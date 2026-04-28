// Single source of truth for the tool surface exposed to Claude.
// Both runtimes (servers/stdio + remote/HTTP) MUST import this — drift here
// means agents built on one runtime behave differently on the other.

export const TOOLS = [
  {
    name: "list_spaces",
    description: "List all Google Chat spaces and DMs.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_messages",
    description:
      "Get recent messages from a space. Each message can include `thread` (thread resource name), " +
      "`threadKey`, and `inThread` — a space has many threads; use `list_space_threads` to map " +
      "user nicknames to a thread id before replying with `send_message`(..., `threadName`).",
    inputSchema: {
      type: "object",
      properties: {
        spaceName: { type: "string" },
        pageSize: { type: "number" },
        filter: { type: "string" },
      },
      required: ["spaceName"],
    },
  },
  {
    name: "list_space_threads",
    description:
      "Scan recent messages in one space and list distinct conversation threads. " +
      "Google Chat does not provide a single thread title; people refer to the same thread by " +
      "different names — each row has `thread` (canonical id for replies), a text `snippet` " +
      "for matching, and `threadKey` when present. Use before replying in a specific thread.",
    inputSchema: {
      type: "object",
      properties: {
        spaceName: { type: "string" },
        maxPages: {
          type: "number",
          description: "Message pages to scan (~100 messages each). Default 4, max 10.",
        },
      },
      required: ["spaceName"],
    },
  },
  {
    name: "search_messages",
    description:
      "Search messages across ALL spaces the user is in, within a time window (default: last 30 days). " +
      "Fan-out: (1) candidate spaces = every space whose displayName contains the full query or any " +
      "non-trivial token (e.g. \"panic room\" → every Panic Room space, \"ECC\" → every ECC space), " +
      "then grep each in parallel with space labels on results; (2) if no label hits, fall back to " +
      "global text grep across all spaces. Uses server-side createTime filter + paginates up to 600 " +
      "messages per space. If a result is expected but not returned, widen the window via sinceDays.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        pageSize: { type: "number" },
        sinceDays: {
          type: "number",
          description: "Look back this many days (default 30, max 365). Increase for older messages.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to a space. For replies inside a room, set `threadName` to the `thread` " +
      "value from `get_messages` / `search_messages` / `list_space_threads` — not a free-form label. " +
      "Also supports cardsV2, threadKey, messageId (idempotency), replyOption, and privateMessageViewer. " +
      "Set `expectType` (one of DIRECT_MESSAGE, GROUP_CHAT, SPACE) to refuse the send if the resolved " +
      "space's type doesn't match — guards against accidentally posting a 1:1 DM into a team room or " +
      "vice-versa when name resolution returned the wrong space.",
    inputSchema: {
      type: "object",
      properties: {
        spaceName: { type: "string" },
        text: { type: "string" },
        cardsV2: { type: "array" },
        threadName: { type: "string" },
        threadKey: { type: "string" },
        replyOption: { type: "string" },
        messageId: { type: "string" },
        privateToUserId: { type: "string" },
        expectType: {
          type: "string",
          enum: ["DIRECT_MESSAGE", "GROUP_CHAT", "SPACE"],
          description: "Required space type. Send is refused with a clear error if the actual type differs.",
        },
      },
      required: ["spaceName"],
    },
  },
  {
    name: "get_space",
    description: "Get details about a space including members (for DMs).",
    inputSchema: {
      type: "object",
      properties: { spaceName: { type: "string" } },
      required: ["spaceName"],
    },
  },
  {
    name: "find_dm",
    description:
      "Find a person's DM space by name or nickname. " +
      "If multiple DMs or directory entries match, returns found='ambiguous' with candidate lists — never guess. " +
      "Use before send_message when you only know a name.",
    inputSchema: {
      type: "object",
      properties: { personName: { type: "string" } },
      required: ["personName"],
    },
  },
  {
    name: "send_to_person",
    description:
      "Send a DM to a person by name — resolves their space when unambiguous. " +
      "If several people or DMs match, returns an error listing candidates; do not send until the user picks one. " +
      "Use when user says 'send X to [person name]'.",
    inputSchema: {
      type: "object",
      properties: {
        personName: { type: "string" },
        text: { type: "string" },
        cardsV2: { type: "array" },
        threadName: { type: "string" },
        messageId: { type: "string" },
      },
      required: ["personName"],
    },
  },
  {
    name: "get_message",
    description: "Get a single message by its full resource name (e.g. spaces/ABC/messages/XYZ).",
    inputSchema: {
      type: "object",
      properties: { messageName: { type: "string" } },
      required: ["messageName"],
    },
  },
  {
    name: "edit_message",
    description: "Edit the text or cardsV2 content of an existing message.",
    inputSchema: {
      type: "object",
      properties: {
        messageName: { type: "string" },
        text: { type: "string" },
        cardsV2: { type: "array" },
      },
      required: ["messageName"],
    },
  },
  {
    name: "delete_message",
    description: "Delete a message by its full resource name.",
    inputSchema: {
      type: "object",
      properties: { messageName: { type: "string" } },
      required: ["messageName"],
    },
  },
  {
    name: "get_members",
    description: "List members of a space with role, state, and isSelf flag.",
    inputSchema: {
      type: "object",
      properties: {
        spaceName: { type: "string" },
        pageSize: { type: "number" },
      },
      required: ["spaceName"],
    },
  },
  {
    name: "whoami",
    description:
      "Return the authenticated caller's identity (email, displayName, userId). " +
      "Use when unsure which account is authenticated or to debug DM self-filtering.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "refresh_cache",
    description: "Force-refresh the spaces, members, and name cache.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "debug_dm_resolution",
    description: "Diagnostic tool: forces a fresh DM-name resolution pass and returns counters.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];
