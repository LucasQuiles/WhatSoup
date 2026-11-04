/**
 * Extract the usage-limit reset time from a provider usage-limit message.
 *
 * Claude usage-limit notices often name when the cap resets — e.g.
 *   "resets at 3pm", "resets at 15:00", "try again at 9:30am",
 *   "will be available at 11pm", or a raw Unix-epoch seconds value.
 * The fallback state machine uses this to schedule auto-revert to the primary
 * provider. Parsing is conservative: anything it cannot confidently interpret
 * yields `null`, and the caller then applies a default rolling-window estimate.
 *
 * Returned times are always in the future relative to `now` — a clock time like
 * "3pm" that has already passed today is rolled forward to tomorrow.
 */
export function extractUsageLimitResetTime(text: string, now: Date = new Date()): Date | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lower = text.toLowerCase();

  // Clock time after a reset cue takes precedence over an incidental long number.
  const cue = /(?:reset[s]?|available|come\s+back|try\s+again|back)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?!\d)\s*(am|pm)?/i;
  const match = lower.match(cue);
  if (match) {
    let hour = Number.parseInt(match[1]!, 10);
    const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
    const meridiem = match[3];
    if (
      Number.isFinite(hour)
      && Number.isFinite(minute)
      && hour >= 0
      && minute >= 0
      && minute < 60
      && (meridiem ? hour >= 1 && hour <= 12 : hour <= 23)
    ) {
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      const candidate = new Date(now);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
      return candidate;
    }
  }

  // The epoch must directly follow a reset cue so quota figures are not misread.
  const epochMatch = lower.match(
    /(?:reset[s]?|available|try\s+again|come\s+back|back)\D{0,12}(1[5-9]\d{8}|[2-9]\d{9})(\d{3})?\b/,
  );
  if (epochMatch) {
    const seconds = epochMatch[1]!;
    const millis = epochMatch[2];
    const epochMs = millis
      ? Number.parseInt(seconds + millis, 10)
      : Number.parseInt(seconds, 10) * 1000;
    if (Number.isFinite(epochMs) && epochMs > now.getTime()) return new Date(epochMs);
  }

  return null;
}
