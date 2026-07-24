// Native reasoning-control descriptor for the `/model` drill-down Level-3
// (reasoning-effort), shown only for a (provider, model) that natively
// supports one. Pure, standalone — no I/O, no runtime wiring.
//
// Phase-1: only claude-cli is wired (its `--effort` flag, threaded through
// providerConfig.effort → resolveProviderArgs at session.ts). OpenAI
// (`reasoning_effort`) and Anthropic (thinking-budget) support reasoning
// control natively too, but that wiring is a Phase-2 fast-follow (the F4
// bounded-effort increment) — everything else is a leaf (null, no Level-3).

/** `flag-levels` is the Phase-1 kind; the extension point for Phase-2 kinds. */
export interface ReasoningControl {
  kind: 'flag-levels';
  /** Ordered strongest -> weakest, native provider values. */
  options: readonly string[];
}

/** claude-cli `--effort` levels, strongest -> weakest. No `max` (owner decision). */
const CLAUDE_CLI_EFFORT_LEVELS: readonly string[] = Object.freeze(['xhigh', 'high', 'medium', 'low']);

/**
 * Reasoning control for `provider`/`model`, or null when the pair has none
 * (leaf, no Level-3). Phase-1 only branches on `provider`; `model` is part
 * of the signature for the Phase-2 per-model gating on openai/anthropic
 * (E31: a model that supports only a subset of levels). Never throws.
 */
export function nativeReasoningControl(provider: string, model: string): ReasoningControl | null {
  void model; // Phase-2 per-model gating hook; Phase-1 branches on provider only.
  if (provider === 'claude-cli') {
    return { kind: 'flag-levels', options: CLAUDE_CLI_EFFORT_LEVELS };
  }
  return null;
}
