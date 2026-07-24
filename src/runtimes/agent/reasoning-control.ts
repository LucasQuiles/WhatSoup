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

/**
 * The reasoning effort a resolved provider config carries (null = none /
 * provider default). SINGLE reader for the `effort` key, so its three consumers
 * cannot drift: session.ts's `--effort` argv builder, SessionManager
 * .getSpawnedEffort() (whose contract is that it reports exactly what spawn
 * threaded), and the pin/recycle diff. The `typeof` guard is load-bearing, not
 * defensive — providerConfig is an untyped `Record<string, unknown>` read from
 * config, and comparing an unguarded non-string `effort` against a guarded read
 * would make the diff see a permanent difference and recycle on every pin.
 *
 * It lives here rather than in session.ts on purpose: this module is a pure
 * zero-import leaf, so consumers reach the reader without importing (or having
 * to mock) the session module.
 */
export function providerConfigEffort(config: Record<string, unknown> | undefined): string | null {
  const raw = config?.['effort'];
  // Empty string normalizes to null so BOTH consumers agree. The argv builder
  // filters falsy (it must — `--effort ''` is a malformed flag), so a reader
  // that returned '' would report an effort the child never received, breaking
  // getSpawnedEffort's contract. Behaviour change vs pre-Slice-3: a configured
  // `effort: ""` previously emitted `--effort ''`; it is now omitted.
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** claude-cli `--effort` levels, strongest -> weakest. No `max` (owner decision). */
const CLAUDE_CLI_EFFORT_LEVELS: readonly string[] = Object.freeze(['xhigh', 'high', 'medium', 'low']);

/**
 * Whether `provider` consumes a reasoning-effort override at spawn. Owns that
 * provider fact for the menu (nativeReasoningControl) and for the spawn-config
 * write (route-resolution applyRouteEffort), split by granularity: which LEVELS
 * a model offers is a menu concern (per-model in Phase-2); whether an effort is
 * written into the spawn config at all is an apply concern.
 *
 * NOT the whole story, and the gap is deliberate to document rather than claim
 * away: the value only reaches the child through the per-provider switch in
 * session.ts resolveProviderArgs, whose `case 'claude-cli'` arm is a THIRD
 * encoding of this fact that does not consult this predicate. So adding a second
 * effort provider is TWO coordinated edits — here, and an argv arm in session.ts
 * — and skipping the argv arm yields the bad failure direction: menu offers the
 * level, pin persists, receipt says "high reasoning", session recycles, and the
 * child still runs at default. The drift-pin test in route-resolution.test.ts
 * asserts through the real argv builder precisely so that omission goes RED.
 */
export function providerHasNativeReasoningControl(provider: string): boolean {
  return provider === 'claude-cli';
}

/**
 * Reasoning control for `provider`/`model`, or null when the pair has none
 * (leaf, no Level-3). Phase-1 only branches on `provider`; `model` is part
 * of the signature for the Phase-2 per-model gating on openai/anthropic
 * (E31: a model that supports only a subset of levels). Never throws.
 */
export function nativeReasoningControl(provider: string, model: string): ReasoningControl | null {
  void model; // Phase-2 per-model gating hook; Phase-1 branches on provider only.
  if (providerHasNativeReasoningControl(provider)) {
    return { kind: 'flag-levels', options: CLAUDE_CLI_EFFORT_LEVELS };
  }
  return null;
}
