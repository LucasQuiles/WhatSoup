// Startup-notification stability journal (src/core/startup-notify.ts).
//
// Born from a live incident (mini11, 2026-07-29): five consecutive
// "*Agent back online* ✓" pings reached the operator's user in 79 minutes —
// one per recovery during maintenance — because the notification is a bare
// trigger fired 3 s after every boot. The config keys that looked like
// protection (`startupNotificationDedupe`, `startupNotificationCooldownSeconds`)
// have no consumers anywhere in the tree, and a cooldown could not work
// anyway: each boot is a fresh process, so suppression state must live on
// disk (the restart-loop-guard precedent).
//
// Contract pinned here: a persisted per-instance boot journal; the
// notification is composed AFTER a stability window and aggregates every
// un-notified boot into one intentional message; fail-open on all
// persistence errors (a broken journal must never block the notification or
// the boot).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  composeStartupNotification,
  createStartupNotificationJournalPort,
  recordStartupBoot,
  settleStartupNotification,
  startupNotifyPath,
} from '../../src/core/startup-notify.ts';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function statePath(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'ws-startup-notify-'));
  return startupNotifyPath(dir);
}

function writePrivateFixture(filePath: string, source: string): void {
  writeFileSync(filePath, source, 'utf8');
  chmodSync(filePath, 0o600);
}

const T0 = 1_785_300_000_000;
const MIN = 60_000;
const utcHm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

describe('recordStartupBoot', () => {
  it('updates a literal deployed v1 journal and returns its bounded available result', () => {
    const p = statePath();
    writePrivateFixture(p, JSON.stringify({ v: 1, boots: [T0 - MIN], lastNotifiedAt: null }) + '\n');

    const result = recordStartupBoot(p, T0);

    expect(result).toMatchObject({
      status: 'available',
      state: { v: 1, boots: [T0 - MIN, T0], lastNotifiedAt: null },
    });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toMatchObject({
      v: 1,
      boots: [T0 - MIN, T0],
      lastNotifiedAt: null,
    });
  });

  it('records a missing journal as an available v1 journal', () => {
    const p = statePath();

    const result = recordStartupBoot(p, T0);

    expect(result).toMatchObject({
      status: 'available',
      state: { v: 1, boots: [T0], lastNotifiedAt: null },
    });
    expect(JSON.parse(readFileSync(p, 'utf8')).v).toBe(1);
  });

  it.each([
    ['malformed', '{not json\n'],
    ['future v2', '{"v":2,"boots":[1],"lastNotifiedAt":null}\n'],
    ['unreadable', '{"v":1,"boots":[1],"lastNotifiedAt":null}\n'],
  ])('preserves an existing %s journal and returns journal_unreadable', (kind, source) => {
    const p = statePath();
    if (kind === 'unreadable') writeFileSync(p, source, 'utf8');
    else writePrivateFixture(p, source);

    const result = recordStartupBoot(p, T0);

    expect(result).toMatchObject({
      status: 'journal_unreadable',
      state: { v: 1, boots: [T0], lastNotifiedAt: null },
    });
    expect(readFileSync(p, 'utf8')).toBe(source);
    const settled = settleStartupNotification(p, T0 + MIN, utcHm, result.state);
    expect(settled).toMatchObject({
      status: 'journal_unreadable',
      watermarkPersisted: false,
      state: { v: 1, boots: [T0], lastNotifiedAt: null },
      notification: { bootsCovered: 1 },
    });
    expect(readFileSync(p, 'utf8')).toBe(source);
  });

  it('appends the boot to a fresh journal and persists it', () => {
    const p = statePath();
    const s = recordStartupBoot(p, T0);
    expect(s.state.boots).toEqual([T0]);
    const onDisk = JSON.parse(readFileSync(p, 'utf8'));
    expect(onDisk.boots).toEqual([T0]);
  });

  it('accumulates boots across separate process lifetimes (reads prior state from disk)', () => {
    const p = statePath();
    recordStartupBoot(p, T0);
    const s = recordStartupBoot(p, T0 + 5 * MIN);
    expect(s.state.boots).toEqual([T0, T0 + 5 * MIN]);
  });

  it('prunes boots older than 24h and caps the journal', () => {
    const p = statePath();
    recordStartupBoot(p, T0 - 25 * 60 * MIN);
    const s = recordStartupBoot(p, T0);
    expect(s.state.boots).toEqual([T0]);
  });

  it('fails open on an unwritable path: returns in-memory state, never throws', () => {
    const s = recordStartupBoot('/nonexistent-root/nope/startup-notify.json', T0);
    expect(s).toMatchObject({
      status: 'journal_unreadable',
      state: { v: 1, boots: [T0], lastNotifiedAt: null },
    });
  });
});

