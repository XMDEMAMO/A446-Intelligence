import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  UpdaterError,
  atomicWriteJson,
  compareVersions,
  nowIso,
  randomId,
  readJsonIfPresent,
  redact,
  UPDATER_VERSION,
  versionKey,
} from "./util.mjs";
import {
  INSTALL_LAYOUT,
  adoptLayout,
  ensureSharedJunctions,
  layoutPaths,
  resolveCurrentTarget,
  switchCurrentJunction,
  unadoptLayout,
  versionDirPath,
} from "./layout.mjs";
import { downloadAsset, listReleases, resolveTargetRelease } from "./release.mjs";
import {
  extractZip,
  listZipEntries,
  readStagedMarker,
  validateZipEntries,
  verifyExtractedTree,
  writeStagedMarker,
} from "./zip.mjs";
import { createHealthChecker, expectedAgentCount } from "./health.mjs";
import { installDependencies, resolveProcessController } from "./device.mjs";

const TERMINAL_PHASES = new Set(["completed", "failed", "rolled_back"]);
const PRE_SWITCH_PHASES = new Set(["checking", "downloading", "verifying_package", "staging", "staged", "preparing"]);
const POST_SWITCH_PHASES = new Set(["switched", "restarting", "verifying"]);
// "switching" = device stopped, physical junction swap in progress. The
// journal alone never proves the switch happened: recovery must read the
// actual junction target (see resolvePendingTransaction).
const SWITCHING_PHASE = "switching";

const REPORT_PHASE = {
  checking: "checking",
  downloading: "downloading",
  verifying_package: "downloading",
  staging: "downloading",
  staged: "staged",
  preparing: "staged",
  switching: "applying",
  switched: "applying",
  restarting: "restarting",
  verifying: "verifying",
  completed: "completed",
  failed: "failed",
  rolled_back: "rolled_back",
};

export class UpdaterCore {
  constructor({ home, config, logger, faults = new Set(), overrides = {}, deps = {} }) {
    this.home = path.resolve(home);
    this.config = config ?? {};
    this.logger = logger ?? (() => {});
    this.faults = faults;
    this.overrides = overrides;
    this.deps = deps;
    this.jobsDir = path.join(this.home, "jobs");
    this.logsDir = path.join(this.home, "logs");
    this.stateFile = path.join(this.home, "state.json");
    this.lockFile = path.join(this.home, "lock.pid");
    this.journalFile = path.join(this.home, "migration-journal.json");
    this.heldLock = null;
  }

  get installRoot() {
    return this.config.installRoot ? path.resolve(this.config.installRoot) : null;
  }

  get adopted() {
    return Boolean(this.installRoot && existsSync(layoutPaths(this.installRoot).currentJson));
  }

  requireAdopted() {
    if (!this.adopted) {
      throw new UpdaterError(
        "This device has not been adopted by the updater yet. Run the adopt command first.",
        { code: "NEEDS_ADOPT", exitCode: 4 },
      );
    }
  }

  async loadState() {
    try {
      const value = await readJsonIfPresent(this.stateFile);
      if (!value) return { schemaVersion: 1, updaterVersion: UPDATER_VERSION, currentVersion: null, job: null };
      return value;
    } catch (error) {
      throw new UpdaterError(
        `state.json is unreadable (${redact(error.message)}). Keeping the current runnable version; manual intervention required.`,
        { code: "STATE_CORRUPT", exitCode: 16 },
      );
    }
  }

  async saveState(state) {
    await atomicWriteJson(this.stateFile, state);
  }

  async saveJob(job) {
    const state = await this.loadState();
    state.job = job;
    if (job?.phase === "completed") state.currentVersion = job.toVersion;
    await this.saveState(state);
    return state;
  }

