// tests/transport/twilio/mock-port.test.ts
import { describe, it, expect } from 'vitest';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';

describe('MockTwilioSmsPort', () => {
  it('verifyCredentials resolves when no failure is injected', async () => {
    const port = new MockTwilioSmsPort();
    await expect(port.verifyCredentials()).resolves.toBeUndefined();
  });

  it('sendSms returns a sid matching /^SM/ and records the call', async () => {
    const port = new MockTwilioSmsPort();
    const { sid } = await port.sendSms({ to: '+15551230000', from: '+15559990000', body: 'hi' });
    expect(sid).toMatch(/^SM/);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toMatchObject({ to: '+15551230000', from: '+15559990000', body: 'hi' });
  });

  it('each sendSms call produces a unique deterministic sid', async () => {
    const port = new MockTwilioSmsPort();
    const r1 = await port.sendSms({ to: '+15551230000', body: 'a' });
    const r2 = await port.sendSms({ to: '+15551230001', body: 'b' });
    expect(r1.sid).not.toBe(r2.sid);
    expect(r1.sid).toMatch(/^SM/);
    expect(r2.sid).toMatch(/^SM/);
  });

  it('injected inbound is returned by listInboundSince', async () => {
    const port = new MockTwilioSmsPort();
    await port.verifyCredentials();
    await port.sendSms({ to: '+15559990000', from: '+15551230000', body: 'hi' });
    port.injectInbound({ sid: 'SMin1', from: '+15551230000', to: '+15559990000', body: 'yo', sentAt: new Date() });
    const since = new Date(0);
    const got = await port.listInboundSince(since);
    expect(got).toHaveLength(1);
    expect(got[0].body).toBe('yo');
    expect(got[0].sid).toBe('SMin1');
  });

  it('listInboundSince filters by sentAt', async () => {
    const port = new MockTwilioSmsPort();
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T01:00:00Z');
    const t2 = new Date('2026-01-01T02:00:00Z');
    port.injectInbound({ sid: 'SM001', from: '+1', to: '+2', body: 'old', sentAt: t0 });
    port.injectInbound({ sid: 'SM002', from: '+1', to: '+2', body: 'new', sentAt: t2 });
    const got = await port.listInboundSince(t1);
    expect(got).toHaveLength(1);
    expect(got[0].body).toBe('new');
  });

  it('includes a record whose sentAt equals since (inclusive boundary, at-least-once)', async () => {
    const port = new MockTwilioSmsPort();
    const cursor = new Date('2026-01-01T01:00:00Z');
    port.injectInbound({ sid: 'SMeq', from: '+1', to: '+2', body: 'boundary', sentAt: cursor });
    const got = await port.listInboundSince(cursor);
    expect(got.map((m) => m.sid)).toEqual(['SMeq']);
  });

  it('returns records ascending by sentAt regardless of injection order', async () => {
    const port = new MockTwilioSmsPort();
    const t = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
    port.injectInbound({ sid: 'SMc', from: '+1', to: '+2', body: 'c', sentAt: t(3) });
    port.injectInbound({ sid: 'SMa', from: '+1', to: '+2', body: 'a', sentAt: t(1) });
    port.injectInbound({ sid: 'SMb', from: '+1', to: '+2', body: 'b', sentAt: t(2) });
    const got = await port.listInboundSince(new Date(0));
    expect(got.map((m) => m.sid)).toEqual(['SMa', 'SMb', 'SMc']);
  });

  it('listInboundSince respects optional pageSize limit', async () => {
    const port = new MockTwilioSmsPort();
    const base = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      port.injectInbound({ sid: `SM${i}`, from: '+1', to: '+2', body: `msg${i}`, sentAt: new Date(base.getTime() + i * 1000) });
    }
    const got = await port.listInboundSince(new Date(0), 3);
    expect(got).toHaveLength(3);
  });

  it('rejects non-positive or non-integer pageSize (fail closed)', async () => {
    const port = new MockTwilioSmsPort();
    await expect(port.listInboundSince(new Date(0), 0)).rejects.toThrow(RangeError);
    await expect(port.listInboundSince(new Date(0), -1)).rejects.toThrow(RangeError);
    await expect(port.listInboundSince(new Date(0), 1.5)).rejects.toThrow(RangeError);
  });

  it('failNextSend causes one rejection then the next send succeeds', async () => {
    const port = new MockTwilioSmsPort();
    const err = new Error('provider down');
    port.failNextSend(err);
    await expect(port.sendSms({ to: '+1', body: 'x' })).rejects.toThrow('provider down');
    // Second call succeeds — failure is one-shot, and the failed call was never recorded
    const { sid } = await port.sendSms({ to: '+1', body: 'y' });
    expect(sid).toMatch(/^SM/);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0].body).toBe('y');
  });

  it('failNextList causes one rejection then the next list succeeds', async () => {
    const port = new MockTwilioSmsPort();
    const err = new Error('list failed');
    port.failNextList(err);
    await expect(port.listInboundSince(new Date(0))).rejects.toThrow('list failed');
    const got = await port.listInboundSince(new Date(0));
    expect(Array.isArray(got)).toBe(true);
  });

  it('failNextVerify causes verifyCredentials to reject then resets', async () => {
    const port = new MockTwilioSmsPort();
    const err = new Error('bad creds');
    port.failNextVerify(err);
    await expect(port.verifyCredentials()).rejects.toThrow('bad creds');
    // Reset after one use
    await expect(port.verifyCredentials()).resolves.toBeUndefined();
  });
});
