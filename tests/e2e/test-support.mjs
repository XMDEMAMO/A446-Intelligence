import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, "..", "..");
const webRoot = path.join(projectRoot, "apps", "web", "dist");

export async function launchBrowser() {
  const executablePath = await resolveBrowserExecutable();
  return chromium.launch({ executablePath, headless: true });
}

export async function startFixtureServer() {
  await access(path.join(webRoot, "index.html"));
  const state = fixtureState();
  const server = createServer((request, response) => {
    void handleRequest(request, response, state).catch((error) => {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a TCP port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function resolveBrowserExecutable() {
  const configured = process.env.A446_E2E_BROWSER;
  const candidates = configured ? [configured] : process.platform === "win32" ? [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ] : process.platform === "darwin" ? [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ] : [
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next supported local browser.
    }
  }
  throw new Error(`Browser E2E requires Edge, Chrome, or Chromium. Set A446_E2E_BROWSER to an executable path. Checked: ${candidates.join(", ")}`);
}

async function handleRequest(request, response, state) {
  const url = new URL(request.url ?? "/", "http://fixture.local");
  if (!url.pathname.startsWith("/api/")) {
    await serveWebAsset(url.pathname, response);
    return;
  }
  const pathname = url.pathname.slice(4) || "/";
  if (pathname === "/health") {
    sendJson(response, 200, { ok: true, protocolVersion: 1, now: new Date().toISOString() });
    return;
  }
  const body = await readJsonBody(request);
  if (pathname === "/v1/auth/login" && request.method === "POST") {
    const role = body.username === "fixture-admin" && body.password === "fixture-admin-password"
      ? "admin"
      : body.username === "fixture-operator" && body.password === "fixture-operator-password"
        ? "operator"
        : null;
    if (!role) {
      sendJson(response, 401, { error: "AUTH_INVALID_CREDENTIALS", code: "AUTH_INVALID_CREDENTIALS" });
      return;
    }
    const sessionId = `${role}-session`;
    state.sessions.set(sessionId, role);
    response.setHeader("set-cookie", `a446_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/`);
    sendJson(response, 200, { user: actorFor(role), csrfToken: `${role}-csrf` });
    return;
  }
  const actor = authenticate(request, state);
  if (!actor) {
    sendJson(response, 401, { error: "AUTH_REQUIRED", code: "AUTH_REQUIRED" });
    return;
  }
  if (!["GET", "HEAD"].includes(request.method ?? "GET") && request.headers["x-csrf-token"] !== `${actor.role}-csrf`) {
    sendJson(response, 403, { error: "CSRF_INVALID", code: "CSRF_INVALID" });
    return;
  }
  if (pathname === "/v1/auth/me" && request.method === "GET") {
    sendJson(response, 200, { user: actor });
  } else if (pathname === "/v1/auth/logout" && request.method === "POST") {
    state.sessions.delete(cookieValue(request, "a446_session"));
    response.setHeader("set-cookie", "a446_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/");
    sendJson(response, 200, { ok: true });
  } else if (pathname === "/v1/agents" && request.method === "GET") {
    sendJson(response, 200, { agents: state.agents });
  } else if (pathname === "/v1/tasks" && request.method === "GET") {
    sendJson(response, 200, { tasks: state.tasks });
  } else if (pathname === "/v1/conversations" && request.method === "GET") {
    sendJson(response, 200, { conversations: state.conversations });
  } else if (pathname === "/v1/messages" && request.method === "GET") {
    sendJson(response, 200, { messages: state.messages });
  } else if (pathname === "/v1/interventions" && request.method === "GET") {
    sendJson(response, 200, { interventions: state.interventions.filter((item) => item.status === "pending") });
  } else if (pathname === "/v1/usage" && request.method === "GET") {
    sendJson(response, 200, state.usage);
  } else if (pathname === "/v1/events" && request.method === "GET") {
    sendJson(response, 200, { events: state.events });
  } else if (pathname === "/v1/workflows" && request.method === "POST") {
    createWorkflow(response, state, body, actor);
  } else if (pathname === "/v1/commands" && request.method === "POST") {
    applyCommand(response, state, body, actor);
  } else if (/^\/v1\/interventions\/[^/]+\/resolve$/.test(pathname) && request.method === "POST") {
    resolveIntervention(response, state, pathname.split("/")[3], body, actor);
  } else if (pathname === "/v1/admin/workers" && request.method === "GET") {
    requireAdmin(response, actor, () => sendJson(response, 200, { workers: state.credentials.map(publicCredential) }));
  } else if (pathname === "/v1/admin/workers" && request.method === "POST") {
    requireAdmin(response, actor, () => createCredential(response, state, body));
  } else if (/^\/v1\/admin\/workers\/[^/]+\/rotate$/.test(pathname) && request.method === "POST") {
    requireAdmin(response, actor, () => rotateCredential(response, state, pathname.split("/")[4]));
  } else if (/^\/v1\/admin\/workers\/[^/]+$/.test(pathname) && request.method === "DELETE") {
    requireAdmin(response, actor, () => revokeCredential(response, state, pathname.split("/")[4]));
  } else {
    sendJson(response, 404, { error: `No fixture route for ${request.method} ${pathname}` });
  }
}

function createWorkflow(response, state, body, actor) {
  const requested = body.executorAgentId ?? null;
  if (requested) {
    const agent = state.agents.find((item) => item.agentId === requested);
    if (!agent || agent.status !== "online" || agent.paused || !agent.roles.includes("executor")) {
      sendJson(response, 409, { error: "The selected Executor is unavailable.", code: "EXECUTOR_UNAVAILABLE", details: { agentId: requested } });
      return;
    }
  }
  const sequence = state.tasks.length + 1;
  const rootTaskId = `fixture-root-${sequence}`;
  const task = {
    taskId: rootTaskId,
    rootTaskId,
    targetAgentId: body.plannerAgentId || "fixture-planner",
    requestedAgentId: requested,
    executorAgentId: requested,
    sourceAgentId: actor.username,
    input: body.objective,
    role: "planner",
    stage: "planning",
    status: "queued",
    taskSpec: { title: body.title, acceptance: body.acceptance ?? [] },
    createdAt: new Date().toISOString(),
  };
  state.tasks.push(task);
  state.conversations.push({
    rootTaskId,
    title: body.title,
    status: "active",
    createdAt: task.createdAt,
    updatedAt: task.createdAt,
    participants: [actor.username, task.targetAgentId],
    taskCount: 1,
    messageCount: 1,
  });
  state.lastWorkflowBody = body;
  state.events.push({ seq: state.events.length + 1, ts: task.createdAt, type: "workflow.created", details: { rootTaskId, actor: actor.username } });
  sendJson(response, 201, { task });
}

function applyCommand(response, state, body, actor) {
  if (body.type !== "task.cancel") {
    sendJson(response, 400, { error: "Unsupported fixture command" });
    return;
  }
  if (actor.role !== "admin") {
    sendJson(response, 403, { error: "ADMIN_REQUIRED", code: "ADMIN_REQUIRED" });
    return;
  }
  const task = state.tasks.find((item) => item.taskId === body.taskId);
  if (!task) {
    sendJson(response, 404, { error: "TASK_NOT_FOUND", code: "TASK_NOT_FOUND" });
    return;
  }
  task.status = "cancelled";
  state.events.push({ seq: state.events.length + 1, ts: new Date().toISOString(), type: "task.cancelled", details: { taskId: task.taskId, actor: actor.username } });
  sendJson(response, 200, { ok: true, task });
}

function resolveIntervention(response, state, interventionId, body, actor) {
  const intervention = state.interventions.find((item) => item.interventionId === interventionId);
  if (!intervention) {
    sendJson(response, 404, { error: "INTERVENTION_NOT_FOUND" });
    return;
  }
  if (intervention.status !== "pending") {
    sendJson(response, 409, { error: "INTERVENTION_ALREADY_RESOLVED" });
    return;
  }
  if (["approve", "reject"].includes(body.decision) && actor.role !== "admin") {
    sendJson(response, 403, { error: "ADMIN_REQUIRED", code: "ADMIN_REQUIRED" });
    return;
  }
  intervention.status = "resolved";
  intervention.decision = body.decision;
  intervention.response = body.response ?? "";
  intervention.resolvedBy = actor.username;
  intervention.resolvedAt = new Date().toISOString();
  sendJson(response, 200, { ok: true, intervention });
}

function createCredential(response, state, body) {
  if (state.credentials.some((item) => item.agentId === body.agentId && item.status === "active")) {
    sendJson(response, 409, { error: "ACTIVE_CREDENTIAL_EXISTS", code: "ACTIVE_CREDENTIAL_EXISTS" });
    return;
  }
  const credentialId = `fixture-credential-${state.credentials.length + 1}`;
  const token = `fixture_token_${state.nextToken++}`;
  const credential = { credentialId, agentId: body.agentId, deviceId: body.deviceId, status: "active", tokenHash: `hash-${token}` };
  state.credentials.push(credential);
  sendJson(response, 201, { credential: publicCredential(credential), token });
}

function rotateCredential(response, state, credentialId) {
  const current = state.credentials.find((item) => item.credentialId === credentialId);
  if (!current || current.status !== "active") {
    sendJson(response, 404, { error: "CREDENTIAL_NOT_FOUND" });
    return;
  }
  current.status = "revoked";
  const token = `fixture_token_${state.nextToken++}`;
  const replacement = { ...current, credentialId: `${credentialId}-rotated`, status: "active", tokenHash: `hash-${token}` };
  state.credentials.push(replacement);
  sendJson(response, 200, { credential: publicCredential(replacement), token });
}

function revokeCredential(response, state, credentialId) {
  const credential = state.credentials.find((item) => item.credentialId === credentialId);
  if (!credential) {
    sendJson(response, 404, { error: "CREDENTIAL_NOT_FOUND" });
    return;
  }
  credential.status = "revoked";
  sendJson(response, 200, { ok: true, credential: publicCredential(credential) });
}

function requireAdmin(response, actor, operation) {
  if (actor.role !== "admin") {
    sendJson(response, 403, { error: "ADMIN_REQUIRED", code: "ADMIN_REQUIRED" });
    return;
  }
  operation();
}

function publicCredential(credential) {
  return {
    credentialId: credential.credentialId,
    agentId: credential.agentId,
    deviceId: credential.deviceId,
    status: credential.status,
  };
}

function authenticate(request, state) {
  const role = state.sessions.get(cookieValue(request, "a446_session"));
  return role ? actorFor(role) : null;
}

function actorFor(role) {
  return { id: `fixture-${role}-id`, username: `fixture-${role}`, role };
}

function cookieValue(request, name) {
  const item = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return item?.slice(name.length + 1) ?? "";
}

async function readJsonBody(request) {
  if (!["POST", "PUT", "PATCH"].includes(request.method ?? "GET")) return {};
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveWebAsset(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(webRoot, requested);
  if (resolved !== webRoot && !resolved.startsWith(`${webRoot}${path.sep}`)) {
    sendJson(response, 400, { error: "Invalid asset path" });
    return;
  }
  let filePath = resolved;
  try {
    await access(filePath);
  } catch {
    filePath = path.join(webRoot, "index.html");
  }
  const extension = path.extname(filePath);
  const contentType = extension === ".html" ? "text/html; charset=utf-8"
    : extension === ".js" ? "text/javascript; charset=utf-8"
      : extension === ".css" ? "text/css; charset=utf-8"
        : extension === ".svg" ? "image/svg+xml"
          : "application/octet-stream";
  response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  response.end(await readFile(filePath));
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function fixtureState() {
  const now = new Date().toISOString();
  const zeroUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, toolTokens: 0, totalTokens: 0 };
  const quota = { state: "Unknown", checkedAt: now, source: "unavailable", windows: [] };
  const agents = [
    fixtureAgent("fixture-planner", "planner", "online", now, quota, zeroUsage),
    fixtureAgent("fixture-executor", "executor", "online", now, quota, zeroUsage),
    fixtureAgent("fixture-reviewer", "reviewer", "online", now, quota, zeroUsage),
    fixtureAgent("fixture-executor-offline", "executor", "offline", now, quota, zeroUsage),
  ];
  const rootTaskId = "fixture-root-1";
  return {
    sessions: new Map(),
    nextToken: 1,
    lastWorkflowBody: null,
    agents,
    tasks: [{
      taskId: "fixture-task-1",
      rootTaskId,
      targetAgentId: "fixture-executor",
      sourceAgentId: "fixture-planner",
      input: "produce fixture result",
      role: "executor",
      stage: "execution",
      status: "completed",
      taskSpec: { title: "Fixture release acceptance", acceptance: ["result is reviewed"] },
      model: "fixture-model",
      usage: { ...zeroUsage, inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      createdAt: now,
    }],
    conversations: [{
      rootTaskId,
      title: "Fixture release acceptance",
      status: "needs_human",
      createdAt: now,
      updatedAt: now,
      participants: ["fixture-planner", "fixture-executor", "fixture-reviewer"],
      taskCount: 1,
      messageCount: 1,
    }],
    messages: [{
      messageId: "fixture-message-1",
      seq: 1,
      rootTaskId,
      taskId: "fixture-task-1",
      senderId: "fixture-executor",
      senderRole: "executor",
      kind: "task_brief",
      text: "Fixture result is ready",
      mentions: ["@fixture-reviewer"],
      attachments: [{ type: "full_result", label: "完整成果", taskId: "fixture-task-1", version: "v1", content: "fixture full result", artifacts: { files: [], missing: [] } }],
      createdAt: now,
    }],
    interventions: [{
      interventionId: "fixture-intervention-1",
      rootTaskId,
      taskId: "fixture-task-1",
      kind: "task_approval",
      status: "pending",
      question: "Approve the fixture release result?",
      requesterRole: "reviewer",
      requesterStage: "result_review",
      allowedActions: ["approve", "reject"],
      requestedAt: now,
    }],
    credentials: [{ credentialId: "fixture-credential-1", agentId: "fixture-executor", deviceId: "fixture-device", status: "active", tokenHash: "fixture-hash" }],
    usage: { totals: { ...zeroUsage, inputTokens: 8, outputTokens: 2, totalTokens: 10 }, byAgent: [] },
    events: [],
  };
}

function fixtureAgent(agentId, role, status, now, quota, usageTotals) {
  return {
    agentId,
    deviceId: `${agentId}-device`,
    account: { id: `${agentId}-account`, provider: "fixture", plan: "test", label: `${agentId} account` },
    roles: [role],
    models: [{ id: `${role}-model`, enabled: true, capabilities: [role], quota }],
    status,
    paused: false,
    busy: false,
    usageTotals,
    quotaSnapshot: quota,
    resourceSnapshot: { schemaVersion: 1, state: status === "online" ? "available" : "stale", checkedAt: now, stale: status !== "online", models: { state: "available", source: "fixture", checkedAt: now, items: [] } },
  };
}
