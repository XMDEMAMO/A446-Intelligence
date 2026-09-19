# A446 Agent 群聊控制台

这是 A446 Intelligence 的非技术型协作界面。每个根任务对应一个群聊，规划、执行和审核 Agent 在群内发布任务简报，执行 Agent 的完整成果以可展开附件呈现。

## 页面结构

- 左侧：任务群聊列表；一个任务只创建一个群聊。
- 中间：角色消息、`@` 提醒、内部步骤状态、完整成果附件和单次 Token 用量。
- 右侧：参与 Agent，以及按账号汇总的设备数、Agent 数、输入/输出/缓存/总 Token 和可信额度快照。
- 新建任务：可让 Hub 自动选择规划、执行、审核 Agent，也可以把 Executor 设为硬约束。
- 人工介入：同一群聊可切换并逐项处理多个待办。
- 系统管理：管理员可维护 operator 与 Worker 凭据；明文 Worker Token 只在创建或轮换成功后显示一次。
- 运维控制：管理员可取消活动任务，并暂停或恢复在线 Agent。

群聊用于人类观察和沟通；普通消息和 `@Agent` 不直接改变任务状态。角色切换、审核通过、驳回、重排和人工介入由 Hub 的正式工作流控制。

## 运行

```powershell
npm.cmd ci
npm.cmd run dev
```

默认通过 Vite 的同源 `/api` 代理连接 `http://127.0.0.1:8787`。启动时先调用 `/v1/auth/me`；未认证时只显示登录页并停止业务轮询。登录后使用服务端 Session Cookie 与 CSRF Token 鉴权。

真实连接使用 `loading / live / reconnecting / offline` 状态：只有 `live` 允许修改。轮询采用 single-flight、请求超时、AbortController、失败退避和页面可见性控制；当前会话通过 `rootTaskId` 读取摘要，完整成果在展开附件时再加载。连接失败不会自动生成演示任务或切换到 Demo。

如需显式只读演示，可在本地设置：

```text
VITE_DEMO_MODE=true
```

生产环境应保持该值为 `false` 或不设置。

## 验证

```powershell
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

不要使用 `VITE_` 环境变量保存任何凭据；这类变量会进入浏览器包。正式 Web 身份只使用登录 Session，Vite 代理不附加共享 Hub Token。前端按角色隐藏管理入口只用于体验，全部权限仍由 Server Hub RBAC 强制。
