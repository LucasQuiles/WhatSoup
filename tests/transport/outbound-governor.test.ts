// tests/transport/outbound-governor.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OutboundGovernor,
  wrapWithOutboundGovernor,
  classifyOutbound,
  isOutboundGovernorShed,
  OUTBOUND_GOVERNOR_SHED_LOG,
} from '../../src/transport/outbound-governor.ts';
import { WhatSoupError } from '../../src/errors.ts';

function fakeSock(sendImpl?: (...a: unknown[]) => unknown) {
  const sendMessage = vi.fn(sendImpl ?? (async () => ({ key: { id: 'wa-1' } })));
  return {
    sendMessage,
    query: vi.fn(async () => ({})),
    end: vi.fn(),
    sendPresenceUpdate: vi.fn(async () => undefined),
    ws: { isOpen: true },
  };
}

function fakeLog() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const IDENTITY = (jid: string) => jid;

describe('classifyOutbound (SS3 — default to exempt)', () => {
  it('classifies genuine text sends as text', () => {
    expect(classifyOutbound({ text: 'hi' })).toBe('text');
    expect(classifyOutbound({ text: 'hi', mentions: ['x@s.whatsapp.net'] })).toBe('text');
  });

  it('classifies media as media (exempt)', () => {
    expect(classifyOutbound({ image: Buffer.from('x'), caption: 'c' })).toBe('media');
    expect(classifyOutbound({ document: Buffer.from('x'), fileName: 'f' })).toBe('media');
    expect(classifyOutbound({ audio: Buffer.from('x') })).toBe('media');
    expect(classifyOutbound({ video: Buffer.from('x') })).toBe('media');
    expect(classifyOutbound({ sticker: Buffer.from('x') })).toBe('media');
  });

  it('classifies control ops as control (exempt) even when they carry text', () => {
    // edit sends { text, edit } — the text MUST NOT make it pace-eligible.
    expect(classifyOutbound({ text: 'new', edit: { id: 'm1' } })).toBe('control');
    expect(classifyOutbound({ delete: { id: 'm1' } })).toBe('control');
    expect(classifyOutbound({ react: { text: '+1', key: {} } })).toBe('control');
    expect(classifyOutbound({ protocolMessage: {} })).toBe('control');
    expect(classifyOutbound({ poll: { name: 'q', values: ['a'] } })).toBe('control');
    expect(classifyOutbound({ forward: {}, force: true })).toBe('control');
  });

  it('defaults unknown / non-text / non-media shapes to control (exempt)', () => {
    expect(classifyOutbound({ sharePhoneNumber: true })).toBe('control');
    expect(classifyOutbound({})).toBe('control');
    expect(classifyOutbound(null)).toBe('control');
  });
});

describe('wrapWithOutboundGovernor — SS1 reference identity + passthrough', () => {
  it('returns the SAME socket object (in-place override, not a Proxy)', () => {
    const gov = new OutboundGovernor(permissive());
    const sock = fakeSock();
    const ret = wrapWithOutboundGovernor(sock, { governor: gov, resolveDest: IDENTITY });
    expect(ret).toBe(sock);
  });

  it('leaves every non-sendMessage method untouched (passthrough)', () => {
    const gov = new OutboundGovernor(permissive());
    const sock = fakeSock();
    const origQuery = sock.query;
    const origEnd = sock.end;
    const origPresence = sock.sendPresenceUpdate;
    wrapWithOutboundGovernor(sock, { governor: gov, resolveDest: IDENTITY });
    expect(sock.query).toBe(origQuery);
    expect(sock.end).toBe(origEnd);
    expect(sock.sendPresenceUpdate).toBe(origPresence);
  });
});

describe('wrapWithOutboundGovernor — paces, never drops (T2.1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('delivers all 30 text sends to one dest, delaying (not dropping) the later ones', async () => {
    const realSend = vi.fn(async () => ({ key: { id: 'x' } }));
    const sock = fakeSock(realSend);
    // cap 1 per 100ms → sends pace 100ms apart; each reservation waits <=100ms
    // (< maxWaitMs 5s) so NONE shed. Ceiling + global generous.
    const gov = new OutboundGovernor({
      windowMs: 100,
      maxPerWindow: 1,
      maxWaitMs: 5_000,
      hardCeiling: 1_000,
      hardCeilingWindowMs: 3_600_000,
      globalMaxPerWindow: 1_000,
      globalWindowMs: 100,
    });
    wrapWithOutboundGovernor(sock, { governor: gov, resolveDest: IDENTITY });

    const sends: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      sends.push(sock.sendMessage('a@s.whatsapp.net', { text: `m${i}` }) as Promise<unknown>);
    }
    // Before draining the pacing clock: NOT all 30 have reached the socket —
    // the governor is delaying them, proving pace (not synchronous fire).
    await Promise.resolve();
    expect(realSend.mock.calls.length).toBeLessThan(30);

    await vi.advanceTimersByTimeAsync(30 * 100 + 200);
    await Promise.all(sends);

    // Every send arrived — none dropped.
    expect(realSend).toHaveBeenCalledTimes(30);
  });
});

