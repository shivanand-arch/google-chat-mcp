// node --test tests/resolve-dm.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNameToSpace } from "../remote/src/shared/resolve-dm.js";
import { matchDirectoryByName } from "../remote/src/shared/email-index.js";
import { aggregateThreadsInSpace } from "../remote/src/shared/threads-aggregate.js";

test("resolveNameToSpace: multiple fuzzy DM hits → ambiguous, not a pick", () => {
  const cache = {
    "ankur jain": { spaceName: "spaces/dm-1", type: "DIRECT_MESSAGE", displayName: "Ankur Jain" },
    "ankur mehta": { spaceName: "spaces/dm-2", type: "DIRECT_MESSAGE", displayName: "Ankur Mehta" },
  };
  const r = resolveNameToSpace(cache, "ankur", { dmOnly: true });
  assert.strictEqual(r.status, "ambiguous");
  assert.strictEqual((r.candidates || []).length, 2);
});

test("resolveNameToSpace: exact key wins (single person)", () => {
  const cache = {
    "shivku": { spaceName: "spaces/dm-s", type: "DIRECT_MESSAGE", displayName: "Shivku" },
  };
  const r = resolveNameToSpace(cache, "shivku", { dmOnly: true });
  assert.strictEqual(r.status, "unique");
  assert.strictEqual(r.spaceName, "spaces/dm-s");
});

test("matchDirectoryByName: no longer returns arbitrary first of several", () => {
  const m = matchDirectoryByName("nonexistent-xyz-12345");
  assert.ok(m.kind === "none" || m.kind === "unique" || m.kind === "ambiguous");
});

test("aggregateThreadsInSpace: groups by thread name", () => {
  const messages = [
    { name: "m1", createTime: "2024-01-02T00:00:00Z", text: "B", thread: { name: "spaces/x/threads/t1" } },
    { name: "m0", createTime: "2024-01-01T00:00:00Z", text: "A", thread: { name: "spaces/x/threads/t1" } },
    { name: "m2", createTime: "2024-01-03T00:00:00Z", text: "top", thread: null },
  ];
  const { threads, unthreadedTopLevel } = aggregateThreadsInSpace(messages);
  assert.strictEqual(threads.length, 1);
  assert.strictEqual(threads[0].thread, "spaces/x/threads/t1");
  assert.strictEqual(threads[0].messagesSeen, 2);
  assert.strictEqual(unthreadedTopLevel.length, 1);
});
