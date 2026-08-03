/**
 * Canonical inbound-event lifecycle states — the single source of truth for
 * the domain enum and its derived open-status predicate (#2244/#2250).
 *
 * Lives in a leaf module (no imports) so both `durability.ts` (the SQL
 * boundary and status query) and `reply-guarantee.ts` (the open-status
 * consumer) can share it without pulling each other's weight into their
 * import graphs — and so the enum and predicate can never drift again.
 *
 * Membership notes:
 * - The DB writes 'pending' (ingest), 'turn_done', 'complete', and 'failed'.
 * - 'processing' is not written by current code, but is retained because
 *   recovery queries reference it and historical production rows may carry it.
 * - 'skipped' is deliberately NOT a member: `markInboundSkipped` has always
 *   written 'complete' (with a terminal_reason), so the phantom union member
 *   in the old reply-guarantee `InboundProcessingStatus` modelled nothing.
 */

export const INBOUND_STATUSES = [
  'pending',
  'processing',
  'turn_done',
  'complete',
  'failed',
] as const;

export type InboundStatus = (typeof INBOUND_STATUSES)[number];

/** Type-narrow for values read back across the SQL boundary. */
export function isInboundStatus(value: unknown): value is InboundStatus {
  return typeof value === 'string'
    && (INBOUND_STATUSES as readonly string[]).includes(value);
}

/**
 * Open-status predicate — the single definition of "this inbound is still in
 * flight". Durability's recovery buckets and reply-guarantee both consume
 * this exact set; keep it adjacent to the enum so they cannot drift (#2244).
 */
export const OPEN_INBOUND_STATUSES = [
  'pending',
  'processing',
  'turn_done',
] as const satisfies readonly InboundStatus[];

export function isOpenInboundStatus(
  status: InboundStatus | undefined,
): boolean {
  return status !== undefined
    && (OPEN_INBOUND_STATUSES as readonly string[]).includes(status);
}