describe('wrapWithOutboundGovernor — media exempt; text sheds at ceiling (T2.2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sheds an over-ceiling text with the PR-G log line, but lets media through', async () => {
    const realSend = vi.fn(async () => ({ key: { id: 'x' } }));
    const sock = fakeSock(realSend);
    const log = fakeLog();
    // cap 1 per 100s → the 2nd text would wait ~100s (>> 5s bound) → shed.
    const gov = new OutboundGovernor({
      windowMs: 100_000,
      maxPerWindow: 1,
      maxWaitMs: 5_000,
      hardCeiling: 1_000,
      hardCeilingWindowMs: 3_600_000,
      globalMaxPerWindow: 1_000,
      globalWindowMs: 100_000,
    });
    wrapWithOutboundGovernor(sock, { governor: gov, resolveDest: IDENTITY, log });

    await sock.sendMessage('a@s.whatsapp.net', { text: 'first' });
    expect(realSend).toHaveBeenCalledTimes(1);

    await expect(sock.sendMessage('a@s.whatsapp.net', { text: 'second' }))
      .rejects.toThrow(/outbound governor ceiling exceeded/);
    expect(realSend).toHaveBeenCalledTimes(1); // shed — not sent
    expect(log.warn).toHaveBeenCalledWith(
      expect.anything(),
      'outbound governor ceiling exceeded',
    );

    // Media bypasses acquire entirely (SS4) — delivered despite the saturated window.
    await sock.sendMessage('a@s.whatsapp.net', { image: Buffer.from('img'), caption: 'c' });
    expect(realSend).toHaveBeenCalledTimes(2);
  });
});

describe('wrapWithOutboundGovernor — global + per-dest buckets (T2.3, F2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a saturated GLOBAL bucket throttles a fresh, otherwise-idle destination', async () => {
    const realSend = vi.fn(async () => ({ key: { id: 'x' } }));
    const sock = fakeSock(realSend);
    // Global cap 1 per 100s; per-dest generous. Two DISTINCT dests, one global.
    const gov = new OutboundGovernor({
      windowMs: 100_000,
      maxPerWindow: 100,
      maxWaitMs: 5_000,
      hardCeiling: 1_000,
      hardCeilingWindowMs: 3_600_000,
      globalMaxPerWindow: 1,
      globalWindowMs: 100_000,
    });
    wrapWithOutboundGovernor(sock, { governor: gov, resolveDest: IDENTITY });

    await sock.sendMessage('a@s.whatsapp.net', { text: 'x' }); // consumes the single global slot
    // dest B is fresh per-dest, but the GLOBAL bucket is exhausted → shed.
    await expect(sock.sendMessage('b@s.whatsapp.net', { text: 'y' }))
      .rejects.toThrow(/outbound governor ceiling exceeded/);
    expect(realSend).toHaveBeenCalledTimes(1);
  });
});

describe('wrapWithOutboundGovernor — lid-resolved keying (T2.4, F3/H3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('folds @lid and phone-JID for the same identity into ONE bucket', async () => {
    const realSend = vi.fn(async () => ({ key: { id: 'x' } }));
    const sock = fakeSock(realSend);
    // resolveDest collapses both aliases of one human to the canonical phone.
    // Fixture-reserved identifiers (repo-hygiene allowlisted; no real PII).
    const LID_ALIAS = '11111110001@lid';
    const PHONE_DIGITS = '15550000001';
    const resolveDest = (jid: string) =>
      jid === LID_ALIAS ? PHONE_DIGITS : jid.split('@')[0]!;
    const gov = new OutboundGovernor({
      windowMs: 100_000,
      maxPerWindow: 1,
      maxWaitMs: 5_000,
      hardCeiling: 1_000,
      hardCeilingWindowMs: 3_600_000,
      globalMaxPerWindow: 1_000,
      globalWindowMs: 100_000,
    });
    wrapWithOutboundGovernor(sock, { governor: gov, resolveDest });

    // First send via the @lid alias reserves the resolved-phone bucket.
    await sock.sendMessage(LID_ALIAS, { text: 'x' });
    // A mid-stream flip to the phone-JID (updateDeliveryJid style) must hit the
    // SAME bucket — not a fresh one that would double the effective rate.
    await expect(sock.sendMessage(`${PHONE_DIGITS}@s.whatsapp.net`, { text: 'y' }))
      .rejects.toThrow(/outbound governor ceiling exceeded/);
    expect(realSend).toHaveBeenCalledTimes(1);
  });
});

