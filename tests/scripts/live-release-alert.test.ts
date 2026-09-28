/**
 * emitReleaseAlert's child environment: the allowlist, plus a per-call
 * override that only a caller which asks for it gets (#2481: the
 * release-invariants alert turns the inline log tail off). A stand-in helper
 * prints the environment it received; no BOT ERRORS event is written.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitReleaseAlert } from '../../scripts/lib/live-release-alert.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('whatsoup-release-alert-');

const PAYLOAD = { summary: 's', evidence: 'e', diagnostics: [], severity: 'warning' as const };

function childEnv(env?: Record<string, string>): Record<string, string> {
  const dir = tmp.make('helper');
  const helper = path.join(dir, 'print-env.mjs');
  writeFileSync(helper, 'process.stdout.write(JSON.stringify(process.env));\n');
  const result = emitReleaseAlert(
    { repoRoot: dir, instance: 'test-line', source: 'test-source', emitHelper: helper, python: process.execPath, ...(env ? { env } : {}) },
    PAYLOAD,
    'alert',
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('emitReleaseAlert child environment', () => {
  it('passes a per-call override to the helper (the release-invariants alert: log tail off)', () => {
    expect(childEnv({ BOT_ERRORS_INLINE_LOG_TAIL: '0' }).BOT_ERRORS_INLINE_LOG_TAIL).toBe('0');
  });

  it('without an override, other alert sources are unchanged: the variable is not forwarded from the parent', () => {
    vi.stubEnv('BOT_ERRORS_INLINE_LOG_TAIL', '0');
    vi.stubEnv('LOG_DIR', '/nonexistent/log-dir');
    const env = childEnv();
    expect(env).not.toHaveProperty('BOT_ERRORS_INLINE_LOG_TAIL');
    // The allowlist still applies as before.
    expect(env.LOG_DIR).toBe('/nonexistent/log-dir');
  });
});
