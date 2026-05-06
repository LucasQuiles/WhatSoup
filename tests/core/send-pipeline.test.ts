import { describe, expect, it } from 'vitest';
import {
  InvalidSendRequestError,
  MissingTextError,
  createSendPipeline,
  prepareTextSend,
} from '../../src/core/send-pipeline.ts';
import {
  MissingTargetError,
  MutuallyExclusiveError,
  type ChatResolver,
} from '../../src/core/chats-resolver.ts';
import { createProfileRegistry, UnknownProfileError } from '../../src/core/profiles.ts';

const chatResolver: ChatResolver = {
  resolve(target): string {
    if (
      typeof target.chatJid === 'string' &&
      target.chatJid.trim().length > 0 &&
      typeof target.to === 'string' &&
      target.to.trim().length > 0
    ) {
      throw new MutuallyExclusiveError();
    }
    if (typeof target.chatJid === 'string' && target.chatJid.trim().length > 0) {
      return target.chatJid;
    }
    if (target.to === 'ops') {
      return 'ops-chat@s.whatsapp.net';
    }
    throw new MissingTargetError();
  },
};

describe('prepareTextSend', () => {
  it('prepares raw chat JID sends with default link preview behavior', () => {
    const prepared = prepareTextSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'hi' },
      { chatResolver },
    );

    expect(prepared).toEqual({
      chatJid: 'raw-chat@s.whatsapp.net',
      text: 'hi',
      linkPreviewMode: 'auto',
      audit: {
        targetKind: 'chatJid',
        textLength: 2,
      },
    });
  });

  it('prepares alias sends and preserves link preview opt-out', () => {
    const prepared = prepareTextSend(
      { to: 'ops', text: 'hello ops', link_preview: 'off' },
      { chatResolver },
    );

    expect(prepared).toEqual({
      chatJid: 'ops-chat@s.whatsapp.net',
      text: 'hello ops',
      linkPreviewMode: 'off',
      audit: {
        targetKind: 'alias',
        alias: 'ops',
        textLength: 9,
      },
    });
  });

  it('throws typed errors for invalid request shape and missing text', () => {
    expect(() => prepareTextSend(null, { chatResolver })).toThrow(InvalidSendRequestError);
    expect(() => prepareTextSend({ chatJid: 'raw-chat@s.whatsapp.net' }, { chatResolver }))
      .toThrow(MissingTextError);
  });

  it('rejects invalid link preview modes before resolving the target', () => {
    expect(() => prepareTextSend(
      { to: 'missing', text: 'hi', link_preview: 'full' },
      { chatResolver },
    )).toThrow('link_preview must be "auto" or "off"');
  });

  it('creates a reusable pipeline with the resolver bound once', () => {
    const pipeline = createSendPipeline({ resolver: chatResolver });

    expect(pipeline.prepareSend({ to: 'ops', text: 'hi' })).toMatchObject({
      chatJid: 'ops-chat@s.whatsapp.net',
      text: 'hi',
      linkPreviewMode: 'auto',
    });
  });

  it('rejects unknown profiles before preparing a send', () => {
    expect(() => prepareTextSend(
      { chatJid: 'raw-chat@s.whatsapp.net', text: 'hi', profile: 'missing' },
      { chatResolver, profiles: createProfileRegistry({}) },
    )).toThrow(UnknownProfileError);
  });

  it('preserves current send preparation when no profile is requested', () => {
    const prepared = prepareTextSend(
      { to: 'ops', text: 'hi' },
      { chatResolver, profiles: createProfileRegistry({ satellite: { prefix: '[SAT] ' } }) },
    );

    expect(prepared).toEqual({
      chatJid: 'ops-chat@s.whatsapp.net',
      text: 'hi',
      linkPreviewMode: 'auto',
      audit: {
        targetKind: 'alias',
        alias: 'ops',
        textLength: 2,
      },
    });
  });

  it('creates a reusable pipeline with resolver and profile registry bound once', () => {
    const pipeline = createSendPipeline({
      resolver: chatResolver,
      profiles: createProfileRegistry({
        satellite: { prefix: '[SAT] ', tag: ' #satellite', linkPreview: 'off' },
      }),
    });

    expect(pipeline.prepareSend({ to: 'ops', text: 'hi', profile: 'satellite' })).toEqual({
      chatJid: 'ops-chat@s.whatsapp.net',
      text: '[SAT] hi #satellite',
      linkPreviewMode: 'off',
      audit: {
        targetKind: 'alias',
        alias: 'ops',
        textLength: 19,
      },
    });
  });

  it('lets request link_preview override profile linkPreview', () => {
    const pipeline = createSendPipeline({
      resolver: chatResolver,
      profiles: createProfileRegistry({
        satellite: { prefix: '[SAT] ', linkPreview: 'off' },
      }),
    });

    expect(pipeline.prepareSend({
      to: 'ops',
      text: 'https://example.com',
      profile: 'satellite',
      link_preview: 'auto',
    })).toMatchObject({
      text: '[SAT] https://example.com',
      linkPreviewMode: 'auto',
    });
  });
});
