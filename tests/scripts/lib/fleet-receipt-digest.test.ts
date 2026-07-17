import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ReceiptDigestError,
  receiptCapabilityDigest,
  receiptCapabilityIdentity,
} from '../../../scripts/lib/fleet-receipt-digest.ts';
import { pyJsonStringify } from '../../../scripts/lib/fleet-roster-inventory.ts';

/**
 * Capability-identity projection + digest for a committed runtime receipt
 * (#1867 criterion 1, guard-side half; design §4/§6/§7.2 of
 * `1867-runtime-proof-producer-design.md`). This is the receipt-capture
 * producer's contract: whatever later Python producer writes a receipt file
 * must produce a JSON object with at least these fields, of these types --
 * `commit` (string), `schemaMigration` (non-negative integer), `provider`
 * (string), `modelUsabilityStatus` (string), `fallbackChain` (array of
 * `{ provider, model, eligible }`), and `driftCheck.ok` (boolean) -- and the
 * digest is `sha256(pyJsonStringify(projection))` over *only* those fields,
 * matching `fleet-roster-inventory.ts`'s `roster_identity`/`roster_digest`
 * pattern exactly (hash a normalized projection, not the raw bundle).
 */
function makeReceiptFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commit: 'a'.repeat(40),
    schemaMigration: 44,
    provider: 'claude-cli',
    modelUsabilityStatus: 'usable',
    fallbackChain: [
      { provider: 'openai', model: 'gpt-fallback', eligible: true, turnCount: 3 },
    ],
    driftCheck: { ok: true, releasePath: 'ignored-volatile-field' },
    // Volatile fields (design §4): must be carried but NOT hashed.
    generatedAt: '2026-06-18T00:00:00Z',
    uptimeSeconds: 12345,
    lastProbeAt: '2026-06-18T00:00:00Z',
    ...overrides,
  };
}

