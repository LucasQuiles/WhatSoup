import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

// @ts-expect-error -- hook libraries are JavaScript modules imported by Node hooks; expires 2026-08-14
import * as rgpState from '../../deploy/hooks/lib/rgp-state.mjs';

const {
  ackQueueEntries,
  appendQueueEntry,
  checkAndRecordRateLimit,
  defaultSocketPath,
  instanceStateDir,
  logLine,
  queueLockPath,
  rateLimitPath,
  readQueueEntries,
  resolveInstanceName,
  sessionStateDir,
  stuckRepliesQueuePath,
  withQueueLock,
} = rgpState;

const tmp = trackTmpDirs('');
let originalHome: string | undefined;
let originalInstance: string | undefined;

function useTmpHome(): string {
  const dir = tmp.make('rgp-state');
  process.env.HOME = dir;
  return dir;
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalInstance = process.env.WHATSOUP_INSTANCE;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalInstance === undefined) delete process.env.WHATSOUP_INSTANCE;
  else process.env.WHATSOUP_INSTANCE = originalInstance;
});

describe('rgp-state instance and path helpers', () => {
  it('defaults to "default" when WHATSOUP_INSTANCE is unset or unsafe', () => {
    delete process.env.WHATSOUP_INSTANCE;
    expect(resolveInstanceName()).toBe('default');

    process.env.WHATSOUP_INSTANCE = '../etc/passwd';
    expect(resolveInstanceName()).toBe('default');

    process.env.WHATSOUP_INSTANCE = '..';
    expect(resolveInstanceName()).toBe('default');
  });

  it('accepts safe instance names used by WhatSoup fleets', () => {
    process.env.WHATSOUP_INSTANCE = 'ana.bot_v2-prod';
    expect(resolveInstanceName()).toBe('ana.bot_v2-prod');
  });

  it('creates per-instance state directories under the user home', () => {
    const home = useTmpHome();
    const dir = instanceStateDir('ana-bot');

    expect(dir).toBe(join(home, '.claude', 'rgp', 'ana-bot'));
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('keeps session state separate from per-instance RGP state', () => {
    const home = useTmpHome();

    expect(sessionStateDir('session-1')).toBe(join(home, '.claude', 'session-env', 'session-1'));
    expect(stuckRepliesQueuePath('bot-a')).toBe(join(home, '.claude', 'rgp', 'bot-a', 'stuck-replies.jsonl'));
    expect(rateLimitPath('bot-a')).toBe(join(home, '.claude', 'rgp', 'bot-a', 'fallback-rate-limit.json'));
    expect(queueLockPath('bot-a')).toBe(join(home, '.claude', 'rgp', 'bot-a', 'stuck-replies.lock'));
    expect(defaultSocketPath()).toBe(join(home, '.claude', 'whatsoup.sock'));
  });
});

describe('rgp-state JSONL queue helpers', () => {
  beforeEach(() => {
    useTmpHome();
  });

  it('appendQueueEntry writes exactly one JSONL entry per call', () => {
    const path = stuckRepliesQueuePath('queue-a');

    expect(appendQueueEntry(path, { id: 'a', chatJid: 'chat@g.us', text: 'one' })).toBe(true);
    expect(appendQueueEntry(path, { id: 'b', chatJid: 'chat@g.us', text: 'two' })).toBe(true);

    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ id: 'a', text: 'one' });
    expect(JSON.parse(lines[1])).toMatchObject({ id: 'b', text: 'two' });
  });

  it('readQueueEntries tolerates malformed lines while returning valid entries', () => {
    const path = stuckRepliesQueuePath('queue-b');
    writeFileSync(path, '{"id":"a"}\nnot-json\n{"id":"b"}\n');

    const result = readQueueEntries(path);

    expect(result.malformedLines).toBe(1);
    expect(result.entries.map((entry: { id?: string }) => entry.id)).toEqual(['a', 'b']);
  });

  it('ackQueueEntries removes successful entries and keeps failed entries queued', () => {
    const path = stuckRepliesQueuePath('queue-c');
    appendQueueEntry(path, { id: 'sent', status: 'sent' });
    appendQueueEntry(path, { id: 'failed', status: 'failed' });

    const result = ackQueueEntries(path, (entry: { status?: string }) => entry.status === 'sent');

    expect(result).toMatchObject({ ok: true, removed: 1, kept: 1 });
    expect(readQueueEntries(path).entries).toEqual([{ id: 'failed', status: 'failed' }]);
  });

  it('ackQueueEntries preserves malformed lines instead of silently deleting them', () => {
    const path = stuckRepliesQueuePath('queue-d');
    writeFileSync(path, '{"id":"sent","status":"sent"}\nnot-json\n{"id":"failed","status":"failed"}\n');

    const result = ackQueueEntries(path, (entry: { status?: string }) => entry.status === 'sent');

    expect(result).toMatchObject({ ok: true, removed: 1, kept: 2, malformedLines: 1 });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('not-json');
    expect(text).toContain('"failed"');
    expect(text).not.toContain('"sent"');
  });

  it('returns false when appendQueueEntry cannot write', () => {
    if (process.geteuid?.() === 0) return;
    const path = stuckRepliesQueuePath('queue-readonly');
    const dir = dirname(path);
    chmodSync(dir, 0o500);
    try {
      expect(appendQueueEntry(path, { id: 'x' })).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('rgp-state lock and rate-limit helpers', () => {
  beforeEach(() => {
    useTmpHome();
  });

  it('withQueueLock serializes work and removes the lock after success', async () => {
    const result = await withQueueLock('lock-a', async () => 'done', { staleMs: 60_000 });

    expect(result).toEqual({ ok: true, result: 'done' });
    expect(existsSync(queueLockPath('lock-a'))).toBe(false);
  });

  it('withQueueLock refuses an active lock without running the callback', async () => {
    const lockPath = queueLockPath('lock-b');
    writeFileSync(lockPath, 'busy');
    const callback = vi.fn();

    const result = await withQueueLock('lock-b', callback, { staleMs: 60_000 });

    expect(result).toMatchObject({ ok: false, locked: true });
    expect(callback).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(true);
  });

  it('withQueueLock recovers stale locks before running the callback', async () => {
    const lockPath = queueLockPath('lock-c');
    writeFileSync(lockPath, 'stale');
    const stale = new Date(Date.now() - 120_000);
    utimesSync(lockPath, stale, stale);

    const result = await withQueueLock('lock-c', async () => 'recovered', { staleMs: 1_000 });

    expect(result).toEqual({ ok: true, result: 'recovered' });
  });

  it('checkAndRecordRateLimit allows three sends per chat per window and blocks the fourth', () => {
    const now = Date.parse('2026-05-14T12:00:00Z');

    expect(checkAndRecordRateLimit('chat@g.us', 'rate-a', { now }).allowed).toBe(true);
    expect(checkAndRecordRateLimit('chat@g.us', 'rate-a', { now: now + 1 }).allowed).toBe(true);
    expect(checkAndRecordRateLimit('chat@g.us', 'rate-a', { now: now + 2 }).allowed).toBe(true);
    const blocked = checkAndRecordRateLimit('chat@g.us', 'rate-a', { now: now + 3 });

    expect(blocked.allowed).toBe(false);
    expect(blocked.count).toBe(3);
  });

  it('rate limits are isolated by instance and sanitize chat keys', () => {
    const dirtyJid = 'chat[evil]/with space@g.us';

    for (let i = 0; i < 3; i += 1) checkAndRecordRateLimit(dirtyJid, 'rate-b');
    expect(checkAndRecordRateLimit(dirtyJid, 'rate-b').allowed).toBe(false);
    expect(checkAndRecordRateLimit(dirtyJid, 'rate-c').allowed).toBe(true);

    const state = JSON.parse(readFileSync(rateLimitPath('rate-b'), 'utf8'));
    expect(state[dirtyJid]).toBeUndefined();
    expect(Object.keys(state)).toEqual(['chat_evil__with_space@g.us']);
  });

  it('logLine writes timestamped JSON and swallows write errors', () => {
    const path = join(instanceStateDir('log-a'), 'events.log');

    logLine(path, { event: 'test' });

    expect(readFileSync(path, 'utf8')).toMatch(/^\[20\d\d-/);
    expect(() => logLine('/no/such/dir/events.log', { event: 'ignored' })).not.toThrow();
  });
});
