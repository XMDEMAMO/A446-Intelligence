# A446 Updater 更新协议、状态机与测试计划

适用范围：`tools/a446-updater`（独立更新外挂）以及 Hub/Worker 的最小 LAN 命令桥接。

本文件是更新模块的唯一协议契约。其他功能只允许调用本文定义的稳定接口，不得复制其内部逻辑。

## 1. 设计原则

1. GitHub Releases 是唯一远程版本源。运行环境永远不从分支 `git pull` 更新。
2. Updater 是独立进程，安装于 `%LOCALAPPDATA%\A446-Updater\`，业务包更新永不覆盖 Updater。
3. Updater 第一版不支持自更新；将来更新 Updater 必须走独立协议版本和单独发布流程。
4. Hub 只做权限检查、命令路由和状态记录，不负责下载或替换文件。
5. 持久数据（token、配置、日志、工作区、任务状态、用户数据）绝不进入覆盖流程。
6. 所有状态转换必须持久化，断电后可恢复或回滚；不确定时保持现有可运行版本，报告人工介入。

## 2. 安装布局

```text
%LOCALAPPDATA%\A446-Updater\
  a446-updater.mjs          CLI 入口
  lib\*.mjs                 Updater 模块
  config.json               设备事实（installRoot/livePath/role/hub 信息），adopt 时写入
  state.json                当前版本 + 更新事务状态（原子写）
  lock.pid                  单实例锁
  jobs\<jobId>\             下载与任务产物（download\、manifest 副本）
  logs\                     运行日志（脱敏）
  migration-journal.json    adopt 迁移日志（一次性）

<A446 安装区>\
  <原解包目录>\              live 路径：junction -> .a446\current（路径字符串永久不变）
  .a446\
    current                 junction -> versions\<versionKey>（真正被切换的指针）
    current.json            { schemaVersion, version, target, updatedAt }
    versions\<versionKey>\  各版本完整解包（每个含 .staged-ok 标记）
    shared\
      var\                  原 apps\agent-hub\var（配置、token、状态、日志、任务历史）
      workspaces\           原 apps\agent-hub\workspaces
```

- `versions\<versionKey>\apps\agent-hub\var` 与 `...\workspaces` 是指向 `shared\` 的 junction，保证绝对路径（worker 配置中的 `stateFile`、`workspace`、探针参数）在版本切换后字符串不变、语义指向共享数据。
- live 路径本身在 adopt 时变为 junction（指向 `.a446\current`），此后永不删除；切换版本只替换 `.a446\current` 这一层，live 路径不存在消失窗口。
- 当前版本判定以 `.a446\current.json` + `.a446\current` junction 实际指向为准；两者不一致时以 junction 为准并修复 JSON。

### 2.1 一次性迁移（adopt）

前置：本机 A446 进程已停止。步骤（每步原子 rename 或 junction 创建，全程写 journal）：

1. 创建 `.a446`、`.a446\shared`、`.a446\versions`。
2. `rename <live>\apps\agent-hub\var -> .a446\shared\var`
3. `rename <live>\apps\agent-hub\workspaces -> .a446\shared\workspaces`（不存在则创建空目录）
4. `rename <live> -> .a446\versions\<当前版本Key>`
5. `junction <live> -> .a446\current`（绝对路径）
6. `junction .a446\current -> .a446\versions\<当前版本Key>`
7. `junction versions\<Key>\apps\agent-hub\var -> .a446\shared\var`；workspaces 同理
8. 写 `current.json`、`config.json`，清空 journal。

迁移中断：journal 存在且未完成时，任何 Updater 命令启动先按 journal 续做（各步骤幂等）。`a446-updater unadopt` 可逆向回滚到原始扁平布局（同样有 journal 保护）。

## 3. CLI 稳定接口

```text
node a446-updater.mjs status
node a446-updater.mjs check [--version <v>]
node a446-updater.mjs stage --version <v> [--job-id <id>]
node a446-updater.mjs apply [--version <v>] [--job-id <id>]
node a446-updater.mjs update [--version <v>|latest] [--job-id <id>] [--allow-downgrade]
node a446-updater.mjs rollback
node a446-updater.mjs adopt --live <path> --role coordinator|worker --hub-ip <ip> --device-id <id> [--access-mode full|safe]
node a446-updater.mjs unadopt
```

公共参数：`--api-base <url>`（默认 `https://api.github.com`）、`--allow-http`（仅测试）、`--json`（默认始终输出单个 JSON 对象到 stdout）、`--skip-dependency-install`（测试）、`--process-controller mock`（测试）、`--health-base <url>`（测试，覆盖 hubBaseUrl）。

