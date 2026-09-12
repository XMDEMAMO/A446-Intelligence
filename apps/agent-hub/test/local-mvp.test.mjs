import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentHub } from "../src/hub.mjs";
import { AgentWorker } from "../src/worker.mjs";
import { delay, makeEnvelope } from "../src/common.mjs";
import { evaluateTaskPolicy, normalizePolicy, PolicyDeniedError } from "../src/local-policy.mjs";
import { buildArtifactManifest } from "../src/artifact-manifest.mjs";
import { statusAfterError } from "../src/capability-probe.mjs";

test("quota telemetry classifies rate limits and exhausted quota without inventing percentages", () => {
  const initial = { type: "test", health: "Healthy", quota: "Unknown" };
  const limited = statusAfterError(initial, new Error("HTTP 429 rate limit"));
  assert.equal(limited.health, "Degraded");
  assert.equal(limited.quota, "Low");
  const exhausted = statusAfterError(initial, new Error("RESOURCE_EXHAUSTED: insufficient quota"));
  assert.equal(exhausted.health, "Unhealthy");
  assert.equal(exhausted.quota, "Exhausted");
});

test("local policy restricts permissions and paths while artifact hashes stay inside workspace", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-policy-test-"));
  const workspace = path.join(tempRoot, "workspace");
  const outside = path.join(tempRoot, "outside.txt");
  try {
    await writeFile(outside, "outside", "utf8");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "input.txt"), "input", "utf8");
    await writeFile(path.join(workspace, "artifact.txt"), "artifact-body", "utf8");
    const policy = normalizePolicy({
      requireTaskSpec: true,
      allowedPermissions: ["project_workspace"],
      defaultDenyUnknownPermissions: true,
    }, workspace);
    const allowed = makeEnvelope("task.assign", {
      taskId: "task-allowed",
      payload: {
        taskSpec: {
          inputs: ["input.txt"],
          expected_outputs: ["artifact.txt"],
          permissions_required: { project_workspace: true },
        },
      },
    });
    const report = await evaluateTaskPolicy(allowed, policy);
    assert.equal(report.allowed, true);
    const manifest = await buildArtifactManifest(allowed.payload.taskSpec, policy);
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, "artifact.txt");
    assert.equal(manifest.files[0].sha256, createHash("sha256").update("artifact-body").digest("hex"));

    const outsideTask = structuredClone(allowed);
    outsideTask.payload.taskSpec.inputs = ["../outside.txt"];
    await assert.rejects(() => evaluateTaskPolicy(outsideTask, policy), PolicyDeniedError);

    const forbidden = structuredClone(allowed);
    forbidden.payload.taskSpec.permissions_required = { account_switch: true };
    await assert.rejects(() => evaluateTaskPolicy(forbidden, policy), /never allowed/);

    const malformed = structuredClone(allowed);
    malformed.payload.taskSpec.expected_outputs = "artifact.txt";
    await assert.rejects(() => evaluateTaskPolicy(malformed, policy), /must be an array/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("worker reports health, rejects unsafe tasks, saves checkpoints, and returns artifact hashes", { timeout: 15000 }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-local-mvp-test-"));
  const workspace = path.join(tempRoot, "workspace");
  const hub = new AgentHub({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 100,
    delivery: { ackTimeoutMs: 100, maxAttemptsPerConnection: 5 },
    logs: { file: path.join(tempRoot, "events.jsonl"), includePayloads: true },
  });
  let worker;
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "artifact.txt"), "verified-output", "utf8");
    await hub.start();
    worker = new AgentWorker({
      agentId: "local-mvp",
      hubUrl: `ws://127.0.0.1:${hub.port}/worker`,
      stateFile: path.join(tempRoot, "worker-state.json"),
      workspace,
      heartbeatMs: 100,
      reconnect: { baseMs: 100, maxMs: 500 },
      policy: {
        requireTaskSpec: true,
        allowedPermissions: ["project_workspace"],
        deniedPermissions: ["browser"],
      },
      adapter: { type: "mock", delayMs: 10 },
    });
    await worker.start();
    await waitUntil(() => hub.agents.get("local-mvp")?.status === "online");
    assert.equal(hub.agents.get("local-mvp").observedCapabilities.adapter.available, true);

    const completed = await post(hub, "/v1/tasks", {
      targetAgentId: "local-mvp",
      input: "produce artifact",
      taskSpec: {
        expected_outputs: ["artifact.txt"],
        permissions_required: { project_workspace: true },
      },
    });
    const completedTask = await waitForTask(hub, completed.task.taskId);
    assert.equal(completedTask.status, "completed");
    assert.equal(completedTask.artifacts.files[0].path, "artifact.txt");
    assert.match(completedTask.artifacts.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(worker.state.executorStatus.health, "Healthy");
    assert.equal(worker.state.executorStatus.quota, "Healthy");
    const checkpointState = JSON.parse(await readFile(path.join(workspace, ".agent-hub", "checkpoints", completed.task.taskId, "state.json"), "utf8"));
    assert.equal(checkpointState.stage, "COMPLETED");

    const rejected = await post(hub, "/v1/tasks", {
      targetAgentId: "local-mvp",
      input: "open browser",
      taskSpec: { permissions_required: { browser: true } },
    });
    const rejectedTask = await waitForTask(hub, rejected.task.taskId);
    assert.equal(rejectedTask.status, "rejected");
    assert.equal(rejectedTask.error.code, "POLICY_DENIED");
  } finally {
    if (worker) await worker.stop();
    await hub.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function post(hub, pathname, body) {
  const response = await fetch(`${hub.url()}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text);
}

async function waitForTask(hub, taskId) {
  await waitUntil(() => ["completed", "failed", "cancelled", "rejected"].includes(hub.tasks.get(taskId)?.status));
  return hub.tasks.get(taskId);
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for condition");
}

\n