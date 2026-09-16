import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentHub } from "../src/hub.mjs";
import { delay } from "../src/common.mjs";
import { MemoryHubStore } from "../src/hub-store.mjs";
import { AgentWorker } from "../src/worker.mjs";

test("fault injection: a Hub restart preserves a running task, artifact manifest, and pending human request", { timeout: 30_000 }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-hub-fault-restart-"));
  const store = new MemoryHubStore();
  let hub;
  let worker;
  try {
    hub = await new AgentHub(hubConfig(tempRoot), { store }).start();
    worker = await startWorker({
      tempRoot,
      hub,
      agentId: "restart-executor",
      roles: ["executor"],
      delayMs: 700,
    });
    await waitUntil(() => hub.agents.get(worker.agentId)?.status === "online", "executor is online");

    await writeFile(path.join(worker.workspace, "result.txt"), "restart-safe mock artifact\n", "utf8");
    const task = hub.createTask({
      targetAgentId: worker.agentId,
      input: "complete an artifact-bearing task through a Hub restart",
      role: "executor",
      stage: "execution",
      taskSpec: {
        title: "restart fault injection",
        expected_outputs: ["result.txt"],
        execution_policy: { side_effects: "none", on_lease_expiry: "retry" },
      },
    });
    const humanTask = hub.createTask({
      input: "preserve this pending human decision during the restart",
      requiresApproval: true,
    });
    const intervention = [...hub.interventions.values()].find((item) => item.taskId === humanTask.taskId);
    assert.ok(intervention, "approval task creates an independent intervention");
    await hub.queueOrDispatch(task);
    await hub.commitAndDispatch();
    await waitUntil(
      () => hub.tasks.get(task.taskId)?.status === "running" && worker.busy,
      "task starts before the Hub restart",
    );

    const port = hub.port;
    const attemptId = task.currentAttemptId;
    await hub.stop();
    hub = await new AgentHub(hubConfig(tempRoot, port), { store }).start();

    await waitUntil(() => hub.agents.get(worker.agentId)?.status === "online", "worker reconnects to the restarted Hub");
    await waitUntil(() => hub.tasks.get(task.taskId)?.status === "completed", "running task completes after restart");
    await waitUntil(() => hub.pendingDeliveries.size === 0, "all reliable Hub deliveries are acknowledged");

    const restoredTask = hub.tasks.get(task.taskId);
    const restoredAttempt = hub.attempts.get(attemptId);
    assert.equal(restoredTask.status, "completed");
    assert.equal(restoredTask.currentAttemptId, attemptId);
    assert.equal(restoredAttempt.status, "completed");
    assert.equal(restoredAttempt.lateResultCount ?? 0, 0);
    assert.equal(restoredTask.artifacts.files.length, 1);
    assert.equal(restoredTask.artifacts.files[0].path, "result.txt");
    assert.equal(restoredTask.artifacts.files[0].size, Buffer.byteLength("restart-safe mock artifact\n"));
    assert.equal(restoredTask.artifacts.files[0].status, "ready");
    assert.match(restoredTask.artifacts.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(hub.artifacts.size, 0, "local Mock mode does not fabricate central Artifact records");
    assert.ok(hub.messages.some((message) => (
      message.taskId === task.taskId
      && message.attachments.some((item) => item.type === "full_result" && item.artifacts?.files?.[0]?.path === "result.txt")
    )));
    assert.equal(hub.interventions.get(intervention.interventionId)?.status, "pending");
    assert.equal(hub.tasks.get(humanTask.taskId)?.status, "awaiting_approval");
    assert.equal(hub.conversations().find((item) => item.rootTaskId === task.rootTaskId)?.status, "completed");
  } finally {
    await worker?.stop();
    await hub?.stop();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("fault injection: an Executor disconnect during execution recovers one reviewed workflow", { timeout: 30_000 }, async () => {
  const fixture = await startWorkflowFixture("executor");
  try {
    const executorTask = await waitForRoleRunning(fixture, "executor");
    await disconnectWorker(fixture, "executor");
    await waitForWorkflowCompletion(fixture);
    assertWorkflowIntegrity(fixture, executorTask.taskId);
  } finally {
    await fixture.stop();
  }
});

test("fault injection: a Reviewer disconnect during review recovers one reviewed workflow", { timeout: 30_000 }, async () => {
  const fixture = await startWorkflowFixture("reviewer");
  try {
    const reviewerTask = await waitForRoleRunning(fixture, "reviewer");
    await disconnectWorker(fixture, "reviewer");
    await waitForWorkflowCompletion(fixture);
    assertWorkflowIntegrity(fixture, reviewerTask.taskId);
  } finally {
    await fixture.stop();
  }
});

async function startWorkflowFixture(disconnectRole) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `agent-hub-fault-${disconnectRole}-`));
  const hub = await new AgentHub(hubConfig(tempRoot)).start();
  const workers = new Map();
  const definitions = [
    {
      agentId: "fault-planner",
      role: "planner",
      roleOutputs: {
        "planner:planning": {
          brief: "assign one artifact-bearing execution",
          assignments: [{
            title: "fault-injection execution",
            instructions: "produce the prepared artifact",
            acceptance: ["result.txt is ready"],
            expectedOutputs: ["result.txt"],
          }],
          needsHuman: false,
        },
        planner: { brief: "reviewed result received", assignments: [], needsHuman: false },
      },
    },
    {
      agentId: "fault-executor",
      role: "executor",
      roleOutputs: {
        executor: { brief: "artifact completed", fullResult: "complete mock artifact result", upstreamIssue: null },
      },
    },
    {
      agentId: "fault-reviewer",
      role: "reviewer",
      roleOutputs: {
        reviewer: { verdict: "approved", brief: "artifact satisfies the acceptance criteria", issues: [], correctionBrief: null },
      },
    },
  ];
  try {
    for (const definition of definitions) {
      const worker = await startWorker({
        tempRoot,
        hub,
        agentId: definition.agentId,
        roles: [definition.role],
        delayMs: definition.role === disconnectRole ? 700 : 20,
        roleOutputs: definition.roleOutputs,
      });
      workers.set(definition.role, worker);
    }
    await waitUntil(() => [...workers.values()].every((worker) => hub.agents.get(worker.agentId)?.status === "online"), "workflow workers are online");
    await writeFile(path.join(workers.get("executor").workspace, "result.txt"), "workflow mock artifact\n", "utf8");
    const root = await hub.createWorkflow({
      title: "fault-injection workflow",
      objective: "complete one reviewed artifact-bearing workflow across a disconnected Worker",
      acceptance: ["result.txt is ready"],
      plannerAgentId: workers.get("planner").agentId,
      reviewerAgentId: workers.get("reviewer").agentId,
      maxReviewCycles: 1,
    });
    await hub.commitAndDispatch();
    return {
      tempRoot,
      hub,
      workers,
      rootTaskId: root.rootTaskId,
      async stop() {
        await Promise.all([...workers.values()].map((worker) => worker.stop()));
        await hub.stop();
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.all([...workers.values()].map((worker) => worker.stop()));
    await hub.stop();
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function startWorker({ tempRoot, hub, agentId, roles, delayMs, roleOutputs = {} }) {
  const workspace = path.join(tempRoot, agentId);
  const worker = new AgentWorker({
    agentId,
    deviceId: `${agentId}-device`,
    account: { id: `${agentId}-account`, provider: "test", plan: "test" },
    roles,
    models: [{ id: `${roles[0]}-model`, capabilities: ["task.execute", "reasoning", "validation"], quota: { state: "Healthy" } }],
    capabilities: ["task.execute", "reasoning", "validation", "coding"],
    hubUrl: `ws://127.0.0.1:${hub.port}/worker`,
    stateFile: path.join(tempRoot, `${agentId}.json`),
    workspace,
    heartbeatMs: 50,
    reconnect: { baseMs: 50, maxMs: 100 },
    adapter: {
      type: "mock",
      delayMs,
      roleOutputs,
      mockUsage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    },
  });
  await worker.start();
  worker.workspace = workspace;
  return worker;
}

async function waitForRoleRunning(fixture, role) {
  let found;
  await waitUntil(() => {
    found = [...fixture.hub.tasks.values()].find((task) => (
      task.rootTaskId === fixture.rootTaskId && task.role === role && task.status === "running"
    ));
    return Boolean(found && fixture.workers.get(role).busy);
  }, `${role} task starts`);
  return found;
}

async function disconnectWorker(fixture, role) {
  const worker = fixture.workers.get(role);
  const socket = worker.ws;
  assert.ok(socket, `${role} has an active WebSocket`);
  socket.terminate();
  await waitUntil(
    () => fixture.hub.log.recent(200).some((event) => event.type === "worker.offline" && event.details.agentId === worker.agentId),
    `${role} disconnect is recorded`,
  );
}

async function waitForWorkflowCompletion(fixture) {
  await waitUntil(() => {
    const tasks = workflowTasks(fixture);
    return tasks.length === 4 && tasks.every((task) => task.status === "completed");
  }, "workflow reaches a consistent completed terminal state", 12_000);
  await waitUntil(() => fixture.hub.pendingDeliveries.size === 0, "workflow reliable deliveries are acknowledged");
}

function assertWorkflowIntegrity(fixture, disconnectedTaskId) {
  const tasks = workflowTasks(fixture);
  assert.deepEqual(tasks.map((task) => task.role), ["planner", "executor", "reviewer", "planner"]);
  assert.equal(tasks.every((task) => task.status === "completed"), true);
  assert.equal(tasks.every((task) => task.currentAttemptId && fixture.hub.attempts.get(task.currentAttemptId)?.status === "completed"), true);
  assert.equal(tasks.filter((task) => task.role === "executor").length, 1, "disconnect does not duplicate execution work");
  const executor = tasks.find((task) => task.role === "executor");
  assert.equal(executor.artifacts.files.length, 1);
  assert.equal(executor.artifacts.files[0].path, "result.txt");
  assert.equal(executor.artifacts.files[0].status, "ready");
  assert.match(executor.artifacts.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(fixture.hub.artifacts.size, 0, "local Mock mode keeps central Artifact state empty");
  assert.equal([...fixture.hub.interventions.values()].filter((item) => item.status === "pending").length, 0);
  assert.equal(fixture.hub.conversations().find((item) => item.rootTaskId === fixture.rootTaskId)?.status, "completed");
  assert.ok(fixture.hub.messages.some((message) => message.taskId === executor.taskId && message.attachments.some((item) => item.type === "full_result")));
  assert.ok(fixture.hub.log.recent(200).some((event) => event.type === "task.result" && event.details.taskId === disconnectedTaskId));
}

function workflowTasks(fixture) {
  return [...fixture.hub.tasks.values()].filter((task) => task.rootTaskId === fixture.rootTaskId);
}

function hubConfig(tempRoot, port = 0) {
  return {
    host: "127.0.0.1",
    port,
    heartbeatMs: 50,
    delivery: { ackTimeoutMs: 50, maxAttemptsPerConnection: 5 },
    leases: { enabled: true, ttlMs: 2_000, scanIntervalMs: 60_000, maxRecoveryAttempts: 2 },
    logs: { file: path.join(tempRoot, "events.jsonl"), includePayloads: false },
  };
}

async function waitUntil(predicate, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
