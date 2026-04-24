// OAuth 2.1 Authorization Server — chains to Google for upstream auth.
//
// Flow:
//   1. claude.ai discovers us via /.well-known/oauth-protected-resource on /mcp
//   2. claude.ai registers a client via POST /register (DCR)
//   3. Browser -> GET /authorize -> we redirect to Google's consent screen
//   4. Google -> GET /oauth/google/callback -> we exchange for Google tokens,
//      issue our own auth code, redirect back to claude.ai's redirect_uri
//   5. claude.ai -> POST /token (with PKCE verifier) -> we return our access token
//   6. claude.ai -> calls /mcp with Authorization: Bearer <our_token>

import express from "express";
import crypto from "crypto";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.memberships.readonly",
].join(" ");

function verifyPkce(verifier, challenge, method) {
  if (!challenge) return true; // PKCE optional if never issued
  if (method === "plain") return verifier === challenge;
  if (method === "S256" || !method) {
    const hash = crypto.createHash("sha256").update(verifier).digest("base64url");
    return hash === challenge;
  }
  return false;
}

export function createOAuthRouter({ publicUrl, googleClientId, googleClientSecret, allowedHd, storage }) {
  const router = express.Router();
  const googleRedirectUri = `${publicUrl}/oauth/google/callback`;

  // ── Metadata ──────────────────────────────────────────────────────────────
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/authorize`,
      token_endpoint: `${publicUrl}/token`,
      registration_endpoint: `${publicUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["chat"],
    });
  });

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: `${publicUrl}/mcp`,
      authorization_servers: [publicUrl],
      scopes_supported: ["chat"],
      bearer_methods_supported: ["header"],
    });
  });

  // ── Dynamic Client Registration (RFC 7591) ────────────────────────────────
  router.post("/register", express.json(), async (req, res) => {
    const { redirect_uris, client_name } = req.body || {};
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({ error: "invalid_redirect_uri" });
    }
    const client = await storage.registerClient({
      redirectUris: redirect_uris,
      clientName: client_name || "unknown",
    });
    res.status(201).json({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // ── /authorize — entry point from claude.ai ──────────────────────────────
  router.get("/authorize", async (req, res) => {
    const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state, scope } = req.query;

    if (response_type !== "code") {
      return res.status(400).send("unsupported_response_type");
    }
    const client = await storage.getClient(client_id);
    if (!client) return res.status(400).send("unknown client_id");
    if (!client.redirectUris.includes(redirect_uri)) {
      return res.status(400).send("redirect_uri not registered for client");
    }

    const googleState = await storage.savePendingAuth({
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method,
      scope: scope || "chat",
      claudeState: state,
    });

    const googleUrl = new URL(GOOGLE_AUTH_URL);
    googleUrl.searchParams.set("client_id", googleClientId);
    googleUrl.searchParams.set("redirect_uri", googleRedirectUri);
    googleUrl.searchParams.set("response_type", "code");
    googleUrl.searchParams.set("scope", GOOGLE_SCOPES);
    googleUrl.searchParams.set("access_type", "offline");
    googleUrl.searchParams.set("prompt", "consent");
    googleUrl.searchParams.set("state", googleState);
    if (allowedHd) googleUrl.searchParams.set("hd", allowedHd);
    res.redirect(googleUrl.toString());
  });

  // ── Google's callback ────────────────────────────────────────────────────
  router.get("/oauth/google/callback", async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Google returned error: ${error}`);
    if (!code || !state) return res.status(400).send("Missing code/state");

    const pending = await storage.takePendingAuth(state);
    if (!pending) return res.status(400).send("Invalid or expired state");

    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: googleRedirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return res.status(500).send(`Google token exchange failed: ${body}`);
    }
    const tokens = await tokenRes.json();

    const userRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const user = userRes.ok ? await userRes.json() : { sub: "unknown" };

    if (allowedHd && user.hd !== allowedHd) {
      return res.status(403).send(`Access restricted to ${allowedHd} accounts`);
    }

    const code2 = await storage.saveAuthCode({
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      scope: pending.scope,
      google: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      },
      user: { sub: user.sub, email: user.email, name: user.name, hd: user.hd },
    });

    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("code", code2);
    if (pending.claudeState) redirect.searchParams.set("state", pending.claudeState);
    res.redirect(redirect.toString());
  });

  // ── /token — claude.ai exchanges our code for our access token ────────────
  router.post("/token", express.urlencoded({ extended: true }), async (req, res) => {
    const { grant_type, code, code_verifier, refresh_token, client_id } = req.body;

    if (grant_type === "authorization_code") {
      const data = await storage.takeAuthCode(code);
      if (!data) return res.status(400).json({ error: "invalid_grant" });
      if (data.clientId !== client_id) return res.status(400).json({ error: "invalid_client" });
      if (!verifyPkce(code_verifier, data.codeChallenge, data.codeChallengeMethod)) {
        return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      }
      const accessToken = await storage.saveAccessToken({
        clientId: data.clientId, google: data.google, user: data.user, scope: data.scope,
      });
      const refreshTok = await storage.saveRefreshToken({
        clientId: data.clientId, google: data.google, user: data.user, scope: data.scope,
      });
      return res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refreshTok,
        scope: data.scope,
      });
    }

    if (grant_type === "refresh_token") {
      const data = await storage.takeRefreshToken(refresh_token);
      if (!data) return res.status(400).json({ error: "invalid_grant" });
      if (data.clientId !== client_id) return res.status(400).json({ error: "invalid_client" });
      const accessToken = await storage.saveAccessToken({
        clientId: data.clientId, google: data.google, user: data.user, scope: data.scope,
      });
      const newRefresh = await storage.saveRefreshToken({
        clientId: data.clientId, google: data.google, user: data.user, scope: data.scope,
      });
      return res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: newRefresh,
        scope: data.scope,
      });
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  return router;
}
