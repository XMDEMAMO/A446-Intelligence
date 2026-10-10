import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentHub } from "../src/hub.mjs";
import { JsonFileHubStore } from "../src/hub-store.mjs";
import { makeEnvelope } from "../src/common.mjs";

/**
 * Hub-side tests for the device update bridge (docs/UPDATER_PROTOCOL.md 6).
 * The Hub only validates, routes and records; a fake online agent is injected
 * directly into hub.agents so no real updater or worker process is needed.
 */
async function startHub(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "a446-updater-bridge-"));
  const hub = await new AgentHub({
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 100,
    delivery: { ackTimeoutMs: 100, maxAttemptsPerConnection: 5 },
    logs: { includePayloads: false },
  }).start();
  t.after(async () => {
    await hub.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return hub;
}

function injectOnlineAgent(hub, agentId, deviceId) {
  const now = new Date().toISOString();
  hub.agents.set(agentId, {
    agentId,
    deviceId,
    status: "online",
    connectedAt: now,
    lastSeenAt: now,
    adapter: "mock",
    capabilities: ["task.execute"],
  });
}

function updateRequestDeliveries(hub) {
  return [...hub.pendingDeliveries.values()].filter((delivery) => delivery.envelope.type === "device.update.request");
}

test("device.update.request routes an envelope to the device agent and is idempotent per jobId", async (t) => {
  const hub = await startHub(t);
  injectOnlineAgent(hub, "agent-laptop", "laptop-01");

  const result = await hub.handleCommand({
    type: "device.update.request",
    deviceId: "laptop-01",
    version: "0.5.0-preview16",
    jobId: "update-job-0001",
  }, { id: "tester", role: "admin" });

  assert.equal(result.ok, true);
  assert.equal(result.job.jobId, "update-job-0001");
  assert.equal(result.job.status, "requested");
  assert.equal(result.job.deviceId, "laptop-01");
  assert.equal(result.job.requestedVersion, "0.5.0-preview16");

  const deliveries = updateRequestDeliveries(hub);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].envelope.payload.jobId, "update-job-0001");
  assert.equal(deliveries[0].envelope.payload.deviceId, "laptop-01");
  assert.equal(deliveries[0].envelope.payload.version, "0.5.0-preview16");

  // The request was audited.
  const audit = hub.log.events.filter((event) => event.type === "device.update.requested");
  assert.equal(audit.length >= 1, true);

  // Repeating the same jobId is idempotent and does not enqueue a second envelope.
  const duplicate = await hub.handleCommand({
    type: "device.update.request",
    deviceId: "laptop-01",
    version: "0.5.0-preview16",
    jobId: "update-job-0001",
  }, { id: "tester", role: "admin" });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.jobId, "update-job-0001");
  assert.equal(updateRequestDeliveries(hub).length, 1);
});

test("device.update.request refuses unknown devices and unsafe jobIds", async (t) => {
  const hub = await startHub(t);

  await assert.rejects(
    () => hub.handleCommand({
      type: "device.update.request",
      deviceId: "ghost-device",
      jobId: "update-job-0002",
    }, { id: "tester", role: "admin" }),
    (error) => error.statusCode === 409 && error.code === "DEVICE_OFFLINE",
  );

  injectOnlineAgent(hub, "agent-laptop", "laptop-01");
  await assert.rejects(
    () => hub.handleCommand({
      type: "device.update.request",
      deviceId: "laptop-01",
      jobId: "short",
    }, { id: "tester", role: "admin" }),
    (error) => error.statusCode === 400 && error.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    () => hub.handleCommand({
      type: "device.update.request",
      deviceId: "laptop-01",
      jobId: "bad job id with spaces",
    }, { id: "tester", role: "admin" }),
    (error) => error.statusCode === 400 && error.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    () => hub.handleCommand({
      type: "device.update.request",
      deviceId: "laptop-01",
    }, { id: "tester", role: "admin" }),
    (error) => error.statusCode === 400 && error.code === "VALIDATION_ERROR",
  );
});

