# C 分支执行命令：协作任务归档、回收站与删除

将本文件全文作为实现模型的任务指令。开始前必须阅读仓库根目录 `AGENTS.md`、`docs/AI_AGENT_MANUAL.md` 与 `apps/agent-hub/AI_IMPLEMENTATION_GUIDE.md`，并遵守其中的测试、权限和工作区约束。

## 任务定位

你负责 C 分支的**后端生命周期与契约测试**。实现协作任务的归档、恢复、移入回收站、从回收站恢复和永久清除。前端由其他分支负责；不要修改 `apps/web`。

仓库当前存在其他 Agent 的未提交修改，尤其是 Updater、Hub、Worker、协作状态机和 Web。不得清理、覆盖、回退或格式化无关改动；不得执行 `git reset --hard`、`git checkout --`、全文件替换或自动 commit/push。修改 `hub.mjs` 时只允许加入最薄的接线，主体逻辑必须放入独立模块。

工作目录：`D:\A446\A446-Intelligence-Dev`

## 必须遵守的产品语义

### 1. 运行中的分支不能被物理删除

- 人类在活动工作流中“减少分支”属于规划调整：分支只能进入 `cancelled` 或 `superseded`，历史记录、审核意见、额度和 Artifact 引用必须保留。
- 归档和删除以 `rootTaskId` 对应的**整个协作任务/群聊**为单位。
- 禁止删除 DAG 中的单个中间任务、单条审核记录或单条 Attempt，以免破坏状态链。

### 2. 生命周期

实现独立于业务 `task.status` 的会话生命周期：

```text
active -> archived -> trashed -> purged
           ^           |
           +-- restore-+
```

- `active`：默认状态。
- `archived`：从默认任务列表隐藏，全部数据和 Artifact 保留，可恢复。
- `trashed`：进入回收站，默认保留 7 天，可恢复；记录 `trashedAt`、`purgeAfter`、操作者。
- `purged`：永久删除任务正文、消息、Attempt、Intervention、投递记录和对应 Artifact 内容；只保留最小审计墓碑，至少包含 `rootTaskId`、原任务标题摘要或不可逆摘要、删除者、删除时间和清除数量，不保留成果正文、提示词、附件内容或凭据。

活动工作流不得直接 archive/trash/purge。必须先完成、失败、拒绝或取消。返回稳定的 HTTP 409 错误码，例如 `WORKFLOW_NOT_TERMINAL`。

### 3. 权限

- Operator：允许 archive、restore、trash、restore-from-trash。
- Administrator：拥有上述能力，并且只有 Administrator 可以永久 purge。
- 沿用现有认证、RBAC、Actor 和审计设施，不新增旁路权限判断。

### 4. 幂等与并发

- 重复 archive、restore、trash 操作必须幂等返回当前状态，不能产生重复审计或重复删除。
- 生命周期转换必须校验当前版本/状态；两个并发请求只能有一个真正改变状态。
- purge 后再次 purge 应返回可识别的幂等结果或 404 墓碑响应，不得抛出未处理异常。
- Hub 重启后生命周期、回收期限和墓碑必须恢复。

## 数据模型建议

优先新增独立的 `conversationLifecycle` 持久集合，不要复用任务执行状态，也不要把 `archived`/`trashed` 塞进 `task.status`。

每条记录至少包含：

```json
{
  "rootTaskId": "...",
  "state": "active|archived|trashed",
  "archivedAt": null,
  "archivedBy": null,
  "trashedAt": null,
  "trashedBy": null,
  "purgeAfter": null,
  "updatedAt": "ISO-8601",
  "version": 1
}
```

永久清除后的墓碑使用独立 `conversationTombstones` 集合。必须检查并适配仓库现有 Memory、JSON File 和 PostgreSQL Store；如果 PostgreSQL 与本地 Hub 的领域层仍未共用，不得伪造“已支持”，应明确列出接口差异并为可测试的当前实现补齐真实存储。

## HTTP 契约

沿用现有 `/v1/conversations` 资源，建议实现：

