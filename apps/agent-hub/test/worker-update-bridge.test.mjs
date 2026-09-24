import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerUpdateBridge } from "../src/worker-update-bridge.mjs";
import { AgentWorker } from "../src/worker.mjs";

/**
 * Worker-side tests for the device update bridge. The updater process is
 * never spawned for real: spawnUpdater/readUpdaterState are injected, so the
 * bridge logic (ack handling, busy rejection, final-status reporting) is
 * exercised deterministically.
 */
function createFakeWorker({ agentId = "agent-laptop", deviceId = "laptop-01" } = {}) {
  return {
    agentId,
    state: { updateJobs: {} },
    config: { agentId, deviceId },
    sent: [],
    saved: 0,
    async saveState() {
      this.saved += 1;
    },
    async sendReliable(message) {
      this.sent.push(message);
    },
  };
}

async function createUpdaterHome(t, { withEntry = true } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "a446-worker-bridge-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (withEntry) {
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "a446-updater.mjs"), "// fake updater entry\n", "utf8");
  }
  return home;
}

function phaseOf(worker, jobId) {
  return worker.sent.filter((message) => message.type === "device.update.status" && message.payload.jobId === jobId);
}

test("handleRequest spawns the updater as a detached process and reports checking", async (t) => {
  const home = await createUpdaterHome(t);
  const worker = createFakeWorker();
  const spawns = [];
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    spawnUpdater: (args, options) => spawns.push({ args, options }),
  });

  await bridge.handleRequest({
    type: "device.update.request",
    payload: { jobId: "update-job-1001", deviceId: "laptop-01", version: "0.5.0-preview16" },
  });

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args.slice(0, 4), [path.join(home, "a446-updater.mjs"), "update", "--job-id", "update-job-1001"]);
  assert.deepEqual(spawns[0].args.slice(4), ["--version", "0.5.0-preview16"]);
  assert.equal(spawns[0].options.logFile.includes("update-job-1001"), true);

  const statuses = phaseOf(worker, "update-job-1001");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].payload.phase, "checking");
  assert.equal(statuses[0].payload.deviceId, "laptop-01");
  assert.equal(bridge.runningJobId, "update-job-1001");
  assert.equal(worker.state.updateJobs["update-job-1001"].ownedBy, "agent-laptop");

  bridge.pollTimer && clearInterval(bridge.pollTimer);
});

test("a second job while one is running is rejected with UPDATE_BUSY", async (t) => {
  const home = await createUpdaterHome(t);
  const worker = createFakeWorker();
  const spawns = [];
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    spawnUpdater: (args) => spawns.push(args),
  });

  await bridge.handleRequest({
    type: "device.update.request",
    payload: { jobId: "update-job-1002", deviceId: "laptop-01" },
  });
  assert.equal(bridge.runningJobId, "update-job-1002");

  await bridge.handleRequest({
    type: "device.update.request",
    payload: { jobId: "update-job-1003", deviceId: "laptop-01" },
  });

  assert.equal(spawns.length, 1, "only the first job spawns an updater");
  const statuses = phaseOf(worker, "update-job-1003");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].payload.phase, "failed");
  assert.equal(statuses[0].payload.code, "UPDATE_BUSY");
  assert.equal(worker.state.updateJobs["update-job-1003"].finalSent, true);
  assert.equal(bridge.runningJobId, "update-job-1002", "the running job keeps ownership");

  bridge.pollTimer && clearInterval(bridge.pollTimer);
});

test("a missing updater installation reports UPDATER_NOT_INSTALLED without spawning", async (t) => {
  const home = await createUpdaterHome(t, { withEntry: false });
  const worker = createFakeWorker();
  const spawns = [];
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    spawnUpdater: (args) => spawns.push(args),
  });

  await bridge.handleRequest({
    type: "device.update.request",
    payload: { jobId: "update-job-1004", deviceId: "laptop-01" },
  });

  assert.equal(spawns.length, 0);
  const statuses = phaseOf(worker, "update-job-1004");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].payload.phase, "failed");
  assert.equal(statuses[0].payload.code, "UPDATER_NOT_INSTALLED");
  assert.equal(worker.state.updateJobs["update-job-1004"].finalSent, true);
});

