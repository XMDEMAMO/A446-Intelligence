import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocket } from "ws";
import { makeEnvelope, parseEnvelope, safeError, delay } from "./common.mjs";
import { MockAdapter } from "./adapters/mock.mjs";
import { CodexAdapter } from "./adapters/codex.mjs";
import { StdioJsonAdapter } from "./adapters/stdio-json.mjs";
import { AntigravityAdapter } from "./adapters/antigravity.mjs";
import { buildArtifactManifest } from "./artifact-manifest.mjs";
import { CheckpointStore } from "./checkpoint-store.mjs";
import { initialExecutorStatus, probeLocalCapabilities, statusAfterError, statusAfterSuccess } from "./capability-probe.mjs";
import { evaluateTaskPolicy, normalizePolicy, PolicyDeniedError, resolveAllowedPath } from "./local-policy.mjs";
import { addUsage, buildRolePrompt, normalizeModels, normalizeQuotaSnapshot, normalizeRoles, normalizeUsage, parseRoleSubmission } from "./collaboration.mjs";
import { probeQuota } from "./quota-probe.mjs";

export class AgentWorker {
  constructor(config) {
    this.config = config;
    this.agentId = config.agentId;
    this.ws = null;
    this.stopping = false;
    this.connected = false;
    this.queue = [];
    this.queuedIds = new Set();
    this.busy = false;
    this.current = null;
    this.currentAbort = null;
    this.heartbeatTimer = null;
    this.quotaTimer = null;
    this.reconnectAttempt = 0;
    this.saveChain = Promise.resolve();
    this.state = {
      sessionId: null,
      paused: false,
      pendingTasks: {},
      processed: {},
      outbox: {},
      executorStatus: null,
      usageTotals: null,
      sessions: {},
    };
    this.policy = normalizePolicy(config.policy, config.workspace);
    this.checkpoints = new CheckpointStore({
      directory: config.checkpoints?.directory ?? path.join(config.workspace, ".agent-hub", "checkpoints"),
      workspace: config.workspace,
      includeOutput: config.checkpoints?.includeOutput !== false,
      maxOutputChars: config.checkpoints?.maxOutputChars ?? 200_000,
    });
    this.observedCapabilities = null;
    this.quotaSnapshot = normalizeQuotaSnapshot(config.quotaSnapshot);
    this.quotaProbeError = null;
    this.adapter = createAdapter(config.adapter ?? { type: "mock" }, {
      agentId: this.agentId,
      workspace: config.workspace,
    });
  }

  async start() {
    if (!this.agentId) throw new Error("Worker config requires agentId");
    await mkdir(this.config.workspace, { recursive: true });
    await resolveAllowedPath(this.checkpoints.directory, this.policy, { mayNotExist: true });
    await this.checkpoints.init();
    await this.loadState();
    await this.adapter.start(this.state);
    this.observedCapabilities = probeLocalCapabilities(this.config);
    await this.refreshQuota();
    const detected = initialExecutorStatus(this.adapter.type, this.observedCapabilities);
    this.state.executorStatus = this.state.executorStatus
      ? { ...detected, quota: this.state.executorStatus.quota ?? "Unknown", lastError: this.state.executorStatus.lastError ?? detected.lastError }
      : detected;
    await this.saveState();
    for (const task of Object.values(this.state.pendingTasks)) this.enqueue(task);
    void this.connectLoop();
    return this;
  }

