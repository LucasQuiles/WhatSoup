import { describe, expect, it } from 'vitest';
import { parseBoundaryJsonBytes } from '../../scripts/lib/verification/boundary-run/schema.ts';

const configurationPolicy = { allowCarriageReturns: true, allowNegativeZero: true, rejectNonFiniteNumbers: true };

describe('configuration JSON parsing through the shared boundary scanner', () => {
  it.each(['1e999', '-1e999'])('rejects overflowing configuration numbers: %s', (literal) => {
    const bytes = Buffer.from(`{"host":{"unused":[${literal}]}}`);
    expect(parseBoundaryJsonBytes(bytes, configurationPolicy).result.ok).toBe(false);
    expect(parseBoundaryJsonBytes(bytes).result.ok).toBe(true);
  });

  it('allows ordinary JSON whitespace and negative zero only with explicit policy', () => {
    const bytes = Buffer.from('{\r\n"offset":-0\r\n}');
    const parsed = parseBoundaryJsonBytes(bytes, configurationPolicy);
    expect(parsed.result.ok).toBe(true);
    expect(parsed.value).toEqual({ offset: -0 });
    expect(parsed.text).toBe(bytes.toString('utf8'));
    expect(parseBoundaryJsonBytes(bytes).result.ok).toBe(false);
    expect(parseBoundaryJsonBytes(Buffer.from('{"offset":-0}')).result.ok).toBe(false);
  });

  it.each([
    '{"key":1,"key":2}',
    '{"outer":[{"key":1,"\\u006bey":2}]}',
    '{"outer":{"nested":{"a":1,"a":null}}}',
  ])('still rejects duplicate keys with configuration policy: %s', (text) => {
    const parsed = parseBoundaryJsonBytes(Buffer.from(text), configurationPolicy);
    expect(parsed.result.ok).toBe(false);
    expect(parsed.result.issues[0]?.code).toBe('duplicate-json-key');
    expect(parsed.value).toBeNull();
  });

  it.each([
    Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
    Buffer.from([0x7b, 0x22, 0xc3, 0x22, 0x3a, 0x31, 0x7d]),
    Buffer.from('{"key":"raw\rcarriage"}'),
    Buffer.from('{"key":1} true'),
  ])('keeps invalid bytes and syntax ineligible', (bytes) => {
    const parsed = parseBoundaryJsonBytes(bytes, configurationPolicy);
    expect(parsed.result.ok).toBe(false);
    expect(parsed.value).toBeNull();
    expect(parsed.text).toBeNull();
  });

  it('treats identical names in separate objects as distinct keys', () => {
    const text = '{"hosts":[{"name":"one"},{"name":"two"}]}';
    const parsed = parseBoundaryJsonBytes(Buffer.from(text), configurationPolicy);
    expect(parsed.result.ok).toBe(true);
    expect(parsed.value).toEqual({ hosts: [{ name: 'one' }, { name: 'two' }] });
  });
});
