import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveAllowedPath } from "./local-policy.mjs";

export class ArtifactClient {
  constructor(config, policy) {
    this.enabled = config.artifacts?.centralStore === true;
    this.policy = policy;
    this.tokenEnv = config.authTokenEnv;
    this.maxFileBytes = Math.max(1, Number(config.artifacts?.maxFileBytes ?? 100 * 1024 * 1024));
    this.baseUrl = this.enabled ? artifactApiBase(config.artifacts?.apiUrl, config.hubUrl) : null;
  }

  async uploadManifest(manifest, { taskId, attemptId }) {
    if (!this.enabled) return manifest;
    const files = [];
    for (const file of manifest.files ?? []) {
      if (file.status !== "ready") {
        files.push(file);
        continue;
      }
      const absolute = await resolveAllowedPath(file.path, this.policy);
      const created = await this.json("/v1/artifacts", {
        method: "POST",
        body: JSON.stringify({ taskId, attemptId, path: file.path, size: file.size, sha256: file.sha256 }),
      });
      const uploaded = await this.json(`/v1/artifacts/${created.artifact.artifactId}/content`, {
        method: "PUT",
        body: createReadStream(absolute),
        duplex: "half",
        headers: { "content-type": "application/octet-stream" },
      });
      files.push({
        ...file,
        artifactId: uploaded.artifact.artifactId,
        status: uploaded.artifact.status,
        downloadUrl: uploaded.artifact.downloadUrl,
      });
    }
    for (const missingPath of manifest.missing ?? []) {
      await this.json("/v1/artifacts", {
        method: "POST",
        body: JSON.stringify({ taskId, attemptId, path: missingPath, status: "missing" }),
      });
    }
    return { ...manifest, files };
  }

  async downloadReferences(payload) {
    if (!this.enabled) return [];
    const references = payload?.contextBundle?.artifactReferences ?? [];
    const downloaded = [];
    for (const reference of references) {
      if (!reference?.artifactId || reference.status !== "ready") continue;
      const expectedSize = Number(reference.size);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > this.maxFileBytes) {
        throw new Error(`Artifact ${reference.artifactId} has an invalid size`);
      }
      const expectedHash = String(reference.sha256 ?? "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error(`Artifact ${reference.artifactId} has an invalid SHA-256`);
      const target = await resolveAllowedPath(reference.path, this.policy, { mayNotExist: true });
      await mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${randomUUID()}.download`;
      const response = await fetch(`${this.baseUrl}/v1/artifacts/${reference.artifactId}/content`, {
        headers: this.authHeaders(),
      });
      if (!response.ok || !response.body) throw new Error(await responseError(response));
      const hash = createHash("sha256");
      let size = 0;
      const verifier = async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > expectedSize || size > this.maxFileBytes) throw new Error("Downloaded artifact is larger than expected");
          hash.update(chunk);
          yield chunk;
        }
      }.bind(this);
      try {
        await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(temp, { flags: "wx", mode: 0o600 }));
        const digest = hash.digest("hex");
        if (size !== expectedSize) throw new Error(`Downloaded artifact size mismatch for ${reference.path}`);
        if (digest !== expectedHash) throw new Error(`Downloaded artifact SHA-256 mismatch for ${reference.path}`);
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      downloaded.push({ artifactId: reference.artifactId, path: reference.path, size, sha256: expectedHash });
    }
    return downloaded;
  }

  async json(pathname, init) {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...this.authHeaders(),
        ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(await responseError(response));
    return response.json();
  }

  authHeaders() {
    const token = this.tokenEnv ? process.env[this.tokenEnv] : null;
    if (!token) throw new Error(`Artifact transfer requires worker credential environment variable ${this.tokenEnv}`);
    return { authorization: `Bearer ${token}` };
  }
}

function artifactApiBase(configured, hubUrl) {
  if (configured) return String(configured).replace(/\/$/, "");
  const url = new URL(hubUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = url.pathname.replace(/\/worker\/?$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function responseError(response) {
  try {
    const body = await response.json();
    return body.error ?? `Artifact request failed (${response.status})`;
  } catch {
    return `Artifact request failed (${response.status})`;
  }
}
