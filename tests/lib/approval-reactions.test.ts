import { describe, expect, it } from 'vitest';

import { createApprovalReactionStore } from '../../src/lib/approval-reactions.ts';

describe('createApprovalReactionStore — registration', () => {
  it('registers and looks up a target', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a1',
      conversationKey: 'c1',
      messageId: 'm1',
      authorizedApprovers: ['admin'],
      actionId: 'act-1',
    });
    const target = store.lookup('a1', 'c1', 'm1');
    expect(target).toBeDefined();
    expect(target?.actionId).toBe('act-1');
    expect(target?.authorizedApprovers).toEqual(['admin']);
  });

  it('overwrites an existing target on re-register', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['u1'],
      actionId: 'old',
    });
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['u1', 'u2'],
      actionId: 'new',
    });
    const target = store.lookup('a', 'c', 'm');
    expect(target?.actionId).toBe('new');
    expect(target?.authorizedApprovers).toEqual(['u1', 'u2']);
  });

  it('ignores register with empty accountId', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: '',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['u'],
      actionId: 'x',
    });
    expect(store.size()).toBe(0);
  });

  it('ignores register with empty conversationKey', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: '',
      messageId: 'm',
      authorizedApprovers: ['u'],
      actionId: 'x',
    });
    expect(store.size()).toBe(0);
  });

  it('ignores register with empty messageId', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: '',
      authorizedApprovers: ['u'],
      actionId: 'x',
    });
    expect(store.size()).toBe(0);
  });

  it('isolates targets by accountId', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a1',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['u'],
      actionId: 'one',
    });
    store.register({
      accountId: 'a2',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['u'],
      actionId: 'two',
    });
    expect(store.lookup('a1', 'c', 'm')?.actionId).toBe('one');
    expect(store.lookup('a2', 'c', 'm')?.actionId).toBe('two');
  });

  it('isolates targets by conversationKey', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'c1',
      messageId: 'm',
      authorizedApprovers: ['u'],
      actionId: 'x',
    });
    expect(store.lookup('a', 'c2', 'm')).toBeUndefined();
  });

  it('isolates targets by messageId', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm1',
      authorizedApprovers: ['u'],
      actionId: 'x',
    });
    expect(store.lookup('a', 'c', 'm2')).toBeUndefined();
  });
});

describe('unregister', () => {
  it('removes a target and returns true', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['u'],
      actionId: 'x',
    });
    expect(store.unregister('a', 'c', 'm')).toBe(true);
    expect(store.lookup('a', 'c', 'm')).toBeUndefined();
  });

  it('returns false for a missing target', () => {
    const store = createApprovalReactionStore();
    expect(store.unregister('a', 'c', 'm')).toBe(false);
  });
});

describe('resolve — approval', () => {
  it('resolves 👍 from an authorized approver as approved', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['admin'],
      actionId: 'act',
    });
    const result = store.resolve({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      reactorId: 'admin',
      emoji: '👍',
    });
    expect(result).toEqual({
      decision: 'approved',
      approverId: 'admin',
      target: expect.objectContaining({ actionId: 'act' }),
    });
  });

  it('resolves 👎 from an authorized approver as denied', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['admin'],
      actionId: 'act',
    });
    const result = store.resolve({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      reactorId: 'admin',
      emoji: '👎',
    });
    expect(result?.decision).toBe('denied');
  });

  it('returns null for an unauthorized reactor', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['admin'],
      actionId: 'act',
    });
    const result = store.resolve({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      reactorId: 'intruder',
      emoji: '👍',
    });
    expect(result).toBeNull();
  });

  it('returns null for an unrecognized emoji', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['admin'],
      actionId: 'act',
    });
    const result = store.resolve({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      reactorId: 'admin',
      emoji: '🎉',
    });
    expect(result).toBeNull();
  });

  it('returns null when target is missing', () => {
    const store = createApprovalReactionStore();
    const result = store.resolve({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'missing',
      reactorId: 'admin',
      emoji: '👍',
    });
    expect(result).toBeNull();
  });

  it('returns null when target has expired', () => {
    let clock = 0;
    const store = createApprovalReactionStore({ ttlMs: 1000, now: () => clock });
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['admin'],
      actionId: 'act',
    });
    clock += 2000;
    const result = store.resolve({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      reactorId: 'admin',
      emoji: '👍',
    });
    expect(result).toBeNull();
  });

  it('supports multiple authorized approvers', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['admin1', 'admin2', 'admin3'],
      actionId: 'act',
    });
    for (const approver of ['admin1', 'admin2', 'admin3']) {
      const result = store.resolve({
        accountId: 'a',
        conversationKey: 'c',
        messageId: 'm',
        reactorId: approver,
        emoji: '👍',
      });
      expect(result?.decision).toBe('approved');
    }
  });
});

