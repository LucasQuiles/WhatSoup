import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLogSink, LocalNotifySink } from '../../src/transport/local-notify.ts';

const dirs: string[] = [];
const NOW = new Date('2026-05-08T12:00:00.000Z');

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpPath(filename: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-local-sink-'));
  dirs.push(dir);
  return join(dir, filename);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('local sinks', () => {
  it('LocalLogSink writes JSONL lines and reports isDurableLog', async () => {
    const path = tmpPath('alerts.jsonl');
    const sink = new LocalLogSink(path, { now: () => NOW });

    expect(sink.isDurableLog).toBe(true);
    const result = await sink.deliver({ body: 'hello\noperator' });

    expect(result).toEqual({ ok: true, channel: 'local-log' });
    expect(readJsonl(path)).toEqual([
      { ts: NOW.toISOString(), channel: 'local-log', body: 'hello\noperator' },
    ]);
  });

  it('LocalNotifySink uses notifier when available', async () => {
    const calls: Array<{ title: string; body: string }> = [];
    const fallback = tmpPath('fallback.jsonl');
    const sink = new LocalNotifySink({
      notifier: async (title, body) => {
        calls.push({ title, body });
      },
      fallbackLogPath: fallback,
      now: () => NOW,
    });

    const result = await sink.deliver({ body: 'hi' });

    expect(result).toEqual({ ok: true, channel: 'local-notify' });
    expect(calls).toEqual([{ title: 'whatsoup-guard', body: 'hi' }]);
    expect(() => readFileSync(fallback, 'utf8')).toThrow();
  });

  it('LocalNotifySink returns a failed delivery when notifier is missing', async () => {
    const fallback = tmpPath('fallback.jsonl');
    const sink = new LocalNotifySink({ notifier: undefined, fallbackLogPath: fallback, now: () => NOW });

    const result = await sink.deliver({ body: 'hi' });

    expect(result).toEqual({
      ok: false,
      channel: 'local-notify',
      error: 'notifier unavailable; wrote fallback log',
    });
    expect(readJsonl(fallback)).toEqual([
      { ts: NOW.toISOString(), channel: 'local-notify', body: 'hi', fallback: 'notifier_unavailable' },
    ]);
  });

  it('LocalNotifySink returns a failed delivery when notifier throws', async () => {
    const fallback = tmpPath('fallback.jsonl');
    const sink = new LocalNotifySink({
      notifier: async () => {
        throw new Error('notification unavailable');
      },
      fallbackLogPath: fallback,
      now: () => NOW,
    });

    const result = await sink.deliver({ body: 'hi' });

    expect(result).toEqual({
      ok: false,
      channel: 'local-notify',
      error: 'notification unavailable; wrote fallback log',
    });
    expect(readJsonl(fallback)).toEqual([
      {
        ts: NOW.toISOString(),
        channel: 'local-notify',
        body: 'hi',
        fallback: 'notifier_failed',
        error: 'notification unavailable',
      },
    ]);
  });
});
