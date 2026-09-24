# a446-updater — A446 Intelligence 设备更新外挂

独立于 Agent 协作逻辑的 Windows 更新工具：以 GitHub Releases 为唯一远程版本源，
完成 check → download → verify → stage → 切换 → 重启 → 健康检查 →（必要时）回滚。

协议、安装布局、状态机与断电恢复的完整定义见仓库根目录 `docs/UPDATER_PROTOCOL.md`。

## 1. 安装

Updater 代码随 LAN 包一起分发（包内 `tools/a446-updater/`）。安装到本机：

```powershell
# 在解压后的包根目录执行；默认安装到 %LOCALAPPDATA%\A446-Updater
powershell -ExecutionPolicy Bypass -File tools\a446-updater\install-updater.ps1
```

安装只刷新代码，不会覆盖已有的 `config.json` / `state.json`。

环境变量（可选）：

- `A446_UPDATER_HOME`：Updater 主目录（默认 `%LOCALAPPDATA%\A446-Updater`）
- `A446_UPDATER_GITHUB_TOKEN`：访问私有仓库的 GitHub token（只存在于进程环境，不落盘）

## 2. 首次接入（adopt，一次性）

adopt 会把现有"平铺"安装迁移为 `versions/<当前版本>` + `shared/` + 两级 junction 布局，
迁移过程 journal 化、每步幂等，中断后重跑自动续做；配套 `unadopt` 可完整还原。

```powershell
node "%LOCALAPPDATA%\A446-Updater\a446-updater.mjs" adopt ^
  --live "D:\A446-MultiDevice-LAN-v0.5.0-preview15-20260920" ^
  --role coordinator ^        # 或 worker
  --hub-ip 192.168.1.10 ^     # 缺省时从 var/lan/settings.json 读取
  --device-id laptop-01       # 缺省时从 var/lan/settings.json 读取
```

迁移后目录结构（`live` 路径字符串不变，Worker 配置里的绝对路径语义不变）：

```text
<A446 安装目录>/            ← live：junction → .a446/current
  .a446/
    current/                ← junction → versions/<当前版本>（切换点）
    current.json            ← 记录当前版本（junction 为准，可自动修复）
    versions/<version>/     ← 各版本完整包内容
    shared/var/             ← 持久运行数据（token、hub-state、config、logs…）
    shared/workspaces/      ← 持久工作区
```

每个版本目录内的 `apps/agent-hub/var`、`workspaces` 是指向 shared 的 junction，
因此任何版本的代码都不会持有或覆盖运行数据。

## 3. 日常使用（CLI）

所有命令输出单行 JSON（`{"ok":..,"command":..,"exitCode":..,"result":..}`），
退出码稳定（见下表），便于脚本与 Hub 桥接消费。

```powershell
node "%LOCALAPPDATA%\A446-Updater\a446-updater.mjs" status
node "%LOCALAPPDATA%\A446-Updater\a446-updater.mjs" check
node "%LOCALAPPDATA%\A446-Updater\a446-updater.mjs" update                    # 最新版本
node "%LOCALAPPDATA%\A446-Updater\a446-updater.mjs" update --version 0.5.0-preview16 --job-id update-20260923-01
node "%LOCALAPPDATA%\A446-Updater\a446-updater.mjs" rollback
```

分步操作（可在切换前人工检查 staged 内容）：

```powershell
... stage --version 0.5.0-preview16     # 下载+校验+安装依赖+写入 .staged-ok
... apply                               # 停设备 → 切 junction → 重启 → 健康检查
```

退出码：`0` 成功 / `1` 错误 / `2` 用法 / `3` 已是最新 / `4` 未 adopt / `10` BUSY /
`11` 版本不可用或拒绝降级 / `12` 校验失败 / `13` 切换后回滚也失败（人工介入） /
`14` 已回滚 / `15` 需人工介入 / `16` 状态文件损坏。

局域网内由 Hub 统一下发更新时无需手工执行：Hub 通过 `POST /v1/commands`
（`type=device.update.request`）把指令投递给设备 Worker，Worker 以独立进程拉起本机
Updater 并回传 `device.update.status`；进度可用 `GET /v1/update-jobs` 查看。

## 4. 人工恢复步骤

- **`exit 14`（已回滚）**：设备已回到上一版本并验证健康。确认失败原因
  （`%LOCALAPPDATA%\A446-Updater\logs\` 与 `state.json` 的 `job.error`）后，
  用**新的 jobId** 重新发起更新即可。
- **`exit 13`（切换后回滚也失败）**：不要盲目重启循环。检查
  `<安装目录>\.a446\current` junction 指向、`current.json` 与 `state.json` 的
  `job.previousTarget` 三者一致后，手工把 junction 指回上一版本目录
  （或删除 junction 后重建），再执行 `rollback` 或 `status` 验证。
- **`exit 16`（state.json 损坏）**：Updater 保持现状不猜测。人工核对
  `current` junction 实际指向的版本目录；如与 `current.json` 不一致，以 junction
  为准修正 JSON；`state.json` 不可手工修补时删除后首次 `status` 会重建空状态。
- **断电/中断恢复**：直接重跑同一命令。切换前（checking…staged）中断不影响旧版本，
  重跑自动续做；切换后（switched/restarting/verifying）中断，恢复时先确保设备运行、
  再验证新版本，验证失败自动回滚。
- **锁定残留**：`lock.pid` 内的 PID 已死时自动接管；怀疑有活动更新时
  `status` 会显示 `pendingRecovery`，等待其结束或人工确认进程已死再删除 `lock.pid`。

## 5. 测试

```powershell
cd tools\a446-updater
npm test        # node --test：单元 + 15 条验收用例（本地假 Release，不出网）
```

已知限制见 `docs/UPDATER_PROTOCOL.md` 第 11 节。
