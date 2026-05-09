import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureCollector } from '../../src/collector/fixture.ts';
import { driftRule } from '../../src/evaluator/canonical-rules.ts';
import { runOneProbe } from '../../src/engine/lifecycle.ts';
import { BaselineStore } from '../../src/store/baseline.ts';
import { openDatabase } from '../../src/store/connection.ts';
import { EventStore } from '../../src/store/events.ts';
import { MuteStore } from '../../src/store/mutes.ts';
import type { ProbeDoc } from '../../src/types.ts';

const KEY = Buffer.from('lifecycle-baseline-key');
const NOW = new Date('2026-05-08T10:00:00.000Z');
const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function setup() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const baselines = new BaselineStore(db, KEY);
  const events = new EventStore(db, join(mkdtempSync(join(tmpdir(), 'wg-life-')), 'events.jsonl'));
  const mutes = new MuteStore(db, { now: () => NOW, allowWildcard: true });
  return { db, baselines, events, mutes };
}

function evaluator(ctx: { observed: ProbeDoc; baseline: ProbeDoc | undefined }) {
  return driftRule({ observed: ctx.observed, baseline: ctx.baseline, severity: 'high', domain: 'exposure' });
}

function baseline(baselines: BaselineStore, fields: Record<string, unknown>): void {
  baselines.set({
    probe_id: 'probe.fixture',
    scope_id: 'scope-a',
    expected_doc: JSON.stringify(fields),
    captured_at: '2026-05-08T09:00:00.000Z',
    captured_by: 'fixture',
  });
}

describe('runOneProbe', () => {
  it('emits probe_error when collector throws', async () => {
    const { baselines, events, mutes } = setup();
    const collector = new FixtureCollector({ id: 'probe.fixture', docs: {} });

    const result = await runOneProbe({
      collector,
      scopeId: 'scope-a',
      baselines,
      events,
      mutes,
      evaluator,
      now: () => NOW,
    });

    expect(result.events.map((event) => event.kind)).toEqual(['probe_error']);
    expect(events.queryByKind('probe_error')).toHaveLength(1);
    expect(events.queryByKind('drift')).toHaveLength(0);
  });

  it('emits no event when observed equals baseline', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, { ports: [80] });
    const collector = new FixtureCollector({
      id: 'probe.fixture',
      docs: { 'scope-a': { fields: { ports: [80] }, captured_at: NOW.toISOString() } },
    });

    const result = await runOneProbe({
      collector,
      scopeId: 'scope-a',
      baselines,
      events,
      mutes,
      evaluator,
      now: () => NOW,
    });

    expect(result.events).toEqual([]);
    expect(events.queryByKind('drift')).toHaveLength(0);
  });

  it('emits alerting-domain evidence when no baseline exists', async () => {
    const { baselines, events, mutes } = setup();
    const collector = new FixtureCollector({
      id: 'probe.fixture',
      docs: { 'scope-a': { fields: { ports: [80] }, captured_at: NOW.toISOString() } },
    });

    const result = await runOneProbe({
      collector,
      scopeId: 'scope-a',
      baselines,
      events,
      mutes,
      evaluator,
      now: () => NOW,
    });

    expect(result.events).toContainEqual(expect.objectContaining({
      kind: 'probe_error',
      domain: 'alerting',
      severity: 'high',
      alerted_to: 'none',
      payload: expect.objectContaining({ error: 'missing baseline' }),
    }));
    expect(events.queryByKind('probe_error')).toHaveLength(1);
  });

  it('emits drift when observed differs from baseline', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, { ports: [80] });
    const collector = new FixtureCollector({
      id: 'probe.fixture',
      docs: { 'scope-a': { fields: { ports: [80, 443] }, captured_at: NOW.toISOString() } },
    });

    const result = await runOneProbe({
      collector,
      scopeId: 'scope-a',
      baselines,
      events,
      mutes,
      evaluator,
      now: () => NOW,
    });

    expect(result.events.map((event) => event.kind)).toEqual(['drift']);
    expect(events.queryByKind('drift')).toHaveLength(1);
  });

  it('emits drift_muted when a host and domain mute is active', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, { ports: [80] });
    const muteId = mutes.create({
      host: 'scope-a',
      domain: 'exposure',
      expires_at: '2026-05-08T11:00:00.000Z',
      reason: 'maintenance',
      created_by: 'operator',
    });
    const collector = new FixtureCollector({
      id: 'probe.fixture',
      docs: { 'scope-a': { fields: { ports: [80, 443] }, captured_at: NOW.toISOString() } },
    });

    const result = await runOneProbe({
      collector,
      scopeId: 'scope-a',
      baselines,
      events,
      mutes,
      evaluator,
      now: () => NOW,
    });

    expect(result.events.map((event) => event.kind)).toEqual(['drift_muted']);
    expect(result.events[0]?.payload).toMatchObject({ mute_id: muteId, mute_match_reason: 'mute matched' });
    expect(events.queryByKind('drift_muted')).toHaveLength(1);
    expect(events.queryByKind('drift')).toHaveLength(0);
  });

  it('emits baseline_integrity_fail and refuses drift evaluation when the baseline row is tampered', async () => {
    const { db, baselines, events, mutes } = setup();
    baseline(baselines, { ports: [80] });
    db.prepare('UPDATE baseline SET expected_doc = ? WHERE probe_id = ? AND scope_id = ?')
      .run('{"ports":[999]}', 'probe.fixture', 'scope-a');
    const collector = new FixtureCollector({
      id: 'probe.fixture',
      docs: { 'scope-a': { fields: { ports: [80, 443] }, captured_at: NOW.toISOString() } },
    });

    const result = await runOneProbe({
      collector,
      scopeId: 'scope-a',
      baselines,
      events,
      mutes,
      evaluator,
      now: () => NOW,
    });

    expect(result.events.map((event) => event.kind)).toEqual(['baseline_integrity_fail']);
    expect(result.events[0]?.severity).toBe('crit');
    expect(result.events[0]?.domain).toBe('alerting');
    expect(events.queryByKind('baseline_integrity_fail')).toHaveLength(1);
    expect(events.queryByKind('baseline_integrity_fail')[0]?.domain).toBe('alerting');
    expect(events.queryByKind('drift')).toHaveLength(0);
  });
});
