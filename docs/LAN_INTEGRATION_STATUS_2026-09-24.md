# 局域网版本整合状态（2026-09-24）

## 当前入口

- 局域网候选源码：`codex/lan-consolidation-20260924`，工作目录 `D:\A446\A446-Integration-20260924`。
- 已运行的稳定版本仍为 `v0.5.0-preview15`。不得用候选包自动覆盖稳定运行目录或它的状态、配对令牌、工作区。
- 本地候选包：`releases/A446-MultiDevice-LAN-v0.5.0-preview16-20260924.zip`。这是验证用构建，未上传、未安装、未进行真实双机更新。
- `main` 和 `origin/main` 仍停在 `625a9aa`；本次没有推送或改动远端分支。

## 分支盘点与取舍

| 来源 | 本轮处理 | 依据 |
| --- | --- | --- |
| `codex/lan-multidevice-package` | 已作为候选分支基线 | 比远端同名分支多 5 个本地提交，包含多设备 LAN、批次汇总、模型选择和 Web 控制台 |
| `D:\A446\A446-Intelligence-Dev` 的未提交工作 | 已复制到隔离目录并提交为 `77ce76c`；原目录未改 | 包含更新外挂、Hub/Worker 桥接、会话生命周期及对应测试；候选分支全量本地检查通过 |
| `origin/codex/v0.5-batch2-artifacts-auth`、`v05-contract-freeze`、`v05-security-deploy-c`、`v05-validation-release-d`、`v05-web-control-b` | 无需重复合并 | 提交已在 LAN 基线的历史中 |
| `origin/codex/v05-core-scheduler-a` 的最后一个提交与 `origin/codex/v05-parallel-integration` 的后续 17 个提交 | 暂留 Server Ready 轨道 | 主要涉及服务器发布、备份、反向代理和 staging Worker；不进入先行 LAN 候选包 |
| `codex/a446-mcp-direct` 的已提交 Web 改动 | 未重复合并 | 与 LAN 基线的 Web 改动同源；LAN 基线还有后续修复，直接合并会回引旧版本 |
| `D:\A446\A446-Intelligence-MCP-Dev` 的未提交 MCP/工作流改动 | 保留原目录，暂不并入 LAN 候选 | 与 LAN 的 AI 审核、人审兜底、批次汇总和快速结案语义冲突；试合并后 139 项 Hub 测试有 6 项失败。原目录文件均未改动 |

## 已通过的验证

- `scripts/check-all.ps1` 已纳入更新外挂测试并全绿：Hub 118/118、更新外挂 37/37、Server Hub 包检查 3/3、浏览器契约 3/3；Web lint/生产构建、组合冒烟和三个包的生产依赖审计也通过。更新外挂使用本地假 Release 与进程控制器，不调用真实 GitHub Release。未配置专用 PostgreSQL 测试库；此缺口属于 Server Ready 验收，LAN 候选使用本地 JSON Store。
- 候选 ZIP：路径穿越和绝对路径检查通过；118 个文件与清单逐一匹配；伴随 `.sha256` 匹配；模拟 Windows 默认解压后没有双层目录。
- 未运行真实 Codex/Antigravity 调用、真实双机升级、断网恢复或自动回滚验收。

## 仍需解决的 LAN 门槛

1. `docs/KNOWN_ISSUES.md` 的 `FLOW-001`：人工改派后部分工作流未进入独立审核与最终汇总。真实观察尚未在本候选分支复现；在复现和修复前，不将候选版替换为稳定版。
2. `UI-001`：账号与额度侧栏在账号较多时可达性不足。
3. 更新外挂需要先在隔离的两台设备上完成真实 Release 下载、校验、切换、健康检查及回滚演练。不得使用正在运行的 preview15 数据目录作破坏性测试。
4. MCP 工作流改动要先单独消除审核策略冲突和 6 项测试失败，再进入 LAN 分支；调试截图不纳入源码交付。

## 后续分支规则

局域网功能从 `codex/lan-consolidation-20260924` 分出短期分支，每项功能保持独立提交；合入前运行 `scripts/check-all.ps1`，涉及更新器时再运行 `tools/a446-updater` 测试和包结构校验。Server Ready 的 staging/部署改动在独立轨道整合。稳定 preview15 只在真实验收完成并经人工决定后替换。
