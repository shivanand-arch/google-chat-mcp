// Retry with exponential backoff + jitter on 429/5xx.
// Honors Retry-After header when present. Max 4 attempts by default.
// `logger` is optional; if provided, called with retry-attempt messages.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withRetry(fn, { label = "api-call", maxAttempts = 4, logger } = {}) {
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
      if (logger) logger(`[retry] ${label} ${code} — attempt ${attempt}/${maxAttempts}, waiting ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}
