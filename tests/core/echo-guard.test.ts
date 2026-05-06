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

  it('allows send after cooldown expires', async () => {
    vi.useFakeTimers();
    const jid = '111111100000000001@g.us';
    const cfg: EchoGuardConfig = { enabled: true, groupCooldownMs: 10 };
    recordGroupOutbound(jid);
    await vi.advanceTimersByTimeAsync(15);
    expect(canSendToGroup(jid, cfg)).toBe(true);
  });

  it('always allows DM sends regardless of cooldown', () => {
    const dmJid = '18459780919@s.whatsapp.net';
    recordGroupOutbound(dmJid);
    expect(canSendToGroup(dmJid, DEFAULT_CFG)).toBe(true);
  });

  it('always allows LID DM sends', () => {
    const lidJid = '49079279169655@lid';
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
});