环境变量：`A446_UPDATER_GITHUB_TOKEN`（私有仓库凭据，仅内存与请求头，禁止写入文件/日志/命令行）、`A446_UPDATER_FAULTS`（测试故障注入，逗号分隔：`after-download,after-stage,after-switch`）。

### 3.1 退出码（冻结）

| 代码 | 含义 |
| --- | --- |
| 0 | 成功（update 完成指 completed） |
| 1 | 未预期错误 |
| 2 | 用法错误 |
| 3 | 已是最新版，未做任何变更 |
| 4 | 尚未 adopt（NEEDS_ADOPT） |
| 10 | 已有更新任务在执行（BUSY） |
| 11 | 版本不可用（不存在 / 拒绝降级） |
| 12 | 校验失败（SHA-256 / ZIP / manifest） |
| 13 | 健康检查失败且回滚失败（NEEDS_MANUAL_INTERVENTION 场景之一） |
| 14 | 已回滚（更新失败但旧版本已恢复运行） |
| 15 | 需要人工介入 |
| 16 | 状态文件损坏（保持现状，不做任何猜测性删除） |

## 4. 更新状态机

内部 phase（state.json `job.phase`）与对外上报 phase：

```text
内部                 上报(Worker->Hub)
checking          -> checking
downloading       -> downloading
verifying_package -> downloading
staging           -> downloading
staged            -> staged
preparing         -> staged
switching         -> applying
switched          -> applying
restarting        -> restarting
verifying         -> verifying
completed         -> completed
failed            -> failed
rolled_back       -> rolled_back
```

完整 update 流程（每步之前先原子持久化 phase；phase 只记录已发生的物理事实）：

```text
checking           读 current.json 与 GitHub Release manifest；比较版本
                   相同 -> 退出码 3，不停止任何进程，不改文件
                   目标 < 当前 且未 --allow-downgrade -> 11
downloading        下载 zip 到 %LOCALAPPDATA%\A446-Updater\jobs\<jobId>\download\
verifying_package  SHA-256、manifest 字段、ZIP 条目安全（无 ../、无绝对路径、
                   无盘符、单一包根 == packageRoot、必备文件存在）
staging            解压到 versions\<Key>.staging-<jobId>，按 PACKAGE-MANIFEST.json
                   逐文件校验 SHA-256，建 var/workspaces junction，
                   依赖安装（npm ci），写 .staged-ok，rename 为 versions\<Key>
staged             （可暂停点：stage 命令到此为止，旧版本仍在运行）
preparing          写事务：fromVersion/toVersion/previousTarget/newTarget
switching          停止本机 A446 进程（按 live 路径与版本目录匹配，不用端口号盲杀）
                   两阶段 rename 切换 .a446\current junction（见 4.2），
                   校验 junction 真实指向后更新 current.json
switched           （junction 已物理指向新版本后才写入此 phase）
restarting         以 detached PowerShell 启动 start-lan-multidevice.ps1
                   （-Mode/-HubIp/-DeviceId/-AccessMode 全部显式传参，无交互）
verifying          Coordinator: Hub /health + /v1/agents 本机 Agent 全部 online
                   Worker: Hub /health + /v1/agents 出现本机 deviceId online
                   （轮询直至超时，不用固定 sleep；同时确认进程存活）
completed          保留旧版本至少一个回滚点；按 keepVersions 清理更旧版本
失败路径           任一步失败 -> rollback：停进程、junction/current.json 切回
                   previousTarget、重启旧版本、验证旧版本健康
                   回滚成功 -> phase=rolled_back，退出码 14
                   回滚失败 -> phase=failed，退出码 13/15，输出人工恢复指引
```

### 4.1 幂等与并发

- 相同 `jobId` 重复执行：state.json 中该 job 已 completed/failed/rolled_back -> 直接返回既有结果，不重复安装；非终态 -> 从断点续做。
- 不同 `jobId` 且前一事务非终态 -> BUSY（退出码 10）。
- 同一设备同时最多一个更新任务，三层保护均为原子操作：
  1. **Hub**：任务从 `requested` 起即占用设备（不只 `running`），首个状态上报前并发请求同样被 409 拒绝；
  2. **Worker**：桥接在第一个 `await` 之前同步占用更新槽（`admit()`），ACK 只在可靠接纳后发出；
  3. **Updater**：进程锁用 `wx` 原子文件创建获取（非 check-then-write），PID 存活检测兜底。

