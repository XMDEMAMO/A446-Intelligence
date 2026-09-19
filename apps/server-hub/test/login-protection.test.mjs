import test from "node:test";
import assert from "node:assert/strict";
import {
  loginScopeHash,
  nextThrottleState,
  normalizeLoginProtection,
  retryAfterMs,
} from "../src/login-protection.mjs";

test("login protection applies recoverable exponential backoff and caps it", () => {
  const config = normalizeLoginProtection({
    windowMs: 60_000,
    username: { maxFailures: 3, baseDelayMs: 100, maxDelayMs: 2_000 },
  });
  const started = Date.parse("2026-09-18T00:00:00.000Z");
  const first = nextThrottleState(null, started, config.username, config.windowMs);
  const second = nextThrottleState({
    failure_count: first.failureCount,
    window_started_at: first.windowStartedAt,
  }, started + 1_000, config.username, config.windowMs);
  const third = nextThrottleState({
    failure_count: second.failureCount,
    window_started_at: second.windowStartedAt,
  }, started + 2_000, config.username, config.windowMs);

  assert.equal(first.delayMs, 100);
  assert.equal(second.delayMs, 200);
  assert.equal(third.delayMs, 2_000);
  assert.equal(retryAfterMs({ blocked_until: third.blockedUntil }, started + 2_500), 1_500);
  assert.equal(retryAfterMs({ blocked_until: third.blockedUntil }, started + 4_001), 0);
});

test("login protection resets the failure counter after the configured window", () => {
  const config = normalizeLoginProtection({ windowMs: 1_000 });
  const started = Date.parse("2026-09-18T00:00:00.000Z");
  const next = nextThrottleState({
    failure_count: 99,
    window_started_at: new Date(started).toISOString(),
  }, started + 1_001, config.username, config.windowMs);

  assert.equal(next.failureCount, 1);
  assert.equal(next.windowStartedAt, new Date(started + 1_001).toISOString());
});

test("login throttle keys are deterministic hashes without raw identity data", () => {
  const first = loginScopeHash("username", "operator-01");
  const second = loginScopeHash("username", "operator-01");
  const ip = loginScopeHash("ip", "192.0.2.10");

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, ip);
  assert.equal(first.includes("operator-01"), false);
});
