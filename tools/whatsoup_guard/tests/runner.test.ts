import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureCollector } from '../src/collector/fixture.ts';
import { capabilityRoleRule, driftRule } from '../src/evaluator/canonical-rules.ts';
import { buildRuntimeConfig, type RuntimePolicyConfig } from '../src/policy/runtime.ts';
import { loadPolicy } from '../src/policy/loader.ts';
import type { Evaluator } from '../src/evaluator/types.ts';
import { runCycle } from '../src/runner.ts';
import { BaselineStore } from '../src/store/baseline.ts';
import { openDatabase } from '../src/store/connection.ts';
import { EventStore } from '../src/store/events.ts';
import { MuteStore } from '../src/store/mutes.ts';
import { RuntimeStateStore } from '../src/store/state.ts';
import type { Sink } from '../src/transport/types.ts';

const KEY = Buffer.from('runner-baseline-key');
const NOW = new Date('2026-05-08T10:00:00.000Z');
const DAY_MS = 86_400_000;
const dirs: string[] = [];
const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const dir = mkdtempSync(join(tmpdir(), 'wg-runner-'));
  dirs.push(dir);
  return {
    db,
    baselines: new BaselineStore(db, KEY),
    events: new EventStore(db, join(dir, 'events.jsonl')),
    mutes: new MuteStore(db, { now: () => NOW }),
    runtimeState: new RuntimeStateStore(db),
  };
}

function baseline(baselines: BaselineStore, probeId: string, scopeId: string, fields: Record<string, unknown>): void {
  baselines.set({
    probe_id: probeId,
    scope_id: scopeId,
    expected_doc: JSON.stringify(fields),
    captured_at: '2026-05-08T09:00:00.000Z',
    captured_by: 'fixture',
  });
}

function tempFile(name: string, body = 'local-configured-test-file'): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-runner-file-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function evaluatorFor(): Evaluator {
  return (ctx) => driftRule({ observed: ctx.observed, baseline: ctx.baseline, severity: 'high', domain: 'exposure' });
}

function criticalEvaluatorFor(): Evaluator {
  return (ctx) => driftRule({ observed: ctx.observed, baseline: ctx.baseline, severity: 'crit', domain: 'exposure' });
}

function runtimeConfig(actions: RuntimePolicyConfig['actions']): RuntimePolicyConfig {
  return {
    actions,
    forbiddenMuteDomains: ['alerting'],
    metaAlertEnabled: true,
    domainSeverities: {},
    enabledDomains: {},
  };
}

