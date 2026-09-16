# A446 Intelligence 单台预发布服务器配置教程

适用版本：`v0.5.0-alpha.3`  
适用目标：用一台租用服务器搭建独立的预发布环境，验证 Web、Server Hub、PostgreSQL、Artifact Store 和远程 Worker。  
示例系统：Ubuntu/Debian + systemd + Caddy。Windows Server、Docker、Kubernetes 和多副本高可用不在本教程范围内。

> 一台服务器可以承担预发布角色，但它不是高可用生产集群。不要把生产用户、生产数据库、生产 Artifact、生产 Worker 凭据或生产域名与预发布环境混用。

## 1. 最终结构

```text
浏览器 ── HTTPS ──┐
Worker ── WSS ────┼── Caddy :443
                  │    ├── /api/*    → Server Hub 127.0.0.1:8787
                  │    ├── /worker   → Server Hub 127.0.0.1:8787
                  │    └── 其他路径  → Web 静态文件
                  │
                  └── Server Hub
                       ├── PostgreSQL 127.0.0.1:5432
                       └── /var/lib/a446/artifacts（仓库外 Artifact Store）
```

Web 的生产构建默认请求同源 `/api`，Worker 使用 `wss://<预发布域名>/worker`。因此 Server Hub、Web 和反向代理必须使用同一个 HTTPS 域名。

## 2. 部署前清单

准备以下内容后再开始：

- 一台可通过 SSH 管理的 Ubuntu 或 Debian 服务器；建议至少 2 vCPU、4 GB 内存，并为数据库、日志、Artifact 和备份预留磁盘空间。
- 一个预发布专用域名，例如 `staging.example.com`，其 DNS A/AAAA 记录指向该服务器。
- Node.js 20+、npm、PostgreSQL、Caddy、Git 和 `rsync`。
- 一个可安全保存密码和 Worker token 的密码管理器或服务器密钥管理机制。
- 云防火墙或安全组规则：仅允许管理来源访问 SSH；对公网只开放 80/443。不要开放 5432 或 8787。

先在服务器确认运行时：

```bash
node --version
npm --version
psql --version
caddy version
```

`node --version` 必须是 20 或更高。若服务器不是 Ubuntu/Debian，不要直接执行下面的 `sudo`、systemd 或 Caddy 路径命令；应改用对应系统的服务管理方式。

## 3. 创建运行账户和目录

以下命令创建无交互登录的服务账户，以及位于仓库外的数据目录：

```bash
sudo adduser --system --group --home /srv/a446 --shell /usr/sbin/nologin a446

sudo install -d -o a446 -g a446 -m 0750 \
  /var/lib/a446/artifacts \
  /var/log/a446

sudo install -d -o root -g root -m 0755 /var/www/a446-staging
sudo install -d -o root -g a446 -m 0750 /etc/a446
```

目录职责：

| 路径 | 用途 | 不应存放 |
| --- | --- | --- |
| `/srv/a446/app` | 已审核的项目源码 | Artifact、日志、Worker state、密码 |
| `/var/lib/a446/artifacts` | 中央 Artifact 内容 | 源码和 Web 静态文件 |
| `/var/log/a446` | Server Hub 审计日志 | Token、密码、Cookie |
| `/var/www/a446-staging` | Web 生产构建 | 后端秘密和数据库转储 |
| `/etc/a446` | 权限受控的环境文件 | 公共静态资源 |

## 4. 部署项目源码和构建 Web

将已审核的仓库版本部署到 `/srv/a446/app`。可使用已授权的 Git 仓库、CI 产物或受控文件传输；不要把本机 `.env`、`node_modules`、日志、Checkpoint、Artifact 或数据库转储上传到服务器。

例如使用已配置的只读 Git 访问：

```bash
sudo -u a446 -H git clone <你的已授权仓库地址> /srv/a446/app
```

安装运行依赖并构建前端：

```bash
sudo -u a446 -H bash -c '
  set -e
  cd /srv/a446/app/apps/agent-hub && npm ci --omit=dev
  cd ../server-hub && npm ci --omit=dev
  cd ../web && npm ci && npm run build
'

sudo rsync -a --delete /srv/a446/app/apps/web/dist/ /var/www/a446-staging/
```

`apps/agent-hub` 也需要安装依赖，因为 Server Hub 会复用其中的共享编排核心。

## 5. 创建隔离的 PostgreSQL 数据库

同一服务器至少维护两个数据库：

- `a446_staging`：预发布 Server Hub 的持久数据；
- `a446_test`：只用于 `npm run test:postgres`，测试会清空 A446 表。

以 PostgreSQL 管理员身份进入终端：

```bash
sudo -u postgres psql
```

在 `postgres=#` 中执行。请从密码管理器生成不同的强密码；若要放入 PostgreSQL URI，密码中的保留字符必须 URL 编码。

