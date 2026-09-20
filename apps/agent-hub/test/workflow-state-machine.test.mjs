import test from "node:test";
import assert from "node:assert/strict";
import { AgentHub } from "../src/hub.mjs";
import { delay } from "../src/common.mjs";

test("Hub authoritative validation triggers automatic format retry once, then escalates to human intervention", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const executor = agent("executor-1", "executor");
  hub.agents.set("executor-1", executor);

  const root = hub.createTask({
    input: "Do work",
    targetAgentId: "executor-1",
    role: "executor",
    stage: "execution",
    workflow: { enabled: true },
  });
  await hub.queueOrDispatch(root);
  assert.equal(root.status, "dispatched");

  // Attempt 1: Worker sends broken JSON with unescaped internal quotes
  const attemptId1 = root.currentAttemptId;
  const brokenJson = '{"brief": "网站测试：所有agent输出"火区"两个字", "fullResult": "done"}';
  await hub.handleWorkerMessage("executor-1", {
    id: "msg-1",
    type: "task.result",
    taskId: root.taskId,
    payload: {
      attemptId: attemptId1,
      output: brokenJson,
    },
  });

  // Hub rejects and triggers 1-time format retry
  assert.equal(root.formatRetryCount, 1);
  assert.equal(root.status, "dispatched"); // Re-dispatched for retry
  assert.match(root.input, /【格式错误需修正】/);
  assert.ok(root.diagnosis?.formatError);
  // Chat messages should NOT contain the broken JSON as a normal task brief
  assert.equal(hub.messages.some((m) => m.kind === "task_brief"), false);

  // Attempt 2: Worker sends broken JSON again
  await hub.handleWorkerMessage("executor-1", {
    id: "msg-2",
    type: "task.result",
    taskId: root.taskId,
    payload: {
      output: 'still not json',
    },
  });

  // Hub now marks task as failed and requires human intervention
  assert.equal(root.status, "failed");
  assert.equal(root.error?.name, "FormatValidationError");
  const intervention = [...hub.interventions.values()].find((i) => i.taskId === root.taskId);
  assert.ok(intervention, "Human intervention created on second format failure");
  assert.equal(intervention.status, "pending");
  assert.match(intervention.question, /任务格式校验失败/);
  assert.equal(hub.conversations().find((c) => c.rootTaskId === root.rootTaskId)?.status, "needs_human");
});

test("Prohibition of self-review: executor cannot review itself and waits for human review if no independent reviewer exists", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  // Only executor-1 is online
  const executor = agent("executor-1", "executor");
  hub.agents.set("executor-1", executor);

  const root = hub.createTask({
    input: "Solo task",
    role: "planner",
    workflow: { enabled: true, executorAgentId: "executor-1" },
  });
  const execTask = hub.createTask({
    input: "Execute solo",
    rootTaskId: root.taskId,
    parentTaskId: root.taskId,
    targetAgentId: "executor-1",
    role: "executor",
    stage: "execution",
    workflow: root.workflow,
  });
  execTask.submission = { brief: "Solo work done", fullResult: "Solo full result" };

  // Trigger advanceWorkflow on executor result
  await hub.advanceWorkflow(execTask);

  // Since executor-1 is the only agent and cannot self-review, it must wait for human review!
  assert.equal(execTask.reviewStatus, "waiting_for_human_review");
  const intervention = [...hub.interventions.values()].find((i) => i.taskId === execTask.taskId);
  assert.ok(intervention, "Human review intervention created");
  assert.equal(intervention.continuation?.type, "human_review");
  assert.match(intervention.question, /严禁由 Executor 自行审核/);

  // Admin approves human review
  const admin = { id: "admin-1", role: "admin" };
  await hub.resolveIntervention(intervention.interventionId, { action: "approve", response: "Looks good" }, admin);

  assert.equal(execTask.reviewStatus, "approved");
  // A planner result_intake task must have been spawned
  const intakeTask = [...hub.tasks.values()].find((t) => t.stage === "result_intake");
  assert.ok(intakeTask, "Planner result_intake spawned after human approval");
});

