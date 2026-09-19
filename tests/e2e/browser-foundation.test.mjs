import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, startFixtureServer } from "./test-support.mjs";

test("browser E2E: authentication, reviewed result, intervention, and workflow creation", { timeout: 30_000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "登录 A446 协作台" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "＋ 新建协作任务" }).count(), 0, "unauthenticated users cannot reach business controls");

    await page.getByLabel("用户名").fill("fixture-admin");
    await page.getByLabel("密码").fill("wrong-password");
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByText("AUTH_INVALID_CREDENTIALS").waitFor();

    await page.getByLabel("密码").fill("fixture-admin-password");
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByText("Hub 已连接").waitFor();
    await page.getByRole("heading", { name: "Fixture release acceptance" }).waitFor();
    await page.getByText("客户端暂无可读取的额度快照").first().waitFor();

    await page.getByText("完整成果").click();
    await page.getByText("fixture full result").waitFor();
    await page.getByText("需要你的决定").waitFor();
    await page.getByRole("button", { name: "批准" }).click();
    await page.getByText("请求已批准").waitFor();
    await page.getByText("需要你的决定").waitFor({ state: "detached" });

    await page.getByRole("button", { name: "＋ 新建协作任务" }).click();
    await page.getByLabel("任务名称").fill("Browser fixture workflow");
    await page.getByLabel("目标").fill("Exercise the contract-driven browser path");
    await page.getByLabel("验收标准").fill("Workflow request reaches the Hub");
    await page.getByLabel("规划 Agent").selectOption("fixture-planner");
    await page.getByLabel("审核 Agent").selectOption("fixture-reviewer");
    await page.getByRole("button", { name: "创建任务群聊" }).click();
    await page.getByText("协作任务已创建").waitFor();
    assert.equal(fixture.state.lastWorkflowBody.plannerAgentId, "fixture-planner");
    assert.equal(fixture.state.lastWorkflowBody.reviewerAgentId, "fixture-reviewer");
    assert.deepEqual(fixture.state.lastWorkflowBody.acceptance, ["Workflow request reaches the Hub"]);
  } finally {
    await page.close();
    await browser.close();
    await fixture.close();
  }
});
