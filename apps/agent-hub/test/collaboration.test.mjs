import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentHub } from "../src/hub.mjs";
import { AgentWorker } from "../src/worker.mjs";
import { addUsage, chooseAgent, normalizeUsage, parseRoleSubmission } from "../src/collaboration.mjs";
import { delay } from "../src/common.mjs";

test("usage normalization and scheduler keep account, role, model, and quota separate", () => {
  assert.deepEqual(normalizeUsage({ usage: {
    input_tokens: 100,
    output_tokens: 40,
    input_tokens_details: { cached_tokens: 25 },
    output_tokens_details: { reasoning_tokens: 12 },
    total_tokens: 140,
  } }), {
    inputTokens: 100,
    outputTokens: 40,
    cachedTokens: 25,
    reasoningTokens: 12,
    toolTokens: 0,
    totalTokens: 140,
  });
  assert.equal(addUsage({ totalTokens: 12 }, { totalTokens: 8 }).totalTokens, 20);

  const agents = new Map([
    ["busy-low", { agentId: "busy-low", status: "online", busy: true, roles: ["executor"], capabilities: ["coding"], models: [{ id: "small", quota: { state: "Low" } }], executors: [{ health: "Healthy" }] }],
    ["ready", { agentId: "ready", status: "online", busy: false, roles: ["executor"], capabilities: ["coding"], models: [{ id: "large", quota: { state: "Healthy" } }], executors: [{ health: "Healthy" }] }],
  ]);
  const selected = chooseAgent(agents, { role: "executor", requiredCapabilities: ["coding"] });
  assert.equal(selected.agent.agentId, "ready");
  assert.equal(selected.model.id, "large");
});

test("role output parser defaults an unstructured review to rejection", () => {
  assert.equal(parseRoleSubmission("reviewer", "looks okay").verdict, "rejected");
  assert.equal(parseRoleSubmission("executor", '{"brief":"done","fullResult":"complete"}').fullResult, "complete");
});

test("an executor upstream-error report is reviewed before the planner receives a replan brief", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  hub.agents = new Map([
    ["planner", agent("planner", "planner")],
    ["executor", agent("executor", "executor")],
    ["reviewer", agent("reviewer", "reviewer")],
  ]);
  const workflow = { enabled: true, plannerAgentId: "planner", reviewerAgentId: "reviewer", maxReviewCycles: 2 };
  const root = hub.createTask({
    targetAgentId: "planner",
    input: "original objective",
    role: "planner",
    stage: "planning",
    workflow,
    taskSpec: { title: "root", acceptance: ["correct"] },
    contextBundle: { objective: "original objective" },
  });
  root.submission = { brief: "assign once", assignments: [{ title: "work", instructions: "execute", acceptance: ["correct"] }] };
  await hub.advanceWorkflow(root);
  const executor = [...hub.tasks.values()].find((task) => task.role === "executor");
  executor.submission = {
    brief: "blocked by incorrect premise",
    fullResult: "internal investigation",
    upstreamIssue: { summary: "premise is false", evidence: ["source A"], impact: "result invalid", recommendation: "replan" },
  };
  await hub.advanceWorkflow(executor);
  const reviewer = [...hub.tasks.values()].find((task) => task.role === "reviewer");
  assert.equal(reviewer.stage, "upstream_review");
  assert.equal("fullResult" in reviewer.contextBundle, false);
  reviewer.submission = { verdict: "upstream_confirmed", brief: "evidence confirms the premise error", correctionBrief: "replace premise A with B" };
  await hub.advanceWorkflow(reviewer);
  const replan = [...hub.tasks.values()].find((task) => task.stage === "replan");
  assert.equal(replan.role, "planner");
  assert.equal(replan.contextBundle.correctionBrief, "replace premise A with B");
  assert.equal("fullResult" in replan.contextBundle, false);
});

test("a repeatedly denied upstream-error claim stops for human intervention", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const workflow = { enabled: true, plannerAgentId: "planner", reviewerAgentId: "reviewer", maxReviewCycles: 0 };
  const root = hub.createTask({ input: "objective", role: "planner", workflow });
  const executor = hub.createTask({
    input: "execute",
    rootTaskId: root.taskId,
    parentTaskId: root.taskId,
    role: "executor",
    targetAgentId: "executor",
    workflow,
  });
  const reviewer = hub.createTask({
    input: "review upstream claim",
    rootTaskId: root.taskId,
    parentTaskId: executor.taskId,
    role: "reviewer",
    targetAgentId: "reviewer",
    workflow,
  });
  reviewer.submission = { verdict: "upstream_denied", brief: "the evidence does not support the claim" };
  await hub.advanceWorkflow(reviewer);
  assert.equal(root.humanIntervention.status, "required");
  assert.equal([...hub.tasks.values()].some((task) => task.stage === "revision"), false);
});

