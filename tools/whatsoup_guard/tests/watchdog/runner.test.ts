import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatchdog } from '../../src/watchdog/runner.ts';
import { openDatabase } from '../../src/store/connection.ts';
import { EventStore } from '../../src/store/events.ts';
import type { Sink } from '../../src/transport/types.ts';

const dirs: string[] = [];
const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(nowIso = '2026-05-09T11:00:00.000Z') {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const dir = mkdtempSync(join(tmpdir(), 'wg-watchdog-'));
  dirs.push(dir);
  const events = new EventStore(db, join(dir, 'events.jsonl'));
  const deliveries: string[] = [];
  const metaAlertSink: Sink = {
    name: 'meta-test',
    isDurableLog: false,
    deliver: vi.fn(async (payload) => {
      deliveries.push(payload.body);
      return { ok: true, channel: 'meta-test' };
    }),
  };
  const run = () => runWatchdog({
    events,
    metaAlertSinks: [metaAlertSink],
    thresholdHours: 7,
    nowIso,
  });

  return { events, metaAlertSink, deliveries, run };
}

describe('runWatchdog', () => {
  it('emits meta-alert when heartbeat is silent past threshold', async () => {
    const { events, deliveries, run } = setup();
    events.append({
      ts: '2026-05-09T03:00:00.000Z',
      kind: 'heartbeat',
      domain: 'alerting',
      severity: 'info',
      payload: { status: 'cycle_complete' },
      alerted_to: 'none',
    });

    const result = await run();

    expect(result.alerts).toBe(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatch(/heartbeat.*silent/i);
    expect(events.queryByKind('alert_delivery_succeeded')).toHaveLength(1);
  });

  it('emits meta-alert when transport-broken is detected', async () => {
    const { events, deliveries, run } = setup();
    events.append({
      ts: '2026-05-09T10:55:00.000Z',
      kind: 'heartbeat',
      domain: 'alerting',
      severity: 'info',
      payload: { status: 'cycle_complete' },
      alerted_to: 'none',
    });
    for (let index = 0; index < 5; index += 1) {
      events.append({
        ts: '2026-05-09T10:56:00.000Z',
        kind: 'drift',
        domain: 'exposure',
        severity: 'high',
        scope_id: `scope-${index}`,
        probe_id: 'fixture.ports',
        fingerprint: `${index}`.padStart(64, '0'),
        payload: { diff: { added: {}, removed: {}, changed: {} } },
        alerted_to: 'none',
      });
      events.append({
        ts: '2026-05-09T10:57:00.000Z',
        kind: 'alert_delivery_failed',
        domain: 'alerting',
        severity: 'high',
        payload: { channel: 'whatsoup', ok: false },
        alerted_to: 'none',
      });
    }

    const result = await run();

    expect(result.alerts).toBe(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatch(/transport.*broken/i);
    expect(events.queryByKind('alert_delivery_succeeded')).toHaveLength(1);
  });

  it('does nothing when both detectors are clean', async () => {
    const { events, deliveries, run } = setup();
    events.append({
      ts: '2026-05-09T10:30:00.000Z',
      kind: 'heartbeat',
      domain: 'alerting',
      severity: 'info',
      payload: { status: 'cycle_complete' },
      alerted_to: 'none',
    });
    events.append({
      ts: '2026-05-09T10:45:00.000Z',
      kind: 'drift',
      domain: 'exposure',
      severity: 'high',
      scope_id: 'scope-a',
      probe_id: 'fixture.ports',
      fingerprint: 'a'.repeat(64),
      payload: { diff: { added: {}, removed: {}, changed: {} } },
      alerted_to: 'none',
    });
    events.append({
      ts: '2026-05-09T10:46:00.000Z',
      kind: 'alert_delivery_succeeded',
      domain: 'alerting',
      severity: 'high',
      payload: { channel: 'whatsoup', ok: true },
      alerted_to: 'whatsoup',
    });

    const result = await run();

    expect(result.alerts).toBe(0);
    expect(deliveries).toHaveLength(0);
  });

  it('records failed-all evidence when a finding has no meta-alert sinks', async () => {
    const { events } = setup();
    const result = await runWatchdog({
      events,
      metaAlertSinks: [],
      thresholdHours: 7,
      nowIso: '2026-05-09T11:00:00.000Z',
    });

    expect(result.alerts).toBe(1);
    expect(result.deliveryFailedCount).toBe(1);
    expect(events.queryByKind('alert_delivery_failed_all')[0]).toMatchObject({
      kind: 'alert_delivery_failed_all',
      domain: 'alerting',
      severity: 'crit',
      scope_id: 'watchdog',
      probe_id: 'watchdog.heartbeat_silent',
      alerted_to: 'none',
      payload: expect.objectContaining({
        source_event_id: null,
        deliveries: [],
        action_result: 'meta_alert',
        reason: expect.stringContaining('heartbeat silent'),
        failure: 'no_meta_alert_sinks',
      }),
    });
  });
});
