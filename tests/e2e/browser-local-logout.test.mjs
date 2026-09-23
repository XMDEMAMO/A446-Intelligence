import assert from "node:assert/strict";
import test from "node:test";
import { launchBrowser, startFixtureServer } from "./test-support.mjs";

test("local logout works when auth succeeds but the first business snapshot is offline", { timeout: 30_000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await launchBrowser();
  const page = await browser.newPage();
  fixture.state.failBusinessRequests = true;
  fixture.state.sessions.set("fixture-session-offline", "fixture-admin-id");
  try {
    await page.context().addCookies([{
      name: "a446_session",
      value: "fixture-session-offline",
      url: fixture.baseUrl,
      httpOnly: true,
      sameSite: "Strict",
    }]);
    await page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Hub 当前离线" }).waitFor();
    await page.getByText("fixture-admin", { exact: true }).waitFor();
    assert.equal(fixture.state.requests.filter((item) => item.pathname === "/v1/auth/me").length, 1, "/auth/me succeeds before business snapshot requests fail");
    assert.equal(await page.getByRole("button", { name: "＋ 新建协作任务" }).count(), 0, "offline gate exposes no task write action");

    await localLogout(page, fixture);
    assert.equal(await page.getByText("fixture-admin", { exact: true }).count(), 0, "the logged-in identity is cleared from the page");
    assert.equal(fixture.state.requests.filter((item) => item.pathname === "/v1/auth/logout").length, 0, "local logout does not claim to revoke the server session");
    assert.equal(fixture.state.sessions.size, 1, "the server session remains active until a server logout or revocation");

    const authChecks = fixture.state.requests.filter((item) => item.pathname === "/v1/auth/me").length;
    fixture.state.failBusinessRequests = false;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "登录 A446 协作台" }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(fixture.state.requests.filter((item) => item.pathname === "/v1/auth/me").length, authChecks, "network recovery and reload do not silently restore the old session");

    const restoreDialogPromise = acceptNextDialog(page);
    await page.getByRole("button", { name: "确认恢复旧 Session" }).click();
    assert.match(await restoreDialogPromise, /确认恢复这个旧 Session/);
    await page.getByText("Hub 已连接").waitFor();
    assert.equal(fixture.state.requests.filter((item) => item.pathname === "/v1/auth/me").length, authChecks + 1, "the old session returns only after explicit confirmation");
  } finally {
    await page.close();
    await browser.close();
    await fixture.close();
  }
});

test("reconnecting mode keeps writes disabled while allowing confirmed local logout", { timeout: 30_000 }, async () => {
  const fixture = await startFixtureServer();
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await login(page);
    await page.context().setOffline(true);
    await page.getByText("Hub 离线").first().waitFor();
    assert.equal(await page.getByRole("button", { name: "本地退出" }).isEnabled(), true, "browser offline state keeps local logout available");

    fixture.state.failBusinessRequests = true;
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.getByText("正在重连").first().waitFor();

    assert.equal(await page.getByRole("button", { name: "＋ 新建协作任务" }).isDisabled(), true);
    assert.equal(await page.getByPlaceholder("恢复实时连接后可发送旁注").isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "发送" }).isDisabled(), true);

    await page.getByRole("button", { name: "系统管理" }).click();
    await page.getByRole("heading", { name: "系统管理" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "创建 Operator" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "签发凭据" }).isDisabled(), true);

    await localLogout(page, fixture);
    assert.equal(await page.getByText("fixture-admin", { exact: true }).count(), 0, "the reconnecting page clears the logged-in identity");
    assert.equal(fixture.state.requests.filter((item) => item.pathname === "/v1/auth/logout").length, 0);
    assert.equal(fixture.state.sessions.size, 1);
    const authChecks = fixture.state.requests.filter((item) => item.pathname === "/v1/auth/me").length;
    fixture.state.failBusinessRequests = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(500);
    assert.equal(fixture.state.requests.filter((item) => item.pathname === "/v1/auth/me").length, authChecks, "reconnect events do not reauthenticate after local logout");
    await page.getByRole("heading", { name: "登录 A446 协作台" }).waitFor();
  } finally {
    await page.close();
    await browser.close();
    await fixture.close();
  }
});

async function login(page) {
  await page.getByRole("heading", { name: "登录 A446 协作台" }).waitFor();
  await page.getByLabel("用户名").fill("fixture-admin");
  await page.getByLabel("密码").fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByText("Hub 已连接").waitFor();
}

async function localLogout(page, fixture) {
  const dialogPromise = acceptNextDialog(page);
  await page.getByRole("button", { name: "本地退出" }).click();
  assert.match(await dialogPromise, /服务器 Session 尚未撤销/);
  await page.getByRole("heading", { name: "登录 A446 协作台" }).waitFor();
  await page.getByText("本机登录状态已清除，服务器 Session 尚未撤销。", { exact: false }).waitFor();
  assert.equal(fixture.state.sessions.size, 1);
}

function acceptNextDialog(page) {
  return new Promise((resolve) => {
    page.once("dialog", async (dialog) => {
      const message = dialog.message();
      await dialog.accept();
      resolve(message);
    });
  });
}
