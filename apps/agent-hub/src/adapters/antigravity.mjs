import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

export class AntigravityAdapter {
  constructor(config, context) {
    this.config = config;
    this.context = context;
    this.state = null;
    this.child = null;
    this.pending = null;
    this.startPromise = null;
    this.stopping = false;
    this.currentProfile = null;
  }

  get type() {
    return "antigravity-stream-json";
  }

  async start(state) {
    this.state = state;
    this.stopping = false;
  }

  async ensureProcess(sessionId, model, reasoningEffort, sessionKey = "legacy") {
    const profile = `${sessionKey}:${model ?? ""}:${reasoningEffort ?? ""}`;
    if (this.child && this.currentProfile === profile) return;
    if (this.child) await this.closeProcess();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.spawnProcess(sessionId, model, reasoningEffort, sessionKey);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async spawnProcess(sessionId, model, reasoningEffort, sessionKey) {
    const command = resolveAgyCommand(this.config.command ?? "agy");
    const args = [
      ...(Array.isArray(this.config.args) ? this.config.args : []),
      "--input-format", "stream-json",
      "--output-format", "stream-json",
    ];
    if (sessionId && this.config.resumeOnStart !== false) args.push("--conversation", sessionId);
    if (model) args.push("--model", String(model));
    if (reasoningEffort) args.push("--effort", String(reasoningEffort));

    const env = { ...process.env };
    if (this.config.stripProxyEnv) {
      for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[name];
    }

    const child = spawn(command, args, {
      cwd: this.context.workspace,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.currentProfile = `${sessionKey}:${model ?? ""}:${reasoningEffort ?? ""}`;
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(child, line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => process.stderr.write(`[${this.context.agentId}:agy] ${chunk}`));
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.pending?.child === child) {
        const pending = this.pending;
        this.pending = null;
        pending.cleanup();
        pending.reject(new Error(`Antigravity CLI exited before a result (code=${code}, signal=${signal ?? "none"})`));
      }
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async run(input, context) {
    if (this.pending) throw new Error("Antigravity adapter accepts only one in-flight turn");
    await this.ensureProcess(context.sessionId, context.model ?? this.config.model, context.reasoningEffort ?? this.config.reasoningEffort, context.sessionKey);
    const child = this.child;
    if (!child?.stdin?.writable) throw new Error("Antigravity CLI stdin is not writable");

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.pending?.child === child) this.pending = null;
        if (this.child === child) this.child = null;
        child.kill();
        reject(Object.assign(new Error("Antigravity task cancelled"), { name: "AbortError" }));
      };
      const cleanup = () => context.signal.removeEventListener("abort", onAbort);
      if (context.signal.aborted) return onAbort();
      context.signal.addEventListener("abort", onAbort, { once: true });
      this.pending = { child, resolve, reject, cleanup };
      child.stdin.write(`${JSON.stringify({ event: "user", message: { content: String(input) } })}\n`, (error) => {
        if (!error) return;
        if (this.pending?.child === child) this.pending = null;
        cleanup();
        reject(error);
      });
    });
  }

  handleLine(child, line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      process.stderr.write(`[${this.context.agentId}:agy] ignored non-JSON stdout line\n`);
      return;
    }

    const conversationId = event.conversation_id ?? event.init?.conversation_id ?? event.result?.conversation_id;
    if (conversationId && this.state) this.state.sessionId = conversationId;
    if (event.event !== "result" || this.pending?.child !== child) return;

    const pending = this.pending;
    this.pending = null;
    pending.cleanup();
    const result = event.result ?? {};
    if (result.status !== "SUCCESS") {
      pending.reject(new Error(result.error || `Antigravity turn ended with status ${result.status ?? "UNKNOWN"}`));
      return;
    }
    pending.resolve({
      output: String(result.response ?? ""),
      sessionId: conversationId ?? this.state?.sessionId,
      usage: result.usage,
    });
  }

  async stop() {
    this.stopping = true;
    await this.closeProcess();
  }

  async closeProcess() {
    const child = this.child;
    this.child = null;
    this.currentProfile = null;
    if (!child) return;
    if (child.stdin.writable) child.stdin.end();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, Number(this.config.shutdownTimeoutMs ?? 5000))),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
function resolveAgyCommand(command) {
  if (process.platform !== "win32" || command.toLowerCase() !== "agy") return command;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return command;
  const candidate = path.join(localAppData, "agy", "bin", "agy.exe");
  return existsSync(candidate) ? candidate : command;
}
