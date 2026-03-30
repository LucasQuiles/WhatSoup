import { describe, it, expectTypeOf } from 'vitest';
import type { Messenger, OutboundMedia } from '../../src/core/types.ts';

describe('OutboundMedia type', () => {
  it('image variant has buffer and optional caption', () => {
    const media: OutboundMedia = { type: 'image', buffer: Buffer.from(''), caption: 'test' };
    expectTypeOf(media).toMatchTypeOf<OutboundMedia>();
  });

  it('document variant requires filename and mimetype', () => {
    const media: OutboundMedia = { type: 'document', buffer: Buffer.from(''), filename: 'test.pdf', mimetype: 'application/pdf' };
    expectTypeOf(media).toMatchTypeOf<OutboundMedia>();
  });

  it('audio variant has mimetype and optional ptt', () => {
    const media: OutboundMedia = { type: 'audio', buffer: Buffer.from(''), mimetype: 'audio/ogg', ptt: true };
    expectTypeOf(media).toMatchTypeOf<OutboundMedia>();
  });

  it('video variant has buffer and optional caption', () => {
    const media: OutboundMedia = { type: 'video', buffer: Buffer.from(''), caption: 'clip' };
    expectTypeOf(media).toMatchTypeOf<OutboundMedia>();
  });
});

describe('Messenger interface', () => {
  it('has sendMedia method', () => {
    expectTypeOf<Messenger>().toHaveProperty('sendMedia');
  });
});
