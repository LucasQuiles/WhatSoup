import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { createTrigger, dueTriggers, resumeTrigger, TRIGGER_BUDGETS } from '../../../src/core/substrate/triggers.ts';
import { TriggerPoller } from '../../../src/core/substrate/poller.ts';
import type { Messenger } from '../../../src/core/types.ts';

describe('persisted trigger resource limits', () => {
  let directory: string;
  let db: Database;
  let now: number;
  const messenger: Messenger = {
    async sendMessage() { return { waMessageId: 'fixture-receipt' }; },
    async sendMedia() { throw new Error('unexpected media request'); },
  };

  beforeEach(() => {
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'trigger-resource-'));
    db = new Database(join(directory, 'fixture.db'));
    db.open();
    now = Math.floor(Date.now() / 1000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(directory, { recursive: true });
  });

  function sqliteTrigger(rawSpec?: string) {
    const bead = createBead(db.raw, { kind: 'watch', title: 'resource fixture', ownerJid: 'fixture', actor: 'fixture' });
    const trigger = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite', spec: { sql: 'SELECT 1', fire_when: 'rows_returned' },
      reportChatJid: 'fixture@s.whatsapp.net', nextFireAt: now, intervalSeconds: 60, actor: 'fixture',
    });
    if (rawSpec !== undefined) db.raw.prepare('UPDATE bead_triggers SET spec_json = ? WHERE id = ?').run(rawSpec, trigger.id);
    return trigger;
  }

  const validSpec = JSON.stringify({ sql: 'SELECT 1 /*é*/', fire_when: 'rows_returned' });
  const oversizedSpec = validSpec + ' '.repeat(TRIGGER_BUDGETS.maxSpecBytes + 1 - Buffer.byteLength(validSpec));

  it('bounds selected legacy spec bytes while preserving the original stored value and row identity', () => {
    const trigger = sqliteTrigger(oversizedSpec + ' '.repeat(1_024));
    const selected = dueTriggers(db.raw, now, 1);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ id: trigger.id, bead_id: trigger.bead_id, kind: trigger.kind, status: 'active' });
    expect(Buffer.byteLength(selected[0].spec_json)).toBeLessThanOrEqual(TRIGGER_BUDGETS.maxSpecBytes + 1);
    expect(db.raw.prepare('SELECT spec_json FROM bead_triggers WHERE id = ?').get(trigger.id)).toEqual({ spec_json: oversizedSpec + ' '.repeat(1_024) });
  });

  it.each([
    ['UTF-8 bytes', oversizedSpec],
    ['embedded NUL after valid JSON', validSpec + '\0' + ' '.repeat(TRIGGER_BUDGETS.maxSpecBytes)],
  ])('rejects oversized %s before parsing or execution', async (_name, rawSpec) => {
    const trigger = sqliteTrigger(rawSpec);
    const parse = vi.spyOn(JSON, 'parse');
    const poller = new TriggerPoller(db.raw, messenger, { now: () => now });
    try {
      expect(await poller.tickOnce()).toBe(1);
      expect(parse.mock.calls.filter(([text]) => typeof text === 'string' && Buffer.byteLength(text) > TRIGGER_BUDGETS.maxSpecBytes)).toHaveLength(0);
      expect(db.raw.prepare('SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?').get(trigger.id))
        .toEqual({ status: 'failed', error_kind: 'resource_exhausted' });
    } finally { poller.stop(); }
  });

  it('rejects an oversized paused spec before parsing without resuming or writing an event', () => {
    const trigger = sqliteTrigger(oversizedSpec);
    db.raw.prepare("UPDATE bead_triggers SET status = 'paused' WHERE id = ?").run(trigger.id);
    const parse = vi.spyOn(JSON, 'parse');
    expect(() => resumeTrigger(db.raw, trigger.id, { actor: 'fixture' })).toThrow(/resource budget/);
    expect(parse.mock.calls.filter(([text]) => typeof text === 'string' && Buffer.byteLength(text) > TRIGGER_BUDGETS.maxSpecBytes)).toHaveLength(0);
    expect(db.raw.prepare('SELECT status FROM bead_triggers WHERE id = ?').get(trigger.id)).toEqual({ status: 'paused' });
    expect(db.raw.prepare("SELECT count(*) AS n FROM bead_events WHERE bead_id = ? AND event_type = 'trigger_resumed'").get(trigger.bead_id)).toEqual({ n: 0 });
  });

  it('preserves, resumes and executes a valid raw spec exactly at the UTF-8 byte boundary', async () => {
    const raw = validSpec + ' '.repeat(TRIGGER_BUDGETS.maxSpecBytes - Buffer.byteLength(validSpec));
    expect(Buffer.byteLength(raw)).toBe(TRIGGER_BUDGETS.maxSpecBytes);
    const trigger = sqliteTrigger(raw);
    expect(dueTriggers(db.raw, now, 1)[0].spec_json).toBe(raw);
    db.raw.prepare("UPDATE bead_triggers SET status = 'paused' WHERE id = ?").run(trigger.id);
    expect(resumeTrigger(db.raw, trigger.id, { actor: 'fixture' })).toMatchObject({ resumed: true });
    expect(db.raw.prepare('SELECT spec_json FROM bead_triggers WHERE id = ?').get(trigger.id)).toEqual({ spec_json: raw });
    const execute = vi.fn(async () => ({ kind: 'ok' as const, rowCount: 1 }));
    const poller = new TriggerPoller(db.raw, messenger, { now: () => now, sqliteExecutor: execute });
    try {
      now += 61;
      expect(await poller.tickOnce()).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(db.raw.prepare('SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?').get(trigger.id))
        .toEqual({ status: 'ok', error_kind: null });
    } finally { poller.stop(); }
  });

  it('keeps timed-out work charged across ticks and admits queued work after it settles', async () => {
    for (let i = 0; i < 2; i++) {
      const bead = createBead(db.raw, { kind: 'watch', title: `URL fixture ${i}`, ownerJid: 'fixture', actor: 'fixture' });
      createTrigger(db.raw, { beadId: bead.id, kind: 'poll.url', spec: { url: `https://example.com/${i}`, hash_mode: 'text' }, reportChatJid: 'fixture@s.whatsapp.net', nextFireAt: now, intervalSeconds: 60, actor: 'fixture' });
    }
    const releases: Array<() => void> = [];
    let hold = true;
    let live = 0;
    let peak = 0;
    const fetch = vi.fn(async () => {
      live++;
      peak = Math.max(peak, live);
      try {
        if (hold) await new Promise<void>((resolve) => releases.push(resolve));
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'fixture' };
      } finally { live--; }
    });
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => now, enableUrlWatch: true, maxConcurrentExecutors: 1, executionTimeoutSeconds: 1, urlFetch: fetch,
    });
    try {
      expect(await poller.tickOnce()).toBe(1);
      now += 120;
      expect(await poller.tickOnce()).toBe(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(live).toBe(1);
      hold = false;
      for (const release of releases) release();
      await vi.waitFor(() => expect(live).toBe(0));
      expect(await poller.tickOnce()).toBe(2);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(peak).toBe(1);
    } finally {
      poller.stop();
      hold = false;
      for (const release of releases) release();
      await vi.waitFor(() => expect(live).toBe(0));
    }
  });
  it.each(['probe notification', 'scheduled notification', 'expiry notification'] as const)(
    'bounds overlapping ticks while a %s is unsettled', async (kind) => {
      for (let i = 0; i < 2; i++) {
        if (kind === 'scheduled notification') {
          const bead = createBead(db.raw, { kind: 'watch', title: `schedule ${i}`, ownerJid: 'fixture', actor: 'fixture' });
          createTrigger(db.raw, { beadId: bead.id, kind: 'schedule.at_time', spec: { fire_at: now }, reportChatJid: 'fixture@s.whatsapp.net', actor: 'fixture', nextFireAt: now });
        } else {
          const trigger = sqliteTrigger();
          if (kind === 'expiry notification') {
            db.raw.prepare("UPDATE bead_triggers SET terminal_at = ?, on_terminal = 'notify' WHERE id = ?").run(now - 1, trigger.id);
          }
        }
      }
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const send = vi.fn(async () => { await held; return { waMessageId: 'fixture-receipt' }; });
      const poller = new TriggerPoller(db.raw, { ...messenger, sendMessage: send }, {
        now: () => now, maxConcurrentExecutors: 1,
        sqliteExecutor: async () => ({ kind: 'ok', rowCount: 1 }),
      });
      const ticks: Promise<number>[] = [];
      try {
        ticks.push(poller.tickOnce());
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        ticks.push(poller.tickOnce());
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(send).toHaveBeenCalledTimes(1);
        expect(await ticks[1]).toBe(0);
        release();
        expect(await ticks[0]).toBe(2);
        expect(send).toHaveBeenCalledTimes(2);
      } finally {
        release();
        await Promise.all(ticks);
        poller.stop();
      }
    },
  );

  it.each(['execution', 'notification'] as const)('queues expiry behind in-flight probe %s and sends each disposition once', async (heldPhase) => {
    const trigger = sqliteTrigger();
    db.raw.prepare("UPDATE bead_triggers SET terminal_at = ?, on_terminal = 'notify' WHERE id = ?").run(now + 1, trigger.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const send = vi.fn(async (_jid: string, _text: string) => {
      if (heldPhase === 'notification') await held;
      return { waMessageId: 'fixture-receipt' };
    });
    const execute = vi.fn(async () => {
      if (heldPhase === 'execution') await held;
      return { kind: 'ok' as const, rowCount: 1 };
    });
    const poller = new TriggerPoller(db.raw, { ...messenger, sendMessage: send }, {
      now: () => now, sqliteExecutor: execute, executionTimeoutSeconds: 30,
    });
    const tick = poller.tickOnce();
    let expiryTick: Promise<number> | undefined;
    try {
      await vi.waitFor(() => expect(heldPhase === 'execution' ? execute : send).toHaveBeenCalledTimes(1));
      now += 2;
      expiryTick = poller.tickOnce();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(send).toHaveBeenCalledTimes(heldPhase === 'execution' ? 0 : 1);
      expect(await expiryTick).toBe(0);
      release();
      expect(await tick).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await poller.tickOnce()).toBe(1);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0][1]).toContain('Watch fired');
      expect(send.mock.calls[1][1]).toContain('expired');
      expect(await poller.tickOnce()).toBe(0);
      expect(db.raw.prepare('SELECT status, next_fire_at FROM bead_triggers WHERE id = ?').get(trigger.id))
        .toEqual({ status: 'expired', next_fire_at: null });
    } finally { release(); await tick; await expiryTick; poller.stop(); }
  });

  it('expires a timed-out probe once and ignores its late successful result', async () => {
    const trigger = sqliteTrigger();
    db.raw.prepare("UPDATE bead_triggers SET terminal_at = ?, on_terminal = 'notify' WHERE id = ?").run(now + 1, trigger.id);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let settled = false;
    const send = vi.fn(async () => ({ waMessageId: 'expiry-receipt' }));
    const poller = new TriggerPoller(db.raw, { ...messenger, sendMessage: send }, {
      now: () => now, executionTimeoutSeconds: 1, maxConcurrentExecutors: 1,
      sqliteExecutor: async () => { await held; settled = true; return { kind: 'ok', rowCount: 1 }; },
    });
    try {
      expect(await poller.tickOnce()).toBe(1);
      expect(db.raw.prepare('SELECT error_kind FROM trigger_runs WHERE trigger_id = ?').get(trigger.id))
        .toEqual({ error_kind: 'execution_timeout' });
      now += 2;
      expect(await poller.tickOnce()).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      const terminal = db.raw.prepare('SELECT * FROM bead_triggers WHERE id = ?').get(trigger.id);
      const runs = db.raw.prepare('SELECT * FROM trigger_runs WHERE trigger_id = ? ORDER BY id').all(trigger.id);
      release();
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(await poller.tickOnce()).toBe(0);
      expect(send).toHaveBeenCalledTimes(1);
      expect(db.raw.prepare('SELECT * FROM bead_triggers WHERE id = ?').get(trigger.id)).toEqual(terminal);
      expect(db.raw.prepare('SELECT * FROM trigger_runs WHERE trigger_id = ? ORDER BY id').all(trigger.id)).toEqual(runs);
    } finally { release(); await vi.waitFor(() => expect(settled).toBe(true)); poller.stop(); }
  });

});
