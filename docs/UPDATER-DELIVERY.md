# A446 更新外挂交付单（2026-09-23）

对应任务书：`GITHUB-LAN-UPDATER-HANDOFF.md`。协议/状态机/测试计划全文见 `docs/UPDATER_PROTOCOL.md`，本单只记录交付清单、改动点与验收结论。

## 1. 新增文件

| 文件 | 内容 |
| --- | --- |
| `docs/UPDATER_PROTOCOL.md` | 协议、安装布局、adopt 迁移、CLI+退出码、状态机、断电恢复表、Release 校验规则、LAN 桥接协议、持久数据边界、脱敏规则、15 用例测试映射、已知限制 |
| `docs/UPDATER-DELIVERY.md` | 本交付单 |
| `tools/a446-updater/a446-updater.mjs` | CLI 入口（status/check/stage/apply/update/rollback/adopt/unadopt，JSON 输出，冻结退出码） |
| `tools/a446-updater/lib/util.mjs` | UpdaterError、parseArgs、atomicWriteJson、sha256File、compareVersions、redact、runPowerShell 等 |
| `tools/a446-updater/lib/layout.mjs` | 两级 junction 布局、journal 化 adopt/unadopt、switchCurrentJunction、resolveCurrentTarget |
| `tools/a446-updater/lib/release.mjs` | listReleases、validateManifest、resolveTargetRelease、downloadAsset（.part+流式哈希） |
| `tools/a446-updater/lib/zip.mjs` | zip 条目安全校验、解压、逐文件 SHA-256、staged 标记 |
| `tools/a446-updater/lib/device.mjs` | 真实/mock 进程控制器（CIM 命令行匹配杀进程，禁止按端口盲杀）、依赖安装 |
| `tools/a446-updater/lib/health.mjs` | 健康检查（/health + /v1/agents 设备在线数） |
| `tools/a446-updater/lib/core.mjs` | UpdaterCore 主编排器（事务、幂等、断电恢复、回滚、清理） |
| `tools/a446-updater/install-updater.ps1` | 安装到 %LOCALAPPDATA%\A446-Updater（只刷新代码，保留配置/状态） |
| `tools/a446-updater/package.json`、`README.md` | 测试脚本与使用/人工恢复说明 |
| `tools/a446-updater/test/*.mjs` | helpers + util/redaction/release/layout 单元测试 + updater-core 验收套件（本地假 Release、故障注入、断电模拟） |
| `apps/agent-hub/src/hub-updates.mjs` | HubUpdateRegistry：权限/路由/状态记录/审计，内存注册表 + Worker 补报 upsert |
| `apps/agent-hub/src/worker-update-bridge.mjs` | WorkerUpdateBridge：ack → 独立进程拉起 Updater → 轮询 state.json 上报 → 重启补报终态 |
| `apps/agent-hub/test/updater-bridge.test.mjs` | Hub 侧桥接测试（9 用例） |
| `apps/agent-hub/test/worker-update-bridge.test.mjs` | Worker 侧桥接测试（13 用例，注入 spawn/readState） |

## 2. 修改文件（薄桥接，未触碰他人未提交改动区域）

| 文件 | 改动 |
| --- | --- |
| `apps/agent-hub/src/hub.mjs` | 5 处：import HubUpdateRegistry；constructor 实例化；`RELIABLE_WORKER_MESSAGES` 增加 `device.update.status`；handleWorkerMessage 新增 status 分支（upsert + ack）；handleCommand 新增 `device.update.request` 分支 + HTTP `GET /v1/update-jobs` |
| `apps/agent-hub/src/worker.mjs` | WorkerUpdateBridge 薄桥接；`updateJobs` 纳入持久状态；消息接纳改为 `admit()` 同步占槽后 ACK；start() 时恢复轮询并补报终态 |
| `apps/agent-hub/protocol/envelope.schema.json` | type enum 增加 `device.update.request`、`device.update.status` |
| `apps/agent-hub/docs/protocol-v1.md` | Reliable delivery 增加两条；新增 "Device update bridge (v0.5 LAN)" 章节（6.1/6.2/6.3）；HTTP 控制面加 `GET /v1/update-jobs` |
| `apps/agent-hub/package.json` | test 脚本纳入两个新测试文件 |
| `scripts/build-lan-package.ps1` | 拷贝列表增加 `tools\a446-updater`；manifest 增加 `version = $Version`（detectLiveVersion 依赖） |
| `MULTI-DEVICE-LAN-README.md` | 已知限制补一条；新增第 11 章"更新外挂" |

