/**
 * Read-only half of `release:activate` on Linux (systemd --user). The unit is
 * `whatsoup@<instance>.service`; the release it runs is selected by the
 * lexically last `z…-release-<12hex>.conf` drop-in in
 * `$XDG_CONFIG_HOME/systemd/user/whatsoup@<instance>.service.d/`, which resets
 * ExecStartPre/ExecStart to paths under
 * `~/.local/opt/whatsoup/releases/<release>/`. Older release drop-ins stay on
 * disk and are shadowed. `~/.local/bin/whatsoup` selects nothing here.
 *
 * The plan binds the RUNNING generation, not only the files: the effective
 * drop-in on disk, the loaded unit (`systemctl --user show`), the main pid's
 * argv and the --expect-current manifest commit must all name the same
 * release, or the plan refuses. Forward admission and rollback admission are
 * separate: the candidate must have a valid fence, meet the fence in force
 * (the running release's requirement) and open the database's schema level;
 * a predecessor that could not be started again only makes automatic rollback
 * unavailable, which the plan and receipt record. Nothing here writes or calls
 * a systemctl verb that changes state.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { instancePaths } from '../../../src/fleet/paths.ts';
import { readSchemaMigrationLevel } from '../sqlite-schema-level.ts';
import { type ActivationHost, resolveInstanceHealthToken } from './host.ts';
import { activationLockPath } from './lock.ts';
import {
  type ActivationArgs,
  type ActivationContext,
  bootstrapEntrypointFor,
  fenceCompatible,
  type FenceRecheckContext,
  formatFenceLevels,
  FULL_COMMIT,
  isDirectory,
  isRegularFile,
  legacyFenceLevels,
  mentionsReleaseRoot,
  type Precondition,
  readManifestCommit,
  readRefreshRollbackFence,
  type RefreshRollbackFenceLevels,
  type RefreshRollbackFenceRead,
  resolveHealthPort,
  sha256,
  wrapperTargetFor,
} from './plan.ts';
import { readReleaseSchemaSupport, type ReleaseSchemaSupport } from './schema-support.ts';

export const RELEASE_DROPIN_PATTERN = /^z+-release-([0-9a-f]{12})\.conf$/;
const ENTRYPOINT_SUFFIX = '/src/bootstrap.ts';
const MAX_DROPIN_PREFIX = 64;
const EXEC_OVERRIDE = /^\s*ExecStart(?:Pre)?\s*=/m;
/**
 * `systemctl show --value` prints values in the unit's property order, not the
 * `-p` order, so values are read by key instead.
 */
export const SHOW_PROPERTIES = [
  'LoadState', 'ActiveState', 'MainPID', 'ControlGroup', 'NeedDaemonReload', 'DropInPaths', 'ExecStart',
] as const;

export function unitFor(instance: string): string {
  return `whatsoup@${instance}.service`;
}

export function releasesDirFor(home: string): string {
  return path.join(home, '.local', 'opt', 'whatsoup', 'releases');
}

/** `$XDG_CONFIG_HOME/systemd/user/<unit>.d`, the directory the systemd user manager reads unit drop-ins from. */
export function dropInDirFor(home: string, unit: string): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const configHome = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  return path.join(configHome, 'systemd', 'user', `${unit}.d`);
}

/** Every systemctl call goes through the host seam as argv, always against the user manager. */
export function systemctl(host: ActivationHost, ...args: string[]): ReturnType<ActivationHost['exec']> {
  return host.exec('systemctl', ['--user', ...args]);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Distinct release roots under `releasesDir` that `text` names as `<root>/deploy/whatsoup`. */
export function releaseRootsIn(text: string, releasesDir: string): string[] {
  const pattern = new RegExp(`(${escapeForRegExp(releasesDir)}/[^/\\s'";]+)/deploy/whatsoup(?=[\\s'";]|$)`, 'gm');
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]!))].sort();
}

/** Move a drop-in onto another release root: every whole-path mention of `from` becomes `to`. */
export function replaceReleaseRoot(text: string, from: string, to: string): string {
  return text.replace(new RegExp(`${escapeForRegExp(from)}(?=[/\\s'";]|$)`, 'gm'), () => to);
}

