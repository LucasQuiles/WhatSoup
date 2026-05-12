import { describe, expect, it } from 'vitest';
import { isTypingHealthEntry } from '../../src/fleet/typing-payload.ts';

describe('isTypingHealthEntry', () => {
  it('accepts entries with a non-empty jid and finite since timestamp', () => {
    expect(isTypingHealthEntry({ jid: '15551234567@s.whatsapp.net', since: 1778547000000 })).toBe(true);
  });

  it('rejects nullish and non-object values', () => {
    expect(isTypingHealthEntry(null)).toBe(false);
    expect(isTypingHealthEntry(undefined)).toBe(false);
    expect(isTypingHealthEntry('typing')).toBe(false);
  });

  it('rejects missing, blank, or non-string jids', () => {
    expect(isTypingHealthEntry({ since: 1 })).toBe(false);
    expect(isTypingHealthEntry({ jid: '   ', since: 1 })).toBe(false);
    expect(isTypingHealthEntry({ jid: 15551234567, since: 1 })).toBe(false);
  });

  it('rejects missing, non-number, or non-finite since values', () => {
    expect(isTypingHealthEntry({ jid: '15551234567@s.whatsapp.net' })).toBe(false);
    expect(isTypingHealthEntry({ jid: '15551234567@s.whatsapp.net', since: '1' })).toBe(false);
    expect(isTypingHealthEntry({ jid: '15551234567@s.whatsapp.net', since: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isTypingHealthEntry({ jid: '15551234567@s.whatsapp.net', since: Number.NaN })).toBe(false);
  });
});
