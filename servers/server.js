import { google } from "googleapis";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname } from "path";

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
  // partial: any index key that starts with the query word, or vice-versa
  for (const [name, email] of Object.entries(index)) {
    const nameParts = name.split(" ");
    const queryParts = query.split(" ");
    if (queryParts.every((qp) => nameParts.some((np) => np.startsWith(qp)))) {
      return email;
    }
  }
  return null;
}

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
        const membersRes = await withRetry(
          () => getChat().spaces.members.list({ parent: space.name, pageSize: 20 }),
          { label: `members.list(${space.name})` },
        );
        return { space, members: membersRes.data.memberships || [] };
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
  return cache;
}

function fuzzyMatch(query, key) {
  if (key.includes(query) || query.includes(key)) return true;
  const queryWords = query.split(/\s+/).filter(w => w.length > 1);
  if (queryWords.length > 0 && queryWords.every(w => key.includes(w))) return true;
  if (queryWords.some(w => key.includes(w) && w.length >= 3)) return true;
  return false;
}

async function findSpaceByName(personName, { dmOnly = false } = {}) {
  if (!nameCache) await buildNameCache();
  const query = personName.toLowerCase().trim();

  // Exact match
  if (nameCache[query]) {
    const entry = nameCache[query];
    if (!dmOnly || entry.type === "DIRECT_MESSAGE") return entry.spaceName;
  }

  // Fuzzy match
  const matches = [];
  for (const [key, entry] of Object.entries(nameCache)) {
    if (dmOnly && entry.type !== "DIRECT_MESSAGE") continue;
    if (fuzzyMatch(query, key)) matches.push({ key, ...entry });
  }
  if (matches.length === 1) return matches[0].spaceName;
  if (matches.length > 1) {
    // Prefer shorter keys (more specific matches)
    return matches.sort((a, b) => a.key.length - b.key.length)[0].spaceName;
  }

  return null;
}

// ── Helpers ──
function formatMessage(msg, senderMap = {}) {
  const id = msg.sender?.name;
  return {
    name: msg.name,
    text: msg.text || "(no text)",
    sender: msg.sender?.displayName || senderMap[id] || id || "Unknown",
    senderId: id,
    createTime: msg.createTime,
    thread: msg.thread?.name,
  };
}
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

async function searchMessages({ query, pageSize = 25 }) {
  const spaces = await ensureSpaces();
  const lowerQuery = query.toLowerCase();

  const matchingSpace = spaces.find(s => {
    const dn = (s.displayName || "").toLowerCase();
    if (!dn || dn.startsWith("spaces/")) return false;
    return dn.includes(lowerQuery) || lowerQuery.includes(dn) ||
      lowerQuery.split(/\s+/).every(w => w.length > 1 && dn.includes(w));
  });

  if (matchingSpace) {
    log(`  search matched space: ${matchingSpace.displayName} (${matchingSpace.name})`);
    const [msgsRes, senderMap] = await Promise.all([
      withRetry(
        () => getChat().spaces.messages.list({
          parent: matchingSpace.name, pageSize, orderBy: "createTime desc",
        }),
        { label: "messages.list(matched)" },
      ),
      ensureSenderMap(matchingSpace.name),
    ]);
    return (msgsRes.data.messages || []).map(msg => ({
      ...formatMessage(msg, senderMap), space: matchingSpace.displayName || matchingSpace.name,
    }));
  }

  const results = [];
  await Promise.allSettled(spaces.map(async (space) => {
    try {
      const msgsRes = await withRetry(
        () => getChat().spaces.messages.list({ parent: space.name, pageSize: 50, orderBy: "createTime desc" }),
        { label: `messages.list(${space.name})`, maxAttempts: 2 },
      );
      const hits = (msgsRes.data.messages || []).filter((m) => m.text && m.text.toLowerCase().includes(lowerQuery));
      if (!hits.length) return;
      const senderMap = await ensureSenderMap(space.name);
      for (const msg of hits) {
        results.push({ ...formatMessage(msg, senderMap), space: space.displayName || space.name });
      }
    } catch {}
  }));
  results.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
  return results.slice(0, pageSize);
}

