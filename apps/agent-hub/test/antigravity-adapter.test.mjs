import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AntigravityAdapter } from "../src/adapters/antigravity.mjs";

const fixture = fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url));

test("Antigravity adapter keeps one stream-json process and conversation", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agy-adapter-test-"));
  const state = { sessionId: null };
  const adapter = new AntigravityAdapter({
    command: process.execPath,
    args: [fixture],
    resumeOnStart: true,
    shutdownTimeoutMs: 1000,
  }, { agentId: "agy-test", workspace });
  try {
    await adapter.start(state);
    const first = await adapter.run("alpha", { sessionId: state.sessionId, signal: new AbortController().signal });
    state.sessionId = first.sessionId;
    const second = await adapter.run("beta", { sessionId: state.sessionId, signal: new AbortController().signal });
    assert.equal(second.sessionId, first.sessionId);
    assert.match(first.output, /turn-1.*alpha/);
    assert.match(second.output, /turn-2.*beta/);
  } finally {
    await adapter.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});
