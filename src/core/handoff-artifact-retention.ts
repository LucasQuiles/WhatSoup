import { MS_PER_DAY } from '../lib/time-units.ts';
import type { Database } from './database.ts';

/** Age at which cross-provider continuity artifacts become sweep-eligible. */
export const HANDOFF_ARTIFACT_RETENTION_MS = MS_PER_DAY;

/** Maximum expired artifacts deleted by each statement in the canonical sweep. */
export const HANDOFF_ARTIFACT_RETENTION_BATCH_SIZE = 100;

function hasHandoffArtifactTable(db: Database): boolean {
  return db.raw.prepare(`
    SELECT 1
      FROM sqlite_master
     WHERE type = 'table'
       AND name = 'agent_handoff_artifacts'
  `).get() !== undefined;
}

/**
 * Drain every artifact strictly older than the supplied cutoff through
 * deterministic bounded delete statements. The initial count bounds the loop,
 * so a malformed driver result cannot turn retention into an unbounded loop.
 * Non-agent databases legitimately lack this optional table.
 */
export function deleteExpiredHandoffArtifacts(db: Database, cutoffMs: number): number {
  if (!hasHandoffArtifactTable(db)) return 0;
  const countRow = db.raw.prepare(`
    SELECT COUNT(*) AS count
      FROM agent_handoff_artifacts
     WHERE updated_at < ?
  `).get(cutoffMs) as { count: number | bigint };
  const expiredCount = Number(countRow.count);
  if (!Number.isSafeInteger(expiredCount) || expiredCount < 0) {
    throw new Error('handoff artifact retention received an invalid expired-row count');
  }
  if (expiredCount === 0) return 0;

  const deleteBatch = db.raw.prepare(`
    DELETE FROM agent_handoff_artifacts
     WHERE conversation_key IN (
       SELECT conversation_key
         FROM agent_handoff_artifacts
        WHERE updated_at < ?
        ORDER BY updated_at ASC, conversation_key ASC
        LIMIT ?
     )
  `);
  let deleted = 0;
  const batches = Math.ceil(expiredCount / HANDOFF_ARTIFACT_RETENTION_BATCH_SIZE);
  for (let batch = 0; batch < batches; batch += 1) {
    const changes = Number(deleteBatch.run(cutoffMs, HANDOFF_ARTIFACT_RETENTION_BATCH_SIZE).changes);
    if (changes <= 0 || changes > HANDOFF_ARTIFACT_RETENTION_BATCH_SIZE) {
      throw new Error('handoff artifact retention batch did not make bounded progress');
    }
    deleted += changes;
  }
  return deleted;
}
