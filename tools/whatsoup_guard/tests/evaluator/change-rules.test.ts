import { describe, expect, it } from 'vitest';
import { changeRule } from '../../src/evaluator/change-rules.ts';
import type { ProbeDoc } from '../../src/types.ts';

function doc(fields: Record<string, unknown>, probeId = 'fixture.change'): ProbeDoc {
  return {
    probe_id: probeId,
    scope_id: 'scope-a',
    captured_at: '2026-05-09T10:00:00.000Z',
    fields,
  };
}

describe('changeRule', () => {
  it('emits change-domain drift when a probe shows a new persistence unit', () => {
    const events = changeRule({
      observed: doc({ units: ['existing.service', 'new.service'] }),
      baseline: doc({ units: ['existing.service'] }),
      severity: 'high',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'drift',
      domain: 'change',
      severity: 'high',
      payload: {
        action: 'alert',
        reason_code: 'change.new_persistence_unit',
        diff: { added: ['new.service'], removed: [], changed: {} },
      },
    });
    expect(events[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits change-domain drift on a new application route', () => {
    const events = changeRule({
      observed: doc({ routes: ['/healthz', '/admin'] }, 'fixture.routes'),
      baseline: doc({ routes: ['/healthz'] }, 'fixture.routes'),
      severity: 'med',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'drift',
      domain: 'change',
      severity: 'med',
      payload: {
        action: 'alert',
        reason_code: 'change.new_application_route',
        diff: { added: ['/admin'], removed: [], changed: {} },
      },
    });
  });

  it('emits no change drift when relevant fields are unchanged', () => {
    const events = changeRule({
      observed: doc({ units: ['existing.service'], routes: ['/healthz'] }),
      baseline: doc({ units: ['existing.service'], routes: ['/healthz'] }),
      severity: 'high',
    });

    expect(events).toEqual([]);
  });
});
