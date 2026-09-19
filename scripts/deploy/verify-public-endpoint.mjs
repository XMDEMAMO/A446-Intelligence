#!/usr/bin/env node

const args = new Set(process.argv.slice(2));
const rawOrigin = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
if (!rawOrigin) {
  console.error("Usage: node verify-public-endpoint.mjs <https-origin> [--allow-loopback-http]");
  process.exit(2);
}

const origin = new URL(rawOrigin);
origin.pathname = "/";
origin.search = "";
origin.hash = "";
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]).has(origin.hostname);
if (origin.protocol !== "https:" && !(args.has("--allow-loopback-http") && loopback && origin.protocol === "http:")) {
  throw new Error("Public verification requires HTTPS; HTTP is permitted only for an explicitly allowed loopback check");
}

const results = [];
const health = await request("api health", new URL("/api/health", origin), [200]);
const healthBody = await health.response.json();
assert(healthBody.ok === true, "health response did not report ok=true");

await request("unauthenticated API boundary", new URL("/api/v1/tasks", origin), [401]);
await request("Worker route boundary", new URL("/worker", origin), [400, 401, 426]);

const index = await request("Web entrypoint", origin, [200]);
requireHeader(index.response, "content-security-policy", (value) => value.includes("frame-ancestors 'none'"));
requireHeader(index.response, "x-content-type-options", (value) => value.toLowerCase() === "nosniff");
requireHeader(index.response, "x-frame-options", (value) => value.toUpperCase() === "DENY");
requireHeader(index.response, "referrer-policy", (value) => value.length > 0);
requireHeader(index.response, "cache-control", (value) => value.includes("no-store"));

const html = await index.response.text();
const assetMatch = html.match(/(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/i);
if (assetMatch) {
  const asset = await request("fingerprinted static asset", new URL(assetMatch[1], origin), [200]);
  requireHeader(asset.response, "cache-control", (value) => value.includes("immutable") && value.includes("max-age=31536000"));
} else {
  results.push({ check: "fingerprinted static asset", status: "WARN", detail: "index.html did not reference /assets/" });
}

if (origin.protocol === "https:" && !index.response.headers.get("strict-transport-security")) {
  results.push({ check: "HSTS", status: "WARN", detail: "not enabled; enable only after the production domain is stable" });
}

for (const result of results) console.log(`${result.status.padEnd(4)} ${result.check}: ${result.detail}`);
if (results.some((result) => result.status === "FAIL")) process.exit(1);
console.log("Public deployment verification passed.");

async function request(check, url, expectedStatuses) {
  let response;
  try {
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    results.push({ check, status: "FAIL", detail: error.message });
    throw error;
  }
  const ok = expectedStatuses.includes(response.status);
  results.push({ check, status: ok ? "PASS" : "FAIL", detail: `${response.status} ${url}` });
  assert(ok, `${check} returned ${response.status}; expected ${expectedStatuses.join(" or ")}`);
  return { response };
}

function requireHeader(response, name, predicate) {
  const value = response.headers.get(name) ?? "";
  const ok = predicate(value);
  results.push({ check: `header ${name}`, status: ok ? "PASS" : "FAIL", detail: value || "missing" });
  assert(ok, `required response header ${name} is missing or invalid`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
