import { describe, it, expect } from 'vitest';
import { resolveAgentModel } from '../../src/core/agent-model.ts';

/**
 * Ownership test for resolveAgentModel precedence (B27 fix 1, 3d7d81344).
 *
 * Before this file, the ordering had no test that OWNED it — only consumers
 * (instance-loader, fleet provider-status) that INCIDENTALLY depended on it,
 * which is why the B27 flip surfaced as a downstream merge failure instead of
 * a deliberate break. This asserts the ordering directly so the next flip
 * breaks something on purpose.
 *
 * Precedence (most agent-scoped first):
 *   1. agentOptions.model   2. top-level model   3. models.conversation
 *
 * Presence rule: a value counts only when it is a non-empty, non-whitespace
 * string. Precedence bugs concentrate at "is this layer present?" — an empty
 * string that read as present is exactly how a pin gets outranked by nothing —
 * so the absent forms (undefined / null / '' / '   ' / non-string) are pinned
 * explicitly at each tier.
 */
describe('resolveAgentModel precedence ownership', () => {
  describe('ordering when multiple tiers are present', () => {
    it('agentOptions.model wins over top-level model and models.conversation', () => {
      expect(
        resolveAgentModel({
          agentOptions: { model: 'agent-scoped' },
          model: 'top-level',
          models: { conversation: 'conversation-role' },
        }),
      ).toBe('agent-scoped');
    });

    it('top-level model wins over models.conversation when agentOptions.model is absent', () => {
      expect(
        resolveAgentModel({
          model: 'top-level',
          models: { conversation: 'conversation-role' },
        }),
      ).toBe('top-level');
    });

    it('models.conversation is the floor when nothing more specific is set', () => {
      expect(resolveAgentModel({ models: { conversation: 'conversation-role' } })).toBe('conversation-role');
    });
  });

  describe('agentOptions.model absent forms fall through to the next tier', () => {
    // Each case sets a distinct top-level model so the fall-through target is
    // unambiguous: if agentOptions.model were wrongly treated as present, the
    // result would not be 'top-level'.
    it('undefined agentOptions.model falls through', () => {
      expect(resolveAgentModel({ agentOptions: { model: undefined }, model: 'top-level' })).toBe('top-level');
    });

    it('null agentOptions.model falls through', () => {
      expect(resolveAgentModel({ agentOptions: { model: null }, model: 'top-level' })).toBe('top-level');
    });

    it('empty-string agentOptions.model falls through (does NOT outrank with nothing)', () => {
      expect(resolveAgentModel({ agentOptions: { model: '' }, model: 'top-level' })).toBe('top-level');
    });

    it('whitespace-only agentOptions.model falls through', () => {
      expect(resolveAgentModel({ agentOptions: { model: '   ' }, model: 'top-level' })).toBe('top-level');
    });

    it('non-string agentOptions.model falls through', () => {
      expect(resolveAgentModel({ agentOptions: { model: 42 }, model: 'top-level' })).toBe('top-level');
    });

    it('missing agentOptions object entirely falls through', () => {
      expect(resolveAgentModel({ model: 'top-level' })).toBe('top-level');
    });
  });

  describe('top-level model absent forms fall through to models.conversation', () => {
    it('empty-string top-level model falls through', () => {
      expect(resolveAgentModel({ model: '', models: { conversation: 'conversation-role' } })).toBe('conversation-role');
    });

    it('whitespace-only top-level model falls through', () => {
      expect(resolveAgentModel({ model: '  ', models: { conversation: 'conversation-role' } })).toBe('conversation-role');
    });

    it('non-string top-level model falls through', () => {
      expect(resolveAgentModel({ model: 7, models: { conversation: 'conversation-role' } })).toBe('conversation-role');
    });
  });

  describe('models.conversation absent forms yield undefined', () => {
    it('empty-string models.conversation yields undefined', () => {
      expect(resolveAgentModel({ models: { conversation: '' } })).toBeUndefined();
    });

    it('non-string models.conversation yields undefined', () => {
      expect(resolveAgentModel({ models: { conversation: 99 } })).toBeUndefined();
    });
  });

  describe('nothing set', () => {
    it('empty config yields undefined', () => {
      expect(resolveAgentModel({})).toBeUndefined();
    });

    it('null config yields undefined', () => {
      expect(resolveAgentModel(null)).toBeUndefined();
    });

    it('undefined config yields undefined', () => {
      expect(resolveAgentModel(undefined)).toBeUndefined();
    });
  });
});
