import fs from "node:fs/promises";
import path from "node:path";
import { UpdaterError, atomicWriteJson, nowIso, redact, runCommand, runPowerShell } from "./util.mjs";

/**
 * Real process controller for Windows. It finds A446 processes strictly by
 * command-line references to the live path or the current version directory
 * (never by port), stops them, and restarts the device with the packaged
 * start script using fully explicit parameters (no interactive prompts).
 */

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function createRealProcessController({ livePath, installRoot, logger = () => {} }) {
  const targets = () => [
    path.resolve(livePath),
    path.resolve(installRoot),
  ];

  const queryScript = (paths) => [
    "$ErrorActionPreference = 'Stop'",
    "$targets = @(" + paths.map(psString).join(", ") + ")",
    "$matches = @()",
    "foreach ($name in @('node.exe','powershell.exe','pwsh.exe','cmd.exe')) {",
    "  $procs = Get-CimInstance Win32_Process -Filter \"Name = '$name'\" -ErrorAction SilentlyContinue",
    "  foreach ($p in $procs) {",
    "    $cmd = [string]$p.CommandLine",
    "    if (-not $cmd) { continue }",
    "    foreach ($t in $targets) {",
    "      if ($cmd.IndexOf($t, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {",
    "        $matches += [pscustomobject]@{ pid = $p.ProcessId; name = $p.Name; command = $cmd }",
    "        break",
    "      }",
    "    }",
    "  }",
    "}",
    "if ($matches.Count -eq 0) { '[]' } else { $matches | ConvertTo-Json -Compress }",
  ].join("\n");

  const matchesA446 = (commandLine) => {
    const command = String(commandLine ?? "");
    if (!/mock-hub-cli\.mjs|worker-cli\.mjs|vite\.js|start-lan-multidevice\.ps1|worker\.mjs|hub\.mjs/.test(command)) return false;
    return true;
  };

  return {
    kind: "real",
    async listA446Processes() {
      const stdout = await runPowerShell(queryScript(targets()), { timeoutMs: 60_000 });
      const text = stdout.trim();
      if (!text) return [];
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.filter((item) => matchesA446(item.command)).map((item) => ({
        pid: Number(item.pid),
        name: String(item.name),
        command: String(item.command),
      }));
    },
    async stop() {
      const processes = await this.listA446Processes();
      if (!processes.length) return { stopped: 0 };
      const script = [
        "$ErrorActionPreference = 'Continue'",
        `$pids = @(${processes.map((item) => item.pid).join(", ")})`,
        "foreach ($id in $pids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }",
        "Start-Sleep -Milliseconds 800",
      ].join("\n");
      await runPowerShell(script, { timeoutMs: 60_000 });
      const remaining = await this.listA446Processes();
      if (remaining.length) {
        throw new UpdaterError(
          `Some A446 processes could not be stopped: ${remaining.map((item) => `${item.pid} (${item.name})`).join(", ")}`,
          { code: "STOP_FAILED", exitCode: 15 },
        );
      }
      logger(`stopped ${processes.length} process(es)`);
      return { stopped: processes.length };
    },
    async start({ role, hubIp, deviceId, accessMode, logFile }) {
      const scriptPath = path.join(livePath, "scripts", "start-lan-multidevice.ps1");
      await fs.access(scriptPath);
      const args = [
        "-Mode", role,
        "-HubIp", hubIp,
        "-DeviceId", deviceId,
        "-AccessMode", accessMode ?? "full",
      ];
      await fs.mkdir(path.dirname(logFile), { recursive: true });
      const spawnScript = [
        "$ErrorActionPreference = 'Stop'",
        `$startArgs = @(${args.map(psString).join(", ")})`,
        `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${psString(scriptPath)}, '-Mode', ${psString(role)}, '-HubIp', ${psString(hubIp)}, '-DeviceId', ${psString(deviceId)}, '-AccessMode', ${psString(accessMode ?? "full")}) -WorkingDirectory ${psString(livePath)} -WindowStyle Hidden -PassThru`,
        `$process.Id | Out-File -FilePath ${psString(logFile)} -Encoding ascii`,
      ].join("\n");
      await runPowerShell(spawnScript, { timeoutMs: 60_000 });
      logger(`restarted device as ${role}`);
      return { started: true, mode: role };
    },
  };
}

/**
 * Mock process controller used by automated tests. It records actions to a
 * JSON file so tests can assert stop/start behaviour without touching real
 * processes, and simulates "processes alive" via a marker file.
 */
export function createMockProcessController({ actionFile }) {
  return {
    kind: "mock",
    async record(action) {
      const current = await fs.readFile(actionFile, "utf8").then((text) => JSON.parse(text)).catch(() => ({ actions: [] }));
      current.actions.push({ action, at: nowIso() });
      await atomicWriteJson(actionFile, current);
    },
    async listA446Processes() {
      return [];
    },
    async stop() {
      await this.record("stop");
      return { stopped: 0 };
    },
    async start() {
      await this.record("start");
      return { started: true };
    },
  };
}

export function resolveProcessController({ controller = "real", livePath, installRoot, actionFile, logger }) {
  if (controller === "mock") return createMockProcessController({ actionFile });
  return createRealProcessController({ livePath, installRoot, logger });
}

export async function installDependencies({ versionDir, includeWeb, logger, skip }) {
  if (skip) return { installed: false, reason: "skipped" };
  const agentHubDir = path.join(versionDir, "apps", "agent-hub");
  await runCommand("npm.cmd", ["ci", "--no-audit", "--no-fund"], { cwd: agentHubDir, timeoutMs: 900_000 });
  logger(`installed dependencies for apps/agent-hub`);
  if (includeWeb) {
    const webDir = path.join(versionDir, "apps", "web");
    await runCommand("npm.cmd", ["ci", "--no-audit", "--no-fund"], { cwd: webDir, timeoutMs: 900_000 });
    logger(`installed dependencies for apps/web`);
  }
  return { installed: true };
}
