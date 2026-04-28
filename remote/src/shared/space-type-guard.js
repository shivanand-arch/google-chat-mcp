// expectType guard — protects against accidental cross-routing where name
// resolution returned a DM but the agent meant a group room (or vice-versa).
//
// Resolution order:
//   1. Check the in-memory cached spaces list (no API call) — covers list_spaces /
//      buildNameCache hot paths.
//   2. Fall back to `spaces.get` — one API call, authoritative.
//
// Returns null on success (types match or no expectation) or throws a clear
// error describing the mismatch. The error message names both the expected and
// actual type so the agent can recover (re-resolve the name, ask the user).

const VALID = new Set(["DIRECT_MESSAGE", "GROUP_CHAT", "SPACE"]);

/**
 * @param {object} chat — googleapis chat client (only used on cache miss)
 * @param {string} spaceName — "spaces/XXX"
 * @param {string|undefined} expectType — caller's expected type, or falsy to skip
 * @param {{ cachedSpaces?: any[], withRetry?: Function }} [opts]
 */
export async function assertSpaceType(chat, spaceName, expectType, opts = {}) {
  if (!expectType) return;
  if (!VALID.has(expectType)) {
    throw new Error(
      `expectType must be one of DIRECT_MESSAGE, GROUP_CHAT, SPACE — got "${expectType}"`,
    );
  }

  let actual = null;
  if (opts.cachedSpaces?.length) {
    const hit = opts.cachedSpaces.find((s) => s.name === spaceName);
    if (hit) actual = hit.spaceType || hit.type || null;
  }
  if (!actual) {
    const fetchOnce = () => chat.spaces.get({ name: spaceName });
    const r = opts.withRetry
      ? await opts.withRetry(fetchOnce, { label: "spaces.get(expectType)", maxAttempts: 2 })
      : await fetchOnce();
    actual = r.data?.spaceType || r.data?.type || null;
  }

  if (!actual) {
    throw new Error(`expectType check failed: could not determine type of ${spaceName}`);
  }
  if (actual !== expectType) {
    throw new Error(
      `expectType mismatch: caller required ${expectType} but ${spaceName} is ${actual}. ` +
      `Refusing send. If this is intentional, drop expectType or pass the correct value.`,
    );
  }
}
