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
    return {
      output: `[${this.agentId} | ${context.sessionId}] ${String(input)}`,
      sessionId: context.sessionId,
    };
  }

  async stop() {}
}

\n