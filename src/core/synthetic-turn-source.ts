// A scheduled agent job runs as a synthetic inbound turn (#2144, #2566 slice 3).
// This module owns that turn's message id: how it is minted, and the one SQL
// predicate recovery accounting uses to recognise it (#3754). Such a turn owes
// no user a reply, so recovery never counts it as user-facing catch-up debt.
//
// The predicate is a case-sensitive prefix GLOB, matching exactly what is
// minted below. On inbound_events.message_id SQLite serves it from the
// UNIQUE(message_id) index as a range scan; LIKE is case-insensitive and
// cannot use that index. classifyTurnLane (observability) keeps its stricter
// numeric shape for lane labels and is not a recovery-accounting predicate.
// Capability-obligation replays (`obl:<id>:<attempt>`) are minted too, but they
// re-run a user's turn and still owe that user a reply, so they stay
// user-facing here although scripts/lib/shadow-gate-report.ts calls them synthetic.

export const SYNTHETIC_SOURCE_MESSAGE_ID_PREFIX = 'agentjob-';

/** The journaled message id of one scheduled agent-job occurrence. */
export function scheduledJobInboundMessageId(
  triggerId: number,
  unixSeconds: number,
  occurrenceId: number,
): string {
  return `${SYNTHETIC_SOURCE_MESSAGE_ID_PREFIX}${triggerId}-${unixSeconds}-occ${occurrenceId}`;
}

/**
 * SQL boolean, parenthesized so it composes under NOT, CASE and AND: `column`
 * (`alias.column` or a bare column) holds a synthetic scheduled-job source
 * message id. NULL yields NULL, which every caller treats as not synthetic.
 */
export function syntheticSourceMessageIdSql(column: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(column)) {
    throw new Error('synthetic source SQL column must be an identifier');
  }
  return `(${column} GLOB '${SYNTHETIC_SOURCE_MESSAGE_ID_PREFIX}*')`;
}
