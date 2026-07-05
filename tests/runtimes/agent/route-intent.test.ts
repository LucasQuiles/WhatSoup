import { describe, expect, it } from 'vitest';
import {
  buildRoutingPromptContract,
  extractRouteIntents,
} from '../../../src/runtimes/agent/route-intent.ts';

describe('extractRouteIntents (typed marker grammar)', () => {
  it('returns text unchanged when no marker syntax is present', () => {
    const text = 'Just a normal reply.\nWith two lines.';
    expect(extractRouteIntents(text)).toEqual({ cleaned: text, intents: [], invalid: [] });
  });

  it('extracts each intent class from a marker alone on its own line', () => {
    for (const cls of ['strongest', 'fastest', 'safe_read_only', 'reset']) {
      const { cleaned, intents, invalid } = extractRouteIntents(`[[wa-route: ${cls}]]\nOn it.`);
      expect(intents).toEqual([cls]);
      expect(invalid).toEqual([]);
      expect(cleaned).toBe('On it.');
    }
  });

  it('accepts surrounding whitespace and mixed case in the payload', () => {
    const { cleaned, intents } = extractRouteIntents('  [[wa-route:  Strongest ]]  \nDone.');
    expect(intents).toEqual(['strongest']);
    expect(cleaned).toBe('Done.');
  });

  it('strips an envelope with an unknown payload but does NOT act on it', () => {
    const { cleaned, intents, invalid } = extractRouteIntents('[[wa-route: banana]]\nHello.');
    expect(intents).toEqual([]);
    expect(invalid).toEqual(['banana']);
    expect(cleaned).toBe('Hello.');
  });

  it('an inline mention is neither stripped nor acted on (fail-safe passthrough)', () => {
    const text = 'The marker looks like [[wa-route: strongest]] in the docs.';
    const res = extractRouteIntents(text);
    expect(res.intents).toEqual([]);
    expect(res.cleaned).toBe(text);
  });

  it('a malformed envelope (bracket in payload) passes through untouched', () => {
    const text = '[[wa-route: a]b]]\nHi.';
    const res = extractRouteIntents(text);
    expect(res.intents).toEqual([]);
    expect(res.invalid).toEqual([]);
    expect(res.cleaned).toBe(text);
  });

  it('records multiple markers in order (caller acts on the first only)', () => {
    const { intents } = extractRouteIntents('[[wa-route: fastest]]\n[[wa-route: reset]]\nOk.');
    expect(intents).toEqual(['fastest', 'reset']);
  });

  it('a reply that is ONLY a marker cleans to the empty string', () => {
    const { cleaned, intents } = extractRouteIntents('[[wa-route: reset]]');
    expect(intents).toEqual(['reset']);
    expect(cleaned).toBe('');
  });
});

describe('buildRoutingPromptContract', () => {
  const ctx = {
    provider: 'claude-cli',
    tierMap: { strongest: 'claude-cli', fastest: 'gemini-cli' },
    routableProviders: ['claude-cli', 'opencode-cli'],
  };

  it('teaches exactly the four marker classes the extractor accepts', () => {
    const text = buildRoutingPromptContract(ctx);
    for (const cls of ['strongest', 'fastest', 'safe_read_only', 'reset']) {
      expect(text).toContain(`[[wa-route: ${cls}]]`);
    }
    expect(text.match(/\[\[wa-route: /g)).toHaveLength(4);
  });

  it('its own teaching lines are not actionable envelopes (lockstep guard)', () => {
    const res = extractRouteIntents(buildRoutingPromptContract(ctx));
    expect(res.intents).toEqual([]);
    expect(res.invalid).toEqual([]);
  });

  it('is spawn-honest and keeps privileged actions owner-gated', () => {
    const text = buildRoutingPromptContract(ctx);
    expect(text).toContain('NEXT session');
    expect(text).toContain('owner-gated');
    expect(text).toContain('never changes what you or they are allowed to do');
    expect(text).toContain('explicit confirmation');
  });

  it('grounds route facts in live instance state', () => {
    const text = buildRoutingPromptContract(ctx);
    expect(text).toContain('current provider: claude-cli');
    expect(text).toContain('strongest tier: claude-cli');
    expect(text).toContain('fastest tier: gemini-cli');
    expect(text).toContain('pinnable providers: claude-cli, opencode-cli');
  });

  it('says so honestly when tiers are unconfigured', () => {
    const text = buildRoutingPromptContract({ ...ctx, tierMap: null });
    expect(text).toContain('strongest tier: not configured (default route)');
    expect(text).toContain('fastest tier: not configured (default route)');
  });
});
