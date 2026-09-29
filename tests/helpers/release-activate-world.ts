/**
 * The simulated launchd world for the release:activate tests: a real temporary
 * HOME (real files, symlinks, plists and a real SQLite database) with
 * launchctl, ps, plutil, the renderer scripts, process liveness, the clock and
 * the health probe replaced. All identifiers are fabricated. Shared by
 * tests/scripts/release-activate.test.ts and
 * tests/scripts/release-activate-report.test.ts; each test file keeps its own
 * node:fs fault mock.
 */
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, vi } from 'vitest';

import { runReleaseActivateCli } from '../../scripts/release-activate.ts';
import type { ActivationHost, ExecResult } from '../../scripts/lib/release-activation/host.ts';
import { trackTmpDirs } from './tmp-dir.ts';

export const tmp = trackTmpDirs('whatsoup-activate-');

export const INSTANCE = 'test-line';
export const INSTANCE_LABEL = `com.whatsoup.${INSTANCE}`;
export const TIMER_LABEL = 'com.whatsoup.aux-timer';
export const DRIFT_LABEL = 'com.whatsoup.release-drift-check';
export const OLD_COMMIT = '1'.repeat(40);
export const NEW_COMMIT = '2'.repeat(40);
export const TOKEN = 'f'.repeat(64);
export const HEALTH_PORT = 19_090;
export const TARGET_URL = 'https://example.invalid/fabricated/repo.git';
export const UID = 4242;
/** Schema migration level of the fixture database; the old release's ceiling. */
export const FIXTURE_SCHEMA = 64;
/**
 * #2481: the `health_invariants` block a current producer emits, and the floor
 * the activating tool requires. Literal copies of src/core/health-invariants.ts,
 * so a change there is a reviewed diff here too.
 */
export const INVARIANTS_SCHEMA = 'whatsoup.health-invariants.v1';
export const DECLARED_INVARIANTS = [
  'turn_capability.stale_evidence_degrades',
  'turn_capability.probe_expected_stale_degrades',
  'health.diagnostic_requires_token',
];
export const INVARIANT_FLOOR = ['turn_capability.stale_evidence_degrades'];
/**
 * The event source names the floor it was judged against: `release-invariants:`
 * plus the first 8 hex of sha256 over the schema and the sorted floor ids,
 * newline-separated. A literal copy of the algorithm, so a change is a reviewed diff.
 */
export function invariantsSourceFor(schema: string, floor: readonly string[]): string {
  const digest = createHash('sha256').update([schema, ...[...floor].sort()].join('\n')).digest('hex');
  return `release-invariants:${digest.slice(0, 8)}`;
}
export const INVARIANTS_ALERT_SOURCE = invariantsSourceFor(INVARIANTS_SCHEMA, INVARIANT_FLOOR);
/** The commit the fake host reports for the activating tool's own tree (the floor's source). */
export const TOOL_COMMIT = 'a'.repeat(40);
export const CURRENT_BLOCK = { schema: INVARIANTS_SCHEMA, ids: DECLARED_INVARIANTS };
/**
 * A producer that predates the block. A sentinel, not `undefined`: a default
 * parameter would silently turn an explicit `undefined` back into the current
 * block, which is exactly the legacy case these tests exist to cover.
 */
export const NO_BLOCK = Symbol('no health_invariants block');

/**
 * An authenticated diagnostic body. The fake host adds the serving pid as
 * `instance.pid` (like the real producer) unless the body already names one or
 * the world sets `injectPid: false`.
 */
