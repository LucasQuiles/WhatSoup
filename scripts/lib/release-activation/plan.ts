/**
 * Read-only half of `release:activate`: resolve every path from arguments,
 * instance config, `HOME`/`XDG_*` and the release manifests; check the
 * preconditions; render the staged plists in memory; and describe the exact
 * actions an apply would take. Nothing here writes to disk or calls a
 * launchctl verb that changes state.
 *
 * Why the checks are shaped the way they are is documented in
 * docs/runbooks/release-deployment.md ("Activating a release"): the wrapper
 * symlink selects the bot's release, an absolute ProgramArguments path
 * selects each auxiliary job's release, and WorkingDirectory selects nothing.
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_INSTANCE_HEALTH_PORT } from '../../../src/fleet/constants.ts';
import { isValidInstanceName } from '../../../src/fleet/instance-name.ts';
import { configRoot, instancePaths } from '../../../src/fleet/paths.ts';
import { escapeXml } from '../../../src/fleet/platform.ts';
import { parsePlist } from '../../check-service-units.ts';
import {
  parseReleaseSnapshotManifest,
  RELEASE_MANIFEST_FILE,
  validateReleaseManifestFile,
} from '../../release-snapshot-plan.ts';
import { type ActivationHost, resolveInstanceHealthToken } from './host.ts';

/** How an auxiliary job's plist is re-rendered from inside the new release. */
export type AuxRenderer = 'setup-timer' | 'release-drift';
export const AUX_RENDERERS: readonly AuxRenderer[] = ['setup-timer', 'release-drift'];

export interface AuxLabelSpec {
  label: string;
  renderer: AuxRenderer;
}

export interface ActivationArgs {
  instance: string;
  release: string;
  expectCurrent: string;
  auxLabels: AuxLabelSpec[];
  healthPort: number | null;
  backupDir: string | null;
  wrapperLink: string | null;
  mode: 'plan' | 'apply';
  exitTimeoutSeconds: number;
  verifyTimeoutSeconds: number;
}

export interface Precondition {
  id: string;
  ok: boolean;
  detail: string;
}

export interface StagedPlist {
  label: string;
  role: 'instance' | 'aux';
  renderer: 'instance-edit' | AuxRenderer;
  plistPath: string;
  /** Rendered bytes; null when rendering failed (a precondition records why). */
  staged: string | null;
  /** Human-readable edits for the instance plist; empty for aux renders. */
  edits: string[];
  /**
   * Lines that differ between the staged plist and the installed plist once the
   * old release root is replaced by the new one. Non-zero means the re-render
   * changes more than the release root (a template change, or a site value the
   * renderer did not carry forward); review it before --apply.
   */
  renderDriftLines: number | null;
}

export interface ActivationContext {
  args: ActivationArgs;
  home: string;
  domain: string;
  launchAgentsDir: string;
  wrapperLink: string;
  dbPath: string;
  healthPort: number | null;
  healthToken: string | null;
  newCommit: string | null;
  oldCommit: string | null;
  instanceLabel: string;
  preconditions: Precondition[];
  staged: StagedPlist[];
}

export const LABEL_PATTERN = /^com\.whatsoup\.[A-Za-z0-9._-]+$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/;

export function instanceLabelFor(instance: string): string {
  return `com.whatsoup.${instance}`;
}

export function wrapperTargetFor(releaseRoot: string): string {
  return path.join(releaseRoot, 'deploy', 'whatsoup');
}

export function bootstrapEntrypointFor(releaseRoot: string): string {
  return path.join(releaseRoot, 'src', 'bootstrap.ts');
}

/** True when `text` names a path at or under `root` (not a sibling sharing its prefix). */
export function mentionsReleaseRoot(text: string, root: string): boolean {
  const escaped = escapeXml(root);
  return [root, escaped].some((spelling) => (
    text.includes(`${spelling}/`) || text.includes(`${spelling}<`) || text.split(/\s/).includes(spelling)
  ));
}

