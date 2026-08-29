/**
 * Opaque account-identity digest: the ONE canonicalization shared by the
 * operator capture script and the runtime verifier. A raw identifier never
 * crosses this boundary in either direction.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  accountIdentityDigestPrefix,
  computeAccountIdentityDigest,
  isAccountIdentityDigest,
} from '../../src/lib/account-identity-digest.ts';

const EMAIL = 'Owner.Example@Example.test';
const ORG_ID = '0F0E0D0C-0B0A-4998-8776-655443322110';

describe('computeAccountIdentityDigest', () => {
  it('produces a self-describing sha256 digest', () => {
    const digest = computeAccountIdentityDigest({ email: EMAIL, orgId: ORG_ID });
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(isAccountIdentityDigest(digest)).toBe(true);
  });

  it('is deterministic and canonicalizes case and surrounding whitespace', () => {
    const a = computeAccountIdentityDigest({ email: EMAIL, orgId: ORG_ID });
    const b = computeAccountIdentityDigest({ email: `  ${EMAIL.toLowerCase()} `, orgId: ORG_ID.toLowerCase() });
    expect(a).toBe(b);
  });

  it('binds BOTH the account and the organization (a different org is a different identity)', () => {
    const base = computeAccountIdentityDigest({ email: EMAIL, orgId: ORG_ID });
    const otherOrg = computeAccountIdentityDigest({ email: EMAIL, orgId: '11111111-2222-4333-8444-555555555555' });
    const otherAccount = computeAccountIdentityDigest({ email: 'someone.else@example.test', orgId: ORG_ID });
    expect(otherOrg).not.toBe(base);
    expect(otherAccount).not.toBe(base);
  });

  it('is not a bare digest of either field (domain-separated canonical input)', () => {
    const digest = computeAccountIdentityDigest({ email: EMAIL, orgId: ORG_ID });
    const bareEmail = `sha256:${createHash('sha256').update(EMAIL.toLowerCase()).digest('hex')}`;
    const bareOrg = `sha256:${createHash('sha256').update(ORG_ID.toLowerCase()).digest('hex')}`;
    expect(digest).not.toBe(bareEmail);
    expect(digest).not.toBe(bareOrg);
  });

  it('refuses an empty account or organization field (no digest of nothing)', () => {
    expect(() => computeAccountIdentityDigest({ email: '   ', orgId: ORG_ID })).toThrow(/email/);
    expect(() => computeAccountIdentityDigest({ email: EMAIL, orgId: '' })).toThrow(/orgId/);
  });

  it('never embeds the raw identifier in the digest', () => {
    const digest = computeAccountIdentityDigest({ email: EMAIL, orgId: ORG_ID });
    expect(digest.toLowerCase()).not.toContain(EMAIL.toLowerCase());
    expect(digest.toLowerCase()).not.toContain(ORG_ID.toLowerCase());
  });

  it('refuses control characters in either field, keeping the `\\n`-joined canonical input injective', () => {
    // Without this refusal, {email: 'a@x\norg-b', orgId: 'org-c'} and
    // {email: 'a@x', orgId: 'org-b\norg-c'} share one canonical string.
    expect(() => computeAccountIdentityDigest({ email: 'a@x\norg-b', orgId: ORG_ID })).toThrow(/email/);
    expect(() => computeAccountIdentityDigest({ email: EMAIL, orgId: 'org-b\norg-c' })).toThrow(/orgId/);
    expect(() => computeAccountIdentityDigest({ email: 'a\u0009b@x', orgId: ORG_ID })).toThrow(/email/);
    expect(() => computeAccountIdentityDigest({ email: EMAIL, orgId: `${ORG_ID}\r` })).toThrow(/orgId/);
    // the refusal is content-free: the message never echoes the value
    let message = '';
    try {
      computeAccountIdentityDigest({ email: 'smuggle-probe@x\norg-b', orgId: ORG_ID });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('smuggle-probe');
  });
});

describe('isAccountIdentityDigest', () => {
  it('accepts only the sha256:<64 lowercase hex> shape', () => {
    expect(isAccountIdentityDigest(`sha256:${'a'.repeat(64)}`)).toBe(true);
    for (const bad of [
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
      `sha256:${'a'.repeat(65)}`,
      'a'.repeat(64),
      `md5:${'a'.repeat(32)}`,
      ` sha256:${'a'.repeat(64)}`,
      EMAIL,
      42,
      null,
      undefined,
      {},
    ]) {
      expect(isAccountIdentityDigest(bad), String(bad)).toBe(false);
    }
  });
});

describe('accountIdentityDigestPrefix', () => {
  it('returns a bounded 12-hex correlation prefix, never the full digest', () => {
    const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;
    expect(accountIdentityDigestPrefix(digest)).toBe('0123456789ab');
    expect(accountIdentityDigestPrefix(null)).toBeNull();
  });
});