test("a duplicate delivery after ack loss re-sends only the final status", async (t) => {
  const home = await createUpdaterHome(t);
  const worker = createFakeWorker();
  worker.state.updateJobs["update-job-1005"] = { finalSent: true, terminalPhase: "completed" };
  const spawns = [];
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    spawnUpdater: (args) => spawns.push(args),
    readUpdaterState: async () => ({
      job: { jobId: "update-job-1005", phase: "completed", toVersion: "0.5.0-preview16", fromVersion: "0.5.0-preview15" },
    }),
  });

  await bridge.handleRequest({
    type: "device.update.request",
    payload: { jobId: "update-job-1005", deviceId: "laptop-01", version: "0.5.0-preview16" },
  });

  assert.equal(spawns.length, 0, "no new updater process is spawned");
  const statuses = phaseOf(worker, "update-job-1005");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].payload.phase, "completed");
  assert.equal(statuses[0].payload.duplicate, true);
  assert.equal(statuses[0].payload.version, "0.5.0-preview16");
});

test("reportPendingFinalStatuses reports terminal updater state after a restart", async (t) => {
  const home = await createUpdaterHome(t);
  const worker = createFakeWorker();
  worker.state.updateJobs["update-job-1006"] = { ownedBy: "agent-laptop", acceptedAt: "2026-09-24T00:00:00.000Z" };
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    readUpdaterState: async () => ({
      job: {
        jobId: "update-job-1006",
        phase: "rolled_back",
        toVersion: "0.5.0-preview16",
        fromVersion: "0.5.0-preview15",
        error: { message: "health verification failed" },
      },
    }),
  });

  await bridge.reportPendingFinalStatuses();

  const statuses = phaseOf(worker, "update-job-1006");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].payload.phase, "rolled_back");
  assert.equal(statuses[0].payload.reportedAfterRestart, true);
  assert.equal(statuses[0].payload.error, "health verification failed");
  assert.equal(worker.state.updateJobs["update-job-1006"].finalSent, true);

  // A second run is a no-op (finalSent guard).
  await bridge.reportPendingFinalStatuses();
  assert.equal(phaseOf(worker, "update-job-1006").length, 1);
});

test("reportPendingFinalStatuses reports a stalled job when no updater state matches", async (t) => {
  const home = await createUpdaterHome(t);
  const worker = createFakeWorker();
  worker.state.updateJobs["update-job-1007"] = { ownedBy: "agent-laptop" };
  worker.state.updateJobs["update-job-1008"] = { ownedBy: "agent-laptop", finalSent: true };
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    readUpdaterState: async () => null,
  });

  await bridge.reportPendingFinalStatuses();

  const stalled = phaseOf(worker, "update-job-1007");
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].payload.phase, "failed");
  assert.equal(stalled[0].payload.code, "UPDATER_STATE_MISSING");
  assert.equal(worker.state.updateJobs["update-job-1007"].finalSent, true);
  // The already-final job was not re-reported.
  assert.equal(phaseOf(worker, "update-job-1008").length, 0);
});

test("polling forwards active phases and the terminal state exactly once", { timeout: 20000 }, async (t) => {
  const home = await createUpdaterHome(t);
  const worker = createFakeWorker();
  let tick = 0;
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    readUpdaterState: async () => {
      tick += 1;
      if (tick <= 1) return { job: { jobId: "update-job-1009", phase: "downloading", toVersion: "0.5.0-preview16" } };
      if (tick <= 2) return { job: { jobId: "update-job-1009", phase: "downloading", toVersion: "0.5.0-preview16" } };
      if (tick <= 3) return { job: { jobId: "update-job-1009", phase: "verifying", toVersion: "0.5.0-preview16" } };
      return { job: { jobId: "update-job-1009", phase: "completed", toVersion: "0.5.0-preview16", fromVersion: "0.5.0-preview15" } };
    },
  });

  // Same phases are not re-reported; the terminal state clears ownership.
  await bridge.handleRequest({
    type: "device.update.request",
    payload: { jobId: "update-job-1009", deviceId: "laptop-01" },
  });
  await new Promise((resolve) => setTimeout(resolve, 4600));

  const phases = phaseOf(worker, "update-job-1009").map((message) => message.payload.phase);
  assert.deepEqual(phases, ["checking", "downloading", "verifying", "completed"]);
  assert.equal(bridge.runningJobId, null);
  assert.equal(bridge.pollTimer, null);
  assert.equal(worker.state.updateJobs["update-job-1009"].finalSent, true);
});

