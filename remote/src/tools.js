// MCP tool implementations — ported from servers/server.js.
// Per-request: a Google Chat client is built from the calling user's Google
// access token. Token refresh is handled transparently via googleapis.

import { google } from "googleapis";

function makeChatClient({ google: g, googleClientId, googleClientSecret }) {
  const oauth2 = new google.auth.OAuth2(googleClientId, googleClientSecret);
  oauth2.setCredentials({
    access_token: g.accessToken,
    refresh_token: g.refreshToken,
    expiry_date: g.expiresAt,
  });
  return google.chat({ version: "v1", auth: oauth2 });
}

const formatMessage = (msg) => ({
  name: msg.name,
  text: msg.text || "(no text)",
  sender: msg.sender?.displayName || msg.sender?.name || "Unknown",
  createTime: msg.createTime,
  thread: msg.thread?.name,
});
const formatSpace = (s) => ({
  name: s.name,
  displayName: s.displayName || s.name,
  type: s.spaceType || s.type,
});

// Simple per-session cache so repeated tool calls don't re-list spaces.
function makeSessionCache() {
  return { spaces: null, nameCache: null };
}

async function ensureSpacesRaw(chat, cache) {
  if (!cache.spaces) {
    const all = [];
    let pageToken;
    do {
      const res = await chat.spaces.list({ pageSize: 1000, pageToken });
      if (res.data.spaces) all.push(...res.data.spaces);
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    cache.spaces = all;
  }
  return cache.spaces;
}

async function listSpaces(chat, cache) {
  const spaces = await ensureSpacesRaw(chat, cache);
  return spaces.map(formatSpace);
}

function addToCache(cache, name, spaceName, type, displayName) {
  if (!name) return;
  const lower = name.toLowerCase().trim();
  if (!lower || lower.startsWith("spaces/")) return;
  const entry = { spaceName, type, displayName };
  cache[lower] = entry;
  for (const word of lower.split(/[\s\/,:\-]+/).filter((w) => w.length > 1)) {
    if (!cache[word]) cache[word] = entry;
  }
}

async function buildNameCache(chat, cache) {
  const spaces = await ensureSpacesRaw(chat, cache);
  const nc = {};

  // 1. Resolve DM names first so their first-name tokens (e.g. "priya") win
  //    over any same-named keyword in a group space.
  const dmSpaces = spaces.filter(
    (s) => (s.spaceType || s.type) === "DIRECT_MESSAGE" && (!s.displayName || s.displayName.startsWith("spaces/")),
  );
  if (dmSpaces.length > 0) {
    const results = await Promise.allSettled(
      dmSpaces.map(async (space) => {
        const r = await chat.spaces.members.list({ parent: space.name, pageSize: 20 });
        return { space, members: r.data.memberships || [] };
      }),
    );

    // Count name frequency: caller appears in every DM, so frequency > 1 => self.
    const freq = {};
    const perSpace = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const names = [];
      for (const m of r.value.members) {
        const n = m.member?.displayName;
        if (n) { names.push(n); freq[n] = (freq[n] || 0) + 1; }
      }
      perSpace.push({ space: r.value.space, names });
    }
    const selfNames = new Set(Object.entries(freq).filter(([_, c]) => c > 1).map(([n]) => n));

    for (const { space, names } of perSpace) {
      const others = names.filter((n) => !selfNames.has(n));
      for (const n of others) addToCache(nc, n, space.name, "DIRECT_MESSAGE", n);
    }
  }

  // 2. Then group/named spaces. Full-name keys still set; word-level keys only
  //    if the DM hasn't already claimed them.
  for (const s of spaces) {
    const type = s.spaceType || s.type;
    const dn = s.displayName || "";
    if (dn && !dn.startsWith("spaces/")) addToCache(nc, dn, s.name, type, dn);
  }

  cache.nameCache = nc;
  return nc;
}

function fuzzyMatch(query, key) {
  if (key.includes(query) || query.includes(key)) return true;
  const words = query.split(/\s+/).filter((w) => w.length > 1);
  if (words.length > 0 && words.every((w) => key.includes(w))) return true;
  if (words.some((w) => key.includes(w) && w.length >= 3)) return true;
  return false;
}

async function findSpaceByName(chat, cache, personName, { dmOnly = false } = {}) {
  if (!cache.nameCache) await buildNameCache(chat, cache);
  const q = personName.toLowerCase().trim();
  if (cache.nameCache[q]) {
    const e = cache.nameCache[q];
    if (!dmOnly || e.type === "DIRECT_MESSAGE") return e.spaceName;
  }
  const matches = [];
  for (const [key, entry] of Object.entries(cache.nameCache)) {
    if (dmOnly && entry.type !== "DIRECT_MESSAGE") continue;
    if (fuzzyMatch(q, key)) matches.push({ key, ...entry });
  }
  if (matches.length === 1) return matches[0].spaceName;
  if (matches.length > 1) return matches.sort((a, b) => a.key.length - b.key.length)[0].spaceName;
  return null;
}

