import fs from "node:fs/promises";
import path from "node:path";
import { UpdaterError, redact, runPowerShell, sha256File } from "./util.mjs";
import { INSTALL_LAYOUT } from "./layout.mjs";

const REQUIRED_PACKAGE_FILES = [
  "apps/agent-hub/src/worker.mjs",
  "apps/agent-hub/src/hub.mjs",
  "apps/agent-hub/package.json",
  "scripts/start-lan-multidevice.ps1",
  "PACKAGE-MANIFEST.json",
];

export async function listZipEntries(zipPath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName 'System.IO.Compression.FileSystem'",
    `$zip = [System.IO.Compression.ZipFile]::OpenRead(${psString(zipPath)})`,
    "try {",
    "  $entries = @($zip.Entries | ForEach-Object { $_.FullName })",
    "  $entries | ConvertTo-Json -Compress",
    "} finally { $zip.Dispose() }",
  ].join("\n");
  const stdout = await runPowerShell(script, { timeoutMs: 120_000 });
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed.map(String);
  if (typeof parsed === "string") return [parsed];
  throw new UpdaterError("Unexpected zip listing output", { code: "ZIP_LIST_FAILED", exitCode: 12 });
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function validateZipEntries(entries, { packageRoot }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new UpdaterError("The package zip is empty or unreadable", { code: "ZIP_INVALID", exitCode: 12 });
  }
  const roots = new Set();
  const normalized = [];
  for (const rawEntry of entries) {
    const entry = String(rawEntry);
    if (!entry || entry.includes("\0")) {
      throw new UpdaterError("The package zip contains an unsafe empty entry", { code: "ZIP_UNSAFE_ENTRY", exitCode: 12 });
    }
    if (entry.startsWith("/") || entry.startsWith("\\") || /^[a-zA-Z]:/.test(entry) || entry.includes("\\")) {
      throw new UpdaterError(`The package zip contains an absolute or backslash entry which was rejected: ${redact(entry)}`, { code: "ZIP_UNSAFE_ENTRY", exitCode: 12 });
    }
    if (entry.includes(":")) {
      throw new UpdaterError(`The package zip contains an entry with a drive/ADS separator which was rejected: ${redact(entry)}`, { code: "ZIP_UNSAFE_ENTRY", exitCode: 12 });
    }
    const segments = entry.split("/");
    if (segments.some((segment) => segment === "..")) {
      throw new UpdaterError(`The package zip contains a path traversal entry which was rejected: ${redact(entry)}`, { code: "ZIP_UNSAFE_ENTRY", exitCode: 12 });
    }
    if (segments.some((segment) => segment === "var" && segments.includes("agent-hub"))) {
      // var directories are junctioned at stage time; packages must not carry runtime var data
      const joined = segments.join("/");
      if (/apps\/agent-hub\/var\//.test(joined) || joined === "apps/agent-hub/var") {
        throw new UpdaterError(
          `The package zip must not contain runtime data under apps/agent-hub/var: ${redact(entry)}`,
          { code: "ZIP_UNSAFE_ENTRY", exitCode: 12 },
        );
      }
    }
    if (segments[0]) roots.add(segments[0]);
    normalized.push(joinedPath(segments));
  }
  if (roots.size !== 1) {
    throw new UpdaterError(
      `The package zip must contain exactly one root directory (found ${roots.size}: ${[...roots].slice(0, 5).join(", ")}).`,
      { code: "ZIP_MULTIPLE_ROOTS", exitCode: 12 },
    );
  }
  const [root] = roots;
  if (root !== packageRoot) {
    throw new UpdaterError(
      `The package zip root '${root}' does not match the manifest packageRoot '${packageRoot}'.`,
      { code: "ZIP_ROOT_MISMATCH", exitCode: 12 },
    );
  }
  for (const required of REQUIRED_PACKAGE_FILES) {
    const wanted = `${packageRoot}/${required}`;
    if (!normalized.includes(wanted)) {
      throw new UpdaterError(`The package zip is missing required file: ${required}`, { code: "ZIP_MISSING_FILE", exitCode: 12 });
    }
  }
  return { root, entries: normalized };
}

