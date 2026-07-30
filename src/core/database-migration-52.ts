import type { DatabaseSync } from 'node:sqlite';

export function runMigration52(db: DatabaseSync): void {
  const columns = db
    .prepare("PRAGMA table_info('enrichment_runs')")
    .all() as Array<{ name: string }>;
  if (columns.length === 0) return;

  const knownColumns = new Set(columns.map(({ name }) => name));
  const additions: Array<readonly [string, string]> = [
    ['schema_version', 'ALTER TABLE enrichment_runs ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1)'],
    ['source', "ALTER TABLE enrichment_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy' CHECK (source IN ('online', 'legacy'))"],
    ['status', "ALTER TABLE enrichment_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'legacy_unclassified' CHECK (status IN ('no_work', 'completed', 'partial', 'failed', 'legacy_unclassified'))"],
    ['failure_code', "ALTER TABLE enrichment_runs ADD COLUMN failure_code TEXT NOT NULL DEFAULT 'legacy_unclassified' CHECK (failure_code IN ('none', 'segment_failed', 'selection_failed', 'message_state_write_failed', 'ledger_write_failed', 'legacy_unclassified'))"],
    ['stage', "ALTER TABLE enrichment_runs ADD COLUMN stage TEXT NOT NULL DEFAULT 'none' CHECK (stage IN ('none', 'selection', 'segment', 'message_state', 'ledger'))"],
    ['retryable', 'ALTER TABLE enrichment_runs ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1))'],
    ['evidence_coverage', "ALTER TABLE enrichment_runs ADD COLUMN evidence_coverage TEXT NOT NULL DEFAULT 'legacy_unclassified' CHECK (evidence_coverage IN ('typed', 'legacy_unclassified'))"],
    ['success_at', 'ALTER TABLE enrichment_runs ADD COLUMN success_at TEXT'],
    ['messages_selected', "ALTER TABLE enrichment_runs ADD COLUMN messages_selected INTEGER NOT NULL DEFAULT 0 CHECK (typeof(messages_selected) = 'integer' AND messages_selected >= 0)"],
    ['messages_succeeded', "ALTER TABLE enrichment_runs ADD COLUMN messages_succeeded INTEGER NOT NULL DEFAULT 0 CHECK (typeof(messages_succeeded) = 'integer' AND messages_succeeded >= 0)"],
    ['messages_deferred', "ALTER TABLE enrichment_runs ADD COLUMN messages_deferred INTEGER NOT NULL DEFAULT 0 CHECK (typeof(messages_deferred) = 'integer' AND messages_deferred >= 0)"],
    ['messages_terminal', "ALTER TABLE enrichment_runs ADD COLUMN messages_terminal INTEGER NOT NULL DEFAULT 0 CHECK (typeof(messages_terminal) = 'integer' AND messages_terminal >= 0)"],
    ['facts_queued', "ALTER TABLE enrichment_runs ADD COLUMN facts_queued INTEGER NOT NULL DEFAULT 0 CHECK (typeof(facts_queued) = 'integer' AND facts_queued >= 0)"],
  ];

  for (const [column, statement] of additions) {
    if (!knownColumns.has(column)) db.exec(statement);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_enrichment_runs_source_run_id
      ON enrichment_runs(source, run_id DESC);
    CREATE INDEX IF NOT EXISTS idx_enrichment_runs_online_success_run_id
      ON enrichment_runs(run_id DESC)
      WHERE source = 'online' AND success_at IS NOT NULL;
  `);
}
