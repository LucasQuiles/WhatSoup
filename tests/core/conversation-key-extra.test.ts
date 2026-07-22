/**
 * Supplemental tests for src/core/conversation-key.ts
 *
 * Existing tests/core/conversation-key.test.ts covers toConversationKey.
 * These tests add coverage for:
 *   - isGroupConversationKey (completely uncovered — 0% function coverage)
 *   - conversationKeyToJid   (completely uncovered — 0% function coverage)
 *   - toConversationKey falsy-branch: the binary-expr at line 12
 *     (!jid || !jid.includes('@')) — the first operand (!jid, i.e. empty string)
 *     is already hit by the existing "throws on empty string" test, BUT the
 *     function itself shows 66.66% function coverage, which means the existing
 *     test file imports only toConversationKey and the other two exports are
 *     never called.  Add them here.
 *
 * Zero mocks — these are pure string functions.
 */

import { describe, it, expect } from 'vitest';
import {
  isGroupConversationKey,
  conversationKeyToJid,
  toConversationKey,
} from '../../src/core/conversation-key.ts';

// ─── isGroupConversationKey ───────────────────────────────────────────────────

describe('isGroupConversationKey', () => {
  it('returns true for the canonical _at_g.us key form', () => {
    expect(isGroupConversationKey('120363555555550001_at_g.us')).toBe(true);
  });

  it('returns true when the raw @g.us JID form is used', () => {
    // Some callers may pass raw JIDs (e.g. chat_jid column) before conversion
    expect(isGroupConversationKey('120363555555550001@g.us')).toBe(true);
  });

  it('returns true for normalized Signal and iMessage group keys', () => {
    expect(isGroupConversationKey('Z3JvdXAtY29udmVyc2F0aW9u_at_signal')).toBe(true);
    expect(isGroupConversationKey('iMessage;+;chatABC_at_imessage')).toBe(true);
  });

  it('returns false for a personal conversation key (bare phone number)', () => {
    expect(isGroupConversationKey('15550100001')).toBe(false);
  });

  it('returns false for a LID key', () => {
    expect(isGroupConversationKey('81536414179557')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isGroupConversationKey('')).toBe(false);
  });

  it('returns false for an unknown domain key', () => {
    expect(isGroupConversationKey('unknown_at_broadcast')).toBe(false);
  });
});

// ─── conversationKeyToJid ────────────────────────────────────────────────────

describe('conversationKeyToJid', () => {
  it('converts _at_g.us back to @g.us JID', () => {
    expect(conversationKeyToJid('120363555555550001_at_g.us')).toBe('120363555555550001@g.us');
  });

  it('is a no-op for personal keys (no _at_g.us present)', () => {
    // Personal keys are bare phone numbers — no transformation needed
    expect(conversationKeyToJid('15550100001')).toBe('15550100001');
  });

  it('restores unknown-domain keys through the transport-neutral encoding', () => {
    expect(conversationKeyToJid('unknown_at_broadcast')).toBe('unknown@broadcast');
  });

  it('is idempotent when called on a key that already has @g.us', () => {
    // If for some reason the raw JID ends up as input, it passes through unchanged
    // (no _at_g.us to replace)
    expect(conversationKeyToJid('120363555555550001@g.us')).toBe('120363555555550001@g.us');
  });
});

// ─── toConversationKey — additional branch coverage ───────────────────────────

describe('toConversationKey — branch completeness', () => {
  it('throws when jid is falsy (empty string) — covers first arm of binary-expr', () => {
    // Line 12: if (!jid || !jid.includes('@'))
    // The existing test covers the empty string case, but add it here too for
    // completeness within this supplemental file.
    expect(() => toConversationKey('')).toThrow(/Invalid JID/);
  });

  it('throws when jid has no @ — covers second arm of binary-expr at line 12', () => {
    expect(() => toConversationKey('nojid')).toThrow(/Invalid JID/);
  });

  it('throws when local part is empty (jid starts with @)', () => {
    // Line 18: empty local part check
    expect(() => toConversationKey('@s.whatsapp.net')).toThrow(/Invalid JID/);
  });
});
