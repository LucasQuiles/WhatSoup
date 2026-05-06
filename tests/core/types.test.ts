import { describe, it, expect, expectTypeOf } from 'vitest';
import type { Messenger, IncomingMessage, RuntimeHealth, SubmissionReceipt } from '../../src/core/types.ts';

describe('core types', () => {
  it('Messenger has sendMessage method', () => {
    expectTypeOf<Messenger>().toHaveProperty('sendMessage');
    const messenger: Messenger = {
      sendMessage: async () => ({ waMessageId: 'msg-1' }),
      sendMedia: async () => ({ waMessageId: null }),
    };
    expect(typeof messenger.sendMessage).toBe('function');
  });
  it('IncomingMessage has required fields', () => {
    expectTypeOf<IncomingMessage>().toHaveProperty('messageId');
    expectTypeOf<IncomingMessage>().toHaveProperty('chatJid');
    expectTypeOf<IncomingMessage>().toHaveProperty('isResponseWorthy');
    const message: IncomingMessage = {
      messageId: 'wamid.1',
      chatJid: '15550100001@s.whatsapp.net',
      senderJid: '15550100001@s.whatsapp.net',
      senderName: null,
      content: 'hello',
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      isGroup: false,
      mentionedJids: [],
      timestamp: 1,
      quotedMessageId: null,
      isResponseWorthy: true,
    };
    expect(message).toMatchObject({
      messageId: 'wamid.1',
      chatJid: '15550100001@s.whatsapp.net',
      isResponseWorthy: true,
    });
  });
  it('RuntimeHealth has status and details', () => {
    expectTypeOf<RuntimeHealth>().toHaveProperty('status');
    expectTypeOf<RuntimeHealth>().toHaveProperty('details');
    const health: RuntimeHealth = { status: 'healthy', details: { transport: 'ready' } };
    expect(health).toEqual({ status: 'healthy', details: { transport: 'ready' } });
  });
  it('SubmissionReceipt has waMessageId field', () => {
    expectTypeOf<SubmissionReceipt>().toHaveProperty('waMessageId');
    const receipt: SubmissionReceipt = { waMessageId: 'ABC123' };
    expect(receipt).toHaveProperty('waMessageId', 'ABC123');
  });
  it('SubmissionReceipt waMessageId is string or null', () => {
    const receipt: SubmissionReceipt = { waMessageId: null };
    expect(receipt.waMessageId).toBeNull();
    const receiptWithId: SubmissionReceipt = { waMessageId: 'ABC123' };
    expect(receiptWithId.waMessageId).toBe('ABC123');
  });
  it('Messenger sendMessage returns SubmissionReceipt', async () => {
    expectTypeOf<Messenger['sendMessage']>().returns.resolves.toMatchTypeOf<SubmissionReceipt>();
    const sendMessage: Messenger['sendMessage'] = async () => ({ waMessageId: 'wamid.1' });
    await expect(sendMessage('15550100001@s.whatsapp.net', 'hello')).resolves.toEqual({ waMessageId: 'wamid.1' });
  });
  it('Messenger sendMedia returns SubmissionReceipt', async () => {
    expectTypeOf<Messenger['sendMedia']>().returns.resolves.toMatchTypeOf<SubmissionReceipt>();
    const sendMedia: Messenger['sendMedia'] = async () => ({ waMessageId: null });
    await expect(sendMedia('15550100001@s.whatsapp.net', { type: 'image', buffer: Buffer.from('') })).resolves.toEqual({ waMessageId: null });
  });
});