  async acquireLock() {
    await fs.mkdir(this.home, { recursive: true });
    // Atomic acquisition: the lock file content is fully written to a
    // temporary file first, then atomically linked into place. fs.link
    // fails with EEXIST when the lock already exists, so two processes can
    // never both believe they hold the lock through this path (no
    // check-then-write window).
    const temp = `${this.lockFile}.new-${process.pid}`;
    const candidate = { pid: process.pid, at: nowIso() };
    await atomicWriteJson(temp, candidate);
    try {
      await fs.link(temp, this.lockFile);
      this.heldLock = candidate;
      return this.heldLock;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
    const existing = await readJsonIfPresent(this.lockFile).catch(() => null);
    if (!existing || !Number.isInteger(existing.pid)) {
      throw new UpdaterError(
        `The lock file at ${redact(this.lockFile)} exists but is unreadable. ` +
        `Verify no updater is running, then delete it manually.`,
        { code: "STATE_CORRUPT", exitCode: 16 },
      );
    }
    if (existing.pid !== process.pid && await isPidAlive(existing.pid)) {
      throw new UpdaterError(
        `Another update is already running (pid ${existing.pid}, job ${redact(String(existing.jobId ?? "?"))}).`,
        { code: "BUSY", exitCode: 10 },
      );
    }
    // Stale lock (dead owner): take it over with an atomic rename, then
    // verify the file really belongs to this process (a second racer may
    // have won the rename in between).
    const takeover = `${this.lockFile}.take-${process.pid}`;
    await atomicWriteJson(takeover, { pid: process.pid, at: nowIso(), tookOverFrom: existing.pid });
    try {
      await fs.rename(takeover, this.lockFile);
    } catch (error) {
      await fs.rm(takeover, { force: true }).catch(() => {});
      throw new UpdaterError(
        "Another update is already running (the stale lock could not be taken over).",
        { code: "BUSY", exitCode: 10 },
      );
    }
    const verify = await readJsonIfPresent(this.lockFile).catch(() => null);
    if (verify?.pid !== process.pid) {
      throw new UpdaterError(
        `Another update is already running (the lock was re-acquired by pid ${verify?.pid}).`,
        { code: "BUSY", exitCode: 10 },
      );
    }
    this.heldLock = verify;
    return this.heldLock;
  }

  async releaseLock() {
    if (this.heldLock) {
      await fs.rm(this.lockFile, { force: true }).catch(() => {});
      this.heldLock = null;
    }
  }

  fault(name) {
    if (this.faults.has(name)) {
      this.logger(`fault injection: ${name}`);
      process.exit(70);
    }
  }

  async currentVersion() {
    const current = await resolveCurrentTarget(this.installRoot);
    return current?.version ?? null;
  }

  async listVersions() {
    const versionsDir = layoutPaths(this.installRoot).versionsDir;
    if (!existsSync(versionsDir)) return [];
    const entries = await fs.readdir(versionsDir);
    const versions = [];
    for (const entry of entries) {
      if (entry.startsWith(INSTALL_LAYOUT.stagingPrefix) || entry.startsWith(INSTALL_LAYOUT.trashPrefix)) continue;
      const dir = path.join(versionsDir, entry);
      const marker = await readStagedMarker(dir);
      if (marker) {
        versions.push({ version: entry, staged: true, stagedAt: marker.stagedAt ?? null });
        continue;
      }
      const adopted = await readJsonIfPresent(path.join(dir, ".a446-version.json")).catch(() => null);
      if (adopted) versions.push({ version: entry, staged: false, stagedAt: adopted.adoptedAt ?? null });
    }
    return versions;
  }

  // ------------------------------------------------------------------ status

  async status() {
    if (!this.adopted) {
      return { adopted: false, updaterVersion: UPDATER_VERSION, home: this.home };
    }
    let state;
    try {
      state = await this.loadState();
    } catch (error) {
      return {
        adopted: true,
        updaterVersion: UPDATER_VERSION,
        home: this.home,
        installRoot: this.installRoot,
        error: { code: error.code, message: error.message },
        exitCode: error.exitCode ?? 16,
      };
    }
    const current = await resolveCurrentTarget(this.installRoot);
    const pending = state.job && !TERMINAL_PHASES.has(state.job.phase);
    return {
      adopted: true,
      updaterVersion: UPDATER_VERSION,
      home: this.home,
      installRoot: this.installRoot,
      livePath: this.config.livePath ?? null,
      role: this.config.role ?? null,
      deviceId: this.config.deviceId ?? null,
      hubBaseUrl: this.config.hubBaseUrl ?? null,
      currentVersion: current?.version ?? state.currentVersion,
      currentTarget: current?.target ?? null,
      versions: await this.listVersions(),
      job: state.job,
      pendingRecovery: Boolean(pending),
      pendingNeedsResume: Boolean(pending && (POST_SWITCH_PHASES.has(state.job.phase) || state.job.phase === SWITCHING_PHASE)),
    };
  }

  // ------------------------------------------------------------------ check

  async check({ version } = {}) {
    this.requireAdopted();
    const target = await this.resolveTarget({ version });
    const current = await this.currentVersion();
    const comparison = compareVersions(target.manifest.version, current);
    return {
      currentVersion: current,
      targetVersion: target.manifest.version,
      upToDate: comparison === 0,
      newerAvailable: comparison > 0,
      downgrade: comparison < 0,
      manifest: target.manifest,
    };
  }

  async resolveTarget({ version }) {
    const repository = this.config.repository ?? "XMDEMAMO/A446-Intelligence";
    const apiBase = this.overrides.apiBase ?? this.config.apiBase ?? "https://api.github.com";
    const token = this.overrides.token ?? null;
    const allowHttp = Boolean(this.overrides.allowHttp);
    const releases = await listReleases({ apiBase, repository, token, allowHttp });
    return await resolveTargetRelease({ releases, requestedVersion: version, repository, token, allowHttp, apiBase });
  }

  // ------------------------------------------------------------------ update

  async update({ version, jobId, allowDowngrade } = {}) {
    this.requireAdopted();
    await this.acquireLock();
    try {
      await this.resolvePendingTransaction();
      const state = await this.loadState();
      const pendingJob = state.job && !TERMINAL_PHASES.has(state.job.phase) ? state.job : null;
      // A pending transaction is always resumed under its recorded id; a
      // terminal failed job is NOT inherited by a parameter-less invocation,
      // so an interrupted download can be retried without a new job id.
      const requestedJobId = jobId ?? pendingJob?.jobId ?? randomId("update");
      if (state.job && TERMINAL_PHASES.has(state.job.phase) && state.job.jobId === requestedJobId) {
        // Idempotent: report the recorded terminal result without reinstalling.
        if (state.job.phase === "completed") return { job: state.job, idempotent: true };
        if (state.job.phase === "rolled_back") {
          const rolledBack = new UpdaterError(
            `Job ${redact(requestedJobId)} previously failed and was rolled back to ${state.job.fromVersion}.`,
            { code: "ROLLED_BACK", exitCode: 14 },
          );
          rolledBack.job = state.job;
          throw rolledBack;
        }
        const failedError = new UpdaterError(
          `Job ${redact(requestedJobId)} previously failed: ${state.job.error?.message ?? "unknown error"}`,
          { code: state.job.error?.code ?? "UPDATE_FAILED", exitCode: state.job.error?.exitCode ?? 13 },
        );
        failedError.job = state.job;
        throw failedError;
      }
      if (pendingJob && pendingJob.jobId !== requestedJobId) {
        throw new UpdaterError(
          `An update transaction for job '${redact(pendingJob.jobId)}' is still pending (phase ${pendingJob.phase}).`,
          { code: "BUSY", exitCode: 10 },
        );
      }
      const current = await this.currentVersion();
      const target = await this.resolveTarget({ version });
      const comparison = compareVersions(target.manifest.version, current);
      if (comparison === 0) {
        throw new UpdaterError(
          `Version ${target.manifest.version} is already installed; nothing was changed.`,
          { code: "UP_TO_DATE", exitCode: 3 },
        );
      }
      if (comparison < 0 && !allowDowngrade) {
        throw new UpdaterError(
          `Refusing to downgrade from ${current} to ${target.manifest.version} without --allow-downgrade.`,
          { code: "VERSION_DOWNGRADE_REFUSED", exitCode: 11 },
        );
      }
      const job = {
        jobId: requestedJobId,
        fromVersion: current,
        toVersion: target.manifest.version,
        phase: "checking",
        reportPhase: "checking",
        previousTarget: null,
        newTarget: null,
        startedAt: nowIso(),
        updatedAt: nowIso(),
      };
      await this.saveJob(job);
      try {
        return await this.runPipeline(job, target);
      } catch (error) {
        // Failures before the switch leave the previous version current; the
        // job is recorded as failed so callers can retry (docs 4.1/4.2).
        if (!TERMINAL_PHASES.has(job.phase)) {
          return await this.handlePipelineFailure(job, error);
        }
        throw error;
      }
    } finally {
      await this.releaseLock();
    }
  }

  async stage({ version, jobId } = {}) {
    this.requireAdopted();
    await this.acquireLock();
    try {
      await this.resolvePendingTransaction();
      const state = await this.loadState();
      const requestedJobId = jobId ?? randomId("stage");
      if (state.job && !TERMINAL_PHASES.has(state.job.phase) && state.job.jobId !== requestedJobId) {
        throw new UpdaterError(
          `Another update transaction '${redact(state.job.jobId)}' is pending (phase ${state.job.phase}).`,
          { code: "BUSY", exitCode: 10 },
        );
      }
      const current = await this.currentVersion();
      const target = await this.resolveTarget({ version });
      const comparison = compareVersions(target.manifest.version, current);
      if (comparison === 0) {
        throw new UpdaterError(`Version ${target.manifest.version} is already installed.`, { code: "UP_TO_DATE", exitCode: 3 });
      }
      if (comparison < 0) {
        throw new UpdaterError(
          `Refusing to stage a downgrade to ${target.manifest.version}.`,
          { code: "VERSION_DOWNGRADE_REFUSED", exitCode: 11 },
        );
      }
      const job = {
        jobId: requestedJobId,
        fromVersion: current,
        toVersion: target.manifest.version,
        phase: "checking",
        reportPhase: "checking",
        previousTarget: null,
        newTarget: null,
        startedAt: nowIso(),
        updatedAt: nowIso(),
      };
      await this.saveJob(job);
      try {
        const staged = await this.stageTarget(job, target);
        await this.setPhase(job, "staged");
        return { job, staged };
      } catch (error) {
        if (!TERMINAL_PHASES.has(job.phase)) {
          return await this.handlePipelineFailure(job, error);
        }
        throw error;
      }
    } finally {
      await this.releaseLock();
    }
  }

  async apply({ version, jobId } = {}) {
    this.requireAdopted();
    await this.acquireLock();
    try {
      await this.resolvePendingTransaction();
      const state = await this.loadState();
      let job = state.job;
      if (!job || TERMINAL_PHASES.has(job.phase)) {
        if (version) {
          const marker = await readStagedMarker(versionDirPath(this.installRoot, version));
          if (!marker) {
            throw new UpdaterError(`Version ${version} is not staged. Run stage first.`, { code: "NOT_STAGED", exitCode: 15 });
          }
          const current = await this.currentVersion();
          job = {
            jobId: jobId ?? randomId("apply"),
            fromVersion: current,
            toVersion: versionKey(version),
            phase: "staged",
            reportPhase: "staged",
            previousTarget: null,
            newTarget: null,
            startedAt: nowIso(),
            updatedAt: nowIso(),
          };
          await this.saveJob(job);
        } else {
          throw new UpdaterError("No staged update transaction found. Run stage or update first.", { code: "NOT_STAGED", exitCode: 15 });
        }
      }
      if (!["staged", "preparing"].includes(job.phase)) {
        const marker = await readStagedMarker(versionDirPath(this.installRoot, job.toVersion));
        if (!marker) {
          throw new UpdaterError(
            `Pending job is in phase ${job.phase} and its staged version directory is missing. Run update to restart the pipeline.`,
            { code: "NOT_STAGED", exitCode: 15 },
          );
        }
      }
      return await this.applyStaged(job);
    } finally {
      await this.releaseLock();
    }
  }

  // ------------------------------------------------------------------ pipeline

  async setPhase(job, phase, extra = {}) {
    job.phase = phase;
    job.reportPhase = REPORT_PHASE[phase] ?? phase;
    job.updatedAt = nowIso();
    Object.assign(job, extra);
    await this.saveJob(job);
    this.logger(`phase -> ${phase}`);
  }

  async runPipeline(job, target) {
    await this.stageTarget(job, target);
    await this.setPhase(job, "staged");
    return await this.applyStaged(job);
  }

  async stageTarget(job, target) {
    const { manifest, release } = target;
    const jobDir = path.join(this.jobsDir, job.jobId);
    await fs.mkdir(jobDir, { recursive: true });
    await fs.mkdir(this.logsDir, { recursive: true });
    await atomicWriteJson(path.join(jobDir, "manifest.json"), manifest);

    await this.setPhase(job, "downloading");
    const destination = path.join(jobDir, "download", manifest.assetName);
    if (!existsSync(destination)) {
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const asset = assets.find((item) => item?.name === manifest.assetName);
      if (!asset || typeof asset.browser_download_url !== "string") {
        throw new UpdaterError(`Release does not contain asset '${manifest.assetName}'`, { code: "ASSET_MISSING", exitCode: 11 });
      }
      await downloadAsset({
        url: asset.browser_download_url,
        destination,
        expectedSha256: manifest.sha256,
        token: this.overrides.token ?? null,
        allowHttp: Boolean(this.overrides.allowHttp),
        faultHook: {
          afterBytes: this.overrides.truncateDownloadAtBytes,
          crashAfterDownload: this.faults.has("after-download"),
        },
      });
    }

    await this.setPhase(job, "verifying_package");
    const entries = await listZipEntries(destination);
    validateZipEntries(entries, { packageRoot: manifest.packageRoot });

    await this.setPhase(job, "staging");
    const versionsDir = layoutPaths(this.installRoot).versionsDir;
    const finalVersionDir = versionDirPath(this.installRoot, manifest.version);
    const stagingDir = path.join(versionsDir, `${versionKey(manifest.version)}${INSTALL_LAYOUT.stagingPrefix}${job.jobId}`);
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    await extractZip(destination, stagingDir);
    const stagedRoot = path.join(stagingDir, manifest.packageRoot);
    const verification = await verifyExtractedTree(stagedRoot, manifest.packageRoot, entries);
    await ensureSharedJunctions(stagedRoot, this.installRoot);
    const installResult = await installDependencies({
      versionDir: stagedRoot,
      includeWeb: this.config.role === "coordinator",
      logger: (message) => this.logger(message),
      skip: this.overrides.skipDependencyInstall ?? this.config.dependencyInstall === false,
    });
    await atomicWriteJson(path.join(stagedRoot, ".a446-version.json"), { version: versionKey(manifest.version), stagedAt: nowIso() });
    await writeStagedMarker(stagedRoot, {
      jobId: job.jobId,
      version: versionKey(manifest.version),
      stagedAt: nowIso(),
      verifiedFiles: verification.verifiedFiles,
      verificationMode: verification.mode,
    });
    await fs.mkdir(versionsDir, { recursive: true });
    if (existsSync(finalVersionDir)) {
      await fs.rm(finalVersionDir, { recursive: true, force: true });
    }
    // The package root itself becomes the version directory so the layout
    // matches the live install (PACKAGE-MANIFEST.json at the root) and the
    // staged marker sits at versions/<key>/.staged-ok.
    await fs.rename(stagedRoot, finalVersionDir);
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    this.fault("after-stage");
    return { versionDir: finalVersionDir, verification, installResult };
  }

  /**
   * Stop -> switch -> restart -> verify -> commit.
   *
   * Journal truth rule: every phase is persisted only AFTER the physical
   * fact it names has happened. `switching` is written while the device is
   * stopped but BEFORE the junction swap; `switched` is written only after
   * switchCurrentJunction re-read the junction and confirmed it points at
   * the new version directory. Recovery therefore never trusts the journal
   * over the filesystem (see resolvePendingTransaction).
   */
  async applyStaged(job) {
    const previous = await resolveCurrentTarget(this.installRoot);
    await this.setPhase(job, "preparing", {
      previousTarget: previous?.target ?? null,
      newTarget: `versions/${versionKey(job.toVersion)}`,
    });
    try {
      await this.stopDevice();
      this.fault("after-stop");
      await this.setPhase(job, SWITCHING_PHASE);
      await switchCurrentJunction(this.installRoot, job.toVersion, {
        faultHook: (step) => this.fault(`switch-${step}`),
      });
      this.fault("after-switch");
      await this.setPhase(job, "switched");
      await this.startDevice();
      this.fault("after-restart");
      await this.setPhase(job, "verifying");
      await this.verifyHealth(job.toVersion);
      this.fault("after-verify");
      await this.setPhase(job, "completed", { completedAt: nowIso() });
      await this.pruneOldVersions(job);
      await this.archiveJob(job);
      return { job };
    } catch (error) {
      return await this.handlePipelineFailure(job, error);
    }
  }

  async handlePipelineFailure(job, error) {
    const switched = [SWITCHING_PHASE, "switched", "restarting", "verifying"].includes(job.phase) || job.failedAfterSwitch === true;
    if (!switched) {
      await this.setPhase(job, "failed", { error: safeErrorRecord(error) });
      await this.archiveJob(job);
      throw error;
    }
    this.logger(`update failed after switch (${error.message}); rolling back`);
    try {
      await this.rollbackToPrevious(job, { markPhase: "rolled_back" });
      await this.archiveJob(job);
      const rolledBack = new UpdaterError(
        `Update to ${job.toVersion} failed and the previous version ${job.fromVersion} was restored and verified. Cause: ${error.message}`,
        { code: "ROLLED_BACK", exitCode: 14 },
      );
      rolledBack.job = job;
      throw rolledBack;
    } catch (rollbackError) {
      if (rollbackError?.code === "ROLLED_BACK") throw rollbackError;
      await this.setPhase(job, "failed", {
        error: safeErrorRecord(error),
        rollbackError: safeErrorRecord(rollbackError),
        failedAfterSwitch: true,
      });
      await this.archiveJob(job);
      throw new UpdaterError(
        `Update failed (${error.message}) and rollback also failed (${rollbackError.message}). Manual intervention required: inspect ` +
        `${redact(layoutPaths(this.installRoot).currentJunction)}, current.json and state.json before restarting the device.`,
        { code: "NEEDS_MANUAL_INTERVENTION", exitCode: 13 },
      );
    }
  }

  async stopDevice() {
    const controller = this.deps.processController ?? this.buildProcessController();
    return await controller.stop();
  }

  async startDevice() {
    const controller = this.deps.processController ?? this.buildProcessController();
    return await controller.start({
      role: this.config.role,
      hubIp: this.config.hubIp,
      deviceId: this.config.deviceId,
      accessMode: this.config.accessMode,
      logFile: path.join(this.logsDir, `restart-${nowIso().replace(/[:.]/g, "-")}.pid`),
    });
  }

  async listDeviceProcesses() {
    const controller = this.deps.processController ?? this.buildProcessController();
    if (typeof controller.listA446Processes !== "function") return [];
    return await controller.listA446Processes();
  }

  buildProcessController() {
    return resolveProcessController({
      controller: this.overrides.processController ?? "real",
      livePath: this.config.livePath,
      installRoot: this.installRoot,
      actionFile: path.join(this.home, "mock-process-actions.json"),
      logger: (message) => this.logger(message),
    });
  }

  async verifyHealth(version) {
    const paths = layoutPaths(this.installRoot);
    const expected = await expectedAgentCount(paths.sharedVarDir, this.config.deviceId);
    const timeoutSeconds = Number(this.config.healthTimeoutSeconds ?? 60);
    const checker = this.deps.healthChecker ?? createHealthChecker({
      hubBaseUrl: this.overrides.healthBase ?? this.config.hubBaseUrl,
      sharedVarDir: paths.sharedVarDir,
      deviceId: this.config.deviceId,
      role: this.config.role,
      expectedOnlineAgents: expected,
      timeoutMs: timeoutSeconds * 1000,
      logger: (message) => this.logger(message),
    });
    return await checker.verify();
  }

  // ------------------------------------------------------------------ rollback

  async rollback() {
    this.requireAdopted();
    await this.acquireLock();
    try {
      const state = await this.loadState();
      const job = state.job;
      if (job?.previousTarget) {
        if (TERMINAL_PHASES.has(job.phase) || POST_SWITCH_PHASES.has(job.phase) || job.phase === SWITCHING_PHASE) {
          await this.rollbackToPrevious(job, { markPhase: "rolled_back" });
          return { job };
        }
        throw new UpdaterError(
          `Pending job is in phase ${job.phase}; run update or apply to finish or roll it back.`,
          { code: "NOT_SWITCHED", exitCode: 15 },
        );
      }
      const versions = await this.listVersions();
      const current = await this.currentVersion();
      const candidates = versions
        .filter((item) => item.version !== current)
        .sort((left, right) => compareVersions(left.version, right.version));
      const previous = candidates[candidates.length - 1];
      if (!previous) {
        throw new UpdaterError("No previous version is available to roll back to.", { code: "NO_ROLLBACK_TARGET", exitCode: 15 });
      }
      const synthetic = {
        jobId: job?.jobId ?? randomId("rollback"),
        fromVersion: current,
        toVersion: previous.version,
        phase: "verifying",
        reportPhase: "verifying",
        previousTarget: `versions/${current}`,
        newTarget: `versions/${previous.version}`,
        startedAt: job?.startedAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      await this.saveJob(synthetic);
      await this.rollbackToPrevious(synthetic, { markPhase: "rolled_back" });
      return { job: synthetic };
    } finally {
      await this.releaseLock();
    }
  }

  async rollbackToPrevious(job, { markPhase }) {
    if (!job.previousTarget) {
      throw new UpdaterError("No previous target recorded for rollback", { code: "NO_ROLLBACK_TARGET", exitCode: 15 });
    }
    const previousVersion = versionFromTarget(job.previousTarget);
    await this.stopDevice();
    await switchCurrentJunction(this.installRoot, previousVersion);
    await this.startDevice();
    await this.verifyHealth(previousVersion);
    if (markPhase) await this.setPhase(job, markPhase, { rolledBackAt: nowIso() });
  }

  async pruneOldVersions(job) {
    const keep = new Set([versionKey(job.toVersion), versionKey(job.fromVersion)].filter(Boolean));
    const keepCount = Math.max(2, Number(this.config.keepVersions ?? 2));
    const versions = (await this.listVersions())
      .filter((item) => !keep.has(item.version))
      .sort((left, right) => compareVersions(left.version, right.version));
    const excess = versions.slice(0, Math.max(0, versions.length - (keepCount - keep.size)));
    for (const item of excess) {
      this.logger(`pruning old version ${item.version}`);
      await fs.rm(versionDirPath(this.installRoot, item.version), { recursive: true, force: true }).catch(() => {});
    }
  }

  async archiveJob(job) {
    await fs.mkdir(path.join(this.jobsDir, job.jobId), { recursive: true });
    await atomicWriteJson(path.join(this.jobsDir, job.jobId, "state-final.json"), job);
  }

  /**
   * Power-loss / interruption recovery (docs/UPDATER_PROTOCOL.md 4.2).
   *
   * The journal phase is a HINT, never the proof: the current junction
   * target is the physical truth. Before any post-switch phase may lead to
   * `completed`, the junction target must equal `toVersion`; otherwise the
   * switch never happened (or a rollback already ran) and the previous
   * version is completed as rolled_back instead. This makes the premature
   * "switched" journal write of older versions harmless: an old version
   * actually running can never be reported as a completed new version.
   */
  async resolvePendingTransaction() {
    const state = await this.loadState();
    const job = state.job;
    if (!job || TERMINAL_PHASES.has(job.phase)) return state;
    if (PRE_SWITCH_PHASES.has(job.phase)) {
      this.logger(`pending pre-switch transaction ${job.jobId} (phase ${job.phase})`);
      return state;
    }
    if (job.phase === SWITCHING_PHASE) {
      this.logger(`resuming interrupted switch for ${job.jobId}: checking the physical junction target`);
      try {
        const target = await resolveCurrentTarget(this.installRoot);
        if (!target || versionKey(target.version) !== versionKey(job.toVersion)) {
          // The physical switch never completed: redo it. This also repairs
          // any half-finished swap (current missing, .next/.old leftover).
          await switchCurrentJunction(this.installRoot, job.toVersion);
        }
        await this.setPhase(job, "switched", { resumedAfterCrash: true });
        return await this.finishPostSwitch(job);
      } catch (error) {
        return await this.handlePipelineFailure(job, error);
      }
    }
    if (POST_SWITCH_PHASES.has(job.phase)) {
      this.logger(`resuming post-switch transaction ${job.jobId}: verifying ${job.toVersion}`);
      try {
        const target = await resolveCurrentTarget(this.installRoot);
        if (!target || versionKey(target.version) !== versionKey(job.toVersion)) {
          // The junction does not point at the new version: either the
          // switch never happened (premature journal) or a rollback was
          // already in progress. Never complete the new version; finish
          // rolling back to the previous one instead.
          this.logger(
            `junction points at ${target?.version ?? "nothing"} instead of ${job.toVersion}; ` +
            `completing the rollback to the previous version`,
          );
          await this.rollbackToPrevious(job, { markPhase: "rolled_back" });
          await this.archiveJob(job);
          return await this.loadState();
        }
        return await this.finishPostSwitch(job);
      } catch (error) {
        return await this.handlePipelineFailure(job, error);
      }
    }
    return state;
  }

  async finishPostSwitch(job) {
    const running = await this.listDeviceProcesses();
    if (!running.length) {
      this.logger("device is not running; starting current junction target first");
      await this.startDevice();
    }
    await this.verifyHealth(job.toVersion);
    await this.setPhase(job, "completed", { completedAt: nowIso(), resumedAfterCrash: true });
    await this.archiveJob(job);
    return await this.loadState();
  }

  // ------------------------------------------------------------------ adopt

  async adopt({ live, role, hubIp, deviceId, accessMode, installRoot } = {}) {
    if (!live) throw new UpdaterError("adopt requires --live <path>", { code: "USAGE", exitCode: 2 });
    if (!["coordinator", "worker"].includes(String(role))) {
      throw new UpdaterError("adopt requires --role coordinator|worker", { code: "USAGE", exitCode: 2 });
    }
    const livePath = path.resolve(live);
    const root = path.resolve(installRoot ?? defaultInstallRoot(livePath));
    const paths = layoutPaths(root);
    // Resolve and validate EVERY parameter before the first file is moved.
    // settings.json may live at the pre-migration location (under live) or,
    // after a partially completed migration, under shared/var - both are
    // read-only lookups, so validation itself never mutates the disk.
    const preSettings = await readJsonIfPresent(path.join(livePath, "apps", "agent-hub", "var", "lan", "settings.json")).catch(() => null);
    const sharedSettings = await readJsonIfPresent(path.join(paths.sharedVarDir, "lan", "settings.json")).catch(() => null);
    const settings = preSettings ?? sharedSettings;
    const resolvedHubIp = hubIp ?? settings?.hubIp ?? null;
    const resolvedDeviceId = deviceId ?? settings?.deviceId ?? null;
    const resolvedAccessMode = accessMode ?? settings?.accessMode ?? "full";
    if (!resolvedHubIp || !/^\d+\.\d+\.\d+\.\d+$/.test(String(resolvedHubIp))) {
      throw new UpdaterError("adopt requires --hub-ip <IPv4> (or a readable var/lan/settings.json)", { code: "USAGE", exitCode: 2 });
    }
    if (!resolvedDeviceId || !/^[A-Za-z0-9._-]+$/.test(String(resolvedDeviceId))) {
      throw new UpdaterError("adopt requires --device-id <id> (or a readable var/lan/settings.json)", { code: "USAGE", exitCode: 2 });
    }
    const adopted = await adoptLayout({
      livePath,
      installRoot: root,
      journalFile: this.journalFile,
      logger: (m) => this.logger(m),
      hooks: { after: (step) => this.fault(`adopt-${step}`) },
    });
    const currentVersion = await this.currentVersionFromLayout(root);
    const config = {
      schemaVersion: 1,
      repository: this.config.repository ?? "XMDEMAMO/A446-Intelligence",
      apiBase: this.config.apiBase ?? "https://api.github.com",
      installRoot: root,
      livePath,
      role: String(role),
      hubIp: String(resolvedHubIp),
      deviceId: String(resolvedDeviceId),
      accessMode: String(resolvedAccessMode),
      hubBaseUrl: `http://${resolvedHubIp}:8787`,
      healthTimeoutSeconds: Number(this.config.healthTimeoutSeconds ?? 60),
      keepVersions: Number(this.config.keepVersions ?? 2),
      dependencyInstall: this.config.dependencyInstall !== false,
      adoptedAt: nowIso(),
    };
    await atomicWriteJson(path.join(this.home, "config.json"), config);
    // Re-running adopt on an already-adopted layout must not wipe a possibly
    // in-flight transaction; preserve any recorded job otherwise.
    const existingState = await this.loadState().catch(() => null);
    await this.saveState({
      schemaVersion: 1,
      updaterVersion: UPDATER_VERSION,
      currentVersion: currentVersion ?? existingState?.currentVersion ?? null,
      job: existingState?.job ?? null,
    });
    this.config = config;
    return { config: { ...config }, version: currentVersion, ...(adopted.alreadyAdopted ? { alreadyAdopted: true } : {}) };
  }

  async currentVersionFromLayout(root) {
    const current = await resolveCurrentTarget(root);
    return current?.version ?? null;
  }

  async unadopt() {
    if (!this.adopted) throw new UpdaterError("Nothing to unadopt", { code: "NOT_ADOPTED", exitCode: 4 });
    const result = await unadoptLayout({
      livePath: this.config.livePath,
      installRoot: this.installRoot,
      journalFile: this.journalFile,
      logger: (message) => this.logger(message),
    });
    await fs.rm(path.join(this.home, "config.json"), { force: true }).catch(() => {});
    await fs.rm(this.stateFile, { force: true }).catch(() => {});
    return result;
  }
}

function versionFromTarget(target) {
  const segments = String(target).split("/");
  return versionKey(segments[segments.length - 1]);
}

function defaultInstallRoot(livePath) {
  return path.join(path.dirname(path.resolve(livePath)), ".a446");
}

function safeErrorRecord(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: redact(String(error?.message ?? error)),
    exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : null,
  };
}

async function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export { createHealthChecker, expectedAgentCount };
