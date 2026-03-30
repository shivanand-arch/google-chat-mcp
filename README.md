# Google Chat MCP Server for Claude Code

An MCP (Model Context Protocol) server that connects Claude Code to Google Chat — read, search, summarise, and send messages across all your spaces and DMs.

## Features

- **List spaces** — see all your Chat rooms, groups, and DMs
- **Read messages** — get recent messages from any space
- **Search** — keyword search across all spaces in parallel
- **Send messages** — send to spaces or DM people by name
- **Find DMs** — fuzzy-match person names to find their DM space
- **Slash commands** — `/chat-summary`, `/chat-search`, `/chat-send`

## Quick Setup (5 minutes)

### Step 1: Google Cloud OAuth credentials

You need a Google Cloud project with the Chat API enabled and OAuth2 Desktop credentials. If your team already has these, skip to Step 2.

1. Go to [Google Cloud Console](https://console.cloud.google.com) → create or select a project
2. Enable the **Google Chat API** (APIs & Services → Library)
3. Configure the **OAuth consent screen** (Internal for Workspace, or External with test users)
4. Add these scopes:
   - `https://www.googleapis.com/auth/chat.spaces.readonly`
   - `https://www.googleapis.com/auth/chat.messages`
   - `https://www.googleapis.com/auth/chat.memberships.readonly`
5. Create **OAuth client ID** → Desktop app → note the **Client ID** and **Client Secret**

### Step 2: Clone and install

```bash
git clone https://github.com/anthropics/google-chat-mcp.git ~/google-chat-mcp
cd ~/google-chat-mcp/servers
npm install
```

### Step 3: Get your refresh token

```bash
cd ~/google-chat-mcp/servers
GOOGLE_CLIENT_ID="your-client-id" GOOGLE_CLIENT_SECRET="your-client-secret" node auth-setup.js
```

Follow the prompts — open the URL, sign in, paste the auth code. Copy the refresh token that's printed.

### Step 4: Add to Claude Code

```bash
claude mcp add google-chat \
  -e GOOGLE_CLIENT_ID="your-client-id" \
  -e GOOGLE_CLIENT_SECRET="your-client-secret" \
  -e GOOGLE_REFRESH_TOKEN="your-refresh-token" \
  -- node ~/google-chat-mcp/servers/server.js
```

### Step 5: Verify

Restart Claude Code and ask: *"List my Google Chat spaces"*

## Usage

Once set up, talk to Claude naturally:

- *"What's happening in my Chat today?"*
- *"Search Chat for the pricing discussion"*
- *"Summarise the Engineering space"*
- *"Send a message to Priya: standup at 10am"*

Or use slash commands:

- `/chat-summary` — summarise all recent spaces
- `/chat-summary product` — summarise the Product space
- `/chat-search pricing` — search for messages about pricing
- `/chat-send Product team | standup moved to 11am` — send a message

## Tools provided

| Tool | Description |
|------|-------------|
| `list_spaces` | List all Google Chat spaces and DMs |
| `get_messages` | Get recent messages from a space |
| `search_messages` | Search messages across all spaces |
| `send_message` | Send a message to a space |
| `get_space` | Get details about a space |
| `find_dm` | Find a person's DM space by name |
| `send_to_person` | Send a DM by person name (auto-resolves space) |

## Troubleshooting

- **"Missing required env vars"** — Make sure all three env vars are passed in the `claude mcp add` command
- **"Insufficient authentication scopes"** — Re-run `auth-setup.js` to get a fresh token with all scopes
- **"Space not found"** — Use `list_spaces` first to see available space names
- **Rate limits** — Search scans multiple spaces; try searching a specific space if you hit limits
