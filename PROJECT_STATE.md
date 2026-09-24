# A446 Project State

## 2026-09-24 局域网候选版状态

本地整合分支为 `codex/lan-consolidation-20260924`，工作目录为 `D:\A446\A446-Integration-20260924`。分支盘点、已整合内容、验证结果和未过的发布门槛见 [局域网版本整合状态](docs/LAN_INTEGRATION_STATUS_2026-09-24.md)。`v0.5.0-preview15` 仍是稳定运行版本；本地 preview16 ZIP 仅为候选，不自动替换稳定包。下文保留 2026-09-20 的历史任务记录。

## 2026-09-20 历史快照

更新时间：2026-09-20

## 当前边界

- 当前稳定运行版本：`v0.5.0-preview15`。
- 稳定运行目录：`D:\A446\A446-MultiDevice-LAN-v0.5.0-preview15-20260920`。
- 稳定运行包及其源码副本不得修改，也不得由自动流程替换。
- 开发源码目录：`D:\A446\A446-Intelligence-Dev`。
- 开发分支：`codex/lan-multidevice-package`。
- preview15 基线提交：`2829ad27031b3aad8917a31b8d5bf5634e5034ae`。
- 是否替换稳定版本最终由人工决定。

## 本轮目标

修复 `scripts/build-lan-package.ps1` 生成的安装 ZIP 在 Windows 默认解压后出现双层同名目录的问题。

已确认的原因：ZIP 内所有条目都带有包名顶层目录，而 Windows 默认解压又创建同名目标目录。

目标结构：用户把候选 ZIP 默认解压到同名目录后，启动脚本、README、`apps`、`docs` 和 `scripts` 应直接位于该目录根部，不应再出现第二层同名目录。

## 账号与并发

- 主机和笔记本上的 Codex 使用同一个 GPT Plus 账号，必须按同一 `accountId` 汇总额度，总并发上限为 1。
- 两台设备上的 Google AI Pro 登录属于两个不同账号资源池。
- 不允许通过多个逻辑 Agent 绕过账号额度或并发限制。
- 不执行账号切换，不读取或迁移凭据、Cookie、浏览器资料或验证码。

## 协作门禁

1. 规划 Agent只拆分、指派任务，并接收审核通过后的简报与成果引用。
2. 执行 Agent独占实现范围，提交完整成果、任务简报及候选包。
3. 审核 Agent必须使用与执行 Agent不同的 Google 账号，独立检查代码、ZIP 结构、自动测试和 Web 生产构建。
4. 审核失败时退回原执行 Agent返工；未经审核通过不得结案。
5. 完整执行结果只传给审核 Agent，不传给规划 Agent。

## 实现范围

- 修改开发源码中的 ZIP 打包逻辑。
- 增加确定性的包结构回归测试，并接入现有自动检查入口。
- 保留拒绝覆盖、安全清理、Manifest、SHA-256 和现有排除规则。
- 除非测试证明必要，不修改协议、Hub 调度、Worker、账号探测或 Web 产品行为。

## 验收标准

- ZIP 根直接包含 `START-A446-MULTI-DEVICE-LAN.bat`、`STOP-A446-MULTI-DEVICE-LAN.bat`、README、`apps`、`docs` 和 `scripts`。
- ZIP 中不存在以完整包名作为统一前缀的包装目录。
- 默认解压到同名目标目录后，不产生第二层同名目录。
- ZIP 不含绝对路径或 `..` 路径穿越条目。
- `PACKAGE-MANIFEST.json`、候选 ZIP 和 `.sha256` 校验一致。
- 新增回归测试、相关自动测试、Web lint 与 Web 生产构建全部通过。
- preview15 稳定 ZIP 与稳定运行目录中的程序文件保持不变。
- 生成新候选包，但不自动替换稳定版本。

## 必要入口

- `AGENTS.md`
- `MULTI-DEVICE-LAN-README.md`
- `docs/AI_AGENT_MANUAL.md`
- `apps/agent-hub/AI_IMPLEMENTATION_GUIDE.md`
- `scripts/build-lan-package.ps1`
- `scripts/check-all.ps1`

