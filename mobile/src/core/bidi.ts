/**
 * Unicode bidirectional-control helpers.
 *
 * The control characters are built from numeric code points on purpose: writing them as literal characters (or
 * escapes that tooling may expand) would put invisible direction-changing characters into the source file itself,
 * which is a known attack on code review ("Trojan Source").
 */

const cc = (code: number): string => String.fromCharCode(code);

/** Left-to-right isolate. */
export const LRI = cc(0x2066);
/** First-strong isolate. */
export const FSI = cc(0x2068);
/** Pop directional isolate. */
export const PDI = cc(0x2069);
/** Right-to-left override: the classic file-name spoofing character. */
export const RLO = cc(0x202e);

export function isBidiControl(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** Removes embedded embedding/override/isolate controls (they could close an isolate early or reorder text). */
export function stripBidiControls(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (!isBidiControl(code)) out += ch;
  }
  return out;
}
