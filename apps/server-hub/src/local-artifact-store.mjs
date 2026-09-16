import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export class LocalArtifactStore {
  constructor(options = {}) {
    if (!options.rootDirectory || !path.isAbsolute(options.rootDirectory)) {
      throw new Error("Artifact rootDirectory must be an absolute path");
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.repositoryRoot = options.repositoryRoot ? path.resolve(options.repositoryRoot) : null;
    this.maxFileBytes = Math.max(1, Number(options.maxFileBytes ?? 100 * 1024 * 1024));
  }

  async init() {
    if (this.repositoryRoot && pathsOverlap(this.rootDirectory, this.repositoryRoot)) {
      throw new Error("Artifact rootDirectory must be outside the repository");
    }
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    if (this.repositoryRoot) {
      const [canonicalRoot, canonicalRepository] = await Promise.all([realpath(this.rootDirectory), realpath(this.repositoryRoot)]);
      if (pathsOverlap(canonicalRoot, canonicalRepository)) throw new Error("Artifact rootDirectory must not overlap the repository");
    }
    await mkdir(path.join(this.rootDirectory, ".tmp"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.rootDirectory, "objects"), { recursive: true, mode: 0o700 });
  }

  createStorageKey() {
    const id = randomUUID().replaceAll("-", "");
    return path.posix.join("objects", id.slice(0, 2), id);
  }

  async receive(request, artifact) {
    if (artifact.size > this.maxFileBytes) throw httpError(413, `Artifact exceeds ${this.maxFileBytes} byte limit`);
    const finalPath = this.resolveStorageKey(artifact.storageKey);
    const tempPath = path.join(this.rootDirectory, ".tmp", `${artifact.artifactId}.${randomUUID()}.upload`);
    await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    const hash = createHash("sha256");
    let size = 0;
    const sink = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
    const verifier = async function* (source) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > artifact.size || size > this.maxFileBytes) throw httpError(413, "Artifact upload is larger than declared or allowed");
        hash.update(chunk);
        yield chunk;
      }
    }.bind(this);
    try {
      await pipeline(request, verifier, sink);
      const digest = hash.digest("hex");
      if (size !== artifact.size) throw httpError(422, `Artifact size mismatch: expected ${artifact.size}, received ${size}`);
      if (digest !== artifact.sha256) throw httpError(422, "Artifact SHA-256 mismatch");
      await rename(tempPath, finalPath);
      await chmod(finalPath, 0o600).catch(() => {});
      return { size, sha256: digest };
    } catch (error) {
      sink.destroy();
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async open(artifact) {
    const file = this.resolveStorageKey(artifact.storageKey);
    const info = await stat(file);
    if (!info.isFile()) throw Object.assign(new Error("Artifact object is not a file"), { code: "ENOENT" });
    return { stream: createReadStream(file), size: info.size };
  }

  resolveStorageKey(storageKey) {
    if (typeof storageKey !== "string" || !/^objects\/[a-f0-9]{2}\/[a-f0-9]{32}$/.test(storageKey)) {
      throw new Error("Invalid server storage key");
    }
    const absolute = path.resolve(this.rootDirectory, ...storageKey.split("/"));
    if (!isInside(absolute, this.rootDirectory)) throw new Error("Artifact storage path escaped its root");
    return absolute;
  }
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isInside(left, right) || isInside(right, left);
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
