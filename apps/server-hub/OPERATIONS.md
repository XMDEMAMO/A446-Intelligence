# A446 Server Hub 运维与恢复指南

本指南对应单进程 PostgreSQL Server Hub alpha。它提供持久调度、独立 Worker/Web 身份、中央 Artifact Store 和人工介入恢复，但不是多副本高可用或多租户部署方案。正式上线前仍需完成阶段 G 的真实多机验证；不要把本指南理解为绕过该门槛的替代品。

## 1. 部署前提与安全边界

- Node.js 20+、PostgreSQL 和 TLS 反向代理由服务器管理员维护。
- Server Hub 默认应只监听 `127.0.0.1`，由反向代理提供 HTTPS 和 WSS；不要把未加 TLS 的端口暴露到公网。
- `A446_DATABASE_URL`、管理员密码、Worker 凭据和 Session 秘密只能放在操作系统服务的受保护环境或密钥管理系统，不能写入 JSON、日志、任务正文或仓库。
- `A446_ARTIFACT_ROOT` 必须是仓库外的绝对目录，供运行账户独占写入。不要把它设为工作区、临时目录或可被 Web 直接静态访问的位置。
- 每个逻辑 Worker 使用独立凭据，并绑定一个 `agentId` 与 `deviceId`；浏览器使用 Web Session，不与 Worker 共用凭据。
- Worker 的本地 Policy 仍是最终权限边界。服务器不能批准被 Worker 拒绝的权限、路径或凭据操作。
- 登录失败同时按规范化用户名与可信来源 IP 做可恢复退避。只有 Hub 明确配置并校验反向代理时才可读取转发地址；公网请求自带的 `X-Forwarded-For` 不可信。

环境变量名称见 [.env.example](.env.example)。该文件只是模板，当前程序不会自动读取 `.env` 文件。

首次在一台 Ubuntu/Debian 预发布服务器部署时，请先按 [单台预发布服务器配置教程](../../docs/STAGING_SERVER_SETUP_GUIDE.md) 完成 PostgreSQL 隔离、systemd、Caddy、Web 静态文件和 Worker 接入，再回到本指南进行备份与恢复验收。

可直接复核和复制的 Caddy、安全头、systemd、版本链接、备份/恢复与公网无凭据探测样例位于 [deploy/README.md](../../deploy/README.md)。样例中的域名、路径和账号仍需在目标服务器上显式确认，不能原样当作秘密或生产参数。

## 2. 最小启动顺序

以下示例使用 PowerShell，且只展示占位值。请在受保护终端或服务管理器中注入真实环境变量。

1. 创建专用 PostgreSQL 数据库和最小权限的应用角色；不要把测试库或生产库混用。
2. 为 Artifact Store 创建仓库外的专用目录，并只授予 Server Hub 服务账户读写权限。
3. 在 `apps/server-hub` 安装生产依赖并设置 Server Hub 环境：

   ```powershell
   npm.cmd ci --omit=dev
   $env:A446_DATABASE_URL = '<server-database-connection-string>'
   $env:A446_ARTIFACT_ROOT = '<absolute-directory-outside-the-repository>'
   ```

4. 从 [config/server.example.json](config/server.example.json) 复制一份本机配置。保持 `auth.mode=identity`、`secureCookies=true` 和回环监听；将 `auth.allowedOrigins` 改为 Web 控制台实际使用的唯一 HTTPS Origin。
5. 先应用 migration，再启动服务：

   ```powershell
   npm.cmd run migrate
   npm.cmd start
   ```

6. 仅在初始化时创建首个管理员。密码通过临时环境变量传入，命令结束后立即从当前会话移除：

   ```powershell
   $env:A446_BOOTSTRAP_PASSWORD = '<long-unique-password>'
   npm.cmd run identity -- create-user --config config/server.local.json --username admin --role admin --password-env A446_BOOTSTRAP_PASSWORD
   Remove-Item Env:A446_BOOTSTRAP_PASSWORD
   ```

7. 为每个 Worker 单独创建并安全传递凭据；命令输出的 token 只显示一次：

   ```powershell
   npm.cmd run identity -- create-worker --config config/server.local.json --agent-id worker-01 --device-id device-01
   ```

   只在对应 Worker 主机的进程环境设置 `A446_WORKER_TOKEN`。Worker 使用 [config/worker.example.json](config/worker.example.json)，并保持唯一的 `agentId`、`stateFile` 和 `workspace`。

## 3. TLS 反向代理

反向代理必须把同一个公网 HTTPS Origin 同时用于 Web API 和 Worker WSS 终点，并支持 WebSocket Upgrade。以 Caddy 为例：

```caddyfile
hub.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

将 `auth.allowedOrigins` 设为 `https://hub.example.com`。不要为了跨域调试把 Origin 检查改为任意来源，也不要在生产环境把 `secureCookies` 或 Worker TLS 校验关闭。若使用 Nginx、云负载均衡器或企业代理，必须显式保留 HTTP/1.1 Upgrade 头，并由其负责有效证书、TLS 更新和访问日志保留策略。