/**
 * The shortest `z…-release-<commit12>.conf` that sorts after every existing
 * drop-in name (systemd orders drop-ins by file name across directories), so
 * the new drop-in is the effective one. Null when 64 `z`s are not enough.
 */
export function nextReleaseDropInName(commit12: string, existing: readonly string[]): string | null {
  for (let count = 1; count <= MAX_DROPIN_PREFIX; count += 1) {
    const name = `${'z'.repeat(count)}-release-${commit12}.conf`;
    if (existing.every((other) => other < name)) return name;
  }
  return null;
}

/**
 * Whether any cgroup path of this process contains the unit as a path segment
 * (cgroup v2 `0::/…/whatsoup@<instance>.service`, or any v1 hierarchy). Null when the
 * text is missing or unparseable: unknown.
 */
export function cgroupInsideUnit(text: string | null, unit: string): boolean | null {
  if (text === null) return null;
  const lines = text.split('\n').filter((line) => line.length > 0);
  const paths = lines.map((line) => {
    const first = line.indexOf(':');
    const second = first < 0 ? -1 : line.indexOf(':', first + 1);
    return second < 0 ? null : line.slice(second + 1);
  });
  if (paths.length === 0 || paths.some((entry) => entry === null || !entry.startsWith('/'))) return null;
  return paths.some((entry) => entry!.split('/').includes(unit));
}

/** The release root a process argv runs: exactly one `<releasesDir>/<name>/src/bootstrap.ts` argument. */
export function releaseRootOfArgv(argv: readonly string[] | null, releasesDir: string): { root: string | null; detail: string } {
  if (argv === null) return { root: null, detail: 'main pid argv unreadable' };
  const entries = argv.filter((arg) => arg.endsWith(ENTRYPOINT_SUFFIX));
  if (entries.length !== 1) return { root: null, detail: `main pid argv names ${entries.length} bootstrap entrypoints` };
  const root = entries[0]!.slice(0, -ENTRYPOINT_SUFFIX.length);
  if (!path.isAbsolute(root) || path.normalize(root) !== root || path.dirname(root) !== releasesDir) {
    return { root: null, detail: 'main pid entrypoint is not under the releases directory' };
  }
  return { root, detail: `main pid runs ${root}` };
}

export interface LoadedUnit {
  loadState: string | null;
  activeState: string | null;
  /** Null for MainPID=0 (not running) or an unreadable value. */
  mainPid: number | null;
  controlGroup: string | null;
  needDaemonReload: boolean | null;
  dropInPaths: string[];
  execStart: string[];
}

export function parseSystemctlShow(stdout: string): LoadedUnit {
  const values = new Map<string, string[]>();
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    values.set(key, [...(values.get(key) ?? []), line.slice(separator + 1)]);
  }
  const one = (key: string): string | null => {
    const found = values.get(key);
    return found !== undefined && found.length === 1 ? found[0]! : null;
  };
  const pidText = one('MainPID');
  const pid = pidText !== null && /^\d+$/.test(pidText) ? Number(pidText) : null;
  const reload = one('NeedDaemonReload');
  const dropIns = one('DropInPaths');
  return {
    loadState: one('LoadState'),
    activeState: one('ActiveState'),
    mainPid: pid !== null && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    controlGroup: one('ControlGroup'),
    needDaemonReload: reload === 'no' ? false : reload === 'yes' ? true : null,
    dropInPaths: dropIns === null ? [] : dropIns.split(/\s+/).filter((entry) => entry.length > 0),
    execStart: (values.get('ExecStart') ?? []).filter((entry) => entry.length > 0),
  };
}

/** `systemctl --user show` for the unit; null when the call fails. Read-only. */
export async function readLoadedUnit(host: ActivationHost, unit: string): Promise<LoadedUnit | null> {
  const result = await systemctl(host, 'show', unit, ...SHOW_PROPERTIES.flatMap((property) => ['-p', property]));
  return result.code === 0 ? parseSystemctlShow(result.stdout) : null;
}

export interface DropInFile {
  name: string;
  path: string;
  sha256: string;
}

