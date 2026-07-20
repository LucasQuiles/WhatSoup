// tests/transport/signal/adapter-construction.test.ts
// Construction + capabilities + selfRef for SignalAdapter.
// Exercises the constructor contract before any lifecycle or send path.
import { describe, it, expect } from 'vitest';
import { SignalAdapter } from '../../../src/transport/signal/adapter.ts';
import { MockSignalPort, makeSignalConfig } from './mock-port.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';

describe('SignalAdapter — construction', () => {
  it('rejects an invalid phoneNumber at construction', () => {
    expect(() => new SignalAdapter(
      makeSignalConfig({ phoneNumber: 'not-a-number' }),
      new MockSignalPort(),
    )).toThrow(/valid E\.164 phoneNumber/);
  });

  it('builds a signal ChannelId from config.account', () => {
    const adapter = new SignalAdapter(makeSignalConfig({ account: 'ops-line' }), new MockSignalPort());
    expect(adapter.selfRef().channel).toBe(makeChannelId('signal', 'ops-line'));
    expect(adapter.capabilities.channel).toBe('signal:ops-line');
  });

  it('declares kind: signal', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(adapter.capabilities.kind).toBe('signal');
  });

  it('declares the v1 extension set (reactions/typing/read-receipts/delete)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    // Compare as a sorted array so the assertion is order-independent.
    expect([...adapter.capabilities.extensions].sort()).toEqual(
      ['delete', 'reactions', 'read-receipts', 'typing'].sort(),
    );
    // Also assert membership explicitly so an accidental add/remove surfaces.
    for (const ext of ['reactions', 'typing', 'read-receipts', 'delete'] as const) {
      expect(adapter.capabilities.extensions.has(ext)).toBe(true);
    }
  });

  it('does NOT declare media/voice-notes/edit/presence/groups in v1', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    const ext = adapter.capabilities.extensions;
    expect(ext.has('media')).toBe(false);
    expect(ext.has('voice-notes')).toBe(false);
    expect(ext.has('edit')).toBe(false);
    expect(ext.has('presence')).toBe(false);
    expect(ext.has('groups')).toBe(false);
  });

  it('declares maxTextLength matching SIGNAL_MAX_TEXT (64 KiB)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(adapter.capabilities.maxTextLength).toBe(65_535);
  });

  it('declares auth: qr (signal-cli link emits a QR)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(adapter.capabilities.auth).toBe('qr');
  });

  it('declares readReceipts: message and reactions: single', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(adapter.capabilities.readReceipts).toBe('message');
    expect(adapter.capabilities.reactions).toBe('single');
  });

  it('declares no media capability in v1 (maxBytes: 0, empty allowlist)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(adapter.capabilities.media.maxBytes).toBe(0);
    expect(adapter.capabilities.media.mimeAllowlist).toEqual([]);
  });

  it('declares idempotency: none across all opcodes (v1)', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(adapter.capabilities.idempotency.sendText).toBe('none');
    expect(adapter.capabilities.idempotency.sendMedia).toBe('none');
    expect(adapter.capabilities.idempotency.react).toBe('none');
    expect(adapter.capabilities.idempotency.editText).toBe('none');
    expect(adapter.capabilities.idempotency.delete).toBe('none');
  });

  it('exposes selfRef using the configured phone number', () => {
    const adapter = new SignalAdapter(
      makeSignalConfig({ phoneNumber: '+15559998888' }),
      new MockSignalPort(),
    );
    expect(adapter.selfRef().id).toBe('+15559998888');
    expect(adapter.selfRef().channel).toBe('signal:test');
  });

  it('starts disconnected', () => {
    const adapter = new SignalAdapter(makeSignalConfig(), new MockSignalPort());
    expect(adapter.state().state).toBe('disconnected');
  });
});
