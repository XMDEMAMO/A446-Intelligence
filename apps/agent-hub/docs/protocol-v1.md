# Agent Hub Protocol v1

本文档是本地 Worker 与正式服务器之间的兼容契约。机器可使用不同操作系统，但必须发送相同的 UTF-8 JSON 消息。

## Transport

- 正式环境：`wss://HOST/worker`
- 本机测试：`ws://127.0.0.1:8787/worker`
- 每个 WebSocket text frame 包含一个完整 envelope。
- Worker 必须主动连接 Hub；Hub 不连接笔记本。
- 认证头：`Authorization: Bearer <token>`。
- 正式服务器应从 token 得到允许的 `agentId`，不能只相信 hello 中的声明。

## Handshake

连接后的第一条消息必须是：

```json
{
  "v": 1,
  "id": "4792facf-a3f9-4a13-8297-408a7de91822",
  "type": "worker.hello",
  "ts": "2026-09-12T00:00:00.000Z",
  "agentId": "laptop-01-codex-a",
  "payload": {
    "adapter": "codex-exec-resume",
    "capabilities": ["task.execute", "coding", "pause", "resume", "cancel"],
    "sessionId": null,
    "paused": false,
    "platform": "win32",
    "node": "v20.19.0",
    "observedCapabilities": {
      "adapter": { "name": "codex", "available": true, "version": "codex-cli 1.x" },
      "tools": [{ "name": "git", "available": true, "version": "git version 2.x" }]
    },
    "executors": [{ "type": "codex-exec-resume", "health": "Healthy", "quota": "Unknown" }]
  }
}
```

Hub 返回 `hub.welcome`。同一 `agentId` 的新连接替换旧连接。

`worker.heartbeat.payload` 除 `busy`、`paused`、`sessionId` 外，还应携带 `currentTaskId`、`observedCapabilities` 和 `executors`。额度状态只允许使用 `Healthy / Low / Exhausted / Unknown`；无法从官方工具可靠读取时必须上报 `Unknown`，不得伪造精确百分比。

## Reliable delivery

- Hub 发送的 `task.assign`、`task.cancel`、`agent.pause`、`agent.resume` 需要 Worker 回 `ack`。
- Worker 发送的 `task.started`、`task.result`、`task.error`、`task.rejected`、`approval.request` 需要 Hub 回 `ack`。
- `ack.replyTo` 等于被确认消息的 `id`。
- 未确认消息可在超时或重连后重复发送；接收方必须以消息 `id` 去重。
- `worker.heartbeat` 和 `hub.welcome` 不要求确认。
- 网络语义是 at-least-once，不承诺 exactly-once；幂等由接收方保证。

## Task lifecycle

```text
queued -> dispatched -> running -> completed
                         |          failed
                         |          cancelled
                         |          rejected
                         -> awaiting_approval -> running
```

`task.assign.payload`：

Task Spec 的 JSON Schema 位于 `protocol/task-spec.schema.json`。Worker 会在接收任务和真正执行前各做一次本地校验；服务器端校验成功不替代本地校验。

```json
{
  "input": "human or upstream agent message",
  "rootTaskId": "uuid",
  "parentTaskId": "optional uuid",
  "sourceAgentId": "human or another agent",
  "metadata": {},
  "taskSpec": {
    "inputs": ["input.txt"],
    "expected_outputs": ["artifact.txt"],
    "permissions_required": {
      "project_workspace": true,
      "terminal": true,
      "browser": false
    }
  }
}
```

`task.result.payload`：

```json
{
  "output": "agent output",
  "sessionId": "local durable session id",
  "artifacts": {
    "algorithm": "sha256",
    "files": [{ "path": "artifact.txt", "size": 123, "sha256": "hex", "status": "ready" }],
    "missing": []
  },
  "checkpoint": { "checkpointId": "id", "stage": "COMPLETED", "path": ".agent-hub/checkpoints/task-id" },
  "executor": { "type": "codex-exec-resume", "health": "Healthy", "quota": "Healthy" }
}
```

本地 Policy 拒绝任务时，Worker 返回 `task.rejected`，其中 `payload.code` 为 `POLICY_DENIED`，`payload.reasons` 为拒绝原因列表，并附带 `checkpoint`。服务器必须把它视为终态，不得自动放宽权限后重发。

Worker 至少在 `ACCEPTED / RUNNING / COMPLETED / FAILED / CANCELLED / REJECTED` 阶段保存本地 Checkpoint。Checkpoint 目录包含 `state.json`、`task_spec.json`、`files_manifest.json`、`continuation.md`，有输出时还包含 `partial_output.txt`。

`task.error.payload`：

```json
{
  "error": { "name": "Error", "message": "safe message" },
  "cancelled": false,
  "sessionId": "optional session id",
  "checkpoint": { "checkpointId": "id", "stage": "FAILED", "path": ".agent-hub/checkpoints/task-id" },
  "executor": { "type": "codex-exec-resume", "health": "Degraded", "quota": "Low" }
}
```

Hub 通过新建子任务实现 A → B。子任务沿用 `rootTaskId`，`parentTaskId` 指向 A 的任务，`sourceAgentId` 为 A。

## Compatibility rules

- 未知的更高 `v` 必须拒绝，不能静默降级。
- v1 内新增的 `payload` 字段应被旧客户端忽略。
- envelope 顶层不增加未协商字段；Schema 设置了 `additionalProperties: false`。
- Agent ID 在四台机器之间必须全局唯一且稳定。
- session ID 只由对应 Worker 持有；Hub 可记录但不得替另一台机器恢复该 session。
- 时间一律为 UTC ISO-8601；顺序以任务关系和消息 ID 为准，不能依赖四台机器的时钟完全一致。
- prompt/output 是否进入 Hub 日志由部署配置决定；token 永远不得写日志。

## HTTP control plane in the mock

- `GET /health`
- `GET /v1/agents`
- `GET /v1/events?limit=N`
- `GET /v1/tasks?rootTaskId=UUID`
- `POST /v1/tasks`
- `POST /v1/commands`

正式服务器可以使用其他控制台或数据库，但 WebSocket envelope 应保持兼容。

\n