# A446 Intelligence v0.5 批次一设计与验收记录

状态：已验收
实施日期：2026-09-15
覆盖阶段：阶段 0、阶段 A、阶段 B
对应总计划：`docs/SERVER_READY_V0.5_IMPLEMENTATION_PLAN.md`

## 1. 本批目标

批次一把原有内存 Hub 提升为可由 PostgreSQL 支撑的单进程 Server Hub，并为每次任务派发引入 Attempt 与 Lease。目标是确保 Hub 重启、Worker 断线、消息重发和旧结果迟到时，任务不会静默丢失、重复结果不会覆盖当前状态、有外部副作用风险的工作不会自动重做。

本批不包含独立 Worker/Web 身份、RBAC、中央 Artifact 文件存储、多副本高可用或真实模型调用。

## 2. 阶段 0：冻结的契约

### 2.1 Task 状态

| 当前状态 | 允许的主要下一状态 | 说明 |
| --- | --- | --- |
| `queued` | `dispatched`、`awaiting_approval`、`cancelled` | 没有合格 Worker 时保持排队 |
| `dispatched` | `running`、`completed`、`failed`、`rejected`、`cancelled`、`queued`、`awaiting_approval` | Worker 可在 started 前直接返回终态 |
| `running` | `completed`、`failed`、`rejected`、`cancelled`、`queued`、`awaiting_approval` | Lease 过期时按重试策略分流 |
| `processing_result` | 工作流下一步或终态 | Hub 内部的原子处理阶段 |
| `awaiting_approval` | `queued`、`cancelled` | 只有明确人工操作才能继续 |
| `completed`、`failed`、`rejected`、`cancelled` | 无 | 终态禁止被迟到消息覆盖 |

### 2.2 Attempt 状态

| 当前状态 | 允许的主要下一状态 |
| --- | --- |
| `assigned` | `running`、`completed`、`failed`、`rejected`、`cancelled`、`awaiting_approval`、`expired` |
| `running` | `completed`、`failed`、`rejected`、`cancelled`、`awaiting_approval`、`expired` |
| 其余状态 | 无；后续消息按 stale 记录 |

每次派发创建新的 `attemptId`，`attemptNumber` 在同一任务内单调递增。只有消息的 `attemptId` 等于任务的 `currentAttemptId`、Worker 匹配且 Attempt 仍活跃时，消息才可改变任务状态。

### 2.3 恢复规则

- Hub 重启时从 Store 恢复任务、消息、Attempt、未确认出站消息、入站去重 ID、Worker 快照、审计事件和序号。
- 恢复出的 Worker 一律先标记为离线，待新的 `worker.hello` 后再上线。
- 未确认出站消息沿用原 envelope ID；重连后再次发送，保持 at-least-once 语义。
- 运行中任务在 Lease 未过期时等待原 Worker 重连并继续提交结果。
- Lease 过期时，Task Spec 明确声明 `side_effects=none|idempotent` 的任务才可自动恢复；其他任务进入 `awaiting_approval`。
- 自动恢复默认最多 3 次；达到上限后转人工确认。
- 动态调度任务可改派给其他在线 Worker；明确指定 Worker 的任务在该 Worker 离线时保持排队。
- 旧 Attempt 的迟到消息进入幂等记录和审计，不修改任务输出或终态。

## 3. 存储与事务边界

共享 Hub 编排核心通过 Store 接口使用两种实现：

- `MemoryHubStore`：本地开发和确定性单元测试。
- `PostgresHubStore`：`apps/server-hub` 的正式服务器入口，依赖 `pg` 和原生 SQL migration。

单次状态提交可同时包含：

- Task 更新；
- 群聊消息追加；
- Worker 注册快照；
- Attempt 更新；
- 出站可靠投递新增或确认删除；
- 入站消息幂等记录；
- 审计事件；
- 消息序号和 Token 汇总元数据。

PostgreSQL Store 在一个数据库事务内提交上述变化。Hub 必须先提交任务、Attempt 和出站消息，再向 WebSocket 发送。Worker 结果则把任务变化、Attempt 终态、入站去重记录和审计事件一起提交后才 ACK。

结果类状态转换使用数据库条件更新，条件至少包含原 `current_attempt_id` 和允许的原 Task 状态。条件不匹配时整笔事务失败，不允许旧结果获胜。

## 4. PostgreSQL Schema

首个只向前 migration 为 `apps/server-hub/migrations/001_persistent_scheduling.sql`，包含：

| 表 | 用途 |
| --- | --- |
| `schema_migrations` | migration 版本记录 |
| `hub_metadata` | 消息序号和聚合元数据 |
| `tasks` | Task 当前状态与完整文档 |
| `task_messages` | 根任务群聊消息 |
| `worker_registrations` | Worker 最近注册快照 |
| `inbound_messages` | Worker 到 Hub 的持久幂等键 |
| `outbound_deliveries` | Hub 到 Worker 的可靠 Outbox |
| `task_attempts` | Attempt、Worker、租约与结果元数据 |
| `audit_events` | 有序审计事件 |
| `artifacts` | 后续批次启用的 Artifact 元数据占位 |
| `human_interventions` | 后续批次扩展的人工介入记录占位 |

