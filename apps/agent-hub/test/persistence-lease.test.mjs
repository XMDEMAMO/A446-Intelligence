import assert from "node:assert/strict";
import test from "node:test";
import { makeEnvelope } from "../src/common.mjs";
import { AgentHub } from "../src/hub.mjs";
import { MemoryHubStore } from "../src/hub-store.mjs";

test("hub state and unacknowledged assignment survive a store-backed restart", async () => {
  const store = new MemoryHubStore();
  let hub = new AgentHub(hubConfig({ ttlMs: 60_000 }), { store });
  await hub.start();
  const agent = testAgent("restart-worker");
  hub.agents.set(agent.agentId, agent);
  hub.markAgent(agent);

  const task = hub.createTask({
    targetAgentId: agent.agentId,
    input: "survive restart",
    taskSpec: retrySafeTaskSpec(),
  });
  await hub.queueOrDispatch(task);
  await hub.commitAndDispatch();
  const attemptId = task.currentAttemptId;
  const assignment = [...hub.pendingDeliveries.values()].find((item) => item.envelope.taskId === task.taskId);
  assert.ok(assignment);

  await hub.stop();
  hub = new AgentHub(hubConfig({ ttlMs: 60_000 }), { store });
  await hub.start();
  try {
    assert.equal(hub.tasks.get(task.taskId)?.status, "dispatched");
    assert.equal(hub.tasks.get(task.taskId)?.currentAttemptId, attemptId);
    assert.equal(hub.attempts.get(attemptId)?.status, "assigned");
    assert.equal(hub.agents.get(agent.agentId)?.status, "offline");
    assert.equal(hub.pendingDeliveries.size, 1);
    assert.equal([...hub.pendingDeliveries.values()][0].envelope.id, assignment.envelope.id);
    assert.ok(hub.messages.some((message) => message.taskId === task.taskId));
  } finally {
    await hub.stop();
  }
});

test("expired retry-safe attempts are reassigned and stale results cannot win", async () => {
  const hub = new AgentHub(hubConfig());
  const agent = testAgent("lease-worker");
  hub.agents.set(agent.agentId, agent);

  const task = hub.createTask({
    targetAgentId: agent.agentId,
    input: "retry me safely",
    taskSpec: retrySafeTaskSpec(),
  });
  await hub.queueOrDispatch(task);
  const firstAttemptId = task.currentAttemptId;
  const firstAttempt = hub.attempts.get(firstAttemptId);
  firstAttempt.leaseExpiresAt = new Date(Date.now() - 100).toISOString();

  await hub.reapExpiredLeases();
  const secondAttemptId = task.currentAttemptId;
  assert.notEqual(secondAttemptId, firstAttemptId);
  assert.equal(firstAttempt.status, "expired");
  assert.equal(hub.attempts.get(secondAttemptId)?.attemptNumber, 2);
  assert.equal(task.recoveryCount, 1);

  await hub.handleWorkerMessage(agent.agentId, makeEnvelope("task.result", {
    agentId: agent.agentId,
    taskId: task.taskId,
    payload: { attemptId: firstAttemptId, output: "late and unsafe to apply" },
  }));
  assert.equal(task.status, "dispatched");
  assert.equal(task.currentAttemptId, secondAttemptId);
  assert.equal(firstAttempt.lateResultCount, 1);

  const secondAttempt = hub.attempts.get(secondAttemptId);
  secondAttempt.leaseExpiresAt = new Date(Date.now() - 100).toISOString();
  await hub.handleWorkerMessage(agent.agentId, makeEnvelope("worker.heartbeat", {
    agentId: agent.agentId,
    payload: { currentTaskId: task.taskId, currentAttemptId: secondAttemptId },
  }));
  assert.ok(Date.parse(secondAttempt.leaseExpiresAt) > Date.now());

  await hub.handleWorkerMessage(agent.agentId, makeEnvelope("task.result", {
    agentId: agent.agentId,
    taskId: task.taskId,
    payload: { attemptId: secondAttemptId, output: "current result" },
  }));
  assert.equal(task.status, "completed");
  assert.equal(task.output, "current result");
  assert.equal(secondAttempt.status, "completed");
});

test("expired attempts with unknown side effects stop for human approval", async () => {
  const hub = new AgentHub(hubConfig());
  const agent = testAgent("approval-worker");
  hub.agents.set(agent.agentId, agent);
  const task = hub.createTask({ targetAgentId: agent.agentId, input: "possibly external work" });
  await hub.queueOrDispatch(task);
  const attempt = hub.attempts.get(task.currentAttemptId);
  attempt.leaseExpiresAt = new Date(Date.now() - 100).toISOString();

  await hub.reapExpiredLeases();
  assert.equal(attempt.status, "expired");
  assert.equal(task.status, "awaiting_approval");
  assert.equal(task.requiresApproval, true);
  assert.equal(task.approval?.type, "lease_expired");
  assert.equal(task.attemptNumber, 1);
  assert.ok(hub.messages.some((message) => message.taskId === task.taskId && message.kind === "human_intervention"));
});

