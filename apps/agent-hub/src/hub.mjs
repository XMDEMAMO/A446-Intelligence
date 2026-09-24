import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { EventLog } from "./event-log.mjs";
import { MemoryHubStore } from "./hub-store.mjs";
import { isLoopbackHost, makeEnvelope, parseEnvelope, safeError } from "./common.mjs";
import { addUsage, bindModelQuotas, chooseAgent, chooseModel, isPreferredQuotaSnapshot, normalizeModels, normalizeQuotaSnapshot, normalizeRoles, normalizeStageModels, parseRoleSubmission, ROLE_SET, STAGE_SET } from "./collaboration.mjs";
import { extractArtifactPaths } from "./local-policy.mjs";
import { HubUpdateRegistry } from "./hub-updates.mjs";
import { ConversationLifecycleManager } from "./conversation-lifecycle.mjs";

const ACTIVE_TASK_STATUSES = new Set(["queued", "awaiting_approval", "dispatched", "running", "processing_result"]);
const ACTIVE_SLOT_STATUSES = new Set(["dispatched", "running", "processing_result"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "rejected"]);
const ACTIVE_ATTEMPT_STATUSES = new Set(["assigned", "running"]);
const RELIABLE_WORKER_MESSAGES = new Set(["task.started", "task.result", "task.error", "task.rejected", "approval.request", "device.update.status"]);
const LEASE_PROTOCOL_FEATURE = "attempt-lease-v1";
const ARTIFACT_PROTOCOL_FEATURE = "artifact-transfer-v1";

export class AgentHub {
  constructor(config, services = {}) {
    this.config = config;
    this.host = config.host ?? "127.0.0.1";
    this.port = Number(config.port ?? 8787);
    this.token = config.auth?.tokenEnv ? process.env[config.auth.tokenEnv] : undefined;
    this.agents = new Map();
    this.connections = new Map();
    this.tasks = new Map();
    this.messages = [];
    this.messageSeq = 0;
    this.usageTotals = null;
    this.pendingDeliveries = new Map();
    this.attempts = new Map();
    this.artifacts = new Map();
    this.interventions = new Map();
    this.interventionLocks = new Map();
    this.updates = new HubUpdateRegistry(this);
    this.lifecycle = new ConversationLifecycleManager(this, { trashRetentionMs: this.config.lifecycle?.trashRetentionMs });
    this.processedInbound = new Set();
    this.store = services.store ?? new MemoryHubStore();
    this.authService = services.authService ?? null;
    this.artifactStore = services.artifactStore ?? null;
    this.webSocketModule = services.webSocketModule ?? null;
    this.WebSocket = null;
    this.persistenceReady = false;
    this.storageFault = null;
    this.dirty = createDirtyState();
    this.pendingEventWrites = [];
    this.commitChain = Promise.resolve();
    this.log = new EventLog({
      file: config.logs?.file,
      includePayloads: config.logs?.includePayloads !== false,
    });
    this.server = null;
    this.wss = null;
    this.retryTimer = null;
    this.leaseTimer = null;
    this.lifecycleTimer = null;
    this.stopping = false;
  }

