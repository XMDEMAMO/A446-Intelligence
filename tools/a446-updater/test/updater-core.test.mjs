import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { UpdaterCore, createHealthChecker } from "../lib/core.mjs";
import { layoutPaths, resolveCurrentTarget } from "../lib/layout.mjs";
import { UpdaterError } from "../lib/util.mjs";
import {
  REPOSITORY,
  buildFakePackage,
  createFakeLiveInstall,
  sha256,
  startFakeHub,
  startFakeReleaseServer,
} from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const CLV = "0.5.0-preview15";
const NEW_V = "0.5.0-preview16";
const OLD_V = "0.5.0-preview14";

async function hashTree(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push({ relative: path.relative(root, full), sha256: sha256(await fs.readFile(full)) });
    }
  }
  if (existsSync(root)) await walk(root);
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return files;
}

/**
 * Full local harness: fake installed package + fake GitHub releases +
 * fake hub health endpoints. Uses the mock process controller so no real
 * A446 process is ever touched, and skips npm dependency installation.
 */
async function startHarness(t, { role = "worker", healthTimeoutSeconds = 30 } = {}) {
  const fakeLive = await createFakeLiveInstall({ version: CLV });
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "a446-core-home-"));
  const installRoot = path.join(fakeLive.staging, ".a446");
  const hub = await startFakeHub({
    initialState: { healthy: true, agents: [{ agentId: "test-device-codex", deviceId: "test-device", status: "online" }] },
  });
  const core = new UpdaterCore({ home, config: {}, logger: () => {} });
  await core.adopt({ live: fakeLive.live, role, deviceId: "test-device", installRoot });
  core.config.healthTimeoutSeconds = healthTimeoutSeconds;
  const releaseServer = await startFakeReleaseServer({ releases: [] });
  const context = {
    fakeLive, home, installRoot, hub, core, releaseServer,
    livePath: fakeLive.live,
    sharedVar: layoutPaths(installRoot).sharedVarDir,
    mockActions: async () => JSON.parse(await fs.readFile(path.join(home, "mock-process-actions.json"), "utf8").catch(() => JSON.stringify({ actions: [] }))).actions,
  };
  t.after(async () => {
    // Close the CURRENT server: addRelease() replaces context.releaseServer,
    // and closing only the originally captured instance would leak the live
    // listener and keep the test process alive after the run.
    if (context.releaseServer) await context.releaseServer.close().catch(() => {});
    await hub.close();
    await fs.rm(fakeLive.staging, { recursive: true, force: true }).catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });
  return context;
}

function setReleases(ctx, releases) {
  void releases;
  return Promise.resolve();
}

function overrides(ctx) {
  return {
    apiBase: ctx.releaseServer.url,
    allowHttp: true,
    processController: "mock",
    healthBase: ctx.hub.url,
    skipDependencyInstall: true,
  };
}

/**
 * Runs one CLI child process against the harness (real process exit, used to
 * simulate power-loss style termination via A446_UPDATER_FAULTS).
 */
async function runCli(ctx, { faults } = {}) {
  const entry = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "a446-updater.mjs");
  const { stdout } = await execFileAsync(
    process.execPath,
    [entry, "update", "--api-base", ctx.releaseServer.url, "--allow-http", "--process-controller", "mock",
      "--health-base", ctx.hub.url, "--skip-dependency-install"],
    { env: { ...process.env, A446_UPDATER_HOME: ctx.home, ...(faults ? { A446_UPDATER_FAULTS: faults } : {}) }, timeout: 180_000 },
  ).catch((error) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code, exitCode: error.code }));
  return stdout;
}