## 3. 测试结果（全部本地假 Release / 假 Hub / mock 进程控制器，不依赖真实 GitHub 与 Provider 额度）

最新基线（2026-09-24，DeepSeek 审查修复轮完成后）：

| 套件 | 结果 |
| --- | --- |
| `tools/a446-updater` util/redaction/release/layout 单元测试 | **14/14 通过**（layout 断言已做 Windows 尾部反斜杠规范化） |
| `tools/a446-updater` updater-core 验收套件 | **23/23 通过**（15 条强制验收 + stage/apply 拆分 + status + health fail-closed + 5 个切换中断点扫描 + premature-journal 反例） |
| `apps/agent-hub` updater-bridge（Hub 侧） | **9/9 通过**（含 requested 占用、伪造/未知/跨 Agent 上报拒绝、五阶段重启重建） |
| `apps/agent-hub` worker-update-bridge（Worker 侧） | **13/13 通过**（含同步占槽、spawn 失败、看门狗超时、恢复轮询、真实 AgentWorker 重启持久化） |
| `apps/agent-hub` npm test 全量回归 | **118/118 通过**；模型推理强度用例的 fixture 已补齐显式 `reasoningEfforts: ["high"]` 声明 |
| `tests/e2e` 浏览器契约验收 | **3/3 通过**；Gemini 新前端的成果附件与人工介入定位已同步为用户可见语义 |

15 条强制验收映射：1 同版本 exit 3 / 2 正常升级+持久数据哈希不变+保留回滚点 / 3 降级与不存在 exit 11 / 4 SHA 错 exit 12 / 5a 损坏 zip / 5b 四种 zipslip / 6 截断下载可重试 / 7 stage 后断电 CLI 续做 / 8 切换后断电进程内续做 / 8b 切换后健康 503 回滚 exit 14 / 9 新版无法启动自动回滚 / 10 hub 健康但 agents 离线不报 completed / 12 同 jobId 幂等 / 13 并发 BUSY exit 10。另补 8s/8j/16/17/18/19 扩展用例（见 `docs/UPDATER_PROTOCOL.md` 第 9 节）。

回归甄别历史：开发期间曾观测到 3 个失败（resource-probe 2 项 + 模型校验 1 项）。resource-probe 后续已修复；最后一项不是生产模型校验缺陷，而是测试注释宣称 Agent 仅支持 `high`、fixture 却漏写 `reasoningEfforts`，按兼容旧 Agent 的规则会被解释为“不限制推理强度”。补齐 fixture 后，目标测试与 Agent Hub 全量回归均通过。2026-09-24 已实际运行全仓库 `check-all.ps1`；Hub、Server Hub、Web lint/build、组合 smoke 与浏览器 E2E 均通过，PostgreSQL 专用验收仍需提供隔离的 `A446_TEST_DATABASE_URL` 才能成为发布批准。

## 4. 开发中发现并修复的关键缺陷

