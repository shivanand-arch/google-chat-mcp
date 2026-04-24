// MCP tool implementations — ported from servers/server.js.
// Per-request: a Google Chat client is built from the calling user's Google
// access token. Token refresh is handled transparently via googleapis.

import { google } from "googleapis";
import { readFileSync } from "fs";
import { homedir } from "os";

// ── Employee directory email index (written by /employee-directory skill) ──
const EMAIL_INDEX_PATH = `${homedir()}/.claude/skills/employee-directory/data/email_index.json`;
let _emailIndex = null;
function getEmailIndex() {
  if (_emailIndex) return _emailIndex;
  try {
    _emailIndex = JSON.parse(readFileSync(EMAIL_INDEX_PATH, "utf8"));
  } catch {
    _emailIndex = {};
  }
  return _emailIndex;
}
function lookupEmailFromDirectory(personName) {
  const index = getEmailIndex();
  const query = personName.toLowerCase().trim();
  if (index[query]) return index[query];
  for (const [name, email] of Object.entries(index)) {
    const nameParts = name.split(" ");
    const queryParts = query.split(" ");
    if (queryParts.every((qp) => nameParts.some((np) => np.startsWith(qp)))) {
      return email;
    }
  }
  return null;
}

function makeChatClient({ google: g, googleClientId, googleClientSecret }) {
  const oauth2 = new google.auth.OAuth2(googleClientId, googleClientSecret);
  oauth2.setCredentials({
    access_token: g.accessToken,
    refresh_token: g.refreshToken,
    expiry_date: g.expiresAt,
  });
  return google.chat({ version: "v1", auth: oauth2 });
}

// ── Input validation (ported from googleworkspace/cli validate.rs) ──
function isDangerousUnicode(code) {
  return (code >= 0x200B && code <= 0x200D) ||
    code === 0xFEFF ||
    (code >= 0x202A && code <= 0x202E) ||
    (code >= 0x2028 && code <= 0x2029) ||
    (code >= 0x2066 && code <= 0x2069);
}
function validateResourceName(s, label = "name") {
  if (!s || typeof s !== "string") throw new Error(`${label} must be a non-empty string`);
  if (s.split("/").some(seg => seg === ".."))
    throw new Error(`${label} must not contain path traversal ('..'): "${s}"`);
  if (s.includes("?") || s.includes("#"))
    throw new Error(`${label} must not contain '?' or '#': "${s}"`);
  if (s.includes("%"))
    throw new Error(`${label} must not contain '%' (URL-encoding bypass): "${s}"`);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0 || code < 0x20 || (code >= 0x7F && code <= 0x9F))
      throw new Error(`${label} must not contain control chars: "${s}"`);
    if (isDangerousUnicode(code))
      throw new Error(`${label} must not contain invisible/bidi Unicode: "${s}"`);
  }
  return s;
}