function readManifestCommit(releaseRoot: string): { commit: string | null; releasePath: string | null; error: string | null } {
  const manifestPath = path.join(releaseRoot, RELEASE_MANIFEST_FILE);
  const report = validateReleaseManifestFile(manifestPath);
  if (!report.ok) return { commit: null, releasePath: null, error: report.error?.kind ?? 'invalid' };
  const manifest = parseReleaseSnapshotManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  return { commit: manifest.source.commit, releasePath: manifest.release.path, error: null };
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(target: string): boolean {
  try {
    return lstatSync(target).isFile();
  } catch {
    return false;
  }
}

function readLinkOrNull(target: string): string | null {
  try {
    return readlinkSync(target);
  } catch {
    return null;
  }
}

function resolveHealthPort(args: ActivationArgs): { port: number | null; detail: string } {
  if (args.healthPort !== null) return { port: args.healthPort, detail: `--health-port ${args.healthPort}` };
  const configPath = path.join(configRoot(), args.instance, 'config.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return { port: null, detail: 'instance config.json unreadable and no --health-port given' };
  }
  const raw = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['healthPort'] : undefined;
  if (raw === undefined) return { port: DEFAULT_INSTANCE_HEALTH_PORT, detail: 'instance config sets no healthPort; default' };
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw < 65_536) {
    return { port: raw, detail: 'instance config healthPort' };
  }
  return { port: null, detail: 'instance config healthPort is not a valid port' };
}

function replaceStringValueAfterKey(text: string, key: string, from: string, to: string): string | null {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)${escapeForRegExp(escapeXml(from))}(</string>)`);
  if (!pattern.test(text)) return null;
  return text.replace(pattern, (_match, open: string, close: string) => `${open}${escapeXml(to)}${close}`);
}

function replaceFirstProgramArgument(text: string, from: string, to: string): string | null {
  const pattern = new RegExp(`(<key>ProgramArguments</key>\\s*<array>\\s*<string>)${escapeForRegExp(escapeXml(from))}(</string>)`);
  if (!pattern.test(text)) return null;
  return text.replace(pattern, (_match, open: string, close: string) => `${open}${escapeXml(to)}${close}`);
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Stage the instance plist: only ProgramArguments[0] (when it names the old
 * release's wrapper directly rather than the wrapper symlink) and
 * WorkingDirectory (when it lies inside the old release) change.
 */
export function stageInstancePlist(
  installed: string,
  options: { expectCurrent: string; release: string; wrapperLink: string },
): { staged: string | null; edits: string[]; error: string | null } {
  const parsed = parsePlist(installed);
  if (!parsed) return { staged: null, edits: [], error: 'installed instance plist is not a parseable XML plist' };
  const argv0 = parsed.programArguments[0];
  const edits: string[] = [];
  let staged = installed;
  const oldWrapper = wrapperTargetFor(options.expectCurrent);
  if (argv0 === oldWrapper) {
    const next = replaceFirstProgramArgument(staged, oldWrapper, wrapperTargetFor(options.release));
    if (next === null) return { staged: null, edits, error: 'could not locate ProgramArguments[0] for rewrite' };
    staged = next;
    edits.push(`ProgramArguments[0]: ${oldWrapper} -> ${wrapperTargetFor(options.release)}`);
  } else if (argv0 !== options.wrapperLink) {
    return {
      staged: null,
      edits,
      error: 'ProgramArguments[0] is neither the wrapper symlink nor the expected release wrapper',
    };
  }
  const workingDirectory = parsed.scalarKeys['WorkingDirectory'];
  if (workingDirectory !== undefined
    && (workingDirectory === options.expectCurrent || workingDirectory.startsWith(`${options.expectCurrent}/`))) {
    const target = `${options.release}${workingDirectory.slice(options.expectCurrent.length)}`;
    const next = replaceStringValueAfterKey(staged, 'WorkingDirectory', workingDirectory, target);
    if (next === null) return { staged: null, edits, error: 'could not locate WorkingDirectory for rewrite' };
    staged = next;
    edits.push(`WorkingDirectory: ${workingDirectory} -> ${target}`);
  }
  if (mentionsReleaseRoot(staged, options.expectCurrent)) {
    return { staged: null, edits, error: 'staged instance plist still references the expected-current release' };
  }
  return { staged, edits, error: null };
}

/** Flag/value pairs the release-drift renderer accepts and the installed job carries. */
const RELEASE_DRIFT_CARRIED_FLAGS = ['--instance', '--target-url', '--target-ref', '--max-log-bytes', '--keep-rotated-logs'];

function carriedReleaseDriftArgs(programArguments: readonly string[], fallbackInstance: string): string[] {
  const carried: string[] = [];
  for (const flag of RELEASE_DRIFT_CARRIED_FLAGS) {
    const index = programArguments.indexOf(flag);
    const value = index >= 0 ? programArguments[index + 1] : undefined;
    if (value !== undefined && !value.startsWith('--')) carried.push(flag, value);
    else if (flag === '--instance') carried.push(flag, fallbackInstance);
  }
  return carried;
}

function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, '');
}

/** Render an aux plist from inside the new release, exactly as its installer does. */
export async function renderAuxPlist(
  host: ActivationHost,
  spec: AuxLabelSpec,
  options: { release: string; home: string; installedPath: string; installed: string; instance: string },
): Promise<{ staged: string | null; error: string | null }> {
  const { release, home, installedPath } = options;
  if (spec.renderer === 'setup-timer') {
    // deploy/setup.sh install_launchd_timer: four literal substitutions, then
    // the new release's own claude-config filter with --preserve-from.
    const template = path.join(release, 'deploy', `${spec.label}.plist`);
    if (!isRegularFile(template)) return { staged: null, error: `new release has no template deploy/${spec.label}.plist` };
    const substituted = stripTrailingNewlines(readFileSync(template, 'utf8')
      .replaceAll('__WHATSOUP_REPO_ROOT__', release)
      .replaceAll('__HOME__', home)
      .replaceAll('${WHATSOUP_REPO_ROOT}', release)
      .replaceAll('${HOME}', home));
    const result = await host.exec('bash', [
      path.join(release, 'scripts', 'run-with-pinned-node.sh'),
      path.join(release, 'scripts', 'launchd-claude-config-env.ts'),
      '--home', home,
      '--preserve-from', installedPath,
    ], { input: `${substituted}\n` });
    if (result.code !== 0) return { staged: null, error: `claude-config filter exited ${result.code}` };
    return { staged: `${stripTrailingNewlines(result.stdout)}\n`, error: null };
  }
  const renderer = path.join(release, 'deploy', 'scripts', 'render-release-drift-launchd.sh');
  if (!isRegularFile(renderer)) return { staged: null, error: 'new release has no render-release-drift-launchd.sh' };
  const parsed = parsePlist(options.installed);
  const result = await host.exec('bash', [
    renderer,
    ...carriedReleaseDriftArgs(parsed?.programArguments ?? [], options.instance),
    '--repo-root', release,
    '--home', home,
    '--preserve-from', installedPath,
  ]);
  if (result.code !== 0) return { staged: null, error: `release-drift renderer exited ${result.code}` };
  return { staged: result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`, error: null };
}