describe('wrapWithOutboundGovernor — governor state survives reconnect (T2.5, SS2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-wrapping a NEW socket keeps the per-dest windows (governor is created once)', async () => {
    const gov = new OutboundGovernor({
      windowMs: 100_000,
      maxPerWindow: 1,
      maxWaitMs: 5_000,
      hardCeiling: 1_000,
      hardCeilingWindowMs: 3_600_000,
      globalMaxPerWindow: 1_000,
      globalWindowMs: 100_000,
    });

    const sock1 = fakeSock();
    wrapWithOutboundGovernor(sock1, { governor: gov, resolveDest: IDENTITY });
    await sock1.sendMessage('a@s.whatsapp.net', { text: 'x' }); // reserves dest on shared governor

    // Simulated reconnect: a brand-new socket object, same governor instance.
    const sock2 = fakeSock();
    const ret2 = wrapWithOutboundGovernor(sock2, { governor: gov, resolveDest: IDENTITY });
    expect(ret2).toBe(sock2);

    // The per-dest window persisted across the reconnect → still saturated → sheds.
    await expect(sock2.sendMessage('a@s.whatsapp.net', { text: 'y' }))
      .rejects.toThrow(/outbound governor ceiling exceeded/);
  });
});

describe('wrapWithOutboundGovernor — hard ceiling tier (catastrophe backstop)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sheds on the ceiling once a conversation exceeds it, even when pacing has room', async () => {
    const realSend = vi.fn(async () => ({ key: { id: 'x' } }));
    const sock = fakeSock(realSend);
    const log = fakeLog();
    // Pacing + global are generous; only the hard ceiling (2 / long window) bites.
    const gov = new OutboundGovernor({
      windowMs: 100_000,
      maxPerWindow: 100,
      maxWaitMs: 5_000,
      hardCeiling: 2,
      hardCeilingWindowMs: 3_600_000,
      globalMaxPerWindow: 1_000,
      globalWindowMs: 100_000,
    });
    wrapWithOutboundGovernor(sock, { governor: gov, resolveDest: IDENTITY, log });

    await sock.sendMessage('a@s.whatsapp.net', { text: '1' });
    await sock.sendMessage('a@s.whatsapp.net', { text: '2' });
    await expect(sock.sendMessage('a@s.whatsapp.net', { text: '3' }))
      .rejects.toThrow(/outbound governor ceiling exceeded/);
    expect(realSend).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'ceiling' }),
      'outbound governor ceiling exceeded',
    );
  });

  it('a breadth flood shedding at the GLOBAL bucket does not burn a bystander ceiling', async () => {
    const realSend = vi.fn(async () => ({ key: { id: 'x' } }));
    const sock = fakeSock(realSend);
    // Global saturates at 1; the bystander's per-dest pacing is generous and its
    // hard ceiling is small (2) — if the ceiling were charged before the global
    // gate, the shed attempts below would exhaust it.
    const gov = new OutboundGovernor({
      windowMs: 100_000,
      maxPerWindow: 100,
      maxWaitMs: 5_000,
      hardCeiling: 2,
      hardCeilingWindowMs: 3_600_000,
      globalMaxPerWindow: 1,
      globalWindowMs: 10_000,
    });
    wrapWithOutboundGovernor(sock, { governor: gov, resolveDest: IDENTITY });

    // Conversation A takes the single global slot.
    await sock.sendMessage('a@s.whatsapp.net', { text: 'a' });
    // Bystander B is flooded-against: every send sheds at the GLOBAL bucket
    // (never reaching B's ceiling, because the ceiling is checked LAST).
    for (let i = 0; i < 4; i++) {
      await expect(sock.sendMessage('b@s.whatsapp.net', { text: `b${i}` }))
        .rejects.toThrow(/outbound governor ceiling exceeded/);
    }
    // Aggregate pressure clears.
    await vi.advanceTimersByTimeAsync(10_001);
    // B's own hour-long ceiling (2) was never charged by the shed attempts, so B
    // can send. (If the ceiling were charged BEFORE the global gate, the 4 shed
    // attempts would have filled B's ceiling of 2 and THIS send would shed on it.)
    await expect(sock.sendMessage('b@s.whatsapp.net', { text: 'ok1' })).resolves.toBeDefined();
  });
});

function permissive() {
  return {
    windowMs: 1_000,
    maxPerWindow: 1_000,
    maxWaitMs: 5_000,
    hardCeiling: 100_000,
    hardCeilingWindowMs: 3_600_000,
    globalMaxPerWindow: 1_000_000,
    globalWindowMs: 1_000,
  };
}

describe('isOutboundGovernorShed (issue #1746 classification seam)', () => {
  it('matches the WhatSoupError the governor throws', () => {
    expect(isOutboundGovernorShed(new WhatSoupError(OUTBOUND_GOVERNOR_SHED_LOG, 'OUTBOUND_GOVERNOR_SHED'))).toBe(true);
  });

  it('matches a prototype-stripped copy via the stable message', () => {
    expect(isOutboundGovernorShed(new Error(OUTBOUND_GOVERNOR_SHED_LOG))).toBe(true);
  });

  it('rejects other WhatSoupError codes, plain errors, and non-errors', () => {
    expect(isOutboundGovernorShed(new WhatSoupError('nope', 'SEND_FAILED' as never))).toBe(false);
    expect(isOutboundGovernorShed(new Error('SEND_TIMEOUT'))).toBe(false);
    expect(isOutboundGovernorShed('outbound governor ceiling exceeded')).toBe(false);
    expect(isOutboundGovernorShed(undefined)).toBe(false);
    expect(isOutboundGovernorShed(null)).toBe(false);
  });
});
