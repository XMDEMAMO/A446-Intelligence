import { randomUUID } from "node:crypto";
import { delay } from "../common.mjs";

export class MockAdapter {
  constructor(config, context) {
    this.config = config;
    this.agentId = context.agentId;
  }

  get type() {
    return "mock";
  }

  async start(state) {
    if (!state.sessionId) state.sessionId = `mock-${this.agentId}-${randomUUID()}`;
  }

  async run(input, context) {
    await delay(Number(this.config.delayMs ?? 50), context.signal);
    const sessionId = context.sessionId ?? `mock-${this.agentId}-${context.sessionKey ?? "legacy"}-${randomUUID()}`;
    const configured = this.config.roleOutputs?.[`${context.role}:${context.stage}`]
      ?? this.config.roleOutputs?.[context.role];
    const output = configured == null
      ? `[${this.agentId} | ${sessionId}] ${String(input)}`
      : typeof configured === "string" ? configured : JSON.stringify(configured);
    return {
      output,
      sessionId,
      usage: this.config.mockUsage ?? { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    };
  }

  async stop() {}
}
