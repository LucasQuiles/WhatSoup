// tests/lib/recovery-authority-store.test.ts
// Sequential format and compatibility tests for recovery-authority markers.
// Cross-process serialization is proved by the sibling concurrency suite.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Hoisted vi.mock via the sanctioned logger mock helper.
// warnSpy lets tests assert on module-level log.warn calls.
import { loggerMock } from '../helpers/logger-mock.ts';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    ...loggerMock().createChildLogger(),
    warn: warnSpy,
  }),
}));

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'recovery-auth-test-'));
  process.env['BOT_ERRORS_STATE_DIR'] = tmpRoot;
  warnSpy.mockClear();
});

afterEach(() => {
  delete process.env['BOT_ERRORS_STATE_DIR'];
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: loadRecoveryMarkers logs a warning for a corrupt marker file,
//         returning an empty set instead of crashing, and preserves the file.
// ---------------------------------------------------------------------------
describe('loadRecoveryMarkers', () => {
  it('logs warning for corrupt file, returns empty set, preserves file', async () => {
    const markerPath = join(tmpRoot, 'recovery-authority.json');
    writeFileSync(markerPath, '{invalid}', 'utf-8');

    const { loadRecoveryMarkers } = await import('../../src/lib/recovery-authority-store.ts');
    const markers = loadRecoveryMarkers();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
    expect(markers).toBeInstanceOf(Set);
    expect(markers.size).toBe(0);
    // File is preserved after corrupt read (not deleted by the handler).
    expect(existsSync(markerPath)).toBe(true);
  });

  it('returns empty set for missing file', async () => {
    const { loadRecoveryMarkers } = await import('../../src/lib/recovery-authority-store.ts');
    const markers = loadRecoveryMarkers();

    expect(markers).toBeInstanceOf(Set);
    expect(markers.size).toBe(0);
  });
});

describe('clearRecoveryMarker', () => {
  it('writes an empty object when the final marker is removed', async () => {
    const { setRecoveryMarker, clearRecoveryMarker } = await import(
      '../../src/lib/recovery-authority-store.ts'
    );

    setRecoveryMarker('test-source');
    clearRecoveryMarker('test-source');

    const markerPath = join(tmpRoot, 'recovery-authority.json');
    // Sequential format contract: clearing the final marker persists an empty
    // object. Cross-process serialization is proved only by the sibling
    // recovery-authority-store-concurrency suite.
    expect(existsSync(markerPath)).toBe(true);

    const content = readFileSync(markerPath, 'utf-8');
    expect(JSON.parse(content)).toEqual({});
  });

  it('is no-op for never-set marker (file not created)', async () => {
    const { clearRecoveryMarker, loadRecoveryMarkers } = await import(
      '../../src/lib/recovery-authority-store.ts'
    );

    clearRecoveryMarker('ghost-source');

    const markerPath = join(tmpRoot, 'recovery-authority.json');
    expect(existsSync(markerPath)).toBe(false);

    const markers = loadRecoveryMarkers();
    expect(markers.size).toBe(0);
  });

  it('persists set+clear+set cycle correctly', async () => {
    const { setRecoveryMarker, clearRecoveryMarker, loadRecoveryMarkers } = await import(
      '../../src/lib/recovery-authority-store.ts'
    );

    setRecoveryMarker('source-a');
    clearRecoveryMarker('source-a');
    setRecoveryMarker('source-b');

    const markers = loadRecoveryMarkers();
    expect(markers.has('source-a')).toBe(false);
    expect(markers.has('source-b')).toBe(true);
    expect(markers.size).toBe(1);
  });

  it('republishes a readable object unchanged when the requested key is absent', async () => {
    const markerPath = join(tmpRoot, 'recovery-authority.json');
    writeFileSync(markerPath, JSON.stringify({ retained: true, ignored: false }), 'utf8');
    const { clearRecoveryMarker } = await import('../../src/lib/recovery-authority-store.ts');

    clearRecoveryMarker('not-present');

    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual({ retained: true });
  });

  it('preserves corrupt bytes and performs no publication', async () => {
    const markerPath = join(tmpRoot, 'recovery-authority.json');
    writeFileSync(markerPath, '{corrupt', 'utf8');
    const { clearRecoveryMarker } = await import('../../src/lib/recovery-authority-store.ts');

    clearRecoveryMarker('source-a');

    expect(readFileSync(markerPath, 'utf8')).toBe('{corrupt');
  });
});

describe('setRecoveryMarker', () => {
  it('rebuilds corrupt JSON with only the requested marker', async () => {
    const markerPath = join(tmpRoot, 'recovery-authority.json');
    writeFileSync(markerPath, '{corrupt', 'utf8');
    const { setRecoveryMarker } = await import('../../src/lib/recovery-authority-store.ts');

    setRecoveryMarker('source-a');

    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual({ 'source-a': true });
  });

  it('normalizes array-shaped JSON through the empty-map path', async () => {
    const markerPath = join(tmpRoot, 'recovery-authority.json');
    writeFileSync(markerPath, JSON.stringify(['stale-entry']), 'utf8');
    const { setRecoveryMarker } = await import('../../src/lib/recovery-authority-store.ts');

    setRecoveryMarker('source-a');

    expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual({ 'source-a': true });
  });

  // @skip-env Windows does not expose POSIX file permission bits.
  it.runIf(process.platform !== 'win32')('publishes the marker file with mode 0600', async () => {
    const markerPath = join(tmpRoot, 'recovery-authority.json');
    const { setRecoveryMarker } = await import('../../src/lib/recovery-authority-store.ts');

    setRecoveryMarker('source-a');

    expect(statSync(markerPath).mode & 0o777).toBe(0o600);
  });
});
