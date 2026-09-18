import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  loginScopeHash,
  nextThrottleState,
  normalizeLoginProtection,
  retryAfterMs,
} from "./login-protection.mjs";

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
    this.loginProtection = normalizeLoginProtection(options.loginProtection);
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.dummyPasswordSalt = randomBytes(16).toString("base64url");
    this.dummyPasswordHash = derivePassword(randomBytes(32).toString("base64url"), this.dummyPasswordSalt, PASSWORD_PARAMETERS);
  }

  async init() {
    const nowMs = Number(this.now());
    await this.dummyPasswordHash;
    await this.pool.query("DELETE FROM web_sessions WHERE expires_at <= now()");
    await this.pool.query("DELETE FROM web_login_throttles WHERE updated_at < $1", [new Date(nowMs - this.loginProtection.throttleRetentionMs).toISOString()]);
    await this.pool.query("DELETE FROM web_auth_events WHERE occurred_at < $1", [new Date(nowMs - this.loginProtection.auditRetentionMs).toISOString()]);
  }

  async createUser({ username, password, role = "operator" }) {
    const normalized = normalizeUsername(username);
    assertPassword(password);
    if (!new Set(["admin", "operator"]).has(role)) throw httpError(400, "role must be admin or operator", { code: "VALIDATION_ERROR" });
    const salt = randomBytes(16).toString("base64url");
    const passwordHash = await derivePassword(password, salt, PASSWORD_PARAMETERS);
    const userId = randomUUID();
    try {
      const result = await this.pool.query(`
        INSERT INTO web_users (user_id, username, password_salt, password_hash, password_parameters, role)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        RETURNING user_id, username, role, status, created_at, updated_at, last_login_at
      `, [userId, normalized, salt, passwordHash, JSON.stringify(PASSWORD_PARAMETERS), role]);
      return camelUser({ ...result.rows[0], active_session_count: 0 });
    } catch (error) {
      if (error.code === "23505") throw httpError(409, `user ${normalized} already exists`, { code: "STATE_CONFLICT" });
      throw error;
    }
  }

  async createOperator({ username, password, role = "operator" }) {
    if (role === "admin") {
      throw httpError(403, "Administrator accounts can only be created by the server CLI", { code: "ADMIN_HTTP_CREATION_FORBIDDEN" });
    }
    if (role !== "operator") throw httpError(400, "role must be operator", { code: "VALIDATION_ERROR" });
    return this.createUser({ username, password, role: "operator" });
  }

  async login(username, password, context = {}) {
    const normalized = normalizeUsername(username);
    const suppliedPassword = typeof password === "string" && password.length <= 1024 ? password : "";
    const passwordShapeValid = typeof password === "string" && password.length <= 1024;
    const nowMs = Number(this.now());
    const now = new Date(nowMs).toISOString();
    const clientIp = normalizedClientIp(context.clientIp);
    const scopes = this.loginProtection.enabled ? [
      { type: "username", hash: loginScopeHash("username", normalized), policy: this.loginProtection.username },
      ...(clientIp ? [{ type: "ip", hash: loginScopeHash("ip", clientIp), policy: this.loginProtection.ip }] : []),
    ].sort((left, right) => `${left.type}:${left.hash}`.localeCompare(`${right.type}:${right.hash}`)) : [];
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const throttleRows = new Map();
      for (const scope of scopes) {
        await client.query(`
          INSERT INTO web_login_throttles (scope_type, scope_hash, failure_count, window_started_at, updated_at)
          VALUES ($1, $2, 0, $3, $3)
          ON CONFLICT (scope_type, scope_hash) DO NOTHING
        `, [scope.type, scope.hash, now]);
        const locked = await client.query(`
          SELECT scope_type, scope_hash, failure_count, window_started_at, last_failed_at, blocked_until
          FROM web_login_throttles
          WHERE scope_type = $1 AND scope_hash = $2
          FOR UPDATE
        `, [scope.type, scope.hash]);
        throttleRows.set(`${scope.type}:${scope.hash}`, locked.rows[0]);
      }

      const blockedMs = scopes.reduce((maximum, scope) => Math.max(maximum, retryAfterMs(throttleRows.get(`${scope.type}:${scope.hash}`), nowMs)), 0);
      if (blockedMs > 0) {
        await recordLoginEvent(client, {
          outcome: "rate_limited",
          usernameHash: loginScopeHash("username", normalized),
          ipHash: clientIp ? loginScopeHash("ip", clientIp) : null,
          retryAfterMs: blockedMs,
        });
        await client.query("COMMIT");
        committed = true;
        throw httpError(429, "Too many login attempts", {
          code: "AUTH_RATE_LIMITED",
          retryAfterMs: blockedMs,
          headers: { "retry-after": String(Math.max(1, Math.ceil(blockedMs / 1000))) },
        });
      }

      const result = await client.query(`
        SELECT user_id, username, password_salt, password_hash, password_parameters, role, status
        FROM web_users WHERE username = $1
      `, [normalized]);
      const user = result.rows[0];
      const actual = await derivePassword(
        suppliedPassword,
        user?.password_salt ?? this.dummyPasswordSalt,
        user?.password_parameters ?? PASSWORD_PARAMETERS,
      );
      const expected = user?.password_hash ?? await this.dummyPasswordHash;
      const valid = passwordShapeValid && user?.status === "active" && safeEqual(actual, expected);

      if (!valid) {
        let nextDelayMs = 0;
        for (const scope of scopes) {
          const next = nextThrottleState(throttleRows.get(`${scope.type}:${scope.hash}`), nowMs, scope.policy, this.loginProtection.windowMs);
          nextDelayMs = Math.max(nextDelayMs, next.delayMs);
          await client.query(`
            UPDATE web_login_throttles
            SET failure_count = $3, window_started_at = $4, last_failed_at = $5, blocked_until = $6, updated_at = $5
            WHERE scope_type = $1 AND scope_hash = $2
          `, [scope.type, scope.hash, next.failureCount, next.windowStartedAt, next.lastFailedAt, next.blockedUntil]);
        }
        await recordLoginEvent(client, {
          outcome: "invalid_credentials",
          usernameHash: loginScopeHash("username", normalized),
          ipHash: clientIp ? loginScopeHash("ip", clientIp) : null,
          retryAfterMs: nextDelayMs || null,
        });
        await client.query("COMMIT");
        committed = true;
        throw httpError(401, "Invalid username or password", { code: "AUTH_INVALID_CREDENTIALS" });
      }

      const sessionId = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(nowMs + this.sessionTtlMs).toISOString();
      await client.query(`
        INSERT INTO web_sessions (session_id, user_id, secret_hash, csrf_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [sessionId, user.user_id, hashSecret(secret), hashSecret(csrfToken), expiresAt]);
      await client.query("UPDATE web_users SET last_login_at = $2, updated_at = $2 WHERE user_id = $1", [user.user_id, now]);
      for (const scope of scopes) {
        if (scope.type === "username") {
          await client.query("DELETE FROM web_login_throttles WHERE scope_type = $1 AND scope_hash = $2", [scope.type, scope.hash]);
        }
      }
      await recordLoginEvent(client, {
        outcome: "success",
        userId: user.user_id,
        usernameHash: loginScopeHash("username", normalized),
        ipHash: clientIp ? loginScopeHash("ip", clientIp) : null,
      });
      await client.query("COMMIT");
      committed = true;
      return {
        actor: webActor(user),
        csrfToken,
        expiresAt,
        cookie: this.serializeCookie(`a446s.${sessionId}.${secret}`, expiresAt),
        csrfCookie: this.serializeCsrfCookie(csrfToken, expiresAt),
      };
    } catch (error) {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listUsers() {
    const result = await this.pool.query(publicUsersSql());
    return result.rows.map(camelUser);
  }

  async setUserStatus(userId, status) {
    if (!new Set(["active", "disabled"]).has(status)) throw httpError(400, "status must be active or disabled", { code: "VALIDATION_ERROR" });
    const normalizedId = requiredUuid(userId, "userId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query("SELECT user_id, role FROM web_users WHERE user_id = $1 FOR UPDATE", [normalizedId]);
      if (!current.rows[0]) throw httpError(404, "User not found", { code: "NOT_FOUND" });
      if (current.rows[0].role !== "operator") throw httpError(403, "Administrator status cannot be changed through HTTP", { code: "FORBIDDEN" });
      await client.query("UPDATE web_users SET status = $2, updated_at = now() WHERE user_id = $1", [normalizedId, status]);
      if (status === "disabled") await client.query("DELETE FROM web_sessions WHERE user_id = $1", [normalizedId]);
      const user = await loadPublicUser(client, normalizedId);
      await client.query("COMMIT");
      return user;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeUserSessions(userId) {
    const normalizedId = requiredUuid(userId, "userId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const user = await client.query("SELECT user_id FROM web_users WHERE user_id = $1 FOR UPDATE", [normalizedId]);
      if (!user.rows[0]) throw httpError(404, "User not found", { code: "NOT_FOUND" });
      const deleted = await client.query("DELETE FROM web_sessions WHERE user_id = $1", [normalizedId]);
      await client.query("COMMIT");
      return { userId: normalizedId, revokedSessions: deleted.rowCount };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
    await this.pool.query("UPDATE web_sessions SET last_seen_at = now() WHERE session_id = $1 AND last_seen_at < now() - interval '1 minute'", [parsed.id]);
    return { ...webActor(row), sessionId: parsed.id, csrfHash: row.csrf_hash };
  }

  verifyCsrf(request, actor) {
    if (actor?.kind !== "web") throw httpError(403, "Web user session required", { code: "FORBIDDEN" });
    const supplied = request.headers["x-csrf-token"];
    if (typeof supplied !== "string" || !safeEqual(hashSecret(supplied), actor.csrfHash)) {
      throw httpError(403, "CSRF validation failed", { code: "CSRF_FAILED" });
    }
    const origin = request.headers.origin;
    if (origin) {
      const expected = `${request.socket.encrypted ? "https" : "http"}://${request.headers.host}`;
      if (origin !== expected && !this.allowedOrigins.has(origin.replace(/\/$/, ""))) {
        throw httpError(403, "Origin validation failed", { code: "CSRF_FAILED" });
      }
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
    const normalizedAgentId = normalizeIdentityId(agentId, "agentId");
    const normalizedDeviceId = normalizeIdentityId(deviceId ?? agentId, "deviceId");
    const credentialId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    try {
      await this.pool.query(`
        INSERT INTO worker_credentials (credential_id, agent_id, device_id, secret_hash)
        VALUES ($1, $2, $3, $4)
      `, [credentialId, normalizedAgentId, normalizedDeviceId, hashSecret(secret)]);
    } catch (error) {
      if (error.code === "23505") {
        throw httpError(409, `agentId ${normalizedAgentId} already has an active credential`, { code: "ACTIVE_CREDENTIAL_EXISTS" });
      }
      throw error;
    }
    return {
      credentialId,
      agentId: normalizedAgentId,
      deviceId: normalizedDeviceId,
      status: "active",
      token: `a446w.${credentialId}.${secret}`,
    };
  }

  async rotateWorkerCredential(credentialId) {
    const normalizedCredentialId = requiredUuid(credentialId, "credentialId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(`
        UPDATE worker_credentials SET status = 'revoked', revoked_at = now()
        WHERE credential_id = $1 AND status = 'active'
        RETURNING agent_id, device_id
      `, [normalizedCredentialId]);
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
    const normalizedCredentialId = requiredUuid(credentialId, "credentialId");
    const result = await this.pool.query(`
      UPDATE worker_credentials SET status = 'revoked', revoked_at = now()
      WHERE credential_id = $1 AND status = 'active'
      RETURNING credential_id, agent_id, device_id, status, created_at, last_used_at, revoked_at
    `, [normalizedCredentialId]);
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

function publicUsersSql(whereClause = "") {
  return `
    SELECT u.user_id, u.username, u.role, u.status, u.created_at, u.updated_at, u.last_login_at,
           count(s.session_id)::integer AS active_session_count
    FROM web_users u
    LEFT JOIN web_sessions s ON s.user_id = u.user_id AND s.expires_at > now()
    ${whereClause}
    GROUP BY u.user_id
    ORDER BY u.created_at ASC, u.username ASC
  `;
}

async function loadPublicUser(client, userId) {
  const result = await client.query(publicUsersSql("WHERE u.user_id = $1"), [userId]);
  if (!result.rows[0]) throw httpError(404, "User not found", { code: "NOT_FOUND" });
  return camelUser(result.rows[0]);
}

function camelUser(row) {
  return {
    userId: row.user_id,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    activeSessionCount: Number(row.active_session_count ?? 0),
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

async function recordLoginEvent(client, { outcome, userId = null, usernameHash, ipHash = null, retryAfterMs = null }) {
  await client.query(`
    INSERT INTO web_auth_events (event_id, outcome, user_id, username_hash, ip_hash, retry_after_ms)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [randomUUID(), outcome, userId, usernameHash, ipHash, retryAfterMs]);
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
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) throw httpError(400, "username format is invalid", { code: "VALIDATION_ERROR" });
  return username;
}

