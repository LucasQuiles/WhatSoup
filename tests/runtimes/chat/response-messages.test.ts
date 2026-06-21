import { describe, it, expect } from 'vitest';
import { chatFailureMessage, type ChatFailureCause } from '../../../src/runtimes/chat/response-messages.ts';

describe('chatFailureMessage (#1064)', () => {
  const causes: ChatFailureCause[] = ['auth', 'rate-limited', 'transient', 'outage'];

  it('returns a non-empty, deterministic message for every cause', () => {
    for (const cause of causes) {
      const msg = chatFailureMessage(cause);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
      // deterministic: same input → identical output
      expect(chatFailureMessage(cause)).toBe(msg);
    }
  });

  it('gives each cause a distinct message (no generic collapse)', () => {
    const messages = causes.map((c) => chatFailureMessage(c));
    expect(new Set(messages).size).toBe(causes.length);
  });

  it('tells the user an operator was notified for the operator-actionable causes', () => {
    expect(chatFailureMessage('auth')).toMatch(/operator/i);
    expect(chatFailureMessage('outage')).toMatch(/operator/i);
  });
});
