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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  parseActivationArgs,
  RELEASE_ACTIVATE_EXIT,
  runReleaseActivateCli,
} from '../../scripts/release-activate.ts';
import { argvNamesEntrypoint } from '../../scripts/lib/release-activation/apply.ts';
import type { ActivationHost, ExecResult } from '../../scripts/lib/release-activation/host.ts';
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
  db.close();

  return { base, home, oldRelease, newRelease, wrapperLink, launchAgents, dbPath, backupDir: path.join(base, 'backups') };
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
  /** Override the health response for the instance (default: healthy for the running release). */
  health?: (runningRoot: string | null) => { status: number; body: string };
  platform?: NodeJS.Platform;
}

class SimulatedLaunchd {
  readonly calls: string[][] = [];
  readonly tokensSeen: string[] = [];
  private readonly loaded = new Map<string, { pid: number; definition: string; root: string | null }>();
  private readonly alive = new Set<number>();
  private readonly argv = new Map<number, string>();
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

  private start(label: string, definition: string): number {
    const pid = this.nextPid++;
    this.alive.add(pid);
    const root = label === INSTANCE_LABEL ? this.runningRoot() : null;
    if (root !== null) {
      this.argv.set(pid, this.options.instanceArgv?.(root)
        ?? `/opt/node/bin/node --experimental-strip-types ${root}/src/bootstrap.ts ${INSTANCE}`);
    }
    this.loaded.set(label, { pid, definition, root });
    return pid;
  }

  private exit(pid: number): void {
    if (!this.options.stuckPids?.has(pid)) this.alive.delete(pid);
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
        const root = job && this.alive.has(job.pid) ? job.root : null;
        if (this.options.health) return this.options.health(root);
        if (root === null) throw new Error('connection refused');
        const commit = root === this.fixture.newRelease ? NEW_COMMIT : OLD_COMMIT;
        return { status: 200, body: JSON.stringify({ instance: { commit }, whatsapp: { connected: true } }) };
      },
      exec: async (file, args, options) => {
        this.calls.push([file, ...args]);
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
            if (job) this.exit(job.pid);
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
            this.exit(job.pid);
            this.start(label, job.definition);
            return ok();
          }
        }
        if (file === 'ps') {
          const pid = Number(args[1]);
          return this.alive.has(pid) && this.argv.has(pid) ? ok(`${this.argv.get(pid)}\n`) : { code: 1, stdout: '', stderr: '' };
        }
        if (file === 'plutil') return ok(`${args[1]}: OK\n`);
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
      'create-backup-dir', 'backup-database', 'record-symlink', 'backup-plists', 'write-staged-plists',
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

describe('release activation helpers', () => {
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