/** Lines present on one side only, after moving the installed plist onto the new root. */
export function countRenderDriftLines(installed: string, staged: string, expectCurrent: string, release: string): number {
  const moved = installed.split(expectCurrent).join(release);
  const left = moved.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
  const right = staged.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0);
  const counts = new Map<string, number>();
  for (const line of left) counts.set(line, (counts.get(line) ?? 0) + 1);
  let unmatchedRight = 0;
  for (const line of right) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else unmatchedRight += 1;
  }
  let unmatchedLeft = 0;
  for (const remaining of counts.values()) unmatchedLeft += remaining;
  return unmatchedLeft + unmatchedRight;
}

/** Absolute ProgramArguments entries of an aux job that lie under `root`. */
function programArgumentsUnder(programArguments: readonly string[], root: string): string[] {
  return programArguments.filter((arg) => path.isAbsolute(arg) && arg.startsWith(`${root}/`));
}

/**
 * Build the read-only activation context: resolved paths, preconditions, and
 * staged plist bytes. Never writes.
 */
export async function buildActivationContext(host: ActivationHost, args: ActivationArgs): Promise<ActivationContext> {
  const preconditions: Precondition[] = [];
  const check = (id: string, ok: boolean, detail: string): boolean => {
    preconditions.push({ id, ok, detail });
    return ok;
  };
  const home = os.homedir();
  const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
  const wrapperLink = args.wrapperLink ?? path.join(home, '.local', 'bin', 'whatsoup');
  const instanceLabel = instanceLabelFor(args.instance);
  const context: ActivationContext = {
    args,
    home,
    domain: `gui/${host.uid}`,
    launchAgentsDir,
    wrapperLink,
    dbPath: instancePaths(args.instance).dbPath,
    healthPort: null,
    healthToken: null,
    newCommit: null,
    oldCommit: null,
    instanceLabel,
    preconditions,
    staged: [],
  };

  check('platform-macos-launchd', host.platform === 'darwin',
    host.platform === 'darwin' ? 'darwin' : `release:activate supports macOS launchd only (platform ${host.platform})`);
  check('home-absolute', path.isAbsolute(home), 'HOME must be absolute');
  check('release-distinct', args.release !== args.expectCurrent, '--release and --expect-current must differ');

  const next = readManifestCommit(args.release);
  check('release-manifest-valid', next.error === null,
    next.error === null ? 'schema-valid' : `new release manifest ${next.error}`);
  if (next.error === null) {
    check('release-manifest-path', next.releasePath === args.release,
      next.releasePath === args.release ? 'manifest release.path matches --release' : 'manifest release.path differs from --release');
    const full = next.commit !== null && FULL_COMMIT.test(next.commit);
    check('release-manifest-commit', full, full ? `commit ${next.commit}` : 'manifest source.commit is not a full 40-hex commit');
    if (full) context.newCommit = next.commit;
  }
  check('release-wrapper-present', isRegularFile(wrapperTargetFor(args.release)), 'deploy/whatsoup in the new release');
  check('release-entrypoint-present', isRegularFile(bootstrapEntrypointFor(args.release)), 'src/bootstrap.ts in the new release');
  check('release-dependencies-present', isDirectory(path.join(args.release, 'node_modules')),
    'node_modules in the new release (the restart preflight refuses a release without it)');

  check('rollback-release-present', existsSync(wrapperTargetFor(args.expectCurrent)),
    'deploy/whatsoup in the --expect-current release (the rollback target)');
  const previous = readManifestCommit(args.expectCurrent);
  // An older release may predate manifests; rollback then verifies argv and
  // connection without a commit comparison.
  if (previous.error === null && previous.commit !== null && FULL_COMMIT.test(previous.commit)) {
    context.oldCommit = previous.commit;
  }

  const linkTarget = readLinkOrNull(wrapperLink);
  check('wrapper-link-on-expected-release', linkTarget === wrapperTargetFor(args.expectCurrent),
    linkTarget === null ? 'wrapper symlink missing or not a symlink' : `wrapper symlink -> ${linkTarget}`);

  const port = resolveHealthPort(args);
  context.healthPort = port.port;
  check('health-port-resolved', port.port !== null, port.detail);
  context.healthToken = resolveInstanceHealthToken(args.instance);
  check('health-token-present', context.healthToken !== null,
    context.healthToken !== null ? 'resolved (value never printed)' : 'no health token: verification could not authenticate');

  check('database-present', isRegularFile(context.dbPath), 'instance bot.db is a regular file');
  check('backup-dir-set', args.backupDir !== null && path.isAbsolute(args.backupDir),
    args.backupDir === null ? '--backup-dir is required for --apply' : 'absolute');

  // Instance plist.
  const instancePlistPath = path.join(launchAgentsDir, `${instanceLabel}.plist`);
  const instanceInstalled = isRegularFile(instancePlistPath) ? readFileSync(instancePlistPath, 'utf8') : null;
  if (check('instance-plist-present', instanceInstalled !== null, `${instanceLabel}.plist in LaunchAgents`)) {
    const stagedInstance = stageInstancePlist(instanceInstalled!, {
      expectCurrent: args.expectCurrent,
      release: args.release,
      wrapperLink,
    });
    check('instance-plist-staged', stagedInstance.error === null, stagedInstance.error ?? 'staged');
    context.staged.push({
      label: instanceLabel,
      role: 'instance',
      renderer: 'instance-edit',
      plistPath: instancePlistPath,
      staged: stagedInstance.staged,
      edits: stagedInstance.edits,
      renderDriftLines: stagedInstance.staged === null
        ? null
        : countRenderDriftLines(instanceInstalled!, stagedInstance.staged, args.expectCurrent, args.release),
    });
  }

  // Auxiliary jobs.
  for (const spec of args.auxLabels) {
    const plistPath = path.join(launchAgentsDir, `${spec.label}.plist`);
    const installed = isRegularFile(plistPath) ? readFileSync(plistPath, 'utf8') : null;
    if (!check(`aux-plist-present:${spec.label}`, installed !== null, `${spec.label}.plist in LaunchAgents`)) continue;
    const parsed = parsePlist(installed!);
    const onExpected = parsed !== null && programArgumentsUnder(parsed.programArguments, args.expectCurrent).length > 0;
    check(`aux-on-expected-release:${spec.label}`, onExpected,
      onExpected ? 'ProgramArguments select the expected-current release' : 'ProgramArguments do not select the expected-current release');
    const rendered = await renderAuxPlist(host, spec, {
      release: args.release,
      home,
      installedPath: plistPath,
      installed: installed!,
      instance: args.instance,
    });
    let stagedOk = rendered.error === null && rendered.staged !== null;
    let detail = rendered.error ?? 'rendered';
    if (stagedOk) {
      const stagedParsed = parsePlist(rendered.staged!);
      if (stagedParsed === null) {
        stagedOk = false;
        detail = 'rendered plist is not a parseable XML plist';
      } else if (programArgumentsUnder(stagedParsed.programArguments, args.release).length === 0) {
        stagedOk = false;
        detail = 'rendered ProgramArguments do not select the new release';
      } else if (mentionsReleaseRoot(rendered.staged!, args.expectCurrent)) {
        stagedOk = false;
        detail = 'rendered plist still references the expected-current release';
      }
    }
    check(`aux-plist-staged:${spec.label}`, stagedOk, detail);
    context.staged.push({
      label: spec.label,
      role: 'aux',
      renderer: spec.renderer,
      plistPath,
      staged: stagedOk ? rendered.staged : null,
      edits: [],
      renderDriftLines: stagedOk ? countRenderDriftLines(installed!, rendered.staged!, args.expectCurrent, args.release) : null,
    });
  }

  return context;
}

