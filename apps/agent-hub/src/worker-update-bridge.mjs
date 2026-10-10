import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { makeEnvelope } from "./common.mjs";

const TERMINAL_UPDATE_PHASES = new Set(["completed", "failed", "rolled_back"]);
const ACTIVE_UPDATE_PHASES = new Set(["checking", "downloading", "staged", "applying", "restarting", "verifying"]);
const POLL_INTERVAL_MS = 1000;
// Watchdog: a poll loop that runs longer than this without a terminal phase is
// treated as a failed update (never silently stopped - the Hub would otherwise
// show the job as running forever).
const MAX_POLL_TICKS = 60 * 60;

function safeUpdaterErrorText(value) {
  return String(value ?? "").slice(0, 500);
}

/**
 * Worker-side bridge for device.update.request.
 *
 * Responsibilities (kept deliberately thin):
 * - admit or reject an incoming request synchronously (single update slot),
 * - spawn the local a446-updater CLI as a detached process,
 * - poll the updater's state.json and report phase changes to the Hub,
 * - guarantee a terminal status for every accepted job: normal terminal
 *   phase, spawn failure, non-zero/abnormal exit detection, poll watchdog
 *   timeout and any unexpected error all end in a `failed` report,
 * - after a restart, report the final state of jobs that were owned by this
 *   agent but never reported as terminal (the worker process itself gets
 *   stopped during an update).
 *
 * The bridge never performs downloads or file operations itself and never
 * handles credentials: the updater is installed at A446_UPDATER_HOME
 * (default %LOCALAPPDATA%\A446-Updater) and reads its own configuration.
 */
export class WorkerUpdateBridge {
  constructor(worker, deps = {}) {
    this.worker = worker;
    this.deps = deps;
    this.runningJobId = null;
    this.pollTimer = null;
    // Ticks may be overridden in tests to exercise the watchdog quickly.
    this.maxPollTicks = Number(deps.maxPollTicks ?? MAX_POLL_TICKS);
    this.pollIntervalMs = Number(deps.pollIntervalMs ?? POLL_INTERVAL_MS);
  }

  updaterHome() {
    if (this.deps.updaterHome) return this.deps.updaterHome;
    if (process.env.A446_UPDATER_HOME) return path.resolve(process.env.A446_UPDATER_HOME);
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return null;
    return path.join(localAppData, "A446-Updater");
  }

  updaterStateFile() {
    const home = this.updaterHome();
    return home ? path.join(home, "state.json") : null;
  }

  updaterEntry() {
    const home = this.updaterHome();
    return home ? path.join(home, "a446-updater.mjs") : null;
  }

  async readUpdaterState() {
    const stateFile = this.updaterStateFile();
    if (this.deps.readUpdaterState) return await this.deps.readUpdaterState(stateFile);
    if (!stateFile || !existsSync(stateFile)) return null;
    try {
      return JSON.parse(await fs.readFile(stateFile, "utf8"));
    } catch {
      return null;
    }
  }

  async recordJob(jobId, patch) {
    const state = this.worker.state;
    state.updateJobs = state.updateJobs ?? {};
    state.updateJobs[jobId] = { ...(state.updateJobs[jobId] ?? {}), ...patch, updatedAt: new Date().toISOString() };
    // Keep the map bounded.
    const entries = Object.entries(state.updateJobs);
    if (entries.length > 20) {
      for (const [key, value] of entries.slice(0, entries.length - 20)) {
        if (value.finalSent) delete state.updateJobs[key];
      }
    }
    await this.worker.saveState();
  }

  async sendStatus(jobId, phase, extra = {}) {
    const payload = {
      jobId,
      deviceId: this.worker.config.deviceId ?? this.worker.config.agentId,
      phase,
      checkedAt: new Date().toISOString(),
      ...extra,
    };
    await this.worker.sendReliable(makeEnvelope("device.update.status", {
      agentId: this.worker.agentId,
      payload,
    }));
  }

  /**
   * Synchronous admission gate, called by the worker BEFORE sending the ack:
   * the ack must mean "reliably accepted", not merely "message received".
   * Returns true when the request is accepted (slot claimed or duplicate
   * replay) and false when it must be rejected (busy / unusable message).
   * The slot claim happens without any await so two concurrent messages can
   * never both pass the busy check.
   */
  admit(message) {
    const payload = message?.payload ?? {};
    const jobId = typeof payload.jobId === "string" && payload.jobId ? payload.jobId : null;
    if (!jobId) {
      console.error(`[${this.worker.agentId}] device.update.request without jobId rejected`);
      return false;
    }
    if (this.runningJobId != null && this.runningJobId !== jobId) {
      // Rejected: handleRequest() reports a terminal `failed` status so the
      // Hub never waits on this job; the missing ack causes one redelivery,
      // which then hits the finalSent replay below and is acked.
      return false;
    }
    // Claim the slot synchronously.
    this.runningJobId = jobId;
    return true;
  }

