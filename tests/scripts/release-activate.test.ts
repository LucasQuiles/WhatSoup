/**
 * release:activate against a real temporary HOME (real files, symlinks, plists
 * and a real SQLite database) with launchctl, ps, plutil, the renderer scripts,
 * process liveness, the clock and the health probe replaced by a simulated
 * launchd world. All identifiers are fabricated.
 */
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fault hooks for the receipt-atomicity tests. node:fs passes through
 * unchanged unless a test sets a hook (the pattern of
 * tests/lib/process-lock-fsync-failure.test.ts). A hook runs before the real
 * call and may throw in its place.
 */
const fsFaults = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => void),
  write: null as null | ((target: unknown, data: unknown) => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: import('node:fs').PathLike, to: import('node:fs').PathLike) => {
      fsFaults.rename?.(String(from), String(to));
      return actual.renameSync(from, to);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      fsFaults.write?.(args[0], args[1]);
      return actual.writeFileSync(...args);
    },
  };
});
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  parseActivationArgs,
  RELEASE_ACTIVATE_EXIT,
  runReleaseActivateCli,
} from '../../scripts/release-activate.ts';
import { argvNamesEntrypoint } from '../../scripts/lib/release-activation/apply.ts';
import {
  type ActivationHost,
  classifyAuthenticatedHealth,
  type ExecResult,
} from '../../scripts/lib/release-activation/host.ts';
import { stageInstancePlist } from '../../scripts/lib/release-activation/plan.ts';

const packageJson = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)) as { scripts: Record<string, string> };

const tmp = trackTmpDirs('whatsoup-activate-');

const INSTANCE = 'test-line';
const INSTANCE_LABEL = `com.whatsoup.${INSTANCE}`;
const TIMER_LABEL = 'com.whatsoup.aux-timer';
const DRIFT_LABEL = 'com.whatsoup.release-drift-check';
const OLD_COMMIT = '1'.repeat(40);
const NEW_COMMIT = '2'.repeat(40);
const TOKEN = 'f'.repeat(64);
const HEALTH_PORT = 19_090;
const TARGET_URL = 'https://example.invalid/fabricated/repo.git';
const UID = 4242;
/** Schema migration level of the fixture database; the old release's ceiling. */
const FIXTURE_SCHEMA = 64;
/**
 * #2481: the `health_invariants` block a current producer emits, and the floor
 * the activating tool requires. Literal copies of src/core/health-invariants.ts,
 * so a change there is a reviewed diff here too.
 */
const INVARIANTS_SCHEMA = 'whatsoup.health-invariants.v1';
const DECLARED_INVARIANTS = [
  'turn_capability.stale_evidence_degrades',
  'turn_capability.probe_expected_stale_degrades',
  'health.diagnostic_requires_token',
];
const INVARIANT_FLOOR = ['turn_capability.stale_evidence_degrades'];
/**
 * The event source names the floor it was judged against: `release-invariants:`
 * plus the first 8 hex of sha256 over the schema and the sorted floor ids,
 * newline-separated. A literal copy of the algorithm, so a change is a reviewed diff.
 */
function invariantsSourceFor(schema: string, floor: readonly string[]): string {
  const digest = createHash('sha256').update([schema, ...[...floor].sort()].join('\n')).digest('hex');
  return `release-invariants:${digest.slice(0, 8)}`;
}
const INVARIANTS_ALERT_SOURCE = invariantsSourceFor(INVARIANTS_SCHEMA, INVARIANT_FLOOR);
/** The commit the fake host reports for the activating tool's own tree (the floor's source). */
const TOOL_COMMIT = 'a'.repeat(40);
const CURRENT_BLOCK = { schema: INVARIANTS_SCHEMA, ids: DECLARED_INVARIANTS };
/**
 * A producer that predates the block. A sentinel, not `undefined`: a default
 * parameter would silently turn an explicit `undefined` back into the current
 * block, which is exactly the legacy case these tests exist to cover.
 */
const NO_BLOCK = Symbol('no health_invariants block');

/**
 * An authenticated diagnostic body. The fake host adds the serving pid as
 * `instance.pid` (like the real producer) unless the body already names one or
 * the world sets `injectPid: false`.
 */
function diagnosticBody(
  commit: string,
  connected: boolean,
  invariants: unknown = CURRENT_BLOCK,
  instance: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    instance: { commit, ...instance },
    whatsapp: { connected },
    ...(invariants === NO_BLOCK ? {} : { health_invariants: invariants }),
  });
}

interface Fixture {
  base: string;
  home: string;
  oldRelease: string;
  newRelease: string;
  wrapperLink: string;
  launchAgents: string;
  dbPath: string;
  backupDir: string;
}

function plist(label: string, programArguments: string[], workingDirectory: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArguments.map((arg) => `    <string>${arg}</string>`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${workingDirectory}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function releaseDriftArgs(root: string, home: string): string[] {
  return [
    '/bin/bash', `${root}/deploy/scripts/run-release-drift-schedule.sh`,
    '--launchd-plist', `${home}/Library/LaunchAgents/${INSTANCE_LABEL}.plist`,
    '--instance', INSTANCE,
    '--target-url', TARGET_URL,
    '--target-ref', 'refs/heads/main',
  ];
}

function writeRelease(root: string, commit: string, withDependencies: boolean): void {
  mkdirSync(path.join(root, 'deploy', 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  if (withDependencies) mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  writeFileSync(path.join(root, 'deploy', 'whatsoup'), '#!/bin/bash\n', { mode: 0o755 });
  writeFileSync(path.join(root, 'src', 'bootstrap.ts'), '// fabricated entrypoint\n');
  writeFileSync(path.join(root, 'deploy', 'scripts', 'render-release-drift-launchd.sh'), '#!/bin/bash\n');
  writeFileSync(path.join(root, 'deploy', `${TIMER_LABEL}.plist`), plist(
    TIMER_LABEL,
    ['/bin/bash', '__WHATSOUP_REPO_ROOT__/deploy/scripts/aux-timer.sh', '__HOME__/Library/Logs/aux.log'],
    '__WHATSOUP_REPO_ROOT__',
  ));
  writeFileSync(path.join(root, '.whatsoup-release-manifest.json'), JSON.stringify({
    schemaVersion: 2,
    source: { ref: 'refs/heads/main', commit },
    release: { path: root, createdAt: '2026-01-01T00:00:00Z', mutablePathExcludes: [] },
    rollback: { path: `${root}-rollback` },
    files: [],
  }));
}

function installFixture(): Fixture {
  const base = tmp.make('world');
  const home = path.join(base, 'home');
  const oldRelease = path.join(base, 'releases', 'release-old');
  const newRelease = path.join(base, 'releases', 'release-new');
  writeRelease(oldRelease, OLD_COMMIT, true);
  writeRelease(newRelease, NEW_COMMIT, true);

  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  mkdirSync(launchAgents, { recursive: true });
  mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const wrapperLink = path.join(home, '.local', 'bin', 'whatsoup');
  symlinkSync(path.join(oldRelease, 'deploy', 'whatsoup'), wrapperLink);

  writeFileSync(path.join(launchAgents, `${INSTANCE_LABEL}.plist`), plist(INSTANCE_LABEL, [wrapperLink, INSTANCE], oldRelease));
  writeFileSync(path.join(launchAgents, `${TIMER_LABEL}.plist`), plist(
    TIMER_LABEL,
    ['/bin/bash', `${oldRelease}/deploy/scripts/aux-timer.sh`, `${home}/Library/Logs/aux.log`],
    oldRelease,
  ));
  writeFileSync(path.join(launchAgents, `${DRIFT_LABEL}.plist`), plist(DRIFT_LABEL, releaseDriftArgs(oldRelease, home), oldRelease));

  const configDir = path.join(home, '.config', 'whatsoup', 'instances', INSTANCE);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ name: INSTANCE, healthPort: HEALTH_PORT }));
  writeFileSync(path.join(configDir, 'tokens.env'), `WHATSOUP_HEALTH_TOKEN=${TOKEN}\n`, { mode: 0o600 });

  const dataDir = path.join(home, '.local', 'share', 'whatsoup', 'instances', INSTANCE);
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'bot.db');
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('before-activation');");
  db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec(`INSERT INTO schema_migrations (version) VALUES (${FIXTURE_SCHEMA - 1}), (${FIXTURE_SCHEMA})`);
  db.close();

  return { base, home, oldRelease, newRelease, wrapperLink, launchAgents, dbPath, backupDir: path.join(base, 'backups') };
}

/** What the new release's startup migration does to the live database. */
function migrateFixture(dbPath: string, version: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`INSERT OR IGNORE INTO schema_migrations (version) VALUES (${version})`);
  } finally {
    db.close();
  }
}

