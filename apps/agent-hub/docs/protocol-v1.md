# Agent Hub Protocol v1

本文档是本地 Worker 与正式服务器之间的兼容契约。机器可使用不同操作系统，但必须发送相同的 UTF-8 JSON 消息。

## Transport

- 正式环境：`wss://HOST/worker`
- 本机测试：`ws://127.0.0.1:8787/worker`
- 每个 WebSocket text frame 包含一个完整 envelope。
- Worker 必须主动连接 Hub；Hub 不连接笔记本。
- Worker 认证头：`Authorization: Bearer <worker-credential>`。正式服务器为每个逻辑 Worker 单独签发高熵凭据，只保存哈希，并从凭据得到允许的 `agentId` 与 `deviceId`，不能相信 hello 中的自报字段。
- Web 使用服务端 Session Cookie，不与 Worker 共用凭据。共享 Token 仅保留给回环或受信的本地开发 Hub，正式 Server Hub 禁止使用。

## Handshake

连接后的第一条消息必须是：

```json
{
  "v": 1,
  "id": "4792facf-a3f9-4a13-8297-408a7de91822",
  "type": "worker.hello",
  "ts": "2026-09-12T00:00:00.000Z",
  "agentId": "laptop-01-codex-a",
  "payload": {
    "adapter": "codex-exec-resume",
    "deviceId": "laptop-01",
    "account": { "id": "gpt-plus-01", "provider": "openai", "plan": "Plus", "label": "GPT Plus 01" },
    "roles": ["executor"],
    "models": [
      { "id": "configured-model-a", "capabilities": ["coding"], "quota": { "state": "Unknown", "source": "unavailable", "windows": [] } }
    ],
    "capabilities": ["task.execute", "coding", "pause", "resume", "cancel"],
    "protocolFeatures": ["attempt-lease-v1", "artifact-transfer-v1"],
    "sessionId": null,
    "paused": false,
    "platform": "win32",
    "node": "v20.19.0",
    "observedCapabilities": {
      "adapter": { "name": "codex", "available": true, "version": "codex-cli 1.x" },
      "tools": [{ "name": "git", "available": true, "version": "git version 2.x" }]
    },
    "executors": [{ "type": "codex-exec-resume", "health": "Healthy", "quota": "Unknown" }],
    "resourceSnapshot": {
      "schemaVersion": 1,
      "state": "available",
      "checkedAt": "2026-09-12T00:00:00.000Z",
      "stale": false,
      "capabilities": {
        "source": "local-resource-probe",
        "device": { "cpu": { "state": "available", "logicalCores": 8 }, "memory": { "state": "available", "totalBytes": 17179869184 } }
      },
      "models": { "state": "unknown", "source": "config", "items": [] },
      "quota": { "state": "Unknown", "source": "unavailable", "windows": [] }
    },
    "usageTotals": { "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "reasoningTokens": 0, "toolTokens": 0, "totalTokens": 0 },
    "quotaSnapshot": { "state": "Unknown", "source": "unavailable", "checkedAt": "2026-09-12T00:00:00.000Z", "windows": [] }
  }
}
```

Hub 返回 `hub.welcome`。同一 `agentId` 的新连接替换旧连接。支持租约的 Hub 会在 `hub.welcome.payload.protocolFeatures` 返回 `attempt-lease-v1`，并同时返回 `leaseTtlMs`。生产 Server Hub 启用租约后，只向在 hello 中声明该特性的 Worker 派发任务。

`worker.heartbeat.payload` 除 `busy`、`paused`、`sessionId` 外，还应携带 `currentTaskId`、`currentAttemptId`、`capabilities`、`models`、`observedCapabilities`、`resourceSnapshot`、`executors`、`usageTotals` 和 `quotaSnapshot`。当前 Attempt 存在时，Hub 以 heartbeat 续租。额度状态只允许使用 `Healthy / Low / Exhausted / Unknown`；无法从官方工具可靠读取时必须上报 `Unknown`，不得伪造精确百分比。

`deviceId` 表示物理设备，`account` 表示本地已登录账号，`agentId` 表示该设备上的一个逻辑 Agent。一个账号可以承载多个 Agent；每个 Agent 仍必须使用独立的 `agentId`、工作区、状态文件和 session。`models` 是当前账号实际允许调度的模型清单，不表示模型拥有独立登录授权。

### Resource snapshot

资源探针在 Worker 启动时运行一次，并按 `capabilityProbe.intervalMs` 低频刷新。`resourceSnapshot` 统一包含能力、设备、模型和可信额度区段；旧 Hub 可以忽略该 v1 payload 增量。资源状态只使用：

