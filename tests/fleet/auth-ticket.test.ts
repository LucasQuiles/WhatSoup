// tests/fleet/auth-ticket.test.ts
//
// Cover the audience-scoped ticket store in `src/fleet/auth-ticket.ts`:
//  - issue+redeem per audience (api/sse/ws)
//  - cross-audience replay rejected (api ticket cannot pass as sse, etc.)
//  - replay (redeem twice) rejected on second attempt
//  - expiry rejected
//  - HMAC tamper / wrong-key rejected
//  - malformed inputs are rejected, not thrown
//  - rotation continuity: ticket signed with prior `active` still validates
//    if the key remains in the caller-supplied validKeys list

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createTicketStore,
  TICKET_TTL_MS,
  isTicketAudience,
  TICKET_AUDIENCES,
  type TicketStore,
  type TicketAudience,
} from '../../src/fleet/auth-ticket.ts';

let store: TicketStore | null = null;
afterEach(() => {
  store?.stop();
  store = null;
});

function freshStore(): TicketStore {
  store = createTicketStore({ evictionIntervalMs: 0 });
  return store;
}

const KEY = 'k'.repeat(64);

describe('auth-ticket -- audience constants', () => {
  it('exposes api, sse, and ws audiences', () => {
    expect(TICKET_AUDIENCES).toEqual(['api', 'sse', 'ws']);
  });

  it('isTicketAudience accepts valid strings and rejects others', () => {
    expect(isTicketAudience('api')).toBe(true);
    expect(isTicketAudience('sse')).toBe(true);
    expect(isTicketAudience('ws')).toBe(true);
    expect(isTicketAudience('admin')).toBe(false);
    expect(isTicketAudience(42)).toBe(false);
    expect(isTicketAudience(null)).toBe(false);
  });
});

describe('auth-ticket -- issue/redeem per audience', () => {
  for (const audience of TICKET_AUDIENCES) {
    it(`issues and redeems a '${audience}'-audience ticket`, () => {
      const s = freshStore();
      const { ticket, expiresIn } = s.issue(KEY, audience);
      expect(typeof ticket).toBe('string');
      // 4 parts: nonce.audience.expiry.hmac
      expect(ticket.split('.').length).toBe(4);
      expect(ticket.split('.')[1]).toBe(audience);
      expect(expiresIn).toBe(Math.floor(TICKET_TTL_MS / 1000));
      expect(s.redeem(ticket, audience, [KEY])).toBe(true);
    });
  }

  it('rejects the same ticket on second redeem (single-use)', () => {
    const s = freshStore();
    const { ticket } = s.issue(KEY, 'api');
    expect(s.redeem(ticket, 'api', [KEY])).toBe(true);
    expect(s.redeem(ticket, 'api', [KEY])).toBe(false);
  });
});

describe('auth-ticket -- cross-audience rejection', () => {
  it('rejects an api ticket presented as sse', () => {
    const s = freshStore();
    const { ticket } = s.issue(KEY, 'api');
    expect(s.redeem(ticket, 'sse', [KEY])).toBe(false);
  });

  it('rejects an sse ticket presented as api', () => {
    const s = freshStore();
    const { ticket } = s.issue(KEY, 'sse');
    expect(s.redeem(ticket, 'api', [KEY])).toBe(false);
  });

  it('rejects a ws ticket presented as api', () => {
    const s = freshStore();
    const { ticket } = s.issue(KEY, 'ws');
    expect(s.redeem(ticket, 'api', [KEY])).toBe(false);
  });

  it('rejects an api ticket presented as ws', () => {
    const s = freshStore();
    const { ticket } = s.issue(KEY, 'api');
    expect(s.redeem(ticket, 'ws', [KEY])).toBe(false);
  });
});

describe('auth-ticket -- expiry', () => {
  it('rejects a ticket past its expiry', () => {
    let clock = 1_000_000;
    store = createTicketStore({ evictionIntervalMs: 0, now: () => clock });
    const { ticket } = store.issue(KEY, 'api');
    clock += TICKET_TTL_MS + 1;
    expect(store.redeem(ticket, 'api', [KEY])).toBe(false);
  });
});

describe('auth-ticket -- HMAC integrity', () => {
  it('rejects a ticket signed with a key not in validKeys', () => {
    const s = freshStore();
    const other = 'x'.repeat(64);
    const { ticket } = s.issue(KEY, 'api');
    expect(s.redeem(ticket, 'api', [other])).toBe(false);
  });

  it('rejects a ticket whose HMAC was tampered with', () => {
    const s = freshStore();
    const { ticket } = s.issue(KEY, 'api');
    const parts = ticket.split('.');
    const last = parts[3].slice(-1);
    const flipped = last === 'A' ? 'B' : 'A';
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3].slice(0, -1)}${flipped}`;
    expect(s.redeem(tampered, 'api', [KEY])).toBe(false);
  });

  it('rejects a ticket whose audience segment was tampered with', () => {
    // An attacker who swaps the audience in the wire format breaks the HMAC
    // because audience is part of the signed payload.
    const s = freshStore();
    const { ticket } = s.issue(KEY, 'api');
    const parts = ticket.split('.');
    const tampered = `${parts[0]}.sse.${parts[2]}.${parts[3]}`;
    expect(s.redeem(tampered, 'sse', [KEY])).toBe(false);
    expect(s.redeem(tampered, 'api', [KEY])).toBe(false);
  });

  it('validates against multiple keys (post-rotation grace)', () => {
    const s = freshStore();
    const oldKey = 'a'.repeat(64);
    const newKey = 'b'.repeat(64);
    const { ticket } = s.issue(oldKey, 'api');
    expect(s.redeem(ticket, 'api', [newKey, oldKey])).toBe(true);
  });
});

describe('auth-ticket -- malformed input', () => {
  it('returns false (does not throw) for malformed strings', () => {
    const s = freshStore();
    expect(s.redeem('', 'api', [KEY])).toBe(false);
    expect(s.redeem('not.a.ticket', 'api', [KEY])).toBe(false);
    expect(s.redeem('only-one-part', 'api', [KEY])).toBe(false);
    expect(s.redeem('a.b.c.d.e', 'api', [KEY])).toBe(false);
    // bogus expiry segment
    expect(s.redeem('nonce.api.notanumber.hmac', 'api', [KEY])).toBe(false);
    // unknown audience segment
    expect(s.redeem('nonce.admin.123.hmac', 'api' as TicketAudience, [KEY])).toBe(false);
  });
});

describe('auth-ticket -- constant-time compare SSOT', () => {
  // test-integrity: source-string-ok — static-policy check (banned local
  // reimplementation), not behavior: the naive/hardened delta is not
  // reachable through the public API because computeHmac only ever emits
  // well-formed base64url, so a behavioral test cannot pin the SSOT.
  //
  // safe-compare.ts is the hardened canonical (well-formed-UTF-16 gate,
  // byteLength check, never throws, empty strings never verify) and its own
  // header cites auth-ticket's compare as the precedent it superseded. The
  // HMAC verification path must use it rather than keep a weaker local copy
  // (same anti-duplication pattern as parser-utils/no-duplicates).
  it('uses safeStringEqual from safe-compare.ts, not a local naive compare', () => {
    const src = readFileSync(
      new URL('../../src/fleet/auth-ticket.ts', import.meta.url),
      'utf8',
    );
    expect(src).toContain("from './safe-compare.ts'");
    expect(src).not.toMatch(/function safeEqual\(/);
  });
});