test("admit() claims the single update slot synchronously before any await", async (t) => {
  const home = await createUpdaterHome(t);
  const worker = createFakeWorker();
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    spawnUpdater: () => {},
    readUpdaterState: async () => null,
  });
  const message1 = { type: "device.update.request", payload: { jobId: "update-job-1010", deviceId: "laptop-01" } };
  const message2 = { type: "device.update.request", payload: { jobId: "update-job-1011", deviceId: "laptop-01" } };

  // No awaits between the two admit calls: the slot claim is synchronous, so
  // a racing second message can never slip through the busy check.
  assert.equal(bridge.admit(message1), true);
  assert.equal(bridge.admit(message2), false, "the second message must be rejected synchronously");
  assert.equal(bridge.runningJobId, "update-job-1010");

  await bridge.handleRequest(message2);
  const busy = phaseOf(worker, "update-job-1011");
  assert.equal(busy.length, 1);
  assert.equal(busy[0].payload.phase, "failed");
  assert.equal(busy[0].payload.code, "UPDATE_BUSY");

  // A message without a usable jobId is never accepted (no ack would be sent).
  assert.equal(bridge.admit({ type: "device.update.request", payload: {} }), false);
  bridge.stopPolling();
});

test("a throwing spawn injector produces a terminal failed report and frees the slot", async (t) => {
  const home = await createUpdaterHome(t);
  const worker = createFakeWorker();
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    spawnUpdater: () => {
      throw new Error("EACCES: spawn refused");
    },
    readUpdaterState: async () => null,
  });

  await bridge.handleRequest({
    type: "device.update.request",
    payload: { jobId: "update-job-1012", deviceId: "laptop-01" },
  });

  const statuses = phaseOf(worker, "update-job-1012");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].payload.phase, "failed");
  assert.equal(statuses[0].payload.code, "UPDATER_SPAWN_FAILED");
  assert.equal(statuses[0].payload.error.includes("EACCES"), true);
  assert.equal(worker.state.updateJobs["update-job-1012"].finalSent, true);
  assert.equal(bridge.runningJobId, null, "the slot is released even after a spawn failure");
  assert.equal(bridge.pollTimer, null);
});

test("the poll watchdog turns a hung updater into a terminal failed report", async (t) => {
  const home = await createUpdaterHome(t);
  const worker = createFakeWorker();
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    spawnUpdater: () => {},
    readUpdaterState: async () => ({ job: { jobId: "update-job-1013", phase: "downloading", toVersion: "0.5.0-preview16" } }),
    pollIntervalMs: 10,
    maxPollTicks: 3,
  });

  await bridge.handleRequest({
    type: "device.update.request",
    payload: { jobId: "update-job-1013", deviceId: "laptop-01" },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const statuses = phaseOf(worker, "update-job-1013");
  const last = statuses[statuses.length - 1];
  assert.equal(last.payload.phase, "failed", "the watchdog must report a terminal failure");
  assert.equal(last.payload.code, "UPDATER_POLL_TIMEOUT");
  assert.equal(worker.state.updateJobs["update-job-1013"].finalSent, true);
  assert.equal(bridge.runningJobId, null, "the watchdog releases the slot");
  assert.equal(bridge.pollTimer, null, "the poll loop never keeps running silently");
});

test("a synthetic failure (finalSent without updater state) is replayed, never re-run", async (t) => {
  const home = await createUpdaterHome(t);
  const worker = createFakeWorker();
  worker.state.updateJobs["update-job-1014"] = { finalSent: true, terminalPhase: "failed", lastError: "UPDATE_BUSY" };
  const spawns = [];
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    spawnUpdater: (args) => spawns.push(args),
    readUpdaterState: async () => null,
  });

  await bridge.handleRequest({
    type: "device.update.request",
    payload: { jobId: "update-job-1014", deviceId: "laptop-01" },
  });

  assert.equal(spawns.length, 0, "a known terminal job is never re-run");
  const statuses = phaseOf(worker, "update-job-1014");
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].payload.phase, "failed");
  assert.equal(statuses[0].payload.duplicate, true);
  assert.equal(bridge.runningJobId, null);
});

