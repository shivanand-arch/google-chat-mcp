// Extracts display names from USER_MENTION annotations on Chat messages.
// Under user auth, the Chat API omits sender.displayName on messages.list/get,
// but USER_MENTION annotations carry the mentioned user's ID + text position,
// so anyone @mentioned becomes resolvable for free — no extra scope needed.

export function harvestAnnotations(messages, map) {
  for (const m of messages || []) {
    if (!m.annotations || !m.text) continue;
    for (const a of m.annotations) {
      if (a.type !== "USER_MENTION") continue;
      const id = a.userMention?.user?.name;
      if (!id) continue;
      const si = Number(a.startIndex) || 0;
      const len = Number(a.length) || 0;
      if (len <= 1) continue;
      const mention = m.text.substring(si, si + len);
      const name = mention.startsWith("@") ? mention.slice(1).trim() : mention.trim();
      if (name && !map[id]) map[id] = name;
    }
  }
}

export function spaceNameFromMessage(messageName) {
  const m = /^(spaces\/[^/]+)\//.exec(messageName || "");
  return m ? m[1] : null;
}