/** Every `*.conf` regular file in the drop-in directory, sorted by name, with its digest; null when unreadable. */
export function listDropIns(dropInDir: string): DropInFile[] | null {
  try {
    return readdirSync(dropInDir)
      .filter((name) => name.endsWith('.conf'))
      .sort()
      .map((name) => {
        const filePath = path.join(dropInDir, name);
        const stat = lstatSync(filePath);
        if (!stat.isFile()) throw new Error(`${name} is not a regular file`);
        return { name, path: filePath, sha256: sha256(readFileSync(filePath)) };
      });
  } catch {
    return null;
  }
}

/** The live generation the switch replaces. `releaseRoot` is set only when all four sources agree. */
export interface SystemdGeneration {
  releaseRoot: string | null;
  /** (d) the --expect-current release manifest commit. */
  manifestCommit: string | null;
  /** (a) the effective release drop-in on disk and the root it names. */
  effectiveDropIn: DropInFile | null;
  dropInRoot: string | null;
  /** (b) the loaded unit. */
  needDaemonReload: boolean | null;
  dropInPaths: string[];
  loadedExecStartRoot: string | null;
  /** (c) the running main pid and the release root its argv names. */
  mainPid: number | null;
  mainPidRoot: string | null;
  /** Every drop-in in the unit's directory at plan time. */
  dropIns: DropInFile[];
}

interface GenerationRead {
  generation: SystemdGeneration;
  effectiveText: string | null;
  loaded: LoadedUnit | null;
  checks: Precondition[];
}

/**
 * Read the four generation sources and judge each against --expect-current.
 * Used by the plan and again immediately before the switch.
 */
export async function readGeneration(
  host: ActivationHost,
  input: { unit: string; dropInDir: string; releasesDir: string; expectCurrent: string; manifestCommit: string | null },
): Promise<GenerationRead> {
  const checks: Precondition[] = [];
  const check = (id: string, ok: boolean, detail: string): void => { checks.push({ id, ok, detail }); };
  const { unit, dropInDir, releasesDir, expectCurrent, manifestCommit } = input;
  const dropIns = listDropIns(dropInDir);
  check('systemd-dropin-dir-readable', dropIns !== null, dropIns === null ? `${dropInDir} unreadable` : `${dropIns.length} drop-ins`);
  const effective = dropIns?.filter((file) => RELEASE_DROPIN_PATTERN.test(file.name)).at(-1) ?? null;
  let effectiveText: string | null = null;
  try { effectiveText = effective === null ? null : readFileSync(effective.path, 'utf8'); } catch { effectiveText = null; }
  const dropInRoots = effectiveText === null ? [] : releaseRootsIn(effectiveText, releasesDir);
  const dropInRoot = dropInRoots.length === 1 ? dropInRoots[0]! : null;
  check('systemd-effective-dropin-on-expected-release', effective !== null && dropInRoot === expectCurrent,
    effective === null ? 'no z…-release-<12hex>.conf drop-in' : `${effective.name} names ${dropInRoots.join(', ') || 'no release root'}`);
  const hex = effective === null ? null : RELEASE_DROPIN_PATTERN.exec(effective.name)![1]!;
  check('systemd-effective-dropin-names-commit', hex !== null && manifestCommit !== null && manifestCommit.startsWith(hex),
    `drop-in ${hex ?? 'none'}; --expect-current manifest commit ${manifestCommit ?? 'unknown'}`);

  const loaded = await readLoadedUnit(host, unit);
  check('systemd-unit-loaded', loaded !== null && loaded.loadState === 'loaded',
    loaded === null ? `systemctl --user show ${unit} failed` : `LoadState=${loaded.loadState ?? 'unknown'}`);
  check('systemd-unit-reload-clean', loaded?.needDaemonReload === false,
    loaded?.needDaemonReload === true ? 'NeedDaemonReload=yes: the files on disk are not what the manager runs'
      : loaded?.needDaemonReload === false ? 'NeedDaemonReload=no' : 'NeedDaemonReload unreadable');
  const dropInPaths = loaded?.dropInPaths ?? [];
  const index = effective === null ? -1 : dropInPaths.indexOf(effective.path);
  const loadedInDir = dropInPaths.filter((entry) => path.dirname(entry) === dropInDir).map((entry) => path.basename(entry)).sort();
  const sameSet = dropIns !== null && loadedInDir.join('\n') === dropIns.map((file) => file.name).join('\n');
  const overriding = index < 0 ? [] : dropInPaths.slice(index + 1).filter((entry) => {
    try { return EXEC_OVERRIDE.test(readFileSync(entry, 'utf8')); } catch { return true; }
  });
  const execRoots = loaded === null ? [] : releaseRootsIn(loaded.execStart.join('\n'), releasesDir);
  const loadedExecStartRoot = loaded !== null && loaded.execStart.length === 1 && execRoots.length === 1 ? execRoots[0]! : null;
  const loadedOk = index >= 0 && sameSet && overriding.length === 0 && loadedExecStartRoot === expectCurrent;
  check('systemd-loaded-unit-on-expected-release', loadedOk, [
    index >= 0 ? 'DropInPaths includes the effective drop-in' : 'DropInPaths does not include the effective drop-in',
    sameSet ? 'loaded drop-in set matches disk' : 'loaded drop-in set differs from disk',
    overriding.length === 0 ? 'no later drop-in sets ExecStart' : `later drop-ins set ExecStart: ${overriding.map((entry) => path.basename(entry)).join(', ')}`,
    `loaded ExecStart names ${execRoots.join(', ') || 'no release root'}`,
  ].join('; '));

  const mainPid = loaded?.mainPid ?? null;
  const argv = mainPid === null ? null : host.readProcessCmdline?.(mainPid) ?? null;
  const running = mainPid === null ? { root: null, detail: 'unit has no main pid' } : releaseRootOfArgv(argv, releasesDir);
  check('systemd-main-pid-on-expected-release', running.root === expectCurrent, `MainPID ${mainPid ?? 0}: ${running.detail}`);

  const agree = checks.every((entry) => entry.ok);
  return {
    generation: {
      releaseRoot: agree ? expectCurrent : null,
      manifestCommit,
      effectiveDropIn: effective,
      dropInRoot,
      needDaemonReload: loaded?.needDaemonReload ?? null,
      dropInPaths,
      loadedExecStartRoot,
      mainPid,
      mainPidRoot: running.root,
      dropIns: dropIns ?? [],
    },
    effectiveText,
    loaded,
    checks,
  };
}

