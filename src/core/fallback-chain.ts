import { asRecord } from '../lib/type-guards.ts';
import { resolveAgentModel } from './agent-model.ts';

export interface AgentFallbackEntry {
  provider: string;
  model?: string;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function normalizeFallbackEntriesFromAgentOptions(
  agentOptions: Record<string, unknown> | null | undefined,
): AgentFallbackEntry[] {
  const opts = agentOptions ?? {};
  const rawChain = opts['fallbacks'];
  if (Array.isArray(rawChain)) {
    const out: AgentFallbackEntry[] = [];
    for (const raw of rawChain) {
      const item = asRecord(raw);
      if (!item) continue;
      const provider = stringOrUndefined(item['provider']);
      if (!provider) continue;
      const model = stringOrUndefined(item['model']);
      out.push(model ? { provider, model } : { provider });
    }
    return out;
  }

  const provider = stringOrUndefined(opts['fallbackProvider']);
  if (!provider) return [];
  const model = stringOrUndefined(opts['fallbackModel']);
  return [model ? { provider, model } : { provider }];
}

export function normalizeFallbackEntriesFromInstanceConfig(
  cfg: Record<string, unknown> | null | undefined,
): AgentFallbackEntry[] {
  return normalizeFallbackEntriesFromAgentOptions(asRecord(cfg?.['agentOptions']));
}

export function fallbackEntryKey(entry: AgentFallbackEntry): string {
  return JSON.stringify([entry.provider, entry.model ?? null]);
}

/**
 * A primary provider that authenticates against a single subscription/session
 * surface (the `*-cli` harnesses: claude-cli, opencode-cli, codex-cli) cannot
 * recover from its own turn-terminal limit (session / usage / weekly cap) without
 * an INDEPENDENT fallback — an entry whose provider differs from the primary.
 *
 * Returns true when such a primary has NO independent fallback target configured:
 * exactly the incident precondition (primary=claude-cli, fallbacks=[]) where
 * a session limit stalls the instance with no rollover and (historically) no alert.
 * Callers use this to fail LOUD at construction instead of failing silent at limit.
 */
export function lacksIndependentFallback(
  primaryProvider: string | null | undefined,
  entries: AgentFallbackEntry[],
): boolean {
  const primary = stringOrUndefined(primaryProvider ?? undefined) ?? 'claude-cli';
  if (!primary.endsWith('-cli')) return false;
  return !entries.some((entry) => entry.provider !== primary);
}

export function isSameAsPrimaryFallbackEntry(
  entry: AgentFallbackEntry,
  rawConfig: Record<string, unknown>,
): boolean {
  const opts = asRecord(rawConfig['agentOptions']) ?? {};
  const primaryProvider = stringOrUndefined(opts['provider']) ?? 'claude-cli';
  if (entry.provider !== primaryProvider) return false;
  const primaryModel = resolveAgentModel(rawConfig);
  if (entry.model === undefined) {
    // A model-less entry targets the provider default model. It collides with
    // the primary only when the primary would also use the provider default —
    // a primary that pins an explicit model is a distinct target.
    return primaryModel === undefined;
  }
  return entry.model === primaryModel;
}
