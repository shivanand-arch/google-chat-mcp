// Resolve `users/<id>` → "Display Name" via Google People API directory.
//
// The senderMap fed by USER_MENTION harvesting + DM-member listing covers ~95%
// of users in practice, but two classes slip through:
//
//   1. DM partners: under user auth, members.list returns `{name, type}` only —
//      `displayName` is null. So a DM with a person who has never @mentioned
//      anyone in a space we share stays unresolved as "DM (unresolved)".
//   2. Orphan senders in group spaces: a user who posts but is never @mentioned
//      and shares no DM with us. Rare, but real (Arun Pandey class — observed
//      in production logs).
//
// People API `people:batchGet` with `directory.readonly` scope and source
// `READ_SOURCE_TYPE_DIRECTORY_PROFILE` resolves any user in the org workspace
// directory by their numeric Google account ID. The Chat user ID portion of
// `users/<id>` is the same numeric ID People API expects under `people/<id>`.
//
// Cost: 1 API call per up-to-200 IDs. We only call when the senderMap has
// unresolved IDs after the cheap (free) harvest paths, so this is a safety
// net rather than the primary mechanism.

// People API caps batchGet at 200 resourceNames per request.
const BATCH_SIZE = 200;

// Convert "users/<id>" → "people/<id>" (People API resource convention).
// Returns null for malformed inputs so the caller can filter.
function userIdToResourceName(userId) {
  if (!userId || typeof userId !== "string") return null;
  const m = /^users\/(.+)$/.exec(userId);
  if (!m) return null;
  const id = m[1];
  // People API resourceNames are numeric Google IDs. Reject anything that
  // doesn't look numeric — spam IDs, app users, etc. would 400 the batch.
  if (!/^\d+$/.test(id)) return null;
  return `people/${id}`;
}

function resourceNameToUserId(rn) {
  if (!rn || typeof rn !== "string") return null;
  const m = /^people\/(.+)$/.exec(rn);
  if (!m) return null;
  return `users/${m[1]}`;
}

// Pick the best display name from a Person resource. People API returns
// `names` ordered by metadata; primary wins, falls back to first entry.
function pickName(person) {
  const names = person?.names || [];
  if (!names.length) return null;
  const primary = names.find((n) => n?.metadata?.primary) || names[0];
  if (primary?.displayName) return primary.displayName;
  if (primary?.unstructuredName) return primary.unstructuredName;
  const composed = [primary?.givenName, primary?.familyName].filter(Boolean).join(" ");
  return composed || null;
}

/**
 * Resolve a set of `users/<id>` strings via People API directory lookups.
 *
 * @param {object} people  googleapis people("v1") client (auth pre-bound)
 * @param {Iterable<string>} userIds  set/array of "users/<id>" strings
 * @param {object} [opts]
 * @param {Function} [opts.withRetry]  optional retry wrapper from the caller
 * @param {string}   [opts.label]      log label, default "people.batchGet"
 * @returns {Promise<Map<string, string>>}  Map of "users/<id>" → "Display Name"
 *   (only resolved entries; failures and unmappable IDs are silently dropped)
 */
export async function resolveViaDirectory(people, userIds, opts = {}) {
  const out = new Map();
  if (!people || !userIds) return out;

  const seen = new Set();
  const validResources = [];
  const reverse = new Map(); // resourceName → original userId
  for (const uid of userIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    const rn = userIdToResourceName(uid);
    if (!rn) continue;
    validResources.push(rn);
    reverse.set(rn, uid);
  }
  if (validResources.length === 0) return out;

  const { withRetry, label = "people.batchGet" } = opts;

  for (let i = 0; i < validResources.length; i += BATCH_SIZE) {
    const slice = validResources.slice(i, i + BATCH_SIZE);
    // sources: READ_SOURCE_TYPE_PROFILE covers account + workspace domain
    // profile + general profile. Combined with directory.readonly scope, this
    // resolves any user in the org workspace directory.
    const call = () => people.people.getBatchGet({
      resourceNames: slice,
      personFields: "names,emailAddresses",
      sources: ["READ_SOURCE_TYPE_PROFILE"],
    });
    try {
      const res = withRetry
        ? await withRetry(call, { label, maxAttempts: 2 })
        : await call();
      const responses = res?.data?.responses || [];
      for (const r of responses) {
        const rn = r.requestedResourceName || r.person?.resourceName;
        const uid = reverse.get(rn) || resourceNameToUserId(rn);
        if (!uid) continue;
        if (r.status && r.status.code && r.status.code !== 0) continue; // entry-level failure
        const name = pickName(r.person);
        if (name) out.set(uid, name);
      }
    } catch (err) {
      // Whole-batch failure — log once and keep going. Caller still has the
      // raw IDs; we just don't enrich for this batch.
      console.log("[people.batchGet.err]", JSON.stringify({
        batch: slice.length,
        code: err?.code || err?.response?.status,
        reason: err?.response?.data?.error?.errors?.[0]?.reason,
        message: err?.message,
      }));
    }
  }
  return out;
}

/**
 * Scan messages for sender IDs not present in `senderMap`. Returns the set
 * of orphan `users/<id>` keys. Caller decides whether to call resolveViaDirectory
 * on the result.
 */
export function collectOrphanSenders(messages, senderMap) {
  const orphans = new Set();
  for (const m of messages || []) {
    const id = m?.sender?.name;
    if (!id || typeof id !== "string") continue;
    if (!id.startsWith("users/")) continue;
    if (senderMap[id]) continue;
    orphans.add(id);
  }
  return orphans;
}
