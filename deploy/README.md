# A446 v0.5 部署与回退样例

本目录是账号 C 负责的部署基线，目标是单台 Ubuntu/Debian 服务器上的 HTTPS/WSS、systemd 自启动、仓库外秘密、成对备份与可恢复回退。它不是多副本高可用方案，也不会替代应用自身的 Web Session、RBAC、CSRF 或 Worker Token 认证。

## 1. 推荐目录

```text
/srv/a446/releases/<release-id>/    只读、已审核的完整版本
/srv/a446/current -> releases/...   当前版本符号链接
/etc/a446/server-hub.env            数据库 URL 与 Artifact 根目录，0640
/etc/a446/server-hub.json           非秘密服务配置，0640
/etc/a446/workers/<name>.env         单个 Worker Token，0640
/etc/a446/workers/<name>.json        单个 Worker 配置，0640
/var/lib/a446/artifacts              中央 Artifact Store
/var/log/a446                        Server Hub 日志
/var/backups/a446                    数据库与 Artifact 成对备份
```

每个 release 必须先安装锁定版本依赖并生成 `apps/web/dist`，再用 `scripts/deploy/switch-release.sh` 切换。不要把 `.env`、数据库转储、Artifact、Worker state、模型会话或明文 Token 放进 release 或 Git。

## 2. Caddy 与可信代理

复制 [Caddyfile.example](Caddyfile.example)，替换域名并先运行 `caddy validate`。样例完成以下事情：

- `/api/*` 去掉 `/api` 前缀后代理到仅监听 `127.0.0.1:8787` 的 Hub；
- `/worker` 代理 WSS，Caddy 自动处理 WebSocket Upgrade；
- HTML/SPA fallback 使用 `no-store`，带内容哈希的 `/assets/*` 使用一年 immutable 缓存；
- 设置 CSP、禁止 frame 嵌入、MIME sniffing、宽松来源泄漏和不需要的浏览器能力；
- HSTS 默认注释，只有真实域名 HTTPS 稳定且子域策略确认后才启用。

Hub 的登录限流默认只应信任 socket 对端。`apps/server-hub/config/server.example.json` 中 `auth.trustedProxyIps` 默认为空；只有在确认 Hub socket 实际看到的代理地址后，才加入精确地址或 CIDR。例如，同机 Caddy 的 peer 确认是 `127.0.0.1` 时可以设置：

```json
"trustedProxyIps": ["127.0.0.1/32"]
```

未匹配的 socket 对端不能影响登录来源 IP，即使它发送了伪造的 `X-Forwarded-For`。匹配可信代理后，Hub 从转发链右侧向左跳过配置中的代理 IP，遇到第一个未信任 IP 后停止。若 Caddy 前还有 Cloudflare 或负载均衡器，只信任这些实际代理使用的地址范围，并在 Caddy 中同样限定上游代理；不要配置 `0.0.0.0/0` 或 `::/0`。

Cloudflare Access 可以作为额外入口门禁，但不能取代 A446 的登录、RBAC、CSRF 和 Worker 凭据。不要让 Access 的身份头自动成为应用管理员身份。

## 3. systemd

将 [a446-server-hub.service.example](systemd/a446-server-hub.service.example) 和 [a446-worker@.service.example](systemd/a446-worker@.service.example) 复制到 `/etc/systemd/system/` 后去掉 `.example`。确认本机 `node` 路径、服务账号和可写目录，再执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now a446-server-hub
sudo systemctl enable --now a446-worker@executor-01
```

Worker 模板从 `/etc/a446/workers/%i.env` 读取该实例唯一的 `A446_WORKER_TOKEN`。同一 `agentId` 不得复用 Token、state 文件或 workspace。若模型 CLI 还需要自己的凭据目录，应只向专用 Worker 账号开放所需目录，不要降低 Hub 服务的隔离设置。

## 4. 备份与恢复

数据库和 Artifact 是一个恢复单元。先停止 Hub、确认维护窗口，再加载受保护环境；不要把数据库 URL 写到命令参数或脚本日志。备份脚本使用子进程环境向 `pg_dump` 传递连接信息：

```bash
sudo systemctl stop a446-server-hub
set -a
. /etc/a446/server-hub.env
set +a
export A446_MAINTENANCE_CONFIRMED=yes
bash scripts/deploy/backup-server.sh /var/backups/a446
unset A446_MAINTENANCE_CONFIRMED A446_DATABASE_URL A446_ARTIFACT_ROOT
```

备份目录本身仍包含完整业务数据，应限制读取权限，并按组织策略加密、异地保存和设定保留期。

备份目录只有出现 `COMPLETE` 标记且 `SHA256SUMS` 校验通过才可恢复。恢复会用 PostgreSQL 单事务执行 `pg_restore --clean`，并先把原 Artifact 目录移动为带时间戳的可回退副本；它不会自动删除旧副本。此操作会替换目标数据库对象，必须再次显式确认：

```bash
sudo systemctl stop a446-server-hub
set -a
. /etc/a446/server-hub.env
set +a
export A446_MAINTENANCE_CONFIRMED=yes
export A446_RESTORE_CONFIRMED=yes
bash scripts/deploy/restore-server.sh /var/backups/a446/a446-<UTC时间>
unset A446_RESTORE_CONFIRMED A446_MAINTENANCE_CONFIRMED A446_DATABASE_URL A446_ARTIFACT_ROOT
```

恢复后先运行 migration，再启动 Hub，并验证健康检查、登录、待处理人工介入与 Artifact 下载。不要对生产库运行 `test:postgres`。

## 5. 版本切换与回退

`switch-release.sh` 只切换经过校验的 release 符号链接，保留旧链接，不执行 `git reset`，也不自动降级数据库 schema。发布或回退前必须停止 Hub/Worker，并已完成同一维护窗口的备份：

```bash
export A446_MAINTENANCE_CONFIRMED=yes
export A446_SERVICES_STOPPED=yes
bash scripts/deploy/switch-release.sh <release-id>
unset A446_SERVICES_STOPPED A446_MAINTENANCE_CONFIRMED
```

切换后运行 migration、启动服务并验证。若旧代码与已升级 schema 不兼容，应恢复切换前的数据库与 Artifact 成对备份，不能删除 migration 或手工修改版本记录。

## 6. 公网验收

从能够通过入口门禁的独立网络执行：

```bash
node scripts/deploy/verify-public-endpoint.mjs https://hub.example.com
```

脚本不需要凭据，会检查健康端点、未登录 API 拒绝、Worker 路由、Web 安全头、HTML 禁止缓存以及指纹静态资源 immutable 缓存。它不会创建任务、连接真实 Worker 或消耗模型额度。真实工作流、多机重连、凭据轮换和恢复演练仍需按发布验收计划单独执行。