test("Four Pillars completion: workflow only completes when all four conditions are met", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  hub.agents.set("planner-1", agent("planner-1", "planner"));
  hub.agents.set("executor-1", agent("executor-1", "executor"));
  hub.agents.set("reviewer-1", agent("reviewer-1", "reviewer"));

  const root = hub.createTask({
    input: "Full workflow",
    role: "planner",
    targetAgentId: "planner-1",
    workflow: { enabled: true, plannerAgentId: "planner-1", executorAgentId: "executor-1", reviewerAgentId: "reviewer-1" },
  });
  root.status = "completed";

  // Pillar check 1: No execution tasks -> Stalled, NOT completed!
  assert.equal(hub.isWorkflowComplete(root.taskId), false);
  assert.equal(hub.conversations()[0].status, "stalled");

  // Create completed execution task
  const execTask = hub.createTask({
    input: "Do work",
    rootTaskId: root.taskId,
    parentTaskId: root.taskId,
    targetAgentId: "executor-1",
    role: "executor",
    stage: "execution",
    workflow: root.workflow,
  });
  execTask.status = "completed";
  execTask.submission = { brief: "Done", fullResult: "Full result" };

  // Pillar check 2: Not reviewed yet -> Not complete!
  assert.equal(hub.isWorkflowComplete(root.taskId), false);

  // Review task approved by independent reviewer-1
  const reviewTask = hub.createTask({
    input: "Review work",
    rootTaskId: root.taskId,
    parentTaskId: execTask.taskId,
    targetAgentId: "reviewer-1",
    role: "reviewer",
    stage: "result_review",
    workflow: root.workflow,
  });
  reviewTask.status = "completed";
  execTask.reviewStatus = "approved";

  // Pillar check 3: Approved, but planner has not issued explicit decision: "complete" -> Not complete!
  assert.equal(hub.isWorkflowComplete(root.taskId), false);

  // Planner issues explicit complete decision in result_intake
  const intakeTask = hub.createTask({
    input: "Intake results",
    rootTaskId: root.taskId,
    parentTaskId: reviewTask.taskId,
    targetAgentId: "planner-1",
    role: "planner",
    stage: "result_intake",
    workflow: root.workflow,
  });
  intakeTask.status = "completed";
  intakeTask.submission = { decision: "complete", brief: "Verified all results", assignments: [] };

  // All Four Pillars are now satisfied!
  assert.equal(hub.isWorkflowComplete(root.taskId), true);
  hub.checkAndFinalizeWorkflow(root.taskId);
  assert.equal(root.status, "completed");
  assert.equal(hub.conversations()[0].status, "completed");
});

test("Scheduling failure provides structured feedback to planner, retries once, then requires human", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  hub.agents.set("planner-1", agent("planner-1", "planner"));
  // executor-1 has no capabilities
  const executor = agent("executor-1", "executor");
  executor.capabilities = [];
  executor.models = [];
  hub.agents.set("executor-1", executor);

  const root = hub.createTask({
    input: "Scheduling test",
    role: "planner",
    targetAgentId: "planner-1",
    workflow: { enabled: true, plannerAgentId: "planner-1" },
  });

  const plannerTask = hub.createTask({
    input: "Plan tasks",
    rootTaskId: root.taskId,
    targetAgentId: "planner-1",
    role: "planner",
    stage: "planning",
    workflow: root.workflow,
  });
  plannerTask.submission = {
    brief: "Assign task requiring non-existent capability",
    assignments: [
      {
        title: "Heavy Task",
        instructions: "Run quantum math",
        requiredCapabilities: ["quantum_compute"],
        targetAgentId: "executor-1",
      },
    ],
  };

  // Dispatch assignments
  await hub.advanceWorkflow(plannerTask);

  // Child task failed scheduling -> Hub cancels child and gives structured feedback to planner in replan stage
  const replanTask = [...hub.tasks.values()].find((t) => t.stage === "replan");
  assert.ok(replanTask, "Planner received replan task after scheduling failure");
  assert.ok(replanTask.contextBundle?.schedulingFailure, "Structured failure feedback provided");
  assert.match(replanTask.contextBundle.schedulingFailure.assignmentTitle, /Heavy Task/);

  // If second plan also schedules impossible task -> Hub requires human intervention
  replanTask.submission = {
    brief: "Try again with impossible model",
    assignments: [
      {
        title: "Heavy Task 2",
        instructions: "Run again",
        requiredCapabilities: ["quantum_compute"],
        targetAgentId: "executor-1",
      },
    ],
  };
  await hub.advanceWorkflow(replanTask);

  const intervention = [...hub.interventions.values()].find((i) => i.question?.includes("调度失败"));
  assert.ok(intervention, "Human intervention created after second scheduling failure");
});

