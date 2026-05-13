import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EventKind } from '../../src/types.ts';
import { ActionSchema } from '../../src/policy/schema.ts';

// One-way drift gate: every shipped EventKind and Action must be mentioned in
// the protection-layer design spec. Removing a stale spec mention does not
// fail this gate; adding a kind or action without documenting it does.
//
// Resolved relative to this test file so the test runs regardless of cwd.
const SPEC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
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

  it('does not retain stale action summaries that contradict shipped v1 behavior', () => {
    expect(SPEC).not.toContain('observe / alert / block / propose / remediate');
    expect(SPEC).not.toContain('remediate:APPLIED');
    expect(SPEC).not.toContain('remediate:FAILED');
    expect(SPEC).toContain('Runtime v1 never emits remediation result labels');
    expect(SPEC).toContain('`observe` / `alert` / `propose_fix:<command>` / `meta_alert`');
  });
});
