import test from "node:test";
import assert from "node:assert/strict";
import { AgentHub } from "../src/hub.mjs";
import { chooseModel, isPreferredQuotaSnapshot, modelCostTier } from "../src/collaboration.mjs";

function agent(agentId, role, overrides = {}) {
  return {
    agentId,
    deviceId: `${agentId}-device`,
    status: "online",
    roles: [role],
    capabilities: ["task.execute", "reasoning", "validation"],
    models: [
      { id: "model-default", capabilities: ["task.execute", "reasoning", "validation"], quota: { state: "Healthy" } },
    ],
    ...overrides,
  };
}

test("P0: chooseModel prioritizes Tier 1 (lightweight) models over Tier 3 (flagship) models when quota states match", () => {
  const testAgent = {
    agentId: "agent-multi-model",
    capabilities: ["task.execute", "reasoning"],
    models: [
      { id: "claude-opus-4-6", capabilities: ["reasoning"], quota: { state: "Healthy" } },
      { id: "gemini-2.5-flash", capabilities: ["reasoning"], quota: { state: "Healthy" } },
      { id: "gpt-4o", capabilities: ["reasoning"], quota: { state: "Healthy" } },
    ],
  };

  assert.equal(modelCostTier("gemini-2.5-flash"), 1);
  assert.equal(modelCostTier("gpt-5.6-luna-low"), 1);
  assert.equal(modelCostTier("gpt-4o"), 2);
  assert.equal(modelCostTier("claude-opus-4-6"), 3);

  // When no specific model is requested, chooseModel should pick Tier 1 (flash) over Tier 3 (opus)
  const chosen = chooseModel(testAgent, { requiredCapabilities: ["reasoning"] });
  assert.equal(chosen.id, "gemini-2.5-flash");
});

test("P1: isPreferredQuotaSnapshot prioritizes valid snapshots over errored/stale ones regardless of checkedAt timestamp", () => {
  const validOlder = {
    checkedAt: "2026-09-20T10:00:00.000Z",
    stale: false,
    errorSummary: null,
    windows: [{ limit: 100, remaining: 80 }],
  };

  const erroredNewer = {
    checkedAt: "2026-09-20T10:05:00.000Z",
    stale: true,
    errorSummary: "Network probe timeout",
    windows: [],
  };

  // Newer errored snapshot should NOT supersede older valid snapshot
  assert.equal(isPreferredQuotaSnapshot(erroredNewer, validOlder), false);

  // Older valid snapshot SHOULD supersede newer errored snapshot
  assert.equal(isPreferredQuotaSnapshot(validOlder, erroredNewer), true);

  // When both are valid, newer timestamp wins
  const validNewer = {
    checkedAt: "2026-09-20T10:10:00.000Z",
    stale: false,
    errorSummary: null,
    windows: [{ limit: 100, remaining: 75 }],
  };
  assert.equal(isPreferredQuotaSnapshot(validNewer, validOlder), true);
  assert.equal(isPreferredQuotaSnapshot(validOlder, validNewer), false);
});

test("P1: Batch review aggregation: sibling execution task waits for other sibling before intake", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  hub.agents.set("planner-1", agent("planner-1", "planner"));
  hub.agents.set("executor-1", agent("executor-1", "executor"));
  hub.agents.set("reviewer-1", agent("reviewer-1", "reviewer"));

  const root = hub.createTask({
    input: "Multi-task workflow",
    role: "planner",
    targetAgentId: "planner-1",
    workflow: { enabled: true, plannerAgentId: "planner-1", executorAgentId: "executor-1", reviewerAgentId: "reviewer-1" },
  });

  // Planner dispatches 2 assignments
  await hub.dispatchAssignments(root, [
    { title: "Task 1", instructions: "Build component A", expectedOutputs: ["a.js"] },
    { title: "Task 2", instructions: "Build component B", expectedOutputs: ["b.js"] },
  ]);

  const execTasks = [...hub.tasks.values()].filter((t) => t.role === "executor");
  assert.equal(execTasks.length, 2);
  const [e1, e2] = execTasks;

  // Executor 1 finishes
  e1.status = "completed";
  e1.submission = { brief: "Finished component A", fullResult: "code A" };
  await hub.advanceWorkflow(e1);

  // Reviewer 1 finishes with approved
  const rev1 = [...hub.tasks.values()].find((t) => t.role === "reviewer" && t.parentTaskId === e1.taskId);
  assert.ok(rev1);
  rev1.status = "completed";
  rev1.submission = { verdict: "approved", brief: "Component A looks great" };
  await hub.advanceWorkflow(rev1);

  // Executor 2 is still queued/dispatched, so NO result_intake task should be spawned yet!
  let intakeTasks = [...hub.tasks.values()].filter((t) => t.stage === "result_intake");
  assert.equal(intakeTasks.length, 0, "No premature intake while sibling E2 is still active");

  // Executor 2 finishes
  e2.status = "completed";
  e2.submission = { brief: "Finished component B", fullResult: "code B" };
  await hub.advanceWorkflow(e2);

  // Reviewer 2 finishes with approved
  const rev2 = [...hub.tasks.values()].find((t) => t.role === "reviewer" && t.parentTaskId === e2.taskId);
  assert.ok(rev2);
  rev2.status = "completed";
  rev2.submission = { verdict: "approved", brief: "Component B looks great" };
  await hub.advanceWorkflow(rev2);

  // Now BOTH are approved, so ONE consolidated result_intake task should be spawned!
  intakeTasks = [...hub.tasks.values()].filter((t) => t.stage === "result_intake");
  assert.equal(intakeTasks.length, 1, "Exactly one consolidated intake task spawned for the batch");
  assert.equal(intakeTasks[0].contextBundle.batchCount, 2);
  assert.match(intakeTasks[0].contextBundle.executorBrief, /Task 1/);
  assert.match(intakeTasks[0].contextBundle.executorBrief, /Task 2/);
  assert.equal(intakeTasks[0].sessionScopeId, `${root.taskId}:intake`);
  assert.equal("schedulerCatalog" in intakeTasks[0].contextBundle, false, "schedulerCatalog omitted in intake");
});