export function diagnosticBody(
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

export interface Fixture {
  base: string;
  home: string;
  oldRelease: string;
  newRelease: string;
  wrapperLink: string;
  launchAgents: string;
  dbPath: string;
  backupDir: string;
}

export function plist(label: string, programArguments: string[], workingDirectory: string): string {
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

export function releaseDriftArgs(root: string, home: string): string[] {
  return [
    '/bin/bash', `${root}/deploy/scripts/run-release-drift-schedule.sh`,
    '--launchd-plist', `${home}/Library/LaunchAgents/${INSTANCE_LABEL}.plist`,
    '--instance', INSTANCE,
    '--target-url', TARGET_URL,
    '--target-ref', 'refs/heads/main',
  ];
}

export function writeRelease(root: string, commit: string, withDependencies: boolean): void {
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

export function installFixture(): Fixture {
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
export function migrateFixture(dbPath: string, version: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`INSERT OR IGNORE INTO schema_migrations (version) VALUES (${version})`);
  } finally {
    db.close();
  }
}

/** The level an old-release binary would see, or null when it cannot open the database at all. */
export function fixtureSchemaLevel(dbPath: string): number | null {
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
export function snapshotTree(root: string): Record<string, string> {
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

export interface WorldOptions {
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
  /** Runs at every bounded exec, before it answers (e.g. a migration that commits meanwhile). */
  onBoundedCall?: (file: string, args: readonly string[]) => void;
  /** How long a process has been up when it first answers (its start precedes the tool's clock by this). Default 2 s. */
  bootMs?: number;
  /** Take `now` from Date.now() and sleep on setTimeout, so fake timers drive the clock (runPumped). */
  realTime?: boolean;
  /** The tool reads each health response this long after it was served (a delayed or descheduled read). */
  responseDelayMs?: number;
  /** After each unbounded `ps -o command=` (the verification poll's argv read), the next host.now() throws once. */
  clockFaultAfterArgvRead?: boolean;
  /** Rewrite the definition `launchctl print` shows for an auxiliary label (e.g. one that still names the old release). */
  auxDefinition?: (label: string, definition: string) => string;
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `ps -o lstart=` under TZ=UTC0 and LC_ALL=C: second resolution, day padded with a space. */
export function lstartText(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} `
    + `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

export interface RecordedAlert {
  instance: string;
  source: string;
  eventType: 'alert' | 'clear';
  env?: Record<string, string>;
  payload: { summary: string; evidence: string; diagnostics: string[]; severity: string };
}

/** The real producer reports its own `process.pid` as `instance.pid`; the fake does the same for the serving pid. */
export function withServingPid(body: string, pid: number): string {
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

export class SimulatedLaunchd {
  readonly calls: string[][] = [];
  readonly tokensSeen: string[] = [];
  /** Every alert sent through the host seam, in order. */
  readonly alerts: RecordedAlert[] = [];
  /** Every health body served: the release root and pid it came from, and the tool clock when it was served. */
  readonly served: Array<{ root: string | null; body: string; at: number; pid: number | null }> = [];
  /** Release root of every instance process started, in order. */
  readonly instanceStarts: string[] = [];
  private readonly loaded = new Map<string, { pid: number; definition: string; root: string | null }>();
  private readonly alive = new Set<number>();
  private readonly argv = new Map<number, string>();
  /** Process start time per pid (ms), as `ps -o lstart=` reports it. */
  private readonly startTimes = new Map<number, number>();
  /** Every exec the tool bounded with its own timeout (`options.timeoutMs`), in order. */
  readonly boundedCalls: string[][] = [];
  /** Index into `calls` of every bounded exec, to check its order against the mutating calls. */
  readonly boundedAt: number[] = [];
  /** The tool clock at each hung call. */
  readonly hungAt: number[] = [];
  /** The `env` each `ps -o lstart=` call asked for. */
  readonly startTimeEnvs: unknown[] = [];
  /** How many injected host.now() faults fired (`clockFaultAfterArgvRead`). */
  clockFaults = 0;
  private clockFaultArmed = false;
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

  now(): number {
    return this.options.realTime ? Date.now() : this.clock;
  }

  private start(label: string, definition: string, reusePid?: number, startedAtMs?: number): number {
    const pid = reusePid ?? this.nextPid++;
    this.alive.add(pid);
    this.startTimes.set(pid, startedAtMs ?? this.now() - (this.options.bootMs ?? 2_000));
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

  /**
   * Restart the instance on the SAME pid (pid reuse). By default the new
   * process starts a second after now; `startedAtMs` can give it the same
   * start time as the process it replaced.
   */
  reuseInstancePid(startedAtMs: number = this.now() + 1_000): void {
    const job = this.loaded.get(INSTANCE_LABEL);
    if (!job) return;
    this.exit(job.pid, job.root, 'kickstart');
    this.start(INSTANCE_LABEL, job.definition, job.pid, startedAtMs);
  }

  /** Start time (ms) of the running instance process. */
  instanceStartedAt(): number {
    return this.startTimes.get(this.loaded.get(INSTANCE_LABEL)!.pid)!;
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
      sleep: this.options.realTime
        ? (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); })
        : async (ms) => { this.clock += ms; },
      now: () => {
        if (this.clockFaultArmed) {
          this.clockFaultArmed = false;
          this.clockFaults += 1;
          throw new Error('injected clock fault');
        }
        return this.now();
      },
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
        this.served.push({ root, body, at: this.now(), pid: serving?.pid ?? null });
        const delay = this.options.responseDelayMs ?? 0;
        if (delay > 0) {
          if (this.options.realTime) await new Promise<void>((resolve) => { setTimeout(resolve, delay); });
          else this.clock += delay;
        }
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
        const extra = options as { timeoutMs?: number; env?: unknown } | undefined;
        if (extra?.timeoutMs !== undefined) {
          this.boundedCalls.push([file, ...args]);
          this.boundedAt.push(this.calls.length - 1);
          if (args.includes('lstart=')) this.startTimeEnvs.push(extra.env);
          this.options.onBoundedCall?.(file, args);
          // A child that never exits: only the tool's own bound can end this call.
          if (this.options.hangBounded?.(file, args)) {
            this.hungAt.push(this.now());
            return new Promise<ExecResult>(() => {});
          }
        }
        if (file === 'launchctl') {
          const [verb, ...rest] = args;
          if (verb === 'print') {
            const job = this.loaded.get(this.labelOf(rest[0]!));
            if (!job) return { code: 113, stdout: '', stderr: 'Could not find service' };
            const label = this.labelOf(rest[0]!);
            const pidLine = this.alive.has(job.pid) ? `\tpid = ${job.pid}\n` : '';
            const definition = label !== INSTANCE_LABEL && this.options.auxDefinition
              ? this.options.auxDefinition(label, job.definition)
              : job.definition;
            return ok(`${label} = {\n${pidLine}\tdefinition = ${definition}\n}\n`);
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
            return this.alive.has(pid) ? ok(`${lstartText(this.startTimes.get(pid)!)}\n`) : { code: 1, stdout: '', stderr: '' };
          }
          if (extra?.timeoutMs === undefined && this.options.clockFaultAfterArgvRead) this.clockFaultArmed = true;
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

  /** Index into `calls` of the last bootout, bootstrap or kickstart. */
  lastMutatingAt(): number {
    return this.calls.findLastIndex(([file, verb]) => file === 'launchctl' && ['bootout', 'bootstrap', 'kickstart'].includes(verb!));
  }
}

export function activationArgs(fixture: Fixture, extra: string[] = []): string[] {
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

export async function run(
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

export const PUMP_STEP_MS = 250;
export const PUMP_LIMIT_MS = 180_000;

/**
 * Run the CLI under fake setTimeout, clearTimeout and Date, with a
 * `realTime` world (host.now() = Date.now(), sleep on setTimeout), so fake time
 * drives both the tool's timers and its deadline clock. Real I/O progresses
 * between steps. A run that does not settle within PUMP_LIMIT_MS of fake time
 * fails with a labelled error rather than the runner timeout.
 */
export async function runPumped(
  makeWorld: () => SimulatedLaunchd,
  argv: string[],
): Promise<{ world: SimulatedLaunchd; result: Awaited<ReturnType<typeof run>> }> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_767_225_600_000 });
  try {
    const world = makeWorld();
    const pending = run(world, argv);
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    for (let elapsed = 0; !settled; elapsed += PUMP_STEP_MS) {
      if (elapsed >= PUMP_LIMIT_MS) throw new Error(`release:activate did not settle within ${PUMP_LIMIT_MS} ms of fake time`);
      await new Promise((resolve) => { setImmediate(resolve); });
      await vi.advanceTimersByTimeAsync(PUMP_STEP_MS);
    }
    return { world, result: await pending };
  } finally {
    vi.useRealTimers();
  }
}

export function onlyBackup(fixture: Fixture): string {
  const entries = readdirSync(fixture.backupDir);
  expect(entries).toHaveLength(1);
  return path.join(fixture.backupDir, entries[0]!);
}
