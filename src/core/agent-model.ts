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
 * Resolve the agent subprocess model from an instance config. Prefers the
 * top-level `model`; falls back to `models.conversation` so per-role models
 * declared in the canonical models map propagate to the agent runtime even
 * when the top-level field is unset. Returns undefined when neither is set
 * or both are empty/non-string.
 */
export function resolveAgentModel(
  cfg: { model?: unknown; models?: unknown } | null | undefined,
): string | undefined {
  const top = cfg?.model;
  if (typeof top === 'string' && top.trim() !== '') return top;
  const models = cfg?.models;
  if (models && typeof models === 'object') {
    const conv = (models as Record<string, unknown>)['conversation'];
    if (typeof conv === 'string' && conv.trim() !== '') return conv;
  }
  return undefined;
}
