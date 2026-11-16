import { execFileSync } from 'node:child_process';
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { maskPrivateText, resolveBoundaryTerms } from './lib/repo-hygiene-boundary.ts';
import {
  classifyPushRemote,
  isPreserveMirrorUrl,
  verifyAlignmentAfter,
  verifyAlignmentBefore,
  type AlignmentAfterOptions,
  type AlignmentBeforeOptions,
  type AlignmentReceipt,
  type PushRemoteClass,
  type RemoteClassOptions,
} from './pre-push-alignment.ts';

export const ZERO_SHA = '0000000000000000000000000000000000000000';
const ZERO_SHA_256 = '0'.repeat(64);
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export type RefDecision = 'delete' | 'branch' | 'release';
// 'preserve' = archival push to the preserve mirror: refs/preserve/* destinations
// only, estate-gated, exempt from candidate alignment and the verification composite.
export type PushDecision = 'skip' | 'branch' | 'release' | 'preserve';

const REQUIRED_CONSOLE_EXECUTABLES = ['eslint', 'tsc', 'vite'] as const;
const DELETE_ONLY_METADATA_SCRIPTS = ['design:metrics', 'design:burndown'] as const;
const PRESERVE_REF_PREFIX = 'refs/preserve/';

interface PrePushGuardDependencies {
  assertConsoleDependencies: (cwd: string) => void;
  verifyAlignmentBefore?: (options: AlignmentBeforeOptions) => AlignmentReceipt;
  verifyAlignmentAfter?: (
    receipt: AlignmentReceipt,
    options: AlignmentAfterOptions,
  ) => void;
  classifyPushRemote?: (options: RemoteClassOptions) => PushRemoteClass;
}

interface PushRemote {
  remoteName: string;
  remoteUrl: string;
}

interface RefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

function isZeroObjectId(oid: string): boolean {
  return oid === ZERO_SHA || oid === ZERO_SHA_256;
}

function pushedBranchRef(update: RefUpdate): string | null {
  if (isZeroObjectId(update.localSha)) return null;
  if (update.localRef.startsWith('refs/heads/')) return update.localRef;
  if (update.localRef === 'HEAD' && update.remoteRef.startsWith('refs/heads/')) {
    return update.remoteRef;
  }
  return null;
}

function parsePrePushLine(line: string): RefUpdate {
  const fields = line.trim().split(/\s+/);
  if (fields.length !== 4) {
    throw new Error(`Invalid pre-push ref update line: ${line}`);
  }
  const [localRef, localSha, remoteRef, remoteSha] = fields as [
    string,
    string,
    string,
    string,
  ];
  if (
    !localRef
    || !OBJECT_ID_PATTERN.test(localSha)
    || !remoteRef
    || !OBJECT_ID_PATTERN.test(remoteSha)
  ) {
    throw new Error(`Invalid pre-push ref update line: ${line}`);
  }
  return { localRef, localSha, remoteRef, remoteSha };
}

export function classifyPrePushLine(line: string): RefDecision {
  const update = parsePrePushLine(line);
  if (isZeroObjectId(update.localSha)) return 'delete';
  if (update.remoteRef === 'refs/heads/main') return 'release';
  if (/^refs\/tags\/v.+/.test(update.remoteRef)) return 'release';
  return 'branch';
}

function nonBlankLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function classifyPrePushInput(input: string): PushDecision {
  const lines = nonBlankLines(input);

  // Zero parseable ref-update lines is NOT the same thing as a genuine
  // all-delete push: a real delete-only push still has lines (each classifying
  // as 'delete' below), while this branch only fires when stdin itself was
  // empty/whitespace-only (e.g. wrapper/indirection stdin loss). Collapsing
  // both into 'skip' silently bypassed the whole verification battery on
  // stdin starvation, so this case fails CLOSED by routing to branch
  // verification instead.
  if (lines.length === 0) return 'branch';

  const decisions = lines.map(classifyPrePushLine);
  if (decisions.includes('release')) return 'release';
  if (decisions.includes('branch')) return 'branch';
  return 'skip';
}

export function commandsForDecision(decision: PushDecision): string[] {
  if (decision === 'release') return ['verify:release'];
  if (decision === 'branch') return ['verify:push:branch'];
  return [];
}

