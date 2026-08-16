/**
 * R6 dynamic catalogue chain derivation (owner directive 2026-08-15: chains are
 * discovered per host/user/deployment, never hardcoded).
 *
 * Pure-module tests over deriveFallbackChainFromCatalog: the live catalogue
 * fixture mirrors the fleet host's `opencode models` output on 2026-08-15
 * (27 ids across deepseek/glm/minimax/kimi + keyless opencode free tier).
 */
import { describe, it, expect } from 'vitest';
import {
  deriveFallbackChainFromCatalog,
  type CandidateEvidence,
} from '../../../src/runtimes/agent/fallback-discovery.ts';

const LIVE_CATALOG = [
  'opencode/big-pickle',
  'opencode/deepseek-v4-flash-free',
  'opencode/hy3-free',
  'opencode/laguna-s-2.1-free',
  'opencode/mimo-v2.5-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/nemotron-3.5-lightning-free',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-reasoner',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
  'glm/glm-4.5-air',
  'glm/glm-4.6',
  'glm/glm-4.7',
  'glm/glm-5',
  'glm/glm-5-turbo',
  'glm/glm-5.1',
  'glm/glm-5.2',
  'kimi/kimi-k3',
  'minimax/MiniMax-M2',
  'minimax/MiniMax-M2.1',
  'minimax/MiniMax-M2.1-highspeed',
  'minimax/MiniMax-M2.5',
  'minimax/MiniMax-M2.5-highspeed',
  'minimax/MiniMax-M2.7',
  'minimax/MiniMax-M2.7-highspeed',
  'minimax/MiniMax-M3',
];

const PRIMARY = { provider: 'claude-cli', model: 'claude-opus-4-8' };
const GATEWAY = 'opencode-cli';

function derive(opts: {
  catalogIds?: readonly string[];
  policy?: Parameters<typeof deriveFallbackChainFromCatalog>[0]['policy'];
  evidenceFor?: (id: string) => CandidateEvidence;
  primary?: { provider: string; model?: string | null };
}) {
  return deriveFallbackChainFromCatalog({
    catalogIds: opts.catalogIds ?? LIVE_CATALOG,
    gatewayProvider: GATEWAY,
    primary: opts.primary ?? PRIMARY,
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.evidenceFor ? { evidenceFor: opts.evidenceFor } : {}),
  });
}

describe('deriveFallbackChainFromCatalog', () => {
  it('selects one model per keyed provider — the last (newest) catalogue entry — in catalogue order', () => {
    const { entries } = derive({ policy: { maxEntries: 4, includeFreeTier: false } });
    expect(entries).toEqual([
      { provider: GATEWAY, model: 'deepseek/deepseek-v4-pro' },
      { provider: GATEWAY, model: 'glm/glm-5.2' },
      { provider: GATEWAY, model: 'kimi/kimi-k3' },
      { provider: GATEWAY, model: 'minimax/MiniMax-M3' },
    ]);
  });

  it('honors a per-provider operator pin present in the catalogue and ignores one that is absent', () => {
    const { entries } = derive({
      policy: {
        maxEntries: 4,
        includeFreeTier: false,
        preferModels: {
          glm: 'glm/glm-4.7',
          deepseek: 'deepseek/not-in-catalogue',
        },
      },
    });
    expect(entries.map((e) => e.model)).toEqual([
      'deepseek/deepseek-v4-pro',
      'glm/glm-4.7',
      'kimi/kimi-k3',
      'minimax/MiniMax-M3',
    ]);
  });

  it('ranks canary-ok providers ahead of unknown and excludes dead ones', () => {
    const evidence: Record<string, CandidateEvidence> = {
      'kimi/kimi-k3': 'dead',
      'glm/glm-5.2': 'dead',
      'minimax/MiniMax-M3': 'ok',
    };
    const { entries } = derive({
      policy: { maxEntries: 4, includeFreeTier: false },
      evidenceFor: (id) => evidence[id] ?? 'unknown',
    });
    expect(entries.map((e) => e.model)).toEqual([
      'minimax/MiniMax-M3',
      'deepseek/deepseek-v4-pro',
    ]);
  });

  it('appends exactly one free-tier model as the tail entry', () => {
    const { entries } = derive({ policy: { maxEntries: 4, includeFreeTier: true } });
    expect(entries).toHaveLength(4);
    expect(entries[3]!.model).toBe('opencode/nemotron-3.5-lightning-free');
    expect(entries.slice(0, 3).every((e) => !e.model.startsWith('opencode/'))).toBe(true);
  });

  it('excludes the primary route from the chain (self-fallback rule)', () => {
    const { entries } = derive({
      primary: { provider: GATEWAY, model: 'deepseek/deepseek-v4-pro' },
      policy: { maxEntries: 4, includeFreeTier: false },
    });
    expect(entries.map((e) => e.model)).toEqual([
      'glm/glm-5.2',
      'kimi/kimi-k3',
      'minimax/MiniMax-M3',
    ]);
  });

  it('skips excluded providers and malformed catalogue ids', () => {
    const { entries } = derive({
      catalogIds: ['nonsense', '/leading', 'trailing/', ...LIVE_CATALOG],
      policy: { maxEntries: 4, includeFreeTier: false, excludeProviders: ['minimax', 'kimi'] },
    });
    expect(entries.map((e) => e.model)).toEqual([
      'deepseek/deepseek-v4-pro',
      'glm/glm-5.2',
    ]);
  });

  it('clamps maxEntries to the [1, 4] chain cap', () => {
    expect(derive({ policy: { maxEntries: 99 } }).entries).toHaveLength(4);
    expect(derive({ policy: { maxEntries: 0 } }).entries).toHaveLength(1);
  });

  it('returns an empty chain for an empty catalogue', () => {
    const { entries, basis } = derive({ catalogIds: [] });
    expect(entries).toEqual([]);
    expect(basis).toEqual([]);
  });

  it('reports every candidate in the basis with its evidence and selection flag', () => {
    const { basis } = derive({
      policy: { maxEntries: 1, includeFreeTier: false },
      evidenceFor: (id) => (id === 'kimi/kimi-k3' ? 'dead' : 'unknown'),
    });
    const byProvider = new Map(basis.map((c) => [c.catalogProvider, c]));
    expect(byProvider.get('kimi')!.evidence).toBe('dead');
    expect(byProvider.get('kimi')!.selected).toBe(false);
    expect(basis.filter((c) => c.selected)).toHaveLength(1);
    expect(byProvider.get('deepseek')!.selected).toBe(true);
  });

  it('a 1-entry chain keeps its slot for the strongest keyed candidate; free tier fills it only when all keyed are dead', () => {
    const keyedAlive = derive({ policy: { maxEntries: 1, includeFreeTier: true } });
    expect(keyedAlive.entries).toEqual([
      { provider: GATEWAY, model: 'deepseek/deepseek-v4-pro' },
    ]);

    const allKeyedDead = derive({
      policy: { maxEntries: 1, includeFreeTier: true },
      evidenceFor: (id) => (id.startsWith('opencode/') ? 'unknown' : 'dead'),
    });
    expect(allKeyedDead.entries).toEqual([
      { provider: GATEWAY, model: 'opencode/nemotron-3.5-lightning-free' },
    ]);
  });

  it('free tier disabled leaves keyless models out entirely', () => {
    const { entries, basis } = derive({ policy: { maxEntries: 4, includeFreeTier: false } });
    expect(entries.some((e) => e.model.startsWith('opencode/'))).toBe(false);
    expect(basis.some((c) => c.freeTier)).toBe(false);
  });
});
