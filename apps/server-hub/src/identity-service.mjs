import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PASSWORD_PARAMETERS = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64 });

export class IdentityService {
  constructor(options = {}) {
    if (!options.pool) throw new Error("IdentityService requires a PostgreSQL Pool");
    this.pool = options.pool;
    this.sessionTtlMs = Math.max(60_000, Number(options.sessionTtlMs ?? 12 * 60 * 60 * 1000));
    this.cookieName = options.cookieName ?? "a446_session";
    this.csrfCookieName = options.csrfCookieName ?? "a446_csrf";
    this.secureCookies = options.secureCookies !== false;
    this.allowedOrigins = new Set((options.allowedOrigins ?? []).map((item) => String(item).replace(/\/$/, "")));
  }

  async init() {
    await this.pool.query("DELETE FROM web_sessions WHERE expires_at <= now()");
  }

  async createUser({ username, password, role = "operator" }) {
    const normalized = normalizeUsername(username);
    assertPassword(password);
    if (!new Set(["admin", "operator"]).has(role)) throw httpError(400, "role must be admin or operator");
    const salt = randomBytes(16).toString("base64url");
    const passwordHash = await derivePassword(password, salt, PASSWORD_PARAMETERS);
    const userId = randomUUID();
    try {
      await this.pool.query(`
        INSERT INTO web_users (user_id, username, password_salt, password_hash, password_parameters, role)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `, [userId, normalized, salt, passwordHash, JSON.stringify(PASSWORD_PARAMETERS), role]);
    } catch (error) {
      if (error.code === "23505") throw httpError(409, `user ${normalized} already exists`);
      throw error;
    }
    return { userId, username: normalized, role, status: "active" };
  }

  async login(username, password) {
    const normalized = normalizeUsername(username);
    const result = await this.pool.query(`
      SELECT user_id, username, password_salt, password_hash, password_parameters, role, status
      FROM web_users WHERE username = $1
    `, [normalized]);
    const user = result.rows[0];
    if (!user || user.status !== "active") throw httpError(401, "Invalid username or password");
    const actual = await derivePassword(String(password ?? ""), user.password_salt, user.password_parameters);
    if (!safeEqual(actual, user.password_hash)) throw httpError(401, "Invalid username or password");

    const sessionId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.sessionTtlMs).toISOString();
    await this.pool.query(`
      INSERT INTO web_sessions (session_id, user_id, secret_hash, csrf_hash, expires_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [sessionId, user.user_id, hashSecret(secret), hashSecret(csrfToken), expiresAt]);
    return {
      actor: webActor(user),
      csrfToken,
      expiresAt,
      cookie: this.serializeCookie(`a446s.${sessionId}.${secret}`, expiresAt),
      csrfCookie: this.serializeCsrfCookie(csrfToken, expiresAt),
    };
  }

  async authenticateWeb(request) {
    const token = parseCookies(request.headers.cookie ?? "")[this.cookieName];
    const parsed = parseOpaqueToken(token, "a446s");
    if (!parsed) return null;
    const result = await this.pool.query(`
      SELECT s.secret_hash, s.csrf_hash, s.expires_at,
             u.user_id, u.username, u.role, u.status
      FROM web_sessions s
      JOIN web_users u ON u.user_id = s.user_id
      WHERE s.session_id = $1 AND s.expires_at > now()
    `, [parsed.id]);
    const row = result.rows[0];
    if (!row || row.status !== "active" || !safeEqual(hashSecret(parsed.secret), row.secret_hash)) return null;
    return { ...webActor(row), sessionId: parsed.id, csrfHash: row.csrf_hash };
  }

  verifyCsrf(request, actor) {
    if (actor?.kind !== "web") throw httpError(403, "Web user session required");
    const supplied = request.headers["x-csrf-token"];
    if (typeof supplied !== "string" || !safeEqual(hashSecret(supplied), actor.csrfHash)) {
      throw httpError(403, "CSRF validation failed");
    }
    const origin = request.headers.origin;
    if (origin) {
      const expected = `${request.socket.encrypted ? "https" : "http"}://${request.headers.host}`;
      if (origin !== expected && !this.allowedOrigins.has(origin.replace(/\/$/, ""))) throw httpError(403, "Origin validation failed");
    }
  }

  async logout(actor) {
    if (actor?.sessionId) await this.pool.query("DELETE FROM web_sessions WHERE session_id = $1", [actor.sessionId]);
    const expired = new Date(0).toISOString();
    return {
      sessionCookie: this.serializeCookie("", expired, 0),
      csrfCookie: this.serializeCsrfCookie("", expired, 0),
    };
  }

  async authenticateWorker(header) {
    const token = bearerToken(header);
    const parsed = parseOpaqueToken(token, "a446w");
    if (!parsed) return null;
    const result = await this.pool.query(`
      SELECT credential_id, agent_id, device_id, secret_hash, status
      FROM worker_credentials WHERE credential_id = $1
    `, [parsed.id]);
    const row = result.rows[0];
    if (!row || row.status !== "active" || !safeEqual(hashSecret(parsed.secret), row.secret_hash)) return null;
    await this.pool.query("UPDATE worker_credentials SET last_used_at = now() WHERE credential_id = $1", [parsed.id]);
    return {
      kind: "worker",
      id: `worker:${row.agent_id}`,
      credentialId: row.credential_id,
      agentId: row.agent_id,
      deviceId: row.device_id,
      role: "worker",
    };
  }

  async createWorkerCredential({ agentId, deviceId }) {
    const normalizedAgentId = requiredText(agentId, "agentId");
    const normalizedDeviceId = requiredText(deviceId ?? agentId, "deviceId");
    const credentialId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    await this.pool.query(`
      INSERT INTO worker_credentials (credential_id, agent_id, device_id, secret_hash)
      VALUES ($1, $2, $3, $4)
    `, [credentialId, normalizedAgentId, normalizedDeviceId, hashSecret(secret)]);
    return {
      credentialId,
      agentId: normalizedAgentId,
      deviceId: normalizedDeviceId,
      status: "active",
      token: `a446w.${credentialId}.${secret}`,
    };
  }

  async rotateWorkerCredential(credentialId) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(`
        UPDATE worker_credentials SET status = 'revoked', revoked_at = now()
        WHERE credential_id = $1 AND status = 'active'
        RETURNING agent_id, device_id
      `, [credentialId]);
      if (!current.rows[0]) throw httpError(404, "Active worker credential not found");
      const nextId = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      await client.query(`
        INSERT INTO worker_credentials (credential_id, agent_id, device_id, secret_hash)
        VALUES ($1, $2, $3, $4)
      `, [nextId, current.rows[0].agent_id, current.rows[0].device_id, hashSecret(secret)]);
      await client.query("COMMIT");
      return {
        credentialId: nextId,
        agentId: current.rows[0].agent_id,
        deviceId: current.rows[0].device_id,
        status: "active",
        token: `a446w.${nextId}.${secret}`,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeWorkerCredential(credentialId) {
    const result = await this.pool.query(`
      UPDATE worker_credentials SET status = 'revoked', revoked_at = now()
      WHERE credential_id = $1 AND status = 'active'
      RETURNING credential_id, agent_id, device_id, status, created_at, last_used_at, revoked_at
    `, [credentialId]);
    if (!result.rows[0]) throw httpError(404, "Active worker credential not found");
    return camelCredential(result.rows[0]);
  }

  async listWorkerCredentials() {
    const result = await this.pool.query(`
      SELECT credential_id, agent_id, device_id, status, created_at, last_used_at, revoked_at
      FROM worker_credentials ORDER BY created_at DESC
    `);
    return result.rows.map(camelCredential);
  }

  serializeCookie(value, expiresAt, maxAge) {
    const parts = [
      `${this.cookieName}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Expires=${new Date(expiresAt).toUTCString()}`,
    ];
    if (this.secureCookies) parts.push("Secure");
    if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
    return parts.join("; ");
  }

  serializeCsrfCookie(value, expiresAt, maxAge) {
    const parts = [
      `${this.csrfCookieName}=${value}`,
      "Path=/",
      "SameSite=Strict",
      `Expires=${new Date(expiresAt).toUTCString()}`,
    ];
    if (this.secureCookies) parts.push("Secure");
    if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
    return parts.join("; ");
  }
}