/**
 * The ref names a push publishes, scanned with the repository guard's --refs rules (the private
 * term rules and the fallback labels). The lines reach the guard through a private file, not a
 * pipe through two npm layers: the guard passes empty input, so a lost pipe would pass silently.
 * Deleted refs are not scanned: removing a privately named remote ref is the remedy, not a leak.
 */
function scanPushedRefNames(updates: readonly RefUpdate[], cwd: string): void {
  const published = updates.filter((update) => !isZeroObjectId(update.localSha));
  if (published.length === 0) return;
  const dir = mkdtempSync(join(tmpdir(), 'whatsoup-pushed-refs-'));
  try {
    const refsFile = join(dir, 'refs.txt');
    const lines = published.map((update) => `${update.localRef} ${update.localSha} ${update.remoteRef} ${update.remoteSha}`);
    writeFileSync(refsFile, `${lines.join('\n')}\n`, { mode: 0o600 });
    console.error('pre-push guard: scanning the pushed ref names (npm run guard:repo:refs)');
    try {
      execFileSync('npm', ['run', 'guard:repo:refs', '--', refsFile], { cwd, timeout: 30_000, stdio: 'inherit' });
    } catch (error) {
      // Fixed text: the child error quotes its arguments. The guard's exit code (1 findings, 2 term file) is kept.
      const failure: Error & { status?: number } = new Error(
        'pre-push guard: the pushed ref names failed the public-boundary check (npm run guard:repo:refs); push refused',
      );
      const status = (error as { status?: unknown }).status;
      if (typeof status === 'number' && status > 0) failure.status = status;
      throw failure;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The one gitleaks release the pre-push step runs; the Quality workflow downloads it sha256-verified. */
export const GITLEAKS_VERSION = '8.30.1';
/** gitleaks exits 1 on its own errors as well as on leaks, so leaks get this exit code instead. */
const GITLEAKS_LEAK_EXIT = 42;
const GITLEAKS_TIMEOUT_MS = 300_000;
/** A remote named on the command line; a push to a URL has no remote-tracking refs of its own. */
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A gitleaks rule id printed as is: lower-case words joined by single hyphens, at most 64 characters. */
const NEUTRAL_RULE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PRINTED_RULE_ID_LENGTH = 64;
/** Every other rule id is counted under this label: a custom rule's id can itself be a secret or a private name. */
const CUSTOM_RULE_LABEL = 'custom-rule';
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/** WHATSOUP_GITLEAKS when set and non-empty (the WHATSOUP_NODE convention), else `gitleaks` on PATH. */
function gitleaksCommand(env: NodeJS.ProcessEnv): string {
  const configured = env['WHATSOUP_GITLEAKS'];
  return configured !== undefined && configured !== '' ? configured : 'gitleaks';
}

/** The version the binary reports, without a leading `v`; null when it is absent or does not run. */
function gitleaksVersion(command: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const output = execFileSync(command, ['version'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim().replace(/^v/, '');
  } catch {
    return null;
  }
}

function commitExists(cwd: string, oid: string, env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${oid}^{commit}`], { cwd, env, timeout: 30_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function remoteTrackingRefs(remoteName: string): string {
  return REMOTE_NAME_PATTERN.test(remoteName) ? `--remotes=${remoteName}` : '--remotes';
}

/**
 * `git log` options naming the commits one update sends; gitleaks splits them on single spaces.
 * The remote's old tip is known here: old..new. A new ref, or an old tip this clone never
 * fetched: new minus everything the remote's tracking refs already hold.
 */
function pushedLogOptions(update: RefUpdate, remoteName: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (!isZeroObjectId(update.remoteSha) && commitExists(cwd, update.remoteSha, env)) {
    return `${update.remoteSha}..${update.localSha}`;
  }
  return `${update.localSha} --not ${remoteTrackingRefs(remoteName)}`;
}

/**
 * Whether a gitleaks rule id may be printed: a neutral shape that no loaded term rule and no
 * fallback rule matches (masking leaves it unchanged). A term file that cannot be loaded leaves
 * no way to check, so then no id is printed.
 */
function ruleIdPrinter(env: NodeJS.ProcessEnv): (ruleId: string) => boolean {
  let terms: ReturnType<typeof resolveBoundaryTerms>;
  try {
    terms = resolveBoundaryTerms(env);
  } catch {
    return () => false;
  }
  return (ruleId) => ruleId.length <= MAX_PRINTED_RULE_ID_LENGTH
    && NEUTRAL_RULE_ID_PATTERN.test(ruleId)
    && maskPrivateText(ruleId, terms.rules) === ruleId;
}

/** Findings per printable rule id from a gitleaks JSON report; null when the report is unreadable. */
function leakCountsByRule(reportPath: string, printable: (ruleId: string) => boolean): Map<string, number> | null {
  let findings: unknown;
  try {
    findings = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(findings)) return null;
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const ruleId = (finding as { RuleID?: unknown } | null)?.RuleID;
    const label = typeof ruleId === 'string' && printable(ruleId) ? ruleId : CUSTOM_RULE_LABEL;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether the folder gitleaks scans holds a .gitleaksignore. gitleaks reads that file whatever
 * --gitleaks-ignore-path names, so its entries would suppress findings. Any answer but "absent"
 * counts as present.
 */
function scanFolderHasIgnoreFile(cwd: string): boolean {
  try {
    lstatSync(join(cwd, '.gitleaksignore'));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * gitleaks' exit status for one range. Its output is discarded: it names files, commits and
 * authors. Neither an inline gitleaks:allow comment nor an ignore file may suppress a finding:
 * --ignore-gitleaks-allow, and --gitleaks-ignore-path naming an empty folder, as in the Quality job.
 */
function gitleaksExit(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  logOptions: string,
  reportPath: string,
  emptyIgnoreDir: string,
): number {
  try {
    execFileSync(command, [
      'git',
      '--log-opts', logOptions,
      '--config', resolve(cwd, '.gitleaks.toml'),
      '--ignore-gitleaks-allow',
      '--gitleaks-ignore-path', emptyIgnoreDir,
      '--redact',
      '--no-banner',
      '--log-level', 'error',
      '--report-format', 'json',
      '--report-path', reportPath,
      '--exit-code', String(GITLEAKS_LEAK_EXIT),
      '.',
    ], { cwd, env, timeout: GITLEAKS_TIMEOUT_MS, stdio: 'ignore' });
    return 0;
  } catch (error) {
    // The error's message quotes the whole argument list (refs, commits); only the status is used.
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : -1;
  }
}

/**
 * The pre-push secret scan: gitleaks over exactly the commits this push sends.
 *
 * Only the pinned release runs. A missing or different binary skips the step with one line, or
 * refuses the push under WHATSOUP_REQUIRE_GITLEAKS=1. Every line and error is counts and neutral
 * rule ids only (see ruleIdPrinter); the scanner's own stdout and stderr are discarded, and a
 * failure is rethrown as fixed text, because a child process error quotes its arguments.
 */
export function runGitleaksStep(
  input: string,
  cwd: string,
  remoteName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const command = gitleaksCommand(env);
  const version = gitleaksVersion(command, cwd, env);
  const problem = version === null
    ? 'gitleaks is not on PATH (or at WHATSOUP_GITLEAKS) or does not run'
    : version !== GITLEAKS_VERSION
      ? `gitleaks ${SEMVER_PATTERN.test(version) ? version : 'of an unrecognised version'} is not the pinned ${GITLEAKS_VERSION}`
      : null;
  if (problem !== null) {
    if (env['WHATSOUP_REQUIRE_GITLEAKS'] === '1') {
      throw new Error(`pre-push guard: ${problem}; WHATSOUP_REQUIRE_GITLEAKS=1 refuses the push`);
    }
    console.error(`pre-push guard: secret scan skipped: ${problem} (WHATSOUP_REQUIRE_GITLEAKS=1 makes this a failure)`);
    return;
  }

  if (scanFolderHasIgnoreFile(cwd)) {
    throw new Error('pre-push guard: a .gitleaksignore at the top of the working tree would suppress gitleaks findings; push refused');
  }

  const pushed = nonBlankLines(input)
    .map(parsePrePushLine)
    .filter((update) => !isZeroObjectId(update.localSha));
  // Empty stdin is the fail-closed case above: scan what HEAD would send, never the whole history.
  const ranges = pushed.length > 0
    ? pushed.map((update) => pushedLogOptions(update, remoteName, cwd, env))
    : [`HEAD --not ${remoteTrackingRefs(remoteName)}`];

  const reportDir = mkdtempSync(join(tmpdir(), 'whatsoup-gitleaks-'));
  try {
    const emptyIgnoreDir = join(reportDir, 'no-ignore-file');
    mkdirSync(emptyIgnoreDir);
    const leaks = new Map<string, number>();
    // The term file is read only when there is a rule id to check.
    let printable: ((ruleId: string) => boolean) | undefined;
    ranges.forEach((logOptions, index) => {
      const reportPath = join(reportDir, `report-${index}.json`);
      const status = gitleaksExit(command, cwd, env, logOptions, reportPath, emptyIgnoreDir);
      if (status === 0) return;
      const counts = status === GITLEAKS_LEAK_EXIT ? leakCountsByRule(reportPath, printable ??= ruleIdPrinter(env)) : null;
      if (counts === null || counts.size === 0) {
        throw new Error(`pre-push guard: gitleaks did not complete (exit ${status}); push refused`);
      }
      for (const [rule, count] of counts) leaks.set(rule, (leaks.get(rule) ?? 0) + count);
    });
    if (leaks.size > 0) {
      const total = [...leaks.values()].reduce((sum, count) => sum + count, 0);
      const perRule = [...leaks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rule, count]) => `${rule} ${count}`)
        .join(', ');
      throw new Error(`pre-push guard: gitleaks found ${total} leak(s) in the pushed commits (${perRule}); push refused`);
    }
    console.error(`pre-push guard: gitleaks ${GITLEAKS_VERSION} found no leaks in ${ranges.length} pushed range(s)`);
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

function assertConsoleDependencies(cwd: string): void {
  const missing = REQUIRED_CONSOLE_EXECUTABLES.filter((executable) => {
    try {
      accessSync(resolve(cwd, 'console/node_modules/.bin', executable), constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });

  if (missing.length > 0) {
    throw new Error(
      `pre-push guard: missing required console executables: ${missing.join(', ')}; run npm ci --prefix console before pushing`,
    );
  }

  try {
    execFileSync(
      'bash',
      [
        'scripts/run-with-pinned-npm.sh',
        '--prefix',
        'console',
        'ls',
        '--all',
        '--offline',
        '--ignore-scripts',
        '--audit=false',
        '--fund=false',
        '--update-notifier=false',
        '--json',
      ],
      {
        cwd,
        timeout: 30_000,
        stdio: 'ignore',
      },
    );
  } catch {
    throw new Error(
      'pre-push guard: console dependency tree is incomplete or invalid; run npm ci --prefix console before pushing',
    );
  }
}

export function runPrePushGuard(
  input: string,
  cwd = process.cwd(),
  dependencies: PrePushGuardDependencies = { assertConsoleDependencies },
  remote?: PushRemote,
): PushDecision {
  let parsedUpdates: RefUpdate[] = [];
  let parseError: unknown = null;
  try {
    parsedUpdates = nonBlankLines(input).map(parsePrePushLine);
  } catch (error) {
    parseError = error;
  }
  const pushedLocalBranchRefs = parsedUpdates
    .map(pushedBranchRef)
    .filter((localRef): localRef is string => localRef !== null)
    .sort();
  const estateArgs = ['run', 'guard:git-estate', '--', 'guard', '--phase', 'pre-push'];
  for (const localRef of pushedLocalBranchRefs) {
    estateArgs.push('--push-local-ref', localRef);
  }
  console.error('pre-push guard: running deterministic Git estate gate');
  execFileSync(
    'npm',
    estateArgs,
    { cwd, timeout: 30_000, stdio: 'inherit' },
  );
  if (parseError) throw parseError;

  // Preservation pushes: only when the hook names the preserve mirror AND at least one
  // non-delete update is present (empty/whitespace stdin keeps its fail-closed branch
  // routing; delete-only keeps its metadata-only routing). The configured push URL is
  // then proven to be the mirror over SSH, and every content destination must sit under
  // refs/preserve/*. Candidate alignment and the composite are for PR candidates, which
  // archival refs are not; the deterministic estate gate above already ran.
  const contentUpdates = parsedUpdates.filter((update) => !isZeroObjectId(update.localSha));
  if (remote && contentUpdates.length > 0 && isPreserveMirrorUrl(remote.remoteUrl)) {
    const classifyRemote = dependencies.classifyPushRemote ?? classifyPushRemote;
    const remoteClass = classifyRemote({
      cwd,
      remoteName: remote.remoteName,
      remoteUrl: remote.remoteUrl,
    });
    if (remoteClass !== 'preserve-mirror') {
      throw new Error(
        'pre-push guard: hook named the preserve mirror but the configured push remote did not classify as it; refusing',
      );
    }
    const offending = contentUpdates.filter(
      (update) => !update.remoteRef.startsWith(PRESERVE_REF_PREFIX),
    );
    if (offending.length > 0) {
      throw new Error(
        `pre-push guard: the preserve mirror accepts only ${PRESERVE_REF_PREFIX}* destinations through this hook; refused: ${offending.map((update) => update.remoteRef).join(', ')}`,
      );
    }
    // Preservation integrity (review-hardened): archival refs are append-only —
    // a deletion may not ride a preservation push (it would skip both the
    // delete-only metadata routing and any preservation check), and an existing
    // archival ref is never updated in place (create-only; remote-side non-FF
    // protection on the mirror is not assumed).
    const rideAlongDeletes = parsedUpdates.filter((update) => isZeroObjectId(update.localSha));
    if (rideAlongDeletes.length > 0) {
      throw new Error(
        `pre-push guard: the preserve mirror is append-only through this hook; ref deletions may not ride a preservation push: ${rideAlongDeletes.map((update) => update.remoteRef).join(', ')}`,
      );
    }
    const overwrites = contentUpdates.filter((update) => !isZeroObjectId(update.remoteSha));
    if (overwrites.length > 0) {
      throw new Error(
        `pre-push guard: archival refs are create-only through this hook; existing-ref update refused: ${overwrites.map((update) => update.remoteRef).join(', ')}`,
      );
    }
    console.error(
      'pre-push guard: preservation push to the preserve mirror (refs/preserve/* only); estate verified; candidate alignment and the verification composite do not apply to archival refs',
    );
    return 'preserve';
  }

  const decision = classifyPrePushInput(input);
  const commands = commandsForDecision(decision);

  if (commands.length === 0) {
    console.error(
      'pre-push guard: delete-only ref update; estate verified; running metadata verification',
    );
    for (const script of DELETE_ONLY_METADATA_SCRIPTS) {
      execFileSync(
        'bash',
        ['scripts/run-with-pinned-npm.sh', '--prefix', 'console', 'run', script],
        { cwd, timeout: 30_000, stdio: 'inherit' },
      );
    }
    return decision;
  }

  if (nonBlankLines(input).length === 0) {
    console.error(
      'pre-push guard: no ref updates received on stdin — refusing to skip verification (fail-closed); genuine branch deletions still skip',
    );
  }

  const alignmentBefore = dependencies.verifyAlignmentBefore ?? verifyAlignmentBefore;
  const alignmentAfter = dependencies.verifyAlignmentAfter ?? verifyAlignmentAfter;
  const alignmentReceipt = remote
    ? alignmentBefore({
        cwd,
        remoteName: remote.remoteName,
        remoteUrl: remote.remoteUrl,
        candidateOids: parsedUpdates
          .filter((update) => !isZeroObjectId(update.localSha))
          .map((update) => update.localSha),
      })
    : null;

  dependencies.assertConsoleDependencies(cwd);

  // The ref-name scan and the secret scan are quick next to the composite, so they run first.
  // Preservation and delete-only pushes returned above: they publish no new ref or commit.
  scanPushedRefNames(parsedUpdates, cwd);
  runGitleaksStep(input, cwd, remote?.remoteName ?? '');

  for (const script of commands) {
    console.error(`pre-push guard: running npm run ${script}`);
    // Gate STEP runner: individual npm steps (vitest suites, typecheck) legitimately
    // run for minutes — 600s bounds a hang without tripping real steps. The 30s
    // default used elsewhere in this series is for fast single git/gh invocations.
    execFileSync('npm', ['run', script], { cwd, timeout: 600_000, stdio: 'inherit' });
  }

  if (alignmentReceipt) {
    alignmentAfter(alignmentReceipt, { cwd });
  }

  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPrePushGuard(
      readFileSync(0, 'utf8'),
      process.cwd(),
      { assertConsoleDependencies },
      {
        remoteName: process.argv[2] ?? '',
        remoteUrl: process.argv[3] ?? '',
      },
    );
  } catch (err) {
    console.error((err as Error).message);
    const errorStatus = (err as Error & { status?: number; exitCode?: number }).status
      ?? (err as Error & { exitCode?: number }).exitCode;
    process.exitCode = typeof errorStatus === 'number' && Number.isInteger(errorStatus) && errorStatus > 0
      ? errorStatus
      : 1;
  }
}
