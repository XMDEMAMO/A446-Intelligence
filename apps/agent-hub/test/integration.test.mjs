import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentHub } from "../src/hub.mjs";
import { AgentWorker } from "../src/worker.mjs";
import { delay, makeEnvelope } from "../src/common.mjs";

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
    assert.equal(hub.tasks.get(paused.task.taskId).schedulingErrorCode, "EXECUTOR_PAUSED");
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

test("workflow creation reports invalid explicit executors without creating tasks", async () => {
  const hub = await new AgentHub({ host: "127.0.0.1", port: 0, logs: { includePayloads: false } }).start();
  try {
    const response = await fetch(`${hub.url()}/v1/workflows`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "fixed work", executorAgentId: "missing" }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "EXECUTOR_UNAVAILABLE");
    assert.equal(hub.tasks.size, 0);
    const bound = hub.createTask({ targetAgentId: "assigned-executor", input: "bound work" });
    await hub.handleWorkerMessage("another-agent", makeEnvelope("task.started", {
      agentId: "another-agent", taskId: bound.taskId,
    }));
    assert.equal(bound.status, "queued");
  } finally {
    await hub.stop();
  }
});

test("conversation cancellation and summary reads preserve full-result detail", async () => {
  const hub = await new AgentHub({ host: "127.0.0.1", port: 0, logs: { includePayloads: false } }).start();
  try {
    const task = hub.createTask({ input: "work", role: "executor", contextBundle: { fullResult: "private context" } });
    task.output = "private output";
    task.submission = { brief: "summary", fullResult: "private result" };
    hub.markTask(task);
    const message = hub.addMessage(task, { text: "result", attachments: [{ type: "full_result", content: "private attachment", taskId: task.taskId }] });
    const taskList = await (await fetch(`${hub.url()}/v1/tasks?rootTaskId=${task.taskId}&view=summary`)).json();
    assert.equal(taskList.tasks.length, 1);
    assert.equal(JSON.stringify(taskList).includes("private"), false);
    const fullTask = await (await fetch(`${hub.url()}/v1/tasks/${task.taskId}`)).json();
    assert.equal(fullTask.task.submission.fullResult, "private result");
    const messageList = await (await fetch(`${hub.url()}/v1/messages?rootTaskId=${task.taskId}&view=summary`)).json();
    assert.equal(JSON.stringify(messageList).includes("private attachment"), false);
    const fullMessage = await (await fetch(`${hub.url()}/v1/messages/${message.messageId}`)).json();
    assert.equal(fullMessage.message.attachments[0].content, "private attachment");
    await hub.handleCommand({ type: "task.cancel", taskId: task.taskId });
    assert.equal(hub.conversations()[0].status, "cancelled");
    for (const type of ["task.started", "approval.request", "task.rejected", "task.result"]) {
      await hub.handleWorkerMessage("late-agent", makeEnvelope(type, { agentId: "late-agent", taskId: task.taskId, payload: { output: "late" } }));
      assert.equal(task.status, "cancelled");
    }
    assert.equal([...hub.interventions.values()].filter((item) => item.status === "pending").length, 0);
  } finally {
    await hub.stop();
  }
});