test("a second concurrent update for the same device is rejected (409 UPDATE_JOB_ALREADY_RUNNING)", async (t) => {
  const hub = await startHub(t);
  injectOnlineAgent(hub, "agent-laptop", "laptop-01");

  await hub.handleCommand({
    type: "device.update.request",
    deviceId: "laptop-01",
    version: "0.5.0-preview16",
    jobId: "update-job-0003",
  }, { id: "tester", role: "admin" });

  // The first job transitions to a running phase via a worker status report.
  await hub.handleWorkerMessage("agent-laptop", makeEnvelope("device.update.status", {
    agentId: "agent-laptop",
    payload: { jobId: "update-job-0003", deviceId: "laptop-01", phase: "downloading", version: "0.5.0-preview16" },
  }));
  assert.equal(hub.updates.jobs.get("update-job-0003").status, "running");

  await assert.rejects(
    () => hub.handleCommand({
      type: "device.update.request",
      deviceId: "laptop-01",
      version: "0.5.0-preview17",
      jobId: "update-job-0004",
    }, { id: "tester", role: "admin" }),
    (error) => error.statusCode === 409 && error.code === "UPDATE_JOB_ALREADY_RUNNING",
  );
  assert.equal(hub.updates.jobs.has("update-job-0004"), false);
});

test("device.update.status is upserted and visible through GET /v1/update-jobs", async (t) => {
  const hub = await startHub(t);
  injectOnlineAgent(hub, "agent-laptop", "laptop-01");

  // A status report for an unknown job recreates the record after a Hub restart.
  await hub.handleWorkerMessage("agent-laptop", makeEnvelope("device.update.status", {
    agentId: "agent-laptop",
    payload: { jobId: "update-job-0005", deviceId: "laptop-01", phase: "checking", version: "0.5.0-preview16" },
  }));
  const job = hub.updates.jobs.get("update-job-0005");
  assert.equal(job.status, "running");
  assert.equal(job.recoveredFromWorkerReport, true);
  assert.equal(job.reports.length, 1);

  for (const phase of ["downloading", "staged", "verifying", "completed"]) {
    await hub.handleWorkerMessage("agent-laptop", makeEnvelope("device.update.status", {
      agentId: "agent-laptop",
      payload: {
        jobId: "update-job-0005",
        deviceId: "laptop-01",
        phase,
        version: "0.5.0-preview16",
        fromVersion: "0.5.0-preview15",
        error: phase === "completed" ? null : "later phases",
      },
    }));
  }
  const finished = hub.updates.jobs.get("update-job-0005");
  assert.equal(finished.status, "completed");
  assert.equal(finished.lastReport.phase, "completed");
  assert.equal(finished.lastReport.error, null);

  // The audit trail recorded every status transition.
  const statusEvents = hub.log.events.filter((event) => event.type === "device.update.status" && event.details?.jobId === "update-job-0005");
  assert.equal(statusEvents.length, 5);

  const response = await fetch(`${hub.url()}/v1/update-jobs`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const listed = body.jobs.find((item) => item.jobId === "update-job-0005");
  assert.equal(listed.status, "completed");
  assert.equal(listed.lastReport.phase, "completed");
});

test("terminal rolled_back status is recorded and stays idempotent for the same jobId", async (t) => {
  const hub = await startHub(t);
  injectOnlineAgent(hub, "agent-laptop", "laptop-01");

  await hub.handleCommand({
    type: "device.update.request",
    deviceId: "laptop-01",
    version: "0.5.0-preview16",
    jobId: "update-job-0006",
  }, { id: "tester", role: "admin" });

  await hub.handleWorkerMessage("agent-laptop", makeEnvelope("device.update.status", {
    agentId: "agent-laptop",
    payload: {
      jobId: "update-job-0006",
      deviceId: "laptop-01",
      phase: "rolled_back",
      version: "0.5.0-preview16",
      fromVersion: "0.5.0-preview15",
      error: "health verification failed",
    },
  }));
  assert.equal(hub.updates.jobs.get("update-job-0006").status, "rolled_back");

  // Per docs/UPDATER_PROTOCOL.md 6.1/11 a known jobId is always idempotent:
  // both the worker bridge and the on-device updater replay the recorded
  // terminal state, so re-dispatching would not re-run the update. A real
  // retry must use a new jobId.
  const duplicate = await hub.handleCommand({
    type: "device.update.request",
    deviceId: "laptop-01",
    version: "0.5.0-preview16",
    jobId: "update-job-0006",
  }, { id: "tester", role: "admin" });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.status, "rolled_back");

  // A new jobId is dispatched normally (this is the only way to retry).
  const retry = await hub.handleCommand({
    type: "device.update.request",
    deviceId: "laptop-01",
    version: "0.5.0-preview16",
    jobId: "update-job-0006-retry",
  }, { id: "tester", role: "admin" });
  assert.equal(retry.duplicate, undefined);
  assert.equal(retry.job.status, "requested");
  assert.equal(retry.job.jobId, "update-job-0006-retry");
});

