# A446 Intelligence 人类用户使用手册

适用版本：最小可用原型
适用对象：课程演示人员、普通使用者、项目维护者

## 1. 这个系统能做什么

A446 Intelligence 是一个通用 AI Agent 任务控制台。当前原型可以在一台电脑上启动一个本地 Hub 和两个 Mock Worker，并通过网页完成：

- 查看 Worker 是否在线、忙碌或暂停。
- 创建任务并指定执行节点。
- 设置执行前人工审批。
- 暂停或恢复 Worker 接单。
- 取消尚未结束的任务。
- 查看执行结果、错误、检查点和产物摘要。
- 查看 Hub 记录的任务与节点事件。

Mock Worker 用于不消耗模型额度的课程演示。Codex 和 Antigravity 的适配器代码已经包含在项目中，但默认启动脚本不会调用真实模型。

## 2. 使用前准备

### 2.1 系统要求

- Windows 10 或 Windows 11。
- Node.js 20 或更高版本。
- npm 9 或更高版本。
- PowerShell。
- 浏览器。

检查版本：

~~~powershell
node --version
npm --version
~~~

如果 node 命令不存在，请先安装 Node.js 20 LTS 或更新版本。

### 2.2 第一次安装依赖

打开 PowerShell，依次执行：

~~~powershell
cd "E:\GitHub\A446 Intelligence\apps\agent-hub"
npm.cmd ci --ignore-scripts

cd "E:\GitHub\A446 Intelligence\apps\web"
npm.cmd ci
~~~

依赖已安装时不需要重复执行。

## 3. 启动与停止

### 3.1 一键启动

~~~powershell
cd "E:\GitHub\A446 Intelligence"
.\scripts\start-prototype.ps1
~~~

看到以下两类提示即表示启动成功：

- Demo healthy：Hub 和两个 Mock Worker 已启动。
- Local: http://127.0.0.1:5173/：网页已启动。

在浏览器访问：

http://127.0.0.1:5173

### 3.2 判断当前连接模式

查看网页左下角：

- 实时连接：网页已连接本地 Hub，操作会真实进入 Hub 和 Worker。
- 演示模式：网页没有连接 Hub，操作只修改浏览器内存，刷新后会恢复示例数据。
- 正在连接：网页正在尝试连接 Hub。

课程展示时应确认左下角显示“实时连接”。

### 3.3 停止

在运行网页的 PowerShell 中按 Ctrl+C。启动脚本会清理它创建的 Hub 和 Worker。

如果窗口被直接关闭，或需要单独清理演示进程：

~~~powershell
cd "E:\GitHub\A446 Intelligence"
.\scripts\stop-prototype.ps1
~~~

## 4. 页面说明

### 4.1 运行总览

首页集中显示：

- 在线节点：Hub 当前识别到的 Worker 数量。
- 活动任务：排队、执行或等待审批的任务。
- 待人工处理：需要用户批准的任务。
- 终态成功率：当前 Hub 生命周期内，终态任务中成功任务的比例。
- 节点态势：Worker 的适配器、健康和额度状态。
- 最近任务：最近创建的任务及其状态。
- 实时事件：Hub 最近记录的协议事件。

### 4.2 任务中心

任务中心支持按以下状态筛选：

- 全部
- 进行中
- 待审批
- 已完成
- 异常

点击任务行可打开右侧详情面板。

### 4.3 执行节点

执行节点页面显示：

- Agent ID
- 适配器
- 在线、执行中或暂停状态
- 执行器健康
- 额度状态
- 最后心跳
- 当前任务
- 声明能力和已探测工具

点击“暂停接单”后，新任务会在 Hub 排队；点击“恢复节点”后，排队任务继续下发。

### 4.4 人工审批

设置了执行前审批的任务会显示在这里。

点击“批准执行”后，Hub 才会把任务发给 Worker。批准只解除 Hub 的等待状态，不能绕过 Worker 的本地权限策略。

已取消、已完成或已拒绝的任务不能再次批准。

### 4.5 审计事件

审计页面显示 Hub 最近保存的事件及其原始详情，例如：

- worker.online
- task.created
- task.dispatched
- task.started
- task.result
- task.rejected
- task.cancelled
- agent.pause
- agent.resume

排查任务为什么没有执行时，先查看这里。

## 5. 创建一个任务

点击右上角“新建任务”，填写：

1. 任务名称：便于在列表中识别，可不填。
2. 任务说明：明确写出目标、输入和完成标准。
3. 执行节点：选择一个在线 Worker。
4. 预期产物路径：填写相对于 Worker 工作区的路径，例如 outputs/result.md。
5. 权限声明：仅勾选任务确实需要的能力。
6. 人工批准：重要或高风险任务建议开启。

点击“下发任务”或“提交审批”。

推荐的任务说明结构：