/** Temporarily intercepts the first matching fetch call. */
async function interceptFirstFetch(matcher, responder, run) {
  const originalFetch = globalThis.fetch;
  let intercepted = false;
  globalThis.fetch = async (url, options) => {
    if (!intercepted && matcher(String(url))) {
      intercepted = true;
      globalThis.fetch = originalFetch;
      return responder();
    }
    return originalFetch(url, options);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function addRelease(ctx, { version, faults = [], files = {} } = {}) {
  const pkg = await buildFakePackage({ version, files, faults: faults.filter((f) => f.startsWith("zipslip") || f === "runtime-var") });
  const zipBytes = await fs.readFile(pkg.zipPath);
  const zipSha256 = sha256(zipBytes);
  const release = {
    version,
    rootName: pkg.rootName,
    zipBytes,
    zipSha256,
    manifestSha256: faults.includes("badsha") ? "b".repeat(64) : zipSha256,
    fault: faults.includes("corrupt") ? "corrupt" : faults.includes("truncate") ? "truncate" : undefined,
  };
  if (ctx.releaseServer) await ctx.releaseServer.close();
  const server = await startFakeReleaseServer({ releases: [...(ctx.releases ?? []), release] });
  ctx.releases = [...(ctx.releases ?? []), release];
  ctx.releaseServer = server;
  ctx.core.overrides = { ...ctx.core.overrides, apiBase: server.url, ...{ allowHttp: true, processController: "mock", healthBase: ctx.hub.url, skipDependencyInstall: true } };
  return release;
}

test("acceptance 1: update to the same version refuses with exit 3 and changes nothing", async (t) => {
  const ctx = await startHarness(t);
  await addRelease(ctx, { version: CLV });
  await assert.rejects(
    () => ctx.core.update({ version: CLV }),
    (error) => error.code === "UP_TO_DATE" && error.exitCode === 3,
  );
  const actions = (await ctx.mockActions()).filter((entry) => entry.action === "stop" || entry.action === "start");
  assert.deepEqual(actions, [], "no process stop/start may happen");
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV);
  assert.ok(existsSync(path.join(ctx.sharedVar, "lan", "pairing-token.txt")));
});

test("acceptance 2: a normal upgrade completes, becomes current, and keeps persistent data", async (t) => {
  const ctx = await startHarness(t);
  await addRelease(ctx, { version: NEW_V });
  const varBefore = await hashTree(ctx.sharedVar);
  const workspacesBefore = await hashTree(layoutPaths(ctx.installRoot).sharedWorkspacesDir);

  const result = await ctx.core.update({ version: NEW_V });
  assert.equal(result.job.phase, "completed");
  assert.equal(result.job.fromVersion, CLV);
  assert.equal(result.job.toVersion, NEW_V);
  const current = await resolveCurrentTarget(ctx.installRoot);
  assert.equal(current.version, NEW_V);
  assert.ok(existsSync(path.join(ctx.installRoot, "versions", NEW_V, "apps", "agent-hub", "src", "worker.mjs")));
  assert.ok(existsSync(path.join(ctx.installRoot, "versions", CLV)), "previous version kept as rollback point");
  assert.deepEqual(await hashTree(ctx.sharedVar), varBefore, "shared var untouched");
  assert.deepEqual(await hashTree(layoutPaths(ctx.installRoot).sharedWorkspacesDir), workspacesBefore, "workspaces untouched");
  const actions = await ctx.mockActions();
  assert.equal(actions.filter((a) => a.action === "stop").length, 1);
  assert.equal(actions.filter((a) => a.action === "start").length, 1);
});

test("acceptance 3: downgrades and unknown versions are refused (exit 11)", async (t) => {
  const ctx = await startHarness(t);
  await addRelease(ctx, { version: OLD_V });
  await assert.rejects(
    () => ctx.core.update({ version: OLD_V }),
    (error) => error.code === "VERSION_DOWNGRADE_REFUSED" && error.exitCode === 11,
  );
  await assert.rejects(
    () => ctx.core.update({ version: "9.9.9" }),
    (error) => error.code === "VERSION_NOT_FOUND" && error.exitCode === 11,
  );
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV);
  assert.equal(existsSync(path.join(ctx.installRoot, "versions", OLD_V)), false);
});

test("acceptance 4: SHA-256 mismatch rejects the package and keeps the old version running", async (t) => {
  const ctx = await startHarness(t);
  await addRelease(ctx, { version: NEW_V, faults: ["badsha"] });
  await assert.rejects(
    () => ctx.core.update({ version: NEW_V }),
    (error) => error.code === "SHA256_MISMATCH" && error.exitCode === 12,
  );
  const state = await ctx.core.loadState();
  assert.equal(state.job.phase, "failed");
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV);
  const stops = (await ctx.mockActions()).filter((a) => a.action === "stop");
  assert.deepEqual(stops, [], "nothing may be stopped before the switch");
});

