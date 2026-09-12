import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export const PROTOCOL_VERSION = 1;

export function makeEnvelope(type, fields = {}) {
  return {
    v: PROTOCOL_VERSION,
    id: fields.id ?? randomUUID(),
    type,
    ts: fields.ts ?? new Date().toISOString(),
    ...(fields.agentId ? { agentId: fields.agentId } : {}),
    ...(fields.taskId ? { taskId: fields.taskId } : {}),
    ...(fields.replyTo ? { replyTo: fields.replyTo } : {}),
    payload: fields.payload ?? {},
  };
}

export function parseEnvelope(raw) {
  const value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
  if (!value || value.v !== PROTOCOL_VERSION || typeof value.id !== "string" || typeof value.type !== "string") {
    throw new Error("Invalid protocol envelope");
  }
  return value;
}

export function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }
    const equal = item.indexOf("=");
    if (equal !== -1) {
      result[item.slice(2, equal)] = item.slice(equal + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

export async function loadJsonConfig(file) {
  const absolutePath = path.resolve(file);
  const text = await readFile(absolutePath, "utf8");
  return {
    data: JSON.parse(text),
    file: absolutePath,
    dir: path.dirname(absolutePath),
  };
}

export function resolveFrom(baseDir, value) {
  if (!value || path.isAbsolute(value)) return value;
  return path.resolve(baseDir, value);
}

export async function ensureParent(file) {
  await mkdir(path.dirname(file), { recursive: true });
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function safeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
  };
}

export function commandExistsHint(command) {
  if (!command) return "No command configured";
  return `Command not found: ${command}`;
}

\n