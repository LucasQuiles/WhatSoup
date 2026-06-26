import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redactBotErrorsText } from '../src/lib/bot-errors-outbox.ts';

// BEAD-052 redaction-parity corpus. Ground truth is the Python SSOT
// (deploy/scripts/lib/bot_errors_redaction.py); the matching pytest
// (deploy/scripts/tests/test_bot_errors_redaction_parity.py) asserts the same
// corpus against `redact_bot_errors_text`. Each row carries either a single
// `expected` (TS and Python agree) or per-side `expected_ts`/`expected_py`
// (intentional divergence, with a `rationale`).
interface CorpusRow {
  id: string;
  class: string;
  input: string;
  expected?: string;
  expected_ts?: string;
  expected_py?: string;
  rationale?: string;
}

const CORPUS_PATH = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures',
  'redaction-parity-corpus.jsonl',
);

function loadCorpus(): CorpusRow[] {
  return readFileSync(CORPUS_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CorpusRow);
}

const rows = loadCorpus();

// The default-off path uses the bare `[REDACTED CREDENTIAL PATH]` marker; the
// corpus encodes that default. Pin the safe-shape gate off so the credential
// path row is deterministic regardless of ambient environment.
let savedSafeShape: string | undefined;
beforeAll(() => {
  savedSafeShape = process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'];
  delete process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'];
});
afterAll(() => {
  if (savedSafeShape === undefined) delete process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'];
  else process.env['BOT_ERRORS_SAFE_SHAPE_CRED_PATH'] = savedSafeShape;
});

describe('redaction parity corpus (TS side)', () => {
  it('contains the expected number of rows', () => {
    expect(rows.length).toBeGreaterThanOrEqual(20);
  });

  for (const row of rows) {
    const expected = row.expected_ts ?? row.expected;
    it(`${row.id} (${row.class})`, () => {
      expect(expected, `row ${row.id} must declare expected_ts or expected`).toBeTypeOf('string');
      expect(redactBotErrorsText(row.input)).toBe(expected);
    });
  }

  // C1 ReDoS guard: the keyed-secret `api[_-]?key` alternative previously wrapped
  // `api[_-]?key` in unbounded `[A-Za-z0-9_.-]*` wildcards, which backtracked
  // quadratically on dotted input (~80KB took seconds). The bounded `{0,20}` form
  // keeps the scan linear. A ~100KB dotted input must redact well under a generous
  // bound; the fixed redactor finishes in single-digit milliseconds here.
  it('redacts a ~100KB dotted input without catastrophic backtracking (C1)', () => {
    const dotted = `1${'.1'.repeat(50000)}`; // ~100KB, no `api`/`key` literal
    const start = process.hrtime.bigint();
    const out = redactBotErrorsText(dotted);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsedMs).toBeLessThan(250);
    // No secret key matched, so the adversarial input passes through unchanged.
    expect(out).toBe(dotted);
  });
});