test("acceptance 5a: a corrupt zip is rejected at listing time", async (t) => {
  const ctx = await startHarness(t);
  await addRelease(ctx, { version: NEW_V, faults: ["corrupt"] });
  await assert.rejects(
    () => ctx.core.update({ version: NEW_V }),
    (error) => error.exitCode === 12,
  );
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV);
});

test("acceptance 5b: path traversal zips are rejected and never extracted into place", async (t) => {
  for (const fault of ["zipslip-parent", "zipslip-absolute", "zipslip-backslash", "zipslip-colon"]) {
    const ctx = await startHarness(t);
    await addRelease(ctx, { version: NEW_V, faults: [fault] });
    await assert.rejects(
      () => ctx.core.update({ version: NEW_V }),
      (error) => error.exitCode === 12,
      `fault ${fault} must be rejected`,
    );
    assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV);
    await ctx.releaseServer.close().catch(() => {});
  }
});

test("acceptance 6: an interrupted download can be retried safely", async (t) => {
  const ctx = await startHarness(t);
  await addRelease(ctx, { version: NEW_V, faults: ["truncate"] });
  await assert.rejects(
    () => ctx.core.update({ version: NEW_V }),
    (error) => error.code === "SHA256_MISMATCH" && error.exitCode === 12,
  );
  const state = await ctx.core.loadState();
  assert.equal(state.job.phase, "failed");
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV);
  // Retry without the fault: add a clean release and update again.
  ctx.releases = [];
  await ctx.releaseServer.close();
  await addRelease(ctx, { version: NEW_V });
  const result = await ctx.core.update({ version: NEW_V });
  assert.equal(result.job.phase, "completed");
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, NEW_V);
});

test("acceptance 7: a crash after staging resumes and completes on restart (CLI)", async (t) => {
  const ctx = await startHarness(t);
  await addRelease(ctx, { version: NEW_V });

  // Crash exactly after the staged tree is put in place.
  await runCli(ctx, { faults: "after-stage" });
  const stateAfterCrash = await ctx.core.loadState();
  assert.ok(["staging", "staged"].includes(stateAfterCrash.job.phase), `unexpected phase ${stateAfterCrash.job?.phase}`);

  // Restart without faults: the transaction resumes and completes.
  const resumed = JSON.parse(await runCli(ctx));
  assert.equal(resumed.exitCode, 0, `resume failed: ${resumed}`);
  assert.equal(resumed.result.job.phase, "completed");
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, NEW_V);
  assert.equal((await ctx.mockActions()).filter((a) => a.action === "start").length >= 1, true, "device restarted by the resumed run");
});

test("acceptance 8: a crash after the switch verifies and completes on resume", async (t) => {
  const ctx = await startHarness(t);
  await addRelease(ctx, { version: NEW_V });

  await runCli(ctx, { faults: "after-switch" });
  const stateAfterCrash = await ctx.core.loadState();
  // The fault fires after the physical swap but BEFORE the journal claims
  // "switched" - the phase only records what has physically happened.
  assert.equal(stateAfterCrash.job.phase, "switching");
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, NEW_V, "junction already points to the new version");

  // In-process resume (same home + config): the updater verifies the new
  // version, completes the transaction and reports the resumed job.
  const core = await resumeCore(ctx);
  const result = await core.update({ version: NEW_V, jobId: stateAfterCrash.job.jobId });
  assert.equal(result.job.phase, "completed");
  assert.equal(result.job.resumedAfterCrash, true);
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, NEW_V);
});

test("acceptance 8b: a crash after the switch with an unhealthy new version rolls back (exit 14)", async (t) => {
  const ctx = await startHarness(t, { healthTimeoutSeconds: 1 });
  await addRelease(ctx, { version: NEW_V });

  await runCli(ctx, { faults: "after-switch" });
  const stateAfterCrash = await ctx.core.loadState();
  const core = await resumeCore(ctx);

  // First /health call (new-version verification) fails; the rollback verify
  // that follows reaches the healthy fake hub and succeeds.
  await assert.rejects(
    () => interceptFirstFetch(
      (url) => url.startsWith(ctx.hub.url) && url.endsWith("/health"),
      async () => new Response("unhealthy", { status: 503 }),
      () => core.update({ version: NEW_V, jobId: stateAfterCrash.job.jobId }),
    ),
    (error) => error.exitCode === 14 && error.code === "ROLLED_BACK",
  );
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV);
  const state = await ctx.core.loadState();
  assert.equal(state.job.phase, "rolled_back");
});

