import path from "node:path";
import { access, realpath } from "node:fs/promises";

const NEVER_ALLOWED = new Set([
  "account_switch",
  "switch_account",
  "credential_access",
  "credentials",
  "browser_profile",
  "cookie_access",
  "verification_code_bypass",
  "bypass_platform_limits",
]);

export class PolicyDeniedError extends Error {
  constructor(reasons) {
    super(`Local policy denied the task: ${reasons.join("; ")}`);
    this.name = "PolicyDeniedError";
    this.code = "POLICY_DENIED";
    this.reasons = reasons;
  }
}

export function normalizePolicy(config = {}, workspace) {
  const workspaceRoot = path.resolve(workspace);
  const roots = Array.isArray(config.allowedRoots) && config.allowedRoots.length > 0
    ? config.allowedRoots.map((item) => path.resolve(item))
    : [workspaceRoot];
  return {
    requireTaskSpec: Boolean(config.requireTaskSpec),
    defaultDenyUnknownPermissions: config.defaultDenyUnknownPermissions !== false,
    allowedPermissions: new Set((config.allowedPermissions ?? ["project_workspace"]).map(normalizeName)),
    deniedPermissions: new Set((config.deniedPermissions ?? []).map(normalizeName)),
    allowedRoots: [...new Set(roots)],
    workspaceRoot,
  };
}

export async function evaluateTaskPolicy(message, policy) {
  const taskSpec = message.payload?.taskSpec ?? message.payload?.metadata?.taskSpec ?? null;
  const reasons = [];
  if (policy.requireTaskSpec && !taskSpec) reasons.push("taskSpec is required");
  if (taskSpec !== null) reasons.push(...validateTaskSpecShape(taskSpec));

  const permissions = taskSpec?.permissionsRequired ?? taskSpec?.permissions_required ?? {};
  for (const [rawName, requested] of Object.entries(permissions)) {
    if (!isRequested(requested)) continue;
    const name = normalizeName(rawName);
    if (NEVER_ALLOWED.has(name)) reasons.push(`permission ${rawName} is never allowed`);
    else if (policy.deniedPermissions.has(name)) reasons.push(`permission ${rawName} is denied by this Worker`);
    else if (policy.defaultDenyUnknownPermissions && !policy.allowedPermissions.has(name)) {
      reasons.push(`permission ${rawName} is not in the local allowlist`);
    }
  }

  const referencedPaths = extractTaskPaths(taskSpec);
  for (const item of referencedPaths) {
    if (isRemoteReference(item.value)) {
      if (item.kind === "output") reasons.push(`output path ${item.value}: remote artifacts are not collected by the local Worker`);
      continue;
    }
    try {
      await resolveAllowedPath(item.value, policy, { mayNotExist: item.kind === "output" });
    } catch (error) {
      reasons.push(`${item.kind} path ${item.value}: ${error.message}`);
    }
  }

  if (reasons.length > 0) throw new PolicyDeniedError(reasons);
  return {
    allowed: true,
    taskSpecPresent: Boolean(taskSpec),
    checkedPermissions: Object.keys(permissions),
    checkedPaths: referencedPaths.map((item) => item.value),
  };
}

export async function resolveAllowedPath(value, policy, { mayNotExist = false } = {}) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("path must be a non-empty string");
  const candidate = path.resolve(policy.workspaceRoot, value);
  if (!isInsideAny(candidate, policy.allowedRoots)) throw new Error("outside allowed roots");

  try {
    const canonical = await realpath(candidate);
    const canonicalRoots = await Promise.all(policy.allowedRoots.map(canonicalizeExisting));
    if (!isInsideAny(canonical, canonicalRoots)) throw new Error("symlink resolves outside allowed roots");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!mayNotExist) throw new Error("does not exist");
    const parent = await nearestExistingParent(path.dirname(candidate));
    const canonicalParent = await realpath(parent);
    const canonicalRoots = await Promise.all(policy.allowedRoots.map(canonicalizeExisting));
    if (!isInsideAny(canonicalParent, canonicalRoots)) throw new Error("parent resolves outside allowed roots");
  }
  return candidate;
}

export function extractTaskPaths(taskSpec) {
  if (!taskSpec || typeof taskSpec !== "object") return [];
  return [
    ...extractPathList(taskSpec.inputs, "input"),
    ...extractPathList(taskSpec.expectedOutputs ?? taskSpec.expected_outputs, "output"),
    ...extractPathList(taskSpec.artifacts, "output"),
  ];
}

export function extractArtifactPaths(taskSpec) {
  return extractTaskPaths(taskSpec).filter((item) => item.kind === "output").map((item) => item.value);
}

function validateTaskSpecShape(taskSpec) {
  if (!taskSpec || typeof taskSpec !== "object" || Array.isArray(taskSpec)) return ["taskSpec must be an object"];
  const reasons = [];
  for (const key of ["inputs", "expectedOutputs", "expected_outputs", "artifacts"]) {
    if (taskSpec[key] === undefined) continue;
    if (!Array.isArray(taskSpec[key])) {
      reasons.push(`taskSpec.${key} must be an array`);
      continue;
    }
    taskSpec[key].forEach((item, index) => {
      const valid = typeof item === "string" && item.trim() !== ""
        || item && typeof item === "object" && typeof item.path === "string" && item.path.trim() !== "";
      if (!valid) reasons.push(`taskSpec.${key}[${index}] must be a path string or an object with path`);
    });
  }
  for (const key of ["permissionsRequired", "permissions_required"]) {
    if (taskSpec[key] !== undefined && (!taskSpec[key] || typeof taskSpec[key] !== "object" || Array.isArray(taskSpec[key]))) {
      reasons.push(`taskSpec.${key} must be an object`);
    }
  }
  return reasons;
}

function extractPathList(value, kind) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (typeof item === "string") result.push({ kind, value: item });
    else if (item && typeof item.path === "string") result.push({ kind, value: item.path });
  }
  return result;
}

function isRequested(value) {
  return value === true || value === "allow" || value === "required" || value === 1;
}

function normalizeName(value) {
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isRemoteReference(value) {
  return /^(https?|s3|gs):\/\//i.test(value);
}

function isInsideAny(candidate, roots) {
  return roots.some((root) => isInside(candidate, root));
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalizeExisting(value) {
  try {
    return await realpath(value);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.resolve(value);
  }
}

async function nearestExistingParent(start) {
  let current = path.resolve(start);
  while (true) {
    try {
      await access(current);
      return current;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

\n