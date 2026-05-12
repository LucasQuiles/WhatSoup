import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventKind } from '../../src/types.ts';
import { ActionSchema } from '../../src/policy/schema.ts';

// One-way drift gate: every shipped EventKind and Action must be mentioned in
// the protection-layer design spec. Removing a stale spec mention does not
// fail this gate; adding a kind or action without documenting it does.
//
// Resolved relative to this test file so the test runs regardless of cwd.
const SPEC_PATH = resolve(
  new URL('.', import.meta.url).pathname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'specs',
  '2026-05-08-whatsoup-protection-layer-design.md',
);
const SPEC = readFileSync(SPEC_PATH, 'utf8');

describe('spec surface', () => {
  it('mentions every shipped EventKind', () => {
    for (const kind of EventKind.options) {
      expect(
        SPEC.includes('`' + kind + '`'),
        `EventKind \`${kind}\` not mentioned in protection-layer spec at ${SPEC_PATH}`,
      ).toBe(true);
    }
  });

  it('mentions every shipped Action', () => {
    for (const action of ActionSchema.options) {
      expect(
        SPEC.includes('`' + action + '`'),
        `Action \`${action}\` not mentioned in protection-layer spec at ${SPEC_PATH}`,
      ).toBe(true);
    }
  });
});