test("Workflow circuit breaker triggers human intervention at 50 task limit", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const root = hub.createTask({
    input: "Infinite loop task",
    role: "planner",
    workflow: { enabled: true },
  });

  // Pre-populate 49 child tasks in the workflow
  for (let i = 0; i < 49; i++) {
    hub.createTask({
      input: `Task ${i}`,
      rootTaskId: root.taskId,
      role: "executor",
      stage: "execution",
      status: "completed",
    });
  }

  // Next task advance triggers circuit breaker
  const plannerTask = hub.createTask({
    input: "50th task",
    rootTaskId: root.taskId,
    role: "planner",
    stage: "planning",
    workflow: root.workflow,
  });
  plannerTask.submission = {
    brief: "One more task",
    assignments: [{ title: "T", instructions: "I" }],
  };

  await hub.advanceWorkflow(plannerTask);

  const intervention = [...hub.interventions.values()].find((i) => i.question?.includes("上限（50次）"));
  assert.ok(intervention, "Circuit breaker created human intervention at 50 tasks");
});

test("Rework lineage: rejected v1 followed by approved v2 successfully completes workflow", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const planner = agent("planner-1", "planner");
  const executor = agent("executor-1", "executor");
  const reviewer = agent("reviewer-1", "reviewer");
  hub.agents.set("planner-1", planner);
  hub.agents.set("executor-1", executor);
  hub.agents.set("reviewer-1", reviewer);

  const root = hub.createTask({
    input: "Build website",
    role: "planner",
    workflow: { enabled: true, plannerAgentId: "planner-1" },
  });
  root.status = "completed";

  // Planner creates v1
  const v1 = hub.createTask({
    input: "Implement v1",
    rootTaskId: root.taskId,
    parentTaskId: root.taskId,
    targetAgentId: "executor-1",
    role: "executor",
    stage: "execution",
    workflow: root.workflow,
    workUnitId: "wu-1",
    revision: 1,
  });
  v1.status = "completed";
  v1.submission = { brief: "v1 done", fullResult: "v1 output" };
  v1.output = "v1 output";

  // Reviewer rejects v1
  const revTask1 = hub.createTask({
    input: "Review v1",
    rootTaskId: root.taskId,
    parentTaskId: v1.taskId,
    targetAgentId: "reviewer-1",
    role: "reviewer",
    workflow: root.workflow,
  });
  revTask1.status = "completed";
  revTask1.submission = { verdict: "rejected", brief: "Missing tests" };

  await hub.advanceWorkflow(revTask1);

  // v1 must now be superseded!
  assert.equal(v1.superseded, true);
  assert.ok(v1.supersededBy);

  // Revision v2 must have been created
  const v2 = hub.tasks.get(v1.supersededBy);
  assert.ok(v2, "v2 revision task exists");
  assert.equal(v2.workUnitId, "wu-1");
  assert.equal(v2.revision, 2);
  assert.equal(v2.superseded, false);

  // Workflow is NOT complete yet because v2 is active
  assert.equal(hub.isWorkflowComplete(root.taskId), false);

  // Complete and approve v2
  v2.status = "completed";
  v2.submission = { brief: "v2 done with tests", fullResult: "v2 full output" };
  v2.output = "v2 full output";

  const revTask2 = hub.createTask({
    input: "Review v2",
    rootTaskId: root.taskId,
    parentTaskId: v2.taskId,
    targetAgentId: "reviewer-1",
    role: "reviewer",
    workflow: root.workflow,
  });
  revTask2.status = "completed";
  revTask2.submission = { verdict: "approved", brief: "Tests are complete" };

  await hub.advanceWorkflow(revTask2);

  assert.equal(v2.reviewStatus, "approved");

  // Planner result_intake task must have been spawned
  const intakeTask = [...hub.tasks.values()].find((t) => t.stage === "result_intake" && t.parentTaskId === revTask2.taskId);
  assert.ok(intakeTask, "Planner result intake task spawned");

  intakeTask.status = "completed";
  intakeTask.submission = { decision: "complete", brief: "All requirements met" };
  await hub.advanceWorkflow(intakeTask);

  // Four Pillars check: Workflow is now COMPLETE despite historical rejected v1!
  assert.equal(hub.isWorkflowComplete(root.taskId), true);
  const conv = hub.conversations().find((c) => c.rootTaskId === root.taskId);
  assert.equal(conv?.status, "completed");
});