数据库连接只从 `A446_DATABASE_URL`（或配置指定的环境变量名）读取。配置文件不得保存连接密码或 Hub Token。

## 5. 协议 v1 增量

所有新增字段都位于既有 envelope 的 payload 内，不修改 v1 顶层：

- `worker.hello.payload.protocolFeatures` 声明 `attempt-lease-v1`。
- `hub.welcome.payload.protocolFeatures` 和 `leaseTtlMs` 返回协商结果。
- `task.assign.payload.attemptId` 与 `lease` 描述本次派发。
- `worker.heartbeat.payload.currentAttemptId` 只续租当前 Attempt。
- `task.started`、`task.result`、`task.error`、`task.rejected`、`approval.request` 回传 `attemptId`。
- `task.cancel.payload.attemptId` 防止旧取消消息杀死新 Attempt。
- `GET /v1/attempts?taskId=...` 提供只读检查接口。

生产 Server Hub 启用 Lease 后，不向未声明 `attempt-lease-v1` 的 Worker 派发。

## 6. 生产配置与启动失败策略

示例位于 `apps/server-hub/config/server.example.json`：

- 默认绑定 loopback，由反向代理终止 TLS/WSS。
- `auth.required=true`，Token 来自 `HUB_TOKEN`。
- `storage.driver=postgres`，连接串来自 `A446_DATABASE_URL`。
- Lease 默认 TTL 30 秒、扫描间隔 5 秒、自动恢复最多 3 次。
- payload 日志默认关闭。

正式入口没有数据库连接串、驱动、migration 或数据库连接失败时拒绝启动。开发 Hub 仍可使用 Memory Store，不需要 PostgreSQL，也没有给 Worker 增加 Docker、Python或原生扩展依赖。

## 7. 主要文件

- `apps/agent-hub/src/hub-store.mjs`
- `apps/agent-hub/src/hub.mjs`
- `apps/agent-hub/src/worker.mjs`
- `apps/agent-hub/src/event-log.mjs`
- `apps/agent-hub/src/collaboration.mjs`
- `apps/agent-hub/protocol/task-spec.schema.json`
- `apps/agent-hub/docs/protocol-v1.md`
- `apps/agent-hub/test/persistence-lease.test.mjs`
- `apps/server-hub/`
- `scripts/check-all.ps1`

## 8. 验收范围

确定性 Hub 测试覆盖：

- Store 后重启仍恢复未确认派发的原 envelope ID。
- Lease 心跳续期。
- 可安全重试任务生成新 Attempt，旧 Attempt 结果不获胜。
- 动态任务避开离线 Worker 重新分配。
- 未知副作用任务转人工确认。
- 自动恢复达到上限后转人工确认。
- 原有双 Worker、会话、路由、暂停、审批、取消、Policy、Checkpoint、Artifact 哈希与协作闭环回归不变。

真实 PostgreSQL 集成测试覆盖：

- 自动执行 migration。
- 任务运行中重启 Hub。
- Worker 断线后自动重连，并由原 Attempt 完成任务。
- 再次重启后读取终态、待审批任务、消息、Attempt、Worker 离线快照和审计事件。
- 数据库条件状态更新在真实 Worker 结果路径中执行。

最终验收记录（2026-09-15）：

- 实施前基线：Hub 12/12；Web lint、生产构建和组合 E2E 均 PASS。
- 最终 `scripts/check-all.ps1`：Hub 17/17；Server Hub 结构/驱动检查 PASS；Web lint PASS；生产构建 PASS；组合 E2E PASS。
- `apps/server-hub` 真实 PostgreSQL 17 集成测试：1/1 PASS，包含运行中重启、Worker 重连、终态/待审批/取消状态恢复、入站去重和未确认 Outbox 原 envelope ID 恢复。
- `npm audit --omit=dev`：agent-hub 与 server-hub 均为 0 vulnerabilities。
- 测试使用精确命名、只绑定 loopback 且带 `--rm` 的临时容器；验收后容器和测试数据库已删除，不可恢复且不包含业务数据。
- 真实模型调用：未运行。

## 9. 回退方式

- 本地开发可继续通过原入口使用 `MemoryHubStore`，无需设置数据库环境变量。
- 正式入口与 PostgreSQL 依赖隔离在 `apps/server-hub`，删除该包不会改变 Worker 的依赖集合。
- migration 只向前执行。本批没有自动 down migration；回退应用版本前应先备份数据库，并保留新增表，避免不可逆数据丢失。

## 10. 已知限制与下一批入口

- 当前 Server Hub 是单进程部署；没有多副本选主、分布式锁或跨实例审计序号分配。
- 批次一仍使用共享 Hub Token，尚未区分 Worker 与 Web 身份。
- `artifacts` 和 `human_interventions` 只是数据库占位；完整 Artifact Store 和只能处理一次的人工介入流程分别在后续批次实现。
- 尚无 PostgreSQL 备份/恢复运维脚本和长时间故障注入报告。
- 没有调用 Codex、Antigravity 或其他真实模型。

下一批从阶段 C 与阶段 D 开始：先定义 Artifact Blob/元数据的一致性与访问授权，再共同实现中央 Artifact Store、独立 Worker/Web 身份和最小 RBAC。
