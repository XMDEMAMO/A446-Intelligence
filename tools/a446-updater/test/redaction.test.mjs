import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { redact } from "../lib/util.mjs";
import { createFakeLiveInstall } from "./helpers.mjs";

test("redaction scrubs GitHub tokens, pairing tokens, bearer headers and API keys", () => {
  const message = [
    "download failed for https://example/c",
    "Authorization: Bearer ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    "token github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234 leaked",
    "pairing A446-0f1e2d3c4b5a69788796a5b4c3d2e1f0-11223344556677889900aabbccddeeff",
    "key sk-proj-abcdef1234567890abcdef",
  ].join(" ");
  const output = redact(message);
  assert.equal(output.includes("ghp_"), false);
  assert.equal(output.includes("github_pat_"), false);
  assert.equal(/A446-[0-9a-f]{20,}/i.test(output), false);
  assert.equal(output.includes("sk-proj-"), false);
  assert.equal(output.includes("Bearer ghp_"), false);
  assert.ok(output.includes("[REDACTED]"));
});

test("updater logs and state files contain no pairing tokens (acceptance case 14)", async (t) => {
  const { live, staging, token } = await createFakeLiveInstall({ version: "0.5.0-preview15" });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "a446-redact-"));
  const installRoot = path.join(staging, ".a446");
  t.after(async () => {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });
  const { UpdaterCore } = await import("../lib/core.mjs");
  const core = new UpdaterCore({ home, config: {}, logger: () => {} });
  await core.adopt({ live, role: "worker", deviceId: "test-device", installRoot });
  // Token values must never appear in updater-managed files.
  const configText = await fs.readFile(path.join(home, "config.json"), "utf8");
  const stateText = await fs.readFile(path.join(home, "state.json"), "utf8");
  assert.equal(configText.includes(token), false);
  assert.equal(stateText.includes(token), false);
  assert.equal(redact(`token is ${token}`).includes(token), false);
});