```text
available    本次探测确认可用
unavailable  本次探测确认不可用，且没有可保留的成功值
unknown      未配置或没有可信机器可读来源
stale        本次刷新失败，仍保留最后一次可信成功值
```

每个区段应携带 `source`、`checkedAt`、`lastSuccessAt`、`stale` 和有界的 `errorSummary`。模型探针失败时使用配置清单并标记 `source=config`；已成功探测过的值在后续失败时保留并标为 `stale`。设备信息只包含调度需要的系统、CPU、内存、GPU、Node、Python、浏览器、主要工具和用户配置的服务描述。探针不得读取 Cookie、浏览器 Profile、Refresh Token、系统凭据库或认证数据库。单个探针失败不使 Worker 离线。

## Reliable delivery

- Hub 发送的 `task.assign`、`task.cancel`、`agent.pause`、`agent.resume`、`device.update.request` 需要 Worker 回 `ack`。
- Worker 发送的 `task.started`、`task.result`、`task.error`、`task.rejected`、`approval.request`、`device.update.status` 需要 Hub 回 `ack`。
- `ack.replyTo` 等于被确认消息的 `id`。
- 未确认消息可在超时或重连后重复发送；接收方必须以消息 `id` 去重。
- `worker.heartbeat` 和 `hub.welcome` 不要求确认。
- 网络语义是 at-least-once，不承诺 exactly-once；幂等由接收方保证。

## Task lifecycle

```text
queued -> dispatched -> running -> completed
                         |          failed
                         |          cancelled
                         |          rejected
                         -> awaiting_approval -> running
```

启用 `attempt-lease-v1` 后，任务与执行尝试分开记录：

```text
Attempt: assigned -> running -> completed | failed | cancelled | rejected
                    |
                    +---------> expired
Task:    queued -> dispatched -> running -> terminal
                    |              |
                    +-- lease -----+-> queued（仅明确可安全重试）
                                   +-> awaiting_approval（副作用未知或外部副作用）
```

- 每次派发创建唯一 `attemptId`，同一任务的 `attemptNumber` 单调递增。
- 只有任务的 `currentAttemptId` 与消息中的 `attemptId` 相等，且 Attempt 仍为 `assigned` 或 `running`，结果才可改变任务状态。
- 过期 Attempt 的迟到 `task.started`、`task.result`、`task.error`、`task.rejected` 或 `approval.request` 只记审计并 ACK，不覆盖当前结果。
- 租约过期后，只有 Task Spec 明确声明 `side_effects` 为 `none` 或 `idempotent` 时才允许自动重派。`external`、`unknown` 或未声明一律进入人工确认。
- 自动恢复次数由服务器 `leases.maxRecoveryAttempts` 限制，默认 3 次；达到上限后即使任务可安全重试也转人工确认，禁止单 Worker 无限重派。
- `task.cancel.payload.attemptId` 存在时，Worker 只取消匹配的当前 Attempt，避免旧取消消息影响新派发。

`task.assign.payload`：

Task Spec 的 JSON Schema 位于 `protocol/task-spec.schema.json`。Worker 会在接收任务和真正执行前各做一次本地校验；服务器端校验成功不替代本地校验。

```json
{
  "input": "human or upstream agent message",
  "rootTaskId": "uuid",
  "parentTaskId": "optional uuid",
  "sourceAgentId": "human or another agent",
  "metadata": {},
  "role": "executor",
  "stage": "execution",
  "sessionScopeId": "uuid-for-this-planning-or-execution-chain",
  "contextBundle": {
    "objective": "only the minimum objective needed by this role",
    "plannerBrief": "approved handoff summary",
    "acceptance": ["verifiable condition"]
  },
  "execution": { "model": "configured-model-a", "reasoningEffort": "medium" },
  "attemptId": "unique-attempt-uuid",
  "lease": { "expiresAt": "2026-09-12T00:00:30.000Z", "ttlMs": 30000 },
  "taskSpec": {
    "inputs": ["input.txt"],
    "expected_outputs": ["artifact.txt"],
    "permissions_required": {
      "project_workspace": true,
      "terminal": true,
      "browser": false
    },
    "execution_policy": {
      "side_effects": "none",
      "on_lease_expiry": "retry"
    }
  }
}
```

`task.result.payload`：

