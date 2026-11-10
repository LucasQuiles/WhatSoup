/**
 * The simulated systemd --user world for the Linux release:activate tests: a
 * real temporary HOME (release trees under ~/.local/opt/whatsoup/releases,
 * real drop-in files, a real SQLite database) with systemctl, /proc reads,
 * the clock and the health probe replaced. Shaped like the live layout (a
 * 12-hex release directory, a predecessor without a fence file, and a
 * `zzzzzzzz-release-<12hex>.conf` effective drop-in among shadowed ones). All
 * identifiers are fabricated.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect } from 'vitest';

import { runReleaseActivateCli } from '../../scripts/release-activate.ts';
import type { ActivationHost, ExecResult } from '../../scripts/lib/release-activation/host.ts';
import {
  diagnosticBody,
  FIXTURE_SCHEMA,
  fixtureSchemaLevel,
  HEALTH_PORT,
  INSTANCE,
  TOKEN,
  TOOL_COMMIT,
  tmp,
  UID,
  writeRelease,
} from './release-activate-world.ts';

export { INSTANCE };
export const UNIT = `whatsoup@${INSTANCE}.service`;
export const SYS_OLD_COMMIT = `c0ffee044d00${'5'.repeat(28)}`;
export const SYS_NEW_COMMIT = `c0ffee0f7a00${'6'.repeat(28)}`;
export const PRIOR_HEX = 'c0ffee031500';
/** `/proc/self/cgroup` of a process running inside the target unit. */
export const INSIDE_UNIT_CGROUP = `0::/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/${UNIT}\n`;
export const SCHEMA_VERSION_REL = 'src/core/database-schema-version.ts';
const SYSTEMCTL_MUTATING = new Set(['daemon-reload', 'restart', 'stop', 'start', 'reload', 'kill', 'reset-failed', 'enable', 'disable']);

export interface SystemdFixture {
  base: string;
  home: string;
  releasesDir: string;
  oldRelease: string;
  newRelease: string;
  dropInDir: string;
  effectiveDropIn: string;
  dbPath: string;
  backupDir: string;
}

/** The release drop-in shape: reset ExecStartPre/ExecStart, then point both at `root`. */
export function releaseDropIn(home: string, root: string): string {
  return [
    '[Service]',
    'ExecStartPre=',
    `ExecStartPre=/usr/bin/env REPO_ROOT=${root} ${home}/.local/bin/whatsoup-ensure-node`,
    'ExecStart=',
    `ExecStart=/bin/bash -euc 'exec ${root}/deploy/whatsoup ${INSTANCE}'`,
    '',
  ].join('\n');
}

