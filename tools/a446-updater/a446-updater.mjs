#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { UpdaterCore } from "./lib/core.mjs";
import { UPDATER_VERSION, parseArgs, readJsonIfPresent, redact } from "./lib/util.mjs";

const COMMANDS = new Set(["status", "check", "stage", "apply", "update", "rollback", "adopt", "unadopt"]);

function defaultHome() {
  if (process.env.A446_UPDATER_HOME) return path.resolve(process.env.A446_UPDATER_HOME);
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    console.error("A446_UPDATER_HOME or LOCALAPPDATA is required to locate the updater home.");
    process.exit(2);
  }
  return path.join(localAppData, "A446-Updater");
}

function createLogger(home, command) {
  const logsDir = path.join(home, "logs");
  let stream = null;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    stream = fs.createWriteStream(path.join(logsDir, `${command}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`), { flags: "a" });
  } catch {
    stream = null;
  }
  return (message) => {
    const line = `${new Date().toISOString()} ${redact(message)}`;
    if (stream) stream.write(`${line}\n`);
  };
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

function usage() {
  const text = [
    `a446-updater ${UPDATER_VERSION}`,
    "",
    "Usage: node a446-updater.mjs <command> [options]",
    "",
    "Commands:",
    "  status                            Show adoption, current version and pending transaction",
    "  check [--version <v>]             Compare installed version with GitHub Releases",
    "  stage --version <v> [--job-id id] Download, verify and stage a version (no switch)",
    "  apply [--version <v>] [--job-id id]  Switch to a staged version and verify",
    "  update [--version <v>] [--job-id id] [--allow-downgrade]  Full update pipeline",
    "  rollback                          Roll back to the previous version",
    "  adopt --live <path> --role coordinator|worker [--hub-ip ip] [--device-id id] [--access-mode full|safe]",
    "  unadopt                           Restore the original flat layout",
    "",
    "Common options:",
    "  --api-base <url>     GitHub API base (default https://api.github.com)",
    "  --allow-http         Allow plain HTTP API/assets (local tests only)",
    "  --skip-dependency-install   Skip npm ci during staging (tests only)",
    "  --process-controller mock    Use the mock process controller (tests only)",
    "  --health-base <url>  Override the Hub base URL used by health checks",
    "",
    "Environment:",
    "  A446_UPDATER_GITHUB_TOKEN   Optional GitHub token for private repositories",
    "  A446_UPDATER_HOME           Updater home directory (default %LOCALAPPDATA%\\A446-Updater)",
    "  A446_UPDATER_FAULTS         Comma-separated fault injection points (tests only)",
    "",
    "Exit codes: 0 ok, 1 error, 2 usage, 3 up-to-date, 4 needs-adopt, 10 busy,",
    "11 version-unavailable, 12 verify-failed, 13 manual-intervention,",
    "14 rolled-back, 15 needs-manual-intervention, 16 state-corrupt",
  ].join("\n");
  return text;
}

async function main() {
  if (!command || args.help || args.h) {
    console.log(usage());
    process.exit(command ? 0 : 2);
  }
  if (!COMMANDS.has(command)) {
    console.error(`Unknown command: ${command}`);
    console.error(usage());
    process.exit(2);
  }
  const home = defaultHome();
  const config = (await readJsonIfPresent(path.join(home, "config.json")).catch(() => null)) ?? {};
  const faults = new Set(String(process.env.A446_UPDATER_FAULTS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  const overrides = {
    apiBase: args["api-base"],
    allowHttp: Boolean(args["allow-http"]),
    token: process.env.A446_UPDATER_GITHUB_TOKEN ?? null,
    skipDependencyInstall: Boolean(args["skip-dependency-install"]),
    processController: args["process-controller"],
    healthBase: args["health-base"],
    truncateDownloadAtBytes: args["truncate-download-at"] !== undefined ? Number(args["truncate-download-at"]) : undefined,
  };
  const core = new UpdaterCore({ home, config, logger: createLogger(home, command), faults, overrides });

  let result;
  let exitCode = 0;
  try {
    switch (command) {
      case "status":
        result = await core.status();
        exitCode = result.exitCode ?? 0;
        break;
      case "check":
        result = await core.check({ version: args.version });
        break;
      case "stage":
        result = await core.stage({ version: args.version, jobId: args["job-id"] });
        break;
      case "apply":
        result = await core.apply({ version: args.version, jobId: args["job-id"] });
        break;
      case "update":
        result = await core.update({
          version: args.version === "latest" ? undefined : args.version,
          jobId: args["job-id"],
          allowDowngrade: Boolean(args["allow-downgrade"]),
        });
        break;
      case "rollback":
        result = await core.rollback();
        break;
      case "adopt":
        result = await core.adopt({
          live: args.live,
          role: args.role,
          hubIp: args["hub-ip"],
          deviceId: args["device-id"],
          accessMode: args["access-mode"],
          installRoot: args["install-root"],
        });
        break;
      case "unadopt":
        result = await core.unadopt();
        break;
      default:
        throw new Error("unreachable");
    }
  } catch (error) {
    exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
    result = {
      ok: false,
      command,
      error: {
        code: error.code ?? "UPDATER_ERROR",
        message: redact(String(error.message)),
      },
      ...(error.job ? { job: error.job } : {}),
    };
  }
  const output = { ok: exitCode === 0 || exitCode === 3 || exitCode === 14, command, exitCode, result };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(exitCode);
}

await main();
