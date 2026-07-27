import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  auditContinuityManifest,
  parseContinuityManifest,
} from './lib/continuity-manifest-audit.ts';

const MAX_MANIFEST_BYTES = 1024 * 1024;

interface CliArgs {
  dbPath: string;
  manifestPath: string;
}

interface FileIdentity {
  device: number;
  inode: number;
  mode: number;
}

const VALUE_FLAGS = new Set(['--db', '--manifest']);

function usage(): string {
  return [
    'Usage: audit-continuity-manifest --db PATH --manifest PATH',
    '',
    'Read-only: classifies independent source receipts without replaying or writing.',
  ].join('\n');
}

export function parseAuditContinuityManifestArgs(argv: string[]): CliArgs {
  if (argv.includes('--help')) throw new Error(usage());
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
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

function existingRegularFile(filePath: string, maxBytes?: number): FileIdentity {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error('not regular');
    if (maxBytes !== undefined && stat.size > maxBytes) {
      throw new Error(`Continuity manifest exceeds ${maxBytes} bytes`);
    }
    return { device: stat.dev, inode: stat.ino, mode: stat.mode };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Continuity manifest exceeds')) {
      throw error;
    }
    throw new Error('Path must identify an existing regular file');
  }
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function identityFromStat(stat: Pick<Stats, 'dev' | 'ino' | 'mode'>): FileIdentity {
  return { device: stat.dev, inode: stat.ino, mode: stat.mode };
}

function assertSameFile(
  expected: FileIdentity,
  observed: FileIdentity,
  label: string,
): void {
  if (!sameFile(expected, observed)) throw new Error(`${label} changed during read-only audit`);
}

function assertContiguousSchema43Receipts(raw: DatabaseSync): void {
  const table = raw.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  if (!table) throw new Error('Database must include contiguous schema 43+ receipts');
  const versions = (raw.prepare(`
    SELECT version FROM schema_migrations ORDER BY version
  `).all() as Array<{ version: number }>).map((row) => Number(row.version));
  if (versions.length < 43 || versions.some((version, index) => version !== index + 1)) {
    throw new Error('Database must include contiguous schema 43+ receipts');
  }
}

function readManifest(manifestPath: string, identity: FileIdentity): unknown {
  if ((identity.mode & 0o077) !== 0) {
    throw new Error('Continuity manifest must not be group- or world-readable');
  }
  const fd = openSync(manifestPath, 'r');
  let text: string;
  try {
    const opened = identityFromStat(fstatSync(fd));
    assertSameFile(identity, opened, 'Continuity manifest');
    if ((opened.mode & 0o077) !== 0) {
      throw new Error('Continuity manifest must not be group- or world-readable');
    }
    const openedSize = fstatSync(fd).size;
    if (openedSize > MAX_MANIFEST_BYTES) {
      throw new Error(`Continuity manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
    text = readFileSync(fd, 'utf8');
    const afterRead = identityFromStat(fstatSync(fd));
    assertSameFile(opened, afterRead, 'Continuity manifest');
    if ((afterRead.mode & 0o077) !== 0) {
      throw new Error('Continuity manifest must not be group- or world-readable');
    }
    if (fstatSync(fd).size > MAX_MANIFEST_BYTES) {
      throw new Error(`Continuity manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    }
  } finally {
    closeSync(fd);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Continuity manifest must be valid JSON');
  }
}

export function runAuditContinuityManifestCli(argv: string[]): number {
  const args = parseAuditContinuityManifestArgs(argv);
  const dbIdentity = existingRegularFile(args.dbPath);
  const manifestIdentity = existingRegularFile(args.manifestPath, MAX_MANIFEST_BYTES);
  const manifest = parseContinuityManifest(readManifest(args.manifestPath, manifestIdentity));
  const raw = new DatabaseSync(args.dbPath, { readOnly: true });
  try {
    raw.exec('PRAGMA foreign_keys = ON');
    assertContiguousSchema43Receipts(raw);
    const audit = auditContinuityManifest(raw, manifest);
    assertSameFile(dbIdentity, existingRegularFile(args.dbPath), 'Database');
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dryRun: true,
      ...audit,
    })}\n`);
    return audit.state === 'clear' ? 0 : 2;
  } finally {
    raw.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = runAuditContinuityManifestCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
