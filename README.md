# A446 Intelligence

> **让多台个人设备上的不同 AI 账号，以规划、执行、审核三个角色共同完成同一个任务。**

A446 Intelligence 是一个通用的本地与分布式 AI Agent 任务控制平台。当前阶段聚焦两台设备的私人局域网协作验证，而不是生产级云服务。

当前仓库已经包含可运行的最小原型：

- apps/web：React + TypeScript 的 Agent 群聊控制台；一个任务对应一个群聊，显示角色简报、成果附件和账号用量。
- apps/agent-hub：local-agent-hub v0.5.0-alpha.3，共享编排核心负责规划/执行/审核闭环、Attempt/Lease、中央制品传输、运行期资源刷新、动态 Agent/模型调度、Token/额度统计和本地 Worker 通信。
- apps/server-hub：PostgreSQL 支持的单进程 Server Hub alpha，提供持久调度、独立 Worker/Web 身份、最小 RBAC、中央 Artifact Store 和可单次处理的持久人工介入。

当前发布说明见 [v0.4.0-r8 阶段总结](docs/RELEASE_SUMMARY_v0.4.0-r8.md)。

## 一键启动

私人热点双机测试请直接双击根目录的 `START-A446-PRIVATE-LAN.bat`。这套启动方式固定使用服务器地址 `192.168.137.1`，详细说明见 [PRIVATE-LAN-README.md](PRIVATE-LAN-README.md)。

原有的本机 Mock 原型仍可在 PowerShell 中执行：

在 PowerShell 中执行：

~~~powershell
cd "E:\GitHub\A446 Intelligence"
.\scripts\start-prototype.ps1
~~~

浏览器打开 http://127.0.0.1:5173。按 Ctrl+C 会停止网页；脚本也会清理它启动的本地 Hub 和 Mock Worker。

使用与维护文档：

- [人类用户使用手册](docs/USER_MANUAL.md)
- [AI 接入与维护手册](docs/AI_AGENT_MANUAL.md)
- [MVP 原型说明](docs/MVP_PROTOTYPE.md)
- [v0.5 Server Ready 实施计划](docs/SERVER_READY_V0.5_IMPLEMENTATION_PLAN.md)
- [v0.5 批次一设计与验收记录](docs/SERVER_READY_V0.5_BATCH1_DESIGN.md)
- [v0.5 批次二设计与验收记录](docs/SERVER_READY_V0.5_BATCH2_DESIGN.md)
- [v0.5 批次三设计与实施记录](docs/SERVER_READY_V0.5_BATCH3_DESIGN.md)

## 一次完成全部检查

~~~powershell
.\scripts\check-all.ps1
~~~

该命令会连续完成 Hub 自动测试、Server Hub 包检查、Web lint、生产构建和组合式端到端冒烟测试。涉及 PostgreSQL 行为时，还需按 [Server Hub 说明](apps/server-hub/README.md) 对专用测试数据库运行真实集成测试。