async function getMessages(chat, _cache, { spaceName, pageSize = 25, filter = "" }) {
  const params = { parent: spaceName, pageSize, orderBy: "createTime desc" };
  if (filter) params.filter = filter;
  const res = await chat.spaces.messages.list(params);
  return (res.data.messages || []).map(formatMessage);
}

async function searchMessages(chat, cache, { query, pageSize = 25 }) {
  const spaces = await ensureSpacesRaw(chat, cache);
  const lower = query.toLowerCase();
  const matching = spaces.find((s) => {
    const dn = (s.displayName || "").toLowerCase();
    if (!dn || dn.startsWith("spaces/")) return false;
    return dn.includes(lower) || lower.includes(dn) ||
      lower.split(/\s+/).every((w) => w.length > 1 && dn.includes(w));
  });
  if (matching) {
    const r = await chat.spaces.messages.list({ parent: matching.name, pageSize, orderBy: "createTime desc" });
    return (r.data.messages || []).map((m) => ({ ...formatMessage(m), space: matching.displayName || matching.name }));
  }
  const results = [];
  await Promise.allSettled(spaces.map(async (space) => {
    try {
      const r = await chat.spaces.messages.list({ parent: space.name, pageSize: 50, orderBy: "createTime desc" });
      for (const m of r.data.messages || []) {
        if (m.text && m.text.toLowerCase().includes(lower))
          results.push({ ...formatMessage(m), space: space.displayName || space.name });
      }
    } catch {}
  }));
  results.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
  return results.slice(0, pageSize);
}

async function sendMessage(chat, _cache, { spaceName, text, threadName }) {
  const body = { text };
  if (threadName) body.thread = { name: threadName };
  const res = await chat.spaces.messages.create({
    parent: spaceName, requestBody: body,
    messageReplyOption: threadName ? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : undefined,
  });
  return formatMessage(res.data);
}

async function getSpace(chat, _cache, { spaceName }) {
  const res = await chat.spaces.get({ name: spaceName });
  return formatSpace(res.data);
}

async function findDm(chat, cache, { personName }) {
  const spaceName = await findSpaceByName(chat, cache, personName, { dmOnly: true });
  if (!spaceName) {
    if (!cache.nameCache) await buildNameCache(chat, cache);
    const available = Object.entries(cache.nameCache)
      .filter(([k, v]) => k.length > 2 && v.type === "DIRECT_MESSAGE")
      .map(([_, v]) => v.displayName)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 50);
    return { found: false, message: `No DM found for "${personName}"`, availableDMs: available };
  }
  return { found: true, spaceName };
}

async function sendToPerson(chat, cache, { personName, text, threadName }) {
  const spaceName = await findSpaceByName(chat, cache, personName, { dmOnly: true });
  if (!spaceName) {
    if (!cache.nameCache) await buildNameCache(chat, cache);
    const names = Object.entries(cache.nameCache)
      .filter(([k, v]) => k.length > 2 && v.type === "DIRECT_MESSAGE")
      .map(([k]) => k)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(", ");
    throw new Error(`No DM found for "${personName}". Available DMs: ${names}`);
  }
  return await sendMessage(chat, cache, { spaceName, text, threadName });
}

export const TOOLS = [
  { name: "list_spaces", description: "List all Google Chat spaces and DMs.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "get_messages", description: "Get recent messages from a space.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, pageSize: { type: "number" }, filter: { type: "string" } }, required: ["spaceName"] } },
  { name: "search_messages", description: "Search messages across ALL spaces in parallel. If the query matches a space/group name, returns messages from that space. Otherwise searches message text across all spaces.", inputSchema: { type: "object", properties: { query: { type: "string" }, pageSize: { type: "number" } }, required: ["query"] } },
  { name: "send_message", description: "Send a message to a space by space name.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, text: { type: "string" }, threadName: { type: "string" } }, required: ["spaceName", "text"] } },
  { name: "get_space", description: "Get details about a space.", inputSchema: { type: "object", properties: { spaceName: { type: "string" } }, required: ["spaceName"] } },
  { name: "find_dm", description: "Find a person's DM space by name or nickname. Use before send_message when you only know a name.", inputSchema: { type: "object", properties: { personName: { type: "string" } }, required: ["personName"] } },
  { name: "send_to_person", description: "Send a DM to a person by name — resolves their space automatically. Use when user says 'send X to [person name]'.", inputSchema: { type: "object", properties: { personName: { type: "string" }, text: { type: "string" }, threadName: { type: "string" } }, required: ["personName", "text"] } },
];

const HANDLERS = {
  list_spaces: listSpaces,
  get_messages: getMessages,
  search_messages: searchMessages,
  send_message: sendMessage,
  get_space: getSpace,
  find_dm: findDm,
  send_to_person: sendToPerson,
};

export async function callTool({ name, args, session, googleClientId, googleClientSecret }) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  const chat = makeChatClient({ google: session.google, googleClientId, googleClientSecret });
  session.cache ||= makeSessionCache();
  return await handler(chat, session.cache, args || {});
}
