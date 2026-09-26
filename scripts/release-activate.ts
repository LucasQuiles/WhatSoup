/**
 * Coordinated release activation for a macOS launchd instance (npm
 * `release:activate`).
 *
 * `--plan` (the default) is read-only: it resolves every path, checks every
 * precondition, renders the staged plists in memory, and prints the exact
 * actions as JSON. `--apply` re-derives the same plan, backs up the database
 * (quick_check verified), the wrapper symlink and every plist, switches the
 * wrapper symlink and the staged plists as one step, reloads each label, and
 * verifies from the executing process. Any failure after the switch rolls
 * everything back and verifies the rollback the same way.
 *
 * Nothing site-specific is compiled in: the instance, releases, auxiliary
 * labels and backup location are arguments; paths come from HOME/XDG_*; the
 * health port comes from the instance config unless given; the expected
 * commit comes from the new release's manifest. The health token is resolved
 * like deploy/scripts/lib/health_reader.py and is never printed.
 *
 * Exit codes: 0 plan ready / activated and verified; 1 activation failed and
 * the rollback was verified; 2 refused before any live change (usage,
 * platform, or an unmet precondition); 3 activation failed and the rollback
 * could not be verified — manual attention required; 4 activation failed and
 * the automatic rollback was NOT attempted because the new release changed
 * the database schema migration level (or it could not be read) — the old
 * binary would refuse that database, so the new release is left in place and
 * stderr carries the manual database-restore steps.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isValidInstanceName } from '../src/fleet/instance-name.ts';
import { CliArgError, isHelpFlag, takeValue } from './lib/cli-args.ts';
import { applyActivation, type ApplyOutcome } from './lib/release-activation/apply.ts';
import { type ActivationHost, createDefaultActivationHost } from './lib/release-activation/host.ts';
import {
  type ActivationArgs,
  type ActivationContext,
  AUX_RENDERERS,
  type AuxRenderer,
  bootstrapEntrypointFor,
  buildActivationContext,
  describeActions,
  LABEL_PATTERN,
  preconditionsMet,
  wrapperTargetFor,
} from './lib/release-activation/plan.ts';

export const RELEASE_ACTIVATE_EXIT = {
  ok: 0,
  rolledBack: 1,
  refused: 2,
  rollbackUnverified: 3,
  rollbackBlockedMigrated: 4,
} as const;

const DEFAULT_EXIT_TIMEOUT_SECONDS = 60;
const DEFAULT_VERIFY_TIMEOUT_SECONDS = 180;

const USAGE = [
  'Usage: release:activate --instance NAME --release PATH --expect-current PATH',
  '  [--aux-label LABEL=setup-timer|release-drift]... [--health-port N]',
  '  [--backup-dir DIR] [--wrapper-link PATH] [--exit-timeout S] [--verify-timeout S]',
  '  [--plan | --apply]',
  '',
  'macOS launchd only. --plan (default) is read-only and prints the actions and',
  'preconditions as JSON. --apply switches, verifies, and rolls back on failure.',
].join('\n');

const VALUE_FLAGS = new Set([
  '--instance', '--release', '--expect-current', '--aux-label', '--health-port',
  '--backup-dir', '--wrapper-link', '--exit-timeout', '--verify-timeout',
]);
const REPEATABLE_FLAGS = new Set(['--aux-label']);

function absolute(flag: string, value: string): string {
  if (!path.isAbsolute(value)) throw new CliArgError(`${flag} must be an absolute path`);
  return path.normalize(value).replace(/\/+$/, '') || '/';
}

function positiveInteger(flag: string, value: string, max: number): number {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > max) {
    throw new CliArgError(`${flag} must be an integer between 1 and ${max}`);
  }
  return Number(value);
}

export function parseActivationArgs(argv: readonly string[]): ActivationArgs {
  const values = new Map<string, string[]>();
  let mode: 'plan' | 'apply' | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (isHelpFlag(flag)) throw new CliArgError(USAGE);
    if (flag === '--plan' || flag === '--apply') {
      const next = flag === '--plan' ? 'plan' : 'apply';
      if (mode !== null) throw new CliArgError('--plan and --apply are mutually exclusive and may appear once');
      mode = next;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new CliArgError(`Unknown argument: ${flag}`);
    if (values.has(flag) && !REPEATABLE_FLAGS.has(flag)) throw new CliArgError(`Duplicate argument: ${flag}`);
    const taken = takeValue(argv, index, flag);
    values.set(flag, [...(values.get(flag) ?? []), taken.value]);
    index = taken.index;
  }
  const one = (flag: string): string | null => values.get(flag)?.[0] ?? null;
  const required = (flag: string): string => {
    const value = one(flag);
    if (value === null || value.trim() === '') throw new CliArgError(`${flag} is required`);
    return value;
  };

  const instance = required('--instance');
  if (!isValidInstanceName(instance)) throw new CliArgError('--instance is not a valid instance name');

  const auxLabels = (values.get('--aux-label') ?? []).map((spec) => {
    const separator = spec.lastIndexOf('=');
    const label = separator > 0 ? spec.slice(0, separator) : '';
    const renderer = separator > 0 ? spec.slice(separator + 1) : '';
    if (!LABEL_PATTERN.test(label)) throw new CliArgError(`--aux-label ${spec}: label must match com.whatsoup.<name>`);
    if (!(AUX_RENDERERS as readonly string[]).includes(renderer)) {
      throw new CliArgError(`--aux-label ${spec}: renderer must be one of ${AUX_RENDERERS.join(', ')}`);
    }
    return { label, renderer: renderer as AuxRenderer };
  });
  const labels = auxLabels.map((entry) => entry.label);
  if (new Set(labels).size !== labels.length) throw new CliArgError('--aux-label lists a label more than once');
  if (labels.includes(`com.whatsoup.${instance}`)) {
    throw new CliArgError('--aux-label must not name the instance label; the instance is always activated');
  }

  const healthPort = one('--health-port');
  const backupDir = one('--backup-dir');
  const wrapperLink = one('--wrapper-link');
  const exitTimeout = one('--exit-timeout');
  const verifyTimeout = one('--verify-timeout');
  return {
    instance,
    release: absolute('--release', required('--release')),
    expectCurrent: absolute('--expect-current', required('--expect-current')),
    auxLabels,
    healthPort: healthPort === null ? null : positiveInteger('--health-port', healthPort, 65_535),
    backupDir: backupDir === null ? null : absolute('--backup-dir', backupDir),
    wrapperLink: wrapperLink === null ? null : absolute('--wrapper-link', wrapperLink),
    mode: mode ?? 'plan',
    exitTimeoutSeconds: exitTimeout === null ? DEFAULT_EXIT_TIMEOUT_SECONDS : positiveInteger('--exit-timeout', exitTimeout, 3_600),
    verifyTimeoutSeconds: verifyTimeout === null
      ? DEFAULT_VERIFY_TIMEOUT_SECONDS
      : positiveInteger('--verify-timeout', verifyTimeout, 3_600),
  };
}

/** The plan document. Carries paths and commits, never the health token or plist bytes. */
export function planDocument(context: ActivationContext): Record<string, unknown> {
  const { args } = context;
  return {
    mode: args.mode,
    ready: preconditionsMet(context),
    instance: args.instance,
    release: { path: args.release, commit: context.newCommit },
    expectCurrent: { path: args.expectCurrent, commit: context.oldCommit },
    paths: {
      wrapperLink: context.wrapperLink,
      launchAgentsDir: context.launchAgentsDir,
      database: context.dbPath,
      backupDir: args.backupDir,
      domain: context.domain,
    },
    health: { port: context.healthPort, tokenResolved: context.healthToken !== null },
    preconditions: context.preconditions,
    plists: context.staged.map((entry) => ({
      label: entry.label,
      role: entry.role,
      renderer: entry.renderer,
      plistPath: entry.plistPath,
      staged: entry.staged !== null,
      edits: entry.edits,
      renderDriftLines: entry.renderDriftLines,
    })),
    actions: describeActions(context),
  };
}