### 4.2 断电恢复

Updater 任何命令启动时读取 state.json，**恢复永远以 current junction 的物理指向为准，journal 只是提示**：

| 断电时 phase | 恢复动作 |
| --- | --- |
| checking/downloading/verifying_package/staging/staged/preparing | 旧版本未受影响；update 重跑该 job 从头执行（下载/暂存可重做），stage 完整则直接进入切换 |
| switching（切换进行中） | 读取 junction 物理指向：已指向 toVersion -> 继续收尾；缺失/半切换（`current.next`/`current.old` 残留）-> 先完成两阶段 rename 再收尾 |
| switched/restarting/verifying | 校验 junction 真实指向 == toVersion：成立 -> 先拉起设备（如无进程）再验证健康，成功 -> completed；不成立（journal 过早写入或回滚已发生）-> **完成回滚到 previousTarget，绝不把旧版本标成新版本完成** |
| completed/failed/rolled_back | 终态，不重复执行 |
| state.json 损坏 | 不做任何写操作；status -> 16；update/apply 拒绝执行并输出人工指引（除非 --recover-state 显式确认后按 junction 实况重建） |

junction 切换本身是**两阶段 rename**：先建 `current.next` -> `current` 改名到 `current.old` -> `current.next` 改名到 `current` -> 校验真实指向 -> 清理。唯一缺失窗口在两次 rename 之间，任何时点断电都可由上表 `switching` 行恢复；删除 `current.old` 之前新 junction 已就位并通过校验。

LAN 场景下 Worker 桥接在进程重启后：终态 job 补报一次（finalSent 防重复）；活动 job 且 Updater 仍在运行 -> 恢复轮询并续报；Updater 状态缺失 -> 补报 `failed/UPDATER_STATE_MISSING`，Hub 永远不会等到一个静默消失的任务。

## 5. GitHub Release 约定

每个 Release 至少包含：

```text
A446-MultiDevice-LAN-<version>.zip
update-manifest.json
SHA256SUMS
```

`update-manifest.json`（schemaVersion 1）必填字段：`version`、`publishedAt`、`repository`（必须等于配置的仓库名）、`assetName`、`sha256`（zip 的 SHA-256，64 位小写十六进制）、`packageRoot`（zip 内唯一顶层目录名，安全单段）、`minUpdaterVersion`。可选：`healthCheck { hubPath, timeoutSeconds }`。

验证规则：

1. 只信 Release API 返回的资产 `browser_download_url`，不在代码里拼接下载地址。
2. 下载 URL 必须 HTTPS（`--allow-http` 仅供本地测试显式开启）。
3. `version` 必须匹配 `^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$`。
4. 版本比较：按 `major.minor.patch` 数值比较；相等时无后缀者高；`-preview<N>` 按 N 数值比较；其余后缀按字典序。
5. zip 校验失败（SHA-256 不符、条目不安全、包根不唯一、必备文件缺失、解压后逐文件哈希不符）一律拒绝，退出码 12，旧版本不动。

私有仓库：通过 `A446_UPDATER_GITHUB_TOKEN` 注入请求头。token 不落盘、不进日志（日志统一脱敏）、不进命令行、不进错误信息。

## 6. LAN 桥接协议（复用现有 Hub WebSocket）

### 6.1 Hub -> Worker：`device.update.request`

由 `POST /v1/commands` 提交（LAN 共享 token 即 admin）：

```json
{ "type": "device.update.request", "deviceId": "laptop-01", "version": "0.5.0-preview16", "jobId": "uuid-or-slug" }
```

Hub 行为：

1. 校验 admin 角色、`deviceId`、`jobId`（必填，8-200 字符）。
2. `jobId` 已存在 -> 返回既有任务（幂等，`duplicate: true`），**不重新下发**。因为 Worker 桥接与设备上的 Updater 对已知 jobId 都会重放已记录的终态，重复下发不会真正重跑更新；**重试必须使用新的 jobId**（见第 11 节）。
3. 同一 `deviceId` 已有活动更新任务 -> HTTP 409 `UPDATE_JOB_ALREADY_RUNNING`。
4. 无该 deviceId 的在线 Agent -> HTTP 409 `DEVICE_OFFLINE`。
5. 通过现有可靠投递（at-least-once，需 ack，按消息 id 去重）发送 envelope 给该设备任一在线 Agent。

