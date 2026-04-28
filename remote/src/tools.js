// MCP tool implementations — ported from servers/server.js.
// Per-request: a Google Chat client is built from the calling user's Google
// access token. Token refresh is handled transparently via googleapis.

import { google } from "googleapis";
import { matchDirectoryByName } from "./shared/email-index.js";
import { resolveNameToSpace } from "./shared/resolve-dm.js";
import { formatMessage } from "./shared/format.js";
import { aggregateThreadsInSpace } from "./shared/threads-aggregate.js";
import { listAllMembers } from "./shared/members-list.js";
import { assertSpaceType } from "./shared/space-type-guard.js";
import { resolveViaDirectory, collectOrphanSenders } from "./shared/people-resolver.js";
import { senderMapKey } from "./storage.js";

// Build chat + people clients sharing one OAuth2 instance so token refresh
// happens once per call across both APIs. People is used as a directory
// fallback when @mention harvesting + DM-member listing miss a user.
function makeClients({ google: g, googleClientId, googleClientSecret }) {
  const oauth2 = new google.auth.OAuth2(googleClientId, googleClientSecret);
  oauth2.setCredentials({
    access_token: g.accessToken,
    refresh_token: g.refreshToken,
    expiry_date: g.expiresAt,
  });
  return {
    chat: google.chat({ version: "v1", auth: oauth2 }),
    people: google.people({ version: "v1", auth: oauth2 }),
  };
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
    // Global sender resolver. One map shared across ALL spaces — a user
    // @mentioned in space A is resolvable in space B without a fresh API call.
    // Hydrated lazily from storage on first use (see ensureSenderMap).
    globalSenderMap: null,           // { "users/XXX": "Display Name" } | null = unloaded
    spacesWarmed: new Set(),         // spaces whose recent 200 msgs we've already harvested this session
    senderMapDirty: false,           // set when harvest adds new keys; persistence schedules a save
    selfNames: new Set(),
    selfIdentity: null,              // { userId, email, name, source }
    _storage: null,                  // injected per-call so we can persist
    _userKey: null,                  // hashed per-user key for storage
  };
}

const sessionCaches = new Map();

