import test from "node:test";
import assert from "node:assert/strict";
import { AgentHub } from "../src/hub.mjs";
import { MemoryHubStore } from "../src/hub-store.mjs";

test("human interventions survive restart, resolve once, and resume the recorded workflow node", async () => {
  const store = new MemoryHubStore();
  let hub = await new AgentHub(testConfig(), { store }).start();
  const workflow = { enabled: true, plannerAgentId: "planner", reviewerAgentId: "reviewer", maxReviewCycles: 1 };
  const root = hub.createTask({
    targetAgentId: "planner",
    input: "persistent objective",
    role: "planner",
    stage: "planning",
    workflow,
    sessionScopeId: "planner-session-scope",
    taskSpec: { title: "Persistent workflow", acceptance: ["resumes correctly"] },
  });
  const origin = hub.createTask({
    targetAgentId: "reviewer",
    input: "review a private result",
    rootTaskId: root.taskId,
    parentTaskId: root.taskId,
    role: "reviewer",
    stage: "result_review",
    workflow,
    sessionScopeId: "reviewer-session-scope",
  });
  origin.output = "full private result that must not be copied";
  const intervention = hub.requireHuman(origin, "Choose the recovery direction");
  await hub.flushState();
  assert.equal(intervention.status, "pending");
  assert.equal(JSON.stringify(intervention).includes("full private result"), false);

  await hub.stop();
  hub = await new AgentHub(testConfig(), { store }).start();
  try {
    const listing = await fetch(`${hub.url()}/v1/interventions?status=pending`);
    assert.equal(listing.status, 200);
    const listed = (await listing.json()).interventions;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].taskId, origin.taskId);
    assert.equal(listed[0].requesterRole, "reviewer");
    assert.equal(listed[0].requesterStage, "result_review");
    assert.equal(listed[0].sessionScopeId, "reviewer-session-scope");

    const resolve = () => fetch(`${hub.url()}/v1/interventions/${intervention.interventionId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "respond", response: "Continue with the corrected direction" }),
    });
    const responses = await Promise.all([resolve(), resolve()]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    await Promise.all(responses.map((response) => response.text()));

    const restoredIntervention = hub.interventions.get(intervention.interventionId);
    assert.equal(restoredIntervention.status, "resolved");
    assert.equal(restoredIntervention.decision, "respond");
    const continuation = [...hub.tasks.values()].find((task) => task.parentTaskId === origin.taskId && task.stage === "human_followup");
    assert.ok(continuation);
    assert.equal(continuation.role, "planner");
    assert.equal(continuation.sessionScopeId, "planner-session-scope");
    assert.equal(continuation.contextBundle.humanResponse, "Continue with the corrected direction");
    assert.equal("fullResult" in continuation.contextBundle, false);
    assert.ok(hub.log.recent(100).some((event) => event.type === "intervention.resolved" && event.details.interventionId === intervention.interventionId));

    await hub.stop();
    hub = await new AgentHub(testConfig(), { store }).start();
    assert.equal(hub.interventions.get(intervention.interventionId)?.status, "resolved");
    assert.ok([...hub.tasks.values()].some((task) => task.taskId === continuation.taskId && task.sessionScopeId === "planner-session-scope"));
  } finally {
    await hub.stop();
  }
});

test("approval interventions require an administrator and rejection is terminal", async () => {
  const store = new MemoryHubStore();
  const hub = await new AgentHub(testConfig(), { store }).start();
  try {
    const task = hub.createTask({ targetAgentId: "worker", input: "dangerous retry", requiresApproval: true });
    await hub.flushState();
    const intervention = [...hub.interventions.values()].find((item) => item.taskId === task.taskId);
    assert.equal(intervention.kind, "task_approval");
    await assert.rejects(
      hub.resolveIntervention(intervention.interventionId, { decision: "reject", response: "Do not run" }, { id: "user:operator", role: "operator" }),
      (error) => error.statusCode === 403,
    );
    const result = await hub.resolveIntervention(
      intervention.interventionId,
      { decision: "reject", response: "Do not run" },
      { id: "user:admin", role: "admin" },
    );
    assert.equal(result.task.status, "rejected");
    assert.equal(hub.conversations()[0].humanIntervention.status, "resolved");
    await assert.rejects(
      hub.resolveIntervention(intervention.interventionId, { decision: "approve" }, { id: "user:admin", role: "admin" }),
      (error) => error.statusCode === 409,
    );
  } finally {
    await hub.stop();
  }
});

function testConfig() {
  return {
    host: "127.0.0.1",
    port: 0,
    logs: { includePayloads: false },
  };
}
