/**
 * Automated OAuth2 setup for Google Chat MCP plugin.
 *
 * Usage:
 *   node auto-setup.js <CLIENT_ID> <CLIENT_SECRET>
 *
 * Opens the browser for OAuth consent, runs a local callback server,
 * captures the refresh token, and outputs the `claude mcp add` command.
 */

import http from "http";
import https from "https";
import { exec } from "child_process";

const CLIENT_ID = process.argv[2];
const CLIENT_SECRET = process.argv[3];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("\nUsage: node auto-setup.js <CLIENT_ID> <CLIENT_SECRET>\n");
  process.exit(1);
}

const REDIRECT_URI = "http://localhost:3847/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.memberships.readonly",
].join(" ");

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
  }).toString();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost:3847");
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end();
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("No authorization code received.");
    process.exit(1);
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    '<h2 style="font-family:system-ui;color:green">&#10003; Authorized! Return to your terminal.</h2>' +
    '<p style="font-family:system-ui;color:#666">You can close this tab.</p>'
  );

  const postData = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }).toString();

  const tokenReq = https.request(
    {
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    },
    (tokenRes) => {
      let data = "";
      tokenRes.on("data", (chunk) => (data += chunk));
      tokenRes.on("end", () => {
        const tokens = JSON.parse(data);
        if (!tokens.refresh_token) {
          console.error("\nERROR: No refresh token received. Response:", data);
          process.exit(1);
        }

        // Output as JSON for the setup command to parse
        console.log(
          JSON.stringify({
            success: true,
            refresh_token: tokens.refresh_token,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
          })
        );

        server.close();
        process.exit(0);
      });
    }
  );
  tokenReq.write(postData);
  tokenReq.end();
});

server.listen(3847, "127.0.0.1", () => {
  console.error("Opening browser for Google Chat authorization...");
  const platform = process.platform;
  const openCmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} "${authUrl}"`);
});

// Auto-close after 5 minutes if no callback
setTimeout(() => {
  console.error("\nTimeout: No authorization received after 5 minutes.");
  server.close();
  process.exit(1);
}, 300000);
