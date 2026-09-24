import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const UPDATER_VERSION = "0.1.0";

export class UpdaterError extends Error {
  constructor(message, { exitCode = 1, code = "UPDATER_ERROR", details } = {}) {
    super(message);
    this.name = "UpdaterError";
    this.exitCode = exitCode;
    this.code = code;
    if (details) this.details = details;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix = "") {
  const raw = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}-${raw}` : raw;
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      args._.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        index += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

export async function readJson(file) {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text);
}

export async function readJsonIfPresent(file) {
  if (!existsSync(file)) return null;
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

export async function sha256File(file) {
  const digest = createHash("sha256");
  await pipelineFile(file, digest);
  return digest.digest("hex");
}

async function pipelineFile(file, hash) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 256);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

export function isValidVersion(value) {
  return typeof value === "string" && VERSION_PATTERN.test(value.replace(/^v/i, ""));
}

export function normalizeVersion(value) {
  if (typeof value !== "string") return null;
  const stripped = value.trim().replace(/^v/i, "");
  if (!isValidVersion(stripped)) return null;
  return stripped;
}

/**
 * Compares two version strings. Returns a negative number when a < b,
 * zero when equal, and a positive number when a > b.
 * Rules: numeric major/minor/patch; a bare release outranks any prerelease of
 * the same triple; `-preview<N>` compares by N; other prerelease segments
 * compare lexically (dot-separated, numeric-aware).
 */
export function compareVersions(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  if (!left) throw new UpdaterError(`Invalid version string: ${redact(String(a))}`, { code: "INVALID_VERSION" });
  if (!right) throw new UpdaterError(`Invalid version string: ${redact(String(b))}`, { code: "INVALID_VERSION" });
  const leftMatch = left.match(VERSION_PATTERN);
  const rightMatch = right.match(VERSION_PATTERN);
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (delta !== 0) return delta;
  }
  const leftPre = leftMatch[4] ?? null;
  const rightPre = rightMatch[4] ?? null;
  if (leftPre === null && rightPre === null) return 0;
  if (leftPre === null) return 1;
  if (rightPre === null) return -1;
  const leftPreview = leftPre.match(/^preview\.?(\d+)$/i);
  const rightPreview = rightPre.match(/^preview\.?(\d+)$/i);
  if (leftPreview && rightPreview) return Number(leftPreview[1]) - Number(rightPreview[1]);
  if (leftPreview) return -1;
  if (rightPreview) return 1;
  const leftParts = leftPre.split(".");
  const rightParts = rightPre.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const delta = Number(leftPart) - Number(rightPart);
      if (delta !== 0) return delta;
    } else {
      const lexical = leftPart.localeCompare(rightPart);
      if (lexical !== 0) return lexical;
    }
  }
  return 0;
}

const REDACTION_PATTERNS = [
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bA446-[0-9a-f]{8,}-[0-9a-f]{8,}\b/gi, replacement: "[REDACTED]" },
  { pattern: /\bA446-[0-9a-fA-F-]{20,}\b/g, replacement: "[REDACTED]" },
  { pattern: /Authorization\s*:\s*Bearer\s+[^\s"']+/gi, replacement: "Authorization: Bearer [REDACTED]" },
  { pattern: /"token"\s*:\s*"[^"]+"/gi, replacement: '"token":"[REDACTED]"' },
];

export function redact(text) {
  let output = String(text);
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export async function runPowerShell(script, { timeoutMs = 120_000 } = {}) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new UpdaterError("PowerShell invocation timed out", { code: "POWERSHELL_TIMEOUT" }));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new UpdaterError(`PowerShell exited with ${code}: ${redact(stderr.trim())}`, { code: "POWERSHELL_FAILED" }));
    });
  });
}

export async function runCommand(file, argsList, { cwd, timeoutMs = 600_000, env } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, argsList, { cwd, windowsHide: true, env: env ?? process.env, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new UpdaterError(`${path.basename(file)} timed out`, { code: "COMMAND_TIMEOUT" }));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new UpdaterError(`${path.basename(file)} exited with ${code}: ${redact((stderr || stdout).trim().slice(0, 2000))}`, { code: "COMMAND_FAILED" }));
    });
  });
}

export function assertSafeRelativeSegment(value, label) {
  if (typeof value !== "string" || !value.length) {
    throw new UpdaterError(`${label} is required`, { code: "UNSAFE_PATH", exitCode: 12 });
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..") || value.includes(":") || value.includes("\0")) {
    throw new UpdaterError(`${label} must be a single safe path segment: ${redact(value)}`, { code: "UNSAFE_PATH", exitCode: 12 });
  }
  if (/^[a-z]:/i.test(value) || value.startsWith(".") || value === "shared" || value === "versions" || value === "current.json") {
    throw new UpdaterError(`${label} is reserved or unsafe: ${redact(value)}`, { code: "UNSAFE_PATH", exitCode: 12 });
  }
}

export function versionKey(version) {
  const normalized = normalizeVersion(version);
  if (!normalized) throw new UpdaterError(`Invalid version: ${version}`, { code: "INVALID_VERSION" });
  return normalized;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
