---
description: Send a message to a Google Chat space or DM
allowed-tools: mcp__google-chat__list_spaces, mcp__google-chat__send_message
argument-hint: <space name> | <message text>
---

Send a message to a Google Chat space on the user's behalf.

Parse $ARGUMENTS to extract the destination and message. The format may be:
- "to [space/person name]: [message]"
- "[space/person name] | [message]"
- Or free-form — use judgment to identify the destination and message.

Steps:
1. Call `list_spaces` to find the matching space by display name or type (DM vs room).
2. If multiple spaces match, ask the user to clarify before proceeding.
3. Show the user exactly what will be sent and to which space. Ask for confirmation before proceeding.
4. Once confirmed, call `send_message` with the spaceName and text.
5. Confirm the message was sent successfully.

Never send a message without explicit user confirmation in the current conversation.