export function preconditionsMet(context: ActivationContext): boolean {
  return context.preconditions.every((entry) => entry.ok);
}

/** The ordered action list an apply would execute, for the plan output. */
export function describeActions(context: ActivationContext): Array<Record<string, unknown>> {
  const { args } = context;
  const labels = context.staged.map((entry) => entry.label);
  return [
    { step: 'create-backup-dir', path: args.backupDir === null ? null : path.join(args.backupDir, 'activation-<commit12>-<utc>'), mode: '0700' },
    { step: 'backup-database', from: context.dbPath, to: '<backup>/bot.db', verify: 'PRAGMA quick_check = ok', mode: '0600' },
    { step: 'record-symlink', link: context.wrapperLink, to: '<backup>/symlink.before' },
    { step: 'backup-plists', labels, to: '<backup>/<label>.plist', mode: '0600' },
    { step: 'write-staged-plists', labels, to: '<backup>/<label>.staged.plist', lint: 'plutil -lint' },
    { step: 'switch-symlink', link: context.wrapperLink, target: wrapperTargetFor(args.release), atomic: true },
    { step: 'install-plists', labels, dir: context.launchAgentsDir, atomic: true },
    ...labels.map((label) => ({
      step: 'reload',
      label,
      sequence: [
        `launchctl print ${context.domain}/${label} (capture pid)`,
        `launchctl bootout ${context.domain}/${label}`,
        `wait up to ${args.exitTimeoutSeconds}s for the old pid to exit; refuse to bootstrap otherwise`,
        `launchctl bootstrap ${context.domain} <plist> (bounded retry on the transient Input/output error)`,
        `launchctl kickstart -k ${context.domain}/${label} (rejoins the keychain session${label === context.instanceLabel ? '' : '; runs this job once immediately'})`,
      ],
    })),
    {
      step: 'verify',
      timeoutSeconds: args.verifyTimeoutSeconds,
      instance: {
        pidChanged: true,
        argvContains: bootstrapEntrypointFor(args.release),
        health: { projection: 'diagnostic', commit: context.newCommit, connected: true, port: context.healthPort },
      },
      aux: labels.filter((label) => label !== context.instanceLabel)
        .map((label) => ({ label, loadedDefinitionUnder: args.release, notUnder: args.expectCurrent })),
    },
    {
      step: 'rollback-on-failure',
      restore: ['symlink', 'plists'],
      reload: labels,
      verify: { argvContains: bootstrapEntrypointFor(args.expectCurrent), commit: context.oldCommit },
    },
  ];
}
