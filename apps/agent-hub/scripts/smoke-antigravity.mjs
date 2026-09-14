#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AntigravityAdapter } from "../src/adapters/antigravity.mjs";
import { parseArgs } from "../src/common.mjs";

const args = parseArgs(process.argv.slice(2));
const workspace = path.resolve(args.workspace ?? "workspaces/antigravity-smoke");
await mkdir(workspace, { recursive: true });
const adapterArgs = [];
if (args.model) adapterArgs.push("--model", args.model);
const state = { sessionId: null };
const adapter = new AntigravityAdapter({
  command: args.command ?? "agy",
  args: adapterArgs,
  stripProxyEnv: Boolean(args["strip-proxy"]),
  resumeOnStart: true,
}, { agentId: "antigravity-smoke", workspace });

try {
  await adapter.start(state);
  const first = await adapter.run("Reply with exactly this token: HUB-CONTEXT-7319", {
    sessionId: state.sessionId,
    signal: new AbortController().signal,
  });
  state.sessionId = first.sessionId;
  const second = await adapter.run("What exact token did I ask you to reply with in the previous turn? Reply with only that token.", {
    sessionId: state.sessionId,
    signal: new AbortController().signal,
  });
  state.sessionId = second.sessionId;
  console.log(JSON.stringify({
    sessionId: state.sessionId,
    first: first.output.trim(),
    second: second.output.trim(),
    contextPreserved: second.output.trim() === "HUB-CONTEXT-7319",
  }, null, 2));
  if (second.output.trim() !== "HUB-CONTEXT-7319") process.exitCode = 1;
} finally {
  await adapter.stop();
}
