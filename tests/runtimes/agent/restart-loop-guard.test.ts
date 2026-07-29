/**
 * Tests for the C5 restart-loop guard (resume-replay breaker).
 *
 * Design sources (WhatSoup contribution lane):
 *   MAP:  oc-re/audits/2026-07-19-c5-restart-loop-guard-map.md
 *   SPEC: oc-re/specs/2026-07-19-c5-restart-loop-guard-spec.md
 * Reference shape: Hermes restart_loop_guard.py (quarantine, static-read only).
 *
 * Invariants under test:
 *  - trip only on >= maxRestarts crashy boots inside the window
 *  - operator stop/restart (clean exit) never trips and resets the journal
 *  - fail-open on ANY persistence problem — a broken breaker never wedges
 *    a healthy instance
 *  - T1 characterization: a 'suspended' checkpoint stays resumable across an
 *    aborted resume (the store-level window the guard closes)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAndRecordInterruptedBoot,
  markBootInProgress,
  markCleanExit,
  readRestartLoopGuardHealth,
  restartLoopGuardPath,
  RESTART_LOOP_GUARD_DEFAULTS,
} from '../../../src/runtimes/agent/restart-loop-guard.ts';
import { Database } from '../../../src/core/database.ts';

const { maxRestarts: DEFAULT_MAX, windowMs: DEFAULT_WINDOW } = RESTART_LOOP_GUARD_DEFAULTS;

describe('restart-loop guard', () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-restart-loop-guard-'));
    statePath = restartLoopGuardPath(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Simulate one full boot with resumable checkpoints pending. Returns trip state. */
  function boot(now: number, maxRestarts: number = DEFAULT_MAX, windowMs: number = DEFAULT_WINDOW) {
    const interrupted = markBootInProgress(statePath, now);
    if (!interrupted) return { tripped: false, bootsInWindow: 0, interrupted };
    const result = checkAndRecordInterruptedBoot({ statePath, maxRestarts, windowMs, now });
    return { ...result, interrupted };
  }

  describe('T2 — journal boundaries', () => {
    it('first-ever boot is not interrupted and records nothing', () => {
      const b = boot(1_000);
      expect(b.interrupted).toBe(false);
      expect(b.tripped).toBe(false);
      expect(b.bootsInWindow).toBe(0);
    });

    it('trips on the 3rd crashy boot, not before', () => {
      let t = 1_000_000;
      boot(t);                                           // boot 1 (fresh)
      expect(boot(t += 1_000).tripped).toBe(false);      // 1st crashy
      expect(boot(t += 1_000).tripped).toBe(false);      // 2nd crashy
      expect(boot(t += 1_000).tripped).toBe(true);       // 3rd crashy → trip
    });

    it('prunes boots outside the window', () => {
      const t0 = 1_000_000;
      boot(t0);                                          // fresh
      boot(t0 + 1_000);                                  // crashy #1 @ t0+1s
      boot(t0 + 2_000);                                  // crashy #2 @ t0+2s
      // next crashy boot lands after the window expired the first two
      const late = boot(t0 + DEFAULT_WINDOW + 3_000);
      expect(late.bootsInWindow).toBe(1);                // only this boot remains
      expect(late.tripped).toBe(false);
    });

    it('honors a custom maxRestarts', () => {
      let t = 1_000_000;
      boot(t);
      boot(t += 1_000);
      const second = boot(t += 1_000, 2);                // maxRestarts=2
      expect(second.tripped).toBe(true);
    });
  });

  describe('T4 — marker lifecycle (clean exit resets)', () => {
    it('clean exit ⇒ next boot is not interrupted', () => {
      let t = 1_000_000;
      boot(t);                                           // fresh boot
      markCleanExit(statePath);                          // graceful shutdown
      const b = boot(t + 1_000);
      expect(b.interrupted).toBe(false);
      expect(b.tripped).toBe(false);
    });

    it('clean exit clears the boots journal (operator back in the loop)', () => {
      let t = 1_000_000;
      boot(t);                                           // fresh
      boot(t += 1_000);                                  // crashy #1
      boot(t += 1_000);                                  // crashy #2 (journal=2)
      markCleanExit(statePath);                          // operator stop after uptime
      boot(t += 1_000);                                  // clean boot, not interrupted
      const b = boot(t += 1_000);                        // one more crashy boot
      expect(b.interrupted).toBe(true);
      expect(b.bootsInWindow).toBe(1);                   // journal restarted at 1, not 3
      expect(b.tripped).toBe(false);
    });
  });

  describe('T3 — fail-open on persistence problems', () => {
    it('updates a literal deployed v1 journal without changing its version', () => {
      writeFileSync(
        statePath,
        JSON.stringify({ v: 1, bootInProgress: false, boots: [], lastTripAt: null }) + '\n',
        'utf8',
      );
      chmodSync(statePath, 0o600);

      expect(markBootInProgress(statePath, 1_000)).toBe(false);

      const onDisk = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(onDisk).toMatchObject({ v: 1, bootInProgress: true, bootsTotal: 1 });
    });

    it('missing state file → not interrupted, not tripped', () => {
      const b = boot(1_000);
      expect(b.interrupted).toBe(false);
      expect(b.tripped).toBe(false);
    });

    it.each([
      ['malformed', '{not json\n'],
      ['future v2', '{"v":2,"bootInProgress":false,"boots":[],"lastTripAt":null}\n'],
      ['unreadable', '{"v":1,"bootInProgress":false,"boots":[],"lastTripAt":null}\n'],
    ])('preserves an existing %s state and fails open without reinitializing it', (kind, source) => {
      writeFileSync(statePath, source, 'utf8');
      if (kind !== 'unreadable') chmodSync(statePath, 0o600);

      const interrupted = markBootInProgress(statePath, 1_000);
      expect(interrupted).toBe(false);
      expect(checkAndRecordInterruptedBoot({ statePath, now: 1_000 }))
        .toEqual({ tripped: false, bootsInWindow: 0 });
      expect(readRestartLoopGuardHealth(statePath, DEFAULT_WINDOW, 1_000).bootsTotal).toBe(0);
      expect(readFileSync(statePath, 'utf8')).toBe(source);
      expect(() => markCleanExit(statePath)).not.toThrow();
      expect(readFileSync(statePath, 'utf8')).toBe(source);
    });

    it('uncreatable state path → every call no-throws and fails open', () => {
      const blocker = join(dir, 'a-regular-file');
      writeFileSync(blocker, 'x', 'utf-8');
      const badPath = join(blocker, 'restart-loop-guard.json'); // ENOTDIR on any write
      expect(() => markBootInProgress(badPath)).not.toThrow();
      expect(markBootInProgress(badPath)).toBe(false);
      expect(() => markCleanExit(badPath)).not.toThrow();
      expect(checkAndRecordInterruptedBoot({ statePath: badPath, now: 1_000 }))
        .toEqual({ tripped: false, bootsInWindow: 0 });
    });
  });

  describe('health introspection (read-only, fail-open)', () => {
    it('reports zeros on missing state, with the window echoed', () => {
      expect(readRestartLoopGuardHealth(statePath, DEFAULT_WINDOW, 1_000))
        .toEqual({
          bootsInWindow: 0,
          tripped: false,
          lastTripAt: null,
          windowMs: DEFAULT_WINDOW,
          bootsTotal: 0,
          checksPerformed: 0,
          lastCheckAt: null,
        });
    });

    it('reports the live journal after a trip', () => {
      let t = 1_000_000;
      boot(t); boot(t += 1_000); boot(t += 1_000); boot(t += 1_000); // tripped at 4th
      const h = readRestartLoopGuardHealth(statePath, DEFAULT_WINDOW, t + 500);
      expect(h.bootsInWindow).toBe(3);
      expect(h.tripped).toBe(true);
      expect(h.lastTripAt).toBe(t);
    });
  });

  describe('observability counters (silence != health)', () => {
    it('echoes windowMs so a flat bootsInWindow:0 is disambiguated from a rolled-past window', () => {
      const h = readRestartLoopGuardHealth(statePath, 12_345, 1_000);
      expect(h.windowMs).toBe(12_345);
    });

    it('bootsTotal counts EVERY boot monotonically and survives window roll-off', () => {
      let t = 1_000_000;
      // Two crash-interrupted boots close together, then one far in the future
      // so the earlier two age out of the window entirely.
      markBootInProgress(statePath, t);
      markBootInProgress(statePath, t += 1_000);
      const far = t + DEFAULT_WINDOW * 10;
      markBootInProgress(statePath, far);
      const h = readRestartLoopGuardHealth(statePath, DEFAULT_WINDOW, far + 500);
      expect(h.bootsInWindow).toBe(0); // all aged out — ambiguous alone
      expect(h.bootsTotal).toBe(3); // ...but the lifetime counter proves 3 boots landed
    });

    it('checksPerformed + lastCheckAt count the breakers DECISION, not clean boots', () => {
      let t = 2_000_000;
      // A clean first boot does not consult the breaker (no prior crash marker).
      markBootInProgress(statePath, t);
      let h = readRestartLoopGuardHealth(statePath, DEFAULT_WINDOW, t + 100);
      expect(h.checksPerformed).toBe(0); // the guard was never asked
      expect(h.lastCheckAt).toBeNull();
      // A crash-interrupted boot (prior marker still set) reaches the decision.
      const interrupted = markBootInProgress(statePath, t += 1_000);
      expect(interrupted).toBe(true);
      checkAndRecordInterruptedBoot({ statePath, maxRestarts: 3, windowMs: DEFAULT_WINDOW, now: t });
      h = readRestartLoopGuardHealth(statePath, DEFAULT_WINDOW, t + 100);
      expect(h.checksPerformed).toBe(1); // asked once, allowed (not tripped)
      expect(h.lastCheckAt).toBe(t);
    });

    it('bootsTotal is INDEPENDENT storage from boots[] — a prune to empty never resets it (Q round 17)', () => {
      // Regression guard: if bootsTotal were ever derived from / shared storage
      // with the pruned boots[] window, it would reset to 0 on the next prune —
      // which is indistinguishable from "no boots", the exact ambiguity the field
      // exists to kill. This pins the separation explicitly.
      let t = 5_000_000;
      markBootInProgress(statePath, t);
      markBootInProgress(statePath, t += 1_000);
      markBootInProgress(statePath, t += 1_000);
      // Force boots[] to prune to empty on the next write (far past the window)…
      const far = t + DEFAULT_WINDOW * 100;
      markBootInProgress(statePath, far);
      // …and re-read from a FRESH health call (reloads state from the file, so
      // this also covers "survives a restart", not just an in-memory read).
      const h = readRestartLoopGuardHealth(statePath, DEFAULT_WINDOW, far + 1);
      expect(h.bootsInWindow).toBe(0); // window pruned to empty
      expect(h.bootsTotal).toBe(4); // lifetime counter untouched by the prune or the reload
    });

    it('a clean exit resets the window journal but NOT the monotonic counters', () => {
      let t = 3_000_000;
      markBootInProgress(statePath, t);
      markBootInProgress(statePath, t += 1_000);
      markCleanExit(statePath);
      const h = readRestartLoopGuardHealth(statePath, DEFAULT_WINDOW, t + 100);
      expect(h.bootsInWindow).toBe(0); // journal restarted
      expect(h.bootsTotal).toBe(2); // lifetime count preserved across the clean exit
    });

    it('back-compat: a legacy state file without the counters loads with defaults, not a reject', () => {
      // A v:1 file written before observability counters existed.
      writeFileSync(statePath, JSON.stringify({ v: 1, bootInProgress: false, boots: [], lastTripAt: null }));
      chmodSync(statePath, 0o600);
      const h = readRestartLoopGuardHealth(statePath, DEFAULT_WINDOW, 1_000);
      expect(h.bootsTotal).toBe(0);
      expect(h.checksPerformed).toBe(0);
      expect(h.lastCheckAt).toBeNull();
      // ...and a subsequent boot increments from the default rather than NaN.
      markBootInProgress(statePath, 2_000);
      expect(readRestartLoopGuardHealth(statePath, DEFAULT_WINDOW, 2_100).bootsTotal).toBe(1);
    });
  });
});