async function sendMessage({
  spaceName, text, cardsV2, threadName, threadKey, replyOption, messageId, privateToUserId,
}) {
  validateSpaceName(spaceName);
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
      const m = await withRetry(
        () => getChat().spaces.members.list({ parent: spaceName, pageSize: 20 }),
        { label: "members.list(get_space)" },
      );
      const memberships = m.data.memberships || [];
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

// Resolve personName → DM space. Order: cache → employee-directory email
// → findDirectMessage. Returns { spaceName, resolvedVia, email? } or null.
async function resolvePersonToDm(personName) {
  const cached = await findSpaceByName(personName, { dmOnly: true });
  if (cached) return { spaceName: cached, resolvedVia: "cache" };

  const email = lookupEmailFromDirectory(personName);
  if (email) {
    try {
      validateResourceName(email, "email");
      const res = await withRetry(
        () => getChat().spaces.findDirectMessage({ name: `users/${email}` }),
        { label: "findDirectMessage", maxAttempts: 2 },
      );
      if (res.data?.name) {
        return { spaceName: res.data.name, resolvedVia: "findDirectMessage", email };
      }
    } catch (e) {
      log(`findDirectMessage(${email}) failed: ${formatApiError(e)}`);
    }
  }
  return null;
}

async function findDm({ personName }) {
  const resolved = await resolvePersonToDm(personName);
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

async function getMembers({ spaceName, pageSize = 50 }) {
  validateSpaceName(spaceName);
  const res = await withRetry(
    () => getChat().spaces.members.list({ parent: spaceName, pageSize }),
    { label: "members.list" },
  );
  return (res.data.memberships || []).map(m => ({
    name: m.name,
    state: m.state,
    role: m.role,
    memberName: m.member?.name,
    displayName: m.member?.displayName,
    type: m.member?.type,
    isSelf: isSelfMember(m),
  }));
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

// ── Tool definitions ──
const TOOLS = [
  { name: "list_spaces", description: "List all Google Chat spaces and DMs.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "get_messages", description: "Get recent messages from a space.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, pageSize: { type: "number" }, filter: { type: "string" } }, required: ["spaceName"] } },
  { name: "search_messages", description: "Search messages across ALL spaces in parallel. If the query matches a space/group name, returns messages from that space. Otherwise searches message text across all spaces.", inputSchema: { type: "object", properties: { query: { type: "string" }, pageSize: { type: "number" } }, required: ["query"] } },
  { name: "send_message", description: "Send a message to a space. Supports plain text, cardsV2, threaded replies (threadName/threadKey), messageId (idempotency), and privateMessageViewer.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, text: { type: "string" }, cardsV2: { type: "array" }, threadName: { type: "string" }, threadKey: { type: "string" }, replyOption: { type: "string" }, messageId: { type: "string" }, privateToUserId: { type: "string" } }, required: ["spaceName"] } },
  { name: "get_space", description: "Get details about a space including members (for DMs).", inputSchema: { type: "object", properties: { spaceName: { type: "string" } }, required: ["spaceName"] } },
  { name: "find_dm", description: "Find a person's DM space by name or nickname. Use before send_message when you only know a name.", inputSchema: { type: "object", properties: { personName: { type: "string" } }, required: ["personName"] } },
  { name: "send_to_person", description: "Send a DM to a person by name — resolves their space automatically. Use when user says 'send X to [person name]'.", inputSchema: { type: "object", properties: { personName: { type: "string" }, text: { type: "string" }, cardsV2: { type: "array" }, threadName: { type: "string" }, messageId: { type: "string" } }, required: ["personName"] } },
  { name: "get_message", description: "Get a single message by its full resource name (e.g. spaces/ABC/messages/XYZ).", inputSchema: { type: "object", properties: { messageName: { type: "string" } }, required: ["messageName"] } },
  { name: "edit_message", description: "Edit the text or cardsV2 content of an existing message.", inputSchema: { type: "object", properties: { messageName: { type: "string" }, text: { type: "string" }, cardsV2: { type: "array" } }, required: ["messageName"] } },
  { name: "delete_message", description: "Delete a message by its full resource name.", inputSchema: { type: "object", properties: { messageName: { type: "string" } }, required: ["messageName"] } },
  { name: "get_members", description: "List members of a space with role, state, and isSelf flag.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, pageSize: { type: "number" } }, required: ["spaceName"] } },
  { name: "whoami", description: "Return the authenticated caller's identity (email, displayName, userId). Use when unsure which account is authenticated or to debug DM self-filtering.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "refresh_cache", description: "Force-refresh the spaces, members, and name cache.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "debug_dm_resolution", description: "Diagnostic tool: forces a fresh DM-name resolution pass and returns counters.", inputSchema: { type: "object", properties: {}, required: [] } },
];

// ── JSON-RPC handler ──
async function handleMessage(msg) {
  const { id, method, params } = msg;
  log(`<< ${method} (id=${id})`);

  if (method === "initialize") {
    const clientVersion = params?.protocolVersion || "2024-11-05";
    sendResponse({ jsonrpc: "2.0", id, result: { protocolVersion: clientVersion, capabilities: { tools: {} }, serverInfo: { name: "google-chat", version: "0.14.0" } } });
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
log("server started (v0.14.0 — parity with remote: rich send schemas, debug_dm_resolution, buildNameCache diagnostics)");
