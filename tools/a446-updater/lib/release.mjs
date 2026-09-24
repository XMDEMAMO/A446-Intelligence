import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { UpdaterError, compareVersions, normalizeVersion, redact, UPDATER_VERSION } from "./util.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

export function apiBaseUrl(apiBase) {
  const base = String(apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  if (!base.startsWith("https://") && !base.startsWith("http://")) {
    throw new UpdaterError(`Unsupported API base URL: ${redact(base)}`, { code: "UNSUPPORTED_URL", exitCode: 2 });
  }
  return base;
}

export async function fetchJson(url, { token, allowHttp = false, timeoutMs = 30_000 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new UpdaterError(`Refusing non-HTTPS URL: ${redact(url)}`, { code: "INSECURE_URL", exitCode: 12 });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "a446-updater",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new UpdaterError(
        `GitHub API request failed with HTTP ${response.status}: ${redact(body.slice(0, 300))}`,
        { code: "GITHUB_API_ERROR", exitCode: 1 },
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function listReleases({ apiBase = "https://api.github.com", repository, token, allowHttp }) {
  const base = apiBaseUrl(apiBase);
  const url = `${base}/repos/${repository}/releases?per_page=50`;
  const releases = await fetchJson(url, { token, allowHttp });
  if (!Array.isArray(releases)) {
    throw new UpdaterError("GitHub releases response is not a list", { code: "GITHUB_API_ERROR", exitCode: 1 });
  }
  return releases.filter((release) => !release.draft);
}

export function findManifestAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((asset) => asset?.name === "update-manifest.json" && typeof asset.browser_download_url === "string") ?? null;
}

export function findPackageAsset(release, assetName) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((item) => item?.name === assetName);
  if (!asset || typeof asset.browser_download_url !== "string") {
    throw new UpdaterError(`Release does not contain asset '${assetName}'`, { code: "ASSET_MISSING", exitCode: 11 });
  }
  return asset;
}

export function validateManifest(manifest, { repository }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new UpdaterError("update-manifest.json is not an object", { code: "MANIFEST_INVALID", exitCode: 12 });
  }
  if (manifest.schemaVersion !== 1) {
    throw new UpdaterError(`Unsupported manifest schemaVersion: ${String(manifest.schemaVersion)}`, { code: "MANIFEST_INVALID", exitCode: 12 });
  }
  const version = normalizeVersion(manifest.version);
  if (!version) {
    throw new UpdaterError(`Manifest version is invalid: ${redact(String(manifest.version))}`, { code: "MANIFEST_INVALID", exitCode: 12 });
  }
  if (manifest.repository !== repository) {
    throw new UpdaterError(
      `Manifest repository '${redact(String(manifest.repository))}' does not match configured repository '${repository}'`,
      { code: "MANIFEST_REPOSITORY_MISMATCH", exitCode: 12 },
    );
  }
  if (typeof manifest.assetName !== "string" || !manifest.assetName.endsWith(".zip")) {
    throw new UpdaterError("Manifest assetName must be a .zip file name", { code: "MANIFEST_INVALID", exitCode: 12 });
  }
  if (typeof manifest.sha256 !== "string" || !HEX64.test(manifest.sha256)) {
    throw new UpdaterError("Manifest sha256 must be 64 lowercase hex characters", { code: "MANIFEST_INVALID", exitCode: 12 });
  }
  if (typeof manifest.packageRoot !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.packageRoot)) {
    throw new UpdaterError("Manifest packageRoot must be a single safe path segment", { code: "MANIFEST_INVALID", exitCode: 12 });
  }
  if (manifest.packageRoot.includes("..")) {
    throw new UpdaterError("Manifest packageRoot must not contain '..'", { code: "MANIFEST_INVALID", exitCode: 12 });
  }
  const minUpdater = normalizeVersion(manifest.minUpdaterVersion ?? "0.1.0");
  if (minUpdater && compareVersions(UPDATER_VERSION, minUpdater) < 0) {
    throw new UpdaterError(
      `This updater (${UPDATER_VERSION}) is older than the manifest requirement (${minUpdater}). Upgrade the updater first.`,
      { code: "UPDATER_TOO_OLD", exitCode: 15 },
    );
  }
  if (manifest.healthCheck !== undefined && (manifest.healthCheck === null || typeof manifest.healthCheck !== "object" || Array.isArray(manifest.healthCheck))) {
    throw new UpdaterError("Manifest healthCheck must be an object when present", { code: "MANIFEST_INVALID", exitCode: 12 });
  }
  return {
    schemaVersion: 1,
    version,
    publishedAt: typeof manifest.publishedAt === "string" ? manifest.publishedAt : null,
    repository: manifest.repository,
    assetName: manifest.assetName,
    sha256: manifest.sha256.toLowerCase(),
    packageRoot: manifest.packageRoot,
    minUpdaterVersion: minUpdater,
    healthCheck: {
      hubPath: typeof manifest.healthCheck?.hubPath === "string" ? manifest.healthCheck.hubPath : "/health",
      timeoutSeconds: Number.isFinite(Number(manifest.healthCheck?.timeoutSeconds)) ? Number(manifest.healthCheck.timeoutSeconds) : 30,
    },
  };
}