test("identity HTTP routes pass trusted client IP and enforce administrator boundaries", async () => {
  const calls = [];
  const userId = "11111111-1111-4111-8111-111111111111";
  const service = {
    async init() {},
    async login(username, _password, context) {
      calls.push(["login", username, context.clientIp]);
      if (username === "limited") throw Object.assign(new Error("Try again later"), {
        statusCode: 429, code: "AUTH_RATE_LIMITED", retryAfterMs: 2000, headers: { "retry-after": "2" },
      });
      return { actor: { kind: "web", id: "user:admin", userId, username, role: "admin" }, csrfToken: "csrf", expiresAt: new Date().toISOString(), cookie: "session=x", csrfCookie: "csrf=x" };
    },
    async authenticateWeb(request) {
      const role = request.headers["x-test-role"];
      return role ? { kind: "web", id: `user:${role}`, userId, username: role, role } : null;
    },
    verifyCsrf(request) {
      if (request.headers["x-csrf-token"] !== "csrf") throw Object.assign(new Error("CSRF failed"), { statusCode: 403 });
    },
    async listUsers() { calls.push(["list"]); return [{ userId, username: "admin", role: "admin", status: "active", createdAt: "2026-09-18T00:00:00.000Z", passwordHash: "must-not-leak" }]; },
    async createUser() { throw new Error("Direct user creation must not be used by HTTP"); },
    async createOperator(input) { calls.push(["create", input.role]); return { userId, username: input.username, role: input.role }; },
    async setUserStatus(id, status) { calls.push(["status", id, status]); return { userId: id, status }; },
    async revokeUserSessions(id) { calls.push(["revoke", id]); return 2; },
  };
  const hub = await new AgentHub({
    host: "127.0.0.1", port: 0, auth: { mode: "identity", trustedProxyIps: ["127.0.0.1"] },
    logs: { includePayloads: false },
  }, { authService: service }).start();
  const request = (pathname, role, method = "GET", body) => fetch(`${hub.url()}${pathname}`, {
    method,
    headers: { ...(role ? { "x-test-role": role, "x-csrf-token": "csrf" } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    const anonymous = await request("/v1/tasks");
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "AUTH_REQUIRED");
    const login = await fetch(`${hub.url()}/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
      body: JSON.stringify({ username: "admin", password: "test" }),
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.id, userId);
    assert.deepEqual(calls[0], ["login", "admin", "192.0.2.10"]);
    hub.config.auth.trustedProxyIps = [];
    const untrustedForward = await fetch(`${hub.url()}/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.20" },
      body: JSON.stringify({ username: "admin", password: "test" }),
    });
    assert.equal(untrustedForward.status, 200);
    await untrustedForward.json();
    assert.equal(calls.at(-1)[2], "127.0.0.1");
    const limited = await fetch(`${hub.url()}/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "limited", password: "test" }),
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "2");
    assert.equal((await limited.json()).retryAfterMs, 2000);
    assert.equal((await request("/v1/admin/users", "operator")).status, 403);
    const me = await request("/v1/auth/me", "admin");
    assert.equal(me.status, 200);
    assert.deepEqual((await me.json()).user, { id: userId, username: "admin", role: "admin", status: "active", createdAt: "2026-09-18T00:00:00.000Z" });
    const users = await request("/v1/admin/users", "admin");
    assert.equal(users.status, 200);
    assert.equal((await users.json()).users[0].id, userId);
    const csrfFailure = await fetch(`${hub.url()}/v1/admin/users`, {
      method: "POST", headers: { "x-test-role": "admin", "content-type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "secret" }),
    });
    assert.equal(csrfFailure.status, 403);
    assert.equal((await csrfFailure.json()).code, "CSRF_FAILED");
    const forbiddenAdmin = await request("/v1/admin/users", "admin", "POST", { username: "new-admin", password: "secret", role: "admin" });
    assert.equal(forbiddenAdmin.status, 403);
    assert.equal((await forbiddenAdmin.json()).code, "ADMIN_HTTP_CREATION_FORBIDDEN");
    const created = await request("/v1/admin/users", "admin", "POST", { username: "operator", password: "secret" });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).user.id, userId);
    assert.ok(calls.some((item) => item[0] === "create" && item[1] === "operator"));
    const changed = await request(`/v1/admin/users/${userId}`, "admin", "PATCH", { status: "disabled" });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).user.id, userId);
    const revoked = await request(`/v1/admin/users/${userId}/revoke-sessions`, "admin", "POST");
    assert.equal((await revoked.json()).revokedSessions, 2);
  } finally {
    await hub.stop();
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
