import fs from "node:fs/promises";
import path from "node:path";
import { UpdaterError, sleep } from "./util.mjs";

/**
 * Health verification. Never relies on a fixed long sleep: polls the Hub
 * control plane until every expected condition holds or the deadline passes.
 * Token is read at runtime from the shared pairing-token file and used only
 * in the Authorization header (never logged).
 */
export async function fetchJson(url, { token, timeoutMs = 5_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "a446-updater",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) return { ok: false, status: response.status };
    const body = await response.json().catch(() => null);
    return { ok: true, status: response.status, body };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function readPairingToken(sharedVarDir) {
  try {
    const token = (await fs.readFile(path.join(sharedVarDir, "pairing-token.txt"), "utf8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

export async function expectedAgentCount(sharedVarDir, deviceId) {
  try {
    const entries = await fs.readdir(path.join(sharedVarDir, "config"));
    const workerConfigs = entries.filter((entry) => entry.startsWith("worker.") && entry.endsWith(".json"));
    const matching = [];
    for (const entry of workerConfigs) {
      try {
        const config = JSON.parse(await fs.readFile(path.join(sharedVarDir, "config", entry), "utf8"));
        if (!deviceId || config.deviceId === deviceId) matching.push(entry);
      } catch {
        // unreadable config: ignore for counting purposes
      }
    }
    return Math.max(1, matching.length);
  } catch {
    return 1;
  }
}

export function createHealthChecker({ hubBaseUrl, sharedVarDir, deviceId, role, expectedOnlineAgents, timeoutMs, pollIntervalMs = 1000, logger = () => {} }) {
  const base = String(hubBaseUrl).replace(/\/+$/, "");
  async function verifyOnce() {
    const health = await fetchJson(`${base}/health`);
    if (!health.ok || health.body?.ok !== true) {
      return { ok: false, reason: `Hub /health is not ready (status ${health.status})` };
    }
    const token = await readPairingToken(sharedVarDir);
    const agents = await fetchJson(`${base}/v1/agents`, { token });
    if (!agents.ok || !Array.isArray(agents.body?.agents)) {
      return { ok: false, reason: "Hub /v1/agents is not reachable yet" };
    }
    const onlineForDevice = agents.body.agents.filter((agent) => agent.deviceId === deviceId && agent.status === "online");
    if (onlineForDevice.length < expectedOnlineAgents) {
      return {
        ok: false,
        reason: `Agents online for device '${deviceId}': ${onlineForDevice.length}/${expectedOnlineAgents}`,
      };
    }
    return { ok: true, onlineAgents: onlineForDevice.length };
  }
  return {
    async verify() {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await verifyOnce();
        if (last.ok) {
          logger(`health check passed: ${last.onlineAgents} agent(s) online`);
          return last;
        }
        await sleep(pollIntervalMs);
      }
      throw new UpdaterError(
        `Health verification failed: ${last?.reason ?? "timed out"}`,
        { code: "HEALTH_CHECK_FAILED", exitCode: 13 },
      );
    },
    verifyOnce,
  };
}
