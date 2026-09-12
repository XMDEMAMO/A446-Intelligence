# Local Agent Hub

这是一个可复制到四台笔记本的本地 Agent Hub 模拟器。Hub 负责路由、在线状态、审批和日志；每台笔记本上的 Worker 只建立出站 WebSocket 连接，并在本地保存自己的 Agent session。

交给编码 AI 继续开发或审查时，先让它完整读取 `AI_IMPLEMENTATION_GUIDE.md`。该文件定义了 AI 的执行顺序、安全硬约束、协议入口和验收条件。

## 兼容性基线

- Windows 10/11、macOS 或常见 Linux 发行版
- x64 或 arm64
- Node.js 20 LTS 或更高版本
- npm 9 或更高版本
- 不要求 Docker、WSL、Python、全局 TypeScript 或原生编译工具
- 唯一运行依赖 `ws` 是纯 JavaScript 包
- Codex Worker 需要本机可执行 `codex`，并已使用 ChatGPT 账号登录
- Antigravity Worker 需要本机可执行 `agy`，并已使用 Google 账号完成官方登录

建议四台机器安装相同的 Node 主版本和相同的 Codex CLI 版本。`package-lock.json` 应随项目一起复制，然后统一运行 `npm ci`。

## 本地 MVP 范围

v0.3.1 的 Worker 已实现：

- 出站 WebSocket 长连接、指数退避重连、心跳、可靠结果回传和消息去重
- Codex session 恢复与 Antigravity 单进程持续 conversation
- 本地 Policy 双检：任务接收时和执行前各检查一次
- 工作区白名单：Task Spec 中的输入和预期成果不得越出允许目录，也会检查符号链接的真实目标
- 阶段 Checkpoint：`ACCEPTED / RUNNING / COMPLETED / FAILED / CANCELLED / REJECTED`
- Artifact 清单：只收集 Task Spec 声明的成果，并返回大小与 SHA-256
- 能力探测：启动时检查 Adapter 和配置的本地工具，随 hello/heartbeat 上报
- 健康/额度状态：`Healthy / Degraded / Unhealthy` 与 `Healthy / Low / Exhausted / Unknown`

额度探测只使用可信结果：执行成功后标记可用，遇到限流或额度耗尽错误时降级；CLI 无可靠信息时保持 `Unknown`，不会伪造 Plus 或 Google AI Pro 的精确百分比。

## 快速验证（不消耗模型额度）

```powershell
cd outputs/local-agent-hub
npm ci
npm test
./scripts/start-demo.ps1
node src/hubctl.mjs agents
node src/hubctl.mjs send --agent agent-a --input "请检查这条消息" --route agent-b --wait
./scripts/stop-demo.ps1
```

macOS/Linux：

```sh
cd outputs/local-agent-hub
npm ci
npm test
chmod +x scripts/*.sh
./scripts/start-demo.sh
node src/hubctl.mjs send --agent agent-a --input 'hello' --route agent-b --wait
./scripts/stop-demo.sh
```

本地模拟默认监听 `127.0.0.1:8787`。如果没有设置 `HUB_TOKEN`，仅限回环地址时允许无认证运行；若启动前已设置 token，Hub、Worker 和控制命令都会使用它。

## 切换到 Codex

先确认环境：

```powershell
node scripts/check-env.mjs --codex
node scripts/check-env.mjs --config config/worker.codex.example.json
```

复制 `config/worker.codex.example.json`，至少修改：

- `agentId`：全局唯一，例如 `laptop-01-codex-a`
- `hubUrl`：同学服务器提供的 `wss://.../worker`
- `stateFile`：该 Agent 独享的状态文件
- `workspace`：该 Agent 独享的工作目录
- `policy.allowedPermissions` / `policy.deniedPermissions`：该机器的本地硬权限

示例配置为兼容尚未发送 Task Spec 的服务器，默认 `policy.requireTaskSpec=false`。正式对接并确认服务器已发送 `taskSpec` 后，建议改为 `true`。

然后在当前终端注入服务器颁发的 token，再启动 Worker：

```powershell
$env:HUB_TOKEN = '<server-issued-token>'
node src/worker-cli.mjs --config config/laptop-01-codex.json
```

Worker 长驻，但 Codex 子进程按任务启动。首次任务创建 session，后续任务调用 `codex exec resume <session-id>`；因此 conversation 连续，同时避免依赖仍在变化的 app-server 协议。每个 Agent 必须使用不同的 `stateFile` 和 `workspace`。

不要把 token 写入 JSON 或提交到版本库。

## 四台笔记本部署

推荐每台机器只改一个 Worker 配置：

| 机器 | 示例 Agent ID | 适配器 | 本地状态 |
| --- | --- | --- | --- |
| Laptop 1 | `laptop-01-codex-a` | `codex` | 独立 JSON |
| Laptop 2 | `laptop-02-codex-b` | `codex` | 独立 JSON |
| Laptop 3 | `laptop-03-codex-c`、`laptop-03-antigravity-a` | `codex`、`antigravity` | 每个 Agent 独立 JSON |
| Laptop 4 | `laptop-04-codex-d`、`laptop-04-antigravity-b` | `codex`、`antigravity` | 每个 Agent 独立 JSON |

复制流程：

1. 复制项目，但不要复制另一台机器的 `var/state`。
2. 安装同一 Node 主版本。
3. 运行 `npm ci` 和 `npm test`。
4. 安装并登录本机 Codex。
5. 为机器设置唯一 `agentId`、独立 workspace 和独立状态文件。
6. 从服务器安全注入 `HUB_TOKEN`。
7. 运行 Worker；防火墙只需允许到 Hub 的出站 HTTPS/WSS。

