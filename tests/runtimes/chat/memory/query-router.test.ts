import { describe, it, expect } from 'vitest';
import { routeQuery } from '../../../../src/runtimes/chat/memory/query-router.ts';

describe('routeQuery — facts-first heuristics', () => {
  const factsPhrases = [
    'who is Ari Levy',
    'What does Jonathan prefer for weekend meetings',
    'what is her preference for morning calls',
    'please remember that Michael likes tea',
    'what is his email address',
    'do we have a phone number for Ari',
  ];

  for (const phrase of factsPhrases) {
    it(`classifies "${phrase}" as facts-first`, () => {
      const routed = routeQuery(phrase);
      expect(routed.intent).toBe('facts');
      expect(routed.namespaces[0]).toBe('whatsapp-facts');
      // Fallback ordering: summaries, chunks
      expect(routed.namespaces).toEqual([
        'whatsapp-facts',
        'whatsapp-summaries',
        'whatsapp-chunks',
      ]);
    });
  }
});

describe('routeQuery — raw-first heuristics', () => {
  const rawPhrases = [
    'what did I say to Ari yesterday',
    'please quote me when I said that',
    'can you summarize thread with Marcus',
    'catch me up on the Ari thread',
    'what did we agree last time with the vendor',
  ];

  for (const phrase of rawPhrases) {
    it(`classifies "${phrase}" as raw-first`, () => {
      const routed = routeQuery(phrase);
      expect(routed.intent).toBe('raw');
      // First-tier: summaries + chunks, in that order
      expect(routed.namespaces.slice(0, 2)).toEqual([
        'whatsapp-summaries',
        'whatsapp-chunks',
      ]);
      // Fallback: facts
      expect(routed.namespaces).toEqual([
        'whatsapp-summaries',
        'whatsapp-chunks',
        'whatsapp-facts',
      ]);
    });
  }
});

describe('routeQuery — hybrid heuristics', () => {
  const hybridPhrases = [
    'what have I discussed with the client about pricing',
    'what has been going on this week with Ari',
    'what have we talked about regarding the safety plan',
  ];

  for (const phrase of hybridPhrases) {
    it(`classifies "${phrase}" as hybrid`, () => {
      const routed = routeQuery(phrase);
      expect(routed.intent).toBe('hybrid');
      // Mixed/ambiguous: summaries then both facts and chunks
      expect(routed.namespaces[0]).toBe('whatsapp-summaries');
      expect(routed.namespaces).toContain('whatsapp-facts');
      expect(routed.namespaces).toContain('whatsapp-chunks');
      // No extra fallback
      expect(routed.namespaces.length).toBe(3);
    });
  }
});

describe('routeQuery — case-insensitive matching', () => {
  it('matches facts-first phrases regardless of case', () => {
    expect(routeQuery('WHO IS Ari').intent).toBe('facts');
    expect(routeQuery('Who Is Ari').intent).toBe('facts');
    expect(routeQuery('WHAT DOES she prefer').intent).toBe('facts');
    expect(routeQuery('Email Address for Michael').intent).toBe('facts');
  });

  it('matches raw-first phrases regardless of case', () => {
    expect(routeQuery('WHAT DID I SAY to Ari').intent).toBe('raw');
    expect(routeQuery('Summarize Thread with Ari').intent).toBe('raw');
    expect(routeQuery('Catch Me Up on the thread').intent).toBe('raw');
  });

  it('matches hybrid phrases regardless of case', () => {
    expect(routeQuery('WHAT HAVE I DISCUSSED with Ari').intent).toBe('hybrid');
    expect(routeQuery('This Week With Ari').intent).toBe('hybrid');
    expect(routeQuery('Talked About pricing').intent).toBe('hybrid');
  });
});

describe('routeQuery — explicit override wins', () => {
  it('returns the override namespaces verbatim with intent=hybrid', () => {
    // Override should win even when query text is clearly facts-first.
    const routed = routeQuery('who is Ari', ['whatsapp-chunks']);
    expect(routed.intent).toBe('hybrid');
    expect(routed.namespaces).toEqual(['whatsapp-chunks']);
  });

  it('preserves override ordering and multi-namespace lists', () => {
    const routed = routeQuery('what did I say', ['whatsapp-facts', 'whatsapp-summaries']);
    expect(routed.intent).toBe('hybrid');
    expect(routed.namespaces).toEqual(['whatsapp-facts', 'whatsapp-summaries']);
  });

  it('falls back to heuristics when override is empty array', () => {
    const routed = routeQuery('who is Ari', []);
    expect(routed.intent).toBe('facts');
    expect(routed.namespaces[0]).toBe('whatsapp-facts');
  });

  it('falls back to heuristics when override is undefined', () => {
    const routed = routeQuery('who is Ari', undefined);
    expect(routed.intent).toBe('facts');
    expect(routed.namespaces[0]).toBe('whatsapp-facts');
  });
});

describe('routeQuery — unknown / generic queries default to hybrid', () => {
  const genericPhrases = [
    'hello there',
    'the weather is nice',
    'explain the project',
    '',
    'random query with no trigger phrase',
  ];

  for (const phrase of genericPhrases) {
    it(`defaults "${phrase}" to hybrid fan-out`, () => {
      const routed = routeQuery(phrase);
      expect(routed.intent).toBe('hybrid');
      expect(routed.namespaces[0]).toBe('whatsapp-summaries');
      expect(routed.namespaces).toContain('whatsapp-facts');
      expect(routed.namespaces).toContain('whatsapp-chunks');
      expect(routed.namespaces.length).toBe(3);
    });
  }
});

describe('routeQuery — returned ordering matches the retrieval policy', () => {
  it('facts intent: whatsapp-facts first, then whatsapp-summaries, then whatsapp-chunks', () => {
    expect(routeQuery('who is Ari').namespaces).toEqual([
      'whatsapp-facts',
      'whatsapp-summaries',
      'whatsapp-chunks',
    ]);
  });

  it('raw intent: summaries, chunks, then facts', () => {
    expect(routeQuery('what did I say to Ari').namespaces).toEqual([
      'whatsapp-summaries',
      'whatsapp-chunks',
      'whatsapp-facts',
    ]);
  });

  it('hybrid intent: summaries first, then facts and chunks (any order after summaries)', () => {
    const routed = routeQuery('what have I discussed with Ari');
    expect(routed.namespaces[0]).toBe('whatsapp-summaries');
    expect(routed.namespaces.slice(1).sort()).toEqual([
      'whatsapp-chunks',
      'whatsapp-facts',
    ]);
  });
});

describe('routeQuery — precedence when multiple triggers match', () => {
  it('raw-first beats facts-first when both match ("what did I say" + "email address")', () => {
    // Raw-first is the stronger signal for "what did I say" queries.
    // Expectation: raw bucket wins because the raw-first phrase is present.
    const routed = routeQuery('what did I say about his email address');
    expect(routed.intent).toBe('raw');
  });

  it('hybrid beats facts-first when both match', () => {
    // "what have I discussed" is hybrid; "remember" also present.
    // Hybrid wins because it is the more specific multi-source question.
    const routed = routeQuery('what have I discussed, remember the date');
    expect(routed.intent).toBe('hybrid');
  });
});
