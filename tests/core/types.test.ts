import { describe, it, expect, expectTypeOf } from 'vitest';
import type { Messenger, IncomingMessage, RuntimeHealth, SubmissionReceipt } from '../../src/core/types.ts';

describe('core types', () => {
  it('Messenger has sendMessage method', () => {
    expectTypeOf<Messenger>().toHaveProperty('sendMessage');
  });
  it('IncomingMessage has required fields', () => {
    expectTypeOf<IncomingMessage>().toHaveProperty('messageId');
    expectTypeOf<IncomingMessage>().toHaveProperty('chatJid');
    expectTypeOf<IncomingMessage>().toHaveProperty('isResponseWorthy');
  });
  it('RuntimeHealth has status and details', () => {
    expectTypeOf<RuntimeHealth>().toHaveProperty('status');
    expectTypeOf<RuntimeHealth>().toHaveProperty('details');
  });
  it('SubmissionReceipt has waMessageId field', () => {
    expectTypeOf<SubmissionReceipt>().toHaveProperty('waMessageId');
  });
  it('SubmissionReceipt waMessageId is string or null', () => {
    const receipt: SubmissionReceipt = { waMessageId: null };
    expect(receipt.waMessageId).toBeNull();
    const receiptWithId: SubmissionReceipt = { waMessageId: 'ABC123' };
    expect(receiptWithId.waMessageId).toBe('ABC123');
  });
  it('Messenger sendMessage returns SubmissionReceipt', () => {
    expectTypeOf<Messenger['sendMessage']>().returns.resolves.toMatchTypeOf<SubmissionReceipt>();
  });
  it('Messenger sendMedia returns SubmissionReceipt', () => {
    expectTypeOf<Messenger['sendMedia']>().returns.resolves.toMatchTypeOf<SubmissionReceipt>();
  });
});
