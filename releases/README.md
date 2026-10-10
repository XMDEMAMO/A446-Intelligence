# Releases

Windows 双设备 Worker 验收包由 `scripts/build-windows-worker-bundle.ps1` 生成，使用说明见 `docs/WINDOWS_DUAL_DEVICE_QUICKSTART.md`。包中仅包含明确列出的源码、锁文件、示例、协议、测试和启动脚本，不包含依赖或任何运行状态。`bundle-manifest.json` 记录源提交、工作树是否有改动及各文件摘要；ZIP 旁的 `.sha256` 校验整个包。验收包不等于已经通过生产发布门禁的服务器版本。

## A446-Agent-Collaboration-v0.4.0-20260914-r8.zip

- Source commit: `ca460b2`
- Size: 247,423 bytes
- Files and directories: 105 archive entries
- SHA-256: `C094BED8A41213F48347EA9E1E0B41E6B2C4220AC422E052C5F73A7C68D25B5E`

The archive contains the tracked source, configuration examples, schemas, tests and documentation under one top-level directory. It excludes `.git`, dependencies, build output, runtime state, workspaces, logs and local authentication tokens.
