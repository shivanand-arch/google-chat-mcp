// Group recent `spaces.messages` results into per-thread rollups. One room has
// many threads; the API does not give a single “thread title” — we surface a
// snippet from messages seen in the sample so the agent can map nicknames
// like “the RCA thread” to `thread` (resource name) for `send_message`.

const SNIPPET_MAX = 220;

/**
 * @param {object[]} messages - raw messages from `spaces.messages.list`
 * @param {{ maxThreadRows?: number, maxUnthreaded?: number }} [opts]
 */
export function aggregateThreadsInSpace(messages, opts = {}) {
  const { maxThreadRows = 50, maxUnthreaded = 15 } = opts;
  /** @type {Map<string, { thread: string, threadKey: string | null, messagesSeen: number, lastCreateTime: string, snippet: string }>} */
  const byThread = new Map();
  const unthreaded = [];

  for (const m of messages) {
    const tn = m.thread?.name;
    if (tn) {
      if (!byThread.has(tn)) {
        byThread.set(tn, {
          thread: tn,
          threadKey: m.thread?.threadKey ?? null,
          messagesSeen: 0,
          lastCreateTime: m.createTime,
          snippet: (m.text || "(no text)").slice(0, SNIPPET_MAX),
        });
      }
      const rec = byThread.get(tn);
      rec.messagesSeen += 1;
      if (m.createTime > rec.lastCreateTime) {
        rec.lastCreateTime = m.createTime;
        if (m.text) rec.snippet = m.text.slice(0, SNIPPET_MAX);
      }
    } else {
      if (unthreaded.length < maxUnthreaded) {
        unthreaded.push({
          name: m.name,
          createTime: m.createTime,
          snippet: (m.text || "(no text)").slice(0, SNIPPET_MAX),
        });
      }
    }
  }

  const threads = [...byThread.values()]
    .sort((a, b) => (b.lastCreateTime || "").localeCompare(a.lastCreateTime || ""))
    .slice(0, maxThreadRows);
  return { threads, unthreadedTopLevel: unthreaded };
}