/** Generation identity for the pre-switch recheck: every recorded field must be unchanged. */
export function sameGeneration(left: SystemdGeneration, right: SystemdGeneration): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface StagedDropIn {
  name: string;
  path: string;
  contents: string;
  sha256: string;
}

export interface AutomaticRollbackAdmission {
  available: boolean;
  /** Why the predecessor may not be started again automatically; empty when available. */
  reasons: string[];
}

export interface SystemdActivationContext extends FenceRecheckContext {
  manager: 'systemd-user';
  home: string;
  unit: string;
  dropInDir: string;
  releasesDir: string;
  dbPath: string;
  healthPort: number | null;
  healthToken: string | null;
  /** The running release's own requirement binds any release started after it, including an older candidate. */
  fenceInForce: { required: RefreshRollbackFenceLevels | null; candidateCapability: RefreshRollbackFenceLevels | null; ok: boolean; detail: string };
  schema: { live: number | null; liveDetail: string; candidate: ReleaseSchemaSupport; target: ReleaseSchemaSupport };
  automaticRollback: AutomaticRollbackAdmission;
  generation: SystemdGeneration;
  staged: StagedDropIn | null;
  cgroup: { insideTarget: boolean | null; detail: string };
  preconditions: Precondition[];
}

export function rollbackAdmission(context: Pick<SystemdActivationContext, 'refreshRollbackFence' | 'schema' | 'oldCommit'>, schemaLevel: number | null): AutomaticRollbackAdmission {
  const reasons: string[] = [];
  const fence = context.refreshRollbackFence;
  if (!fence.targetCompatibleAtPlan) reasons.push(`rollback target cannot meet the candidate refresh rollback fence (${fence.targetDetail})`);
  if (context.schema.target.max === null) reasons.push(`rollback target schema support unproven (${context.schema.target.detail})`);
  else if (schemaLevel === null) reasons.push('database schema level unknown');
  else if (schemaLevel > context.schema.target.max) reasons.push(`database schema ${schemaLevel} is above rollback target support ${context.schema.target.max}`);
  if (context.oldCommit === null) reasons.push('rollback target commit unknown');
  return { available: reasons.length === 0, reasons };
}

