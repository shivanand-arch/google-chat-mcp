// Local on-disk cache for the CLI server (servers/server.js only).
//
// Why: The first `list_spaces` after a server restart fetches ~all spaces +
// fans out members.list across every unnamed DM (158 round-trips on a heavy
// account). That's a 5-10s cold-start tax every time Claude Code reconnects.
// Persisting the result to disk keeps it warm across restarts.
//
// Why JSON, not SQLite (the architectural sketch said sqlite):
//   - Data shape is tiny (~few hundred kB even on 1000 spaces).
//   - One read on startup, one write per refresh — no SELECT/UPDATE workload
//     that benefits from a relational engine.
//   - `better-sqlite3` is a native dep; first-run install pain isn't worth it
//     when atomic JSON write (write to .tmp, rename) gives the same crash safety.
// If we ever cache message corpora for offline grep, switch to sqlite then.
//
// NOT shared with Railway: this file is imported only from servers/server.js.
// The remote runtime is multi-tenant and stateless; persisting per-user caches
// to a Railway volume would couple sessions that should stay isolated.
//
// Privacy: this cache contains DM partner names, group room names, and DM
// resource IDs — same data the in-memory cache holds. The file is written to
// the user's home dir with default permissions; no need to upload anywhere.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const CACHE_DIR = join(homedir(), ".config", "google-chat-mcp");
const CACHE_PATH = join(CACHE_DIR, "cache.json");
// v2 adds globalSenderMap (userId → displayName, shared across all spaces).
// v1 caches load-but-treat-as-missing this field, so old caches still warm-start.
const CACHE_VERSION = 2;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h — stale beyond this triggers refresh

/**
 * @typedef {object} CachedState
 * @property {number} version
 * @property {number} savedAt              — epoch ms
 * @property {string|null} userId          — guards against cache cross-bleed if account changes
 * @property {Array<any>} spaces           — raw spaces from spaces.list
 * @property {Record<string, any>} nameCache
 * @property {Record<string, string>} dmLabels
 * @property {Record<string, string[]>} dmMembers
 * @property {string[]} selfNames
 * @property {Record<string, string>} globalSenderMap — userId → displayName, accumulated across all spaces
 */

function ensureDir() {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* dir exists */ }
}

/** Load cached state. Returns null if missing, malformed, or wrong user.
 *  Older versions are accepted (forward-compatible) — missing fields just
 *  start empty rather than blocking warm-start on a schema bump. */
export function loadCache(currentUserId) {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const raw = readFileSync(CACHE_PATH, "utf8");
    const data = JSON.parse(raw);
    if (typeof data?.version !== "number") return null;
    // Future-version caches (e.g. someone downgraded the binary) are dropped —
    // we don't know what shape they hold. Older versions: accept and let the
    // missing fields default to empty.
    if (data.version > CACHE_VERSION) return null;
    if (currentUserId && data.userId && data.userId !== currentUserId) return null;
    if (!Array.isArray(data.spaces)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Atomic write: serialize → write to .tmp → rename. Rename is atomic on POSIX,
 * so a crash mid-write never leaves a half-written file.
 */
export function saveCache(state) {
  ensureDir();
  const payload = {
    version: CACHE_VERSION,
    savedAt: Date.now(),
    userId: state.userId || null,
    spaces: state.spaces || [],
    nameCache: state.nameCache || {},
    dmLabels: state.dmLabels || {},
    dmMembers: state.dmMembers || {},
    selfNames: Array.isArray(state.selfNames) ? state.selfNames : [...(state.selfNames || [])],
    globalSenderMap: state.globalSenderMap || {},
  };
  const tmp = `${CACHE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  renameSync(tmp, CACHE_PATH);
}

/** Returns true if the cached state is older than the TTL (default 6h). */
export function isStale(state, ttlMs = DEFAULT_TTL_MS) {
  if (!state || !state.savedAt) return true;
  return (Date.now() - state.savedAt) > ttlMs;
}

export function clearCache() {
  try { if (existsSync(CACHE_PATH)) unlinkSync(CACHE_PATH); } catch { /* ignore */ }
}

export const CACHE_FILE_PATH = CACHE_PATH;
