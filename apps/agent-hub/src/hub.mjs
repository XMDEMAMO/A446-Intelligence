import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { EventLog } from "./event-log.mjs";
import { isLoopbackHost, makeEnvelope, parseEnvelope, safeError } from "./common.mjs";
import { addUsage, chooseAgent, normalizeModels, normalizeQuotaSnapshot, normalizeRoles, parseRoleSubmission } from "./collaboration.mjs";

const ACTIVE_TASK_STATUSES = new Set(["queued", "awaiting_approval", "dispatched", "running", "processing_result"]);

export class AgentHub {
  constructor(config) {
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
            deviceId: message.payload?.deviceId ?? registeredAgentId,
            account: message.payload?.account ?? null,
            roles: normalizeRoles(message.payload?.roles),
            models: normalizeModels(message.payload?.models, { model: message.payload?.model }),
            maxConcurrency: Number(message.payload?.maxConcurrency ?? 1),
            activeTaskCount: [...this.tasks.values()].filter((task) => task.targetAgentId === registeredAgentId && ACTIVE_TASK_STATUSES.has(task.status)).length,
            usageTotals: message.payload?.usageTotals ?? null,
            quotaSnapshot: normalizeQuotaSnapshot(message.payload?.quotaSnapshot),
            quotaProbeError: message.payload?.quotaProbeError ?? null,
            connectedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          });
          await this.log.record("worker.online", this.agents.get(registeredAgentId));
          ws.send(JSON.stringify(makeEnvelope("hub.welcome", { agentId: registeredAgentId, replyTo: message.id, payload: { heartbeatMs: this.config.heartbeatMs ?? 10000 } })));
          this.flushAgentDeliveries(registeredAgentId);
          for (const task of this.tasks.values()) {
            if (task.status === "queued" && (!task.targetAgentId || task.targetAgentId === registeredAgentId)) {
              await this.queueOrDispatch(task);
            }
          }
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
        agent.usageTotals = message.payload?.usageTotals ?? agent.usageTotals;
        agent.quotaSnapshot = normalizeQuotaSnapshot(message.payload?.quotaSnapshot) ?? agent.quotaSnapshot;
        agent.quotaProbeError = message.payload?.quotaProbeError ?? agent.quotaProbeError;
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
      this.addMessage(task, {
        senderId: agentId,
        senderRole: task.role,
        kind: "status",
        text: `开始执行：${task.taskSpec?.title ?? task.input.slice(0, 80)}`,
      });
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
      this.finishTaskActivity(task);
      await this.log.record("task.rejected", { taskId: task.taskId, agentId, payload: message.payload });
      await this.retryQueuedTasks();
      return;
    }
    if ((message.type === "task.result" || message.type === "task.error") && task) {
      if (["completed", "failed", "cancelled", "rejected"].includes(task.status)) return;
      const terminalStatus = message.type === "task.result" ? "completed" : (message.payload?.cancelled ? "cancelled" : "failed");
      task.status = "processing_result";
      task.completedAt = new Date().toISOString();
      task.output = message.payload?.output;
      task.error = message.payload?.error;
      task.sessionId = message.payload?.sessionId;
      task.artifacts = message.payload?.artifacts;
      task.checkpoint = message.payload?.checkpoint;
      task.model = message.payload?.model ?? task.execution?.model ?? null;
      task.usage = message.payload?.usage ?? null;
      task.quotaSnapshot = normalizeQuotaSnapshot(message.payload?.quotaSnapshot);
      task.submission = message.payload?.submission ?? parseRoleSubmission(task.role, task.output);
      if (task.usage) this.usageTotals = addUsage(this.usageTotals, task.usage);
      const agentRecord = this.agents.get(agentId);
      if (agentRecord && message.payload?.usageTotals) agentRecord.usageTotals = message.payload.usageTotals;
      if (agentRecord && task.quotaSnapshot) agentRecord.quotaSnapshot = task.quotaSnapshot;
      await this.log.record(message.type, { taskId: task.taskId, agentId, payload: message.payload });
      if (message.type === "task.result") {
        this.recordResultMessage(task);
      }
      try {
        if (message.type === "task.result" && task.workflow?.enabled) {
          await this.advanceWorkflow(task);
        } else if (message.type === "task.result" && task.route.length > 0) {
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
        await this.log.record("workflow.advance_error", { taskId: task.taskId, error: safeError(error) });
        await this.retryQueuedTasks();
        return;
      }
      task.status = terminalStatus;
      this.finishTaskActivity(task);
      await this.retryQueuedTasks();
    }
  }

  sendAck(agentId, replyTo) {
    const ws = this.connections.get(agentId);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(makeEnvelope("ack", { agentId, replyTo })));
  }

  createTask(input) {
    const taskId = randomUUID();
    const role = normalizeRoles(input.role)[0] ?? null;
    const rootTaskId = input.rootTaskId ?? taskId;
    const task = {
      taskId,
      rootTaskId,
      parentTaskId: input.parentTaskId,
      targetAgentId: input.targetAgentId ?? null,
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
      reviewCycle: Number(input.reviewCycle ?? 0),
      requiresApproval: Boolean(input.requiresApproval),
      status: input.requiresApproval ? "awaiting_approval" : "queued",
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, task);
    const sourceRole = task.sourceAgentId === "human"
      ? "human"
      : input.sourceRole ?? this.tasks.get(task.parentTaskId)?.role ?? "agent";
    this.addMessage(task, {
      senderId: task.sourceAgentId,
      senderRole: sourceRole,
      kind: "task_instruction",
      text: task.input,
      mentions: task.targetAgentId ? [task.targetAgentId] : task.role ? [`@${task.role}`] : [],
    });
    void this.log.record("task.created", task);
    return task;
  }

  async createWorkflow(input) {
    if (typeof input.objective !== "string" || !input.objective.trim()) throw httpError(400, "workflow objective is required");
    const workflow = {
      enabled: true,
      plannerAgentId: input.plannerAgentId ?? null,
      reviewerAgentId: input.reviewerAgentId ?? null,
      maxReviewCycles: Math.max(0, Number(input.maxReviewCycles ?? 2)),
    };
    const task = this.createTask({
      targetAgentId: workflow.plannerAgentId,
      sourceAgentId: "human",
      input: input.objective.trim(),
      role: "planner",
      stage: "planning",
      workflow,
      requiredCapabilities: input.requiredCapabilities,
      modelPreference: input.modelPreference,
      reasoningEffort: input.reasoningEffort,
      requiresApproval: Boolean(input.requiresApproval),
      taskSpec: {
        title: String(input.title ?? input.objective).trim().slice(0, 200),
        type: "collaboration_workflow",
        priority: input.priority ?? "P1",
        inputs: [],
        expected_outputs: [],
        permissions_required: input.permissionsRequired ?? { project_workspace: true },
        checkpoint_policy: { mode: "stage" },
        acceptance: Array.isArray(input.acceptance) ? input.acceptance.map(String) : [],
      },
      contextBundle: {
        objective: input.objective.trim(),
        acceptance: Array.isArray(input.acceptance) ? input.acceptance.map(String) : [],
      },
    });
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

  async advanceWorkflow(task) {
    const submission = task.submission ?? {};
    if (task.role === "planner") {
      if (submission.needsHuman) {
        this.requireHuman(task, submission.humanQuestion || submission.brief || "规划 Agent 请求人工介入");
        return;
      }
      for (const assignment of submission.assignments ?? []) {
        const child = this.createTask({
          targetAgentId: assignment.targetAgentId,
          input: assignment.instructions,
          rootTaskId: task.rootTaskId,
          parentTaskId: task.taskId,
          sourceAgentId: task.targetAgentId,
          role: "executor",
          stage: "execution",
          workflow: task.workflow,
          requiredCapabilities: assignment.requiredCapabilities,
          modelPreference: assignment.modelPreference,
          taskSpec: {
            title: assignment.title,
            type: "collaboration_execution",
            priority: task.taskSpec?.priority ?? "P1",
            inputs: [],
            expected_outputs: [],
            permissions_required: task.taskSpec?.permissions_required ?? { project_workspace: true },
            checkpoint_policy: { mode: "stage" },
            acceptance: assignment.acceptance?.length ? assignment.acceptance : task.taskSpec?.acceptance ?? [],
          },
          contextBundle: {
            objective: task.contextBundle?.objective ?? task.input,
            plannerBrief: submission.brief,
            acceptance: assignment.acceptance ?? [],
          },
        });
        await this.queueOrDispatch(child);
      }
      return;
    }

    if (task.role === "executor") {
      const reviewKind = submission.upstreamIssue ? "upstream_review" : "result_review";
      const reviewer = this.createTask({
        targetAgentId: task.workflow?.reviewerAgentId,
        input: reviewKind === "upstream_review" ? "审核执行 Agent 提交的上游错误报告。" : "审核执行 Agent 提交的完整成果。",
        rootTaskId: task.rootTaskId,
        parentTaskId: task.taskId,
        sourceAgentId: task.targetAgentId,
        role: "reviewer",
        stage: reviewKind,
        workflow: task.workflow,
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
          artifactReferences: (task.artifacts?.files ?? []).map((file) => ({ path: file.path, sha256: file.sha256, status: file.status })),
          resultVersion: `v${task.reviewCycle + 1}`,
        },
      });
      task.reviewStatus = "pending";
      task.reviewTaskId = reviewer.taskId;
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

    if (verdict === "approved") {
      await this.createPlannerIntake(task, reviewed, "result_intake", {
        approved: true,
        executorBrief: reviewed.submission?.brief,
        reviewBrief: submission.brief,
        artifactReferences: (reviewed.artifacts?.files ?? []).map((file) => ({ path: file.path, sha256: file.sha256, status: file.status })),
      });
      return;
    }
    if (verdict === "upstream_confirmed") {
      await this.createPlannerIntake(task, reviewed, "replan", {
        upstreamIssueConfirmed: true,
        correctionBrief: submission.correctionBrief ?? submission.brief,
        executorBrief: reviewed.submission?.brief,
      });
      return;
    }
    if (verdict === "upstream_denied") {
      const nextCycle = reviewed.reviewCycle + 1;
      const maxCycles = Number(task.workflow?.maxReviewCycles ?? 2);
      if (nextCycle > maxCycles) {
        this.requireHuman(task, `同一上游错误报告连续 ${nextCycle} 次未获审核认可：${submission.brief}`);
        return;
      }
      await this.createRevisionTask(task, reviewed, { upstreamDenied: true, reviewBrief: submission.brief }, nextCycle);
      return;
    }

    const nextCycle = reviewed.reviewCycle + 1;
    const maxCycles = Number(task.workflow?.maxReviewCycles ?? 2);
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

  async createPlannerIntake(reviewTask, reviewed, stage, details) {
    const root = this.tasks.get(reviewTask.rootTaskId);
    const planner = this.createTask({
      targetAgentId: reviewTask.workflow?.plannerAgentId,
      input: stage === "replan" ? "根据已确认的上游错误重新安排后续任务。" : "接收已审核通过的任务简报，并决定是否继续安排任务。",
      rootTaskId: reviewTask.rootTaskId,
      parentTaskId: reviewTask.taskId,
      sourceAgentId: reviewTask.targetAgentId,
      role: "planner",
      stage,
      workflow: reviewTask.workflow,
      sessionScopeId: root?.sessionScopeId ?? reviewTask.rootTaskId,
      taskSpec: {
        title: stage === "replan" ? "重新规划" : "接收审核结果",
        type: stage,
        priority: reviewed.taskSpec?.priority ?? "P1",
        permissions_required: { project_workspace: true },
        acceptance: [],
      },
      contextBundle: details,
    });
    await this.queueOrDispatch(planner);
  }

  async createRevisionTask(reviewTask, reviewed, details, reviewCycle = reviewed.reviewCycle) {
    const revision = this.createTask({
      targetAgentId: reviewed.targetAgentId,
      input: details.upstreamDenied ? "审核未认可上游错误报告，请继续原任务。" : "根据审核意见修改原成果。",
      rootTaskId: reviewTask.rootTaskId,
      parentTaskId: reviewTask.taskId,
      sourceAgentId: reviewTask.targetAgentId,
      role: "executor",
      stage: "revision",
      workflow: reviewTask.workflow,
      sessionScopeId: reviewed.sessionScopeId,
      reviewCycle,
      taskSpec: reviewed.taskSpec,
      contextBundle: {
        objective: reviewed.contextBundle?.objective ?? reviewed.input,
        previousBrief: reviewed.submission?.brief,
        ...details,
      },
    });
    await this.queueOrDispatch(revision);
  }

  requireHuman(task, question) {
    const root = this.tasks.get(task.rootTaskId) ?? task;
    root.humanIntervention = {
      status: "required",
      question: String(question),
      requestedBy: task.targetAgentId,
      requestedAt: new Date().toISOString(),
    };
    this.addMessage(task, {
      senderId: task.targetAgentId,
      senderRole: task.role,
      kind: "human_intervention",
      text: String(question),
      mentions: ["human"],
    });
  }

  conversations() {
    const roots = [...this.tasks.values()].filter((task) => task.rootTaskId === task.taskId);
    return roots.map((root) => {
      const tasks = [...this.tasks.values()].filter((task) => task.rootTaskId === root.taskId);
      const messages = this.messages.filter((message) => message.rootTaskId === root.taskId);
      const active = tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status));
      const failed = tasks.some((task) => ["failed", "rejected"].includes(task.status));
      const status = root.humanIntervention?.status === "required" ? "needs_human" : active ? "active" : failed ? "failed" : "completed";
      const participants = [...new Set(tasks.flatMap((task) => [task.sourceAgentId, task.targetAgentId]).filter(Boolean))];
      return {
        rootTaskId: root.taskId,
        title: root.taskSpec?.title ?? (root.input.slice(0, 60) || "未命名任务"),
        status,
        createdAt: root.createdAt,
        updatedAt: messages.at(-1)?.createdAt ?? root.completedAt ?? root.createdAt,
        participants,
        taskCount: tasks.length,
        messageCount: messages.length,
        humanIntervention: root.humanIntervention ?? null,
      };
    }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async queueOrDispatch(task) {
    if (task.requiresApproval && task.status === "awaiting_approval") return;
    let selection;
    try {
      selection = chooseAgent(this.agents, {
        targetAgentId: task.targetAgentId,
        role: task.role,
        requiredCapabilities: task.requiredCapabilities,
        modelPreference: task.modelPreference,
      });
    } catch (error) {
      task.status = "queued";
      task.schedulingError = error.message;
      await this.log.record("task.queued_no_candidate", { taskId: task.taskId, agentId: task.targetAgentId, error: error.message });
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
    if (agent?.paused) {
      task.status = "queued";
      await this.log.record("task.queued_paused", { taskId: task.taskId, agentId: task.targetAgentId });
      return;
    }
    task.status = "dispatched";
    task.dispatchedAt = new Date().toISOString();
    if (!task.activeSlotAgentId) {
      task.activeSlotAgentId = agent.agentId;
      agent.activeTaskCount = Number(agent.activeTaskCount ?? 0) + 1;
    }
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
        role: task.role,
        stage: task.stage,
        contextBundle: task.contextBundle,
        sessionScopeId: task.sessionScopeId,
        execution: task.execution,
      },
    }));
    await this.log.record("task.dispatched", { taskId: task.taskId, agentId: task.targetAgentId });
  }

  finishTaskActivity(task) {
    if (!task.activeSlotAgentId) return;
    const agent = this.agents.get(task.activeSlotAgentId);
    if (agent) agent.activeTaskCount = Math.max(0, Number(agent.activeTaskCount ?? 0) - 1);
    task.activeSlotAgentId = null;
  }

  async retryQueuedTasks() {
    for (const candidate of this.tasks.values()) {
      if (candidate.status === "queued") await this.queueOrDispatch(candidate);
    }
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
      if (request.method === "GET" && url.pathname === "/v1/conversations") {
        return json(response, 200, { conversations: this.conversations() });
      }
      if (request.method === "GET" && url.pathname === "/v1/messages") {
        const rootTaskId = url.searchParams.get("rootTaskId");
        const messages = this.messages.filter((message) => !rootTaskId || message.rootTaskId === rootTaskId);
        return json(response, 200, { messages });
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
          if (item.quotaSnapshot && (!current.quotaSnapshot || Date.parse(item.quotaSnapshot.checkedAt) > Date.parse(current.quotaSnapshot.checkedAt))) {
            current.quotaSnapshot = item.quotaSnapshot;
          }
          accounts.set(key, current);
        }
        return json(response, 200, { totals: this.usageTotals, byAgent, byAccount: [...accounts.values()] });
      }
      if (request.method === "POST" && url.pathname === "/v1/workflows") {
        const body = await readBody(request);
        const task = await this.createWorkflow(body);
        return json(response, 202, { task });
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        const body = await readBody(request);
        if (typeof body.text !== "string" || !body.text.trim()) return json(response, 400, { error: "message text is required" });
        const task = this.tasks.get(body.taskId ?? body.rootTaskId);
        if (!task || task.rootTaskId !== String(body.rootTaskId ?? task.rootTaskId)) return json(response, 404, { error: "Unknown task conversation" });
        const message = this.addMessage(task, {
          senderId: body.senderId ?? "human",
          senderRole: "human",
          kind: "message",
          text: body.text.trim(),
          mentions: body.mentions,
        });
        return json(response, 201, { message });
      }
      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        const body = await readBody(request);
        if (typeof body.input !== "string" || (!body.targetAgentId && !body.role)) return json(response, 400, { error: "string input and targetAgentId or role are required" });
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
    if (command.type === "workflow.human_response") {
      const root = this.tasks.get(command.rootTaskId);
      if (!root || root.rootTaskId !== root.taskId) throw httpError(404, `Unknown workflow ${command.rootTaskId}`);
      if (root.humanIntervention?.status !== "required") throw httpError(409, `Workflow ${command.rootTaskId} is not awaiting human input`);
      const response = String(command.response ?? "").trim();
      if (!response) throw httpError(400, "Human response is required");
      root.humanIntervention = {
        ...root.humanIntervention,
        status: "resolved",
        response,
        resolvedAt: new Date().toISOString(),
        resolvedBy: command.by ?? "human",
      };
      this.addMessage(root, { senderId: command.by ?? "human", senderRole: "human", kind: "human_decision", text: response });
      const planner = this.createTask({
        targetAgentId: root.workflow?.plannerAgentId,
        input: "根据人工决定继续规划。",
        rootTaskId: root.taskId,
        parentTaskId: root.taskId,
        sourceAgentId: command.by ?? "human",
        role: "planner",
        stage: "human_followup",
        workflow: root.workflow,
        sessionScopeId: root.sessionScopeId,
        taskSpec: root.taskSpec,
        contextBundle: { objective: root.input, humanResponse: response },
      });
      await this.queueOrDispatch(planner);
      await this.log.record("workflow.human_response", { rootTaskId: root.taskId, by: command.by ?? "human" });
      return { ok: true, task: planner };
    }
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
      this.finishTaskActivity(task);
      this.deliver(task.targetAgentId, makeEnvelope("task.cancel", { agentId: task.targetAgentId, taskId: task.taskId }));
      await this.log.record("task.cancelled", { taskId: task.taskId, agentId: task.targetAgentId });
      await this.retryQueuedTasks();
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
