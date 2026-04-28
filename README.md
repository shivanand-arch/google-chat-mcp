# Google Chat MCP

Connect Claude to your Google Chat — read, search, summarise, and send messages across all your spaces and DMs.

Works in **two modes**:

- **Claude Code CLI** — install as a local plugin, stdio transport. One user, local credentials.
- **claude.ai / Claude Cowork connector** — self-hosted HTTP MCP server with OAuth. Any number of colleagues can connect their own Google account by clicking **Connect**.

---

## Option A: Claude Code CLI (local, stdio)

### Install via plugin marketplace

```
/plugin marketplace add shivanand-arch/google-chat-mcp
/plugin install google-chat@exotel-tools
```

Then run `/chat-setup` to connect your Google account.

### Manual install

```bash
git clone https://github.com/shivanand-arch/google-chat-mcp.git ~/google-chat-mcp
cd ~/google-chat-mcp/servers && npm install
```

Then in Claude Code, run `/chat-setup` — or manually:

```bash
# Get your refresh token
GOOGLE_CLIENT_ID="your-id" GOOGLE_CLIENT_SECRET="your-secret" node ~/google-chat-mcp/servers/auto-setup.js

# Register with Claude Code
claude mcp add google-chat \
  -e GOOGLE_CLIENT_ID="your-id" \
  -e GOOGLE_CLIENT_SECRET="your-secret" \
  -e GOOGLE_REFRESH_TOKEN="your-token" \
  -- node ~/google-chat-mcp/servers/start.js
```

---

## Option B: claude.ai / Cowork custom connector (remote, HTTP + OAuth)

This path runs an HTTP MCP server with OAuth, deployed to Railway. Colleagues then add the deployed URL as a custom connector on claude.ai and authorize their own Google account with one click.

> **Do not** paste the GitHub repo URL into claude.ai's connector field — it is not an MCP endpoint. You need a live deployed URL.

### 1. Prepare Google OAuth

Create (or reuse) an OAuth 2.0 **Web application** client at [console.cloud.google.com](https://console.cloud.google.com/apis/credentials). Enable the Google Chat API. On the consent screen add these scopes:

- `openid` `email` `profile`
- `https://www.googleapis.com/auth/chat.spaces.readonly`
- `https://www.googleapis.com/auth/chat.messages`
- `https://www.googleapis.com/auth/chat.memberships.readonly`
- `https://www.googleapis.com/auth/directory.readonly` — People API fallback to resolve `users/<id>` → display name when @mention harvest and DM-member listing miss a user. **Without this scope, all DMs surface as "DM (unresolved)" because `members.list` returns null `displayName` for DMs under user auth.**

> Existing connectors authorized before v0.12.0 will need to be reconnected after upgrading — the directory scope is new and a fresh consent is required.

Note the **Client ID** and **Client Secret**. You'll add the redirect URI in step 3 once you know the Railway URL.

### 2. Deploy to Railway

```bash
# From the repo root
cd remote

# Option 2a: one-shot deploy from CLI
railway login
railway init         # create a new Railway project
railway up           # deploys the ./remote directory

# Option 2b: connect the repo in Railway's dashboard
# → New Project → Deploy from GitHub repo → pick shivanand-arch/google-chat-mcp
# → Root directory: remote
```

Railway will give you a URL like `https://google-chat-mcp-production.up.railway.app`. Copy it.

### 3. Set environment variables on Railway

In the Railway service → **Variables**:

| Key | Value |
|-----|-------|
| `GOOGLE_CLIENT_ID` | from step 1 |
| `GOOGLE_CLIENT_SECRET` | from step 1 |
| `PUBLIC_URL` | your Railway URL (no trailing slash) |
| `SESSION_SECRET` | any random 32+ char string |
| `ALLOWED_HD` | *(optional)* restrict to one Workspace domain, e.g. `exotel.com` |

Then go back to the Google Cloud console and add this **Authorized redirect URI** to the OAuth client:

```
https://<your-railway-url>/oauth/google/callback
```

Redeploy the Railway service so the env vars take effect.

### 4. Add the connector on claude.ai

1. Go to **Settings → Connectors → Add custom connector**
2. Name: `Google Chat` (or anything)
3. URL: `https://<your-railway-url>/mcp`
4. Click **Connect** → authorize your Google account → done.

Share the same URL with colleagues. Each click **Connect** and authorizes their own Google account — no shared credentials.

### Endpoints exposed by the remote server

| Path | Purpose |
|------|---------|
| `GET /` | landing page with install hint |
| `GET /healthz` | health check (used by Railway) |
| `POST /mcp` | MCP JSON-RPC endpoint (bearer-token auth) |
| `GET /.well-known/oauth-authorization-server` | OAuth 2.1 AS metadata |
| `GET /.well-known/oauth-protected-resource` | resource metadata |
| `POST /register` | Dynamic Client Registration |
| `GET /authorize` | kicks off OAuth flow |
| `POST /token` | exchanges code / refresh token for access token |
| `GET /oauth/google/callback` | Google OAuth return leg |

### Notes on the remote server

- **Token storage is in-memory.** Railway service restarts will force colleagues to re-auth. Acceptable for a small team; swap `remote/src/storage.js` for a Postgres-backed implementation if you need durability.
- Tokens are short-lived (1 hour access, long-lived refresh). The server refreshes the Google token transparently via `googleapis`.
- No shared refresh token — each colleague's Google credentials are stored only against their own issued bearer token.

---

## Prerequisites (both modes)

You need a Google Cloud project with:
1. **Google Chat API** enabled
2. OAuth2 credentials — **Desktop** type for Option A, **Web application** type for Option B
3. Chat scopes on the consent screen (see above)

## What you get

| Type | Name | Description |
|------|------|-------------|
| Command | `/chat-setup` | One-time setup — connects your Google Chat account (CLI only) |
| Command | `/chat-summary` | Summarise recent messages across spaces |
| Command | `/chat-search` | Search messages by keyword |
| Command | `/chat-send` | Send a message to a space or DM |
| Skill | `google-chat` | Auto-activates for any Chat-related request |
| MCP Server | `google-chat` | 7 tools: `list_spaces`, `get_messages`, `search_messages`, `send_message`, `get_space`, `find_dm`, `send_to_person` |

## Usage

Once connected, just ask naturally:

- *"What's happening in my Chat today?"*
- *"Search Chat for the pricing discussion"*
- *"Summarise the Engineering space"*
- *"Send a message to Priya: standup at 10am"*
- *"Draft a follow-up email based on my Chat with Sahil"*

CLI slash commands:

- `/chat-summary` — summarise all recent spaces
- `/chat-summary product` — summarise a specific space
- `/chat-search pricing` — search for messages
- `/chat-send Product team | standup moved to 11am` — send a message

## Troubleshooting

- **"Couldn't reach the MCP server"** (claude.ai) — You likely pasted the GitHub URL. Deploy to Railway (Option B) and paste the Railway URL's `/mcp` path instead.
- **"Missing required env vars"** (CLI) — Run `/chat-setup` to configure credentials
- **"Insufficient authentication scopes"** — Re-run `/chat-setup` (CLI) or disconnect and reconnect on claude.ai
- **"Space not found"** — Ask Claude to list your spaces first
- **Rate limits** — Try searching a specific space instead of all spaces
