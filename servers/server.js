import { google } from "googleapis";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname } from "path";
import { createHash } from "crypto";
import { TOOLS } from "../remote/src/shared/tools.js";
import { matchDirectoryByName } from "../remote/src/shared/email-index.js";
import { resolveNameToSpace } from "../remote/src/shared/resolve-dm.js";
import { formatMessage } from "../remote/src/shared/format.js";
import { aggregateThreadsInSpace } from "../remote/src/shared/threads-aggregate.js";
import { listAllMembers } from "../remote/src/shared/members-list.js";
import { assertSpaceType } from "../remote/src/shared/space-type-guard.js";
import { loadCache, saveCache, isStale, CACHE_FILE_PATH } from "./local-cache.js";

// ── Credentials (set via env vars) ──
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// Lazily initialized — server starts even without credentials so Claude Code
// can connect. A clear error is returned when tools are actually called.
let _chat = null;
let _oauth2Client = null;
function getOAuth2Client() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error(
      "Google credentials not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN. " +
      "Run: node servers/auto-setup.js <CLIENT_ID> <CLIENT_SECRET>"
    );
  }
  if (!_oauth2Client) {
    _oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    _oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  }
  return _oauth2Client;
}
function getChat() {
  if (!_chat) _chat = google.chat({ version: "v1", auth: getOAuth2Client() });
  return _chat;
}

const log = (msg) => process.stderr.write(`[google-chat] ${msg}\n`);
function sendResponse(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

// ── Input validation (ported from googleworkspace/cli validate.rs) ──
// Rejects path traversal, URL-encoding bypass, query/fragment injection,
// control chars, and invisible/bidi Unicode that could spoof display names.
function isDangerousUnicode(code) {
  return (code >= 0x200B && code <= 0x200D) || // zero-width: ZWSP, ZWNJ, ZWJ
    code === 0xFEFF ||                          // BOM
    (code >= 0x202A && code <= 0x202E) ||       // bidi: LRE, RLE, PDF, LRO, RLO
    (code >= 0x2028 && code <= 0x2029) ||       // line/paragraph separators
    (code >= 0x2066 && code <= 0x2069);         // directional isolates
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
    if (code === 0 || (code < 0x20) || (code >= 0x7F && code <= 0x9F))
      throw new Error(`${label} must not contain control chars: "${s}"`);
    if (isDangerousUnicode(code))
      throw new Error(`${label} must not contain invisible/bidi Unicode: "${s}"`);
  }
  return s;
}
const validateSpaceName = (n) => validateResourceName(n, "spaceName");
const validateMessageName = (n) => validateResourceName(n, "messageName");

