/**
 * capability-obligation-as01-rehearsal — AS-01 old-binary / schema rehearsal
 * harness (candidate §5, coupled evidence-gated rollback).
 *
 * EXECUTION IS OWNER-GATED. This authors the runnable harness; it does not run a
 * migration or an old binary on its own. Two guarantees make it an artifact, not
 * a loaded gun:
 *
 *  1. Commands are NEVER guessed. The startup / schema-guard command is read at
 *     RUNTIME from the OLD release's OWN package.json scripts (`--release-dir`
 *     + `--script-name`); an unknown script name is refused.
 *  2. It only ever touches a CLONE. `--clone-db` must resolve INSIDE the
 *     operator-designated `--rehearsal-dir` sandbox; a target outside it (a live
 *     instance DB) is refused. And it is DRY-RUN by default — it prints the
 *     resolved plan and executes nothing unless `--confirm` is passed.
 *
 * The rehearsal answers candidate §5: does the OLD binary accept / reject /
 * find-inconclusive the target-schema clone. A reject/inconclusive makes binary
 * rollback a COUPLED pre-migration DB restore — that decision stays with the
 * owner; this harness only produces the observation.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface As01RehearsalPlan {
  ok: boolean;
  refusedReason: 'clone_outside_rehearsal_dir' | 'release_package_json_unreadable' | 'unknown_script_name' | null;
  releaseDir: string;
  cloneDb: string;
  scriptName: string;
  /** The command string the release itself defines for `scriptName` (never guessed). */
  resolvedCommand: string | null;
  dbEnvVar: string;
}

/** True when `child` resolves to `parent` or a path inside it. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function planAs01Rehearsal(params: {
  releaseDir: string;
  cloneDb: string;
  rehearsalDir: string;
  scriptName: string;
  dbEnvVar: string;
}): As01RehearsalPlan {
  const base: As01RehearsalPlan = {
    ok: false,
    refusedReason: null,
    releaseDir: resolve(params.releaseDir),
    cloneDb: resolve(params.cloneDb),
    scriptName: params.scriptName,
    resolvedCommand: null,
    dbEnvVar: params.dbEnvVar,
  };
  // Clone-only guard: the target MUST be inside the designated rehearsal sandbox.
  if (!isInside(params.rehearsalDir, params.cloneDb)) {
    return { ...base, refusedReason: 'clone_outside_rehearsal_dir' };
  }
  // Commands come from the OLD release's OWN package.json — never guessed.
  let scripts: Record<string, unknown>;
  try {
    const pkg = JSON.parse(readFileSync(resolve(params.releaseDir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    return { ...base, refusedReason: 'release_package_json_unreadable' };
  }
  const command = scripts[params.scriptName];
  if (typeof command !== 'string' || command.length === 0) {
    return { ...base, refusedReason: 'unknown_script_name' };
  }
  return { ...base, ok: true, resolvedCommand: command };
}

function usage(): string {
  return [
    'Usage: capability-obligation-as01-rehearsal --release-dir DIR --clone-db PATH \\',
    '         --rehearsal-dir DIR --script-name NAME [--db-env WHATSOUP_DB_PATH] [--confirm]',
    '',
    'EXECUTION IS OWNER-GATED. Dry-run by default: it prints the plan and runs',
    'nothing. --clone-db must be inside --rehearsal-dir (a live DB is refused).',
    'The command is read from the OLD release\'s OWN package.json script NAME —',
    'never guessed. Run against a backup-API CLONE only; --confirm actually runs',
    'the old release script against the clone with --db-env set to the clone path.',
  ].join('\n');
}

export interface As01Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export function runAs01RehearsalCli(argv: readonly string[], io: As01Io): number {
  const flags = new Map<string, string>();
  let confirm = false;
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (t === '--confirm') { confirm = true; continue; }
    if (t === '--help') { io.out(usage()); return 0; }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${t} requires a value`);
    flags.set(t, v);
    i += 1;
  }
  const releaseDir = flags.get('--release-dir');
  const cloneDb = flags.get('--clone-db');
  const rehearsalDir = flags.get('--rehearsal-dir');
  const scriptName = flags.get('--script-name');
  const dbEnvVar = flags.get('--db-env') ?? 'WHATSOUP_DB_PATH';
  if (!releaseDir || !cloneDb || !rehearsalDir || !scriptName) {
    throw new Error(`missing required flag.\n${usage()}`);
  }
  const plan = planAs01Rehearsal({ releaseDir, cloneDb, rehearsalDir, scriptName, dbEnvVar });
  if (!plan.ok) {
    io.err(`AS-01 rehearsal refused: ${plan.refusedReason}`);
    return 1;
  }
  io.out(`AS-01 rehearsal plan:`);
  io.out(`  release-dir : ${plan.releaseDir}`);
  io.out(`  clone-db    : ${plan.cloneDb}`);
  io.out(`  script      : ${plan.scriptName} => ${plan.resolvedCommand}`);
  io.out(`  db-env      : ${plan.dbEnvVar}=${plan.cloneDb}`);
  if (!confirm) {
    io.out('DRY-RUN — nothing executed. Pass --confirm to run the OLD release script against the clone (owner-gated).');
    return 0;
  }
  // Owner-gated execution: run the release's own script against the clone with
  // an EXPLICIT allowlisted env (never inherit process.env wholesale) — only the
  // minimum npm needs plus the clone DB path.
  const childEnv: Record<string, string> = { [plan.dbEnvVar]: plan.cloneDb };
  for (const key of ['PATH', 'HOME'] as const) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  const result = spawnSync('npm', ['run', plan.scriptName], {
    cwd: plan.releaseDir,
    env: childEnv,
    encoding: 'utf8',
    timeout: 600_000,
  });
  io.out(`exit=${result.status ?? 'signal'}`);
  if (result.stdout) io.out(result.stdout.slice(-4096));
  if (result.stderr) io.err(result.stderr.slice(-4096));
  // The exit code is the OBSERVATION (accept vs reject); rollback coupling is the
  // owner's decision, not this harness's.
  return result.status === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = runAs01RehearsalCli(process.argv.slice(2), {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
