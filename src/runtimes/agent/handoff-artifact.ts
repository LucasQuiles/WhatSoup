/**
 * Persistence for cross-harness handoff artifacts.
 *
 * One warm, per-conversation artifact (distilled summary + seeded artifacts)
 * that {@link buildHandoffPrelude} reads when a conversation fails over to a
 * stand-in provider. The artifact is an OPTIMISATION, never a hard dependency —
 * a missing or stale row degrades the handoff to verbatim-only, so a write
 * failure here can never block a turn.
 *
 * Mirrors the idempotent `ensureAgentSchema` DDL/helper convention in
 * `session-db.ts`; the {@link HandoffArtifact} shape is the single definition
 * shared with the composer.
 */

import type { Database } from '../../core/database.ts';
import type { HandoffArtifact } from './handoff-prelude.ts';

export type { HandoffArtifact } from './handoff-prelude.ts';
export {
  HANDOFF_ARTIFACT_RETENTION_BATCH_SIZE,
  HANDOFF_ARTIFACT_RETENTION_MS,
  deleteExpiredHandoffArtifacts,
} from '../../core/handoff-artifact-retention.ts';

/**
 * Handoff artifacts exist only for short-lived cross-provider continuity.
 * Their summary, seeded artifact content, source provider/model, and token
 * baseline become eligible for deletion after the same 24-hour window.
 */
const HANDOFF_ARTIFACT_DDL = `
CREATE TABLE IF NOT EXISTS agent_handoff_artifacts (
  conversation_key TEXT PRIMARY KEY,
  summary TEXT,
  seeded_artifacts TEXT,
  updated_at INTEGER NOT NULL,
  source_provider TEXT NOT NULL,
  source_model TEXT,
  token_baseline INTEGER NOT NULL DEFAULT 0
);
`;

/** Create the handoff-artifact table if absent. Idempotent. */
export function ensureHandoffArtifactSchema(db: Database): void {
  db.raw.exec(HANDOFF_ARTIFACT_DDL);
}

function rowToArtifact(row: Record<string, unknown>): HandoffArtifact {
  return {
    conversationKey: row['conversation_key'] as string,
    summary: (row['summary'] as string | null) ?? null,
    seededArtifacts: (row['seeded_artifacts'] as string | null) ?? null,
    updatedAt: Number(row['updated_at']),
    sourceProvider: row['source_provider'] as string,
    sourceModel: (row['source_model'] as string | null) ?? null,
    tokenBaseline: Number(row['token_baseline'] ?? 0),
  };
}

/**
 * Insert or replace the artifact for a conversation. The single-statement
 * upsert is atomic, so a concurrent reader sees either the old or the new row,
 * never a torn write. Requires {@link ensureHandoffArtifactSchema} to have run.
 */
export function upsertHandoffArtifact(db: Database, artifact: HandoffArtifact): void {
  db.raw
    .prepare(`
      INSERT INTO agent_handoff_artifacts
        (conversation_key, summary, seeded_artifacts, updated_at, source_provider, source_model, token_baseline)
      VALUES
        (@conversation_key, @summary, @seeded_artifacts, @updated_at, @source_provider, @source_model, @token_baseline)
      ON CONFLICT(conversation_key) DO UPDATE SET
        summary = excluded.summary,
        seeded_artifacts = excluded.seeded_artifacts,
        updated_at = excluded.updated_at,
        source_provider = excluded.source_provider,
        source_model = excluded.source_model,
        token_baseline = excluded.token_baseline
    `)
    .run({
      conversation_key: artifact.conversationKey,
      summary: artifact.summary,
      seeded_artifacts: artifact.seededArtifacts,
      updated_at: artifact.updatedAt,
      source_provider: artifact.sourceProvider,
      source_model: artifact.sourceModel,
      token_baseline: artifact.tokenBaseline,
    });
}

/** Read the artifact for a conversation, or null when none exists. */
export function getHandoffArtifact(db: Database, conversationKey: string): HandoffArtifact | null {
  const row = db.raw
    .prepare('SELECT * FROM agent_handoff_artifacts WHERE conversation_key = ?')
    .get(conversationKey) as Record<string, unknown> | undefined;
  return row ? rowToArtifact(row) : null;
}

/** Delete a conversation's artifact (e.g. on /new or workspace reset). Idempotent. */
export function deleteHandoffArtifact(db: Database, conversationKey: string): void {
  db.raw.prepare('DELETE FROM agent_handoff_artifacts WHERE conversation_key = ?').run(conversationKey);
}

function hasHandoffArtifactTable(db: Database): boolean {
  return db.raw.prepare(`
    SELECT 1
      FROM sqlite_master
     WHERE type = 'table'
       AND name = 'agent_handoff_artifacts'
  `).get() !== undefined;
}

function distinctNonEmptyValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export type HandoffArtifactInvalidator = (conversationKeys: readonly string[]) => void;

/**
 * Delete artifacts for the supplied conversations. The table is optional for
 * non-agent instances, so its absence is a valid zero-result state.
 */
export function deleteHandoffArtifacts(db: Database, conversationKeys: readonly string[]): number {
  const keys = distinctNonEmptyValues(conversationKeys);
  if (keys.length === 0 || !hasHandoffArtifactTable(db)) return 0;
  const placeholders = keys.map(() => '?').join(',');
  const result = db.raw.prepare(
    `DELETE FROM agent_handoff_artifacts WHERE conversation_key IN (${placeholders})`,
  ).run(...keys);
  return Number(result.changes);
}

/**
 * Clear a conversation's messages and its derived handoff artifact together.
 * The artifact is invalidated first so a later local message mutation failure
 * cannot leave cross-provider continuity data available after a clear event.
 */
export function clearChatAndDeleteHandoffArtifact(
  db: Database,
  conversationKey: string,
  invalidate?: HandoffArtifactInvalidator,
): { messages: number; handoffArtifacts: number } {
  if (conversationKey.length === 0) return { messages: 0, handoffArtifacts: 0 };
  invalidate?.([conversationKey]);
  const handoffArtifacts = deleteHandoffArtifacts(db, [conversationKey]);
  const messages = db.clearChat(conversationKey);
  return { messages, handoffArtifacts };
}

/**
 * Revoke messages and invalidate every affected conversation's artifact in
 * privacy-safe order. Conversation ownership is read before soft deletion so
 * provenance remains available for the invalidation; artifact deletion happens
 * before that local mutation so a later failure cannot retain the artifact.
 */
export function deleteMessagesAndHandoffArtifacts(
  db: Database,
  messageIds: readonly string[],
  invalidate?: HandoffArtifactInvalidator,
): { messages: number; handoffArtifacts: number; conversations: number } {
  const ids = distinctNonEmptyValues(messageIds);
  if (ids.length === 0) return { messages: 0, handoffArtifacts: 0, conversations: 0 };
  const conversationKeys = db.getConversationKeysForMessageIds(ids);
  if (conversationKeys.length === 0) {
    return { messages: db.markMessagesDeleted(ids), handoffArtifacts: 0, conversations: 0 };
  }
  invalidate?.(conversationKeys);
  const handoffArtifacts = deleteHandoffArtifacts(db, conversationKeys);
  const messages = db.markMessagesDeleted(ids);
  return { messages, handoffArtifacts, conversations: conversationKeys.length };
}