test("a known jobId is idempotent even after failure (a failed job is not re-dispatched)", async (t) => {
  const hub = await startHub(t);
  injectOnlineAgent(hub, "agent-laptop", "laptop-01");

  await hub.handleCommand({
    type: "device.update.request",
    deviceId: "laptop-01",
    version: "0.5.0-preview16",
    jobId: "update-job-0007",
  }, { id: "tester", role: "admin" });

  await hub.handleWorkerMessage("agent-laptop", makeEnvelope("device.update.status", {
    agentId: "agent-laptop",
    payload: {
      jobId: "update-job-0007",
      deviceId: "laptop-01",
      phase: "failed",
      version: "0.5.0-preview16",
      error: "package verification rejected",
    },
  }));
  assert.equal(hub.updates.jobs.get("update-job-0007").status, "failed");

  const before = [...hub.pendingDeliveries.values()].filter((d) => d.envelope.type === "device.update.request").length;
  const again = await hub.handleCommand({
    type: "device.update.request",
    deviceId: "laptop-01",
    version: "0.5.0-preview16",
    jobId: "update-job-0007",
  }, { id: "tester", role: "admin" });
  assert.equal(again.duplicate, true, "a failed job is not re-dispatched under the same id");
  assert.equal(again.job.status, "failed");
  const after = [...hub.pendingDeliveries.values()].filter((d) => d.envelope.type === "device.update.request").length;
  assert.equal(after, before, "no new envelope is enqueued for a known jobId");
});

test("a job in the requested state already occupies its device (no double dispatch before the first report)", async (t) => {
  const hub = await startHub(t);
  injectOnlineAgent(hub, "agent-laptop", "laptop-01");

  await hub.handleCommand({
    type: "device.update.request",
    deviceId: "laptop-01",
    version: "0.5.0-preview16",
    jobId: "update-job-race-1",
  }, { id: "tester", role: "admin" });

  // No status report has arrived yet: the job is still "requested", but the
  // device slot must already be occupied so a racing second request cannot
  // slip through (DeepSeek review fix 4 - Hub layer).
  await assert.rejects(
    () => hub.handleCommand({
      type: "device.update.request",
      deviceId: "laptop-01",
      version: "0.5.0-preview16",
      jobId: "update-job-race-2",
    }, { id: "tester", role: "admin" }),
    (error) => error.statusCode === 409 && error.code === "UPDATE_JOB_ALREADY_RUNNING",
  );
  assert.equal(hub.updates.jobs.has("update-job-race-2"), false);
  assert.equal(updateRequestDeliveries(hub).length, 1);
});

test("invalid or forged status reports are rejected without touching the job", async (t) => {
  const hub = await startHub(t);
  injectOnlineAgent(hub, "agent-laptop", "laptop-01");
  injectOnlineAgent(hub, "agent-other", "desktop-02");

  await hub.handleCommand({
    type: "device.update.request",
    deviceId: "laptop-01",
    version: "0.5.0-preview16",
    jobId: "update-job-guard-1",
  }, { id: "tester", role: "admin" });

  // Unknown phase: rejected, job untouched, device slot NOT freed.
  const unknown = await hub.updates.ingestStatus("agent-laptop", makeEnvelope("device.update.status", {
    agentId: "agent-laptop",
    payload: { jobId: "update-job-guard-1", deviceId: "laptop-01", phase: "teleported" },
  }));
  assert.equal(unknown.ok, false);
  assert.equal(hub.updates.jobs.get("update-job-guard-1").status, "requested");
  await assert.rejects(
    () => hub.handleCommand({
      type: "device.update.request",
      deviceId: "laptop-01",
      jobId: "update-job-guard-2",
    }, { id: "tester", role: "admin" }),
    (error) => error.statusCode === 409 && error.code === "UPDATE_JOB_ALREADY_RUNNING",
  );

  // Forged report from an agent of a DIFFERENT device: rejected.
  const forged = await hub.updates.ingestStatus("agent-other", makeEnvelope("device.update.status", {
    agentId: "agent-other",
    payload: { jobId: "update-job-guard-1", deviceId: "laptop-01", phase: "completed" },
  }));
  assert.equal(forged.ok, false, "an agent of another device must not report for this job");
  assert.equal(hub.updates.jobs.get("update-job-guard-1").status, "requested");

  // The legitimate agent may still report and reach completed.
  const legit = await hub.updates.ingestStatus("agent-laptop", makeEnvelope("device.update.status", {
    agentId: "agent-laptop",
    payload: { jobId: "update-job-guard-1", deviceId: "laptop-01", phase: "completed", version: "0.5.0-preview16" },
  }));
  assert.equal(legit.ok, true);
  assert.equal(hub.updates.jobs.get("update-job-guard-1").status, "completed");
});

