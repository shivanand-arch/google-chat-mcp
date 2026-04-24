// OAuth state storage — pluggable backend.
//
// Pass { redisUrl } to makeStorage() to use Redis; omit for in-memory.
// The interface is async in both modes so callers don't branch.
//
// Keys (Redis): gc-mcp:client:*, gc-mcp:pending:*, gc-mcp:code:*,
// gc-mcp:access:*, gc-mcp:refresh:*

import crypto from "crypto";

const rand = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

// ── In-memory backend ───────────────────────────────────────────────────────
function makeMemoryStorage() {
  const pendingAuth = new Map();
  const authCodes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const clients = new Map();

  // GC expired entries once a minute — keeps memory bounded.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingAuth) if (v.expiresAt < now) pendingAuth.delete(k);
    for (const [k, v] of authCodes) if (v.expiresAt < now) authCodes.delete(k);
    for (const [k, v] of accessTokens) if (v.expiresAt < now) accessTokens.delete(k);
  }, 60_000).unref();

  return {
    backend: "memory",

    async registerClient({ redirectUris, clientName }) {
      const clientId = rand(16);
      const clientSecret = rand(32);
      const client = { clientId, clientSecret, redirectUris, clientName, createdAt: Date.now() };
      clients.set(clientId, client);
      return client;
    },
    async getClient(clientId) { return clients.get(clientId) || null; },

    async savePendingAuth(data) {
      const state = rand();
      pendingAuth.set(state, { ...data, expiresAt: Date.now() + 10 * 60_000 });
      return state;
    },
    async takePendingAuth(state) {
      const data = pendingAuth.get(state);
      if (!data) return null;
      pendingAuth.delete(state);
      return data;
    },

    async saveAuthCode(data) {
      const code = rand();
      authCodes.set(code, { ...data, expiresAt: Date.now() + 60_000 });
      return code;
    },
    async takeAuthCode(code) {
      const data = authCodes.get(code);
      if (!data) return null;
      authCodes.delete(code);
      return data;
    },

    async saveAccessToken({ clientId, google, user, scope, ttlSeconds = 3600 }) {
      const token = rand(48);
      accessTokens.set(token, {
        clientId, google, user, scope,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      return token;
    },
    async getAccessToken(token) {
      const data = accessTokens.get(token);
      if (!data) return null;
      if (data.expiresAt < Date.now()) { accessTokens.delete(token); return null; }
      return data;
    },

    async saveRefreshToken({ clientId, google, user, scope }) {
      const token = rand(48);
      refreshTokens.set(token, { clientId, google, user, scope });
      return token;
    },
    async takeRefreshToken(token) {
      const data = refreshTokens.get(token);
      if (!data) return null;
      refreshTokens.delete(token);
      return data;
    },
  };
}

// ── Redis backend ───────────────────────────────────────────────────────────
// Uses native EXPIRE so we don't need a GC loop. Values are JSON-encoded.
async function makeRedisStorage(redisUrl) {
  // Dynamic import so users without REDIS_URL don't need the dep installed.
  const { default: Redis } = await import("ioredis");
  const client = new Redis(redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
  client.on("error", (e) => console.error("[redis.error]", e.message));
  client.on("connect", () => console.log("[redis] connected"));

  const K = {
    client: (id) => `gc-mcp:client:${id}`,
    pending: (s) => `gc-mcp:pending:${s}`,
    code: (c) => `gc-mcp:code:${c}`,
    access: (t) => `gc-mcp:access:${t}`,
    refresh: (t) => `gc-mcp:refresh:${t}`,
  };

  async function setJson(key, value, ttlSeconds) {
    const v = JSON.stringify(value);
    if (ttlSeconds) await client.set(key, v, "EX", ttlSeconds);
    else await client.set(key, v);
  }
  async function getJson(key) {
    const v = await client.get(key);
    return v ? JSON.parse(v) : null;
  }
  async function takeJson(key) {
    const v = await client.get(key);
    if (!v) return null;
    await client.del(key);
    return JSON.parse(v);
  }

  return {
    backend: "redis",

    async registerClient({ redirectUris, clientName }) {
      const clientId = rand(16);
      const clientSecret = rand(32);
      const c = { clientId, clientSecret, redirectUris, clientName, createdAt: Date.now() };
      await setJson(K.client(clientId), c); // DCR registrations persist
      return c;
    },
    async getClient(clientId) {
      return await getJson(K.client(clientId));
    },

    async savePendingAuth(data) {
      const state = rand();
      await setJson(K.pending(state), data, 10 * 60);
      return state;
    },
    async takePendingAuth(state) {
      return await takeJson(K.pending(state));
    },

    async saveAuthCode(data) {
      const code = rand();
      await setJson(K.code(code), data, 60);
      return code;
    },
    async takeAuthCode(code) {
      return await takeJson(K.code(code));
    },

    async saveAccessToken({ clientId, google, user, scope, ttlSeconds = 3600 }) {
      const token = rand(48);
      await setJson(
        K.access(token),
        { clientId, google, user, scope, expiresAt: Date.now() + ttlSeconds * 1000 },
        ttlSeconds,
      );
      return token;
    },
    async getAccessToken(token) {
      // Redis TTL auto-expires — no manual check needed.
      return await getJson(K.access(token));
    },

    async saveRefreshToken({ clientId, google, user, scope }) {
      const token = rand(48);
      await setJson(K.refresh(token), { clientId, google, user, scope });
      return token;
    },
    async takeRefreshToken(token) {
      return await takeJson(K.refresh(token));
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────
export async function makeStorage({ redisUrl } = {}) {
  if (redisUrl) {
    try {
      const s = await makeRedisStorage(redisUrl);
      console.log("[storage] backend=redis");
      return s;
    } catch (err) {
      console.error("[storage] Redis init failed:", err.message, "— falling back to in-memory");
    }
  }
  console.log("[storage] backend=memory (sessions will not survive restart)");
  return makeMemoryStorage();
}
