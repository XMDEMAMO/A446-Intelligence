# VNC 预发布部署入口

应用候选固定为 `a762204e0ab3f2404e4862de04f066a9074b6173`，来自 `codex/staging-integration-20261010`。本分支只添加运维入口，不改变已完成全量检查和 Windows Worker 包的应用提交。

`scripts/deploy/vnc-staging.sh` 用于已经部署 A446 的 Ubuntu 服务器，由设备所有者在云厂商 VNC 的 root 终端执行。它先检查当前服务、空间和在途任务数量；存在在途任务时停止，不取消任务。取得的 GitHub 提交必须等于上述 SHA。之后调用候选自带的不可变 release 升级脚本，完成构建、受保护配置备份、数据库与 Artifact 成对备份、迁移、切换和公网验证。

本机或代理的 SSH 连通问题不要求修改服务器的登录、TLS 或防火墙策略。用户当前 VNC 输出已经确认 SSH active、22 端口监听、UFW 放行 22 和本机出口，Fail2ban 未安装；此前内核日志不能单独确定本次断连根因。

执行时保持 VNC 页面打开。看到 `VERIFIED RELEASE: a762204e0ab3f2404e4862de04f066a9074b6173` 才表示脚本完成。中途出错先保留输出和备份目录，不删除 release 目录或盲目重复升级。再次执行时，已经运行同一版本会只验证端点；存在未激活的同名 release 会停止，供人工检查。

部署脚本不调用真实模型，不创建管理员或 Worker 凭据。部署后按 `docs/WINDOWS_DUAL_DEVICE_QUICKSTART.md` 完成 FLOW-001 与真实双设备闭环；这一步尚未验收。
