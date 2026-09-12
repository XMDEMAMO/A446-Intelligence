#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs, delay } from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const baseUrl = process.env.HUB_HTTP_URL ?? "http://127.0.0.1:8787";
const token = process.env.HUB_TOKEN;

if (!command) usage();

if (command === "agents") print(await request("GET", "/v1/agents"));
else if (command === "events") print(await request("GET", `/v1/events?limit=${encodeURIComponent(args.limit ?? 50)}`));
else if (command === "send") {
  if (!args.agent || typeof args.input !== "string") usage("send requires --agent and --input");
  const route = args.route ? String(args.route).split(",").map((item) => item.trim()).filter(Boolean) : [];
  const taskSpec = args["task-spec"] ? JSON.parse(await readFile(String(args["task-spec"]), "utf8")) : undefined;
  const response = await request("POST", "/v1/tasks", {
    targetAgentId: args.agent,
    input: args.input,
    route,
    taskSpec,
    requiresApproval: Boolean(args["requires-approval"]),
  });
  if (!args.wait) print(response);
  else print(await waitForRoot(response.task.rootTaskId, Number(args.timeout ?? 120000)));
} else if (["pause", "resume"].includes(command)) {
  if (!args.agent) usage(`${command} requires --agent`);
  print(await request("POST", "/v1/commands", { type: `agent.${command}`, targetAgentId: args.agent }));
} else if (command === "approve") {
  if (!args.task) usage("approve requires --task");
  print(await request("POST", "/v1/commands", { type: "task.approve", taskId: args.task, by: args.by ?? "human" }));
} else if (command === "cancel") {
  if (!args.task) usage("cancel requires --task");
  print(await request("POST", "/v1/commands", { type: "task.cancel", taskId: args.task }));
} else usage(`Unknown command ${command}`);

async function waitForRoot(rootTaskId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request("GET", `/v1/tasks?rootTaskId=${encodeURIComponent(rootTaskId)}`);
    if (!result.active && result.tasks.length > 0) return result;
    await delay(250);
  }
  throw new Error(`Timed out waiting for root task ${rootTaskId}`);
}

async function request(method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error ?? response.statusText}`);
  return result;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function usage(error) {
  if (error) console.error(error);
  console.error(`Usage:
  node src/hubctl.mjs agents
  node src/hubctl.mjs events [--limit 50]
  node src/hubctl.mjs send --agent agent-a --input "task" [--task-spec task.json] [--route agent-b] [--requires-approval] [--wait]
  node src/hubctl.mjs pause|resume --agent agent-a
  node src/hubctl.mjs approve|cancel --task TASK_ID`);
  process.exit(2);
}

\n