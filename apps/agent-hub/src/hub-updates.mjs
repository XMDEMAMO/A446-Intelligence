import { makeEnvelope, safeError } from "./common.mjs";

const MAX_REPORTS_PER_JOB = 50;
const ACTIVE_UPDATE_PHASES = new Set(["checking", "downloading", "staged", "applying", "restarting", "verifying"]);
const TERMINAL_UPDATE_PHASES = new Set(["completed", "failed", "rolled_back"]);
const VALID_UPDATE_PHASES = new Set([...ACTIVE_UPDATE_PHASES, ...TERMINAL_UPDATE_PHASES]);
// Occupying statuses for the per-device concurrency guard: a job occupies its
// device from the moment it is requested - not only once a first report
// marks it running. Without this, two requests racing before the first
// status report would both be dispatched.
const OCCUPYING_STATUSES = new Set(["requested", "running"]);

function httpError(statusCode, message, code, details) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}), ...(details ? { details } : {}) });
}

function statusFromPhase(phase) {
  if (phase === "completed") return "completed";
  if (phase === "failed") return "failed";
  if (phase === "rolled_back") return "rolled_back";
  if (ACTIVE_UPDATE_PHASES.has(phase)) return "running";
  return "unknown";
}

/**
 * Hub-side registry for device update jobs. The Hub only performs permission
 * checks, command routing and status bookkeeping; downloading and file
 * replacement happen exclusively inside the per-device updater process.
 *
 * Job records are persisted with the Hub state (see hub-store.mjs), so a Hub
 * restart rebuilds them exactly; every transition is additionally recorded
 * as an audit event.
 */
export class HubUpdateRegistry {
  constructor(hub) {
    this.hub = hub;
    this.jobs = new Map();
  }

  /** Rebuild the registry from the persisted job list after a Hub restart. */
  restore(list) {
    for (const stored of Array.isArray(list) ? list : []) {
      if (stored && typeof stored.jobId === "string") {
        this.jobs.set(stored.jobId, {
          ...stored,
          reports: Array.isArray(stored.reports) ? stored.reports : [],
        });
      }
    }
  }

  /** Marks a job dirty so the next flush persists it. */
  markUpdate(job) {
    if (typeof this.hub.markUpdateJob === "function") this.hub.markUpdateJob(job);
  }

  validateJobId(jobId) {
    if (typeof jobId !== "string" || jobId.length < 8 || jobId.length > 200 || !/^[A-Za-z0-9._:@-]+$/.test(jobId)) {
      return false;
    }
    return true;
  }

  async request(command, actor) {
    const deviceId = typeof command.deviceId === "string" ? command.deviceId.trim() : "";
    if (!deviceId) throw httpError(400, "device.update.request requires deviceId", "VALIDATION_ERROR");
    const jobId = command.jobId;
    if (!this.validateJobId(jobId)) {
      throw httpError(400, "device.update.request requires a jobId of 8-200 safe characters", "VALIDATION_ERROR");
    }
    const requestedVersion = command.version == null ? null : String(command.version);

    const existing = this.jobs.get(jobId);
    if (existing) {
      // Same jobId is always idempotent from the Hub's perspective: the worker
      // bridge and the on-device updater both replay the recorded terminal
      // state for a known jobId, so re-dispatching it would NOT re-run the
      // update. A real retry must use a new jobId (docs/UPDATER_PROTOCOL.md 11).
      return { ok: true, duplicate: true, job: this.publicJob(existing) };
    }
    return this.dispatch(deviceId, requestedVersion, jobId, actor);
  }

  async dispatch(deviceId, requestedVersion, jobId, actor) {
    for (const job of this.jobs.values()) {
      if (job.deviceId === deviceId && OCCUPYING_STATUSES.has(job.status)) {
        throw httpError(
          409,
          `Device '${deviceId}' already has an update job in progress (${job.jobId}, status ${job.status})`,
          "UPDATE_JOB_ALREADY_RUNNING",
        );
      }
    }
    const candidates = [...this.hub.agents.values()].filter(
      (agent) => agent.deviceId === deviceId && agent.status === "online",
    );
    if (!candidates.length) {
      throw httpError(409, `No online agent for device '${deviceId}'`, "DEVICE_OFFLINE");
    }
    const agent = candidates[0];
    const job = {
      jobId,
      deviceId,
      agentId: agent.agentId,
      requestedVersion,
      requestedBy: actor?.id ?? "human",
      requestedAt: new Date().toISOString(),
      status: "requested",
      lastReport: null,
      reports: [],
    };
    this.jobs.set(jobId, job);
    this.markUpdate(job);
    this.hub.deliver(agent.agentId, makeEnvelope("device.update.request", {
      agentId: agent.agentId,
      payload: { jobId, deviceId, version: requestedVersion },
    }));
    await this.hub.recordEvent("device.update.requested", {
      actor: actor?.id ?? "human",
      jobId,
      deviceId,
      agentId: agent.agentId,
      version: requestedVersion,
    });
    await this.hub.flushState();
    return { ok: true, job: this.publicJob(job) };
  }

