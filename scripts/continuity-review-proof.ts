import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { assertNoSecretLike } from './artifact-redaction.ts';

const PAYLOAD_TYPE = 'continuity-review-intent-proof';
const MIN_SCHEMA_VERSION = 35;

interface CliArgs {
  db: string;
  out: string;
  help: boolean;
}

interface ReviewIntentProofRow {
  inboundSeq: number;
  status: string;
  reason: string;
  source: string;
  createdAt: string;
  completedAt: string | null;
  terminalOutboundExists: boolean;
  actionAudit: {
    actorRecorded: boolean;
    reasonRecorded: boolean;
  };
}

function usage(): string {
  return [
    'Usage: continuity-review-proof.ts --db path/to/bot.db --out review-proof.json',
    '',
    'Emits a redaction-safe, read-only proof artifact for continuity review intents.',
  ].join('\n');
}

export function parseArgs(argv: string[], cwd = process.cwd()): CliArgs {
  const args: Partial<CliArgs> = { help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--db') {
      const value = argv[index + 1];
      if (!value) throw new Error('--db requires a path');
      args.db = path.resolve(cwd, value);
      index += 1;
    } else if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out requires a path');
      args.out = path.resolve(cwd, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }

  if (!args.help && !args.db) throw new Error('--db is required');
  if (!args.help && !args.out) throw new Error('--out is required');
  return args as CliArgs;
}

function requireMigratedSchema(db: DatabaseSync): void {
  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as { version: number | null } | undefined;
  const version = Number(row?.version ?? 0);
  if (version < MIN_SCHEMA_VERSION) {
    throw new Error(`schema_migrations version ${version} is below required ${MIN_SCHEMA_VERSION}`);
  }

  const columns = (
    db.prepare("PRAGMA table_info('continuity_review_intents')").all() as Array<{ name: string }>
  ).map((col) => col.name);
  for (const column of ['inbound_seq', 'status', 'reason', 'source', 'created_at', 'completed_at', 'completed_by', 'completion_reason']) {
    if (!columns.includes(column)) {
      throw new Error(`continuity_review_intents missing required column ${column}`);
    }
  }
}

function readReviewIntentProofRows(dbPath: string): ReviewIntentProofRow[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    requireMigratedSchema(db);
    const rows = db.prepare(`
      SELECT
        continuity_review_intents.inbound_seq,
        continuity_review_intents.status,
        continuity_review_intents.reason,
        continuity_review_intents.source,
        continuity_review_intents.created_at,
        continuity_review_intents.completed_at,
        (continuity_review_intents.completed_by IS NOT NULL) AS actor_recorded,
        (continuity_review_intents.completion_reason IS NOT NULL) AS reason_recorded,
        EXISTS (
          SELECT 1
          FROM outbound_ops
          WHERE outbound_ops.source_inbound_seq = continuity_review_intents.inbound_seq
            AND outbound_ops.is_terminal = 1
        ) AS terminal_outbound_exists
      FROM continuity_review_intents
      ORDER BY continuity_review_intents.inbound_seq ASC
    `).all() as Array<{
      inbound_seq: number;
      status: string;
      reason: string;
      source: string;
      created_at: string;
      completed_at: string | null;
      actor_recorded: number;
      reason_recorded: number;
      terminal_outbound_exists: number;
    }>;

    return rows.map((row) => ({
      inboundSeq: row.inbound_seq,
      status: row.status,
      reason: row.reason,
      source: row.source,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      terminalOutboundExists: row.terminal_outbound_exists === 1,
      actionAudit: {
        actorRecorded: row.actor_recorded === 1,
        reasonRecorded: row.reason_recorded === 1,
      },
    }));
  } finally {
    try {
      db?.close();
    } catch {
      // Short-lived read-only proof command; close failures have no recovery path.
    }
  }
}

function countByStatus(rows: ReviewIntentProofRow[]): Record<string, number> {
  const counts: Record<string, number> = {
    total: rows.length,
    pending_review: 0,
    resolved: 0,
    dismissed: 0,
    terminal_outbound_exists: 0,
    action_audited: 0,
  };
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    if (row.terminalOutboundExists) counts.terminal_outbound_exists += 1;
    if (row.actionAudit.actorRecorded && row.actionAudit.reasonRecorded) counts.action_audited += 1;
  }
  return counts;
}

export function buildContinuityReviewProof(args: { db: string }): Record<string, unknown> {
  const rows = readReviewIntentProofRows(args.db);
  return {
    id: 'whatsoup-continuity-review-intents',
    proof_class: 'probe',
    source_layer: 'durability',
    ts: new Date().toISOString(),
    payload_type: PAYLOAD_TYPE,
    payload: {
      claim: 'continuity review intents can be exported as safe proof metadata without chat identity or message payload',
      verdict: 'pass',
      counts: countByStatus(rows),
      review_intents: rows,
      evidence_refs: [
        'durability:continuity_review_intents',
        'durability:outbound_ops_terminal_exists',
      ],
      limitations: [
        'read-only SQLite proof; does not claim the operator reviewed or sent a reply',
        'contains only review-intent metadata and boolean action-audit flags',
      ],
    },
  };
}

function writeJsonAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

export function run(
  argv: string[] = process.argv.slice(2),
  cwd = process.cwd(),
): Record<string, unknown> | null {
  try {
    const args = parseArgs(argv, cwd);
    if (args.help) {
      console.log(usage());
      return null;
    }
    const proof = buildContinuityReviewProof({ db: args.db });
    const text = `${JSON.stringify(proof, null, 2)}\n`;
    assertNoSecretLike(text, 'continuity review proof artifact');
    const diagnostic = `CONTINUITY_REVIEW_PROOF status=pass rows=${
      (proof.payload as { review_intents?: unknown[] }).review_intents?.length ?? 0
    } out=${path.basename(args.out)}`;
    assertNoSecretLike(diagnostic, 'continuity review proof diagnostics');
    writeJsonAtomic(args.out, text);
    console.log(diagnostic);
    return proof;
  } catch (err) {
    console.error(`continuity review proof failed: ${(err as Error).message}`);
    process.exitCode = 1;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