  async restorePersistedState() {
    const state = await this.store.load();
    this.tasks = new Map((state.tasks ?? []).map((task) => [task.taskId, task]));
    const maximumMessages = Number(this.config.messages?.maxInMemory ?? 5000);
    this.messages = (state.messages ?? []).sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0)).slice(-maximumMessages);
    this.messageSeq = Math.max(
      Number(state.metadata?.messageSeq ?? 0),
      ...this.messages.map((message) => Number(message.seq ?? 0)),
      0,
    );
    this.usageTotals = state.metadata?.usageTotals ?? null;
    this.pendingDeliveries = new Map((state.deliveries ?? []).map((delivery) => {
      const restored = { ...delivery, sentAt: 0, attempts: 0 };
      return [deliveryKey(restored.agentId, restored.envelope.id), restored];
    }));
    this.attempts = new Map((state.attempts ?? []).map((attempt) => [attempt.attemptId, attempt]));
    this.artifacts = new Map((state.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact]));
    this.interventions = new Map((state.interventions ?? []).map((stored) => {
      const intervention = normalizeStoredIntervention(stored, this.tasks);
      return [intervention.interventionId, intervention];
    }));
    for (const root of [...this.tasks.values()].filter((task) => task.taskId === task.rootTaskId && task.humanIntervention)) {
      if ([...this.interventions.values()].some((item) => item.rootTaskId === root.taskId)) continue;
      const intervention = normalizeStoredIntervention({
        ...root.humanIntervention,
        interventionId: `${root.taskId}:legacy`,
        rootTaskId: root.taskId,
        taskId: root.taskId,
      }, this.tasks);
      this.interventions.set(intervention.interventionId, intervention);
    }
    this.processedInbound = new Set((state.inboundMessages ?? []).map((message) => message.messageId));
    this.log.restore(state.auditEvents ?? []);
    this.updates.restore(state.updateJobs ?? []);
    this.lifecycle.loadState(state.lifecycles ?? [], state.tombstones ?? []);

    this.agents = new Map((state.agents ?? []).map((agent) => {
      const restored = {
        ...agent,
        status: "offline",
        busy: false,
        currentTaskId: null,
        activeTaskCount: 0,
      };
      this.markAgent(restored);
      return [restored.agentId, restored];
    }));
    for (const root of [...this.tasks.values()].filter((task) => task.taskId === task.rootTaskId)) {
      root.humanIntervention = this.publicIntervention(this.currentIntervention(root.taskId), true);
    }
  }

  leasesEnabled() {
    return this.config.leases?.enabled === true;
  }

  leaseTtlMs() {
    return Math.max(1000, Number(this.config.leases?.ttlMs ?? 30_000));
  }

  leaseScanIntervalMs() {
    return Math.max(250, Number(this.config.leases?.scanIntervalMs ?? 5_000));
  }

  leaseMaxRecoveryAttempts() {
    return Math.max(0, Number(this.config.leases?.maxRecoveryAttempts ?? 3));
  }

  lifecycleSweepIntervalMs() {
    return Math.max(30_000, Number(this.config.lifecycle?.sweepIntervalMs ?? 60_000));
  }

  markTask(task, guard) {
    if (!task?.taskId) return;
    this.dirty.tasks.set(task.taskId, task);
    if (guard) this.dirty.taskGuards.set(task.taskId, guard);
  }

  markAgent(agent) {
    if (agent?.agentId) this.dirty.agents.set(agent.agentId, agent);
  }

  markUpdateJob(job) {
    if (job?.jobId) this.dirty.updateJobs.set(job.jobId, job);
  }

  markLifecycle(record) {
    if (record?.rootTaskId) this.dirty.lifecycles.set(record.rootTaskId, record);
  }

  markTombstone(stone) {
    if (stone?.rootTaskId) this.dirty.tombstones.set(stone.rootTaskId, stone);
  }

  markLifecycleRemoved(rootTaskId) {
    if (!rootTaskId) return;
    this.dirty.lifecycles.delete(rootTaskId);
    let set = this.dirty.removals.get("lifecycles");
    if (!set) {
      set = new Set();
      this.dirty.removals.set("lifecycles", set);
    }
    set.add(rootTaskId);
  }

  markPurgeRemovals({ taskIds = [], messageIds = [], attemptIds = [], interventionIds = [], artifactIds = [], deliveryKeys = [] }) {
    const add = (kind, ids) => {
      for (const id of ids) {
        let set = this.dirty.removals.get(kind);
        if (!set) {
          set = new Set();
          this.dirty.removals.set(kind, set);
        }
        set.add(id);
      }
    };
    add("tasks", taskIds);
    add("messages", messageIds);
    add("attempts", attemptIds);
    add("interventions", interventionIds);
    add("artifacts", artifactIds);
    add("deliveries", deliveryKeys);
  }

  markAttempt(attempt) {
    if (attempt?.attemptId) this.dirty.attempts.set(attempt.attemptId, attempt);
  }

  markArtifact(artifact) {
    if (artifact?.artifactId) this.dirty.artifacts.set(artifact.artifactId, artifact);
  }

  markIntervention(intervention, guard) {
    if (!intervention?.interventionId) return;
    this.dirty.interventions.set(intervention.interventionId, intervention);
    if (guard) this.dirty.interventionGuards.set(intervention.interventionId, guard);
  }

  markDelivery(delivery) {
    const key = deliveryKey(delivery.agentId, delivery.envelope.id);
    this.dirty.deletedDeliveries.delete(key);
    this.dirty.deliveries.set(key, delivery);
  }

  markDeliveryDeleted(agentId, messageId) {
    const key = deliveryKey(agentId, messageId);
    this.dirty.deliveries.delete(key);
    this.dirty.deletedDeliveries.set(key, { agentId, messageId });
  }

  markInbound(agentId, message) {
    const record = {
      messageId: message.id,
      agentId,
      type: message.type,
      taskId: message.taskId ?? null,
      receivedAt: new Date().toISOString(),
    };
    this.processedInbound.add(message.id);
    this.dirty.inboundMessages.set(message.id, record);
  }

  async recordEvent(type, details = {}) {
    const event = await this.log.record(type, details);
    this.dirty.auditEvents.set(event.seq, event);
    return event;
  }

  queueEvent(type, details = {}) {
    const pending = this.recordEvent(type, details);
    pending.catch(() => {});
    this.pendingEventWrites.push(pending);
  }

  async flushState() {
    if (!this.persistenceReady) return;
    if (this.storageFault) throw this.storageFault;
    const operation = this.commitChain.then(async () => {
      while (this.pendingEventWrites.length > 0) {
        const writes = this.pendingEventWrites.splice(0);
        await Promise.all(writes);
      }
      while (hasDirtyState(this.dirty)) {
        const changes = takeDirtyState(this);
        try {
          await this.store.commit(changes);
        } catch (error) {
          mergeDirtyState(this.dirty, changes);
          throw error;
        }
      }
    });
    this.commitChain = operation.catch(() => {});
    try {
      await operation;
    } catch (error) {
      this.storageFault = Object.assign(new Error(`Hub persistence failed: ${error.message}`), { cause: error });
      throw this.storageFault;
    }
  }

  async commitAndDispatch() {
    await this.flushState();
    this.flushNewDeliveries();
  }

  flushNewDeliveries() {
    for (const delivery of this.pendingDeliveries.values()) {
      if (!delivery.sentAt) this.sendDelivery(delivery);
    }
  }

  async handleBackgroundError(type, error) {
    console.error(`[hub] ${type}: ${error.message}`);
    if (this.storageFault) return;
    try {
      await this.recordEvent(type, { error: safeError(error) });
      await this.flushState();
    } catch {}
  }

  async start() {
    this.validateSecurity();
    const webSocketModule = this.webSocketModule ?? await import("ws");
    this.WebSocket = webSocketModule.WebSocket;
    await this.log.init();
    await this.store.init();
    await this.authService?.init?.();
    await this.artifactStore?.init?.();
    this.persistenceReady = true;
    await this.restorePersistedState();
    const requestHandler = this.handleHttp.bind(this);
    if (this.config.tls?.enabled) {
      const [key, cert] = await Promise.all([
        readFile(this.config.tls.keyFile),
        readFile(this.config.tls.certFile),
      ]);
      this.server = https.createServer({ key, cert }, requestHandler);
    } else {
      this.server = http.createServer(requestHandler);
    }

    this.wss = new webSocketModule.WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head).catch(() => {
        if (!socket.destroyed) {
          socket.write("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
          socket.destroy();
        }
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (typeof address === "object" && address) this.port = address.port;
    this.retryTimer = setInterval(() => this.retryDeliveries(), 1000);
    this.retryTimer.unref();
    if (this.leasesEnabled()) {
      this.leaseTimer = setInterval(() => {
        void this.reapExpiredLeases().catch((error) => this.handleBackgroundError("lease.reaper_error", error));
      }, this.leaseScanIntervalMs());
      this.leaseTimer.unref();
      await this.reapExpiredLeases();
    }
    this.lifecycleTimer = setInterval(() => {
      void this.lifecycle.purgeDue().catch((error) => this.handleBackgroundError("conversation.lifecycle_sweep_error", error));
    }, this.lifecycleSweepIntervalMs());
    this.lifecycleTimer.unref();
    await this.recordEvent("hub.started", { host: this.host, port: this.port, tls: Boolean(this.config.tls?.enabled) });
    await this.flushState();
    return this;
  }

  validateSecurity() {
    const remote = !isLoopbackHost(this.host);
    if (this.config.auth?.mode === "identity") {
      if (!this.authService) throw new Error("Identity auth mode requires an authService");
      if (this.config.auth?.tokenEnv) throw new Error("Identity auth mode cannot use a shared Hub token");
    } else if (this.config.auth?.required && !this.token) {
      throw new Error(`Required Hub token is missing from environment variable ${this.config.auth.tokenEnv}`);
    }
    if (remote && !this.authService && !this.token) throw new Error("Non-loopback Hub listeners require bearer-token authentication");
    if (remote && !this.config.tls?.enabled && !this.config.allowPlaintextRemote) {
      throw new Error("Non-loopback Hub listeners require TLS unless allowPlaintextRemote is explicitly enabled for a trusted tunnel");
    }
  }

  url() {
    return `${this.config.tls?.enabled ? "https" : "http"}://${this.host}:${this.port}`;
  }

  async stop() {
    this.stopping = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.lifecycleTimer) clearInterval(this.lifecycleTimer);
    for (const agent of this.agents.values()) {
      if (agent.status !== "offline") {
        agent.status = "offline";
        agent.busy = false;
        agent.currentTaskId = null;
        agent.disconnectedAt = new Date().toISOString();
        this.markAgent(agent);
      }
    }
    await this.recordEvent("hub.stopped");
    await this.flushState();
    for (const ws of this.connections.values()) ws.close(1001, "Hub stopping");
    await new Promise((resolve) => this.wss?.close(() => resolve()));
    await new Promise((resolve) => this.server?.close(() => resolve()));
    await this.store.close();
  }

  authorized(header) {
    if (!this.token) return true;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  async handleUpgrade(request, socket, head) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const actor = url.pathname === "/worker" ? await this.authenticateWorkerRequest(request) : null;
    if (!actor) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    request.a446Actor = actor;
    this.wss.handleUpgrade(request, socket, head, (ws) => this.acceptWorker(ws, request));
  }

  async authenticateWorkerRequest(request) {
    if (this.authService) return this.authService.authenticateWorker(request.headers.authorization);
    return this.authorized(request.headers.authorization)
      ? { kind: "worker", id: "legacy-worker", role: "worker", legacy: true }
      : null;
  }

  async authenticateHttpRequest(request) {
    if (this.authService) return this.authService.authenticateWeb(request);
    return this.authorized(request.headers.authorization)
      ? { kind: "web", id: "human", username: "human", role: "admin", legacy: true }
      : null;
  }

  acceptWorker(ws, request = {}) {
    const authenticatedActor = request.a446Actor;
    ws.a446Actor = authenticatedActor;
    let registeredAgentId;
    const helloDeadline = setTimeout(() => ws.close(1008, "worker.hello required"), 5000);
    ws.on("message", async (raw) => {
      try {
        if (this.storageFault) throw this.storageFault;
        const message = parseEnvelope(raw);
        if (!registeredAgentId) {
          if (message.type !== "worker.hello" || !message.agentId) throw new Error("First message must be worker.hello with agentId");
          if (authenticatedActor && !authenticatedActor.legacy) {
            if (message.agentId !== authenticatedActor.agentId) throw new Error("Credential is not valid for the claimed agentId");
            const claimedDeviceId = message.payload?.deviceId ?? message.agentId;
            if (claimedDeviceId !== authenticatedActor.deviceId) throw new Error("Credential is not valid for the claimed deviceId");
          }
          registeredAgentId = authenticatedActor?.agentId ?? message.agentId;
          clearTimeout(helloDeadline);
          const existing = this.connections.get(registeredAgentId);
          if (existing && existing !== ws) existing.close(4001, "Replaced by newer connection");
          this.connections.set(registeredAgentId, ws);
          const previous = this.agents.get(registeredAgentId);
          const now = new Date().toISOString();
          const agent = {
            ...previous,
            agentId: registeredAgentId,
            status: "online",
            paused: Boolean(message.payload?.paused),
            capabilities: message.payload?.capabilities ?? [],
            protocolFeatures: Array.isArray(message.payload?.protocolFeatures) ? message.payload.protocolFeatures.map(String) : [],
            adapter: message.payload?.adapter,
            sessionId: message.payload?.sessionId,
            observedCapabilities: message.payload?.observedCapabilities,
            resourceSnapshot: message.payload?.resourceSnapshot ?? null,
            executors: message.payload?.executors ?? [],
            deviceId: authenticatedActor?.deviceId ?? message.payload?.deviceId ?? registeredAgentId,
            account: message.payload?.account ?? null,
            roles: normalizeRoles(message.payload?.roles),
            models: bindModelQuotas(normalizeModels(message.payload?.models, { model: message.payload?.model }), message.payload?.quotaSnapshot),
            maxConcurrency: Number(message.payload?.maxConcurrency ?? 1),
            activeTaskCount: [...this.tasks.values()].filter((task) => task.activeSlotAgentId === registeredAgentId && ACTIVE_SLOT_STATUSES.has(task.status)).length,
            usageTotals: message.payload?.usageTotals ?? null,
            quotaSnapshot: normalizeQuotaSnapshot(message.payload?.quotaSnapshot),
            quotaProbeError: message.payload?.quotaProbeError ?? null,
            connectedAt: previous?.connectedAt ?? now,
            reconnectedAt: previous ? now : undefined,
            lastSeenAt: now,
          };
          this.agents.set(registeredAgentId, agent);
          this.markAgent(agent);
          await this.recordEvent("worker.online", agent);
          for (const task of this.tasks.values()) {
            if (task.status === "queued" && (!task.targetAgentId || task.targetAgentId === registeredAgentId)) {
              await this.queueOrDispatch(task);
            }
          }
          await this.flushState();
          ws.send(JSON.stringify(makeEnvelope("hub.welcome", {
            agentId: registeredAgentId,
            replyTo: message.id,
            payload: {
              heartbeatMs: this.config.heartbeatMs ?? 10000,
              protocolFeatures: [
                ...(this.leasesEnabled() ? [LEASE_PROTOCOL_FEATURE] : []),
                ...(this.artifactStore ? [ARTIFACT_PROTOCOL_FEATURE] : []),
              ],
              ...(this.leasesEnabled() ? {
                leaseTtlMs: this.leaseTtlMs(),
                lease: { feature: LEASE_PROTOCOL_FEATURE, ttlMs: this.leaseTtlMs() },
              } : {}),
            },
          })));
          this.flushAgentDeliveries(registeredAgentId, true);
          return;
        }
        if (message.agentId && message.agentId !== registeredAgentId) throw new Error("agentId cannot change on an active connection");
        await this.handleWorkerMessage(registeredAgentId, message);
      } catch (error) {
        try {
          await this.recordEvent("worker.protocol_error", { agentId: registeredAgentId, error: safeError(error) });
          await this.flushState();
        } catch {}
        ws.close(this.storageFault ? 1011 : 1008, this.storageFault ? "Hub persistence unavailable" : "Protocol error");
      }
    });
    ws.on("close", async () => {
      clearTimeout(helloDeadline);
      if (!registeredAgentId || this.connections.get(registeredAgentId) !== ws) return;
      this.connections.delete(registeredAgentId);
      if (this.stopping) return;
      const agent = this.agents.get(registeredAgentId);
      if (agent) {
        agent.status = "offline";
        agent.busy = false;
        agent.currentTaskId = null;
        agent.disconnectedAt = new Date().toISOString();
        this.markAgent(agent);
      }
      for (const delivery of this.pendingDeliveries.values()) {
        if (delivery.agentId === registeredAgentId) {
          delivery.sentAt = 0;
          delivery.attempts = 0;
        }
      }
      try {
        await this.recordEvent("worker.offline", { agentId: registeredAgentId });
        await this.flushState();
      } catch (error) {
        await this.handleBackgroundError("worker.offline_persist_error", error);
      }
    });
  }

  async handleWorkerMessage(agentId, message) {
    const reliable = RELIABLE_WORKER_MESSAGES.has(message.type);
    if (reliable && this.processedInbound.has(message.id)) {
      this.sendAck(agentId, message.id);
      return;
    }
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastSeenAt = new Date().toISOString();
      if (message.payload?.executor) agent.executors = [message.payload.executor];
    }
    if (message.type === "worker.heartbeat") {
      if (agent) {
        agent.sessionId = message.payload?.sessionId ?? agent.sessionId;
        agent.busy = Boolean(message.payload?.busy);
        agent.paused = Boolean(message.payload?.paused);
        agent.observedCapabilities = message.payload?.observedCapabilities ?? agent.observedCapabilities;
        agent.resourceSnapshot = message.payload?.resourceSnapshot ?? agent.resourceSnapshot;
        agent.capabilities = Array.isArray(message.payload?.capabilities) ? message.payload.capabilities.map(String) : agent.capabilities;
        agent.quotaSnapshot = normalizeQuotaSnapshot(message.payload?.quotaSnapshot) ?? agent.quotaSnapshot;
        agent.models = bindModelQuotas(Array.isArray(message.payload?.models) ? normalizeModels(message.payload.models) : agent.models, agent.quotaSnapshot);
        agent.executors = message.payload?.executors ?? agent.executors;
        agent.currentTaskId = message.payload?.currentTaskId ?? null;
        agent.usageTotals = message.payload?.usageTotals ?? agent.usageTotals;
        agent.quotaProbeError = message.payload?.quotaProbeError ?? agent.quotaProbeError;
        agent.account = message.payload?.account ?? agent.account;
        this.markAgent(agent);
      }
      this.renewLeaseFromHeartbeat(agentId, message);
      await this.flushState();
      return;
    }
    if (message.type === "ack") {
      const key = deliveryKey(agentId, message.replyTo);
      if (this.pendingDeliveries.delete(key)) this.markDeliveryDeleted(agentId, message.replyTo);
      await this.flushState();
      return;
    }
    if (message.type === "device.update.status") {
      await this.updates.ingestStatus(agentId, message);
      this.markInbound(agentId, message);
      await this.commitAndDispatch();
      this.sendAck(agentId, message.id);
      return;
    }
    const task = message.taskId ? this.tasks.get(message.taskId) : undefined;
    if (reliable && task && this.isStaleAttemptMessage(task, agentId, message)) {
      await this.recordLateAttemptMessage(task, agentId, message);
      this.markInbound(agentId, message);
      await this.flushState();
      this.sendAck(agentId, message.id);
      return;
    }
    if (reliable && task && (TERMINAL_TASK_STATUSES.has(task.status) || task.targetAgentId && task.targetAgentId !== agentId)) {
      await this.recordLateAttemptMessage(task, agentId, message);
      this.markInbound(agentId, message);
      await this.flushState();
      this.sendAck(agentId, message.id);
      return;
    }
    if (message.type === "task.started" && task) {
      task.status = "running";
      task.startedAt = new Date().toISOString();
      task.checkpoint = message.payload?.checkpoint;
      const attempt = this.currentAttempt(task);
      if (attempt) {
        attempt.status = "running";
        attempt.startedAt = task.startedAt;
        attempt.lastHeartbeatAt = task.startedAt;
        attempt.leaseExpiresAt = new Date(Date.now() + this.leaseTtlMs()).toISOString();
        this.markAttempt(attempt);
      }
      this.addMessage(task, {
        senderId: agentId,
        senderRole: task.role,
        kind: "status",
        text: `开始执行：${task.taskSpec?.title ?? task.input.slice(0, 80)}`,
      });
      this.markTask(task, this.taskAttemptGuard(message));
      await this.recordEvent("task.started", { taskId: task.taskId, agentId, attemptId: attempt?.attemptId, checkpoint: task.checkpoint });
    } else if (message.type === "approval.request" && task) {
      task.status = "awaiting_approval";
      task.approval = message.payload;
      const attempt = this.currentAttempt(task);
      if (attempt) {
        attempt.status = "awaiting_approval";
        attempt.completedAt = new Date().toISOString();
        this.markAttempt(attempt);
      }
      this.finishTaskActivity(task);
      this.markTask(task, this.taskAttemptGuard(message));
      this.createIntervention(task, {
        kind: "worker_approval",
        question: message.payload?.question ?? message.payload?.reason ?? "Worker 请求人工批准后继续任务。",
        requestedBy: agentId,
        requesterRole: task.role ?? "executor",
        allowedActions: ["approve", "reject"],
        continuation: { type: "retry_task", taskId: task.taskId },
      });
      await this.recordEvent("approval.requested", { taskId: task.taskId, agentId, attemptId: attempt?.attemptId, approval: message.payload });
    } else if (message.type === "task.rejected" && task) {
      task.status = "rejected";
      task.completedAt = new Date().toISOString();
      task.error = { name: "PolicyDeniedError", code: message.payload?.code, reasons: message.payload?.reasons ?? [] };
      task.checkpoint = message.payload?.checkpoint;
      this.completeAttempt(task, "rejected", message);
      this.finishTaskActivity(task);
      this.markTask(task, this.taskAttemptGuard(message));
      await this.recordEvent("task.rejected", { taskId: task.taskId, agentId, attemptId: message.payload?.attemptId, payload: message.payload });
      if (task.workflow?.enabled && !task.forceCompleted && !this.getCanonicalRootTask(task.rootTaskId)?.forceCompleted) {
        const reason = task.error?.reasons?.join("; ") || task.error?.code || "PolicyDenied";
        this.requireHuman(task, `子任务 '${task.taskSpec?.title ?? task.taskId}' 被节点安全策略拒绝 (${reason})。工作流已暂停，请人工介入审查。`);
      }
      await this.retryQueuedTasks();
    } else if ((message.type === "task.result" || message.type === "task.error") && task) {
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        await this.recordLateAttemptMessage(task, agentId, message);
      } else {
      const artifactError = this.validateTaskArtifacts(task, message);
      let formatValidation = null;
      if (message.type === "task.result" && !artifactError && task.workflow?.enabled && task.role && ROLE_SET.has(task.role)) {
        formatValidation = parseRoleSubmission(task.role, message.payload?.output, task.stage);
      }
      const formatError = formatValidation && !formatValidation.ok ? formatValidation.error : null;
      if (formatError) {
        task.formatRetryCount = Number(task.formatRetryCount ?? 0);
        if (task.formatRetryCount === 0) {
          const reservation = this.reserveWorkflowInvocations(task.rootTaskId, 1);
          if (!reservation.ok) {
            task.status = "failed";
            task.completedAt = new Date().toISOString();
            task.error = { name: "CircuitBreakerError", message: "工作流累计 Agent 调用已达上限（50次），格式修正重试被熔断" };
            task.diagnosis = {
              formatError,
              rawOutput: formatValidation.raw,
              failedAt: new Date().toISOString(),
              retried: false,
              circuitBroken: true,
            };
            this.completeAttempt(task, "failed", message);
            this.finishTaskActivity(task);
            this.markTask(task);
            await this.recordEvent("workflow.format_failed", { taskId: task.taskId, agentId, attemptId: message.payload?.attemptId, error: "Circuit breaker limit reached (50 invocations)" });
            this.requireHuman(task, "工作流累计 Agent 调用已达上限（50次），格式修正重试被熔断。请人工介入审查。");
            await this.retryQueuedTasks();
            if (reliable) this.markInbound(agentId, message);
            await this.commitAndDispatch();
            if (reliable) this.sendAck(agentId, message.id);
            return;
          }
          task.quotaReserved = true;
          task.formatRetryCount = 1;
          task.status = "queued";
          task.diagnosis = {
            formatError,
            rawOutput: formatValidation.raw,
            failedAt: new Date().toISOString(),
          };
          task.originalInput = task.originalInput ?? task.input;
          task.input = `${task.originalInput}\n\n【格式错误需修正】上一次回复未通过服务端格式校验：${formatError}。请严格按照角色与阶段的 JSON 契约重新输出，切勿输出多余解释或损坏字符。`;
          task.contextBundle = {
            ...(task.contextBundle ?? {}),
            formatErrorFeedback: formatError,
          };
          this.completeAttempt(task, "failed", message);
          this.finishTaskActivity(task);
          this.markTask(task);
          await this.recordEvent("workflow.format_retry", { taskId: task.taskId, agentId, attemptId: message.payload?.attemptId, error: formatError });
          await this.queueOrDispatch(task);
          await this.retryQueuedTasks();
          if (reliable) this.markInbound(agentId, message);
          await this.commitAndDispatch();
          if (reliable) this.sendAck(agentId, message.id);
          return;
        } else {
          task.status = "failed";
          task.completedAt = new Date().toISOString();
          task.error = { name: "FormatValidationError", message: `两次输出均无法通过格式校验: ${formatError}` };
          task.diagnosis = {
            formatError,
            rawOutput: formatValidation.raw,
            failedAt: new Date().toISOString(),
            retried: true,
          };
          this.completeAttempt(task, "failed", message);
          this.finishTaskActivity(task);
          this.markTask(task);
          await this.recordEvent("workflow.format_failed", { taskId: task.taskId, agentId, attemptId: message.payload?.attemptId, error: formatError });
          this.requireHuman(task, `任务格式校验失败（已自动重试 1 次仍失败）：${formatError}。请检查诊断详情并处理。`);
          await this.retryQueuedTasks();
          if (reliable) this.markInbound(agentId, message);
          await this.commitAndDispatch();
          if (reliable) this.sendAck(agentId, message.id);
          return;
        }
      }

      const acceptedResult = message.type === "task.result" && !artifactError;
      const terminalStatus = acceptedResult ? "completed" : (message.payload?.cancelled ? "cancelled" : "failed");
      task.status = "processing_result";
      task.completedAt = new Date().toISOString();
      task.output = message.payload?.output;
      task.error = artifactError ?? message.payload?.error;
      task.sessionId = message.payload?.sessionId;
      task.artifacts = message.payload?.artifacts;
      task.checkpoint = message.payload?.checkpoint;
      task.model = message.payload?.model ?? task.execution?.model ?? null;
      task.usage = message.payload?.usage ?? null;
      task.quotaSnapshot = normalizeQuotaSnapshot(message.payload?.quotaSnapshot);
      task.submission = formatValidation?.ok ? formatValidation.value : (message.payload?.submission ?? parseRoleSubmission(task.role, task.output, task.stage).value ?? message.payload?.submission);
      this.markTask(task, this.taskAttemptGuard(message));
      if (task.usage) {
        this.usageTotals = addUsage(this.usageTotals, task.usage);
        this.dirty.metadata = true;
      }
      const agentRecord = this.agents.get(agentId);
      if (agentRecord && message.payload?.usageTotals) agentRecord.usageTotals = message.payload.usageTotals;
      if (agentRecord && task.quotaSnapshot) agentRecord.quotaSnapshot = task.quotaSnapshot;
      if (agentRecord) this.markAgent(agentRecord);
      this.completeAttempt(task, terminalStatus, message);
      await this.recordEvent(message.type, { taskId: task.taskId, agentId, attemptId: message.payload?.attemptId, payload: message.payload });
      if (artifactError) {
        await this.recordEvent("artifact.result_rejected", { taskId: task.taskId, agentId, attemptId: message.payload?.attemptId, error: artifactError });
      }
      if (acceptedResult) {
        this.recordResultMessage(task);
      }
      try {
        if (acceptedResult && task.workflow?.enabled) {
          await this.advanceWorkflow(task);
        } else if (acceptedResult && task.route.length > 0) {
          const [nextAgentId, ...rest] = task.route;
          const child = this.createTask({
            targetAgentId: nextAgentId,
            input: message.payload?.output ?? "",
            route: rest,
            rootTaskId: task.rootTaskId,
            parentTaskId: task.taskId,
            sourceAgentId: agentId,
            metadata: task.metadata,
          });
          await this.queueOrDispatch(child);
        }
      } catch (error) {
        task.status = "failed";
        task.error = { name: "WorkflowAdvanceError", message: String(error?.message ?? error) };
        this.finishTaskActivity(task);
        this.markTask(task);
        await this.recordEvent("workflow.advance_error", { taskId: task.taskId, error: safeError(error) });
        await this.retryQueuedTasks();
      }
      if (task.status === "processing_result") {
        task.status = terminalStatus;
        this.finishTaskActivity(task);
        this.markTask(task);
        await this.retryQueuedTasks();
      }
      if (task.workflow?.enabled) {
        if (["failed", "cancelled", "rejected"].includes(terminalStatus) && !task.forceCompleted && !this.getCanonicalRootTask(task.rootTaskId)?.forceCompleted) {
          const reason = task.error?.message ?? task.error?.name ?? terminalStatus;
          this.requireHuman(task, `子任务 '${task.taskSpec?.title ?? task.taskId}' 执行失败 (${reason})。工作流已暂停，请人工介入审查。`);
        }
        this.checkAndFinalizeWorkflow(task.rootTaskId);
      }
      }
    } else if (reliable && !task) {
      await this.recordEvent("worker.unknown_task_message", { agentId, messageId: message.id, taskId: message.taskId, type: message.type });
    }

    if (reliable) this.markInbound(agentId, message);
    await this.commitAndDispatch();
    if (reliable) this.sendAck(agentId, message.id);
  }

  currentAttempt(task) {
    return task?.currentAttemptId ? this.attempts.get(task.currentAttemptId) : undefined;
  }

  taskAttemptGuard(message) {
    if (!this.leasesEnabled()) return undefined;
    return {
      currentAttemptId: message.payload?.attemptId,
      allowedStatuses: ["dispatched", "running", "processing_result"],
    };
  }

  isStaleAttemptMessage(task, agentId, message) {
    if (!this.leasesEnabled()) return false;
    const attemptId = message.payload?.attemptId;
    const attempt = attemptId ? this.attempts.get(attemptId) : undefined;
    return !attemptId
      || attemptId !== task.currentAttemptId
      || !attempt
      || attempt.workerId !== agentId
      || !ACTIVE_ATTEMPT_STATUSES.has(attempt.status);
  }

  async recordLateAttemptMessage(task, agentId, message) {
    const attemptId = message.payload?.attemptId;
    const attempt = attemptId ? this.attempts.get(attemptId) : undefined;
    if (attempt) {
      attempt.lateResultCount = Number(attempt.lateResultCount ?? 0) + 1;
      attempt.lastLateResult = {
        messageId: message.id,
        type: message.type,
        receivedAt: new Date().toISOString(),
        hasOutput: typeof message.payload?.output === "string",
        error: message.payload?.error ? safeError(message.payload.error) : null,
      };
      this.markAttempt(attempt);
    }
    await this.recordEvent("task.late_attempt_message", {
      taskId: task.taskId,
      currentAttemptId: task.currentAttemptId ?? null,
      receivedAttemptId: attemptId ?? null,
      agentId,
      messageId: message.id,
      type: message.type,
    });
  }

  completeAttempt(task, status, message) {
    const attempt = this.currentAttempt(task);
    if (!attempt) return;
    attempt.status = status;
    attempt.completedAt = new Date().toISOString();
    attempt.resultMessageId = message.id;
    this.markAttempt(attempt);
  }

  renewLeaseFromHeartbeat(agentId, message) {
    if (!this.leasesEnabled()) return;
    const taskId = message.payload?.currentTaskId;
    const attemptId = message.payload?.currentAttemptId;
    if (!taskId || !attemptId) return;
    const task = this.tasks.get(taskId);
    const attempt = this.attempts.get(attemptId);
    if (!task || task.currentAttemptId !== attemptId || !attempt || attempt.workerId !== agentId || !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) return;
    const now = new Date().toISOString();
    attempt.lastHeartbeatAt = now;
    attempt.leaseExpiresAt = new Date(Date.now() + this.leaseTtlMs()).toISOString();
    this.markAttempt(attempt);
  }

  sendAck(agentId, replyTo) {
    const ws = this.connections.get(agentId);
    const openState = this.WebSocket?.OPEN ?? 1;
    if (ws?.readyState === openState) ws.send(JSON.stringify(makeEnvelope("ack", { agentId, replyTo })));
  }

  createTask(input) {
    const taskId = randomUUID();
    const role = input.role === "system" ? "system" : (normalizeRoles(input.role)[0] ?? null);
    const rootTaskId = input.rootTaskId ?? taskId;
    const task = {
      taskId,
      rootTaskId,
      parentTaskId: input.parentTaskId,
      batchId: input.batchId ?? null,
      planningTaskId: input.planningTaskId ?? null,
      targetAgentId: input.targetAgentId ?? null,
      requestedAgentId: input.requestedAgentId ?? input.targetAgentId ?? null,
      sourceAgentId: input.sourceAgentId ?? "human",
      input: String(input.input ?? ""),
      route: Array.isArray(input.route) ? input.route : [],
      metadata: input.metadata ?? {},
      taskSpec: input.taskSpec ?? input.metadata?.taskSpec ?? null,
      role,
      stage: input.stage ?? (role ? role : "execution"),
      workflow: input.workflow ?? null,
      sessionScopeId: input.sessionScopeId ?? (input.workflow?.enabled ? (role === "planner" ? rootTaskId : taskId) : "legacy"),
      contextBundle: input.contextBundle ?? {},
      requiredCapabilities: Array.isArray(input.requiredCapabilities) ? input.requiredCapabilities.map(String) : [],
      modelPreference: input.modelPreference ?? input.model ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      workUnitId: input.workUnitId ?? null,
      revision: Number(input.revision ?? 1),
      superseded: Boolean(input.superseded),
      supersededBy: input.supersededBy ?? null,
      reviewCycle: Number(input.reviewCycle ?? 0),
      attemptNumber: Number(input.attemptNumber ?? 0),
      currentAttemptId: input.currentAttemptId ?? null,
      recoveryCount: Number(input.recoveryCount ?? 0),
      requiresApproval: Boolean(input.requiresApproval),
      quotaReserved: Boolean(input.quotaReserved),
      forceCompleted: input.forceCompleted ?? null,
      status: input.requiresApproval ? "awaiting_approval" : "queued",
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, task);
    this.markTask(task);
    const sourceRole = task.sourceAgentId === "human" || task.sourceAgentId.startsWith("user:")
      ? "human"
      : input.sourceRole ?? this.tasks.get(task.parentTaskId)?.role ?? "agent";
    this.addMessage(task, {
      senderId: task.sourceAgentId,
      senderRole: sourceRole,
      kind: "task_instruction",
      text: task.input,
      mentions: task.targetAgentId ? [task.targetAgentId] : task.role ? [`@${task.role}`] : [],
    });
    this.queueEvent("task.created", task);
    if (task.requiresApproval) {
      this.createIntervention(task, {
        kind: "task_approval",
        question: `任务等待人工批准：${task.taskSpec?.title ?? task.input.slice(0, 160)}`,
        requestedBy: "system",
        requesterRole: task.role ?? "system",
        allowedActions: ["approve", "reject"],
        continuation: { type: "retry_task", taskId: task.taskId },
      });
    }
    return task;
  }

  validateAgentStageModel(agent, roleLabel, role, { modelPreference, reasoningEffort }, customPrefix = "") {
    const prefix = customPrefix ? `${customPrefix} ` : "";
    if (modelPreference) {
      const model = agent.models?.find((m) => (typeof m === "string" ? m : m.id) === modelPreference);
      if (!model) {
        throw httpError(400, `${roleLabel} '${agent.agentId}' does not support selected ${prefix}model '${modelPreference}'`, "INCOMPATIBLE_MODEL");
      }
      if (reasoningEffort && typeof model === "object" && model.reasoningEfforts?.length && !model.reasoningEfforts.includes(reasoningEffort)) {
        throw httpError(400, `${roleLabel} '${agent.agentId}' ${prefix}model '${model.id}' does not support reasoning effort '${reasoningEffort}'`, "INCOMPATIBLE_REASONING_EFFORT");
      }
      return;
    }
    if (reasoningEffort) {
      const chosen = chooseModel(agent, { role, reasoningEffort }, false);
      if (chosen?.id) return;
      const anyCompatible = (agent.models ?? []).some((m) => {
        if (typeof m === "string") return true;
        if (m.enabled === false) return false;
        return !m.reasoningEfforts?.length || m.reasoningEfforts.includes(reasoningEffort);
      });
      if (!anyCompatible) {
        throw httpError(400, `${roleLabel} '${agent.agentId}' has no available ${prefix}model supporting reasoning effort '${reasoningEffort}'`, "INCOMPATIBLE_REASONING_EFFORT");
      }
    }
  }

  async createWorkflow(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.objective !== "string" || !input.objective.trim()) {
      throw httpError(400, "workflow objective is required", "VALIDATION_ERROR");
    }
    if (input.executorAgentId != null && (typeof input.executorAgentId !== "string" || !input.executorAgentId.trim() || input.executorAgentId !== input.executorAgentId.trim())) {
      throw httpError(400, "executorAgentId must be a non-empty Agent ID or null", "VALIDATION_ERROR");
    }
    const executorAgentId = input.executorAgentId ?? null;
    if (executorAgentId) {
      const executor = this.agents.get(executorAgentId);
      const reason = !executor ? "unknown" : executor.status !== "online" ? "offline" : executor.paused ? "paused" : !executor.roles?.includes("executor") ? "role_mismatch" : null;
      if (reason) throw httpError(409, `Executor ${executorAgentId} is unavailable`, "EXECUTOR_UNAVAILABLE", { reason, agentId: executorAgentId });
    }
    const normalizedStages = normalizeStageModels(input.stageModels, {
      plannerModelPreference: input.plannerModelPreference ?? input.modelPreference,
      plannerReasoningEffort: input.plannerReasoningEffort ?? input.reasoningEffort,
      reviewerModelPreference: input.reviewerModelPreference,
      reviewerReasoningEffort: input.reviewerReasoningEffort,
      intakeModelPreference: input.intakeModelPreference,
      intakeReasoningEffort: input.intakeReasoningEffort,
    });

    if (input.plannerAgentId) {
      const plannerAgent = this.agents.get(input.plannerAgentId);
      if (plannerAgent) {
        this.validateAgentStageModel(plannerAgent, "Planner agent", "planner", normalizedStages.planner);
        this.validateAgentStageModel(plannerAgent, "Planner agent", "planner", normalizedStages.intake, "intake");
      }
    }
    if (input.reviewerAgentId) {
      const reviewerAgent = this.agents.get(input.reviewerAgentId);
      if (reviewerAgent) {
        this.validateAgentStageModel(reviewerAgent, "Reviewer agent", "reviewer", normalizedStages.reviewer);
      }
    }

    const workflow = {
      enabled: true,
      plannerAgentId: input.plannerAgentId ?? null,
      executorAgentId,
      reviewerAgentId: input.reviewerAgentId ?? null,
      maxReviewCycles: Math.max(0, Number(input.maxReviewCycles ?? 2)),
      plannerModelPreference: normalizedStages.planner.modelPreference,
      plannerReasoningEffort: normalizedStages.planner.reasoningEffort,
      reviewerModelPreference: normalizedStages.reviewer.modelPreference,
      reviewerReasoningEffort: normalizedStages.reviewer.reasoningEffort,
      intakeModelPreference: normalizedStages.intake.modelPreference,
      intakeReasoningEffort: normalizedStages.intake.reasoningEffort,
      stageModels: normalizedStages,
      fastPath: Boolean(input.fastPath),
    };

    const initialArtifacts = [];
    const initialReferences = [];
    const initialInputs = [];
    for (const item of input.attachments ?? []) {
      const artifactId = typeof item === "string" ? item : item?.artifactId;
      if (!artifactId) continue;
      const artifact = this.artifacts.get(artifactId);
      if (!artifact || artifact.status !== "ready") continue;
      initialArtifacts.push(artifact);
      initialReferences.push(toArtifactReference(artifact));
      initialInputs.push({ path: artifact.path });
    }

    const task = this.createTask({
      targetAgentId: workflow.plannerAgentId,
      sourceAgentId: input.sourceAgentId ?? "human",
      input: input.objective.trim(),
      role: "planner",
      stage: "planning",
      workflow,
      requiredCapabilities: input.requiredCapabilities,
      modelPreference: workflow.plannerModelPreference,
      reasoningEffort: workflow.plannerReasoningEffort,
      requiresApproval: Boolean(input.requiresApproval),
      taskSpec: {
        title: String(input.title ?? input.objective).trim().slice(0, 200),
        type: "collaboration_workflow",
        priority: input.priority ?? "P1",
        inputs: initialInputs,
        expected_outputs: [],
        permissions_required: input.permissionsRequired ?? { project_workspace: true },
        checkpoint_policy: { mode: "stage" },
        acceptance: Array.isArray(input.acceptance) ? input.acceptance.map(String) : [],
      },
      contextBundle: {
        objective: input.objective.trim(),
        acceptance: Array.isArray(input.acceptance) ? input.acceptance.map(String) : [],
        schedulerCatalog: this.schedulerCatalog(),
        artifactReferences: initialReferences,
      },
    });

    for (const artifact of initialArtifacts) {
      artifact.taskId = task.taskId;
      artifact.rootTaskId = task.rootTaskId;
      this.markArtifact(artifact);
    }

    if (initialArtifacts.length > 0) {
      task.artifacts = {
        files: initialArtifacts.map((item) => this.publicArtifact(item)),
      };
      this.addMessage(task, {
        senderId: input.sourceAgentId ?? "human",
        senderRole: "human",
        kind: "task_brief",
        text: `创建了协作任务，并附带 ${initialArtifacts.length} 个附件。`,
        attachments: [{
          type: "artifacts",
          label: "初始任务附件",
          taskId: task.taskId,
          artifacts: {
            files: initialArtifacts.map((item) => this.publicArtifact(item)),
          },
        }],
      });
    }

    await this.queueOrDispatch(task);
    return task;
  }

  addMessage(task, input) {
    const message = {
      messageId: randomUUID(),
      seq: ++this.messageSeq,
      rootTaskId: task.rootTaskId,
      taskId: task.taskId,
      parentTaskId: task.parentTaskId ?? null,
      senderId: input.senderId ?? "system",
      senderRole: input.senderRole ?? "system",
      kind: input.kind ?? "message",
      text: String(input.text ?? ""),
      mentions: Array.isArray(input.mentions) ? input.mentions : [],
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    if (this.messages.length > Number(this.config.messages?.maxInMemory ?? 5000)) this.messages.shift();
    this.dirty.messages.set(message.messageId, message);
    this.dirty.metadata = true;
    return message;
  }

  recordResultMessage(task) {
    const submission = task.submission ?? {};
    const attachments = [];
    if (task.role === "executor") {
      attachments.push({
        type: "full_result",
        label: "完整成果",
        taskId: task.taskId,
        version: `v${task.reviewCycle + 1}`,
        content: submission.fullResult ?? task.output ?? "",
        artifacts: task.artifacts ?? null,
      });
    } else if (task.artifacts?.files?.length) {
      attachments.push({ type: "artifacts", label: "成果附件", taskId: task.taskId, artifacts: task.artifacts });
    }
    this.addMessage(task, {
      senderId: task.targetAgentId,
      senderRole: task.role ?? "executor",
      kind: task.role === "reviewer" ? "review_decision" : "task_brief",
      text: submission.brief ?? task.output ?? "任务已完成",
      mentions: task.role === "reviewer" && task.parentTaskId ? [this.tasks.get(task.parentTaskId)?.targetAgentId].filter(Boolean) : [],
      attachments,
    });
  }

  getCanonicalRootTask(taskIdOrTask) {
    if (!taskIdOrTask) return null;
    let current = typeof taskIdOrTask === "string" ? this.tasks.get(taskIdOrTask) : taskIdOrTask;
    if (!current) return null;
    const visited = new Set();
    while (current && current.rootTaskId && current.rootTaskId !== current.taskId && !visited.has(current.taskId)) {
      visited.add(current.taskId);
      const parent = this.tasks.get(current.rootTaskId);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  reserveWorkflowInvocations(rootTaskId, count = 1) {
    const root = this.getCanonicalRootTask(rootTaskId);
    if (!root) return { ok: true, current: 0, requested: count };
    if (!root.workflow?.enabled) return { ok: true, current: 0, requested: count };

    root.workflow = { ...(root.workflow ?? {}) };
    const canonicalRootTaskId = root.taskId;
    const childTasks = [...this.tasks.values()].filter((t) => (t.rootTaskId === canonicalRootTaskId || this.getCanonicalRootTask(t)?.taskId === canonicalRootTaskId) && t.taskId !== canonicalRootTaskId);
    const current = Math.max(childTasks.length, Number(root.workflow.totalInvocations ?? 0));
    if (current + count > 50) {
      return {
        ok: false,
        error: `工作流累计任务调用已达上限（50次）：当前已执行/预留 ${current} 次，拟增加 ${count} 次，超过硬上限 50 次。`,
        current,
        requested: count,
      };
    }
    root.workflow.totalInvocations = current + count;
    this.markTask(root);
    return { ok: true, current: root.workflow.totalInvocations, requested: count };
  }

  refundWorkflowInvocation(rootTaskId, count = 1) {
    const root = this.getCanonicalRootTask(rootTaskId);
    if (!root?.workflow?.enabled) return;
    const current = Number(root.workflow.totalInvocations ?? 0);
    root.workflow = { ...(root.workflow ?? {}) };
    root.workflow.totalInvocations = Math.max(0, current - count);
    this.markTask(root);
  }

  async advanceWorkflow(task) {
    const submission = task.submission ?? {};
    const root = this.tasks.get(task.rootTaskId) ?? task;

    if (task.role === "planner") {
      if (task.stage === "result_intake") {
        const decision = submission.decision;
        if (decision === "needs_human") {
          this.requireHuman(task, submission.humanQuestion || submission.brief || "规划 Agent 在接收成果后请求人工介入");
          return;
        }
        if (decision === "continue") {
          const assignments = submission.assignments ?? [];
          if (assignments.length === 0) {
            this.requireHuman(task, "规划 Agent 决定继续任务，但未提供任何子任务分配。请人工确认。");
            return;
          }
          await this.dispatchAssignments(task, assignments);
          return;
        }
        if (decision === "complete") {
          task.workflowDecision = "complete";
          this.markTask(task);
          this.checkAndFinalizeWorkflow(root.taskId);
          return;
        }
        this.requireHuman(task, `规划 Agent 返回未知的结案决策: ${decision}`);
        return;
      }

      // stage === "planning" or "replan"
      if (submission.needsHuman) {
        this.requireHuman(task, submission.humanQuestion || submission.brief || "规划 Agent 请求人工介入");
        return;
      }
      const assignments = submission.assignments ?? [];
      if (assignments.length === 0) {
        this.requireHuman(task, "规划 Agent 未生成任何有效子任务，需要人工确认或补充规划。");
        return;
      }
      await this.dispatchAssignments(task, assignments);
      return;
    }

    if (task.role === "executor") {
      const reviewKind = submission.upstreamIssue ? "upstream_review" : "result_review";

      // Prohibit self-review: reviewer MUST NOT be the executor
      let reviewerAgentId = task.workflow?.reviewerAgentId;
      if (reviewerAgentId === task.targetAgentId) {
        reviewerAgentId = null;
      }

      const root = this.getCanonicalRootTask(task.rootTaskId);
      const rawReviewerModel = task.workflow?.reviewerModelPreference
        ?? root?.workflow?.reviewerModelPreference
        ?? task.workflow?.stageModels?.reviewer?.modelPreference
        ?? root?.workflow?.stageModels?.reviewer?.modelPreference
        ?? null;
      const reviewerModel = typeof rawReviewerModel === "string" ? rawReviewerModel.trim() || null : null;
      const rawReviewerReasoning = task.workflow?.reviewerReasoningEffort
        ?? root?.workflow?.reviewerReasoningEffort
        ?? task.workflow?.stageModels?.reviewer?.reasoningEffort
        ?? root?.workflow?.stageModels?.reviewer?.reasoningEffort
        ?? null;
      const reviewerReasoning = typeof rawReviewerReasoning === "string" ? rawReviewerReasoning.trim() || null : null;

      if (!reviewerAgentId) {
        // Exclude executor and ensure formal scheduler constraints
        const candidateAgents = new Map(
          [...this.agents.entries()].filter(([id, a]) => (
            id !== task.targetAgentId &&
            (!this.leasesEnabled() || a.protocolFeatures?.includes(LEASE_PROTOCOL_FEATURE))
          ))
        );
        this.refreshAccountLoads();
        try {
          const selection = chooseAgent(candidateAgents, {
            role: "reviewer",
            modelPreference: reviewerModel,
            reasoningEffort: reviewerReasoning,
            requireDeclaredRole: false,
          });
          reviewerAgentId = selection.agent.agentId;
        } catch {
          reviewerAgentId = null;
        }
      }

      if (!reviewerAgentId) {
        task.reviewStatus = "waiting_for_human_review";
        this.markTask(task);
        this.createIntervention(task, {
          kind: "workflow_input",
          question: reviewerModel
            ? `当前没有可运行指定审核模型 '${reviewerModel}' 的独立 Reviewer 节点（严禁由 Executor 自行审核）。成果已提交，请人工进行审核确认。`
            : "当前没有可立即调度的独立 Reviewer 节点（严禁由 Executor 自行审核）。成果已提交，请人工进行审核确认。",
          allowedActions: ["approve", "reject"],
          continuation: { type: "human_review", taskId: task.taskId },
        });
        return;
      }

      const reservation = this.reserveWorkflowInvocations(task.rootTaskId, 1);
      if (!reservation.ok) {
        this.requireHuman(task, `工作流累计任务调用已达上限（50次），无法调度 Reviewer：${reservation.error}`);
        return;
      }

      const reviewer = this.createTask({
        targetAgentId: reviewerAgentId,
        input: reviewKind === "upstream_review" ? "审核执行 Agent 提交的上游错误报告。" : "审核执行 Agent 提交的完整成果。",
        rootTaskId: task.rootTaskId,
        parentTaskId: task.taskId,
        sourceAgentId: task.targetAgentId,
        role: "reviewer",
        stage: reviewKind,
        quotaReserved: true,
        workflow: task.workflow,
        modelPreference: reviewerModel,
        reasoningEffort: reviewerReasoning,
        reviewCycle: task.reviewCycle,
        taskSpec: {
          title: reviewKind === "upstream_review" ? "上游错误裁定" : `审核：${task.taskSpec?.title ?? "执行成果"}`,
          type: reviewKind,
          priority: task.taskSpec?.priority ?? "P1",
          inputs: [],
          expected_outputs: [],
          permissions_required: { project_workspace: true },
          checkpoint_policy: { mode: "stage" },
          acceptance: task.taskSpec?.acceptance ?? [],
        },
        contextBundle: reviewKind === "upstream_review" ? {
          objective: task.contextBundle?.objective ?? task.input,
          acceptance: task.taskSpec?.acceptance ?? [],
          upstreamIssue: submission.upstreamIssue,
          executorBrief: submission.brief,
        } : {
          objective: task.contextBundle?.objective ?? task.input,
          acceptance: task.taskSpec?.acceptance ?? [],
          executorBrief: submission.brief,
          fullResult: submission.fullResult ?? task.output,
          artifactReferences: (task.artifacts?.files ?? []).map(toArtifactReference),
          resultVersion: `v${task.reviewCycle + 1}`,
        },
      });
      task.reviewStatus = "pending";
      task.reviewTaskId = reviewer.taskId;
      this.markTask(task);
      await this.queueOrDispatch(reviewer);
      return;
    }

    if (task.role !== "reviewer") return;
    const reviewed = this.tasks.get(task.parentTaskId);
    if (!reviewed) return;
    const verdict = submission.verdict;
    reviewed.reviewStatus = verdict;
    reviewed.reviewedAt = new Date().toISOString();
    reviewed.reviewBrief = submission.brief;
    this.markTask(reviewed);

    if (verdict === "approved") {
      const root = this.getCanonicalRootTask(task.rootTaskId) ?? task;
      const tasks = [...this.tasks.values()].filter(
        (t) => t.rootTaskId === root.taskId || this.getCanonicalRootTask(t)?.taskId === root.taskId
      );
      const activeTasks = tasks.filter((t) => !t.superseded);
      const currentBatchId = reviewed.batchId ?? reviewed.parentTaskId;

      // Identify all active (non-superseded) executors belonging to this batch
      const batchExecutors = activeTasks.filter(
        (t) => t.role === "executor" && (t.batchId === currentBatchId || t.parentTaskId === currentBatchId)
      );

      // Check if any sibling execution tasks in this batch are still active or pending review
      const hasRunningExecution = batchExecutors.some((t) => ACTIVE_TASK_STATUSES.has(t.status));
      const hasPendingReview = batchExecutors.some(
        (t) => t.status === "completed" && (!t.reviewStatus || t.reviewStatus === "pending")
      );
      const hasRunningReview = activeTasks.some((t) => {
        if (t.role !== "reviewer" || t.taskId === task.taskId) return false;
        const parent = this.tasks.get(t.parentTaskId);
        const parentBatch = parent?.batchId ?? parent?.parentTaskId;
        return parentBatch === currentBatchId && ACTIVE_TASK_STATUSES.has(t.status);
      });

      if (hasRunningExecution || hasRunningReview || hasPendingReview) {
        // Other siblings in the current batch are still executing or undergoing review.
        return;
      }

      // CRITICAL SAFETY CHECK: Verify that ALL batch executors completed successfully and are approved.
      // If any task failed, was cancelled, was rejected, or has an unapproved reviewStatus:
      const failedOrUnapproved = batchExecutors.filter(
        (t) => t.status !== "completed" || t.reviewStatus !== "approved"
      );
      if (failedOrUnapproved.length > 0) {
        const failureDetails = failedOrUnapproved
          .map((t) => `'${t.taskSpec?.title ?? t.taskId}' (status: ${t.status}, review: ${t.reviewStatus ?? "none"})`)
          .join(", ");
        this.requireHuman(
          task,
          `当前批次存在未成功完成或未获通过的子任务 [${failureDetails}]，禁止自动进入结果汇总。请人工介入排查。`,
          {
            batchId: currentBatchId,
            reasonTaskIds: failedOrUnapproved.map((t) => t.taskId),
          }
        );
        return;
      }

      // Concurrency deduplication: Check if an intake or finalization task for this batch already exists
      const existingIntake = tasks.find(
        (t) => (t.stage === "result_intake" || t.stage === "hub_finalization") &&
          (t.batchId === currentBatchId || t.contextBundle?.batchId === currentBatchId)
      );
      if (existingIntake) {
        return;
      }

      // Aggregate briefs from ALL completed executors in this batch
      const aggregatedBrief = batchExecutors.length === 1
        ? (batchExecutors[0].submission?.brief ?? "执行完成")
        : batchExecutors.map((t) => `【${t.taskSpec?.title ?? t.taskId}】: ${t.submission?.brief ?? "执行完成"}`).join("\n");
      const aggregatedArtifacts = batchExecutors.flatMap((t) => (t.artifacts?.files ?? []).map(toArtifactReference));

      // Aggregate briefs from ALL completed reviewers in this batch
      const batchReviewers = tasks.filter((t) => {
        if (t.role !== "reviewer" || t.status !== "completed") return false;
        const p = this.tasks.get(t.parentTaskId);
        return (p?.batchId === currentBatchId || p?.parentTaskId === currentBatchId);
      });
      const aggregatedReviewBrief = batchReviewers.length <= 1
        ? (submission.brief ?? "审核通过")
        : batchReviewers.map((r) => {
            const p = this.tasks.get(r.parentTaskId);
            return `【${p?.taskSpec?.title ?? r.taskId}】: ${r.submission?.brief ?? r.submission?.verdict ?? "审核通过"}`;
          }).join("\n");

      if (root.workflow?.fastPath) {
        const reservation = this.reserveWorkflowInvocations(task.rootTaskId, 1);
        if (!reservation.ok) {
          this.requireHuman(task, `工作流累计任务调用已达上限（50次），无法执行快速结案：${reservation.error}`);
          return;
        }
        const finalization = this.createTask({
          targetAgentId: root.workflow?.plannerAgentId ?? task.targetAgentId,
          input: "全量子任务已审核通过，Hub 确定性结案（实验功能）。",
          rootTaskId: root.taskId,
          parentTaskId: task.taskId,
          sourceAgentId: "system",
          sourceRole: "system",
          role: "system",
          stage: "hub_finalization",
          batchId: currentBatchId,
          quotaReserved: true,
          workflow: root.workflow,
          sessionScopeId: `${root.taskId}:intake`,
          taskSpec: {
            title: "Hub 确定性结案（实验功能）",
            type: "hub_finalization",
            priority: "P1",
            permissions_required: { project_workspace: true },
            acceptance: [],
          },
          contextBundle: {
            approved: true,
            fastPath: true,
            batchId: currentBatchId,
            batchCount: batchExecutors.length,
            executorBrief: aggregatedBrief,
            reviewBrief: aggregatedReviewBrief,
            artifactReferences: aggregatedArtifacts,
          },
        });
        finalization.status = "completed";
        finalization.completedAt = new Date().toISOString();
        finalization.submission = {
          decision: "complete",
          brief: `当前批次所有子任务（${batchExecutors.length}个）均已通过审核并交付完整成果，Hub 确定性结案（实验功能）完成。`,
          assignments: [],
          needsHuman: false,
        };
        finalization.output = finalization.submission.brief;
        finalization.workflowDecision = "complete";
        this.finishTaskActivity(finalization);
        this.markTask(finalization);
        this.checkAndFinalizeWorkflow(root.taskId);
        return;
      }

      await this.createPlannerIntake(task, reviewed, "result_intake", {
        approved: true,
        batchId: currentBatchId,
        batchCount: batchExecutors.length,
        executorBrief: aggregatedBrief,
        reviewBrief: aggregatedReviewBrief,
        artifactReferences: aggregatedArtifacts,
      });
      return;
    }
    if (verdict === "upstream_confirmed") {
      const root = this.tasks.get(task.rootTaskId) ?? task;
      const replanDepth = Number(root.workflow?.replanDepth ?? reviewed.workflow?.replanDepth ?? 0) + 1;
      if (replanDepth > 10) {
        this.requireHuman(task, "工作流重新规划深度已达上限（10层），已自动暂停。请人工介入审查。");
        return;
      }
      if (root.workflow) {
        root.workflow.replanDepth = replanDepth;
        this.markTask(root);
      }
      reviewed.superseded = true;
      this.markTask(reviewed);
      await this.createPlannerIntake(task, reviewed, "replan", {
        upstreamIssueConfirmed: true,
        correctionBrief: submission.correctionBrief ?? submission.brief,
        executorBrief: reviewed.submission?.brief,
      });
      return;
    }
    if (verdict === "upstream_denied") {
      const nextCycle = reviewed.reviewCycle + 1;
      const maxCycles = Math.min(5, Math.max(0, Number(task.workflow?.maxReviewCycles ?? 2)));
      if (nextCycle > maxCycles) {
        this.requireHuman(task, `同一上游错误报告连续 ${nextCycle} 次未获审核认可：${submission.brief}`);
        return;
      }
      await this.createRevisionTask(task, reviewed, { upstreamDenied: true, reviewBrief: submission.brief }, nextCycle);
      return;
    }

    const nextCycle = reviewed.reviewCycle + 1;
    const maxCycles = Math.min(5, Math.max(0, Number(task.workflow?.maxReviewCycles ?? 2)));
    if (nextCycle > maxCycles) {
      this.requireHuman(task, `成果连续 ${nextCycle} 次未通过审核：${submission.brief}`);
      return;
    }
    await this.createRevisionTask(task, reviewed, {
      reviewBrief: submission.brief,
      issues: submission.issues ?? [],
      correctionBrief: submission.correctionBrief,
    }, nextCycle);
  }

  async dispatchAssignments(task, assignments) {
    const reservation = this.reserveWorkflowInvocations(task.rootTaskId, assignments.length);
    if (!reservation.ok) {
      this.requireHuman(
        task,
        `工作流累计任务调用已达上限（50次），当前已执行 ${reservation.current} 次，本次拟下发 ${assignments.length} 次，已自动熔断暂停。请人工介入审查。`
      );
      return;
    }

    const boundExecutorId = task.workflow?.executorAgentId ?? null;
    let assignmentIndex = 0;
    for (const assignment of assignments) {
      assignmentIndex++;
      if (boundExecutorId && assignment.targetAgentId && assignment.targetAgentId !== boundExecutorId) {
        this.queueEvent("workflow.executor_override", {
          rootTaskId: task.rootTaskId,
          plannerTaskId: task.taskId,
          requestedByPlanner: assignment.targetAgentId,
          executorAgentId: boundExecutorId,
        });
      }
      const workUnitId = `wu-${task.taskId}-${assignmentIndex}`;
      const child = this.createTask({
        targetAgentId: boundExecutorId ?? assignment.targetAgentId,
        requestedAgentId: boundExecutorId ?? assignment.targetAgentId ?? null,
        input: assignment.instructions,
        rootTaskId: task.rootTaskId,
        parentTaskId: task.taskId,
        batchId: task.taskId,
        planningTaskId: task.taskId,
        sourceAgentId: task.targetAgentId,
        role: "executor",
        stage: "execution",
        quotaReserved: true,
        workflow: task.workflow,
        workUnitId,
        revision: 1,
        superseded: false,
        requiredCapabilities: assignment.requiredCapabilities,
        modelPreference: assignment.modelPreference,
        reasoningEffort: assignment.reasoningEffort,
        taskSpec: {
          title: assignment.title,
          type: "collaboration_execution",
          priority: task.taskSpec?.priority ?? "P1",
          inputs: (task.taskSpec?.inputs ?? []).map((item) => (typeof item === "string" ? { path: item } : item)),
          expected_outputs: assignment.expectedOutputs ?? [],
          permissions_required: task.taskSpec?.permissions_required ?? { project_workspace: true },
          checkpoint_policy: { mode: "stage" },
          acceptance: assignment.acceptance?.length ? assignment.acceptance : task.taskSpec?.acceptance ?? [],
        },
        contextBundle: {
          objective: task.contextBundle?.objective ?? task.input,
          plannerBrief: task.submission?.brief,
          acceptance: assignment.acceptance ?? [],
          artifactReferences: task.contextBundle?.artifactReferences ?? [],
        },
      });
      await this.queueOrDispatch(child);
      if (child.status === "queued" && child.schedulingErrorCode && child.schedulingErrorCode !== "EXECUTOR_AT_CAPACITY" && child.schedulingErrorCode !== "ACCOUNT_AT_CAPACITY") {
        await this.handleSchedulingFailure(task, child);
      }
    }
  }

  async handleSchedulingFailure(plannerTask, childTask) {
    const root = this.tasks.get(plannerTask.rootTaskId) ?? plannerTask;
    root.schedulingRetryCount = Number(root.schedulingRetryCount ?? 0);
    if (root.schedulingRetryCount === 0) {
      root.schedulingRetryCount = 1;
      this.markTask(root);
      childTask.status = "cancelled";
      childTask.superseded = true;
      this.markTask(childTask);
      this.refundWorkflowInvocation(plannerTask.rootTaskId, 1);
      await this.createPlannerIntake(plannerTask, childTask, "replan", {
        schedulingFailure: {
          assignmentTitle: childTask.taskSpec?.title,
          targetAgentId: childTask.targetAgentId,
          requestedModel: childTask.modelPreference,
          errorCode: childTask.schedulingErrorCode,
          errorReason: childTask.schedulingError,
        },
        failureMessage: `子任务 '${childTask.taskSpec?.title}' 调度失败 (${childTask.schedulingError})。请根据可用调度资源重新分配节点或模型。`,
      });
    } else {
      this.requireHuman(childTask, `子任务 '${childTask.taskSpec?.title}' 调度失败（重新规划后仍无法调度）：${childTask.schedulingError}。请人工介入选择执行节点。`);
    }
  }

  async createPlannerIntake(reviewTask, reviewed, stage, details) {
    const root = this.getCanonicalRootTask(reviewTask.rootTaskId);
    const reservation = this.reserveWorkflowInvocations(reviewTask.rootTaskId, 1);
    if (!reservation.ok) {
      this.requireHuman(reviewTask, `工作流累计任务调用已达上限（50次），无法调度 Planner：${reservation.error}`);
      return;
    }
    const plannerModel = root?.workflow?.intakeModelPreference
      ?? root?.workflow?.stageModels?.intake?.modelPreference
      ?? root?.workflow?.plannerModelPreference
      ?? root?.workflow?.stageModels?.planner?.modelPreference
      ?? null;
    const plannerReasoning = root?.workflow?.intakeReasoningEffort
      ?? root?.workflow?.stageModels?.intake?.reasoningEffort
      ?? root?.workflow?.plannerReasoningEffort
      ?? root?.workflow?.stageModels?.planner?.reasoningEffort
      ?? null;
    const sessionScopeId = stage === "result_intake"
      ? `${reviewTask.rootTaskId}:intake`
      : (root?.sessionScopeId ?? reviewTask.rootTaskId);
    const contextBundle = { ...details };
    if (stage !== "result_intake") {
      contextBundle.schedulerCatalog = this.schedulerCatalog();
    }
    const planner = this.createTask({
      targetAgentId: reviewTask.workflow?.plannerAgentId,
      input: stage === "replan" ? "根据已确认的上游错误重新安排后续任务。" : "接收已审核通过的任务简报，并决定是否继续安排任务。",
      rootTaskId: reviewTask.rootTaskId,
      parentTaskId: reviewTask.taskId,
      batchId: details.batchId ?? null,
      sourceAgentId: reviewTask.targetAgentId,
      role: "planner",
      stage,
      quotaReserved: true,
      workflow: root?.workflow ?? reviewTask.workflow,
      sessionScopeId,
      modelPreference: plannerModel,
      reasoningEffort: plannerReasoning,
      taskSpec: {
        title: stage === "replan" ? "重新规划" : "接收审核结果",
        type: stage,
        priority: reviewed.taskSpec?.priority ?? "P1",
        permissions_required: { project_workspace: true },
        acceptance: [],
      },
      contextBundle,
    });
    await this.queueOrDispatch(planner);
  }

  async createRevisionTask(reviewTask, reviewed, details, reviewCycle = reviewed.reviewCycle) {
    const root = this.tasks.get(reviewTask.rootTaskId);
    const reservation = this.reserveWorkflowInvocations(reviewTask.rootTaskId, 1);
    if (!reservation.ok) {
      this.requireHuman(reviewTask, `工作流累计任务调用已达上限（50次），无法调度返工任务：${reservation.error}`);
      return;
    }
    const revision = this.createTask({
      targetAgentId: reviewed.targetAgentId,
      requestedAgentId: reviewed.requestedAgentId ?? reviewed.targetAgentId,
      input: details.upstreamDenied ? "审核未认可上游错误报告，请继续原任务。" : "根据审核意见修改原成果。",
      rootTaskId: reviewTask.rootTaskId,
      parentTaskId: reviewTask.taskId,
      batchId: reviewed.batchId ?? reviewed.parentTaskId,
      planningTaskId: reviewed.planningTaskId ?? reviewed.parentTaskId,
      sourceAgentId: reviewTask.targetAgentId,
      role: "executor",
      stage: "revision",
      quotaReserved: true,
      workflow: root?.workflow ?? reviewTask.workflow,
      workUnitId: reviewed.workUnitId ?? reviewed.taskId,
      revision: Number(reviewed.revision ?? 1) + 1,
      superseded: false,
      sessionScopeId: reviewed.sessionScopeId,
      modelPreference: reviewed.modelPreference ?? null,
      reasoningEffort: reviewed.reasoningEffort ?? null,
      reviewCycle,
      taskSpec: reviewed.taskSpec,
      contextBundle: {
        objective: reviewed.contextBundle?.objective ?? reviewed.input,
        previousBrief: reviewed.submission?.brief,
        ...details,
      },
    });
    reviewed.superseded = true;
    reviewed.supersededBy = revision.taskId;
    this.markTask(reviewed);
    await this.queueOrDispatch(revision);
  }

  requireHuman(task, question, extraOptions = {}) {
    const root = this.tasks.get(task.rootTaskId) ?? task;
    return this.createIntervention(task, {
      kind: "workflow_input",
      question,
      allowedActions: ["respond", "approve", "reject"],
      continuation: {
        type: "workflow_followup",
        targetAgentId: root.workflow?.plannerAgentId ?? (task.role === "planner" ? task.targetAgentId : null),
        role: "planner",
        stage: "human_followup",
        sessionScopeId: root.sessionScopeId ?? task.sessionScopeId ?? root.taskId,
      },
      ...extraOptions,
    });
  }

  createIntervention(task, options = {}) {
    const root = this.getCanonicalRootTask(task.rootTaskId ?? task) ?? task;
    const kind = String(options.kind ?? "workflow_input");
    const batchId = options.batchId ?? task.batchId ?? task.parentTaskId ?? null;
    const reasonTaskIds = Array.isArray(options.reasonTaskIds) && options.reasonTaskIds.length > 0
      ? options.reasonTaskIds.map(String)
      : [task.taskId];

    const duplicate = [...this.interventions.values()].find((item) => {
      if (item.rootTaskId !== root.taskId || item.status !== "pending" || item.kind !== kind) return false;
      if (item.taskId === task.taskId) return true;
      const itemBatchId = item.batchId ?? this.tasks.get(item.taskId)?.batchId ?? this.tasks.get(item.taskId)?.parentTaskId ?? null;
      if (batchId && itemBatchId && batchId === itemBatchId) {
        const itemReasonTaskIds = Array.isArray(item.reasonTaskIds) && item.reasonTaskIds.length > 0
          ? item.reasonTaskIds
          : [item.taskId];
        if (reasonTaskIds.some((id) => itemReasonTaskIds.includes(id))) {
          return true;
        }
      }
      return false;
    });
    if (duplicate) return duplicate;
    const requestedAt = new Date().toISOString();
    const question = String(options.question ?? "需要人工决定").trim().slice(0, 4000);
    const intervention = {
      interventionId: randomUUID(),
      rootTaskId: root.taskId,
      taskId: task.taskId,
      batchId,
      reasonTaskIds,
      kind,
      status: "pending",
      question,
      requestedBy: options.requestedBy ?? task.targetAgentId ?? "system",
      requesterRole: options.requesterRole ?? task.role ?? "system",
      requesterStage: options.requesterStage ?? task.stage ?? null,
      sessionScopeId: options.sessionScopeId ?? task.sessionScopeId ?? null,
      allowedActions: Array.isArray(options.allowedActions) ? options.allowedActions : ["respond"],
      context: minimalInterventionContext(root, task, options.context),
      continuation: options.continuation ?? null,
      requestedAt,
      updatedAt: requestedAt,
    };
    this.interventions.set(intervention.interventionId, intervention);
    this.markIntervention(intervention);
    this.syncRootIntervention(root.taskId);
    if (options.addMessage !== false) {
      this.addMessage(task, {
        senderId: intervention.requestedBy,
        senderRole: intervention.requesterRole,
        kind: "human_intervention",
        text: question,
        mentions: ["human"],
      });
    }
    this.queueEvent("intervention.requested", {
      interventionId: intervention.interventionId,
      rootTaskId: intervention.rootTaskId,
      taskId: intervention.taskId,
      kind: intervention.kind,
      requesterRole: intervention.requesterRole,
      requesterStage: intervention.requesterStage,
      sessionScopeId: intervention.sessionScopeId,
    });
    return intervention;
  }

  currentIntervention(rootTaskId) {
    const root = this.getCanonicalRootTask(rootTaskId);
    const targetId = root ? root.taskId : rootTaskId;
    const matching = [...this.interventions.values()]
      .filter((item) => item.rootTaskId === targetId)
      .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
    return matching.find((item) => item.status === "pending") ?? matching[0] ?? null;
  }

  publicIntervention(intervention, legacyStatus = false) {
    if (!intervention) return null;
    const { continuation, context, ...safe } = intervention;
    return {
      ...safe,
      ...(!legacyStatus ? { context } : {}),
      status: legacyStatus ? (intervention.status === "pending" ? "required" : "resolved") : intervention.status,
      ...(legacyStatus ? { recordStatus: intervention.status } : {}),
      resume: continuation ? {
        type: continuation.type,
        role: continuation.role ?? null,
        stage: continuation.stage ?? null,
        sessionScopeId: continuation.sessionScopeId ?? intervention.sessionScopeId ?? null,
      } : null,
    };
  }

  syncRootIntervention(rootTaskId) {
    const root = this.getCanonicalRootTask(rootTaskId);
    if (!root) return;
    root.humanIntervention = this.publicIntervention(this.currentIntervention(root.taskId), true);
    this.markTask(root);
  }

  closePendingInterventions(task, actorId, reason) {
    const resolvedAt = new Date().toISOString();
    let count = 0;
    for (const intervention of this.interventions.values()) {
      if (intervention.taskId !== task.taskId || intervention.status !== "pending") continue;
      intervention.status = "resolved";
      intervention.decision = "reject";
      intervention.response = reason;
      intervention.resolvedAt = resolvedAt;
      intervention.resolvedBy = actorId;
      intervention.updatedAt = resolvedAt;
      this.markIntervention(intervention, { allowedStatuses: ["pending"] });
      count++;
    }
    this.syncRootIntervention(task.rootTaskId);
    return count;
  }

  async resolveIntervention(interventionId, input, actor) {
    const previous = this.interventionLocks.get(interventionId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.resolveInterventionNow(interventionId, input, actor));
    this.interventionLocks.set(interventionId, operation);
    try {
      return await operation;
    } finally {
      if (this.interventionLocks.get(interventionId) === operation) this.interventionLocks.delete(interventionId);
    }
  }

  async resolveInterventionNow(interventionId, input, actor) {
    const intervention = this.interventions.get(interventionId);
    if (!intervention) throw httpError(404, `Unknown intervention ${interventionId}`);
    if (intervention.status !== "pending") throw httpError(409, `Intervention ${interventionId} is already resolved`);
    const decision = String(input.decision ?? input.action ?? "respond").toLowerCase();
    if (!intervention.allowedActions.includes(decision)) throw httpError(400, `Decision ${decision} is not allowed for this intervention`);
    const response = String(input.response ?? "").trim().slice(0, 10_000);
    if (decision === "respond" && !response) throw httpError(400, "Human response is required");
    if (intervention.continuation?.type === "retry_task" && actor.role !== "admin") {
      throw httpError(403, "Administrator role required for task approval or rejection");
    }
    const origin = this.tasks.get(intervention.taskId);
    const root = this.tasks.get(intervention.rootTaskId);
    if (intervention.continuation?.type === "workflow_followup" && !root) {
      throw httpError(409, "Intervention root workflow is unavailable");
    }
    if (intervention.continuation?.type === "retry_task" && (!origin || TERMINAL_TASK_STATUSES.has(origin.status))) {
      throw httpError(409, "Intervention task can no longer be resumed");
    }

    const resolvedAt = new Date().toISOString();
    intervention.status = "resolved";
    intervention.decision = decision;
    intervention.response = response || null;
    intervention.resolvedAt = resolvedAt;
    intervention.resolvedBy = actor.id;
    intervention.updatedAt = resolvedAt;
    this.markIntervention(intervention, { allowedStatuses: ["pending"] });
    this.syncRootIntervention(intervention.rootTaskId);

    const messageTask = origin ?? root;
    if (messageTask) {
      this.addMessage(messageTask, {
        senderId: actor.id,
        senderRole: "human",
        kind: "human_decision",
        text: response || (decision === "approve" ? "已批准" : "已拒绝"),
      });
    }

    let resumedTask = null;
    if (intervention.continuation?.type === "workflow_followup") {
      resumedTask = this.createTask({
        targetAgentId: intervention.continuation.targetAgentId,
        input: "根据记录的人工决定从原工作流节点继续。",
        rootTaskId: intervention.rootTaskId,
        parentTaskId: intervention.taskId,
        sourceAgentId: actor.id,
        role: intervention.continuation.role,
        stage: intervention.continuation.stage,
        workflow: origin?.workflow ?? root.workflow,
        sessionScopeId: intervention.continuation.sessionScopeId,
        taskSpec: root.taskSpec,
        contextBundle: {
          ...intervention.context,
          humanResponse: response || decision,
          humanDecision: { interventionId, decision, response: response || null },
          schedulerCatalog: this.schedulerCatalog(),
        },
      });
      await this.queueOrDispatch(resumedTask);
    } else if (intervention.continuation?.type === "retry_task") {
      const task = origin;
      if (decision === "approve") {
        task.requiresApproval = false;
        task.status = "queued";
        task.approval = { ...(task.approval ?? {}), approvedAt: resolvedAt, approvedBy: actor.id, interventionId };
        this.markTask(task);
        await this.queueOrDispatch(task);
        resumedTask = task;
      } else {
        task.requiresApproval = false;
        task.status = "rejected";
        task.completedAt = resolvedAt;
        task.error = { name: "HumanRejectedError", message: response || "Human rejected the intervention request" };
        this.finishTaskActivity(task);
        this.markTask(task);
        await this.retryQueuedTasks();
        resumedTask = task;
      }
    } else if (intervention.continuation?.type === "human_review") {
      const task = origin;
      if (decision === "approve") {
        task.reviewStatus = "approved";
        task.reviewedAt = resolvedAt;
        task.reviewBrief = response || "人工审核通过";
        this.markTask(task);
        await this.createPlannerIntake(task, task, "result_intake", {
          approved: true,
          executorBrief: task.submission?.brief,
          reviewBrief: task.reviewBrief,
          artifactReferences: (task.artifacts?.files ?? []).map(toArtifactReference),
        });
        resumedTask = task;
      } else {
        task.reviewStatus = "rejected";
        task.reviewedAt = resolvedAt;
        task.reviewBrief = response || "人工审核驳回";
        this.markTask(task);
        await this.createRevisionTask(task, task, { reviewBrief: task.reviewBrief }, (task.reviewCycle ?? 0) + 1);
        resumedTask = task;
      }
    }

    await this.recordEvent("intervention.resolved", {
      interventionId,
      rootTaskId: intervention.rootTaskId,
      taskId: intervention.taskId,
      actor: actor.id,
      decision,
      resumedTaskId: resumedTask?.taskId ?? null,
    });
    if (intervention.continuation?.type === "workflow_followup") {
      await this.recordEvent("workflow.human_response", { rootTaskId: intervention.rootTaskId, actor: actor.id, interventionId, decision });
    } else if (decision === "approve") {
      await this.recordEvent("task.approved", { taskId: intervention.taskId, actor: actor.id, interventionId });
    } else {
      await this.recordEvent("task.human_rejected", { taskId: intervention.taskId, actor: actor.id, interventionId });
    }
    await this.commitAndDispatch();
    return { ok: true, intervention: this.publicIntervention(intervention), task: resumedTask };
  }

  conversations(options = {}) {
    const lifecycleFilter = options.lifecycle ?? "active";
    const roots = [...this.tasks.values()].filter((task) => task.rootTaskId === task.taskId);
    return roots.map((root) => {
      const tasks = [...this.tasks.values()].filter((task) => task.rootTaskId === root.taskId);
      const messages = this.messages.filter((message) => message.rootTaskId === root.taskId);
      const activeTasks = tasks.filter((task) => !task.superseded);
      const active = activeTasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status));
      const failed = activeTasks.some((task) => ["failed", "rejected"].includes(task.status));
      const currentIntervention = this.currentIntervention(root.taskId);
      const isCancelled = root.status === "cancelled" || (activeTasks.length > 0 && activeTasks.every((task) => task.status === "cancelled"));
      const isComplete = this.isWorkflowComplete(root.taskId);
      const status = root.forceCompleted
        ? "completed"
        : currentIntervention?.status === "pending"
          ? "needs_human"
          : active
            ? "active"
            : failed
              ? "failed"
              : isCancelled
                ? "cancelled"
                : isComplete
                  ? "completed"
                  : "stalled";
      const participants = [...new Set(tasks.flatMap((task) => [task.sourceAgentId, task.targetAgentId]).filter(Boolean))];
      return {
        rootTaskId: root.taskId,
        title: root.taskSpec?.title ?? (root.input.slice(0, 60) || "未命名任务"),
        status,
        lifecycle: this.lifecycle.stateOf(root.taskId),
        createdAt: root.createdAt,
        updatedAt: messages.at(-1)?.createdAt ?? root.completedAt ?? root.createdAt,
        participants,
        taskCount: tasks.length,
        messageCount: messages.length,
        humanIntervention: this.publicIntervention(currentIntervention, true),
      };
    })
      .filter((item) => lifecycleFilter === "all" || item.lifecycle === lifecycleFilter)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  isWorkflowComplete(rootTaskId) {
    const root = this.getCanonicalRootTask(rootTaskId);
    if (!root) return false;
    if (root.forceCompleted) return true;
    if (!root.workflow?.enabled) {
      return root.status === "completed";
    }

    const canonicalRootTaskId = root.taskId;
    const tasks = [...this.tasks.values()].filter((t) => t.rootTaskId === canonicalRootTaskId || this.getCanonicalRootTask(t)?.taskId === canonicalRootTaskId);
    const activeTasks = tasks.filter((t) => !t.superseded);

    // Pillar 4: No active tasks, no pending interventions, no failed/rejected tasks among non-superseded tasks
    if (activeTasks.some((t) => ACTIVE_TASK_STATUSES.has(t.status))) return false;
    const currentIntervention = this.currentIntervention(canonicalRootTaskId);
    if (currentIntervention && currentIntervention.status === "pending") return false;
    if (activeTasks.some((t) => ["failed", "rejected"].includes(t.status))) return false;

    // Pillar 1: All active execution tasks completed and have valid deliverable fullResult/output
    const executionTasks = activeTasks.filter((t) => t.role === "executor");
    if (executionTasks.length === 0) return false;
    for (const execTask of executionTasks) {
      if (execTask.status !== "completed") return false;
      if (!execTask.submission?.fullResult && !execTask.output) return false;
    }

    // Pillar 2: Every active execution task approved by an independent reviewer (or human)
    for (const execTask of executionTasks) {
      if (execTask.reviewStatus !== "approved") return false;
      const reviewTask = tasks.find((t) => t.parentTaskId === execTask.taskId && t.role === "reviewer");
      if (reviewTask && reviewTask.targetAgentId === execTask.targetAgentId) {
        return false;
      }
    }

    // Pillar 3: Planner explicitly decided 'complete' in result_intake stage OR Hub deterministic finalization completed
    const intakeTask = tasks.filter((t) => (
      (t.role === "planner" && t.stage === "result_intake") ||
      (t.role === "system" && t.stage === "hub_finalization")
    ) && t.status === "completed").at(-1);
    if (!intakeTask || intakeTask.submission?.decision !== "complete") {
      return false;
    }

    return true;
  }

  checkAndFinalizeWorkflow(rootTaskId) {
    const root = this.getCanonicalRootTask(rootTaskId);
    if (!root) return;
    if (this.isWorkflowComplete(root.taskId)) {
      root.status = "completed";
      root.completedAt = root.completedAt ?? new Date().toISOString();
      root.workflowCompletedAt = new Date().toISOString();
      this.finishTaskActivity(root);
      this.markTask(root);
      this.queueEvent("workflow.completed", { rootTaskId: root.taskId });
    }
  }

  schedulerCatalog() {
    this.refreshAccountLoads();
    return [...this.agents.values()].map((agent) => ({
      agentId: agent.agentId,
      deviceId: agent.deviceId,
      account: agent.account ? {
        id: agent.account.id,
        provider: agent.account.provider,
        plan: agent.account.plan,
        maxConcurrency: Number(agent.accountMaxConcurrency ?? 1),
        activeTaskCount: Number(agent.accountActiveTaskCount ?? 0),
      } : null,
      roles: agent.roles ?? [],
      status: agent.status,
      paused: Boolean(agent.paused),
      activeTaskCount: Number(agent.activeTaskCount ?? 0),
      maxConcurrency: Number(agent.maxConcurrency ?? 1),
      capabilities: agent.capabilities ?? [],
      models: (agent.models ?? []).map((model) => ({
        id: model.id,
        label: model.label,
        family: model.family,
        quotaGroup: model.quotaGroup,
        reasoningEfforts: model.reasoningEfforts ?? [],
        defaultReasoningEffort: model.defaultReasoningEffort ?? null,
        availability: model.availability ?? "unknown",
        quotaState: model.quota?.state ?? "Unknown",
      })),
      quota: agent.quotaSnapshot ? {
        state: agent.quotaSnapshot.state,
        windows: (agent.quotaSnapshot.windows ?? []).map((window) => ({
          id: window.id,
          name: window.name,
          quotaGroup: window.quotaGroup,
          windowType: window.windowType,
          durationMinutes: window.durationMinutes,
          remainingPercent: window.remainingPercent,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt,
        })),
        stale: Boolean(agent.quotaSnapshot.stale),
      } : { state: "Unknown", windows: [], stale: false },
      environment: summarizeAgentEnvironment(agent.resourceSnapshot?.capabilities),
    })).sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  refreshAccountLoads() {
    const loads = new Map();
    for (const task of this.tasks.values()) {
      if (!task.activeSlotAgentId || !ACTIVE_SLOT_STATUSES.has(task.status)) continue;
      const worker = this.agents.get(task.activeSlotAgentId);
      const key = schedulingAccountKey(worker);
      if (key) loads.set(key, Number(loads.get(key) ?? 0) + 1);
    }
    for (const agent of this.agents.values()) {
      const key = schedulingAccountKey(agent);
      agent.accountActiveTaskCount = key ? Number(loads.get(key) ?? 0) : Number(agent.activeTaskCount ?? 0);
      agent.accountMaxConcurrency = Math.max(1, Number(agent.account?.maxConcurrency ?? 1));
    }
  }

  async queueOrDispatch(task) {
    if (task.requiresApproval && task.status === "awaiting_approval") return;
    if (task.workflow?.enabled && !task.quotaReserved) {
      const root = this.getCanonicalRootTask(task.rootTaskId ?? task) ?? task;
      const reservation = this.reserveWorkflowInvocations(root.taskId, 1);
      if (!reservation.ok) {
        task.status = "failed";
        task.completedAt = new Date().toISOString();
        task.error = { name: "CircuitBreakerError", message: reservation.error };
        this.finishTaskActivity(task);
        this.markTask(task);
        this.requireHuman(task, `工作流累计任务调用已达上限（50次），已自动熔断暂停。请人工介入审查。`);
        return;
      }
      task.quotaReserved = true;
    }
    let selection;
    try {
      const requiresArtifacts = Boolean(this.artifactStore && extractArtifactPaths(task.taskSpec).length);
      const candidates = new Map([...this.agents].filter(([, agent]) => (
        (!this.leasesEnabled() || agent.protocolFeatures?.includes(LEASE_PROTOCOL_FEATURE))
        && (!requiresArtifacts || agent.protocolFeatures?.includes(ARTIFACT_PROTOCOL_FEATURE))
      )));
      const namedAgent = task.targetAgentId ? this.agents.get(task.targetAgentId) : null;
      if (namedAgent && !candidates.has(namedAgent.agentId)) {
        const reason = this.leasesEnabled() && !namedAgent.protocolFeatures?.includes(LEASE_PROTOCOL_FEATURE)
          ? "lease_protocol_unsupported" : "artifact_protocol_unsupported";
        throw httpError(409, `Agent ${namedAgent.agentId} does not support this task protocol`, "EXECUTOR_UNAVAILABLE", { reason, agentId: namedAgent.agentId });
      }
      this.refreshAccountLoads();
      selection = chooseAgent(candidates, {
        targetAgentId: task.targetAgentId,
        role: task.role,
        requireDeclaredRole: task.role === "executor" && Boolean(task.workflow?.enabled),
        requiredCapabilities: task.requiredCapabilities,
        modelPreference: task.modelPreference,
        reasoningEffort: task.reasoningEffort,
      });
    } catch (error) {
      task.status = "queued";
      task.schedulingError = error.message;
      task.schedulingErrorCode = error.code ?? (task.targetAgentId ? "EXECUTOR_UNAVAILABLE" : "NO_ELIGIBLE_AGENT");
      task.schedulingErrorDetails = { ...(error.details ?? {}), observedAt: new Date().toISOString() };
      this.markTask(task);
      await this.recordEvent("task.queued_no_candidate", { taskId: task.taskId, agentId: task.targetAgentId, error: error.message });
      return;
    }
    const agent = selection.agent;
    task.targetAgentId = agent.agentId;
    task.execution = {
      model: selection.model?.id ?? null,
      reasoningEffort: task.reasoningEffort,
      selectedAt: new Date().toISOString(),
      reason: task.modelPreference ? "requested-model" : "capability-quota-load-score",
    };
    task.schedulingError = null;
    task.schedulingErrorCode = null;
    task.schedulingErrorDetails = null;
    task.status = "dispatched";
    task.dispatchedAt = new Date().toISOString();
    task.quotaReserved = false;
    if (!task.activeSlotAgentId) {
      task.activeSlotAgentId = agent.agentId;
      agent.activeTaskCount = Number(agent.activeTaskCount ?? 0) + 1;
      this.markAgent(agent);
    }
    let attempt;
    if (this.leasesEnabled()) {
      const attemptId = randomUUID();
      task.attemptNumber = Number(task.attemptNumber ?? 0) + 1;
      task.currentAttemptId = attemptId;
      attempt = {
        attemptId,
        taskId: task.taskId,
        attemptNumber: task.attemptNumber,
        workerId: agent.agentId,
        status: "assigned",
        createdAt: new Date().toISOString(),
        assignedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + this.leaseTtlMs()).toISOString(),
        lastHeartbeatAt: null,
      };
      this.attempts.set(attemptId, attempt);
    }
    const assignment = makeEnvelope("task.assign", {
      agentId: task.targetAgentId,
      taskId: task.taskId,
      payload: {
        input: task.input,
        rootTaskId: task.rootTaskId,
        parentTaskId: task.parentTaskId,
        sourceAgentId: task.sourceAgentId,
        metadata: task.metadata,
        taskSpec: task.taskSpec,
        role: task.role,
        stage: task.stage,
        contextBundle: task.contextBundle,
        sessionScopeId: task.sessionScopeId,
        execution: task.execution,
        ...(attempt ? {
          attemptId: attempt.attemptId,
          lease: {
            expiresAt: attempt.leaseExpiresAt,
            ttlMs: this.leaseTtlMs(),
          },
        } : {}),
      },
    });
    if (attempt) {
      attempt.assignmentMessageId = assignment.id;
      this.markAttempt(attempt);
    }
    this.markTask(task);
    this.deliver(task.targetAgentId, assignment);
    await this.recordEvent("task.dispatched", {
      taskId: task.taskId,
      agentId: task.targetAgentId,
      attemptId: attempt?.attemptId ?? null,
      leaseExpiresAt: attempt?.leaseExpiresAt ?? null,
    });
  }

  finishTaskActivity(task) {
    if (!task.activeSlotAgentId) return;
    const agent = this.agents.get(task.activeSlotAgentId);
    if (agent) {
      agent.activeTaskCount = Math.max(0, Number(agent.activeTaskCount ?? 0) - 1);
      this.markAgent(agent);
    }
    task.activeSlotAgentId = null;
    this.markTask(task);
  }

  async retryQueuedTasks() {
    for (const candidate of this.tasks.values()) {
      if (candidate.status === "queued") await this.queueOrDispatch(candidate);
    }
  }

  deliver(agentId, envelope) {
    const key = deliveryKey(agentId, envelope.id);
    if (!this.pendingDeliveries.has(key)) {
      const delivery = { agentId, envelope, attempts: 0, sentAt: 0, createdAt: new Date().toISOString() };
      this.pendingDeliveries.set(key, delivery);
      this.markDelivery(delivery);
    }
  }

  sendDelivery(delivery) {
    const ws = this.connections.get(delivery.agentId);
    const openState = this.WebSocket?.OPEN ?? 1;
    if (!ws || ws.readyState !== openState) return;
    ws.send(JSON.stringify(delivery.envelope));
    delivery.sentAt = Date.now();
    delivery.attempts += 1;
  }

  flushAgentDeliveries(agentId, force = false) {
    for (const delivery of this.pendingDeliveries.values()) {
      if (delivery.agentId === agentId && (force || !delivery.sentAt)) this.sendDelivery(delivery);
    }
  }

  retryDeliveries() {
    const timeout = Number(this.config.delivery?.ackTimeoutMs ?? 5000);
    const maxAttempts = Number(this.config.delivery?.maxAttemptsPerConnection ?? 5);
    for (const delivery of this.pendingDeliveries.values()) {
      if (!delivery.sentAt) {
        this.sendDelivery(delivery);
        continue;
      }
      if (Date.now() - delivery.sentAt < timeout) continue;
      if (delivery.attempts >= maxAttempts) continue;
      this.sendDelivery(delivery);
    }
  }

  async reapExpiredLeases(nowMs = Date.now()) {
    if (!this.leasesEnabled() || this.storageFault) return;
    let changed = false;
    for (const attempt of this.attempts.values()) {
      if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
      if (Date.parse(attempt.leaseExpiresAt) > nowMs) continue;
      const task = this.tasks.get(attempt.taskId);
      attempt.status = "expired";
      attempt.expiredAt = new Date(nowMs).toISOString();
      this.markAttempt(attempt);
      changed = true;

      if (attempt.assignmentMessageId) {
        const key = deliveryKey(attempt.workerId, attempt.assignmentMessageId);
        if (this.pendingDeliveries.delete(key)) this.markDeliveryDeleted(attempt.workerId, attempt.assignmentMessageId);
      }
      if (!task || task.currentAttemptId !== attempt.attemptId || TERMINAL_TASK_STATUSES.has(task.status)) continue;

      this.finishTaskActivity(task);
      task.recoveryCount = Number(task.recoveryCount ?? 0) + 1;
      const retrySafe = this.canRetryExpiredTask(task);
      const recoveryLimitExceeded = task.recoveryCount > this.leaseMaxRecoveryAttempts();
      if (retrySafe && !recoveryLimitExceeded) {
        task.status = "queued";
        task.currentAttemptId = null;
        task.targetAgentId = task.role === "executor" && task.workflow?.enabled
          ? (task.workflow.executorAgentId ?? task.targetAgentId ?? task.requestedAgentId ?? null)
          : (task.requestedAgentId ?? null);
        task.schedulingError = null;
        task.schedulingErrorCode = null;
        task.schedulingErrorDetails = null;
        this.addMessage(task, {
          senderId: "system",
          senderRole: "system",
          kind: "status",
          text: `执行租约已过期，任务进入第 ${task.recoveryCount} 次恢复调度。`,
        });
        await this.recordEvent("task.lease_expired_requeued", {
          taskId: task.taskId,
          attemptId: attempt.attemptId,
          workerId: attempt.workerId,
          recoveryCount: task.recoveryCount,
        });
      } else {
        task.status = "awaiting_approval";
        task.requiresApproval = true;
        task.approval = {
          type: "lease_expired",
          attemptId: attempt.attemptId,
          workerId: attempt.workerId,
          requestedAt: new Date(nowMs).toISOString(),
          reason: recoveryLimitExceeded
            ? `Automatic lease recovery limit (${this.leaseMaxRecoveryAttempts()}) reached`
            : "Task may have external side effects or has no explicit retry-safe policy",
        };
        this.createIntervention(task, {
          kind: "lease_expiry",
          question: recoveryLimitExceeded
            ? `执行租约再次过期，已达到自动恢复上限 ${this.leaseMaxRecoveryAttempts()} 次，需要人工确认。`
            : "执行租约已过期。该任务未声明可安全重试，需要人工确认后才能重新派发。",
          requestedBy: "system",
          requesterRole: task.role ?? "system",
          allowedActions: ["approve", "reject"],
          continuation: { type: "retry_task", taskId: task.taskId },
          context: { reason: task.approval.reason },
        });
        await this.recordEvent("task.lease_expired_needs_approval", {
          taskId: task.taskId,
          attemptId: attempt.attemptId,
          workerId: attempt.workerId,
          recoveryLimitExceeded,
        });
      }
      this.markTask(task);
    }
    if (!changed) return;
    await this.retryQueuedTasks();
    await this.commitAndDispatch();
  }

  canRetryExpiredTask(task) {
    const policy = task.taskSpec?.execution_policy ?? task.taskSpec?.executionPolicy ?? {};
    const sideEffects = String(policy.side_effects ?? policy.sideEffects ?? "unknown").toLowerCase();
    const onExpiry = String(policy.on_lease_expiry ?? policy.onLeaseExpiry ?? "").toLowerCase();
    if (onExpiry === "human") return false;
    if (onExpiry === "retry") return sideEffects === "none" || sideEffects === "idempotent";
    return sideEffects === "none" || sideEffects === "idempotent";
  }

  async registerArtifact(body, actor) {
    if (!this.artifactStore) throw httpError(404, "Artifact Store is not enabled");
    if (actor?.kind !== "worker") throw httpError(403, "Worker identity required");
    const task = this.tasks.get(String(body.taskId ?? ""));
    if (!task) throw httpError(404, "Unknown artifact task");
    const attemptId = String(body.attemptId ?? "");
    const attempt = this.attempts.get(attemptId);
    if (!attempt || task.currentAttemptId !== attemptId || attempt.taskId !== task.taskId) throw httpError(409, "Artifact attempt is not current");
    if (attempt.workerId !== actor.agentId || task.targetAgentId !== actor.agentId) throw httpError(403, "Worker does not own this task attempt");

    const expectedPath = normalizeArtifactPath(body.path);
    const declared = [...new Set(extractArtifactPaths(task.taskSpec).map(normalizeArtifactPath))];
    if (!declared.some((item) => isDeclaredArtifactPath(expectedPath, item))) throw httpError(403, "Artifact path is not declared by the Task Spec");
    const requestedStatus = body.status === "missing" ? "missing" : "uploading";
    const size = requestedStatus === "missing" ? null : Number(body.size);
    const sha256 = requestedStatus === "missing" ? null : String(body.sha256 ?? "").toLowerCase();
    if (requestedStatus === "uploading") {
      if (!Number.isSafeInteger(size) || size < 0) throw httpError(400, "Artifact size must be a non-negative integer");
      if (size > this.artifactStore.maxFileBytes) throw httpError(413, "Artifact exceeds the configured size limit");
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw httpError(400, "Artifact SHA-256 is invalid");
    }

    const existing = [...this.artifacts.values()].find((item) => item.attemptId === attemptId && item.path === expectedPath);
    if (existing) {
      if (existing.size !== size || existing.sha256 !== sha256) {
        throw httpError(409, "Artifact metadata conflicts with an existing upload");
      }
      if (existing.status === "invalid" && requestedStatus === "uploading") {
        existing.status = "uploading";
        existing.storageKey = this.artifactStore.createStorageKey();
        existing.invalidReason = null;
        existing.updatedAt = new Date().toISOString();
        this.markArtifact(existing);
        await this.recordEvent("artifact.upload_retried", { actor: actor.id, artifactId: existing.artifactId, taskId: task.taskId });
        await this.flushState();
      } else if (existing.status !== requestedStatus && existing.status !== "ready") {
        throw httpError(409, "Artifact metadata conflicts with an existing upload");
      }
      return this.publicArtifact(existing);
    }

    const artifact = {
      artifactId: randomUUID(),
      taskId: task.taskId,
      rootTaskId: task.rootTaskId,
      attemptId,
      workerId: actor.agentId,
      path: expectedPath,
      originalName: expectedPath.split("/").at(-1),
      size,
      sha256,
      status: requestedStatus,
      storageKey: requestedStatus === "uploading" ? this.artifactStore.createStorageKey() : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.artifacts.set(artifact.artifactId, artifact);
    this.markArtifact(artifact);
    await this.recordEvent("artifact.registered", {
      actor: actor.id,
      artifactId: artifact.artifactId,
      taskId: task.taskId,
      attemptId,
      path: expectedPath,
      status: artifact.status,
    });
    await this.flushState();
    return this.publicArtifact(artifact);
  }

  async receiveArtifact(request, artifactId, actor) {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw httpError(404, "Unknown artifact");
    if (actor?.kind !== "worker" || artifact.workerId !== actor.agentId) throw httpError(403, "Artifact upload is not authorized");
    const attempt = this.attempts.get(artifact.attemptId);
    const task = this.tasks.get(artifact.taskId);
    if (!attempt || !task || task.currentAttemptId !== attempt.attemptId || attempt.workerId !== actor.agentId) {
      throw httpError(409, "Artifact attempt is no longer current");
    }
    if (artifact.status === "ready") {
      request.resume();
      return this.publicArtifact(artifact);
    }
    if (artifact.status !== "uploading") throw httpError(409, `Artifact cannot be uploaded from status ${artifact.status}`);
    try {
      await this.artifactStore.receive(request, artifact);
      artifact.status = "ready";
      artifact.readyAt = new Date().toISOString();
      artifact.updatedAt = artifact.readyAt;
    } catch (error) {
      artifact.status = "invalid";
      artifact.invalidReason = String(error.message ?? error).slice(0, 500);
      artifact.updatedAt = new Date().toISOString();
      this.markArtifact(artifact);
      await this.recordEvent("artifact.invalid", { actor: actor.id, artifactId, taskId: artifact.taskId, reason: artifact.invalidReason });
      await this.flushState();
      throw error;
    }
    this.markArtifact(artifact);
    await this.recordEvent("artifact.ready", { actor: actor.id, artifactId, taskId: artifact.taskId, size: artifact.size, sha256: artifact.sha256 });
    await this.flushState();
    return this.publicArtifact(artifact);
  }

  publicArtifact(artifact) {
    const { storageKey: _storageKey, workerId: _workerId, invalidReason: _invalidReason, ...safe } = artifact;
    return {
      ...safe,
      ...(artifact.status === "ready" ? { downloadUrl: `/v1/artifacts/${artifact.artifactId}/content` } : {}),
    };
  }

  canReadArtifact(actor, artifact) {
    if (actor?.kind === "web") return actor.role === "admin" || actor.role === "operator";
    if (actor?.kind !== "worker") return false;
    if (artifact.workerId === actor.agentId) return true;
    return [...this.tasks.values()].some((task) => task.rootTaskId === artifact.rootTaskId
      && task.targetAgentId === actor.agentId
      && task.contextBundle?.artifactReferences?.some((item) => item.artifactId === artifact.artifactId));
  }

  validateTaskArtifacts(task, message) {
    if (!this.artifactStore || message.type !== "task.result") return null;
    const declared = [...new Set(extractArtifactPaths(task.taskSpec).map(normalizeArtifactPath))];
    const files = message.payload?.artifacts?.files ?? [];
    const normalizedFiles = files.map((file) => ({ file, path: normalizeArtifactPath(file.path) }));
    for (const expectedPath of declared) {
      if (!normalizedFiles.some((item) => isDeclaredArtifactPath(item.path, expectedPath))) {
        return { name: "ArtifactValidationError", message: `Required artifact is not ready: ${expectedPath}` };
      }
    }
    for (const item of normalizedFiles) {
      if (!declared.some((expectedPath) => isDeclaredArtifactPath(item.path, expectedPath))) {
        return { name: "ArtifactValidationError", message: `Undeclared artifact in task result: ${item.file.path}` };
      }
      const stored = item.file.artifactId ? this.artifacts.get(item.file.artifactId) : null;
      if (item.file.status !== "ready" || !stored || stored.status !== "ready"
        || stored.taskId !== task.taskId || stored.attemptId !== message.payload?.attemptId
        || stored.path !== item.path || stored.sha256 !== item.file.sha256 || stored.size !== item.file.size) {
        return { name: "ArtifactValidationError", message: `Required artifact is not ready: ${item.path}` };
      }
    }
    return null;
  }

  async handleHttp(request, response) {
    let requestActor = null;
    try {
      const url = new URL(request.url ?? "/", this.url());
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, this.storageFault ? 503 : 200, {
          ok: !this.storageFault,
          protocolVersion: 1,
          now: new Date().toISOString(),
          storage: {
            driver: this.store.constructor.name,
            healthy: !this.storageFault,
            error: this.storageFault?.message ?? null,
          },
          leases: {
            enabled: this.leasesEnabled(),
            ttlMs: this.leasesEnabled() ? this.leaseTtlMs() : null,
          },
        });
      }
      if (this.storageFault) return json(response, 503, { error: this.storageFault.message });
      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        if (!this.authService) return json(response, 404, { error: "Identity authentication is not enabled" });
        const body = await readBody(request);
        const login = await this.authService.login(body.username, body.password, { clientIp: clientIpForRequest(request, this.config.auth) });
        requestActor = login.actor;
        await this.recordEvent("auth.login", { actor: login.actor.id, result: "success" });
        await this.flushState();
        return json(response, 200, {
          user: publicActor(login.actor),
          csrfToken: login.csrfToken,
          expiresAt: login.expiresAt,
        }, { "set-cookie": [login.cookie, login.csrfCookie] });
      }

      const artifactRoute = url.pathname.match(/^\/v1\/artifacts\/([0-9a-f-]{36})(?:\/(content))?$/i);
      const artifactRequest = url.pathname === "/v1/artifacts" || url.pathname === "/v1/attachments" || Boolean(artifactRoute);
      let actor;
      const legacyArtifactAgentId = artifactRequest && !this.authService
        ? normalizeLegacyArtifactAgentId(request.headers["x-a446-agent-id"])
        : null;
      if (legacyArtifactAgentId && this.authorized(request.headers.authorization)) {
        actor = {
          kind: "worker",
          id: `legacy-worker:${legacyArtifactAgentId}`,
          role: "worker",
          agentId: legacyArtifactAgentId,
          legacy: true,
        };
      } else {
        actor = await this.authenticateHttpRequest(request);
        if (!actor && artifactRequest && this.authService) actor = await this.authService.authenticateWorker(request.headers.authorization);
      }
      if (!actor) return json(response, 401, { error: "Unauthorized", code: "AUTH_REQUIRED" });
      requestActor = actor;

      if (request.method === "GET" && url.pathname === "/v1/auth/me") {
        if (actor.kind !== "web") return json(response, 403, { error: "Web user session required", code: "FORBIDDEN" });
        const users = actor.userId && this.authService?.listUsers ? await this.authService.listUsers() : [];
        const currentUser = users.find((user) => (user.id ?? user.userId) === actor.userId);
        return json(response, 200, { user: currentUser ? publicUser(currentUser) : publicActor(actor) });
      }
      if (request.method === "POST" && url.pathname === "/v1/auth/logout") {
        this.requireWebMutation(request, actor);
        const cookies = await this.authService.logout(actor);
        await this.recordEvent("auth.logout", { actor: actor.id, result: "success" });
        await this.flushState();
        return json(response, 200, { ok: true }, { "set-cookie": [cookies.sessionCookie, cookies.csrfCookie] });
      }

      if (request.method === "POST" && url.pathname === "/v1/attachments") {
        if (!this.artifactStore) throw httpError(503, "Artifact storage is not enabled", "STORAGE_NOT_CONFIGURED");
        if (actor.kind !== "web" && actor.role !== "admin" && actor.role !== "operator") {
          throw httpError(403, "Web operator session required to upload attachments", "FORBIDDEN");
        }
        if (this.authService) this.requireWebMutation(request, actor);
        const rawFilename = url.searchParams.get("filename") ?? request.headers["x-file-name"] ?? "attachment.bin";
        const cleanName = path.posix.basename(String(rawFilename).replace(/[\r\n\0]/g, "")).trim() || "attachment.bin";
        const artifactId = randomUUID();
        const storageKey = this.artifactStore.createStorageKey();
        const artifact = {
          artifactId,
          taskId: null,
          rootTaskId: null,
          attemptId: null,
          workerId: null,
          uploadedBy: actor.id ?? actor.username ?? "web",
          path: cleanName,
          originalName: cleanName,
          status: "uploading",
          storageKey,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const result = await this.artifactStore.receive(request, artifact);
        artifact.size = result.size;
        artifact.sha256 = result.sha256;
        artifact.status = "ready";
        artifact.readyAt = new Date().toISOString();
        artifact.updatedAt = artifact.readyAt;
        this.artifacts.set(artifactId, artifact);
        this.markArtifact(artifact);
        await this.recordEvent("artifact.attachment_uploaded", {
          actor: actor.id,
          artifactId,
          path: cleanName,
          size: result.size,
          sha256: result.sha256,
        });
        await this.flushState();
        return json(response, 201, { artifact: this.publicArtifact(artifact) });
      }
      if (request.method === "POST" && url.pathname === "/v1/artifacts") {
        const artifact = await this.registerArtifact(await readBody(request), actor);
        return json(response, 201, { artifact });
      }
      if (request.method === "PUT" && artifactRoute?.[2] === "content") {
        const artifact = await this.receiveArtifact(request, artifactRoute[1], actor);
        return json(response, 200, { artifact });
      }
      if (request.method === "GET" && artifactRoute?.[2] === "content") {
        const artifact = this.artifacts.get(artifactRoute[1]);
        if (!artifact) return json(response, 404, { error: "Unknown artifact" });
        if (!this.canReadArtifact(actor, artifact)) return json(response, 403, { error: "Artifact download is not authorized" });
        if (artifact.status !== "ready") return json(response, 409, { error: `Artifact is ${artifact.status}` });
        try {
          const object = await this.artifactStore.open(artifact);
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": object.size,
            "content-disposition": contentDisposition(artifact.originalName),
            "x-artifact-sha256": artifact.sha256,
            "cache-control": "private, no-store",
          });
          object.stream.pipe(response);
          return;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          artifact.status = "missing";
          artifact.updatedAt = new Date().toISOString();
          this.markArtifact(artifact);
          await this.recordEvent("artifact.missing", { actor: actor.id, artifactId: artifact.artifactId, taskId: artifact.taskId });
          await this.flushState();
          return json(response, 404, { error: "Artifact object is missing" });
        }
      }
      if (request.method === "GET" && url.pathname === "/v1/artifacts") {
        const taskId = url.searchParams.get("taskId");
        const artifacts = [...this.artifacts.values()]
          .filter((artifact) => (!taskId || artifact.taskId === taskId) && this.canReadArtifact(actor, artifact))
          .map((artifact) => this.publicArtifact(artifact));
        return json(response, 200, { artifacts });
      }

      if (url.pathname.startsWith("/v1/admin/")) {
        this.requireAdmin(request, actor);
        if (request.method === "GET" && url.pathname === "/v1/admin/users") {
          return json(response, 200, { users: (await this.authService.listUsers()).map(publicUser) });
        }
        const userRoute = url.pathname.match(/^\/v1\/admin\/users\/([0-9a-f-]{36})$/i);
        if (request.method === "PATCH" && userRoute) {
          const body = await readBody(request);
          if (!["active", "disabled"].includes(body.status)) throw httpError(400, "status must be active or disabled", "VALIDATION_ERROR");
          const user = await this.authService.setUserStatus(userRoute[1], body.status);
          await this.recordEvent("user.status_changed", { actor: actor.id, userId: userRoute[1], status: body.status, result: "success" });
          await this.flushState();
          return json(response, 200, { user: publicUser(user) });
        }
        const revokeSessions = url.pathname.match(/^\/v1\/admin\/users\/([0-9a-f-]{36})\/revoke-sessions$/i);
        if (request.method === "POST" && revokeSessions) {
          const result = await this.authService.revokeUserSessions(revokeSessions[1]);
          const revokedSessions = typeof result === "number" ? result : result?.revokedSessions ?? 0;
          await this.recordEvent("user.sessions_revoked", { actor: actor.id, userId: revokeSessions[1], revokedSessions, result: "success" });
          await this.flushState();
          return json(response, 200, { ok: true, revokedSessions });
        }
        if (request.method === "GET" && url.pathname === "/v1/admin/workers") {
          return json(response, 200, { credentials: await this.authService.listWorkerCredentials() });
        }
        if (request.method === "POST" && url.pathname === "/v1/admin/workers") {
          const credential = await this.authService.createWorkerCredential(await readBody(request));
          await this.recordEvent("credential.created", { actor: actor.id, credentialId: credential.credentialId, agentId: credential.agentId, deviceId: credential.deviceId, result: "success" });
          await this.flushState();
          return json(response, 201, { credential });
        }
        const rotate = url.pathname.match(/^\/v1\/admin\/workers\/([0-9a-f-]{36})\/rotate$/i);
        if (request.method === "POST" && rotate) {
          const credential = await this.authService.rotateWorkerCredential(rotate[1]);
          this.disconnectCredential(rotate[1]);
          await this.recordEvent("credential.rotated", { actor: actor.id, previousCredentialId: rotate[1], credentialId: credential.credentialId, agentId: credential.agentId, result: "success" });
          await this.flushState();
          return json(response, 200, { credential });
        }
        const revoke = url.pathname.match(/^\/v1\/admin\/workers\/([0-9a-f-]{36})$/i);
        if (request.method === "DELETE" && revoke) {
          const credential = await this.authService.revokeWorkerCredential(revoke[1]);
          this.disconnectCredential(revoke[1]);
          await this.recordEvent("credential.revoked", { actor: actor.id, credentialId: credential.credentialId, agentId: credential.agentId, result: "success" });
          await this.flushState();
          return json(response, 200, { credential });
        }
        if (request.method === "POST" && url.pathname === "/v1/admin/users") {
          const body = await readBody(request);
          if (body.role === "admin") throw httpError(403, "Administrators cannot be created over HTTP", "ADMIN_HTTP_CREATION_FORBIDDEN");
          if (body.role != null && body.role !== "operator") throw httpError(400, "role must be operator", "VALIDATION_ERROR");
          const createOperator = this.authService.createOperator ?? this.authService.createUser;
          const user = await createOperator.call(this.authService, { ...body, role: "operator" });
          await this.recordEvent("user.created", { actor: actor.id, userId: user.userId ?? user.id, username: user.username, role: user.role, result: "success" });
          await this.flushState();
          return json(response, 201, { user: publicUser(user) });
        }
        return json(response, 404, { error: "Not found" });
      }

      if (actor.kind !== "web") return json(response, 403, { error: "Web user session required", code: "FORBIDDEN" });
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) this.requireWebMutation(request, actor);
      if (request.method === "GET" && url.pathname === "/v1/interventions") {
        const rootTaskId = url.searchParams.get("rootTaskId");
        const status = url.searchParams.get("status");
        const interventions = [...this.interventions.values()]
          .filter((item) => (!rootTaskId || item.rootTaskId === rootTaskId) && (!status || item.status === status))
          .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
          .map((item) => this.publicIntervention(item));
        return json(response, 200, { interventions });
      }
      const interventionResolveRoute = url.pathname.match(/^\/v1\/interventions\/([^/]{1,200})\/resolve$/i);
      if (request.method === "POST" && interventionResolveRoute) {
        const result = await this.resolveIntervention(decodeURIComponent(interventionResolveRoute[1]), await readBody(request), actor);
        return json(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/v1/agents") {
        return json(response, 200, { agents: [...this.agents.values()] });
      }
      if (request.method === "GET" && url.pathname === "/v1/update-jobs") {
        return json(response, 200, { jobs: this.updates.listJobs() });
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        return json(response, 200, { events: this.log.recent(url.searchParams.get("limit")) });
      }
      if (request.method === "GET" && url.pathname === "/v1/tasks") {
        const rootTaskId = url.searchParams.get("rootTaskId");
        const tasks = [...this.tasks.values()].filter((task) => !rootTaskId || task.rootTaskId === rootTaskId);
        return json(response, 200, { tasks: url.searchParams.get("view") === "summary" ? tasks.map(summarizeTask) : tasks, active: tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status)) });
      }
      const taskDetailRoute = url.pathname.match(/^\/v1\/tasks\/([0-9a-f-]{36})$/i);
      if (request.method === "GET" && taskDetailRoute) {
        const task = this.tasks.get(taskDetailRoute[1]);
        return task ? json(response, 200, { task }) : json(response, 404, { error: "Task not found", code: "NOT_FOUND" });
      }
      if (request.method === "GET" && url.pathname === "/v1/attempts") {
        const taskId = url.searchParams.get("taskId");
        const attempts = [...this.attempts.values()].filter((attempt) => !taskId || attempt.taskId === taskId);
        return json(response, 200, { attempts });
      }
      if (request.method === "GET" && url.pathname === "/v1/conversations") {
        const lifecycle = url.searchParams.get("lifecycle") ?? "active";
        if (!["active", "archived", "trashed", "all"].includes(lifecycle)) {
          return json(response, 400, { error: "lifecycle must be one of active, archived, trashed, all", code: "VALIDATION_ERROR" });
        }
        return json(response, 200, { conversations: this.conversations({ lifecycle }) });
      }
      const conversationArchiveRoute = url.pathname.match(/^\/v1\/conversations\/([0-9a-f-]{36})\/archive$/i);
      if (request.method === "POST" && conversationArchiveRoute) {
        const result = await this.lifecycle.archive(conversationArchiveRoute[1], actor);
        return json(response, 200, result);
      }
      const conversationRestoreRoute = url.pathname.match(/^\/v1\/conversations\/([0-9a-f-]{36})\/restore$/i);
      if (request.method === "POST" && conversationRestoreRoute) {
        const result = await this.lifecycle.restore(conversationRestoreRoute[1], actor);
        return json(response, 200, result);
      }
      const conversationTrashRoute = url.pathname.match(/^\/v1\/conversations\/([0-9a-f-]{36})$/i);
      if (request.method === "DELETE" && conversationTrashRoute) {
        const result = await this.lifecycle.trash(conversationTrashRoute[1], actor);
        return json(response, 200, result);
      }
      const trashRestoreRoute = url.pathname.match(/^\/v1\/trash\/([0-9a-f-]{36})\/restore$/i);
      if (request.method === "POST" && trashRestoreRoute) {
        const result = await this.lifecycle.restoreFromTrash(trashRestoreRoute[1], actor);
        return json(response, 200, result);
      }
      const trashPurgeRoute = url.pathname.match(/^\/v1\/trash\/([0-9a-f-]{36})$/i);
      if (request.method === "DELETE" && trashPurgeRoute) {
        const result = await this.lifecycle.purge(trashPurgeRoute[1], actor);
        return json(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/v1/messages") {
        const rootTaskId = url.searchParams.get("rootTaskId");
        const messages = this.messages.filter((message) => !rootTaskId || message.rootTaskId === rootTaskId);
        return json(response, 200, { messages: url.searchParams.get("view") === "summary" ? messages.map(summarizeMessage) : messages });
      }
      const messageDetailRoute = url.pathname.match(/^\/v1\/messages\/([0-9a-f-]{36})$/i);
      if (request.method === "GET" && messageDetailRoute) {
        const message = this.messages.find((item) => item.messageId === messageDetailRoute[1]);
        return message ? json(response, 200, { message }) : json(response, 404, { error: "Message not found", code: "NOT_FOUND" });
      }
      if (request.method === "GET" && url.pathname === "/v1/usage") {
        const byAgent = [...this.agents.values()].map((agent) => ({
          agentId: agent.agentId,
          deviceId: agent.deviceId,
          account: agent.account,
          usageTotals: agent.usageTotals ?? null,
          quotaSnapshot: agent.quotaSnapshot ?? null,
        }));
        const accounts = new Map();
        for (const item of byAgent) {
          const key = `${item.account?.provider ?? "unknown"}:${item.account?.id ?? item.agentId}`;
          const current = accounts.get(key) ?? {
            accountKey: key,
            account: item.account,
            agentIds: [],
            deviceIds: [],
            usageTotals: null,
            quotaSnapshot: null,
          };
          current.agentIds.push(item.agentId);
          if (!current.deviceIds.includes(item.deviceId)) current.deviceIds.push(item.deviceId);
          if (item.usageTotals) current.usageTotals = addUsage(current.usageTotals, item.usageTotals);
          if (item.quotaSnapshot && isPreferredQuotaSnapshot(item.quotaSnapshot, current.quotaSnapshot)) {
            current.quotaSnapshot = item.quotaSnapshot;
          }
          accounts.set(key, current);
        }
        return json(response, 200, { totals: this.usageTotals, byAgent, byAccount: [...accounts.values()] });
      }
      if (request.method === "POST" && url.pathname === "/v1/workflows") {
        const body = await readBody(request);
        const task = await this.createWorkflow({ ...body, sourceAgentId: actor.id });
        await this.commitAndDispatch();
        return json(response, 202, { task });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        const body = await readBody(request);
        if (typeof body.text !== "string" || !body.text.trim()) return json(response, 400, { error: "message text is required" });
        const task = this.tasks.get(body.taskId ?? body.rootTaskId);
        if (!task || task.rootTaskId !== String(body.rootTaskId ?? task.rootTaskId)) return json(response, 404, { error: "Unknown task conversation" });
        const message = this.addMessage(task, {
          senderId: actor.id,
          senderRole: "human",
          kind: "message",
          text: body.text.trim(),
          mentions: body.mentions,
        });
        await this.flushState();
        return json(response, 201, { message });
      }
      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        const body = await readBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return json(response, 400, { error: "Request body must be a JSON object" });
        }
        if (typeof body.input !== "string" || !body.input.trim() || (!body.targetAgentId && !body.role)) {
          return json(response, 400, { error: "string input and targetAgentId or role are required" });
        }

        let root = null;
        if (body.rootTaskId) {
          const referenced = this.tasks.get(String(body.rootTaskId));
          if (!referenced) {
            return json(response, 404, { error: `Unknown rootTaskId: ${body.rootTaskId}` });
          }
          if ((referenced.rootTaskId && referenced.rootTaskId !== referenced.taskId) || Boolean(referenced.parentTaskId)) {
            return json(response, 400, {
              error: `Task ${body.rootTaskId} is a child task, not a root task. rootTaskId must reference the root workflow task.`,
            });
          }
          root = this.getCanonicalRootTask(referenced) ?? referenced;
          if (root.status === "completed" || root.status === "cancelled" || root.forceCompleted) {
            return json(response, 400, { error: "Cannot add task to a completed or cancelled workflow" });
          }
        }

        const task = this.createTask({
          input: body.input.trim(),
          targetAgentId: body.targetAgentId ? String(body.targetAgentId) : null,
          role: body.role ? String(body.role) : null,
          rootTaskId: root ? root.taskId : null,
          parentTaskId: root ? root.taskId : null,
          workflow: root?.workflow ?? null,
          quotaReserved: false,
          forceCompleted: null,
          superseded: false,
          revision: 1,
          reviewCycle: 0,
          attemptNumber: 0,
          currentAttemptId: null,
          recoveryCount: 0,
          status: body.requiresApproval ? "awaiting_approval" : "queued",
          sourceAgentId: actor.id,
          sourceRole: actor.role === "admin" || actor.id === "human" || actor.id.startsWith("user:") ? "human" : "agent",
          requiredCapabilities: Array.isArray(body.requiredCapabilities) ? body.requiredCapabilities.map(String) : [],
          modelPreference: body.modelPreference ?? body.model ?? null,
          reasoningEffort: body.reasoningEffort ?? null,
          taskSpec: body.taskSpec && typeof body.taskSpec === "object" ? body.taskSpec : null,
          metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
          route: Array.isArray(body.route) ? body.route.map(String) : [],
          requiresApproval: Boolean(body.requiresApproval),
        });
        await this.queueOrDispatch(task);
        await this.commitAndDispatch();
        return json(response, 202, { task });
      }
      if (request.method === "POST" && url.pathname === "/v1/commands") {
        const body = await readBody(request);
        const result = await this.handleCommand(body, actor);
        await this.commitAndDispatch();
        return json(response, 200, result);
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      if (!this.storageFault) {
        try {
          await this.recordEvent("http.error", {
            actor: requestActor?.id ?? "anonymous",
            method: request.method,
            path: new URL(request.url ?? "/", this.url()).pathname,
            result: "error",
            error: safeError(error),
          });
          await this.flushState();
        } catch {}
      }
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return json(response, statusCode, {
        error: error.message,
        code: error.code ?? httpErrorCode(statusCode),
        ...(error.details && typeof error.details === "object" ? { details: error.details } : {}),
        ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
      }, error.headers ?? {});
    }
  }

  requireWebMutation(request, actor) {
    if (actor?.kind !== "web") throw httpError(403, "Web user session required", "FORBIDDEN");
    if (!actor.legacy) {
      try {
        this.authService.verifyCsrf(request, actor);
      } catch (error) {
        if (error.statusCode === 403 && !error.code) error.code = "CSRF_FAILED";
        throw error;
      }
    }
  }

  disconnectCredential(credentialId) {
    for (const connection of this.connections.values()) {
      if (connection.a446Actor?.credentialId === credentialId) connection.close(4003, "Worker credential revoked");
    }
  }

  requireAdmin(request, actor) {
    if (actor?.kind !== "web" || actor.role !== "admin") throw httpError(403, "Administrator role required", "FORBIDDEN");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET")) this.requireWebMutation(request, actor);
  }

  async handleCommand(command, actor = { id: "human", role: "admin" }) {
    if (command.type === "device.update.request") {
      if (actor.role !== "admin") throw httpError(403, "Administrator role required for device updates");
      return this.updates.request(command, actor);
    }
    if (command.type === "intervention.resolve") {
      return this.resolveIntervention(String(command.interventionId ?? ""), command, actor);
    }
    if (command.type === "workflow.human_response") {
      const root = this.tasks.get(command.rootTaskId);
      if (!root || root.rootTaskId !== root.taskId) throw httpError(404, `Unknown workflow ${command.rootTaskId}`);
      const response = String(command.response ?? "").trim();
      if (!response) throw httpError(400, "Human response is required");
      let intervention = [...this.interventions.values()].find((item) => item.rootTaskId === root.taskId && item.status === "pending" && item.kind === "workflow_input");
      if (!intervention && root.humanIntervention?.status === "required") {
        intervention = this.requireHuman(root, root.humanIntervention.question);
      }
      if (!intervention) throw httpError(409, `Workflow ${command.rootTaskId} is not awaiting human input`);
      return this.resolveIntervention(intervention.interventionId, { decision: "respond", response }, actor);
    }
    if (command.type === "task.approve") {
      if (actor.role !== "admin") throw httpError(403, "Administrator role required for task approval");
      const task = this.tasks.get(command.taskId);
      if (!task) throw httpError(404, `Unknown task ${command.taskId}`);
      if (task.status !== "awaiting_approval" || !task.requiresApproval) {
        throw httpError(409, `Task ${command.taskId} is not awaiting approval`);
      }
      const intervention = [...this.interventions.values()].find((item) => item.taskId === task.taskId && item.status === "pending" && item.continuation?.type === "retry_task");
      if (intervention) return this.resolveIntervention(intervention.interventionId, { decision: "approve" }, actor);
      task.requiresApproval = false;
      task.approval = { ...(task.approval ?? {}), approvedAt: new Date().toISOString(), approvedBy: actor.id };
      this.markTask(task);
      await this.queueOrDispatch(task);
      await this.recordEvent("task.approved", { taskId: task.taskId, actor: actor.id });
      return { ok: true, task };
    }
    if (["agent.pause", "agent.resume"].includes(command.type)) {
      if (actor.role !== "admin") throw httpError(403, "Administrator role required for agent control");
      const agent = this.agents.get(command.targetAgentId);
      if (!agent) throw httpError(404, `Unknown Agent ${command.targetAgentId}`, "NOT_FOUND");
      agent.paused = command.type === "agent.pause";
      this.markAgent(agent);
      this.deliver(command.targetAgentId, makeEnvelope(command.type, { agentId: command.targetAgentId }));
      if (command.type === "agent.resume") {
        for (const task of this.tasks.values()) {
          if (task.targetAgentId === command.targetAgentId && task.status === "queued") await this.queueOrDispatch(task);
        }
      }
      await this.recordEvent(command.type, { actor: actor.id, agentId: command.targetAgentId });
      return { ok: true, agent };
    }
    if (command.type === "task.cancel") {
      if (actor.role !== "admin") throw httpError(403, "Administrator role required for task cancellation");
      const task = this.tasks.get(command.taskId);
      if (!task) throw httpError(404, `Unknown task ${command.taskId}`);
      if (!ACTIVE_TASK_STATUSES.has(task.status)) {
        throw httpError(409, `Task ${command.taskId} cannot be cancelled from status ${task.status}`);
      }
      task.status = "cancelled";
      task.completedAt = new Date().toISOString();
      const attempt = this.currentAttempt(task);
      if (attempt && ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
        attempt.status = "cancelled";
        attempt.completedAt = task.completedAt;
        this.markAttempt(attempt);
      }
      this.finishTaskActivity(task);
      this.markTask(task);
      const closedCount = this.closePendingInterventions(task, actor.id, "Task cancelled by an administrator");
      if (task.targetAgentId) {
        this.deliver(task.targetAgentId, makeEnvelope("task.cancel", {
          agentId: task.targetAgentId,
          taskId: task.taskId,
          payload: { attemptId: task.currentAttemptId ?? null },
        }));
      }
      await this.recordEvent("task.cancelled", { actor: actor.id, taskId: task.taskId, agentId: task.targetAgentId, attemptId: task.currentAttemptId ?? null });
      if (task.workflow?.enabled && !task.forceCompleted && !this.getCanonicalRootTask(task.rootTaskId)?.forceCompleted) {
        const hasOtherPending = [...this.interventions.values()].some(
          (item) => item.rootTaskId === (task.rootTaskId ?? task.taskId) && item.status === "pending"
        );
        if (closedCount === 0 && !hasOtherPending && task.taskId !== task.rootTaskId) {
          this.requireHuman(task, `子任务 '${task.taskSpec?.title ?? task.taskId}' 已被人工取消。工作流已暂停，请人工介入审查。`);
        }
      }
      await this.retryQueuedTasks();
      return { ok: true, task };
    }
    if (command.type === "workflow.replan") {
      const root = this.tasks.get(command.rootTaskId);
      if (!root || root.rootTaskId !== root.taskId) throw httpError(404, `Unknown workflow ${command.rootTaskId}`);
      if (root.status === "completed" || root.status === "cancelled" || root.forceCompleted) {
        throw httpError(400, "Cannot replan a completed or cancelled workflow");
      }
      const reservation = this.reserveWorkflowInvocations(root.taskId, 1);
      if (!reservation.ok) {
        throw httpError(400, `工作流累计任务调用已达上限（50次），无法重新规划：${reservation.error}`);
      }

      // Cancel and supersede any active child tasks from previous plan
      for (const t of this.tasks.values()) {
        if (t.rootTaskId === root.taskId && t.taskId !== root.taskId && ACTIVE_TASK_STATUSES.has(t.status)) {
          t.status = "cancelled";
          t.superseded = true;
          t.completedAt = new Date().toISOString();
          this.finishTaskActivity(t);
          this.markTask(t);
          if (t.targetAgentId) {
            this.deliver(t.targetAgentId, makeEnvelope("task.cancel", {
              agentId: t.targetAgentId,
              taskId: t.taskId,
              payload: { attemptId: t.currentAttemptId ?? null },
            }));
          }
        }
      }
      const plannerId = root.workflow?.plannerAgentId ?? (root.role === "planner" ? root.targetAgentId : null);
      if (!plannerId) {
        this.refundWorkflowInvocation(root.taskId, 1);
        throw httpError(400, "Workflow does not specify a planner Agent");
      }
      const replanModel = command.modelPreference
        ?? root.workflow?.plannerModelPreference
        ?? root.workflow?.stageModels?.planner?.modelPreference
        ?? root.modelPreference
        ?? null;
      const replanReasoning = command.reasoningEffort
        ?? root.workflow?.plannerReasoningEffort
        ?? root.workflow?.stageModels?.planner?.reasoningEffort
        ?? root.reasoningEffort
        ?? null;
      const replanTask = this.createTask({
        targetAgentId: plannerId,
        input: command.instructions || "用户要求对当前工作流重新进行任务规划。",
        rootTaskId: root.taskId,
        parentTaskId: root.taskId,
        sourceAgentId: actor.id,
        role: "planner",
        stage: "replan",
        quotaReserved: true,
        workflow: root.workflow,
        sessionScopeId: root.sessionScopeId ?? root.taskId,
        modelPreference: replanModel,
        reasoningEffort: replanReasoning,
        taskSpec: {
          title: "人工触发重新规划",
          type: "replan",
          priority: "P1",
          permissions_required: { project_workspace: true },
          acceptance: [],
        },
        contextBundle: {
          reason: command.reason || "workflow_stalled",
          requestedBy: actor.id,
          schedulerCatalog: this.schedulerCatalog(),
        },
      });
      await this.queueOrDispatch(replanTask);
      await this.recordEvent("workflow.manual_replan", { actor: actor.id, rootTaskId: root.taskId, taskId: replanTask.taskId });
      return { ok: true, task: replanTask };
    }
    if (command.type === "workflow.force_complete") {
      if (actor.role !== "admin") throw httpError(403, "Administrator role required for force completion");
      const root = this.tasks.get(command.rootTaskId);
      if (!root || root.rootTaskId !== root.taskId) throw httpError(404, `Unknown workflow ${command.rootTaskId}`);
      const resolvedAt = new Date().toISOString();

      const workflowTasks = [...this.tasks.values()].filter((t) => t.rootTaskId === root.taskId && t.taskId !== root.taskId);
      for (const t of workflowTasks) {
        if (!TERMINAL_TASK_STATUSES.has(t.status)) {
          t.status = "cancelled";
          t.completedAt = resolvedAt;
          if (t.currentAttemptId) {
            const attempt = this.attempts.get(t.currentAttemptId);
            if (attempt && !TERMINAL_TASK_STATUSES.has(attempt.status)) {
              attempt.status = "cancelled";
              attempt.completedAt = resolvedAt;
              this.markAttempt(attempt);
            }
          }
          this.finishTaskActivity(t);
          this.markTask(t);
          if (t.targetAgentId) {
            this.deliver(t.targetAgentId, makeEnvelope("task.cancel", {
              agentId: t.targetAgentId,
              taskId: t.taskId,
              payload: { attemptId: t.currentAttemptId ?? null },
            }));
          }
        }
      }

      for (const intervention of this.interventions.values()) {
        if (intervention.rootTaskId !== root.taskId || intervention.status !== "pending") continue;
        intervention.status = "resolved";
        intervention.decision = "reject";
        intervention.response = "Workflow force-completed by administrator";
        intervention.resolvedAt = resolvedAt;
        intervention.resolvedBy = actor.id;
        intervention.updatedAt = resolvedAt;
        this.markIntervention(intervention, { allowedStatuses: ["pending"] });
      }
      this.syncRootIntervention(root.taskId);

      root.status = "completed";
      root.completedAt = resolvedAt;
      root.workflowDecision = "complete";
      root.forceCompleted = { completedAt: resolvedAt, completedBy: actor.id, reason: command.reason || "admin_force_complete" };
      this.finishTaskActivity(root);
      this.markTask(root);

      this.queueEvent("workflow.completed", { rootTaskId: root.taskId, forceCompleted: true });
      await this.recordEvent("workflow.force_completed", { actor: actor.id, rootTaskId: root.taskId });
      await this.retryQueuedTasks();
      return { ok: true, task: root };
    }
    throw httpError(400, `Unsupported command type: ${command.type}`);
  }
}