test("Bulk dispatch circuit breaker: 45 existing tasks + 8 new assignments blocked before dispatch", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const root = hub.createTask({
    input: "Heavy workflow",
    role: "planner",
    workflow: { enabled: true, totalInvocations: 45 },
  });

  const plannerTask = hub.createTask({
    input: "Plan 8 tasks",
    rootTaskId: root.taskId,
    role: "planner",
    stage: "planning",
    workflow: root.workflow,
  });

  const eightAssignments = Array.from({ length: 8 }, (_, i) => ({
    title: `Subtask ${i}`,
    instructions: `Do ${i}`,
  }));

  await hub.dispatchAssignments(plannerTask, eightAssignments);

  // No child tasks dispatched
  const children = [...hub.tasks.values()].filter((t) => t.parentTaskId === plannerTask.taskId);
  assert.equal(children.length, 0);

  // Circuit breaker human intervention created
  const intervention = [...hub.interventions.values()].find((i) => i.question?.includes("上限（50次）"));
  assert.ok(intervention, "Human intervention created before bulk dispatch exceeded 50 limit");
  assert.match(intervention.question, /本次拟下发 8 次/);
});

test("Capacity-aware Reviewer selection: chooses idle reviewer over at-capacity reviewer", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const executor = agent("executor-1", "executor");
  // reviewer-1 is busy (activeTaskCount: 1, maxConcurrency: 1)
  const reviewer1 = { ...agent("reviewer-1", "reviewer"), activeTaskCount: 1, accountMaxConcurrency: 1 };
  // reviewer-2 is idle (activeTaskCount: 0, maxConcurrency: 1)
  const reviewer2 = { ...agent("reviewer-2", "reviewer"), activeTaskCount: 0, accountMaxConcurrency: 1 };

  hub.agents.set("executor-1", executor);
  hub.agents.set("reviewer-1", reviewer1);
  hub.agents.set("reviewer-2", reviewer2);

  const root = hub.createTask({
    input: "Parallel review task",
    role: "planner",
    workflow: { enabled: true },
  });

  const execTask = hub.createTask({
    input: "Work",
    rootTaskId: root.taskId,
    targetAgentId: "executor-1",
    role: "executor",
    stage: "execution",
    workflow: root.workflow,
  });
  execTask.submission = { brief: "Done", fullResult: "Full" };

  await hub.advanceWorkflow(execTask);

  // Reviewer task must be assigned to reviewer-2, NOT reviewer-1!
  const reviewTask = [...hub.tasks.values()].find((t) => t.parentTaskId === execTask.taskId && t.role === "reviewer");
  assert.ok(reviewTask, "Review task created");
  assert.equal(reviewTask.targetAgentId, "reviewer-2");
});

