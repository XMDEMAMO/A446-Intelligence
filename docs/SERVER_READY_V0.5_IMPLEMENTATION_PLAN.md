# A446 Intelligence v0.5 Server Ready 实施计划

状态：已确认作为后续实施基线
建立日期：2026-09-15
当前基线：local-agent-hub v0.5.0-alpha.3 + a446-server-hub v0.5.0-alpha.3
实施状态：批次一（阶段 0、A、B）与批次二（阶段 C、D）已验收；批次三进行中，阶段 E 已验收，阶段 F 等待真实 PostgreSQL 验收

## 1 目的与适用范围

本计划把用户提供的《A446 Intelligence v0.5 Server-Ready 必要功能实施计划》整理为仓库内可持续执行、检查和更新的施工基线。目标是在不重写现有多 Agent 协作闭环的前提下，补齐正式服务器运行所需的最低可靠性、安全性和跨设备能力。

本计划适用于 v0.5 Server Ready 相关的设计、实现、测试、文档和发布准备。它规定范围、批次、验收门槛和停止条件，但不覆盖更高优先级的要求：

1. 当前人类请求始终拥有最高优先级。
2. `docs/AI_AGENT_MANUAL.md` 和 `apps/agent-hub/AI_IMPLEMENTATION_GUIDE.md` 中的安全不变量不得削弱。
3. Worker 或协议行为变更必须遵守 `apps/agent-hub/docs/protocol-v1.md` 和 JSON Schema。
4. 本计划中的待办项不是自动授权。真实模型调用、外部服务变更、凭据操作和部署仍需符合当前请求与安全规则。

## 2 执行方式

v0.5 允许一次实现多个紧密相关的阶段，不要求每次对话只完成一个阶段。实施按四个批次推进：

| 批次 | 包含阶段 | 组合原因 |
| --- | --- | --- |
| 批次一 | 阶段 0、A、B | 数据持久化、可靠投递、Attempt 和 Lease 共用状态模型与事务边界，拆开容易产生不可安全恢复的中间状态 |
| 批次二 | 阶段 C、D | Artifact 上传下载必须与服务器身份和授权边界共同验收，避免先形成缺少权限保护的文件接口 |
| 批次三 | 阶段 E、F | 资源探针和人工介入已有本地雏形，均建立在持久化、身份和统一状态模型之上 |
| 批次四 | 阶段 G | 集中完成故障注入、真实多机验证、发布检查和部署说明 |

批次执行规则：

- 一个批次可以连续实现多个阶段，但每个阶段仍保留独立提交、测试记录和验收结论。
- 前置阶段的关键验收失败时，先修复该阶段，不继续堆叠后续功能。
- 每个批次结束时必须运行 `scripts/check-all.ps1`；阶段内的行为变更先运行更聚焦的确定性测试。
- PostgreSQL、认证和 Artifact Store 不能只靠 Mock 测试宣布通过，必须运行对应的真实组件集成测试。
- 每批次交付时只报告修改范围、验收结果、精确测试结果、回退方式和已知限制。
- 未收到开始实施的明确请求前，本文件只作为计划，不自动触发代码变更或真实模型调用。

## 3 当前基线与已有能力

当前仓库已经具备以下可复用基础：

- React 控制台、HTTP 控制面和 Hub 与 Worker 的 WebSocket v1 协议。
- Worker 主动连接、重连、心跳、ACK、消息去重、持久 Outbox 和串行任务队列。
- Planner、Executor、Reviewer 协作闭环以及受限的角色上下文。
- Codex 和 Antigravity 的本地持久会话。
- Worker 本地 Policy、路径边界、Checkpoint、Artifact 清单和 SHA-256。
- 模型、额度和工具的初步探针，以及 `Unknown` 降级语义。
- Web 人工介入入口、任务审批、暂停、恢复、取消和事件记录。

计划制定时的正式服务器阻塞项（当前进度以第 13 节状态表为准）：

