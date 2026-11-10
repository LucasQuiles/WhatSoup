/**
 * F7: a stalled-operation kill tells the user to send the message again and
 * finalizes the killed request as failed. The agent must not resume that
 * work on its own. The in-process respawn knows the kill reason; a service
 * restart does not, so the reason is saved on the session checkpoint's
 * `watchdog_state` JSON next to the park (stalled-operation-holds.ts).
 * Proactive resume after a restart reads it and resumes the provider session
 * without a context or continuation turn. The next request the user sends
 * clears it.
 *
 * The hold names the provider session it was recorded for. A checkpoint that
 * moved to another session does not inherit it.
 */
const HOLD_KEY = 'stalledOperationResumeHold';

/**
 * What keeps a service restart from continuing the stopped work: `parked`
 * (no resumable checkpoint names the stopped session, which every build
 * honours), `held` (only the hold, which a build without it ignores),
 * `unprotected` (neither) or `not_needed` (no checkpoint to resume).
 */
export type StalledOperationRestartProtection = 'not_needed' | 'parked' | 'held' | 'unprotected';

function parseWatchdogState(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** The watchdog state with the hold set for `sessionId`, other keys kept. */
export function withStalledOperationResumeHold(
  raw: string | null | undefined,
  sessionId: string,
): string {
  return JSON.stringify({ ...parseWatchdogState(raw), [HOLD_KEY]: { sessionId } });
}

/** The watchdog state without the hold, or null when there is no hold to remove. */
export function withoutStalledOperationResumeHold(raw: string | null | undefined): string | null {
  const state = parseWatchdogState(raw);
  if (!(HOLD_KEY in state)) return null;
  delete state[HOLD_KEY];
  return JSON.stringify(state);
}

/** True when the checkpoint holds proactive resume for exactly this provider session. */
export function stalledOperationResumeHoldApplies(
  raw: string | null | undefined,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  const hold = parseWatchdogState(raw)[HOLD_KEY];
  return typeof hold === 'object'
    && hold !== null
    && (hold as Record<string, unknown>)['sessionId'] === sessionId;
}
