import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UpdaterError } from "../lib/util.mjs";
import { validateManifest, resolveTargetRelease } from "../lib/release.mjs";
import { validateZipEntries } from "../lib/zip.mjs";
import { REPOSITORY, buildFakePackage, startFakeReleaseServer, sha256 } from "./helpers.mjs";

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    version: "0.5.0-preview16",
    publishedAt: new Date().toISOString(),
    repository: REPOSITORY,
    assetName: "A446-MultiDevice-LAN-0.5.0-preview16.zip",
    sha256: "a".repeat(64),
    packageRoot: "A446-MultiDevice-LAN-0.5.0-preview16",
    minUpdaterVersion: "0.1.0",
  };
}

test("validateManifest accepts a correct manifest and normalizes fields", () => {
  const manifest = validateManifest(validManifest(), { repository: REPOSITORY });
  assert.equal(manifest.version, "0.5.0-preview16");
  assert.equal(manifest.healthCheck.hubPath, "/health");
  assert.equal(manifest.healthCheck.timeoutSeconds, 30);
});

test("validateManifest rejects tampered fields", () => {
  assert.throws(() => validateManifest({ ...validManifest(), schemaVersion: 2 }, { repository: REPOSITORY }), UpdaterError);
  assert.throws(() => validateManifest({ ...validManifest(), version: "not semver" }, { repository: REPOSITORY }), /invalid/);
  assert.throws(() => validateManifest({ ...validManifest(), repository: "evil/repo" }, { repository: REPOSITORY }), /does not match/);
  assert.throws(() => validateManifest({ ...validManifest(), sha256: "zz".repeat(32) }, { repository: REPOSITORY }), /sha256/);
  assert.throws(() => validateManifest({ ...validManifest(), packageRoot: "../escape" }, { repository: REPOSITORY }), /packageRoot/);
  assert.throws(
    () => validateManifest({ ...validManifest(), minUpdaterVersion: "99.0.0" }, { repository: REPOSITORY }),
    /older than the manifest requirement/,
  );
});

test("validateZipEntries rejects traversal, absolute paths, backslashes, drive letters and multiple roots", () => {
  const safeEntries = [
    "pkg/apps/agent-hub/src/worker.mjs",
    "pkg/apps/agent-hub/src/hub.mjs",
    "pkg/apps/agent-hub/package.json",
    "pkg/scripts/start-lan-multidevice.ps1",
    "pkg/PACKAGE-MANIFEST.json",
  ];
  assert.doesNotThrow(() => validateZipEntries(safeEntries, { packageRoot: "pkg" }));
  assert.throws(() => validateZipEntries([...safeEntries, "pkg/../evil.txt"], { packageRoot: "pkg" }), /traversal/);
  assert.throws(() => validateZipEntries([...safeEntries, "/abs.txt"], { packageRoot: "pkg" }), /absolute/);
  assert.throws(() => validateZipEntries([...safeEntries, "apps\\evil.mjs"], { packageRoot: "pkg" }), /backslash/);
  assert.throws(() => validateZipEntries([...safeEntries, "C:/evil.txt"], { packageRoot: "pkg" }), /drive|absolute|separator|backslash/);
  assert.throws(() => validateZipEntries([...safeEntries, "evil:stream.txt"], { packageRoot: "pkg" }), /separator/);
  assert.throws(() => validateZipEntries(["a.txt", "b.txt"], { packageRoot: "pkg" }), /exactly one root/);
  assert.throws(
    () => validateZipEntries(["pkg/apps/agent-hub/src/worker.mjs", "pkg/apps/agent-hub/var/lan/hub-state.json"], { packageRoot: "pkg" }),
    /runtime data/,
  );
  assert.throws(
    () => validateZipEntries(["pkg/README.md"], { packageRoot: "pkg" }),
    /missing required file/,
  );
});

test("resolveTargetRelease picks the requested version and rejects unknown ones", async () => {
  const pkgA = await buildFakePackage({ version: "0.5.0-preview15" });
  const pkgB = await buildFakePackage({ version: "0.5.0-preview16" });
  const releases = [
    {
      version: "0.5.0-preview15",
      rootName: pkgA.rootName,
      zipBytes: await fs.readFile(pkgA.zipPath),
      zipSha256: sha256(await fs.readFile(pkgA.zipPath)),
    },
    {
      version: "0.5.0-preview16",
      rootName: pkgB.rootName,
      zipBytes: await fs.readFile(pkgB.zipPath),
      zipSha256: sha256(await fs.readFile(pkgB.zipPath)),
    },
  ];
  const server = await startFakeReleaseServer({ releases });
  try {
    const list = await (await fetch(`${server.url}/repos/${REPOSITORY}/releases`)).json();
    const target = await resolveTargetRelease({
      releases: list,
      requestedVersion: "0.5.0-preview15",
      repository: REPOSITORY,
      allowHttp: true,
    });
    assert.equal(target.manifest.version, "0.5.0-preview15");
    const latest = await resolveTargetRelease({
      releases: list,
      repository: REPOSITORY,
      allowHttp: true,
    });
    assert.equal(latest.manifest.version, "0.5.0-preview16");
    await assert.rejects(
      () => resolveTargetRelease({
        releases: list,
        requestedVersion: "9.9.9",
        repository: REPOSITORY,
        allowHttp: true,
      }),
      (error) => error.code === "VERSION_NOT_FOUND" && error.exitCode === 11,
    );
  } finally {
    await server.close();
    await fs.rm(pkgA.staging, { recursive: true, force: true });
    await fs.rm(pkgB.staging, { recursive: true, force: true });
  }
});
