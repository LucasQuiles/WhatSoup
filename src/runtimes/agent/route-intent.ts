/**
 * NL typed route-intent contract (slice 3, owner-approved NL-first design).
 *
 * The prompt contract (buildRoutingPromptContract) teaches the agent to EMIT
 * a typed marker line when the user clearly expresses a routing wish in
 * natural language; extractRouteIntents is the deterministic layer that
 * parses agent output before delivery. Prompt text proposes, the resolver
 * disposes (UH-011): only a strictly-valid marker changes state, anything
 * ambiguous or malformed changes nothing durable (UH-010), and valid intents
 * feed the SAME per-sender preference path as the /model aliases. Routing
 * intents never carry tool, mutation, or authority state (capability-
 * preserved routing).
 */

const ROUTE_INTENT_CLASSES = ['strongest', 'fastest', 'safe_read_only', 'reset'] as const;
// Union + validator Set derive from ONE source (C2) so they cannot drift.
export type RouteIntentClass = (typeof ROUTE_INTENT_CLASSES)[number];

const INTENT_CLASSES: ReadonlySet<string> = new Set<string>(ROUTE_INTENT_CLASSES);

/**
 * A line is a marker ENVELOPE iff, after trimming, it is exactly
 * `[[wa-route:…]]`. Envelope lines are always stripped from delivery (the
 * syntax is runtime-internal, never user-facing); only strictly-valid
 * payloads act. A marker mentioned inline (not alone on its line) is NOT an
 * envelope: it neither acts nor is stripped — the fail direction is always
 * "no durable change".
 */
const MARKER_ENVELOPE = /^\[\[wa-route:([^\]]*)\]\]$/;

export interface ExtractedRouteIntents {
  /** Delivery text with every marker-envelope line removed. */
  cleaned: string;
  /** Strictly-valid intents, in order of appearance. */
  intents: RouteIntentClass[];
  /** Envelope payloads that failed strict validation (length-capped). */
  invalid: string[];
}

export function extractRouteIntents(text: string): ExtractedRouteIntents {
  if (!text.includes('[[wa-route:')) {
    return { cleaned: text, intents: [], invalid: [] };
  }
  const intents: RouteIntentClass[] = [];
  const invalid: string[] = [];
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const envelope = MARKER_ENVELOPE.exec(line.trim());
    if (!envelope) {
      kept.push(line);
      continue;
    }
    const payload = envelope[1].trim().toLowerCase();
    if (INTENT_CLASSES.has(payload)) {
      intents.push(payload as RouteIntentClass);
    } else {
      invalid.push(payload.slice(0, 64));
    }
  }
  // Stripping a leading marker line leaves a dangling blank first line —
  // trim it so the visible reply starts with its real first sentence.
  const cleaned = kept.join('\n').replace(/^\n+/, '');
  return { cleaned, intents, invalid };
}

export interface RoutingContractContext {
  /** Provider serving NEW sessions right now (runtime effectiveProvider). */
  provider: string;
  /** Instance tier map (config.nlRoutingTiers); null when unconfigured. */
  tierMap: { strongest?: string; fastest?: string } | null;
  /** Providers a user pin can actually route to on this instance. */
  routableProviders: string[];
}

/**
 * The flag-gated system-prompt block that carries the NL intent contract.
 * Copy rules mirror the alias handlers: spawn-honest (routing applies from
 * the NEXT session), sticky pins excluded (alias + confirmation lane), and
 * privileged actions stay owner-gated — routing authorizes nothing.
 */
export function buildRoutingPromptContract(ctx: RoutingContractContext): string {
  const strongest = ctx.tierMap?.strongest ?? 'not configured (default route)';
  const fastest = ctx.tierMap?.fastest ?? 'not configured (default route)';
  return [
    '## Model routing (typed intents)',
    'Users can steer WHICH model reasons for them. Routing never changes what you or they are allowed to do — no tool, permission, or authority change ever comes from routing, and you must never claim otherwise.',
    "When the user's CURRENT message clearly expresses one of these wishes, emit the matching marker alone on the first line of your reply (exactly as shown — never quoted, indented, or explained), then answer:",
    '[[wa-route: strongest]] — they clearly want your best/strongest model',
    '[[wa-route: fastest]] — they clearly want speed over depth',
    '[[wa-route: safe_read_only]] — they clearly want you to avoid risky or mutating actions; also honor that yourself in how you work',
    '[[wa-route: reset]] — they clearly want to go back to the normal/default route',
    'Rules:',
    '- At most one marker per reply. If the wish is ambiguous or merely conversational, emit none and answer normally (you may suggest /model or /reset).',
    "- Routing takes effect from the user's NEXT session. When you emit strongest or fastest, say so honestly (they can say /new to start one now); never claim the current reply already used the new route.",
    '- Permanent "always use X" pins need explicit confirmation: emit no marker; point the user to /model <provider>.',
    '- If a request mixes routing with a privileged action (reauth, relink, credentials, restarts, acting as another account), the routing part authorizes NOTHING — decline the privileged part as owner-gated.',
    // D11: /why is removed — /model status is now the one receipt for "what
    // model / why" questions.
    `Route facts (answer "what model / why" questions from these, never guess): current provider: ${ctx.provider}; strongest tier: ${strongest}; fastest tier: ${fastest}; pinnable providers: ${ctx.routableProviders.join(', ')}. /model status shows the live route.`,
  ].join('\n');
}