function createDirtyState() {
  return {
    tasks: new Map(),
    taskGuards: new Map(),
    messages: new Map(),
    agents: new Map(),
    attempts: new Map(),
    artifacts: new Map(),
    interventions: new Map(),
    interventionGuards: new Map(),
    deliveries: new Map(),
    deletedDeliveries: new Map(),
    inboundMessages: new Map(),
    auditEvents: new Map(),
    updateJobs: new Map(),
    lifecycles: new Map(),
    tombstones: new Map(),
    removals: new Map(),
    metadata: false,
  };
}

function hasDirtyState(dirty) {
  return dirty.metadata
    || dirty.tasks.size > 0
    || dirty.messages.size > 0
    || dirty.agents.size > 0
    || dirty.attempts.size > 0
    || dirty.artifacts.size > 0
    || dirty.interventions.size > 0
    || dirty.deliveries.size > 0
    || dirty.deletedDeliveries.size > 0
    || dirty.inboundMessages.size > 0
    || dirty.auditEvents.size > 0
    || dirty.updateJobs.size > 0
    || dirty.lifecycles.size > 0
    || dirty.tombstones.size > 0
    || dirty.removals.size > 0;
}

function takeDirtyState(hub) {
  const dirty = hub.dirty;
  hub.dirty = createDirtyState();
  return {
    tasks: structuredClone([...dirty.tasks.values()]),
    taskGuards: structuredClone(Object.fromEntries(dirty.taskGuards)),
    messages: structuredClone([...dirty.messages.values()]),
    agents: structuredClone([...dirty.agents.values()]),
    attempts: structuredClone([...dirty.attempts.values()]),
    artifacts: structuredClone([...dirty.artifacts.values()]),
    interventions: structuredClone([...dirty.interventions.values()]),
    interventionGuards: structuredClone(Object.fromEntries(dirty.interventionGuards)),
    deliveries: structuredClone([...dirty.deliveries.values()]),
    deletedDeliveries: structuredClone([...dirty.deletedDeliveries.values()]),
    inboundMessages: structuredClone([...dirty.inboundMessages.values()]),
    auditEvents: structuredClone([...dirty.auditEvents.values()]),
    updateJobs: structuredClone([...dirty.updateJobs.values()]),
    lifecycles: structuredClone([...dirty.lifecycles.values()]),
    tombstones: structuredClone([...dirty.tombstones.values()]),
    removals: Object.fromEntries([...dirty.removals.entries()].map(([kind, ids]) => [kind, [...ids]])),
    ...(dirty.metadata ? {
      metadata: {
        messageSeq: hub.messageSeq,
        usageTotals: structuredClone(hub.usageTotals),
      },
    } : {}),
  };
}

