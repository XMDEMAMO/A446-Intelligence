# 预发布整合记录（2026-10-13）

整合分支：`codex/staging-integration-20261010`。本次整合保留原工作区修改，并将所有已获取的 `origin/*` 功能分支纳入同一提交历史；未改动 `main` 或室友的源分支。

## 整合来源

| 来源 | 内容 |
| --- | --- |
| `codex/v05-parallel-integration`，`f381797` | Server Hub、身份、租约、部署、恢复和已有预发布启动器 |
| 本地修改，`8ff931d` | Windows 双设备 Worker 包、便携 Node、独立凭据、Codex resume 沙箱与 Artifact 能力调度修正 |
| `codex/flow-001-replan-review`，`b12b7b5` | LAN 功能前置更新、人工重新规划、逐分支审核和独立最终汇总审核 |
| `codex/lan-consolidation-20260924`，`8ddfce6` | 执行前可选计划讨论和规划修订 |

冲突处理保留服务器身份验证、可信代理 CIDR/转发链处理和离线本地退出。执行任务仍受独立 Worker Token、Task Spec、本地 Policy、工作区沙箱和 TLS 校验约束。

## 整合补齐

- PostgreSQL migration `005_workflow_lifecycle_and_updates.sql` 保存设备更新、归档、回收站及永久清理记录，重启后可恢复。
- 清理查询完整的持久消息集合，不依赖内存窗口。独占 Artifact 文件和数据库记录移除，其他工作流引用的 Artifact 保留。
- 更新器崩溃恢复测试使用 `fileURLToPath`，支持仓库路径中的空格和中文。
- 浏览器回归随新界面更新定位，保留按需读取完整成果、RBAC 和一次性 Token 检查。
- Windows 验收包包含新测试依赖的 Provider 探针脚本，仍按显式白名单排除凭据与运行数据。

## 验证与部署状态

`scripts/check-all.ps1 -RequirePostgres` 已完整通过：Hub 132 项、更新器 37 项、Server Hub 单元 5 项、浏览器 Fixture 5 项、隔离 PostgreSQL 4 项、Web lint/生产构建、Mock 组合流程和三个生产包依赖审计（0 漏洞）。另外 Web 视图 15 项通过。临时服务和 PostgreSQL 已停止并清理。所有模型执行测试使用 Mock，本次尚未执行真实双设备验收。

完整日志位于仓库外 `C:\Users\ASUS\.codex\visualizations\2026\10\10\01a123b3-f0a2-76e1-98a1-f539d1f443c7\staging-integration-check-all-20261013.log`。

公网 `https://staging.a446intelligence.party` 健康检查、未认证 API/Worker 拒绝、安全头和静态缓存检查通过。用户提供的 `154.219.103.237` 对应此站点。

**尚未部署本次整合候选**：SSH 在认证前关闭连接，直连、域名和本机现有代理均未收到 SSH 握手。用户提供的 VNC 截图显示 CPU soft lockup、RCU stall、`sshd` 卡顿及网络配置启动失败，需先恢复服务器并确认日志；截图不足以确定故障根因。没有读取密码或私钥内容，没有修改目标服务器。旧报告的八项通过证据属于旧候选，不自动作为新候选的验收证据。

SSH 恢复后，应按固定完整提交 SHA 执行 `scripts/deploy/upgrade-staging-v05.sh <SHA> codex/staging-integration-20261010 https://staging.a446intelligence.party`。脚本先准备不可变 release、配置备份和数据库/Artifact 成对备份，再应用迁移与切换；部署后必须复核运行 SHA、公网端点和 FLOW-001。

两台真实设备使用同一份新 Worker 包，操作及 FLOW-001 复测步骤见 [Windows 双设备教程](WINDOWS_DUAL_DEVICE_QUICKSTART.md)。真实验收通过前，不把本次整合标为正式上线完成。