function outcomeExit(outcome: ApplyOutcome['outcome']): number {
  switch (outcome) {
    case 'activated': return RELEASE_ACTIVATE_EXIT.ok;
    case 'rolled-back': return RELEASE_ACTIVATE_EXIT.rolledBack;
    case 'refused': return RELEASE_ACTIVATE_EXIT.refused;
    case 'rollback-unverified': return RELEASE_ACTIVATE_EXIT.rollbackUnverified;
    case 'rollback-blocked-migrated': return RELEASE_ACTIVATE_EXIT.rollbackBlockedMigrated;
  }
}

/**
 * Operator instructions for `rollback-blocked-migrated`: the levels, the
 * backup, and the exact manual restore. Written to stderr so stdout stays one
 * JSON receipt.
 */
export function blockedRollbackMessage(context: ActivationContext, outcome: ApplyOutcome): string {
  const backup = outcome.backupPath!;
  const { domain, dbPath, wrapperLink } = context;
  const schema = outcome.schemaMigration;
  let oldTarget: string;
  try {
    oldTarget = readFileSync(path.join(backup, 'symlink.before'), 'utf8');
  } catch {
    oldTarget = wrapperTargetFor(context.args.expectCurrent);
  }
  const state = schema.blockedAt === 'after-instance-stop'
    ? `The new release's instance ${context.instanceLabel} is stopped; its symlink and plists are still in place.`
    : 'The new release was left in place, in whatever state verification found it.';
  const aside = `${dbPath}.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)`;
  return [
    '',
    'release:activate: ROLLBACK BLOCKED — the database schema changed during activation.',
    `  schema migration level before activation: ${schema.before ?? 'unknown'}`,
    `  schema migration level after failure: ${schema.after ?? 'unreadable'}${schema.afterError ? ` (${schema.afterError})` : ''}`,
    `The old release would refuse this database, so the symlink and plists were NOT restored and the old release was NOT started. ${state}`,
    `Pre-activation database backup: ${path.join(backup, 'bot.db')}`,
    '',
    'WARNING: data loss. Messages received after the backup was taken are lost from the restored database.',
    'The moved-aside live database below is then the only copy of those messages; keep it.',
    '',
    'Manual restore, only with approval for this instance:',
    '  1. Stop every label and confirm the instance pid is gone:',
    ...context.staged.map((entry) => `       launchctl bootout ${domain}/${entry.label}`),
    `       launchctl print ${domain}/${context.instanceLabel}   # must fail: not loaded`,
    '  2. Move the live database and its sidecars aside together (a stale -wal beside a restored bot.db corrupts it):',
    `       aside=${aside}; mkdir -m 700 "$aside"`,
    `       mv ${dbPath} ${dbPath}-wal ${dbPath}-shm "$aside"/   # -wal/-shm may be absent`,
    '  3. Restore the backup:',
    `       cp ${path.join(backup, 'bot.db')} ${dbPath} && chmod 600 ${dbPath}`,
    '  4. Repoint the wrapper symlink and the plists to the old release:',
    `       ln -sfn ${oldTarget} ${wrapperLink}`,
    ...context.staged.map((entry) => `       cp ${path.join(backup, `${entry.label}.plist`)} ${entry.plistPath}`),
    '  5. Start every label:',
    ...context.staged.map((entry) => `       launchctl bootstrap ${domain} ${entry.plistPath}`),
    `  6. Verify from the executing process: ps argv names ${bootstrapEntrypointFor(context.args.expectCurrent)} and health reports commit ${context.oldCommit ?? '<old commit>'}.`,
    'See docs/runbooks/release-deployment.md, "Rollback".',
    '',
  ].join('\n');
}

