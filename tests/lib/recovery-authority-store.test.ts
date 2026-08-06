// tests/lib/recovery-authority-store.test.ts
// Discriminating tests for batch-1 v2 hardening of src/lib/recovery-authority-store.ts
// (#2394 — atomic write, corrupt-file tolerance, close delete-on-empty race)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Hoisted vi.mock: spy on the module-level log.warn.
// The store imports createChildLogger from ../logger.ts (src/logger.ts).
const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), level: 'error' }),
  }),
}));

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'recovery-auth-test-'));
  process.env['BOT_ERRORS_STATE_DIR'] = tmpRoot;
  warnSpy.mockClear();
});

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'recovery-auth-test-'));
  process.env['BOT_ERRORS_STATE_DIR'] = tmpRoot;
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

// ---------------------------------------------------------------------------
// Test 2: clearRecoveryMarker writes an empty object instead of deleting
//         the file, so concurrent setRecoveryMarker calls are not orphaned.
//         This is the ONLY truly discriminating test for v2 hardening.
// ---------------------------------------------------------------------------
describe('clearRecoveryMarker', () => {
  it('writes empty object when last marker removed (discriminating: v1 deletes file)', async () => {
    const { setRecoveryMarker, clearRecoveryMarker } = await import(
      '../../src/lib/recovery-authority-store.ts'
    );

    setRecoveryMarker('test-source');
    clearRecoveryMarker('test-source');

    const markerPath = join(tmpRoot, 'recovery-authority.json');
    expect(existsSync(markerPath)).toBe(true); // v1: false (deleted)

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
});
