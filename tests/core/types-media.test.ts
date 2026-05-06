import { describe, it, expect, expectTypeOf } from 'vitest';
import type { Messenger, OutboundMedia } from '../../src/core/types.ts';

describe('OutboundMedia type', () => {
  it('image variant has buffer and optional caption', () => {
    const media: OutboundMedia = { type: 'image', buffer: Buffer.from(''), caption: 'test' };
    expectTypeOf(media).toMatchTypeOf<OutboundMedia>();
    expect(media).toMatchObject({ type: 'image', caption: 'test' });
  });

  it('document variant requires filename and mimetype', () => {
    const media: OutboundMedia = { type: 'document', buffer: Buffer.from(''), filename: 'test.pdf', mimetype: 'application/pdf' };
    expectTypeOf(media).toMatchTypeOf<OutboundMedia>();
    expect(media).toMatchObject({ type: 'document', filename: 'test.pdf', mimetype: 'application/pdf' });
  });

  it('audio variant has mimetype and optional ptt', () => {
    const media: OutboundMedia = { type: 'audio', buffer: Buffer.from(''), mimetype: 'audio/ogg', ptt: true };
    expectTypeOf(media).toMatchTypeOf<OutboundMedia>();
    expect(media).toMatchObject({ type: 'audio', mimetype: 'audio/ogg', ptt: true });
  });

  it('video variant has buffer and optional caption', () => {
    const media: OutboundMedia = { type: 'video', buffer: Buffer.from(''), caption: 'clip' };
    expectTypeOf(media).toMatchTypeOf<OutboundMedia>();
    expect(media).toMatchObject({ type: 'video', caption: 'clip' });
  });
});

describe('Messenger interface', () => {
  it('has sendMedia method', () => {
    expectTypeOf<Messenger>().toHaveProperty('sendMedia');
    const messenger: Messenger = {
      sendMessage: async () => ({ waMessageId: null }),
      sendMedia: async () => ({ waMessageId: 'media-1' }),
    };
    expect(typeof messenger.sendMedia).toBe('function');
  });
});