## 4. 备份与恢复

任务元数据和 Artifact 内容是一组恢复单元：只备份其中之一会产生无法验证或无法下载的成果记录。建议在计划维护窗口内暂停新任务、等待必要任务结束，再停止 Server Hub 后进行一致性备份。运行中的任务在停机后会依照 Lease 和人工确认规则恢复；不要假设可以在中途无损续跑黑盒模型调用。

备份至少包含：

- PostgreSQL 数据库的逻辑备份；
- `A446_ARTIFACT_ROOT` 的同一时间点文件系统快照或受控复制，保留权限；
- 当前 Server Hub 配置的非秘密部分及部署环境变量的名称清单，不复制真实秘密。

示例数据库备份命令：

```powershell
$backupDirectory = 'D:\A446-Backup\20260916-000000'
New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
pg_dump --format=custom --file "$backupDirectory\a446.dump" $env:A446_DATABASE_URL
```

Ubuntu/Debian 的推荐自动化入口是 `scripts/deploy/backup-server.sh`。它要求 Hub 已停止并显式设置 `A446_MAINTENANCE_CONFIRMED=yes`，随后同时生成 PostgreSQL custom dump、Artifact 快照、完成标记与数据库校验和。连接串仅通过子进程环境传给 `pg_dump`，不会写入命令输出或清单。

先确认数据库备份成功，再对 Artifact 根目录创建同一维护窗口的快照。备份介质应按部署方安全策略加密、限制读取权限，并定期做恢复演练。

恢复前必须停止 Server Hub，并确认目标数据库和 Artifact 根目录是已授权的恢复目标。以下 `pg_restore --clean` 会删除目标中与备份冲突的对象，不能对不应被覆盖的数据库执行：

```powershell
pg_restore --clean --if-exists --no-owner --dbname $env:A446_DATABASE_URL 'D:\A446-Backup\20260916-000000\a446.dump'
```

随后把同一备份点的 Artifact 快照恢复到配置的 `A446_ARTIFACT_ROOT`，恢复服务账户目录权限，运行 `npm.cmd run migrate`，再启动 Hub。完成后检查 `/health`、待处理人工介入、Artifact 下载及审计记录；不要仅凭进程启动成功判断恢复完成。

`scripts/deploy/restore-server.sh` 需要额外设置 `A446_RESTORE_CONFIRMED=yes`。它先校验完成标记与 SHA-256，再把现有 Artifact 目录移动成带时间戳的可恢复副本，并用单事务执行 `pg_restore --clean`。脚本不会自动删除旧副本，也不会自动启动服务。版本代码使用 `scripts/deploy/switch-release.sh` 切换符号链接；该脚本不降级 schema，旧代码不兼容新 schema 时必须恢复成对备份。

## 5. 验证、日志和发布包

每次代码变更至少执行：

```powershell
cd "E:\GitHub\A446 Intelligence"
.\scripts\check-all.ps1
```

涉及 PostgreSQL、身份或 Artifact Store 时，还必须对可清空的专用库运行：

```powershell
cd "E:\GitHub\A446 Intelligence\apps\server-hub"
$env:A446_TEST_DATABASE_URL = '<disposable-test-database-connection-string>'
npm.cmd run test:postgres
```

该测试会清空 A446 表，不能指向生产库。批次四新增的 Mock 故障注入会验证 Hub 重启、Executor 断线和 Reviewer 断线；它不替代 PostgreSQL 集成测试，也不消耗真实模型额度。

生产日志应默认保持 `logs.includePayloads=false`，并存到仓库外受控目录。发布前检查包内不含 `node_modules`、`dist`、`var`、Artifact 内容、Worker state/Checkpoint、`.env`、Token、密码、Cookie 或数据库转储。真实 Codex/Antigravity 多机流程会消耗现有产品额度，只能在当前人类明确授权后执行。

## 6. 身份管理集成检查

`IdentityService` 的数据库实现与 Hub HTTP 路由由不同并行账号维护。合入集成分支时必须逐项确认：

- 登录路由传入可信解析后的 `clientIp`，并转发错误对象的 `code`、`retryAfterMs`、`headers`；
- `GET/POST/PATCH /v1/admin/users` 与撤销 Session 路由只调用 `listUsers`、`createOperator`、`setUserStatus`、`revokeUserSessions`；
- Web API 不调用可创建管理员的 bootstrap `createUser`；
- rotate/revoke 提交成功后关闭对应旧 credential 的活动 WebSocket；
- API 公开用户 ID 使用 UUID，不返回 `password_salt`、`password_hash`、`password_parameters`、Session secret 或 CSRF hash；
- 只有配置的可信代理可影响来源地址，直连模式只用 socket 对端地址。

数据库集成测试 `test/identity-hardening.test.mjs` 覆盖退避恢复、无原始 IP/用户名审计、管理员 HTTP 创建拒绝、停用/撤销 Session、Worker 唯一 active 凭据与轮换旧 Token 失效。
