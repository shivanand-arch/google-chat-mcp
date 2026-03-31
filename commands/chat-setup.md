---
description: Set up Google Chat connection — OAuth login and MCP server configuration
allowed-tools: Bash, AskUserQuestion, Read
argument-hint: [optional: client_id client_secret]
---

Help the user connect their Google Chat account to Claude Code. This is a one-time setup.

## Steps

### 1. Check if already configured

Run this bash command to check if google-chat MCP server is already registered:
```bash
cat ~/.claude.json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('configured' if 'google-chat' in d.get('mcpServers',{}) else 'not-configured')" 2>/dev/null || echo "not-configured"
```

If already configured, tell the user "Google Chat is already set up! Try `/chat-summary` to test it." and stop.

### 2. Get Google Cloud OAuth credentials

Ask the user for their **Google Cloud OAuth Client ID** and **Client Secret**.

Tell them: "You need a Google Cloud project with the Chat API enabled and OAuth2 Desktop credentials. If your team already has these, ask your admin for the Client ID and Client Secret. Otherwise, follow these steps:"

1. Go to console.cloud.google.com → create or select a project
2. Enable the **Google Chat API** (APIs & Services → Library)
3. Configure the **OAuth consent screen** (Internal for Workspace, or External with test users)
4. Add scopes: `chat.spaces.readonly`, `chat.messages`, `chat.memberships.readonly`
5. Create **OAuth client ID** → Desktop app

Wait for them to provide CLIENT_ID and CLIENT_SECRET before proceeding.

### 3. Run OAuth flow

Determine the plugin root directory. The auto-setup script is at `servers/auto-setup.js` relative to this plugin. Find it using:
```bash
find ~/.claude ~/Library/Application\ Support/Claude -path "*/google-chat*/servers/auto-setup.js" 2>/dev/null | head -1
```

Then install dependencies and run the OAuth flow:
```bash
cd <directory containing auto-setup.js> && npm install 2>/dev/null && node auto-setup.js "<CLIENT_ID>" "<CLIENT_SECRET>"
```

This opens the browser. The user signs into Google and grants access. The script outputs a JSON with the refresh token.

### 4. Register the MCP server

Parse the JSON output from step 3 to get the refresh_token, then run:

```bash
claude mcp add google-chat \
  -e GOOGLE_CLIENT_ID="<CLIENT_ID>" \
  -e GOOGLE_CLIENT_SECRET="<CLIENT_SECRET>" \
  -e GOOGLE_REFRESH_TOKEN="<REFRESH_TOKEN>" \
  -- node <path-to-server.js>
```

Where `<path-to-server.js>` is the full path to `server.js` in the same directory as `auto-setup.js`.

### 5. Confirm

Tell the user: "Google Chat is connected! Restart Claude Code, then try asking 'What's happening in my Chat today?' or use `/chat-summary`."
