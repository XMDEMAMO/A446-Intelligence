import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCodexAccount,
  normalizeCodexModels,
  normalizeCodexRateLimits,
  normalizeAntigravityUsage,
  parseAntigravityModels,
} from "../scripts/provider-probe.mjs";

test("Codex provider probe normalizes account, models, reasoning efforts, and quota windows", () => {
  const account = normalizeCodexAccount({ account: { type: "chatgpt", email: "user@example.com", planType: "plus" } });
  assert.equal(account.provider, "openai");
  assert.equal(account.plan, "plus");
  assert.equal(account.label, "user@example.com");
  assert.notEqual(account.id, account.label);

  const models = normalizeCodexModels({ data: [{ id: "model-a", displayName: "Model A", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }] });
  assert.deepEqual(models[0].reasoningEfforts, ["low", "high"]);

  const quota = normalizeCodexRateLimits({ rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 92, resetsAt: 2_000_000_000, windowDurationMins: 300 }, secondary: { usedPercent: 25, resetsAt: 2_000_100_000, windowDurationMins: 10_080 } } } }, "2026-09-19T00:00:00.000Z");
  assert.equal(quota.state, "Low");
  assert.equal(quota.windows[0].remainingPercent, 8);
  assert.equal(quota.windows[0].windowType, "5h");
  assert.equal(quota.windows[0].durationMinutes, 300);
  assert.equal(quota.windows[1].windowType, "7d");
  assert.equal(quota.windows[0].resetsAt, "2033-05-18T03:33:20.000Z");
});

test("Antigravity provider probe ignores progress text and returns callable models", () => {
  const models = parseAntigravityModels("Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n");
  assert.deepEqual(models.map((model) => model.id), ["gemini-3.8-flash-high", "claude-sonnet-4-6"]);
  assert.deepEqual(models[0].reasoningEfforts, ["high"]);
  assert.deepEqual(models[1].reasoningEfforts, []);
  assert.equal(models[0].family, "gemini");
  assert.equal(models[0].quotaGroup, "Gemini Models");
  assert.equal(models[1].quotaGroup, "Claude and GPT models");
});

test("Antigravity provider probe normalizes official read-only usage groups", () => {
  const quota = normalizeAntigravityUsage({ command: { data: { groups: [
    { name: "Gemini Models", buckets: [
      { id: "gemini-5h", window: "5h", remaining_fraction: 0.09, reset_time: "2026-09-20T00:00:00Z" },
      { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.75, reset_time: "2026-09-25T00:00:00Z" },
    ] },
    { name: "Claude and GPT models", buckets: [
      { id: "3p-5h", window: "5h", remaining_fraction: 1, reset_time: "2026-09-20T00:00:00Z" },
      { id: "3p-weekly", window: "weekly", remaining_fraction: 0.5, reset_time: "2026-09-25T00:00:00Z" },
    ] },
  ] } } }, "2026-09-19T00:00:00.000Z");
  assert.equal(quota.state, "Low");
  assert.equal(quota.source, "antigravity-cli-usage");
  assert.equal(quota.windows[0].remainingPercent, 9);
  assert.equal(quota.windows[0].usedPercent, 91);
  assert.equal(quota.windows[0].resetsAt, "2026-09-20T00:00:00.000Z");
  assert.equal(quota.windows[0].quotaGroup, "Gemini Models");
  assert.equal(quota.windows[0].durationMinutes, 300);
  assert.equal(quota.windows[1].windowType, "7d");
  assert.equal(quota.windows[2].quotaGroup, "Claude and GPT models");
});
