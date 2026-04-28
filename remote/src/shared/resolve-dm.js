// Resolves a person/space name string → Chat space (DM or group) without
// silent mis-picks. Used by find_dm and send_to_person.
//
// Previous bug: on multiple fuzzy matches the server picked the "shortest key",
// which could route messages to the wrong person when two DMs shared a token
// (e.g. two "Ankur"s). We now return explicit { status: "ambiguous" } instead.

import { fuzzyMatch } from "./name-cache.js";

/**
 * @typedef {{ spaceName: string, type: string, displayName: string }} NameCacheEntry
 * @param {Record<string, NameCacheEntry>} nameCache
 * @param {string} personName
 * @param {{ dmOnly?: boolean }} [opts]
 * @returns {
 *   | { status: "none" }
 *   | { status: "unique"; spaceName: string; matchType: "exact" | "fuzzy"; displayName: string; matchedKey?: string }
 *   | { status: "ambiguous"; candidates: Array<{ spaceName: string; displayName: string; spaceType: string; matchedKey: string }> }
 * }
 */
export function resolveNameToSpace(nameCache, personName, { dmOnly = false } = {}) {
  if (!nameCache || typeof nameCache !== "object") {
    return { status: "none" };
  }
  const query = (personName || "").toLowerCase().trim();
  if (!query) return { status: "none" };

  const direct = nameCache[query];
  if (direct) {
    if (!dmOnly || direct.type === "DIRECT_MESSAGE") {
      return {
        status: "unique",
        spaceName: direct.spaceName,
        matchType: "exact",
        displayName: direct.displayName,
        matchedKey: query,
      };
    }
    // Exact key is a group while dmOnly — fall through to fuzzy DM search.
  }

  const seen = new Map();
  for (const [key, entry] of Object.entries(nameCache)) {
    if (!entry || typeof entry !== "object") continue;
    if (dmOnly && entry.type !== "DIRECT_MESSAGE") continue;
    if (!fuzzyMatch(query, key)) continue;
    if (!seen.has(entry.spaceName)) {
      seen.set(entry.spaceName, { key, spaceName: entry.spaceName, type: entry.type, displayName: entry.displayName });
    }
  }
  const list = [...seen.values()];
  if (list.length === 0) return { status: "none" };
  if (list.length === 1) {
    return {
      status: "unique",
      spaceName: list[0].spaceName,
      matchType: "fuzzy",
      displayName: list[0].displayName,
      matchedKey: list[0].key,
    };
  }
  list.sort((a, b) => (a.displayName || a.key).localeCompare(b.displayName || b.key));
  return {
    status: "ambiguous",
    candidates: list.map((c) => ({
      spaceName: c.spaceName,
      displayName: c.displayName,
      spaceType: c.type,
      matchedKey: c.key,
    })),
  };
}
