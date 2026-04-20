// In-memory storage for OAuth state, auth codes, access tokens, and refresh tokens.
// Replace with Postgres / Redis by implementing the same interface if persistence
// across restarts is needed. For now a Railway dyno restart forces users to re-auth,
// which is acceptable for a small team connector.

import crypto from "crypto";

const pendingAuth = new Map();     // opaque state -> { clientId, redirectUri, codeChallenge, codeChallengeMethod, scope, claudeState }
const authCodes = new Map();       // code -> { clientId, redirectUri, codeChallenge, codeChallengeMethod, google, user, expiresAt }
const accessTokens = new Map();    // token -> { clientId, google, user, scope, expiresAt }
const refreshTokens = new Map();   // token -> { clientId, google, user, scope }
const clients = new Map();         // clientId -> { clientId, clientSecret?, redirectUris, createdAt }

// GC loop — cheap, but keeps memory bounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuth) if (v.expiresAt < now) pendingAuth.delete(k);
  for (const [k, v] of authCodes) if (v.expiresAt < now) authCodes.delete(k);
  for (const [k, v] of accessTokens) if (v.expiresAt < now) accessTokens.delete(k);
}, 60_000).unref();

const rand = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export const storage = {
  // ── Clients (Dynamic Client Registration) ──
  registerClient({ redirectUris, clientName }) {
    const clientId = rand(16);
    const clientSecret = rand(32);
    const client = { clientId, clientSecret, redirectUris, clientName, createdAt: Date.now() };
    clients.set(clientId, client);
    return client;
  },
  getClient(clientId) { return clients.get(clientId) || null; },

  // ── Pending authorization (between /authorize and Google callback) ──
  savePendingAuth(data) {
    const state = rand();
    pendingAuth.set(state, { ...data, expiresAt: Date.now() + 10 * 60_000 });
    return state;
  },
  takePendingAuth(state) {
    const data = pendingAuth.get(state);
    if (!data) return null;
    pendingAuth.delete(state);
    return data;
  },

  // ── Authorization codes (returned to claude.ai after Google consent) ──
  saveAuthCode(data) {
    const code = rand();
    authCodes.set(code, { ...data, expiresAt: Date.now() + 60_000 });
    return code;
  },
  takeAuthCode(code) {
    const data = authCodes.get(code);
    if (!data) return null;
    authCodes.delete(code);
    return data;
  },

  // ── Access tokens (issued to claude.ai; map to Google tokens) ──
  saveAccessToken({ clientId, google, user, scope, ttlSeconds = 3600 }) {
    const token = rand(48);
    accessTokens.set(token, {
      clientId, google, user, scope,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return token;
  },
  getAccessToken(token) {
    const data = accessTokens.get(token);
    if (!data) return null;
    if (data.expiresAt < Date.now()) { accessTokens.delete(token); return null; }
    return data;
  },

  // ── Refresh tokens ──
  saveRefreshToken({ clientId, google, user, scope }) {
    const token = rand(48);
    refreshTokens.set(token, { clientId, google, user, scope });
    return token;
  },
  takeRefreshToken(token) {
    const data = refreshTokens.get(token);
    if (!data) return null;
    refreshTokens.delete(token);
    return data;
  },
};
