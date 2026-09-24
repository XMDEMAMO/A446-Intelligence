import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, startFixtureServer } from "./test-support.mjs";

test("browser E2E: admin UI manages users, sessions, and one-time Worker credentials", { timeout: 45_000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await launchBrowser();
  const adminContext = await browser.newContext();
  const operatorContext = await browser.newContext();
  const visibilityContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const operatorPage = await operatorContext.newPage();
  const visibilityPage = await visibilityContext.newPage();
  try {
    await adminPage.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await login(adminPage, "fixture-admin", "fixture-admin-password");

    assert.equal(fixture.state.requests.some((item) => item.pathname === "/v1/messages" && item.search.includes("view=summary")), true, "conversation loading uses the summary message endpoint");
    assert.equal(fixture.state.requests.filter((item) => item.pathname === "/v1/messages/fixture-message-1").length, 0, "summary load does not fetch full message detail");
    const fullResultToggle = adminPage.getByText("完整成果", { exact: true });
    await fullResultToggle.click();
    await adminPage.getByText("fixture full result").waitFor();
    assert.equal(fixture.state.requests.filter((item) => item.pathname === "/v1/messages/fixture-message-1").length, 1, "opening the attachment loads exactly one message detail");
    await fullResultToggle.click();
    await fullResultToggle.click();
    await adminPage.waitForTimeout(100);
    assert.equal(fixture.state.requests.filter((item) => item.pathname === "/v1/messages/fixture-message-1").length, 1, "reopening an already loaded result does not refetch without bound");

    await adminPage.getByRole("button", { name: "系统管理" }).click();
    await adminPage.getByRole("heading", { name: "系统管理" }).waitFor();

    const username = "fixture-created-operator";
    const password = "fixture-created-password";
    await adminPage.getByLabel("用户名").fill(username);
    await adminPage.getByLabel("初始密码").fill(password);
    await adminPage.getByRole("button", { name: "创建 Operator" }).click();
    await adminPage.getByText("Operator 已创建").waitFor();
    const userRow = adminPage.getByRole("row").filter({ hasText: username });
    await userRow.waitFor();
    await userRow.getByText("正常", { exact: true }).waitFor();

    await operatorPage.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await login(operatorPage, username, password);
    assert.equal((await apiRequest(operatorPage, "GET", "/api/v1/auth/me")).status, 200);

    adminPage.once("dialog", (dialog) => void dialog.accept());
    await userRow.getByRole("button", { name: "撤销会话" }).click();
    await adminPage.getByText("已撤销 1 个会话").waitFor();
    assert.equal((await apiRequest(operatorPage, "GET", "/api/v1/auth/me")).status, 401, "revoking sessions invalidates the existing operator session");

    adminPage.once("dialog", (dialog) => void dialog.accept());
    await userRow.getByRole("button", { name: "停用" }).click();
    await adminPage.getByText("用户已停用，现有会话已撤销").waitFor();
    await userRow.getByText("已停用", { exact: true }).waitFor();
    await userRow.getByRole("button", { name: "启用" }).click();
    await adminPage.getByText("用户已启用").waitFor();
    await userRow.getByText("正常", { exact: true }).waitFor();

    const agentId = "fixture-ui-worker";
    await adminPage.getByLabel("Agent ID").fill(agentId);
    await adminPage.getByLabel("Device ID").fill("fixture-ui-device");
    await adminPage.getByRole("button", { name: "签发凭据" }).click();
    const tokenDialog = adminPage.getByRole("dialog", { name: "保存 Worker Token" });
    await tokenDialog.waitFor();
    const firstToken = (await tokenDialog.locator("code").textContent())?.trim() ?? "";
    assert.match(firstToken, /^fixture_token_/);
    await assertSecretIsEphemeral(adminPage, firstToken, true);
    await tokenDialog.getByRole("button", { name: "我已安全保存，关闭" }).click();
    await tokenDialog.waitFor({ state: "detached" });
    await assertSecretIsEphemeral(adminPage, firstToken, false);

    let activeCredential = adminPage.locator(".credential-card").filter({ hasText: agentId }).filter({ hasText: "active" });
    await activeCredential.waitFor();
    adminPage.once("dialog", (dialog) => void dialog.accept());
    await activeCredential.getByRole("button", { name: "轮换" }).click();
    await tokenDialog.waitFor();
    const rotatedToken = (await tokenDialog.locator("code").textContent())?.trim() ?? "";
    assert.match(rotatedToken, /^fixture_token_/);
    assert.notEqual(rotatedToken, firstToken);
    await assertSecretIsEphemeral(adminPage, rotatedToken, true);
    await tokenDialog.getByRole("button", { name: "我已安全保存，关闭" }).click();
    await tokenDialog.waitFor({ state: "detached" });
    await assertSecretIsEphemeral(adminPage, rotatedToken, false);

    activeCredential = adminPage.locator(".credential-card").filter({ hasText: agentId }).filter({ hasText: "active" });
    adminPage.once("dialog", (dialog) => void dialog.accept());
    await activeCredential.getByRole("button", { name: "撤销" }).click();
    await adminPage.getByText("Worker 凭据已撤销").waitFor();
    await adminPage.locator(".credential-card").filter({ hasText: agentId }).filter({ hasText: "revoked" }).last().waitFor();

    await visibilityPage.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await login(visibilityPage, "fixture-operator", "fixture-operator-password");
    assert.equal(await visibilityPage.getByRole("button", { name: "系统管理" }).count(), 0, "operator cannot see the management entry point");
    const forbidden = await apiRequest(visibilityPage, "POST", "/api/v1/admin/users", { username: "operator-forbidden", password: "fixture-password-123", role: "operator" });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, "FORBIDDEN");
  } finally {
    await adminContext.close();
    await operatorContext.close();
    await visibilityContext.close();
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

async function assertSecretIsEphemeral(page, token, visible) {
  assert.equal(page.url().includes(token), false, "one-time token is never placed in the URL");
  const storageContainsToken = await page.evaluate((secret) => {
    const values = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) values.push(storage.getItem(storage.key(index) ?? "") ?? "");
    }
    return values.some((value) => value.includes(secret));
  }, token);
  assert.equal(storageContainsToken, false, "one-time token is never persisted in browser storage");
  assert.equal((await page.locator("body").innerText()).includes(token), visible, visible ? "token is visible in the one-time dialog" : "token disappears after the one-time dialog closes");
}

async function apiRequest(page, method, url, body) {
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
