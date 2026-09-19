# A446 Intelligence v0.5 批次四验证与发布准备记录

日期：2026-09-16  
版本：`0.5.0-alpha.3`  
覆盖阶段：阶段 G  
状态：进行中

## 1. 本轮范围

在当前人类确认阶段 F 的真实 PostgreSQL 人工验收已经通过后，批次四先完成不消耗模型额度、可在本机重复运行的部分：

- 用 Memory Store 与 Mock Adapter 覆盖三类故障注入：Hub 在运行中重启、Executor 在执行中断线、Reviewer 在审核中断线。
- 每个场景同时检查任务、Attempt、可靠投递、群聊消息、独立人工介入、Artifact 清单和终态，而不只检查进程是否重新连接。
- 提供非秘密环境变量模板、最小部署顺序、TLS/WSS 反向代理边界、备份/恢复操作和发布包检查项。
- 提供单台 Ubuntu/Debian 预发布服务器的可执行配置教程，覆盖目录隔离、PostgreSQL 双库、systemd、Caddy、Worker 接入和首次验收。
- 同步更新实施计划与用户文档，明确哪些结果来自本机自动测试、哪些由当前人类人工验证，以及哪些仍未执行。

本轮不调用 Codex、Antigravity 或其他真实模型，不读取第三方凭据，也不启动或修改外部 PostgreSQL 服务。

## 2. Mock 故障注入

新增 `apps/agent-hub/test/fault-injection.test.mjs`，并纳入 `npm test`：

| 场景 | 注入动作 | 必须保持的结果 |
| --- | --- | --- |
| Hub 重启 | 运行中的 Executor 任务已保存启动状态后，关闭并在原端口重建 Hub | Worker 自动重连；同一 Attempt 完成；结果消息和本地 Artifact 清单保留；独立待处理人工请求仍为 `pending` |
| Executor 断线 | Executor Mock Adapter 正在运行时终止 WebSocket | 断线被审计；Worker 重连并使用原 Attempt 回传结果；工作流恰好生成一个执行任务并完成审核 |
| Reviewer 断线 | Reviewer Mock Adapter 正在审核时终止 WebSocket | 断线被审计；审核通过并创建一次规划回收；没有错误终态、待处理人工请求或未确认派发 |

Mock 本地模式不启用中央 Artifact Store，因此测试断言任务回传的 SHA-256 Artifact 清单为 `ready`，同时确认 Hub 不伪造服务器 Artifact 记录。真实 PostgreSQL/文件流场景继续由 `apps/server-hub` 的专用测试库覆盖。

## 3. 自动验证记录

本轮开始前的全仓基线：

- 开始前的 `scripts/check-all.ps1`：Hub 23/23 PASS、Server Hub 包检查 PASS、Web lint PASS、Web production build PASS、组合 E2E PASS。
- `node --test test/fault-injection.test.mjs`：3/3 PASS。
- 文档与包检查更新后的最终 `scripts/check-all.ps1`：Hub 26/26 PASS、Server Hub 包检查 PASS、Web lint PASS、Web production build PASS、组合 E2E PASS。
- `npm.cmd audit --omit=dev`：`apps/agent-hub`、`apps/server-hub` 与 `apps/web` 均为 0 vulnerabilities。

因此，本轮 Mock 故障注入和文档准备已计入阶段 G 的已完成子项。

## 4. 阶段 F 验收来源

阶段 F 的 PostgreSQL migration、Hub 重启和并发条件处理已由当前人类人工验证为通过，因此计划状态改为“已验收”。本机没有 `A446_TEST_DATABASE_URL`，本轮没有重复执行该破坏性专用数据库测试；这一事实会保留在交付报告中。

## 5. 尚未完成的阶段 G 门槛

- 在专用 PostgreSQL 数据库上复跑完整 `npm.cmd run test:postgres`（推荐作为每次发布前复验）。
- 经当前人类明确授权后，使用真实 Codex 与 Antigravity 在不同设备上完成一次规划、执行、审核和规划回收，并记录 Attempt、耗时、Token、可信额度、返工次数和 Artifact 哈希。
- 在目标服务器的实际 TLS、域名、反向代理、Artifact 磁盘预算和备份位置确定后，完成部署演练与恢复演练。
在这些门槛完成前，阶段 G 仍是“进行中”，不得声称 v0.5 已达到 Server Ready 完成定义。

## 6. v0.5 并行 D 分支验证增量

`codex/v05-validation-release-d` 从共享契约冻结点新增以下发布验证基础，不修改 Hub 或 Web 核心业务逻辑：

- `scripts/smoke-e2e.ps1` 等待完整成果附件真正可见后再断言，避免任务终态与群聊消息提交之间的短暂竞态；同时修正 PowerShell 单元素集合计数。
- `tests/e2e` 使用本机 Edge、Chrome 或 Chromium 运行真实浏览器，默认连接无秘密的本地契约服务，覆盖登录、成果附件、人工介入、指定 Executor 硬约束、RBAC、Worker Token 一次展示、取消与退出会话。
- `scripts/check-all.ps1` 纳入浏览器 E2E 和三个生产包的 `npm audit --omit=dev`；提供 `-RequirePostgres`，缺少专用数据库时不得作为发布批准。
- `scripts/check-release.ps1` 作为严格门禁，强制专用 PostgreSQL；可按明确授权追加真实公网浏览器流程和仓库外证据文件校验。
- `docs/V0.5_RELEASE_ACCEPTANCE_REPORT.md` 和证据模板区分自动通过、未执行和真实演练，不允许把 Mock、计划或跳过项写成发布通过。

A、B、C 功能分支进入唯一集成 HEAD 后，D 的实时浏览器门禁必须在真实 HTTPS 入口复跑。真实 Codex 与 Antigravity 多设备工作流仍需当前人类明确授权，不能由自动检查自行消耗额度。