describe('fleet-receipt-digest (#1867 criterion 1, capability-identity projection)', () => {
  it('produces a stable digest across repeated calls for the same identity-relevant input', () => {
    const receipt = makeReceiptFixture();
    expect(receiptCapabilityDigest(receipt)).toBe(receiptCapabilityDigest(receipt));
  });

  it('produces the same digest when only a volatile field changes (uptime, timestamps, turn counters)', () => {
    const base = makeReceiptFixture();
    const touched = makeReceiptFixture({
      generatedAt: '2027-01-01T00:00:00Z',
      uptimeSeconds: 999999,
      lastProbeAt: '2027-01-01T00:00:00Z',
      fallbackChain: [
        { provider: 'openai', model: 'gpt-fallback', eligible: true, turnCount: 9999 },
      ],
    });

    expect(receiptCapabilityDigest(touched)).toBe(receiptCapabilityDigest(base));
  });

  it('changes the digest when the commit (identity field) changes', () => {
    const base = makeReceiptFixture();
    const changed = makeReceiptFixture({ commit: 'b'.repeat(40) });

    expect(receiptCapabilityDigest(changed)).not.toBe(receiptCapabilityDigest(base));
  });

  it('changes the digest when schemaMigration (identity field) changes', () => {
    const base = makeReceiptFixture();
    const changed = makeReceiptFixture({ schemaMigration: 45 });

    expect(receiptCapabilityDigest(changed)).not.toBe(receiptCapabilityDigest(base));
  });

  it('changes the digest when provider (identity field) changes', () => {
    const base = makeReceiptFixture();
    const changed = makeReceiptFixture({ provider: 'openai-cli' });

    expect(receiptCapabilityDigest(changed)).not.toBe(receiptCapabilityDigest(base));
  });

  it('changes the digest when modelUsabilityStatus (identity field) changes', () => {
    const base = makeReceiptFixture();
    const changed = makeReceiptFixture({ modelUsabilityStatus: 'unusable' });

    expect(receiptCapabilityDigest(changed)).not.toBe(receiptCapabilityDigest(base));
  });

  it('changes the digest when a fallback chain entry provider/model/eligible changes', () => {
    const base = makeReceiptFixture();
    const changed = makeReceiptFixture({
      fallbackChain: [{ provider: 'openai', model: 'gpt-fallback', eligible: false, turnCount: 3 }],
    });

    expect(receiptCapabilityDigest(changed)).not.toBe(receiptCapabilityDigest(base));
  });

  it('changes the digest when the drift-check ok boolean changes', () => {
    const base = makeReceiptFixture();
    const changed = makeReceiptFixture({ driftCheck: { ok: false, releasePath: 'ignored-volatile-field' } });

    expect(receiptCapabilityDigest(changed)).not.toBe(receiptCapabilityDigest(base));
  });

  it('throws ReceiptDigestError when the receipt is not an object', () => {
    expect(() => receiptCapabilityIdentity('not-an-object')).toThrow(ReceiptDigestError);
    expect(() => receiptCapabilityIdentity(null)).toThrow(ReceiptDigestError);
    expect(() => receiptCapabilityIdentity([])).toThrow(ReceiptDigestError);
  });

  it('throws ReceiptDigestError when an identity field is missing or ill-typed', () => {
    expect(() => receiptCapabilityIdentity(makeReceiptFixture({ commit: 123 }))).toThrow(ReceiptDigestError);
    expect(() => receiptCapabilityIdentity(makeReceiptFixture({ commit: undefined }))).toThrow(ReceiptDigestError);
    expect(() => receiptCapabilityIdentity(makeReceiptFixture({ schemaMigration: 'not-a-number' }))).toThrow(ReceiptDigestError);
    expect(() => receiptCapabilityIdentity(makeReceiptFixture({ schemaMigration: -1 }))).toThrow(ReceiptDigestError);
    expect(() => receiptCapabilityIdentity(makeReceiptFixture({ provider: '' }))).toThrow(ReceiptDigestError);
    expect(() => receiptCapabilityIdentity(makeReceiptFixture({ modelUsabilityStatus: undefined }))).toThrow(ReceiptDigestError);
    expect(() => receiptCapabilityIdentity(makeReceiptFixture({ fallbackChain: 'not-an-array' }))).toThrow(ReceiptDigestError);
    expect(() => receiptCapabilityIdentity(makeReceiptFixture({
      fallbackChain: [{ provider: 'openai', model: 'x' }],
    }))).toThrow(ReceiptDigestError);
    expect(() => receiptCapabilityIdentity(makeReceiptFixture({ driftCheck: { ok: 'yes' } }))).toThrow(ReceiptDigestError);
    expect(() => receiptCapabilityIdentity(makeReceiptFixture({ driftCheck: undefined }))).toThrow(ReceiptDigestError);
  });

  it('returns exactly the identity-tagged projection fields (no volatile leakage) from receiptCapabilityIdentity', () => {
    const identity = receiptCapabilityIdentity(makeReceiptFixture());

    expect(identity).toEqual({
      commit: 'a'.repeat(40),
      schemaMigration: 44,
      provider: 'claude-cli',
      modelUsabilityStatus: 'usable',
      fallbackChain: [{ provider: 'openai', model: 'gpt-fallback', eligible: true }],
      driftOk: true,
    });
  });

  it('matches sha256(pyJsonStringify(projection)) computed independently in this test (self-consistency of the call shape)', () => {
    const receipt = makeReceiptFixture();
    const identity = receiptCapabilityIdentity(receipt);
    const expected = createHash('sha256').update(Buffer.from(pyJsonStringify(identity), 'utf8')).digest('hex');

    expect(receiptCapabilityDigest(receipt)).toBe(expected);
  });

  it('matches a Python sha256(json.dumps(projection, sort_keys=True, separators=(",",":"))) computation (byte-identical contract for the future producer)', () => {
    const receipt = makeReceiptFixture();
    const identity = receiptCapabilityIdentity(receipt);

    const pythonDigest = execFileSync('python3', ['-c', `
import sys, json, hashlib
projection = json.loads(sys.stdin.read())
material = json.dumps(projection, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
sys.stdout.write(hashlib.sha256(material.encode("utf-8")).hexdigest())
`], { input: JSON.stringify(identity), encoding: 'utf8' }).trim();

    expect(receiptCapabilityDigest(receipt)).toBe(pythonDigest);
  });
});