test("reportPendingFinalStatuses resumes polling for a still-active updater after a restart", async (t) => {
  const home = await createUpdaterHome(t);
  const worker = createFakeWorker();
  worker.state.updateJobs["update-job-1015"] = { ownedBy: "agent-laptop" };
  let phase = "downloading";
  const bridge = new WorkerUpdateBridge(worker, {
    updaterHome: home,
    readUpdaterState: async () => ({ job: { jobId: "update-job-1015", phase, toVersion: "0.5.0-preview16" } }),
    pollIntervalMs: 10,
    maxPollTicks: 50,
  });

  await bridge.reportPendingFinalStatuses();

  // The active job was adopted: current phase reported and polling resumed.
  const resumed = phaseOf(worker, "update-job-1015");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].payload.phase, "downloading");
  assert.equal(resumed[0].payload.resumedAfterRestart, true);
  assert.equal(bridge.runningJobId, "update-job-1015");
  assert.ok(bridge.pollTimer, "polling must resume for the still-running updater");

  // The updater eventually reaches its terminal phase while the new worker polls.
  phase = "completed";
  await new Promise((resolve) => setTimeout(resolve, 100));
  const statuses = phaseOf(worker, "update-job-1015");
  assert.equal(statuses[statuses.length - 1].payload.phase, "completed");
  assert.equal(worker.state.updateJobs["update-job-1015"].finalSent, true);
  assert.equal(bridge.runningJobId, null);
});

test("real AgentWorker restart: updateJobs survive via the persisted state and replay terminal statuses", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "a446-worker-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "worker-state.json");
  const config = {
    agentId: "agent-laptop",
    deviceId: "laptop-01",
    workspace: directory,
    stateFile,
    adapter: { type: "mock" },
  };

  // First worker instance accepts a job (in flight: never reported terminal).
  const workerA = new AgentWorker(config);
  await workerA.loadState();
  const bridgeA = new WorkerUpdateBridge(workerA, {
    updaterHome: directory,
    readUpdaterState: async () => null,
  });
  await bridgeA.recordJob("update-job-2001", { acceptedAt: "2026-09-24T00:00:00.000Z", ownedBy: "agent-laptop" });
  assert.ok(workerA.state.updateJobs["update-job-2001"]);

  // "Restart": a brand-new AgentWorker over the same state file must see the
  // job (DeepSeek fix 1 - updateJobs is part of the persisted state).
  const workerB = new AgentWorker(config);
  await workerB.loadState();
  assert.equal(workerB.state.updateJobs["update-job-2001"]?.ownedBy, "agent-laptop");

  // The restarted worker reports the terminal state the updater recorded.
  const sent = [];
  workerB.sendReliable = async (message) => sent.push(message);
  const bridgeB = new WorkerUpdateBridge(workerB, {
    updaterHome: directory,
    readUpdaterState: async () => ({
      job: { jobId: "update-job-2001", phase: "rolled_back", toVersion: "0.5.0-preview16", fromVersion: "0.5.0-preview15", error: { message: "health check failed" } },
    }),
  });
  await bridgeB.reportPendingFinalStatuses();
  const reported = sent.filter((message) => message.type === "device.update.status" && message.payload.jobId === "update-job-2001");
  assert.equal(reported.length, 1);
  assert.equal(reported[0].payload.phase, "rolled_back");
  assert.equal(reported[0].payload.reportedAfterRestart, true);
  assert.equal(workerB.state.updateJobs["update-job-2001"].finalSent, true);

  // The finalSent marker itself survives yet another restart (idempotent).
  const workerC = new AgentWorker(config);
  await workerC.loadState();
  assert.equal(workerC.state.updateJobs["update-job-2001"]?.finalSent, true);
  const sentC = [];
  workerC.sendReliable = async (message) => sentC.push(message);
  const bridgeC = new WorkerUpdateBridge(workerC, {
    updaterHome: directory,
    readUpdaterState: async () => null,
  });
  await bridgeC.reportPendingFinalStatuses();
  assert.equal(sentC.filter((message) => message.type === "device.update.status").length, 0, "a finalSent job is never re-reported");
});