- 批次一已解决任务、消息、Agent、Attempt、审计和待确认投递的 PostgreSQL 持久化；人工介入的一次性独立记录仍属于阶段 F。
- 批次一已解决服务器侧 Attempt、Lease、超时恢复和安全重派。
- 批次二已解决中央 Artifact 内容存储、跨 Worker 下载、双端哈希校验和结果门禁。
- 批次二已解决独立 Worker 凭据、Web 登录 Session、CSRF 和管理员/操作者权限。
- 阶段 E 已将资源探针扩展为启动及运行期低频刷新，统一能力、设备、模型、可信额度的来源、时间、最后成功、陈旧和错误语义；未提供官方接口的 Provider 额度仍保持 `Unknown`。
- 阶段 F 的独立人工介入记录、最小恢复上下文、单次条件处理、Web 操作和原节点/session 恢复已实现；真实 PostgreSQL migration/重启/并发验收尚待专用测试数据库。

## 4 目标运行结构

```text
浏览器
  │ HTTPS 同源 API 与安全会话 Cookie
  ▼
TLS 反向代理
  │
  ▼
单个 Server Hub 进程
  ├── PostgreSQL：任务、Attempt、消息、身份、审计和元数据
  └── Local Artifact Store：服务器本地成果文件
        ▲
        │ WSS 与 HTTPS，Worker 主动连接
        ├── Codex Worker
        ├── Antigravity Worker
        └── 其他兼容 Worker
```

实施边界：

- 保持一个 Hub 进程，不拆微服务。
- 保留当前 `apps/agent-hub` 的 Worker 和 Mock Hub 用途。
- 新增独立的生产 Server Hub 入口或包，使 PostgreSQL 等服务端依赖不成为 Worker 的必需依赖。
- 通过小范围抽取和依赖注入复用现有编排、协议和状态机，不复制一套新的协作逻辑。
- 开发模式可继续使用 Memory Store；正式服务器模式必须使用 PostgreSQL，并在依赖缺失时拒绝启动。
- 模型推理、浏览器自动化和重型文件处理继续留在 Worker，不放到控制服务器。

## 5 批次一 持久调度基础

### 5.1 阶段 0 基线与契约冻结

实施内容：

- 确认工作树和当前分支，不覆盖现有用户修改。
- 运行 `scripts/check-all.ps1`，记录 v0.4.0 的真实基线结果。
- 固定任务状态、Attempt 状态、允许转换、终态保护和 Hub 重启恢复规则。
- 固定存储接口、数据库事务边界、幂等键和迁移方式。
- 确定生产配置项、环境变量、数据目录和开发回退开关。
- 明确 v1 payload 增量和 Worker 能力协商；若需要不兼容变更，先提出协议版本升级。

阶段产物：

- 简短的状态转换表和恢复规则。
- 第一版 PostgreSQL Schema 与 migration 清单。
- 需要修改和新增的文件清单。
- 基线测试报告。

### 5.2 阶段 A Hub 持久化

实施内容：

- 引入可替换的 Hub Store 接口，并提供 Memory 和 PostgreSQL 两种实现。
- 生产服务器优先使用轻量 PostgreSQL 驱动和原生 SQL migration，不引入大型 ORM。
- PostgreSQL 连接信息只从环境变量读取，不写入仓库配置。
- 持久化以下核心对象：
  - 根任务、子任务、状态、关系和工作流上下文。
  - 群聊消息和附件引用。
  - Worker 注册快照；Hub 启动后先标记为离线，重连后更新在线状态。
  - 人工介入状态和 Artifact 元数据占位。
  - 入站 envelope 幂等记录。
  - 需要 ACK 的出站 envelope、原始消息 ID 和确认状态。
  - 审计事件及其顺序。
- 状态变更、消息追加和可靠投递记录使用同一事务或可靠 Outbox 模式提交。
- Hub 重启后恢复未确认投递时沿用原 envelope ID，避免 Worker 将它识别成新任务。
- 终态任务保持终态；非终态任务进入明确的恢复或重新调度流程，不得静默丢失。
- 保留当前 HTTP API 和前端数据形状，必要新增字段应向后兼容。

建议核心表：

- `schema_migrations`
- `tasks`
- `task_messages`
- `worker_registrations`
- `inbound_messages`
- `outbound_deliveries`
- `audit_events`
- `artifacts`
- `human_interventions`
- `task_attempts`，在阶段 A 建表、阶段 B 启用完整行为

阶段 A 验收：