test("Replan depth uniform tracking on root workflow", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const planner = agent("planner-1", "planner");
  const executor = agent("executor-1", "executor");
  const reviewer = agent("reviewer-1", "reviewer");
  hub.agents.set("planner-1", planner);
  hub.agents.set("executor-1", executor);
  hub.agents.set("reviewer-1", reviewer);

  const root = hub.createTask({
    input: "Replan depth test",
    role: "planner",
    workflow: { enabled: true, plannerAgentId: "planner-1", replanDepth: 2 },
  });

  const execTask = hub.createTask({
    input: "Exec task with upstream issue",
    rootTaskId: root.taskId,
    targetAgentId: "executor-1",
    role: "executor",
    stage: "execution",
    workflow: root.workflow,
  });
  execTask.submission = { brief: "Blocked by dependency", upstreamIssue: { reason: "Need library X" } };

  const revTask = hub.createTask({
    input: "Review upstream issue",
    rootTaskId: root.taskId,
    parentTaskId: execTask.taskId,
    targetAgentId: "reviewer-1",
    role: "reviewer",
    workflow: root.workflow,
  });
  revTask.submission = { verdict: "upstream_confirmed", brief: "Agreed, library X is missing" };

  await hub.advanceWorkflow(revTask);

  // root.workflow.replanDepth must now be 3!
  assert.equal(root.workflow.replanDepth, 3);
  // execTask must be superseded
  assert.equal(execTask.superseded, true);
  // Planner replan task spawned with updated depth
  const replanTask = [...hub.tasks.values()].find((t) => t.stage === "replan");
  assert.ok(replanTask);
  assert.equal(replanTask.workflow.replanDepth, 3);
});

test("Hub handleCommand supports workflow.replan and workflow.force_complete", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const planner = agent("planner-1", "planner");
  hub.agents.set("planner-1", planner);

  const root = hub.createTask({
    input: "Stalled workflow",
    role: "planner",
    workflow: { enabled: true, plannerAgentId: "planner-1" },
  });

  // Replan command
  const replanResult = await hub.handleCommand({
    type: "workflow.replan",
    rootTaskId: root.taskId,
    instructions: "Please try alternative strategy",
  }, { id: "admin-1", role: "admin" });

  assert.equal(replanResult.ok, true);
  assert.equal(replanResult.task.role, "planner");
  assert.equal(replanResult.task.stage, "replan");

  // Force complete command
  const forceResult = await hub.handleCommand({
    type: "workflow.force_complete",
    rootTaskId: root.taskId,
    reason: "Administrative signoff",
  }, { id: "admin-1", role: "admin" });

  assert.equal(forceResult.ok, true);
  assert.equal(root.status, "completed");
  assert.equal(root.workflowDecision, "complete");
  assert.ok(root.forceCompleted);
});

test("preview12: Concurrent dispatch atomic reservation prevents 45 -> 51 race condition", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const executor = agent("executor-1", "executor");
  hub.agents.set("executor-1", executor);

  const root = hub.createTask({
    input: "High load workflow",
    role: "planner",
    workflow: { enabled: true, totalInvocations: 45, executorAgentId: "executor-1" },
  });

  const p1 = hub.createTask({ input: "Plan A", rootTaskId: root.taskId, role: "planner", workflow: root.workflow });
  const p2 = hub.createTask({ input: "Plan B", rootTaskId: root.taskId, role: "planner", workflow: root.workflow });

  const batch1 = [
    { title: "Task 1", instructions: "Do 1" },
    { title: "Task 2", instructions: "Do 2" },
    { title: "Task 3", instructions: "Do 3" },
  ];
  const batch2 = [
    { title: "Task 4", instructions: "Do 4" },
    { title: "Task 5", instructions: "Do 5" },
    { title: "Task 6", instructions: "Do 6" },
  ];

  // Dispatch concurrently
  await Promise.all([
    hub.dispatchAssignments(p1, batch1),
    hub.dispatchAssignments(p2, batch2),
  ]);

  // One batch must succeed (reserves 3, reaching 48)
  // The other batch must be rejected (48 + 3 = 51 > 50) and trigger human intervention
  assert.equal(root.workflow.totalInvocations, 48);
  const intervention = [...hub.interventions.values()].find((i) => i.question?.includes("上限（50次）"));
  assert.ok(intervention, "Second concurrent batch was blocked by atomic reservation");

  const childTasks = [...hub.tasks.values()].filter((t) => t.role === "executor");
  assert.equal(childTasks.length, 3, "Only 3 child tasks created instead of 6");
});