const UNREAD_FENCE: RefreshRollbackFenceRead = { required: null, capability: null, digest: null, detail: 'not read' };

export async function buildSystemdActivationContext(host: ActivationHost, args: ActivationArgs): Promise<SystemdActivationContext> {
  const preconditions: Precondition[] = [];
  const check = (id: string, ok: boolean, detail: string): boolean => {
    preconditions.push({ id, ok, detail });
    return ok;
  };
  const home = os.homedir();
  const unit = unitFor(args.instance);
  const dropInDir = dropInDirFor(home, unit);
  const releasesDir = releasesDirFor(home);
  const dbPath = instancePaths(args.instance).dbPath;

  check('platform-linux-systemd-user', host.platform === 'linux', `platform ${host.platform}`);
  check('systemd-options-supported', args.auxLabels.length === 0 && args.wrapperLink === null,
    'the unit drop-in selects the release: --aux-label and --wrapper-link do not apply under systemd');
  check('home-absolute', path.isAbsolute(home), 'HOME must be absolute');
  check('release-distinct', args.release !== args.expectCurrent, '--release and --expect-current must differ');
  check('release-roots-under-releases-dir',
    path.dirname(args.release) === releasesDir && path.dirname(args.expectCurrent) === releasesDir, `both under ${releasesDir}`);

  const next = readManifestCommit(args.release);
  let newCommit: string | null = null;
  check('release-manifest-valid', next.error === null, next.error === null ? 'schema-valid' : `new release manifest ${next.error}`);
  if (next.error === null) {
    check('release-manifest-path', next.releasePath === args.release,
      next.releasePath === args.release ? 'manifest release.path matches --release' : 'manifest release.path differs from --release');
    const full = next.commit !== null && FULL_COMMIT.test(next.commit);
    check('release-manifest-commit', full, full ? `commit ${next.commit}` : 'manifest source.commit is not a full 40-hex commit');
    if (full) newCommit = next.commit;
  }
  check('release-wrapper-present', isRegularFile(wrapperTargetFor(args.release)), 'deploy/whatsoup in the new release');
  check('release-entrypoint-present', isRegularFile(bootstrapEntrypointFor(args.release)), 'src/bootstrap.ts in the new release');
  check('release-dependencies-present', isDirectory(path.join(args.release, 'node_modules')), 'node_modules in the new release');
  check('rollback-release-present', existsSync(wrapperTargetFor(args.expectCurrent)), 'deploy/whatsoup in the --expect-current release');

  const previous = readManifestCommit(args.expectCurrent);
  const oldCommit = previous.error === null && previous.commit !== null && FULL_COMMIT.test(previous.commit)
    && previous.releasePath === args.expectCurrent ? previous.commit : null;
  check('expect-current-manifest-commit', oldCommit !== null,
    oldCommit !== null ? `commit ${oldCommit}` : `--expect-current manifest ${previous.error ?? 'commit or release.path invalid'}`);

  // Fences: F7's per-key reader and compatibility rule, unchanged.
  const candidateFence = next.error === null && next.manifest !== null ? readRefreshRollbackFence(args.release, next.manifest) : UNREAD_FENCE;
  check('release-refresh-rollback-fence-valid', candidateFence.required !== null, candidateFence.detail);
  const targetFence: RefreshRollbackFenceRead = previous.error === null && previous.manifest !== null
    ? readRefreshRollbackFence(args.expectCurrent, previous.manifest)
    : previous.error === 'missing'
      ? { required: legacyFenceLevels(), capability: legacyFenceLevels(), digest: null, detail: 'rollback target has no release manifest or refresh rollback fence' }
      : { required: null, capability: null, digest: null, detail: `rollback target release manifest ${previous.error ?? 'unavailable'}` };
  const refreshRollbackFence: ActivationContext['refreshRollbackFence'] = {
    required: candidateFence.required,
    candidateDigest: candidateFence.digest,
    targetCapability: targetFence.capability,
    targetDigest: targetFence.digest,
    targetCompatibleAtPlan: candidateFence.required !== null && fenceCompatible(candidateFence.required, targetFence.capability),
    candidateDetail: candidateFence.detail,
    targetDetail: targetFence.detail,
  };
  const inForceOk = targetFence.required !== null && candidateFence.capability !== null
    && fenceCompatible(targetFence.required, candidateFence.capability);
  const fenceInForce = {
    required: targetFence.required,
    candidateCapability: candidateFence.capability,
    ok: inForceOk,
    detail: targetFence.required === null ? `fence in force unreadable: ${targetFence.detail}`
      : candidateFence.capability === null ? `candidate capability unreadable: ${candidateFence.detail}`
        : `running release requires ${formatFenceLevels(targetFence.required)}; candidate provides ${formatFenceLevels(candidateFence.capability)}`,
  };
  check('systemd-candidate-meets-fence-in-force', inForceOk, fenceInForce.detail);

  // Schema: the candidate must open the database; unknown on either side refuses.
  const databasePresent = check('database-present', isRegularFile(dbPath), 'instance bot.db is a regular file');
  let live: number | null = null;
  let liveDetail = 'database absent';
  if (databasePresent) {
    try {
      live = readSchemaMigrationLevel(dbPath);
      liveDetail = `schema migration ${live}`;
    } catch (error) {
      liveDetail = error instanceof Error ? error.message : String(error);
    }
  }
  check('database-schema-level-readable', live !== null, liveDetail);
  const candidateSchema = readReleaseSchemaSupport(args.release, next.error === null ? next.manifest : null);
  const targetSchema = readReleaseSchemaSupport(args.expectCurrent, previous.error === null ? previous.manifest : null);
  check('release-schema-support-covers-database', live !== null && candidateSchema.max !== null && live <= candidateSchema.max,
    `database ${live ?? 'unknown'}; candidate ${candidateSchema.detail}`);

  const port = resolveHealthPort(args);
  check('health-port-resolved', port.port !== null, port.detail);
  const healthToken = resolveInstanceHealthToken(args.instance);
  check('health-token-present', healthToken !== null, healthToken !== null ? 'resolved (value never printed)' : 'no health token');
  check('backup-dir-set', args.backupDir !== null && path.isAbsolute(args.backupDir),
    args.backupDir === null ? '--backup-dir is required for --apply' : 'absolute');

  const read = await readGeneration(host, { unit, dropInDir, releasesDir, expectCurrent: args.expectCurrent, manifestCommit: oldCommit });
  preconditions.push(...read.checks);

  let staged: StagedDropIn | null = null;
  if (newCommit !== null && read.effectiveText !== null && read.generation.dropInRoot === args.expectCurrent) {
    const contents = replaceReleaseRoot(read.effectiveText, args.expectCurrent, args.release);
    const name = nextReleaseDropInName(newCommit.slice(0, 12), [
      ...read.generation.dropIns.map((file) => file.name),
      ...read.generation.dropInPaths.map((entry) => path.basename(entry)),
    ]);
    const roots = releaseRootsIn(contents, releasesDir);
    if (name !== null && roots.length === 1 && roots[0] === args.release && !mentionsReleaseRoot(contents, args.expectCurrent)) {
      staged = { name, path: path.join(dropInDir, name), contents, sha256: sha256(Buffer.from(contents, 'utf8')) };
    }
  }
  check('systemd-new-dropin-staged', staged !== null, staged === null ? 'could not stage a drop-in that selects only the new release' : staged.name);

  const insideTarget = cgroupInsideUnit(host.readSelfCgroup?.() ?? null, unit);
  const cgroupDetail = insideTarget === null ? 'own cgroup unreadable: treated as inside the target unit'
    : insideTarget ? `this process runs inside ${unit}; --apply would stop itself mid-switch: run it from a separate unit or scope`
      : `outside ${unit}`;
  if (args.mode === 'apply') check('systemd-apply-outside-target-cgroup', insideTarget === false, cgroupDetail);

  const schema = { live, liveDetail, candidate: candidateSchema, target: targetSchema };
  return {
    manager: 'systemd-user',
    args,
    home,
    unit,
    dropInDir,
    releasesDir,
    dbPath,
    healthPort: port.port,
    healthToken,
    newCommit,
    oldCommit,
    refreshRollbackFence,
    fenceInForce,
    schema,
    automaticRollback: rollbackAdmission({ refreshRollbackFence, schema, oldCommit }, live),
    generation: read.generation,
    staged,
    cgroup: { insideTarget, detail: cgroupDetail },
    preconditions,
  };
}