1. **staged 目录层级错误**：stage 时把含 packageRoot 层的 stagingDir 整体 rename 成版本目录，`.staged-ok` 埋在 `versions/<v>/<packageRoot>/.staged-ok`，切换时 NOT_STAGED → 改为把包根本身 rename 为版本目录（与 live 布局一致）。
2. **pre-switch 失败未落终态**：下载/校验失败后 job 停在 downloading → update()/stage() 用 handlePipelineFailure 包装，非切换阶段失败统一标记 failed 并归档。
3. **failed 后无法重试**：无参 update 曾默认继承 failed 终态 jobId 触发"previously failed" → 改为只继承**非终态 pending**（断电恢复语义），failed 终态在无参调用下开新事务（重试），显式相同 jobId 仍幂等重放。
4. **测试 harness 断网**：验收 9/10 中多余的 `releaseServer.close()` 导致 listReleases fetch failed → 删除。
5. **桥接可测试性**：`readUpdaterState` 的 deps 注入优先于文件存在性检查。
6. **【审查阶段修复】Hub 与 Worker 的 failed 重试语义不一致**：`HubUpdateRegistry.request` 曾对 `status === "failed"` 的同 jobId 重新 `dispatch`（置 `retryOfPreviousFailure`），但 Worker 桥接的 `finalSent` 幂等保护与 Updater 的同 jobId 终态重放都会让这次"重试"**只重报旧错误、不重新执行**——Hub 认为已重试，实际没有。修复：已知 jobId 一律幂等返回、不再下发（`dispatch` 移除 retry 分支与 `retryOfPreviousFailure` 字段），把"重试需新 jobId"从隐性限制升格为显式契约，并同步 `docs/UPDATER_PROTOCOL.md` 6.1、`apps/agent-hub/docs/protocol-v1.md`、新增测试用例 `a known jobId is idempotent even after failure`。

## 4.1 审查复核结论（独立验证，2026-09-23 18:50）

- **文件真实性**：`tools/a446-updater` 17 个文件、4 个新增桥接模块/测试、2 个文档均实际存在；`git status` 未跟踪项与交付单一致。
- **薄桥接范围**：`hub.mjs` 整体 diff 为 112 行 / 11 个区块，但**其中仅 5 处属于本交付**（import、constructor、`RELIABLE_WORKER_MESSAGES`、worker status 分支、command+HTTP 路由）；其余区块（约 L887/L938/L1332/L1656/L1669/L1702，含模型校验、资源探测）是**他人未提交改动**，未被本次工作触碰。交付单第 2 节"5 处"表述准确，但合并时**不可整个文件照搬**。
- **回归失败的基线复核（加严）**：此前仅替换 worker.mjs 做基线；本次额外将 `hub.mjs` 也恢复为纯 HEAD 后复跑，`resource-probe` 仍为 3/5（同样 2 失败）；且第三个失败用例的**被测源 `collaboration.mjs` 无任何改动，仅测试文件被他人改写**（新增 `xhigh` 等期望）。结论加强：3 个回归失败均源于仓库既有状态/他人未完成的测试先行改动，与本交付无关。
- **文档一致性**：核对 `hub-updates.mjs` 的 `validateJobId`（8-200 字符、`[A-Za-z0-9._:@-]`）与文档 6.1 第 1 条相符；发现并修正了 6.1 第 2 条与实现不符（修复项 6）。

## 5. 已知限制

见 `docs/UPDATER_PROTOCOL.md` 第 11 节。要点：仅 Windows；Updater 不自更新；Web 控制台无更新页面（API 已就绪）；**failed 重试需换新 jobId**（显式安全契约，防止 ack 丢失导致重复执行）；v1 只做 SHA-256（签名接口预留）。Hub 重启恢复已通过持久化解决（不再依赖 Worker 补报）。

## 5.1 DeepSeek 审查修复轮（2026-09-24）

外部审查提出 8 项缺陷，逐项修复并以故障注入测试证明（修复前失败/修复后通过的用例均在套件内）：

