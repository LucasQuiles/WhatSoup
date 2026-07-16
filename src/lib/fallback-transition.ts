/**
 * Fallback transition tracker.
 *
 * Detects when a model fallback starts or clears (primary model recovers),
 * and generates the appropriate user-visible notice. This closes the fallback
 * UX loop: the user is told not only when the bot falls back to a backup
 * model, but also when the primary model comes back online.
 *
 * Pure functions — no side effects, no I/O. The caller persists the
 * transition state and decides when to show the notice.
 */

/** A model reference in the form "provider/model" or just "model". */
export type ModelRef = string;

/** Persisted state from the last transition (stored per-session). */
export interface FallbackTransitionState {
  /** The selected (primary) model ref recorded at the last transition. */
  selectedModel?: ModelRef;
  /** The active (runtime) model ref recorded at the last transition. */
  activeModel?: ModelRef;
  /** The reason recorded at the last transition. */
  reason?: string;
}

/** The transition outcome computed by {@link resolveFallbackTransition}. */
export type FallbackTransition = {
  /** Whether the active model currently differs from the selected model. */
  fallbackActive: boolean;
  /** True when a fallback just started (was not active, now is). */
  fallbackStarted: boolean;
  /** True when a fallback just cleared (was active, now is not). */
  fallbackCleared: boolean;
  /** True when the fallback reason or active model changed mid-fallback. */
  fallbackChanged: boolean;
  /** Summary of the current fallback reason (when active). */
  reasonSummary: string;
  /** The next state to persist. */
  nextState: FallbackTransitionState;
  /** The previous state (echoed back for convenience). */
  previousState: FallbackTransitionState;
};

const NO_STATE: FallbackTransitionState = {};

/**
 * Resolve a fallback transition by comparing the current model state against
 * the persisted transition state.
 *
 * @param params.selectedModel - The user-configured primary model ref.
 * @param params.activeModel - The model currently running (may differ from selected).
 * @param params.reason - Optional reason for the current fallback (e.g., "rate-limited").
 * @param params.state - The persisted transition state from the last call.
 * @returns The transition outcome and next state to persist.
 */
export function resolveFallbackTransition(params: {
  selectedModel: ModelRef;
  activeModel: ModelRef;
  reason?: string;
  state?: FallbackTransitionState;
}): FallbackTransition {
  const { selectedModel, activeModel } = params;
  const reason = params.reason?.trim() || undefined;
  const previousState = params.state ?? NO_STATE;

  const fallbackActive = selectedModel !== activeModel;

  const previousWasActive =
    previousState.selectedModel !== previousState.activeModel &&
    Boolean(previousState.selectedModel) &&
    Boolean(previousState.activeModel);

  // A fallback "started" when it's now active but wasn't before (previous
  // state was clear or absent). If the selected model changed, it's also a
  // start because the user pinned a new primary.
  const fallbackStarted =
    fallbackActive &&
    (!previousWasActive || previousState.selectedModel !== selectedModel);

  // A fallback "cleared" when it was active before but isn't now.
  const fallbackCleared = !fallbackActive && previousWasActive;

  // A fallback "changed" when it's still active but the active model or reason
  // differs from what we persisted (e.g., switched between two backup models).
  const fallbackChanged =
    fallbackActive &&
    !fallbackStarted &&
    (previousState.activeModel !== activeModel ||
      previousState.reason !== reason);

  const nextState: FallbackTransitionState = fallbackActive
    ? { selectedModel, activeModel, reason }
    : {};

  return {
    fallbackActive,
    fallbackStarted,
    fallbackCleared,
    fallbackChanged,
    reasonSummary: reason ?? (fallbackActive ? 'unavailable' : ''),
    nextState,
    previousState,
  };
}

/**
 * Build the user-visible notice when a fallback starts.
 * @returns The notice string, or null if no notice is needed.
 */
export function buildFallbackStartedNotice(params: {
  selectedModel: ModelRef;
  activeModel: ModelRef;
  reason?: string;
}): string | null {
  if (params.selectedModel === params.activeModel) return null;
  const reason = params.reason?.trim();
  const reasonClause = reason ? ` (${reason})` : '';
  return `_Switching to backup model: ${params.activeModel}${reasonClause}. Your messages will continue normally._`;
}

/**
 * Build the user-visible notice when a fallback clears (primary recovers).
 * @returns The notice string, or null if no notice is needed.
 */
export function buildFallbackClearedNotice(params: {
  selectedModel: ModelRef;
  previousActiveModel?: ModelRef;
}): string {
  const selected = params.selectedModel;
  const previous = params.previousActiveModel?.trim();
  if (previous && previous !== selected) {
    return `_Back on primary model: ${selected} (was ${previous}). Continuing normally._`;
  }
  return `_Back on primary model: ${selected}. Continuing normally._`;
}

/**
 * Build the user-visible notice when a fallback changes mid-flight (switched
 * between two backup models).
 * @returns The notice string, or null if no notice is needed.
 */
export function buildFallbackChangedNotice(params: {
  activeModel: ModelRef;
  previousActiveModel?: ModelRef;
  reason?: string;
}): string | null {
  if (!params.previousActiveModel || params.activeModel === params.previousActiveModel) {
    return null;
  }
  const reason = params.reason?.trim();
  const reasonClause = reason ? ` (${reason})` : '';
  return `_Switched backup model to ${params.activeModel}${reasonClause}._`;
}