  async stop() {
    this.stopping = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.quotaTimer) clearInterval(this.quotaTimer);
    this.currentAbort?.abort();
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1000, "Worker stopping");
    else if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.terminate();
    await this.adapter.stop();
    await this.saveState();
  }

  async refreshQuota() {
    if (!this.config.quotaProbe?.command) return this.quotaSnapshot;
    try {
      const snapshot = await probeQuota(this.config.quotaProbe, { workspace: this.config.workspace });
      if (snapshot) this.quotaSnapshot = snapshot;
      this.quotaProbeError = null;
    } catch (error) {
      this.quotaProbeError = { message: String(error?.message ?? error).slice(0, 500), checkedAt: new Date().toISOString() };
    }
    return this.quotaSnapshot;
  }

  async loadState() {
    try {
      const saved = JSON.parse(await readFile(this.config.stateFile, "utf8"));
      this.state = {
        sessionId: saved.sessionId ?? null,
        paused: Boolean(saved.paused),
        pendingTasks: saved.pendingTasks ?? {},
        processed: saved.processed ?? {},
        outbox: saved.outbox ?? {},
        executorStatus: saved.executorStatus ?? null,
        usageTotals: saved.usageTotals ?? null,
        sessions: saved.sessions ?? {},
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async saveState() {
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
    this.saveChain = this.saveChain.then(async () => {
      await mkdir(path.dirname(this.config.stateFile), { recursive: true });
      const temp = `${this.config.stateFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, "utf8");
      await rename(temp, this.config.stateFile);
    });
    return this.saveChain;
  }

  async connectLoop() {
    while (!this.stopping) {
      try {
        await this.connectOnce();
      } catch (error) {
        if (!this.stopping) console.error(`[${this.agentId}] connection error: ${error.message}`);
      }
      if (this.stopping) break;
      this.reconnectAttempt += 1;
      const base = Number(this.config.reconnect?.baseMs ?? 1000);
      const max = Number(this.config.reconnect?.maxMs ?? 30000);
      const wait = Math.min(max, base * (2 ** Math.min(this.reconnectAttempt, 8))) + Math.floor(Math.random() * 250);
      await delay(wait);
    }
  }

  connectOnce() {
    return new Promise((resolve, reject) => {
      const token = this.config.authTokenEnv ? process.env[this.config.authTokenEnv] : undefined;
      if (this.config.authRequired && !token) return reject(new Error(`Missing required token environment variable ${this.config.authTokenEnv}`));
      const options = {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        rejectUnauthorized: this.config.tls?.rejectUnauthorized !== false,
      };
      if (this.config.tls?.caFile) {
        try { options.ca = readFileSync(this.config.tls.caFile); } catch (error) { return reject(error); }
      }
      const ws = new WebSocket(this.config.hubUrl, options);
      this.ws = ws;
      let opened = false;
      ws.once("open", () => {
        opened = true;
        this.connected = true;
        this.reconnectAttempt = 0;
        this.send(makeEnvelope("worker.hello", {
          agentId: this.agentId,
          payload: {
            adapter: this.adapter.type,
            capabilities: this.config.capabilities ?? ["task.execute", "pause", "resume", "cancel"],
            protocolFeatures: ["attempt-lease-v1"],
            sessionId: this.state.sessionId,
            paused: this.state.paused,
            platform: process.platform,
            node: process.version,
            observedCapabilities: this.observedCapabilities,
            executors: [this.state.executorStatus],
            ...this.agentProfile(),
          },
        }));
        for (const message of Object.values(this.state.outbox)) this.send(message);
        this.startHeartbeat();
        void this.drainQueue();
      });
      ws.on("message", (raw) => void this.handleMessage(raw));
      ws.once("error", (error) => {
        if (!opened) reject(error);
      });
      ws.once("close", () => {
        this.connected = false;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        resolve();
      });
    });
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const beat = () => this.send(makeEnvelope("worker.heartbeat", {
      agentId: this.agentId,
      payload: {
        busy: this.busy,
        paused: this.state.paused,
        sessionId: this.state.sessionId,
        observedCapabilities: this.observedCapabilities,
        executors: [this.state.executorStatus],
        currentTaskId: this.current?.taskId ?? null,
        currentAttemptId: this.current?.payload?.attemptId ?? null,
        usageTotals: this.state.usageTotals,
        quotaSnapshot: this.quotaSnapshot,
        quotaProbeError: this.quotaProbeError,
      },
    }));
    beat();
    this.heartbeatTimer = setInterval(beat, Number(this.config.heartbeatMs ?? 5000));
    if (this.quotaTimer) clearInterval(this.quotaTimer);
    if (this.config.quotaProbe?.command) {
      this.quotaTimer = setInterval(() => void this.refreshQuota(), Number(this.config.quotaProbe.intervalMs ?? 60_000));
      this.quotaTimer.unref();
    }
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  async sendReliable(message) {
    this.state.outbox[message.id] = message;
    await this.saveState();
    this.send(message);
  }

  async handleMessage(raw) {
    try {
      const message = parseEnvelope(raw);
      if (message.type === "hub.welcome") return;
      if (message.type === "ack") {
        delete this.state.outbox[message.replyTo];
        await this.saveState();
        return;
      }
      if (message.type === "task.assign") return this.acceptTask(message);
      if (message.type === "agent.pause") {
        this.state.paused = true;
        await this.saveState();
        this.send(makeEnvelope("ack", { agentId: this.agentId, replyTo: message.id }));
        return;
      }
      if (message.type === "agent.resume") {
        this.state.paused = false;
        await this.saveState();
        this.send(makeEnvelope("ack", { agentId: this.agentId, replyTo: message.id }));
        void this.drainQueue();
        return;
      }
      if (message.type === "task.cancel") {
        const attemptId = message.payload?.attemptId;
        await this.removeQueuedTask(message.taskId, attemptId);
        if (this.current?.taskId === message.taskId && (!attemptId || this.current.payload?.attemptId === attemptId)) this.currentAbort?.abort();
        this.send(makeEnvelope("ack", { agentId: this.agentId, replyTo: message.id }));
      }
    } catch (error) {
      console.error(`[${this.agentId}] message error: ${error.message}`);
    }
  }

  async acceptTask(message) {
    const prior = this.state.processed[message.id];
    if (prior) {
      this.send(makeEnvelope("ack", { agentId: this.agentId, replyTo: message.id }));
      await this.sendReliable(prior);
      return;
    }
    this.send(makeEnvelope("ack", { agentId: this.agentId, replyTo: message.id }));
    try {
      this.validateRole(message);
      await evaluateTaskPolicy(message, this.policy);
    } catch (error) {
      if (!(error instanceof PolicyDeniedError)) throw error;
      const checkpoint = await this.checkpoints.save(message, "REJECTED", { error: safeError(error) });
      const rejected = makeEnvelope("task.rejected", {
        agentId: this.agentId,
        taskId: message.taskId,
        payload: { code: error.code, reasons: error.reasons, checkpoint, attemptId: message.payload?.attemptId ?? null },
      });
      this.state.processed[message.id] = rejected;
      trimProcessed(this.state.processed, Number(this.config.maxProcessedMessages ?? 1000));
      await this.saveState();
      await this.sendReliable(rejected);
      return;
    }
    if (!this.state.pendingTasks[message.id]) {
      this.state.pendingTasks[message.id] = message;
      await this.saveState();
      await this.checkpoints.save(message, "ACCEPTED", { sessionId: this.state.sessionId });
    }
    this.enqueue(message);
    void this.drainQueue();
  }

  enqueue(message) {
    if (this.queuedIds.has(message.id)) return;
    this.queuedIds.add(message.id);
    this.queue.push(message);
  }

  async removeQueuedTask(taskId, attemptId) {
    const removed = [];
    this.queue = this.queue.filter((message) => {
      if (message.taskId !== taskId || (attemptId && message.payload?.attemptId !== attemptId)) return true;
      removed.push(message);
      this.queuedIds.delete(message.id);
      delete this.state.pendingTasks[message.id];
      return false;
    });
    await Promise.all(removed.map((message) => this.checkpoints.save(message, "CANCELLED", {
      sessionId: this.state.sessionId,
      error: { name: "AbortError", message: "Task cancelled before execution" },
    })));
    await this.saveState();
  }

  async drainQueue() {
    if (this.busy || this.state.paused) return;
    const message = this.queue.shift();
    if (!message) return;
    this.queuedIds.delete(message.id);
    this.busy = true;
    this.current = message;
    this.currentAbort = new AbortController();
    try {
      this.validateRole(message);
      await evaluateTaskPolicy(message, this.policy);
    } catch (error) {
      this.busy = false;
      this.current = null;
      this.currentAbort = null;
      if (error instanceof PolicyDeniedError) {
        const checkpoint = await this.checkpoints.save(message, "REJECTED", { error: safeError(error) });
        const rejected = makeEnvelope("task.rejected", {
          agentId: this.agentId,
          taskId: message.taskId,
          payload: { code: error.code, reasons: error.reasons, checkpoint, attemptId: message.payload?.attemptId ?? null },
        });
        delete this.state.pendingTasks[message.id];
        this.state.processed[message.id] = rejected;
        await this.saveState();
        await this.sendReliable(rejected);
        void this.drainQueue();
        return;
      }
      throw error;
    }
    const startedCheckpoint = await this.checkpoints.save(message, "RUNNING", { sessionId: this.state.sessionId });
    await this.sendReliable(makeEnvelope("task.started", {
      agentId: this.agentId,
      taskId: message.taskId,
      payload: { checkpoint: startedCheckpoint, attemptId: message.payload?.attemptId ?? null },
    }));
    let completion;
    try {
      const role = String(message.payload?.role ?? "").toLowerCase();
      const execution = message.payload?.execution ?? {};
      const sessionKey = String(message.payload?.sessionScopeId ?? "legacy");
      const scopedSessionId = this.state.sessions[sessionKey] ?? (sessionKey === "legacy" ? this.state.sessionId : null);
      const prompt = buildRolePrompt(role, message.payload?.input ?? "", message.payload ?? {});
      const result = await this.adapter.run(prompt, {
        agentId: this.agentId,
        taskId: message.taskId,
        sessionId: scopedSessionId,
        sessionKey,
        metadata: message.payload?.metadata ?? {},
        role,
        stage: message.payload?.stage ?? null,
        model: execution.model ?? null,
        reasoningEffort: execution.reasoningEffort ?? null,
        signal: this.currentAbort.signal,
      });
      if (result.sessionId) {
        this.state.sessions[sessionKey] = result.sessionId;
        this.state.sessionId = result.sessionId;
      }
      const taskSpec = message.payload?.taskSpec ?? message.payload?.metadata?.taskSpec;
      const artifacts = await buildArtifactManifest(taskSpec, this.policy, {
        maxFileBytes: this.config.artifacts?.maxFileBytes,
      });
      this.state.executorStatus = statusAfterSuccess(this.state.executorStatus);
      const usage = normalizeUsage(result.usage);
      if (usage) this.state.usageTotals = addUsage(this.state.usageTotals, usage);
      await this.refreshQuota();
      const submission = parseRoleSubmission(role, result.output);
      const checkpoint = await this.checkpoints.save(message, "COMPLETED", {
        sessionId: this.state.sessionId,
        output: result.output,
        artifacts,
      });
      completion = makeEnvelope("task.result", {
        agentId: this.agentId,
        taskId: message.taskId,
        payload: {
          output: result.output,
          role,
          model: execution.model ?? this.config.adapter?.model ?? null,
          submission,
          usage,
          usageTotals: this.state.usageTotals,
          quotaSnapshot: this.quotaSnapshot,
          sessionId: this.state.sessionId,
          artifacts,
          checkpoint,
          executor: this.state.executorStatus,
          attemptId: message.payload?.attemptId ?? null,
        },
      });
    } catch (error) {
      if (error?.name !== "AbortError") this.state.executorStatus = statusAfterError(this.state.executorStatus, error);
      const stage = error?.name === "AbortError" ? "CANCELLED" : "FAILED";
      const checkpoint = await this.checkpoints.save(message, stage, {
        sessionId: this.state.sessionId,
        error: safeError(error),
      });
      completion = makeEnvelope("task.error", {
        agentId: this.agentId,
        taskId: message.taskId,
        payload: {
          error: safeError(error),
          cancelled: error?.name === "AbortError",
          sessionId: this.state.sessionId,
          checkpoint,
          executor: this.state.executorStatus,
          attemptId: message.payload?.attemptId ?? null,
        },
      });
    }
    delete this.state.pendingTasks[message.id];
    this.state.processed[message.id] = completion;
    trimProcessed(this.state.processed, Number(this.config.maxProcessedMessages ?? 1000));
    this.busy = false;
    this.current = null;
    this.currentAbort = null;
    await this.saveState();
    await this.sendReliable(completion);
    void this.drainQueue();
  }

  validateRole(message) {
    const requested = String(message.payload?.role ?? "").toLowerCase();
    const roles = normalizeRoles(this.config.roles ?? this.config.role);
    if (requested && roles.length && !roles.includes(requested)) {
      throw new PolicyDeniedError([`agent ${this.agentId} does not accept role ${requested}`]);
    }
  }

  agentProfile() {
    return {
      deviceId: this.config.deviceId ?? this.agentId,
      account: this.config.account && typeof this.config.account === "object" ? {
        id: this.config.account.id ? String(this.config.account.id) : undefined,
        provider: this.config.account.provider ? String(this.config.account.provider) : undefined,
        plan: this.config.account.plan ? String(this.config.account.plan) : undefined,
        label: this.config.account.label ? String(this.config.account.label) : undefined,
      } : null,
      roles: normalizeRoles(this.config.roles ?? this.config.role),
      models: normalizeModels(this.config.models, this.config.adapter),
      maxConcurrency: 1,
      usageTotals: this.state.usageTotals,
      quotaSnapshot: this.quotaSnapshot,
      quotaProbeError: this.quotaProbeError,
    };
  }
}
function createAdapter(config, context) {
  if (config.type === "mock") return new MockAdapter(config, context);
  if (config.type === "codex") return new CodexAdapter(config, context);
  if (config.type === "antigravity") return new AntigravityAdapter(config, context);
  if (config.type === "stdio-json") return new StdioJsonAdapter(config, context);
  throw new Error(`Unsupported adapter type: ${config.type}`);
}
function trimProcessed(processed, max) {
  const keys = Object.keys(processed);
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete processed[key];
}