```sql
CREATE ROLE a446_staging LOGIN PASSWORD '替换为预发布数据库强密码';
CREATE DATABASE a446_staging OWNER a446_staging;

CREATE ROLE a446_test_user LOGIN PASSWORD '替换为测试数据库强密码';
CREATE DATABASE a446_test OWNER a446_test_user;

\q
```

PostgreSQL 应只监听回环地址。确认没有把 5432 暴露到公网：

```bash
sudo ss -ltnp | grep 5432
```

预期监听地址为 `127.0.0.1:5432`、`[::1]:5432` 或本机 Unix socket。若出现公网 IP，先修正 PostgreSQL `listen_addresses` 和防火墙，再继续。

## 6. 创建 Server Hub 环境文件

创建 `/etc/a446/server-hub.env`。它不会被 Git 提交，也不会被程序自动从项目目录读取；systemd 会显式加载它。

```bash
sudoedit /etc/a446/server-hub.env
```

填入占位值对应的真实秘密，且不要把此文件发送给任何人：

```text
A446_DATABASE_URL=postgresql://a446_staging:<URL编码后的数据库密码>@127.0.0.1:5432/a446_staging
A446_ARTIFACT_ROOT=/var/lib/a446/artifacts
```

设置权限，使 root 和服务账户可读取：

```bash
sudo chown root:a446 /etc/a446/server-hub.env
sudo chmod 640 /etc/a446/server-hub.env
```

环境变量名称可参考 [Server Hub `.env.example`](../apps/server-hub/.env.example)，但不要把 `.env.example` 中的占位文本直接当成可连接的地址。

## 7. 创建预发布 Server Hub 配置

复制示例配置，不要修改或提交示例文件：

```bash
cd /srv/a446/app/apps/server-hub
sudo -u a446 cp config/server.example.json config/server.staging.json
sudo -u a446 chmod 600 config/server.staging.json
```

编辑 `config/server.staging.json`，至少确认以下字段。将 `staging.example.com` 换成你的预发布域名：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "auth": {
    "mode": "identity",
    "required": true,
    "sessionTtlMs": 43200000,
    "cookieName": "a446_session",
    "secureCookies": true,
    "allowedOrigins": ["https://staging.example.com"]
  },
  "tls": { "enabled": false },
  "storage": {
    "driver": "postgres",
    "connectionStringEnv": "A446_DATABASE_URL",
    "maxConnections": 10
  },
  "artifacts": {
    "rootDirectoryEnv": "A446_ARTIFACT_ROOT",
    "maxFileBytes": 104857600
  },
  "leases": {
    "enabled": true,
    "ttlMs": 30000,
    "scanIntervalMs": 5000,
    "maxRecoveryAttempts": 3
  },
  "logs": {
    "file": "/var/log/a446/server-hub-events.jsonl",
    "includePayloads": false
  }
}
```

不要将 `host` 改成 `0.0.0.0`，不要关闭 `secureCookies`，不要把 `allowedOrigins` 设为 `*`，也不要用共享 `HUB_TOKEN` 替代正式 Server Hub 身份。

## 8. 应用 migration 和创建初始管理员

先进入服务账户会话并加载环境变量：

```bash
sudo -u a446 -H bash
set -a
. /etc/a446/server-hub.env
set +a
cd /srv/a446/app/apps/server-hub
npm run migrate
```

只在首次初始化时创建管理员。密码只在当前终端内暂存，命令结束后立即清除：

```bash
export A446_BOOTSTRAP_PASSWORD='<从密码管理器复制的管理员密码>'
npm run identity -- create-user --config config/server.staging.json --username admin --role admin --password-env A446_BOOTSTRAP_PASSWORD
unset A446_BOOTSTRAP_PASSWORD
exit
```

不要把管理员密码写进命令历史、shell 配置、JSON 或屏幕截图。可考虑在交互式终端中粘贴，并在完成后清理终端历史。

## 9. 创建 systemd 服务

先确认 Node 实际位置：

```bash
command -v node
```

创建 `/etc/systemd/system/a446-server-hub.service`，将 `ExecStart` 中的 Node 路径换成上一步结果：

```ini
[Unit]
Description=A446 Server Hub (staging)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=a446
Group=a446
WorkingDirectory=/srv/a446/app/apps/server-hub
Environment=NODE_ENV=production
EnvironmentFile=/etc/a446/server-hub.env
ExecStart=/usr/bin/node src/server-hub-cli.mjs --config config/server.staging.json
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/a446/artifacts /var/log/a446

[Install]
WantedBy=multi-user.target
```

启动并检查健康状态：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now a446-server-hub
sudo systemctl status a446-server-hub --no-pager
curl --fail http://127.0.0.1:8787/health
```

诊断服务日志时使用：

```bash
sudo journalctl -u a446-server-hub -n 100 --no-pager
```

不要把包含数据库 URI、Cookie、Token 或密码的日志粘贴到公开位置。

## 10. 配置 Caddy、HTTPS 和 WebSocket

