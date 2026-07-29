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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  composeStartupNotification,
  markStartupNotified,
  recordStartupBoot,
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

const T0 = 1_785_300_000_000;
const MIN = 60_000;
const utcHm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

describe('recordStartupBoot', () => {
  it('appends the boot to a fresh journal and persists it', () => {
    const p = statePath();
    const s = recordStartupBoot(p, T0);
    expect(s.boots).toEqual([T0]);
    const onDisk = JSON.parse(readFileSync(p, 'utf8'));
    expect(onDisk.boots).toEqual([T0]);
  });

  it('accumulates boots across separate process lifetimes (reads prior state from disk)', () => {
    const p = statePath();
    recordStartupBoot(p, T0);
    const s = recordStartupBoot(p, T0 + 5 * MIN);
    expect(s.boots).toEqual([T0, T0 + 5 * MIN]);
  });

  it('prunes boots older than 24h and caps the journal', () => {
    const p = statePath();
    recordStartupBoot(p, T0 - 25 * 60 * MIN);
    const s = recordStartupBoot(p, T0);
    expect(s.boots).toEqual([T0]);
  });

  it('fails open on a corrupt journal: fresh state, boot still recorded', () => {
    const p = statePath();
    writeFileSync(p, '{not json');
    const s = recordStartupBoot(p, T0);
    expect(s.boots).toEqual([T0]);
  });

  it('fails open on an unwritable path: returns in-memory state, never throws', () => {
    const s = recordStartupBoot('/nonexistent-root/nope/startup-notify.json', T0);
    expect(s.boots).toEqual([T0]);
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
    markStartupNotified(p, T0 + MIN);
    const s = recordStartupBoot(p, T0 + 30 * MIN);
    const msg = composeStartupNotification(s, utcHm);
    expect(msg.bootsCovered).toBe(1);
    expect(msg.text).toBe('*Agent back online* ✓');
  });
});

describe('markStartupNotified', () => {
  it('persists lastNotifiedAt so later processes see covered boots', () => {
    const p = statePath();
    recordStartupBoot(p, T0);
    markStartupNotified(p, T0 + MIN);
    const onDisk = JSON.parse(readFileSync(p, 'utf8'));
    expect(onDisk.lastNotifiedAt).toBe(T0 + MIN);
  });

  it('fails open when the journal cannot be written', () => {
    expect(() => markStartupNotified('/nonexistent-root/nope/j.json', T0)).not.toThrow();
  });
});

describe('startupNotifyPath', () => {
  it('pins the canonical on-disk journal location', () => {
    // Literal on purpose: this is the filename ops and docs reference.
    expect(startupNotifyPath('/x/state')).toBe('/x/state/startup-notify.json');
  });
});
