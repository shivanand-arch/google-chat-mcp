import { google } from "googleapis";

// ── Credentials (set via env vars) ──
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  process.stderr.write("[google-chat] ERROR: Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN env vars\n");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const chat = google.chat({ version: "v1", auth: oauth2Client });

const log = (msg) => process.stderr.write(`[google-chat] ${msg}\n`);
function sendResponse(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

// ── Name cache ──
let allSpacesRaw = null;
let nameCache = null;

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
    const res = await chat.spaces.list({ pageSize: 200 });
    allSpacesRaw = res.data.spaces || [];
  }
  return allSpacesRaw;
}

async function buildNameCache() {
  log("Building name cache...");
  const spaces = await ensureSpaces();
  const cache = {};

  for (const space of spaces) {
    const type = space.spaceType || space.type;
    const dn = space.displayName || "";
    if (dn && !dn.startsWith("spaces/")) {
      addToCache(cache, dn, space.name, type, dn);
    }
  }

  const dmSpaces = spaces.filter(s =>
    (s.spaceType || s.type) === "DIRECT_MESSAGE" &&
    (!s.displayName || s.displayName.startsWith("spaces/"))
  );
  if (dmSpaces.length > 0) {
    log(`  Fetching members for ${dmSpaces.length} unnamed DM spaces...`);
    const memberResults = await Promise.allSettled(
      dmSpaces.map(async (space) => {
        const membersRes = await chat.spaces.members.list({ parent: space.name, pageSize: 20 });
        return { space, members: membersRes.data.memberships || [] };
      })
    );
    let hits = 0, errors = 0;
    for (const r of memberResults) {
      if (r.status !== "fulfilled") { errors++; continue; }
      const { space, members } = r.value;
      for (const m of members) {
        const name = m.member?.displayName;
        if (name) { addToCache(cache, name, space.name, "DIRECT_MESSAGE", name); hits++; }
      }
    }
    log(`  Members lookup: ${hits} names found, ${errors} errors`);
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
  return {
    name: space.name,
    displayName: space.displayName || space.name,
    type: space.spaceType || space.type,
  };
}

// ── Tool implementations ──
async function listSpaces() {
  const spaces = await ensureSpaces();
  return spaces.map(formatSpace);
}

async function getMessages({ spaceName, pageSize = 25, filter = "" }) {
  const params = { parent: spaceName, pageSize, orderBy: "createTime desc" };
  if (filter) params.filter = filter;
  const res = await chat.spaces.messages.list(params);
  return (res.data.messages || []).map(formatMessage);
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
    const msgsRes = await chat.spaces.messages.list({
      parent: matchingSpace.name, pageSize, orderBy: "createTime desc"
    });
    return (msgsRes.data.messages || []).map(msg => ({
      ...formatMessage(msg), space: matchingSpace.displayName || matchingSpace.name
    }));
  }

  const results = [];
  await Promise.allSettled(spaces.map(async (space) => {
    try {
      const msgsRes = await chat.spaces.messages.list({ parent: space.name, pageSize: 50, orderBy: "createTime desc" });
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
  const body = { text };
  if (threadName) body.thread = { name: threadName };
  const res = await chat.spaces.messages.create({
    parent: spaceName, requestBody: body,
    messageReplyOption: threadName ? "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : undefined,
  });
  return formatMessage(res.data);
}

async function getSpace({ spaceName }) {
  const res = await chat.spaces.get({ name: spaceName });
  return formatSpace(res.data);
}

async function findDm({ personName }) {
  const spaceName = await findSpaceByName(personName, { dmOnly: true });
  if (!spaceName) {
    if (!nameCache) await buildNameCache();
    const available = Object.entries(nameCache)
      .filter(([k, v]) => k.length > 2 && v.type === "DIRECT_MESSAGE")
      .map(([k, v]) => `${v.displayName}`)
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 50);
    return { found: false, message: `No DM found for "${personName}"`, availableDMs: available };
  }
  return { found: true, spaceName };
}

async function sendToPerson({ personName, text, threadName }) {
  const spaceName = await findSpaceByName(personName, { dmOnly: true });
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

// ── Tool definitions ──
const TOOLS = [
  { name: "list_spaces", description: "List all Google Chat spaces and DMs.", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "get_messages", description: "Get recent messages from a space.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, pageSize: { type: "number" }, filter: { type: "string" } }, required: ["spaceName"] } },
  { name: "search_messages", description: "Search messages across ALL spaces in parallel. If the query matches a space/group name, returns messages from that space. Otherwise searches message text across all spaces.", inputSchema: { type: "object", properties: { query: { type: "string" }, pageSize: { type: "number" } }, required: ["query"] } },
  { name: "send_message", description: "Send a message to a space by space name.", inputSchema: { type: "object", properties: { spaceName: { type: "string" }, text: { type: "string" }, threadName: { type: "string" } }, required: ["spaceName", "text"] } },
  { name: "get_space", description: "Get details about a space.", inputSchema: { type: "object", properties: { spaceName: { type: "string" } }, required: ["spaceName"] } },
  { name: "find_dm", description: "Find a person's DM space by name or nickname. Use before send_message when you only know a name.", inputSchema: { type: "object", properties: { personName: { type: "string" } }, required: ["personName"] } },
  { name: "send_to_person", description: "Send a DM to a person by name — resolves their space automatically. Use when user says 'send X to [person name]'.", inputSchema: { type: "object", properties: { personName: { type: "string" }, text: { type: "string" }, threadName: { type: "string" } }, required: ["personName", "text"] } },
];

// ── JSON-RPC handler ──
async function handleMessage(msg) {
  const { id, method, params } = msg;
  log(`<< ${method} (id=${id})`);

  if (method === "initialize") {
    const clientVersion = params?.protocolVersion || "2024-11-05";
    sendResponse({ jsonrpc: "2.0", id, result: { protocolVersion: clientVersion, capabilities: { tools: {} }, serverInfo: { name: "google-chat", version: "0.7.0" } } });
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
log("server started (v7 — SDK-free, NDJSON, DM-only person resolution, smart search)");
