import { describe, expect, it } from 'vitest';

import {
  createLifecycleDigester,
  digestsMatch,
  encodeLifecycleTuple,
  parseLifecycleDigest,
} from '../../../src/core/observability/lifecycle-digest.ts';

const KEY_1 = Buffer.from('0'.repeat(64), 'hex');
const KEY_2 = Buffer.from('1'.repeat(64), 'hex');

describe('lifecycle keyed digests (FLOS Contract H / F10)', () => {
  it('produces a versioned, keyed, domain-separated digest', () => {
    const digester = createLifecycleDigester({ keyId: 'k1', secret: KEY_1 });

    const scope = digester.digest('scope', 'instance-alpha|L-INT|chat-1');
    const condition = digester.digest('condition', 'instance-alpha|L-INT|chat-1');

    expect(scope).toMatch(/^k1:[0-9a-f]{64}$/);
    // Same value under a different domain must not collide (domain separation).
    expect(condition).not.toBe(scope);
    // Deterministic under the same key.
    expect(digester.digest('scope', 'instance-alpha|L-INT|chat-1')).toBe(scope);
  });

  it('is not publicly derivable: a different key changes every digest', () => {
    const a = createLifecycleDigester({ keyId: 'k1', secret: KEY_1 });
    const b = createLifecycleDigester({ keyId: 'k1', secret: KEY_2 });

    expect(a.digest('scope', 'same-value')).not.toBe(b.digest('scope', 'same-value'));
  });

  it('rejects an empty or unversioned key id and an empty secret', () => {
    expect(() => createLifecycleDigester({ keyId: '', secret: KEY_1 })).toThrow();
    expect(() => createLifecycleDigester({ keyId: 'k1:', secret: KEY_1 })).toThrow();
    expect(() => createLifecycleDigester({ keyId: 'k1', secret: Buffer.alloc(0) })).toThrow();
  });

  it('accepts only Buffer key material (one canonical encoding, so two writers cannot split identity)', () => {
    // A hex string and its decoded bytes are the SAME provisioned key; if the
    // primitive silently UTF-8-encoded the string, host A (string) and host B
    // (Buffer) would emit different digests under the same key id and
    // joinable() would report both as joinable. Refuse the ambiguity here.
    expect(() =>
      createLifecycleDigester({ keyId: 'k1', secret: '0'.repeat(64) as unknown as Buffer }),
    ).toThrow(/Buffer/);
    expect(() =>
      createLifecycleDigester({
        keyId: 'k2',
        secret: KEY_2,
        previous: { keyId: 'k1', secret: '0'.repeat(64) as unknown as Buffer },
      }),
    ).toThrow(/Buffer/);
  });

  it('dual-emits during rotation and matches identity on either key', () => {
    const rotating = createLifecycleDigester({
      keyId: 'k2',
      secret: KEY_2,
      previous: { keyId: 'k1', secret: KEY_1 },
    });
    const old = createLifecycleDigester({ keyId: 'k1', secret: KEY_1 });

    const pair = rotating.digestPair('condition', 'instance-alpha|L-SCH|job-7');
    expect(pair.current).toMatch(/^k2:/);
    expect(pair.previous).toBe(old.digest('condition', 'instance-alpha|L-SCH|job-7'));

    // An open condition recorded under k1 keeps its identity when a k2 writer sees it.
    expect(digestsMatch(pair, old.digest('condition', 'instance-alpha|L-SCH|job-7'))).toBe(true);
    expect(digestsMatch(pair, old.digest('condition', 'instance-alpha|L-SCH|job-8'))).toBe(false);
  });

  it('treats an unknown key id as unjoinable, never as a new identity', () => {
    const digester = createLifecycleDigester({ keyId: 'k1', secret: KEY_1 });
    const foreign = 'k9:' + 'a'.repeat(64);

    expect(parseLifecycleDigest(foreign)).toEqual({ keyId: 'k9', hex: 'a'.repeat(64) });
    expect(digester.joinable(foreign)).toBe(false);
    expect(digester.joinable(digester.digest('scope', 'x'))).toBe(true);
    expect(parseLifecycleDigest('not-a-digest')).toBeNull();
    expect(parseLifecycleDigest('k1:zz')).toBeNull();
  });

  it('never emits the raw value or the secret in the digest string', () => {
    const digester = createLifecycleDigester({ keyId: 'k1', secret: KEY_1 });
    const out = digester.digest('evidence', 'raw-correlation-identifier-0001');
    expect(out).not.toContain('raw-correlation-identifier-0001');
    expect(out).not.toContain(KEY_1.toString('hex'));
  });
});

describe('lifecycle identity tuples (design F13/F15: scope = (instance, lane, class, scope))', () => {
  it('encodes a tuple canonically so separator choice and separator-bearing parts cannot collide', () => {
    const a = encodeLifecycleTuple(['instance-alpha', 'L-INT', 'chat-1']);
    expect(encodeLifecycleTuple(['instance-alpha', 'L-INT', 'chat-1'])).toBe(a);
    // The classic split/join ambiguity: ('a|b','c') vs ('a','b|c').
    expect(encodeLifecycleTuple(['a|b', 'c'])).not.toBe(encodeLifecycleTuple(['a', 'b|c']));
    expect(encodeLifecycleTuple(['a/b', 'c'])).not.toBe(encodeLifecycleTuple(['a', 'b/c']));
    // Arity is part of identity.
    expect(encodeLifecycleTuple(['a', ''])).not.toBe(encodeLifecycleTuple(['a']));
  });

  it('rejects an empty tuple and non-string parts', () => {
    expect(() => encodeLifecycleTuple([])).toThrow();
    expect(() => encodeLifecycleTuple(['a', 1 as unknown as string])).toThrow();
  });

  it('digests a tuple exactly as its canonical encoding, in both digest and digestPair', () => {
    const digester = createLifecycleDigester({
      keyId: 'k2',
      secret: KEY_2,
      previous: { keyId: 'k1', secret: KEY_1 },
    });
    const parts = ['instance-alpha', 'L-SCH', 'V1', 'job-7'] as const;
    const encoded = encodeLifecycleTuple(parts);

    expect(digester.digest('scope', parts)).toBe(digester.digest('scope', encoded));
    expect(digester.digestPair('condition', parts)).toEqual(digester.digestPair('condition', encoded));
    // Two emitters that agree on the tuple agree on the digest without agreeing on a separator.
    expect(digester.digest('scope', parts)).not.toBe(digester.digest('scope', parts.join('|')));
  });
});
