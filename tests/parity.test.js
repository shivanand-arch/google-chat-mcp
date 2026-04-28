// Parity test — guarantees both runtimes expose the identical tool surface.
// If this ever fails, the two runtimes have drifted and the BRD invariant
// (FR-12: local and remote behave the same) is broken.
//
// Deliberately does NOT import remote/src/tools.js or servers/server.js —
// both pull in `googleapis` and other runtime deps that aren't installed at
// the repo root. Instead: import the shared module directly (pure, no deps)
// and static-check the two runtime files for the correct import line.
//
// Run: node --test tests/parity.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TOOLS } from "../remote/src/shared/tools.js";

test("TOOLS covers the 15 documented tools", () => {
  const expectedNames = [
    "list_spaces", "get_messages", "list_space_threads", "search_messages", "send_message",
    "get_space", "find_dm", "send_to_person", "get_message",
    "edit_message", "delete_message", "get_members", "whoami",
    "refresh_cache", "debug_dm_resolution",
  ];
  const actualNames = TOOLS.map((t) => t.name);
  assert.deepStrictEqual(actualNames.sort(), expectedNames.sort());
});

test("every tool has a non-empty description and valid input schema", () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description?.length > 0, `${tool.name}: empty description`);
    assert.strictEqual(tool.inputSchema?.type, "object", `${tool.name}: schema.type`);
    assert.ok(Array.isArray(tool.inputSchema?.required), `${tool.name}: schema.required`);
    assert.strictEqual(typeof tool.inputSchema?.properties, "object", `${tool.name}: schema.properties`);
  }
});

test("write tools all require an identifier argument", () => {
  const writeToolRequirements = {
    send_message: "spaceName",
    send_to_person: "personName",
    edit_message: "messageName",
    delete_message: "messageName",
  };
  for (const [name, required] of Object.entries(writeToolRequirements)) {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool, `${name} missing from TOOLS`);
    assert.ok(
      tool.inputSchema.required.includes(required),
      `${name} must require ${required}`,
    );
  }
});

// Static checks: neither runtime may redeclare TOOLS locally; both must
// route to shared/tools.js. Catches the drift we already observed.

test("servers/server.js imports TOOLS from shared (no local redeclaration)", () => {
  const src = readFileSync(new URL("../servers/server.js", import.meta.url), "utf8");
  assert.match(
    src,
    /import\s*\{\s*TOOLS\s*\}\s*from\s*["']\.\.\/remote\/src\/shared\/tools\.js["']/,
    "servers/server.js must import TOOLS from ../remote/src/shared/tools.js",
  );
  assert.doesNotMatch(
    src,
    /^\s*const\s+TOOLS\s*=\s*\[/m,
    "servers/server.js must not redeclare TOOLS locally",
  );
});

test("remote/src/tools.js re-exports TOOLS from shared (no local redeclaration)", () => {
  const src = readFileSync(new URL("../remote/src/tools.js", import.meta.url), "utf8");
  assert.match(
    src,
    /export\s*\{\s*TOOLS\s*\}\s*from\s*["']\.\/shared\/tools\.js["']/,
    "remote/src/tools.js must re-export TOOLS from ./shared/tools.js",
  );
  assert.doesNotMatch(
    src,
    /^\s*export\s+const\s+TOOLS\s*=\s*\[/m,
    "remote/src/tools.js must not redeclare TOOLS locally",
  );
});
