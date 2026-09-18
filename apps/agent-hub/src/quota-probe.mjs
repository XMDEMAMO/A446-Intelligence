import { spawn } from "node:child_process";
import { normalizeQuotaSnapshot } from "./collaboration.mjs";

export async function probeQuota(spec, context = {}) {
  if (!spec?.command) return null;
  const parsed = await probeJson(spec, context);
  const checkedAt = parsed.checkedAt ?? new Date().toISOString();
  return normalizeQuotaSnapshot({
    ...parsed,
    checkedAt,
    lastSuccessAt: parsed.lastSuccessAt ?? checkedAt,
    source: parsed.source ?? spec.source ?? "client-probe",
    stale: false,
    errorSummary: null,
  });
}

export async function probeJson(spec, context = {}) {
  if (!spec?.command) return null;
  const stdout = await runProbe(spec.command, Array.isArray(spec.args) ? spec.args : [], {
    cwd: context.workspace,
    timeoutMs: Number(spec.timeoutMs ?? 10_000),
    stripProxyEnv: Boolean(spec.stripProxyEnv),
    maxOutputChars: Number(spec.maxOutputChars ?? 100_000),
  });
  return parseProbeOutput(stdout);
}

function runProbe(command, args, options) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    if (options.stripProxyEnv) {
      for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete environment[name];
    }
    const child = spawn(String(command), args.map(String), {
      cwd: options.cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-options.maxOutputChars); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-options.maxOutputChars); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`quota probe exited with code ${code}: ${stderr.trim() || "no stderr"}`));
    });
  });
}

export function parseProbeOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) throw new Error("probe returned no output");
  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {}
  }
  throw new Error("probe output must contain a JSON object");
}
