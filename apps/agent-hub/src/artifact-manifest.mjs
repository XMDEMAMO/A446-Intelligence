import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { extractArtifactPaths, resolveAllowedPath } from "./local-policy.mjs";

export async function buildArtifactManifest(taskSpec, policy, options = {}) {
  const requested = [...new Set(extractArtifactPaths(taskSpec))];
  const files = [];
  const missing = [];
  const maxFileBytes = Number(options.maxFileBytes ?? 100 * 1024 * 1024);

  for (const requestedPath of requested) {
    const absolute = await resolveAllowedPath(requestedPath, policy, { mayNotExist: true });
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if (error.code === "ENOENT") {
        missing.push(toPortableRelative(policy.workspaceRoot, absolute));
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      const target = await realpath(absolute);
      await resolveAllowedPath(target, policy);
      info = await lstat(target);
    }
    if (info.isDirectory()) {
      for (const file of await walkFiles(absolute, policy)) files.push(await describeFile(file, policy.workspaceRoot, maxFileBytes));
    } else if (info.isFile()) {
      files.push(await describeFile(absolute, policy.workspaceRoot, maxFileBytes));
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    algorithm: "sha256",
    generatedAt: new Date().toISOString(),
    files,
    missing,
  };
}

async function walkFiles(directory, policy, visited = new Set()) {
  const canonicalDirectory = await realpath(directory);
  if (visited.has(canonicalDirectory)) return [];
  visited.add(canonicalDirectory);
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(candidate);
      await resolveAllowedPath(target, policy);
      const targetInfo = await lstat(target);
      if (targetInfo.isFile()) result.push(target);
      else if (targetInfo.isDirectory()) result.push(...await walkFiles(target, policy, visited));
    } else if (entry.isDirectory()) {
      result.push(...await walkFiles(candidate, policy, visited));
    } else if (entry.isFile()) {
      result.push(candidate);
    }
  }
  return result;
}

async function describeFile(file, workspaceRoot, maxFileBytes) {
  const info = await lstat(file);
  if (info.size > maxFileBytes) {
    return {
      path: toPortableRelative(workspaceRoot, file),
      size: info.size,
      sha256: null,
      status: "too_large",
    };
  }
  return {
    path: toPortableRelative(workspaceRoot, file),
    size: info.size,
    sha256: await hashFile(file),
    status: "ready",
  };
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function toPortableRelative(workspaceRoot, file) {
  const relative = path.relative(workspaceRoot, file);
  return relative.split(path.sep).join("/");
}
