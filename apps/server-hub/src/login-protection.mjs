import { createHash } from "node:crypto";

const DEFAULTS = Object.freeze({
  enabled: true,
  windowMs: 15 * 60 * 1000,
  auditRetentionMs: 30 * 24 * 60 * 60 * 1000,
  throttleRetentionMs: 24 * 60 * 60 * 1000,
  username: Object.freeze({ maxFailures: 8, baseDelayMs: 500, maxDelayMs: 5 * 60 * 1000 }),
  ip: Object.freeze({ maxFailures: 20, baseDelayMs: 250, maxDelayMs: 30 * 1000 }),
});

export function normalizeLoginProtection(input = {}) {
  return {
    enabled: input.enabled !== false,
    windowMs: boundedInteger(input.windowMs, DEFAULTS.windowMs, 1_000, 24 * 60 * 60 * 1000),
    auditRetentionMs: boundedInteger(input.auditRetentionMs, DEFAULTS.auditRetentionMs, 60_000, 365 * 24 * 60 * 60 * 1000),
    throttleRetentionMs: boundedInteger(input.throttleRetentionMs, DEFAULTS.throttleRetentionMs, 60_000, 30 * 24 * 60 * 60 * 1000),
    username: normalizeScope(input.username, DEFAULTS.username),
    ip: normalizeScope(input.ip, DEFAULTS.ip),
  };
}

export function loginScopeHash(scopeType, value) {
  return createHash("sha256").update(`${scopeType}\0${String(value)}`, "utf8").digest("hex");
}

export function retryAfterMs(record, nowMs = Date.now()) {
  const blockedUntilMs = timestamp(record?.blocked_until ?? record?.blockedUntil);
  return blockedUntilMs > nowMs ? Math.max(1, Math.ceil(blockedUntilMs - nowMs)) : 0;
}

export function nextThrottleState(record, nowMs, policy, windowMs) {
  const windowStartedMs = timestamp(record?.window_started_at ?? record?.windowStartedAt);
  const insideWindow = Number.isFinite(windowStartedMs) && nowMs - windowStartedMs < windowMs;
  const failureCount = insideWindow ? Math.max(0, Number(record?.failure_count ?? record?.failureCount ?? 0)) + 1 : 1;
  const exponent = Math.min(Math.max(0, failureCount - 1), 20);
  const exponentialDelay = policy.baseDelayMs * (2 ** exponent);
  const delayMs = Math.min(policy.maxDelayMs, failureCount >= policy.maxFailures ? policy.maxDelayMs : exponentialDelay);
  return {
    failureCount,
    windowStartedAt: new Date(insideWindow ? windowStartedMs : nowMs).toISOString(),
    lastFailedAt: new Date(nowMs).toISOString(),
    blockedUntil: new Date(nowMs + delayMs).toISOString(),
    delayMs,
  };
}

function normalizeScope(input = {}, defaults) {
  const maxDelayMs = boundedInteger(input.maxDelayMs, defaults.maxDelayMs, 100, 60 * 60 * 1000);
  return {
    maxFailures: boundedInteger(input.maxFailures, defaults.maxFailures, 1, 10_000),
    baseDelayMs: boundedInteger(input.baseDelayMs, defaults.baseDelayMs, 50, maxDelayMs),
    maxDelayMs,
  };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function timestamp(value) {
  if (!value) return Number.NaN;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