async function resumeCore(ctx) {
  const config = JSON.parse(await fs.readFile(path.join(ctx.home, "config.json"), "utf8"));
  config.healthTimeoutSeconds = 1;
  const { UpdaterCore } = await import("../lib/core.mjs");
  return new UpdaterCore({
    home: ctx.home,
    config,
    logger: () => {},
    overrides: {
      apiBase: ctx.releaseServer.url,
      allowHttp: true,
      processController: "mock",
      healthBase: ctx.hub.url,
      skipDependencyInstall: true,
    },
  });
}

test("acceptance 9: a new version that cannot start is rolled back automatically (exit 14)", async (t) => {
  const ctx = await startHarness(t, { healthTimeoutSeconds: 1 });
  await addRelease(ctx, { version: NEW_V });
  // First verify fails (hub unhealthy); rollback verify succeeds (hub healthy).
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const text = String(url);
    if (text.startsWith(ctx.hub.url) && text.endsWith("/health") && attempts === 0) {
      attempts += 1;
      return new Response("unhealthy", { status: 503 });
    }
    return originalFetch(url, options);
  };
  try {
    await ctx.core.update({ version: NEW_V });
    assert.fail("update must fail when the new version is unhealthy");
  } catch (error) {
    assert.equal(error.exitCode, 14);
    assert.equal(error.code, "ROLLED_BACK");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV);
  const state = await ctx.core.loadState();
  assert.equal(state.job.phase, "rolled_back");
  assert.ok(existsSync(path.join(ctx.installRoot, "versions", NEW_V)), "failed new version kept for diagnosis");
});

