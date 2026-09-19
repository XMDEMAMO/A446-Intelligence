import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser } from "./test-support.mjs";

test("live browser release gate: login, identity display, Executor selection, offline write guard, and logout", { timeout: 60_000 }, async () => {
  const baseUrl = requiredEnvironment("A446_E2E_BASE_URL");
  const username = requiredEnvironment("A446_E2E_ADMIN_USERNAME");
  const password = requiredEnvironment("A446_E2E_ADMIN_PASSWORD");
  if (process.env.A446_E2E_ALLOW_MUTATION !== "1") {
    throw new Error("A446_E2E_ALLOW_MUTATION=1 is required because this release test creates and cancels a disposable workflow.");
  }
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "登录 A446 协作台" }).waitFor();
    await page.getByLabel("用户名").fill(username);
    await page.getByLabel("密码").fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByText("Hub 已连接").waitFor();

    await page.getByText(username, { exact: false }).first().waitFor();
    await page.getByRole("button", { name: "＋ 新建协作任务" }).click();
    const executorSelect = page.getByLabel("执行 Agent");
    await executorSelect.waitFor();
    const options = await executorSelect.locator("option:not([disabled])").allTextContents();
    assert.ok(options.length >= 2, "Executor selector exposes automatic and at least one available Executor option");
    await executorSelect.selectOption({ index: 1 });
    await page.getByLabel("任务名称").fill(`Release gate ${Date.now()}`);
    await page.getByLabel("目标").fill("Create and cancel one disposable release-gate workflow");
    await page.getByLabel("验收标准").fill("The selected Executor remains bound");
    const workflowResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/v1/workflows") && response.request().method() === "POST");
    await page.getByRole("button", { name: "创建任务群聊" }).click();
    const workflowResponse = await workflowResponsePromise;
    assert.equal(workflowResponse.status(), 201);
    const workflow = await workflowResponse.json();
    const cancelled = await page.evaluate(async (taskId) => {
      const response = await fetch("/api/v1/commands", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-csrf-token": window.sessionStorage.getItem("a446.csrf") ?? "" },
        body: JSON.stringify({ type: "task.cancel", taskId }),
      });
      return { status: response.status, body: await response.json() };
    }, workflow.task.taskId);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.task?.status ?? "cancelled", "cancelled");

    await page.context().setOffline(true);
    await page.waitForTimeout(3500);
    await page.getByText(/正在重连|离线/).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "＋ 新建协作任务" }).isDisabled(), true, "offline mode disables task creation");
    await page.context().setOffline(false);
    await page.getByText("Hub 已连接").waitFor();

    await page.getByRole("button", { name: /退出|登出/ }).click();
    await page.getByRole("heading", { name: "登录 A446 协作台" }).waitFor();
  } finally {
    await page.close();
    await browser.close();
  }
});

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live browser release gate.`);
  return value;
}
