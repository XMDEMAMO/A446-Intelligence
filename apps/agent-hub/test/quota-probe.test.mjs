import test from "node:test";
import assert from "node:assert/strict";
import { probeQuota } from "../src/quota-probe.mjs";

test("quota probe reads a machine-readable client snapshot without shell evaluation", async () => {
  const payload = JSON.stringify({
    state: "Low",
    source: "official-client",
    windows: [{ name: "five-hour", usedPercent: 91, remainingPercent: 9, resetsAt: "2026-09-13T12:00:00.000Z" }],
  });
  const snapshot = await probeQuota({
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(payload)})`],
    timeoutMs: 3000,
  });
  assert.equal(snapshot.state, "Low");
  assert.equal(snapshot.source, "official-client");
  assert.equal(snapshot.windows[0].remainingPercent, 9);
});

test("quota probe rejects non-JSON output instead of inventing numbers", async () => {
  await assert.rejects(
    probeQuota({ command: process.execPath, args: ["-e", "process.stdout.write('unknown')"], timeoutMs: 3000 }),
    /JSON object/,
  );
});