function mergeDirtyState(dirty, changes) {
  for (const task of changes.tasks ?? []) dirty.tasks.set(task.taskId, task);
  for (const [taskId, guard] of Object.entries(changes.taskGuards ?? {})) dirty.taskGuards.set(taskId, guard);
  for (const message of changes.messages ?? []) dirty.messages.set(message.messageId, message);
  for (const agent of changes.agents ?? []) dirty.agents.set(agent.agentId, agent);
  for (const attempt of changes.attempts ?? []) dirty.attempts.set(attempt.attemptId, attempt);
  for (const artifact of changes.artifacts ?? []) dirty.artifacts.set(artifact.artifactId, artifact);
  for (const intervention of changes.interventions ?? []) dirty.interventions.set(intervention.interventionId, intervention);
  for (const [interventionId, guard] of Object.entries(changes.interventionGuards ?? {})) dirty.interventionGuards.set(interventionId, guard);
  for (const delivery of changes.deliveries ?? []) dirty.deliveries.set(deliveryKey(delivery.agentId, delivery.envelope.id), delivery);
  for (const delivery of changes.deletedDeliveries ?? []) {
    const key = deliveryKey(delivery.agentId, delivery.messageId);
    dirty.deliveries.delete(key);
    dirty.deletedDeliveries.set(key, delivery);
  }
  for (const message of changes.inboundMessages ?? []) dirty.inboundMessages.set(message.messageId, message);
  for (const event of changes.auditEvents ?? []) dirty.auditEvents.set(event.seq, event);
  for (const job of changes.updateJobs ?? []) dirty.updateJobs.set(job.jobId, job);
  for (const record of changes.lifecycles ?? []) dirty.lifecycles.set(record.rootTaskId, record);
  for (const stone of changes.tombstones ?? []) dirty.tombstones.set(stone.rootTaskId, stone);
  for (const [kind, ids] of Object.entries(changes.removals ?? {})) {
    let set = dirty.removals.get(kind);
    if (!set) {
      set = new Set();
      dirty.removals.set(kind, set);
    }
    for (const id of ids) set.add(id);
  }
  if (changes.metadata) dirty.metadata = true;
}