export async function runReleaseActivateCli(
  argv: readonly string[],
  host: ActivationHost = createDefaultActivationHost(),
  io: { stdout: (text: string) => void; stderr: (text: string) => void } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  let args: ActivationArgs;
  try {
    args = parseActivationArgs(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return RELEASE_ACTIVATE_EXIT.refused;
  }
  if (host.platform !== 'darwin') {
    io.stderr('release:activate supports macOS launchd only; see docs/runbooks/release-deployment.md\n');
    io.stdout(`${JSON.stringify({ mode: args.mode, ready: false, refused: 'platform-not-macos-launchd' })}\n`);
    return RELEASE_ACTIVATE_EXIT.refused;
  }

  const context = await buildActivationContext(host, args);
  const plan = planDocument(context);
  if (args.mode === 'plan') {
    io.stdout(`${JSON.stringify(plan, null, 2)}\n`);
    return plan.ready ? RELEASE_ACTIVATE_EXIT.ok : RELEASE_ACTIVATE_EXIT.refused;
  }
  if (!preconditionsMet(context)) {
    io.stdout(`${JSON.stringify({ ...plan, outcome: 'refused' }, null, 2)}\n`);
    return RELEASE_ACTIVATE_EXIT.refused;
  }
  const outcome = await applyActivation(host, context);
  const receipt = `${JSON.stringify({
    mode: 'apply',
    instance: args.instance,
    release: plan.release,
    expectCurrent: plan.expectCurrent,
    ...outcome,
  }, null, 2)}\n`;
  if (outcome.backupPath !== null) {
    try {
      writeFileSync(path.join(outcome.backupPath, 'receipt.json'), receipt, { mode: 0o600 });
    } catch (error) {
      io.stderr(`could not write receipt.json: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  io.stdout(receipt);
  if (outcome.outcome === 'rollback-blocked-migrated') io.stderr(blockedRollbackMessage(context, outcome));
  return outcomeExit(outcome.outcome);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exitCode = await runReleaseActivateCli(process.argv.slice(2));
}
