import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { EventLog } from "./event-log.mjs";
import { isLoopbackHost, makeEnvelope, parseEnvelope, safeError } from "./common.mjs";

const ACTIVE_TASK_STATUSES = new Set(["queued", "awaiting_approval", "dispatched", "running"]);

export class AgentHub {
  constructor(config) {
    this.config = config;
    this.host = config.host ?? "127.0.0.1";
    this.port = Number(config.port ?? 8787);
    this.token = config.auth?.tokenEnv ? process.env[config.auth.tokenEnv] : undefined;
    this.agents = new Map();
    this.connections = new Map();
    this.tasks = new Map();
    this.pendingDeliveries = new Map();
    this.log = new EventLog({
      file: config.logs?.file,
      includePayloads: config.logs?.includePayloads !== false,
    });
    this.server = null;
    this.wss = null;
    this.retryTimer = null;
  }

  async start() {
    this.validateSecurity();
    await this.log.init();
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

    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname !== "/worker" || !this.authorized(request.headers.authorization)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.acceptWorker(ws, request));
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
    await this.log.record("hub.started", { host: this.host, port: this.port, tls: Boolean(this.config.tls?.enabled) });
    return this;
  }

  validateSecurity() {
    const remote = !isLoopbackHost(this.host);
    if (this.config.auth?.required && !this.token) {
      throw new Error(`Required Hub token is missing from environment variable ${this.config.auth.tokenEnv}`);
    }
    if (remote && !this.token) throw new Error("Non-loopback Hub listeners require bearer-token authentication");
    if (remote && !this.config.tls?.enabled && !this.config.allowPlaintextRemote) {
      throw new Error("Non-loopback Hub listeners require TLS unless allowPlaintextRemote is explicitly enabled for a trusted tunnel");
    }
  }

  url() {
    return `${this.config.tls?.enabled ? "https" : "http"}://${this.host}:${this.port}`;
  }

  async stop() {
    if (this.retryTimer) clearInterval(this.retryTimer);
    for (const ws of this.connections.values()) ws.close(1001, "Hub stopping");
    await new Promise((resolve) => this.wss?.close(() => resolve()));
    await new Promise((resolve) => this.server?.close(() => resolve()));
    await this.log.record("hub.stopped");
  }

  authorized(header) {
    if (!this.token) return true;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  acceptWorker(ws) {
    let registeredAgentId;
    const helloDeadline = setTimeout(() => ws.close(1008, "worker.hello required"), 5000);
    ws.on("message", async (raw) => {
      try {
        const message = parseEnvelope(raw);
        if (!registeredAgentId) {
          if (message.type !== "worker.hello" || !message.agentId) throw new Error("First message must be worker.hello with agentId");
          registeredAgentId = message.agentId;
          clearTimeout(helloDeadline);
          const existing = this.connections.get(registeredAgentId);
          if (existing && existing !== ws) existing.close(4001, "Replaced by newer connection");
          this.connections.set(registeredAgentId, ws);
          this.agents.set(registeredAgentId, {
            agentId: registeredAgentId,
            status: "online",
            paused: Boolean(message.payload?.paused),
            capabilities: message.payload?.capabilities ?? [],
            adapter: message.payload?.adapter,
            sessionId: message.payload?.sessionId,
            observedCapabilities: message.payload?.observedCapabilities,
            executors: message.payload?.executors ?? [],
            connectedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          });
          await this.log.record("worker.online", this.agents.get(registeredAgentId));
          ws.send(JSON.stringify(makeEnvelope("hub.welcome", { agentId: registeredAgentId, replyTo: message.id, payload: { heartbeatMs: this.config.heartbeatMs ?? 10000 } })));
          this.flushAgentDeliveries(registeredAgentId);
          return;
        }
        if (message.agentId && message.agentId !== registeredAgentId) throw new Error("agentId cannot change on an active connection");
        await this.handleWorkerMessage(registeredAgentId, message);
      } catch (error) {
        await this.log.record("worker.protocol_error", { agentId: registeredAgentId, error: safeError(error) });
        ws.close(1008, "Protocol error");
      }
    });
    ws.on("close", async () => {
      clearTimeout(helloDeadline);
      if (!registeredAgentId || this.connections.get(registeredAgentId) !== ws) return;
      this.connections.delete(registeredAgentId);
      const agent = this.agents.get(registeredAgentId);
      if (agent) {
        agent.status = "offline";
        agent.disconnectedAt = new Date().toISOString();
      }
      for (const delivery of this.pendingDeliveries.values()) {
        if (delivery.agentId === registeredAgentId) {
          delivery.sentAt = 0;
          delivery.attempts = 0;
        }
      }
      await this.log.record("worker.offline", { agentId: registeredAgentId });
    });
  }

  async handleWorkerMessage(agentId, message) {
    const agent = this.agents.get(agentId);
    if (agent) agent.lastSeenAt = new Date().toISOString();
    if (agent && message.payload?.executor) agent.executors = [message.payload.executor];
    if (message.type === "worker.heartbeat") {
      if (agent) {
        agent.sessionId = message.payload?.sessionId ?? agent.sessionId;
        agent.busy = Boolean(message.payload?.busy);
        agent.paused = Boolean(message.payload?.paused);
        agent.observedCapabilities = message.payload?.observedCapabilities ?? agent.observedCapabilities;
        agent.executors = message.payload?.executors ?? agent.executors;
        agent.currentTaskId = message.payload?.currentTaskId ?? null;
      }
      return;
    }
    if (message.type === "ack") {
      this.pendingDeliveries.delete(`${agentId}:${message.replyTo}`);
      return;
    }
    if (["task.started", "task.result", "task.error", "task.rejected", "approval.request"].includes(message.type)) {
      this.sendAck(agentId, message.id);
    }
    const task = message.taskId ? this.tasks.get(message.taskId) : undefined;
    if (message.type === "task.started" && task) {
      task.status = "running";
      task.startedAt = new Date().toISOString();
      task.checkpoint = message.payload?.checkpoint;
      await this.log.record("task.started", { taskId: task.taskId, agentId, checkpoint: task.checkpoint });
      return;
    }
    if (message.type === "approval.request" && task) {
      task.status = "awaiting_approval";
      task.approval = message.payload;
      await this.log.record("approval.requested", { taskId: task.taskId, agentId, approval: message.payload });
      return;
    }
    if (message.type === "task.rejected" && task) {
      task.status = "rejected";
      task.completedAt = new Date().toISOString();
      task.error = { name: "PolicyDeniedError", code: message.payload?.code, reasons: message.payload?.reasons ?? [] };
      task.checkpoint = message.payload?.checkpoint;
      await this.log.record("task.rejected", { taskId: task.taskId, agentId, payload: message.payload });
      return;
    }
    if ((message.type === "task.result" || message.type === "task.error") && task) {
      if (["completed", "failed", "cancelled", "rejected"].includes(task.status)) return;
      task.status = message.type === "task.result" ? "completed" : (message.payload?.cancelled ? "cancelled" : "failed");
      task.completedAt = new Date().toISOString();
      task.output = message.payload?.output;
      task.error = message.payload?.error;
      task.sessionId = message.payload?.sessionId;
      task.artifacts = message.payload?.artifacts;
      task.checkpoint = message.payload?.checkpoint;
      await this.log.record(message.type, { taskId: task.taskId, agentId, payload: message.payload });
      if (message.type === "task.result" && task.route.length > 0) {
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
    }
  }

  sendAck(agentId, replyTo) {
    const ws = this.connections.get(agentId);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(makeEnvelope("ack", { agentId, replyTo })));
  }

  createTask(input) {
    const taskId = randomUUID();
    const task = {
      taskId,
      rootTaskId: input.rootTaskId ?? taskId,
      parentTaskId: input.parentTaskId,
      targetAgentId: input.targetAgentId,
      sourceAgentId: input.sourceAgentId ?? "human",
      input: String(input.input ?? ""),
      route: Array.isArray(input.route) ? input.route : [],
      metadata: input.metadata ?? {},
      taskSpec: input.taskSpec ?? input.metadata?.taskSpec ?? null,
      requiresApproval: Boolean(input.requiresApproval),
      status: input.requiresApproval ? "awaiting_approval" : "queued",
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, task);
    void this.log.record("task.created", task);
    return task;
  }

  async queueOrDispatch(task) {
    if (task.requiresApproval && task.status === "awaiting_approval") return;
    const agent = this.agents.get(task.targetAgentId);
    if (agent?.paused) {
      task.status = "queued";
      await this.log.record("task.queued_paused", { taskId: task.taskId, agentId: task.targetAgentId });
      return;
    }
    task.status = "dispatched";
    task.dispatchedAt = new Date().toISOString();
    this.deliver(task.targetAgentId, makeEnvelope("task.assign", {
      agentId: task.targetAgentId,
      taskId: task.taskId,
      payload: {
        input: task.input,
        rootTaskId: task.rootTaskId,
        parentTaskId: task.parentTaskId,
        sourceAgentId: task.sourceAgentId,
        metadata: task.metadata,
        taskSpec: task.taskSpec,
      },
    }));
    await this.log.record("task.dispatched", { taskId: task.taskId, agentId: task.targetAgentId });
  }

  deliver(agentId, envelope) {
    const key = `${agentId}:${envelope.id}`;
    if (!this.pendingDeliveries.has(key)) {
      this.pendingDeliveries.set(key, { agentId, envelope, attempts: 0, sentAt: 0 });
    }
    this.sendDelivery(this.pendingDeliveries.get(key));
  }

  sendDelivery(delivery) {
    const ws = this.connections.get(delivery.agentId);
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(delivery.envelope));
    delivery.sentAt = Date.now();
    delivery.attempts += 1;
  }

  flushAgentDeliveries(agentId) {
    for (const delivery of this.pendingDeliveries.values()) {
      if (delivery.agentId === agentId) this.sendDelivery(delivery);
    }
  }

  retryDeliveries() {
    const timeout = Number(this.config.delivery?.ackTimeoutMs ?? 5000);
    const maxAttempts = Number(this.config.delivery?.maxAttemptsPerConnection ?? 5);
    for (const delivery of this.pendingDeliveries.values()) {
      if (!delivery.sentAt || Date.now() - delivery.sentAt < timeout) continue;
      if (delivery.attempts >= maxAttempts) continue;
      this.sendDelivery(delivery);
    }
  }

  async handleHttp(request, response) {
    try {
      const url = new URL(request.url ?? "/", this.url());
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true, protocolVersion: 1, now: new Date().toISOString() });
      }
      if (!this.authorized(request.headers.authorization)) return json(response, 401, { error: "Unauthorized" });
      if (request.method === "GET" && url.pathname === "/v1/agents") {
        return json(response, 200, { agents: [...this.agents.values()] });
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        return json(response, 200, { events: this.log.recent(url.searchParams.get("limit")) });
      }
      if (request.method === "GET" && url.pathname === "/v1/tasks") {
        const rootTaskId = url.searchParams.get("rootTaskId");
        const tasks = [...this.tasks.values()].filter((task) => !rootTaskId || task.rootTaskId === rootTaskId);
        return json(response, 200, { tasks, active: tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status)) });
      }
      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        const body = await readBody(request);
        if (!body.targetAgentId || typeof body.input !== "string") return json(response, 400, { error: "targetAgentId and string input are required" });
        const task = this.createTask(body);
        await this.queueOrDispatch(task);
        return json(response, 202, { task });
      }
      if (request.method === "POST" && url.pathname === "/v1/commands") {
        const body = await readBody(request);
        const result = await this.handleCommand(body);
        return json(response, 200, result);
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      await this.log.record("http.error", { error: safeError(error) });
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      return json(response, statusCode, { error: error.message });
    }
  }

  async handleCommand(command) {
    if (command.type === "task.approve") {
      const task = this.tasks.get(command.taskId);
      if (!task) throw httpError(404, `Unknown task ${command.taskId}`);
      if (task.status !== "awaiting_approval" || !task.requiresApproval) {
        throw httpError(409, `Task ${command.taskId} is not awaiting approval`);
      }
      task.requiresApproval = false;
      task.approval = { ...(task.approval ?? {}), approvedAt: new Date().toISOString(), approvedBy: command.by ?? "human" };
      await this.queueOrDispatch(task);
      return { ok: true, task };
    }
    if (["agent.pause", "agent.resume"].includes(command.type)) {
      const agent = this.agents.get(command.targetAgentId);
      if (agent) agent.paused = command.type === "agent.pause";
      this.deliver(command.targetAgentId, makeEnvelope(command.type, { agentId: command.targetAgentId }));
      if (command.type === "agent.resume") {
        for (const task of this.tasks.values()) {
          if (task.targetAgentId === command.targetAgentId && task.status === "queued") await this.queueOrDispatch(task);
        }
      }
      await this.log.record(command.type, { agentId: command.targetAgentId });
      return { ok: true, agent };
    }
    if (command.type === "task.cancel") {
      const task = this.tasks.get(command.taskId);
      if (!task) throw httpError(404, `Unknown task ${command.taskId}`);
      if (!ACTIVE_TASK_STATUSES.has(task.status)) {
        throw httpError(409, `Task ${command.taskId} cannot be cancelled from status ${task.status}`);
      }
      task.status = "cancelled";
      task.completedAt = new Date().toISOString();
      this.deliver(task.targetAgentId, makeEnvelope("task.cancel", { agentId: task.targetAgentId, taskId: task.taskId }));
      await this.log.record("task.cancelled", { taskId: task.taskId, agentId: task.targetAgentId });
      return { ok: true, task };
    }
    throw httpError(400, `Unsupported command type: ${command.type}`);
  }
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response, status, value) {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
\n