1. **Worker 重启后 updateJobs 丢失**：`AgentWorker.loadState` 白名单补入 `updateJobs`；新增真实 AgentWorker 重启集成测试（running/completed/failed/rolled_back 补报与 finalSent 幂等）。
2. **junction 切换非原子**：改为两阶段 rename（`current.next` 暂存 -> rename 两次 -> 校验真实指向 -> 清理）；新增 `switching` phase（先于物理切换写入，`switched` 仅在 junction 校验通过后写入）；恢复时以 junction 物理指向为准（不等同/缺失即完成回滚）；五个中断点（after-stop / between-renames / after-switch / after-restart / after-verify）CLI 崩溃扫描 + 过早 journal 反例测试。
3. **adopt 中断无法恢复**：journal 优先于 ALREADY_ADOPTED 判定，live 已是 junction 且 journal 匹配 -> 进入恢复流程；参数/hubIp/deviceId 校验全部前置于任何文件移动（非法参数磁盘零改动）；迁移一半断电重跑测试在套件内。
4. **三层并发竞态**：Hub 以 `requested` 起的全部活动态占用设备；Worker `admit()` 在首个 await 前同步占槽（ACK=可靠接纳）；Updater 锁改 `wx` 原子创建。并发测试覆盖三层。
5. **桥接永久 running**：spawn 失败（`UPDATER_SPAWN_FAILED`）、轮询看门狗（`UPDATER_POLL_TIMEOUT`）、连续轮询错误、未安装、状态缺失全部产生 failed 终态并释放槽位；拒绝的请求不 ack，由终态上报 + 红投递重放收敛。
6. **Hub 状态完整性**：phase 白名单校验；上报 Agent 与 job 绑定设备一致性校验；非法/伪造上报拒绝且不改状态、不释放占用，记 `device.update.status.rejected` 审计事件。
7. **Hub 重启恢复**：`updateJobs` 随 Hub 状态持久化（JsonFileHubStore）；requested/running/completed/failed/rolled_back 五阶段重启重建集成测试；重建后同 jobId 幂等、不重复执行已完成更新。
8. **测试与文档失真**：layout 断言规范化尾部反斜杠；harness cleanup 关闭**当前实际监听**的 server（测试进程自行退出）；全套件计数与基线同步至本节；协议文档同步两阶段 rename / switching phase / ACK 语义 / 持久化恢复。

## 6. 未 commit / 未 push 说明

工作区内存在**其他 Agent 的未提交修改**（模型校验、资源探测等区域），任务书禁止混合提交、禁止清理工作区。本次全部改动以工作区文件形式保留，未执行任何 `git add/commit/push`，未创建真实 GitHub Release。合并时建议仅挑选第 1、2 节清单中的文件。

## 7. 双机真实验收审查清单（主 Agent 执行）

```text
准备：主机=协调端（adopted），笔记本=worker-01（adopted）；两者同一 LAN；GitHub 建真实 Release（含 update-manifest.json + zip + sha256）
1.  主机 POST /v1/commands {type:"device.update.request", deviceId:"worker-01", jobId:"acc-real-01"}
2.  GET /v1/update-jobs 确认 job 出现且 status=running，phase 依次经过 checking/downloading/staged/applying/restarting/verifying
3.  笔记本任务栏确认 A446 进程重启，启动日志属于新版本目录
4.  完成后 job status=completed，笔电 .a446/current 指向新版本，versions 保留上一版本
5.  笔电 shared\var 下 pairing-token.txt / settings.json / hub-state.json 与更新前一致（持久数据不丢）
6.  破坏性用例：发布一个健康检查必失败的版本，重复 1-4，确认自动回滚到上一版本且 job status=rolled_back、exit 14
7.  回滚后用【新 jobId】重新提交正常版本，确认重试成功
8.  更新期间拔掉笔电网线再恢复，确认 Hub 重连后 Worker 补报终态、无任务卡死
9.  检查 Updater logs（%LOCALAPPDATA%\A446-Updater\logs）无 token/密钥泄漏（应只见 [REDACTED]）
10. 断电用例（可选）：verifying 阶段直接断电，重新上电后 worker 自动重启并补报；Updater 恢复流程验证新版本健康或回滚
```
