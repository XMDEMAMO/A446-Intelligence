import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { runPowerShell } from "../lib/util.mjs";

export const REPOSITORY = "XMDEMAMO/A446-Intelligence";

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Builds a fake A446 Multi-Device LAN package directory + zip.
 * The PACKAGE-MANIFEST.json carries per-file SHA-256 records exactly like the
 * real build script produces, so the updater's extracted-tree verification is
 * exercised end to end.
 */
export async function buildFakePackage({ version, files = {}, faults = [] }) {
  const rootName = `A446-MultiDevice-LAN-${version}`;
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "a446-fake-pkg-"));
  const root = path.join(staging, rootName);
  const defaults = {
    "apps/agent-hub/src/worker.mjs": `// fake worker ${version}\nexport const VERSION = "${version}";\n`,
    "apps/agent-hub/src/hub.mjs": `// fake hub ${version}\nexport const VERSION = "${version}";\n`,
    "apps/agent-hub/package.json": JSON.stringify({ name: "local-agent-hub", version, private: true, type: "module" }, null, 2),
    "scripts/start-lan-multidevice.ps1": `param([string]$Mode) Write-Output "fake start $Mode ${version}"`,
    "apps/agent-hub/scripts/check-env.mjs": "console.log('ok')",
    "MULTI-DEVICE-LAN-README.md": `# fake package ${version}`,
  };
  const merged = { ...defaults, ...files };
  for (const key of Object.keys(merged)) {
    if (merged[key] === null) delete merged[key];
  }
  const manifestFiles = [];
  for (const [relative, content] of Object.entries(merged)) {
    const target = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    const buffer = Buffer.from(content, "utf8");
    await fs.writeFile(target, buffer);
    manifestFiles.push({ path: relative, size: buffer.length, sha256: sha256(buffer) });
  }
  const packageManifest = {
    schemaVersion: 1,
    package: rootName,
    version,
    builtAt: new Date().toISOString(),
    files: manifestFiles,
  };
  await fs.writeFile(path.join(root, "PACKAGE-MANIFEST.json"), JSON.stringify(packageManifest, null, 2));

  const zipPath = path.join(staging, `${rootName}.zip`);
  const entries = [{ name: `${rootName}/PACKAGE-MANIFEST.json`, file: path.join(root, "PACKAGE-MANIFEST.json") }];
  for (const [relative] of Object.entries(merged)) {
    entries.push({ name: `${rootName}/${relative}`, file: path.join(root, ...relative.split("/")) });
  }
  if (faults.includes("zipslip-parent")) {
    entries.push({ name: "../evil.txt", content: Buffer.from("evil") });
  }
  if (faults.includes("zipslip-absolute")) {
    entries.push({ name: "C:/evil.txt", content: Buffer.from("evil") });
  }
  if (faults.includes("zipslip-backslash")) {
    entries.push({ name: "apps\\agent-hub\\evil.mjs", content: Buffer.from("evil") });
  }
  if (faults.includes("zipslip-colon")) {
    entries.push({ name: "evil:stream.txt", content: Buffer.from("evil") });
  }
  if (faults.includes("runtime-var")) {
    entries.push({ name: `${rootName}/apps/agent-hub/var/lan/hub-state.json`, content: Buffer.from("{}") });
  }
  await createZip(zipPath, entries);
  return { staging, root, zipPath, rootName, manifestFiles: packageManifest.files };
}

async function createZip(zipPath, entries) {
  const json = JSON.stringify(entries.map((entry) => ({
    name: entry.name,
    file: entry.file ?? null,
    contentB64: entry.content ? Buffer.from(entry.content).toString("base64") : null,
  })));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName 'System.IO.Compression'",
    "Add-Type -AssemblyName 'System.IO.Compression.FileSystem'",
    `$entries = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(json, "utf8").toString("base64")}')))`,
    `if (Test-Path ${ps(zipPath)}) { Remove-Item ${ps(zipPath)} -Force }`,
    `$zip = [System.IO.Compression.ZipFile]::Open(${ps(zipPath)}, 'Create')`,
    "try {",
    "  foreach ($e in $entries) {",
    "    $entry = $zip.CreateEntry($e.name)",
    "    $stream = $entry.Open()",
    "    if ($e.contentB64) {",
    "      $bytes = [Convert]::FromBase64String($e.contentB64)",
    "      $stream.Write($bytes, 0, $bytes.Length)",
    "    } elseif ($e.file) {",
    "      $bytes = [System.IO.File]::ReadAllBytes($e.file)",
    "      $stream.Write($bytes, 0, $bytes.Length)",
    "    }",
    "    $stream.Dispose()",
    "  }",
    "} finally { $zip.Dispose() }",
  ].join("\n");
  await runPowerShell(script, { timeoutMs: 120_000 });
}

