import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UpdaterError } from "../lib/util.mjs";
import {
  adoptLayout,
  isJunction,
  layoutPaths,
  readJunctionTarget,
  resolveCurrentTarget,
  switchCurrentJunction,
  unadoptLayout,
} from "../lib/layout.mjs";
import { createFakeLiveInstall } from "./helpers.mjs";

test("adopt converts a flat install into versions+shared+junction and unadopt restores it", async (t) => {
  const { live, staging } = await createFakeLiveInstall({ version: "0.5.0-preview15" });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "a446-layout-home-"));
  const installRoot = path.join(staging, ".a446");
  const journalFile = path.join(home, "migration-journal.json");
  t.after(async () => {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });

  const result = await adoptLayout({ livePath: live, installRoot, journalFile });
  assert.equal(result.version, "0.5.0-preview15");
  assert.equal(isJunction(live), true);
  const paths = layoutPaths(installRoot);
  assert.equal(isJunction(paths.currentJunction), true);
  assert.ok(existsSync(path.join(live, "apps", "agent-hub", "src", "worker.mjs")), "live resolves through the junction chain");
  assert.ok(existsSync(path.join(paths.sharedVarDir, "lan", "pairing-token.txt")), "shared var preserved");
  assert.ok(existsSync(path.join(paths.sharedWorkspacesDir, "lan", "keep.txt")), "shared workspaces preserved");
  const token = await fs.readFile(path.join(paths.sharedVarDir, "lan", "pairing-token.txt"), "utf8");
  assert.match(token, /^A446-/, "pairing token survived the migration");
  assert.ok(!existsSync(journalFile), "journal cleared after completion");

  const current = await resolveCurrentTarget(installRoot);
  assert.equal(current.version, "0.5.0-preview15");
  assert.equal(current.target, "versions/0.5.0-preview15");
  assert.equal(current.repaired, false);

  await unadoptLayout({ livePath: live, installRoot, journalFile });
  assert.equal(isJunction(live), false, "live is a real directory again");
  assert.ok(existsSync(path.join(live, "apps", "agent-hub", "var", "lan", "pairing-token.txt")), "var moved back");
  assert.ok(existsSync(path.join(live, "apps", "agent-hub", "workspaces", "lan", "keep.txt")), "workspaces moved back");
  assert.equal(existsSync(installRoot && paths.currentJunction), false, "current junction removed");
});

test("adopt resumes after an interrupted migration and keeps data intact", async (t) => {
  const { live, staging } = await createFakeLiveInstall({ version: "0.5.0-preview15" });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "a446-layout-resume-"));
  const installRoot = path.join(staging, ".a446");
  const journalFile = path.join(home, "migration-journal.json");
  t.after(async () => {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });

  // Simulate a crash right after "move-var" by executing a partial journal:
  const paths = layoutPaths(installRoot);
  await fs.mkdir(paths.versionsDir, { recursive: true });
  await fs.mkdir(paths.sharedDir, { recursive: true });
  await fs.rename(path.join(live, "apps", "agent-hub", "var"), paths.sharedVarDir);
  await fs.writeFile(journalFile, JSON.stringify({ steps: ["mkdirs", "move-var"], livePath: live, installRoot, versionKey: "0.5.0-preview15" }));

  const result = await adoptLayout({ livePath: live, installRoot, journalFile });
  assert.equal(result.version, "0.5.0-preview15");
  assert.ok(existsSync(path.join(paths.sharedVarDir, "lan", "pairing-token.txt")), "var not duplicated");
  assert.ok(existsSync(path.join(live, "apps", "agent-hub", "src", "worker.mjs")));
  assert.ok(existsSync(path.join(live, "apps", "agent-hub", "var", "lan", "pairing-token.txt")), "var reachable via junction chain");
  assert.ok(!existsSync(journalFile));
});

test("removeJunction never deletes the junction target and refuses real directories", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "a446-junction-"));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  });
  const target = path.join(base, "target");
  const link = path.join(base, "link");
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "data.txt"), "keep");
  const { createJunction } = await import("../lib/layout.mjs");
  createJunction(link, target);
  assert.equal(isJunction(link), true);
  // Windows junction targets may carry a trailing backslash; strip trailing
  // separators so the assertion is not path-format dependent.
  const junctionTarget = readJunctionTarget(link).replace(/[\\/]+$/, "");
  assert.ok(junctionTarget.endsWith("target"));
  const { removeJunction } = await import("../lib/layout.mjs");
  await removeJunction(link);
  assert.equal(existsSync(link), false);
  assert.ok(existsSync(path.join(target, "data.txt")), "target contents untouched");
  await assert.rejects(() => removeJunction(target), /not a junction/);
});

test("switchCurrentJunction refuses unstaged versions and updates current.json", async (t) => {
  const { live, staging } = await createFakeLiveInstall({ version: "0.5.0-preview15" });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "a446-switch-"));
  const installRoot = path.join(staging, ".a446");
  const journalFile = path.join(home, "journal.json");
  t.after(async () => {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });
  await adoptLayout({ livePath: live, installRoot, journalFile });
  await assert.rejects(
    () => switchCurrentJunction(installRoot, "0.5.0-preview16"),
    (error) => error.code === "NOT_STAGED" || error.code === "JUNCTION_TARGET_MISSING" || error.exitCode === 15,
    "unstaged or missing version directories must not be switched to",
  );
  const paths = layoutPaths(installRoot);
  assert.equal((await resolveCurrentTarget(installRoot)).version, "0.5.0-preview15");
  void paths;
});