test("preview12: workflow.replan is blocked when 50 invocations reached", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const planner = agent("planner-1", "planner");
  hub.agents.set("planner-1", planner);

  const root = hub.createTask({
    input: "Maxed out workflow",
    role: "planner",
    workflow: { enabled: true, plannerAgentId: "planner-1", totalInvocations: 50 },
  });

  await assert.rejects(
    async () => {
      await hub.handleCommand({
        type: "workflow.replan",
        rootTaskId: root.taskId,
        instructions: "Replan should fail",
      }, { id: "admin-1", role: "admin" });
    },
    /50次/
  );

  assert.equal(root.workflow.totalInvocations, 50, "Total invocations did not exceed 50");
});

test("preview12: workflow.force_complete cancels active child tasks, closes interventions, and marks completed", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const executor = agent("executor-1", "executor");
  hub.agents.set("executor-1", executor);

  const root = hub.createTask({
    input: "Stalled stuck workflow",
    role: "planner",
    workflow: { enabled: true, executorAgentId: "executor-1" },
  });

  // Create an active child task
  const child = hub.createTask({
    input: "Running subtask",
    rootTaskId: root.taskId,
    parentTaskId: root.taskId,
    role: "executor",
    targetAgentId: "executor-1",
    status: "running",
    workflow: root.workflow,
  });

  // Create a pending intervention on child task
  const childIntervention = hub.createIntervention(child, {
    kind: "workflow_input",
    question: "Child task intervention",
  });

  // Verify conversation is active / needs_human before force_complete
  const beforeConv = hub.conversations().find((c) => c.rootTaskId === root.taskId);
  assert.equal(beforeConv.status, "needs_human");

  // Admin triggers force_complete
  const result = await hub.handleCommand({
    type: "workflow.force_complete",
    rootTaskId: root.taskId,
    reason: "Admin intervention needed to finish",
  }, { id: "admin-1", role: "admin" });

  assert.equal(result.ok, true);
  assert.equal(root.status, "completed");
  assert.ok(root.forceCompleted);

  // Child task cancelled
  assert.equal(child.status, "cancelled");

  // Child intervention resolved
  assert.equal(childIntervention.status, "resolved");

  // Workflow complete check
  assert.equal(hub.isWorkflowComplete(root.taskId), true);

  // Conversation status completed
  const afterConv = hub.conversations().find((c) => c.rootTaskId === root.taskId);
  assert.equal(afterConv.status, "completed");
});