  async handleRequest(message) {
    const payload = message?.payload ?? {};
    const jobId = typeof payload.jobId === "string" && payload.jobId ? payload.jobId : null;
    if (!jobId) return;
    // Direct callers (tests, redelivery paths) may skip admit(): claim the
    // slot here too - synchronously, before any await.
    if (this.runningJobId == null) this.runningJobId = jobId;
    try {
      const record = this.worker.state.updateJobs?.[jobId];
      if (record?.finalSent && record.terminalPhase && TERMINAL_UPDATE_PHASES.has(record.terminalPhase)) {
        // Duplicate delivery after ack loss: re-send the recorded final
        // status only. Never re-run the update for a known terminal job.
        let version = null;
        let fromVersion = null;
        let error = record.lastError ?? null;
        const updaterState = await this.readUpdaterState();
        if (updaterState?.job?.jobId === jobId) {
          version = updaterState.job.toVersion ?? version;
          fromVersion = updaterState.job.fromVersion ?? fromVersion;
          error = updaterState.job.error?.message ?? error;
        }
        await this.sendStatus(jobId, record.terminalPhase, { version, fromVersion, error, duplicate: true });
        if (this.runningJobId === jobId) this.runningJobId = null;
        return;
      }
      const updaterState = await this.readUpdaterState();
      if (updaterState?.job?.jobId === jobId && TERMINAL_UPDATE_PHASES.has(updaterState.job.phase)) {
        // The updater itself already recorded a terminal result for this job
        // (e.g. the worker was restarted before reporting): replay it.
        await this.sendStatus(jobId, updaterState.job.phase, {
          version: updaterState.job.toVersion ?? null,
          fromVersion: updaterState.job.fromVersion ?? null,
          error: updaterState.job.error?.message ?? null,
          duplicate: true,
        });
        await this.recordJob(jobId, { finalSent: true, terminalPhase: updaterState.job.phase });
        if (this.runningJobId === jobId) this.runningJobId = null;
        return;
      }
      if (this.runningJobId != null && this.runningJobId !== jobId) {
        // Defense in depth: admit() already gates synchronously; this async
        // re-check protects direct callers of handleRequest.
        await this.recordJob(jobId, { rejected: "busy" });
        await this.sendStatus(jobId, "failed", {
          error: "another update job is already running on this device",
          code: "UPDATE_BUSY",
        });
        await this.recordJob(jobId, { finalSent: true, terminalPhase: "failed", lastError: "UPDATE_BUSY" });
        return;
      }
      await this.recordJob(jobId, { acceptedAt: new Date().toISOString(), ownedBy: this.worker.agentId });
      const entry = this.updaterEntry();
      if (!entry || !existsSync(entry)) {
        await this.sendStatus(jobId, "failed", {
          error: `the a446-updater is not installed on this device (expected at ${entry ?? "unknown"})`,
          code: "UPDATER_NOT_INSTALLED",
        });
        await this.recordJob(jobId, { finalSent: true, terminalPhase: "failed", lastError: "UPDATER_NOT_INSTALLED" });
        if (this.runningJobId === jobId) this.runningJobId = null;
        return;
      }
      const args = [entry, "update", "--job-id", jobId];
      if (payload.version) args.push("--version", String(payload.version));
      const logFile = path.join(this.updaterHome(), "logs", `job-${jobId}-${Date.now()}.log`);
      await fs.mkdir(path.dirname(logFile), { recursive: true }).catch(() => {});
      let child = null;
      if (this.deps.spawnUpdater) {
        // Test injection: a throwing injector simulates a spawn failure.
        this.deps.spawnUpdater(args, { logFile });
      } else {
        child = spawn(process.execPath, args, {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
          windowsHide: true,
          env: process.env,
        });
        child.unref();
      }
      await this.sendStatus(jobId, "checking", { version: payload.version ?? null });
      this.startPolling(jobId);
      // A detached child can still fail to start (bad interpreter, missing
      // file deleted between check and spawn, ...). Catch it and terminate.
      if (child) {
        child.once("error", (error) => {
          void this.reportSpawnFailure(jobId, error);
        });
      }
    } catch (error) {
      // Any unexpected error must still produce a terminal report.
      await this.reportSpawnFailure(jobId, error);
    }
  }

