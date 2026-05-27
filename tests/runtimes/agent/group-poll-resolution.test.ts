import { describe, it, expect } from 'vitest';
import {
  evaluateResolution,
  evaluateResolutionOnTimeout,
  type PollVote,
  type ResolutionStrategy,
} from '../../../src/runtimes/agent/runtime.js';

function makeVote(
  voterJid: string,
  selectedOptions: string[],
  isAdmin: boolean,
  timestamp: number,
): PollVote {
  return { voterJid, selectedOptions, isAdmin, timestamp };
}

function votesMap(...entries: [string, PollVote][]): Map<string, PollVote> {
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// evaluateResolution — first-vote-wins
// ---------------------------------------------------------------------------
describe('evaluateResolution — first-vote-wins', () => {
  it('resolves on first vote', () => {
    const votes = votesMap(['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', ['Yes'], false, 100)]);
    const result = evaluateResolution('first-vote-wins', votes, null);
    expect(result.status).toBe('resolved');
    expect(result.answer).toBe('Yes');
  });

  it('second voter is ignored — first vote is the answer', () => {
    const votes = votesMap(
      ['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', ['Yes'], false, 100)],
      ['bob@s.whatsapp.net', makeVote('bob@s.whatsapp.net', ['No'], false, 200)],
    );
    const result = evaluateResolution('first-vote-wins', votes, null);
    expect(result.status).toBe('resolved');
    expect(result.answer).toBe('Yes');
  });

  it('returns pending when no votes', () => {
    const result = evaluateResolution('first-vote-wins', new Map(), null);
    expect(result.status).toBe('pending');
  });

  it('joins multiple selectedOptions with comma', () => {
    const votes = votesMap([
      'alice@s.whatsapp.net',
      makeVote('alice@s.whatsapp.net', ['Option A', 'Option B'], false, 100),
    ]);
    const result = evaluateResolution('first-vote-wins', votes, null);
    expect(result.status).toBe('resolved');
    expect(result.answer).toBe('Option A, Option B');
  });
});

// ---------------------------------------------------------------------------
// evaluateResolution — admin-only
// ---------------------------------------------------------------------------
describe('evaluateResolution — admin-only', () => {
  it('non-admin vote is ignored — returns pending', () => {
    const votes = votesMap(['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', ['Yes'], false, 100)]);
    const result = evaluateResolution('admin-only', votes, null);
    expect(result.status).toBe('pending');
  });

  it('admin vote resolves', () => {
    const votes = votesMap(['admin@s.whatsapp.net', makeVote('admin@s.whatsapp.net', ['Deploy'], true, 100)]);
    const result = evaluateResolution('admin-only', votes, null);
    expect(result.status).toBe('resolved');
    expect(result.answer).toBe('Deploy');
  });

  it('returns pending with no votes', () => {
    const result = evaluateResolution('admin-only', new Map(), null);
    expect(result.status).toBe('pending');
  });

  it('admin resolves even when non-admin voted earlier', () => {
    const votes = votesMap(
      ['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', ['No'], false, 50)],
      ['admin@s.whatsapp.net', makeVote('admin@s.whatsapp.net', ['Yes'], true, 100)],
    );
    const result = evaluateResolution('admin-only', votes, null);
    expect(result.status).toBe('resolved');
    expect(result.answer).toBe('Yes');
  });
});

// ---------------------------------------------------------------------------
// evaluateResolution — admin-wins
// ---------------------------------------------------------------------------
describe('evaluateResolution — admin-wins', () => {
  it('non-admin vote alone — returns pending', () => {
    const votes = votesMap(['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', ['Maybe'], false, 100)]);
    const result = evaluateResolution('admin-wins', votes, null);
    expect(result.status).toBe('pending');
  });

  it('admin vote resolves and overrides non-admin', () => {
    const votes = votesMap(
      ['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', ['No'], false, 50)],
      ['admin@s.whatsapp.net', makeVote('admin@s.whatsapp.net', ['Yes'], true, 150)],
    );
    const result = evaluateResolution('admin-wins', votes, null);
    expect(result.status).toBe('resolved');
    expect(result.answer).toBe('Yes');
  });

  it('returns pending with no votes', () => {
    const result = evaluateResolution('admin-wins', new Map(), null);
    expect(result.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// evaluateResolution — majority-after-timeout
// ---------------------------------------------------------------------------
describe('evaluateResolution — majority-after-timeout', () => {
  it('always returns pending on vote arrival regardless of vote count', () => {
    const votes = votesMap(
      ['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', ['Yes'], false, 100)],
      ['bob@s.whatsapp.net', makeVote('bob@s.whatsapp.net', ['Yes'], false, 200)],
      ['carol@s.whatsapp.net', makeVote('carol@s.whatsapp.net', ['No'], false, 300)],
    );
    const result = evaluateResolution('majority-after-timeout', votes, null);
    expect(result.status).toBe('pending');
  });

  it('returns pending even with a single vote', () => {
    const votes = votesMap(['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', ['Yes'], false, 100)]);
    const result = evaluateResolution('majority-after-timeout', votes, null);
    expect(result.status).toBe('pending');
  });

  it('returns pending with no votes', () => {
    const result = evaluateResolution('majority-after-timeout', new Map(), null);
    expect(result.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// evaluateResolutionOnTimeout
// ---------------------------------------------------------------------------
describe('evaluateResolutionOnTimeout', () => {
  it('returns null with no votes', () => {
    expect(evaluateResolutionOnTimeout(new Map())).toBeNull();
  });

  it('majority wins (2 vs 1)', () => {
    const votes = votesMap(
      ['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', ['Yes'], false, 100)],
      ['bob@s.whatsapp.net', makeVote('bob@s.whatsapp.net', ['Yes'], false, 200)],
      ['carol@s.whatsapp.net', makeVote('carol@s.whatsapp.net', ['No'], false, 300)],
    );
    expect(evaluateResolutionOnTimeout(votes)).toBe('Yes');
  });

  it('tie broken by earliest voter timestamp', () => {
    const votes = votesMap(
      // 'No' has earlier timestamp (50) vs 'Yes' (100) — tie broken in favour of 'No'
      ['bob@s.whatsapp.net', makeVote('bob@s.whatsapp.net', ['Yes'], false, 100)],
      ['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', ['No'], false, 50)],
    );
    expect(evaluateResolutionOnTimeout(votes)).toBe('No');
  });

  it('single vote wins outright', () => {
    const votes = votesMap(['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', ['Deploy'], false, 100)]);
    expect(evaluateResolutionOnTimeout(votes)).toBe('Deploy');
  });

  it('skips votes with no selectedOptions[0]', () => {
    const votes = votesMap(
      ['alice@s.whatsapp.net', makeVote('alice@s.whatsapp.net', [], false, 100)],
      ['bob@s.whatsapp.net', makeVote('bob@s.whatsapp.net', ['Yes'], false, 200)],
    );
    expect(evaluateResolutionOnTimeout(votes)).toBe('Yes');
  });
});