/** The level an old-release binary would see, or null when it cannot open the database at all. */
function fixtureSchemaLevel(dbPath: string): number | null {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return Number((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Paths, modes, content hashes and link targets of every entry under `root`. */
function snapshotTree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      const key = path.relative(root, full);
      if (stat.isSymbolicLink()) entries[key] = `link:${readlinkSync(full)}`;
      else if (stat.isDirectory()) {
        entries[key] = `dir:${(stat.mode & 0o777).toString(8)}`;
        walk(full);
      } else {
        entries[key] = `file:${(stat.mode & 0o777).toString(8)}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
      }
    }
  };
  walk(root);
  return entries;
}

interface WorldOptions {
  /** Consecutive transient bootstrap failures to inject per label. */
  transientBootstrapFailures?: Record<string, number>;
  /** Pids that ignore bootout and never exit. */
  stuckPids?: Set<number>;
  /** Override the instance argv the new process gets (default: from the wrapper symlink). */
  instanceArgv?: (releaseRoot: string) => string;
  /**
   * Override the health response for the instance. `fallback` is the default:
   * healthy for the running release, except that an old-release process
   * against a database above FIXTURE_SCHEMA (or one it cannot open) refuses
   * to start, as a DatabaseCompatibilityError `future_schema` does.
   */
  health?: (
    runningRoot: string | null,
    fallback: () => { status: number; body: string },
  ) => { status: number; body: string };
  /** Runs when an instance process starts on `root` (a new release migrating at startup). */
  onInstanceStart?: (root: string) => void;
  /** Runs when an instance process on `root` exits (a migration committed during shutdown). */
  onInstanceExit?: (root: string, via: 'bootout' | 'kickstart') => void;
  platform?: NodeJS.Platform;
  /** Exit status the alert helper reports (default 0), or 'throw' for a spawn that fails outright. */
  alertStatus?: number | 'throw';
  /** Runs inside the alert call, before it returns (to observe what is already durable). */
  onAlert?: () => void;
  /** Add the serving pid as `instance.pid` to diagnostic bodies that lack one (default true). */
  injectPid?: boolean;
  /** `plutil -lint` rejects every staged plist: a refusal inside the apply, after the backup dir exists. */
  plutilFails?: boolean;
  /** A bounded exec (one given `timeoutMs`) matching this never settles, as a hung child would. */
  hangBounded?: (file: string, args: readonly string[]) => boolean;
}

interface RecordedAlert {
  instance: string;
  source: string;
  eventType: 'alert' | 'clear';
  env?: Record<string, string>;
  payload: { summary: string; evidence: string; diagnostics: string[]; severity: string };
}

/** The real producer reports its own `process.pid` as `instance.pid`; the fake does the same for the serving pid. */
function withServingPid(body: string, pid: number): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return body;
  const instance = (payload as Record<string, unknown>).instance;
  if (typeof instance !== 'object' || instance === null || Array.isArray(instance) || 'pid' in instance) return body;
  return JSON.stringify({ ...payload, instance: { ...instance, pid } });
}

class SimulatedLaunchd {
  readonly calls: string[][] = [];
  readonly tokensSeen: string[] = [];
  /** Every alert sent through the host seam, in order. */
  readonly alerts: RecordedAlert[] = [];
  /** Every health body served, with the release root it came from. */
  readonly served: Array<{ root: string | null; body: string }> = [];
  /** Release root of every instance process started, in order. */
  readonly instanceStarts: string[] = [];
  private readonly loaded = new Map<string, { pid: number; definition: string; root: string | null }>();
  private readonly alive = new Set<number>();
  private readonly argv = new Map<number, string>();
  /** `ps -o lstart=` per pid: a new value on every start, even when a pid is reused. */
  private readonly startTimes = new Map<number, string>();
  private startSeq = 0;
  /** Every exec the tool bounded with its own timeout (`options.timeoutMs`), in order. */
  readonly boundedCalls: string[][] = [];
  private nextPid = 7000;
  private clock = 1_767_225_600_000;
  readonly transient: Record<string, number>;
  readonly initialInstancePid: number;

  constructor(private readonly fixture: Fixture, private readonly options: WorldOptions = {}) {
    this.transient = { ...(options.transientBootstrapFailures ?? {}) };
    const instancePlist = path.join(fixture.launchAgents, `${INSTANCE_LABEL}.plist`);
    this.initialInstancePid = this.start(INSTANCE_LABEL, readFileSync(instancePlist, 'utf8'));
    for (const label of [TIMER_LABEL, DRIFT_LABEL]) {
      this.start(label, readFileSync(path.join(fixture.launchAgents, `${label}.plist`), 'utf8'));
    }
  }

  private runningRoot(): string {
    return path.dirname(path.dirname(readlinkSync(this.fixture.wrapperLink)));
  }

  private start(label: string, definition: string, reusePid?: number): number {
    const pid = reusePid ?? this.nextPid++;
    this.alive.add(pid);
    this.startTimes.set(pid, `Mon Sep 28 12:00:${String(this.startSeq++).padStart(2, '0')} 2026`);
    const root = label === INSTANCE_LABEL ? this.runningRoot() : null;
    if (root !== null) {
      this.argv.set(pid, this.options.instanceArgv?.(root)
        ?? `/opt/node/bin/node --experimental-strip-types ${root}/src/bootstrap.ts ${INSTANCE}`);
      this.instanceStarts.push(root);
      this.options.onInstanceStart?.(root);
    }
    this.loaded.set(label, { pid, definition, root });
    return pid;
  }

  private exit(pid: number, root: string | null, via: 'bootout' | 'kickstart'): void {
    if (this.options.stuckPids?.has(pid) || !this.alive.has(pid)) return;
    this.alive.delete(pid);
    if (root !== null) this.options.onInstanceExit?.(root, via);
  }

  /** Restart the instance under launchd (a new pid on the same definition), as a crash-and-respawn would. */
  restartInstance(): void {
    const job = this.loaded.get(INSTANCE_LABEL);
    if (!job) return;
    this.exit(job.pid, job.root, 'kickstart');
    this.start(INSTANCE_LABEL, job.definition);
  }

  /** Restart the instance on the SAME pid (pid reuse): only the process start time tells the generations apart. */
  reuseInstancePid(): void {
    const job = this.loaded.get(INSTANCE_LABEL);
    if (!job) return;
    this.exit(job.pid, job.root, 'kickstart');
    this.start(INSTANCE_LABEL, job.definition, job.pid);
  }

  /** Release roots the instance ran on, collapsing the restart `kickstart -k` adds after each bootstrap. */
  releasesStarted(): string[] {
    return this.instanceStarts.filter((root, index) => index === 0 || this.instanceStarts[index - 1] !== root);
  }

  private defaultHealth(root: string | null): { status: number; body: string } {
    if (root === null) throw new Error('connection refused');
    if (root === this.fixture.oldRelease) {
      const level = fixtureSchemaLevel(this.fixture.dbPath);
      if (level === null || level > FIXTURE_SCHEMA) throw new Error('connection refused');
    }
    const commit = root === this.fixture.newRelease ? NEW_COMMIT : OLD_COMMIT;
    // Both releases are current producers, so a test about the switch itself
    // sees a satisfied invariant verdict (and, under --apply, one clear).
    return { status: 200, body: diagnosticBody(commit, true) };
  }

  private labelOf(target: string): string {
    return target.slice(`gui/${UID}/`.length);
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  loadedDefinition(label: string): string | null {
    return this.loaded.get(label)?.definition ?? null;
  }

  host(): ActivationHost {
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    return {
      platform: this.options.platform ?? 'darwin',
      uid: UID,
      isProcessAlive: (pid) => this.alive.has(pid),
      sleep: async (ms) => { this.clock += ms; },
      now: () => this.clock,
      fetchHealth: async (port, token) => {
        expect(port).toBe(HEALTH_PORT);
        this.tokensSeen.push(token);
        const job = this.loaded.get(INSTANCE_LABEL);
        const serving = job && this.alive.has(job.pid) ? job : null;
        const root = serving?.root ?? null;
        const response = this.options.health
          ? this.options.health(root, () => this.defaultHealth(root))
          : this.defaultHealth(root);
        const body = this.options.injectPid === false || serving === null
          ? response.body
          : withServingPid(response.body, serving.pid);
        this.served.push({ root, body });
        return { status: response.status, body };
      },
      emitReleaseAlert: async (request) => {
        this.alerts.push(request as RecordedAlert);
        this.options.onAlert?.();
        if (this.options.alertStatus === 'throw') throw new Error('spawn python3 ENOENT');
        return { status: this.options.alertStatus ?? 0 };
      },
      toolCommit: async () => TOOL_COMMIT,
      exec: async (file, args, options) => {
        this.calls.push([file, ...args]);
        const bounded = (options as { timeoutMs?: number } | undefined)?.timeoutMs !== undefined;
        if (bounded) {
          this.boundedCalls.push([file, ...args]);
          // A child that never exits: only the tool's own bound can end this call.
          if (this.options.hangBounded?.(file, args)) return new Promise<ExecResult>(() => {});
        }
        if (file === 'launchctl') {
          const [verb, ...rest] = args;
          if (verb === 'print') {
            const job = this.loaded.get(this.labelOf(rest[0]!));
            if (!job) return { code: 113, stdout: '', stderr: 'Could not find service' };
            const pidLine = this.alive.has(job.pid) ? `\tpid = ${job.pid}\n` : '';
            return ok(`${this.labelOf(rest[0]!)} = {\n${pidLine}\tdefinition = ${job.definition}\n}\n`);
          }
          if (verb === 'bootout') {
            const label = this.labelOf(rest[0]!);
            const job = this.loaded.get(label);
            if (job) this.exit(job.pid, job.root, 'bootout');
            this.loaded.delete(label);
            return ok();
          }
          if (verb === 'bootstrap') {
            const plistPath = rest[1]!;
            const label = path.basename(plistPath, '.plist');
            if ((this.transient[label] ?? 0) > 0) {
              this.transient[label]! -= 1;
              return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
            }
            this.start(label, readFileSync(plistPath, 'utf8'));
            return ok();
          }
          if (verb === 'kickstart') {
            const label = this.labelOf(rest[1]!);
            const job = this.loaded.get(label);
            if (!job) return { code: 113, stdout: '', stderr: 'Could not find service' };
            this.exit(job.pid, job.root, 'kickstart');
            this.start(label, job.definition);
            return ok();
          }
        }
        if (file === 'ps') {
          const pid = Number(args[1]);
          if (args.includes('lstart=')) {
            return this.alive.has(pid) ? ok(`${this.startTimes.get(pid)}\n`) : { code: 1, stdout: '', stderr: '' };
          }
          return this.alive.has(pid) && this.argv.has(pid) ? ok(`${this.argv.get(pid)}\n`) : { code: 1, stdout: '', stderr: '' };
        }
        if (file === 'plutil') {
          return this.options.plutilFails
            ? { code: 1, stdout: '', stderr: `${args[1]}: invalid property list\n` }
            : ok(`${args[1]}: OK\n`);
        }
        if (file === 'bash' && args[0]!.endsWith('run-with-pinned-node.sh')) return ok(options?.input ?? '');
        if (file === 'bash' && args[0]!.endsWith('render-release-drift-launchd.sh')) {
          const value = (flag: string): string => args[args.indexOf(flag) + 1]!;
          const root = value('--repo-root');
          return ok(plist(DRIFT_LABEL, [
            '/bin/bash', `${root}/deploy/scripts/run-release-drift-schedule.sh`,
            '--launchd-plist', `${value('--home')}/Library/LaunchAgents/com.whatsoup.${value('--instance')}.plist`,
            '--instance', value('--instance'),
            '--target-url', value('--target-url'),
            '--target-ref', value('--target-ref'),
          ], root));
        }
        return { code: 127, stdout: '', stderr: `unexpected command ${file}` };
      },
    };
  }

  mutatingCalls(): string[][] {
    return this.calls.filter(([file, verb]) => file === 'launchctl' && ['bootout', 'bootstrap', 'kickstart'].includes(verb!));
  }
}

function activationArgs(fixture: Fixture, extra: string[] = []): string[] {
  return [
    '--instance', INSTANCE,
    '--release', fixture.newRelease,
    '--expect-current', fixture.oldRelease,
    '--aux-label', `${TIMER_LABEL}=setup-timer`,
    '--aux-label', `${DRIFT_LABEL}=release-drift`,
    '--backup-dir', fixture.backupDir,
    '--verify-timeout', '30',
    '--exit-timeout', '10',
    ...extra,
  ];
}

async function run(
  world: SimulatedLaunchd,
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string; json: Record<string, unknown> }> {
  let stdout = '';
  let stderr = '';
  const code = await runReleaseActivateCli(argv, world.host(), {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr, json: stdout ? JSON.parse(stdout) as Record<string, unknown> : {} };
}

function onlyBackup(fixture: Fixture): string {
  const entries = readdirSync(fixture.backupDir);
  expect(entries).toHaveLength(1);
  return path.join(fixture.backupDir, entries[0]!);
}

let fixture: Fixture;

beforeEach(() => {
  fixture = installFixture();
  vi.stubEnv('HOME', fixture.home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(fixture.home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(fixture.home, '.local', 'share'));
  vi.stubEnv('XDG_STATE_HOME', path.join(fixture.home, '.local', 'state'));
  vi.stubEnv('WHATSOUP_HEALTH_TOKEN', undefined);
  vi.stubEnv(`BOT_ERRORS_HEALTH_TOKEN_${INSTANCE.replace(/-/g, '_').toUpperCase()}`, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fsFaults.rename = null;
  fsFaults.write = null;
});

describe('release:activate arguments', () => {
  it('registers the npm script on the pinned-node runner', () => {
    expect(packageJson.scripts['release:activate'])
      .toBe('bash scripts/run-with-pinned-node.sh scripts/release-activate.ts');
  });

  it('defaults to plan mode and accepts repeated --aux-label', () => {
    const args = parseActivationArgs(activationArgs(fixture));
    expect(args.mode).toBe('plan');
    expect(args.auxLabels).toEqual([
      { label: TIMER_LABEL, renderer: 'setup-timer' },
      { label: DRIFT_LABEL, renderer: 'release-drift' },
    ]);
  });

  it('rejects an unknown renderer, a relative release, both modes, and the instance as an aux label', () => {
    expect(() => parseActivationArgs([...activationArgs(fixture), '--aux-label', 'com.whatsoup.x=other']))
      .toThrow(/renderer must be one of/);
    expect(() => parseActivationArgs(['--instance', INSTANCE, '--release', 'rel', '--expect-current', '/abs']))
      .toThrow(/absolute/);
    expect(() => parseActivationArgs([...activationArgs(fixture), '--plan', '--apply'])).toThrow(/mutually exclusive/);
    expect(() => parseActivationArgs([...activationArgs(fixture), '--aux-label', `${INSTANCE_LABEL}=setup-timer`]))
      .toThrow(/must not name the instance label/);
  });
});

describe('release:activate --plan', () => {
  it('is read-only: no filesystem change and no mutating launchctl verb', async () => {
    const world = new SimulatedLaunchd(fixture);
    const before = snapshotTree(fixture.base);

    const result = await run(world, activationArgs(fixture));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(snapshotTree(fixture.base)).toEqual(before);
    expect(world.mutatingCalls()).toEqual([]);
    expect(result.json).toMatchObject({
      mode: 'plan',
      ready: true,
      release: { path: fixture.newRelease, commit: NEW_COMMIT },
      expectCurrent: { path: fixture.oldRelease, commit: OLD_COMMIT },
      health: { port: HEALTH_PORT, tokenResolved: true },
    });
    const plists = result.json.plists as Array<Record<string, unknown>>;
    expect(plists.map((entry) => [entry.label, entry.staged, entry.renderDriftLines])).toEqual([
      [INSTANCE_LABEL, true, 0],
      [TIMER_LABEL, true, 0],
      [DRIFT_LABEL, true, 0],
    ]);
    expect(plists[0]!.edits).toEqual([`WorkingDirectory: ${fixture.oldRelease} -> ${fixture.newRelease}`]);
    const steps = (result.json.actions as Array<{ step: string }>).map((action) => action.step);
    expect(steps).toEqual([
      'create-backup-dir', 'backup-database', 'record-schema-level', 'record-symlink', 'backup-plists', 'write-staged-plists',
      'switch-symlink', 'install-plists', 'reload', 'reload', 'reload', 'verify', 'rollback-on-failure',
    ]);
    expect(result.stdout).not.toContain(TOKEN);
  });

  it('carries the installed release-drift job values into the renderer instead of resetting them', async () => {
    const world = new SimulatedLaunchd(fixture);
    await run(world, activationArgs(fixture));
    const render = world.calls.find((call) => call[1]?.endsWith('render-release-drift-launchd.sh'));
    expect(render).toEqual(expect.arrayContaining(['--target-url', TARGET_URL, '--instance', INSTANCE, '--repo-root', fixture.newRelease]));
  });

  it('refuses when the wrapper symlink is not on the expected release, and --apply then changes nothing', async () => {
    const world = new SimulatedLaunchd(fixture);
    const other = path.join(fixture.base, 'releases', 'release-other');
    writeRelease(other, '3'.repeat(40), true);
    const expectOther = (argv: string[]): string[] => argv.map((arg) => (arg === fixture.oldRelease ? other : arg));
    const planned = await run(world, expectOther(activationArgs(fixture)));
    expect(planned.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    const failed = (planned.json.preconditions as Array<{ id: string; ok: boolean }>).filter((entry) => !entry.ok).map((entry) => entry.id);
    expect(failed).toContain('wrapper-link-on-expected-release');

    const before = snapshotTree(fixture.base);
    const applied = await run(world, expectOther(activationArgs(fixture, ['--apply'])));
    expect(applied.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    expect(applied.json.outcome).toBe('refused');
    expect(snapshotTree(fixture.base)).toEqual(before);
    expect(world.mutatingCalls()).toEqual([]);
  });

  it('refuses a new release whose manifest names a different release path', async () => {
    const world = new SimulatedLaunchd(fixture);
    const manifestPath = path.join(fixture.newRelease, '.whatsoup-release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { release: { path: string } };
    manifest.release.path = path.join(fixture.base, 'elsewhere');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = await run(world, activationArgs(fixture));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    const failed = (result.json.preconditions as Array<{ id: string; ok: boolean }>).filter((entry) => !entry.ok).map((entry) => entry.id);
    expect(failed).toEqual(['release-manifest-path']);
  });

  it('refuses clearly on a platform other than macOS launchd', async () => {
    const world = new SimulatedLaunchd(fixture, { platform: 'linux' });
    const result = await run(world, activationArgs(fixture));
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    expect(result.stderr).toMatch(/macOS launchd only/);
    expect(result.json).toEqual({ mode: 'plan', ready: false, refused: 'platform-not-macos-launchd' });
    expect(world.calls).toEqual([]);
  });
});

describe('release:activate --apply', () => {
  it('switches, retries the transient bootstrap error, verifies from the process, and keeps a private backup', async () => {
    const world = new SimulatedLaunchd(fixture, { transientBootstrapFailures: { [INSTANCE_LABEL]: 2 } });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
    const instanceBootstraps = world.calls.filter(([file, verb, , plistPath]) =>
      file === 'launchctl' && verb === 'bootstrap' && plistPath?.endsWith(`${INSTANCE_LABEL}.plist`));
    expect(instanceBootstraps).toHaveLength(3);
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.newRelease, 'deploy', 'whatsoup'));
    expect(result.json.verification).toMatchObject({
      argvMatches: true,
      health: { projection: 'diagnostic', commit: NEW_COMMIT, connected: true },
    });
    expect((result.json.verification as { pid: number }).pid).not.toBe(world.initialInstancePid);
    for (const label of [TIMER_LABEL, DRIFT_LABEL]) {
      const loaded = world.loadedDefinition(label)!;
      expect(loaded).toContain(`${fixture.newRelease}/`);
      expect(loaded).not.toContain(`${fixture.oldRelease}/`);
    }

    const backup = onlyBackup(fixture);
    expect(path.basename(backup)).toMatch(new RegExp(`^activation-${NEW_COMMIT.slice(0, 12)}-\\d{8}T\\d{6}Z$`));
    expect(lstatSync(backup).mode & 0o777).toBe(0o700);
    expect(readFileSync(path.join(backup, 'symlink.before'), 'utf8')).toBe(path.join(fixture.oldRelease, 'deploy', 'whatsoup'));
    const copy = new DatabaseSync(path.join(backup, 'bot.db'), { readOnly: true });
    try {
      expect(copy.prepare('SELECT value FROM fixture').all()).toEqual([{ value: 'before-activation' }]);
    } finally {
      copy.close();
    }
    for (const name of ['bot.db', 'receipt.json', `${INSTANCE_LABEL}.plist`, `${TIMER_LABEL}.staged.plist`]) {
      expect(lstatSync(path.join(backup, name)).mode & 0o777).toBe(0o600);
    }
    // The token authenticated every probe and appears nowhere in the output.
    expect(new Set(world.tokensSeen)).toEqual(new Set([TOKEN]));
    for (const text of [result.stdout, result.stderr, readFileSync(path.join(backup, 'receipt.json'), 'utf8')]) {
      expect(text).not.toContain(TOKEN);
    }
  });

  it('refuses to bootstrap while the old pid is still running, then rolls back and verifies the rollback', async () => {
    const originals = Object.fromEntries([INSTANCE_LABEL, TIMER_LABEL, DRIFT_LABEL].map((label) => [
      label, readFileSync(path.join(fixture.launchAgents, `${label}.plist`), 'utf8'),
    ]));
    const stuck = new Set<number>();
    const world = new SimulatedLaunchd(fixture, { stuckPids: stuck });
    stuck.add(world.initialInstancePid);

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
    expect(result.json.outcome).toBe('rolled-back');
    expect(result.json.failure).toMatch(/still running .* refusing to bootstrap/);
    // The only instance bootstrap is the rollback's, against the restored plist.
    const instanceBootstraps = world.calls.filter(([file, verb, , plistPath]) =>
      file === 'launchctl' && verb === 'bootstrap' && plistPath?.endsWith(`${INSTANCE_LABEL}.plist`));
    expect(instanceBootstraps).toHaveLength(1);
    expect(world.loadedDefinition(INSTANCE_LABEL)).toBe(originals[INSTANCE_LABEL]);
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.oldRelease, 'deploy', 'whatsoup'));
    for (const [label, text] of Object.entries(originals)) {
      expect(readFileSync(path.join(fixture.launchAgents, `${label}.plist`), 'utf8')).toBe(text);
    }
    expect(result.json.rollback).toMatchObject({ verified: true });
  });

  it('rolls back when the new process never reports a connected session, and verifies the rollback from the process', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: (root) => ({
        status: 200,
        body: JSON.stringify({
          instance: { commit: root === fixture.newRelease ? NEW_COMMIT : OLD_COMMIT },
          whatsapp: { connected: root !== fixture.newRelease },
        }),
      }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
    expect(result.json.verification).toMatchObject({ argvMatches: true, health: { connected: false } });
    const rollback = result.json.rollback as { verified: boolean; observation: Record<string, unknown>; steps: Array<{ step: string; ok: boolean }> };
    expect(rollback.verified).toBe(true);
    expect(rollback.observation).toMatchObject({ argvMatches: true, health: { commit: OLD_COMMIT, connected: true } });
    expect(rollback.steps.every((step) => step.ok)).toBe(true);
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.oldRelease, 'deploy', 'whatsoup'));
    for (const label of [TIMER_LABEL, DRIFT_LABEL]) {
      expect(world.loadedDefinition(label)).toContain(`${fixture.oldRelease}/`);
    }
  });

  it('catches the WorkingDirectory false pass: healthy process and new commit, but argv still on the old release', async () => {
    const world = new SimulatedLaunchd(fixture, {
      // The process keeps executing the OLD release however the plist changes.
      instanceArgv: () => `/opt/node/bin/node --experimental-strip-types ${fixture.oldRelease}/src/bootstrap.ts ${INSTANCE}`,
      // Health follows the configuration, not the process, so it reports the
      // new commit while the switch is in place: argv alone must fail this.
      health: () => {
        const onNew = readlinkSync(fixture.wrapperLink).startsWith(`${fixture.newRelease}/`);
        return {
          status: 200,
          body: JSON.stringify({ instance: { commit: onNew ? NEW_COMMIT : OLD_COMMIT }, whatsapp: { connected: true } }),
        };
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
    expect(result.json.outcome).toBe('rolled-back');
    expect(result.json.verification).toMatchObject({
      argvMatches: false,
      health: { projection: 'diagnostic', commit: NEW_COMMIT, connected: true },
    });
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.oldRelease, 'deploy', 'whatsoup'));
  });

  it('treats a rejected token (public envelope) as unverified', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: () => ({ status: 200, body: JSON.stringify({ schema_version: 'health.public.v1', status: 'ok' }) }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rollbackUnverified);
    expect(result.json.verification).toMatchObject({ health: { projection: 'unobserved' } });
    expect(result.json.rollback).toMatchObject({ verified: false });
  });
});

describe('release:activate --apply: rollback against a migrated database', () => {
  const notConnectedOnNew = (root: string | null, fallback: () => { status: number; body: string }) => (
    root === fixture.newRelease
      ? { status: 200, body: JSON.stringify({ instance: { commit: NEW_COMMIT }, whatsapp: { connected: false } }) }
      : fallback()
  );

  function instancePlistsAreStaged(): void {
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.newRelease, 'deploy', 'whatsoup'));
    expect(readFileSync(path.join(fixture.launchAgents, `${INSTANCE_LABEL}.plist`), 'utf8'))
      .toContain(`<string>${fixture.newRelease}</string>`);
    for (const label of [TIMER_LABEL, DRIFT_LABEL]) {
      const installed = readFileSync(path.join(fixture.launchAgents, `${label}.plist`), 'utf8');
      expect(installed).toContain(`${fixture.newRelease}/`);
      expect(installed).not.toContain(`${fixture.oldRelease}/`);
    }
  }

  function expectOperatorMessage(stderr: string, backup: string, levels: { before: string; after: string }): void {
    expect(stderr).toContain(`before activation: ${levels.before}`);
    expect(stderr).toContain(`after failure: ${levels.after}`);
    expect(stderr).toContain(path.join(backup, 'bot.db'));
    expect(stderr).toContain(`launchctl bootout gui/${UID}/${INSTANCE_LABEL}`);
    expect(stderr).toContain(`cp ${path.join(backup, 'bot.db')} ${fixture.dbPath}`);
    expect(stderr).toContain(`ln -sfn ${path.join(fixture.oldRelease, 'deploy', 'whatsoup')} ${fixture.wrapperLink}`);
    expect(stderr).toContain(`cp ${path.join(backup, `${TIMER_LABEL}.plist`)} ${path.join(fixture.launchAgents, `${TIMER_LABEL}.plist`)}`);
    expect(stderr).toContain(`launchctl bootstrap gui/${UID} ${path.join(fixture.launchAgents, `${INSTANCE_LABEL}.plist`)}`);
    expect(stderr).toMatch(/messages received after the backup .* lost/i);
  }

  it('(a) runs the verified rollback when the schema level is unchanged, and records both levels', async () => {
    const world = new SimulatedLaunchd(fixture, { health: notConnectedOnNew });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
    expect(result.json.outcome).toBe('rolled-back');
    expect(result.json.schemaMigration).toEqual({
      before: FIXTURE_SCHEMA, after: FIXTURE_SCHEMA, afterError: null, blockedAt: null,
    });
    expect(result.json.rollback).toMatchObject({ verified: true });
    expect(world.releasesStarted()).toEqual([fixture.oldRelease, fixture.newRelease, fixture.oldRelease]);
    expect(readlinkSync(fixture.wrapperLink)).toBe(path.join(fixture.oldRelease, 'deploy', 'whatsoup'));
  });

  it('(b) stops without restoring when the new release advanced the schema, and exits with the distinct code', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: notConnectedOnNew,
      onInstanceStart: (root) => { if (root === fixture.newRelease) migrateFixture(fixture.dbPath, FIXTURE_SCHEMA + 1); },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rollbackBlockedMigrated);
    expect(result.json.outcome).toBe('rollback-blocked-migrated');
    expect(result.json.schemaMigration).toEqual({
      before: FIXTURE_SCHEMA, after: FIXTURE_SCHEMA + 1, afterError: null, blockedAt: 'before-rollback',
    });
    expect(result.json.rollback).toBeNull();
    // The old binary never started again, and nothing was restored.
    expect(world.releasesStarted()).toEqual([fixture.oldRelease, fixture.newRelease]);
    instancePlistsAreStaged();
    const backup = onlyBackup(fixture);
    expect(result.json.backupPath).toBe(backup);
    expectOperatorMessage(result.stderr, backup, { before: String(FIXTURE_SCHEMA), after: String(FIXTURE_SCHEMA + 1) });
    expect(result.stderr).toContain('left in place');
    expect(JSON.parse(readFileSync(path.join(backup, 'receipt.json'), 'utf8'))).toMatchObject({
      outcome: 'rollback-blocked-migrated',
    });
  });

  it('(c) fails closed when the schema level cannot be read after the failure', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: notConnectedOnNew,
      onInstanceStart: (root) => { if (root === fixture.newRelease) writeFileSync(fixture.dbPath, 'not a sqlite database'); },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rollbackBlockedMigrated);
    expect(result.json.outcome).toBe('rollback-blocked-migrated');
    const schema = result.json.schemaMigration as Record<string, unknown>;
    expect(schema).toMatchObject({ before: FIXTURE_SCHEMA, after: null, blockedAt: 'before-rollback' });
    expect(schema.afterError).toEqual(expect.any(String));
    expect(world.releasesStarted()).toEqual([fixture.oldRelease, fixture.newRelease]);
    instancePlistsAreStaged();
    expectOperatorMessage(result.stderr, onlyBackup(fixture), { before: String(FIXTURE_SCHEMA), after: 'unreadable' });
  });

  it('(d) records the pre-activation schema level in receipt.json on success', async () => {
    const world = new SimulatedLaunchd(fixture);

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    const receipt = JSON.parse(readFileSync(path.join(onlyBackup(fixture), 'receipt.json'), 'utf8')) as Record<string, unknown>;
    expect(receipt.schemaMigration).toEqual({ before: FIXTURE_SCHEMA, after: null, afterError: null, blockedAt: null });
  });

  it('(e) re-checks after the new instance has exited, catching a migration that committed during shutdown', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: notConnectedOnNew,
      onInstanceExit: (root, via) => {
        if (root === fixture.newRelease && via === 'bootout') migrateFixture(fixture.dbPath, FIXTURE_SCHEMA + 1);
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rollbackBlockedMigrated);
    expect(result.json.schemaMigration).toEqual({
      before: FIXTURE_SCHEMA, after: FIXTURE_SCHEMA + 1, afterError: null, blockedAt: 'after-instance-stop',
    });
    expect(world.releasesStarted()).toEqual([fixture.oldRelease, fixture.newRelease]);
    expect(world.loadedDefinition(INSTANCE_LABEL)).toBeNull();
    instancePlistsAreStaged();
    expectOperatorMessage(result.stderr, onlyBackup(fixture), { before: String(FIXTURE_SCHEMA), after: String(FIXTURE_SCHEMA + 1) });
    expect(result.stderr).toContain('is stopped');
  });
});

describe('release:activate: health invariants are report-only (#2481)', () => {
  /** The new release's producer; the old release keeps the default current body unless a test says otherwise. */
  const newReleaseEmits = (invariants: unknown, instance: Record<string, unknown> = {}, status = 200) => (
    root: string | null,
    fallback: () => { status: number; body: string },
  ) => (
    root === fixture.newRelease ? { status, body: diagnosticBody(NEW_COMMIT, true, invariants, instance) } : fallback()
  );

  function receiptText(): string {
    return readFileSync(path.join(onlyBackup(fixture), 'receipt.json'), 'utf8');
  }

  function receiptOf(): Record<string, unknown> {
    return JSON.parse(receiptText()) as Record<string, unknown>;
  }

  /** Bodies the new release actually served, parsed. */
  function servedByNew(world: SimulatedLaunchd): Array<Record<string, unknown>> {
    return world.served
      .filter((entry) => entry.root === fixture.newRelease)
      .map((entry) => JSON.parse(entry.body) as Record<string, unknown>);
  }

  /**
   * Swap the backup directory for a regular file (and back), so the durable
   * receipt writer cannot create its temporary file there.
   */
  function blockBackupDir(): { restore: () => void } {
    const dir = onlyBackup(fixture);
    const aside = `${dir}.aside`;
    renameSync(dir, aside);
    writeFileSync(dir, 'not a directory\n');
    return {
      restore: () => {
        unlinkSync(dir);
        renameSync(aside, dir);
      },
    };
  }

  it('a producer without the block still activates with exit 0 and sends exactly one warning, under --apply', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(NO_BLOCK) });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(world.alerts).toHaveLength(1);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
    expect(world.alerts[0]).toMatchObject({
      instance: INSTANCE,
      source: INVARIANTS_ALERT_SOURCE,
      eventType: 'alert',
      payload: { severity: 'warning' },
    });
    // Guard on the fixture itself: the new release really served bodies without the block.
    const served = servedByNew(world);
    expect(served.length).toBeGreaterThan(0);
    for (const body of served) expect(body).not.toHaveProperty('health_invariants');
  });

  it('records the missing verdict, the tool floor and its source commit, and the alert attempt in receipt.json', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(NO_BLOCK) });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    const expected = {
      reportOnly: true,
      floor: { schema: INVARIANTS_SCHEMA, ids: INVARIANT_FLOOR, toolCommit: TOOL_COMMIT },
      activation: { outcome: 'missing', detail: null, schema: null, undeclared: INVARIANT_FLOOR },
      rollback: null,
      alert: { attempted: true, kind: 'warning', status: 0 },
    };
    expect(receiptOf().invariants).toEqual(expected);
    expect(result.json.invariants).toEqual(expected);
  });

  it('writes receipt.json with the verdict before the alert is sent, marking the alert pending', async () => {
    let atAlert: unknown = 'alert never sent';
    const world = new SimulatedLaunchd(fixture, {
      health: newReleaseEmits(NO_BLOCK),
      onAlert: () => { atAlert = receiptOf().invariants; },
    });

    await run(world, activationArgs(fixture, ['--apply']));

    expect(atAlert).toMatchObject({
      activation: { outcome: 'missing' },
      alert: { attempted: true, kind: 'warning', status: 'pending' },
    });
    expect(receiptOf().invariants).toMatchObject({ alert: { attempted: true, kind: 'warning', status: 0 } });
  });

  /** Temporary files the atomic writer leaves in the backup directory (none after a failure, too). */
  function receiptTemporaries(): string[] {
    return readdirSync(onlyBackup(fixture)).filter((name) => name.startsWith('.receipt.json.'));
  }

  it('a final rewrite that fails at rename leaves the previous receipt byte-identical and no temporary file', async () => {
    let before: string | null = null;
    const world = new SimulatedLaunchd(fixture, {
      health: newReleaseEmits(NO_BLOCK),
      onAlert: () => {
        before = receiptText();
        // The temporary file is fully written and synced by now; only the rename fails.
        fsFaults.rename = (_from, to) => {
          if (path.basename(to) === 'receipt.json') throw Object.assign(new Error('EIO: injected rename failure'), { code: 'EIO' });
        };
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));
    fsFaults.rename = null;

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'missing' },
      alert: { attempted: true, kind: 'warning', status: 'pending' },
    });
    expect(receiptText()).toBe(before);
    expect(receiptTemporaries()).toEqual([]);
    expect(result.stderr).toContain('release:activate: receipt-write-failed EIO\n');
    expect(result.stderr).not.toContain(fixture.base);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });

  it('a final rewrite that fails after a partial write leaves the previous receipt byte-identical and no partial receipt', async () => {
    let before: string | null = null;
    const world = new SimulatedLaunchd(fixture, {
      health: newReleaseEmits(NO_BLOCK),
      onAlert: () => {
        before = receiptText();
        // The next write is the final receipt: half of it lands, then the disk is full.
        fsFaults.write = (target, data) => {
          fsFaults.write = null;
          const text = String(data);
          const half = text.slice(0, Math.floor(text.length / 2));
          if (typeof target === 'number') writeSync(target, half);
          else writeFileSync(target as string, half);
          throw Object.assign(new Error('ENOSPC: injected short write'), { code: 'ENOSPC' });
        };
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));
    fsFaults.write = null;

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'missing' },
      alert: { attempted: true, kind: 'warning', status: 'pending' },
    });
    expect(receiptText()).toBe(before);
    expect(receiptTemporaries()).toEqual([]);
    expect(result.stderr).toContain('release:activate: receipt-write-failed ENOSPC\n');
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });

  it('a failed first receipt write still attempts the alert, prints only a fixed code with the errno name, and keeps the exit code', async () => {
    let blocked: { restore: () => void } | null = null;
    const world = new SimulatedLaunchd(fixture, {
      health: (root, fallback) => {
        // Verification runs after every backup write, so the receipt is the next write into the directory.
        if (root === fixture.newRelease && blocked === null) blocked = blockBackupDir();
        return newReleaseEmits(NO_BLOCK)(root, fallback);
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));
    (blocked as { restore: () => void } | null)?.restore();

    expect(world.alerts).toHaveLength(1);
    expect(result.stderr).toMatch(/^release:activate: receipt-write-failed E[A-Z0-9]+$/m);
    expect(result.stderr).not.toContain(fixture.base);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
  });

  it('after a failed first receipt write and a failed helper, stderr never claims the verdict is in receipt.json', async () => {
    let blocked: { restore: () => void } | null = null;
    const world = new SimulatedLaunchd(fixture, {
      alertStatus: 1,
      health: (root, fallback) => {
        if (root === fixture.newRelease && blocked === null) blocked = blockBackupDir();
        return newReleaseEmits(NO_BLOCK)(root, fallback);
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));
    (blocked as { restore: () => void } | null)?.restore();

    expect(world.alerts).toHaveLength(1);
    expect(result.stderr).toContain('the verdict was not recorded');
    expect(result.stderr).not.toContain('receipt.json');
    expect(result.stderr).toMatch(/^release:activate: receipt-write-failed E[A-Z0-9]+$/m);
    expect(result.stderr).not.toContain(fixture.base);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });

  it('the alert asks the helper for the standard BOT ERRORS event with the inline log tail off, and nothing else', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(NO_BLOCK) });

    await run(world, activationArgs(fixture, ['--apply']));

    expect(world.alerts).toHaveLength(1);
    expect(world.alerts[0]!.env).toEqual({ BOT_ERRORS_INLINE_LOG_TAIL: '0' });
  });

  it('the tool-supplied alert payload is content-free: verdicts and ids only, no paths, commits, or token', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(NO_BLOCK) });

    await run(world, activationArgs(fixture, ['--apply']));

    expect(world.alerts).toHaveLength(1);
    const text = JSON.stringify(world.alerts[0]!.payload);
    expect(text).toContain('missing');
    expect(text).toContain(INVARIANT_FLOOR[0]);
    for (const forbidden of [fixture.base, fixture.home, NEW_COMMIT, OLD_COMMIT, TOOL_COMMIT, TOKEN]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('never carries a producer-declared id anywhere: the whole receipt, stdout and the event hold only a count of extra ids', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: newReleaseEmits({ schema: INVARIANTS_SCHEMA, ids: [...INVARIANT_FLOOR, 'tenant.alice.prod.example'] }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    const verification = receiptOf().verification as { health?: { invariants?: unknown } } | undefined;
    expect(verification?.health?.invariants).toEqual({ reading: 'declared', floorIds: INVARIANT_FLOOR, extraIdCount: 1 });
    expect(world.alerts).toHaveLength(1);
    const documents = [receiptText(), result.stdout, JSON.stringify(world.alerts[0]!.payload)];
    for (const text of documents) {
      for (const part of ['alice', 'tenant', 'prod.example']) expect(text).not.toContain(part);
    }
  });

  it('never echoes a producer schema string into the receipt or the alert', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: newReleaseEmits({ schema: 'tenant-alice.prod.example', ids: DECLARED_INVARIANTS }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'unknown', detail: 'unknown-schema', schema: 'unrecognised', undeclared: INVARIANT_FLOOR },
    });
    expect(world.alerts).toHaveLength(1);
    const texts = [receiptText(), result.stdout, JSON.stringify(world.alerts[0]!.payload)];
    for (const text of texts) {
      for (const part of ['tenant-alice.prod.example', 'tenant', 'alice', 'prod.example']) expect(text).not.toContain(part);
    }
  });

  it('a path-shaped schema never reaches the receipt or the alert', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: newReleaseEmits({ schema: `${fixture.base}/health-invariants`, ids: DECLARED_INVARIANTS }),
    });

    await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({ activation: { outcome: 'unknown', schema: 'unrecognised' } });
    expect(world.alerts).toHaveLength(1);
    expect(JSON.stringify(world.alerts[0]!.payload)).not.toContain(fixture.base);
    expect(JSON.stringify(receiptOf().invariants)).not.toContain(fixture.base);
  });

  it('a producer that declares the floor is satisfied and sends exactly one clear for the same instance and source', async () => {
    const world = new SimulatedLaunchd(fixture);

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'satisfied', detail: null, schema: 'known', undeclared: [] },
      alert: { attempted: true, kind: 'clear', status: 0 },
    });
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(world.alerts).toHaveLength(1);
    expect(world.alerts[0]).toMatchObject({ instance: INSTANCE, source: INVARIANTS_ALERT_SOURCE, eventType: 'clear' });
    expect(receiptOf().verification).toMatchObject({ binding: 'bound' });
  });

  it('the event source names the tool floor: a clear under this floor never uses the source of another floor', async () => {
    const world = new SimulatedLaunchd(fixture);

    await run(world, activationArgs(fixture, ['--apply']));

    expect(world.alerts).toHaveLength(1);
    expect(world.alerts[0]!.eventType).toBe('clear');
    expect(world.alerts[0]!.source).toBe(INVARIANTS_ALERT_SOURCE);
    expect(world.alerts[0]!.source).toMatch(/^release-invariants:[0-9a-f]{8}$/);
    // A tool whose floor also requires another id raises and clears a different incident.
    const otherFloor = invariantsSourceFor(INVARIANTS_SCHEMA, [...INVARIANT_FLOOR, 'health.diagnostic_requires_token']);
    expect(otherFloor).not.toBe(INVARIANTS_ALERT_SOURCE);
    expect(world.alerts[0]!.source).not.toBe(otherFloor);
  });

  it('the clear payload is content-free: verdicts and ids only, no paths, commits, or token', async () => {
    const world = new SimulatedLaunchd(fixture);

    await run(world, activationArgs(fixture, ['--apply']));

    expect(world.alerts).toHaveLength(1);
    expect(world.alerts[0]!.eventType).toBe('clear');
    const text = JSON.stringify(world.alerts[0]!.payload);
    expect(text).toContain('satisfied');
    for (const forbidden of [fixture.base, fixture.home, NEW_COMMIT, OLD_COMMIT, TOOL_COMMIT, TOKEN]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('extra ids beyond the floor stay satisfied (one clear)', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: newReleaseEmits({ schema: INVARIANTS_SCHEMA, ids: [...INVARIANT_FLOOR, 'future.invariant_this_tool_does_not_know'] }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({ activation: { outcome: 'satisfied', undeclared: [] } });
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['clear']);
  });

  it('a block that omits a floor id is below_floor: one warning, outcome and exit unchanged', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: newReleaseEmits({ schema: INVARIANTS_SCHEMA, ids: ['health.diagnostic_requires_token'] }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'below_floor', detail: null, schema: 'known', undeclared: INVARIANT_FLOOR },
    });
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['alert']);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
  });

  it('an unrecognised schema is unknown, never satisfied, even when every floor id is listed', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: newReleaseEmits({ schema: 'whatsoup.health-invariants.v2', ids: DECLARED_INVARIANTS }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'unknown', detail: 'unknown-schema', schema: 'unrecognised', undeclared: INVARIANT_FLOOR },
    });
    expect(world.alerts).toHaveLength(1);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });

  it('a malformed block (ids not an array) is unknown, never missing', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: newReleaseEmits({ schema: INVARIANTS_SCHEMA, ids: DECLARED_INVARIANTS.join(',') }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'unknown', detail: 'malformed', schema: null, undeclared: INVARIANT_FLOOR },
    });
    expect(world.alerts).toHaveLength(1);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });

  it('a non-2xx diagnostic body that declares the floor is unknown/http-status: one warning, outcome and exit unchanged', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(CURRENT_BLOCK, {}, 503) });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'unknown', detail: 'http-status', schema: null, undeclared: INVARIANT_FLOOR },
    });
    expect(world.alerts).toHaveLength(1);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
  });

  it('a body served by another pid than the one observed is unknown/unbound, whatever it declares', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(CURRENT_BLOCK, { pid: 424_242 }) });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'unknown', detail: 'unbound', schema: null, undeclared: INVARIANT_FLOOR },
    });
    expect(world.alerts).toHaveLength(1);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });

  it('records the binding result, never the pid a responder reported: no 424242 in receipt.json or stdout', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(CURRENT_BLOCK, { pid: 424_242 }) });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({ activation: { outcome: 'unknown', detail: 'unbound' } });
    expect(receiptOf().verification).toMatchObject({ binding: 'unbound' });
    // The body really named that pid (guard on the fixture).
    expect(servedByNew(world).some((body) => (body.instance as Record<string, unknown>).pid === 424_242)).toBe(true);
    for (const text of [receiptText(), result.stdout]) expect(text).not.toContain('424242');
    const verification = receiptOf().verification as { health: Record<string, unknown> };
    expect(verification.health).not.toHaveProperty('responderPid');
    expect(verification).not.toHaveProperty('resample');
  });

  it('a launchd pid that changes between the samples before and after the response is unknown/unbound, one warning', async () => {
    let restarted = false;
    let world: SimulatedLaunchd | null = null;
    world = new SimulatedLaunchd(fixture, {
      health: (root, fallback) => {
        const response = newReleaseEmits(CURRENT_BLOCK)(root, fallback);
        // The process that answered is replaced before the tool looks at launchd again.
        if (root === fixture.newRelease && !restarted) {
          restarted = true;
          world!.restartInstance();
        }
        return response;
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(restarted).toBe(true);
    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'unknown', detail: 'unbound', schema: null, undeclared: INVARIANT_FLOOR },
    });
    expect(receiptOf().verification).toMatchObject({ binding: 'restarted' });
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['alert']);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });

  it('the same pid with a different process start time between the samples is restarted: verdict unknown, one warning', async () => {
    let reused = false;
    let world: SimulatedLaunchd | null = null;
    world = new SimulatedLaunchd(fixture, {
      health: (root, fallback) => {
        const response = newReleaseEmits(CURRENT_BLOCK)(root, fallback);
        // The responder exits and a new process gets the SAME pid before the re-sample.
        if (root === fixture.newRelease && !reused) {
          reused = true;
          world!.reuseInstancePid();
        }
        return response;
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'unknown', detail: 'unbound', schema: null, undeclared: INVARIANT_FLOOR },
    });
    expect(receiptOf().verification).toMatchObject({ binding: 'restarted' });
    expect(reused).toBe(true);
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['alert']);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });

  it('a re-sample exec that never exits is cut off at its own bound: the activation completes as the baseline, binding unobserved', async () => {
    // Only bounded execs can hang here, and the one bounded launchctl call is the re-sample.
    const world = new SimulatedLaunchd(fixture, { hangBounded: (file) => file === 'launchctl' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let result: Awaited<ReturnType<typeof run>> | null = null;
    try {
      const pending = run(world, activationArgs(fixture, ['--apply']));
      let settled = false;
      pending.then(() => { settled = true; }, () => { settled = true; });
      while (!settled) {
        // Let real I/O (the database backup, file writes) progress, then move the fake clock.
        await new Promise((resolve) => { setImmediate(resolve); });
        await vi.advanceTimersByTimeAsync(1_000);
      }
      result = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'unknown', detail: 'unobserved', schema: null, undeclared: INVARIANT_FLOOR },
    });
    expect(receiptOf().verification).toMatchObject({ binding: 'unobserved' });
    expect(result!.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result!.json.outcome).toBe('activated');
    expect(world.boundedCalls.filter(([file]) => file === 'launchctl')).toHaveLength(1);
  });

  it('a failed first health poll and a passing second activate as the baseline; the re-sample runs once, after the decision', async () => {
    let polls = 0;
    const world = new SimulatedLaunchd(fixture, {
      health: (root, fallback) => {
        if (root !== fixture.newRelease) return fallback();
        polls += 1;
        return polls === 1 ? { status: 200, body: diagnosticBody(NEW_COMMIT, false) } : fallback();
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'satisfied' },
      alert: { attempted: true, kind: 'clear', status: 0 },
    });
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
    expect(polls).toBe(2);
    // Not once per poll: one bounded launchctl print, for the final observation only.
    expect(world.boundedCalls.filter(([file, verb]) => file === 'launchctl' && verb === 'print')).toHaveLength(1);
    expect(receiptOf().verification).toMatchObject({ binding: 'bound' });
  });

  it('a body without a numeric instance.pid is unknown/unbound', async () => {
    const world = new SimulatedLaunchd(fixture, { injectPid: false });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({ activation: { outcome: 'unknown', detail: 'unbound' } });
    expect(servedByNew(world).every((body) => !('pid' in (body.instance as Record<string, unknown>)))).toBe(true);
    expect(world.alerts).toHaveLength(1);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
  });

  it('a failed alert helper never changes the outcome or exit code; the receipt records its status', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(NO_BLOCK), alertStatus: 1 });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({ alert: { attempted: true, kind: 'warning', status: 1 } });
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.json.outcome).toBe('activated');
  });

  it('an alert helper that throws is recorded with a null status, the verdict is already durable, and the exit code is unchanged', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(NO_BLOCK), alertStatus: 'throw' });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'missing' },
      alert: { attempted: true, kind: 'warning', status: null },
    });
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(result.stderr).toMatch(/release invariants alert/);
  });

  it('on rollback, records the rollback target verdict too, and still sends only one warning', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: (root) => (root === fixture.newRelease
        ? { status: 200, body: diagnosticBody(NEW_COMMIT, false) }
        : { status: 200, body: diagnosticBody(OLD_COMMIT, true, NO_BLOCK) }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'satisfied' },
      rollback: { outcome: 'missing', detail: null, undeclared: INVARIANT_FLOOR },
      alert: { attempted: true, kind: 'warning', status: 0 },
    });
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['alert']);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
  });

  it('a rollback where both processes declare the floor sends exactly one clear', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: (root, fallback) => (root === fixture.newRelease
        ? { status: 200, body: diagnosticBody(NEW_COMMIT, false) }
        : fallback()),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'satisfied' },
      rollback: { outcome: 'satisfied' },
      alert: { attempted: true, kind: 'clear', status: 0 },
    });
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['clear']);
  });

  it('a rollback body served by another pid is unknown/unbound for the rollback verdict', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: (root) => (root === fixture.newRelease
        ? { status: 200, body: diagnosticBody(NEW_COMMIT, false) }
        : { status: 200, body: diagnosticBody(OLD_COMMIT, true, CURRENT_BLOCK, { pid: 424_242 }) }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'satisfied' },
      rollback: { outcome: 'unknown', detail: 'unbound' },
    });
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['alert']);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
  });

  it('records no rollback verdict and sends no clear when the rollback stopped before any rollback process was observed', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: (root, fallback) => (root === fixture.newRelease
        ? { status: 200, body: diagnosticBody(NEW_COMMIT, false) }
        : fallback()),
      onInstanceExit: (root, via) => {
        if (root === fixture.newRelease && via === 'bootout') migrateFixture(fixture.dbPath, FIXTURE_SCHEMA + 1);
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rollbackBlockedMigrated);
    // The new instance may already be stopped: a satisfied activation verdict clears nothing here.
    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'satisfied' },
      rollback: null,
      alert: { attempted: false, kind: null, status: null },
    });
    expect(world.alerts).toEqual([]);
  });

  it('binds to the executing process: argv on the old release gives unknown/unbound, not the body it served', async () => {
    const world = new SimulatedLaunchd(fixture, {
      instanceArgv: () => `/opt/node/bin/node --experimental-strip-types ${fixture.oldRelease}/src/bootstrap.ts ${INSTANCE}`,
      health: () => {
        const onNew = readlinkSync(fixture.wrapperLink).startsWith(`${fixture.newRelease}/`);
        return { status: 200, body: diagnosticBody(onNew ? NEW_COMMIT : OLD_COMMIT, true) };
      },
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'unknown', detail: 'unbound', schema: null, undeclared: INVARIANT_FLOOR },
      rollback: { outcome: 'satisfied' },
    });
    expect(world.alerts.map((alert) => alert.eventType)).toEqual(['alert']);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rolledBack);
  });

  it('an unobserved body (public envelope) is unknown/unobserved, never missing', async () => {
    const world = new SimulatedLaunchd(fixture, {
      health: () => ({ status: 200, body: JSON.stringify({ schema_version: 'health.public.v1', status: 'ok' }) }),
    });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: { outcome: 'unknown', detail: 'unobserved', schema: null, undeclared: INVARIANT_FLOOR },
      rollback: { outcome: 'unknown', detail: 'unobserved' },
    });
    expect(world.alerts).toHaveLength(1);
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.rollbackUnverified);
  });

  it('--plan never sends an alert, even against a producer without the block', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(NO_BLOCK) });

    const result = await run(world, activationArgs(fixture, ['--plan']));

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.ok);
    expect(world.alerts).toEqual([]);
    expect(result.json).not.toHaveProperty('invariants');
  });

  it('an --apply refused on its preconditions sends no alert', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(NO_BLOCK) });
    const other = path.join(fixture.base, 'releases', 'release-other');
    writeRelease(other, '3'.repeat(40), true);
    const argv = activationArgs(fixture, ['--apply']).map((arg) => (arg === fixture.oldRelease ? other : arg));

    const result = await run(world, argv);

    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    expect(world.alerts).toEqual([]);
  });

  it('an --apply refused inside the apply (staged plist fails plutil) records no verdict and sends no event', async () => {
    const world = new SimulatedLaunchd(fixture, { health: newReleaseEmits(NO_BLOCK), plutilFails: true });

    const result = await run(world, activationArgs(fixture, ['--apply']));

    expect(receiptOf().invariants).toMatchObject({
      activation: null,
      rollback: null,
      alert: { attempted: false, kind: null, status: null },
    });
    expect(result.code).toBe(RELEASE_ACTIVATE_EXIT.refused);
    expect(result.json.outcome).toBe('refused');
    expect(world.alerts).toEqual([]);
  });
});

describe('release activation helpers', () => {
  it('reads the health_invariants block structurally, never by matching bytes', () => {
    const read = (invariants: unknown): unknown => classifyAuthenticatedHealth(200, diagnosticBody(NEW_COMMIT, true, invariants)).invariants;
    const reading = (kind: string, floorIds: string[] = [], extraIdCount = 0) => ({ reading: kind, floorIds, extraIdCount });

    expect(read(NO_BLOCK)).toEqual(reading('absent'));
    // Only floor members are kept by name; every other declared id is only counted.
    expect(read(CURRENT_BLOCK)).toEqual(reading('declared', INVARIANT_FLOOR, DECLARED_INVARIANTS.length - INVARIANT_FLOOR.length));
    expect(read({ schema: INVARIANTS_SCHEMA, ids: [] })).toEqual(reading('declared'));
    expect(read({ schema: INVARIANTS_SCHEMA, ids: ['tenant.alice.prod.example'] })).toEqual(reading('declared', [], 1));
    expect(read({ schema: 'whatsoup.health-invariants.v2', ids: DECLARED_INVARIANTS })).toEqual(reading('unknown-schema'));
    expect(read({ schema: '/var/lib/whatsoup/state', ids: [] })).toEqual(reading('unknown-schema'));
    expect(read({ schema: 'x'.repeat(129), ids: [] })).toEqual(reading('unknown-schema'));
    const malformed = reading('malformed');
    expect(read(null)).toEqual(malformed);
    expect(read(DECLARED_INVARIANTS)).toEqual(malformed);
    expect(read({ schema: INVARIANTS_SCHEMA })).toEqual(malformed);
    expect(read({ schema: INVARIANTS_SCHEMA, ids: DECLARED_INVARIANTS.join(',') })).toEqual(malformed);
    expect(read({ schema: INVARIANTS_SCHEMA, ids: [INVARIANT_FLOOR[0], INVARIANT_FLOOR[0]] })).toEqual(malformed);
    expect(read({ schema: INVARIANTS_SCHEMA, ids: [INVARIANT_FLOOR[0], 7] })).toEqual(malformed);
    expect(read({ schema: INVARIANTS_SCHEMA, ids: ['/var/lib/whatsoup/state'] })).toEqual(malformed);
    expect(read({ schema: INVARIANTS_SCHEMA, ids: Array.from({ length: 65 }, (_, index) => `id_${index}`) })).toEqual(malformed);
    expect(read({ schema: 42, ids: DECLARED_INVARIANTS })).toEqual(malformed);

    // The ids appearing as text elsewhere in the body are not a declaration.
    const smuggled = JSON.stringify({
      instance: { commit: NEW_COMMIT, note: JSON.stringify({ health_invariants: CURRENT_BLOCK }) },
      whatsapp: { connected: true },
    });
    expect(classifyAuthenticatedHealth(200, smuggled).invariants).toEqual(reading('absent'));
  });

  it('reads the responder pid from instance.pid, numeric only', () => {
    const pidOf = (instance: Record<string, unknown>): unknown =>
      classifyAuthenticatedHealth(200, diagnosticBody(NEW_COMMIT, true, CURRENT_BLOCK, instance)).responderPid;
    expect(pidOf({ pid: 7001 })).toBe(7001);
    expect(pidOf({})).toBeNull();
    expect(pidOf({ pid: '7001' })).toBeNull();
    expect(pidOf({ pid: 7001.5 })).toBeNull();
  });

  it('reads no invariants from a body it cannot classify as diagnostic', () => {
    expect(classifyAuthenticatedHealth(200, JSON.stringify({ schema_version: 'health.public.v1', status: 'ok' })).invariants).toBeNull();
    expect(classifyAuthenticatedHealth(500, JSON.stringify({ status: 'error' })).invariants).toBeNull();
    expect(classifyAuthenticatedHealth(200, 'not json').invariants).toBeNull();
    // A 503 diagnostic body is still read; the verdict, not the reader, maps non-2xx to unknown.
    expect(classifyAuthenticatedHealth(503, diagnosticBody(NEW_COMMIT, false, NO_BLOCK)).invariants)
      .toEqual({ reading: 'absent', floorIds: [], extraIdCount: 0 });
  });

  it('matches the bootstrap entrypoint only as a whole argument', () => {
    const entry = '/r/rel/src/bootstrap.ts';
    expect(argvNamesEntrypoint(`node ${entry} inst`, entry)).toBe(true);
    expect(argvNamesEntrypoint(`node ${entry}`, entry)).toBe(true);
    expect(argvNamesEntrypoint('node /x/r/rel/src/bootstrap.ts inst', entry)).toBe(false);
    expect(argvNamesEntrypoint(`node ${entry}.bak inst`, entry)).toBe(false);
  });

  it('stages only ProgramArguments[0] and WorkingDirectory, and refuses anything else pointing at the old release', () => {
    const link = '/h/.local/bin/whatsoup';
    const viaLink = plist(INSTANCE_LABEL, [link, INSTANCE], '/r/old');
    expect(stageInstancePlist(viaLink, { expectCurrent: '/r/old', release: '/r/new', wrapperLink: link }))
      .toMatchObject({ error: null, edits: ['WorkingDirectory: /r/old -> /r/new'] });

    const direct = plist(INSTANCE_LABEL, ['/r/old/deploy/whatsoup', INSTANCE], '/h');
    const staged = stageInstancePlist(direct, { expectCurrent: '/r/old', release: '/r/new', wrapperLink: link });
    expect(staged.error).toBeNull();
    expect(staged.staged).toContain('<string>/r/new/deploy/whatsoup</string>');
    expect(staged.staged).toContain('<string>/h</string>');

    const foreign = plist(INSTANCE_LABEL, ['/usr/local/bin/other', INSTANCE], '/r/old');
    expect(stageInstancePlist(foreign, { expectCurrent: '/r/old', release: '/r/new', wrapperLink: link }).error)
      .toMatch(/neither the wrapper symlink nor/);

    const leftover = plist(INSTANCE_LABEL, [link, INSTANCE, '/r/old/extra'], '/r/old');
    expect(stageInstancePlist(leftover, { expectCurrent: '/r/old', release: '/r/new', wrapperLink: link }).error)
      .toMatch(/still references the expected-current release/);

    // A sibling sharing the old root as a string prefix is not a reference to it.
    const sibling = plist(INSTANCE_LABEL, [link, INSTANCE, '/r/old-archive/x'], '/r/old');
    expect(stageInstancePlist(sibling, { expectCurrent: '/r/old', release: '/r/new', wrapperLink: link }).error).toBeNull();
  });
});