test("lease recovery reassigns dynamic work away from an offline Worker", async () => {
  const hub = new AgentHub(hubConfig());
  const firstAgent = testAgent("a-offline-worker");
  const secondAgent = testAgent("b-online-worker");
  hub.agents.set(firstAgent.agentId, firstAgent);
  hub.agents.set(secondAgent.agentId, secondAgent);
  const task = hub.createTask({ input: "move to an available worker", taskSpec: retrySafeTaskSpec() });
  await hub.queueOrDispatch(task);
  const firstAttempt = hub.attempts.get(task.currentAttemptId);
  assert.equal(firstAttempt.workerId, firstAgent.agentId);
  firstAgent.status = "offline";
  firstAttempt.leaseExpiresAt = new Date(Date.now() - 100).toISOString();

  await hub.reapExpiredLeases();
  assert.equal(hub.attempts.get(task.currentAttemptId)?.workerId, secondAgent.agentId);
  assert.equal(task.status, "dispatched");
});

test("workflow executor recovery keeps the first worker and session across restart", async () => {
  const store = new MemoryHubStore();
  let hub = await new AgentHub(hubConfig({ scanIntervalMs: 60_000 }), { store }).start();
  const first = testAgent("a-executor");
  const other = testAgent("b-executor");
  first.roles = ["executor"];
  other.roles = ["executor"];
  hub.agents.set(first.agentId, first);
  hub.agents.set(other.agentId, other);
  hub.markAgent(first);
  hub.markAgent(other);
  const task = hub.createTask({
    input: "revision-safe work", role: "executor", workflow: { enabled: true, executorAgentId: null },
    taskSpec: retrySafeTaskSpec(),
  });
  await hub.queueOrDispatch(task);
  const firstAttemptId = task.currentAttemptId;
  const scope = task.sessionScopeId;
  assert.equal(task.targetAgentId, first.agentId);
  await hub.flushState();
  await hub.stop();

  hub = await new AgentHub(hubConfig({ scanIntervalMs: 60_000 }), { store }).start();
  try {
    const restored = hub.tasks.get(task.taskId);
    assert.equal(restored.targetAgentId, first.agentId);
    assert.equal(restored.sessionScopeId, scope);
    const onlineOther = hub.agents.get(other.agentId);
    onlineOther.status = "online";
    hub.markAgent(onlineOther);
    const attempt = hub.attempts.get(firstAttemptId);
    attempt.leaseExpiresAt = new Date(Date.now() - 100).toISOString();
    await hub.reapExpiredLeases();
    assert.equal(restored.status, "queued");
    assert.equal(restored.targetAgentId, first.agentId);
    assert.equal(restored.requestedAgentId, null);
    assert.equal(restored.sessionScopeId, scope);
    assert.equal(restored.schedulingErrorCode, "EXECUTOR_UNAVAILABLE");
    assert.equal([...hub.attempts.values()].filter((item) => item.taskId === task.taskId).length, 1);
    assert.equal(onlineOther.activeTaskCount, 0);
  } finally {
    await hub.stop();
  }
});

test("automatic lease recovery stops at the configured limit", async () => {
  const hub = new AgentHub(hubConfig({ maxRecoveryAttempts: 1 }));
  const agent = testAgent("bounded-worker");
  hub.agents.set(agent.agentId, agent);
  const task = hub.createTask({
    targetAgentId: agent.agentId,
    input: "do not retry forever",
    taskSpec: retrySafeTaskSpec(),
  });
  await hub.queueOrDispatch(task);
  let attempt = hub.attempts.get(task.currentAttemptId);
  attempt.leaseExpiresAt = new Date(Date.now() - 100).toISOString();
  await hub.reapExpiredLeases();
  assert.equal(task.attemptNumber, 2);

  attempt = hub.attempts.get(task.currentAttemptId);
  attempt.leaseExpiresAt = new Date(Date.now() - 100).toISOString();
  await hub.reapExpiredLeases();
  assert.equal(task.status, "awaiting_approval");
  assert.equal(task.attemptNumber, 2);
  assert.match(task.approval?.reason ?? "", /limit \(1\) reached/);
});

function hubConfig(leaseOverrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    delivery: { ackTimeoutMs: 50, maxAttemptsPerConnection: 2 },
    leases: { enabled: true, ttlMs: 1000, scanIntervalMs: 60_000, ...leaseOverrides },
    logs: { includePayloads: false },
  };
}

function retrySafeTaskSpec() {
  return { execution_policy: { side_effects: "none", on_lease_expiry: "retry" } };
}

function testAgent(agentId) {
  return {
    agentId,
    status: "online",
    paused: false,
    busy: false,
    activeTaskCount: 0,
    maxConcurrency: 1,
    roles: [],
    capabilities: [],
    models: [],
    protocolFeatures: ["attempt-lease-v1"],
  };
}