function deliveryKey(agentId, messageId) {
  return `${agentId}:${messageId}`;
}

function toArtifactReference(file) {
  return {
    artifactId: file.artifactId,
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    status: file.status,
  };
}

function minimalInterventionContext(root, task, extra = {}) {
  const acceptance = Array.isArray(root.taskSpec?.acceptance)
    ? root.taskSpec.acceptance.map((item) => String(item).slice(0, 1000)).slice(0, 50)
    : [];
  return {
    objective: String(extra?.objective ?? root.contextBundle?.objective ?? root.input ?? "").slice(0, 20_000),
    acceptance,
    taskTitle: String(task.taskSpec?.title ?? task.input ?? "").slice(0, 500),
    ...(extra?.reason ? { reason: String(extra.reason).slice(0, 2000) } : {}),
  };
}

function normalizeStoredIntervention(stored, tasks) {
  const rootTaskId = String(stored.rootTaskId ?? stored.root_task_id ?? "");
  const root = tasks.get(rootTaskId);
  const taskId = String(stored.taskId ?? rootTaskId);
  const task = tasks.get(taskId) ?? root;
  const status = stored.status === "required" ? "pending" : stored.status === "resolved" ? "resolved" : stored.status ?? "pending";
  const kind = stored.kind ?? "workflow_input";
  const requestedAt = new Date(stored.requestedAt ?? stored.createdAt ?? Date.now()).toISOString();
  const continuation = stored.continuation ?? (kind === "workflow_input" ? {
    type: "workflow_followup",
    targetAgentId: root?.workflow?.plannerAgentId ?? (task?.role === "planner" ? task?.targetAgentId : null),
    role: "planner",
    stage: "human_followup",
    sessionScopeId: root?.sessionScopeId ?? task?.sessionScopeId ?? rootTaskId,
  } : {
    type: "retry_task",
    taskId,
  });
  return {
    ...stored,
    interventionId: String(stored.interventionId ?? `${rootTaskId}:legacy`),
    rootTaskId,
    taskId,
    kind,
    status,
    question: String(stored.question ?? "需要人工决定"),
    requestedBy: stored.requestedBy ?? task?.targetAgentId ?? "system",
    requesterRole: stored.requesterRole ?? task?.role ?? "system",
    requesterStage: stored.requesterStage ?? task?.stage ?? null,
    sessionScopeId: stored.sessionScopeId ?? task?.sessionScopeId ?? null,
    allowedActions: Array.isArray(stored.allowedActions)
      ? stored.allowedActions
      : kind === "workflow_input" ? ["respond", "approve", "reject"] : ["approve", "reject"],
    context: stored.context ?? (root && task ? minimalInterventionContext(root, task) : {}),
    continuation,
    requestedAt,
    updatedAt: new Date(stored.updatedAt ?? stored.resolvedAt ?? requestedAt).toISOString(),
  };
}

