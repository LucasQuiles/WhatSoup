import { resolveAgentModel } from './agent-model.ts';

export interface AgentFallbackEntry {
  provider: string;
  model?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
      const item = record(raw);
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
  return normalizeFallbackEntriesFromAgentOptions(record(cfg?.['agentOptions']));
}

export function fallbackEntryKey(entry: AgentFallbackEntry): string {
  return JSON.stringify([entry.provider, entry.model ?? null]);
}

export function isSameAsPrimaryFallbackEntry(
  entry: AgentFallbackEntry,
  rawConfig: Record<string, unknown>,
): boolean {
  const opts = record(rawConfig['agentOptions']) ?? {};
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
