// src/runtimes/chat/memory/query-router.ts
// Deterministic query-dependent routing for WhatsApp memory retrieval.
//
// Implements the Phase 3 retrieval policy: WhatsApp queries fan out to the
// right namespace(s) first based on user intent — facts-first for identity
// and preference questions, raw-first for quote/summarize/catch-up questions,
// hybrid for mixed/ambiguous "what have I discussed" questions.
//
// No LLM classifier; pure substring heuristics, case-insensitive.

export type QueryIntent = 'facts' | 'raw' | 'hybrid';

export interface RoutedQuery {
  intent: QueryIntent;
  namespaces: string[]; // ordered: first-tier first, fallbacks after
}

/** Phrases that indicate an identity / preference / standing-fact question. */
const FACTS_TRIGGERS: readonly string[] = [
  'who is',
  'what does',
  'preference',
  'remember',
  'email address',
  'phone',
];

/** Phrases that indicate a thread catch-up / quote-me / what-did-I-say question. */
const RAW_TRIGGERS: readonly string[] = [
  'what did i say',
  'quote',
  'summarize thread',
  'catch me up',
  'last time',
];

/** Phrases that indicate a mixed / ambiguous retrieval. */
const HYBRID_TRIGGERS: readonly string[] = [
  'what have i discussed',
  'this week with',
  'talked about',
];

const FACTS_NS = 'whatsapp-facts';
const CHUNKS_NS = 'whatsapp-chunks';
const SUMMARIES_NS = 'whatsapp-summaries';

/**
 * Return true if any trigger phrase appears in `lower` (already lowercased).
 */
function anyMatch(lower: string, triggers: readonly string[]): boolean {
  for (const t of triggers) {
    if (lower.includes(t)) return true;
  }
  return false;
}

/**
 * Classify a natural-language query into a retrieval intent, and return the
 * namespaces to query in fan-out order. When `override` is a non-empty array,
 * the caller's explicit choice wins regardless of query text; the intent is
 * reported as 'hybrid' to reflect that the router deferred to the caller.
 *
 * Policy (see plan §Retrieval Policy):
 *   identity/preference/standing fact  ->  whatsapp-facts, then summaries, chunks
 *   thread catch-up / quote / what did I say  ->  summaries, chunks, then facts
 *   mixed / ambiguous  ->  summaries, then facts and chunks
 *
 * Precedence when multiple buckets match the same query text:
 *   hybrid > raw > facts
 * Hybrid wins because multi-source questions naturally need both signals;
 * raw wins over facts because "what did I say" is more specific than a
 * standing-fact phrase that happens to appear in the same sentence.
 */
export function routeQuery(query: string, override?: string[]): RoutedQuery {
  if (override && override.length > 0) {
    return { intent: 'hybrid', namespaces: [...override] };
  }

  const lower = query.toLowerCase();

  const hitHybrid = anyMatch(lower, HYBRID_TRIGGERS);
  const hitRaw = anyMatch(lower, RAW_TRIGGERS);
  const hitFacts = anyMatch(lower, FACTS_TRIGGERS);

  if (hitHybrid) {
    return {
      intent: 'hybrid',
      namespaces: [SUMMARIES_NS, FACTS_NS, CHUNKS_NS],
    };
  }

  if (hitRaw) {
    return {
      intent: 'raw',
      namespaces: [SUMMARIES_NS, CHUNKS_NS, FACTS_NS],
    };
  }

  if (hitFacts) {
    return {
      intent: 'facts',
      namespaces: [FACTS_NS, SUMMARIES_NS, CHUNKS_NS],
    };
  }

  // Unknown / generic: safest fan-out is hybrid.
  return {
    intent: 'hybrid',
    namespaces: [SUMMARIES_NS, FACTS_NS, CHUNKS_NS],
  };
}
