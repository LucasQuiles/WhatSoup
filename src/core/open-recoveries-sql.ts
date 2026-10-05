import { syntheticSourceMessageIdSql } from './synthetic-turn-source.ts';

/**
 * The open operator catch-up selector, shared by the turn-recovery store's
 * supervisor counts and the recovery-evidence ledger so the two counts cannot
 * drift apart (#3754). An open catch-up is a `recovery_pending_operator_catchup`
 * link with no `superseded_by_operator_catchup` closure for the same
 * (inbound_seq, recovery_plan_id).
 *
 * The CTE yields one row. `count` is user-facing: links whose source inbound is
 * not a synthetic scheduled-job turn. `synthetic` counts the rest, residue
 * that owes no user a reply. A link whose source inbound row is missing has a
 * NULL message id, so it lands in `count` (fail closed). Per-seq open-link
 * checks (turn-recovery-orphan-settle.ts, the migration triggers,
 * recovery-catchup-closure.ts) ask whether one seq has an open link, not who is
 * owed a reply, so they keep their own unsplit predicate.
 */
export const OPEN_RECOVERIES_CTE_SQL = `open_recoveries AS (
          SELECT
            COALESCE(SUM(CASE WHEN ${syntheticSourceMessageIdSql('source.message_id')} THEN 0 ELSE 1 END), 0)
              AS count,
            COALESCE(SUM(CASE WHEN ${syntheticSourceMessageIdSql('source.message_id')} THEN 1 ELSE 0 END), 0)
              AS synthetic
          FROM inbound_disposition_links pending
          LEFT JOIN inbound_events source ON source.seq = pending.inbound_seq
          WHERE pending.disposition = 'recovery_pending_operator_catchup'
            AND NOT EXISTS (
              SELECT 1
              FROM inbound_disposition_links closure
              WHERE closure.inbound_seq = pending.inbound_seq
                AND closure.recovery_plan_id = pending.recovery_plan_id
                AND closure.disposition = 'superseded_by_operator_catchup'
            )
        )`;
