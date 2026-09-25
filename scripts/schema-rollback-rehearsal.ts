// Schema rollback rehearsal on disposable files only. Runs two real checkouts:
// OLD creates a database, NEW migrates it, then OLD reopens it. Records the
// old binary's exact refusal and whether it changed any byte of the database.
//
//   node scripts/schema-rollback-rehearsal.ts \
//     --old-root <checkout of the previous release> \
//     --new-root <checkout of this release> \
//     --work-dir <new empty scratch directory>
//
// Never point --work-dir at a live instance directory: the harness creates its
// own database there and refuses a directory that already exists.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Args {
  oldRoot: string;
  newRoot: string;
  workDir: string;
}

interface StepResult {
  ok: boolean;
  latest: number | null;
  closureTable: boolean;
  error: { name: string; reason: string | null; message: string } | null;
}

// One open-and-migrate of a fresh database takes seconds; a hung child fails the rehearsal.
const STEP_TIMEOUT_MS = 120_000;
const FLAGS = new Set(['--old-root', '--new-root', '--work-dir']);

export function parseRehearsalArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} is required`);
    values.set(flag, resolve(value));
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`${flag} is required`);
    return value;
  };
  return {
    oldRoot: required('--old-root'),
    newRoot: required('--new-root'),
    workDir: required('--work-dir'),
  };
}

// Runs inside a child Node process with the given checkout's own modules.
const STEP_SOURCE = `
const [root, dbPath, mode] = process.argv.slice(1);
const { Database } = await import(root + '/src/core/database.ts');
const { DatabaseSync } = await import('node:sqlite');
const result = { ok: true, latest: null, closureTable: false, error: null };
const db = new Database(dbPath);
try {
  db.open();
} catch (error) {
  result.ok = false;
  result.error = {
    name: error?.name ?? 'Error',
    reason: error?.reason ?? null,
    message: String(error?.message ?? error),
  };
} finally {
  db.close();
}
const reader = new DatabaseSync(dbPath, { readOnly: true });
try {
  result.latest = reader.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  result.closureTable = reader.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'continuity_gap_closures'",
  ).get() !== undefined;
} finally {
  reader.close();
}
process.stdout.write('REHEARSAL_RESULT ' + JSON.stringify(result) + '\\n');
`;

function runStep(root: string, dbPath: string, isolatedHome: string): StepResult {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', STEP_SOURCE, root, dbPath],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: STEP_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: isolatedHome,
        XDG_CONFIG_HOME: join(isolatedHome, 'config'),
        XDG_DATA_HOME: join(isolatedHome, 'data'),
        XDG_STATE_HOME: join(isolatedHome, 'state'),
        LOG_LEVEL: 'silent',
      },
    },
  );
  const line = child.stdout.split('\n').find((entry) => entry.startsWith('REHEARSAL_RESULT '));
  if (child.status !== 0 || line === undefined) {
    throw new Error(`rehearsal step failed in ${root}: exit=${child.status}\n${child.stderr.slice(-4000)}`);
  }
  return JSON.parse(line.slice('REHEARSAL_RESULT '.length)) as StepResult;
}

function directoryState(dir: string): Record<string, string> {
  const state: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    if (name === 'home') continue;
    state[name] = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
  }
  return state;
}

export function runSchemaRollbackRehearsal(args: Args): Record<string, unknown> {
  if (existsSync(args.workDir)) throw new Error('--work-dir must not exist yet');
  mkdirSync(args.workDir, { recursive: true, mode: 0o700 });
  const home = join(args.workDir, 'home');
  mkdirSync(home, { mode: 0o700 });
  const dbPath = join(args.workDir, 'rehearsal.db');

  const created = runStep(args.oldRoot, dbPath, home);
  const migrated = runStep(args.newRoot, dbPath, home);
  const beforeOld = directoryState(args.workDir);
  const reopened = runStep(args.oldRoot, dbPath, home);
  const afterOld = directoryState(args.workDir);

  const databaseUnchanged = beforeOld['rehearsal.db'] === afterOld['rehearsal.db'];
  const refused = !reopened.ok && reopened.error?.reason === 'future_schema';
  return {
    ok: created.ok && migrated.ok && refused && databaseUnchanged
      && reopened.latest === migrated.latest && reopened.closureTable,
    created: { latest: created.latest, closureTable: created.closureTable },
    migrated: { latest: migrated.latest, closureTable: migrated.closureTable },
    oldBinaryReopen: reopened,
    databaseUnchanged,
    filesBeforeOldReopen: beforeOld,
    filesAfterOldReopen: afterOld,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    const report = runSchemaRollbackRehearsal(parseRehearsalArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 3;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
