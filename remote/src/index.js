// Entry point — wires Express + OAuth 2.1 AS + MCP over HTTP.

import express from "express";
import { createOAuthRouter } from "./oauth.js";
import { createMcpHandler } from "./mcp.js";

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  PUBLIC_URL,
  ALLOWED_HD,
  PORT = 8080,
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !PUBLIC_URL) {
  console.error("[google-chat-mcp] Missing required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_URL");
  process.exit(1);
}

const publicUrl = PUBLIC_URL.replace(/\/+$/, "");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Railway terminates TLS upstream

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html><head><title>Google Chat MCP</title><style>
body{font-family:system-ui;max-width:640px;margin:60px auto;padding:0 20px;color:#111}
code{background:#f4f4f4;padding:2px 6px;border-radius:4px}
</style></head><body>
<h1>Google Chat MCP</h1>
<p>This is a remote MCP server. Add it as a custom connector on claude.ai:</p>
<ol>
  <li>Go to <b>Settings → Connectors → Add custom connector</b></li>
  <li>Paste this URL: <code>${publicUrl}/mcp</code></li>
  <li>Click <b>Connect</b> and authorize your Google account</li>
</ol>
<p><a href="https://github.com/shivanand-arch/google-chat-mcp">Source on GitHub</a></p>
</body></html>`);
});

// OAuth 2.1 AS + well-known metadata + Google callback
app.use(createOAuthRouter({
  publicUrl,
  googleClientId: GOOGLE_CLIENT_ID,
  googleClientSecret: GOOGLE_CLIENT_SECRET,
  allowedHd: ALLOWED_HD || null,
}));

// MCP endpoint — accepts POST with JSON-RPC body, requires Bearer token
const mcpHandler = createMcpHandler({
  googleClientId: GOOGLE_CLIENT_ID,
  googleClientSecret: GOOGLE_CLIENT_SECRET,
});
app.post("/mcp", express.json({ limit: "1mb" }), mcpHandler);

// Some clients probe GET /mcp for capabilities — return 405 with resource metadata hint
app.get("/mcp", (req, res) => {
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`);
  res.status(405).json({ error: "method_not_allowed", hint: "POST JSON-RPC to /mcp with Authorization: Bearer <token>" });
});

app.listen(PORT, () => {
  console.log(`[google-chat-mcp] listening on :${PORT} (public: ${publicUrl})`);
});