export function systemdActions(context: SystemdActivationContext): Array<Record<string, unknown>> {
  const { args, unit } = context;
  return [
    { step: 'acquire-activation-lock', path: activationLockPath(context.home), onHeld: 'refuse with no change' },
    { step: 'refuse-inside-target-cgroup', unit, source: '/proc/self/cgroup' },
    { step: 'create-backup-dir', path: args.backupDir === null ? null : path.join(args.backupDir, 'activation-<commit12>-<utc>'), mode: '0700' },
    { step: 'backup-database', from: context.dbPath, to: '<backup>/bot.db', verify: 'PRAGMA quick_check = ok', mode: '0600' },
    { step: 'record-schema-level', from: '<backup>/bot.db', read: 'MAX(version) FROM schema_migrations' },
    { step: 'backup-dropins', from: context.dropInDir, to: '<backup>/dropins/', mode: '0600' },
    { step: 'write-recovery', files: ['<backup>/recovery.json', '<backup>/recovery.md'], binds: 'release root, manifest commit, drop-in names and sha256, MainPID, backup schema level' },
    { step: 'validate-recovery-evidence', refuseOnFailure: 'exit 2 before any daemon-reload, stop or restart' },
    { step: 'recheck-refresh-rollback-fence-requirement-before-switch' },
    { step: 'recheck-generation-before-switch', sources: ['effective drop-in', 'systemctl show', 'MainPID argv', 'manifest commit'] },
    { step: 'write-dropin', path: context.staged?.path ?? null, mode: '0600', atomic: true },
    { step: 'daemon-reload', argv: ['systemctl', '--user', 'daemon-reload'] },
    { step: 'restart', argv: ['systemctl', '--user', 'restart', unit] },
    {
      step: 'verify',
      timeoutSeconds: args.verifyTimeoutSeconds,
      instance: { pidChanged: true, argvContains: bootstrapEntrypointFor(args.release), health: { commit: context.newCommit, connected: true, port: context.healthPort } },
    },
    {
      step: 'rollback-on-failure',
      automatic: context.automaticRollback.available,
      blockIf: 'schema level changed, unreadable or above the rollback target support (exit 4), or the rollback target fails the refresh fence (exit 5), checked before stopping the unit and again after it stops',
      restore: ['remove new drop-in', 'daemon-reload', 'start'],
    },
  ];
}