test("P1: Deterministic fast path directly completes workflow when fastPath is enabled", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  hub.agents.set("planner-1", agent("planner-1", "planner"));
  hub.agents.set("executor-1", agent("executor-1", "executor"));
  hub.agents.set("reviewer-1", agent("reviewer-1", "reviewer"));

  const root = hub.createTask({
    input: "Fast path workflow",
    role: "planner",
    targetAgentId: "planner-1",
    workflow: { enabled: true, fastPath: true, plannerAgentId: "planner-1", executorAgentId: "executor-1", reviewerAgentId: "reviewer-1" },
  });
  root.status = "completed";
  root.completedAt = new Date().toISOString();

  await hub.dispatchAssignments(root, [
    { title: "Task Single", instructions: "Do work", expectedOutputs: ["res.txt"] },
  ]);

  const execTask = [...hub.tasks.values()].find((t) => t.role === "executor");
  execTask.status = "completed";
  execTask.submission = { brief: "Done", fullResult: "output content" };
  await hub.advanceWorkflow(execTask);

  const revTask = [...hub.tasks.values()].find((t) => t.role === "reviewer");
  revTask.status = "completed";
  revTask.submission = { verdict: "approved", brief: "Review passed" };
  await hub.advanceWorkflow(revTask);

  // Fast path should create a completed hub_finalization task with decision complete and finalize workflow
  const finalTask = [...hub.tasks.values()].find((t) => t.stage === "hub_finalization");
  assert.ok(finalTask);
  assert.equal(finalTask.role, "system");
  assert.equal(finalTask.status, "completed");
  assert.equal(finalTask.submission?.decision, "complete");
  assert.match(finalTask.taskSpec?.title, /Hub 确定性结案/);
  assert.equal(hub.isWorkflowComplete(root.taskId), true);
  assert.equal(root.status, "completed");
  assert.ok(root.workflowCompletedAt);
});

test("P0: Reviewer model preference does not become [object Object] with Web UI default stageModels", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  hub.agents.set("planner-1", agent("planner-1", "planner"));
  hub.agents.set("executor-1", agent("executor-1", "executor"));
  hub.agents.set("reviewer-1", agent("reviewer-1", "reviewer"));

  // Web UI sends stageModels where values can be objects with null modelPreference
  const root = await hub.createWorkflow({
    objective: "Web UI default stageModels test",
    plannerAgentId: "planner-1",
    executorAgentId: "executor-1",
    reviewerAgentId: "reviewer-1",
    stageModels: {
      planner: { modelPreference: null, reasoningEffort: null },
      reviewer: { modelPreference: null, reasoningEffort: null },
      intake: { modelPreference: null, reasoningEffort: null },
    },
  });

  await hub.dispatchAssignments(root, [
    { title: "Subtask 1", instructions: "Build component", expectedOutputs: ["out.js"] },
  ]);

  const execTask = [...hub.tasks.values()].find((t) => t.role === "executor");
  execTask.status = "completed";
  execTask.submission = { brief: "Subtask done", fullResult: "code" };
  await hub.advanceWorkflow(execTask);

  const reviewerTask = [...hub.tasks.values()].find((t) => t.role === "reviewer");
  assert.ok(reviewerTask, "Reviewer task was created");
  assert.ok(typeof reviewerTask.modelPreference === "string" || reviewerTask.modelPreference === null, "modelPreference must be string or null");
  assert.equal(reviewerTask.modelPreference, null, "modelPreference is normalized to null");
  assert.notEqual(String(reviewerTask.modelPreference), "[object Object]");
});