function assertPassword(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 1024) throw httpError(400, "password must be 12 to 1024 characters", { code: "VALIDATION_ERROR" });
}

function requiredText(value, name) {
  const result = String(value ?? "").trim();
  if (!result) throw httpError(400, `${name} is required`, { code: "VALIDATION_ERROR" });
  if (result.length > 200) throw httpError(400, `${name} is too long`, { code: "VALIDATION_ERROR" });
  return result;
}

function normalizeIdentityId(value, name) {
  const result = String(value ?? "").trim();
  if (!result || result.length > 128 || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw httpError(400, `${name} must be 1 to 128 printable characters`, { code: "VALIDATION_ERROR" });
  }
  return result;
}

function normalizedClientIp(value) {
  if (value === undefined || value === null || value === "") return null;
  const result = String(value).trim().toLowerCase();
  if (!result || result.length > 128 || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw httpError(400, "clientIp is invalid", { code: "VALIDATION_ERROR" });
  }
  return result;
}

function requiredUuid(value, name) {
  const result = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw httpError(400, `${name} must be a UUID`, { code: "VALIDATION_ERROR" });
  }
  return result;
}

function defaultErrorCode(statusCode) {
  if (statusCode === 400) return "VALIDATION_ERROR";
  if (statusCode === 401) return "AUTH_REQUIRED";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409) return "STATE_CONFLICT";
  if (statusCode === 429) return "AUTH_RATE_LIMITED";
  return "INTERNAL_ERROR";
}

function httpError(statusCode, message, metadata = {}) {
  return Object.assign(new Error(message), {
    statusCode,
    code: metadata.code ?? defaultErrorCode(statusCode),
    ...(metadata.details === undefined ? {} : { details: metadata.details }),
    ...(metadata.retryAfterMs === undefined ? {} : { retryAfterMs: metadata.retryAfterMs }),
    ...(metadata.headers === undefined ? {} : { headers: metadata.headers }),
  });
}
