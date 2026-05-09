import { describe, expect, it } from 'vitest';
import { FixtureCollector } from '../../src/collector/fixture.ts';

const PROVIDED_CAPTURED_AT = '2026-05-08T10:00:00.000Z';

function expectValidIsoTimestamp(value: string): void {
  expect(new Date(value).toISOString()).toBe(value);
}

describe('FixtureCollector', () => {
  it('returns the configured ProbeDoc with provided deterministic captured_at', async () => {
    const c = new FixtureCollector({
      id: 'fixture.ports',
      docs: {
        'scope-a': {
          fields: { ports: [80, 443] },
          captured_at: PROVIDED_CAPTURED_AT,
        },
      },
    });

    const doc = await c.run('scope-a');

    expect(doc).toEqual({
      probe_id: 'fixture.ports',
      scope_id: 'scope-a',
      captured_at: PROVIDED_CAPTURED_AT,
      fields: { ports: [80, 443] },
    });
  });

  it('uses a deterministic default captured_at when the fixture omits one', async () => {
    const c = new FixtureCollector({
      id: 'fixture.health',
      docs: { 'scope-a': { fields: { ok: true } } },
    });

    const doc = await c.run('scope-a');

    expect(doc.captured_at).toBe('1970-01-01T00:00:00.000Z');
    expectValidIsoTimestamp(doc.captured_at);
  });

  it('schema-validates fixture docs before returning them', () => {
    expect(() => new FixtureCollector({
      id: 'fixture.invalid',
      docs: {
        'scope-a': {
          fields: { ok: true },
          captured_at: 'not-an-iso-timestamp',
        },
      },
    })).toThrow(/fixture collector options invalid/);
  });

  it('throws a probe-error-style error for unknown scope', async () => {
    const c = new FixtureCollector({ id: 'fixture.x', docs: {} });

    await expect(c.run('scope-missing')).rejects.toThrow(/probe_error.*no fixture/);
    await expect(c.run('scope-missing')).rejects.toMatchObject({
      name: 'CollectorProbeError',
      kind: 'probe_error',
      collector_id: 'fixture.x',
      scope_id: 'scope-missing',
    });
  });

  it('returns docs that are not mutable aliases of fixture input', async () => {
    const fields = { ports: [80, 443] };
    const c = new FixtureCollector({
      id: 'fixture.ports',
      docs: { 'scope-a': { fields, captured_at: PROVIDED_CAPTURED_AT } },
    });

    const doc = await c.run('scope-a');
    const returnedPorts = doc.fields.ports as number[];
    returnedPorts.push(8080);

    expect(fields).toEqual({ ports: [80, 443] });
    expect(await c.run('scope-a')).toEqual({
      probe_id: 'fixture.ports',
      scope_id: 'scope-a',
      captured_at: PROVIDED_CAPTURED_AT,
      fields: { ports: [80, 443] },
    });
  });
});