```json
{
  "attemptId": "unique-attempt-uuid",
  "output": "agent output",
  "role": "executor",
  "model": "configured-model-a",
  "submission": {
    "brief": "short task brief",
    "fullResult": "complete result, supplied to reviewer as an attachment",
    "upstreamIssue": null
  },
  "usage": { "inputTokens": 800, "outputTokens": 200, "cachedTokens": 0, "reasoningTokens": 0, "toolTokens": 0, "totalTokens": 1000 },
  "usageTotals": { "inputTokens": 800, "outputTokens": 200, "cachedTokens": 0, "reasoningTokens": 0, "toolTokens": 0, "totalTokens": 1000 },
  "quotaSnapshot": { "state": "Unknown", "source": "unavailable", "checkedAt": "2026-09-12T00:05:00.000Z", "windows": [] },
  "sessionId": "local durable session id",
  "artifacts": {
    "algorithm": "sha256",
    "files": [{ "artifactId": "uuid", "path": "artifact.txt", "size": 123, "sha256": "hex", "status": "ready", "downloadUrl": "/v1/artifacts/uuid/content" }],
    "missing": []
  },
  "checkpoint": { "checkpointId": "id", "stage": "COMPLETED", "path": ".agent-hub/checkpoints/task-id" },
  "executor": { "type": "codex-exec-resume", "health": "Healthy", "quota": "Healthy" }
}
```

本地 Policy 拒绝任务时，Worker 返回 `task.rejected`，其中 `payload.code` 为 `POLICY_DENIED`，`payload.reasons` 为拒绝原因列表，并附带 `checkpoint`。服务器必须把它视为终态，不得自动放宽权限后重发。

启用 `artifact-transfer-v1` 时，Worker 在发送 `task.result` 前完成中央制品登记与上传：

1. `POST /v1/artifacts` 登记 Task Spec 已声明的相对输出路径、当前 `taskId`、`attemptId`、字节数和 SHA-256；服务器返回 Artifact ID。
2. `PUT /v1/artifacts/{artifactId}/content` 流式上传内容。服务器先写临时文件，核对大小与 SHA-256，成功后原子移动并把状态改为 `ready`。
3. 缺失输出以 `status=missing` 登记；超限、哈希错误、未声明路径和路径逃逸均不能成为 `ready`。
4. 后续任务从 `contextBundle.artifactReferences` 取得 Artifact ID、受控目标相对路径、大小和哈希，通过 `GET /v1/artifacts/{artifactId}/content` 流式下载；Worker 必须在允许工作区内落盘并再次校验后才能交给 Adapter。
5. Server Hub 只在全部声明输出都对应当前 Attempt 的 `ready` 记录时接受结果。HTTP 响应不暴露服务器 `storageKey` 或绝对路径。

Worker 至少在 `ACCEPTED / RUNNING / COMPLETED / FAILED / CANCELLED / REJECTED` 阶段保存本地 Checkpoint。Checkpoint 目录包含 `state.json`、`task_spec.json`、`files_manifest.json`、`continuation.md`，有输出时还包含 `partial_output.txt`。

`task.error.payload`：

```json
{
  "attemptId": "unique-attempt-uuid",
  "error": { "name": "Error", "message": "safe message" },
  "cancelled": false,
  "sessionId": "optional session id",
  "checkpoint": { "checkpointId": "id", "stage": "FAILED", "path": ".agent-hub/checkpoints/task-id" },
  "executor": { "type": "codex-exec-resume", "health": "Degraded", "quota": "Low" }
}
```

Hub 通过新建子任务实现 A → B。子任务沿用 `rootTaskId`，`parentTaskId` 指向 A 的任务，`sourceAgentId` 为 A。

## Collaboration workflow

每个根任务对应一个群聊，所有内部子任务与消息共享同一个 `rootTaskId`：

```text
规划 Agent -> 执行 Agent -> 审核 Agent -> 规划 Agent
                     |             |
                     | 上游错误     | 驳回：返回执行 Agent 修改
                     +----------->  | 确认：只把纠错简报交给规划 Agent 重排
```

- 规划 Agent 只拆分、指派、接收通过审核的简报，不读取完整成果。
- 执行 Agent 提交 `brief + fullResult`；发现上游错误时提交 `upstreamIssue`，不得静默篡改上游结论。
- 审核 Agent 只审核完整成果或上游错误报告，返回结构化 verdict。
- `approved` 后，规划 Agent 只收到执行简报、审核简报和成果引用。
- `rejected` 后，原执行 Agent 获得纠错简报；超过最大次数才请求人工介入。
- 规划任务不得生成会修改同一成果的重叠执行任务；一个成果始终只有一个执行负责人。
- 群聊中的 `@` 用于人类观察和提醒，不直接改变任务状态。
- `sessionScopeId` 隔离不同任务的模型会话；执行修改沿用原执行范围，规划回收沿用根任务的规划范围，不同根任务不得共享模型上下文。

