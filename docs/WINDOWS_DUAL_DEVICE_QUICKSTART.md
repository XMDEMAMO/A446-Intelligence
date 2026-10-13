# Windows 双设备真实 Worker 验收

把同一个 `A446-Worker-Windows-*.zip` 发给两位设备所有者。两人分别解压到自己的普通文件夹；不要直接在 ZIP 内运行，也不要使用需要管理员写入权限的目录。

默认连接：https://staging.a446intelligence.party

## 设备分工

| 设备 | 双击的文件 | 启动的身份 | deviceId |
| --- | --- | --- | --- |
| 你的设备：已登录 Codex | `启动规划执行Worker.cmd` | `codex-planner-01`、`codex-executor-01` | `device-01` |
| 帮忙者的设备：已登录 Antigravity | `启动审核Worker.cmd` | `antigravity-reviewer-01` | `device-02` |

同一份 ZIP 包可以发给两个人，但两台机器要选择不同入口。每个逻辑 Worker 有自己的配置、工作区、状态文件、会话与凭据。`device-01` 和 `device-02` 必须对应两台真实设备。

## 管理员先做一次准备

在预发布控制台登录管理员，进入 Worker 管理，按上表创建三份独立凭据，Agent ID 和 device ID 必须完全一致。已有同名凭据时，由管理员确认归属并决定是否轮换，不要重复创建或冒用其他 Worker。

通过受控渠道把各自凭据交给对应设备所有者。审核设备只需一份，Codex 设备需要两份。不要把管理员账号、Provider 登录资料或 Cookie 交给帮忙者；不要把任何凭据写进 ZIP、聊天、截图或验收记录。

也可以让对方先运行启动器、看到身份表后暂停，再在控制台创建对应凭据。生成的 `apps/agent-hub/var/staging-launcher/registration.json` 不包含秘密，可交给管理员核对身份。

## 每个人只需操作启动器

1. 确认本机安装并通过官方方式登录相应 CLI：Codex 使用 `codex login status` 检查；Antigravity 使用 `agy models` 检查。启动器只检查已有登录，不会代办登录。
2. 双击自己负责的入口。缺少 Node.js 时自动下载便携版 Node.js 24 LTS，并对照 nodejs.org 官方 SHA-256 校验；缺少项目依赖时自动按锁文件安装。首次运行需能访问 nodejs.org、npm Registry、Provider 和预发布服务器。
3. 核对身份表，在隐藏输入中粘贴自己的 Worker Token。Codex 设备依次输入规划和执行两个 Token；审核设备只输入审核 Token。输入后按 Enter。没有某份 Token 可直接按 Enter 跳过，稍后重新运行即可。
4. 保持新打开的 Worker 窗口运行，在控制台确认三个 Agent 均在线。关闭对应窗口可停止该 Worker；重新双击并输入同一身份当前有效的凭据，可沿用原工作区和状态。

启动本身不执行模型任务。管理员创建验收任务后，真实调用会消耗各自现有产品额度。运行文件都留在解压目录的 `apps/agent-hub/var/staging-launcher/`；凭据只存在对应进程环境，不保存到配置、日志或进程参数。结束后停止 Worker，并由管理员撤销仅供验收使用的凭据。

## 管理员执行一个小任务

在控制台固定选择规划 `codex-planner-01`、执行 `codex-executor-01`、审核 `antigravity-reviewer-01`，创建任务：

```text
目标：创建 validation/report.md，包含当天日期、三个参与 Agent 的名称，
以及 17 × 23 的计算结果。只安排一个执行任务，必须在 expectedOutputs 中声明该文件。
审核者在自己的工作区读取下载后的文件并核对内容，规划者最后接收审核简报。

验收：真实规划、执行、审核、回收四个阶段完成；
文件通过中央 Artifact Store 上传和下载；双方文件大小与 SHA-256 相同；
指定执行者始终保持绑定。
```

再用一个可丢弃小任务验证恢复：在执行或审核期间停止对应 Worker，然后以同一身份重新启动。根据任务状态，观察完成或明确的人工确认；不要把中断后盲目重做外部操作视为恢复成功。

复测 FLOW-001 时，再创建一个可丢弃的三分支任务，通过控制台人工重新规划并观察：每条新分支执行后都有独立审核；旧计划中未获审核通过的分支不再阻塞；最终汇总经过独立 `final_review` 并明确结案。不要用强制完成代替这项验收。若启用“执行前方案讨论”，先观察 `plan_discussion` 和 `plan_refinement`，确认只有修订后的方案进入执行；该选项每轮增加两次真实调用。

保存两个设备的 Agent/device ID、根任务及子任务 ID、Attempt ID、实际模型、时间、审核结论、文件大小与 SHA-256、Token 用量和恢复结果。客户端不提供额度或实际模型信息时明确记录未知，不推算。两个设备必须实际完成操作，启动器通过检查不能代替真实验收。

## 常见问题

- CLI 未安装或未登录：由该设备所有者通过官方客户端处理后重新双击。启动器不会读取或迁移账号凭据。
- 认证失败：核对 Token 所绑定的 Agent/device ID；管理员在控制台确认是否撤销或轮换。不要把 Token 发到群聊排错。
- 网络失败：确认能访问预发布 HTTPS 地址和 Provider；不要关闭 TLS 校验。
- 首次安装失败：确认 nodejs.org 和 npm Registry 可达后重试；运行目录必须可写。
- 需要其他服务器或身份：在 PowerShell 调用 `scripts/start-staging-workers.ps1 -Provider Codex` 或 `-Provider Antigravity`，通过 `-HubUrl wss://域名/worker -ArtifactApiUrl https://域名` 指定同源入口。身份可使用 `A446_CODEX_DEVICE_ID`、`A446_ANTIGRAVITY_DEVICE_ID` 和三个 `A446_*_AGENT_ID` 环境变量覆盖，须与服务器凭据完全一致。
- Codex 默认沿用本机 CLI 的默认模型。需要固定模型时，由账号所有者在启动前设置 `A446_CODEX_MODEL`；Antigravity 可设置 `A446_ANTIGRAVITY_MODEL`。只使用该账号实际可用的模型。

## 源码与复验

包内 `bundle-manifest.json` 列出源提交、是否包含工作树修改及每个文件的 SHA-256；ZIP 旁的 `.sha256` 校验整体内容。这是 Worker 验收包，不是已经放行的生产服务器发布包。

源码仓库中可运行 `scripts/build-windows-worker-bundle.ps1` 重新打包。无 Token 的配置检查使用 `scripts/start-staging-workers.ps1 -Provider Both -ValidateOnly`，它不启动 Worker 或执行模型任务；开发时额外指定 `-SkipReadiness` 仅验证配置结构，不能据此宣布真实客户端通过。
