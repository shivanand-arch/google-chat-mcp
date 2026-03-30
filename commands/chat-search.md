---
description: Search Google Chat messages for a keyword or phrase
allowed-tools: mcp__google-chat__list_spaces, mcp__google-chat__search_messages, mcp__google-chat__get_space
argument-hint: <keyword or phrase>
---

Search Google Chat for messages matching the query: $ARGUMENTS

1. Call `search_messages` with the query from $ARGUMENTS (pageSize: 25).
2. Group results by space.
3. For each result, show:
   - Space name
   - Sender name
   - Message time
   - The relevant message text (quote directly, keep it brief)
4. If no results are found, say so clearly and suggest alternative search terms.
5. If the results suggest a longer conversation the user might want to read, offer to retrieve the full thread.

Do not fabricate or paraphrase message content — show exactly what was said.