编辑 Caddy 配置（常见路径为 `/etc/caddy/Caddyfile`），将域名替换为你的预发布域名：

```caddyfile
staging.example.com {
    @api path /api/*
    handle @api {
        uri strip_prefix /api
        reverse_proxy 127.0.0.1:8787
    }

    @worker path /worker
    handle @worker {
        reverse_proxy 127.0.0.1:8787
    }

    handle {
        root * /var/www/a446-staging
        try_files {path} /index.html
        file_server
    }
}
```

Caddy 会为有效公网域名自动处理 TLS，并原生支持 WebSocket。验证并重载：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

如果证书签发失败，先检查 DNS 是否已解析到本机，以及云防火墙是否允许 80/443；不要为了临时访问而让浏览器或 Worker 跳过 TLS 证书验证。

## 11. 创建并接入 Worker 凭据

Server Hub 启动后，为每个逻辑 Worker 单独生成凭据：

```bash
sudo -u a446 -H bash
set -a
. /etc/a446/server-hub.env
set +a
cd /srv/a446/app/apps/server-hub
npm run identity -- create-worker --config config/server.staging.json --agent-id staging-executor-01 --device-id laptop-01
exit
```

该命令只显示一次 token。将它通过受控渠道放到对应 Worker 设备的进程环境中：

```text
A446_WORKER_TOKEN=<仅该 Worker 可用的凭据>
```

Worker 配置应使用：

```json
{
  "hubUrl": "wss://staging.example.com/worker",
  "authTokenEnv": "A446_WORKER_TOKEN",
  "authRequired": true,
  "artifacts": {
    "centralStore": true,
    "apiUrl": "https://staging.example.com"
  }
}
```

每个 Agent 必须有不同的 `agentId`、`stateFile` 和 `workspace`。不要复制其他 Worker 的 token、会话文件或工作区。

## 12. 首次预发布验收

依次验证：

1. 打开 `https://staging.example.com`，管理员能够登录。
2. 未登录访问受保护 API 被拒绝；普通操作者不能管理凭据、取消任务或批准人工介入。
3. 两个 Mock Worker 上线后，创建一个 Planner → Executor → Reviewer → Planner 工作流。
4. Executor 上传一个已声明输出；Reviewer 下载后通过 SHA-256 复核。
5. 创建需要人工批准的任务，重启 `a446-server-hub`，确认人工介入仍为待处理状态。
6. 同一人工请求首次处理成功，重复处理返回 HTTP `409`。
7. 在 `a446_test` 上运行 PostgreSQL 集成测试，绝不使用 `a446_staging`：

   ```bash
   export A446_TEST_DATABASE_URL='postgresql://a446_test_user:<测试库密码>@127.0.0.1:5432/a446_test'
   cd /srv/a446/app/apps/server-hub
   npm run test:postgres
   unset A446_TEST_DATABASE_URL
   ```

8. 做一次 PostgreSQL 与 Artifact 根目录的一致性备份/恢复演练。

真实 Codex 或 Antigravity 多机流程会消耗用户产品额度，必须在当前人类明确授权后才运行。

## 13. 日常更新与回退

更新前先备份数据库和 Artifact 根目录；更新后重新安装依赖、构建 Web、执行 migration、重启服务并运行健康检查。不要通过删除 migration、清空生产/预发布库或关闭安全检查来“回退”。

简化更新顺序：

```text
备份 → 停止/维护窗口 → 部署已审核版本 → npm ci → Web build → migration → 重启 Hub → 健康检查 → 工作流验收
```

备份、恢复、发布包清理与完整验收细节见 [Server Hub 运维与恢复指南](../apps/server-hub/OPERATIONS.md) 和 [批次四验证记录](SERVER_READY_V0.5_BATCH4_DESIGN.md)。

## 14. 常见问题

| 现象 | 首先检查 |
| --- | --- |
| 浏览器登录后仍报 401/403 | 域名、`allowedOrigins`、HTTPS、Cookie 是否使用同一 Origin |
| Web 页面能打开但 API 失败 | Caddy 的 `/api` 是否去除了 `/api` 前缀并代理到 127.0.0.1:8787 |
| Worker 无法连接 | Worker 的 WSS URL、独立 token、`agentId`/`deviceId` 绑定、443 出站网络 |
| Artifact 下载失败 | `A446_ARTIFACT_ROOT` 权限、Artifact 状态、Task Spec 是否声明输出、SHA-256 是否一致 |
| Hub 无法启动 | `/etc/a446/server-hub.env` 权限、数据库连接、migration、`journalctl` 输出 |
| PostgreSQL 测试清空了错误的数据 | 立即停止继续操作；测试库必须独立，运行前仅输出 URI 的主机/端口/数据库名进行人工确认 |

完成本教程不代表项目已经达到高可用生产级别；当前明确边界仍是单进程、无多副本故障切换、无多租户体系。