- 创建任务和群聊后重启 Hub，数据仍可读取。
- 已完成、失败、拒绝和取消的任务不会重新执行。
- Hub 重启前尚未确认的派发在重启后继续投递，且 Worker 不会重复执行同一消息。
- 运行中任务不会静默消失，并留下明确的恢复状态和审计记录。
- 数据库不可用时，正式服务器模式启动失败；开发 Memory 模式仍可运行。

### 5.3 阶段 B Attempt Lease 与故障恢复

实施内容：

- 每次派发创建唯一 Attempt，并记录任务、Worker、派发 envelope、开始时间、状态、租约期限和结果时间。
- `task.assign.payload` 增加 `attemptId` 和租约信息；Worker 在 `task.started`、`task.result`、`task.error`、`task.rejected` 和心跳中回传当前 Attempt。
- 新字段只放在 v1 payload 中，并通过 Worker 能力声明启用；不把 Lease 任务派给不支持该能力的 Worker。
- Worker 心跳只续租当前任务的当前 Attempt。
- 后台 Lease Reaper 定期扫描过期 Attempt。
- 无外部副作用或明确幂等的任务可以重新调度；存在外部副作用或属性未知的任务默认转人工确认。
- 结果提交使用数据库条件更新：只有 `current_attempt_id` 匹配且任务仍允许转换时才能改变任务状态。
- 旧 Attempt 的迟到结果可以留档和审计，但必须标记为 stale，不能覆盖当前结果或终态。
- 保留 at-least-once 语义，不声称实现 exactly-once。

初始可配置默认值：

- Worker 心跳间隔沿用当前约 5 秒配置。
- Lease TTL 默认 30 秒。
- Reaper 扫描间隔默认 5 秒。
- 所有数值均可由服务器配置覆盖，并在故障测试后再调整。

阶段 B 验收：

- 执行中断开 Worker，任务在租约过期后恢复或重新分配。
- 旧 Worker 恢复并提交迟到结果时，新结果和任务终态不被覆盖。
- 单 Worker 场景不会形成无限重复重派。
- 有外部副作用的任务不会因 Lease 超时自动重复执行。
- 正常 Planner 到 Executor 到 Reviewer 流程行为不变。

## 6 批次二 Artifact 与身份边界

### 6.1 阶段 C 中央 Artifact Store

实施内容：

- 在 Server Hub 中增加 Local Artifact Store，根目录位于仓库之外并由配置指定。
- 服务器生成内部对象键，不直接使用 Worker 提供的绝对路径或未清理文件名作为存储路径。
- 上传采用流式处理，先写临时文件，验证大小和 SHA-256 后原子移动到正式位置。
- Artifact 状态至少包含 `uploading`、`ready`、`invalid`、`missing`。
- 数据库保存 Artifact ID、任务、Attempt、原始文件名、大小、SHA-256、状态和存储键。
- 只上传 Task Spec 声明的输出；缺失、超限或哈希不一致的文件不能标记为可用。
- Worker 下载 Artifact 时只能写入自身允许工作区内的受控路径，并在交给 Adapter 前再次校验 SHA-256。
- Web 只获取授权后的下载入口和元数据，不暴露服务器文件系统路径。
- API 对大文件使用流式读写，避免在 2 核 4 GB 服务器上整文件进入内存。
- 第一版不实现版本历史、在线预览、S3、MinIO 或自动生命周期管理。

阶段 C 验收：

- Worker A 生成并上传文件，Worker B 能下载、校验并审核。
- 错误哈希、超限文件、未声明文件和路径逃逸均被拒绝。
- Artifact Store 和 Hub 重启后，已就绪成果仍可访问。
- 任务结果只有在所需 Artifact 状态有效时才能呈现为可下载成果。

### 6.2 阶段 D 最小身份与权限

实施内容：

- 区分 Worker 身份和 Web 用户身份，不再让正式服务器共用一个全局 Token。
- 每个逻辑 Worker 使用独立高熵凭据，并绑定允许的 `agentId`、`deviceId` 和状态。
- 服务器只保存凭据哈希；明文凭据生成时显示一次，可单独撤销和轮换。
- Web 第一版提供管理员和普通操作者两级角色。
- 用户密码使用 Node.js 安全密码派生能力保存，不存明文；登录后使用服务端 Session 和 `HttpOnly`、`Secure`、`SameSite` Cookie。
- 对修改操作执行同源或 CSRF 检查。
- 后端统一建立认证 Actor，上游请求中的 `by`、`agentId` 等自报字段不能作为授权依据。
- 高风险操作至少包括 Worker 凭据管理、设备管理、任务取消、人工批准和管理员配置。
- 审计记录包含真实 Actor、动作、目标、结果和时间，但不记录 Token、密码或会话秘密。
- 可保留仅用于回环或受信开发环境的 Legacy Token 模式；正式服务器模式禁止使用它替代独立身份。