// ── Retry with exponential backoff + jitter on 429/5xx ──
// Honors Retry-After header when present. Max 4 attempts.
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function withRetry(fn, { label = "api-call", maxAttempts = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err?.code || err?.response?.status;
      const retryable = code === 429 || (code >= 500 && code < 600);
      if (!retryable || attempt === maxAttempts) break;
      const retryAfterHdr = err?.response?.headers?.["retry-after"];
      const retryAfterMs = retryAfterHdr
        ? (isNaN(+retryAfterHdr) ? 0 : +retryAfterHdr * 1000)
        : 0;
      const backoff = Math.min(30000, 500 * Math.pow(2, attempt - 1));
      const jitter = Math.random() * 250;
      const delay = Math.max(retryAfterMs, backoff) + jitter;
      log(`[retry] ${label} ${code} — attempt ${attempt}/${maxAttempts}, waiting ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ── Structured error normalization (ported from gws executor.rs) ──
// Parses Google API error shape; surfaces `accessNotConfigured` Enable URL.
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

// ── Self identity (authoritative — authenticated caller) ──
// Resolution order: env override → disk cache → OIDC userinfo → frequency heuristic.
// This is the single source of truth for filtering "self" out of DM member lists.
const SELF_CACHE_PATH = `${homedir()}/.cache/google-chat-mcp/self.json`;
let selfIdentity = null; // { userId?, email?, name?, source }

function loadSelfFromDisk() {
  try {
    const data = JSON.parse(readFileSync(SELF_CACHE_PATH, "utf8"));
    if (data?.email || data?.name || data?.userId) return data;
  } catch {}
  return null;
}
function saveSelfToDisk(identity) {
  try {
    mkdirSync(dirname(SELF_CACHE_PATH), { recursive: true });
    writeFileSync(SELF_CACHE_PATH, JSON.stringify(identity, null, 2));
  } catch (e) { log(`self cache save failed: ${e.message}`); }
}
async function getSelfIdentity() {
  if (selfIdentity) return selfIdentity;

  // 1. Env var override — user can set if auto-detection fails.
  if (process.env.GOOGLE_SELF_EMAIL || process.env.GOOGLE_SELF_NAME) {
    selfIdentity = {
      email: process.env.GOOGLE_SELF_EMAIL,
      name: process.env.GOOGLE_SELF_NAME,
      source: "env",
    };
    log(`self identity from env: ${selfIdentity.email || selfIdentity.name}`);
    return selfIdentity;
  }

  // 2. Disk cache from a previous run.
  const cached = loadSelfFromDisk();
  if (cached) {
    selfIdentity = cached;
    log(`self identity from disk cache: ${cached.email || cached.name}`);
    return selfIdentity;
  }

  // 3. OIDC userinfo endpoint. Requires openid/email/profile scope — may fail
  //    if the refresh token wasn't granted those. Fall back silently.
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: getOAuth2Client() });
    const { data } = await withRetry(() => oauth2.userinfo.get(), { label: "userinfo" });
    if (data?.email || data?.name) {
      selfIdentity = {
        userId: data.id,
        email: data.email,
        name: data.name,
        source: "userinfo",
      };
      saveSelfToDisk(selfIdentity);
      log(`self identity from userinfo: ${data.email} (${data.name})`);
      return selfIdentity;
    }
  } catch (e) {
    log(`userinfo lookup failed: ${e.message || e} — will fall back to frequency heuristic`);
  }

  return null; // frequency heuristic in buildNameCache will populate selfNames
}

// Returns true if the member displayName/userId matches the authenticated self.
function isSelfMember(member) {
  if (!selfIdentity) return false;
  const dn = member?.member?.displayName || member?.displayName || "";
  const uid = member?.member?.name || "";
  if (selfIdentity.name && dn && dn === selfIdentity.name) return true;
  if (selfIdentity.userId && uid === `users/${selfIdentity.userId}`) return true;
  return false;
}

// ── Name cache ──
let allSpacesRaw = null;
let nameCache = null;
let dmLabels = {}; // spaceName → "Person A, Person B" (non-self members of each DM)
let selfNames = new Set(); // display names of self — seeded from selfIdentity when available
let dmMembers = {}; // spaceName → array of raw member displayNames (for get_space responses)
let senderMaps = {}; // spaceName → { "users/XXX": "Display Name" } for sender-name enrichment
let lastDiag = null; // diagnostics from last buildNameCache run, exposed via debug_dm_resolution

// Stable per-account fingerprint for the on-disk cache. Hashing the refresh
// token (not the access token, which rotates) gives us isolation if a user
// switches accounts without leaking the secret to disk.
let _userFingerprint = null;
function getUserFingerprint() {
  if (_userFingerprint) return _userFingerprint;
  if (!REFRESH_TOKEN) return null;
  _userFingerprint = createHash("sha256").update(REFRESH_TOKEN).digest("hex").slice(0, 16);
  return _userFingerprint;
}

// Warm-start: try to populate module state from the on-disk cache.
// Safe even when called before credentials are configured — without a
// refresh token we can't compute a fingerprint, so loadCache returns null.
// On stale cache we keep the data anyway (the next refresh_cache or first
// tool call will rebuild) — better to serve stale-but-fast than slow.
function warmFromDisk() {
  const fp = getUserFingerprint();
  if (!fp) return;
  const cached = loadCache(fp);
  if (!cached) return;
  allSpacesRaw = cached.spaces;
  nameCache = cached.nameCache;
  dmLabels = cached.dmLabels || {};
  dmMembers = cached.dmMembers || {};
  selfNames = new Set(cached.selfNames || []);
  const ageMin = Math.round((Date.now() - cached.savedAt) / 60000);
  const stale = isStale(cached);
  log(`Warm-started from ${CACHE_FILE_PATH} (${cached.spaces?.length || 0} spaces, ` +
      `${Object.keys(cached.nameCache || {}).length} name keys, age ${ageMin}m${stale ? ", stale" : ""})`);
}

// Chat API omits sender.displayName under user-auth. But USER_MENTION
// annotations on messages carry the mentioned user's ID + the text position,
// so anyone @mentioned in the space becomes resolvable for free.
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

async function ensureSenderMap(spaceName) {
  if (senderMaps[spaceName]) return senderMaps[spaceName];
  const map = {};
  try {
    const res = await withRetry(
      () => getChat().spaces.messages.list({ parent: spaceName, pageSize: 200, orderBy: "createTime desc" }),
      { label: `messages.list(sender-warmup:${spaceName})`, maxAttempts: 2 },
    );
    harvestAnnotations(res.data.messages || [], map);
  } catch (err) {
    log(`[senderMap.err] ${spaceName}: ${err?.message}`);
  }
  senderMaps[spaceName] = map;
  return map;
}

function spaceNameFromMessage(messageName) {
  const m = /^(spaces\/[^/]+)\//.exec(messageName || "");
  return m ? m[1] : null;
}

function addToCache(cache, name, spaceName, type, displayName) {
  if (!name) return;
  const lower = name.toLowerCase().trim();
  if (!lower || lower.startsWith("spaces/")) return;
  const entry = { spaceName, type, displayName };
  cache[lower] = entry;
  const words = lower.split(/[\s\/,:\-]+/).filter(w => w.length > 1);
  for (const word of words) {
    if (!cache[word]) cache[word] = entry;
  }
}

async function ensureSpaces() {
  if (!allSpacesRaw) {
    const all = [];
    let pageToken;
    do {
      const res = await withRetry(
        () => getChat().spaces.list({ pageSize: 1000, pageToken }),
        { label: "spaces.list" },
      );
      if (res.data.spaces) all.push(...res.data.spaces);
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    allSpacesRaw = all;
    log(`Fetched ${all.length} spaces total (paginated)`);
  }
  return allSpacesRaw;
}

async function buildNameCache() {
  log("Building name cache...");
  // Seed selfNames from authoritative identity BEFORE frequency heuristic.
  await getSelfIdentity();
  if (selfIdentity?.name) selfNames.add(selfIdentity.name);

  const spaces = await ensureSpaces();
  const cache = {};

  // ── 1. Resolve DM names first so their first-name tokens (e.g. "priya")
  //      win over any same-named keyword in a group space. ──
  const dmSpaces = spaces.filter(s =>
    (s.spaceType || s.type) === "DIRECT_MESSAGE" &&
    (!s.displayName || s.displayName.startsWith("spaces/"))
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
    selfSource: null,
    dmLabelsCount: 0,
  };
  if (dmSpaces.length > 0) {
    log(`  Fetching members for ${dmSpaces.length} unnamed DM spaces...`);
    const memberResults = await Promise.allSettled(
      dmSpaces.map(async (space) => {
        const r = await listAllMembers(getChat(), space.name, {
          withRetry,
          label: `members.list(${space.name})`,
          maxAttempts: 3,
        });
        return { space, members: r.memberships };
      })
    );

    // First pass: collect names + detect self.
    // Primary signal: userId match via selfIdentity (authoritative).
    // Fallback: frequency — the caller appears in EVERY DM.
    const nameFreq = {};
    const perSpaceNames = [];
    for (const r of memberResults) {
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
        if (isSelfMember(m)) { selfNames.add(n); continue; } // authoritative skip
        names.push(n);
        nameFreq[n] = (nameFreq[n] || 0) + 1;
      }
      perSpaceNames.push({ space: r.value.space, names });
    }
    // Fallback heuristic — only add names that appear in >1 DM (almost
    // certainly self). Skip if authoritative identity already resolved self.
    if (selfNames.size === 0) {
      const detectedSelf = Object.entries(nameFreq).filter(([_, c]) => c > 1).map(([n]) => n);
      for (const n of detectedSelf) selfNames.add(n);
    }
    diag.selfNamesCount = selfNames.size;
    diag.selfSource = selfIdentity?.source || "frequency";
    if (selfNames.size > 0) log(`  Self (source=${diag.selfSource}): ${[...selfNames].join(", ")}`);

    // Second pass: add only non-self names; also build dmLabels map.
    let hits = 0, emptyDms = 0;
    const labels = {};
    const members = {};
    for (const { space, names } of perSpaceNames) {
      members[space.name] = names;
      const others = names.filter(n => !selfNames.has(n));
      // If self-detection filtered everything out, fall back to all names
      // so we never leave a DM with no label (which would leak the space ID).
      const labelNames = others.length ? others : names;
      if (labelNames.length === 0) { emptyDms++; continue; }
      for (const n of others) {
        addToCache(cache, n, space.name, "DIRECT_MESSAGE", n);
        hits++;
      }
      labels[space.name] = labelNames.join(", ");
    }
    dmLabels = labels;
    dmMembers = members;
    diag.dmLabelsCount = Object.keys(labels).length;
    log(`  DM resolution: ${hits} names cached, ${diag.memberListErr} API errors, ${emptyDms} DMs with no resolvable member`);
  }
  lastDiag = diag;

  // ── 2. Then add group/named spaces. Full-name keys still get set,
  //      word-level keys only if the DM hasn't claimed them. ──
  for (const space of spaces) {
    const type = space.spaceType || space.type;
    const dn = space.displayName || "";
    if (dn && !dn.startsWith("spaces/")) {
      addToCache(cache, dn, space.name, type, dn);
    }
  }

  const keys = Object.keys(cache);
  log(`Name cache built: ${keys.length} entries`);
  nameCache = cache;
  // Persist warm state so the next process start skips the cold fetch.
  // Best-effort: never let a write failure break the in-memory build.
  try {
    saveCache({
      userId: getUserFingerprint(),
      spaces: allSpacesRaw || [],
      nameCache,
      dmLabels,
      dmMembers,
      selfNames: [...selfNames],
    });
  } catch (e) { log(`local-cache save failed: ${e.message}`); }
  return cache;
}

// ── Helpers ──
// formatMessage → shared/format.js (thread + threadKey + inThread for room threads)
function formatSpace(space) {
  const type = space.spaceType || space.type;
  const raw = space.displayName || "";
  let displayName = raw && !raw.startsWith("spaces/") ? raw : "";
  const label = dmLabels?.[space.name];
  if (!displayName && type === "DIRECT_MESSAGE" && label) {
    displayName = `DM: ${label}`;
  }
  // Never leak the raw space ID as a displayName — the LLM may render it as a
  // person's name in summaries. Use a generic placeholder instead.
  if (!displayName) {
    displayName = type === "DIRECT_MESSAGE" ? "DM (unresolved)" : "Unnamed space";
  }
  const out = { name: space.name, displayName, type };
  if (type === "DIRECT_MESSAGE" && label) out.otherMember = label;
  const members = dmMembers?.[space.name];
  if (type === "DIRECT_MESSAGE" && members?.length) out.members = members;
  return out;
}

// ── Tool implementations ──
async function listSpaces() {
  // Trigger DM-member resolution so DM displayNames are useful strings.
  if (!nameCache) await buildNameCache();
  const spaces = await ensureSpaces();
  return spaces.map(formatSpace);
}

async function getMessages({ spaceName, pageSize = 25, filter = "" }) {
  validateSpaceName(spaceName);
  const params = { parent: spaceName, pageSize, orderBy: "createTime desc" };
  if (filter) params.filter = filter;
  const [res, senderMap] = await Promise.all([
    withRetry(() => getChat().spaces.messages.list(params), { label: "messages.list" }),
    ensureSenderMap(spaceName),
  ]);
  const messages = res.data.messages || [];
  harvestAnnotations(messages, senderMap);
  return messages.map((m) => formatMessage(m, senderMap));
}

async function getMessage({ messageName }) {
  validateMessageName(messageName);
  const res = await withRetry(
    () => getChat().spaces.messages.get({ name: messageName }),
    { label: "messages.get" },
  );
  const spaceName = spaceNameFromMessage(res.data?.name);
  const senderMap = spaceName ? await ensureSenderMap(spaceName) : {};
  return formatMessage(res.data, senderMap);
}

async function editMessage({ messageName, text, cardsV2 }) {
  validateMessageName(messageName);
  const body = {};
  const maskParts = [];
  if (text !== undefined) { body.text = text; maskParts.push("text"); }
  if (cardsV2 !== undefined) { body.cardsV2 = cardsV2; maskParts.push("cards_v2"); }
  if (maskParts.length === 0) throw new Error("edit_message requires text or cardsV2");
  const res = await withRetry(
    () => getChat().spaces.messages.patch({
      name: messageName,
      updateMask: maskParts.join(","),
      requestBody: body,
    }),
    { label: "messages.patch" },
  );
  return formatMessage(res.data);
}

async function deleteMessage({ messageName }) {
  validateMessageName(messageName);
  await withRetry(
    () => getChat().spaces.messages.delete({ name: messageName }),
    { label: "messages.delete" },
  );
  return { deleted: true, messageName };
}

// Tokens too short or too common to be meaningful name-matches.
const SEARCH_API_PAGE_SIZE = 100;           // messages per API page
const SEARCH_MAX_PAGES_PER_SPACE = 6;       // per-space hard stop: 6 × 100 = 600 messages
const SEARCH_TOTAL_MSG_BUDGET = 20000;      // org-wide safety net across all scanned spaces
const SEARCH_DEFAULT_SINCE_DAYS = 30;       // default time window for text grep
const SEARCH_MAX_SINCE_DAYS = 365;          // clamp to protect runtime
const SEARCH_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "at", "by", "with",
]);
// Accuracy > economy: don't cap fan-out. If 50 spaces match "ECC", we search all 50.
// (withRetry + allSettled absorbs rate-limit blips; the caller can always narrow the query.)
const SEARCH_RESULT_HARD_CAP = 200;  // ceiling on consolidated hits returned to caller

function tokenizeQuery(lower) {
  const toks = lower.split(/\s+/).filter((t) => t.length >= 2 && !SEARCH_STOPWORDS.has(t));
  return toks.length ? toks : [lower];
}

// Paginate through messages in a space within the time window, up to per-space cap.
// Filters server-side via Google Chat API's `filter: "createTime > ..."` so quiet
// spaces cost ~1 page, not 6. textFilter=false collects all messages (browse mode).
async function scanSpaceForText(space, { lower, timeFilter, textFilter = true, budget }) {
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
      () => getChat().spaces.messages.list(params),
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

async function searchMessages({ query, pageSize = 25, sinceDays }) {
  const spaces = await ensureSpaces();
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
    // Exactly one space with the full query as a displayName substring → browse mode (no text filter).
    const soloBrowse = targets.length === 1 && targets[0].displayName &&
      targets[0].displayName.toLowerCase().includes(lower);
    log(`  search candidates: ${targets.length}${soloBrowse ? " (browse mode)" : ` (window=${effectiveDays}d)`}`);

    if (soloBrowse) {
      const space = targets[0];
      const msgsRes = await withRetry(
        () => getChat().spaces.messages.list({ parent: space.name, pageSize, orderBy: "createTime desc" }),
        { label: `messages.list(${space.name})`, maxAttempts: 2 },
      );
      const senderMap = await ensureSenderMap(space.name);
      for (const m of msgsRes.data.messages || []) pushHit(m, space, senderMap);
      return results.slice(0, pageSize);
    }

    await Promise.allSettled(targets.map(async (space) => {
      try {
        const { hits } = await scanSpaceForText(space, { lower, timeFilter, textFilter: true, budget });
        if (!hits.length) return;
        const senderMap = await ensureSenderMap(space.name);
        for (const m of hits) pushHit(m, space, senderMap);
      } catch {}
    }));
    results.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
    if (results.length > 0) {
      return results.slice(0, Math.min(SEARCH_RESULT_HARD_CAP, Math.max(pageSize, results.length)));
    }
  }

  // No name-match hits anywhere → global text grep across every space within the time window.
  log(`  search: no candidate spaces, global grep (window=${effectiveDays}d, ${spaces.length} spaces)`);
  await Promise.allSettled(spaces.map(async (space) => {
    try {
      const { hits } = await scanSpaceForText(space, { lower, timeFilter, textFilter: true, budget });
      if (!hits.length) return;
      const senderMap = await ensureSenderMap(space.name);
      for (const m of hits) pushHit(m, space, senderMap);
    } catch {}
  }));
  results.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
  return results.slice(0, Math.min(SEARCH_RESULT_HARD_CAP, Math.max(pageSize, results.length)));
}

async function sendMessage({
  spaceName, text, cardsV2, threadName, threadKey, replyOption, messageId, privateToUserId, expectType,
}) {
  validateSpaceName(spaceName);
  if (!text && !cardsV2) throw new Error("send_message requires text or cardsV2");
  if (messageId) validateResourceName(messageId, "messageId");
  if (threadName) validateResourceName(threadName, "threadName");

  if (expectType) {
    await assertSpaceType(getChat(), spaceName, expectType, {
      cachedSpaces: allSpacesRaw,
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
  if (replyOption) {
    params.messageReplyOption = replyOption;
  } else if (threadName || threadKey) {
    params.messageReplyOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
  }

  const res = await withRetry(
    () => getChat().spaces.messages.create(params),
    { label: "messages.create" },
  );
  return formatMessage(res.data);
}

async function getSpace({ spaceName }) {
  validateSpaceName(spaceName);
  // Ensure self identity is loaded so isSelfMember can work.
  await getSelfIdentity();
  const res = await withRetry(
    () => getChat().spaces.get({ name: spaceName }),
    { label: "spaces.get" },
  );
  const s = res.data;
  const type = s.spaceType || s.type;
  if (type === "DIRECT_MESSAGE" && !dmMembers[spaceName]) {
    try {
      const m = await listAllMembers(getChat(), spaceName, {
        withRetry,
        label: "members.list(get_space)",
        maxAttempts: 3,
      });
      const memberships = m.memberships;
      const allNames = memberships.map(x => x.member?.displayName).filter(Boolean);
      // Use authoritative isSelfMember check (userId match), fall back to name match.
      const otherNames = memberships
        .filter(x => !isSelfMember(x) && !selfNames.has(x.member?.displayName))
        .map(x => x.member?.displayName)
        .filter(Boolean);
      dmMembers[spaceName] = allNames;
      const labelNames = otherNames.length ? otherNames : allNames;
      if (labelNames.length) dmLabels[spaceName] = labelNames.join(", ");
    } catch (e) {
      log(`get_space members fetch failed for ${spaceName}: ${formatApiError(e)}`);
    }
  }
  return formatSpace(s);
}

async function listSpaceThreads({ spaceName, maxPages = 4 }) {
  validateSpaceName(spaceName);
  if (!nameCache) await buildNameCache();
  const all = await ensureSpaces();
  const s = all.find((x) => x.name === spaceName);
  const spaceLabel = s ? formatSpace(s) : { displayName: spaceName };

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
      () => getChat().spaces.messages.list(params),
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

// Resolve personName → DM space. Order: name cache (no silent multi-match) →
// employee directory (ambiguous returns explicit list) → findDirectMessage.
async function resolvePersonToDm(personName) {
  if (!nameCache) await buildNameCache();
  const nameHit = resolveNameToSpace(nameCache, personName, { dmOnly: true });
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
        () => getChat().spaces.findDirectMessage({ name: `users/${dir.email}` }),
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
    } catch (e) {
      log(`findDirectMessage(${dir.email}) failed: ${formatApiError(e)}`);
    }
  }
  return null;
}

async function findDm({ personName }) {
  const resolved = await resolvePersonToDm(personName);
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
  if (resolved) return { found: true, ...resolved };

  if (!nameCache) await buildNameCache();
  const available = Object.entries(nameCache)
    .filter(([k, v]) => k.length > 2 && v.type === "DIRECT_MESSAGE")
    .map(([, v]) => v.displayName)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 50);
  return { found: false, message: `No DM found for "${personName}"`, availableDMs: available };
}

async function sendToPerson({ personName, text, threadName, cardsV2, messageId }) {
  const resolved = await resolvePersonToDm(personName);
  if (resolved?.ambiguous) {
    throw new Error(formatAmbiguousError(personName, resolved));
  }
  if (!resolved) {
    if (!nameCache) await buildNameCache();
    const names = Object.entries(nameCache)
      .filter(([k, v]) => k.length > 2 && v.type === "DIRECT_MESSAGE")
      .map(([k]) => k)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(", ");
    throw new Error(`No DM found for "${personName}". Available DMs: ${names}`);
  }
  const sent = await sendMessage({ spaceName: resolved.spaceName, text, threadName, cardsV2, messageId });
  return { ...sent, resolvedVia: resolved.resolvedVia, email: resolved.email };
}

async function refreshCache() {
  allSpacesRaw = null;
  nameCache = null;
  dmLabels = {};
  dmMembers = {};
  senderMaps = {};
  selfNames = new Set();
  selfIdentity = null;
  lastDiag = null;
  await buildNameCache();
  return { refreshed: true, spaces: allSpacesRaw.length, self: selfIdentity };
}

async function whoami() {
  const id = await getSelfIdentity();
  if (id) return id;
  if (!nameCache) await buildNameCache();
  return {
    source: selfNames.size > 0 ? "frequency" : "unknown",
    inferredNames: [...selfNames],
    hint: selfNames.size === 0
      ? "Set GOOGLE_SELF_EMAIL / GOOGLE_SELF_NAME env vars, or re-auth with openid/email/profile scopes."
      : undefined,
  };
}

async function getMembers({ spaceName, pageSize = 100 }) {
  validateSpaceName(spaceName);
  const r = await listAllMembers(getChat(), spaceName, {
    withRetry,
    label: "members.list",
    pageSize,
    maxAttempts: 3,
  });
  const out = r.memberships.map(m => ({
    name: m.name,
    state: m.state,
    role: m.role,
    memberName: m.member?.name,
    displayName: m.member?.displayName,
    type: m.member?.type,
    isSelf: isSelfMember(m),
  }));
  if (r.truncated) {
    return { members: out, truncated: true, pages: r.pages, note: "Member list truncated at page cap (5000)." };
  }
  return out;
}

// Diagnostic: force a fresh DM-resolution pass and report counters.
// Useful when DM displayNames look wrong — exposes whether members.list
// succeeded, whether self-detection fired, and whether the expected scopes
// were granted on the refresh token.
async function debugDmResolution() {
  nameCache = null;
  dmLabels = {};
  dmMembers = {};
  await buildNameCache();
  const spaces = await ensureSpaces();
  const dmsUnnamedTotal = spaces.filter(
    (s) => (s.spaceType || s.type) === "DIRECT_MESSAGE" && (!s.displayName || s.displayName.startsWith("spaces/")),
  ).length;
  const sampleLabelled = Object.entries(dmLabels).slice(0, 5);
  const sampleUnresolvedDms = spaces
    .filter((s) => {
      const t = s.spaceType || s.type;
      if (t !== "DIRECT_MESSAGE") return false;
      if (s.displayName && !s.displayName.startsWith("spaces/")) return false;
      return !dmLabels[s.name];
    })
    .slice(0, 5)
    .map((s) => s.name);
  return {
    diagnostics: lastDiag,
    self: selfIdentity,
    dmsUnnamedTotal,
    dmLabelsResolved: Object.keys(dmLabels).length,
    sampleLabelled: sampleLabelled.map(([spaceName, label]) => ({ spaceName, label })),
    sampleUnresolvedDms,
    hint: "If memberListErr > 0 and firstError mentions 'permission'/'403', the chat.memberships.readonly scope was not granted — re-run auto-setup with updated scopes.",
  };
}

// Tool definitions imported from shared/tools.js — single source of truth
// shared between local stdio and remote HTTP runtimes.

// ── JSON-RPC handler ──
async function handleMessage(msg) {
  const { id, method, params } = msg;
  log(`<< ${method} (id=${id})`);

  if (method === "initialize") {
    const clientVersion = params?.protocolVersion || "2024-11-05";
    sendResponse({ jsonrpc: "2.0", id, result: { protocolVersion: clientVersion, capabilities: { tools: {} }, serverInfo: { name: "google-chat", version: "0.15.0" } } });
    return;
  }
  if (method?.startsWith("notifications/")) return;
  if (method === "ping") { sendResponse({ jsonrpc: "2.0", id, result: {} }); return; }
  if (method === "tools/list") { sendResponse({ jsonrpc: "2.0", id, result: { tools: TOOLS } }); return; }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};
    log(`   tool=${toolName} args=${JSON.stringify(args)}`);
    try {
      let result;
      switch (toolName) {
        case "list_spaces":     result = await listSpaces(); break;
        case "get_messages":    result = await getMessages(args); break;
        case "list_space_threads": result = await listSpaceThreads(args); break;
        case "search_messages": result = await searchMessages(args); break;
        case "send_message":    result = await sendMessage(args); break;
        case "get_space":       result = await getSpace(args); break;
        case "find_dm":         result = await findDm(args); break;
        case "send_to_person":  result = await sendToPerson(args); break;
        case "get_message":     result = await getMessage(args); break;
        case "edit_message":    result = await editMessage(args); break;
        case "delete_message":  result = await deleteMessage(args); break;
        case "refresh_cache":   result = await refreshCache(); break;
        case "whoami":          result = await whoami(); break;
        case "get_members":     result = await getMembers(args); break;
        case "debug_dm_resolution": result = await debugDmResolution(); break;
        default: throw new Error(`Unknown tool: ${toolName}`);
      }
      sendResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
      log(`   >> ${toolName} OK`);
    } catch (err) {
      // Use the structured-error formatter so Chat API errors (accessNotConfigured,
      // PERMISSION_DENIED, NOT_FOUND, etc.) surface reason + Enable URL to the LLM.
      const msg = err?.response?.data ? formatApiError(err) : (err.message || String(err));
      sendResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${msg}` }], isError: true } });
      log(`   >> ${toolName} ERROR: ${msg}`);
    }
    return;
  }

  if (method === "resources/list") { sendResponse({ jsonrpc: "2.0", id, result: { resources: [] } }); return; }
  if (method === "prompts/list") { sendResponse({ jsonrpc: "2.0", id, result: { prompts: [] } }); return; }
  sendResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// ── Stdio framing: newline-delimited JSON (matches MCP SDK ReadBuffer) ──
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const idx = buf.indexOf(10);
    if (idx === -1) break;
    let line = buf.subarray(0, idx).toString("utf8");
    buf = buf.subarray(idx + 1);
    line = line.replace(/\r$/, "");
    if (!line) continue;
    try { const msg = JSON.parse(line); handleMessage(msg).catch((e) => log(`Error: ${e.stack}`)); }
    catch (e) { log(`Parse error: ${e.message}`); }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("uncaughtException", (e) => log(`Uncaught: ${e.stack}`));
process.on("unhandledRejection", (e) => log(`Rejection: ${e}`));
warmFromDisk();
log("server started (v0.17.0 — paginated members, expectType guard, on-disk cache)");
