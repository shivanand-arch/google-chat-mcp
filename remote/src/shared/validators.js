// Input validation for Google Chat API resource names.
// Rejects path traversal, URL-encoding bypass, query/fragment injection,
// control chars, and invisible/bidi Unicode that could spoof display names.
// Ported from googleworkspace/cli validate.rs.

export function isDangerousUnicode(code) {
  return (code >= 0x200B && code <= 0x200D) || // zero-width: ZWSP, ZWNJ, ZWJ
    code === 0xFEFF ||                          // BOM
    (code >= 0x202A && code <= 0x202E) ||       // bidi: LRE, RLE, PDF, LRO, RLO
    (code >= 0x2028 && code <= 0x2029) ||       // line/paragraph separators
    (code >= 0x2066 && code <= 0x2069);         // directional isolates
}

export function validateResourceName(s, label = "name") {
  if (!s || typeof s !== "string") throw new Error(`${label} must be a non-empty string`);
  if (s.split("/").some((seg) => seg === ".."))
    throw new Error(`${label} must not contain path traversal ('..'): "${s}"`);
  if (s.includes("?") || s.includes("#"))
    throw new Error(`${label} must not contain '?' or '#': "${s}"`);
  if (s.includes("%"))
    throw new Error(`${label} must not contain '%' (URL-encoding bypass): "${s}"`);
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0 || (code < 0x20) || (code >= 0x7F && code <= 0x9F))
      throw new Error(`${label} must not contain control chars: "${s}"`);
    if (isDangerousUnicode(code))
      throw new Error(`${label} must not contain invisible/bidi Unicode: "${s}"`);
  }
  return s;
}

export const validateSpaceName = (n) => validateResourceName(n, "spaceName");
export const validateMessageName = (n) => validateResourceName(n, "messageName");
