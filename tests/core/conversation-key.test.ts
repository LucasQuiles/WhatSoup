import { describe, it, expect } from 'vitest';
import { toConversationKey } from '../../src/core/conversation-key.ts';

describe('toConversationKey', () => {
  it('normalizes @s.whatsapp.net DM to bare phone', () => {
    expect(toConversationKey('18459780919@s.whatsapp.net')).toBe('18459780919');
  });

  it('normalizes @lid DM to numeric ID without device qualifier', () => {
    expect(toConversationKey('81536414179557:42@lid')).toBe('81536414179557');
  });

  it('normalizes @lid DM without device qualifier', () => {
    expect(toConversationKey('81536414179557@lid')).toBe('81536414179557');
  });

  it('normalizes @g.us group to _at_g.us form', () => {
    expect(toConversationKey('120363123456789@g.us')).toBe('120363123456789_at_g.us');
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
});
