# A446 Intelligence

A446 Intelligence 是一个通用的本地与分布式 AI Agent 任务控制平台。

当前仓库已经包含可运行的最小原型：

- apps/web：React + TypeScript 控制台，管理任务、节点、审批、产物与审计事件。
- apps/agent-hub：接入的 local-agent-hub v0.3.1，负责本地 Worker 通信和任务流转。

## 一键启动

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

## 一次完成全部检查

~~~powershell
.\scripts\check-all.ps1
~~~

该命令会连续完成 Hub 自动测试、Web lint、生产构建和组合式端到端冒烟测试。
\n