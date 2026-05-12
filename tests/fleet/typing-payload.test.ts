/**
 * Direct contract-lock for src/fleet/typing-payload.ts.
 *
 * `isTypingHealthEntry(entry)` validates the wire shape of typing-state
 * entries surfaced via the realtime health endpoint:
 *   - `jid` must be a non-empty string (after trim)
 *   - `since` must be a finite number
 *
 * All other shapes (null/undefined/primitives/arrays/wrong field types)
 * must reject. No prior test mirror.
 */
import { describe, expect, it } from 'vitest';
import { isTypingHealthEntry } from '../../src/fleet/typing-payload.ts';

describe('isTypingHealthEntry — valid shapes', () => {
  it('accepts a minimal { jid, since } object', () => {
    expect(isTypingHealthEntry({ jid: '15551234567@s.whatsapp.net', since: 1_700_000_000_000 })).toBe(true);
  });

  it('accepts since = 0 (finite, falsy)', () => {
    expect(isTypingHealthEntry({ jid: 'x', since: 0 })).toBe(true);
  });

  it('accepts since as a negative finite number', () => {
    expect(isTypingHealthEntry({ jid: 'x', since: -1 })).toBe(true);
  });

  it('accepts extra keys (only validates the two required fields)', () => {
    expect(isTypingHealthEntry({ jid: 'x', since: 1, extra: 'ok' })).toBe(true);
  });
});

describe('isTypingHealthEntry — non-object roots', () => {
  it('rejects null', () => {
    expect(isTypingHealthEntry(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isTypingHealthEntry(undefined)).toBe(false);
  });

  it('rejects primitives (string/number/boolean)', () => {
    expect(isTypingHealthEntry('jid')).toBe(false);
    expect(isTypingHealthEntry(42)).toBe(false);
    expect(isTypingHealthEntry(true)).toBe(false);
  });
});

describe('isTypingHealthEntry — invalid jid', () => {
  it('rejects missing jid', () => {
    expect(isTypingHealthEntry({ since: 1 })).toBe(false);
  });

  it('rejects empty-string jid', () => {
    expect(isTypingHealthEntry({ jid: '', since: 1 })).toBe(false);
  });

  it('rejects whitespace-only jid (trim length check)', () => {
    expect(isTypingHealthEntry({ jid: '   ', since: 1 })).toBe(false);
    expect(isTypingHealthEntry({ jid: '\t\n', since: 1 })).toBe(false);
  });

  it('rejects non-string jid (number / null / object)', () => {
    expect(isTypingHealthEntry({ jid: 123, since: 1 })).toBe(false);
    expect(isTypingHealthEntry({ jid: null, since: 1 })).toBe(false);
    expect(isTypingHealthEntry({ jid: {}, since: 1 })).toBe(false);
  });
});

describe('isTypingHealthEntry — invalid since', () => {
  it('rejects missing since', () => {
    expect(isTypingHealthEntry({ jid: 'x' })).toBe(false);
  });

  it('rejects non-number since', () => {
    expect(isTypingHealthEntry({ jid: 'x', since: '1' })).toBe(false);
    expect(isTypingHealthEntry({ jid: 'x', since: null })).toBe(false);
  });

  it('rejects NaN since (non-finite)', () => {
    expect(isTypingHealthEntry({ jid: 'x', since: Number.NaN })).toBe(false);
  });

  it('rejects Infinity / -Infinity since (non-finite)', () => {
    expect(isTypingHealthEntry({ jid: 'x', since: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isTypingHealthEntry({ jid: 'x', since: Number.NEGATIVE_INFINITY })).toBe(false);
  });
});

describe('isTypingHealthEntry — type narrowing', () => {
  it('narrows `unknown` to TypingHealthEntry when true', () => {
    const raw: unknown = { jid: 'peer', since: 1_000 };
    if (isTypingHealthEntry(raw)) {
      // If the guard truly narrowed, `.jid` and `.since` must be typed.
      const jid: string = raw.jid;
      const since: number = raw.since;
      expect(jid).toBe('peer');
      expect(since).toBe(1_000);
    } else {
      throw new Error('expected guard to accept valid shape');
    }
  });
});
