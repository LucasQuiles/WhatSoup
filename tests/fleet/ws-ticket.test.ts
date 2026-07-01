// tests/fleet/ws-ticket.test.ts
//
// Cover the short-lived WS ticket store in `src/fleet/ws-ticket.ts`:
//  - issue+redeem happy path
//  - expired ticket → 401-equivalent
//  - replay (redeem twice) → second attempt rejected
//  - HMAC tamper → rejected
//  - ticket signed with prior `active` still validates if the key remains in
//    the caller-supplied validKeys list (rotation continuity)
//  - malformed inputs are rejected, not thrown

import { describe, it, expect, afterEach } from 'vitest';
import { createTicketStore, TICKET_TTL_MS, type TicketStore } from '../../src/fleet/ws-ticket.ts';

let store: TicketStore | null = null;
afterEach(() => {
  store?.stop();
  store = null;
});

function freshStore(): TicketStore {
  // Disable the timer-based eviction inside tests so vitest can exit promptly.
  store = createTicketStore({ evictionIntervalMs: 0 });
  return store;
}

describe('ticket store — issue/redeem', () => {
  it('issues a ticket and redeems it successfully', () => {
    const s = freshStore();
    const key = 'a'.repeat(64);
    const { ticket, expiresIn } = s.issue(key);
    expect(typeof ticket).toBe('string');
    expect(ticket.split('.')).toHaveLength(4);
    expect(ticket.split('.')[1]).toBe('ws');
    expect(expiresIn).toBe(Math.floor(TICKET_TTL_MS / 1000));
    expect(s.redeem(ticket, [key])).toBe(true);
  });

  it('rejects the same ticket on second redeem (single-use)', () => {
    const s = freshStore();
    const key = 'a'.repeat(64);
    const { ticket } = s.issue(key);
    expect(s.redeemedCount).toBe(0);
    expect(s.redeem(ticket, [key])).toBe(true);
    expect(s.redeemedCount).toBe(1);
    expect(s.redeem(ticket, [key])).toBe(false);
  });
});

describe('ticket store — expiry', () => {
  it('rejects a ticket past its expiry', () => {
    let clock = 1_000_000;
    store = createTicketStore({ evictionIntervalMs: 0, now: () => clock });
    const key = 'a'.repeat(64);
    const { ticket } = store.issue(key);
    clock += TICKET_TTL_MS + 1;
    expect(store.redeem(ticket, [key])).toBe(false);
  });
});

describe('ticket store — HMAC integrity', () => {
  it('rejects a ticket signed with a key not in validKeys', () => {
    const s = freshStore();
    const issuingKey = 'a'.repeat(64);
    const otherKey = 'b'.repeat(64);
    const { ticket } = s.issue(issuingKey);
    expect(s.redeem(ticket, [otherKey])).toBe(false);
  });

  it('rejects a ticket whose HMAC was tampered with', () => {
    const s = freshStore();
    const key = 'a'.repeat(64);
    const { ticket } = s.issue(key);
    const parts = ticket.split('.');
    // Flip the last character of the HMAC segment
    const lastChar = parts[3].slice(-1);
    const flipped = lastChar === 'A' ? 'B' : 'A';
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3].slice(0, -1)}${flipped}`;
    expect(s.redeem(tampered, [key])).toBe(false);
  });

  it('validates against multiple keys (post-rotation grace)', () => {
    const s = freshStore();
    const oldActive = 'a'.repeat(64);
    const newActive = 'b'.repeat(64);
    // Ticket was minted while `oldActive` was the signing key.
    const { ticket } = s.issue(oldActive);
    // After rotation the server presents both as valid keys.
    expect(s.redeem(ticket, [newActive, oldActive])).toBe(true);
  });
});

describe('ticket store — malformed input', () => {
  it('returns false (does not throw) for malformed strings', () => {
    const s = freshStore();
    const key = 'a'.repeat(64);
    expect(s.redeem('', [key])).toBe(false);
    expect(s.redeem('not.a.ticket', [key])).toBe(false);
    expect(s.redeem('only-one-part', [key])).toBe(false);
    expect(s.redeem('a.b.c', [key])).toBe(false);
    // bogus expiry segment
    expect(s.redeem('nonce.ws.notanumber.hmac', [key])).toBe(false);
  });
});