function normalizeArtifactPath(value) {
  const raw = String(value ?? "").trim().replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || raw.includes("\0")) {
    throw httpError(400, "Artifact path must be a relative workspace path");
  }
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw httpError(400, "Artifact path cannot escape the workspace");
  const normalized = parts.join("/");
  if (!normalized) throw httpError(400, "Artifact path must name a file or subdirectory");
  return normalized;
}

function isDeclaredArtifactPath(candidate, declaration) {
  return candidate === declaration || candidate.startsWith(`${declaration}/`);
}

function publicActor(actor) {
  return {
    id: actor.userId ?? actor.id,
    username: actor.username,
    role: actor.role,
    ...(actor.status ? { status: actor.status } : {}),
    ...(actor.createdAt ? { createdAt: actor.createdAt } : {}),
    ...(actor.updatedAt ? { updatedAt: actor.updatedAt } : {}),
    ...(actor.lastLoginAt !== undefined ? { lastLoginAt: actor.lastLoginAt } : {}),
    ...(actor.activeSessionCount !== undefined ? { activeSessionCount: actor.activeSessionCount } : {}),
  };
}

function publicUser(user) {
  return {
    id: user.id ?? user.userId,
    username: user.username,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    activeSessionCount: user.activeSessionCount,
  };
}

