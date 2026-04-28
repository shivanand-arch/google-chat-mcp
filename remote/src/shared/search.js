// Search fan-out constants and helpers.
// Accuracy > economy: don't cap fan-out. If 50 spaces match "ECC", we search all 50.
// withRetry + Promise.allSettled absorbs rate-limit blips; the caller can always narrow.

import { withRetry } from "./retry.js";

export const SEARCH_API_PAGE_SIZE = 100;            // messages per API page
export const SEARCH_MAX_PAGES_PER_SPACE = 6;        // per-space hard stop: 6 × 100 = 600 messages
export const SEARCH_TOTAL_MSG_BUDGET = 20000;       // org-wide safety net across all scanned spaces
export const SEARCH_DEFAULT_SINCE_DAYS = 30;        // default time window for text grep
export const SEARCH_MAX_SINCE_DAYS = 365;           // clamp to protect runtime
export const SEARCH_RESULT_HARD_CAP = 200;          // ceiling on consolidated hits returned to caller

export const SEARCH_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "at", "by", "with",
]);

export function tokenizeQuery(lower) {
  const toks = lower.split(/\s+/).filter((t) => t.length >= 2 && !SEARCH_STOPWORDS.has(t));
  return toks.length ? toks : [lower];
}

// Paginate through messages in a space within the time window, up to per-space cap.
// Filters server-side via Google Chat API's `filter: "createTime > ..."` so quiet
// spaces cost ~1 page, not 6. textFilter=false collects all messages (browse mode).
export async function scanSpaceForText(chat, space, { lower, timeFilter, textFilter = true, budget, logger } = {}) {
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
      () => chat.spaces.messages.list(params),
      { label: `messages.list(${space.name})`, maxAttempts: 2, logger },
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