- `POST /v1/conversations/{rootTaskId}/archive`
- `POST /v1/conversations/{rootTaskId}/restore`
- `DELETE /v1/conversations/{rootTaskId}`：移入回收站，不做硬删除
- `POST /v1/trash/{rootTaskId}/restore`
- `DELETE /v1/trash/{rootTaskId}`：Administrator 永久清除
- `GET /v1/conversations?lifecycle=active|archived|trashed|all`

如果当前路由风格要求通过 `/v1/commands` 实现，允许增加对应命令，但必须保持上述资源语义、权限、错误码和测试覆盖。不要让同一操作出现两套含义不同的实现。

列表默认只返回 `active`；`archived` 和 `trashed` 必须显式查询。读取具体已归档任务允许；读取已移入回收站任务仅返回回收站摘要，不默认返回完整成果正文。

## Artifact 清理边界

- archive/trash 不删除 Artifact。
- purge 只删除目标 `rootTaskId` 独占的 Artifact。
- 如果 Artifact 存在跨任务引用，必须先做引用计数或反向引用检查，仍被其他根任务引用时不得删除实体文件。
- 文件删除失败必须使 purge 失败并保留可重试状态，不能出现“数据库显示已清除但磁盘正文仍在”的静默成功。
- 路径必须通过现有 Artifact Store 的安全边界校验，禁止直接拼接用户输入路径。

## 审计事件

至少记录：

- `conversation.archived`
- `conversation.restored`
- `conversation.trashed`
- `conversation.trash_restored`
- `conversation.purged`
- `conversation.lifecycle.rejected`

审计必须包含 Actor、rootTaskId、转换前后状态、时间和稳定原因码；不得记录 Token、Cookie、登录信息或完整成果正文。

## 强制测试

每项测试必须先证明旧实现不满足，再证明新实现通过。至少覆盖：

1. 终态协作任务可归档，默认列表隐藏，归档列表可见。
2. 归档后恢复，消息、任务、Artifact 和审核记录完整。
3. 活动工作流 archive/trash/purge 均返回 409，状态不变。
4. 移入回收站后默认和归档列表均隐藏，回收站列表可见。
5. 回收站恢复后回到归档状态，而不是直接变成活动列表；如选择其他语义，必须在契约中明确并保持一致。
6. Operator 无权永久 purge，Administrator 可以。
7. purge 后正文、消息、Attempt、Intervention 和独占 Artifact 被清除，只保留最小墓碑。
8. 共享 Artifact 不被误删。
9. archive/trash/restore 重复请求幂等。
10. 两个并发生命周期请求只有一个产生有效转换和审计。
11. JSON Store 重启后 archived/trashed 状态和 purgeAfter 完整恢复。
12. PostgreSQL Store 的迁移、约束和并发条件更新测试；没有专用数据库时必须明确标记未执行，禁止写成通过。
13. 非管理员调用硬删除 API 返回 403。
14. 单个子任务删除请求被拒绝，不破坏 DAG。
15. 全量 Agent Hub 回归、Server Hub 检查、Web lint/build（只验证，不改 Web）和组合 smoke 不新增失败。

## 文件和冲突边界

- 优先新增：生命周期领域模块、Store 迁移/接口、专用测试和契约文档。
- `apps/agent-hub/src/hub.mjs` 只做 import、实例化和路由接线；不得重排或覆盖其中现有协作、Updater、资源探针代码。
- 不得修改 `apps/web`。
- 不得修改 Updater 目录或更新协议。
- 不得处理 A 分支的 `final_review`，也不得处理 B 分支的多账号启动器。

## 验收与交付格式

完成后必须提供：

1. 精确修改文件列表，区分新增与修改。
2. 每个生命周期转换的状态表、HTTP 状态码和稳定错误码。
3. 每项强制测试的名称与实际运行结果。
4. Agent Hub 全量回归结果及失败甄别，不得把失败简单称为“预先存在”而不做纯基线验证。
5. 未执行项和原因，尤其是 PostgreSQL 专用验收。
6. 已知限制、数据恢复方式和回退方式。
7. 不 commit、不 push、不部署；等待主 Agent 独立审查。

最终交付标准不是“接口能调用”，而是：数据生命周期清晰、重启可恢复、并发安全、权限明确、Artifact 不泄漏也不误删、现有工作流回归零新增失败。
