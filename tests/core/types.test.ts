import { describe, it, expectTypeOf } from 'vitest';
import type { Messenger, IncomingMessage, RuntimeHealth } from '../../src/core/types.ts';

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
});
