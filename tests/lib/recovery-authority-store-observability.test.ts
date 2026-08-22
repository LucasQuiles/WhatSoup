// tests/lib/recovery-authority-store-observability.test.ts
//
// The per-marker redesign made two paths BEST-EFFORT: legacy migration may not break a
// read, and a failed lock release may not fail a migration. Neither may throw — but the
// catch ratchet correctly refused them as silent swallows, so reporting is now REQUIRED
// BEHAVIOUR and needs its own coverage. These are the two failure modes, injected.
//
// Why they matter, and why "it didn't throw" is not a sufficient assertion:
//   - a migration that throws leaves reads unioning BOTH planes, so the store looks
//     completely correct while the upgrade is permanently stuck;
//   - a release that throws leaves the lock file behind, so the next acquirer silently
//     pays the reclaim path.
// Both present as healthy. The warning is the only signal, so it is asserted here.
//
// Lives in its own file because it mocks process-lock; the sibling unit suite must keep
// exercising the real one.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loggerMock } from '../helpers/logger-mock.ts';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    ...loggerMock().createChildLogger(),
    warn: warnSpy,
  }),
}));

// Real acquire, selectively throwing release. Mocking release alone keeps the lock file
// genuinely on disk, which is what lets the reclaim assertion below mean anything.
const lockState = vi.hoisted(() => ({ releaseThrows: false }));
vi.mock('../../src/lib/process-lock.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/process-lock.ts')>();
  return {
    ...actual,
    releaseProcessLock: (...args: Parameters<typeof actual.releaseProcessLock>): boolean => {
      if (lockState.releaseThrows) {
        const error = new Error('EPERM: operation not permitted, unlink lock') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return actual.releaseProcessLock(...args);
    },
  };
});

let tmpRoot: string;
const LEGACY = 'recovery-authority.json';
const legacyPath = (): string => join(tmpRoot, LEGACY);
const lockPath = (): string => `${legacyPath()}.lock`;

const store = () => import('../../src/lib/recovery-authority-store.ts');

/** Every warn call flattened to text, so leak assertions cover payload AND message. */
const warnText = (): string => JSON.stringify(warnSpy.mock.calls);
const warnPayloads = (): Record<string, unknown>[] =>
  warnSpy.mock.calls
    .map((call) => call[0] as unknown)
    .filter((first): first is Record<string, unknown> => typeof first === 'object' && first !== null);

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'recovery-auth-obs-'));
  process.env['BOT_ERRORS_STATE_DIR'] = tmpRoot;
  warnSpy.mockClear();
  lockState.releaseThrows = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  lockState.releaseThrows = false;
  delete process.env['BOT_ERRORS_STATE_DIR'];
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migration failure is best-effort AND reported', () => {
  it('keeps both-plane reads correct, does not throw, and names the reason', async () => {
    const { setRecoveryMarker, loadRecoveryMarkers } = await store();
    // One marker in each plane, so a correct union is observable.
    writeFileSync(legacyPath(), JSON.stringify({ 'legacy-src:inst-a': true }), 'utf-8');
    setRecoveryMarker('dir-src:inst-b');
    warnSpy.mockClear();

    // Inject AFTER seeding: the state dir becomes unstattable for the legacy path only,
    // which is what an EACCES on that file looks like from inside migration.
    const realExistsSync = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((target: fs.PathLike): boolean => {
      if (String(target) === legacyPath()) {
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return realExistsSync(target);
    });

    let markers: Set<string>;
    expect(() => { markers = loadRecoveryMarkers(); }).not.toThrow();

    // The read is still CORRECT across both planes — that is the property that makes
    // this failure invisible without the warning.
    expect([...markers!].sort()).toEqual(['dir-src:inst-b', 'legacy-src:inst-a']);

    const reasons = warnPayloads().map((payload) => payload['reason']);
    expect(reasons).toContain('legacy_migration_unavailable');
    const migrationWarn = warnPayloads().find((p) => p['reason'] === 'legacy_migration_unavailable');
    expect(migrationWarn?.['code']).toBe('EACCES');
  });

  it('leaks no marker key, state path, or instance directory into the warning', async () => {
    const { setRecoveryMarker, loadRecoveryMarkers } = await store();
    writeFileSync(legacyPath(), JSON.stringify({ 'legacy-src:inst-a': true }), 'utf-8');
    setRecoveryMarker('dir-src:inst-b');
    warnSpy.mockClear();

    const realExistsSync = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((target: fs.PathLike): boolean => {
      if (String(target) === legacyPath()) {
        const error = new Error(`EACCES: permission denied, stat '${legacyPath()}'`) as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return realExistsSync(target);
    });

    loadRecoveryMarkers();

    // Pin REPORTED-AND-CLEAN, not merely clean: without this a silent catch would
    // satisfy every assertion below by emitting nothing at all.
    expect(warnPayloads().map((p) => p['reason'])).toContain('legacy_migration_unavailable');

    const text = warnText();
    // The raw errno message embeds the absolute path; logging `error.message` would
    // have leaked it. Only the classified code may cross this boundary.
    expect(text).not.toContain(tmpRoot);
    expect(text).not.toContain(LEGACY);
    expect(text).not.toContain('legacy-src:inst-a');
    expect(text).not.toContain('dir-src:inst-b');
    expect(text).not.toContain('permission denied');
  });
});