describe('T1 — characterization: suspended checkpoint stays resumable across an aborted resume', () => {
  // NOTE: this suite deliberately drives the REAL migrated schema via
  // Database + the engine's exact resumable filter SQL
  // (src/core/durability.ts:501-506 — `session_status IN ('active','suspended')
  // AND session_id IS NOT NULL`) instead of constructing a DurabilityEngine.
  // On this box the engine's import chain (durability.ts → config.ts →
  // agent-config-validator.ts → 're2') is unresolvable — a PRE-EXISTING
  // install gap, proven identical on pristine main (d8e1f307) by stash
  // isolation 2026-07-19. The filter is replicated verbatim so the window
  // claim stays executable here; engine-level coverage rides in CI.
  const RESUMABLE_FILTER = `
    SELECT conversation_key FROM session_checkpoints
    WHERE session_status IN ('active','suspended') AND session_id IS NOT NULL`;

  let db: Database;

  function resumableKeys(): string[] {
    return (db.raw.prepare(RESUMABLE_FILTER).all() as Array<{ conversation_key: string }>)
      .map((r) => r.conversation_key);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => { db.close(); });

  it('pins the store-level loop window the guard closes', () => {
    db.raw.prepare(
      `INSERT INTO session_checkpoints (conversation_key, session_id, session_status)
       VALUES ('conv-1', 'sess-abc', 'suspended')`,
    ).run();
    // Boot 1: gate sees it resumable.
    expect(resumableKeys()).toContain('conv-1');
    // Resume is attempted; the process dies BEFORE the first turn finalizes.
    // The checkpoint only re-flips to 'active' at turn-finalization
    // (src/runtimes/agent/runtime-turn-coordinator.ts:455, gated on
    // status.active) — so a crash in the resume window performs NO mutation:
    // (nothing to simulate — that is the point)
    // Boot 2: the same checkpoint is STILL resumable → unbounded replay loop
    // without the guard. The guard's trip is what breaks this cycle.
    expect(resumableKeys()).toContain('conv-1');
  });

  it('only an explicit terminal status removes it from the resumable set', () => {
    db.raw.prepare(
      `INSERT INTO session_checkpoints (conversation_key, session_id, session_status)
       VALUES ('conv-1', 'sess-abc', 'suspended')`,
    ).run();
    db.raw.prepare(
      `UPDATE session_checkpoints SET session_status = 'ended' WHERE conversation_key = 'conv-1'`,
    ).run();
    expect(resumableKeys()).not.toContain('conv-1');
  });
});
