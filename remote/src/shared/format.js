// Pure formatters for Chat resources. Never leaks the raw space ID as a
// displayName — the LLM may render that ID as if it were a person's name
// in summaries. Use a generic placeholder instead.

/**
 * Normalized message for MCP output. A space can contain many threads; the same
 * thread is always identified by `thread` (resource name). `threadKey` (when
 * present) can be used with `send_message`. Users often describe threads with
 * multiple informal names — that text must be matched in `get_messages` or
 * `search_messages` / `list_space_threads`, not used as a bare `threadName`.
 */
export function formatMessage(msg, senderMap = {}) {
  const id = msg.sender?.name;
  const threadName = msg.thread?.name;
  return {
    name: msg.name,
    text: msg.text || "(no text)",
    sender: msg.sender?.displayName || senderMap[id] || id || "Unknown",
    senderId: id,
    createTime: msg.createTime,
    thread: threadName,
    threadKey: msg.thread?.threadKey ?? null,
    inThread: Boolean(threadName),
  };
}

// `ctx` carries the DM enrichment maps owned by the caller (runtime-specific):
//   { dmLabels: { [spaceName]: "Name A, Name B" },
//     dmMembers: { [spaceName]: ["Name A", "Name B"] } }
export function formatSpace(space, ctx = {}) {
  const type = space.spaceType || space.type;
  const raw = space.displayName || "";
  let displayName = raw && !raw.startsWith("spaces/") ? raw : "";
  const label = ctx.dmLabels?.[space.name];
  if (!displayName && type === "DIRECT_MESSAGE" && label) {
    displayName = `DM: ${label}`;
  }
  if (!displayName) {
    displayName = type === "DIRECT_MESSAGE" ? "DM (unresolved)" : "Unnamed space";
  }
  const out = { name: space.name, displayName, type };
  if (type === "DIRECT_MESSAGE" && label) out.otherMember = label;
  const members = ctx.dmMembers?.[space.name];
  if (type === "DIRECT_MESSAGE" && members?.length) out.members = members;
  return out;
}
