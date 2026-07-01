/**
 * Steady-state eligibility surfacing for FallbackChain.snapshot().
 *
 * Before this behaviour, the idle (pre-selection) snapshot hardcoded
 * `eligible: null` for every configured entry, so an uncredentialed fallback
 * tier (e.g. an opencode-cli provider whose API key is absent) was invisible in
 * /health and to fleet provider-parity until a window actually armed. The
 * optional resolver lets callers surface real credential presence in the idle
 * snapshot without changing the post-selection (chainState) precedence.
 */
import { describe, it, expect } from 'vitest';
import { FallbackChain } from '../../../src/runtimes/agent/fallback-chain-state.ts';
import type { AgentFallbackEntry } from '../../../src/core/fallback-chain.ts';

const entries: AgentFallbackEntry[] = [
  { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
  { provider: 'opencode-cli', model: 'minimax/MiniMax-M2.7' },
  { provider: 'opencode-cli', model: 'deepseek/deepseek-chat' },
];

describe('FallbackChain.snapshot eligibility resolver', () => {
  it('reports eligible:null for every entry when no resolver is given (unchanged behaviour)', () => {
    const chain = new FallbackChain();
    const snap = chain.snapshot(entries);
    expect(snap.map((e) => e.eligible)).toEqual([null, null, null]);
  });

  it('uses the resolver to surface per-entry credential presence in the idle snapshot', () => {
    const chain = new FallbackChain();
    // claude-cli is native (no key service → null); the opencode tier has no key (false).
    const resolve = (entry: AgentFallbackEntry): boolean | null =>
      entry.provider === 'opencode-cli' ? false : null;
    const snap = chain.snapshot(entries, resolve);
    expect(snap.map((e) => e.eligible)).toEqual([null, false, false]);
    // entries are otherwise preserved
    expect(snap.map((e) => e.provider)).toEqual([
      'claude-cli',
      'opencode-cli',
      'opencode-cli',
    ]);
  });

  it('reports eligible:true when the resolver finds the credential present', () => {
    const chain = new FallbackChain();
    const resolve = (entry: AgentFallbackEntry): boolean | null =>
      entry.provider === 'opencode-cli' ? true : null;
    const snap = chain.snapshot(entries, resolve);
    expect(snap.map((e) => e.eligible)).toEqual([null, true, true]);
  });

  it('ignores the resolver once a window has selected (chainState takes precedence)', () => {
    const chain = new FallbackChain();
    chain.chainState = [
      { provider: 'claude-cli', model: 'claude-sonnet-4-6', eligible: true },
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2.7', eligible: false },
    ];
    // Resolver would say true for opencode, but the last selection's computed
    // state must win.
    const resolve = (): boolean | null => true;
    const snap = chain.snapshot(entries, resolve);
    expect(snap.map((e) => e.eligible)).toEqual([true, false]);
  });
});
