// tests/transport/imessage/adapter-construction.test.ts
import { describe, it, expect } from 'vitest';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import { MockImessagePort, makeImessageConfig } from './mock-port.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';

describe('ImessageAdapter — construction', () => {
  it('rejects an empty sender at construction', () => {
    expect(() => new ImessageAdapter(
      makeImessageConfig({ sender: '' }),
      new MockImessagePort(),
    )).toThrow(/non-empty sender/);
  });

  it('rejects a sender that is neither AppleID email nor E.164 phone', () => {
    expect(() => new ImessageAdapter(
      makeImessageConfig({ sender: 'not-valid' }),
      new MockImessagePort(),
    )).toThrow(/AppleID email or E\.164 phone/);
  });

  it('accepts an AppleID email sender', () => {
    const adapter = new ImessageAdapter(
      makeImessageConfig({ sender: 'bot@icloud.com' }),
      new MockImessagePort(),
    );
    expect(adapter.selfRef().id).toBe('bot@icloud.com');
  });

  it('accepts an E.164 phone sender', () => {
    const adapter = new ImessageAdapter(
      makeImessageConfig({ sender: '+15551234567' }),
      new MockImessagePort(),
    );
    expect(adapter.selfRef().id).toBe('+15551234567');
  });

  it('rejects unimplemented webhook mode at the direct-construction seam', () => {
    expect(() => new ImessageAdapter(
      makeImessageConfig({ inboundMode: 'webhook' as unknown as 'poll' }),
      new MockImessagePort(),
    )).toThrow(/only poll.*not implemented/i);
  });

  it('builds an imessage ChannelId from config.account', () => {
    const adapter = new ImessageAdapter(
      makeImessageConfig({ account: 'mac-mini' }),
      new MockImessagePort(),
    );
    expect(adapter.selfRef().channel).toBe(makeChannelId('imessage', 'mac-mini'));
    expect(adapter.capabilities.channel).toBe('imessage:mac-mini');
  });

  it('declares kind: imessage', () => {
    const adapter = new ImessageAdapter(makeImessageConfig(), new MockImessagePort());
    expect(adapter.capabilities.kind).toBe('imessage');
  });

  it('declares the v1 extension set (reactions/typing/read-receipts)', () => {
    const adapter = new ImessageAdapter(makeImessageConfig(), new MockImessagePort());
    for (const ext of ['reactions', 'typing', 'read-receipts'] as const) {
      expect(adapter.capabilities.extensions.has(ext)).toBe(true);
    }
  });

  it('does not advertise bridge-gated extensions for imsg without runtime attestation', () => {
    const adapter = new ImessageAdapter(
      makeImessageConfig({ backend: 'imsg', imsgSocketPath: '/tmp/imsg-test.sock' }),
      new MockImessagePort(),
    );
    expect([...adapter.capabilities.extensions]).toEqual([]);
    expect(adapter.capabilities.readReceipts).toBe('none');
    expect(adapter.capabilities.reactions).toBe('none');
  });

  it('does NOT declare delete in v1 (iMessage has no remote-delete protocol)', () => {
    const adapter = new ImessageAdapter(makeImessageConfig(), new MockImessagePort());
    expect(adapter.capabilities.extensions.has('delete')).toBe(false);
  });

  it('does NOT declare media/voice-notes/edit/presence/groups/inline-keyboards in v1', () => {
    const adapter = new ImessageAdapter(makeImessageConfig(), new MockImessagePort());
    const ext = adapter.capabilities.extensions;
    expect(ext.has('media')).toBe(false);
    expect(ext.has('voice-notes')).toBe(false);
    expect(ext.has('edit')).toBe(false);
    expect(ext.has('presence')).toBe(false);
    expect(ext.has('groups')).toBe(false);
    expect(ext.has('inline-keyboards')).toBe(false);
  });

  it('declares maxTextLength 64 KiB', () => {
    const adapter = new ImessageAdapter(makeImessageConfig(), new MockImessagePort());
    expect(adapter.capabilities.maxTextLength).toBe(65_535);
  });

  it('declares auth: token', () => {
    const adapter = new ImessageAdapter(makeImessageConfig(), new MockImessagePort());
    expect(adapter.capabilities.auth).toBe('token');
  });

  it('declares readReceipts: conversation (iMessage marks conversations, not individual messages)', () => {
    const adapter = new ImessageAdapter(makeImessageConfig(), new MockImessagePort());
    expect(adapter.capabilities.readReceipts).toBe('conversation');
  });

  it('declares reactions: single', () => {
    const adapter = new ImessageAdapter(makeImessageConfig(), new MockImessagePort());
    expect(adapter.capabilities.reactions).toBe('single');
  });

  it('starts disconnected', () => {
    const adapter = new ImessageAdapter(makeImessageConfig(), new MockImessagePort());
    expect(adapter.state().state).toBe('disconnected');
  });
});