test("hub restart rebuilds update jobs from the persistent store at every stage", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "a446-updater-hub-restart-"));
  const storeFile = path.join(directory, "hub-state.json");
  const stages = [
    { phase: null, expectedStatus: "requested" },
    { phase: "downloading", expectedStatus: "running" },
    { phase: "completed", expectedStatus: "completed" },
    { phase: "failed", expectedStatus: "failed" },
    { phase: "rolled_back", expectedStatus: "rolled_back" },
  ];
  try {
    for (const [index, stage] of stages.entries()) {
      // First hub: dispatch and (optionally) report a phase.
      const hubA = await new AgentHub({
        host: "127.0.0.1",
        port: 0,
        heartbeatMs: 100,
        delivery: { ackTimeoutMs: 100, maxAttemptsPerConnection: 5 },
        logs: { includePayloads: false },
      }, { store: new JsonFileHubStore(storeFile) }).start();
      // Each stage gets its own device: an earlier stage's job may still sit
      // in an active status in the shared store, and (by design) a device
      // with an active update job refuses new dispatches.
      const deviceId = `laptop-restart-${index}`;
      const agentId = `agent-restart-${index}`;
      injectOnlineAgent(hubA, agentId, deviceId);
      const jobId = `update-job-restart-${index}`;
      await hubA.handleCommand({
        type: "device.update.request",
        deviceId,
        version: "0.5.0-preview16",
        jobId,
      }, { id: "tester", role: "admin" });
      if (stage.phase) {
        await hubA.handleWorkerMessage(agentId, makeEnvelope("device.update.status", {
          agentId,
          payload: { jobId, deviceId, phase: stage.phase, version: "0.5.0-preview16" },
        }));
      }
      await hubA.stop();

      // Second hub over the SAME store: the job must be rebuilt exactly.
      const hubB = await new AgentHub({
        host: "127.0.0.1",
        port: 0,
        heartbeatMs: 100,
        delivery: { ackTimeoutMs: 100, maxAttemptsPerConnection: 5 },
        logs: { includePayloads: false },
      }, { store: new JsonFileHubStore(storeFile) }).start();
      t.after(async () => {
        await hubB.stop().catch(() => {});
      });
      const rebuilt = hubB.updates.jobs.get(jobId);
      assert.ok(rebuilt, `job ${jobId} must survive a hub restart (stage ${stage.phase ?? "requested"})`);
      assert.equal(rebuilt.status, stage.expectedStatus);
      assert.equal(rebuilt.deviceId, deviceId);

      // A known jobId stays idempotent after the restart: no re-dispatch,
      // no re-execution of an already completed update (DeepSeek fix 7).
      const again = await hubB.handleCommand({
        type: "device.update.request",
        deviceId,
        version: "0.5.0-preview16",
        jobId,
      }, { id: "tester", role: "admin" });
      assert.equal(again.duplicate, true);
      assert.equal(again.job.status, stage.expectedStatus);
      const deliveries = updateRequestDeliveries(hubB).filter((d) => d.envelope.payload.jobId === jobId);
      assert.equal(deliveries.length, 1, "only the restored delivery exists - nothing new was dispatched");
      await hubB.stop().catch(() => {});
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});