### 6.2 Worker -> Hub：`device.update.status`

Worker 桥接收到 request 后：`admit()` 同步占用更新槽（单槽，无 await）-> ACK（ACK 语义 = 任务已被可靠接纳，而非仅收到消息；被拒绝的请求不 ack，由桥接补报 `failed/UPDATE_BUSY` 终态后红投递重放）-> 以独立进程拉起本机 Updater（`update --job-id <id> [--version <v>]`）-> 轮询 `state.json`，phase 变化即上报。任何异常路径都保证终态：spawn 失败（`UPDATER_SPAWN_FAILED`）、轮询看门狗超时（`UPDATER_POLL_TIMEOUT`）、连续轮询错误、未安装（`UPDATER_NOT_INSTALLED`）均上报 `failed` 并释放更新槽，**不存在静默停止轮询的路径**。Worker 自身被重启后：终态 job 补报一次（finalSent 防重复）；活动 job 且 Updater 仍在运行 -> 恢复轮询；状态缺失 -> 补报 `failed/UPDATER_STATE_MISSING`。

```json
{
  "v": 1, "id": "...", "type": "device.update.status", "agentId": "...",
  "payload": {
    "jobId": "...", "deviceId": "...", "phase": "downloading",
    "version": "0.5.0-preview16", "fromVersion": "0.5.0-preview15",
    "error": null, "checkedAt": "ISO-8601"
  }
}
```

phase 取值：`checking|downloading|staged|applying|restarting|verifying|completed|failed|rolled_back`。该消息加入可靠投递集合（需 ack、按 id 去重）。

### 6.3 Hub 侧状态

- 持久化注册表 `updateJobs`：随 Hub 状态一起落盘（dirty 标记 + 原子写），**Hub 重启后按阶段精确重建**（requested/running/completed/failed/rolled_back 均有集成测试覆盖），重建后同 jobId 依旧幂等，不会重复执行已完成的更新。
- 上报校验：phase 白名单之外的一律拒绝（不改变任务状态、不释放设备占用）；上报 Agent 与 job 绑定设备不一致的伪造上报拒绝并记审计事件 `device.update.status.rejected`。
- `GET /v1/update-jobs` 返回任务列表（Web 会话/admin）。
- 每次请求与上报都写入审计事件 `device.update.requested` / `device.update.status`。

## 7. 持久数据边界（禁止覆盖/删除）

```text
shared\var（含 pairing-token.txt、settings.json、hub-state.json、config\、state\、logs\、provider-cache\、artifacts\）
shared\workspaces
%LOCALAPPDATA%\A446-Updater\（config.json、state.json、jobs\、logs\）
```

更新流程只写 `.a446\versions\*`、`.a446\current*`、Updater home 下的 jobs/logs/state。清理仅限 Updater 自建的 `.staging-*`/`.trash-*` 目录与超出 keepVersions 的旧版本目录（绝不删除当前与上一版本）。

## 8. 安全与脱敏

- 日志与错误输出统一经过 redaction：GitHub token（`ghp_`/`github_pat_`/Bearer 头）、pairing token（`A446-<hex>` 形态）、`sk-` 密钥形态全部替换为 `[REDACTED]`。
- 停止进程严格按命令行包含 live 路径/当前版本目录路径匹配，禁止按端口号盲杀。
- Updater 不读取、不迁移任何 Provider 凭据；重启由现有 start 脚本完成，token 由脚本自身从 shared var 读取。
- 状态/日志文件不含 token 字段。

## 9. 测试计划（本地假 Release，不依赖真实 GitHub）

