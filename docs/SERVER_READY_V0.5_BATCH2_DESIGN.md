# A446 Intelligence v0.5 批次二设计与验收记录

日期：2026-09-15  
版本：`0.5.0-alpha.2`  
覆盖阶段：阶段 C、阶段 D

## 1. 交付范围

批次二把首批预留的 `artifacts` 表升级为中央制品库，并同时替换正式 Server Hub 的共享 Token。Artifact 接口与身份边界共同上线，避免产生任何无权限保护的临时文件接口。本批不引入对象存储、文件版本、在线预览、生命周期清理或多进程 Server Hub。

## 2. 中央 Artifact Store

### 2.1 数据与文件边界

- `A446_ARTIFACT_ROOT` 指向仓库外的绝对目录；启动时拒绝仓库内目录。
- Worker 只提交 Task Spec 中声明的工作区相对路径。服务器生成不可预测的 Artifact ID 和内部 `storageKey`，外部响应不返回 `storageKey` 或服务器绝对路径。
- PostgreSQL 保存 Artifact ID、任务、根任务、Attempt、声明路径、原始文件名、大小、SHA-256、状态、内部对象键和时间戳。
- 状态为 `uploading / ready / invalid / missing`。只有 `ready` 提供下载入口。
- 单文件默认上限 100 MiB，可通过 `artifacts.maxFileBytes` 收紧。

### 2.2 写入与读取

```text
Worker POST 元数据
  -> Hub 校验 Worker/Task/Attempt/声明路径
  -> uploading 元数据持久化
  -> Worker PUT 流
  -> .tmp 文件 + 增量大小/SHA-256 校验
  -> 原子移动到 objects/<前缀>/<随机对象键>
  -> ready 元数据持久化
```

大小、哈希、声明路径或 Attempt 任一不匹配时均不能进入 `ready`。Hub 收到 `task.result` 后再次把清单与数据库记录逐项核对；所需制品不完整时，任务以 `ArtifactValidationError` 失败，不推进工作流，也不生成可下载成果消息。

Reviewer 等下游 Worker 只收到 Artifact ID、目标相对路径、大小和哈希。Worker 下载到自身 Policy 允许的工作区临时文件，复核字节数与 SHA-256 后原子落盘，再调用 Adapter。

## 3. 身份与权限

### 3.1 Worker

- 凭据格式包含公开凭据 ID 和 256 位随机秘密；数据库只保存秘密的 SHA-256。
- 每个凭据绑定一个 `agentId` 和 `deviceId`，可独立创建、轮换和撤销。
- WebSocket 升级先认证，`worker.hello` 的 `agentId/deviceId` 必须与认证 Actor 一致。
- Worker 只能为自己当前 Task Attempt 登记和上传声明输出；只能下载自己生成或当前下游任务明确引用的制品。

### 3.2 Web

- 用户角色为 `admin` 或 `operator`；密码通过 Node.js `scrypt` 派生后保存。
- 登录创建服务器端不透明 Session；浏览器只持有 `HttpOnly; Secure; SameSite=Strict` Cookie，修改操作同时校验 CSRF Token 和 Origin。
- `admin` 独占用户/Worker 凭据管理、任务批准与取消、Worker 暂停与恢复；`operator` 可读取控制面、创建任务和发送协作消息。
- Hub 从认证结果创建统一 Actor。请求体中的 `by`、`senderId`、`agentId` 不作为授权或审计身份。
- 认证和管理事件只记录 Actor、目标与结果，不记录密码、Token、Session Secret 或 CSRF Secret。

正式 `apps/server-hub` 配置必须使用 `auth.mode=identity`，存在 `tokenEnv` 时拒绝启动。本地 Memory Hub 的 Legacy Token 行为保持兼容，但只适用于回环或受信开发环境。

## 4. 接口

| 接口 | Actor | 作用 |
| --- | --- | --- |
| `POST /v1/auth/login` | 匿名 | 建立 Web Session |
| `POST /v1/auth/logout`、`GET /v1/auth/me` | Web | 注销或读取当前用户 |
| `POST /v1/artifacts` | Worker | 登记声明输出或缺失输出 |
| `PUT /v1/artifacts/:id/content` | 所属 Worker | 流式上传 |
| `GET /v1/artifacts/:id/content` | 授权 Web/Worker | 流式下载 |
| `/v1/admin/workers*`、`POST /v1/admin/users` | admin | 管理身份 |

CLI `npm.cmd run identity -- ...` 提供初始管理员以及 Worker 凭据的离线引导入口，明文 Worker Token 只在创建或轮换成功时返回一次。

## 5. 验收记录

真实 PostgreSQL 集成场景一次覆盖：

- 未认证控制面请求返回 401；operator 调用管理员接口返回 403。
- 独立 Worker 凭据绑定身份；撤销 Worker A 后 Worker B 仍有效。
- 拒绝超限、未声明和路径逃逸的制品元数据。
- Worker A 流式上传并通过 SHA-256/大小校验，任务结果通过制品门禁。
- Worker B 按授权引用下载到受控工作区并再次校验。
- Hub 与 PostgreSQL连接重建后，已就绪制品仍可由原 Web Session 下载。

结果：真实 PostgreSQL 测试 `2/2 PASS`（首批持久调度恢复场景 + 批次二身份/制品场景）；`scripts/check-all.ps1` 全绿（本地 Hub `17/17 PASS`、Server Hub 包检查、Web lint/build、组合 E2E PASS）。

未调用真实 Codex、Antigravity 或其他模型。

## 6. 回退与限制

- 回退代码时保留 `002_artifacts_and_identity.sql` 已创建的表和列；它们不影响首批读取，避免破坏性回滚。
- 停用中央传输可在 Worker 去掉 `artifacts.centralStore=true`，本地 Mock 模式仍返回本地清单；正式 Server Hub 不应退回共享 Token。
- 当前本地文件后端不做自动清理、配额分区、病毒扫描、预览或跨节点复制；生产部署需把 Artifact 根目录纳入文件级备份，并与 PostgreSQL 备份保持一致。
- 当前为单进程 Server Hub；Artifact 上传状态的跨进程协调与对象存储适配不在本批范围。

下一批从阶段 E、F 开始：统一资源探针语义，并把人工介入提升为独立、一次性消费、可恢复的持久记录。
