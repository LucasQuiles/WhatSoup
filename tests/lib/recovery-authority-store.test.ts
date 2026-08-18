// tests/lib/recovery-authority-store.test.ts
// Sequential format and compatibility tests for recovery-authority markers.
// Cross-process serialization is proved by the sibling concurrency suite.
//
// Layout under test (redesign 2026-08-17): one durable file per marker under
// `recovery-authority.d/`, replacing the single `recovery-authority.json` object
// whose read-modify-write forced every mutation through one process lock and
// starved deterministically at 16 concurrent writers. The legacy aggregate file
// is still READ (and migrated) so no marker is lost across the upgrade.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, chmodSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync,
} from 'node:fs';
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
const LEGACY = 'recovery-authority.json';
const DIR = 'recovery-authority.d';

const legacyPath = (): string => join(tmpRoot, LEGACY);
const markerDir = (): string => join(tmpRoot, DIR);
/** Encoded on-disk name for a source key, mirroring the store's encoder. */
const markerFile = (source: string): string =>
  join(markerDir(), encodeURIComponent(source).replace(
    /[.!~*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  ) + '.json');
const dirEntries = (): string[] => (existsSync(markerDir()) ? readdirSync(markerDir()).sort() : []);

const store = () => import('../../src/lib/recovery-authority-store.ts');

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'recovery-auth-test-'));
  process.env['BOT_ERRORS_STATE_DIR'] = tmpRoot;
  warnSpy.mockClear();
});

