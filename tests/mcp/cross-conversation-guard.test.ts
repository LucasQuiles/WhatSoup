// tests/mcp/cross-conversation-guard.test.ts
//
// Issue 3457: the combined cross-conversation guard. Unit cells for every
// named branch of evaluateTargetConversation, the registry's loud log on a
// binding/mirror divergence, and the fail-closed path when a handler is run
// without the registry callback. The call-site matrix itself lives in
// tests/integration/cross-conversation-guard-matrix.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const { mockWarn, mockError } = vi.hoisted(() => ({ mockWarn: vi.fn(), mockError: vi.fn() }));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: mockWarn,
    error: mockError,
    debug: vi.fn(),
  }),
}));

import { ToolRegistry } from '../helpers/resolved-tool-registry.ts';
import {
  CrossConversationDenied,
  evaluateTargetConversation,
  type ConversationKeyFold,
} from '../../src/mcp/cross-conversation-guard.ts';
import { makeConversationBinding, type SessionContext, type ToolDeclaration } from '../../src/mcp/types.ts';

const ALICE_JID = '15551110001@s.whatsapp.net';
const ALICE_KEY = '15551110001';
const BOB_JID = '15552220002@s.whatsapp.net';
const BOB_KEY = '15552220002';
const ALICE_LID_JID = '11111110001@lid';

/** Fixture fold: ALICE's @lid folds onto her phone; anything without `@` is invalid. */
const fold: ConversationKeyFold = (jid) => {
  if (!jid.includes('@')) throw new Error('invalid jid');
  if (jid === ALICE_LID_JID) return ALICE_KEY;
  return jid.split('@')[0]!;
};

describe('evaluateTargetConversation branches (3457)', () => {
  it('chat-scoped-injected-target: admits a chat-scoped session without folding', () => {
    const throwingFold: ConversationKeyFold = () => { throw new Error('must not fold'); };
    const verdict = evaluateTargetConversation(
      { tier: 'chat-scoped', conversationKey: ALICE_KEY, deliveryJid: ALICE_JID },
      BOB_JID,
      throwingFold,
    );
    expect(verdict).toEqual({ kind: 'admit', branch: 'chat-scoped-injected-target' });
  });

  it('unconfined-global-session: admits an unbound global session with no conversationKey (M5 fail-open, kept)', () => {
    expect(evaluateTargetConversation({ tier: 'global' }, BOB_JID, fold))
      .toEqual({ kind: 'admit', branch: 'unconfined-global-session' });
    expect(evaluateTargetConversation({ tier: 'global', conversationKey: '' }, BOB_JID, fold))
      .toEqual({ kind: 'admit', branch: 'unconfined-global-session' });
  });

  it('target-matches-conversation: admits an unbound pinned session addressing its own conversation', () => {
    expect(evaluateTargetConversation({ tier: 'global', conversationKey: ALICE_KEY }, ALICE_LID_JID, fold))
      .toEqual({ kind: 'admit', branch: 'target-matches-conversation' });
  });

  it('foreign-conversation: denies an unbound pinned session on authorization', () => {
    const verdict = evaluateTargetConversation({ tier: 'global', conversationKey: ALICE_KEY }, BOB_JID, fold);
    expect(verdict).toMatchObject({
      kind: 'deny',
      branch: 'foreign-conversation',
      failureCode: 'authorization_denied',
      failureStage: 'authorization',
      text: `chatJid "${BOB_JID}" resolves to conversation "${BOB_KEY}" which does not match session conversation "${ALICE_KEY}"`,
    });
  });

  it('invalid-target-jid: denies a JID the fold rejects on validation', () => {
    expect(evaluateTargetConversation({ tier: 'global', conversationKey: ALICE_KEY }, 'not-a-jid', fold))
      .toMatchObject({
        kind: 'deny',
        branch: 'invalid-target-jid',
        failureCode: 'validation_rejected',
        failureStage: 'validation',
        text: 'Invalid chatJid "not-a-jid": must be a valid JID',
      });
  });

  it('binding-mirror-divergence: denies a bound session whose mirror names another conversation (owner decision 27)', () => {
    const session: SessionContext = {
      tier: 'global',
      conversationKey: BOB_KEY,
      binding: makeConversationBinding(ALICE_KEY, ALICE_JID),
    };
    const verdict = evaluateTargetConversation(session, ALICE_JID, fold);
    expect(verdict).toMatchObject({
      kind: 'deny',
      branch: 'binding-mirror-divergence',
      failureCode: 'authorization_denied',
      failureStage: 'authorization',
      divergence: {
        bindingConversationKey: ALICE_KEY,
        bindingDeliveryJid: ALICE_JID,
        bindingFoldedKey: ALICE_KEY,
        mirrorConversationKey: BOB_KEY,
      },
    });
  });

  it('a bound session compares folds, not stored strings: a raw @lid binding key with its phone-folded mirror is NOT a divergence', () => {
    const session: SessionContext = {
      tier: 'global',
      conversationKey: ALICE_KEY,
      binding: makeConversationBinding('11111110001', ALICE_LID_JID),
    };
    expect(evaluateTargetConversation(session, ALICE_LID_JID, fold))
      .toEqual({ kind: 'admit', branch: 'target-matches-conversation' });
  });

  it('a bound session with no mirror enforces the binding: a target outside it is denied as foreign', () => {
    const session: SessionContext = { tier: 'global', binding: makeConversationBinding(ALICE_KEY, ALICE_JID) };
    expect(evaluateTargetConversation(session, ALICE_JID, fold))
      .toEqual({ kind: 'admit', branch: 'target-matches-conversation' });
    expect(evaluateTargetConversation(session, BOB_JID, fold))
      .toMatchObject({ kind: 'deny', branch: 'foreign-conversation', failureCode: 'authorization_denied' });
  });
});

