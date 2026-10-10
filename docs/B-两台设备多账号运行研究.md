# B 分支研究：两台设备稳定运行多个订阅账号

日期：2026-09-24
本轮范围：只读调查与隔离实验，不创建 Windows 用户、不切换账号、不读取凭据、不执行付费模型任务。

## 1. 目标资源

当前目标是让两台 Windows 设备稳定承载：

- 1 个 GPT Plus / Codex 账号；
- 3 个 Google AI Pro / Antigravity 账号；
- 未来可再加入第 2 个 GPT Plus；
- 每个账号是独立调度槽，同账号的多个逻辑 Agent 不能绕过账号级并发限制。

## 2. 本机事实

### 2.1 客户端版本与公开参数

- Antigravity CLI：`agy 1.2.9`。
- CLI 公开帮助没有 `--profile`、`--config-dir`、`--user-data-dir` 或账号选择参数。
- 桌面端进程使用单一 Electron 用户目录：`C:\Users\Windows\AppData\Roaming\Antigravity`。
- CLI 会在当前用户 Home 下创建 `~/.gemini/antigravity-cli` 和 `~/.gemini/config`。
- 当前系统为 Windows 11 专业版，可使用不同 Windows 用户的独立用户配置和凭据存储。

Google 官方 Codelab 也说明 CLI 首次运行通过 Google OAuth 登录，设置位于 `~/.gemini/antigravity-cli/settings.json`；官方公开材料未给出同一 OS 用户下的多账号 Profile 参数：

