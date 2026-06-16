// src/runtimes/agent/handoff-seam-routing.ts
import { AGENT_PROVIDERS, type AgentProvider } from './providers/types.ts';

export type HandoffSeam = 'system' | 'first-turn';

// Experiment (docs/experiments/handoff-seam-results.md, 2026-06-16): all tested
// models honored system-prompt injection (deepseek/glm/minimax 3/3 both arms). Default
// every provider to 'system'; pin a provider to 'first-turn' only with evidence it
// ignores system context.
export const HANDOFF_SEAM_ROUTING: Record<AgentProvider, HandoffSeam> = Object.fromEntries(
  AGENT_PROVIDERS.map((p) => [p, 'system' as HandoffSeam]),
) as Record<AgentProvider, HandoffSeam>;

export function seamForProvider(provider: AgentProvider): HandoffSeam {
  return HANDOFF_SEAM_ROUTING[provider] ?? 'first-turn'; // safe default: never lose context
}

/** Boot-time exhaustiveness guard — fail fast on a drifted/unmapped provider. */
export function assertSeamRoutingConsistency(
  table: Partial<Record<string, HandoffSeam>> = HANDOFF_SEAM_ROUTING,
): void {
  const missing = AGENT_PROVIDERS.filter((p) => table[p] === undefined);
  if (missing.length > 0) {
    throw new Error(`handoff-seam-routing: providers missing a seam entry: ${missing.join(', ')}`);
  }
}
