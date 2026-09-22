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
  isExperimentalCatalogModel,
  isNonChatCatalogModel,
  type CandidateEvidence,
} from '../../../src/runtimes/agent/fallback-discovery.ts';
import type { ModelCatalogMetadata } from '../../../src/runtimes/agent/providers/binary-preflight.ts';

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
  catalogMetadata?: Readonly<Record<string, ModelCatalogMetadata>>;
  policy?: Parameters<typeof deriveFallbackChainFromCatalog>[0]['policy'];
  evidenceFor?: (id: string) => CandidateEvidence;
  primary?: { provider: string; model?: string | null };
}) {
  return deriveFallbackChainFromCatalog({
    catalogIds: opts.catalogIds ?? LIVE_CATALOG,
    ...(opts.catalogMetadata ? { catalogMetadata: opts.catalogMetadata } : {}),
    gatewayProvider: GATEWAY,
    primary: opts.primary ?? PRIMARY,
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.evidenceFor ? { evidenceFor: opts.evidenceFor } : {}),
  });
}

describe('deriveFallbackChainFromCatalog', () => {
  it('selects one model per keyed provider using the metadata-free descending-id tie break', () => {
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

  it('ranks canary-ok providers ahead of unknown and replaces exact dead models', () => {
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
      'glm/glm-5.1',
    ]);
  });

  it('uses release metadata instead of assuming the last catalogue id is newest', () => {
    const catalogIds = ['openai/gpt-5.6', 'openai/o3-pro'];
    const catalogMetadata = {
      'openai/gpt-5.6': {
        status: 'active', releaseDate: '2026-08-15', textOutput: true, toolCall: true,
      },
      'openai/o3-pro': {
        status: 'active', releaseDate: '2025-06-10', textOutput: true, toolCall: true,
      },
    } satisfies Record<string, ModelCatalogMetadata>;

    const { entries, basis } = derive({
      catalogIds,
      catalogMetadata,
      policy: { maxEntries: 1, includeFreeTier: false },
    });

    expect(entries).toEqual([{ provider: GATEWAY, model: 'openai/gpt-5.6' }]);
    expect(basis[0]).toMatchObject({
      model: 'openai/gpt-5.6',
      releaseDate: '2026-08-15',
      eligibilityBasis: 'metadata',
    });
  });

  it('ranks valid month-precision release dates without treating them as unknown', () => {
    const catalogIds = ['glm/new-month', 'glm/older-day'];
    const catalogMetadata = {
      'glm/new-month': {
        status: 'active', releaseDate: '2026-08', textOutput: true, toolCall: true,
      },
      'glm/older-day': {
        status: 'active', releaseDate: '2026-07-31', textOutput: true, toolCall: true,
      },
    } satisfies Record<string, ModelCatalogMetadata>;

    const { entries } = derive({
      catalogIds,
      catalogMetadata,
      policy: { maxEntries: 1, includeFreeTier: false },
    });

    expect(entries).toEqual([{ provider: GATEWAY, model: 'glm/new-month' }]);
  });

  it('prefers an active stable model over a newer beta model when evidence is equal', () => {
    const catalogIds = ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash-vision-exp'];
    const catalogMetadata = {
      'deepseek/deepseek-v4-pro': {
        status: 'active', releaseDate: '2026-08-12', textOutput: true, toolCall: true,
      },
      'deepseek/deepseek-v4-flash-vision-exp': {
        status: 'beta', releaseDate: '2026-08-21', textOutput: true, toolCall: true,
      },
    } satisfies Record<string, ModelCatalogMetadata>;

    const { entries } = derive({
      catalogIds,
      catalogMetadata,
      policy: { maxEntries: 1, includeFreeTier: false },
    });

    expect(entries).toEqual([{ provider: GATEWAY, model: 'deepseek/deepseek-v4-pro' }]);
  });

  it('excludes explicitly inactive, non-text-output, and non-tool-capable models', () => {
    const catalogIds = [
      'inactive/newest',
      'notext/newest',
      'notool/newest',
      'eligible/current',
    ];
    const catalogMetadata = {
      'inactive/newest': {
        status: 'inactive', releaseDate: '2026-09-01', textOutput: true, toolCall: true,
      },
      'notext/newest': {
        status: 'active', releaseDate: '2026-09-01', textOutput: false, toolCall: true,
      },
      'notool/newest': {
        status: 'active', releaseDate: '2026-09-01', textOutput: true, toolCall: false,
      },
      'eligible/current': {
        status: 'active', releaseDate: '2026-08-01', textOutput: true, toolCall: true,
      },
    } satisfies Record<string, ModelCatalogMetadata>;

    const { entries, basis } = derive({
      catalogIds,
      catalogMetadata,
      policy: { maxEntries: 4, includeFreeTier: false },
    });

    expect(entries).toEqual([{ provider: GATEWAY, model: 'eligible/current' }]);
    expect(basis.map((candidate) => candidate.model)).toEqual(['eligible/current']);
  });

  it('falls through an exact dead model to the next eligible model from that provider', () => {
    const catalogIds = ['glm/glm-5.1', 'glm/glm-5.2'];
    const catalogMetadata = {
      'glm/glm-5.1': {
        status: 'active', releaseDate: '2026-07-01', textOutput: true, toolCall: true,
      },
      'glm/glm-5.2': {
        status: 'active', releaseDate: '2026-08-01', textOutput: true, toolCall: true,
      },
    } satisfies Record<string, ModelCatalogMetadata>;

    const { entries } = derive({
      catalogIds,
      catalogMetadata,
      policy: { maxEntries: 1, includeFreeTier: false },
      evidenceFor: (id) => (id === 'glm/glm-5.2' ? 'dead' : 'unknown'),
    });

    expect(entries).toEqual([{ provider: GATEWAY, model: 'glm/glm-5.1' }]);
  });

  it('prefers a proven completion over a newer unknown model from the same provider', () => {
    const catalogIds = ['minimax/MiniMax-M2.7', 'minimax/MiniMax-M3'];
    const catalogMetadata = {
      'minimax/MiniMax-M2.7': {
        status: 'active', releaseDate: '2026-06-01', textOutput: true, toolCall: true,
      },
      'minimax/MiniMax-M3': {
        status: 'active', releaseDate: '2026-08-01', textOutput: true, toolCall: true,
      },
    } satisfies Record<string, ModelCatalogMetadata>;

    const { entries } = derive({
      catalogIds,
      catalogMetadata,
      policy: { maxEntries: 1, includeFreeTier: false },
      evidenceFor: (id) => (id.endsWith('M2.7') ? 'ok' : 'unknown'),
    });

    expect(entries).toEqual([{ provider: GATEWAY, model: 'minimax/MiniMax-M2.7' }]);
  });

  it('breaks equal or missing release dates by descending model id, not catalogue position', () => {
    const catalogIds = ['glm/glm-a', 'glm/glm-b'];
    const catalogMetadata = {
      'glm/glm-a': {
        status: 'active', releaseDate: '2026-08-01', textOutput: true, toolCall: true,
      },
      'glm/glm-b': {
        status: 'active', releaseDate: '2026-08-01', textOutput: true, toolCall: true,
      },
    } satisfies Record<string, ModelCatalogMetadata>;

    expect(derive({
      catalogIds,
      catalogMetadata,
      policy: { maxEntries: 1, includeFreeTier: false },
    }).entries).toEqual([{ provider: GATEWAY, model: 'glm/glm-b' }]);
    expect(derive({
      catalogIds,
      policy: { maxEntries: 1, includeFreeTier: false },
    }).entries).toEqual([{ provider: GATEWAY, model: 'glm/glm-b' }]);
    // Position must not decide: the reversed listing picks the same id.
    expect(derive({
      catalogIds: [...catalogIds].reverse(),
      catalogMetadata,
      policy: { maxEntries: 1, includeFreeTier: false },
    }).entries).toEqual([{ provider: GATEWAY, model: 'glm/glm-b' }]);
    expect(derive({
      catalogIds: [...catalogIds].reverse(),
      policy: { maxEntries: 1, includeFreeTier: false },
    }).entries).toEqual([{ provider: GATEWAY, model: 'glm/glm-b' }]);
  });

  it('lets an exact operator pin bypass automatic capability eligibility unless it is dead', () => {
    const catalogIds = ['openai/gpt-5.6', 'openai/gpt-realtime-2.1'];
    const catalogMetadata = {
      'openai/gpt-5.6': {
        status: 'active', releaseDate: '2026-08-01', textOutput: true, toolCall: true,
      },
      'openai/gpt-realtime-2.1': {
        status: 'inactive', releaseDate: '2026-09-01', textOutput: false, toolCall: false,
      },
    } satisfies Record<string, ModelCatalogMetadata>;
    const policy = {
      maxEntries: 1,
      includeFreeTier: false,
      preferModels: { openai: 'openai/gpt-realtime-2.1' },
    };

    const pinned = derive({ catalogIds, catalogMetadata, policy });
    expect(pinned.entries).toEqual([{ provider: GATEWAY, model: 'openai/gpt-realtime-2.1' }]);
    expect(pinned.basis[0]).toMatchObject({ eligibilityBasis: 'operator-pin' });

    const deadPin = derive({
      catalogIds,
      catalogMetadata,
      policy,
      evidenceFor: (id) => (id.endsWith('realtime-2.1') ? 'dead' : 'unknown'),
    });
    expect(deadPin.entries).toEqual([{ provider: GATEWAY, model: 'openai/gpt-5.6' }]);
  });

  it('appends exactly one free-tier model as the tail entry', () => {
    const { entries } = derive({ policy: { maxEntries: 4, includeFreeTier: true } });
    expect(entries).toHaveLength(4);
    expect(entries[3]!.model).toBe('opencode/nemotron-3.5-lightning-free');
    expect(entries.slice(0, 3).every((e) => !e.model.startsWith('opencode/'))).toBe(true);
  });

  it('does not reserve a paid gateway model as the free-tier tail when cost metadata exists', () => {
    const catalogIds = ['deepseek/current', 'opencode/free-model', 'opencode/newer-paid-model'];
    const catalogMetadata = {
      'deepseek/current': {
        status: 'active', releaseDate: '2026-08-01', textOutput: true, toolCall: true,
      },
      'opencode/free-model': {
        status: 'active', releaseDate: '2026-07-01', textOutput: true, toolCall: true, zeroCost: true,
      },
      'opencode/newer-paid-model': {
        status: 'active', releaseDate: '2026-09-01', textOutput: true, toolCall: true, zeroCost: false,
      },
    } satisfies Record<string, ModelCatalogMetadata>;

    const { entries, basis } = derive({
      catalogIds,
      catalogMetadata,
      policy: { maxEntries: 2, includeFreeTier: true },
    });

    expect(entries).toEqual([
      { provider: GATEWAY, model: 'deepseek/current' },
      { provider: GATEWAY, model: 'opencode/free-model' },
    ]);
    expect(basis.find((candidate) => candidate.freeTier)).toMatchObject({
      model: 'opencode/free-model',
      zeroCost: true,
    });
  });

  it('does not infer zero cost from the gateway prefix when a verbose record lacks valid cost', () => {
    const catalogIds = ['deepseek/current', 'opencode/cost-unknown'];
    const catalogMetadata = {
      'deepseek/current': {
        status: 'active', releaseDate: '2026-08-01', textOutput: true, toolCall: true,
      },
      'opencode/cost-unknown': {
        status: 'active', releaseDate: '2026-09-01', textOutput: true, toolCall: true,
      },
    } satisfies Record<string, ModelCatalogMetadata>;

    const { entries, basis } = derive({
      catalogIds,
      catalogMetadata,
      policy: { maxEntries: 2, includeFreeTier: true },
    });

    expect(entries).toEqual([{ provider: GATEWAY, model: 'deepseek/current' }]);
    expect(basis).not.toContainEqual(expect.objectContaining({ model: 'opencode/cost-unknown' }));
  });

  it('excludes the exact primary route while retaining another model from its provider', () => {
    const { entries } = derive({
      primary: { provider: GATEWAY, model: 'deepseek/deepseek-v4-pro' },
      policy: { maxEntries: 4, includeFreeTier: false },
    });
    expect(entries.map((e) => e.model)).toEqual([
      'deepseek/deepseek-v4-flash',
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

// Live 2026-08-16 finding: credentialed gateways list EVERY model a key
// unlocks; the old later-entry pick then lands on embeddings (openai tail
// = text-embedding-ada-002) or video generators (google tail = veo-3.1-*) —
// models that can never serve a text turn.
describe('non-chat catalogue filtering', () => {
  const OPENAI_TAIL = [
    'openai/gpt-5.2', 'openai/o3', 'openai/o3-pro',
    'openai/gpt-image-2', 'openai/gpt-realtime-2.1',
    'openai/text-embedding-3-large', 'openai/text-embedding-ada-002',
  ];
  const GOOGLE_TAIL = [
    'google/gemini-3.1-pro', 'google/gemma-4-31b-it',
    'google/imagen-4-ultra', 'google/lyria-3-pro-preview',
    'google/veo-3.1-lite-generate-preview',
  ];

  it('classifies the observed live non-chat families', () => {
    for (const id of [
      'openai/text-embedding-ada-002', 'openai/gpt-image-2', 'openai/gpt-realtime-2.1',
      'google/veo-3.1-lite-generate-preview', 'google/imagen-4-ultra', 'google/lyria-3-pro-preview',
      'openai/whisper-1', 'openai/tts-1-hd', 'openai/dall-e-3', 'openai/gpt-4o-audio-preview',
    ]) {
      expect(isNonChatCatalogModel(id), id).toBe(true);
    }
    for (const id of [
      'deepseek/deepseek-v4-pro', 'glm/glm-5.2', 'google/gemma-4-31b-it',
      'google/gemini-3.1-pro', 'openai/o3-pro', 'opencode/nemotron-3.5-lightning-free',
    ]) {
      expect(isNonChatCatalogModel(id), id).toBe(false);
    }
  });

  it('the newest-per-provider pick skips a non-chat catalogue tail (openai embeddings)', () => {
    const { entries } = derive({ catalogIds: OPENAI_TAIL, policy: { maxEntries: 1, includeFreeTier: false } });
    expect(entries).toEqual([{ provider: GATEWAY, model: 'openai/o3-pro' }]);
  });

  it('the newest-per-provider pick skips video/music generators (google veo/lyria tail)', () => {
    const { entries } = derive({ catalogIds: GOOGLE_TAIL, policy: { maxEntries: 1, includeFreeTier: false } });
    expect(entries).toEqual([{ provider: GATEWAY, model: 'google/gemma-4-31b-it' }]);
  });

  it('a provider whose ids are ALL non-chat yields no candidate at all', () => {
    const { entries, basis } = derive({
      catalogIds: ['openai/text-embedding-3-large', 'openai/text-embedding-ada-002', 'deepseek/deepseek-v4-pro'],
      policy: { maxEntries: 4, includeFreeTier: false },
    });
    expect(basis.some((c) => c.catalogProvider === 'openai')).toBe(false);
    expect(entries).toEqual([{ provider: GATEWAY, model: 'deepseek/deepseek-v4-pro' }]);
  });

  it('an operator preferModels pin BYPASSES the heuristic (explicit intent wins)', () => {
    const { entries } = derive({
      catalogIds: OPENAI_TAIL,
      policy: { maxEntries: 1, includeFreeTier: false, preferModels: { openai: 'openai/gpt-realtime-2.1' } },
    });
    expect(entries).toEqual([{ provider: GATEWAY, model: 'openai/gpt-realtime-2.1' }]);
  });
});

// Live 2026-09-22 finding (fleet host `opencode models --pure --verbose`,
// opencode 1.18.31): three DeepSeek ids share status, capabilities, family and
// release date. The former later-entry tie break therefore let catalogue
// position pick the experimental vision variant, and every one of the three
// could win depending on listing order. Selection must depend on metadata and
// the id itself, never on where an id appears in the listing.
function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)])
      .map((rest) => [value, ...rest]));
}

const LIVE_DEEPSEEK_IDS = [
  'deepseek/deepseek-chat',
  'deepseek/deepseek-flash',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-vision-exp',
  'deepseek/deepseek-v4-pro',
] as const;

// Parsed (post-capture) metadata of the live records. `deepseek-chat` is
// config-defined: its verbose record carries an empty release date, which the
// capture layer drops.
const LIVE_DEEPSEEK_METADATA = {
  'deepseek/deepseek-chat': {
    status: 'active', textOutput: true, toolCall: true, zeroCost: true,
  },
  'deepseek/deepseek-flash': {
    status: 'active', releaseDate: '2026-09-10', textOutput: true, toolCall: true, zeroCost: false,
  },
  'deepseek/deepseek-v4-flash': {
    status: 'active', releaseDate: '2026-09-10', textOutput: true, toolCall: true, zeroCost: false,
  },
  'deepseek/deepseek-v4-flash-vision-exp': {
    status: 'active', releaseDate: '2026-09-10', textOutput: true, toolCall: true, zeroCost: false,
  },
  'deepseek/deepseek-v4-pro': {
    status: 'active', releaseDate: '2026-08-12', textOutput: true, toolCall: true, zeroCost: false,
  },
} satisfies Record<string, ModelCatalogMetadata>;

function winnersAcrossOrders(
  ids: readonly string[],
  opts: {
    catalogMetadata?: Readonly<Record<string, ModelCatalogMetadata>>;
    evidenceFor?: (id: string) => CandidateEvidence;
  } = {},
): { orders: number; winners: string[] } {
  const orders = permutations(ids);
  const winners = new Set(orders.map((order) => derive({
    catalogIds: order,
    ...(opts.catalogMetadata ? { catalogMetadata: opts.catalogMetadata } : {}),
    ...(opts.evidenceFor ? { evidenceFor: opts.evidenceFor } : {}),
    policy: { maxEntries: 1, includeFreeTier: false },
  }).entries[0]?.model ?? 'none'));
  return { orders: orders.length, winners: [...winners].sort() };
}

describe('catalogue-order invariance', () => {
  it('selects the same DeepSeek representative under all 120 orders of the live catalogue', () => {
    const result = winnersAcrossOrders(LIVE_DEEPSEEK_IDS, { catalogMetadata: LIVE_DEEPSEEK_METADATA });
    expect(result).toEqual({ orders: 120, winners: ['deepseek/deepseek-v4-flash'] });
  });

  it('never lets listing order choose among metadata-free ids either', () => {
    const result = winnersAcrossOrders(['glm/glm-5', 'glm/glm-5-turbo', 'glm/glm-5.1', 'glm/glm-5.2']);
    expect(result).toEqual({ orders: 24, winners: ['glm/glm-5.2'] });
  });

  it('ranks an older stable sibling above a newer experimental id', () => {
    const result = winnersAcrossOrders(
      ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash-vision-exp'],
      { catalogMetadata: LIVE_DEEPSEEK_METADATA },
    );
    expect(result).toEqual({ orders: 2, winners: ['deepseek/deepseek-v4-pro'] });
  });

  it('falls through dead same-day ids to the stable model, not the experimental variant', () => {
    const dead = new Set(['deepseek/deepseek-flash', 'deepseek/deepseek-v4-flash']);
    const result = winnersAcrossOrders(LIVE_DEEPSEEK_IDS, {
      catalogMetadata: LIVE_DEEPSEEK_METADATA,
      evidenceFor: (id) => (dead.has(id) ? 'dead' : 'unknown'),
    });
    expect(result).toEqual({ orders: 120, winners: ['deepseek/deepseek-v4-pro'] });
  });

  it('still lets an exact operator pin select an experimental id', () => {
    const { entries, basis } = derive({
      catalogIds: LIVE_DEEPSEEK_IDS,
      catalogMetadata: LIVE_DEEPSEEK_METADATA,
      policy: {
        maxEntries: 1,
        includeFreeTier: false,
        preferModels: { deepseek: 'deepseek/deepseek-v4-flash-vision-exp' },
      },
    });
    expect(entries).toEqual([{ provider: GATEWAY, model: 'deepseek/deepseek-v4-flash-vision-exp' }]);
    expect(basis[0]).toMatchObject({ eligibilityBasis: 'operator-pin' });
  });

  it('keeps an explicit pre-release status at its own tier rather than promoting it', () => {
    const catalogIds = ['glm/glm-next-alpha', 'glm/glm-5.2-preview'];
    const catalogMetadata = {
      'glm/glm-next-alpha': {
        status: 'alpha', releaseDate: '2026-09-15', textOutput: true, toolCall: true,
      },
      'glm/glm-5.2-preview': {
        status: 'active', releaseDate: '2026-08-01', textOutput: true, toolCall: true,
      },
    } satisfies Record<string, ModelCatalogMetadata>;

    // The active-but-preview-named id is demoted only to the preview tier;
    // the explicit alpha status stays in the lower alpha tier.
    const result = winnersAcrossOrders(catalogIds, { catalogMetadata });
    expect(result).toEqual({ orders: 2, winners: ['glm/glm-5.2-preview'] });
  });
});

describe('isExperimentalCatalogModel', () => {
  it('classifies lifecycle tokens carried in the model id', () => {
    for (const id of [
      'deepseek/deepseek-v4-flash-vision-exp',
      'google/gemini-3.1-pro-preview',
      'openai/o5-alpha',
      'acme/model-beta-2',
      'acme/model_experimental',
      'acme/model.exp',
      'Acme/Model-Preview',
    ]) {
      expect(isExperimentalCatalogModel(id), id).toBe(true);
    }
    for (const id of [
      'deepseek/deepseek-flash',
      'deepseek/deepseek-v4-pro',
      'glm/glm-5-turbo',
      'minimax/MiniMax-M2.1-highspeed',
      'opencode/nemotron-3.5-lightning-free',
      'openai/o3-pro',
      'acme/expert-coder',
      'acme/betamax',
      'exp/stable-model',
    ]) {
      expect(isExperimentalCatalogModel(id), id).toBe(false);
    }
  });
});
