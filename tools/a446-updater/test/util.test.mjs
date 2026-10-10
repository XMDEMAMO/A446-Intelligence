import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  atomicWriteJson,
  compareVersions,
  isValidVersion,
  normalizeVersion,
  parseArgs,
  redact,
  versionKey,
} from "../lib/util.mjs";

test("compareVersions orders preview builds numerically and releases above previews", () => {
  assert.ok(compareVersions("0.5.0-preview15", "0.5.0-preview16") < 0);
  assert.ok(compareVersions("0.5.0-preview9", "0.5.0-preview10") < 0, "numeric, not lexical");
  assert.ok(compareVersions("0.5.0", "0.5.0-preview16") > 0, "release outranks preview");
  assert.ok(compareVersions("0.5.1-preview1", "0.5.0") > 0);
  assert.ok(compareVersions("v0.5.0-preview15", "0.5.0-preview15") === 0, "v prefix ignored");
  assert.ok(compareVersions("0.4.9", "0.5.0-preview1") < 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("isValidVersion and normalizeVersion reject malformed input", () => {
  assert.equal(isValidVersion("0.5.0-preview16"), true);
  assert.equal(isValidVersion("v0.5.0"), true);
  assert.equal(isValidVersion("preview16"), false);
  assert.equal(isValidVersion(""), false);
  assert.equal(normalizeVersion(" v0.5.0-preview16 "), "0.5.0-preview16");
  assert.equal(normalizeVersion("garbage"), null);
  assert.throws(() => versionKey("bad/version"), /Invalid version/);
});

test("parseArgs supports --key value, boolean flags and positional values", () => {
  const args = parseArgs(["update", "--version", "0.5.0-preview16", "--allow-downgrade", "--job-id", "j-1"]);
  assert.deepEqual(args._, ["update"]);
  assert.equal(args.version, "0.5.0-preview16");
  assert.equal(args["allow-downgrade"], true);
  assert.equal(args["job-id"], "j-1");
});

test("atomicWriteJson writes atomically without leaving temp files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "a446-util-"));
  const file = path.join(directory, "state.json");
  await atomicWriteJson(file, { hello: "world" });
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(parsed.hello, "world");
  const leftovers = (await fs.readdir(directory)).filter((entry) => entry.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
  await fs.rm(directory, { recursive: true, force: true });
});