阶段 D 验收：

- 撤销一个 Worker 的凭据不会影响其他 Worker。
- 凭据绑定的 Worker 不能冒充其他 `agentId`。
- 未登录用户无法读取受保护数据或执行任务操作。
- 普通操作者不能执行管理员专属操作。
- Artifact 上传下载只对有权访问对应任务的 Actor 开放。
- 日志、数据库导出示例和发布包中不存在明文凭据。

## 7 批次三 运行可见性与人工恢复

### 7.1 阶段 E 资源探针统一

实施内容：

- 沿用现有 `capability-probe.mjs`、`quota-probe.mjs` 和状态归一化逻辑，不另写一套探针框架。
- 将启动探测扩展为启动时执行一次、运行中低频刷新。
- 统一上报模型、额度、设备能力、数据来源、探测时间、最后成功时间、陈旧状态和错误摘要。
- 模型列表优先读取官方或稳定的本地客户端接口；不可读时使用配置清单并标明来源。
- 额度只接受可信的机器可读来源；不可读时保持 `Unknown`，不从 Token 数或错误文案猜百分比。
- 设备能力只收集调度真正需要的系统、CPU、内存、GPU、Node、Python、浏览器、主要工具及用户配置的服务描述。
- 探针失败保留最后可信值并标记陈旧，不导致整个 Worker 离线。
- 不读取 Cookie、浏览器 Profile、Refresh Token、系统凭据库或认证数据库。

阶段 E 验收：

- Hub 和 Web 能区分确定可用、不可用、未知和陈旧。
- 单个探针失败不会阻止 Worker 接受其他可执行任务。
- 能力变化可在不重启 Hub 的情况下刷新。
- 没有可信额度来源时始终显示 `Unknown`。

### 7.2 阶段 F 人工介入持久化

实施内容：

- 把人工介入请求保存为独立记录，关联根任务、发起任务、发起角色、阶段和 `sessionScopeId`。
- 保存恢复所需的最小上下文和继续节点，不复制无关完整成果。
- Web 控制台读取待处理请求，并提交批准、拒绝或文本回复。
- 人工回复使用数据库条件更新，只允许从待处理状态转换一次；重复提交返回冲突。
- 处理后从记录的工作流节点和会话范围继续，而不是无条件从根任务重新开始。
- Hub 重启后仍能列出、处理和恢复请求。
- 预留通知接口和事件，但 v0.5 不实现 QQ、Telegram、邮件或任意远程命令。

阶段 F 验收：

- 人工请求产生后重启 Hub，请求仍在且上下文完整。
- 同一请求的并发或重复回复只有一个生效。
- 恢复任务沿用正确角色、阶段和模型会话范围。
- 审计记录能说明谁在何时对哪个请求作出何种决定。

## 8 批次四 验证与发布准备

### 8.1 自动验证

必须新增或扩展以下确定性测试：

- PostgreSQL migration、Store 契约和 Hub 重启恢复。
- 入站幂等、持久 Outbox 和原 envelope ID 重投。
- Lease 续租、过期重派、单 Worker 恢复和 stale 结果拒绝。
- 外部副作用任务在过期后转人工确认。
- Artifact 跨 Worker 上传下载、大小限制、路径边界和错误哈希。
- Worker 凭据绑定、单独撤销、Web 登录、角色权限和 CSRF 防护。
- 探针刷新、陈旧状态及 `Unknown` 降级。
- 人工请求持久化、单次处理和原节点恢复。
- 现有 Planner、Executor、Reviewer、审批、暂停、恢复、取消、Token 和额度测试全部保持通过。

每个批次至少执行：

```powershell
.\scripts\check-all.ps1
```

涉及 PostgreSQL 的测试必须连接专用测试数据库。没有运行真实 PostgreSQL 测试时，只能报告单元测试结果，不能宣布阶段 A 或 B 完成。

