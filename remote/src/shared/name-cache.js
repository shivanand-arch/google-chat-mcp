// Name-cache helpers for resolving "John" or "panic room" → spaceName.
// `cache` is a plain object the caller owns; these helpers mutate it.

export function addToCache(cache, name, spaceName, type, displayName) {
  if (!name) return;
  const lower = name.toLowerCase().trim();
  if (!lower || lower.startsWith("spaces/")) return;
  const entry = { spaceName, type, displayName };
  cache[lower] = entry;
  const words = lower.split(/[\s\/,:\-]+/).filter((w) => w.length > 1);
  for (const word of words) {
    if (!cache[word]) cache[word] = entry;
  }
}

export function fuzzyMatch(query, key) {
  if (key.includes(query) || query.includes(key)) return true;
  const queryWords = query.split(/\s+/).filter((w) => w.length > 1);
  if (queryWords.length > 0 && queryWords.every((w) => key.includes(w))) return true;
  if (queryWords.some((w) => key.includes(w) && w.length >= 3)) return true;
  return false;
}