- [Hands-on with Antigravity CLI](https://codelabs.developers.google.com/antigravity-cli-hands-on)
- [Getting Started with Google Antigravity](https://codelabs.developers.google.com/getting-started-google-antigravity)

### 2.2 隔离实验

本轮创建了一次临时空目录，并同时改写子进程的：

- `USERPROFILE`
- `HOME`
- `APPDATA`
- `LOCALAPPDATA`
- `XDG_CONFIG_HOME`

随后分别在正常环境和临时环境执行：

1. `agy models`；
2. 官方只读 `/usage` JSON 查询（不提交模型任务）。

结果：

- 两边都能读取完全相同的模型列表；
- 两边都返回 `Healthy`、4 个额度窗口；
- 去除查询时间后，两份额度数据指纹完全相同；
- 临时 Home 虽然生成了独立 `~/.gemini/antigravity-cli` 文件结构，但账号认证仍然指向当前 Windows 用户的同一会话。

结论：**仅隔离 Home/AppData 不能隔离 Antigravity 账号**。认证很可能依赖同一 Windows 用户的安全凭据存储或共享后台会话。不能把“不同目录”包装成已实现的多账号方案。

## 3. 当前 A446 的单账号假设

现有代码还有以下明确限制：

1. `prepare-lan-device.mjs` 按 Provider 生成 Worker，一个设备最多生成一个 Antigravity Worker；Agent ID 固定为 `<deviceId>-antigravity-01`。
2. `start-lan-multidevice.ps1` 只维护一个全局 `A446_ANTIGRAVITY_ACCOUNT_ID`，所有 Antigravity Worker 会继承同一别名。
3. 设置、配置、状态、Provider Cache、日志和工作区都落在包内共享 `apps/agent-hub/var/lan`，同机多个用户/槽位会发生文件冲突。
4. `AntigravityAdapter` 原样继承 Worker 进程环境，没有账号槽级环境或运行身份概念。
5. Updater 只会以发起更新的当前 Windows 用户重新启动一个 `start-lan-multidevice.ps1`；它无法自动恢复另一个 Windows 用户的 Worker。
6. Updater 的健康检查按设备统计配置文件数量；多用户槽位若把配置分散到不同用户目录，必须有设备级槽位清单作为权威预期数。

因此不能只“多写一份 worker.json”；启动、持久目录、账号身份和更新恢复都必须一起设计。

## 4. 推荐方案：Windows 用户作为认证隔离边界

可靠方案是：**同一物理设备可有多个 Account Slot，但每个同 Provider 的不同账号运行在不同 Windows 用户下。**

建议拓扑：

| 设备 | Windows 用户/槽位 | Provider | 账号 |
| --- | --- | --- | --- |
| 主机 | 当前用户 | Codex | GPT Plus 1 |
| 主机 | 当前用户 | Antigravity | Google A |
| 笔记本 | 当前用户 | Antigravity | Google B |
| 主机或笔记本 | 独立 Windows 用户 | Antigravity | Google C |
| 未来任一设备 | 独立 Windows 用户 | Codex | GPT Plus 2 |

不同 Provider 可在同一 Windows 用户下共存；同 Provider 的不同账号必须使用不同 Windows 用户，直到官方提供并验证独立 Profile 接口。

### 4.1 登录和凭据原则

- 新 Windows 用户由人类创建并设置密码。
- 人类切换到该用户，手工完成一次官方 OAuth 登录和条款确认。
- A446 不读取密码、OAuth Token、Cookie、浏览器资料或 Windows Credential Manager 内容。
- 不在任务执行期间自动切号。
- 登录完成后，Worker 以该 Windows 用户身份运行；A446 只接收人工填写的非敏感账号别名。

### 4.2 运行方式

为每个账号槽注册一个 Windows 计划任务，使用 Windows 自身保存的运行身份：

- 任务指向稳定的 A446 `current` junction；
- 参数包含 `slotId`、`deviceId`、Hub 地址和权限模式；
- Worker 的配置、状态、Cache、日志和工作区写入该用户的 `%LOCALAPPDATA%\A446\slots\<slotId>`；
- 设备级只保留不含凭据的 `slot-registry.json`，记录期望在线槽位和计划任务名；
- 配对 Token 继续由设备级共享持久目录管理，但读取权限只授予已注册的 A446 用户。

计划任务比“切换用户后保持窗口不关”可靠，因为它可以在开机、更新和进程崩溃后重新拉起 Worker；注册任务时由人类输入该 Windows 用户密码，A446 不接触明文密码。

## 5. 建议数据模型

```json
{
  "schemaVersion": 1,
  "deviceId": "host-01",
  "slots": [
    {
      "slotId": "host-google-a",
      "provider": "antigravity",
      "accountId": "google-a",
      "accountLabel": "Google AI Pro A",
      "windowsUser": "WINDOWS\\windows",
      "taskName": "A446-Worker-host-google-a",
      "runtimeIsolation": "windows-user",
      "expectedAgents": 1,
      "enabled": true
    }
  ]
}
```

Hub 调度继续使用已经存在的 `account.id` 和 `account.maxConcurrency`。新增的关键字段是 `slotId` 与经过本地注册确认的 `runtimeIsolation`；Hub 不需要知道 Windows 密码或用户 Profile 路径。

## 6. B 分支需要实现的代码

### 6.1 Account Slot 配置生成

- `prepare-lan-device.mjs` 从“每 Provider 一个 Worker”升级为读取显式 `accountSlots[]`。
- Agent ID 改为 `<deviceId>-<provider>-<slotId>`，确保稳定且唯一。
- 每个槽位生成独立 state/cache/workspace/log 路径。
- 账号别名保存在槽位配置，不再通过一个全局环境变量覆盖所有 Worker。

### 6.2 槽位启动器

- 新增非交互的单槽位启动入口，例如 `start-account-slot.ps1`。
- 它只启动一个 Worker，不启动 Hub/Web，也不扫描或切换账号。
- 启动前执行只读 Provider 探针，确认登录有效；无法验证真实账号身份时显示人工别名和 `identityVerified=false`。
- 不允许两个槽位共享同一个 stateFile、workspace、cacheFile 或 agentId。

### 6.3 设备级监督器

- `start-lan-multidevice.ps1` 负责 Hub/Web 和当前用户槽位。
- 设备级 Supervisor 读取 `slot-registry.json`，启动或触发其他 Windows 用户的计划任务。
- `/health` 不能仅证明当前用户的 Worker 在线；Updater 必须等待设备注册表中的全部 enabled 槽位重新上线。

### 6.4 Updater 集成

- 更新前停止当前包路径下的 Worker，并停止设备槽位注册表列出的计划任务。
- 切换完成后逐个触发计划任务，而不是只重启当前用户的一份 Launcher。
- 健康检查以 `slot-registry.json` 的 enabled 槽位为准。
- 任一必需槽位未上线时不得报告 `completed`；达到超时后回滚。
- 回滚后同样需要恢复全部槽位。

## 7. 强制验收

1. 两台设备同时显示至少 4 个账号槽，账号别名和 Agent ID 稳定。
2. Google A/B/C 各运行一次只读额度探针，窗口数据分别归属正确人工别名，不串号。
3. Google A 与 Google C 在同一物理设备、不同 Windows 用户下同时执行不同的低风险模型任务。
4. 同一个 `account.id` 即使注册两个 Agent，Hub 仍只允许一个活动任务。
5. 不同 `account.id` 可并发运行。
6. 重启 Hub、重启主用户 Launcher、注销/重新登录次用户后，槽位映射不漂移。
7. Updater 更新后所有 enabled 槽位恢复；少一个槽位不得误报健康。
8. 任何日志、配置、API 和 Web 页面都不包含密码、OAuth Token 或 Cookie。
9. 新增账号只能经人工注册和登录，系统无自动切号路径。

## 8. 尚需人类完成的一次性步骤

要继续做真实原型，需要人类选择主机或笔记本作为 Google C 的承载设备，然后：

1. 创建一个新的本地 Windows 用户；
2. 切换到该用户；
3. 安装或确认 `agy` 可用；
4. 手工登录新购买的 Google AI Pro 账号；
5. 退出到原用户并告知非敏感的 Windows 用户名、设备和账号别名。

在这一步之前可以完成代码与 Mock 测试，但无法证明真实并发登录和更新后恢复。

## 9. 当前结论

- “同一 Windows 用户 + 不同 Home/AppData”方案：**已实测否决**。
- “CLI 官方多 Profile 参数”方案：**当前 1.2.9 未发现支持**。
- “不同 Windows 用户作为账号隔离边界”：**当前最可靠且不读取凭据的方案**。
- 真正实现不只是启动多个 Worker，还必须同步改造槽位持久目录、账号别名、设备监督器和 Updater 重启/健康检查。