### 8.2 故障注入

先使用 Mock Adapter，再在获得明确授权后使用真实 Adapter：

1. 任务运行中重启 Hub。
2. 任务运行中断开 Executor Worker。
3. 审核阶段断开 Reviewer Worker。

每种场景都检查任务、Attempt、消息、人工请求、Artifact 和终态是否一致，不只检查进程是否重新上线。

### 8.3 真实多机验证

- 使用真实 Codex 和 Antigravity 完成一次规划、执行、审核和规划回收全流程。
- 记录设备、Agent、模型、Attempt、耗时、Token、可信额度状态、返工次数和 Artifact 哈希。
- 真实调用会消耗用户现有产品额度，必须在执行前获得当前人类请求的明确授权。
- 不得以付费 API Key 替代本地已登录客户端，也不得自动处理登录、账号切换或额度限制。

### 8.4 发布准备

- 提供生产环境变量清单和 `.env.example`，不包含可用秘密。
- 提供 PostgreSQL migration、备份和恢复说明。
- 提供 Artifact 根目录、权限、容量和备份说明。
- 提供 TLS 反向代理、Server Hub 和 Worker 的最小启动顺序。
- 检查日志中没有 Token、密码、Cookie、凭据和不必要的任务正文。
- 检查发布包不包含 `node_modules`、运行状态、日志、数据库、Artifact 内容、工作区或 Checkpoint。
- 更新版本、锁文件、用户手册、AI 手册、协议、配置示例和发布说明。

阶段 G 验收：

- 自动测试、Lint、生产构建、组合端到端测试和生产依赖审计全部通过。
- 三种故障场景不会造成任务永久丢失、错误终态或旧结果覆盖。
- 跨设备 Artifact 可以下载并通过 SHA-256 校验。
- 真实多机测试只有在明确授权并实际成功后才能标记通过。
- Server Ready 条件满足后停止增加功能，进入独立的服务器部署任务。

## 9 跨阶段安全与兼容约束

- 第三方账号凭据始终留在 Worker 本机；Hub 不读取、不保存、不迁移。
- Worker 本地 Policy 拒绝不能被服务器许可覆盖。
- 输入、输出、Checkpoint 和下载 Artifact 都必须遵守工作区 canonical path 和符号链接边界。
- 浏览器不得持有 Worker Token 或服务器管理 Token。
- 认证 Token、密码和会话秘密不得进入日志、事件、任务上下文或发布包。
- WebSocket 保持 at-least-once；幂等由持久消息 ID、Attempt 和条件状态转换共同保证。
- 新 v1 payload 字段允许旧端忽略；不兼容 envelope 或语义变更必须显式升级协议。
- 探针失败必须降级；未知数据必须显示 `Unknown` 或 `Unavailable`。
- 不把 Docker、WSL、Python、TypeScript 编译、原生扩展或 UI 自动化变成 Worker 必需依赖。
- 每个阶段结束后保持 Mock 本地模式可运行、生产模式可回退、数据库 migration 可追踪。

## 10 v0.5 完成定义

- [ ] Hub 重启不会丢失任务、消息、人工请求、可靠投递和 Artifact 记录。
- [ ] Worker 断线不会让任务无限卡死，重新调度后旧结果不会覆盖新结果。
- [ ] Artifact 可以在不同 Worker 间传递并通过 SHA-256 校验。
- [ ] 每个 Worker 使用独立、可撤销且不可冒用其他 Agent 的凭据。
- [ ] Web 用户具备管理员和普通操作者的最小权限边界。
- [ ] 模型、额度和设备能力使用统一状态，未知信息正确显示 `Unknown`。
- [ ] 人工介入在 Hub 重启后仍可处理，并从正确节点继续。
- [ ] 全量自动检查和三种关键故障注入通过。
- [ ] 在明确授权后，真实 Codex 与 Antigravity 多机任务完成一次全流程。
- [ ] 发布包、配置、日志和数据库示例不包含本机秘密。
- [ ] 环境变量、数据目录、migration、备份和启动说明完整。
- [ ] 全部条件满足后停止扩展功能，转入服务器部署。

## 11 明确推迟到 v0.5 之后

