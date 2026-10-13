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

**本次候选已部署**：2026-10-13 04:59 UTC，通过用户授权的云厂商 VNC root 控制台执行固定版本入口，运行提交为 `a762204e0ab3f2404e4862de04f066a9074b6173`。入口下载的 SHA-256 与本地审核版本一致：`282aea10340db679a6a0fc666c026512c82040ab43da0c64c0cc4dcdcfbc2c63`。

升级脚本完成依赖安装、Web 构建、数据库与 Artifact 成对备份、迁移、release 切换和服务恢复。服务器输出 `VERIFIED RELEASE` 与上述完整 SHA 一致，Server Hub 与 Caddy 均为 active。本机另行执行公网验证通过：健康 200、未认证 API/Worker 401、安全响应头、HTML no-store、静态资源 immutable。网页已使用新资源 `index-BrHAFuRn.js`。

恢复记录：

- 当前 release：`/srv/a446/releases/a762204e0ab3f2404e4862de04f066a9074b6173`。
- 前一 release：`/srv/a446/releases/ef397b69b23a68b2e7d139b6e0518325578c2666`。
- 配置备份：`/var/backups/a446/config-20261013T045859Z`。
- 数据库与 Artifact 成对备份：`/var/backups/a446/a446-20261013T045923Z`，已确认 `COMPLETE` 标志及 Artifact 快照，数据库校验 `a446.dump: OK`。

此前 SSH 在认证前关闭连接的问题尚未修复。最新 VNC 输出确认 SSH active、22 端口监听、UFW 放行；早期内核截图不能单独确定本次断连根因。本次没有读取密码或私钥，也没有修改 SSH、TLS 或防火墙策略。旧报告的八项通过证据仍属于旧候选，不自动作为新候选的验收证据。

两台真实设备使用同一份新 Worker 包，操作及 FLOW-001 复测步骤见 [Windows 双设备教程](WINDOWS_DUAL_DEVICE_QUICKSTART.md)。用户确认室友稍后才能配合，真实双设备和 FLOW-001 复测尚未执行；可以开始预发布调试，正式上线验收仍未完成。