test("P0: Failed subtask blocks intake and escalates to human intervention", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  hub.agents.set("planner-1", agent("planner-1", "planner"));
  hub.agents.set("executor-1", agent("executor-1", "executor"));
  hub.agents.set("reviewer-1", agent("reviewer-1", "reviewer"));

  const root = hub.createTask({
    input: "Batch with failure test",
    role: "planner",
    targetAgentId: "planner-1",
    workflow: { enabled: true, plannerAgentId: "planner-1", executorAgentId: "executor-1", reviewerAgentId: "reviewer-1" },
  });

  await hub.dispatchAssignments(root, [
    { title: "Good Task", instructions: "Build A", expectedOutputs: ["a.js"] },
    { title: "Bad Task", instructions: "Build B", expectedOutputs: ["b.js"] },
  ]);

  const execTasks = [...hub.tasks.values()].filter((t) => t.role === "executor");
  const [e1, e2] = execTasks;

  // e2 fails
  e2.status = "failed";
  e2.error = { name: "ExecutionError", message: "Build syntax error in B" };

  // e1 succeeds and reviewer approves it
  e1.status = "completed";
  e1.submission = { brief: "Finished A", fullResult: "code A" };
  await hub.advanceWorkflow(e1);

  const rev1 = [...hub.tasks.values()].find((t) => t.role === "reviewer" && t.parentTaskId === e1.taskId);
  assert.ok(rev1);
  rev1.status = "completed";
  rev1.submission = { verdict: "approved", brief: "A approved" };
  await hub.advanceWorkflow(rev1);

  // Result intake MUST NOT be created because e2 failed
  const intakeTasks = [...hub.tasks.values()].filter((t) => t.stage === "result_intake");
  assert.equal(intakeTasks.length, 0, "No intake created when a sibling subtask is failed");

  // An intervention should be created alerting about the failed subtask
  const intervention = hub.currentIntervention(root.taskId);
  assert.ok(intervention, "Human intervention created on failed sibling in batch");
  assert.match(intervention.question, /未成功完成或未获通过/);
  assert.match(intervention.question, /Bad Task/);
});

test("P1: Incompatible model throws HTTP 400 with INCOMPATIBLE_MODEL", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  hub.agents.set("planner-1", agent("planner-1", "planner", {
    models: [{ id: "supported-model", capabilities: ["reasoning"] }],
  }));

  await assert.rejects(
    async () => {
      await hub.createWorkflow({
        objective: "Incompatible model test",
        plannerAgentId: "planner-1",
        plannerModelPreference: "unsupported-model-xyz",
      });
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "INCOMPATIBLE_MODEL");
      assert.match(err.message, /unsupported-model-xyz/);
      return true;
    }
  );
});

test("P1: Fast Path aggregates ALL reviewer briefs and uses role 'system' / stage 'hub_finalization'", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  hub.agents.set("planner-1", agent("planner-1", "planner"));
  hub.agents.set("executor-1", agent("executor-1", "executor"));
  hub.agents.set("reviewer-1", agent("reviewer-1", "reviewer"));
  hub.agents.set("reviewer-2", agent("reviewer-2", "reviewer"));

  const root = hub.createTask({
    input: "Fast path multi-reviewer",
    role: "planner",
    targetAgentId: "planner-1",
    workflow: { enabled: true, fastPath: true, plannerAgentId: "planner-1", executorAgentId: "executor-1" },
  });
  root.status = "completed";
  root.completedAt = new Date().toISOString();

  await hub.dispatchAssignments(root, [
    { title: "Subtask Alpha", instructions: "Alpha work", expectedOutputs: ["alpha.txt"] },
    { title: "Subtask Beta", instructions: "Beta work", expectedOutputs: ["beta.txt"] },
  ]);

  const [e1, e2] = [...hub.tasks.values()].filter((t) => t.role === "executor");
  e1.status = "completed";
  e1.submission = { brief: "Alpha done", fullResult: "alpha result" };
  await hub.advanceWorkflow(e1);

  e2.status = "completed";
  e2.submission = { brief: "Beta done", fullResult: "beta result" };
  await hub.advanceWorkflow(e2);

  const rev1 = [...hub.tasks.values()].find((t) => t.role === "reviewer" && t.parentTaskId === e1.taskId);
  const rev2 = [...hub.tasks.values()].find((t) => t.role === "reviewer" && t.parentTaskId === e2.taskId);

  rev1.status = "completed";
  rev1.submission = { verdict: "approved", brief: "Alpha quality verified" };
  await hub.advanceWorkflow(rev1);

  rev2.status = "completed";
  rev2.submission = { verdict: "approved", brief: "Beta quality verified" };
  await hub.advanceWorkflow(rev2);

  const finalTask = [...hub.tasks.values()].find((t) => t.stage === "hub_finalization");
  assert.ok(finalTask, "hub_finalization task created");
  assert.equal(finalTask.role, "system");
  assert.match(finalTask.taskSpec?.title, /Hub 确定性结案/);
  // Verify that briefs from BOTH reviewers are present!
  assert.match(finalTask.contextBundle.reviewBrief, /Alpha quality verified/);
  assert.match(finalTask.contextBundle.reviewBrief, /Beta quality verified/);
  assert.equal(hub.isWorkflowComplete(root.taskId), true);
});