function ps(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Local fake GitHub Releases server. Supports per-release faults:
 * badsha | corrupt | truncate | missing-file.
 */
export async function startFakeReleaseServer({ releases, failReleasesEndpoint = false }) {
  const state = { requests: [] };
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8");
  const server = http.createServer((request, response) => {
    state.requests.push({ url: request.url, at: Date.now() });
    const url = new URL(request.url, "http://localhost");
    if (failReleasesEndpoint) {
      response.writeHead(500).end("fake github down");
      return;
    }
    if (url.pathname === `/repos/${REPOSITORY}/releases`) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(encode(releases.map((release, index) => ({
        id: 1000 + index,
        tag_name: `v${release.version}`,
        draft: false,
        prerelease: release.version.includes("preview"),
        assets: [
          { name: "update-manifest.json", browser_download_url: `${server.url}/assets/manifest-${index}.json` },
          { name: `A446-MultiDevice-LAN-${release.version}.zip`, browser_download_url: `${server.url}/assets/pkg-${index}.zip` },
        ],
      }))));
      return;
    }
    const manifestMatch = url.pathname.match(/^\/assets\/manifest-(\d+)\.json$/);
    if (manifestMatch) {
      const release = releases[Number(manifestMatch[1])];
      const body = encode({
        schemaVersion: 1,
        version: release.version,
        publishedAt: new Date().toISOString(),
        repository: REPOSITORY,
        assetName: `A446-MultiDevice-LAN-${release.version}.zip`,
        sha256: release.manifestSha256 ?? release.zipSha256,
        packageRoot: release.rootName,
        minUpdaterVersion: "0.1.0",
        healthCheck: { hubPath: "/health", timeoutSeconds: 30 },
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(body);
      return;
    }
    const pkgMatch = url.pathname.match(/^\/assets\/pkg-(\d+)\.zip$/);
    if (pkgMatch) {
      const release = releases[Number(pkgMatch[1])];
      if (release.fault === "corrupt") {
        response.writeHead(200, { "Content-Type": "application/zip" });
        response.end(Buffer.from("this is not a zip file at all"));
        return;
      }
      let body = release.zipBytes;
      if (release.fault === "truncate") body = body.subarray(0, Math.max(1, Math.floor(body.length / 2)));
      response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": body.length });
      response.end(body);
      return;
    }
    response.writeHead(404).end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.url = `http://127.0.0.1:${server.address().port}`;
  server.state = state;
  server.close = (() => {
    const original = server.close.bind(server);
    return () => new Promise((resolve) => original(resolve));
  })();
  return server;
}

/**
 * Local fake Hub control plane used by health checks.
 * state.healthy toggles /health; state.agents controls /v1/agents.
 */
export async function startFakeHub({ initialState = { healthy: true, agents: [] } } = {}) {
  const state = initialState;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/health") {
      if (state.healthy) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, version: "fake" }));
      } else {
        response.writeHead(503).end("unhealthy");
      }
      return;
    }
    if (url.pathname === "/v1/agents") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ agents: state.agents }));
      return;
    }
    response.writeHead(404).end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.url = `http://127.0.0.1:${server.address().port}`;
  server.state = state;
  server.close = (() => {
    const original = server.close.bind(server);
    return () => new Promise((resolve) => original(resolve));
  })();
  return server;
}

/** Materialises a fake installed package (pre-adoption flat layout). */
export async function createFakeLiveInstall({ version, deviceId = "test-device" }) {
  const base = await buildFakePackage({ version });
  const live = path.join(base.staging, "live");
  await fs.mkdir(path.join(live, "apps", "agent-hub", "var", "lan", "config"), { recursive: true });
  await fs.mkdir(path.join(live, "apps", "agent-hub", "var", "lan", "state"), { recursive: true });
  await fs.mkdir(path.join(live, "apps", "agent-hub", "workspaces", "lan"), { recursive: true });
  await fs.cp(base.root, live, { recursive: true });
  await fs.rm(base.root, { recursive: true, force: true });
  const token = `A446-${"a".repeat(32)}-${"b".repeat(32)}`;
  await fs.writeFile(path.join(live, "apps", "agent-hub", "var", "lan", "pairing-token.txt"), token, "utf8");
  await fs.writeFile(
    path.join(live, "apps", "agent-hub", "var", "lan", "settings.json"),
    JSON.stringify({ deviceId, hubIp: "127.0.0.1", accessMode: "full" }, null, 2),
  );
  await fs.writeFile(
    path.join(live, "apps", "agent-hub", "var", "lan", "config", `worker.${deviceId}-codex.json`),
    JSON.stringify({ agentId: `${deviceId}-codex`, deviceId, hubUrl: "ws://127.0.0.1:8787/worker" }, null, 2),
  );
  await fs.writeFile(
    path.join(live, "apps", "agent-hub", "var", "lan", "hub-state.json"),
    JSON.stringify({ deviceId, persisted: true }, null, 2),
  );
  await fs.writeFile(path.join(live, "apps", "agent-hub", "var", "lan", "state", `${deviceId}-codex.json`), "{}");
  await fs.writeFile(path.join(live, "apps", "agent-hub", "workspaces", "lan", "keep.txt"), "workspace data");
  return { live, staging: base.staging, zipBytes: null, token };
}