function joinedPath(segments) {
  return segments.filter((segment) => segment.length > 0).join("/");
}

export async function extractZip(zipPath, destinationDir) {
  await fs.mkdir(destinationDir, { recursive: true });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName 'System.IO.Compression.FileSystem'",
    `[System.IO.Compression.ZipFile]::ExtractToDirectory(${psString(zipPath)}, ${psString(destinationDir)})`,
  ].join("\n");
  try {
    await runPowerShell(script, { timeoutMs: 600_000 });
  } catch (error) {
    await fs.rm(destinationDir, { recursive: true, force: true }).catch(() => {});
    throw new UpdaterError(`Zip extraction failed: ${error.message}`, { code: "ZIP_EXTRACT_FAILED", exitCode: 12 });
  }
}

/**
 * Verifies the extracted tree against PACKAGE-MANIFEST.json file hashes when
 * the manifest provides them. Falls back to entry presence checks only when
 * the package manifest has no file list (legacy packages).
 */
export async function verifyExtractedTree(versionDir, packageRoot, zipEntries) {
  const manifestPath = path.join(versionDir, "PACKAGE-MANIFEST.json");
  let packageManifest = null;
  try {
    packageManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    packageManifest = null;
  }
  const files = Array.isArray(packageManifest?.files) ? packageManifest.files : null;
  if (!files || !files.length) {
    for (const entry of zipEntries) {
      const relative = entry.slice(packageRoot.length + 1);
      if (!relative) continue;
      const target = path.join(versionDir, ...relative.split("/"));
      await fs.access(target);
    }
    return { verifiedFiles: 0, mode: "presence-only" };
  }
  let verified = 0;
  for (const record of files) {
    if (!record || typeof record.path !== "string" || typeof record.sha256 !== "string") {
      throw new UpdaterError("PACKAGE-MANIFEST.json contains an invalid file record", { code: "VERIFY_FAILED", exitCode: 12 });
    }
    if (record.path.includes("..") || record.path.startsWith("/") || record.path.includes(":")) {
      throw new UpdaterError(`PACKAGE-MANIFEST.json contains an unsafe path: ${redact(record.path)}`, { code: "VERIFY_FAILED", exitCode: 12 });
    }
    const target = path.join(versionDir, ...record.path.split("/"));
    const resolvedRoot = path.resolve(versionDir);
    const resolvedTarget = path.resolve(target);
    if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
      throw new UpdaterError(`PACKAGE-MANIFEST.json path escapes the version directory: ${redact(record.path)}`, { code: "VERIFY_FAILED", exitCode: 12 });
    }
    const stats = await fs.stat(target).catch(() => null);
    if (!stats || !stats.isFile()) {
      throw new UpdaterError(`Extracted package is missing file: ${record.path}`, { code: "VERIFY_FAILED", exitCode: 12 });
    }
    if (stats.size !== Number(record.size)) {
      throw new UpdaterError(`File size mismatch for ${record.path}`, { code: "VERIFY_FAILED", exitCode: 12 });
    }
    const hash = await sha256File(target);
    if (hash !== String(record.sha256).toLowerCase()) {
      throw new UpdaterError(`SHA-256 mismatch for extracted file ${record.path}`, { code: "VERIFY_FAILED", exitCode: 12 });
    }
    verified += 1;
  }
  return { verifiedFiles: verified, mode: "sha256" };
}

export async function writeStagedMarker(versionDir, payload) {
  const markerPath = path.join(versionDir, INSTALL_LAYOUT.stagedMarker);
  await fs.writeFile(markerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function readStagedMarker(versionDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(versionDir, INSTALL_LAYOUT.stagedMarker), "utf8"));
  } catch {
    return null;
  }
}