function getOrCreateCache(session, storage) {
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
  // Refresh storage handle every call — it's stable per process, but session
  // caches predate it so we attach lazily. Same for the userKey (hashed).
  if (storage) cache._storage = storage;
  if (!cache._userKey) cache._userKey = senderMapKey(key);
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

// Lazily hydrate the global sender map from storage on first access.
// Returns the (always-shared) map; never the stale per-space copy.
async function getGlobalSenderMap(cache) {
  if (cache.globalSenderMap) return cache.globalSenderMap;
  let hydrated = {};
  if (cache._storage?.getSenderMap && cache._userKey) {
    try {
      hydrated = await cache._storage.getSenderMap(cache._userKey) || {};
    } catch (err) {
      console.log("[senderMap.hydrate.err]", err?.message);
    }
  }
  cache.globalSenderMap = hydrated;
  return cache.globalSenderMap;
}

// Best-effort, debounced persist. Coalesces multiple harvests in a single
// turn into one Redis write — relevant for search_messages which scans many
// spaces in parallel.
function schedulePersistSenderMap(cache) {
  if (!cache._storage?.saveSenderMap || !cache._userKey) return;
  if (cache._persistTimer) return;
  cache._persistTimer = setTimeout(async () => {
    cache._persistTimer = null;
    if (!cache.senderMapDirty) return;
    cache.senderMapDirty = false;
    try {
      await cache._storage.saveSenderMap(cache._userKey, cache.globalSenderMap);
    } catch (err) {
      console.log("[senderMap.persist.err]", err?.message);
    }
  }, 250);
  // Don't keep the event loop alive just for this — Node will let it fire on shutdown.
  if (cache._persistTimer.unref) cache._persistTimer.unref();
}

async function ensureSenderMap(chat, cache, spaceName) {
  const map = await getGlobalSenderMap(cache);
  // First touch of a space this session → harvest its recent @mentions once.
  if (!cache.spacesWarmed.has(spaceName)) {
    const before = Object.keys(map).length;
    try {
      const res = await withRetry(
        () => chat.spaces.messages.list({ parent: spaceName, pageSize: 200, orderBy: "createTime desc" }),
        { label: `messages.list(sender-warmup:${spaceName})`, maxAttempts: 2 },
      );
      harvestAnnotations(res.data.messages || [], map);
    } catch (err) {
      console.log("[senderMap.err]", JSON.stringify({ spaceName, error: err?.message }));
    }
    cache.spacesWarmed.add(spaceName);
    if (Object.keys(map).length > before) {
      cache.senderMapDirty = true;
      schedulePersistSenderMap(cache);
    }
  }
  return map;
}

// Wrapper for harvestAnnotations call sites that mutate the senderMap directly
// (e.g. getMessages, after fetching the page being shown to the user).
// Marks the cache dirty so the new mentions get persisted.
function harvestIntoCache(messages, cache, map) {
  const before = Object.keys(map).length;
  harvestAnnotations(messages, map);
  if (Object.keys(map).length > before) {
    cache.senderMapDirty = true;
    schedulePersistSenderMap(cache);
  }
}

// People API safety net for orphan senders. Called after @mention harvest;
// any sender whose userId is still missing from the map gets a directory
// lookup. Resolved names are folded into the global senderMap and persisted.
async function enrichOrphansViaPeopleAPI(messages, cache, senderMap, label = "people.batchGet(orphans)") {
  if (!cache._peopleClient) return 0;
  const orphans = collectOrphanSenders(messages, senderMap);
  if (orphans.size === 0) return 0;
  let added = 0;
  try {
    const resolved = await resolveViaDirectory(cache._peopleClient, orphans, {
      withRetry,
      label,
    });
    for (const [uid, name] of resolved) {
      if (!senderMap[uid]) {
        senderMap[uid] = name;
        added++;
      }
    }
  } catch (err) {
    console.log("[enrichOrphans.err]", err?.message);
  }
  if (added > 0) {
    cache.senderMapDirty = true;
    schedulePersistSenderMap(cache);
  }
  return added;
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
  // Pre-load the global sender map so DM-member displayNames we resolve below
  // also feed the cross-space sender resolver. members.list exposes
  // displayName ONLY for DMs under user auth, so this is the cheapest place
  // to harvest userId → name mappings before relying on @mention scraping.
  const senderMap = await getGlobalSenderMap(cache);
  let senderMapBefore = Object.keys(senderMap).length;

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
        const r = await listAllMembers(chat, space.name, {
          withRetry,
          label: `members.list(${space.name})`,
          maxAttempts: 3,
        });
        return { space, members: r.memberships };
      }),
    );

    // First pass: collect raw member records (uid + displayName-if-any) per space.
    // Under user auth, members.list returns null displayName for DMs, so we
    // capture the userId regardless and let the People API enrichment below
    // fill in the names. Without this, every DM stays "DM (unresolved)".
    const perSpaceRecords = [];
    const orphanUids = new Set();
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
      const records = [];
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
        const uid = m.member?.name;
        if (!uid || !uid.startsWith("users/")) continue;
        const dn = m.member?.displayName || null;
        if (!dn && !senderMap[uid]) orphanUids.add(uid);
        records.push({ uid, displayName: dn, member: m });
      }
      perSpaceRecords.push({ space: r.value.space, records });
    }

    // People API safety net: any DM partner with null displayName AND no prior
    // @mention sighting → resolve via directory and fold into senderMap.
    if (orphanUids.size > 0) {
      try {
        const resolved = await resolveViaDirectory(cache._peopleClient, orphanUids, {
          withRetry,
          label: "people.batchGet(dm-partners)",
        });
        for (const [uid, name] of resolved) {
          if (!senderMap[uid]) senderMap[uid] = name;
        }
        diag.peopleApiOrphans = orphanUids.size;
        diag.peopleApiResolved = resolved.size;
      } catch (err) {
        diag.peopleApiOrphans = orphanUids.size;
        diag.peopleApiResolved = 0;
        diag.peopleApiError = err?.message;
      }
    }

    // Second pass: build perSpace[] using either the original displayName,
    // an existing senderMap entry, or a freshly-resolved People API name.
    // Primary self-detection signal: userId match via selfIdentity (authoritative).
    // Fallback: frequency — the caller appears in every DM.
    const freq = {};
    const perSpace = [];
    const allMembersPerSpace = {};
    for (const { space, records } of perSpaceRecords) {
      const names = [];
      const allNames = [];
      for (const rec of records) {
        const n = rec.displayName || senderMap[rec.uid] || null;
        if (!n) continue;
        // Seed the resolver if we haven't already (e.g. displayName from API).
        if (rec.uid && !senderMap[rec.uid]) senderMap[rec.uid] = n;
        allNames.push(n);
        if (isSelfMember(rec.member, cache)) { cache.selfNames.add(n); continue; }
        names.push(n);
        freq[n] = (freq[n] || 0) + 1;
      }
      allMembersPerSpace[space.name] = allNames;
      perSpace.push({ space, names });
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
  diag.senderMapAdded = Object.keys(senderMap).length - senderMapBefore;
  if (diag.senderMapAdded > 0) {
    cache.senderMapDirty = true;
    schedulePersistSenderMap(cache);
  }
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

async function getMessages(chat, cache, { spaceName, pageSize = 25, filter = "" }) {
  validateResourceName(spaceName, "spaceName");
  const params = { parent: spaceName, pageSize, orderBy: "createTime desc" };
  if (filter) params.filter = filter;
  const [res, senderMap] = await Promise.all([
    withRetry(() => chat.spaces.messages.list(params), { label: "messages.list" }),
    ensureSenderMap(chat, cache, spaceName),
  ]);
  const messages = res.data.messages || [];
  harvestIntoCache(messages, cache, senderMap);
  // People API safety net: resolve any senders still missing after @mention harvest.
  await enrichOrphansViaPeopleAPI(messages, cache, senderMap, "people.batchGet(get_messages)");
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
  // Single-message orphan resolution — cheap when sender is already known.
  await enrichOrphansViaPeopleAPI([res.data], cache, senderMap, "people.batchGet(get_message)");
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

async function getMembers(chat, cache, { spaceName, pageSize = 100 }) {
  validateResourceName(spaceName, "spaceName");
  const r = await listAllMembers(chat, spaceName, {
    withRetry,
    label: "members.list",
    pageSize,
    maxAttempts: 3,
  });
  const out = r.memberships.map((m) => ({
    name: m.name,
    state: m.state,
    role: m.role,
    memberName: m.member?.name,
    displayName: m.member?.displayName,
    type: m.member?.type,
    isSelf: isSelfMember(m, cache),
  }));
  if (r.truncated) {
    return { members: out, truncated: true, pages: r.pages, note: "Member list truncated at page cap (5000)." };
  }
  return out;
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
  // Drop the warmed-spaces marker so the next get_messages re-harvests fresh
  // @mentions, but KEEP the global sender map — names don't go stale, and
  // wiping it would force every cross-space resolution to start from zero.
  cache.spacesWarmed = new Set();
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
      const msgs = r.data.messages || [];
      await enrichOrphansViaPeopleAPI(msgs, cache, senderMap, "people.batchGet(search-browse)");
      for (const m of msgs) pushHit(m, space, senderMap);
      return results.slice(0, pageSize);
    }

    await Promise.allSettled(targets.map(async (space) => {
      try {
        const { hits } = await scanSpaceForText(chat, space, { lower, timeFilter, textFilter: true, budget });
        if (!hits.length) return;
        const senderMap = await ensureSenderMap(chat, cache, space.name);
        await enrichOrphansViaPeopleAPI(hits, cache, senderMap, "people.batchGet(search-targeted)");
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
      await enrichOrphansViaPeopleAPI(hits, cache, senderMap, "people.batchGet(search-global)");
      for (const m of hits) pushHit(m, space, senderMap);
    } catch {}
  }));
  results.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
  return results.slice(0, Math.min(SEARCH_RESULT_HARD_CAP, Math.max(pageSize, results.length)));
}

async function sendMessage(chat, cache, {
  spaceName, text, cardsV2, threadName, threadKey, replyOption, messageId, privateToUserId, expectType,
}) {
  validateResourceName(spaceName, "spaceName");
  if (!text && !cardsV2) throw new Error("send_message requires text or cardsV2");
  if (messageId) validateResourceName(messageId, "messageId");
  if (threadName) validateResourceName(threadName, "threadName");

  if (expectType) {
    await assertSpaceType(chat, spaceName, expectType, {
      cachedSpaces: cache?.spaces,
      withRetry,
    });
  }

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
      const m = await listAllMembers(chat, spaceName, {
        withRetry,
        label: "members.list(get_space)",
        maxAttempts: 3,
      });
      const memberships = m.memberships;

      // Under user auth, members.list returns null displayName for DMs.
      // Capture user IDs and let People API fill the names so this surface
      // matches what list_spaces returns for the same DM.
      const senderMap = await getGlobalSenderMap(cache);
      const orphanUids = new Set();
      for (const x of memberships) {
        const uid = x.member?.name;
        if (uid && uid.startsWith("users/") && !x.member?.displayName && !senderMap[uid]) {
          orphanUids.add(uid);
        }
      }
      if (orphanUids.size > 0 && cache._peopleClient) {
        try {
          const resolved = await resolveViaDirectory(cache._peopleClient, orphanUids, {
            withRetry,
            label: "people.batchGet(get_space)",
          });
          for (const [uid, name] of resolved) {
            if (!senderMap[uid]) senderMap[uid] = name;
          }
          if (resolved.size > 0) {
            cache.senderMapDirty = true;
            schedulePersistSenderMap(cache);
          }
        } catch (err) {
          console.log("[getSpace.peopleApi.err]", err?.message);
        }
      }

      const nameOf = (x) => x.member?.displayName || (x.member?.name && senderMap[x.member.name]) || null;
      const allNames = memberships.map(nameOf).filter(Boolean);
      // Authoritative self check via OAuth session identity; fall back to cached selfNames.
      const otherNames = memberships
        .filter((x) => !isSelfMember(x, cache) && !cache.selfNames.has(nameOf(x)))
        .map(nameOf)
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

/**
 * Scans recent messages in one space, groups by `thread` (Chat's canonical id
 * for that conversation). Users can refer to the same thread by many names;
 * this maps snippets → thread id for `send_message(..., threadName)`.
 */
async function listSpaceThreads(chat, cache, { spaceName, maxPages = 4 }) {
  validateResourceName(spaceName, "spaceName");
  if (!cache.nameCache) await buildNameCache(chat, cache);
  const all = await ensureSpacesRaw(chat, cache);
  const s = all.find((x) => x.name === spaceName);
  const spaceLabel = s ? formatSpace(s, cache) : { displayName: spaceName };

  const maxP = Math.min(10, Math.max(1, Number(maxPages) || 4));
  const collected = [];
  let pageToken;
  for (let p = 0; p < maxP; p++) {
    const params = {
      parent: spaceName,
      pageSize: 100,
      orderBy: "createTime desc",
    };
    if (pageToken) params.pageToken = pageToken;
    const r = await withRetry(
      () => chat.spaces.messages.list(params),
      { label: `messages.list(threads:${spaceName})`, maxAttempts: 2 },
    );
    const msgs = r.data.messages || [];
    collected.push(...msgs);
    pageToken = r.data.nextPageToken;
    if (!pageToken) break;
  }

  const { threads, unthreadedTopLevel } = aggregateThreadsInSpace(collected, {
    maxThreadRows: 50,
    maxUnthreaded: 15,
  });
  return {
    spaceName,
    spaceDisplayName: spaceLabel.displayName || spaceName,
    scannedMessageCount: collected.length,
    note:
      "A space can have many threads. Each `thread` is the resource id for that thread — use it as `threadName` when replying. " +
      "Informal thread names (what people say aloud) are not in the API; match them against the `snippet` text below.",
    threads,
    unthreadedTopLevel,
  };
}

async function resolvePersonToDm(chat, cache, personName) {
  if (!cache.nameCache) await buildNameCache(chat, cache);
  const nameHit = resolveNameToSpace(cache.nameCache, personName, { dmOnly: true });
  if (nameHit.status === "unique") {
    return {
      spaceName: nameHit.spaceName,
      resolvedVia: "cache",
      matchType: nameHit.matchType,
      displayName: nameHit.displayName,
    };
  }
  if (nameHit.status === "ambiguous") {
    return { ambiguous: true, source: "name_cache", candidates: nameHit.candidates };
  }

  const dir = matchDirectoryByName(personName);
  if (dir.kind === "ambiguous") {
    return { ambiguous: true, source: "directory", directoryMatches: dir.matches };
  }
  if (dir.kind === "unique") {
    try {
      validateResourceName(dir.email, "email");
      const res = await withRetry(
        () => chat.spaces.findDirectMessage({ name: `users/${dir.email}` }),
        { label: "findDirectMessage", maxAttempts: 2 },
      );
      if (res.data?.name) {
        return {
          spaceName: res.data.name,
          resolvedVia: "findDirectMessage",
          email: dir.email,
          directoryKey: dir.directoryKey,
        };
      }
    } catch (err) {
      console.log("[findDirectMessage.err]", JSON.stringify({
        email: dir.email, error: formatApiError(err),
      }));
    }
  }
  return null;
}

function formatAmbiguousError(personName, resolved) {
  if (resolved.source === "name_cache") {
    const lines = resolved.candidates.map(
      (c) => `  - ${c.displayName} (${c.spaceName}) [matched: ${c.matchedKey}]`,
    );
    return `Ambiguous name "${personName}": several DMs match. Ask the user to pick one.\n${lines.join("\n")}`;
  }
  const lines = resolved.directoryMatches.map(
    (m) => `  - ${m.name} <${m.email}>`,
  );
  return `Ambiguous name "${personName}": several people match in the employee directory. Ask the user to pick one.\n${lines.join("\n")}`;
}

async function findDm(chat, cache, { personName }) {
  const resolved = await resolvePersonToDm(chat, cache, personName);
  if (resolved?.ambiguous) {
    if (resolved.source === "name_cache") {
      return {
        found: "ambiguous",
        reason: "Multiple DM spaces match; user must disambiguate.",
        candidates: resolved.candidates,
      };
    }
    return {
      found: "ambiguous",
      reason: "Multiple employee directory entries match; user must disambiguate.",
      directoryMatches: resolved.directoryMatches,
    };
  }
  if (resolved) {
    return { found: true, ...resolved };
  }

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
  if (resolved?.ambiguous) {
    throw new Error(formatAmbiguousError(personName, resolved));
  }
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

// Tool surface is the single source of truth in shared/tools.js. Re-exported
// here so existing `import { TOOLS } from "./tools.js"` call-sites keep working.
export { TOOLS } from "./shared/tools.js";

const HANDLERS = {
  list_spaces: listSpaces,
  get_messages: getMessages,
  list_space_threads: listSpaceThreads,
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

export async function callTool({ name, args, session, googleClientId, googleClientSecret, storage }) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  const { chat, people } = makeClients({ google: session.google, googleClientId, googleClientSecret });
  const cache = getOrCreateCache(session, storage);
  // Per-call attachment: the OAuth2 access token may rotate between calls,
  // so we always use the freshly-built client (not a stale cached one).
  cache._peopleClient = people;
  try {
    return await handler(chat, cache, args || {});
  } catch (err) {
    if (err?.response?.data) {
      throw new Error(formatApiError(err));
    }
    throw err;
  }
}