~~~text
目标：需要完成什么。
输入：可以使用哪些材料。
输出：应返回什么内容或文件。
验收：怎样判断任务完成。
~~~

## 6. 权限与拒绝

网页中的权限选项是任务声明，不等于最终授权。Worker 会在收到任务和真正执行前各检查一次本地策略。

当前 Mock Worker 适合无额外权限的演示任务。勾选“终端命令”或“浏览器访问”可能被本地策略拒绝，这是预期的安全行为。

常见拒绝原因：

- permission ... is not in the local allowlist：申请的权限不在 Worker 白名单中。
- browser_profile is never allowed：任务申请读取浏览器个人资料，此能力被永久禁止。
- path escapes allowed roots：输入或输出路径越出了 Worker 工作区。
- input path does not exist：声明的本地输入文件不存在。

不要为了让任务通过而关闭本地策略。应修改任务声明、使用正确的工作区路径，或由机器所有者明确调整配置。

## 7. 任务状态

常见状态含义：

| 状态 | 含义 |
| --- | --- |
| 排队中 | 等待节点恢复或等待下发 |
| 已下发 | Hub 已把任务发给 Worker |
| 执行中 | Worker 已开始执行 |
| 待审批 | 等待人工批准 |
| 已完成 | Worker 返回成功结果 |
| 失败 | 执行器运行失败 |
| 已拒绝 | Worker 本地策略拒绝任务 |
| 已取消 | 用户取消任务，状态不可恢复 |

任务完成后，详情页可能显示：

- 执行结果
- 最近检查点
- 产物文件路径
- 文件大小
- SHA-256 摘要
- 缺失的预期产物

## 8. 推荐的课程演示流程

1. 一键启动项目。
2. 确认“2 / 2”节点在线且显示“实时连接”。
3. 创建一个不勾选额外权限的普通任务，展示任务完成和结果回传。
4. 创建一个需要人工批准的任务，进入“人工审批”后批准执行。
5. 在“执行节点”暂停 agent-a，创建任务并展示排队，再恢复节点。
6. 创建一个待审批任务并取消，说明取消后不能再次批准。
7. 打开“审计事件”，展示完整事件记录。

如需在演示前一次验证所有流程：

~~~powershell
cd "E:\GitHub\A446 Intelligence"
.\scripts\check-all.ps1
~~~

脚本会统一验证并自动清理测试进程。

## 9. 常见问题

### 网页显示演示模式

原因：Hub 未启动，或 8787 端口不可访问。

处理：

1. 停止残留进程。
2. 重新运行一键启动脚本。
3. 查看 apps/agent-hub/var/process-logs/hub.err.log。

### 没有在线节点

检查：

- 启动窗口是否显示 Demo healthy。
- apps/agent-hub/var/process-logs 下的 Worker 错误日志。
- 8787 端口是否被其他程序占用。

### PowerShell 不允许运行脚本

可以只对本次启动绕过执行策略：

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-prototype.ps1
~~~

### 任务一直排队

检查目标 Worker 是否已暂停或离线。进入“执行节点”恢复 Worker。

### 任务显示已完成但没有产物

Mock Worker 主要返回文本，不保证创建文件。真实 Worker 只有在实际生成了任务声明的相对路径文件时，产物清单才会包含文件。

### 端口被占用

先运行：

~~~powershell
.\scripts\stop-prototype.ps1
~~~

如果占用者不是本项目，请停止对应程序，或修改 Hub 和 Vite 配置后再启动。

## 10. 数据与安全

- 本地演示默认只监听 127.0.0.1，不对局域网或公网开放。
- 不要把密码、Cookie、验证码、浏览器资料或模型账号凭据写进任务。
- 不要把 HUB_TOKEN 写进 JSON、网页环境变量或 Git 仓库。
- VITE_ 前缀的环境变量会进入浏览器包，不能用于保存秘密。
- 当前 Hub 是开发模拟器，不具备生产多租户、数据库和高可用能力。

## 11. 真实 Worker

真实 Codex 或 Antigravity Worker 需要：

- 本机已安装对应 CLI。
- 用户已通过官方方式登录。
- 每个 Agent 使用唯一 agentId、stateFile 和 workspace。
- 远端 Hub 提供 WSS 地址和独立 Token。
- 先运行环境检查，再启动 Worker。

详细接入说明见：

- apps/agent-hub/README.md
- apps/agent-hub/AI_IMPLEMENTATION_GUIDE.md
- apps/agent-hub/docs/protocol-v1.md

真实模型测试可能消耗账号额度，不属于默认课程演示流程。

## 12. 相关文档

- 项目原型说明：[MVP_PROTOTYPE.md](MVP_PROTOTYPE.md)
- AI 接入与维护手册：[AI_AGENT_MANUAL.md](AI_AGENT_MANUAL.md)
- Hub 使用说明：[../apps/agent-hub/README.md](../apps/agent-hub/README.md)

\n