function webActor(row) {
  return {
    kind: "web",
    id: `user:${row.username}`,
    userId: row.user_id,
    username: row.username,
    role: row.role,
  };
}

function camelCredential(row) {
  return {
    credentialId: row.credential_id,
    agentId: row.agent_id,
    deviceId: row.device_id,
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

async function derivePassword(password, salt, parameters) {
  const options = {
    N: Number(parameters?.N ?? PASSWORD_PARAMETERS.N),
    r: Number(parameters?.r ?? PASSWORD_PARAMETERS.r),
    p: Number(parameters?.p ?? PASSWORD_PARAMETERS.p),
    maxmem: 64 * 1024 * 1024,
  };
  const keyLength = Number(parameters?.keyLength ?? PASSWORD_PARAMETERS.keyLength);
  const key = await scrypt(String(password), Buffer.from(salt, "base64url"), keyLength, options);
  return Buffer.from(key).toString("hex");
}

function hashSecret(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(header) {
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
}

function parseOpaqueToken(value, prefix) {
  const match = typeof value === "string" ? value.match(new RegExp(`^${prefix}\\.([0-9a-f-]{36})\\.([A-Za-z0-9_-]{32,})$`, "i")) : null;
  return match ? { id: match[1], secret: match[2] } : null;
}

function parseCookies(value) {
  return Object.fromEntries(String(value).split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
  }));
}

function normalizeUsername(value) {
  const username = requiredText(value, "username").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) throw httpError(400, "username format is invalid");
  return username;
}

function assertPassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 1024) throw httpError(400, "password must be 12 to 1024 characters");
}

function requiredText(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw httpError(400, `${name} is required`);
  if (result.length > 200) throw httpError(400, `${name} is too long`);
  return result;
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
