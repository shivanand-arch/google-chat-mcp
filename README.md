# Google Chat Plugin for Claude Code

Connect Claude Code to your Google Chat — read, search, summarise, and send messages across all your spaces and DMs.

## Install

### Option 1: Plugin marketplace (recommended)

In Claude Code, run:

```
/plugin marketplace add shivanand-arch/google-chat-mcp
/plugin install google-chat@exotel-tools
```

Then run `/chat-setup` to connect your Google account.

### Option 2: Manual

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
  -- node ~/google-chat-mcp/servers/server.js
```

## Prerequisites

You need a Google Cloud project with:
1. **Google Chat API** enabled
2. **OAuth2 Desktop credentials** (Client ID + Client Secret)
3. These scopes on the consent screen:
   - `chat.spaces.readonly`
   - `chat.messages`
   - `chat.memberships.readonly`

If your team already has a Google Cloud project set up, ask your admin for the Client ID and Client Secret.

## What you get

| Type | Name | Description |
|------|------|-------------|
| Command | `/chat-setup` | One-time setup — connects your Google Chat account |
| Command | `/chat-summary` | Summarise recent messages across spaces |
| Command | `/chat-search` | Search messages by keyword |
| Command | `/chat-send` | Send a message to a space or DM |
| Skill | `google-chat` | Auto-activates for any Chat-related request |
| MCP Server | `google-chat` | 7 tools: list, read, search, send, find DM, send to person |

## Usage

Once set up, just talk to Claude naturally:

- *"What's happening in my Chat today?"*
- *"Search Chat for the pricing discussion"*
- *"Summarise the Engineering space"*
- *"Send a message to Priya: standup at 10am"*
- *"Draft a follow-up email based on my Chat with Sahil"*

Or use slash commands:

- `/chat-summary` — summarise all recent spaces
- `/chat-summary product` — summarise a specific space
- `/chat-search pricing` — search for messages
- `/chat-send Product team | standup moved to 11am` — send a message

## Troubleshooting

- **"Missing required env vars"** — Run `/chat-setup` to configure credentials
- **"Insufficient authentication scopes"** — Re-run `/chat-setup` to get a fresh token
- **"Space not found"** — Ask Claude to list your spaces first
- **Rate limits** — Try searching a specific space instead of all spaces
