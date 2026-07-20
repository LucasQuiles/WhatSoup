/**
 * Agent-model resolution shared by the loader, the fleet routes, and the
 * config validator.
 *
 * Lives here (not in instance-loader.ts, its original home) so that
 * agent-config-validator.ts can consume it without a circular import —
 * instance-loader.ts imports the validator. instance-loader.ts re-exports it
 * for existing callers.
 */

/**
 * Resolve the agent subprocess model from an instance config.
 *
 * Precedence (B27 fix 1 — most agent-scoped first):
 *   1. `agentOptions.model` — the agent-scoped knob. This is where the
 *      instance schema puts the agent model and where live configs set it;
 *      before B27 it was never read, so `--model` was silently never passed
 *      at spawn and a configured instance rendered as "not configured".
 *   2. top-level `model`
 *   3. `models.conversation` — per-role models declared in the canonical
 *      models map propagate to the agent runtime when nothing more specific
 *      is set.
 *
 * Returns undefined when none is set or all are empty/non-string.
 */
export function resolveAgentModel(
  cfg:
    | { model?: unknown; models?: unknown; agentOptions?: unknown }
    | null
    | undefined,
): string | undefined {
  const agentOptions = cfg?.agentOptions;
  if (agentOptions && typeof agentOptions === 'object') {
    const agentModel = (agentOptions as Record<string, unknown>)['model'];
    if (typeof agentModel === 'string' && agentModel.trim() !== '') return agentModel;
  }
  const top = cfg?.model;
  if (typeof top === 'string' && top.trim() !== '') return top;
  const models = cfg?.models;
  if (models && typeof models === 'object') {
    const conv = (models as Record<string, unknown>)['conversation'];
    if (typeof conv === 'string' && conv.trim() !== '') return conv;
  }
  return undefined;
}
