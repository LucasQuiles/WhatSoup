import { describe, expect, it } from 'vitest';

import {
  buildFallbackChangedNotice,
  buildFallbackClearedNotice,
  buildFallbackStartedNotice,
  resolveFallbackTransition,
} from '../../src/lib/fallback-transition.ts';

describe('resolveFallbackTransition', () => {
  describe('no prior state (fresh session)', () => {
    it('reports no transition when models match', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'anthropic/claude-sonnet',
        activeModel: 'anthropic/claude-sonnet',
      });
      expect(result.fallbackActive).toBe(false);
      expect(result.fallbackStarted).toBe(false);
      expect(result.fallbackCleared).toBe(false);
      expect(result.fallbackChanged).toBe(false);
      expect(result.nextState).toEqual({});
    });

    it('reports fallbackStarted when active differs from selected', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'anthropic/claude-sonnet',
        activeModel: 'openai/gpt-4o',
        reason: 'rate-limited',
      });
      expect(result.fallbackActive).toBe(true);
      expect(result.fallbackStarted).toBe(true);
      expect(result.fallbackCleared).toBe(false);
      expect(result.reasonSummary).toBe('rate-limited');
      expect(result.nextState).toEqual({
        selectedModel: 'anthropic/claude-sonnet',
        activeModel: 'openai/gpt-4o',
        reason: 'rate-limited',
      });
    });
  });

  describe('fallback starts', () => {
    it('detects a new fallback from a previously-clear state', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'primary',
        activeModel: 'backup',
        reason: 'unavailable',
        state: { selectedModel: 'primary', activeModel: 'primary' },
      });
      expect(result.fallbackStarted).toBe(true);
      expect(result.fallbackCleared).toBe(false);
    });

    it('detects a new fallback when previous state was empty', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'primary',
        activeModel: 'backup-a',
        state: {},
      });
      expect(result.fallbackStarted).toBe(true);
    });
  });

  describe('fallback clears', () => {
    it('detects a cleared fallback when primary recovers', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'primary',
        activeModel: 'primary',
        state: { selectedModel: 'primary', activeModel: 'backup', reason: 'rate-limited' },
      });
      expect(result.fallbackActive).toBe(false);
      expect(result.fallbackStarted).toBe(false);
      expect(result.fallbackCleared).toBe(true);
      expect(result.nextState).toEqual({});
    });

    it('does NOT report cleared when there was no prior fallback', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'primary',
        activeModel: 'primary',
        state: {},
      });
      expect(result.fallbackCleared).toBe(false);
    });
  });

  describe('fallback changes mid-flight', () => {
    it('detects a change between two backup models', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'primary',
        activeModel: 'backup-b',
        reason: 'rate-limited',
        state: { selectedModel: 'primary', activeModel: 'backup-a', reason: 'rate-limited' },
      });
      expect(result.fallbackActive).toBe(true);
      expect(result.fallbackStarted).toBe(false);
      expect(result.fallbackCleared).toBe(false);
      expect(result.fallbackChanged).toBe(true);
    });

    it('detects a reason change without model change', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'primary',
        activeModel: 'backup',
        reason: 'auth-required',
        state: { selectedModel: 'primary', activeModel: 'backup', reason: 'rate-limited' },
      });
      expect(result.fallbackChanged).toBe(true);
    });

    it('does NOT report changed when state is identical', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'primary',
        activeModel: 'backup',
        reason: 'rate-limited',
        state: { selectedModel: 'primary', activeModel: 'backup', reason: 'rate-limited' },
      });
      expect(result.fallbackChanged).toBe(false);
      expect(result.fallbackStarted).toBe(false);
    });
  });

  describe('selected model changes', () => {
    it('reports started when user switches primary mid-fallback', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'new-primary',
        activeModel: 'backup',
        state: { selectedModel: 'old-primary', activeModel: 'backup' },
      });
      // Selected changed → this is a "started" transition (new pair)
      expect(result.fallbackStarted).toBe(true);
    });
  });

  describe('nextState persistence', () => {
    it('persists the full transition state when fallback is active', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'a',
        activeModel: 'b',
        reason: 'timeout',
      });
      expect(result.nextState.selectedModel).toBe('a');
      expect(result.nextState.activeModel).toBe('b');
      expect(result.nextState.reason).toBe('timeout');
    });

    it('clears nextState when fallback is not active', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'a',
        activeModel: 'a',
        state: { selectedModel: 'a', activeModel: 'b', reason: 'rate-limited' },
      });
      expect(result.nextState).toEqual({});
    });

    it('trims empty reason to undefined', () => {
      const result = resolveFallbackTransition({
        selectedModel: 'a',
        activeModel: 'b',
        reason: '   ',
      });
      expect(result.nextState.reason).toBeUndefined();
      expect(result.reasonSummary).toBe('unavailable');
    });
  });
});

describe('buildFallbackStartedNotice', () => {
  it('builds a notice with reason', () => {
    const notice = buildFallbackStartedNotice({
      selectedModel: 'anthropic/claude-sonnet',
      activeModel: 'openai/gpt-4o',
      reason: 'rate-limited',
    });
    expect(notice).toContain('openai/gpt-4o');
    expect(notice).toContain('rate-limited');
    expect(notice).toContain('backup model');
  });

  it('builds a notice without reason', () => {
    const notice = buildFallbackStartedNotice({
      selectedModel: 'primary',
      activeModel: 'backup',
    });
    expect(notice).toContain('backup');
    expect(notice).not.toContain('(');
  });

  it('returns null when models match', () => {
    expect(
      buildFallbackStartedNotice({ selectedModel: 'same', activeModel: 'same' }),
    ).toBeNull();
  });
});

describe('buildFallbackClearedNotice', () => {
  it('builds a notice with previous model', () => {
    const notice = buildFallbackClearedNotice({
      selectedModel: 'anthropic/claude-sonnet',
      previousActiveModel: 'openai/gpt-4o',
    });
    expect(notice).toContain('anthropic/claude-sonnet');
    expect(notice).toContain('openai/gpt-4o');
    expect(notice).toContain('Back on primary');
    expect(notice).toContain('was');
  });

  it('builds a notice without previous model', () => {
    const notice = buildFallbackClearedNotice({
      selectedModel: 'primary',
    });
    expect(notice).toContain('primary');
    expect(notice).toContain('Back on primary');
    expect(notice).not.toContain('was');
  });
});

describe('buildFallbackChangedNotice', () => {
  it('builds a notice when switching between backups', () => {
    const notice = buildFallbackChangedNotice({
      activeModel: 'backup-b',
      previousActiveModel: 'backup-a',
      reason: 'rate-limited',
    });
    expect(notice).toContain('backup-b');
    expect(notice).toContain('rate-limited');
    expect(notice).toContain('Switched backup');
  });

  it('returns null when same model', () => {
    expect(
      buildFallbackChangedNotice({
        activeModel: 'same',
        previousActiveModel: 'same',
      }),
    ).toBeNull();
  });

  it('returns null when no previous model', () => {
    expect(
      buildFallbackChangedNotice({ activeModel: 'backup' }),
    ).toBeNull();
  });
});
