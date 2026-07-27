import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CUTOVER = resolve(import.meta.dirname, '../../scripts/cutover.sh');

describe('cutover temporary-file portability', () => {
  it('uses explicit TMPDIR templates instead of platform-dependent mktemp -t', () => {
    const source = readFileSync(CUTOVER, 'utf8');

    expect(source).not.toContain('mktemp -t');
    expect(source).toContain('mktemp "${TMPDIR:-/tmp}/whatsoup-test.XXXXXX"');
    expect(source).toContain('mktemp "${TMPDIR:-/tmp}/whatsoup-migrate-dry.XXXXXX"');
    expect(source).toContain('mktemp "${TMPDIR:-/tmp}/whatsoup-migrate.XXXXXX"');
  });
});
