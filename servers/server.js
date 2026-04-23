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
function getChat() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error(
      "Google credentials not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN. " +
      "Run: node servers/auto-setup.js <CLIENT_ID> <CLIENT_SECRET>"
    );
  }
  if (!_chat) {
    const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    _chat = google.chat({ version: "v1", auth: oauth2Client });
  }
  return _chat;
}

const log = (msg) => process.stderr.write(`[google-chat] ${msg}\n`);
function sendResponse(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

// Reject resource names with path traversal or query injection attempts.
const DANGEROUS_CHARS = /[?#&<>|]/;
function validateSpaceName(name) {
  if (!name || typeof name !== "string") throw new Error("spaceName must be a non-empty string");
  if (name.includes("..") || DANGEROUS_CHARS.test(name))
    throw new Error(`Invalid spaceName: "${name}"`);
  return name;
}
function validateMessageName(name) {
  if (!name || typeof name !== "string") throw new Error("messageName must be a non-empty string");
  if (name.includes("..") || DANGEROUS_CHARS.test(name))
    throw new Error(`Invalid messageName: "${name}"`);
  return name;
}

// ── Name cache ──
let allSpacesRaw = null;
let nameCache = null;
let dmLabels = {}; // spaceName → "Person A, Person B" (non-self members of each DM)

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
      const res = await getChat().spaces.list({ pageSize: 1000, pageToken });
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
  const spaces = await ensureSpaces();
  const cache = {};

  // ── 1. Resolve DM names first so their first-name tokens (e.g. "priya")
  //      win over any same-named keyword in a group space. ──
  const dmSpaces = spaces.filter(s =>
    (s.spaceType || s.type) === "DIRECT_MESSAGE" &&
    (!s.displayName || s.displayName.startsWith("spaces/"))
  );
  if (dmSpaces.length > 0) {
    log(`  Fetching members for ${dmSpaces.length} unnamed DM spaces...`);
    const memberResults = await Promise.allSettled(
      dmSpaces.map(async (space) => {
        const membersRes = await getChat().spaces.members.list({ parent: space.name, pageSize: 20 });
        return { space, members: membersRes.data.memberships || [] };
      })
    );

    // First pass: count name frequency. The caller appears in EVERY DM,
    // so any name that appears in >1 DM is almost certainly the caller.
    const nameFreq = {};
    const perSpaceNames = [];
    let errors = 0;
    for (const r of memberResults) {
      if (r.status !== "fulfilled") { errors++; continue; }
      const names = [];
      for (const m of r.value.members) {
        const n = m.member?.displayName;
        if (n) { names.push(n); nameFreq[n] = (nameFreq[n] || 0) + 1; }
      }
      perSpaceNames.push({ space: r.value.space, names });
    }
    const selfNames = new Set(Object.entries(nameFreq).filter(([_, c]) => c > 1).map(([n]) => n));
    if (selfNames.size > 0) log(`  Detected self: ${[...selfNames].join(", ")}`);

    // Second pass: add only non-self names; also build dmLabels map.
    let hits = 0, emptyDms = 0;
    const labels = {};
    for (const { space, names } of perSpaceNames) {
      const others = names.filter(n => !selfNames.has(n));
      if (others.length === 0) { emptyDms++; continue; }
      for (const n of others) {
        addToCache(cache, n, space.name, "DIRECT_MESSAGE", n);
        hits++;
      }
      labels[space.name] = others.join(", ");
    }
    dmLabels = labels;
    log(`  DM resolution: ${hits} names cached, ${errors} API errors, ${emptyDms} DMs with no resolvable member`);
  }

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
function formatMessage(msg) {
  return {
    name: msg.name,
    text: msg.text || "(no text)",
    sender: msg.sender?.displayName || msg.sender?.name || "Unknown",
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
  if (!displayName) displayName = space.name;
  const out = { name: space.name, displayName, type };
  if (type === "DIRECT_MESSAGE" && label) out.otherMember = label;
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
  const res = await getChat().spaces.messages.list(params);
  return (res.data.messages || []).map(formatMessage);
}

async function getMessage({ messageName }) {
  validateMessageName(messageName);
  const res = await getChat().spaces.messages.get({ name: messageName });
  return formatMessage(res.data);
}

async function editMessage({ messageName, text }) {
  validateMessageName(messageName);
  const res = await getChat().spaces.messages.patch({
    name: messageName,
    updateMask: "text",
    requestBody: { text },
  });
  return formatMessage(res.data);
}

async function deleteMessage({ messageName }) {
  validateMessageName(messageName);
  await getChat().spaces.messages.delete({ name: messageName });
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
    const msgsRes = await getChat().spaces.messages.list({
      parent: matchingSpace.name, pageSize, orderBy: "createTime desc"
    });
    return (msgsRes.data.messages || []).map(msg => ({
      ...formatMessage(msg), space: matchingSpace.displayName || matchingSpace.name
    }));
  }

  const results = [];
  await Promise.allSettled(spaces.map(async (space) => {
    try {
      const msgsRes = await getChat().spaces.messages.list({ parent: space.name, pageSize: 50, orderBy: "createTime desc" });
      for (const msg of msgsRes.data.messages || []) {
        if (msg.text && msg.text.toLowerCase().includes(lowerQuery))
          results.push({ ...formatMessage(msg), space: space.displayName || space.name });
      }
    } catch {}
  }));
  results.sort((a, b) => new Date(b.createTime) - new Date(a.createTime));
  return results.slice(0, pageSize);
}

async function sendMessage({ spaceName, text, threadName }) {
  validateSpaceName(spaceName);
  const body = { text };
  if (threadName) body.thread = { name: threadName };
  const res = await getChat().spaces.messages.create({
    parent: spaceName, requestBody: body,
    messageReplyOption: threadName ? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : undefined,
  });
  return formatMessage(res.data);
}

async function getSpace({ spaceName }) {
  validateSpaceName(spaceName);
  const res = await getChat().spaces.get({ name: spaceName });
  const s = res.data;
  const type = s.spaceType || s.type;
  // For DMs without a useful displayName, fetch members once to enrich.
  if (type === "DIRECT_MESSAGE" && (!s.displayName || s.displayName.startsWith("spaces/")) && !dmLabels[spaceName]) {
    try {
      const m = await getChat().spaces.members.list({ parent: spaceName, pageSize: 20 });
      const members = (m.data.memberships || [])
        .map((x) => x.member?.displayName)
        .filter(Boolean);
      // If we already know self from buildNameCache, filter them out.
      const self = new Set(
        nameCache
          ? Object.values(nameCache)
              .filter((v) => v.type === "DIRECT_MESSAGE")
              .map((v) => v.displayName)
          : []
      );
      const others = members.filter((n) => !self.has(n));
      const label = (others.length ? others : members).join(", ");
      if (label) dmLabels[spaceName] = label;
    } catch {}
  }
  return formatSpace(s);
}

async function findDm({ personName }) {
  const spaceName = await findSpaceByName(personName, { dmOnly: true });
  if (spaceName) return { found: true, spaceName };

  // Fallback: look up email from employee directory → call findDirectMessage
  const email = lookupEmailFromDirectory(personName);
  if (email) {
    try {
      const res = await getChat().spaces.findDirectMessage({ name: `users/${email}` });
      if (res.data?.name) {
        return { found: true, spaceName: res.data.name, resolvedVia: "directory", email };
      }
    } catch {}
  }

  if (!nameCache) await buildNameCache();
  const available = Object.entries(nameCache)
    .filter(([k, v]) => k.length > 2 && v.type === "DIRECT_MESSAGE")
    .map(([k, v]) => `${v.displayName}`)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 50);
  return { found: false, message: `No DM found for "${personName}"`, availableDMs: available };
}

async function sendToPerson({ personName, text, threadName }) {
  let spaceName = await findSpaceByName(personName, { dmOnly: true });

  if (!spaceName) {
    // Fallback: look up email from employee directory → call findDirectMessage
    const email = lookupEmailFromDirectory(personName);
    if (email) {
      try {
        const res = await getChat().spaces.findDirectMessage({ name: `users/${email}` });
        if (res.data?.name) spaceName = res.data.name;
      } catch {}
    }
  }

  if (!spaceName) {
    if (!nameCache) await buildNameCache();
    const names = Object.entries(nameCache)
      .filter(([k, v]) => k.length > 2 && v.type === "DIRECT_MESSAGE")
      .map(([k]) => k)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(", ");
    throw new Error(`No DM found for "${personName}". Available DMs: ${names}`);
  }
  return await sendMessage({ spaceName, text, threadName });
}

async function refreshCache() {
  allSpacesRaw = null;
  nameCache = null;
  dmLabels = {};
  await buildNameCache();
  return { refreshed: true, spaces: allSpacesRaw.length };
}

// ── Tool definitions ──
const TOOLS = [
  { name: "list_spaces", description: "List all Google Chat spaces and DMs.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "get_messages", description: "Get recent messages from a space.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, pageSize: { type: "number" }, filter: { type: "string" } }, required: ["spaceName"] } },
  { name: "search_messages", description: "Search messages across ALL spaces in parallel. If the query matches a space/group name, returns messages from that space. Otherwise searches message text across all spaces.", inputSchema: { type: "object", properties: { query: { type: "string" }, pageSize: { type: "number" } }, required: ["query"] } },
  { name: "send_message", description: "Send a message to a space by space name.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, text: { type: "string" }, threadName: { type: "string" } }, required: ["spaceName", "text"] } },
  { name: "get_space", description: "Get details about a space.", inputSchema: { type: "object", properties: { spaceName: { type: "string" } }, required: ["spaceName"] } },
  { name: "find_dm", description: "Find a person's DM space by name or nickname. Use before send_message when you only know a name.", inputSchema: { type: "object", properties: { personName: { type: "string" } }, required: ["personName"] } },
  { name: "send_to_person", description: "Send a DM to a person by name — resolves their space automatically. Use when user says 'send X to [person name]'.", inputSchema: { type: "object", properties: { personName: { type: "string" }, text: { type: "string" }, threadName: { type: "string" } }, required: ["personName", "text"] } },
  { name: "get_message", description: "Get a single message by its full resource name (e.g. spaces/ABC/messages/XYZ).", inputSchema: { type: "object", properties: { messageName: { type: "string" } }, required: ["messageName"] } },
  { name: "edit_message", description: "Edit the text of an existing message.", inputSchema: { type: "object", properties: { messageName: { type: "string" }, text: { type: "string" } }, required: ["messageName", "text"] } },
  { name: "delete_message", description: "Delete a message by its full resource name.", inputSchema: { type: "object", properties: { messageName: { type: "string" } }, required: ["messageName"] } },
  { name: "refresh_cache", description: "Force-refresh the spaces and name cache. Use if spaces or DMs are missing after changes.", inputSchema: { type: "object", properties: {}, required: [] } },
];

// ── JSON-RPC handler ──
async function handleMessage(msg) {
  const { id, method, params } = msg;
  log(`<< ${method} (id=${id})`);

  if (method === "initialize") {
    const clientVersion = params?.protocolVersion || "2024-11-05";
    sendResponse({ jsonrpc: "2.0", id, result: { protocolVersion: clientVersion, capabilities: { tools: {} }, serverInfo: { name: "google-chat", version: "0.11.0" } } });
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
        default: throw new Error(`Unknown tool: ${toolName}`);
      }
      sendResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
      log(`   >> ${toolName} OK`);
    } catch (err) {
      sendResponse({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } });
      log(`   >> ${toolName} ERROR: ${err.message}`);
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
log("server started (v0.11.0 — DM labels flow into list_spaces & get_space output)");
