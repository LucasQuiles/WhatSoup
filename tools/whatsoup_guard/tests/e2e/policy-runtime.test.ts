import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureCollector } from '../../src/collector/fixture.ts';
import { buildRuntimeConfig } from '../../src/policy/runtime.ts';
import { loadPolicy } from '../../src/policy/loader.ts';
import { runCycle } from '../../src/runner.ts';
import { BaselineStore } from '../../src/store/baseline.ts';
import { openDatabase } from '../../src/store/connection.ts';
import { EventStore } from '../../src/store/events.ts';
import { MuteStore } from '../../src/store/mutes.ts';
import type { Sink } from '../../src/transport/types.ts';

const KEY = Buffer.from('policy-runtime-e2e-key');
const NOW = new Date('2026-05-08T10:00:00.000Z');
const dirs: string[] = [];
const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('policy runtime integration', () => {
  it('honors domains.change.enabled false through the loaded policy runtime path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-policy-runtime-'));
    dirs.push(dir);
    const policyPath = join(dir, 'policy.yaml');
    writeFileSync(policyPath, [
      'extends: development',
      'domains:',
      '  change:',
      '    enabled: false',
      '',
    ].join('\n'));
    const db = openDatabase(':memory:');
    dbs.push(db);
    const baselines = new BaselineStore(db, KEY);
    const events = new EventStore(db, join(dir, 'events.jsonl'));
    const mutes = new MuteStore(db, { now: () => NOW });
    baselines.set({
      probe_id: 'fixture.change',
      scope_id: 'scope-a',
      expected_doc: JSON.stringify({ routes: ['/healthz'] }),
      captured_at: '2026-05-08T09:00:00.000Z',
      captured_by: 'fixture',
    });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { routes: ['/healthz', '/admin'] }, captured_at: NOW.toISOString() } },
    });
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: () => () => [],
      changeProbeIds: ['fixture.change'],
      runtimeConfig: buildRuntimeConfig(loadPolicy(policyPath)),
      now: () => NOW,
      sinks: [sink],
    });

    expect(result).toMatchObject({
      driftCount: 0,
      deliverySucceededCount: 0,
      deliveryFailedCount: 0,
      heartbeatCount: 1,
    });
    expect(result.totalEventCount).toBe(1);
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(events.queryByKind('drift')).toHaveLength(0);
    expect(events.queryByKind('alert_delivery_succeeded')).toHaveLength(0);
  });
});
