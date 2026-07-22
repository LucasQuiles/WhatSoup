import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { canSendToGroup, recordGroupOutbound, __resetForTests } from '../../src/core/echo-guard.ts';
import type { EchoGuardConfig } from '../../src/core/echo-guard.ts';

const DEFAULT_CFG: EchoGuardConfig = { enabled: true, groupCooldownMs: 60_000 };

describe('echo-guard', () => {
  beforeEach(() => {
    __resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows first send to a group', () => {
    expect(canSendToGroup('111111100000000001@g.us', DEFAULT_CFG)).toBe(true);
  });

  it('blocks second send within cooldown window', () => {
    const jid = '111111100000000001@g.us';
    recordGroupOutbound(jid);
    expect(canSendToGroup(jid, DEFAULT_CFG)).toBe(false);
  });

  it('applies the group cooldown to iMessage group conversations', () => {
    const jid = 'iMessage;+;chatABC@imessage';
    recordGroupOutbound(jid);
    expect(canSendToGroup(jid, DEFAULT_CFG)).toBe(false);
  });

  it('allows send after cooldown expires', async () => {
    vi.useFakeTimers();
    const jid = '111111100000000001@g.us';
    const cfg: EchoGuardConfig = { enabled: true, groupCooldownMs: 10 };
    recordGroupOutbound(jid);
    await vi.advanceTimersByTimeAsync(15);
    expect(canSendToGroup(jid, cfg)).toBe(true);
  });

  it('always allows DM sends regardless of cooldown', () => {
    const dmJid = '15551230006@s.whatsapp.net';
    recordGroupOutbound(dmJid);
    expect(canSendToGroup(dmJid, DEFAULT_CFG)).toBe(true);
  });

  it('always allows LID DM sends', () => {
    const lidJid = '11111110000008@lid';
    recordGroupOutbound(lidJid);
    expect(canSendToGroup(lidJid, DEFAULT_CFG)).toBe(true);
  });

  it('allows all sends when disabled', () => {
    const jid = '111111100000000001@g.us';
    const cfg: EchoGuardConfig = { enabled: false, groupCooldownMs: 60_000 };
    recordGroupOutbound(jid);
    expect(canSendToGroup(jid, cfg)).toBe(true);
  });

  it('tracks cooldown per group independently', () => {
    const group1 = '111111111@g.us';
    const group2 = '222222222@g.us';
    recordGroupOutbound(group1);
    expect(canSendToGroup(group1, DEFAULT_CFG)).toBe(false);
    expect(canSendToGroup(group2, DEFAULT_CFG)).toBe(true);
  });

  it('__resetForTests clears all cooldown state', () => {
    const jid = '111111100000000001@g.us';
    recordGroupOutbound(jid);
    expect(canSendToGroup(jid, DEFAULT_CFG)).toBe(false);
    __resetForTests();
    expect(canSendToGroup(jid, DEFAULT_CFG)).toBe(true);
  });

  it('evicts the oldest cooldown entry when over capacity (bounded growth)', () => {
    const firstJid = '100000000000000000@g.us';
    recordGroupOutbound(firstJid);
    expect(canSendToGroup(firstJid, DEFAULT_CFG)).toBe(false); // cooldown active

    // Fill the cap (10_000) with distinct groups; firstJid is the oldest entry.
    for (let i = 0; i < 10_000; i++) {
      recordGroupOutbound(`2${String(i).padStart(17, '0')}@g.us`);
    }

    // The oldest (firstJid) was evicted — its cooldown no longer suppresses.
    expect(canSendToGroup(firstJid, DEFAULT_CFG)).toBe(true);
    // A still-resident recent group keeps its active cooldown.
    expect(canSendToGroup('200000000000000000@g.us', DEFAULT_CFG)).toBe(false);
  });

  // --- Session-aware tests ---

  it('allows rapid sends from the same sender token (intra-session)', () => {
    const jid = '111111100000000001@g.us';
    const token = 'session-A';
    recordGroupOutbound(jid, token);
    // Same token — should be exempt from cooldown
    expect(canSendToGroup(jid, DEFAULT_CFG, token)).toBe(true);
  });

  it('blocks rapid sends from a different sender token (cross-session)', () => {
    const jid = '111111100000000001@g.us';
    recordGroupOutbound(jid, 'session-A');
    // Different token — cooldown applies
    expect(canSendToGroup(jid, DEFAULT_CFG, 'session-B')).toBe(false);
  });

  it('blocks rapid sends when new sender has no token (cross-session)', () => {
    const jid = '111111100000000001@g.us';
    recordGroupOutbound(jid, 'session-A');
    // No token — cooldown applies
    expect(canSendToGroup(jid, DEFAULT_CFG)).toBe(false);
  });

  it('blocks rapid sends when original sender had no token', () => {
    const jid = '111111100000000001@g.us';
    recordGroupOutbound(jid); // no token
    // Even with a token, different source — cooldown applies
    expect(canSendToGroup(jid, DEFAULT_CFG, 'session-B')).toBe(false);
  });

  it('allows cross-session send after cooldown expires', async () => {
    vi.useFakeTimers();
    const jid = '111111100000000001@g.us';
    const cfg: EchoGuardConfig = { enabled: true, groupCooldownMs: 10 };
    recordGroupOutbound(jid, 'session-A');
    await vi.advanceTimersByTimeAsync(15);
    expect(canSendToGroup(jid, cfg, 'session-B')).toBe(true);
  });
});
