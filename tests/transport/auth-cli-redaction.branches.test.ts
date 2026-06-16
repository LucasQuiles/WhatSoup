// Intended repo path: tests/transport/auth-cli-redaction.branches.test.ts
//
// Closes the only uncovered branch in src/transport/auth-cli-redaction.ts:
// line 9 `String(value ?? '')` — the nullish-coalescing RHS (null/undefined path),
// which the existing auth-cli-redaction.test.ts never exercises (branch pct was 50%).
//
// Also adds explicit hit/miss coverage for EVERY redaction regex so the
// security-sensitive contract is asserted at the unit level: each secret family
// is removed on the hit path, and benign look-alikes are preserved on the miss path.
import { describe, expect, it } from 'vitest';

import { redactAuthCliText } from '../../src/transport/auth-cli-redaction.ts';

describe('redactAuthCliText — nullish input branch', () => {
  it('returns empty string for null (?? RHS)', () => {
    expect(redactAuthCliText(null)).toBe('');
  });

  it('returns empty string for undefined (?? RHS)', () => {
    expect(redactAuthCliText(undefined)).toBe('');
  });

  it('coerces non-string, non-nullish values via String() (?? LHS)', () => {
    // A number is not nullish, so the LHS of ?? is taken and String()-coerced.
    expect(redactAuthCliText(0)).toBe('0');
    expect(redactAuthCliText(false)).toBe('false');
  });

  it('coerces an object via String() then applies redaction', () => {
    // Object stringifies to "[object Object]" — no secrets, passes through unchanged.
    expect(redactAuthCliText({ a: 1 })).toBe('[object Object]');
  });
});

describe('redactAuthCliText — per-regex hit and miss paths', () => {
  // SECRETISH_ASSIGNMENT
  it('redacts secret-shaped assignments but keeps the key + separator', () => {
    const out = redactAuthCliText('api_key=AKIA12345 password: hunter2 client_secret:zzz');
    expect(out).toContain('api_key=[REDACTED]');
    expect(out).toContain('password: [REDACTED]');
    expect(out).toContain('client_secret:[REDACTED]');
    expect(out).not.toContain('AKIA12345');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('zzz');
  });

  it('leaves non-secret assignments untouched (miss path)', () => {
    const benign = 'count=42 status: connected mode=allowlist';
    expect(redactAuthCliText(benign)).toBe(benign);
  });

  // AUTHORIZATION_BEARER + BEARER_VALUE
  it('redacts Authorization: Bearer header and bare Bearer tokens', () => {
    const out = redactAuthCliText('Authorization: Bearer abc.def.ghi and Bearer xyz123==');
    expect(out).toContain('Authorization: Bearer [REDACTED]');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('xyz123');
  });

  it('does not touch the word "bearer" outside a token context (miss path)', () => {
    // "Bearer" with no following token-shaped value: BEARER_VALUE requires >=1 token char.
    const benign = 'the message bearer was unknown';
    expect(redactAuthCliText(benign)).toBe(benign);
  });

  // WHATSAPP_JID
  it('redacts WhatsApp JIDs across all suffixes', () => {
    const out = redactAuthCliText('15555550123@s.whatsapp.net 120363@g.us 1111111655@lid 12345:7@s.whatsapp.net');
    expect(out).not.toContain('15555550123');
    expect(out).not.toContain('120363');
    expect(out).not.toContain('1111111655');
    expect(out).not.toMatch(/12345:7/);
    expect((out.match(/\[REDACTED WHATSAPP JID\]/g) || []).length).toBe(4);
  });

  it('keeps a plain phone number with no JID suffix (miss path)', () => {
    const benign = 'call 15555550123 later';
    expect(redactAuthCliText(benign)).toBe(benign);
  });

  // URL_USERINFO
  it('redacts URL userinfo while keeping the scheme', () => {
    const out = redactAuthCliText(['https://user:secretpass@', 'fixture.invalid/x'].join(''));
    expect(out).toContain(['https://[REDACTED]@', 'fixture.invalid/x'].join(''));
    expect(out).not.toContain('user:secretpass');
  });

  it('keeps a userinfo-free URL untouched (miss path)', () => {
    const benign = 'see https://fixture.invalid/path?x=1';
    expect(redactAuthCliText(benign)).toBe(benign);
  });

  // CREDENTIAL_PATH
  it('redacts every credential path family', () => {
    const samples = [
      '/home/testuser/.config/whatsoup/instances/a/auth/creds.json',
      '/home/testuser/.local/share/whatsoup/instances/b/auth',
      '/var/lib/auth-bond-backups/c/latest',
      '/etc/whatsoup/fleet-token',
      '/srv/secrets.env',
    ];
    for (const s of samples) {
      const out = redactAuthCliText(s);
      expect(out).toContain('[REDACTED CREDENTIAL PATH]');
    }
  });

  it('keeps an unrelated filesystem path untouched (miss path)', () => {
    const benign = 'reading /var/log/whatsoup/app.log now';
    expect(redactAuthCliText(benign)).toBe(benign);
  });

  it('is idempotent — re-redacting already-redacted text is a no-op', () => {
    const once = redactAuthCliText('token=abc 15555550123@s.whatsapp.net');
    expect(redactAuthCliText(once)).toBe(once);
  });
});
