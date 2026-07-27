import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  recordContinuityGaps,
  type ContinuityGapObservation,
} from '../src/core/continuity-gap-ledger.ts';
import {
  MAX_MANIFEST_BYTES,
  assertContiguousSchema43Receipts,
  assertSameFile,
  existingRegularFile,
  readManifest,
} from './audit-continuity-manifest.ts';
import {
  auditContinuityManifest,
  parseContinuityManifest,
  type ContinuityManifest,
  type ContinuityManifestReceipt,
  type ContinuityReceiptAudit,
} from './lib/continuity-manifest-audit.ts';

interface RecordArgs {
  dbPath: string;
  manifestPath: string;
}

const VALUE_FLAGS = new Set(['--db', '--manifest']);
const CONFIRM_FLAG = '--confirm-record';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function usage(): string {
  return [
    'Usage: record-continuity-manifest --db PATH --manifest PATH --confirm-record',
    '',
    'Records content-free unresolved continuity evidence. Does not replay or send messages.',
  ].join('\n');
}

export function parseRecordContinuityManifestArgs(argv: string[]): RecordArgs {
  if (argv.includes('--help')) throw new Error(usage());
  const confirmCount = argv.filter((value) => value === CONFIRM_FLAG).length;
  if (confirmCount !== 1) throw new Error(`${CONFIRM_FLAG} is required exactly once`);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === CONFIRM_FLAG) continue;
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) {
      throw new Error(`${flag} is required`);
    }
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`${flag} is required`);
    return resolve(value);
  };
  return {
    dbPath: required('--db'),
    manifestPath: required('--manifest'),
  };
}

function receiptFingerprint(
  manifest: ContinuityManifest,
  receipt: ContinuityManifestReceipt,
): string {
  return sha256(JSON.stringify([
    manifest.source,
    receipt.messageId,
    receipt.sentAt,
    receipt.senderFingerprint,
    receipt.contentHash,
    receipt.contentType,
  ]));
}

function observationFor(
  manifest: ContinuityManifest,
  receipt: ContinuityManifestReceipt,
  audit: ContinuityReceiptAudit,
): ContinuityGapObservation | null {
  if (
    audit.classification !== 'absent'
    && audit.classification !== 'observed_not_admitted'
    && audit.classification !== 'ambiguous'
  ) {
    return null;
  }
  return {
    ordinal: receipt.ordinal,
    classification: audit.classification,
    receiptFingerprint: receiptFingerprint(manifest, receipt),
    destinationFingerprint: sha256(JSON.stringify([
      manifest.destination.conversationKey,
      manifest.destination.channelFingerprint,
    ])),
    manifestFingerprint: sha256(manifest.manifestId),
    evidenceFingerprint: sha256(manifest.evidenceRef),
  };
}

export function runRecordContinuityManifestCli(argv: string[]): number {
  const args = parseRecordContinuityManifestArgs(argv);
  const dbIdentity = existingRegularFile(args.dbPath);
  const manifestIdentity = existingRegularFile(args.manifestPath, MAX_MANIFEST_BYTES);
  const manifest = parseContinuityManifest(readManifest(args.manifestPath, manifestIdentity));
  const raw = new DatabaseSync(args.dbPath);
  const begin = raw.prepare('BEGIN IMMEDIATE');
  const commit = raw.prepare('COMMIT');
  const rollback = raw.prepare('ROLLBACK');
  try {
    raw.exec('PRAGMA foreign_keys = ON');
    assertContiguousSchema43Receipts(raw);
    assertSameFile(dbIdentity, existingRegularFile(args.dbPath), 'Database');
    begin.run();
    let opened = true;
    try {
      const audit = auditContinuityManifest(raw, manifest);
      const observations = audit.receipts.flatMap((receiptAudit, index) => {
        const observation = observationFor(
          manifest,
          manifest.receipts[index],
          receiptAudit,
        );
        return observation ? [observation] : [];
      });
      const ledger = observations.length > 0
        ? recordContinuityGaps(raw, observations)
        : { created: 0, existing: 0, unresolved: 0, ambiguous: 0 };
      commit.run();
      opened = false;
      assertSameFile(dbIdentity, existingRegularFile(args.dbPath), 'Database');
      process.stdout.write(`${JSON.stringify({
        ok: true,
        recorded: true,
        state: audit.state,
        counts: audit.counts,
        ledger,
      })}\n`);
      return audit.state === 'clear' ? 0 : 2;
    } catch (error) {
      if (opened) {
        try { rollback.run(); } catch { /* best-effort rollback */ }
      }
      throw error;
    }
  } finally {
    raw.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = runRecordContinuityManifestCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