  async ingestStatus(agentId, message) {
    const payload = message.payload ?? {};
    const jobId = typeof payload.jobId === "string" ? payload.jobId : null;
    if (!jobId) return { ok: false, reason: "missing jobId" };
    const phase = typeof payload.phase === "string" ? payload.phase : "unknown";
    // Phase whitelist: anything outside the protocol is rejected WITHOUT
    // touching the job. An unknown phase must never overwrite a valid
    // status or free a device's concurrency slot.
    if (!VALID_UPDATE_PHASES.has(phase)) {
      await this.hub.recordEvent("device.update.status.rejected", {
        jobId,
        agentId,
        phase,
        reason: "unknown phase",
      });
      return { ok: false, reason: "unknown phase", phase };
    }
    const agent = this.hub.agents.get(agentId);
    let job = this.jobs.get(jobId);
    if (job) {
      // Only the agent the job was dispatched to (or another agent of the
      // same device) may report for it; anything else is a forged report.
      const sameAgent = job.agentId === agentId;
      const sameDevice = agent?.deviceId != null && agent.deviceId === job.deviceId;
      if (!sameAgent && !sameDevice) {
        await this.hub.recordEvent("device.update.status.rejected", {
          jobId,
          agentId,
          expectedAgentId: job.agentId ?? null,
          expectedDeviceId: job.deviceId ?? null,
          phase,
          reason: "agent mismatch",
        });
        return { ok: false, reason: "agent mismatch" };
      }
    } else {
      // Unknown jobId: only meaningful as a re-report that rebuilds the job
      // after a Hub restart, and only from an agent of a known device whose
      // deviceId matches the report.
      const deviceId = agent?.deviceId ?? null;
      if (!deviceId) {
        await this.hub.recordEvent("device.update.status.rejected", { jobId, agentId, phase, reason: "unknown agent" });
        return { ok: false, reason: "unknown agent" };
      }
      if (payload.deviceId && payload.deviceId !== deviceId) {
        await this.hub.recordEvent("device.update.status.rejected", {
          jobId,
          agentId,
          deviceId,
          reportedDeviceId: payload.deviceId,
          phase,
          reason: "deviceId mismatch",
        });
        return { ok: false, reason: "deviceId mismatch" };
      }
      job = {
        jobId,
        deviceId,
        agentId,
        requestedVersion: payload.version ?? null,
        requestedBy: agentId,
        requestedAt: new Date().toISOString(),
        status: statusFromPhase(phase),
        lastReport: null,
        reports: [],
        recoveredFromWorkerReport: true,
      };
      this.jobs.set(jobId, job);
    }
    const report = {
      phase,
      status: statusFromPhase(phase),
      version: payload.version ?? null,
      fromVersion: payload.fromVersion ?? null,
      error: payload.error ? safeError({ message: String(payload.error) }) : null,
      checkedAt: payload.checkedAt ?? new Date().toISOString(),
    };
    job.lastReport = report;
    job.reports.push(report);
    if (job.reports.length > MAX_REPORTS_PER_JOB) job.reports.splice(0, job.reports.length - MAX_REPORTS_PER_JOB);
    job.status = report.status;
    this.markUpdate(job);
    await this.hub.recordEvent("device.update.status", {
      jobId,
      deviceId: job.deviceId,
      agentId,
      phase,
      status: report.status,
    });
    return { ok: true, job: this.publicJob(job) };
  }

  publicJob(job) {
    return {
      jobId: job.jobId,
      deviceId: job.deviceId,
      agentId: job.agentId ?? null,
      requestedVersion: job.requestedVersion ?? null,
      requestedBy: job.requestedBy ?? null,
      requestedAt: job.requestedAt ?? null,
      status: job.status,
      lastReport: job.lastReport,
      reports: job.reports.slice(-10),
      ...(job.recoveredFromWorkerReport ? { recoveredFromWorkerReport: true } : {}),
    };
  }

  listJobs() {
    return [...this.jobs.values()]
      .sort((left, right) => Date.parse(right.requestedAt ?? 0) - Date.parse(left.requestedAt ?? 0))
      .map((job) => this.publicJob(job));
  }
}
