import { describe, expect, it } from 'vitest';

import { redactText } from '../../src/lib/redaction-text.ts';

// The key/value scan is linear in the text, as in the Python SSOT
// (deploy/scripts/tests/test_bot_errors_redaction_linear.py): the end of each
// value's folded line comes from one index of the text's line breaks, not
// from a search per value. At 9dbb5a5d7 pretty-printed JSON took 11 ms at
// 16 KB and 140 ms at 64 KB here, against main's 0 and 2 ms.
const SHAPES: Record<string, [unit: string, prefix: string]> = {
  'json-line': ['"token":"a",', '{'],
  'single-quoted-dict': ["{'token': 'a'}, ", ''],
  'quoted-assignments': ['token="a" ', ''],
  'json-pretty': ['\n  "token": "a",', '{'],
  'card-stop-folded': ['\n token: a,', ''],
  'authorization-lines': ['Authorization: x\n', ''],
};
const SIZES = [32_768, 65_536, 131_072] as const;
// A linear scan stays far below this; the quadratic scan passed it at 128 KB.
const CAP_MS_AT_128_KB = 150;

function text(shape: string, size: number): string {
  const [unit, prefix] = SHAPES[shape]!;
  return prefix + unit.repeat(Math.floor((size - prefix.length) / unit.length));
}

function bestMs(value: string): number {
  redactText(value); // warm the JIT on this shape first
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run += 1) {
    const start = process.hrtime.bigint();
    redactText(value);
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
  }
  return best;
}

describe('redactText key/value scan stays linear', () => {
  for (const shape of Object.keys(SHAPES)) {
    it(`${shape} at 32, 64 and 128 KB`, () => {
      const timings = SIZES.map((size) => bestMs(text(shape, size)));
      SIZES.forEach((size, index) => {
        expect(timings[index], JSON.stringify(timings)).toBeLessThan(CAP_MS_AT_128_KB * size / SIZES[2]);
      });
      // Linear growth from 32 KB to 128 KB is 4x; a quadratic scan grows 16x.
      expect(timings[2], JSON.stringify(timings)).toBeLessThan(8 * Math.max(timings[0]!, 1));
    });

    it(`${shape} still loses every secret value`, () => {
      const secret = ['lastval', 'Q7w8', 'E9r0'].join('');
      expect(redactText(`${text(shape, 32_768)} token="${secret}"`)).not.toContain(secret);
    });
  }
});
