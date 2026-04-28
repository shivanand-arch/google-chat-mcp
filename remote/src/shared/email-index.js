// Employee directory email index. Local-file lookup; returns null gracefully
// if the file doesn't exist (e.g. on Railway containers).
// Written by the /employee-directory skill to:
//   ~/.claude/skills/employee-directory/data/email_index.json

import { readFileSync } from "fs";
import { homedir } from "os";

const EMAIL_INDEX_PATH = `${homedir()}/.claude/skills/employee-directory/data/email_index.json`;
let _emailIndex = null;

export function getEmailIndex() {
  if (_emailIndex) return _emailIndex;
  try {
    _emailIndex = JSON.parse(readFileSync(EMAIL_INDEX_PATH, "utf8"));
  } catch {
    _emailIndex = {};
  }
  return _emailIndex;
}

/**
 * @returns {{ kind: "none" } | { kind: "unique"; directoryKey: string; email: string } | { kind: "ambiguous"; matches: { name: string; email: string }[] }}
 */
export function matchDirectoryByName(personName) {
  const index = getEmailIndex();
  const query = personName.toLowerCase().trim();
  if (!query) return { kind: "none" };
  if (index[query]) return { kind: "unique", directoryKey: query, email: index[query] };

  const matches = [];
  for (const [name, email] of Object.entries(index)) {
    const nameParts = name.split(" ");
    const queryParts = query.split(/\s+/).filter((w) => w.length > 0);
    if (queryParts.length > 0 && queryParts.every((qp) => nameParts.some((np) => np.startsWith(qp)))) {
      matches.push({ name, email });
    }
  }
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "unique", directoryKey: matches[0].name, email: matches[0].email };
  return { kind: "ambiguous", matches };
}

/** @deprecated Prefer matchDirectoryByName — this returns a single email only when unambiguous. */
export function lookupEmailFromDirectory(personName) {
  const m = matchDirectoryByName(personName);
  if (m.kind === "unique") return m.email;
  return null;
}
