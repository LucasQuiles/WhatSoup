// tests/transport/contract/capabilities.test.ts
import { describe, it, expect } from 'vitest';
import {
  type Capabilities, type IdempotencyDeclaration, type ExtensionName,
  ALL_EXTENSION_NAMES,
} from '../../../src/transport/contract/capabilities.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';

describe('Capabilities', () => {
  it('declares all spec-1 extension names', () => {
    expect(ALL_EXTENSION_NAMES).toEqual([
      'media', 'voice-notes', 'reactions', 'edit', 'delete',
      'typing', 'presence', 'groups', 'read-receipts',
      'inline-keyboards', 'outbound-status',
    ]);
  });

  it('shape: Capabilities object can be constructed', () => {
    const idem: IdempotencyDeclaration = {
      sendText: 'none', sendMedia: 'none', react: 'none',
      editText: 'none', delete: 'none',
    };
    const caps: Capabilities = {
      channel: makeChannelId('whatsapp', 'test'),
      kind: 'whatsapp',
      extensions: new Set<ExtensionName>(['media', 'reactions']),
      maxTextLength: 65536,
      auth: 'qr',
      readReceipts: 'message',
      reactions: 'multiple',
      media: { maxBytes: 64 * 1024 * 1024, mimeAllowlist: ['image/jpeg'] },
      idempotency: idem,
    };
    expect(caps.extensions.has('media')).toBe(true);
    expect(caps.idempotency.sendText).toBe('none');
  });
});
