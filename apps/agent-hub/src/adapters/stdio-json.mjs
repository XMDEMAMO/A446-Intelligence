import { spawn } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

export class StdioJsonAdapter {
  constructor(config, context) {
    this.config = config;
    this.context = context;
    this.child = null;
    this.pending = new Map();
  }

  get type() {
    return "stdio-json";
  }

  async start() {
    if (!this.config.command) throw new Error("stdio-json adapter requires adapter.command");
    this.child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.context.workspace,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => process.stderr.write(`[${this.context.agentId}:adapter] ${chunk}`));
    this.child.on("exit", (code) => {
      const error = new Error(`Persistent adapter exited with code ${code}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.child = null;
    });
    await new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
  }

  async run(input, context) {
    if (!this.child) throw new Error("Persistent adapter is not running");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        reject(Object.assign(new Error("Task cancelled"), { name: "AbortError" }));
      };
      if (context.signal.aborted) return abort();
      context.signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          context.signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject,
      });
      this.child.stdin.write(`${JSON.stringify({ id, input: String(input), sessionId: context.sessionId })}\n`);
    });
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(String(message.error)));
    else pending.resolve({ output: String(message.output ?? ""), sessionId: message.sessionId });
  }

  async stop() {
    this.child?.kill();
  }
}

\n