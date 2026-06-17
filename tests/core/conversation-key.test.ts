import { describe, it, expect } from 'vitest';
import {
  conversationKeyToJid,
  isGroupConversationKey,
  toConversationKey,
} from '../../src/core/conversation-key.ts';

describe('toConversationKey', () => {
  it('normalizes @s.whatsapp.net DM to bare phone', () => {
    expect(toConversationKey('15550100001@s.whatsapp.net')).toBe('15550100001');
  });

  it('normalizes @lid DM to numeric ID without device qualifier', () => {
    expect(toConversationKey('81536414179557:42@lid')).toBe('81536414179557');
  });

  it('normalizes @lid DM without device qualifier', () => {
    expect(toConversationKey('81536414179557@lid')).toBe('81536414179557');
  });

  it('normalizes @g.us group to _at_g.us form', () => {
    expect(toConversationKey('group-alpha@g.us')).toBe('group-alpha_at_g.us');
  });

  it('handles unknown suffix by stripping domain', () => {
    expect(toConversationKey('unknown@broadcast')).toBe('unknown_at_broadcast');
  });

  it('throws on empty string', () => {
    expect(() => toConversationKey('')).toThrow();
  });

  it('throws on string without @', () => {
    expect(() => toConversationKey('nojid')).toThrow();
  });

  it('throws when the local part is empty', () => {
    expect(() => toConversationKey('@s.whatsapp.net')).toThrow(/empty local part/);
  });
});

describe('isGroupConversationKey', () => {
  it('detects normalized and raw group conversation keys', () => {
    expect(isGroupConversationKey('group-alpha_at_g.us')).toBe(true);
    expect(isGroupConversationKey('group-alpha@g.us')).toBe(true);
  });

  it('does not classify personal or non-group keys as groups', () => {
    expect(isGroupConversationKey('15550100001')).toBe(false);
    expect(isGroupConversationKey('broadcast_at_broadcast')).toBe(false);
  });
});

describe('conversationKeyToJid', () => {
  it('converts normalized group keys back to group JIDs', () => {
    expect(conversationKeyToJid('group-alpha_at_g.us')).toBe('group-alpha@g.us');
  });

  it('leaves non-group keys unchanged', () => {
    expect(conversationKeyToJid('15550100001')).toBe('15550100001');
    expect(conversationKeyToJid('broadcast_at_broadcast')).toBe('broadcast_at_broadcast');
  });
});