test("preview13: lease retry consumes quota, reaching 50 causes circuit breaker and human intervention", async () => {
  const hub = new AgentHub({
    host: "127.0.0.1",
    port: 0,
    delivery: { ackTimeoutMs: 50, maxAttemptsPerConnection: 2 },
    leases: { enabled: true, ttlMs: 1000, scanIntervalMs: 60_000 },
    logs: { includePayloads: false },
  });

  const worker = {
    ...agent("executor-lease-1", "executor"),
    protocolFeatures: ["attempt-lease-v1"],
  };
  hub.agents.set("executor-lease-1", worker);

  const root = hub.createTask({
    input: "Workflow with lease retry",
    role: "planner",
    workflow: { enabled: true, totalInvocations: 49 },
  });

  const task = hub.createTask({
    targetAgentId: worker.agentId,
    rootTaskId: root.taskId,
    role: "executor",
    input: "Retry safe task",
    taskSpec: { execution_policy: { side_effects: "none", on_lease_expiry: "retry" } },
    workflow: root.workflow,
  });

  // First dispatch: 49 -> 50
  await hub.queueOrDispatch(task);
  assert.equal(task.status, "dispatched");
  assert.equal(root.workflow.totalInvocations, 50);
  assert.equal(task.quotaReserved, false, "quotaReserved was reset after dispatch");

  const attempt = hub.attempts.get(task.currentAttemptId);
  assert.ok(attempt);
  attempt.leaseExpiresAt = new Date(Date.now() - 100).toISOString();

  // Lease expires and tries to re-dispatch attempt 2
  // But quota is already 50, so next attempt 50 + 1 = 51 is blocked by circuit breaker!
  await hub.reapExpiredLeases();

  // Task should have failed with CircuitBreakerError and human intervention triggered
  assert.equal(task.status, "failed");
  assert.equal(task.error?.name, "CircuitBreakerError");
  assert.equal(root.workflow.totalInvocations, 50, "Did not exceed 50 invocations");

  const intervention = [...hub.interventions.values()].find((i) => i.question?.includes("上限（50次）"));
  assert.ok(intervention, "Circuit breaker created human intervention on lease retry");
});

test("preview13: 50th invocation result with decision 'complete' is processed and finalizes workflow", async () => {
  const hub = new AgentHub({ logs: { includePayloads: true } });
  const planner = agent("planner-1", "planner");
  const executor = agent("executor-1", "executor");
  const reviewer = agent("reviewer-1", "reviewer");
  hub.agents.set("planner-1", planner);
  hub.agents.set("executor-1", executor);
  hub.agents.set("reviewer-1", reviewer);

  const root = hub.createTask({
    input: "Finish on 50th invocation",
    role: "planner",
    workflow: {
      enabled: true,
      plannerAgentId: "planner-1",
      executorAgentId: "executor-1",
      reviewerAgentId: "reviewer-1",
      totalInvocations: 49,
    },
  });
  root.status = "completed";

  // Create an approved executor task
  const exec = hub.createTask({
    input: "Exec subtask",
    rootTaskId: root.taskId,
    role: "executor",
    targetAgentId: "executor-1",
    workflow: root.workflow,
  });
  exec.status = "completed";
  exec.reviewStatus = "approved";
  exec.submission = { brief: "done", fullResult: "code ready" };

  // Create reviewer task confirming approval
  const rev = hub.createTask({
    input: "Review subtask",
    rootTaskId: root.taskId,
    parentTaskId: exec.taskId,
    role: "reviewer",
    targetAgentId: "reviewer-1",
    workflow: root.workflow,
  });
  rev.status = "completed";
  rev.submission = { verdict: "approved", brief: "looks good" };

  // Create the 50th task: planner result_intake
  const intakeTask = hub.createTask({
    input: "Intake task",
    rootTaskId: root.taskId,
    parentTaskId: exec.taskId,
    role: "planner",
    stage: "result_intake",
    targetAgentId: "planner-1",
    workflow: root.workflow,
  });

  // Set totalInvocations to 50
  root.workflow.totalInvocations = 50;

  intakeTask.submission = {
    decision: "complete",
    brief: "All deliverables verified, complete workflow",
    assignments: [],
  };
  intakeTask.status = "completed";

  // advanceWorkflow should NOT be blocked by >= 50, but should accept complete and finalize!
  await hub.advanceWorkflow(intakeTask);

  assert.equal(intakeTask.workflowDecision, "complete");
  assert.equal(root.status, "completed", "Root workflow marked completed on 50th invocation");
  assert.equal(root.workflow.totalInvocations, 50, "Invocations capped at 50");
  assert.equal(hub.isWorkflowComplete(root.taskId), true);
});