## Compatibility rules

- 未知的更高 `v` 必须拒绝，不能静默降级。
- v1 内新增的 `payload` 字段应被旧客户端忽略。
- envelope 顶层不增加未协商字段；Schema 设置了 `additionalProperties: false`。
- Agent ID 在四台机器之间必须全局唯一且稳定。
- session ID 只由对应 Worker 持有；Hub 可记录但不得替另一台机器恢复该 session。协作工作流必须按 `sessionScopeId` 保存本地 session，不能让同一 Agent 的不同根任务串联上下文。
- 时间一律为 UTC ISO-8601；顺序以任务关系和消息 ID 为准，不能依赖四台机器的时钟完全一致。
- prompt/output 是否进入 Hub 日志由部署配置决定；认证 token 永远不得写日志。Token 数量属于可审计用量指标，可以记录；不得把它与认证凭据混淆。

`task.started`、`task.rejected` 和 `approval.request` 也必须在 payload 中回传当前 `attemptId`。未协商 `attempt-lease-v1` 的旧版本地模式保持 v1 原有行为。

## Device update bridge (v0.5 LAN)

设备更新桥接把 GitHub Release 更新指令通过现有 Hub WebSocket 通道转发给指定设备，由设备上独立运行的 Updater 完成 check/download/verify/stage/切换/重启/健康检查/回滚。Hub 只做权限校验、路由与状态记录，不参与更新执行。完整状态机、安装布局与断电恢复见 `docs/UPDATER_PROTOCOL.md`。

### 6.1 Hub -> Worker：`device.update.request`

由 `POST /v1/commands` 提交（LAN 共享 token 即 admin）：

```json
{ "type": "device.update.request", "deviceId": "laptop-01", "version": "0.5.0-preview16", "jobId": "uuid-or-slug" }
```

Hub 行为：

1. 校验 admin 角色、`deviceId`、`jobId`（必填，8-200 字符）。
2. `jobId` 已存在 -> 返回既有任务（幂等，`duplicate: true`），不重新下发；重试必须使用新的 `jobId`（Worker 桥接与设备 Updater 对已知 jobId 都重放终态，重复下发不会重跑）。
3. 同一 `deviceId` 已有活动更新任务 -> HTTP 409 `UPDATE_JOB_ALREADY_RUNNING`。
4. 无该 deviceId 的在线 Agent -> HTTP 409 `DEVICE_OFFLINE`。
5. 通过现有可靠投递（at-least-once，需 ack，按消息 id 去重）发送 envelope 给该设备任一在线 Agent。

### 6.2 Worker -> Hub：`device.update.status`

Worker 桥接收到 request 后：ack -> 以独立进程拉起本机 Updater（`update --job-id <id> [--version <v>]`）-> 轮询 Updater `state.json`，phase 变化即上报；Worker 自身被重启后，在启动时检查 Updater state，对未补报终态的 job 补发一次最终状态（在 Worker 自身状态中记录 `finalSent` 防重复）。

```json
{
  "v": 1, "id": "...", "type": "device.update.status", "agentId": "...",
  "payload": {
    "jobId": "...", "deviceId": "...", "phase": "downloading",
    "version": "0.5.0-preview16", "fromVersion": "0.5.0-preview15",
    "error": null, "checkedAt": "ISO-8601"
  }
}
```

phase 取值：`checking|downloading|staged|applying|restarting|verifying|completed|failed|rolled_back`。该消息加入可靠投递集合（需 ack、按 id 去重）。

### 6.3 Hub 侧状态

- 内存注册表 `updateJobs: Map<jobId, job>`（Hub 重启后丢失非终态记录属 v1 已知限制；Worker 重连补报会按 upsert 重建）。
- `GET /v1/update-jobs` 返回任务列表（Web 会话/admin）。
- 每次请求与上报都写入审计事件 `device.update.requested` / `device.update.status`。

## Human intervention

人工介入是独立持久记录，至少包含 `interventionId`、`rootTaskId`、`taskId`、`kind`、发起角色、发起阶段、`sessionScopeId`、最小上下文、允许动作和继续节点。记录初始状态为 `pending`，只能通过数据库条件更新转换一次为 `resolved`；重复或并发提交返回 HTTP `409`。