afterEach(() => {
  delete process.env['BOT_ERRORS_STATE_DIR'];
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('loadRecoveryMarkers', () => {
  it('logs warning for corrupt legacy file, returns empty set, preserves file', async () => {
    writeFileSync(legacyPath(), '{invalid}', 'utf-8');

    const { loadRecoveryMarkers } = await store();
    const markers = loadRecoveryMarkers();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
    expect(markers).toBeInstanceOf(Set);
    expect(markers.size).toBe(0);
    // Bytes that could not be interpreted are never deleted — migration refuses to
    // discard what it could not read.
    expect(existsSync(legacyPath())).toBe(true);
  });

  it('returns empty set when nothing has been written', async () => {
    const { loadRecoveryMarkers } = await store();
    const markers = loadRecoveryMarkers();

    expect(markers).toBeInstanceOf(Set);
    expect(markers.size).toBe(0);
  });

  it('skips one undecodable entry instead of zeroing every other marker', async () => {
    const { setRecoveryMarker, loadRecoveryMarkers } = await store();
    setRecoveryMarker('good-a');
    setRecoveryMarker('good-b');
    // A stray name that is not valid percent-encoding.
    writeFileSync(join(markerDir(), '%ZZ.json'), '{}', 'utf8');

    const markers = loadRecoveryMarkers();

    // Under the old single-file layout one bad file meant "no markers" because that
    // file WAS the state. With a directory that would discard every other producer's
    // marker, which is a strictly worse failure than dropping one.
    expect(markers.has('good-a')).toBe(true);
    expect(markers.has('good-b')).toBe(true);
    expect(markers.size).toBe(2);
  });

  it('ignores non-marker files in the directory', async () => {
    const { setRecoveryMarker, loadRecoveryMarkers } = await store();
    setRecoveryMarker('real');
    writeFileSync(join(markerDir(), 'notes.txt'), 'scratch', 'utf8');

    expect([...(loadRecoveryMarkers())]).toEqual(['real']);
  });
});

describe('legacy migration', () => {
  it('migrates an aggregate file into per-marker files and removes it', async () => {
    writeFileSync(legacyPath(), JSON.stringify({ 'a:bot': true, 'b:bot': true, skipped: false }), 'utf8');

    const { loadRecoveryMarkers } = await store();
    const markers = loadRecoveryMarkers();

    expect(markers).toEqual(new Set(['a:bot', 'b:bot']));
    expect(existsSync(markerFile('a:bot'))).toBe(true);
    expect(existsSync(markerFile('b:bot'))).toBe(true);
    expect(existsSync(legacyPath())).toBe(false);
  });

  it('unions both planes so no marker is lost mid-upgrade', async () => {
    const { setRecoveryMarker } = await store();
    setRecoveryMarker('new-plane');
    // A legacy file appearing alongside per-marker files (e.g. an older process
    // still writing the aggregate during a rolling restart).
    writeFileSync(legacyPath(), JSON.stringify({ 'old-plane': true }), 'utf8');

    const { loadRecoveryMarkers } = await store();
    expect(loadRecoveryMarkers()).toEqual(new Set(['new-plane', 'old-plane']));
  });

  it('treats an array-shaped legacy file as empty and migrates it away', async () => {
    writeFileSync(legacyPath(), JSON.stringify(['stale-entry']), 'utf8');

    const { loadRecoveryMarkers } = await store();

    expect(loadRecoveryMarkers().size).toBe(0);
    expect(existsSync(legacyPath())).toBe(false);
  });

  it('is idempotent and leaves an already-migrated marker untouched', async () => {
    writeFileSync(legacyPath(), JSON.stringify({ 'a:bot': true }), 'utf8');
    const { loadRecoveryMarkers } = await store();

    loadRecoveryMarkers();
    const first = readFileSync(markerFile('a:bot'), 'utf8');
    loadRecoveryMarkers();

    expect(readFileSync(markerFile('a:bot'), 'utf8')).toBe(first);
    expect(loadRecoveryMarkers()).toEqual(new Set(['a:bot']));
  });

  it('does NOT resurrect a marker cleared while only the legacy file held it', async () => {
    // The migration race: the key lives only in the aggregate file, so unlinking a
    // per-marker file would be a no-op and a later migration would materialise it
    // again — un-clearing a marker the caller explicitly cleared. clear() removes it
    // from BOTH planes under the legacy lock, so migration cannot bring it back.
    writeFileSync(legacyPath(), JSON.stringify({ 'doomed:bot': true, 'kept:bot': true }), 'utf8');
    const { clearRecoveryMarker, loadRecoveryMarkers } = await store();

    clearRecoveryMarker('doomed:bot');
    const markers = loadRecoveryMarkers(); // triggers migration

    expect(markers.has('doomed:bot')).toBe(false);
    expect(markers.has('kept:bot')).toBe(true);
    expect(existsSync(markerFile('doomed:bot'))).toBe(false);
  });
});

describe('clearRecoveryMarker', () => {
  it('removes only the cleared marker file, leaving siblings intact', async () => {
    const { setRecoveryMarker, clearRecoveryMarker, loadRecoveryMarkers } = await store();

    setRecoveryMarker('source-a');
    setRecoveryMarker('source-b');
    clearRecoveryMarker('source-a');

    expect(existsSync(markerFile('source-a'))).toBe(false);
    expect(existsSync(markerFile('source-b'))).toBe(true);
    expect(loadRecoveryMarkers()).toEqual(new Set(['source-b']));
  });

  it('leaves an empty directory when the final marker is removed', async () => {
    const { setRecoveryMarker, clearRecoveryMarker, loadRecoveryMarkers } = await store();

    setRecoveryMarker('test-source');
    clearRecoveryMarker('test-source');

    expect(dirEntries()).toEqual([]);
    expect(loadRecoveryMarkers().size).toBe(0);
  });

  it('is no-op for never-set marker (no files created)', async () => {
    const { clearRecoveryMarker, loadRecoveryMarkers } = await store();

    clearRecoveryMarker('ghost-source');

    expect(existsSync(legacyPath())).toBe(false);
    expect(dirEntries()).toEqual([]);
    expect(loadRecoveryMarkers().size).toBe(0);
  });

  it('persists set+clear+set cycle correctly', async () => {
    const { setRecoveryMarker, clearRecoveryMarker, loadRecoveryMarkers } = await store();

    setRecoveryMarker('source-a');
    clearRecoveryMarker('source-a');
    setRecoveryMarker('source-b');

    const markers = loadRecoveryMarkers();
    expect(markers.has('source-a')).toBe(false);
    expect(markers.has('source-b')).toBe(true);
    expect(markers.size).toBe(1);
  });

  it('leaves other legacy entries unchanged when the requested key is absent', async () => {
    writeFileSync(legacyPath(), JSON.stringify({ retained: true, ignored: false }), 'utf8');
    const { clearRecoveryMarker } = await store();

    clearRecoveryMarker('not-present');

    // The absent key needs no rewrite, so the aggregate is left for migration to fold.
    expect(existsSync(legacyPath())).toBe(true);
    expect(JSON.parse(readFileSync(legacyPath(), 'utf8'))).toEqual({ retained: true, ignored: false });
  });

  it('preserves corrupt legacy bytes and performs no publication', async () => {
    writeFileSync(legacyPath(), '{corrupt', 'utf8');
    const { clearRecoveryMarker } = await store();

    clearRecoveryMarker('source-a');

    expect(readFileSync(legacyPath(), 'utf8')).toBe('{corrupt');
  });

  it('takes no lock in the steady state (post-migration)', async () => {
    const { setRecoveryMarker, clearRecoveryMarker } = await store();

    setRecoveryMarker('source-a');
    clearRecoveryMarker('source-a');

    // The starvation fix: with no aggregate file there is nothing shared to
    // serialise, so no lock file is ever created for a mutation.
    expect(dirEntries().filter((f) => f.endsWith('.lock'))).toEqual([]);
    expect(existsSync(join(tmpRoot, `${LEGACY}.lock`))).toBe(false);
  });
});

describe('setRecoveryMarker', () => {
  it('writes its own file without touching a corrupt legacy file', async () => {
    writeFileSync(legacyPath(), '{corrupt', 'utf8');
    const { setRecoveryMarker, loadRecoveryMarkers } = await store();

    setRecoveryMarker('source-a');

    expect(existsSync(markerFile('source-a'))).toBe(true);
    expect(readFileSync(legacyPath(), 'utf8')).toBe('{corrupt');
    expect(loadRecoveryMarkers()).toEqual(new Set(['source-a']));
  });

  it('is idempotent for a repeated set', async () => {
    const { setRecoveryMarker, loadRecoveryMarkers } = await store();

    setRecoveryMarker('source-a');
    setRecoveryMarker('source-a');

    expect(dirEntries()).toEqual([`${encodeURIComponent('source-a')}.json`]);
    expect(loadRecoveryMarkers()).toEqual(new Set(['source-a']));
  });

  it('gives distinct keys distinct paths (no false sharing)', async () => {
    const { setRecoveryMarker } = await store();

    setRecoveryMarker('connection_exhausted:bot-one');
    setRecoveryMarker('connection_exhausted:bot-two');

    expect(dirEntries()).toHaveLength(2);
  });

  // @skip-env Windows does not expose POSIX file permission bits.
  it.runIf(process.platform !== 'win32')('publishes the marker file with mode 0600', async () => {
    const { setRecoveryMarker } = await store();

    setRecoveryMarker('source-a');

    expect(statSync(markerFile('source-a')).mode & 0o777).toBe(0o600);
  });

  // @skip-env Windows does not expose POSIX file permission bits.
  it.runIf(process.platform !== 'win32')('creates the marker directory as private 0700', async () => {
    const { setRecoveryMarker } = await store();

    setRecoveryMarker('source-a');

    expect(statSync(markerDir()).mode & 0o777).toBe(0o700);
  });
});

describe('marker key encoding', () => {
  // The real key shapes, from connection.ts:2504/2574/2681/2719 and scheduler.ts.
  const REAL_KEYS = [
    'connection_exhausted:sandbox-agent',
    'whatsapp_auth_bond_local_failure:operator-agent',
    'scheduler_delink:chat-bot',
  ];

  it('round-trips every real key shape through the on-disk name', async () => {
    const { setRecoveryMarker, loadRecoveryMarkers } = await store();

    for (const key of REAL_KEYS) setRecoveryMarker(key);

    expect(loadRecoveryMarkers()).toEqual(new Set(REAL_KEYS));
  });

  it('produces names that cannot traverse or collide with lock/temp suffixes', async () => {
    const { setRecoveryMarker } = await store();
    // Hostile keys: path traversal, a bare dot-dot, and the suffixes the atomic
    // writer and process lock use.
    for (const key of ['../escape', '..', 'x/../../y', 'evil.lock', 'evil.tmp']) {
      setRecoveryMarker(key);
    }

    for (const entry of dirEntries()) {
      const stem = entry.slice(0, -'.json'.length);
      expect(stem).toMatch(/^[A-Za-z0-9_%-]+$/);
      expect(stem).not.toBe('.');
      expect(stem).not.toBe('..');
    }
    // Everything stayed inside the marker directory.
    expect(existsSync(join(tmpRoot, 'escape'))).toBe(false);
    expect(dirEntries()).toHaveLength(5);
  });

  it('round-trips hostile keys too', async () => {
    const { setRecoveryMarker, loadRecoveryMarkers } = await store();
    const keys = ['../escape', 'a b:c', 'unicode-é:bot'];

    for (const key of keys) setRecoveryMarker(key);

    expect(loadRecoveryMarkers()).toEqual(new Set(keys));
  });

  it('rejects a key whose encoded name would exceed the filename limit', async () => {
    const { setRecoveryMarker } = await store();

    expect(() => setRecoveryMarker('x'.repeat(300))).toThrow(RangeError);
  });
});

describe('directory-enumeration failure semantics', () => {
  // @skip-env Windows does not enforce POSIX directory permissions.
  it.runIf(process.platform !== 'win32')(
    'returns empty rather than throwing when the marker directory is unreadable',
    async () => {
      mkdirSync(markerDir(), { recursive: true });
      chmodSync(markerDir(), 0o000);
      const { loadRecoveryMarkers } = await store();

      try {
        // Callers treat this as infallible; an unreadable directory must degrade to
        // "no markers", never propagate.
        expect(() => loadRecoveryMarkers()).not.toThrow();
        expect(loadRecoveryMarkers().size).toBe(0);
      } finally {
        // Restore before teardown: a 0o000 directory cannot be traversed, so rmSync
        // would fail here AND in the shared isolated-HOME teardown.
        chmodSync(markerDir(), 0o700);
      }
    },
  );
});

describe('marker payload timestamp comes from the injectable clock', () => {
  // Own block, and its own teardown, so restoring this spy cannot change the
  // teardown of the ~30 tests above it — the rest of this file is inside a frozen
  // verification set.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stamps setAt from systemClock.nowIso(), not a direct wall-clock read', async () => {
    // The payload's `setAt` had no coverage at all, so a bare `new Date()` here was
    // invisible to every test in this file — it surfaced only when the repo-wide
    // clock ratchet (tests/scripts/clock-budget.test.ts, #2200) counted it. src/ has
    // ONE sanctioned wall-clock reader, src/lib/clock.ts, and stamping through it is
    // what makes this value drivable to a known instant instead of untestable.
    const { systemClock } = await import('../../src/lib/clock.ts');
    const FROZEN = '2026-01-02T03:04:05.678Z';
    const nowIso = vi.spyOn(systemClock, 'nowIso').mockReturnValue(FROZEN);

    const { setRecoveryMarker } = await store();
    setRecoveryMarker('clock:bot');

    const payload = JSON.parse(readFileSync(markerFile('clock:bot'), 'utf8')) as Record<string, unknown>;
    // The exact stubbed value: a real `new Date()` would produce today's timestamp,
    // which can never equal FROZEN, so this assertion cannot pass vacuously.
    expect(payload['setAt']).toBe(FROZEN);
    expect(payload['source']).toBe('clock:bot');
    // And the clock was actually consulted — pins REACHED-THE-CLOCK, so a future
    // refactor cannot satisfy the equality above by hard-coding or omitting setAt.
    expect(nowIso).toHaveBeenCalled();
  });
});