  /** Reports a terminal failure and releases the slot; never throws. */
  async reportSpawnFailure(jobId, error) {
    try {
      this.stopPolling();
      await this.sendStatus(jobId, "failed", {
        error: safeUpdaterErrorText(error?.message ?? error),
        code: error?.code ?? "UPDATER_SPAWN_FAILED",
      });
      await this.recordJob(jobId, { finalSent: true, terminalPhase: "failed", lastError: error?.code ?? safeUpdaterErrorText(error?.message ?? error) });
    } catch (reportError) {
      console.error(`[${this.worker.agentId}] update failure report error: ${safeUpdaterErrorText(reportError.message)}`);
    } finally {
      if (this.runningJobId === jobId) this.runningJobId = null;
    }
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  startPolling(jobId) {
    this.stopPolling();
    let lastPhase = null;
    let ticks = 0;
    this.pollTimer = setInterval(async () => {
      ticks += 1;
      try {
        // Watchdog first: an updater that never writes a terminal phase
        // (crashed without state, hung installer) must produce a failed
        // terminal report instead of silently stopping the poll loop.
        if (ticks > this.maxPollTicks) {
          await this.reportSpawnFailure(jobId, Object.assign(
            new Error(`the updater did not reach a terminal phase within ${this.maxPollTicks} poll ticks`),
            { code: "UPDATER_POLL_TIMEOUT" },
          ));
          return;
        }
        const updaterState = await this.readUpdaterState();
        const job = updaterState?.job;
        if (!job || job.jobId !== jobId) return;
        if (job.phase !== lastPhase && ACTIVE_UPDATE_PHASES.has(job.phase)) {
          lastPhase = job.phase;
          await this.sendStatus(jobId, job.phase, {
            version: job.toVersion ?? null,
            fromVersion: job.fromVersion ?? null,
          });
        }
        if (TERMINAL_UPDATE_PHASES.has(job.phase)) {
          this.stopPolling();
          await this.sendStatus(jobId, job.phase, {
            version: job.toVersion ?? null,
            fromVersion: job.fromVersion ?? null,
            error: job.error?.message ?? null,
          });
          await this.recordJob(jobId, { finalSent: true, terminalPhase: job.phase });
          if (this.runningJobId === jobId) this.runningJobId = null;
        }
      } catch (error) {
        // A single poll error (transient fs issue) does not stop the loop,
        // but repeated errors must not hide a dead updater: after half the
        // watchdog budget of consecutive errors, fail the job explicitly.
        this.pollErrorCount = (this.pollErrorCount ?? 0) + 1;
        console.error(`[${this.worker.agentId}] update status poll error: ${safeUpdaterErrorText(error.message)}`);
        if (this.pollErrorCount >= Math.ceil(this.maxPollTicks / 2)) {
          await this.reportSpawnFailure(jobId, Object.assign(
            new Error(`update status polling failed repeatedly: ${error.message}`),
            { code: "UPDATER_POLL_TIMEOUT" },
          ));
        }
        return;
      }
      this.pollErrorCount = 0;
    }, this.pollIntervalMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  /**
   * Called on worker startup: after an update restart, report the terminal
   * state of jobs owned by this agent that were never final-reported.
   */
  async reportPendingFinalStatuses() {
    try {
      const jobs = this.worker.state.updateJobs ?? {};
      const updaterState = await this.readUpdaterState();
      for (const [jobId, record] of Object.entries(jobs)) {
        if (record.finalSent) continue;
        if (record.ownedBy && record.ownedBy !== this.worker.agentId) continue;
        if (updaterState?.job?.jobId === jobId && TERMINAL_UPDATE_PHASES.has(updaterState.job.phase)) {
          const job = updaterState.job;
          await this.sendStatus(jobId, job.phase, {
            version: job.toVersion ?? null,
            fromVersion: job.fromVersion ?? null,
            error: job.error?.message ?? null,
            reportedAfterRestart: true,
          });
          await this.recordJob(jobId, { finalSent: true, terminalPhase: job.phase });
          continue;
        }
        if (updaterState?.job?.jobId === jobId && ACTIVE_UPDATE_PHASES.has(updaterState.job.phase)) {
          // The detached updater is still working: resume polling from this
          // new worker instance so the job still reaches a terminal report.
          if (this.runningJobId == null) {
            this.runningJobId = jobId;
            await this.sendStatus(jobId, updaterState.job.phase, {
              version: updaterState.job.toVersion ?? null,
              fromVersion: updaterState.job.fromVersion ?? null,
              resumedAfterRestart: true,
            });
            this.startPolling(jobId);
          }
          continue;
        }
        // The updater never started or the job vanished: report stalled state
        // once so the Hub is not left waiting forever.
        if (!updaterState?.job || updaterState.job.jobId !== jobId) {
          await this.sendStatus(jobId, "failed", {
            error: "no matching updater transaction was found on this device",
            code: "UPDATER_STATE_MISSING",
            reportedAfterRestart: true,
          });
          await this.recordJob(jobId, { finalSent: true, terminalPhase: "failed", lastError: "UPDATER_STATE_MISSING" });
        }
      }
    } catch (error) {
      console.error(`[${this.worker.agentId}] update final status report error: ${safeUpdaterErrorText(error.message)}`);
    }
  }
}