- QQ、Telegram、邮件通知和远程人工介入。
- 企业 SSO、复杂 RBAC、团队、组织和多租户体系。
- S3、MinIO、Artifact 版本管理和在线预览。
- Redis、消息队列、Kubernetes、自动扩缩容和高可用 Hub。
- 完整成本分析和额度仪表盘。
- 不受官方接口支持的精确额度抓取。
- 自动网络发现和复杂调度策略。
- 大规模压力测试和全面性能调优。
- 黑盒 CLI 单轮内部的细粒度恢复。

## 12 默认决策与待确认依赖

若后续人类请求没有另行指定，实施采用以下默认决策：

- 数据库使用 PostgreSQL。
- 正式服务器保持一个 Hub 进程。
- Artifact 第一版使用服务器本地磁盘，根目录位于仓库之外。
- 单文件默认上限沿用当前 100 MB，并允许配置覆盖。
- 生产数据库连接、Worker 凭据和用户秘密只通过环境变量或一次性安全初始化流程提供。
- TLS 由反向代理终止，Worker 通过 WSS、浏览器通过 HTTPS 访问。
- 开发环境继续保留 Memory Store 和回环地址模式。

开始对应批次前需要确认或准备：

- 可用于 migration 和集成验收的 PostgreSQL 实例与测试数据库。
- 目标服务器操作系统、域名、TLS 和反向代理方式。
- Artifact 数据目录、磁盘预算、单文件上限和备份位置。
- 初始管理员的安全初始化方式和 Session 有效期。
- 阶段 G 是否授权真实 Codex 与 Antigravity 调用。

## 13 交付与状态记录

每个阶段使用以下状态之一：`未开始`、`进行中`、`已验收`、`阻塞`、`推迟`。

| 阶段 | 当前状态 | 验收记录 |
| --- | --- | --- |
| 阶段 0 基线与契约冻结 | 已验收 | 2026-09-15：实施前 `check-all.ps1` 全绿（Hub 12/12、Web lint/build、E2E PASS）；状态机、事务边界、Schema 和恢复规则见批次一记录 |
| 阶段 A Hub 持久化 | 已验收 | 2026-09-15：Memory/PostgreSQL Store、SQL migration、可靠 Outbox/Inbox、消息与审计恢复完成；真实 PostgreSQL 重启与未确认 envelope 恢复测试 1/1 PASS |
| 阶段 B Attempt Lease 与恢复 | 已验收 | 2026-09-15：Attempt、Lease、能力协商、条件状态更新、过期重派、stale 隔离及恢复上限完成；Hub 17/17、全仓 E2E 与真实 PostgreSQL 测试 PASS |
| 阶段 C 中央 Artifact Store | 已验收 | 2026-09-15：仓库外 Local Artifact Store、服务器对象键、流式临时写入与原子落盘、大小/SHA-256 校验、声明路径约束、跨 Worker 下载复核、结果门禁和重启恢复完成；真实 PostgreSQL/文件流场景 PASS |
| 阶段 D 最小身份与权限 | 已验收 | 2026-09-15：独立 Worker 凭据及即时撤销/轮换、agentId/deviceId 绑定、Web scrypt 用户与服务端 Session、HttpOnly/Secure/SameSite Cookie、CSRF/Origin、admin/operator RBAC 和真实 Actor 审计完成；真实身份/权限场景 PASS |
| 阶段 E 资源探针统一 | 已验收 | 2026-09-16：启动及低频刷新、设备/工具/服务/模型/额度统一快照、来源与最后成功时间、陈旧保留、配置模型回退、动态能力刷新和 Web 状态展示完成；资源专项 4/4、Hub 全量 23/23、Web lint/build、E2E PASS |
| 阶段 F 人工介入持久化 | 进行中 | 2026-09-16：独立 Store/表记录、migration 003、最小上下文、Web 批准/拒绝/回复、pending 条件更新、并发单次处理、原父任务/角色/阶段/session 恢复及审计已实现；Memory 重启与并发测试 2/2 PASS，真实 PostgreSQL 测试因未提供 `A446_TEST_DATABASE_URL` 尚未执行，不能标记已验收 |
| 阶段 G 验证与发布准备 | 未开始 |  |

每次交付后更新本表，并按以下结构报告：

```text
批次与阶段：
实现内容：
关键文件：
验收结果：
测试结果：
真实模型是否运行：
回退方式：
已知限制：
下一批次入口：
```
