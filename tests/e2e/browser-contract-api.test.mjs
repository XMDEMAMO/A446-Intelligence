import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, startFixtureServer } from "./test-support.mjs";

test("browser E2E: executor constraint, RBAC, one-time credential, cancellation, and logout contracts", { timeout: 30_000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await login(page, "fixture-admin", "fixture-admin-password");

    const me = await browserRequest(page, "GET", "/api/v1/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.user.role, "admin");

    const unavailable = await browserRequest(page, "POST", "/api/v1/workflows", {
      title: "Unavailable Executor",
      objective: "must not silently fall back",
      acceptance: [],
      executorAgentId: "fixture-executor-offline",
    });
    assert.equal(unavailable.status, 409);
    assert.equal(unavailable.body.code, "EXECUTOR_UNAVAILABLE");

    const explicit = await browserRequest(page, "POST", "/api/v1/workflows", {
      title: "Explicit Executor",
      objective: "bind the selected Executor",
      acceptance: ["executor remains stable"],
      executorAgentId: "fixture-executor",
    });
    assert.equal(explicit.status, 202);
    assert.equal(explicit.body.task.executorAgentId, "fixture-executor");

    const cancelled = await browserRequest(page, "POST", "/api/v1/commands", { type: "task.cancel", taskId: explicit.body.task.taskId });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.task.status, "cancelled");

    const taskSummary = await browserRequest(page, "GET", "/api/v1/tasks?rootTaskId=fixture-root-1&view=summary");
    assert.equal(taskSummary.status, 200);
    assert.equal(taskSummary.body.tasks.length, 1);
    assert.equal(Object.hasOwn(taskSummary.body.tasks[0], "output"), false);
    assert.equal(Object.hasOwn(taskSummary.body.tasks[0].submission, "fullResult"), false);
    assert.equal(JSON.stringify(taskSummary.body).includes("fixture private"), false);
    const taskDetail = await browserRequest(page, "GET", "/api/v1/tasks/fixture-task-1");
    assert.equal(taskDetail.body.task.output, "fixture private output");
    assert.equal(taskDetail.body.task.submission.fullResult, "fixture full result");

    const messageSummary = await browserRequest(page, "GET", "/api/v1/messages?rootTaskId=fixture-root-1&view=summary");
    assert.equal(messageSummary.status, 200);
    assert.equal(Object.hasOwn(messageSummary.body.messages[0].attachments[0], "content"), false);
    const messageDetail = await browserRequest(page, "GET", "/api/v1/messages/fixture-message-1");
    assert.equal(messageDetail.body.message.attachments[0].content, "fixture full result");

    const csrfFailure = await page.evaluate(async () => {
      const response = await fetch("/api/v1/admin/users", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "csrf-blocked", password: "fixture-password-123", role: "operator" }),
      });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(csrfFailure.status, 403);
    assert.equal(csrfFailure.body.code, "CSRF_FAILED");

    const created = await browserRequest(page, "POST", "/api/v1/admin/workers", { agentId: "fixture-new-executor", deviceId: "fixture-new-device" });
    assert.equal(created.status, 201);
    assert.equal(Object.hasOwn(created.body, "token"), false, "worker token follows the frozen nested credential response");
    assert.match(created.body.credential.token, /^fixture_token_/);
    const firstToken = created.body.credential.token;
    const listed = await browserRequest(page, "GET", "/api/v1/admin/workers");
    assert.equal(listed.status, 200);
    assert.equal(JSON.stringify(listed.body).includes(firstToken), false, "worker token is not returned by list APIs");
    assert.equal(Array.isArray(listed.body.credentials), true);
    assert.equal(Object.hasOwn(listed.body, "workers"), false);
    assert.equal(listed.body.credentials.some((item) => Object.hasOwn(item, "token") || Object.hasOwn(item, "tokenHash")), false);

    const rotated = await browserRequest(page, "POST", `/api/v1/admin/workers/${created.body.credential.credentialId}/rotate`, {});
    assert.equal(rotated.status, 200);
    assert.equal(Object.hasOwn(rotated.body, "token"), false);
    assert.match(rotated.body.credential.token, /^fixture_token_/);
    assert.notEqual(rotated.body.credential.token, firstToken);
    const afterRotate = await browserRequest(page, "GET", "/api/v1/admin/workers");
    assert.equal(JSON.stringify(afterRotate.body).includes(rotated.body.credential.token), false, "rotated token is displayed only in its success response");

    const resolved = await browserRequest(page, "POST", "/api/v1/interventions/fixture-intervention-1/resolve", { decision: "approve" });
    assert.equal(resolved.status, 200);
    const repeated = await browserRequest(page, "POST", "/api/v1/interventions/fixture-intervention-1/resolve", { decision: "approve" });
    assert.equal(repeated.status, 409);

    const logout = await browserRequest(page, "POST", "/api/v1/auth/logout", {});
    assert.equal(logout.status, 200);
    const afterLogout = await browserRequest(page, "GET", "/api/v1/auth/me");
    assert.equal(afterLogout.status, 401);

    await page.reload({ waitUntil: "domcontentloaded" });
    await login(page, "fixture-operator", "fixture-operator-password");
    const forbidden = await browserRequest(page, "POST", "/api/v1/admin/workers", { agentId: "operator-forbidden", deviceId: "operator-device" });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, "FORBIDDEN");
  } finally {
    await page.close();
    await browser.close();
    await fixture.close();
  }
});

async function login(page, username, password) {
  await page.getByRole("heading", { name: "登录 A446 协作台" }).waitFor();
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByText("Hub 已连接").waitFor();
}

async function browserRequest(page, method, url, body) {
  return page.evaluate(async ({ requestMethod, requestUrl, requestBody }) => {
    const csrf = window.sessionStorage.getItem("a446.csrf") ?? "";
    const response = await fetch(requestUrl, {
      method: requestMethod,
      credentials: "include",
      headers: {
        ...(requestBody === undefined ? {} : { "content-type": "application/json" }),
        ...(["GET", "HEAD"].includes(requestMethod) ? {} : { "x-csrf-token": csrf }),
      },
      ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }, { requestMethod: method, requestUrl: url, requestBody: body });
}
