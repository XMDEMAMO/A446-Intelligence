import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

export class CodexAdapter {
  constructor(config, context) {
    this.config = config;
    this.agentId = context.agentId;
    this.workspace = context.workspace;
    this.child = null;
  }

  get type() {
    return "codex-exec-resume";
  }

  async start() {
    await mkdir(this.workspace, { recursive: true });
  }

  async run(input, context) {
    const command = this.config.command ?? "codex";
    const globalArgs = Array.isArray(this.config.globalArgs) ? this.config.globalArgs : [];
    const execArgs = Array.isArray(this.config.execArgs) ? this.config.execArgs : [];
    const args = context.sessionId
      ? [...globalArgs, "exec", "resume", "--json", "--skip-git-repo-check", ...execArgs, context.sessionId, "-"]
      : [...globalArgs, "exec", "--json", "--skip-git-repo-check", ...execArgs, "-"];
    const result = await runJsonl(command, args, String(input), {
      cwd: this.workspace,
      signal: context.signal,
      maxOutputChars: Number(this.config.maxOutputChars ?? 200_000),
      onSpawn: (child) => { this.child = child; },
    });
    this.child = null;
    return result;
  }

  async stop() {
    this.child?.kill();
  }
}

async function runJsonl(command, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    options.onSpawn(child);
    let stdoutBuffer = "";
    let stderr = "";
    let sessionId;
    let output = "";
    const events = [];

    const abort = () => child.kill();
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          events.push(event);
          sessionId = findSessionId(event) ?? sessionId;
          output = findAgentText(event) ?? output;
        } catch {
          output = `${output}${output ? "\n" : ""}${line}`;
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-options.maxOutputChars);
    });
    child.once("error", reject);
    child.once("close", (code, closeSignal) => {
      options.signal.removeEventListener("abort", abort);
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer);
          sessionId = findSessionId(event) ?? sessionId;
          output = findAgentText(event) ?? output;
        } catch {
          output = `${output}${output ? "\n" : ""}${stdoutBuffer.trim()}`;
        }
      }
      if (options.signal.aborted) {
        reject(Object.assign(new Error("Codex task cancelled"), { name: "AbortError" }));
      } else if (code !== 0) {
        reject(new Error(`Codex exited with code ${code}${closeSignal ? ` (${closeSignal})` : ""}: ${stderr.trim() || "no stderr"}`));
      } else if (!output) {
        reject(new Error(`Codex completed without an agent message. Events: ${events.length}`));
      } else {
        resolve({ output, sessionId });
      }
    });
    child.stdin.end(input);
  });
}

function findSessionId(event) {
  if (!event || typeof event !== "object") return undefined;
  if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
  for (const [key, value] of Object.entries(event)) {
    if (["thread_id", "session_id", "sessionId"].includes(key) && typeof value === "string") return value;
  }
  return undefined;
}

function findAgentText(event) {
  const item = event?.item;
  if (event?.type === "item.completed" && item?.type === "agent_message") {
    if (typeof item.text === "string") return item.text;
    if (typeof item.content === "string") return item.content;
  }
  if (event?.type === "message.completed" && typeof event?.message?.content === "string") return event.message.content;
  return undefined;
}

\n