// ── Retry with exponential backoff + jitter on 429/5xx ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, { label = "api-call", maxAttempts = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      const code = err?.code || err?.response?.status;
      const retryable = code === 429 || (code >= 500 && code < 600);
      if (!retryable || attempt === maxAttempts) break;
      const retryAfterHdr = err?.response?.headers?.["retry-after"];
      const retryAfterMs = retryAfterHdr && !isNaN(+retryAfterHdr) ? +retryAfterHdr * 1000 : 0;
      const backoff = Math.min(30000, 500 * Math.pow(2, attempt - 1));
      const delay = Math.max(retryAfterMs, backoff) + Math.random() * 250;
      console.log(`[retry] ${label} ${code} attempt ${attempt}/${maxAttempts} waiting ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ── Structured error normalization ──
function normalizeApiError(err) {
  const data = err?.response?.data;
  if (!data) return { message: err.message || String(err) };
  const inner = data.error || data;
  const out = {
    code: inner.code ?? err.code,
    status: inner.status,
    message: inner.message || err.message,
    reason: inner.errors?.[0]?.reason || inner.reason,
  };
  if (out.reason === "accessNotConfigured" && typeof out.message === "string") {
    const m = out.message.match(/visiting\s+(https?:\/\/\S+?)[.,;:)\]"']?(?:\s|$)/);
    if (m) out.enableUrl = m[1];
  }
  return out;
}
function formatApiError(err) {
  const n = normalizeApiError(err);
  const parts = [];
  if (n.code) parts.push(`[${n.code}${n.status ? " " + n.status : ""}]`);
  if (n.reason) parts.push(`(${n.reason})`);
  parts.push(n.message || "Unknown error");
  if (n.enableUrl) parts.push(`→ Enable it at: ${n.enableUrl}`);
  return parts.join(" ");
}

// Authoritative self check via OAuth session identity.
function isSelfMember(member, cache) {
  const id = cache?.selfIdentity;
  if (!id) return false;
  const dn = member?.member?.displayName || member?.displayName || "";
  const uid = member?.member?.name || "";
  if (id.name && dn && dn === id.name) return true;
  if (id.userId && uid === `users/${id.userId}`) return true;
  return false;
}

const formatMessage = (msg, senderMap = {}) => {
  const id = msg.sender?.name;
  return {
    name: msg.name,
    text: msg.text || "(no text)",
    sender: msg.sender?.displayName || senderMap[id] || id || "Unknown",
    senderId: id,
    createTime: msg.createTime,
    thread: msg.thread?.name,
  };
};
// Format a Google Chat space. Never leaks the raw space ID as displayName —
// the LLM may render that ID as if it were a person's name in summaries.
function formatSpace(s, cache) {
  const type = s.spaceType || s.type;
  const raw = s.displayName || "";
  let displayName = raw && !raw.startsWith("spaces/") ? raw : "";
  const label = cache?.dmLabels?.[s.name];
  if (!displayName && type === "DIRECT_MESSAGE" && label) {
    displayName = `DM: ${label}`;
  }
  if (!displayName) {
    displayName = type === "DIRECT_MESSAGE" ? "DM (unresolved)" : "Unnamed space";
  }
  const out = { name: s.name, displayName, type };
  if (type === "DIRECT_MESSAGE" && label) out.otherMember = label;
  const members = cache?.dmMembers?.[s.name];
  if (type === "DIRECT_MESSAGE" && members?.length) out.members = members;
  return out;
}

// Per-session cache so repeated tool calls don't re-list spaces.
// In-process only (intentionally) — a Map here decouples cache lifetime from
// OAuth access-token rotation and from Redis round-trips on the storage layer.
// Keyed by the Google refresh token because it's stable per user+grant.
function makeSessionCache() {
  return {
    spaces: null,
    nameCache: null,
    dmLabels: {},
    dmMembers: {},
    senderMaps: {}, // spaceName → { "users/XXX": "Display Name" }
    selfNames: new Set(),
    selfIdentity: null, // { userId, email, name, source }
  };
}

const sessionCaches = new Map();

function getOrCreateCache(session) {
  const key = session?.google?.refreshToken || session?.user?.sub || "anonymous";
  let cache = sessionCaches.get(key);
  if (!cache) {
    cache = makeSessionCache();
    if (session?.user) {
      cache.selfIdentity = {
        userId: session.user.sub,
        email: session.user.email,
        name: session.user.name,
        source: "oauth-session",
      };
      if (session.user.name) cache.selfNames.add(session.user.name);
    }
    sessionCaches.set(key, cache);
  }
  return cache;
}

// Resolve users/XXX → "Display Name" for one space. The Chat API does NOT
// populate sender.displayName on messages.list/get under user auth — only
// name + type. We call members.list to enrich. Cached per space on the session.
// Chat API omits sender.displayName under user-auth. USER_MENTION annotations
// on messages carry the mentioned user's ID + text position — anyone @mentioned
// in the space becomes resolvable for free, no extra scope needed.
function harvestAnnotations(messages, map) {
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

async function ensureSenderMap(chat, cache, spaceName) {
  if (!cache.senderMaps) cache.senderMaps = {};
  if (cache.senderMaps[spaceName]) return cache.senderMaps[spaceName];
  const map = {};
  try {
    const res = await withRetry(
      () => chat.spaces.messages.list({ parent: spaceName, pageSize: 200, orderBy: "createTime desc" }),
      { label: `messages.list(sender-warmup:${spaceName})`, maxAttempts: 2 },
    );
    harvestAnnotations(res.data.messages || [], map);
  } catch (err) {
    console.log("[senderMap.err]", JSON.stringify({ spaceName, error: err?.message }));
  }
  cache.senderMaps[spaceName] = map;
  return map;
}

// Derive the parent space from a message resource name like
// "spaces/AAA/messages/BBB.CCC" → "spaces/AAA".
function spaceNameFromMessage(messageName) {
  const m = /^(spaces\/[^/]+)\//.exec(messageName || "");
  return m ? m[1] : null;
}

async function ensureSpacesRaw(chat, cache) {
  if (!cache.spaces) {
    const all = [];
    let pageToken;
    do {
      const res = await withRetry(
        () => chat.spaces.list({ pageSize: 1000, pageToken }),
        { label: "spaces.list" },
      );
      if (res.data.spaces) all.push(...res.data.spaces);
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    cache.spaces = all;
  }
  return cache.spaces;
}

async function listSpaces(chat, cache) {
  // Trigger DM-member resolution so DM displayNames are useful strings.
  if (!cache.nameCache) await buildNameCache(chat, cache);
  const spaces = await ensureSpacesRaw(chat, cache);
  return spaces.map((s) => formatSpace(s, cache));
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
  const dmLabels = {}; // spaceName → "Person A, Person B" (non-self members)

  // 1. Resolve DM names first so their first-name tokens (e.g. "priya") win
  //    over any same-named keyword in a group space.
  const dmSpaces = spaces.filter(
    (s) => (s.spaceType || s.type) === "DIRECT_MESSAGE" && (!s.displayName || s.displayName.startsWith("spaces/")),
  );
  const diag = {
    spacesTotal: spaces.length,
    dmSpacesUnnamed: dmSpaces.length,
    memberListOk: 0,
    memberListErr: 0,
    firstError: null,
    firstErrorStatus: null,
    firstSampleMember: null,
    selfNamesCount: 0,
    dmLabelsCount: 0,
  };
  if (dmSpaces.length > 0) {
    const results = await Promise.allSettled(
      dmSpaces.map(async (space) => {
        const r = await withRetry(
          () => chat.spaces.members.list({ parent: space.name, pageSize: 20 }),
          { label: `members.list(${space.name})` },
        );
        return { space, members: r.data.memberships || [] };
      }),
    );

    // Primary signal: userId match via selfIdentity (authoritative, from OAuth session).
    // Fallback: frequency — the caller appears in every DM.
    const freq = {};
    const perSpace = [];
    const allMembersPerSpace = {};
    for (const r of results) {
      if (r.status !== "fulfilled") {
        diag.memberListErr++;
        if (!diag.firstError) {
          diag.firstError = r.reason?.message || String(r.reason);
          diag.firstErrorStatus = r.reason?.response?.status || r.reason?.code || null;
        }
        continue;
      }
      diag.memberListOk++;
      const names = [];
      const allNames = [];
      for (const m of r.value.members) {
        if (!diag.firstSampleMember) {
          diag.firstSampleMember = {
            hasMember: !!m.member,
            memberKeys: m.member ? Object.keys(m.member) : [],
            displayName: m.member?.displayName || null,
            memberName: m.member?.name || null,
            memberType: m.member?.type || null,
          };
        }
        const n = m.member?.displayName;
        if (!n) continue;
        allNames.push(n);
        if (isSelfMember(m, cache)) { cache.selfNames.add(n); continue; }
        names.push(n);
        freq[n] = (freq[n] || 0) + 1;
      }
      allMembersPerSpace[r.value.space.name] = allNames;
      perSpace.push({ space: r.value.space, names });
    }
    // Fallback heuristic only if authoritative identity hasn't resolved self.
    if (cache.selfNames.size === 0) {
      const detected = Object.entries(freq).filter(([, c]) => c > 1).map(([n]) => n);
      for (const n of detected) cache.selfNames.add(n);
    }
    diag.selfNamesCount = cache.selfNames.size;
    diag.selfSource = cache.selfIdentity?.source || "frequency";

    for (const { space, names } of perSpace) {
      const others = names.filter((n) => !cache.selfNames.has(n));
      const allNames = allMembersPerSpace[space.name] || [];
      const labelNames = others.length ? others : allNames;
      for (const n of others) addToCache(nc, n, space.name, "DIRECT_MESSAGE", n);
      if (labelNames.length) dmLabels[space.name] = labelNames.join(", ");
      cache.dmMembers[space.name] = allNames;
    }
  }

  diag.dmLabelsCount = Object.keys(dmLabels).length;
  console.log("[buildNameCache]", JSON.stringify(diag));

  // 2. Then group/named spaces. Full-name keys still set; word-level keys only
  //    if the DM hasn't already claimed them.
  for (const s of spaces) {
    const type = s.spaceType || s.type;
    const dn = s.displayName || "";
    if (dn && !dn.startsWith("spaces/")) addToCache(nc, dn, s.name, type, dn);
  }

  cache.nameCache = nc;
  cache.dmLabels = dmLabels;
  cache.lastDiag = diag;
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

async function getMessages(chat, cache, { spaceName, pageSize = 25, filter = "" }) {
  validateResourceName(spaceName, "spaceName");
  const params = { parent: spaceName, pageSize, orderBy: "createTime desc" };
  if (filter) params.filter = filter;
  const [res, senderMap] = await Promise.all([
    withRetry(() => chat.spaces.messages.list(params), { label: "messages.list" }),
    ensureSenderMap(chat, cache, spaceName),
  ]);
  const messages = res.data.messages || [];
  harvestAnnotations(messages, senderMap);
  return messages.map((m) => formatMessage(m, senderMap));
}

async function getMessage(chat, cache, { messageName }) {
  validateResourceName(messageName, "messageName");
  const res = await withRetry(
    () => chat.spaces.messages.get({ name: messageName }),
    { label: "messages.get" },
  );
  const spaceName = spaceNameFromMessage(res.data?.name);
  const senderMap = spaceName ? await ensureSenderMap(chat, cache, spaceName) : {};
  return formatMessage(res.data, senderMap);
}

async function editMessage(chat, _cache, { messageName, text, cardsV2 }) {
  validateResourceName(messageName, "messageName");
  const body = {};
  const mask = [];
  if (text !== undefined) { body.text = text; mask.push("text"); }
  if (cardsV2 !== undefined) { body.cardsV2 = cardsV2; mask.push("cards_v2"); }
  if (mask.length === 0) throw new Error("edit_message requires text or cardsV2");
  const res = await withRetry(
    () => chat.spaces.messages.patch({
      name: messageName,
      updateMask: mask.join(","),
      requestBody: body,
    }),
    { label: "messages.patch" },
  );
  return formatMessage(res.data);
}

async function deleteMessage(chat, _cache, { messageName }) {
  validateResourceName(messageName, "messageName");
  await withRetry(
    () => chat.spaces.messages.delete({ name: messageName }),
    { label: "messages.delete" },
  );
  return { deleted: true, messageName };
}

async function getMembers(chat, cache, { spaceName, pageSize = 50 }) {
  validateResourceName(spaceName, "spaceName");
  const res = await withRetry(
    () => chat.spaces.members.list({ parent: spaceName, pageSize }),
    { label: "members.list" },
  );
  return (res.data.memberships || []).map((m) => ({
    name: m.name,
    state: m.state,
    role: m.role,
    memberName: m.member?.name,
    displayName: m.member?.displayName,
    type: m.member?.type,
    isSelf: isSelfMember(m, cache),
  }));
}

async function whoami(_chat, cache) {
  if (cache.selfIdentity) return cache.selfIdentity;
  return {
    source: cache.selfNames.size > 0 ? "frequency" : "unknown",
    inferredNames: [...cache.selfNames],
    hint: cache.selfNames.size === 0
      ? "OAuth session is missing user info — reconnect the connector on claude.ai."
      : undefined,
  };
}

async function refreshCache(chat, cache) {
  cache.spaces = null;
  cache.nameCache = null;
  cache.dmLabels = {};
  cache.dmMembers = {};
  cache.senderMaps = {};
  cache.selfNames = new Set();
  // keep selfIdentity from OAuth session — it doesn't change per call.
  if (cache.selfIdentity?.name) cache.selfNames.add(cache.selfIdentity.name);
  await buildNameCache(chat, cache);
  return { refreshed: true, spaces: cache.spaces.length, self: cache.selfIdentity };
}

// Tokens too short or too common to be meaningful name-matches.
const SEARCH_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "at", "by", "with",
]);
// Accuracy > economy: don't cap fan-out. If 50 spaces match "ECC", we search all 50.
// (withRetry + allSettled absorbs rate-limit blips; the caller can always narrow the query.)
const SEARCH_API_PAGE_SIZE = 100;           // messages per API page
const SEARCH_MAX_PAGES_PER_SPACE = 6;       // per-space hard stop: 6 × 100 = 600 messages
const SEARCH_TOTAL_MSG_BUDGET = 20000;      // org-wide safety net across all scanned spaces
const SEARCH_RESULT_HARD_CAP = 200;         // ceiling on consolidated hits returned to caller
const SEARCH_DEFAULT_SINCE_DAYS = 30;       // default time window for text grep
const SEARCH_MAX_SINCE_DAYS = 365;          // clamp to protect runtime

function tokenizeQuery(lower) {
  const toks = lower.split(/\s+/).filter((t) => t.length >= 2 && !SEARCH_STOPWORDS.has(t));
  return toks.length ? toks : [lower];
}

// Paginate through messages in a space within the time window, up to per-space cap.
// Filters server-side via Google Chat API's `filter: "createTime > ..."` so quiet
// spaces cost ~1 page, not 6. textFilter=false collects all messages (browse mode).
async function scanSpaceForText(chat, space, { lower, timeFilter, textFilter = true, budget }) {
  const hits = [];
  let pageToken;
  let pages = 0;
  let truncated = false;
  do {
    const params = {
      parent: space.name,
      pageSize: SEARCH_API_PAGE_SIZE,
      orderBy: "createTime desc",
    };
    if (pageToken) params.pageToken = pageToken;
    if (timeFilter) params.filter = timeFilter;
    const r = await withRetry(
      () => chat.spaces.messages.list(params),
      { label: `messages.list(${space.name})`, maxAttempts: 2 },
    );
    const msgs = r.data.messages || [];
    pages++;
    for (const m of msgs) {
      if (!textFilter) hits.push(m);
      else if (m.text && m.text.toLowerCase().includes(lower)) hits.push(m);
    }
    if (budget) {
      budget.remaining -= msgs.length;
      if (budget.remaining <= 0) { truncated = true; break; }
    }
    pageToken = r.data.nextPageToken;
    if (pages >= SEARCH_MAX_PAGES_PER_SPACE) { truncated = !!pageToken; break; }
  } while (pageToken);
  return { hits, pages, truncated };
}

async function searchMessages(chat, cache, { query, pageSize = 25, sinceDays }) {
  const spaces = await ensureSpacesRaw(chat, cache);
  const lower = query.toLowerCase();
  const qTokens = tokenizeQuery(lower);

  const effectiveDays = Math.min(
    SEARCH_MAX_SINCE_DAYS,
    Math.max(1, sinceDays ?? SEARCH_DEFAULT_SINCE_DAYS),
  );
  const sinceIso = new Date(Date.now() - effectiveDays * 86400000).toISOString();
  const timeFilter = `createTime > "${sinceIso}"`;
  const budget = { remaining: SEARCH_TOTAL_MSG_BUDGET };

  // Candidate set = every space whose displayName contains the full query OR any non-trivial token.
  // For queries like "panic room" / "ECC" / "RCA" this returns ALL label-matches, not a picked winner.
  const targets = spaces.filter((s) => {
    const dn = (s.displayName || "").toLowerCase();
    if (!dn || dn.startsWith("spaces/")) return false;
    if (dn.includes(lower)) return true;
    return qTokens.some((t) => dn.includes(t));
  });

  const results = [];
  const seen = new Set();
  const pushHit = (m, space, senderMap) => {
    if (seen.has(m.name)) return;
    seen.add(m.name);
    results.push({ ...formatMessage(m, senderMap), space: space.displayName || space.name });
  };

  if (targets.length > 0) {
    // Exactly one space with the full query as a displayName substring → browse mode
    // (return newest pageSize messages from that space, no text or time filter).
    const soloBrowse = targets.length === 1 && targets[0].displayName &&
      targets[0].displayName.toLowerCase().includes(lower);

    if (soloBrowse) {
      const space = targets[0];
      const r = await withRetry(
        () => chat.spaces.messages.list({ parent: space.name, pageSize, orderBy: "createTime desc" }),
        { label: `messages.list(${space.name})`, maxAttempts: 2 },
      );
      const senderMap = await ensureSenderMap(chat, cache, space.name);
      for (const m of r.data.messages || []) pushHit(m, space, senderMap);
      return results.slice(0, pageSize);
    }

    await Promise.allSettled(targets.map(async (space) => {
      try {
        const { hits } = await scanSpaceForText(chat, space, { lower, timeFilter, textFilter: true, budget });
        if (!hits.length) return;
        const senderMap = await ensureSenderMap(chat, cache, space.name);
        for (const m of hits) pushHit(m, space, senderMap);
      } catch {}
    }));
    results.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
    if (results.length > 0) {
      return results.slice(0, Math.min(SEARCH_RESULT_HARD_CAP, Math.max(pageSize, results.length)));
    }
  }

  // No name-match hits anywhere → global text grep across every space within the time window.
  await Promise.allSettled(spaces.map(async (space) => {
    try {
      const { hits } = await scanSpaceForText(chat, space, { lower, timeFilter, textFilter: true, budget });
      if (!hits.length) return;
      const senderMap = await ensureSenderMap(chat, cache, space.name);
      for (const m of hits) pushHit(m, space, senderMap);
    } catch {}
  }));
  results.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
  return results.slice(0, Math.min(SEARCH_RESULT_HARD_CAP, Math.max(pageSize, results.length)));
}

async function sendMessage(chat, _cache, {
  spaceName, text, cardsV2, threadName, threadKey, replyOption, messageId, privateToUserId,
}) {
  validateResourceName(spaceName, "spaceName");
  if (!text && !cardsV2) throw new Error("send_message requires text or cardsV2");
  if (messageId) validateResourceName(messageId, "messageId");
  if (threadName) validateResourceName(threadName, "threadName");

  const body = {};
  if (text) body.text = text;
  if (cardsV2) body.cardsV2 = cardsV2;
  if (threadName) body.thread = { name: threadName };
  else if (threadKey) body.thread = { threadKey };
  if (privateToUserId) body.privateMessageViewer = { name: `users/${privateToUserId}` };

  const params = { parent: spaceName, requestBody: body };
  if (messageId) params.messageId = messageId;
  if (replyOption) params.messageReplyOption = replyOption;
  else if (threadName || threadKey) params.messageReplyOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";

  const res = await withRetry(
    () => chat.spaces.messages.create(params),
    { label: "messages.create" },
  );
  return formatMessage(res.data);
}

async function getSpace(chat, cache, { spaceName }) {
  validateResourceName(spaceName, "spaceName");
  const res = await withRetry(
    () => chat.spaces.get({ name: spaceName }),
    { label: "spaces.get" },
  );
  const s = res.data;
  const type = s.spaceType || s.type;
  if (type === "DIRECT_MESSAGE" && !cache.dmMembers[spaceName]) {
    try {
      const m = await withRetry(
        () => chat.spaces.members.list({ parent: spaceName, pageSize: 20 }),
        { label: "members.list(get_space)" },
      );
      const memberships = m.data.memberships || [];
      const allNames = memberships.map((x) => x.member?.displayName).filter(Boolean);
      // Authoritative self check via OAuth session identity; fall back to cached selfNames.
      const otherNames = memberships
        .filter((x) => !isSelfMember(x, cache) && !cache.selfNames.has(x.member?.displayName))
        .map((x) => x.member?.displayName)
        .filter(Boolean);
      cache.dmMembers[spaceName] = allNames;
      const labelNames = otherNames.length ? otherNames : allNames;
      if (labelNames.length) cache.dmLabels[spaceName] = labelNames.join(", ");
    } catch (err) {
      console.log("[getSpace.err]", JSON.stringify({
        spaceName,
        error: formatApiError(err),
      }));
    }
  }
  return formatSpace(s, cache);
}

async function resolvePersonToDm(chat, cache, personName) {
  const cached = await findSpaceByName(chat, cache, personName, { dmOnly: true });
  if (cached) return { spaceName: cached, resolvedVia: "cache" };

  const email = lookupEmailFromDirectory(personName);
  if (email) {
    try {
      validateResourceName(email, "email");
      const res = await withRetry(
        () => chat.spaces.findDirectMessage({ name: `users/${email}` }),
        { label: "findDirectMessage", maxAttempts: 2 },
      );
      if (res.data?.name) {
        return { spaceName: res.data.name, resolvedVia: "findDirectMessage", email };
      }
    } catch (err) {
      console.log("[findDirectMessage.err]", JSON.stringify({
        email, error: formatApiError(err),
      }));
    }
  }
  return null;
}

async function findDm(chat, cache, { personName }) {
  const resolved = await resolvePersonToDm(chat, cache, personName);
  if (resolved) return { found: true, ...resolved };

  if (!cache.nameCache) await buildNameCache(chat, cache);
  const available = Object.entries(cache.nameCache)
    .filter(([k, v]) => k.length > 2 && v.type === "DIRECT_MESSAGE")
    .map(([, v]) => v.displayName)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 50);
  return { found: false, message: `No DM found for "${personName}"`, availableDMs: available };
}

async function debugDmResolution(chat, cache) {
  // Force a rebuild so we always get fresh numbers.
  cache.nameCache = null;
  cache.dmLabels = null;
  await buildNameCache(chat, cache);
  const spaces = await ensureSpacesRaw(chat, cache);
  const dmsUnnamedTotal = spaces.filter(
    (s) => (s.spaceType || s.type) === "DIRECT_MESSAGE" && (!s.displayName || s.displayName.startsWith("spaces/")),
  ).length;
  const sampleLabelled = Object.entries(cache.dmLabels || {}).slice(0, 5);
  const sampleUnresolvedDms = spaces
    .filter((s) => {
      const t = s.spaceType || s.type;
      if (t !== "DIRECT_MESSAGE") return false;
      if (s.displayName && !s.displayName.startsWith("spaces/")) return false;
      return !cache.dmLabels?.[s.name];
    })
    .slice(0, 5)
    .map((s) => s.name);
  return {
    diagnostics: cache.lastDiag || null,
    dmsUnnamedTotal,
    dmLabelsResolved: Object.keys(cache.dmLabels || {}).length,
    sampleLabelled: sampleLabelled.map(([spaceName, label]) => ({ spaceName, label })),
    sampleUnresolvedDms,
    hint: "If memberListErr > 0 and firstError mentions 'permission'/'403', the chat.memberships.readonly scope was not granted — reconnect the connector on claude.ai.",
  };
}

async function sendToPerson(chat, cache, { personName, text, threadName, cardsV2, messageId }) {
  const resolved = await resolvePersonToDm(chat, cache, personName);
  if (!resolved) {
    if (!cache.nameCache) await buildNameCache(chat, cache);
    const names = Object.entries(cache.nameCache)
      .filter(([k, v]) => k.length > 2 && v.type === "DIRECT_MESSAGE")
      .map(([k]) => k)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(", ");
    throw new Error(`No DM found for "${personName}". Available DMs: ${names}`);
  }
  const sent = await sendMessage(chat, cache, {
    spaceName: resolved.spaceName, text, threadName, cardsV2, messageId,
  });
  return { ...sent, resolvedVia: resolved.resolvedVia, email: resolved.email };
}

export const TOOLS = [
  { name: "list_spaces", description: "List all Google Chat spaces and DMs.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "get_messages", description: "Get recent messages from a space.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, pageSize: { type: "number" }, filter: { type: "string" } }, required: ["spaceName"] } },
  { name: "search_messages", description: "Search messages across ALL spaces the user is in, within a time window (default: last 30 days). Fan-out: (1) candidate spaces = every space whose displayName contains the full query or any non-trivial token (e.g. \"panic room\" → every Panic Room space, \"ECC\" → every ECC space), then grep each in parallel with space labels on results; (2) if no label hits, fall back to global text grep across all spaces. Uses server-side createTime filter + paginates up to 600 messages per space. If a result is expected but not returned, widen the window via sinceDays.", inputSchema: { type: "object", properties: { query: { type: "string" }, pageSize: { type: "number" }, sinceDays: { type: "number", description: "Look back this many days (default 30, max 365). Increase for older messages." } }, required: ["query"] } },
  { name: "send_message", description: "Send a message to a space. Supports plain text, cardsV2, threaded replies (threadName/threadKey), messageId (idempotency), and privateMessageViewer.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, text: { type: "string" }, cardsV2: { type: "array" }, threadName: { type: "string" }, threadKey: { type: "string" }, replyOption: { type: "string" }, messageId: { type: "string" }, privateToUserId: { type: "string" } }, required: ["spaceName"] } },
  { name: "get_space", description: "Get details about a space including members (for DMs).", inputSchema: { type: "object", properties: { spaceName: { type: "string" } }, required: ["spaceName"] } },
  { name: "find_dm", description: "Find a person's DM space by name or nickname. Use before send_message when you only know a name.", inputSchema: { type: "object", properties: { personName: { type: "string" } }, required: ["personName"] } },
  { name: "send_to_person", description: "Send a DM to a person by name — resolves their space automatically. Use when user says 'send X to [person name]'.", inputSchema: { type: "object", properties: { personName: { type: "string" }, text: { type: "string" }, cardsV2: { type: "array" }, threadName: { type: "string" }, messageId: { type: "string" } }, required: ["personName"] } },
  { name: "get_message", description: "Get a single message by its full resource name.", inputSchema: { type: "object", properties: { messageName: { type: "string" } }, required: ["messageName"] } },
  { name: "edit_message", description: "Edit the text or cardsV2 content of an existing message.", inputSchema: { type: "object", properties: { messageName: { type: "string" }, text: { type: "string" }, cardsV2: { type: "array" } }, required: ["messageName"] } },
  { name: "delete_message", description: "Delete a message by its full resource name.", inputSchema: { type: "object", properties: { messageName: { type: "string" } }, required: ["messageName"] } },
  { name: "get_members", description: "List members of a space with role, state, and isSelf flag.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, pageSize: { type: "number" } }, required: ["spaceName"] } },
  { name: "whoami", description: "Return the authenticated caller's identity from the OAuth session.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "refresh_cache", description: "Force-refresh the spaces, members, and name cache for this session.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "debug_dm_resolution", description: "Diagnostic tool: forces a fresh DM-name resolution pass and returns counters.", inputSchema: { type: "object", properties: {}, required: [] } },
];

const HANDLERS = {
  list_spaces: listSpaces,
  get_messages: getMessages,
  search_messages: searchMessages,
  send_message: sendMessage,
  get_space: getSpace,
  find_dm: findDm,
  send_to_person: sendToPerson,
  get_message: getMessage,
  edit_message: editMessage,
  delete_message: deleteMessage,
  get_members: getMembers,
  whoami: whoami,
  refresh_cache: refreshCache,
  debug_dm_resolution: debugDmResolution,
};

export async function callTool({ name, args, session, googleClientId, googleClientSecret }) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  const chat = makeChatClient({ google: session.google, googleClientId, googleClientSecret });
  const cache = getOrCreateCache(session);
  try {
    return await handler(chat, cache, args || {});
  } catch (err) {
    if (err?.response?.data) {
      throw new Error(formatApiError(err));
    }
    throw err;
  }
}