// ---------------------------------------------------------------------------
// Registry wiring: logging and the post-resolution callback.
// ---------------------------------------------------------------------------

/** A handler that resolves its own target, like send_message resolving an alias. */
function selfResolvingTool(resolvedJid: string, dispatched: string[]): ToolDeclaration {
  return {
    name: 'self_resolving_send',
    description: 'fixture: resolves its own target, then asks the registry guard',
    // `to` makes the registry treat this as an alias-capable tool, so a global
    // session may call it without a chatJid and reach the handler.
    schema: z.object({ chatJid: z.string().optional(), to: z.string().optional(), text: z.string() }),
    scope: 'chat',
    targetMode: 'injected',
    handler: async (_params, _session, _bond, assertTargetConversation) => {
      assertTargetConversation!(resolvedJid);
      dispatched.push(resolvedJid);
      return { sent: true };
    },
  };
}

describe('ToolRegistry cross-conversation guard wiring (3457)', () => {
  let registry: ToolRegistry;
  let dispatched: string[];

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.setCanonicalConversationKeyResolver(fold);
    dispatched = [];
    mockWarn.mockClear();
    mockError.mockClear();
  });

  it('logs a binding/mirror divergence at ERROR level with both keys, and denies (fail-closed)', async () => {
    registry.register(selfResolvingTool(ALICE_JID, dispatched));
    const result = await registry.call('self_resolving_send', { text: 'hi' }, {
      tier: 'global',
      conversationKey: BOB_KEY,
      binding: makeConversationBinding(ALICE_KEY, ALICE_JID),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not match the conversation binding');
    expect(dispatched).toHaveLength(0);
    expect(mockError).toHaveBeenCalledTimes(1);
    const [fields, message] = mockError.mock.calls[0]!;
    expect(message).toMatch(/binding and its session mirror disagree/);
    expect(fields).toMatchObject({
      tool: 'self_resolving_send',
      point: 'post-resolution',
      branch: 'binding-mirror-divergence',
      bindingConversationKey: ALICE_KEY,
      mirrorConversationKey: BOB_KEY,
      targetJid: ALICE_JID,
    });
  });

  it('logs an ordinary foreign-conversation denial at WARN, not ERROR', async () => {
    registry.register(selfResolvingTool(BOB_JID, dispatched));
    const result = await registry.call('self_resolving_send', { to: 'bob', text: 'hi' }, {
      tier: 'global',
      conversationKey: ALICE_KEY,
    });

    expect(result.isError).toBe(true);
    expect(dispatched).toHaveLength(0);
    expect(mockError).not.toHaveBeenCalled();
    const guardWarn = mockWarn.mock.calls.find(([, msg]) => msg === 'cross-conversation guard denied tool target');
    expect(guardWarn?.[0]).toMatchObject({ point: 'post-resolution', branch: 'foreign-conversation', targetJid: BOB_JID });
  });

  it('the pre-handler point and the post-resolution point answer a foreign target with the identical text', async () => {
    registry.register(selfResolvingTool(BOB_JID, dispatched));
    const session: SessionContext = { tier: 'global', conversationKey: ALICE_KEY };

    const preHandler = await registry.call('self_resolving_send', { chatJid: BOB_JID, text: 'hi' }, session);
    const postResolution = await registry.call('self_resolving_send', { to: 'bob', text: 'hi' }, session);

    expect(preHandler.isError).toBe(true);
    expect(postResolution.isError).toBe(true);
    expect(postResolution.content[0].text).toBe(preHandler.content[0].text);
    expect(dispatched).toHaveLength(0);
  });

  it('CrossConversationDenied carries the verdict it was built from', () => {
    const verdict = evaluateTargetConversation({ tier: 'global', conversationKey: ALICE_KEY }, BOB_JID, fold);
    if (verdict.kind !== 'deny') throw new Error('expected a deny verdict');
    const err = new CrossConversationDenied(verdict);
    expect(err.message).toBe(verdict.text);
    expect(err.verdict).toBe(verdict);
  });
});