test("preview14: HTTP POST /v1/tasks enforces strict whitelist DTO and blocks 50-limit bypass", async () => {
  const hub = new AgentHub({
    host: "127.0.0.1",
    port: 0,
    delivery: { ackTimeoutMs: 50, maxAttemptsPerConnection: 2 },
    logs: { includePayloads: true },
  });
  await hub.start();

  try {
    const executor = agent("executor-http-1", "executor");
    hub.agents.set("executor-http-1", executor);

    // Root workflow already reached 50 invocations and is currently active
    const root = hub.createTask({
      input: "Maxed out workflow",
      role: "planner",
      workflow: { enabled: true, totalInvocations: 50, executorAgentId: "executor-http-1" },
    });
    root.status = "running";

    // 1. Client attempts to forge quotaReserved: true and workflow.enabled: true via HTTP POST /v1/tasks
    const res1 = await fetch(`${hub.url()}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rootTaskId: root.taskId,
        input: "attempt to bypass quota via quotaReserved",
        targetAgentId: "executor-http-1",
        workflow: { enabled: true },
        quotaReserved: true,
      }),
    });
    assert.equal(res1.status, 202);
    const data1 = await res1.json();
    const created1 = hub.tasks.get(data1.task.taskId);
    assert.ok(created1);
    assert.equal(created1.quotaReserved, false, "Client cannot forge quotaReserved: true");
    assert.equal(created1.status, "failed", "Task failed due to 50 invocation circuit breaker");
    assert.equal(created1.error?.name, "CircuitBreakerError");
    assert.equal(root.workflow.totalInvocations, 50, "Total invocations capped at 50");
    const intervention1 = [...hub.interventions.values()].find((i) => i.taskId === created1.taskId && i.question?.includes("50次"));
    assert.ok(intervention1, "Human intervention created on circuit breaker");

    // 2. Client attempts to bypass workflow via workflow.enabled: false
    const res2 = await fetch(`${hub.url()}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rootTaskId: root.taskId,
        input: "attempt to bypass workflow via enabled: false",
        targetAgentId: "executor-http-1",
        workflow: { enabled: false },
      }),
    });
    assert.equal(res2.status, 202);
    const data2 = await res2.json();
    const created2 = hub.tasks.get(data2.task.taskId);
    assert.ok(created2);
    assert.equal(created2.workflow?.enabled, true, "Workflow configuration strictly inherited from root");
    assert.equal(created2.status, "failed", "Task halted by circuit breaker");
    assert.equal(root.workflow.totalInvocations, 50, "Total invocations did not exceed 50");

    // 3. Client attempts to forge internal fields (forceCompleted, superseded, revision, status)
    const res3 = await fetch(`${hub.url()}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "standalone task with forged state",
        targetAgentId: "executor-http-1",
        forceCompleted: true,
        superseded: true,
        revision: 99,
        attemptNumber: 10,
        currentAttemptId: "fake-id",
        status: "completed",
      }),
    });
    assert.equal(res3.status, 202);
    const data3 = await res3.json();
    const created3 = hub.tasks.get(data3.task.taskId);
    assert.ok(created3);
    assert.equal(created3.forceCompleted, null, "forceCompleted cannot be forged");
    assert.equal(created3.superseded, false, "superseded cannot be forged");
    assert.equal(created3.revision, 1, "revision reset to 1");
    assert.notEqual(created3.status, "completed", "status cannot be forged to completed");

    // 4. Client attempts to add task to a completed workflow -> HTTP 400
    root.status = "completed";
    const res4 = await fetch(`${hub.url()}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rootTaskId: root.taskId,
        input: "attempt to add task to completed workflow",
        targetAgentId: "executor-http-1",
      }),
    });
    assert.equal(res4.status, 400);
    const data4 = await res4.json();
    assert.match(data4.error, /Cannot add task to a completed or cancelled workflow/);
  } finally {
    await hub.stop();
  }
});

function agent(agentId, role) {
  return {
    agentId,
    status: "online",
    paused: false,
    busy: false,
    roles: [role],
    capabilities: ["task.execute", "coding", "reasoning"],
    models: [{ id: `${role}-model`, enabled: true, capabilities: ["task.execute", "coding", "reasoning"], quota: { state: "Healthy" } }],
    executors: [{ health: "Healthy", quota: "Healthy" }],
  };
}