test("planner, executor, and reviewer form one minimal-context task conversation", { timeout: 15000 }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-collaboration-test-"));
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
    const definitions = [
      {
        agentId: "planner-1",
        roles: ["planner"],
        models: [{ id: "plan-model", capabilities: ["reasoning"], quota: { state: "Healthy" } }],
        roleOutputs: {
          "planner:planning": { brief: "split once", assignments: [{ title: "draft", instructions: "produce result", acceptance: ["complete"] }], needsHuman: false },
          planner: { brief: "accepted result", assignments: [], needsHuman: false },
        },
      },
      {
        agentId: "executor-1",
        roles: ["executor"],
        models: [{ id: "work-model", capabilities: ["task.execute"], quota: { state: "Healthy" } }],
        roleOutputs: { executor: { brief: "result summary", fullResult: "full private result", upstreamIssue: null } },
      },
      {
        agentId: "reviewer-1",
        roles: ["reviewer"],
        models: [{ id: "review-model", capabilities: ["validation"], quota: { state: "Healthy" } }],
        roleOutputs: { reviewer: { verdict: "approved", brief: "meets acceptance", issues: [], correctionBrief: null } },
      },
    ];
    for (const definition of definitions) {
      const worker = new AgentWorker({
        agentId: definition.agentId,
        deviceId: `${definition.agentId}-device`,
        account: { id: `${definition.agentId}-account`, provider: "test", plan: "test" },
        roles: definition.roles,
        models: definition.models,
        capabilities: ["task.execute", "reasoning", "validation", "coding"],
        hubUrl: `ws://127.0.0.1:${hub.port}/worker`,
        stateFile: path.join(tempRoot, `${definition.agentId}.json`),
        workspace: path.join(tempRoot, definition.agentId),
        heartbeatMs: 100,
        reconnect: { baseMs: 50, maxMs: 200 },
        adapter: { type: "mock", delayMs: 5, roleOutputs: definition.roleOutputs, mockUsage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } },
      });
      workers.push(worker);
      await worker.start();
    }
    await waitUntil(() => hub.agents.size === 3 && [...hub.agents.values()].every((agent) => agent.status === "online"));

    const response = await post(hub, "/v1/workflows", {
      title: "Collaborative task",
      objective: "Solve one problem",
      acceptance: ["complete"],
    });
    const rootId = response.task.rootTaskId;
    await waitUntil(() => {
      const tasks = [...hub.tasks.values()].filter((task) => task.rootTaskId === rootId);
      return tasks.length === 4 && tasks.every((task) => task.status === "completed");
    });

    const tasks = [...hub.tasks.values()].filter((task) => task.rootTaskId === rootId);
    assert.deepEqual(tasks.map((task) => task.role), ["planner", "executor", "reviewer", "planner"]);
    assert.deepEqual(tasks.map((task) => task.execution.model), ["plan-model", "work-model", "review-model", "plan-model"]);
    const reviewer = tasks.find((task) => task.role === "reviewer");
    const intake = tasks.find((task) => task.stage === "result_intake");
    assert.equal(reviewer.contextBundle.fullResult, "full private result");
    assert.equal(intake.contextBundle.executorBrief, "result summary");
    assert.equal("fullResult" in intake.contextBundle, false);
    assert.equal(tasks.find((task) => task.role === "executor").reviewStatus, "approved");
    assert.equal(hub.messages.every((message) => message.rootTaskId === rootId), true);
    assert.deepEqual(hub.messages.filter((message) => message.kind === "task_instruction").map((message) => message.senderRole), ["human", "planner", "executor", "reviewer"]);
    assert.equal(hub.conversations()[0].messageCount, hub.messages.length);
    assert.equal(hub.usageTotals.totalTokens, 40);
    assert.deepEqual(Object.keys(workers[0].state.sessions), [rootId]);
    assert.deepEqual(Object.keys(workers[1].state.sessions), [tasks.find((task) => task.role === "executor").sessionScopeId]);
    assert.equal(tasks.find((task) => task.stage === "result_intake").sessionScopeId, rootId);
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

function agent(agentId, role) {
  return {
    agentId,
    status: "online",
    paused: false,
    busy: false,
    roles: [role],
    capabilities: [],
    models: [{ id: `${role}-model`, enabled: true, capabilities: [], quota: { state: "Healthy" } }],
    executors: [{ health: "Healthy", quota: "Healthy" }],
  };
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for condition");
}