describe('runCycle', () => {
  it('runs every collector and scope pair and emits drift to the ledger', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 2 }, captured_at: NOW.toISOString() } },
    });

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
    });

    expect(result).toEqual({
      driftCount: 1,
      probeErrorCount: 0,
      totalEventCount: 2,
      deliverySucceededCount: 0,
      deliveryFailedCount: 0,
      dedupSuppressedCount: 0,
      stormSuppressedCount: 0,
      baselineIntegrityFailCount: 0,
      selfSecretWidenedCount: 0,
      tokenAgingCount: 0,
      heartbeatCount: 1,
    });
    expect(events.queryByKind('drift')).toHaveLength(1);
  });

  it('writes a heartbeat event for each completed cycle', async () => {
    const { baselines, events, mutes } = setup();

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
    });

    expect(result.heartbeatCount).toBe(1);
    expect(events.queryByKind('heartbeat')[0]).toMatchObject({
      kind: 'heartbeat',
      domain: 'alerting',
      payload: expect.objectContaining({ status: 'cycle_complete' }),
    });
  });

  it('emits mute_expire events for mutes that expired since the previous cycle', async () => {
    const { baselines, events, mutes, runtimeState } = setup();
    runtimeState.set('prev_cycle_iso', '2026-05-09T09:00:00.000Z');
    const muteId = mutes.create({
      host: 'scope-a',
      domain: 'change',
      expires_at: '2026-05-09T09:30:00.000Z',
      reason: 'planned maintenance ended',
      created_by: 'operator',
    });

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      runtimeState,
      evaluatorFor,
      now: () => new Date('2026-05-09T10:00:00.000Z'),
    });

    expect(result.totalEventCount).toBe(2);
    expect(runtimeState.get('prev_cycle_iso')).toBe('2026-05-09T10:00:00.000Z');
    const expired = events.queryByKind('mute_expire');
    expect(expired).toHaveLength(1);
    expect(expired[0]!.payload).toMatchObject({
      mute_id: muteId,
      host: 'scope-a',
      domain: 'change',
      expired_at: '2026-05-09T09:30:00.000Z',
    });
  });

  it('does not deliver a mute_expire alert when no sink is configured (backward compatible)', async () => {
    const { baselines, events, mutes, runtimeState } = setup();
    runtimeState.set('prev_cycle_iso', '2026-05-09T09:00:00.000Z');
    mutes.create({
      host: 'scope-a',
      domain: 'change',
      expires_at: '2026-05-09T09:30:00.000Z',
      reason: 'planned maintenance ended',
      created_by: 'operator',
    });

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      runtimeState,
      evaluatorFor,
      now: () => new Date('2026-05-09T10:00:00.000Z'),
    });

    expect(result.deliverySucceededCount).toBe(0);
    expect(result.deliveryFailedCount).toBe(0);
    expect(events.queryByKind('alert_delivery_succeeded')).toHaveLength(0);
  });

  it('delivers a mute_expire alert to the configured sink exactly once, correlated with the drift it was suppressing', async () => {
    const { baselines, events, mutes, runtimeState } = setup();
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    const muteId = mutes.create({
      host: 'scope-a',
      domain: 'exposure',
      expires_at: '2026-05-08T11:00:00.000Z',
      reason: 'planned maintenance',
      created_by: 'operator',
    });
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 2 }, captured_at: NOW.toISOString() } },
    });
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      runtimeState,
      evaluatorFor,
      now: () => NOW,
      sinks: [sink],
    });

    const muted = events.queryByKind('drift_muted');
    expect(muted).toHaveLength(1);
    expect(muted[0]?.payload).toMatchObject({ mute_id: muteId });
    expect(sink.deliver).not.toHaveBeenCalled();
    const suppressedCorrelationId = muted[0]!.correlation_id;

    const afterExpiry = new Date('2026-05-08T11:30:00.000Z');
    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      runtimeState,
      evaluatorFor,
      now: () => afterExpiry,
      sinks: [sink],
    });

    expect(sink.deliver).toHaveBeenCalledTimes(1);
    expect(result.deliverySucceededCount).toBe(1);
    expect(result.deliveryFailedCount).toBe(0);
    const delivered = events.queryByKind('alert_delivery_succeeded');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.correlation_id).toBe(suppressedCorrelationId);
  });

  it('delivers a mute_expire alert with a fresh correlation id when the mute never suppressed anything', async () => {
    const { baselines, events, mutes, runtimeState } = setup();
    runtimeState.set('prev_cycle_iso', '2026-05-09T09:00:00.000Z');
    mutes.create({
      host: 'scope-b',
      domain: 'exposure',
      expires_at: '2026-05-09T09:30:00.000Z',
      reason: 'unused mute',
      created_by: 'operator',
    });
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      runtimeState,
      evaluatorFor,
      now: () => new Date('2026-05-09T10:00:00.000Z'),
      sinks: [sink],
    });

    expect(sink.deliver).toHaveBeenCalledTimes(1);
    expect(result.deliverySucceededCount).toBe(1);
    const delivered = events.queryByKind('alert_delivery_succeeded');
    const muteExpireEvent = events.queryByKind('mute_expire')[0];
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.correlation_id).toBe(muteExpireEvent?.correlation_id);
  });

  it('does not re-deliver a mute_expire alert on a later cycle for the same already-expired mute (no duplicate page burst)', async () => {
    const { baselines, events, mutes, runtimeState } = setup();
    runtimeState.set('prev_cycle_iso', '2026-05-09T09:00:00.000Z');
    mutes.create({
      host: 'scope-a',
      domain: 'change',
      expires_at: '2026-05-09T09:30:00.000Z',
      reason: 'planned maintenance ended',
      created_by: 'operator',
    });
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      runtimeState,
      evaluatorFor,
      now: () => new Date('2026-05-09T10:00:00.000Z'),
      sinks: [sink],
    });

    expect(sink.deliver).toHaveBeenCalledTimes(1);

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      runtimeState,
      evaluatorFor,
      now: () => new Date('2026-05-09T11:00:00.000Z'),
      sinks: [sink],
    });

    expect(sink.deliver).toHaveBeenCalledTimes(1);
    expect(result.deliverySucceededCount).toBe(0);
    expect(events.queryByKind('alert_delivery_succeeded')).toHaveLength(1);
  });

  it('passes deployment role context into the evaluator', async () => {
    const { baselines, events, mutes } = setup();
    const fields = { runtime_type: 'passive', role: 'support', provider_env: {} };
    baseline(baselines, 'fixture.capability', 'scope-a', fields);
    const collector = new FixtureCollector({
      id: 'fixture.capability',
      docs: { 'scope-a': { fields, captured_at: NOW.toISOString() } },
    });

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: () => (ctx) => capabilityRoleRule({
        observed: ctx.observed,
        deploymentRole: ctx.deploymentRole,
      }),
      deploymentRoles: { support: { runtime_type: 'agent' } },
      now: () => NOW,
    });

    expect(result.driftCount).toBe(1);
    expect(events.queryByKind('drift')[0]).toMatchObject({
      domain: 'capability',
      severity: 'high',
      payload: expect.objectContaining({
        reason_code: 'capability.role_violation',
      }),
    });
  });

  it('emits change-domain drift for change-relevant probe ids', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.change', 'scope-a', { units: ['existing.service'] });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { units: ['existing.service', 'new.service'] }, captured_at: NOW.toISOString() } },
    });

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: () => () => [],
      changeProbeIds: ['fixture.change'],
      now: () => NOW,
    });

    expect(result.driftCount).toBe(1);
    expect(events.queryByKind('drift')[0]).toMatchObject({
      domain: 'change',
      severity: 'high',
      payload: expect.objectContaining({
        reason_code: 'change.new_persistence_unit',
      }),
    });
  });

  it('uses policy domain severity for change-domain drift', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.change', 'scope-a', { routes: ['/healthz'] });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { routes: ['/healthz', '/admin'] }, captured_at: NOW.toISOString() } },
    });

    await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: () => () => [],
      changeProbeIds: ['fixture.change'],
      runtimeConfig: {
        ...runtimeConfig({ 'change.new_application_route': 'alert' }),
        domainSeverities: { change: 'med' },
      },
      now: () => NOW,
    });

    expect(events.queryByKind('drift')[0]).toMatchObject({
      domain: 'change',
      severity: 'med',
      payload: expect.objectContaining({
        reason_code: 'change.new_application_route',
      }),
    });
  });

  it('suppresses disabled change-domain findings before ledgering or delivery', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.change', 'scope-a', { units: ['existing.service'] });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { units: ['existing.service', 'new.service'] }, captured_at: NOW.toISOString() } },
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
      runtimeConfig: {
        ...runtimeConfig({ 'change.new_persistence_unit': 'alert' }),
        enabledDomains: { change: false },
      },
      now: () => NOW,
      sinks: [sink],
    });

    expect(result).toMatchObject({
      driftCount: 0,
      probeErrorCount: 0,
      deliverySucceededCount: 0,
      deliveryFailedCount: 0,
      heartbeatCount: 1,
    });
    expect(result.totalEventCount).toBe(1);
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(events.queryByKind('drift')).toHaveLength(0);
    expect(events.queryByKind('alert_delivery_succeeded')).toHaveLength(0);
  });

  it('honors policy action observe by ledgering drift without alert dispatch', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.change', 'scope-a', { units: ['existing.service'] });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { units: ['existing.service', 'new.service'] }, captured_at: NOW.toISOString() } },
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
      runtimeConfig: {
        ...runtimeConfig({ 'change.new_persistence_unit': 'observe' }),
        forbiddenMuteDomains: ['change'],
      },
      now: () => NOW,
      sinks: [sink],
    });

    expect(result.driftCount).toBe(1);
    expect(result.deliverySucceededCount).toBe(0);
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(events.queryByKind('drift')).toHaveLength(1);
    expect(events.queryByKind('alert_delivery_succeeded')).toHaveLength(0);
  });

  it('honors policy action alert by dispatching through the normal alert chain', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.change', 'scope-a', { units: ['existing.service'] });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { units: ['existing.service', 'new.service'] }, captured_at: NOW.toISOString() } },
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
      runtimeConfig: runtimeConfig({ 'change.new_persistence_unit': 'alert' }),
      now: () => NOW,
      sinks: [sink],
    });

    expect(result.deliverySucceededCount).toBe(1);
    expect(sink.deliver).toHaveBeenCalledOnce();
    expect(vi.mocked(sink.deliver).mock.calls[0]?.[0].body).toMatch(/action:\s+alert/u);
  });

  it('passes event severity into the transport payload', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 2 }, captured_at: NOW.toISOString() } },
    });
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
      sinks: [sink],
    });

    expect(sink.deliver).toHaveBeenCalledOnce();
    expect(vi.mocked(sink.deliver).mock.calls[0]?.[0]).toMatchObject({ severity: 'high' });
  });

  it('honors policy action propose_fix by dispatching with the proposed-fix label', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.change', 'scope-a', { routes: ['/healthz'] });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { routes: ['/healthz', '/admin'] }, captured_at: NOW.toISOString() } },
    });
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: () => () => [],
      changeProbeIds: ['fixture.change'],
      runtimeConfig: runtimeConfig({ 'change.new_application_route': 'propose_fix' }),
      now: () => NOW,
      sinks: [sink],
    });

    expect(sink.deliver).toHaveBeenCalledOnce();
    expect(vi.mocked(sink.deliver).mock.calls[0]?.[0].body).toMatch(/action:\s+propose_fix/u);
  });

  it.each(['personal-strict', 'production'] as const)(
    'runs shipped %s exposure actions without pre-alert unsupported-action errors',
    async (profileName) => {
      const { baselines, events, mutes } = setup();
      baseline(baselines, 'fixture.exposure', 'scope-a', { firewall: 'enabled' });
      const collector = new FixtureCollector({
        id: 'fixture.exposure',
        docs: { 'scope-a': { fields: { firewall: 'disabled' }, captured_at: NOW.toISOString() } },
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
        evaluatorFor: () => (ctx) => [{
          ts: ctx.observed.captured_at,
          kind: 'drift',
          domain: 'exposure',
          scope_id: ctx.observed.scope_id,
          probe_id: ctx.observed.probe_id,
          severity: 'high',
          fingerprint: profileName === 'production'
            ? '1'.repeat(64)
            : '2'.repeat(64),
          payload: {
            reason_code: 'exposure.firewall_disabled',
            diff: { added: {}, removed: {}, changed: { firewall: ['enabled', 'disabled'] } },
          },
        }],
        runtimeConfig: buildRuntimeConfig(loadPolicy(
          new URL(`../src/policy/profiles/${profileName}.yaml`, import.meta.url).pathname,
        )),
        now: () => NOW,
        sinks: [sink],
      });

      expect(result.deliverySucceededCount).toBe(1);
      expect(sink.deliver).toHaveBeenCalledOnce();
      expect(vi.mocked(sink.deliver).mock.calls[0]?.[0].body).toMatch(/action:\s+propose_fix/u);
    },
  );

  it('honors policy action meta_alert by dispatching through meta-alert sinks', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.change', 'scope-a', { units: ['existing.service'] });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { units: ['existing.service', 'new.service'] }, captured_at: NOW.toISOString() } },
    });
    const primary: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };
    const meta: Sink = {
      name: 'meta-test',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'meta-test' })),
    };

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: () => () => [],
      changeProbeIds: ['fixture.change'],
      runtimeConfig: runtimeConfig({ 'change.new_persistence_unit': 'meta_alert' }),
      now: () => NOW,
      sinks: [primary],
      metaAlertSinks: [meta],
    });

    expect(result.deliverySucceededCount).toBe(1);
    expect(primary.deliver).not.toHaveBeenCalled();
    expect(meta.deliver).toHaveBeenCalledOnce();
    expect(events.queryByKind('alert_delivery_succeeded')[0]?.alerted_to).toBe('external_push');
  });

  it('rejects policy remediate actions until auto-revert support exists', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.change', 'scope-a', { units: ['existing.service'] });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { units: ['existing.service', 'new.service'] }, captured_at: NOW.toISOString() } },
    });

    await expect(runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: () => () => [],
      changeProbeIds: ['fixture.change'],
      runtimeConfig: runtimeConfig({ 'change.new_persistence_unit': 'remediate' }),
      now: () => NOW,
    })).rejects.toThrow(/policy action remediate is not yet supported/);
  });

  it('uses policy forbidden mute domains when evaluating drift mutes', async () => {
    const { baselines, events, mutes } = setup();
    mutes.create({
      host: 'scope-a',
      domain: 'change',
      expires_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
      reason: 'would otherwise mute change drift',
      created_by: 'operator',
    });
    baseline(baselines, 'fixture.change', 'scope-a', { units: ['existing.service'] });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { units: ['existing.service', 'new.service'] }, captured_at: NOW.toISOString() } },
    });

    await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: () => () => [],
      changeProbeIds: ['fixture.change'],
      runtimeConfig: {
        ...runtimeConfig({ 'change.new_persistence_unit': 'observe' }),
        forbiddenMuteDomains: ['change'],
      },
      now: () => NOW,
    });

    expect(events.queryByKind('drift')).toHaveLength(1);
    expect(events.queryByKind('drift_muted')).toHaveLength(0);
  });

  it('formats drift alerts, sends them through the channel chain, and ledgers delivery success', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 2 }, captured_at: NOW.toISOString() } },
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
      evaluatorFor,
      now: () => NOW,
      sinks: [sink],
    });

    expect(result).toMatchObject({
      driftCount: 1,
      probeErrorCount: 0,
      deliverySucceededCount: 1,
      deliveryFailedCount: 0,
    });
    expect(sink.deliver).toHaveBeenCalledTimes(1);
    expect(events.queryByKind('alert_delivery_succeeded')).toHaveLength(1);
    expect(events.queryByKind('alert_delivery_failed_all')).toHaveLength(0);
  });

  it('suppresses repeated non-critical drift through dedup before delivery', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 2 }, captured_at: NOW.toISOString() } },
    });
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
      sinks: [sink],
    });
    vi.mocked(sink.deliver).mockClear();

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => new Date(NOW.getTime() + 60 * 60 * 1000),
      sinks: [sink],
    });

    expect(result.dedupSuppressedCount).toBe(1);
    expect(result.deliverySucceededCount).toBe(0);
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(events.queryByKind('drift_dedup')[0]?.payload).toMatchObject({
      suppression: 'dedup',
    });
  });

  it('suppresses identical critical alert storms and writes drift_dedup evidence', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 2 }, captured_at: NOW.toISOString() } },
    });
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: criticalEvaluatorFor,
      now: () => NOW,
      sinks: [sink],
    });
    vi.mocked(sink.deliver).mockClear();

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: criticalEvaluatorFor,
      now: () => new Date(NOW.getTime() + 60 * 1000),
      sinks: [sink],
    });

    expect(result.stormSuppressedCount).toBe(1);
    expect(result.deliverySucceededCount).toBe(0);
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(events.queryByKind('drift_dedup').at(-1)?.payload).toMatchObject({
      suppression: 'storm_guard',
    });
  });

  it('ledgers failed delivery attempts and failed-all when every real sink fails', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 2 }, captured_at: NOW.toISOString() } },
    });
    const whatsoup: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: false, channel: 'whatsoup', error: 'down' })),
    };
    const localLog: Sink = {
      name: 'local-log',
      isDurableLog: true,
      deliver: vi.fn(async () => ({ ok: true, channel: 'local-log' })),
    };

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
      sinks: [whatsoup, localLog],
    });

    expect(result).toMatchObject({
      driftCount: 1,
      deliverySucceededCount: 1,
      deliveryFailedCount: 2,
    });
    expect(events.queryByKind('alert_delivery_failed')).toHaveLength(1);
    expect(events.queryByKind('alert_delivery_failed_all')).toHaveLength(1);
    expect(events.queryByKind('alert_delivery_succeeded')[0]?.alerted_to).toBe('local_log');
  });

  it('routes alerting.transport_failed through meta-alert sinks when every primary sink fails', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 2 }, captured_at: NOW.toISOString() } },
    });
    const primary: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: false, channel: 'whatsoup', error: 'down' })),
    };
    const meta: Sink = {
      name: 'meta-test',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'meta-test' })),
    };

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor,
      runtimeConfig: runtimeConfig({ 'alerting.transport_failed': 'meta_alert' }),
      now: () => NOW,
      sinks: [primary],
      metaAlertSinks: [meta],
    });

    expect(result.deliverySucceededCount).toBe(1);
    expect(result.deliveryFailedCount).toBe(2);
    expect(primary.deliver).toHaveBeenCalledOnce();
    expect(meta.deliver).toHaveBeenCalledOnce();
    expect(vi.mocked(meta.deliver).mock.calls[0]?.[0].body).toMatch(/action:\s+meta_alert/u);
    const failedAll = events.queryByKind('alert_delivery_failed_all');
    expect(failedAll).toHaveLength(1);
    expect(events.queryByKind('alert_delivery_succeeded').at(-1)).toMatchObject({
      scope_id: 'scope-a',
      probe_id: 'fixture.ports',
      alerted_to: 'external_push',
      payload: expect.objectContaining({
        source_event_id: failedAll[0]!.id,
        action_result: 'meta_alert',
      }),
    });
  });

  it('appends self_secret_widened when configured secret metadata is unsafe', async () => {
    const { baselines, events, mutes } = setup();
    const secretPath = tempFile('guard-hmac-key');
    chmodSync(secretPath, 0o644);

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
      selfSecrets: [{ path: secretPath, mode: 0o600 }],
    });

    expect(result.selfSecretWidenedCount).toBe(1);
    expect(events.queryByKind('self_secret_widened')[0]).toMatchObject({
      domain: 'credential',
      severity: 'crit',
      payload: {
        path: secretPath,
        expected_mode: 0o600,
        actual_mode: 0o644,
      },
    });
  });

  it('dispatches alerts when self_secret_widened fires', async () => {
    const { baselines, events, mutes } = setup();
    const secretPath = tempFile('guard-hmac-key');
    chmodSync(secretPath, 0o644);
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
      selfSecrets: [{ path: secretPath, mode: 0o600 }],
      sinks: [sink],
    });

    expect(result.selfSecretWidenedCount).toBe(1);
    expect(result.deliverySucceededCount).toBe(1);
    expect(sink.deliver).toHaveBeenCalledOnce();
    expect(vi.mocked(sink.deliver).mock.calls[0]?.[0].body).toContain('self_secret_widened');
    expect(events.queryByKind('alert_delivery_succeeded')[0]).toMatchObject({
      scope_id: 'guard',
      probe_id: 'self_secret_widened',
      alerted_to: 'whatsoup',
    });
  });

  it('refuses the cycle before probes when self_secret_widened fires', async () => {
    const { baselines, events, mutes } = setup();
    const secretPath = tempFile('guard-hmac-key');
    chmodSync(secretPath, 0o644);
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 2 }, captured_at: NOW.toISOString() } },
    });

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
      selfSecrets: [{ path: secretPath, mode: 0o600 }],
    });

    expect(result.driftCount).toBe(0);
    expect(result.probeErrorCount).toBe(0);
    expect(result.heartbeatCount).toBe(0);
    expect(events.queryByKind('drift')).toHaveLength(0);
    expect(events.queryByKind('cycle_refused')[0]).toMatchObject({
      domain: 'alerting',
      severity: 'crit',
      payload: {
        reason: 'self_secret_widened',
        count: 1,
      },
    });
  });

  it('dispatches alerts when baseline integrity verification fails', async () => {
    const { db, baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    db.prepare('UPDATE baseline SET expected_doc = ? WHERE probe_id = ? AND scope_id = ?')
      .run(JSON.stringify({ p: 999 }), 'fixture.ports', 'scope-a');
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 2 }, captured_at: NOW.toISOString() } },
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
      evaluatorFor,
      now: () => NOW,
      sinks: [sink],
    });

    expect(result.deliverySucceededCount).toBe(1);
    expect(result.baselineIntegrityFailCount).toBe(1);
    expect(sink.deliver).toHaveBeenCalledOnce();
    expect(vi.mocked(sink.deliver).mock.calls[0]?.[0].body).toMatch(/action:\s+alert/u);
    expect(events.queryByKind('baseline_integrity_fail')).toHaveLength(1);
    expect(events.queryByKind('alert_delivery_succeeded')[0]).toMatchObject({
      scope_id: 'scope-a',
      probe_id: 'fixture.ports',
      alerted_to: 'whatsoup',
    });
    expect(events.queryByKind('heartbeat')[0]?.payload).toMatchObject({
      baseline_integrity_fail_count: 1,
    });
  });

  it('appends alert_token_aging when token metadata exceeds policy', async () => {
    const { baselines, events, mutes } = setup();
    const tokenPath = tempFile('guard-alert-token');
    const oldTimestampSeconds = (NOW.getTime() - 31 * DAY_MS) / 1000;
    utimesSync(tokenPath, oldTimestampSeconds, oldTimestampSeconds);

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
      tokenAgeChecks: [{ path: tokenPath, maxAgeDays: 30 }],
    });

    expect(result.tokenAgingCount).toBe(1);
    expect(events.queryByKind('alert_token_aging')[0]).toMatchObject({
      domain: 'credential',
      severity: 'high',
      payload: expect.objectContaining({
        path: tokenPath,
        max_age_days: 30,
        age_days: 31,
      }),
    });
  });

  it('honors credential.token_aging observe by ledgering token aging without alert dispatch', async () => {
    const { baselines, events, mutes } = setup();
    const tokenPath = tempFile('guard-alert-token');
    const oldTimestampSeconds = (NOW.getTime() - 31 * DAY_MS) / 1000;
    utimesSync(tokenPath, oldTimestampSeconds, oldTimestampSeconds);
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      runtimeConfig: runtimeConfig({ 'credential.token_aging': 'observe' }),
      now: () => NOW,
      tokenAgeChecks: [{ path: tokenPath, maxAgeDays: 30 }],
      sinks: [sink],
    });

    expect(result.tokenAgingCount).toBe(1);
    expect(result.deliverySucceededCount).toBe(0);
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(events.queryByKind('alert_token_aging')).toHaveLength(1);
    expect(events.queryByKind('alert_delivery_succeeded')).toHaveLength(0);
  });

  it('suppresses token-aging self-protection when the credential domain is disabled', async () => {
    const { baselines, events, mutes } = setup();
    const tokenPath = tempFile('guard-alert-token');
    const oldTimestampSeconds = (NOW.getTime() - 31 * DAY_MS) / 1000;
    utimesSync(tokenPath, oldTimestampSeconds, oldTimestampSeconds);
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      runtimeConfig: {
        ...runtimeConfig({ 'credential.token_aging': 'alert' }),
        enabledDomains: { credential: false },
      },
      now: () => NOW,
      tokenAgeChecks: [{ path: tokenPath, maxAgeDays: 30 }],
      sinks: [sink],
    });

    expect(result).toMatchObject({
      driftCount: 0,
      probeErrorCount: 0,
      deliverySucceededCount: 0,
      deliveryFailedCount: 0,
      tokenAgingCount: 0,
      heartbeatCount: 1,
    });
    expect(result.totalEventCount).toBe(1);
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(events.queryByKind('alert_token_aging')).toHaveLength(0);
    expect(events.queryByKind('alert_delivery_succeeded')).toHaveLength(0);
  });

  it('honors credential.token_aging alert by dispatching through the normal alert chain', async () => {
    const { baselines, events, mutes } = setup();
    const tokenPath = tempFile('guard-alert-token');
    const oldTimestampSeconds = (NOW.getTime() - 31 * DAY_MS) / 1000;
    utimesSync(tokenPath, oldTimestampSeconds, oldTimestampSeconds);
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      runtimeConfig: runtimeConfig({ 'credential.token_aging': 'alert' }),
      now: () => NOW,
      tokenAgeChecks: [{ path: tokenPath, maxAgeDays: 30 }],
      sinks: [sink],
    });

    expect(result.deliverySucceededCount).toBe(1);
    expect(sink.deliver).toHaveBeenCalledOnce();
    expect(vi.mocked(sink.deliver).mock.calls[0]?.[0].body).toMatch(/action:\s+alert/u);
    expect(events.queryByKind('alert_delivery_succeeded')[0]).toMatchObject({
      scope_id: 'guard',
      probe_id: 'alert_token_aging',
      alerted_to: 'whatsoup',
    });
  });

  it('attributes multiple token-aging deliveries to their distinct source events', async () => {
    const { baselines, events, mutes } = setup();
    const firstToken = tempFile('first-guard-alert-token');
    const secondToken = tempFile('second-guard-alert-token');
    const oldTimestampSeconds = (NOW.getTime() - 31 * DAY_MS) / 1000;
    utimesSync(firstToken, oldTimestampSeconds, oldTimestampSeconds);
    utimesSync(secondToken, oldTimestampSeconds, oldTimestampSeconds);
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      runtimeConfig: runtimeConfig({ 'credential.token_aging': 'alert' }),
      now: () => NOW,
      tokenAgeChecks: [
        { path: firstToken, maxAgeDays: 30 },
        { path: secondToken, maxAgeDays: 30 },
      ],
      sinks: [sink],
    });

    const tokenEvents = events.queryByKind('alert_token_aging');
    const deliveries = events.queryByKind('alert_delivery_succeeded');
    expect(tokenEvents).toHaveLength(2);
    expect(deliveries.map((event) => event.payload.source_event_id)).toEqual([
      tokenEvents[0]!.id,
      tokenEvents[1]!.id,
    ]);
    expect(vi.mocked(sink.deliver).mock.calls.map((call) => call[0].body.match(/event-id: (\d+)/u)?.[1])).toEqual([
      String(tokenEvents[0]!.id),
      String(tokenEvents[1]!.id),
    ]);
  });

  it('honors credential.token_aging propose_fix with a remediation_hint to a runbook (no shell command)', async () => {
    // Token rotation has no single deterministic shell command — the operator must
    // pick the right credential surface for the deployment. Per spec §6.5 we still
    // owe the operator follow-up text; we emit `remediation_hint:` instead of
    // `propose_fix:<command>`.
    const { baselines, events, mutes } = setup();
    const tokenPath = tempFile('guard-alert-token');
    const oldTimestampSeconds = (NOW.getTime() - 31 * DAY_MS) / 1000;
    utimesSync(tokenPath, oldTimestampSeconds, oldTimestampSeconds);
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      runtimeConfig: runtimeConfig({ 'credential.token_aging': 'propose_fix' }),
      now: () => NOW,
      tokenAgeChecks: [{ path: tokenPath, maxAgeDays: 30 }],
      sinks: [sink],
    });

    expect(sink.deliver).toHaveBeenCalledOnce();
    const body = vi.mocked(sink.deliver).mock.calls[0]?.[0].body ?? '';
    expect(body).toMatch(/action:\s+propose_fix/u);
    expect(body).not.toMatch(/action:\s+(?:remediate|block)/u);
    // Must carry a remediation_hint pointing at the protection-layer spec.
    const hintLine = body.split('\n').find((line: string) => line.startsWith('remediation_hint:'));
    expect(hintLine).toBeDefined();
    expect(hintLine!).toMatch(/docs\/specs\/2026-05-08-whatsoup-protection-layer-design\.md/u);
    // Must NOT carry a fabricated propose_fix command line.
    expect(body).not.toMatch(/^propose_fix:/m);
  });

  it('honors alerting.self_secret_widened propose_fix with a chmod command for the widened path', async () => {
    // self_secret_widened payload carries `path` and `expected_mode` deterministically,
    // so `chmod <mode> <path>` is a real POSIX command we can safely propose.
    const { baselines, events, mutes } = setup();
    const secretPath = tempFile('guard-hmac-key');
    chmodSync(secretPath, 0o644);
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      runtimeConfig: runtimeConfig({ 'alerting.self_secret_widened': 'propose_fix' }),
      now: () => NOW,
      selfSecrets: [{ path: secretPath, mode: 0o600 }],
      sinks: [sink],
    });

    expect(sink.deliver).toHaveBeenCalledOnce();
    const body = vi.mocked(sink.deliver).mock.calls[0]?.[0].body ?? '';
    expect(body).toMatch(/action:\s+propose_fix/u);
    const proposeLine = body.split('\n').find((line: string) => line.startsWith('propose_fix:'));
    expect(proposeLine).toBeDefined();
    expect(proposeLine!).toMatch(/^propose_fix: chmod 0600 '.+guard-hmac-key'$/u);
    // No remediation_hint when a real fix command is present.
    expect(body).not.toMatch(/^remediation_hint:/m);
  });

  it('honors change.new_application_route propose_fix with a remediation_hint (no auto-fix)', async () => {
    // Accepting a new application route is a baseline-update decision, not a shell
    // command. We emit a hint pointing at the spec instead of inventing a subcommand.
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.change', 'scope-a', { routes: ['/healthz'] });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { routes: ['/healthz', '/admin'] }, captured_at: NOW.toISOString() } },
    });
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: () => () => [],
      changeProbeIds: ['fixture.change'],
      runtimeConfig: runtimeConfig({ 'change.new_application_route': 'propose_fix' }),
      now: () => NOW,
      sinks: [sink],
    });

    expect(sink.deliver).toHaveBeenCalledOnce();
    const body = vi.mocked(sink.deliver).mock.calls[0]?.[0].body ?? '';
    expect(body).toMatch(/action:\s+propose_fix/u);
    expect(body).not.toMatch(/^propose_fix:/m);
    const hintLine = body.split('\n').find((line: string) => line.startsWith('remediation_hint:'));
    expect(hintLine).toBeDefined();
    expect(hintLine!).toMatch(/docs\/specs\/2026-05-08-whatsoup-protection-layer-design\.md/u);
  });

  it('honors change.new_persistence_unit propose_fix with a remediation_hint (no auto-fix)', async () => {
    // Same contract as new_application_route: persistence-unit changes are baseline
    // decisions, not single shell commands.
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.change', 'scope-a', { units: ['svc-a'] });
    const collector = new FixtureCollector({
      id: 'fixture.change',
      docs: { 'scope-a': { fields: { units: ['svc-a', 'svc-b'] }, captured_at: NOW.toISOString() } },
    });
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor: () => () => [],
      changeProbeIds: ['fixture.change'],
      runtimeConfig: runtimeConfig({ 'change.new_persistence_unit': 'propose_fix' }),
      now: () => NOW,
      sinks: [sink],
    });

    expect(sink.deliver).toHaveBeenCalledOnce();
    const body = vi.mocked(sink.deliver).mock.calls[0]?.[0].body ?? '';
    expect(body).toMatch(/action:\s+propose_fix/u);
    expect(body).not.toMatch(/^propose_fix:/m);
    const hintLine = body.split('\n').find((line: string) => line.startsWith('remediation_hint:'));
    expect(hintLine!).toMatch(/docs\/specs\/2026-05-08-whatsoup-protection-layer-design\.md/u);
  });

  it('honors alerting.self_secret_widened observe by refusing without delivery', async () => {
    const { baselines, events, mutes } = setup();
    const secretPath = tempFile('guard-hmac-key');
    chmodSync(secretPath, 0o644);
    const sink: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      runtimeConfig: runtimeConfig({ 'alerting.self_secret_widened': 'observe' }),
      now: () => NOW,
      selfSecrets: [{ path: secretPath, mode: 0o600 }],
      sinks: [sink],
    });

    expect(result.selfSecretWidenedCount).toBe(1);
    expect(result.deliverySucceededCount).toBe(0);
    expect(sink.deliver).not.toHaveBeenCalled();
    expect(events.queryByKind('self_secret_widened')).toHaveLength(1);
    expect(events.queryByKind('cycle_refused')).toHaveLength(1);
  });

  it('honors alerting.self_secret_widened meta_alert by dispatching through meta-alert sinks', async () => {
    const { baselines, events, mutes } = setup();
    const secretPath = tempFile('guard-hmac-key');
    chmodSync(secretPath, 0o644);
    const primary: Sink = {
      name: 'whatsoup',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'whatsoup' })),
    };
    const meta: Sink = {
      name: 'meta-test',
      isDurableLog: false,
      deliver: vi.fn(async () => ({ ok: true, channel: 'meta-test' })),
    };

    const result = await runCycle({
      collectors: [],
      scopes: [],
      baselines,
      events,
      mutes,
      evaluatorFor,
      runtimeConfig: runtimeConfig({ 'alerting.self_secret_widened': 'meta_alert' }),
      now: () => NOW,
      selfSecrets: [{ path: secretPath, mode: 0o600 }],
      sinks: [primary],
      metaAlertSinks: [meta],
    });

    expect(result.deliverySucceededCount).toBe(1);
    expect(primary.deliver).not.toHaveBeenCalled();
    expect(meta.deliver).toHaveBeenCalledOnce();
    expect(events.queryByKind('alert_delivery_succeeded')[0]).toMatchObject({
      alerted_to: 'external_push',
      payload: expect.objectContaining({ action_result: 'meta_alert' }),
    });
  });

  it('honors alerting.baseline_integrity_fail alert and counts delivery as actionable', async () => {
    const { db, baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    db.prepare('UPDATE baseline SET expected_doc = ? WHERE probe_id = ? AND scope_id = ?')
      .run(JSON.stringify({ p: 999 }), 'fixture.ports', 'scope-a');
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 2 }, captured_at: NOW.toISOString() } },
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
      evaluatorFor,
      runtimeConfig: runtimeConfig({ 'alerting.baseline_integrity_fail': 'alert' }),
      now: () => NOW,
      sinks: [sink],
    });

    expect(result.deliverySucceededCount).toBe(1);
    expect(sink.deliver).toHaveBeenCalledOnce();
    expect(vi.mocked(sink.deliver).mock.calls[0]?.[0].body).toMatch(/action:\s+alert/u);
    expect(events.queryByKind('alert_delivery_succeeded')[0]?.payload).toMatchObject({
      action_result: 'alert',
    });
  });

  it('counts clean collector results without creating events', async () => {
    const { baselines, events, mutes } = setup();
    baseline(baselines, 'fixture.ports', 'scope-a', { p: 1 });
    const collector = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields: { p: 1 }, captured_at: NOW.toISOString() } },
    });

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-a'],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
    });

    expect(result).toEqual({
      driftCount: 0,
      probeErrorCount: 0,
      totalEventCount: 1,
      deliverySucceededCount: 0,
      deliveryFailedCount: 0,
      dedupSuppressedCount: 0,
      stormSuppressedCount: 0,
      baselineIntegrityFailCount: 0,
      selfSecretWidenedCount: 0,
      tokenAgingCount: 0,
      heartbeatCount: 1,
    });
    expect(events.queryByKind('drift')).toHaveLength(0);
  });

  it('counts probe errors distinctly from drift', async () => {
    const { baselines, events, mutes } = setup();
    const collector = new FixtureCollector({ id: 'fixture.ports', docs: {} });

    const result = await runCycle({
      collectors: [collector],
      scopes: ['scope-missing'],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
    });

    expect(result).toEqual({
      driftCount: 0,
      probeErrorCount: 1,
      totalEventCount: 2,
      deliverySucceededCount: 0,
      deliveryFailedCount: 0,
      dedupSuppressedCount: 0,
      stormSuppressedCount: 0,
      baselineIntegrityFailCount: 0,
      selfSecretWidenedCount: 0,
      tokenAgingCount: 0,
      heartbeatCount: 1,
    });
    expect(events.queryByKind('probe_error')).toHaveLength(1);
    expect(events.queryByKind('drift')).toHaveLength(0);
  });

  it('runs the collector and scope cross-product deterministically', async () => {
    const { baselines, events, mutes } = setup();
    for (const probeId of ['fixture.a', 'fixture.b']) {
      for (const scopeId of ['scope-a', 'scope-b']) {
        baseline(baselines, probeId, scopeId, { value: 1 });
      }
    }
    const collectors = [
      new FixtureCollector({
        id: 'fixture.a',
        docs: {
          'scope-a': { fields: { value: 2 }, captured_at: NOW.toISOString() },
          'scope-b': { fields: { value: 2 }, captured_at: NOW.toISOString() },
        },
      }),
      new FixtureCollector({
        id: 'fixture.b',
        docs: {
          'scope-a': { fields: { value: 2 }, captured_at: NOW.toISOString() },
          'scope-b': { fields: { value: 2 }, captured_at: NOW.toISOString() },
        },
      }),
    ];

    const result = await runCycle({
      collectors,
      scopes: ['scope-a', 'scope-b'],
      baselines,
      events,
      mutes,
      evaluatorFor,
      now: () => NOW,
    });

    expect(result).toEqual({
      driftCount: 4,
      probeErrorCount: 0,
      totalEventCount: 5,
      deliverySucceededCount: 0,
      deliveryFailedCount: 0,
      dedupSuppressedCount: 0,
      stormSuppressedCount: 0,
      baselineIntegrityFailCount: 0,
      selfSecretWidenedCount: 0,
      tokenAgingCount: 0,
      heartbeatCount: 1,
    });
    expect(events.queryByKind('drift').map((event) => `${event.probe_id}:${event.scope_id}`)).toEqual([
      'fixture.a:scope-a',
      'fixture.a:scope-b',
      'fixture.b:scope-a',
      'fixture.b:scope-b',
    ]);
  });
});