describe('lock release failure is best-effort AND reported', () => {
  it('does not throw, still migrates, and names the reason', async () => {
    const { loadRecoveryMarkers } = await store();
    writeFileSync(legacyPath(), JSON.stringify({ 'legacy-src:inst-a': true }), 'utf-8');
    lockState.releaseThrows = true;

    let markers: Set<string>;
    expect(() => { markers = loadRecoveryMarkers(); }).not.toThrow();
    expect(markers!.has('legacy-src:inst-a')).toBe(true);

    // Migration itself SUCCEEDED — the failure is only in releasing the lock, so the
    // legacy aggregate is gone and the marker now lives in its own file.
    expect(existsSync(legacyPath())).toBe(false);

    const releaseWarn = warnPayloads().find((p) => p['reason'] === 'legacy_lock_release_failed');
    expect(releaseWarn).toBeDefined();
    expect(releaseWarn?.['code']).toBe('EPERM');
    // Migration succeeded, so its own failure reason must NOT be reported.
    expect(warnPayloads().map((p) => p['reason'])).not.toContain('legacy_migration_failed');
  });

  it('leaves the lock file intact so the normal reclaim path still applies', async () => {
    const { loadRecoveryMarkers } = await store();
    writeFileSync(legacyPath(), JSON.stringify({ 'legacy-src:inst-a': true }), 'utf-8');
    lockState.releaseThrows = true;
    loadRecoveryMarkers();

    // The lock survived the failed release rather than being half-removed.
    expect(existsSync(lockPath())).toBe(true);

    // And it is still a WELL-FORMED lock, not corrupt bytes: the real acquirer classifies
    // it as held by a live process, which is the state the reclaim machinery handles.
    // Classified 'active' (not 'corrupt') is the assertion that matters — a corrupt
    // classification would mean the failed release left the file unusable.
    const actual = await vi.importActual<typeof import('../../src/lib/process-lock.ts')>(
      '../../src/lib/process-lock.ts',
    );
    let caught: unknown;
    try {
      actual.acquireProcessLock(lockPath(), { wait: { timeoutMs: 50, pollMs: 10 } });
    } catch (error) {
      caught = error;
    }
    expect(actual.isProcessLockError(caught)).toBe(true);
    expect((caught as { reason: string }).reason).not.toBe('corrupt');
  });

  it('leaks no marker key or state path into the release warning', async () => {
    const { loadRecoveryMarkers } = await store();
    writeFileSync(legacyPath(), JSON.stringify({ 'legacy-src:inst-a': true }), 'utf-8');
    lockState.releaseThrows = true;
    loadRecoveryMarkers();

    // As above: assert the warning EXISTS before asserting what it omits.
    expect(warnPayloads().map((p) => p['reason'])).toContain('legacy_lock_release_failed');

    const text = warnText();
    expect(text).not.toContain(tmpRoot);
    expect(text).not.toContain('legacy-src:inst-a');
    expect(text).not.toContain('unlink lock');
  });
});
