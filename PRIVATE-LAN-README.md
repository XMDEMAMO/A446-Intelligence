# A446 私人局域网启动说明

这套配置固定用于当前 Windows 移动热点：

- Hub 服务器：`192.168.137.1:8787`
- 网页控制台：`http://192.168.137.1:5173`
- 认证令牌：设备 1 首次启动时随机生成并显示；设备 2 首次连接时输入一次。两端分别保存在被 Git 忽略的本地 `var` 目录中，配置 JSON 和发布包均不保存令牌
- 网络：私人热点内使用带认证的明文 WebSocket，不用于公网

双击 `START-A446-PRIVATE-LAN.bat`，按两台设备的固定角色选择：

1. 设备 1（当前服务器电脑）选择“Server + Codex planner/executor”。它会同时启动 Hub、网页、Codex 规划 Agent 和 Codex 执行 Agent。
2. 记下设备 1 首次启动时显示的 Private LAN token。
3. 设备 2 选择“Gemini reviewer”，首次运行时输入设备 1 显示的 token；之后会自动读取本机保存值。

首次运行会自动安装 Node.js 依赖。Codex 或 Gemini 的官方客户端仍需事先安装并登录。服务器启动后，局域网设备用浏览器打开 `http://192.168.137.1:5173`。

当前测试只有两台设备。设备 1 使用 GPT Plus，并运行独立的 Codex 规划 Agent 和执行 Agent；设备 2 使用 Gemini AI Pro，并只运行审核 Agent。每个 Agent 的并发数仍为 1；启动脚本不会自动切换账号，也不会加入绕过平台限制的参数。

如需重新配对，删除对应设备上的 `apps\agent-hub\var\private-lan-token.txt` 后重新启动。不要把这个文件上传、发送到群聊或加入 Git。
