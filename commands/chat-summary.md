---
description: Summarise unread/recent messages across Chat spaces
allowed-tools: mcp__google-chat__list_spaces, mcp__google-chat__get_messages
argument-hint: [space name or "all"]
---

Summarise recent Google Chat activity for the user.

If $ARGUMENTS specifies a space name or keyword, find the matching space using `list_spaces` and summarise messages from that space.

If $ARGUMENTS is empty or "all", call `list_spaces`, then call `get_messages` for each of the top 5 most recently active spaces (pageSize: 25). Skip spaces with no messages.

For each space with activity, produce a concise summary:
- **Space name**
- Key topics discussed
- Any decisions made
- Any open questions or action items
- Names of active participants

Lead with the most important information. Keep each space summary to 3-5 sentences unless there is a lot of significant content.

End with a one-sentence overall summary of what needs the user's attention most.
