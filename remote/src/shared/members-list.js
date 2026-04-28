// Paginated members.list — fetches every page of memberships for a space.
// Without this, a DM/space with > pageSize members silently truncates: the
// caller's display name might be missing, dmLabels comes out half-empty, and
// `get_members` returns a partial roster.
//
// Page caps:
//   - Per-page: 100 (Chat API max)
//   - Total pages: 50 (5,000 members) — guardrail against runaway loops on
//     the very rare giant space; nobody has DMs that big in practice.
//
// `withRetry` is injected so callers can use whichever retry implementation
// their runtime already has (servers/stdio and remote/HTTP each ship a copy).

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * @param {object} chat — googleapis chat client
 * @param {string} spaceName — "spaces/XXX"
 * @param {{ withRetry: Function, label?: string, pageSize?: number, maxAttempts?: number }} opts
 * @returns {Promise<{ memberships: any[], pages: number, truncated: boolean }>}
 */
export async function listAllMembers(chat, spaceName, opts) {
  const {
    withRetry,
    label = `members.list(${spaceName})`,
    pageSize = DEFAULT_PAGE_SIZE,
    maxAttempts = 3,
  } = opts || {};
  if (typeof withRetry !== "function") {
    throw new Error("listAllMembers: opts.withRetry function is required");
  }
  const memberships = [];
  let pageToken;
  let pages = 0;
  let truncated = false;
  do {
    const params = { parent: spaceName, pageSize };
    if (pageToken) params.pageToken = pageToken;
    const r = await withRetry(
      () => chat.spaces.members.list(params),
      { label, maxAttempts },
    );
    const batch = r.data.memberships || [];
    memberships.push(...batch);
    pages++;
    pageToken = r.data.nextPageToken;
    if (pages >= MAX_PAGES) {
      truncated = !!pageToken;
      break;
    }
  } while (pageToken);
  return { memberships, pages, truncated };
}