/**
 * Resolves the release + manifest to install. Order:
 * 1. exact requested version (or fail);
 * 2. latest = highest validated manifest version.
 */
export async function resolveTargetRelease({ releases, requestedVersion, repository, token, allowHttp, apiBase }) {
  const candidates = [];
  const failures = [];
  for (const release of releases) {
    const manifestAsset = findManifestAsset(release);
    if (!manifestAsset) continue;
    try {
      const raw = await fetchJson(manifestAsset.browser_download_url, { token, allowHttp, apiBase });
      const manifest = validateManifest(raw, { repository });
      candidates.push({ release, manifest, manifestUrl: manifestAsset.browser_download_url });
    } catch (error) {
      failures.push(`release '${release.tag_name}': ${error.message}`);
    }
  }
  if (requestedVersion) {
    const wanted = normalizeVersion(requestedVersion);
    if (!wanted) {
      throw new UpdaterError(`Invalid requested version: ${redact(requestedVersion)}`, { code: "INVALID_VERSION", exitCode: 2 });
    }
    const match = candidates.find((candidate) => candidate.manifest.version === wanted);
    if (!match) {
      throw new UpdaterError(
        `Version ${wanted} is not available in GitHub Releases.${failures.length ? ` Some releases were skipped: ${failures.join("; ")}` : ""}`,
        { code: "VERSION_NOT_FOUND", exitCode: 11 },
      );
    }
    return match;
  }
  if (!candidates.length) {
    throw new UpdaterError(
      `No usable update-manifest.json found in GitHub Releases.${failures.length ? ` ${failures.join("; ")}` : ""}`,
      { code: "NO_RELEASES", exitCode: 11 },
    );
  }
  candidates.sort((left, right) => compareVersions(left.manifest.version, right.manifest.version));
  return candidates[candidates.length - 1];
}

export async function downloadAsset({ url, destination, expectedSha256, token, allowHttp, onProgress, faultHook }) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new UpdaterError(`Refusing non-HTTPS download URL: ${redact(url)}`, { code: "INSECURE_URL", exitCode: 12 });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15 * 60_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "a446-updater",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      throw new UpdaterError(`Asset download failed with HTTP ${response.status}`, { code: "DOWNLOAD_FAILED", exitCode: 1 });
    }
    const digest = createHash("sha256");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const partFile = `${destination}.part`;
    const handle = await fs.open(partFile, "w");
    try {
      const reader = response.body.getReader();
      let downloaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        digest.update(value);
        await handle.write(value);
        downloaded += value.byteLength;
        if (onProgress) onProgress(downloaded);
        if (faultHook && faultHook.afterBytes !== undefined && downloaded >= faultHook.afterBytes) {
          throw new UpdaterError("Simulated download interruption", { code: "DOWNLOAD_INTERRUPTED", exitCode: 1 });
        }
      }
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(partFile, { force: true });
      throw error;
    }
    if (faultHook && faultHook.crashAfterDownload) {
      await fs.rm(partFile, { force: true });
      process.exit(70);
    }
    const actual = digest.digest("hex");
    if (expectedSha256 && actual !== expectedSha256.toLowerCase()) {
      await fs.rm(partFile, { force: true });
      throw new UpdaterError(
        `SHA-256 mismatch for downloaded asset (expected ${expectedSha256}, got ${actual}). The package was rejected.`,
        { code: "SHA256_MISMATCH", exitCode: 12 },
      );
    }
    await fs.rename(partFile, destination);
    return { sha256: actual };
  } finally {
    clearTimeout(timer);
  }
}