export function systemdPlanDocument(context: SystemdActivationContext): Record<string, unknown> {
  const { args } = context;
  return {
    mode: args.mode,
    manager: context.manager,
    ready: context.preconditions.every((entry) => entry.ok),
    instance: args.instance,
    unit: context.unit,
    release: { path: args.release, commit: context.newCommit },
    expectCurrent: { path: args.expectCurrent, commit: context.oldCommit },
    generation: context.generation,
    paths: { dropInDir: context.dropInDir, releasesDir: context.releasesDir, database: context.dbPath, backupDir: args.backupDir },
    newDropIn: context.staged === null ? null : { name: context.staged.name, sha256: context.staged.sha256 },
    health: { port: context.healthPort, tokenResolved: context.healthToken !== null },
    rollbackRefreshFence: {
      candidateRequirement: context.refreshRollbackFence.required,
      targetCapabilityAtPlan: context.refreshRollbackFence.targetCapability,
      targetCompatibleAtPlan: context.refreshRollbackFence.targetCompatibleAtPlan,
      candidateDetail: context.refreshRollbackFence.candidateDetail,
      targetDetail: context.refreshRollbackFence.targetDetail,
      limitation: 'compatibility only; not evidence of a live or absent refresh child',
    },
    fenceInForce: context.fenceInForce,
    schema: context.schema,
    automaticRollback: {
      ...context.automaticRollback,
      route: context.automaticRollback.available ? 'automatic' : 'manual-recovery-only',
    },
    cgroup: context.cgroup,
    preconditions: context.preconditions,
    actions: systemdActions(context),
  };
}