function sealFile(root: string, relative: string, body: string): void {
  writeFileSync(path.join(root, relative), body);
  const manifestPath = path.join(root, '.whatsoup-release-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Array<{ path: string; sha256: string; sizeBytes: number }> };
  manifest.files = [
    ...manifest.files.filter((entry) => entry.path !== relative),
    { path: relative, sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: Buffer.byteLength(body) },
  ];
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

/** Seal the release's highest supported schema migration, as src/core/database-schema-version.ts declares it. */
export function writeSchemaSupport(root: string, max: number): void {
  mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
  sealFile(root, SCHEMA_VERSION_REL, `/** fabricated */\nexport const CURRENT_SCHEMA_MIGRATION = ${max};\n`);
}

export function installSystemdFixture(): SystemdFixture {
  const base = tmp.make('systemd');
  const home = path.join(base, 'home');
  const releasesDir = path.join(home, '.local', 'opt', 'whatsoup', 'releases');
  const oldRelease = path.join(releasesDir, `WhatSoup-release-${SYS_OLD_COMMIT.slice(0, 12)}`);
  const newRelease = path.join(releasesDir, `WhatSoup-release-${SYS_NEW_COMMIT.slice(0, 12)}`);
  writeRelease(oldRelease, SYS_OLD_COMMIT, true);
  writeRelease(newRelease, SYS_NEW_COMMIT, true);
  // The predecessor has no fence file (every fence key level 0) and opens the fixture schema.
  writeSchemaSupport(oldRelease, FIXTURE_SCHEMA);
  writeSchemaSupport(newRelease, FIXTURE_SCHEMA + 2);

  const dropInDir = path.join(home, '.config', 'systemd', 'user', `${UNIT}.d`);
  mkdirSync(dropInDir, { recursive: true });
  writeFileSync(path.join(dropInDir, 'max-sessions.conf'), '[Service]\nEnvironment=WHATSOUP_MAX_SESSIONS=4\n');
  writeFileSync(path.join(dropInDir, `zz-release-${PRIOR_HEX}.conf`), releaseDropIn(home, path.join(releasesDir, `WhatSoup-release-${PRIOR_HEX}`)));
  writeFileSync(path.join(dropInDir, 'zzzz-host-readiness.conf'), '[Unit]\nAfter=default.target\n\n[Service]\nExecStartPre=/usr/bin/true\n');
  const effectiveDropIn = path.join(dropInDir, `zzzzzzzz-release-${SYS_OLD_COMMIT.slice(0, 12)}.conf`);
  writeFileSync(effectiveDropIn, releaseDropIn(home, oldRelease), { mode: 0o600 });

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

  return { base, home, releasesDir, oldRelease, newRelease, dropInDir, effectiveDropIn, dbPath, backupDir: path.join(base, 'backups') };
}

export interface SystemdWorldOptions {
  /** `/proc/self/cgroup` text; null for unreadable. Default: a separate scope. */
  selfCgroup?: string | null;
  /** Report NeedDaemonReload=yes whatever the files say. */
  needDaemonReload?: boolean;
  /** The process already running at construction runs this release root instead of the loaded one. */
  initialMainPidRoot?: string;
  /** `systemctl show` ExecStart names this root instead of the loaded drop-in's. */
  loadedExecRoot?: string;
  /** Health response for the running release; `fallback` is healthy unless the predecessor would refuse the database. */
  health?: (root: string | null, fallback: () => { status: number; body: string }) => { status: number; body: string };
  /** Runs when an instance process starts on `root` (a new release migrating at startup). */
  onInstanceStart?: (root: string) => void;
}

interface LoadedDropIn { name: string; path: string; text: string }

export class SimulatedSystemd {
  readonly calls: string[][] = [];
  readonly instanceStarts: string[] = [];
  readonly initialMainPid: number;
  private loaded: LoadedDropIn[] = [];
  private mainPid: number | null = null;
  private activeState = 'inactive';
  private readonly argv = new Map<number, string[]>();
  private readonly rootOf = new Map<number, string | null>();
  private nextPid = 9100;
  private clock = 1_767_225_600_000;

  constructor(private readonly fixture: SystemdFixture, private readonly options: SystemdWorldOptions = {}) {
    this.reloadFromDisk();
    this.initialMainPid = this.start(options.initialMainPidRoot);
  }

  private diskDropIns(): LoadedDropIn[] {
    return readdirSync(this.fixture.dropInDir).filter((name) => name.endsWith('.conf')).sort().map((name) => {
      const filePath = path.join(this.fixture.dropInDir, name);
      return { name, path: filePath, text: readFileSync(filePath, 'utf8') };
    });
  }

  private reloadFromDisk(): void {
    this.loaded = this.diskDropIns();
  }

  /** The release root the loaded drop-ins select: the last one that sets a non-empty ExecStart. */
  loadedRoot(): string | null {
    const pattern = new RegExp(`(${this.fixture.releasesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/\\s'";]+)/deploy/whatsoup`);
    const selecting = this.loaded.filter((file) => /^ExecStart=\S/m.test(file.text)).at(-1);
    return selecting === undefined ? null : pattern.exec(selecting.text)?.[1] ?? null;
  }

  private start(rootOverride?: string): number {
    const pid = this.nextPid++;
    const root = rootOverride ?? this.loadedRoot();
    this.argv.set(pid, ['/opt/node/bin/node', '--experimental-strip-types', `${root}/src/bootstrap.ts`, INSTANCE]);
    this.rootOf.set(pid, root);
    this.mainPid = pid;
    this.activeState = 'active';
    if (root !== null) {
      this.instanceStarts.push(root);
      this.options.onInstanceStart?.(root);
    }
    return pid;
  }

  private stop(): void {
    this.mainPid = null;
    this.activeState = 'inactive';
  }

  private show(): string {
    const needReload = this.options.needDaemonReload === true
      || JSON.stringify(this.diskDropIns()) !== JSON.stringify(this.loaded);
    const execRoot = this.options.loadedExecRoot ?? this.loadedRoot();
    return [
      'LoadState=loaded',
      `ActiveState=${this.activeState}`,
      `MainPID=${this.mainPid ?? 0}`,
      `ControlGroup=/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/${UNIT}`,
      `NeedDaemonReload=${needReload ? 'yes' : 'no'}`,
      `DropInPaths=${this.loaded.map((file) => file.path).join(' ')}`,
      `ExecStart={ path=/bin/bash ; argv[]=/bin/bash -euc exec ${execRoot}/deploy/whatsoup ${INSTANCE} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`,
      '',
    ].join('\n');
  }

  private defaultHealth(root: string | null): { status: number; body: string } {
    if (root === null) throw new Error('connection refused');
    if (root === this.fixture.oldRelease) {
      const level = fixtureSchemaLevel(this.fixture.dbPath);
      if (level === null || level > FIXTURE_SCHEMA) throw new Error('connection refused');
    }
    return { status: 200, body: diagnosticBody(root === this.fixture.newRelease ? SYS_NEW_COMMIT : SYS_OLD_COMMIT, true) };
  }

  /** systemctl verbs that change manager or unit state, in order. */
  mutatingCalls(): string[][] {
    return this.calls.filter(([file, user, verb]) => file === 'systemctl' && user === '--user' && SYSTEMCTL_MUTATING.has(verb!));
  }

  /** Verbs of the mutating calls, e.g. ['daemon-reload', 'restart']. */
  mutatingVerbs(): string[] {
    return this.mutatingCalls().map((call) => call[2]!);
  }

  host(): ActivationHost {
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    return {
      platform: 'linux',
      uid: UID,
      isProcessAlive: (pid) => pid === this.mainPid,
      sleep: async (ms) => { this.clock += ms; },
      now: () => this.clock,
      fetchHealth: async (port, token) => {
        expect(port).toBe(HEALTH_PORT);
        expect(token).toBe(TOKEN);
        const root = this.mainPid === null ? null : this.rootOf.get(this.mainPid) ?? null;
        const response = this.options.health
          ? this.options.health(root, () => this.defaultHealth(root))
          : this.defaultHealth(root);
        return response;
      },
      emitReleaseAlert: async () => ({ status: 0 }),
      toolCommit: async () => TOOL_COMMIT,
      readSelfCgroup: () => (this.options.selfCgroup === undefined
        ? `0::/user.slice/user-${UID}.slice/user@${UID}.service/app.slice/release-activate-test.scope\n`
        : this.options.selfCgroup),
      readProcessCmdline: (pid) => (pid === this.mainPid ? this.argv.get(pid) ?? null : null),
      exec: async (file, args) => {
        this.calls.push([file, ...args]);
        if (file !== 'systemctl' || args[0] !== '--user') return { code: 127, stdout: '', stderr: `unexpected command ${file}` };
        const [, verb, unit] = args;
        if (verb === 'show' && unit === UNIT) return ok(this.show());
        if (verb === 'daemon-reload') { this.reloadFromDisk(); return ok(); }
        if (verb === 'stop' && unit === UNIT) { this.stop(); return ok(); }
        if (verb === 'start' && unit === UNIT) { if (this.mainPid === null) this.start(); return ok(); }
        if (verb === 'restart' && unit === UNIT) { this.stop(); this.start(); return ok(); }
        return { code: 1, stdout: '', stderr: `unexpected systemctl ${args.join(' ')}` };
      },
    };
  }
}

export function systemdActivationArgs(fixture: SystemdFixture, extra: string[] = []): string[] {
  return [
    '--instance', INSTANCE,
    '--release', fixture.newRelease,
    '--expect-current', fixture.oldRelease,
    '--backup-dir', fixture.backupDir,
    '--verify-timeout', '30',
    '--exit-timeout', '10',
    ...extra,
  ];
}

export async function runSystemd(
  world: SimulatedSystemd,
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

export function failedPreconditions(json: Record<string, unknown>): string[] {
  return (json['preconditions'] as Array<{ id: string; ok: boolean }>).filter((entry) => !entry.ok).map((entry) => entry.id);
}

export function onlySystemdBackup(fixture: SystemdFixture): string {
  const entries = readdirSync(fixture.backupDir);
  expect(entries).toHaveLength(1);
  return path.join(fixture.backupDir, entries[0]!);
}
