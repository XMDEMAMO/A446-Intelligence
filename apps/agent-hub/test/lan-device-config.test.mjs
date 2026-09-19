import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildHubConfig, buildWorkerConfig } from "../scripts/prepare-lan-device.mjs";

test("multi-device LAN config gives one account slot one concurrent task and trusted probes", () => {
  const root = path.resolve("C:/a446-test");
  const config = buildWorkerConfig({ provider: "codex", command: "codex", mode: "worker", hubIp: "192.168.137.1", deviceId: "laptop-03", fullAccess: false, root });
  assert.equal(config.agentId, "laptop-03-codex-01");
  assert.deepEqual(config.roles, ["executor", "reviewer"]);
  assert.equal(config.account.maxConcurrency, 1);
  assert.equal(config.hubUrl, "ws://192.168.137.1:8787/worker");
  assert.equal(config.artifacts.centralStore, true);
  assert.equal(config.adapter.sandbox, "workspace-write");
  assert.match(config.modelProbe.args[0], /provider-probe\.mjs$/);
});

test("coordinator config uses durable local files and explicit private-LAN plaintext", () => {
  const worker = buildWorkerConfig({ provider: "antigravity", command: "agy", mode: "coordinator", hubIp: "192.168.137.1", deviceId: "desktop-01", fullAccess: true, root: path.resolve("C:/a446-test") });
  assert.deepEqual(worker.roles, ["planner", "executor", "reviewer"]);
  assert.deepEqual(worker.adapter.args, ["--mode", "accept-edits"]);
  assert.equal(worker.policy.defaultDenyUnknownPermissions, true);
  assert.ok(!worker.adapter.args.includes("--dangerously-skip-permissions"));
  const hub = buildHubConfig({ hubIp: "192.168.137.1" });
  assert.equal(hub.storage.driver, "json-file");
  assert.equal(hub.artifacts.rootDirectory, "../artifacts");
  assert.equal(hub.leases.enabled, true);
  assert.equal(hub.allowPlaintextRemote, true);
});