describe('composeStartupNotification', () => {
  // Pure function of the journal state — composed from literals, no filesystem.
  it('keeps the classic copy for a single un-notified boot', () => {
    const msg = composeStartupNotification({ v: 1, boots: [T0], lastNotifiedAt: null }, utcHm);
    expect(msg.text).toBe('*Agent back online* ✓');
    expect(msg.bootsCovered).toBe(1);
  });

  it('aggregates multiple un-notified boots into one intentional message with the time range', () => {
    const msg = composeStartupNotification(
      { v: 1, boots: [T0, T0 + 15 * MIN, T0 + 79 * MIN], lastNotifiedAt: null },
      utcHm,
    );
    expect(msg.bootsCovered).toBe(3);
    expect(msg.text).toContain('*Agent back online* ✓');
    expect(msg.text).toContain('3 restarts');
    expect(msg.text).toContain(utcHm(T0));
    expect(msg.text).toContain(utcHm(T0 + 79 * MIN));
  });

  // Round-trip through the persisted journal: the notified watermark from one
  // process must suppress covered boots for the next.
  it('counts only boots after the last notification', () => {
    const p = statePath();
    recordStartupBoot(p, T0);
    settleStartupNotification(p, T0 + MIN, utcHm);
    const s = recordStartupBoot(p, T0 + 30 * MIN);
    const msg = composeStartupNotification(s.state, utcHm);
    expect(msg.bootsCovered).toBe(1);
    expect(msg.text).toBe('*Agent back online* ✓');
  });
});

describe('settleStartupNotification', () => {
  it('selects every unnotified boot, persists the watermark, and returns the composed aggregate', () => {
    const p = statePath();
    recordStartupBoot(p, T0);
    recordStartupBoot(p, T0 + 15 * MIN);
    const settled = settleStartupNotification(p, T0 + 16 * MIN, utcHm);

    expect(settled).toMatchObject({
      status: 'available',
      watermarkPersisted: true,
      notification: { bootsCovered: 2 },
    });
    expect(settled.notification?.text).toContain('2 restarts');
    const onDisk = JSON.parse(readFileSync(p, 'utf8'));
    expect(onDisk.lastNotifiedAt).toBe(T0 + 16 * MIN);
  });

  it('returns no notification when all boots are already covered', () => {
    const p = statePath();
    recordStartupBoot(p, T0);
    settleStartupNotification(p, T0 + MIN, utcHm);

    expect(settleStartupNotification(p, T0 + 2 * MIN, utcHm)).toMatchObject({
      status: 'available',
      watermarkPersisted: true,
      notification: null,
    });
  });
});

describe('createStartupNotificationJournalPort', () => {
  it('reconciles an unpersisted boot when storage recovers before settlement', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ws-startup-notify-recovery-'));
    const journalParent = path.join(dir, 'journal-parent');
    const p = path.join(journalParent, 'startup-notify.json');
    writeFileSync(journalParent, 'blocking parent', 'utf8');

    const port = createStartupNotificationJournalPort(p, utcHm);
    expect(port.recordStartupBoot(T0)).toMatchObject({
      status: 'journal_unreadable',
      state: { v: 1, boots: [T0], lastNotifiedAt: null },
    });

    rmSync(journalParent);
    mkdirSync(journalParent, { mode: 0o700 });

    const settled = port.settleStartupNotification(T0 + MIN);

    expect(settled).toMatchObject({
      status: 'available',
      watermarkPersisted: true,
      state: { v: 1, boots: [T0], lastNotifiedAt: T0 + MIN },
      notification: { bootsCovered: 1 },
    });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toMatchObject({
      v: 1,
      boots: [T0],
      lastNotifiedAt: T0 + MIN,
    });
  });
});

describe('startupNotifyPath', () => {
  it('pins the canonical on-disk journal location', () => {
    // Literal on purpose: this is the filename ops and docs reference.
    expect(startupNotifyPath('/x/state')).toBe('/x/state/startup-notify.json');
  });
});
