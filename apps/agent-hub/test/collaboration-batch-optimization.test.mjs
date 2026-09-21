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

  // Fast path should create a completed intake task with decision complete and finalize workflow
  const intakeTask = [...hub.tasks.values()].find((t) => t.stage === "result_intake");
  assert.ok(intakeTask);
  assert.equal(intakeTask.status, "completed");
  assert.equal(intakeTask.submission?.decision, "complete");
  assert.equal(hub.isWorkflowComplete(root.taskId), true);
  assert.equal(root.status, "completed");
  assert.ok(root.workflowCompletedAt);
});
