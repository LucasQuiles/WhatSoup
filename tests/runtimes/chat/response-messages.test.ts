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

  it('pins the exact copy per cause so wording drift is a conscious, reviewed change (#1064 hardening)', () => {
    // Byte-stable copy: a wording edit must update this test (and the runtime
    // assertions that match these strings), making copy drift explicit.
    expect(chatFailureMessage('auth')).toBe(
      "⚠️ I can't reach my language model right now — it looks like a setup issue on my end. My operator has been notified; please try again later.",
    );
    expect(chatFailureMessage('rate-limited')).toBe(
      "I'm getting more messages than I can keep up with right now — give me a minute and ask again.",
    );
    expect(chatFailureMessage('transient')).toBe(
      'lol my brain glitched for a sec — mind asking me again?',
    );
    expect(chatFailureMessage('outage')).toBe(
      '⚠️ My language model is unavailable right now and my operator has been notified — please try again in a bit.',
    );
  });
});
