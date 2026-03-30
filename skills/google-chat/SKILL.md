---
name: google-chat
description: >
  This skill should be used when the user asks to "check my Chat messages",
  "what's happening in Chat", "summarize my Google Chat", "search Chat for",
  "send a message in Chat", "catch me up on", "what did [person] say in Chat",
  or any request involving reading, searching, summarizing, or sending Google
  Chat messages. Also activate when the user wants to use Chat context while
  doing other work, such as drafting an email or document based on a Chat
  conversation.
version: 0.1.0
---

## Working with Google Chat

You have access to the user's Google Chat through the `google-chat` MCP server. Use the tools below to help the user read, search, summarize, and send messages.

## Available tools

- **`list_spaces`** — list all spaces (rooms, DMs, group chats) the user is in
- **`get_messages`** — get recent messages from a specific space
- **`search_messages`** — search for a keyword across all spaces
- **`send_message`** — send a message or reply to a space or thread
- **`get_space`** — get details about a specific space
- **`find_dm`** — find a person's DM space by name
- **`send_to_person`** — send a DM to a person by name (resolves space automatically)

## Core workflows

### Catching up on a space

1. Call `list_spaces` to find the right space if the user hasn't specified one.
2. Call `get_messages` with a reasonable `pageSize` (25-50).
3. Summarise the conversation: who said what, any decisions made, any open questions or action items.

### Searching across Chat

1. Call `search_messages` with the user's keyword or phrase.
2. Group results by space if multiple spaces are involved.
3. Surface the most relevant messages first — quote sparingly, summarise the context.

### Sending a message

1. Confirm the space name and message text with the user before sending.
2. Call `send_message`. If replying to a thread, pass `threadName`.
3. Confirm success by showing the sent message details.

### Using Chat as context for another task

When the user asks to draft an email, write a doc, or create a task based on something from Chat:
1. Retrieve the relevant messages first.
2. Extract key decisions, action items, or facts.
3. Use that information to complete the task.

## Tone and output style

- Summaries should be concise — lead with what matters most (decisions, actions, blockers).
- When listing messages, show sender name, time, and message text.
- Never fabricate or assume message content — only work from what the API returns.
- Always confirm before sending a message on the user's behalf.

## Space names

Space names use the format `spaces/XXXXXXX`. Always retrieve this from `list_spaces` rather than asking the user to provide it manually.
