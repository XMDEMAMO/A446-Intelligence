# A446 Intelligence v0.5 批次三设计与实施记录

日期：2026-09-16  
版本：`0.5.0-alpha.3`  
覆盖阶段：阶段 E、阶段 F  
状态：阶段 E、阶段 F 已验收

## 1. 交付范围

批次三在既有 Worker 探针、PostgreSQL Store、身份 Actor 和工作流状态机上增量实现运行可见性与人工恢复。不引入第二套探针框架、外部通知、远程命令、Provider 私有接口、Cookie/Profile 读取或多进程协调。

## 2. 阶段 E：资源探针统一

### 2.1 刷新与降级

- Worker 启动时运行一次资源探测，并按 `capabilityProbe.intervalMs` 低频刷新。
- `resourceSnapshot` 统一包含能力/设备、模型和可信额度三个区段，同时保留旧版 `observedCapabilities`、`models` 和 `quotaSnapshot` 字段。
- 每个区段记录 `source`、`checkedAt`、`lastSuccessAt`、`stale` 和有界 `errorSummary`。
- 状态只使用 `available / unavailable / unknown / stale`。刷新失败但存在上次可信结果时保留结果并标记 `stale`；首次失败为 `unavailable`；未配置或无可信接口为 `unknown`。
- 单项失败不关闭 WebSocket、不把 Worker 标为离线，也不阻止不依赖该项能力的任务。

### 2.2 数据来源

- 系统、架构、版本、CPU 线程/型号、内存和 Node 来自 Node 标准库。
- GPU、Python、浏览器、主要工具和本地服务只通过用户配置的 `shell=false` 探针或声明读取。
- 模型优先使用可配置的机器可读 `modelProbe`；不可读时使用配置清单，并明确 `source=config`、可用性 `unknown`。
- 额度只接受 `quotaProbe` 的机器可读 JSON。无来源时始终是 `Unknown`；探针错误不从 Token 或错误文案反推百分比。
- 探针不读取密码、Cookie、浏览器 Profile、Refresh Token、验证码、系统凭据库或认证数据库。

### 2.3 动态调度与 Web

Heartbeat 重复发送刷新后的 `capabilities`、`models` 和 `resourceSnapshot`。Hub 更新并持久化 Agent 快照，因此工具/服务能力和模型变化不需要重启 Hub。Web 参与者列表显示资源可用、不可用、未知或陈旧；额度卡单独显示可信、未知或陈旧，不与 Token 混合。

## 3. 阶段 F：人工介入持久化

### 3.1 独立记录

`human_interventions` 通过 migration `003_resource_and_interventions.sql` 扩展为独立工作流记录。记录包含：

- `interventionId`、根任务和发起任务。
- 类型、发起 Agent/角色/阶段和原 `sessionScopeId`。
- 问题、允许动作、最小上下文和显式继续节点。
- `pending/resolved` 状态、决定、真实认证 Actor 和处理时间。

最小上下文只保留目标、验收标准、任务标题和恢复原因；不复制执行 Agent 的 `fullResult`。根任务中的 `humanIntervention` 仅保留兼容 UI 摘要，独立记录是恢复依据。

### 3.2 单次处理

```text
GET /v1/interventions?status=pending
  -> Web 选择请求
POST /v1/interventions/{id}/resolve
  -> 校验认证 Actor 与允许动作
  -> 单进程同 ID 串行化
  -> PostgreSQL UPDATE ... WHERE status = 'pending'
  -> 同一事务保存决定、任务/消息、后续任务和审计
  -> 第二次或并发提交返回 409
```

工作流输入允许 `respond`，也可把批准/拒绝作为结构化决定交回记录的继续节点。任务首次审批、Worker 审批和 Lease 超时恢复只允许管理员批准或拒绝。取消任务时同步关闭其待处理介入，避免残留“需人工”状态。

### 3.3 原节点恢复

- 工作流回复以发起任务为 `parentTaskId`，使用记录的目标角色、阶段和继续 `sessionScopeId`，不会无条件以根任务作为新起点。
- Lease/任务审批复用原任务的角色、阶段、Task Spec 和 session 范围；批准后重新调度，拒绝后进入终态。
- Hub 重启时从独立 Store 恢复记录，并兼容迁移批次二留下的 `rootTaskId:current` 旧记录。
- 审计分别记录 `intervention.requested`、`intervention.resolved` 以及兼容的工作流回复/任务批准事件，不记录认证秘密或无关完整成果。

## 4. 验证记录

新增确定性覆盖：

- 能力探针成功后失败会保留最后成功值并标记陈旧。
- 模型机器可读发现、配置回退和陈旧降级。
- 可信额度成功后失败保留原窗口；从未成功时保持 `Unknown`。
- Worker 在线时刷新能力，Hub 无需重启或重连即可看到变化。
- 人工请求经 Memory Store/Hub 重启仍可列出。
- 两个并发回复只有一个成功，另一个返回 `409`。
- 后续任务沿用记录的父任务、规划角色、`human_followup` 阶段和规划 session；介入记录不含完整成果。
- 审批类介入保持管理员边界，拒绝进入终态。

结果：Hub 自动测试 `23/23 PASS`；Server Hub 包检查 PASS；Web lint 与生产构建 PASS；组合 E2E PASS。阶段 E 据此验收。

PostgreSQL 集成场景已扩展为：重启后恢复待处理介入、条件处理一次、重复提交 `409`。当前主机没有 `A446_TEST_DATABASE_URL` 或可用 PostgreSQL 服务；当前人类已确认在专用 PostgreSQL 环境中人工验证通过，因此阶段 F 标记为“已验收”。本轮没有在本机重复运行该破坏性测试。

生产依赖审计尝试访问 npm 官方漏洞数据库，但当前执行环境未授权发送依赖元数据，未取得新的审计结果。未调用真实 Codex、Antigravity 或其他模型。

## 5. 回退与下一步

- 回退代码时保留 migration 003 新增列和索引；旧版本会忽略它们，避免破坏性数据库回滚。
- Worker 可把 `capabilityProbe.intervalMs` 设为更长周期；不得用关闭安全检查或伪造资源/额度替代探针失败处理。
- 每次发布前仍应设置指向可清空专用库的 `A446_TEST_DATABASE_URL`，在 `apps/server-hub` 运行 `npm.cmd run test:postgres`，以复验 PostgreSQL 条件处理与重启恢复。
- 后续工作已进入阶段 G 的故障注入、多机验证与发布准备；真实模型调用仍需单独明确授权。