test("P1: Metadata-driven automatic model classification (costTier, recommendedRoles, isDefault)", () => {
  const testAgent = {
    agentId: "agent-smart-models",
    capabilities: ["task.execute", "reasoning"],
    models: [
      {
        id: "model-heavy-flagship",
        capabilities: ["reasoning"],
        costTier: 3,
        quota: { state: "Healthy" },
      },
      {
        id: "model-planner-specialist",
        capabilities: ["reasoning"],
        costTier: 2,
        recommendedRoles: ["planner"],
        quota: { state: "Healthy" },
      },
      {
        id: "model-fast-helper",
        capabilities: ["reasoning"],
        costTier: 1,
        quota: { state: "Healthy" },
      },
    ],
  };

  // 1. Role match: when role is "planner", model with recommendedRoles: ["planner"] wins
  const plannerChoice = chooseModel(testAgent, { role: "planner", requiredCapabilities: ["reasoning"] });
  assert.equal(plannerChoice.id, "model-planner-specialist");

  // 2. Cost tier: when role is not planner, costTier 1 wins over costTier 2 and 3
  const executorChoice = chooseModel(testAgent, { role: "executor", requiredCapabilities: ["reasoning"] });
  assert.equal(executorChoice.id, "model-fast-helper");

  // 3. Explicit costTier overrides name heuristics
  assert.equal(modelCostTier({ id: "gemini-flash-something", costTier: 3 }), 3);
  assert.equal(modelCostTier({ id: "claude-opus-heavy", costTier: 1 }), 1);
});

test("P1: Concurrent reviewer completions spawn only 1 result_intake task", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  hub.agents.set("planner-1", agent("planner-1", "planner"));
  hub.agents.set("executor-1", agent("executor-1", "executor"));
  hub.agents.set("reviewer-1", agent("reviewer-1", "reviewer"));
  hub.agents.set("reviewer-2", agent("reviewer-2", "reviewer"));

  const root = hub.createTask({
    input: "Concurrent review test",
    role: "planner",
    targetAgentId: "planner-1",
    workflow: { enabled: true, plannerAgentId: "planner-1", executorAgentId: "executor-1" },
  });

  await hub.dispatchAssignments(root, [
    { title: "Task 1", instructions: "Do 1", expectedOutputs: ["1.txt"] },
    { title: "Task 2", instructions: "Do 2", expectedOutputs: ["2.txt"] },
  ]);

  const [e1, e2] = [...hub.tasks.values()].filter((t) => t.role === "executor");
  e1.status = "completed";
  e1.submission = { brief: "E1 done", fullResult: "r1" };
  await hub.advanceWorkflow(e1);

  e2.status = "completed";
  e2.submission = { brief: "E2 done", fullResult: "r2" };
  await hub.advanceWorkflow(e2);

  const rev1 = [...hub.tasks.values()].find((t) => t.role === "reviewer" && t.parentTaskId === e1.taskId);
  const rev2 = [...hub.tasks.values()].find((t) => t.role === "reviewer" && t.parentTaskId === e2.taskId);

  rev1.status = "completed";
  rev1.submission = { verdict: "approved", brief: "Rev1 approved" };
  rev2.status = "completed";
  rev2.submission = { verdict: "approved", brief: "Rev2 approved" };

  // Trigger advanceWorkflow for both reviewers almost concurrently
  await Promise.all([
    hub.advanceWorkflow(rev1),
    hub.advanceWorkflow(rev2),
  ]);

  const intakeTasks = [...hub.tasks.values()].filter((t) => t.stage === "result_intake");
  assert.equal(intakeTasks.length, 1, "Exactly one result_intake task spawned despite concurrent reviewer completions");
  assert.equal(intakeTasks[0].contextBundle.batchCount, 2);
  assert.match(intakeTasks[0].contextBundle.reviewBrief, /Rev1 approved/);
  assert.match(intakeTasks[0].contextBundle.reviewBrief, /Rev2 approved/);
});