test("acceptance 10: hub healthy but agents offline never reports completed (exit 14)", async (t) => {
  const ctx = await startHarness(t, { healthTimeoutSeconds: 1 });
  await addRelease(ctx, { version: NEW_V });
  // The first /v1/agents poll (new-version verification) reports the agents
  // offline; the rollback verification reaches the healthy agent list.
  await assert.rejects(
    () => interceptFirstFetch(
      (url) => url.startsWith(ctx.hub.url) && url.endsWith("/v1/agents"),
      async () => new Response(JSON.stringify({ agents: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      () => ctx.core.update({ version: NEW_V }),
    ),
    (error) => error.exitCode === 14 && error.code === "ROLLED_BACK",
  );
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV);
  const state = await ctx.core.loadState();
  assert.equal(state.job.phase, "rolled_back");
});

test("acceptance 12: repeating the same jobId is idempotent", async (t) => {
  const ctx = await startHarness(t);
  await addRelease(ctx, { version: NEW_V });
  const first = await ctx.core.update({ version: NEW_V, jobId: "same-job-1" });
  assert.equal(first.job.phase, "completed");
  const actionsAfterFirst = (await ctx.mockActions()).length;
  const second = await ctx.core.update({ version: NEW_V, jobId: "same-job-1" });
  assert.equal(second.idempotent, true);
  assert.equal(second.job.phase, "completed");
  assert.equal((await ctx.mockActions()).length, actionsAfterFirst, "no additional stop/start for a repeated jobId");
});

test("acceptance 13: a second concurrent transaction is rejected with BUSY (exit 10)", async (t) => {
  const ctx = await startHarness(t);
  await addRelease(ctx, { version: NEW_V });
  const state = await ctx.core.loadState();
  state.job = {
    jobId: "job-in-flight",
    fromVersion: CLV,
    toVersion: NEW_V,
    phase: "staged",
    reportPhase: "staged",
    previousTarget: null,
    newTarget: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await ctx.core.saveState(state);
  await assert.rejects(
    () => ctx.core.update({ version: NEW_V, jobId: "other-job" }),
    (error) => error.code === "BUSY" && error.exitCode === 10,
  );
  await assert.rejects(
    () => ctx.core.stage({ version: NEW_V, jobId: "other-job" }),
    (error) => error.code === "BUSY" && error.exitCode === 10,
  );
});

test("stage then apply splits the pipeline and both halves are safe", async (t) => {
  const ctx = await startHarness(t);
  await addRelease(ctx, { version: NEW_V });
  const staged = await ctx.core.stage({ version: NEW_V, jobId: "split-1" });
  assert.equal(staged.job.phase, "staged");
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV, "still on the old version after stage");
  assert.deepEqual((await ctx.mockActions()).filter((a) => a.action === "stop"), [], "stage must not stop processes");
  const applied = await ctx.core.apply({ jobId: "split-1" });
  assert.equal(applied.job.phase, "completed");
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, NEW_V);
});

test("status reports adoption info and pending transactions", async (t) => {
  const ctx = await startHarness(t);
  const status = await ctx.core.status();
  assert.equal(status.adopted, true);
  assert.equal(status.currentVersion, CLV);
  assert.equal(status.role, "worker");
  assert.equal(status.deviceId, "test-device");
  assert.equal(status.pendingRecovery, false);
});

test("health checker fails closed when the hub never becomes healthy", async (t) => {
  const hub = await startFakeHub({ initialState: { healthy: false, agents: [] } });
  t.after(() => hub.close());
  const checker = createHealthChecker({
    hubBaseUrl: hub.url,
    sharedVarDir: path.join(os.tmpdir(), "a446-no-shared-var"),
    deviceId: "test-device",
    expectedOnlineAgents: 1,
    timeoutMs: 1200,
    pollIntervalMs: 100,
  });
  await assert.rejects(
    () => checker.verify(),
    (error) => error.code === "HEALTH_CHECK_FAILED" && error.exitCode === 13,
  );
});

// ---------------------------------------------------------------------------
// DeepSeek review fix 2: interruption sweep around the junction swap. Every
// interruption point must resume to the new version, and no interruption may
// ever produce "old version actually running but status says new completed".
// ---------------------------------------------------------------------------
for (const faultName of ["after-stop", "switch-between-renames", "after-switch", "after-restart", "after-verify"]) {
  test(`switch interruption at '${faultName}' resumes and completes the new version`, async (t) => {
    const ctx = await startHarness(t);
    await addRelease(ctx, { version: NEW_V });

    // Crash the CLI child exactly at the interruption point.
    await runCli(ctx, { faults: faultName });
    const stateAfterCrash = await ctx.core.loadState();
    assert.ok(stateAfterCrash.job, "an in-flight job was persisted");
    assert.ok(!["completed", "failed", "rolled_back"].includes(stateAfterCrash.job.phase),
      `crash at ${faultName} must not record a terminal phase (got ${stateAfterCrash.job.phase})`);

    // Resume in-process: the transaction finishes on the new version.
    const core = await resumeCore(ctx);
    const result = await core.update({ version: NEW_V, jobId: stateAfterCrash.job.jobId });
    assert.equal(result.job.phase, "completed");

    // The physical fact matches the recorded outcome: junction == toVersion.
    const current = await resolveCurrentTarget(ctx.installRoot);
    assert.equal(current.version, NEW_V);
    assert.equal(result.job.toVersion, current.version, "status and junction agree - no old-version-as-new-completed");
    const finalState = await ctx.core.loadState();
    assert.equal(finalState.job.phase, "completed");
  });
}

test("a journal that claims 'switched' while the junction is still old can never complete the new version", async (t) => {
  const ctx = await startHarness(t, { healthTimeoutSeconds: 1 });
  await addRelease(ctx, { version: NEW_V });

  // Stage normally, then corrupt the journal: claim the switch already
  // happened although the junction still points at the old version (the
  // premature-'switched' write an older updater version could produce).
  await ctx.core.stage({ version: NEW_V, jobId: "premature-1" });
  const state = await ctx.core.loadState();
  state.job.phase = "switched";
  state.job.reportPhase = "applying";
  state.job.previousTarget = `versions/${CLV}`;
  await ctx.core.saveState(state);
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV);

  // Recovery trusts the junction over the journal: complete the rollback to
  // the previous version instead of marking the new version completed.
  const core = await resumeCore(ctx);
  await assert.rejects(
    () => core.update({ version: NEW_V, jobId: "premature-1" }),
    (error) => error.exitCode === 14 && error.code === "ROLLED_BACK",
  );
  assert.equal((await resolveCurrentTarget(ctx.installRoot)).version, CLV, "the old version stays in charge");
  const finalState = await ctx.core.loadState();
  assert.equal(finalState.job.phase, "rolled_back");
});
