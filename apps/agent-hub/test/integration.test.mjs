import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentHub } from "../src/hub.mjs";
import { AgentWorker } from "../src/worker.mjs";
import { delay } from "../src/common.mjs";

test("two workers preserve sessions, route output, pause, and approval", { timeout: 15000 }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-test-"));
  const hub = new AgentHub({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 100,
    delivery: { ackTimeoutMs: 100, maxAttemptsPerConnection: 5 },
    logs: { file: path.join(tempRoot, "events.jsonl"), includePayloads: true },
  });
  const workers = [];
  try {
    await hub.start();
    for (const agentId of ["agent-a", "agent-b"]) {
      const worker = new AgentWorker({
        agentId,
        hubUrl: `ws://127.0.0.1:${hub.port}/worker`,
        stateFile: path.join(tempRoot, `${agentId}.json`),
        workspace: path.join(tempRoot, agentId),
        heartbeatMs: 100,
        reconnect: { baseMs: 100, maxMs: 500 },
        adapter: { type: "mock", delayMs: 10 },
      });
      workers.push(worker);
      await worker.start();
    }

    await waitUntil(() => hub.agents.size === 2 && [...hub.agents.values()].every((agent) => agent.status === "online"));

    const routed = await post(hub, "/v1/tasks", {
      targetAgentId: "agent-a",
      input: "first",
      route: ["agent-b"],
    });
    const routedTasks = await waitForRoot(hub, routed.task.rootTaskId);
    assert.equal(routedTasks.length, 2);
    assert.match(routedTasks[0].output, /agent-a/);
    assert.match(routedTasks[1].output, /agent-b/);
    assert.match(routedTasks[1].output, /agent-a/);

    const firstSession = workers[0].state.sessionId;
    const second = await post(hub, "/v1/tasks", { targetAgentId: "agent-a", input: "second" });
    await waitForRoot(hub, second.task.rootTaskId);
    assert.equal(workers[0].state.sessionId, firstSession);

    workers[0].ws.terminate();
    await waitUntil(() => hub.agents.get("agent-a")?.status === "offline");
    const offline = await post(hub, "/v1/tasks", { targetAgentId: "agent-a", input: "deliver after reconnect" });
    const offlineTasks = await waitForRoot(hub, offline.task.rootTaskId);
    assert.equal(offlineTasks[0].status, "completed");
    assert.equal(workers[0].state.sessionId, firstSession);

    await post(hub, "/v1/commands", { type: "agent.pause", targetAgentId: "agent-a" });
    await waitUntil(() => workers[0].state.paused === true);
    const paused = await post(hub, "/v1/tasks", { targetAgentId: "agent-a", input: "queued while paused" });
    assert.equal(hub.tasks.get(paused.task.taskId).status, "queued");
    await post(hub, "/v1/commands", { type: "agent.resume", targetAgentId: "agent-a" });
    await waitForRoot(hub, paused.task.rootTaskId);

    const gated = await post(hub, "/v1/tasks", {
      targetAgentId: "agent-b",
      input: "approval required",
      requiresApproval: true,
    });
    assert.equal(hub.tasks.get(gated.task.taskId).status, "awaiting_approval");
    await post(hub, "/v1/commands", { type: "task.approve", taskId: gated.task.taskId, by: "test" });
    const gatedTasks = await waitForRoot(hub, gated.task.rootTaskId);
    assert.equal(gatedTasks[0].status, "completed");

    const cancelledGate = await post(hub, "/v1/tasks", {
      targetAgentId: "agent-b",
      input: "cancel before approval",
      requiresApproval: true,
    });
    await post(hub, "/v1/commands", { type: "task.cancel", taskId: cancelledGate.task.taskId });
    assert.equal(hub.tasks.get(cancelledGate.task.taskId).status, "cancelled");
    await postRejected(
      hub,
      "/v1/commands",
      { type: "task.approve", taskId: cancelledGate.task.taskId, by: "test" },
      409,
    );

    const persisted = JSON.parse(await readFile(path.join(tempRoot, "agent-a.json"), "utf8"));
    assert.equal(persisted.sessionId, firstSession);
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()));
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

async function postRejected(hub, pathname, body, expectedStatus) {
  const response = await fetch(`${hub.url()}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, expectedStatus);
  const result = await response.json();
  assert.match(result.error, /not awaiting approval/);
}

async function waitForRoot(hub, rootTaskId) {
  await waitUntil(() => {
    const tasks = [...hub.tasks.values()].filter((task) => task.rootTaskId === rootTaskId);
    return tasks.length > 0 && tasks.every((task) => ["completed", "failed", "cancelled"].includes(task.status));
  });
  return [...hub.tasks.values()].filter((task) => task.rootTaskId === rootTaskId);
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for condition");
}