describe('custom emoji configuration', () => {
  it('respects custom approve/deny emoji', () => {
    const store = createApprovalReactionStore({ approveEmoji: '✅', denyEmoji: '❌' });
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['u'],
      actionId: 'x',
    });
    expect(
      store.resolve({
        accountId: 'a',
        conversationKey: 'c',
        messageId: 'm',
        reactorId: 'u',
        emoji: '✅',
      })?.decision,
    ).toBe('approved');
    expect(
      store.resolve({
        accountId: 'a',
        conversationKey: 'c',
        messageId: 'm',
        reactorId: 'u',
        emoji: '❌',
      })?.decision,
    ).toBe('denied');
    // Default emoji no longer matches.
    expect(
      store.resolve({
        accountId: 'a',
        conversationKey: 'c',
        messageId: 'm',
        reactorId: 'u',
        emoji: '👍',
      }),
    ).toBeNull();
  });
});

describe('TTL expiry', () => {
  it('expires targets after ttlMs', () => {
    let clock = 1_000;
    const store = createApprovalReactionStore({ ttlMs: 500, now: () => clock });
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['u'],
      actionId: 'x',
    });
    expect(store.lookup('a', 'c', 'm')).toBeDefined();
    clock += 499;
    expect(store.lookup('a', 'c', 'm')).toBeDefined();
    clock += 2;
    expect(store.lookup('a', 'c', 'm')).toBeUndefined();
  });

  it('size() purges expired entries', () => {
    let clock = 0;
    const store = createApprovalReactionStore({ ttlMs: 100, now: () => clock });
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm1',
      authorizedApprovers: ['u'],
      actionId: 'x',
    });
    clock += 200;
    expect(store.size()).toBe(0);
  });
});

describe('capacity eviction', () => {
  it('evicts oldest entry when maxEntries reached', () => {
    let clock = 0;
    const store = createApprovalReactionStore({ maxEntries: 2, now: () => clock });
    clock = 100;
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm1',
      authorizedApprovers: ['u'],
      actionId: '1',
    });
    clock = 200;
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm2',
      authorizedApprovers: ['u'],
      actionId: '2',
    });
    clock = 300;
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm3',
      authorizedApprovers: ['u'],
      actionId: '3',
    });
    expect(store.lookup('a', 'c', 'm1')).toBeUndefined();
    expect(store.lookup('a', 'c', 'm2')?.actionId).toBe('2');
    expect(store.lookup('a', 'c', 'm3')?.actionId).toBe('3');
  });

  it('does not evict on overwrite', () => {
    const store = createApprovalReactionStore({ maxEntries: 2 });
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm1',
      authorizedApprovers: ['u'],
      actionId: '1',
    });
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm2',
      authorizedApprovers: ['u'],
      actionId: '2',
    });
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm2',
      authorizedApprovers: ['u'],
      actionId: '2-updated',
    });
    expect(store.lookup('a', 'c', 'm1')?.actionId).toBe('1');
    expect(store.lookup('a', 'c', 'm2')?.actionId).toBe('2-updated');
  });

  it('uses default maxEntries of 1000', () => {
    const store = createApprovalReactionStore();
    for (let i = 0; i < 1100; i++) {
      store.register({
        accountId: 'a',
        conversationKey: 'c',
        messageId: `m${i}`,
        authorizedApprovers: ['u'],
        actionId: String(i),
      });
    }
    expect(store.lookup('a', 'c', 'm50')).toBeUndefined();
    expect(store.lookup('a', 'c', 'm100')?.actionId).toBe('100');
  });
});

describe('clear', () => {
  it('removes all targets', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm1',
      authorizedApprovers: ['u'],
      actionId: '1',
    });
    store.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm2',
      authorizedApprovers: ['u'],
      actionId: '2',
    });
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.lookup('a', 'c', 'm1')).toBeUndefined();
  });
});

describe('independent instances', () => {
  it('separate stores do not share state', () => {
    const s1 = createApprovalReactionStore();
    const s2 = createApprovalReactionStore();
    s1.register({
      accountId: 'a',
      conversationKey: 'c',
      messageId: 'm',
      authorizedApprovers: ['u'],
      actionId: 'from-s1',
    });
    expect(s2.lookup('a', 'c', 'm')).toBeUndefined();
    expect(s1.lookup('a', 'c', 'm')?.actionId).toBe('from-s1');
  });
});

describe('multi-JID approval', () => {
  it('the same action can be registered against multiple messages', () => {
    const store = createApprovalReactionStore();
    store.register({
      accountId: 'a',
      conversationKey: 'admin-chat',
      messageId: 'm1',
      authorizedApprovers: ['admin'],
      actionId: 'shared-act',
    });
    store.register({
      accountId: 'a',
      conversationKey: 'ops-chat',
      messageId: 'm2',
      authorizedApprovers: ['admin'],
      actionId: 'shared-act',
    });
    // Admin reacts in either chat.
    expect(
      store.resolve({
        accountId: 'a',
        conversationKey: 'admin-chat',
        messageId: 'm1',
        reactorId: 'admin',
        emoji: '👍',
      })?.decision,
    ).toBe('approved');
    expect(
      store.resolve({
        accountId: 'a',
        conversationKey: 'ops-chat',
        messageId: 'm2',
        reactorId: 'admin',
        emoji: '👍',
      })?.decision,
    ).toBe('approved');
  });
});
