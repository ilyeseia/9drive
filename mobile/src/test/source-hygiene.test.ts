import fs from 'node:fs';
import path from 'node:path';

/**
 * Guards against "Trojan Source": invisible bidirectional-control characters embedded in source files can make
 * code display differently from how it executes. The helpers in core/bidi.ts build them from code points instead.
 */
function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|js|json)$/.test(entry.name)) yield full;
  }
}

describe('source hygiene', () => {
  it('contains no literal bidi control characters', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(__dirname, '..'))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0x200e || code === 0x200f) {
          offenders.push(path.relative(path.join(__dirname, '..'), file));
          break;
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