`workflow_input` 允许文本 `respond`，并从记录的父任务、角色、阶段和 session 范围创建后续任务。`task_approval`、`worker_approval` 与 `lease_expiry` 默认只允许管理员 `approve` 或 `reject`；批准时继续原任务，拒绝时进入终态。记录只保存恢复需要的目标、验收标准、任务标题和原因，不复制执行 Agent 的完整成果。Hub 重启后必须能继续列出和处理 `pending` 记录。

## HTTP control plane

- `GET /health`
- `POST /v1/auth/login`、`POST /v1/auth/logout`、`GET /v1/auth/me`
- `GET /v1/agents`
- `GET /v1/update-jobs`
- `GET /v1/events?limit=N`
- `GET /v1/tasks?rootTaskId=UUID`
- `GET /v1/attempts?taskId=UUID`
- `GET /v1/conversations`
- `GET /v1/messages?rootTaskId=UUID`
- `GET /v1/interventions?status=pending&rootTaskId=UUID`
- `GET /v1/usage`
- `POST /v1/workflows`
- `POST /v1/messages`
- `POST /v1/tasks`
- `POST /v1/commands`
- `POST /v1/interventions/{interventionId}/resolve`
- `GET|POST /v1/artifacts`、`PUT|GET /v1/artifacts/{artifactId}/content`
- 管理员：`GET|POST /v1/admin/workers`、`POST /v1/admin/workers/{credentialId}/rotate`、`DELETE /v1/admin/workers/{credentialId}`、`POST /v1/admin/users`

除 `/health` 和登录外，正式服务器的控制面均要求 Web Session。修改请求还必须通过 CSRF 与同源校验；请求体中的 `by`、`senderId` 或其他自报身份不参与授权。管理员可管理身份、批准/取消任务和控制 Worker，普通操作者可创建任务、交流和读取已授权成果。

### v0.5 并行实施控制面增量

`POST /v1/workflows` 新增可选字段 `executorAgentId?: string | null`。缺失或 `null` 保持自动调度；非空值是硬约束，优先于 Planner assignment 的 `targetAgentId`。创建时指定 Agent 不存在、离线、暂停或角色不匹配时返回 HTTP `409` 与 `code=EXECUTOR_UNAVAILABLE`，不得创建半成品 Workflow，也不得静默回退到其他 Agent。执行 revision、Attempt 恢复和 Hub 重启必须保留实际执行者与原 `sessionScopeId`。

为兼容已有 Task 响应，`schedulingError` 继续是可读字符串，并可增加 `schedulingErrorCode` 与 `schedulingErrorDetails`。旧客户端可以忽略新增字段。

正式 Server Hub 的用户管理接口扩展为：

- `GET /v1/admin/users`
- `POST /v1/admin/users`，只允许创建 `operator`；HTTP 创建 `admin` 必须拒绝
- `PATCH /v1/admin/users/{userId}`，只允许启用或停用 `operator`
- `POST /v1/admin/users/{userId}/revoke-sessions`

Worker 管理沿用现有路径。同一 `agentId` 最多存在一个 active 凭据；创建冲突返回 `409 ACTIVE_CREDENTIAL_EXISTS`。轮换必须在同一事务中撤销旧凭据并签发新凭据，提交后立即断开旧连接。明文 Token 只允许出现在创建或轮换成功响应中一次，不得进入列表、日志、事件或 URL。

登录失败必须同时受来源 IP 和规范化用户名维度的可恢复限流保护。无效用户名、错误密码与停用用户统一返回 `401 AUTH_INVALID_CREDENTIALS`；限流返回 `429 AUTH_RATE_LIMITED`、`Retry-After` 和 `retryAfterMs`。默认只信任 socket 对端地址，只有显式配置受信反向代理后才读取转发地址。

新增关键错误使用向后兼容结构：

```json
{
  "error": "human-readable summary",
  "code": "MACHINE_READABLE_CODE",
  "details": {},
  "retryAfterMs": 1000
}
```

现有客户端可以继续只读取 `error`。`details` 不得包含密码、Token、Session Secret、CSRF Secret 或其他敏感值。完整字段、查询摘要规则、冻结错误码和跨账号所有权见 `docs/V0.5_SHARED_CONTRACT.md`。

开发 Hub 默认使用 Memory Store；私人 LAN 包可显式使用单进程 JSON 文件 Store 和协调设备本地 Artifact Store；`apps/server-hub` 使用 PostgreSQL。新增 Artifact 字段位于 v1 payload 内，未启用 `artifact-transfer-v1` 的本地模式保持旧行为。共享 Token 的 LAN Artifact HTTP 请求还携带 `x-a446-agent-id`，但 Hub 仍必须依据当前任务与 Attempt 的所有权校验，不能只相信该请求头。
