import { describe, it, expect } from 'vitest';
import { decayScore, applyDecay } from '../../../../src/runtimes/chat/providers/pinecone.ts';

describe('decayScore', () => {
  it('returns full score for age=0', () => {
    expect(decayScore(0.9, 0, 14)).toBeCloseTo(0.9, 5);
  });

  it('halves score at exactly one half-life', () => {
    expect(decayScore(1.0, 14, 14)).toBeCloseTo(0.5, 2);
  });

  it('quarters score at two half-lives', () => {
    expect(decayScore(1.0, 28, 14)).toBeCloseTo(0.25, 2);
  });

  it('returns 0 for negative similarity', () => {
    expect(decayScore(-0.5, 0, 14)).toBe(0);
  });

  it('clamps to 0 for ages beyond maxAge', () => {
    expect(decayScore(0.9, 91, 14, 90)).toBe(0);
  });

  it('handles halfLife of 0 gracefully (returns 0 for any age > 0)', () => {
    expect(decayScore(0.9, 1, 0)).toBe(0);
    expect(decayScore(0.9, 0, 0)).toBeCloseTo(0.9, 5);
  });
});

describe('applyDecay', () => {
  it('filters out records older than maxAgeDays', () => {
    const now = new Date();
    const results = [
      { id: 'a', score: 0.9, record: { createdAt: now.toISOString() } },
      { id: 'b', score: 0.8, record: { createdAt: new Date(now.getTime() - 100 * 86400000).toISOString() } },
    ];
    const filtered = applyDecay(results as any, 14, 90);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('a');
  });

  it('re-sorts by decayed score', () => {
    const now = new Date();
    const results = [
      { id: 'old-high', score: 0.95, record: { createdAt: new Date(now.getTime() - 30 * 86400000).toISOString() } },
      { id: 'new-low', score: 0.6, record: { createdAt: now.toISOString() } },
    ];
    const decayed = applyDecay(results as any, 14, 90);
    expect(decayed[0].id).toBe('new-low');
  });
});