| # | 验收用例 | 测试方式 |
| --- | --- | --- |
| 1 | 已是最新版：不停进程不改文件 | update 相同版本 -> 退出码 3，进程控制器零调用，fs 快照不变 |
| 2 | 正常升级：健康检查通过并成为当前版本 | 假 Release v2 + 健康 mock -> completed，current.json/junction 指向 v2 |
| 3 | 指定旧版本/不存在版本 | 降级拒绝（11）；不存在（11）；旧版本目录不被创建 |
| 4 | SHA-256 错误 | 假 Release 错哈希 -> 12，旧版本继续运行 |
| 5 | ZIP 损坏/路径穿越 | 条目含 `../`、绝对路径、盘符 -> 12，拒绝解压 |
| 6 | 下载中断 | 服务器截断响应 -> 失败；重试成功；旧版本不受影响 |
| 7 | 暂存后断电 | 注入 after-stage 崩溃 -> 重启 Updater 恢复事务并完成 |
| 8 | 切换后断电 | 注入 after-switch 崩溃 -> 重启后验证新版本（健康失败则回滚） |
| 8s | 切换中断点扫描 | after-stop / switch-between-renames（两次 rename 之间）/ after-switch / after-restart / after-verify 五个中断点各自崩溃后恢复 -> 全部完成新版本，且 junction 指向 == 状态记录 |
| 8j | 过早 journal 反例 | journal 声称 switched 但 junction 仍指旧版 -> 恢复完成回滚（rolled_back），绝不把旧版本标成新版本完成 |
| 9 | 新版本无法启动 | 健康 mock 持续失败 -> 自动回滚旧版本（14），旧版本健康 |
| 10 | Hub 健康但 Agent 未重连 | /health ok 但 /v1/agents 离线 -> 不误报 completed，回滚 |
| 11 | 持久数据不变 | 升级前后 shared var/workspaces 逐文件哈希一致 |
| 12 | 相同 jobId 两次 | 第二次直接返回既有终态，不重复安装 |
| 13 | 并发更新 | Updater 原子锁（wx）-> BUSY(10)；Hub 同设备 requested/running 均占用 -> 409；Worker 同步占槽，无 await 竞态窗口 |
| 14 | 日志无凭据 | 构造含 token 的错误消息 -> 输出与日志均为 [REDACTED] |
| 15 | 主机 LAN 指定设备更新 | Hub 桥接测试：device.update.request 经 WS 送达、状态上报、/v1/update-jobs 可见 |
| 16 | Hub 重启恢复 | JsonFileHubStore 持久化 -> 五个阶段（requested/running/completed/failed/rolled_back）各自重启后精确重建，同 jobId 幂等不重跑 |
| 17 | Hub 状态完整性 | 未知 phase 拒绝且不释放占用；跨设备伪造上报拒绝；合法上报不受影响 |
| 18 | Worker 异常路径 | spawn 失败 / 轮询看门狗超时 / 未安装 / 状态缺失 -> 全部产生 failed 终态并释放槽位；ACK 语义 = 可靠接纳（admit 同步占槽） |
| 19 | Worker 重启持久化 | 真实 AgentWorker：updateJobs 持久化存活，重启后补报终态，finalSent 幂等；活动任务恢复轮询 |

全部测试位于 `tools/a446-updater/test/` 与 `apps/agent-hub/test/updater-bridge.test.mjs`、`apps/agent-hub/test/worker-update-bridge.test.mjs`，运行方式见第 10 节。

## 10. 运行与验收命令

```powershell
# Updater 单元/验收测试（含本地假 Release 服务端到端）
cd D:\A446\A446-Intelligence-Dev\tools\a446-updater
npm test

# Hub/Worker 桥接回归
cd D:\A446\A446-Intelligence-Dev\apps\agent-hub
npm test

# 全仓库检查（含 Web 构建等）
cd D:\A446\A446-Intelligence-Dev
.\scripts\check-all.ps1
```

## 11. 已知限制（v1）

- 仅支持 Windows（junction、PowerShell）。
- Updater 不自更新。
- Web 控制台未提供更新页面（接口已就绪：POST /v1/commands + GET /v1/update-jobs）。
- 真实双机 LAN 验收（主机指挥笔记本更新）需主 Agent 最终审查时执行；本仓库内以桥接集成测试 + 本地假 Release 端到端替代。
- 签名验证接口已预留（manifest 可扩展 `signature` 字段），v1 只做 SHA-256。
- failed / rolled_back 任务的**重试必须使用新的 jobId**：Updater 与 Worker 桥接对已知 jobId 的终态都做幂等重放（failed → 原样重报错误，completed/rolled_back → 只重报状态），Hub 也因此不再对已知 jobId 重新下发。这是刻意的安全契约（防止 ack 丢失导致重复执行）而非缺陷。
- 若未来需要"同 jobId 重试"，须同时：envelope payload 增加 `retry` 标志、Worker 桥接据此绕过 `finalSent` 保护、Updater 支持 `--retry` 清理已失败事务；三者缺一不可，否则会退化为"假重试"（Hub 以为重试了、实际只重报旧错误）。
