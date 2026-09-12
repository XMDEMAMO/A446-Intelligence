# A446 Intelligence 最小可用原型

更新时间：2026-09-12

配套手册：

- [人类用户使用手册](USER_MANUAL.md)
- [AI 接入与维护手册](AI_AGENT_MANUAL.md)

## 当前结论

室友交付的 local-agent-hub v0.3.1 可以接入本项目，现已完整保留在 apps/agent-hub。它适合作为本地通信层和协议参考；其中的 Hub 明确是开发模拟器，不能原封不动暴露到公网。

本原型定位为通用 Agent 任务平台，不绑定软件项目管理。资料整理、内容生成、文件处理、验证和编码等工作，都可以通过同一套任务模型下发给具备对应能力的 Worker。

## 已完成

网页控制台支持：

- 查看在线节点、活动任务、待审批数量与终态成功率。
- 查看 Worker 的适配器、执行器健康、粗粒度额度和工具能力。
- 创建通用任务，指定执行节点、说明、预期产物和所需权限。
- 设置执行前人工审批。
- 暂停或恢复 Worker 接单，批准或取消任务。
- 查看检查点、执行结果、错误、产物路径与 SHA-256 摘要。
- 查看 Hub 的近期协议和审计事件。
- Hub 未启动时自动进入离线演示模式；Hub 可用后自动切换为真实数据。

接入的 Hub/Worker 支持：

- Worker 主动建立 WebSocket 连接。
- 重连、心跳、ACK、去重、出站队列和串行执行。
- Codex 会话续接及 Antigravity 持久 stream-json 会话。
- 任务执行前后的本地策略检查。
- 工作区路径和符号链接越界防护。
- 阶段检查点、产物清单和 SHA-256 哈希。
- 能力探测、健康/额度状态、取消、暂停和恢复。

## 运行结构

~~~text
浏览器
  │  同源 /api
  ▼
Vite 开发代理
  │  HTTP 127.0.0.1:8787
  ▼
Local Agent Hub v0.3.1
  │  WebSocket /worker
  ├── Mock Worker A
  ├── Mock Worker B
  └── 后续可接 Codex / Antigravity Worker
~~~

控制台使用以下 Hub 接口：

- GET /health
- GET /v1/agents
- GET /v1/tasks
- GET /v1/events
- POST /v1/tasks
- POST /v1/commands

开发代理会把 /api 请求转发到 Hub。若启动 Vite 的进程设置了 HUB_TOKEN，代理在服务端附加 Bearer Token，凭据不会进入浏览器包。

## 首次安装

~~~powershell
cd "E:\GitHub\A446 Intelligence\apps\agent-hub"
npm.cmd ci --ignore-scripts

cd "E:\GitHub\A446 Intelligence\apps\web"
npm.cmd ci
~~~

## 启动

推荐从仓库根目录一键启动：

~~~powershell
cd "E:\GitHub\A446 Intelligence"
.\scripts\start-prototype.ps1
~~~

然后访问 http://127.0.0.1:5173。左下角显示“实时连接”表示网页、HTTP API、Hub 和 Worker 已连通。按 Ctrl+C 停止；如需单独清理演示进程：

~~~powershell
.\scripts\stop-prototype.ps1
~~~

也可以分别启动：

~~~powershell
cd "E:\GitHub\A446 Intelligence\apps\agent-hub"
.\scripts\start-demo.ps1

cd "E:\GitHub\A446 Intelligence\apps\web"
npm.cmd run dev
~~~

## 验证

~~~powershell
cd "E:\GitHub\A446 Intelligence\apps\agent-hub"
npm.cmd test

cd "E:\GitHub\A446 Intelligence\apps\web"
npm.cmd run lint
npm.cmd run build
~~~

当前验证结果：

- Hub 自动测试 5 项通过，0 项失败。
- Web ESLint 通过。
- Web TypeScript 与 Vite 生产构建通过。
- Hub npm 审计未发现已知漏洞。

需要一次完成全部检查时，在仓库根目录运行：

~~~powershell
.\scripts\check-all.ps1
~~~

最后一段组合式冒烟测试会在一次 Hub 生命周期内覆盖普通任务、人工审批、暂停/恢复、取消、取消后禁止审批及事件回读，并自动清理它启动的进程。

## 安全边界

- 无 Token 的本地模式只能监听回环地址，不得映射到局域网或公网。
- 正式环境应由可信后端持有 Token。不要使用 VITE_HUB_TOKEN；VITE_ 前缀变量会打包进浏览器。
- 网页里的权限选项只是任务声明，Worker 的本地策略始终拥有最终决定权。
- 当前 Hub 尚无多租户身份、细粒度 RBAC、可靠租约、数据库持久化和高可用。
- 当前产物清单可校验 Worker 本机工作区文件，尚无跨机器产物存储与下载服务。

## 2 核 4 GB 服务器

2 核 4 GB 足以运行早期的静态网页、轻量控制 API、WebSocket 连接和小规模元数据存储。模型推理、浏览器自动化和重型文件处理应放在 Worker 或外部模型服务上，不要放在这台控制服务器上。

正式上线前，应把 Mock Hub 换成独立控制服务，并补充持久数据库、TLS 反向代理、每个 Worker 独立 Token、限流、日志轮转和备份。

## 作业完成后的优化顺序

1. 固定正式任务数据模型和状态机。
2. 将 HTTP/WS 协议抽成共享包并增加兼容测试。
3. 增加数据库、Worker 身份、任务租约和超时重派。
4. 增加跨 Worker 产物存储及审批人身份审计。
5. 再扩展团队、多租户、计费和更复杂的自动调度。
\n