function summarizeTask(task) {
  const { output, submission, contextBundle, ...summary } = task;
  const { fullResult: _fullResult, ...safeSubmission } = submission ?? {};
  const { fullResult: _contextFullResult, ...safeContext } = contextBundle ?? {};
  return {
    ...summary,
    ...(submission ? { submission: safeSubmission } : {}),
    ...(contextBundle ? { contextBundle: safeContext } : {}),
  };
}

function summarizeMessage(message) {
  return {
    ...message,
    attachments: (message.attachments ?? []).map(({ content, ...attachment }) => attachment),
  };
}

function schedulingAccountKey(agent) {
  if (!agent) return null;
  const provider = agent.account?.provider;
  const id = agent.account?.id;
  if (provider && id) return `${provider}:${id}`;
  return `${agent.deviceId ?? agent.agentId}:${provider ?? agent.adapter ?? "unknown"}:${id ?? agent.agentId}`;
}

function normalizeLegacyArtifactAgentId(value) {
  const agentId = Array.isArray(value) ? value[0] : value;
  if (typeof agentId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(agentId)) return null;
  return agentId;
}

function summarizeAgentEnvironment(capabilities) {
  const device = capabilities?.device ?? {};
  const availableTools = (capabilities?.tools ?? []).filter((item) => ["available", "stale"].includes(item?.state)).map((item) => ({
    name: item.name,
    version: item.version,
    stale: Boolean(item.stale),
  }));
  return {
    platform: capabilities?.platform ?? device.system?.platform ?? null,
    arch: capabilities?.arch ?? device.system?.arch ?? null,
    node: capabilities?.node ?? device.node?.version ?? null,
    python: ["available", "stale"].includes(device.python?.state) ? device.python.version ?? "available" : null,
    gpu: ["available", "stale"].includes(device.gpu?.state) ? device.gpu.version ?? device.gpu.description ?? "available" : null,
    tools: availableTools,
  };
}

function clientIpForRequest(request, authConfig = {}) {
  const peer = String(request.socket?.remoteAddress ?? "unknown");
  const trusted = authConfig?.trustedProxyIps ?? authConfig?.trustedProxies ?? [];
  if (!Array.isArray(trusted) || !trusted.includes(peer)) return peer;
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded !== "string") return peer;
  const candidate = forwarded.split(",", 1)[0].trim();
  return isIP(candidate) ? candidate : peer;
}

function contentDisposition(filename) {
  const fallback = String(filename ?? "artifact.bin").replace(/[^A-Za-z0-9._-]/g, "_") || "artifact.bin";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(filename ?? fallback))}`;
}

function httpError(statusCode, message, code, details) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}), ...(details ? { details } : {}) });
}

function httpErrorCode(statusCode) {
  return ({ 400: "VALIDATION_ERROR", 401: "AUTH_REQUIRED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "STATE_CONFLICT", 413: "PAYLOAD_TOO_LARGE", 503: "HUB_UNAVAILABLE" })[statusCode] ?? "INTERNAL_ERROR";
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw httpError(413, "Request body too large", "PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError(400, "Invalid JSON request body", "VALIDATION_ERROR");
  }
}

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}