Worker 带指数退避重连、心跳、Hub 消息确认、本地 inbox/outbox、消息去重和串行任务队列。网络中断后它会重连并重发未确认结果。

同一台笔记本运行两个 Agent 时，必须使用不同的 `agentId`、`stateFile` 和 `workspace`。

## Hub 控制命令

```text
node src/hubctl.mjs agents
node src/hubctl.mjs events --limit 100
node src/hubctl.mjs send --agent AGENT --input TEXT --route NEXT_AGENT --wait
node src/hubctl.mjs send --agent AGENT --input TEXT --task-spec config/task.local-mvp.example.json --wait
node src/hubctl.mjs send --agent AGENT --input TEXT --requires-approval
node src/hubctl.mjs approve --task TASK_ID
node src/hubctl.mjs cancel --task TASK_ID
node src/hubctl.mjs pause --agent AGENT
node src/hubctl.mjs resume --agent AGENT
```

设置远端控制地址：

```powershell
$env:HUB_HTTP_URL = 'https://hub.example.com:9443'
$env:HUB_TOKEN = '<server-issued-token>'
```

## HTTPS/WSS

`config/hub.remote.example.json` 展示了直接 TLS 监听。正式部署也可以由 Nginx、Caddy 或云负载均衡器终止 TLS，再把流量转发到回环地址上的 Hub。

生产约束：

- 非回环监听默认强制认证和 TLS。
- 每台机器应使用不同 token；当前本地 Mock Hub 使用一个共享 token，正式服务器应把 token 映射到允许的 Agent ID。
- 使用私有 CA 时，通过 `NODE_EXTRA_CA_CERTS` 注入 CA，或在 Worker 的 `tls.caFile` 指定证书。
- 不要将 `rejectUnauthorized` 设为 `false` 用于正式网络。
- 远端示例默认不记录 prompt/output 正文，只记录元数据。

## 与同学服务器对接的协议

每个 WebSocket 消息都是一个 JSON envelope：

```json
{
  "v": 1,
  "id": "uuid",
  "type": "task.assign",
  "ts": "ISO-8601",
  "agentId": "laptop-01-codex-a",
  "taskId": "uuid",
  "replyTo": "optional-message-id",
  "payload": {}
}
```

完整契约见 `docs/protocol-v1.md`，可校验定义见 `protocol/envelope.schema.json` 和 `protocol/task-spec.schema.json`。

当前消息类型：

- Worker → Hub：`worker.hello`、`worker.heartbeat`、`task.started`、`task.result`、`task.error`、`task.rejected`、`approval.request`、`ack`
- Hub → Worker：`hub.welcome`、`task.assign`、`task.cancel`、`agent.pause`、`agent.resume`、`ack`

需要可靠投递的消息在收到 `ack.replyTo` 前保留。Hub 可能重复发送同一 `id`，Worker 必须幂等处理。

Task Spec 中的路径以该 Agent 的 `workspace` 为基准。Checkpoint 默认保存在 `workspace/.agent-hub/checkpoints/<taskId>/`；服务端只收到相对路径、阶段和 ID，不接收本机绝对路径。

## Antigravity 接口边界

Antigravity 使用专用的 `antigravity` 适配器，直接实现官方持续进程协议：

- Worker 只启动一次 `agy --input-format stream-json --output-format stream-json`。
- 每个任务向 stdin 写入一个 `event: user` JSON 对象。
- 每轮等待一个 `event: result`，保存其中的 `conversation_id`。
- CLI 意外退出后，下一个任务会重新启动进程，并使用 `--conversation` 恢复已保存的会话。

先复制 `config/worker.antigravity.example.json`，设置唯一 Agent ID、Hub URL、workspace 和 state 文件。首次使用前在普通终端运行一次 `agy` 完成账号登录。不要加入 `--dangerously-skip-permissions`；需要运行的命令应通过 Antigravity 的细粒度 permission allow 规则预授权。

可用两轮无工具调用的测试确认持续上下文：

```powershell
node scripts/smoke-antigravity.mjs --model gemini-3.8-flash-low
```

如果测试返回 `User location is not supported for the API use`，说明 Google 服务端拒绝当前账号地区或网络出口，并非 Worker 或 JSONL 协议错误。应核对 Google 账号条款地区和 Antigravity 官方地理可用范围；不应通过脚本绕过地区限制。

`stdio-json` 适配器仍保留，供其他能够实现通用请求/响应 JSONL 的长期进程使用。

## 文件说明

- `src/hub.mjs`：本地 Hub 与 HTTP 控制面
- `src/worker.mjs`：跨平台长驻 Worker
- `src/adapters/codex.mjs`：Codex session 恢复适配器
- `src/adapters/antigravity.mjs`：Antigravity 原生持续 stream-json 适配器
- `src/adapters/stdio-json.mjs`：持续进程通用适配器
- `src/local-policy.mjs`：本地权限与工作区白名单
- `src/checkpoint-store.mjs`：标准阶段检查点
- `src/capability-probe.mjs`：工具、健康与额度状态
- `src/artifact-manifest.mjs`：成果文件 SHA-256 清单
- `src/hubctl.mjs`：人工控制 CLI
- `scripts/check-env.mjs`：四台机器统一环境检查
- `test/integration.test.mjs`：双 Agent、会话、路由、暂停和审批测试
- `test/local-mvp.test.mjs`：Policy、Checkpoint、能力/额度状态和 Artifact 哈希测试

本项目是协议与 Worker 的本地参考实现；同学的正式服务器可以复用 JSON envelope，而不必复用这里的 Mock Hub 代码。

\n