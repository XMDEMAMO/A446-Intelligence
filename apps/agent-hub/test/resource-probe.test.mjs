import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeConfiguredModels, probeLocalCapabilities, schedulingCapabilities } from "../src/capability-probe.mjs";
import { AgentHub } from "../src/hub.mjs";
import { AgentWorker } from "../src/worker.mjs";
import { delay } from "../src/common.mjs";

test("resource probes retain the last trusted value as stale and preserve scheduling metadata", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "a446-resource-probe-"));
  const marker = path.join(tempRoot, "tool-ready");
  const script = `process.exit(require('node:fs').existsSync(${JSON.stringify(marker)}) ? 0 : 7)`;
  const config = {
    adapter: { type: "mock" },
    capabilities: ["task.execute"],
    capabilityProbe: {
      tools: [{ name: "dynamic-tool", command: process.execPath, args: ["-e", script], capabilities: ["dynamic.tool"] }],
    },
  };
  try {
    await writeFile(marker, "ready", "utf8");
    const available = probeLocalCapabilities(config);
    assert.equal(available.tools[0].state, "available");
    assert.ok(available.tools[0].lastSuccessAt);
    assert.ok(schedulingCapabilities(config, available).includes("dynamic.tool"));

    await rm(marker);
    const stale = probeLocalCapabilities(config, available);
    assert.equal(stale.tools[0].state, "stale");
    assert.equal(stale.tools[0].lastSuccessAt, available.tools[0].lastSuccessAt);
    assert.match(stale.tools[0].errorSummary, /exit 7/);
    assert.ok(schedulingCapabilities(config, stale).includes("dynamic.tool"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("model discovery uses trusted JSON, then marks the last successful list stale", async () => {
  const discovered = await probeConfiguredModels({
    adapter: { type: "mock" },
    models: [{ id: "configured-model", capabilities: ["coding"] }],
    modelProbe: {
      command: process.execPath,
      args: ["-e", `process.stdout.write(JSON.stringify({source:'official-client',models:[{id:'live-model'}]}))`],
    },
  });
  assert.equal(discovered.state, "available");
  assert.equal(discovered.items[0].id, "live-model");
  assert.equal(discovered.items[0].source, "official-client");

  const stale = await probeConfiguredModels({
    adapter: { type: "mock" },
    modelProbe: { command: process.execPath, args: ["-e", "process.exit(9)"] },
  }, discovered);
  assert.equal(stale.state, "stale");
  assert.equal(stale.items[0].id, "live-model");
  assert.equal(stale.items[0].availability, "stale");
});

test("quota refresh keeps the last trusted snapshot stale instead of guessing a replacement", async () => {
  const worker = new AgentWorker({
    agentId: "quota-refresh-worker",
    workspace: os.tmpdir(),
    stateFile: path.join(os.tmpdir(), "unused-quota-refresh-state.json"),
    quotaProbe: {
      command: process.execPath,
      args: ["-e", `process.stdout.write(JSON.stringify({state:'Low',source:'official-client',windows:[{name:'five-hour',remainingPercent:8}]}))`],
    },
    adapter: { type: "mock" },
  });
  await worker.refreshQuota();
  const lastSuccessAt = worker.quotaSnapshot.lastSuccessAt;
  worker.config.quotaProbe.args = ["-e", "process.exit(4)"];
  await worker.refreshQuota();
  assert.equal(worker.quotaSnapshot.state, "Low");
  assert.equal(worker.quotaSnapshot.stale, true);
  assert.equal(worker.quotaSnapshot.lastSuccessAt, lastSuccessAt);
  assert.equal(worker.quotaSnapshot.windows[0].remainingPercent, 8);
});

test("a running Worker refreshes changed capabilities without reconnecting or inventing quota", { timeout: 15000 }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "a446-resource-refresh-"));
  const marker = path.join(tempRoot, "refresh-ready");
  const script = `process.exit(require('node:fs').existsSync(${JSON.stringify(marker)}) ? 0 : 8)`;
  const hub = new AgentHub({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 50,
    logs: { includePayloads: false },
  });
  let worker;
  try {
    await hub.start();
    worker = new AgentWorker({
      agentId: "refresh-worker",
      hubUrl: `ws://127.0.0.1:${hub.port}/worker`,
      stateFile: path.join(tempRoot, "state.json"),
      workspace: path.join(tempRoot, "workspace"),
      heartbeatMs: 50,
      reconnect: { baseMs: 50, maxMs: 200 },
      capabilityProbe: {
        intervalMs: 100,
        timeoutMs: 1000,
        tools: [{ name: "refresh-tool", command: process.execPath, args: ["-e", script], capabilities: ["refresh.capability"] }],
      },
      adapter: { type: "mock" },
    });
    await worker.start();
    await waitUntil(() => hub.agents.get("refresh-worker")?.status === "online");
    assert.equal(hub.agents.get("refresh-worker").capabilities.includes("refresh.capability"), false);
    assert.equal(hub.agents.get("refresh-worker").quotaSnapshot.state, "Unknown");

    await writeFile(marker, "ready", "utf8");
    await waitUntil(() => hub.agents.get("refresh-worker")?.capabilities.includes("refresh.capability"));
    const connectedAt = hub.agents.get("refresh-worker").connectedAt;
    assert.equal(hub.agents.get("refresh-worker").resourceSnapshot.state, "available");

    await rm(marker);
    await waitUntil(() => hub.agents.get("refresh-worker")?.resourceSnapshot?.capabilities?.tools?.[0]?.state === "stale");
    assert.equal(hub.agents.get("refresh-worker").status, "online");
    assert.equal(hub.agents.get("refresh-worker").connectedAt, connectedAt);
  } finally {
    if (worker) await worker.stop();
    await hub.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function waitUntil(predicate, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error("Timed out waiting for condition");
}
