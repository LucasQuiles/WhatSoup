import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const receiptFault = vi.hoisted(() => ({ fail: false }));
vi.mock('../../src/lib/private-fs.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/private-fs.ts')>();
  return {
    ...actual,
    writeAtomicPrivateFileSync: (...args: Parameters<typeof actual.writeAtomicPrivateFileSync>) => {
      if (receiptFault.fail) throw Object.assign(new Error('injected receipt publication failure'), { code: 'ENOSPC' });
      return actual.writeAtomicPrivateFileSync(...args);
    },
  };
});

// Tests cannot create root-owned files: lstat may report one plist as root-owned, and the installed helper is faked.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const lstatSync = vi.fn(actual.lstatSync);
  return { ...actual, default: { ...actual, lstatSync }, lstatSync };
});
vi.mock('../../scripts/lib/release-activation/root-helper-interpreter.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/lib/release-activation/root-helper-interpreter.ts')>();
  return { ...actual, readInstalledRootHelper: vi.fn(() => null) };
});

import * as fs from 'node:fs';
import { createDefaultActivationHost, parseLoadedDomain, parseLoadedJob } from '../../scripts/lib/release-activation/host.ts';
import { acquireActivationLock } from '../../scripts/lib/release-activation/lock.ts';
import { readInstalledRootHelper, ROOT_HELPER_SUDO } from '../../scripts/lib/release-activation/root-helper-interpreter.ts';
import { releaseProcessLock } from '../../src/lib/process-lock.ts';
import { RELEASE_ACTIVATE_EXIT } from '../../scripts/release-activate.ts';
import type { ActivationHost } from '../../scripts/lib/release-activation/host.ts';
import { applyHostUnitActivation } from '../../scripts/lib/release-activation/host-unit-apply.ts';
import { buildHostUnitPlan, parseHostUnitDeclaration } from '../../scripts/lib/release-activation/host-unit-plan.ts';
import { plistDigest, type ActivationContext } from '../../scripts/lib/release-activation/plan.ts';
import { parseHostActivationArgs, RELEASE_ACTIVATE_HOST_EXIT, runReleaseActivateHostCli } from '../../scripts/release-activate-host.ts';
import { parsePlist } from '../../scripts/check-service-units.ts';
import { diagnosticBody, plist, writeRefreshRollbackFence, writeRelease } from '../helpers/release-activate-world.ts';

const DOMAIN = [
  'gui/501 = {',
  '\tservices = {',
  '\t\t   56045      0 \tcom.whatsoup.alpha-line',
  '\t\t       0      0 \tcom.whatsoup.reply-guarantee',
  '\t\t       0   (pe) \tcom.apple.finder',
  '\t}',
  '}',
  '',
].join('\n');

const JOB = [
  'gui/501/com.whatsoup.alpha-line = {',
  '\tpath = /fixture-home/Library/LaunchAgents/com.whatsoup.alpha-line.plist',
  '\ttype = LaunchAgent',
  '\tprogram = /fixture-home/.local/bin/whatsoup',
  '\tstate = running',
  '\tpid = 56045',
  '\truns = 3',
  '\tworking directory = /ignored',
  '\tinherited environment = {',
  '\t\tPATH => redacted',
  '\t}',
  '\targuments = {',
  '\t\t/fixture-home/.local/bin/whatsoup',
  '\t\talpha-line',
  '\t}',
  '}',
  '',
].join('\n');

const OLD = '1'.repeat(40);
const NEXT = '2'.repeat(40);

interface TwoMemberWorld {
  root: string;
  home: string;
  launchAgents: string;
  oldRelease: string;
  newRelease: string;
  link: string;
  directPlist: string;
  firstDb: string;
  secondDb: string;
  contexts: ActivationContext[];
  host: ActivationHost;
  addJob: (label: string, contents: string | Uint8Array) => string;
  calls: string[];
  linkTargetsAtHealth: string[];
  migrate: (which: 'first' | 'second') => void;
  setFailure: (value: 'second-health' | 'second-and-old-health' | 'wrong-pid' | 'host-loaded-mismatch' | 'outside-loaded-mismatch' | 'outside-loaded-program-mismatch' | 'outside-loaded-argv-mismatch' | 'outside-unloaded-113' | 'domain-timeout' | 'migrate-first-before-gate' | 'migrate-second-before-gate' | 'migrate-first-during-quiesce' | 'migrate-second-during-quiesce' | 'unreadable-first-before-gate' | 'unreadable-second-before-gate' | 'unreadable-first-during-quiesce' | 'unreadable-second-during-quiesce' | null) => void;
}

/** A two-member launchd world: first member follows one shared link, second is direct. */
function twoMemberWorld({ sharedFirst = true }: { sharedFirst?: boolean } = {}): TwoMemberWorld {
  const root = mkdtempSync(path.join(os.tmpdir(), 'whatsoup-host-unit-'));
  const home = path.join(root, 'home');
  const oldRelease = path.join(root, 'releases', 'old');
  const newRelease = path.join(root, 'releases', 'new');
  writeRelease(oldRelease, OLD, true); writeRelease(newRelease, NEXT, true);
  const agents = path.join(home, 'Library', 'LaunchAgents'); mkdirSync(agents, { recursive: true });
  const link = path.join(home, '.local', 'bin', 'whatsoup'); mkdirSync(path.dirname(link), { recursive: true }); symlinkSync(path.join(oldRelease, 'deploy', 'whatsoup'), link);
  const firstLabel = 'com.whatsoup.shared'; const secondLabel = 'com.whatsoup.direct';
  const firstPlist = path.join(agents, `${firstLabel}.plist`); const directPlist = path.join(agents, `${secondLabel}.plist`);
  writeFileSync(firstPlist, plist(firstLabel, [sharedFirst ? link : path.join(oldRelease, 'deploy', 'whatsoup'), 'shared'], oldRelease));
  writeFileSync(directPlist, plist(secondLabel, [path.join(oldRelease, 'deploy', 'whatsoup'), 'direct'], oldRelease));
  const dbPath = (name: string, port: number): string => {
    const config = path.join(home, '.config', 'whatsoup', 'instances', name); mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, 'config.json'), JSON.stringify({ healthPort: port }));
    writeFileSync(path.join(config, 'tokens.env'), 'WHATSOUP_HEALTH_TOKEN=private-token\n');
    const file = path.join(home, '.local', 'share', 'whatsoup', 'instances', name, 'bot.db'); mkdirSync(path.dirname(file), { recursive: true }); const db = new DatabaseSync(file);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (7)'); db.close(); return file;
  };
  const firstDb = dbPath('shared', 19001); const secondDb = dbPath('direct', 19002); const backupDir = path.join(root, 'backups');
  const context = (instance: string, label: string, plistPath: string, db: string, port: number, shared: boolean): ActivationContext => ({
    args: { instance, release: newRelease, expectCurrent: oldRelease, auxLabels: [], healthPort: port, backupDir, wrapperLink: link, mode: 'apply', exitTimeoutSeconds: 1, verifyTimeoutSeconds: 1 },
    home, domain: 'gui/501', launchAgentsDir: agents, wrapperLink: link, dbPath: db, healthPort: port, healthToken: 'private-token', newCommit: NEXT, oldCommit: OLD, instanceLabel: label, preconditions: [],
    botErrorsHealthConsumer: null,
    // What planning records for releases without a refresh rollback fence (plan.ts readRefreshRollbackFence).
    refreshRollbackFence: { required: 0, candidateDigest: null, targetCapability: 0, targetDigest: null, targetCompatibleAtPlan: true, candidateDetail: 'no refresh rollback fence (legacy release)', targetDetail: 'no refresh rollback fence (legacy release)' },
    staged: [{ label, role: 'instance', renderer: 'instance-edit', plistPath, installedSha256: plistDigest(readFileSync(plistPath, 'utf8')), staged: plist(label, [shared ? link : path.join(newRelease, 'deploy', 'whatsoup'), instance], newRelease), edits: [], renderDriftLines: 0 }],
  });
  const contexts = [context('shared', firstLabel, firstPlist, firstDb, 19001, sharedFirst), context('direct', secondLabel, directPlist, secondDb, 19002, false)];
  let nextPid = 900;
  let clock = 1_700_000_000_000;
  let rollbackPhase = false;
  let fault: 'second-health' | 'second-and-old-health' | 'wrong-pid' | 'host-loaded-mismatch' | 'outside-loaded-mismatch' | 'outside-loaded-program-mismatch' | 'outside-loaded-argv-mismatch' | 'outside-unloaded-113' | 'domain-timeout' | 'migrate-first-before-gate' | 'migrate-second-before-gate' | 'migrate-first-during-quiesce' | 'migrate-second-during-quiesce' | 'unreadable-first-before-gate' | 'unreadable-second-before-gate' | 'unreadable-first-during-quiesce' | 'unreadable-second-during-quiesce' | null = null;
  const jobs = new Map<string, { pid: number; alive: boolean; plist: string }>([
    [firstLabel, { pid: nextPid++, alive: true, plist: firstPlist }], [secondLabel, { pid: nextPid++, alive: true, plist: directPlist }],
  ]);
  const calls: string[] = [];
  const linkTargetsAtHealth: string[] = [];
  const addJob = (name: string, contents: string | Uint8Array): string => {
    const plistPath = path.join(agents, `${name}.plist`);
    writeFileSync(plistPath, contents);
    jobs.set(name, { pid: nextPid++, alive: true, plist: plistPath });
    return plistPath;
  };
  const migrate = (which: 'first' | 'second') => { const db = new DatabaseSync(which === 'first' ? firstDb : secondDb); db.exec('INSERT OR IGNORE INTO schema_migrations VALUES (8)'); db.close(); };
  const label = (target: string): string => target.slice(target.lastIndexOf('/') + 1);
  const rootFor = (job: { plist: string }): string => {
    const source = readFileSync(job.plist, 'utf8');
    if (source.includes(link)) return path.dirname(path.dirname(readlinkSync(link)));
    return source.includes(newRelease) ? newRelease : oldRelease;
  };
  const host: ActivationHost = {
    platform: 'darwin', uid: 501, now: () => clock, sleep: async (milliseconds) => { clock += milliseconds; }, isProcessAlive: (pid) => [...jobs.values()].some((job) => job.alive && job.pid === pid), toolCommit: async () => 'a'.repeat(40), emitReleaseAlert: async () => ({ status: 0 }),
    fetchHealth: async (port) => {
      linkTargetsAtHealth.push(readlinkSync(link));
      const entry = contexts.find((candidate) => candidate.healthPort === port)!; const job = jobs.get(entry.instanceLabel)!;
      const rootForJob = rootFor(job); const isSecond = entry.instanceLabel === secondLabel;
      if (fault === 'migrate-first-before-gate' && !isSecond && rootForJob === newRelease) migrate('first');
      if (fault === 'migrate-second-before-gate' && isSecond && rootForJob === newRelease) migrate('second');
      if (fault === 'unreadable-first-before-gate' && !isSecond && rootForJob === newRelease) unlinkSync(firstDb);
      if (fault === 'unreadable-second-before-gate' && isSecond && rootForJob === newRelease) unlinkSync(secondDb);
      const pid = fault === 'wrong-pid' && isSecond && rootForJob === newRelease ? job.pid + 1 : job.pid;
      const failedSecond = isSecond && rootForJob === newRelease && ['second-health', 'second-and-old-health', 'migrate-first-before-gate', 'migrate-second-before-gate', 'migrate-first-during-quiesce', 'migrate-second-during-quiesce', 'unreadable-first-before-gate', 'unreadable-second-before-gate', 'unreadable-first-during-quiesce', 'unreadable-second-during-quiesce'].includes(fault ?? '');
      if (failedSecond) rollbackPhase = true;
      const failedOld = fault === 'second-and-old-health' && rootForJob === oldRelease;
      return { status: 200, body: diagnosticBody(rootForJob === newRelease ? NEXT : OLD, !failedSecond && !failedOld, undefined, { pid }) };
    },
    exec: async (file, args, options) => {
      // A work tree at each asked root, at OLD: with --show-toplevel, rev-parse prints that root before HEAD.
      if (file === 'git') return { code: 0, stdout: `${args.includes('--show-toplevel') ? `${args[1]}\n` : ''}${OLD}\n`, stderr: '' };
      if (file === 'plutil') return { code: 0, stdout: '', stderr: '' };
      if (file === 'ps') { const job = [...jobs.values()].find((candidate) => candidate.pid === Number(args[1]) && candidate.alive); return job === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: `node ${rootFor(job)}/src/bootstrap.ts\n`, stderr: '' }; }
      if (file === '/bin/launchctl' && args[0] === 'print' && args[1] === 'gui/501') {
        if (fault === 'domain-timeout') return { code: 0, stdout: '', stderr: '', timedOut: true };
        const services = [...jobs.entries()].map(([name, job]) => `\t\t${job.alive ? job.pid : 0} 0 \t${name}\n`).join('');
        return { code: 0, stdout: `gui/501 = {\n\tservices = {\n${services}\t}\n}\n`, stderr: '' };
      }
      if (file === '/bin/launchctl' && args[0] === 'print') {
        const name = label(args[1]!); const job = jobs.get(name); if (job === undefined || (fault === 'outside-unloaded-113' && name === 'com.google.keystone.agent')) return { code: 113, stdout: '', stderr: '' };
        const definition = parsePlist(readFileSync(job.plist, 'utf8'));
        let program = definition?.programArguments[0] ?? '';
        const argv = definition?.programArguments ?? [];
        if (fault === 'outside-loaded-program-mismatch' && name === 'com.agent365.token-warmer') program = '/bin/false';
        if (fault === 'outside-loaded-argv-mismatch' && name === 'com.agent365.token-warmer') argv.push('--stale');
        const loadedPath = (fault === 'host-loaded-mismatch' && name === 'com.whatsoup.whatsoup-fleet') || (fault === 'outside-loaded-mismatch' && name === 'com.agent365.token-warmer') ? `${job.plist}.stale` : job.plist;
        const workingDirectory = definition?.scalarKeys['WorkingDirectory'];
        return { code: 0, stdout: `gui/501/${name} = {\n\tpath = ${loadedPath}\n\ttype = LaunchAgent\n\tprogram = ${program}\n\tstate = running\n\tpid = ${job.pid}\n${workingDirectory === undefined ? '' : `\tworking directory = ${workingDirectory}\n`}\targuments = {\n${argv.map((entry) => `\t\t${entry}\n`).join('')}\t}\n}\n`, stderr: '' };
      }
      if (file === 'launchctl') {
        const verb = args[0]!; const target = args.at(-1) ?? ''; const name = verb === 'bootstrap' ? path.basename(args[2]!, '.plist') : label(target); const job = jobs.get(name);
        calls.push(`${verb}:${name}`);
        if (verb === 'print') return job?.alive ? { code: 0, stdout: `gui/501/${name} = {\n\tpid = ${job.pid}\n}\n`, stderr: '' } : { code: 113, stdout: '', stderr: '' };
        if (verb === 'bootout') { if (job !== undefined) { job.alive = false; if (rollbackPhase && fault === 'migrate-first-during-quiesce' && name === firstLabel) migrate('first'); if (rollbackPhase && fault === 'migrate-second-during-quiesce' && name === secondLabel) migrate('second'); if (rollbackPhase && fault === 'unreadable-first-during-quiesce' && name === firstLabel) unlinkSync(firstDb); if (rollbackPhase && fault === 'unreadable-second-during-quiesce' && name === secondLabel) unlinkSync(secondDb); } return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'bootstrap') { jobs.set(name, { pid: nextPid++, alive: true, plist: args[2]! }); return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'kickstart') { if (job !== undefined) { job.alive = false; jobs.set(name, { pid: nextPid++, alive: true, plist: job.plist }); } return { code: 0, stdout: '', stderr: '' }; }
      }
      if (file === 'bash' && args[0]?.endsWith('run-with-pinned-node.sh')) return { code: 0, stdout: options?.input ?? '', stderr: '' };
      return { code: 127, stdout: '', stderr: `${file} unsupported` };
    },
  };
  return { root, home, launchAgents: agents, oldRelease, newRelease, link, directPlist, firstDb, secondDb, contexts, host, addJob, calls, linkTargetsAtHealth, migrate, setFailure: (value) => { fault = value; } };
}

async function planTwoMemberWorld(world: TwoMemberWorld): Promise<Awaited<ReturnType<typeof buildHostUnitPlan>>> {
  return planHostUnit(world, { schemaVersion: 1, members: [
    { instance: 'shared', expectCurrent: world.oldRelease, auxLabels: [] },
    { instance: 'direct', expectCurrent: world.oldRelease, auxLabels: [] },
  ] });
}

async function planHostUnit(world: TwoMemberWorld, declaration: unknown): Promise<Awaited<ReturnType<typeof buildHostUnitPlan>>> {
  const unit = path.join(world.root, 'host-unit.json');
  writeFileSync(unit, JSON.stringify(declaration));
  vi.stubEnv('HOME', world.home); vi.stubEnv('XDG_CONFIG_HOME', path.join(world.home, '.config')); vi.stubEnv('XDG_DATA_HOME', path.join(world.home, '.local', 'share'));
  try { return await buildHostUnitPlan(world.host, { unitPath: unit, release: world.newRelease, backupDir: path.join(world.root, 'backups'), mode: 'plan', exitTimeoutSeconds: 1, verifyTimeoutSeconds: 1 }); }
  finally { vi.unstubAllEnvs(); }
}

/** A real repository with one empty commit; its git runs with no inherited GIT_* state and no user or system config. */
function commitRepository(directory: string, message: string): string {
  const env = {
    PATH: process.env['PATH'] ?? '', HOME: directory, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  execFileSync('git', ['-C', directory, 'init', '--quiet', '--initial-branch=main'], { env });
  execFileSync('git', ['-C', directory, 'commit', '--quiet', '--allow-empty', '-m', message], { env });
  return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
}

/** The world's fakes, except git: the real binary, run through the production exec adapter. */
function withRealGit(world: TwoMemberWorld): void {
  const fake = world.host.exec;
  const real = createDefaultActivationHost().exec;
  world.host.exec = (file, args, options) => (file === 'git' ? real(file, args, options) : fake(file, args, options));
}

describe('release:activate-host loaded launchd contract', () => {
  it('accepts only one explicit mode and absolute host operation paths', () => {
    expect(parseHostActivationArgs(['--unit', '/private/unit.json', '--release', '/private/release', '--backup-dir', '/private/backups']))
      .toMatchObject({ mode: 'plan', exitTimeoutSeconds: 60, verifyTimeoutSeconds: 180 });
    expect(() => parseHostActivationArgs(['--unit', 'unit.json', '--release', '/private/release', '--backup-dir', '/private/backups'])).toThrow(/absolute/);
    expect(() => parseHostActivationArgs(['--unit', '/private/unit.json', '--release', '/private/release', '--backup-dir', '/private/backups', '--plan', '--apply'])).toThrow(/mutually exclusive/);
  });

  it('requires explicit unique member and auxiliary ownership', () => {
    expect(parseHostUnitDeclaration({ schemaVersion: 1, members: [
      { instance: 'alpha-line', expectCurrent: '/releases/old-a', auxLabels: [{ label: 'com.whatsoup.reply-guarantee', renderer: 'setup-timer' }] },
      { instance: 'line-a', expectCurrent: '/releases/old-b', auxLabels: [] },
    ] })).not.toBeNull();
    expect(parseHostUnitDeclaration({ schemaVersion: 1, members: [
      { instance: 'alpha-line', expectCurrent: '/releases/old-a', auxLabels: [] },
      { instance: 'alpha-line', expectCurrent: '/releases/old-b', auxLabels: [] },
    ] })).toBeNull();
    expect(parseHostUnitDeclaration({ schemaVersion: 1, members: [
      { instance: 'alpha-line', expectCurrent: '/releases/old-a', auxLabels: [{ label: 'com.whatsoup.line-a', renderer: 'setup-timer' }] },
      { instance: 'line-a', expectCurrent: '/releases/old-b', auxLabels: [] },
    ] })).toBeNull();
  });

  it('accepts selected primary and loaded-but-idle auxiliary services', () => {
    expect(parseLoadedDomain(DOMAIN)).toEqual([
      { label: 'com.whatsoup.alpha-line', pid: 56045, status: '0' },
      { label: 'com.whatsoup.reply-guarantee', pid: 0, status: '0' },
    ]);
  });

  it('retains the one closed external host auxiliary in the accepted domain inventory', () => {
    expect(parseLoadedDomain(DOMAIN.replace('com.apple.finder', 'com.bot-errors.health'))).toEqual(expect.arrayContaining([
      { label: 'com.bot-errors.health', pid: 0, status: '(pe)' },
    ]));
  });

  it('accepts the observed launchd jt status without treating it as readiness', () => {
    expect(parseLoadedDomain(DOMAIN.replace('(pe)', '(jt)'))).toEqual(parseLoadedDomain(DOMAIN));
    expect(parseLoadedDomain(DOMAIN.replace('0      0', '0   (jt)'))).toEqual(expect.arrayContaining([
      { label: 'com.whatsoup.reply-guarantee', pid: 0, status: '(jt)' },
    ]));
    expect(parseLoadedDomain(DOMAIN.replace('(pe)', '(unknown)'))).toBeNull();
  });

  it('fails closed on duplicate, truncated, or malformed services', () => {
    expect(parseLoadedDomain(DOMAIN.replace('com.apple.finder', 'com.whatsoup.alpha-line'))).toBeNull();
    expect(parseLoadedDomain(DOMAIN.replace('\t}', ''))).toBeNull();
    expect(parseLoadedDomain(DOMAIN.replace('56045      0', 'pid = nope'))).toBeNull();
  });

  it('retains only selector-bearing loaded job fields', () => {
    expect(parseLoadedJob(JOB, 'com.whatsoup.alpha-line', 'gui/501')).toEqual({
      label: 'com.whatsoup.alpha-line',
      path: '/fixture-home/Library/LaunchAgents/com.whatsoup.alpha-line.plist',
      type: 'LaunchAgent',
      program: '/fixture-home/.local/bin/whatsoup',
      state: 'running',
      pid: 56045,
      arguments: ['/fixture-home/.local/bin/whatsoup', 'alpha-line'],
      workingDirectory: '/ignored',
      pythonEnvironmentKeys: [],
    });
  });

  it('accepts native jetsam limit metadata while retaining exact selector fields', () => {
    const native = JOB.replace('\truns = 3', '\truns = 3\n\tjetsam memory limit (active) = (unlimited)\n\tjetsam memory limit (inactive) = (unlimited)');
    expect(parseLoadedJob(native, 'com.whatsoup.alpha-line', 'gui/501')).toEqual(parseLoadedJob(JOB, 'com.whatsoup.alpha-line', 'gui/501'));
    expect(parseLoadedJob(native.replace('\tstate = running', '\tstate = running\n\tstate = waiting'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
  });

  it('accepts the observed submitted-job metadata without weakening selector checks', () => {
    const native = JOB.replace('\truns = 3', '\truns = 3\n\tsubmitted job. ignore execute allowed');
    expect(parseLoadedJob(native, 'com.whatsoup.alpha-line', 'gui/501')).toEqual(parseLoadedJob(JOB, 'com.whatsoup.alpha-line', 'gui/501'));
    expect(parseLoadedJob(native.replace('ignore execute allowed', 'ignore execute denied'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
    expect(parseLoadedJob(native.replace('\tstate = running', '\tstate = running\n\tstate = waiting'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
  });

  it('accepts native pid-local endpoint metadata with a closed outer block', () => {
    const endpoints = ['\tpid-local endpoints = {', '\t\t"com.apple.coredrag" = {', '\t\t\tport = 0xa6c2b', '\t\t\tactive = 1', '\t\t}', '\t}'].join('\n');
    const native = JOB.replace('\truns = 3', `\truns = 3\n${endpoints}`);
    expect(parseLoadedJob(native, 'com.whatsoup.alpha-line', 'gui/501')).toEqual(parseLoadedJob(JOB, 'com.whatsoup.alpha-line', 'gui/501'));
    expect(parseLoadedJob(native.replace('pid-local endpoints', 'unknown-endpoints'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
    expect(parseLoadedJob(native.replace(endpoints, endpoints.slice(0, -3)), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
    expect(parseLoadedJob(native.replace('\tprogram = ', '\tprogram = /other\n\tprogram = '), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
  });

  it('refuses malformed, duplicate, or mismatched loaded definitions', () => {
    expect(parseLoadedJob(JOB.replace('gui/501/com.whatsoup.alpha-line = {', 'gui/501/com.whatsoup.other = {'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
    expect(parseLoadedJob(JOB.replace('\tstate = running', '\tstate = running\n\tstate = waiting'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
    expect(parseLoadedJob(JOB.replace('\t\talpha-line', '\t'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
    expect(parseLoadedJob(JOB.replace('\t}\n\targuments', '\targuments'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
  });

  it('retains Python resolution environment names while rejecting duplicate or malformed proof blocks', () => {
    const withEnvironment = JOB.replace('\targuments = {', [
      '\tenvironment = {', '\t\tPYTHONPATH => /untrusted', '\t}', '\targuments = {',
    ].join('\n'));
    expect(parseLoadedJob(withEnvironment, 'com.whatsoup.alpha-line', 'gui/501')).toEqual(expect.objectContaining({
      workingDirectory: '/ignored', pythonEnvironmentKeys: ['PYTHONPATH'],
    }));
    expect(parseLoadedJob(withEnvironment.replace('\tenvironment = {', '\tenvironment = {\n\t}\n\tenvironment = {'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
    expect(parseLoadedJob(withEnvironment.replace('\t\tPYTHONPATH => /untrusted', '\t\tPYTHONPATH'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
    expect(parseLoadedJob(withEnvironment.replace('\t\tPYTHONPATH => /untrusted', '\t\tPATH => first\n\t\tPATH => second'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
    const normalOverride = JOB.replace('\targuments = {', '\tdefault environment = {\n\t\tPATH => default\n\t}\n\targuments = {');
    expect(parseLoadedJob(normalOverride, 'com.whatsoup.alpha-line', 'gui/501')).toEqual(expect.objectContaining({ pythonEnvironmentKeys: [] }));
    expect(parseLoadedJob(withEnvironment.replace('\tworking directory = /ignored', '\tworking directory = /ignored\n\tworking directory = /other'), 'com.whatsoup.alpha-line', 'gui/501')).toBeNull();
  });
});

describe('release:activate-host group transaction', () => {
  it('plans a mixed selector unit and admits a manifestless old checkout only with an exact authenticated Git HEAD', async () => {
    const world = twoMemberWorld();
    unlinkSync(path.join(world.oldRelease, '.whatsoup-release-manifest.json'));
    const plan = await planTwoMemberWorld(world);
    expect(plan.ready).toBe(true);
    expect(plan.document).toMatchObject({ members: expect.arrayContaining([expect.objectContaining({ selectorMode: 'shared-link', oldCommit: OLD }), expect.objectContaining({ selectorMode: 'direct', oldCommit: OLD })]) });
  });

  describe('a manifestless old release resolved by the real git', () => {
    const noHead = (instance: string) => ({ id: `old-commit:${instance}`, ok: false, detail: 'manifestless old release has no exact Git HEAD' });
    const manifestless = (world: TwoMemberWorld): void => {
      unlinkSync(path.join(world.oldRelease, '.whatsoup-release-manifest.json'));
      withRealGit(world);
    };

    it('gives no commit when an inherited GIT_DIR/GIT_WORK_TREE names another repository', async () => {
      const world = twoMemberWorld(); manifestless(world);
      const foreign = path.join(world.root, 'foreign'); mkdirSync(foreign);
      const foreignHead = commitRepository(foreign, 'foreign');
      vi.stubEnv('GIT_DIR', path.join(foreign, '.git')); vi.stubEnv('GIT_WORK_TREE', foreign);
      const plan = await planTwoMemberWorld(world); // its finally unstubs these too
      expect(plan.ready).toBe(false);
      expect(plan.document.preconditions).toEqual(expect.arrayContaining([noHead('shared'), noHead('direct')]));
      expect(JSON.stringify(plan.document)).not.toContain(foreignHead);
    });

    it('gives no commit when the release is nested in another work tree', async () => {
      const world = twoMemberWorld(); manifestless(world);
      const enclosingHead = commitRepository(world.root, 'enclosing');
      const plan = await planTwoMemberWorld(world);
      expect(plan.ready).toBe(false);
      expect(plan.document.preconditions).toEqual(expect.arrayContaining([noHead('shared'), noHead('direct')]));
      expect(JSON.stringify(plan.document)).not.toContain(enclosingHead);
    });

    it('admits the HEAD of the release work tree itself, also under an inherited GIT_DIR/GIT_WORK_TREE', async () => {
      const world = twoMemberWorld(); manifestless(world);
      const releaseHead = commitRepository(world.oldRelease, 'old release');
      const foreign = path.join(world.root, 'foreign'); mkdirSync(foreign);
      commitRepository(foreign, 'foreign');
      // The fabricated old-release health reports the release's own HEAD.
      const fetchHealth = world.host.fetchHealth;
      world.host.fetchHealth = async (port, token) => {
        const response = await fetchHealth(port, token);
        return { ...response, body: response.body.replaceAll(OLD, releaseHead) };
      };
      vi.stubEnv('GIT_DIR', path.join(foreign, '.git')); vi.stubEnv('GIT_WORK_TREE', foreign);
      const plan = await planTwoMemberWorld(world);
      expect(plan.document.preconditions).toEqual(expect.arrayContaining([
        { id: 'old-commit:shared', ok: true, detail: releaseHead },
        { id: 'old-commit:direct', ok: true, detail: releaseHead },
      ]));
      expect(plan.ready).toBe(true);
      expect(plan.document).toMatchObject({ members: [expect.objectContaining({ oldCommit: releaseHead }), expect.objectContaining({ oldCommit: releaseHead })] });
    });
  });

  it('switches and rolls back a direct-only operator launcher that selects a declared old release', async () => {
    const world = twoMemberWorld({ sharedFirst: false }); world.setFailure('second-health');
    const plan = await planTwoMemberWorld(world);
    expect(plan.ready).toBe(true);
    const context = plan.applyContext!;
    expect([...context.sharedLaunchers.entries()]).toContainEqual([world.link, []]);
    const result = await applyHostUnitActivation(world.host, context);
    expect(result.outcome).toBe('rolled-back');
    expect(world.linkTargetsAtHealth).toContain(path.join(world.newRelease, 'deploy', 'whatsoup'));
    expect(readlinkSync(world.link)).toBe(path.join(world.oldRelease, 'deploy', 'whatsoup'));
  });

  it('recognizes a direct-only launcher owned by a later member with a different old root', async () => {
    const world = twoMemberWorld({ sharedFirst: false });
    const alternate = path.join(world.root, 'releases', 'old-direct'); writeRelease(alternate, OLD, true);
    writeFileSync(world.directPlist, plist('com.whatsoup.direct', [path.join(alternate, 'deploy', 'whatsoup'), 'direct'], alternate));
    unlinkSync(world.link); symlinkSync(path.join(alternate, 'deploy', 'whatsoup'), world.link);
    const plan = await planHostUnit(world, { schemaVersion: 1, members: [
      { instance: 'shared', expectCurrent: world.oldRelease, auxLabels: [] },
      { instance: 'direct', expectCurrent: alternate, auxLabels: [] },
    ] });
    expect(plan.ready).toBe(true);
    expect([...plan.applyContext!.sharedLaunchers.entries()]).toContainEqual([world.link, []]);
  });

  it('leaves a direct-only operator launcher outside the transaction when it selects an undeclared root', async () => {
    const world = twoMemberWorld({ sharedFirst: false });
    unlinkSync(world.link); symlinkSync(path.join(world.root, 'undeclared', 'deploy', 'whatsoup'), world.link);
    const plan = await planTwoMemberWorld(world);
    expect(plan.ready).toBe(true);
    expect(plan.applyContext?.sharedLaunchers.has(world.link)).toBe(false);
  });

  it('refuses a direct-only operator launcher that exists but cannot be read as a symlink', async () => {
    const world = twoMemberWorld({ sharedFirst: false });
    unlinkSync(world.link); writeFileSync(world.link, 'not a symlink');
    const plan = await planTwoMemberWorld(world);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `direct-only-launcher:${world.link}`, ok: false }),
    ]));
  });

  it('refuses an installed but unloaded consumer of the selected shared launcher', async () => {
    const world = twoMemberWorld();
    writeFileSync(path.join(world.launchAgents, 'com.whatsoup.rogue.plist'), plist('com.whatsoup.rogue', [world.link, 'rogue'], world.oldRelease));
    const plan = await planTwoMemberWorld(world);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'loaded:com.whatsoup.rogue', ok: false })]));
  });

  // A job retired from the standard (docs/releases/2026-11-20-token-backup-job-retired.md) refuses by name with the
  // files to remove, whether only its plist is left or launchd still has it loaded; never as a missing load.
  it.each([['installed but unloaded', false], ['installed and loaded', true]] as const)('refuses a retired job that is %s, by name, and says to remove it', async (_state, loaded) => {
    const world = twoMemberWorld();
    const label = 'com.whatsoup.ms365-token-backup';
    const contents = plist(label, [path.join(world.home, '.local', 'bin', 'ms365-token-backup')], world.home);
    if (loaded) world.addJob(label, contents); else writeFileSync(path.join(world.launchAgents, `${label}.plist`), contents);
    const plan = await planTwoMemberWorld(world);
    expect(plan.ready).toBe(false);
    const rows = (plan.document.preconditions as Array<{ id: string }>).filter((row) => row.id.endsWith(`:${label}`));
    expect(rows).toEqual([
      expect.objectContaining({ id: `retired:${label}`, ok: false, detail: expect.stringMatching(/retired from the standard.*remove/) }),
    ]);
  });

  it.each([['present', true], ['gone', false]] as const)('names the plist a retired job was loaded from, the canonical plist when %s, and the script', async (_state, canonicalPresent) => {
    const world = twoMemberWorld();
    const label = 'com.whatsoup.ms365-token-backup';
    const script = path.join(world.home, '.local', 'bin', 'ms365-token-backup'); writeFileSync(script, '#!/bin/sh\n');
    const elsewhere = path.join(world.root, 'elsewhere', `${label}.plist`); mkdirSync(path.dirname(elsewhere), { recursive: true });
    writeFileSync(elsewhere, plist(label, [script], world.home));
    const canonical = world.addJob(label, plist(label, [script], world.home));
    if (!canonicalPresent) unlinkSync(canonical);
    const fake = world.host.exec;
    const loaded = `gui/501/${label} = {\n\tpath = ${elsewhere}\n\ttype = LaunchAgent\n\tprogram = ${script}\n\tstate = running\n\tpid = 4242\n\targuments = {\n\t\t${script}\n\t}\n}\n`;
    world.host.exec = (file, args, options) => (file === '/bin/launchctl' && args[0] === 'print' && args[1] === `gui/501/${label}` ? Promise.resolve({ code: 0, stdout: loaded, stderr: '' }) : fake(file, args, options));
    const plan = await planTwoMemberWorld(world);
    const rows = (plan.document.preconditions as Array<{ id: string; ok: boolean; detail: string }>).filter((row) => row.id.endsWith(`:${label}`));
    expect(rows.map((row) => [row.id, row.ok])).toEqual([[`retired:${label}`, false]]);
    expect(rows[0]!.detail).toContain(`boot the job out (loaded from ${elsewhere})`);
    expect(rows[0]!.detail).toContain(script);
    expect(rows[0]!.detail.includes(canonical)).toBe(canonicalPresent);
  });

  it('checks a configured instance that owns the retired name as an instance, never as the retired job', async () => {
    const world = twoMemberWorld();
    const label = 'com.whatsoup.ms365-token-backup';
    const config = path.join(world.home, '.config', 'whatsoup', 'instances', 'ms365-token-backup'); mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, 'config.json'), JSON.stringify({ healthPort: 19003 }));
    writeFileSync(path.join(world.launchAgents, `${label}.plist`), plist(label, [world.link, 'ms365-token-backup'], world.oldRelease));
    const plan = await planTwoMemberWorld(world);
    const ids = (plan.document.preconditions as Array<{ id: string }>).map((row) => row.id).filter((id) => id.endsWith(`:${label}`));
    expect(ids).not.toContain(`retired:${label}`);
    expect(ids).toContain(`loaded:${label}`);
  });

  const retiredRows = async (world: TwoMemberWorld): Promise<Array<{ id: string; detail: string }>> =>
    ((await planTwoMemberWorld(world)).document.preconditions as Array<{ id: string; detail: string }>).filter((row) => row.id.endsWith(':com.whatsoup.ms365-token-backup'));

  it('says only to boot out a loaded retired job whose plist and script are gone and whose load path is unread', async () => {
    const world = twoMemberWorld();
    const label = 'com.whatsoup.ms365-token-backup';
    unlinkSync(world.addJob(label, plist(label, [path.join(world.home, '.local', 'bin', 'ms365-token-backup')], world.home)));
    const fake = world.host.exec;
    world.host.exec = (file, args, options) => (file === '/bin/launchctl' && args[0] === 'print' && args[1] === `gui/501/${label}` ? Promise.resolve({ code: 113, stdout: '', stderr: '' }) : fake(file, args, options));
    expect((await retiredRows(world)).map((row) => [row.id, row.detail])).toEqual([[`retired:${label}`, 'retired from the standard; boot the job out; no plist or script is left to remove']]);
  });

  it('gives no retired row for a plist with the retired file name whose Label is another job', async () => {
    const world = twoMemberWorld();
    writeFileSync(path.join(world.launchAgents, 'com.whatsoup.ms365-token-backup.plist'), plist('com.example.other', ['/usr/bin/true'], world.home));
    const ids = (await retiredRows(world)).map((row) => row.id);
    expect(ids).not.toContain('retired:com.whatsoup.ms365-token-backup');
    expect(ids).toContain('installed:com.whatsoup.ms365-token-backup');
  });

  it('does not take a directory named config.json as an instance owning the retired name', async () => {
    const world = twoMemberWorld();
    mkdirSync(path.join(world.home, '.config', 'whatsoup', 'instances', 'ms365-token-backup', 'config.json'), { recursive: true });
    writeFileSync(path.join(world.launchAgents, 'com.whatsoup.ms365-token-backup.plist'), plist('com.whatsoup.ms365-token-backup', ['/usr/bin/true'], world.home));
    expect((await retiredRows(world)).map((row) => row.id)).toEqual(['retired:com.whatsoup.ms365-token-backup']);
  });

  it('refuses an external-label installed consumer of a member old release before any mutation', async () => {
    const world = twoMemberWorld();
    writeFileSync(path.join(world.launchAgents, 'com.bot-errors.health.plist'), plist('com.bot-errors.health', ['/bin/bash', `${world.oldRelease}/deploy/scripts/health-reader.sh`], world.oldRelease));
    const plan = await planTwoMemberWorld(world);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'unowned-consumer:com.bot-errors.health', ok: false })]));
  });

  it('does not prove bot-errors absent from a timed-out domain inventory', async () => {
    const world = twoMemberWorld(); world.setFailure('domain-timeout');
    const plan = await planTwoMemberWorld(world);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'loaded-domain', ok: false }),
      expect.objectContaining({ id: 'closed-host-aux-declared:com.bot-errors.health', ok: false, detail: expect.stringContaining('unproven') }),
    ]));
  });

  it('admits an unrelated non-shell installed job that proves it cannot consume a selected root or launcher', async () => {
    const world = twoMemberWorld();
    writeFileSync(path.join(world.launchAgents, 'com.rustdesk.agent.plist'), plist('com.rustdesk.agent', ['/Applications/RustDesk.app/Contents/MacOS/RustDesk', '--service'], '/Applications/RustDesk.app'));
    const plan = await planTwoMemberWorld(world);
    expect(plan.ready).toBe(true);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'unowned-selector:com.rustdesk.agent', ok: true })]));
  });

  it('refuses a duplicate discovered health port before mutation', async () => {
    const world = twoMemberWorld();
    writeFileSync(path.join(world.home, '.config', 'whatsoup', 'instances', 'direct', 'config.json'), JSON.stringify({ healthPort: 19001 }));
    const plan = await planTwoMemberWorld(world);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'unique-health-ports', ok: false })]));
  });

  it.each(['inline-interpreter', 'selected-working-directory'] as const)('refuses an undeclared %s dependency', async (kind) => {
    const world = twoMemberWorld();
    const argv = kind === 'inline-interpreter'
      ? ['/usr/bin/python3', '-c', `import runpy; runpy.run_path('${world.oldRelease}/worker.py')`]
      : ['/usr/bin/true'];
    writeFileSync(path.join(world.launchAgents, 'com.example.dependent.plist'),
      plist('com.example.dependent', argv, world.oldRelease));
    const plan = await planTwoMemberWorld(world);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'unowned-selector:com.example.dependent', ok: false }),
    ]));
  });

  // A lost receipt does not change the live activation, so the exit code stays the outcome's, as in
  // release:activate, and stderr names the failure. Each outcome comes after this run created its
  // backup directory, so each one writes a receipt.
  const receiptLoss: Array<{ outcome: string; code: number; arrange: (world: TwoMemberWorld) => void }> = [
    { outcome: 'activated', code: RELEASE_ACTIVATE_HOST_EXIT.ok, arrange: () => undefined },
    { outcome: 'rolled-back', code: RELEASE_ACTIVATE_HOST_EXIT.rolledBack, arrange: (world) => world.setFailure('second-health') },
    { outcome: 'refused', code: RELEASE_ACTIVATE_HOST_EXIT.refused, arrange: (world) => {
      // Apply lints each staged plist inside its new backup directory; planning never runs plutil.
      const exec = world.host.exec;
      world.host.exec = (file, args, options) => (file === 'plutil' ? Promise.resolve({ code: 1, stdout: '', stderr: '' }) : exec(file, args, options));
    } },
    { outcome: 'rollback-unverified', code: RELEASE_ACTIVATE_HOST_EXIT.rollbackUnverified, arrange: (world) => {
      // The old release fails its health from the switch's first stop on, after planning read it healthy.
      const exec = world.host.exec;
      world.host.exec = (file, args, options) => {
        if (file === 'launchctl' && args[0] === 'bootout') world.setFailure('second-and-old-health');
        return exec(file, args, options);
      };
    } },
    { outcome: 'rollback-blocked-migrated', code: RELEASE_ACTIVATE_HOST_EXIT.rollbackBlockedMigrated, arrange: (world) => world.setFailure('migrate-second-before-gate') },
    { outcome: 'rollback-blocked-refresh-fence', code: RELEASE_ACTIVATE_HOST_EXIT.rollbackBlockedRefreshFence, arrange: (world) => {
      writeRefreshRollbackFence(world.newRelease, { requirement: 3, capability: 3 });
      writeRefreshRollbackFence(world.oldRelease, { requirement: 1, capability: 1 });
      world.setFailure('second-health');
    } },
  ];
  it.each(receiptLoss)('keeps exit $code for a $outcome outcome whose private receipt cannot be written', async ({ outcome, code, arrange }) => {
    const world = twoMemberWorld();
    await planTwoMemberWorld(world); // writes the declaration
    arrange(world);
    receiptFault.fail = true;
    let stdout = ''; let stderr = '';
    vi.stubEnv('HOME', world.home); vi.stubEnv('XDG_CONFIG_HOME', path.join(world.home, '.config')); vi.stubEnv('XDG_DATA_HOME', path.join(world.home, '.local', 'share'));
    try {
      const exit = await runReleaseActivateHostCli(['--unit', path.join(world.root, 'host-unit.json'), '--release', world.newRelease, '--backup-dir', path.join(world.root, 'backups'), '--apply'], world.host, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
      expect(exit).toBe(code);
    } finally { vi.unstubAllEnvs(); receiptFault.fail = false; }
    expect(stderr).toBe('release:activate-host: receipt-write-failed ENOSPC\n');
    const receipt = JSON.parse(stdout) as { outcome: { outcome: string; backupPath: string | null } };
    expect(receipt.outcome.outcome).toBe(outcome);
    expect(receipt.outcome.backupPath).not.toBeNull();
    expect(existsSync(path.join(receipt.outcome.backupPath!, 'receipt.json'))).toBe(false);
  });

  it('refuses a backup path another run already created and leaves that run\'s receipt byte-identical', async () => {
    const world = twoMemberWorld();
    await planTwoMemberWorld(world); // writes the declaration
    world.host.now = () => 1_700_000_000_000;
    const backups = path.join(world.root, 'backups');
    // This run's backup path at that clock (2023-11-14T22:13:20Z), created by an earlier run in the same second.
    const collision = path.join(backups, `activation-host-${NEXT.slice(0, 12)}-20231114T221320Z`);
    mkdirSync(collision, { recursive: true, mode: 0o700 }); chmodSync(backups, 0o700);
    const priorReceipt = `${JSON.stringify({ mode: 'apply', outcome: { outcome: 'activated' } }, null, 2)}\n`;
    writeFileSync(path.join(collision, 'receipt.json'), priorReceipt, { mode: 0o600 });
    let stdout = '';
    vi.stubEnv('HOME', world.home); vi.stubEnv('XDG_CONFIG_HOME', path.join(world.home, '.config')); vi.stubEnv('XDG_DATA_HOME', path.join(world.home, '.local', 'share'));
    try {
      const code = await runReleaseActivateHostCli(['--unit', path.join(world.root, 'host-unit.json'), '--release', world.newRelease, '--backup-dir', backups, '--apply'], world.host, { stdout: (text) => { stdout += text; }, stderr: () => undefined });
      expect(code).toBe(RELEASE_ACTIVATE_HOST_EXIT.refused);
    } finally { vi.unstubAllEnvs(); }
    expect(JSON.parse(stdout)).toMatchObject({ outcome: { outcome: 'refused', backupPath: null } });
    expect(readFileSync(path.join(collision, 'receipt.json'), 'utf8')).toBe(priorReceipt);
    expect(readdirSync(backups)).toEqual([path.basename(collision)]);
    expect(readlinkSync(world.link)).toBe(path.join(world.oldRelease, 'deploy', 'whatsoup'));
    expect(world.calls).toEqual([]);
  });

  it('refuses, before any write, a release-drift auxiliary declared under another instance\'s label', async () => {
    const world = twoMemberWorld();
    const foreign = 'com.whatsoup.line-a';
    // A configured instance outside the member set whose primary job runs the old release directly.
    const config = path.join(world.home, '.config', 'whatsoup', 'instances', 'line-a'); mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, 'config.json'), JSON.stringify({ healthPort: 19003 }));
    const foreignPlist = world.addJob(foreign, plist(foreign, [path.join(world.oldRelease, 'deploy', 'whatsoup'), 'line-a'], world.oldRelease));
    const foreignBefore = readFileSync(foreignPlist, 'utf8');
    // The release-drift renderer renders its own fixed label, whatever label it is declared under.
    const fake = world.host.exec;
    world.host.exec = (file, args, options) => (file === 'bash' && args[0]?.endsWith('render-release-drift-launchd.sh')
      ? Promise.resolve({ code: 0, stdout: plist('com.whatsoup.release-drift-check', ['/bin/bash', `${world.newRelease}/deploy/scripts/run-release-drift-schedule.sh`, '--instance', 'direct'], world.newRelease), stderr: '' })
      : fake(file, args, options));
    const plan = await planHostUnit(world, { schemaVersion: 1, members: [
      { instance: 'shared', expectCurrent: world.oldRelease, auxLabels: [] },
      { instance: 'direct', expectCurrent: world.oldRelease, auxLabels: [{ label: foreign, renderer: 'release-drift' }] },
    ] });
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `direct:aux-plist-staged:${foreign}`, ok: false, detail: 'rendered plist Label is not the declared auxiliary label' }),
      expect.objectContaining({ id: `member-aux-not-instance:${foreign}`, ok: false }),
    ]));
    let stdout = '';
    vi.stubEnv('HOME', world.home); vi.stubEnv('XDG_CONFIG_HOME', path.join(world.home, '.config')); vi.stubEnv('XDG_DATA_HOME', path.join(world.home, '.local', 'share'));
    try {
      const code = await runReleaseActivateHostCli(['--unit', path.join(world.root, 'host-unit.json'), '--release', world.newRelease, '--backup-dir', path.join(world.root, 'backups'), '--apply'], world.host, { stdout: (text) => { stdout += text; }, stderr: () => undefined });
      expect(code).toBe(RELEASE_ACTIVATE_HOST_EXIT.refused);
    } finally { vi.unstubAllEnvs(); }
    expect(JSON.parse(stdout)).toMatchObject({ ready: false, outcome: 'refused' });
    expect(readFileSync(foreignPlist, 'utf8')).toBe(foreignBefore);
    expect(existsSync(path.join(world.root, 'backups'))).toBe(false);
    expect(world.calls).toEqual([]);
  });

  it('switches a shared selector once and a direct selector in the same successful transaction', async () => {
    const world = twoMemberWorld();
    const result = await applyHostUnitActivation(world.host, { release: world.newRelease, commit: NEXT, backupDir: path.join(world.root, 'backups'), members: world.contexts, sharedLaunchers: new Map([[world.link, ['shared']]]) });
    expect(result.outcome).toBe('activated');
    expect(readlinkSync(world.link)).toBe(path.join(world.newRelease, 'deploy', 'whatsoup'));
    expect(readFileSync(world.directPlist, 'utf8')).toContain(path.join(world.newRelease, 'deploy', 'whatsoup'));
    expect(result.members.map((member) => member.databaseBackup?.quickCheck)).toEqual(['ok', 'ok']);
  });

  it.each(['second-health', 'wrong-pid'] as const)('rolls every selector back when %s rejects the second member', async (fault) => {
    const world = twoMemberWorld(); world.setFailure(fault);
    const result = await applyHostUnitActivation(world.host, { release: world.newRelease, commit: NEXT, backupDir: path.join(world.root, 'backups'), members: world.contexts, sharedLaunchers: new Map([[world.link, ['shared']]]) });
    expect(result.outcome).toBe('rolled-back');
    expect(readlinkSync(world.link)).toBe(path.join(world.oldRelease, 'deploy', 'whatsoup'));
    expect(readFileSync(world.directPlist, 'utf8')).toContain(path.join(world.oldRelease, 'deploy', 'whatsoup'));
    expect(result.schemaGates.map((gate) => ({ stage: gate.stage, members: gate.members.map((member) => member.instance).sort() }))).toEqual([
      { stage: 'before-rollback', members: ['direct', 'shared'] },
      { stage: 'after-quiesce', members: ['direct', 'shared'] },
    ]);
  });

  it.each(['migrate-first-before-gate', 'migrate-second-before-gate', 'migrate-first-during-quiesce', 'migrate-second-during-quiesce', 'unreadable-first-before-gate', 'unreadable-second-before-gate', 'unreadable-first-during-quiesce', 'unreadable-second-during-quiesce'] as const)('blocks every restoration when schema migration occurs %s', async (fault) => {
    const world = twoMemberWorld(); world.setFailure(fault);
    const result = await applyHostUnitActivation(world.host, { release: world.newRelease, commit: NEXT, backupDir: path.join(world.root, 'backups'), members: world.contexts, sharedLaunchers: new Map([[world.link, ['shared']]]) });
    expect(result.outcome).toBe('rollback-blocked-migrated');
    expect(readlinkSync(world.link)).toBe(path.join(world.newRelease, 'deploy', 'whatsoup'));
    expect(readFileSync(world.directPlist, 'utf8')).toContain(path.join(world.newRelease, 'deploy', 'whatsoup'));
    expect(result.schemaGates.map((gate) => ({ stage: gate.stage, members: gate.members.map((member) => member.instance).sort() }))).toEqual(fault.includes('during')
      ? [{ stage: 'before-rollback', members: ['direct', 'shared'] }, { stage: 'after-quiesce', members: ['direct', 'shared'] }]
      : [{ stage: 'before-rollback', members: ['direct', 'shared'] }]);
    expect(result.schemaGates.some((gate) => gate.members.some((member) => member.changed))).toBe(true);
  });
});

describe('release:activate-host keeps release:activate single-apply guards', () => {
  const actualFs = vi.importActual<typeof import('node:fs')>('node:fs');
  const oldWrapper = (world: TwoMemberWorld): string => path.join(world.oldRelease, 'deploy', 'whatsoup');
  const newWrapper = (world: TwoMemberWorld): string => path.join(world.newRelease, 'deploy', 'whatsoup');
  const apply = (world: TwoMemberWorld, host: ActivationHost = world.host) => applyHostUnitActivation(host, {
    release: world.newRelease, commit: NEXT, backupDir: path.join(world.root, 'backups'), members: world.contexts, sharedLaunchers: new Map([[world.link, ['shared']]]),
  });
  const liveMutations = (world: TwoMemberWorld): string[] => world.calls.filter((call) => /^(bootout|bootstrap|kickstart):/.test(call));
  /** lstat reports `target` as root-owned; every other path is unchanged. */
  const reportRootOwned = async (target: string): Promise<void> => {
    const real = (await actualFs).lstatSync;
    vi.mocked(fs.lstatSync).mockImplementation(((file: fs.PathLike, options?: fs.StatSyncOptions) => {
      const stats = real(file, options);
      if (stats === undefined || String(file) !== target) return stats;
      return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as fs.Stats, stats, { uid: 0 });
    }) as typeof fs.lstatSync);
  };
  /** The installed helper matches the pin; the fake sudo answers each run in turn, writing the requested bytes only when told to. */
  const withFakeSudo = async (world: TwoMemberWorld, replies: Array<{ code: number; write: boolean; timedOut?: true }>): Promise<{ host: ActivationHost; runs: () => number }> => {
    const helper = (await actualFs).readFileSync(path.join(import.meta.dirname, '../../scripts/lib/release-activation/protected_plist.py'));
    vi.mocked(readInstalledRootHelper).mockReturnValue(helper);
    let runs = 0;
    return {
      runs: () => runs,
      host: {
        ...world.host,
        exec: async (file, args, options) => {
          if (file !== ROOT_HELPER_SUDO) return world.host.exec(file, args, options);
          const reply = replies[runs++] ?? { code: 0, write: true };
          const request = JSON.parse(options?.input ?? '{}') as { path: string; contents: string };
          if (reply.write) writeFileSync(request.path, request.contents);
          return { code: reply.code, stdout: '', stderr: '', ...(reply.timedOut ? { timedOut: true as const } : {}) };
        },
      },
    };
  };
  afterEach(async () => {
    vi.mocked(fs.lstatSync).mockImplementation((await actualFs).lstatSync);
    vi.mocked(readInstalledRootHelper).mockReturnValue(null);
  });

  it('uses the release:activate exit codes, including 5 for a fence-blocked rollback', () => {
    expect(RELEASE_ACTIVATE_HOST_EXIT).toEqual(RELEASE_ACTIVATE_EXIT);
    expect(RELEASE_ACTIVATE_HOST_EXIT.rollbackBlockedRefreshFence).toBe(5);
  });

  it('refuses before any effect while another activation holds the activation lock', async () => {
    const world = twoMemberWorld();
    const directBefore = readFileSync(world.directPlist, 'utf8');
    const holder = acquireActivationLock(world.home);
    let result;
    try { result = await apply(world); } finally { releaseProcessLock(holder); }
    expect(result.outcome).toBe('refused');
    expect(result.steps).toEqual([expect.objectContaining({ step: 'acquire-activation-lock', ok: false })]);
    expect(result.backupPath).toBeNull();
    expect(existsSync(path.join(world.root, 'backups'))).toBe(false);
    expect(readlinkSync(world.link)).toBe(oldWrapper(world));
    expect(readFileSync(world.directPlist, 'utf8')).toBe(directBefore);
    expect(world.calls).toEqual([]);
  });

  it('refuses before the switch when the candidate refresh fence changed after planning', async () => {
    const world = twoMemberWorld();
    const directBefore = readFileSync(world.directPlist, 'utf8');
    writeRefreshRollbackFence(world.newRelease, { requirement: 3, capability: 3 });
    const result = await apply(world);
    expect(result.outcome).toBe('refused');
    expect(result.failure).toBe('refresh rollback fence requirement changed or cannot be revalidated before switch');
    expect(readlinkSync(world.link)).toBe(oldWrapper(world));
    expect(readFileSync(world.directPlist, 'utf8')).toBe(directBefore);
    expect(liveMutations(world)).toEqual([]);
  });

  it('blocks the group rollback with exit 5 when the old release lacks the candidate refresh fence', async () => {
    const world = twoMemberWorld();
    writeRefreshRollbackFence(world.newRelease, { requirement: 3, capability: 3 });
    writeRefreshRollbackFence(world.oldRelease, { requirement: 1, capability: 1 });
    expect((await planTwoMemberWorld(world)).ready).toBe(true);
    world.setFailure('second-health');
    let stdout = '';
    vi.stubEnv('HOME', world.home); vi.stubEnv('XDG_CONFIG_HOME', path.join(world.home, '.config')); vi.stubEnv('XDG_DATA_HOME', path.join(world.home, '.local', 'share'));
    let code: number;
    try {
      code = await runReleaseActivateHostCli(['--unit', path.join(world.root, 'host-unit.json'), '--release', world.newRelease, '--backup-dir', path.join(world.root, 'backups'), '--apply'], world.host, { stdout: (text) => { stdout += text; }, stderr: () => {} });
    } finally { vi.unstubAllEnvs(); }
    expect(code).toBe(5);
    const receipt = JSON.parse(stdout) as { outcome: { outcome: string; rollback: { steps: Array<{ step: string; ok: boolean }> } } };
    expect(receipt.outcome.outcome).toBe('rollback-blocked-refresh-fence');
    expect(receipt.outcome.rollback.steps).toContainEqual(expect.objectContaining({ step: 'recheck-refresh-rollback-fence-before-instance-stop:shared', ok: false }));
    // The old release was never restored or restarted: no member was stopped for rollback.
    expect(readlinkSync(world.link)).toBe(newWrapper(world));
    expect(readFileSync(world.directPlist, 'utf8')).toContain(newWrapper(world));
    expect(receipt.outcome.rollback.steps.some((step) => step.step.startsWith('stop:'))).toBe(false);
  });

  it('refuses and installs nothing when a plist changed after planning', async () => {
    const world = twoMemberWorld();
    const foreign = readFileSync(world.directPlist, 'utf8').replace('</plist>', '<!-- edited after planning -->\n</plist>');
    writeFileSync(world.directPlist, foreign);
    const result = await apply(world);
    expect(result.outcome).toBe('refused');
    expect(result.failure).toBe('com.whatsoup.direct: installed plist changed outside this activation');
    expect(readFileSync(world.directPlist, 'utf8')).toBe(foreign);
    expect(readlinkSync(world.link)).toBe(oldWrapper(world));
    expect(liveMutations(world)).toEqual([]);
  });

  it.each([
    { kind: 'grants group or other access', failure: 'backup directory grants group or other access', prepare: (dir: string) => { mkdirSync(dir); chmodSync(dir, 0o755); } },
    { kind: 'is a symlink to a private directory', failure: 'backup directory is a symlink or not a directory', prepare: (dir: string) => { mkdirSync(`${dir}-target`, { mode: 0o700 }); chmodSync(`${dir}-target`, 0o700); symlinkSync(`${dir}-target`, dir); } },
  ])('refuses an existing final backup directory that $kind before any effect', async ({ failure, prepare }) => {
    const world = twoMemberWorld();
    const backupDir = path.join(world.root, 'backups');
    prepare(backupDir);
    const directBefore = readFileSync(world.directPlist, 'utf8');
    const result = await apply(world);
    expect(result.outcome).toBe('refused');
    expect(result.failure).toBe(failure);
    expect(result.backupPath).toBeNull();
    expect(readdirSync(backupDir)).toEqual([]);
    expect(readlinkSync(world.link)).toBe(oldWrapper(world));
    expect(readFileSync(world.directPlist, 'utf8')).toBe(directBefore);
    expect(liveMutations(world)).toEqual([]);
  });

  it('accepts an existing current-user private final backup directory', async () => {
    const world = twoMemberWorld();
    const backupDir = path.join(world.root, 'backups');
    mkdirSync(backupDir, { mode: 0o700 }); chmodSync(backupDir, 0o700);
    const result = await apply(world);
    expect(result.outcome).toBe('activated');
    expect(path.dirname(result.backupPath!)).toBe(backupDir);
  });

  it('plans only with an absent or current-user private final backup directory', async () => {
    const world = twoMemberWorld();
    const backupDir = path.join(world.root, 'backups');
    expect((await planTwoMemberWorld(world)).ready).toBe(true);
    mkdirSync(backupDir); chmodSync(backupDir, 0o755);
    const open = await planTwoMemberWorld(world);
    expect(open.ready).toBe(false);
    expect(open.document.preconditions).toEqual(expect.arrayContaining([
      { id: 'shared:backup-dir-private-owned', ok: false, detail: 'backup directory grants group or other access' },
      { id: 'direct:backup-dir-private-owned', ok: false, detail: 'backup directory grants group or other access' },
    ]));
    chmodSync(backupDir, 0o700);
    expect((await planTwoMemberWorld(world)).ready).toBe(true);
  });

  it('refuses before the switch when a root-owned plist has no current root helper', async () => {
    const world = twoMemberWorld();
    const directBefore = readFileSync(world.directPlist, 'utf8');
    await reportRootOwned(world.directPlist);
    const result = await apply(world);
    expect(result.outcome).toBe('refused');
    expect(result.steps).toContainEqual(expect.objectContaining({ step: 'check-root-plist-helper', ok: false }));
    expect(readlinkSync(world.link)).toBe(oldWrapper(world));
    expect(readFileSync(world.directPlist, 'utf8')).toBe(directBefore);
    expect(liveMutations(world)).toEqual([]);
  });

  it('ends rollback-unverified, never rolled-back, when the root helper times out during the switch', async () => {
    const world = twoMemberWorld();
    await reportRootOwned(world.directPlist);
    // The helper times out without writing: the plist keeps its original bytes, but uchg may be gone.
    const { host, runs } = await withFakeSudo(world, [{ code: 127, write: false, timedOut: true }]);
    const result = await apply(world, host);
    expect(runs()).toBe(1);
    expect(result.outcome).toBe('rollback-unverified');
    expect(result.rollback?.verified).toBe(false);
    expect(result.rollback?.steps).toContainEqual(expect.objectContaining({ step: 'confirm-plist-protection', ok: false }));
  });

  it('ends rollback-unverified when the root helper times out while restoring a plist', async () => {
    const world = twoMemberWorld(); world.setFailure('second-health');
    await reportRootOwned(world.directPlist);
    const { host, runs } = await withFakeSudo(world, [{ code: 0, write: true }, { code: 127, write: false, timedOut: true }]);
    const result = await apply(world, host);
    expect(runs()).toBe(2);
    expect(result.outcome).toBe('rollback-unverified');
    expect(result.rollback?.verified).toBe(false);
  });
});

describe('release:activate-host reviewed outside-unit declarations', () => {
  const digest = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;
  const members = (world: TwoMemberWorld) => [
    { instance: 'shared', expectCurrent: world.oldRelease, auxLabels: [] },
    { instance: 'direct', expectCurrent: world.oldRelease, auxLabels: [] },
  ];
  const reviewedInterpreter = (world: TwoMemberWorld, { runtimeData = false }: { runtimeData?: boolean } = {}) => {
    const label = 'com.agent365.token-warmer';
    const script = path.join(world.root, 'outside', 'token-warmer.py');
    mkdirSync(path.dirname(script), { recursive: true }); writeFileSync(script, 'print("warm")\n');
    const dataDirectory = path.join(world.root, 'runtime', 'agent365');
    const dataPath = path.join(dataDirectory, 'token-warmer.db');
    const source = plist(label, runtimeData ? ['/usr/bin/python3', '-I', script, dataDirectory, dataPath, '--select', 'default'] : ['/usr/bin/python3', '-I', script, '--select', 'default'], path.dirname(script));
    const plistPath = world.addJob(label, source);
    const declaration = {
      schemaVersion: 3,
      members: members(world),
      hostAuxiliaries: [],
      outsideUnits: [{
        label,
        plistSha256: digest(source),
        loadState: 'loaded',
        reviewInputs: {
          roots: [world.newRelease, world.oldRelease].sort(),
          links: [world.link],
          files: [{ path: script, sha256: digest(readFileSync(script, 'utf8')) }],
          argumentBindings: runtimeData
            ? [{ index: 2, path: script, kind: 'review-file' }, { index: 3, path: dataDirectory, kind: 'runtime-data' }, { index: 4, path: dataPath, kind: 'runtime-data' }]
            : [{ index: 2, path: script, kind: 'review-file' }],
        },
      }],
    };
    return { label, script, dataDirectory, dataPath, source, plistPath, declaration };
  };
  const reviewedPythonModule = (world: TwoMemberWorld) => {
    const label = 'com.operations.dashboard';
    const workingDirectory = path.join(world.root, 'outside', 'operations-dashboard');
    const packageDirectory = path.join(workingDirectory, 'app');
    const init = path.join(packageDirectory, '__init__.py');
    const module = path.join(packageDirectory, 'watchdog.py');
    mkdirSync(packageDirectory, { recursive: true }); writeFileSync(init, ''); writeFileSync(module, 'print("watch")\n');
    const source = plist(label, [path.join(workingDirectory, 'venv', 'bin', 'python'), '-m', 'app.watchdog'], workingDirectory);
    const plistPath = world.addJob(label, source);
    const files = [init, module].sort().map((file) => ({ path: file, sha256: digest(readFileSync(file, 'utf8')) }));
    const declaration = {
      schemaVersion: 3,
      members: members(world),
      hostAuxiliaries: [],
      outsideUnits: [{
        label,
        plistSha256: digest(source),
        loadState: 'loaded',
        reviewInputs: {
          roots: [world.newRelease, world.oldRelease].sort(),
          links: [world.link],
          files,
          argumentBindings: [],
        },
      }],
    };
    return { label, workingDirectory, init, module, source, plistPath, declaration };
  };

  it('admits only a v3 exact reviewed declaration for an unrelated loaded interpreter job', async () => {
    const world = twoMemberWorld(); const outside = reviewedInterpreter(world);
    const plan = await planHostUnit(world, outside.declaration);
    expect(plan.ready).toBe(true);
    expect(plan.document.outsideUnits).toEqual([expect.objectContaining({ label: outside.label, plistDigest: digest(outside.source), reviewTupleSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) })]);
    expect(parseHostUnitDeclaration({ ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], reviewInputs: { ...outside.declaration.outsideUnits[0].reviewInputs, files: [] } }] })).not.toBeNull();
    const missingSource = await planHostUnit(world, { ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], reviewInputs: { ...outside.declaration.outsideUnits[0].reviewInputs, files: [] } }] });
    expect(missingSource.ready).toBe(false);
    expect(missingSource.document.preconditions).toEqual(expect.arrayContaining([expect.objectContaining({ id: `outside-unit:${outside.label}`, ok: false, detail: expect.stringContaining('no reviewed source') })]));
    expect(parseHostUnitDeclaration({ ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], label: 'com.whatsoup.unowned' }] })).toBeNull();
  });

  it('admits declared generated runtime-data paths while refusing omitted or source-misclassified bindings', async () => {
    const world = twoMemberWorld(); const outside = reviewedInterpreter(world, { runtimeData: true });
    mkdirSync(outside.dataDirectory, { recursive: true });
    expect((await planHostUnit(world, outside.declaration)).ready).toBe(true);
    const omitted = { ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], reviewInputs: { ...outside.declaration.outsideUnits[0].reviewInputs, argumentBindings: [outside.declaration.outsideUnits[0].reviewInputs.argumentBindings[0]] } }] };
    const misclassified = { ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], reviewInputs: { ...outside.declaration.outsideUnits[0].reviewInputs, argumentBindings: [{ ...outside.declaration.outsideUnits[0].reviewInputs.argumentBindings[0], kind: 'runtime-data' }, outside.declaration.outsideUnits[0].reviewInputs.argumentBindings[1], outside.declaration.outsideUnits[0].reviewInputs.argumentBindings[2]] } }] };
    for (const declaration of [omitted, misclassified]) {
      const plan = await planHostUnit(world, declaration);
      expect(plan.ready).toBe(false);
      expect(plan.document.preconditions).toEqual(expect.arrayContaining([expect.objectContaining({ id: `outside-unit:${outside.label}`, ok: false })]));
    }
    const target = path.join(world.oldRelease, 'deploy', 'runtime-data.db');
    mkdirSync(path.dirname(outside.dataPath), { recursive: true }); writeFileSync(target, 'runtime-data\n'); symlinkSync(target, outside.dataPath);
    const escaped = await planHostUnit(world, outside.declaration);
    expect(escaped.ready).toBe(false);
    expect(escaped.document.preconditions).toEqual(expect.arrayContaining([expect.objectContaining({ id: `outside-unit:${outside.label}`, ok: false })]));
    unlinkSync(outside.dataPath);
    symlinkSync(path.join(world.oldRelease, 'deploy', 'not-yet-created'), outside.dataPath);
    const danglingEscape = await planHostUnit(world, outside.declaration);
    expect(danglingEscape.ready).toBe(false);
    expect(danglingEscape.document.preconditions).toEqual(expect.arrayContaining([expect.objectContaining({ id: `outside-unit:${outside.label}`, ok: false })]));
  });

  it('refuses an initially unreviewed Python module form', async () => {
    const world = twoMemberWorld(); const outside = reviewedInterpreter(world);
    const source = plist(outside.label, ['/usr/bin/python3', '-m', 'agent365.token_warmer'], path.dirname(outside.script));
    writeFileSync(outside.plistPath, source);
    const declaration = { ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], plistSha256: digest(source), reviewInputs: { ...outside.declaration.outsideUnits[0].reviewInputs, argumentBindings: [] } }] };
    const plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([expect.objectContaining({ id: `outside-unit:${outside.label}`, ok: false })]));
  });

  it('admits only a reviewed Python -m module with exact cwd and package inputs', async () => {
    const world = twoMemberWorld(); const outside = reviewedPythonModule(world);
    expect((await planHostUnit(world, outside.declaration)).ready).toBe(true);

    const missingInit = { ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], reviewInputs: { ...outside.declaration.outsideUnits[0].reviewInputs, files: outside.declaration.outsideUnits[0].reviewInputs.files.filter((file) => file.path !== outside.init) } }] };
    expect((await planHostUnit(world, missingInit)).ready).toBe(false);

    for (const source of [
      outside.source.replace('  <key>WorkingDirectory</key>', `  <key>WorkingDirectory</key>\n  <string>${outside.workingDirectory}</string>\n  <key>WorkingDirectory</key>`),
      outside.source.replace(`  <key>WorkingDirectory</key>\n  <string>${outside.workingDirectory}</string>`, '  <key>WorkingDirectory</key>\n  <true/>'),
    ]) {
      writeFileSync(outside.plistPath, source);
      const declaration = { ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], plistSha256: digest(source) }] };
      expect((await planHostUnit(world, declaration)).ready).toBe(false);
    }
    writeFileSync(outside.plistPath, outside.source);

    const selectedModule = path.join(world.oldRelease, 'deploy', 'selected-module.py');
    writeFileSync(selectedModule, 'print("watch")\n'); unlinkSync(outside.module); symlinkSync(selectedModule, outside.module);
    expect((await planHostUnit(world, outside.declaration)).ready).toBe(false);
    unlinkSync(outside.module); writeFileSync(outside.module, 'print("watch")\n');

    for (const argv of [
      [path.join(outside.workingDirectory, 'venv', 'bin', 'python'), '-m', 'app'],
      [path.join(outside.workingDirectory, 'venv', 'bin', 'python'), '-m', 'app.watchdog', '--once'],
    ]) {
      const source = plist(outside.label, argv, outside.workingDirectory);
      writeFileSync(outside.plistPath, source);
      const declaration = { ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], plistSha256: digest(source) }] };
      expect((await planHostUnit(world, declaration)).ready).toBe(false);
    }
  });

  it('refuses Python module cwd and environment resolution drift', async () => {
    const world = twoMemberWorld(); const outside = reviewedPythonModule(world);
    const installedPythonEnv = outside.source.replace('  <key>WorkingDirectory</key>', [
      '  <key>EnvironmentVariables</key>', '  <dict><key>PYTHONPATH</key><string>/untrusted</string></dict>', '  <key>WorkingDirectory</key>',
    ].join('\n'));
    writeFileSync(outside.plistPath, installedPythonEnv);
    const installedEnvDeclaration = { ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], plistSha256: digest(installedPythonEnv) }] };
    expect((await planHostUnit(world, installedEnvDeclaration)).ready).toBe(false);

    writeFileSync(outside.plistPath, outside.source);
    const baseExec = world.host.exec;
    world.host.exec = async (file, args, options) => {
      const result = await baseExec(file, args, options);
      if (file !== '/bin/launchctl' || args[0] !== 'print' || args[1] !== `gui/501/${outside.label}` || result.code !== 0) return result;
      return { ...result, stdout: result.stdout.replace('\targuments = {', '\tenvironment = {\n\t\tPYTHONHOME => /untrusted\n\t}\n\targuments = {') };
    };
    expect((await planHostUnit(world, outside.declaration)).ready).toBe(false);

    world.host.exec = async (file, args, options) => {
      const result = await baseExec(file, args, options);
      if (file !== '/bin/launchctl' || args[0] !== 'print' || args[1] !== `gui/501/${outside.label}` || result.code !== 0) return result;
      return { ...result, stdout: result.stdout.replace(`\tworking directory = ${outside.workingDirectory}`, '\tworking directory = /outside/mismatch') };
    };
    expect((await planHostUnit(world, outside.declaration)).ready).toBe(false);
  });

  it('admits a digest-pinned opaque shell command only with reviewed source inputs', async () => {
    const world = twoMemberWorld(); const outside = reviewedInterpreter(world);
    const source = plist(outside.label, ['/bin/zsh', '-lc', 'exec dreammachine-client'], path.dirname(outside.script));
    writeFileSync(outside.plistPath, source);
    const declaration = { ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], plistSha256: digest(source), reviewInputs: { ...outside.declaration.outsideUnits[0].reviewInputs, argumentBindings: [] } }] };
    expect((await planHostUnit(world, declaration)).ready).toBe(true);
    const withoutSource = { ...declaration, outsideUnits: [{ ...declaration.outsideUnits[0], reviewInputs: { ...declaration.outsideUnits[0].reviewInputs, files: [] } }] };
    expect((await planHostUnit(world, withoutSource)).ready).toBe(false);
  });

  it('refuses an outside declaration when any selected root or launcher cannot resolve', async () => {
    const world = twoMemberWorld(); const outside = reviewedInterpreter(world);
    const missingRoot = path.join(world.root, 'missing-selected-root');
    const declaration = {
      ...outside.declaration,
      hostAuxiliaries: [{ label: 'com.bot-errors.health', mode: 'path-rebase', expectCurrent: missingRoot }],
      outsideUnits: [{ ...outside.declaration.outsideUnits[0], reviewInputs: { ...outside.declaration.outsideUnits[0].reviewInputs, roots: [world.newRelease, world.oldRelease, missingRoot].sort() } }],
    };
    const plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `outside-unit:${outside.label}`, ok: false, detail: expect.stringContaining('selected root or launcher unavailable') }),
    ]));
  });

  it.each(['missing-review-file', 'plist-digest-drift', 'raw-selected-root', 'symlink-into-selected-root'] as const)('refuses %s without treating a reviewed outside job as a generic exception', async (fault) => {
    const world = twoMemberWorld(); const outside = reviewedInterpreter(world);
    if (fault === 'missing-review-file') unlinkSync(outside.script);
    if (fault === 'plist-digest-drift') writeFileSync(outside.plistPath, outside.source.replace('default', 'changed'));
    if (fault === 'raw-selected-root') writeFileSync(outside.plistPath, outside.source.replace('</dict>', `  <key>OpaqueRef</key>\n  <string>${world.oldRelease}/hidden</string>\n</dict>`));
    if (fault === 'symlink-into-selected-root') {
      const target = path.join(world.oldRelease, 'deploy', 'review-input.py');
      writeFileSync(target, 'print("warm")\n'); unlinkSync(outside.script); symlinkSync(target, outside.script);
    }
    const plan = await planHostUnit(world, outside.declaration);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `outside-unit:${outside.label}`, ok: false }),
    ]));
  });

  it.each(['outside-loaded-mismatch', 'outside-loaded-program-mismatch', 'outside-loaded-argv-mismatch'] as const)('requires exact loaded path, program, and argv when %s occurs', async (fault) => {
    const world = twoMemberWorld(); const outside = reviewedInterpreter(world); world.setFailure(fault);
    const plan = await planHostUnit(world, outside.declaration);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `outside-unit:${outside.label}`, ok: false, detail: expect.stringContaining('loaded definition differs') }),
    ]));
  });

  it('admits a digest-pinned empty plist stub only when launchctl returns its explicit bounded 113 state', async () => {
    const world = twoMemberWorld(); const label = 'com.google.keystone.agent';
    const source = ''; world.addJob(label, source); world.setFailure('outside-unloaded-113');
    const declaration = {
      schemaVersion: 3, members: members(world), hostAuxiliaries: [], outsideUnits: [{
        label, plistSha256: digest(source), loadState: 'unloaded-113',
        reviewInputs: { roots: [world.newRelease, world.oldRelease].sort(), links: [world.link], files: [], argumentBindings: [] },
      }],
    };
    expect((await planHostUnit(world, declaration)).ready).toBe(true);
  });

  // A non-empty plist left in ~/Library/LaunchAgents can load at the next login, so only the stub skips review.
  it.each([
    { name: 'an interpreter plist', args: ['/usr/bin/python3', '/tmp/evil.py'] },
    { name: 'a non-interpreter plist', args: ['/opt/example/bin/agent', '--run'] },
  ])('refuses $name under unloaded-113 before reading launchd', async ({ args }) => {
    const world = twoMemberWorld(); const label = 'com.google.keystone.agent';
    const source = plist(label, args, path.join(world.root, 'outside')); world.addJob(label, source); world.setFailure('outside-unloaded-113');
    const printed: string[] = []; const baseExec = world.host.exec;
    world.host.exec = async (file, execArgs, options) => {
      if (file === '/bin/launchctl' && execArgs[1] === `gui/501/${label}`) printed.push(execArgs.join(' '));
      return baseExec(file, execArgs, options);
    };
    const declaration = {
      schemaVersion: 3, members: members(world), hostAuxiliaries: [], outsideUnits: [{
        label, plistSha256: digest(source), loadState: 'unloaded-113',
        reviewInputs: { roots: [world.newRelease, world.oldRelease].sort(), links: [world.link], files: [], argumentBindings: [] },
      }],
    };
    const plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      { id: `outside-unit:${label}`, ok: false, detail: 'unloaded-113 plist is not a zero-byte stub' },
    ]));
    expect(printed).toEqual([]);
  });

  it('rejects an XML-escaped reference to a selected host launcher', async () => {
    const world = twoMemberWorld(); const outside = reviewedInterpreter(world);
    writeFileSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    writeFileSync(path.join(world.newRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    const fleetLink = path.join(world.home, '.local', 'bin', 'whatsoup&fleet');
    symlinkSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), fleetLink);
    const fleetLabel = 'com.whatsoup.whatsoup-fleet'; world.addJob(fleetLabel, plist(fleetLabel, [fleetLink, '9099'], world.oldRelease));
    const source = outside.source.replace('</dict>', `  <key>OpaqueRef</key>\n  <string>${fleetLink.replaceAll('&', '&amp;')}</string>\n</dict>`);
    writeFileSync(outside.plistPath, source);
    const declaration = {
      ...outside.declaration,
      hostAuxiliaries: [{ label: fleetLabel, mode: 'fleet-wrapper', expectCurrent: world.oldRelease, link: fleetLink }],
      outsideUnits: [{ ...outside.declaration.outsideUnits[0], plistSha256: digest(source), reviewInputs: { ...outside.declaration.outsideUnits[0].reviewInputs, links: [world.link, fleetLink].sort() } }],
    };
    const plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `outside-unit:${outside.label}`, ok: false, detail: expect.stringContaining('selected root or launcher') }),
    ]));
  });

  it('rechecks the exact reviewed tuple before its first filesystem or launchd mutation', async () => {
    const world = twoMemberWorld(); const outside = reviewedInterpreter(world);
    const plan = await planHostUnit(world, outside.declaration);
    expect(plan.ready).toBe(true);
    writeFileSync(outside.plistPath, outside.source.replace('default', 'changed'));
    const result = await applyHostUnitActivation(world.host, plan.applyContext!);
    expect(result.outcome).toBe('refused');
    expect(result.backupPath).toBeNull();
    expect(world.calls).toEqual([]);
    expect(readlinkSync(world.link)).toBe(path.join(world.oldRelease, 'deploy', 'whatsoup'));
    expect(readFileSync(world.directPlist, 'utf8')).toContain(path.join(world.oldRelease, 'deploy', 'whatsoup'));
  });

  it('rechecks reviewed Python module sources before its first mutation', async () => {
    const world = twoMemberWorld(); const outside = reviewedPythonModule(world);
    const plan = await planHostUnit(world, outside.declaration);
    expect(plan.ready).toBe(true);
    writeFileSync(outside.module, 'print("changed")\n');
    const result = await applyHostUnitActivation(world.host, plan.applyContext!);
    expect(result.outcome).toBe('refused');
    expect(result.backupPath).toBeNull();
    expect(world.calls).toEqual([]);
  });

  it('reads an outside plist strictly, so a character reference cannot hide a Python environment key', async () => {
    const world = twoMemberWorld(); const outside = reviewedPythonModule(world);
    const source = outside.source.replace('  <key>WorkingDirectory</key>',
      '  <key>EnvironmentVariable&#115;</key>\n  <dict><key>PYTHONPATH</key><string>/opt/example/lib</string></dict>\n  <key>WorkingDirectory</key>');
    writeFileSync(outside.plistPath, source);
    const plan = await planHostUnit(world, { ...outside.declaration, outsideUnits: [{ ...outside.declaration.outsideUnits[0], plistSha256: digest(source) }] });
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      { id: `outside-unit:${outside.label}`, ok: false, detail: 'installed loaded plist is unreadable: plist holds a numeric character reference' },
    ]));
  });

  it('retains the normalized reviewed tuple digest in the plan and successful apply receipt', async () => {
    const world = twoMemberWorld(); const outside = reviewedInterpreter(world);
    const plan = await planHostUnit(world, outside.declaration);
    const plannedDigest = (plan.document.outsideUnits as Array<{ reviewTupleSha256: string }>)[0]!.reviewTupleSha256;
    let stdout = ''; let stderr = '';
    vi.stubEnv('HOME', world.home); vi.stubEnv('XDG_CONFIG_HOME', path.join(world.home, '.config')); vi.stubEnv('XDG_DATA_HOME', path.join(world.home, '.local', 'share'));
    try {
      const code = await runReleaseActivateHostCli(['--unit', path.join(world.root, 'host-unit.json'), '--release', world.newRelease, '--backup-dir', path.join(world.root, 'backups'), '--apply'], world.host, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
      expect(code).toBe(RELEASE_ACTIVATE_HOST_EXIT.ok);
    } finally { vi.unstubAllEnvs(); }
    expect(stderr).toBe('');
    const receipt = JSON.parse(stdout) as { outsideUnits: Array<{ reviewTupleSha256: string }>; outcome: { backupPath: string } };
    expect(receipt.outsideUnits[0]?.reviewTupleSha256).toBe(plannedDigest);
    expect(JSON.parse(readFileSync(path.join(receipt.outcome.backupPath, 'receipt.json'), 'utf8')).outsideUnits[0].reviewTupleSha256).toBe(plannedDigest);
  });
});

describe('release:activate-host closed host auxiliaries', () => {
  const members = (world: TwoMemberWorld) => [
    { instance: 'shared', expectCurrent: world.oldRelease, auxLabels: [] },
    { instance: 'direct', expectCurrent: world.oldRelease, auxLabels: [] },
  ];

  it('admits only explicit host auxiliary modes and ownership', () => {
    expect(parseHostUnitDeclaration({ schemaVersion: 2, members: [
      { instance: 'alpha-line', expectCurrent: '/releases/old-a', auxLabels: [] },
    ], hostAuxiliaries: [
      { label: 'com.bot-errors.health', mode: 'path-rebase', expectCurrent: '/checkout' },
      { label: 'com.whatsoup.harness-maintenance', mode: 'setup-timer', expectCurrent: '/checkout' },
      { label: 'com.whatsoup.whatsoup-fleet', mode: 'fleet-wrapper', expectCurrent: '/checkout', link: '/fixture/.local/bin/whatsoup-fleet' },
      { label: 'com.whatsoup.alpha-line-watchdog', mode: 'quiesce' },
    ] })).not.toBeNull();
    expect(parseHostUnitDeclaration({ schemaVersion: 2, members: [
      { instance: 'alpha-line', expectCurrent: '/releases/old-a', auxLabels: [] },
    ], hostAuxiliaries: [
      { label: 'com.bot-errors.health', mode: 'path-rebase', expectCurrent: '/checkout', hiddenSelector: '/unchecked' },
    ] })).toBeNull();
  });

  // Path-rebase admits four closed contracts: the BOT ERRORS installer form and legacy wrapper, and the two legacy
  // timers. Each refusal names its reason; any other health-job shape names the reinstall route.
  const BOT_ERRORS = 'com.bot-errors.health';
  const MAINTENANCE = 'com.whatsoup.harness-maintenance';
  const REPLY = 'com.whatsoup.reply-guarantee';
  const HEALTH_SHAPE = 'bot-errors health job is neither the installer form nor the legacy wrapper; reinstall it with deploy/scripts/install-bot-errors-health-launchd.sh or deploy/scripts/install-bot-errors-launchd.sh';
  const rootKey = (key: string): string => `plist root key ${key} is not admitted for a path-rebase job`;
  const pathRebaseWorld = (label = BOT_ERRORS) => {
    const world = twoMemberWorld();
    const checkout = path.join(world.root, 'checkout'); writeRelease(checkout, OLD, true);
    return { world, checkout, declaration: { schemaVersion: 2, members: members(world), hostAuxiliaries: [{ label, mode: 'path-rebase', expectCurrent: checkout }] } };
  };
  /** Insert plist lines before WorkingDirectory. */
  const withLines = (source: string, ...lines: string[]): string => source.replace('  <key>WorkingDirectory</key>', [...lines, '  <key>WorkingDirectory</key>'].join('\n'));
  const environment = (...entries: string[]): string[] => ['  <key>EnvironmentVariables</key>', `  <dict>${entries.join('')}</dict>`];
  /** The argv both BOT ERRORS installers write by default (deploy/scripts/install-bot-errors-health-launchd.sh, install-bot-errors-launchd.sh). */
  const installerArgs = (root: string, home: string, python = '/usr/bin/python3'): string[] => [
    python, `${root}/deploy/scripts/bot-errors-runner.py`, '--instance', 'bot-errors-health', '--source', 'service-exit', '--summary', 'BOT ERRORS daily health command failed',
    '--log-hint', `${home}/.local/state/bot-errors/logs/health.err.log`, '--diagnostic', `launchd_label=${BOT_ERRORS}`, '--', python, `${root}/deploy/scripts/bot-errors-health-check.py`, '--daily',
  ];
  const installerForm = (root: string, home: string, python?: string): string => withLines(plist(BOT_ERRORS, installerArgs(root, home, python), root), ...environment(
    `<key>PATH</key><string>${home}/.local/bin:/usr/bin:/bin</string>`, `<key>BOT_ERRORS_STATE_DIR</key><string>${home}/.local/state/bot-errors</string>`,
    `<key>BOT_ERRORS_HEALTH_PROFILE</key><string>${root}/deploy/health-profiles/host-a.json</string>`,
  ));
  /** The reviewed legacy wrapper shell; its profile default names a profile below the selected root. */
  const legacyShell = (root: string, home: string): string => [
    `BOT_ERRORS_ENV_FILE=${home}/.config/whatsoup/bot-errors.env; export BOT_ERRORS_ENV_FILE; `,
    'if [[ ! -r "$BOT_ERRORS_ENV_FILE" ]]; then printf "%s\\n" "missing BOT_ERRORS_ENV_FILE=$BOT_ERRORS_ENV_FILE" >/dev/stderr; exit 64; fi; ',
    'set -a; source "$BOT_ERRORS_ENV_FILE"; set +a; ',
    'if [[ -z "${BOT_ERRORS_JID:-}" ]]; then printf "%s\\n" "missing BOT_ERRORS_JID in $BOT_ERRORS_ENV_FILE" >/dev/stderr; exit 65; fi; ',
    'if [[ -z "${BOT_ERRORS_EXPECTED_JID:-}" ]]; then printf "%s\\n" "missing BOT_ERRORS_EXPECTED_JID in $BOT_ERRORS_ENV_FILE" >/dev/stderr; exit 65; fi; ',
    'if [[ "$BOT_ERRORS_JID" != *@g.us ]]; then printf "%s\\n" "BOT_ERRORS_JID must be a WhatsApp group JID" >/dev/stderr; exit 65; fi; ',
    'if [[ "$BOT_ERRORS_JID" != "$BOT_ERRORS_EXPECTED_JID" ]]; then printf "%s\\n" "BOT_ERRORS_JID does not match BOT_ERRORS_EXPECTED_JID" >/dev/stderr; exit 65; fi; ',
    `if [[ -z "\${BOT_ERRORS_STATE_DIR:-}" ]]; then export BOT_ERRORS_STATE_DIR=${home}/.local/state/bot-errors; fi; `,
    'if [[ -z "${BOT_ERRORS_HEALTH_PROFILE:-}" ]]; then export BOT_ERRORS_HEALTH_PROFILE=', `${root}/deploy/health-profiles/edge9.json`, '; fi;  exec "$@"',
  ].join('');
  const legacyWrapper = (root: string, home: string, ...environmentEntries: string[]): string => plist(BOT_ERRORS, [
    '/bin/bash', '-c', legacyShell(root, home), 'bot-errors-health', '/usr/bin/python3', `${root}/deploy/scripts/bot-errors-runner.py`,
    '--instance', 'bot-errors-health', '--source', 'service-exit', '--summary', 'BOT ERRORS daily health command failed',
    '--log-hint', `${home}/.local/state/bot-errors/logs/health.err.log`, '--diagnostic', 'launchd_label=com.bot-errors.health',
    '--', '/usr/bin/python3', `${root}/deploy/scripts/bot-errors-health-check.py`, '--daily',
  ], root).replace('  <key>WorkingDirectory</key>', [
    ...environment(...(environmentEntries.length > 0 ? environmentEntries : ['<key>BOT_ERRORS_DB</key><string>preserve-me</string>'])),
    '  <key>StartCalendarInterval</key>', '  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>20</integer></dict>',
    '  <key>WorkingDirectory</key>',
  ].join('\n'));
  const timerLines = (interval: number): string[] => ['  <key>RunAtLoad</key>', '  <true/>', '  <key>StartInterval</key>', `  <integer>${interval}</integer>`, '  <key>KeepAlive</key>', '  <false/>'];
  const maintenanceForm = (root: string, home: string, ...lines: string[]): string => withLines(plist(MAINTENANCE, [
    '/bin/bash', `${home}/.local/libexec/fleet-reauth/maint-ccd-guard.sh`, '/bin/bash', `${root}/deploy/scripts/harness-maintenance.sh`,
  ], root), ...timerLines(3600), ...lines);
  const replyForm = (root: string, home: string, ...lines: string[]): string => withLines(plist(REPLY, [
    `${home}/.nvm/versions/node/v24.15.0/bin/node`, `${root}/deploy/hooks/drain-stuck-replies.mjs`, '--once',
  ], root), ...timerLines(300), ...lines);
  type HostUnitPlanResult = Awaited<ReturnType<typeof buildHostUnitPlan>>;
  const stagedFor = (plan: HostUnitPlanResult, label: string): string =>
    (plan.applyContext as unknown as { hostAuxiliaries: Array<{ label: string; staged: string }> }).hostAuxiliaries.find((entry) => entry.label === label)!.staged;
  type Build = (root: string, home: string, world: TwoMemberWorld) => string | Uint8Array;
  /** Plan one path-rebase job, declared at a fresh checkout, whose installed plist `build` writes. */
  const planWith = async (label: string, build: Build) => {
    const { world, checkout, declaration } = pathRebaseWorld(label);
    world.addJob(label, build(checkout, world.home, world));
    return { world, checkout, plan: await planHostUnit(world, declaration) };
  };
  const expectStaged = (plan: HostUnitPlanResult, label: string, detail: string): void => {
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([{ id: `host-aux-plist-staged:${label}`, ok: false, detail }]));
  };

  it('stages a declared bot-errors checkout outside every member root without losing its fields', async () => {
    const { world, checkout, declaration } = pathRebaseWorld();
    const sibling = `${checkout}-cache/log`;
    const source = withLines(installerForm(checkout, world.home), '  <key>StandardOutPath</key>', `  <string>${sibling}</string>`, '  <key>StandardErrorPath</key>', '  <string>preserve-me</string>');
    world.addJob(BOT_ERRORS, source);
    const plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(true);
    const staged = stagedFor(plan, BOT_ERRORS);
    expect(staged).toContain('preserve-me');
    expect(staged).toContain(sibling);
    expect(staged).toContain(world.newRelease);
    expect(staged).not.toContain(`${checkout}/`);

    const wrongRoot = await planHostUnit(world, { ...declaration, hostAuxiliaries: [{ label: BOT_ERRORS, mode: 'path-rebase', expectCurrent: `${checkout}-other` }] });
    expect(wrongRoot.ready).toBe(false);
    expect(wrongRoot.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `host-aux-on-expected-release:${BOT_ERRORS}`, ok: false }),
    ]));

    world.addJob(BOT_ERRORS, source.replace('preserve-me', `cd ${checkout} &amp;&amp; run`));
    expectStaged(await planHostUnit(world, declaration), BOT_ERRORS, 'expected-current root is embedded in a non-path string value');
  });

  // A python3 file this user owns: isTrustedHealthPython admits it, so only the /usr/bin/python3 pin refuses it.
  const ownedPython = (file: string): string => {
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, '', { mode: 0o700 });
    return file;
  };
  it.each<{ name: string; build: Build }>([
    { name: 'a direct script at [0]', build: (root) => plist(BOT_ERRORS, [`${root}/deploy/scripts/bot-errors-health-check.py`, '--daily'], root) },
    { name: 'the short runner form', build: (root) => plist(BOT_ERRORS, ['/usr/bin/python3', `${root}/deploy/scripts/bot-errors-runner.py`, '--daily'], root) },
    { name: '/bin/sh running a release script', build: (root) => plist(BOT_ERRORS, ['/bin/sh', `${root}/deploy/scripts/bot-errors-health.sh`], root) },
    { name: '/bin/bash running a release script', build: (root) => plist(BOT_ERRORS, ['/bin/bash', `${root}/deploy/scripts/bot-errors-health-check.py`], root) },
    { name: 'a bash -c command that starts with the root', build: (root) => plist(BOT_ERRORS, ['/bin/bash', '-c', `${root}/deploy/scripts/bot-errors-health-check.py --daily`], root) },
    { name: 'a bash -c command that is a bare root path', build: (root) => plist(BOT_ERRORS, ['/bin/bash', '-c', `${root}/deploy/scripts/bot-errors-health-check.py`], root) },
    { name: 'an in-release Python with the installer suffix', build: (root, home) => installerForm(root, home, ownedPython(`${root}/venv/bin/python3`)) },
    { name: 'another trusted python3 with the installer suffix', build: (root, home, world) => installerForm(root, home, ownedPython(`${world.root}/bin/python3`)) },
    { name: 'the installer form under a case variant of the declared root', build: (root, home) => installerForm(path.join(path.dirname(root), path.basename(root).toUpperCase()), home) },
    { name: 'the installer form with WorkingDirectory below the root', build: (root, home) => installerForm(root, home).replace(`<string>${root}</string>`, `<string>${root}/deploy</string>`) },
    { name: 'the installer form with a non-default log hint', build: (root, home) => installerForm(root, home).replace(`${home}/.local/state/bot-errors/logs/health.err.log`, `${home}/.local/state/other/logs/health.err.log`) },
  ])('refuses the health job as $name, naming the reinstall route', async ({ build }) => {
    expectStaged((await planWith(BOT_ERRORS, build)).plan, BOT_ERRORS, HEALTH_SHAPE);
  });

  const contracts: Array<{ name: string; label: string; build: (root: string, home: string) => string; first: (home: string) => string }> = [
    { name: 'the installer form', label: BOT_ERRORS, build: (root, home) => installerForm(root, home), first: () => '/usr/bin/python3' },
    { name: 'the legacy wrapper', label: BOT_ERRORS, build: (root, home) => legacyWrapper(root, home), first: () => '/bin/bash' },
    { name: 'harness maintenance', label: MAINTENANCE, build: (root, home) => maintenanceForm(root, home), first: () => '/bin/bash' },
    { name: 'reply guarantee', label: REPLY, build: (root, home) => replyForm(root, home), first: (home) => `${home}/.nvm/versions/node/v24.15.0/bin/node` },
  ];
  it.each(contracts.flatMap((contract) => [
    { ...contract, which: 'equal to ProgramArguments[0]', program: contract.first },
    { ...contract, which: 'naming another program', program: () => '/opt/example/bin/other' },
  ]))('refuses a Program key $which in $name while the loaded definition still matches', async ({ label, build, program }) => {
    const { plan } = await planWith(label, (root, home) => withLines(build(root, home), '  <key>Program</key>', `  <string>${program(home)}</string>`));
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([{ id: `host-aux-installed-loaded-match:${label}`, ok: true, detail: 'exact path/program/arguments' }]));
    expectStaged(plan, label, rootKey('Program'));
  });

  it.each([
    { key: 'UserName', value: '<string>root</string>' },
    { key: 'EnableGlobbing', value: '<true/>' },
    { key: 'BundleProgram', value: '<string>/opt/example/bin/other</string>' },
  ])('refuses the root key $key, naming it', async ({ key, value }) => {
    expectStaged((await planWith(BOT_ERRORS, (root, home) => withLines(installerForm(root, home), `  <key>${key}</key>`, `  ${value}`))).plan, BOT_ERRORS, rootKey(key));
  });

  it.each(['DYLD_INSERT_LIBRARIES', '__PYVENV_LAUNCHER__', 'SHELLOPTS', 'PS4', 'BASH_ENV', 'HOME', 'UNRELATED', 'CLAUDE_CONFIG_DIR', 'X.Y-Z'].flatMap((key) => [
    { key, form: 'the installer form', build: (root: string, home: string) => withLines(plist(BOT_ERRORS, installerArgs(root, home), root), ...environment('<key>PATH</key><string>/usr/bin:/bin</string>', `<key>${key}</key><string>/opt/example/lib</string>`)) },
    { key, form: 'the legacy wrapper', build: (root: string, home: string) => legacyWrapper(root, home, `<key>${key}</key><string>/opt/example/lib</string>`) },
  ]))('refuses the environment key $key in $form, naming it', async ({ key, build }) => {
    expectStaged((await planWith(BOT_ERRORS, build)).plan, BOT_ERRORS, `environment key ${key} is not admitted for ${BOT_ERRORS}`);
  });

  // Names only: each timer admits exactly the keys the repository's render writes for that job (deploy/setup.sh through
  // scripts/launchd-claude-config-env.ts), and no key of another contract.
  it.each([
    { label: MAINTENANCE, build: maintenanceForm, keys: ['PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'], refused: 'BOT_ERRORS_DB' },
    { label: REPLY, build: replyForm, keys: ['PATH', 'CLAUDE_CONFIG_DIR'], refused: 'CLAUDE_SECURESTORAGE_CONFIG_DIR' },
  ])('admits only the environment keys the repository writes for $label', async ({ label, build, keys, refused }) => {
    const entries = keys.map((key) => `<key>${key}</key><string>/opt/example/${key.toLowerCase()}</string>`);
    expect((await planWith(label, (root, home) => build(root, home, ...environment(...entries)))).plan.ready).toBe(true);
    expectStaged((await planWith(label, (root, home) => build(root, home, ...environment(...entries, `<key>${refused}</key><string>/opt/example/x</string>`)))).plan,
      label, `environment key ${refused} is not admitted for ${label}`);
  });

  // The startup keys of the interpreter each timer runs: /bin/bash for harness maintenance, node for reply guarantee.
  it.each([
    { label: MAINTENANCE, build: maintenanceForm, key: 'BASH_ENV' },
    { label: MAINTENANCE, build: maintenanceForm, key: 'SHELLOPTS' },
    { label: REPLY, build: replyForm, key: 'NODE_OPTIONS' },
  ])('refuses the environment key $key for $label, naming it', async ({ label, build, key }) => {
    expectStaged((await planWith(label, (root, home) => build(root, home, ...environment(`<key>${key}</key><string>/opt/example/x</string>`)))).plan,
      label, `environment key ${key} is not admitted for ${label}`);
  });

  // A key may print only in the bounded identifier form, so a key that holds a path never reaches plan output.
  const KEY_MARKER = '/opt/example/key-marker';
  const KEY_NOT_SHOWN = '(a name outside [A-Za-z_][A-Za-z0-9_.-]{0,63}, not shown)';
  const withEnvironmentEntry = (entry: string): Build => (root, home) => withLines(plist(BOT_ERRORS, installerArgs(root, home), root), ...environment('<key>PATH</key><string>/usr/bin:/bin</string>', entry));
  it.each<{ name: string; build: Build; detail: string }>([
    { name: 'a root key', build: (root, home) => withLines(installerForm(root, home), `  <key>${KEY_MARKER}</key>`, '  <string>x</string>'), detail: rootKey(KEY_NOT_SHOWN) },
    { name: 'an environment key', build: withEnvironmentEntry(`<key>${KEY_MARKER}</key><string>x</string>`), detail: `environment key ${KEY_NOT_SHOWN} is not admitted for ${BOT_ERRORS}` },
    { name: 'an environment key whose value is not a <string>', build: withEnvironmentEntry(`<key>${KEY_MARKER}</key><integer>1</integer>`), detail: `plist EnvironmentVariables value for ${KEY_NOT_SHOWN} is not a <string>` },
    { name: 'a duplicate root key', build: (root, home) => withLines(installerForm(root, home), `  <key>${KEY_MARKER}</key>`, '  <string>x</string>', `  <key>${KEY_MARKER}</key>`, '  <string>y</string>'), detail: `plist has a duplicate key ${KEY_NOT_SHOWN}` },
  ])('refuses $name that holds a path without printing it', async ({ build, detail }) => {
    const { plan } = await planWith(BOT_ERRORS, build);
    expectStaged(plan, BOT_ERRORS, detail);
    expect(JSON.stringify(plan.document)).not.toContain(KEY_MARKER);
  });

  const strictRefusals = [
    { name: 'a character reference in the EnvironmentVariables key', edit: (source: string) => source.replace('<key>EnvironmentVariables</key>', '<key>EnvironmentVariable&#115;</key>'), detail: 'plist holds a numeric character reference' },
    { name: 'a CDATA EnvironmentVariables key', edit: (source: string) => source.replace('<key>EnvironmentVariables</key>', '<key><![CDATA[EnvironmentVariables]]></key>'), detail: 'plist holds a CDATA section' },
    { name: 'a DOCTYPE entity for the EnvironmentVariables key', edit: (source: string) => source.replace(/<!DOCTYPE[^>]*>/, '<!DOCTYPE plist [<!ENTITY environment "EnvironmentVariables">]>').replace('<key>EnvironmentVariables</key>', '<key>&environment;</key>'), detail: 'plist DOCTYPE has an internal subset or entity declaration' },
    { name: 'an entity in the EnvironmentVariables key', edit: (source: string) => source.replace('<key>EnvironmentVariables</key>', '<key>Environment&amp;Variables</key>'), detail: 'plist <key> holds an entity reference' },
    { name: 'whitespace around the EnvironmentVariables key', edit: (source: string) => source.replace('<key>EnvironmentVariables</key>', '<key> EnvironmentVariables </key>'), detail: 'plist <key> text has surrounding whitespace' },
    { name: 'a comment inside the EnvironmentVariables key', edit: (source: string) => source.replace('<key>EnvironmentVariables</key>', '<key>Environment<!-- hidden -->Variables</key>'), detail: 'plist <key> holds markup' },
    // The hidden plist holds no Label or ProgramArguments, so every regular-expression check still reads the visible one.
    { name: 'a DOCTYPE SYSTEM literal holding a plist with a Program key', edit: (source: string) => source.replace(/<!DOCTYPE[^>]*>/, `<!DOCTYPE plist SYSTEM '><plist version="1.0"><dict><key>Program</key><string>/opt/example/hidden</string></dict></plist>'>`), detail: 'plist DOCTYPE is not the Apple PLIST 1.0 DOCTYPE' },
    { name: 'a Program key after a comment opened as <!--->', edit: (source: string) => source.replace('<key>EnvironmentVariables</key>', '<!---><key>Program</key><string>/opt/example/hidden</string><!-- --><key>EnvironmentVariables</key>'), detail: 'plist holds a comment that starts with <!---' },
  ];
  it.each([
    ...strictRefusals.map((row) => ({ ...row, form: 'the installer form', label: BOT_ERRORS, build: (root: string, home: string) => row.edit(installerForm(root, home)) })),
    ...strictRefusals.map((row) => ({ ...row, form: 'harness maintenance', label: MAINTENANCE, build: (root: string, home: string) => row.edit(maintenanceForm(root, home, ...environment('<key>PATH</key><string>/usr/bin:/bin</string>'))) })),
  ])('refuses $name in $form', async ({ label, build, detail }) => {
    expectStaged((await planWith(label, build)).plan, label, detail);
  });

  /** A bplist00 whose one object, the top object, is the ASCII string `text`. */
  const binaryPlist = (text: string): Buffer => {
    const body = Buffer.from(text, 'ascii');
    const trailer = Buffer.alloc(32);
    trailer.writeUInt8(1, 6); trailer.writeUInt8(1, 7); // offset and object-reference sizes
    trailer.writeBigUInt64BE(1n, 8); trailer.writeBigUInt64BE(0n, 16); trailer.writeBigUInt64BE(BigInt(8 + 4 + body.length), 24);
    return Buffer.concat([Buffer.from('bplist00', 'ascii'), Buffer.from([0x5f, 0x11, body.length >> 8, body.length & 0xff]), body, Buffer.from([8]), trailer]);
  };
  it.each<{ name: string; build: Build; detail: string }>([
    { name: 'bplist00 bytes holding a valid XML plist as a string object', build: (root, home) => binaryPlist(installerForm(root, home)), detail: 'plist is a binary property list; only XML is admitted' },
    { name: 'a UTF-16 plist', build: (root, home) => Buffer.from(`${String.fromCharCode(0xfeff)}${installerForm(root, home).replace('encoding="UTF-8"', 'encoding="UTF-16"')}`, 'utf16le'), detail: 'plist does not start with an XML declaration or <plist>' },
    { name: 'a ProgramArguments entry that is not a <string>', build: (root, home) => installerForm(root, home).replace('<string>--instance</string>', '<integer>1</integer>'), detail: 'plist ProgramArguments entry 2 is not a <string>' },
  ])('refuses $name', async ({ build, detail }) => {
    expectStaged((await planWith(BOT_ERRORS, build)).plan, BOT_ERRORS, detail);
  });

  // Every decoded string value of every contract must name the path it spells.
  it.each<{ name: string; label: string; build: (root: string, home: string) => string }>([
    { name: 'an installer environment value <root>/../x', label: BOT_ERRORS, build: (root, home) => installerForm(root, home).replace(`<string>${home}/.local/state/bot-errors</string>`, `<string>${root}/../x</string>`) },
    { name: 'an installer log path <root>.bak/../<name>/log', label: BOT_ERRORS, build: (root, home) => withLines(installerForm(root, home), '  <key>StandardOutPath</key>', `  <string>${root}.bak/../${path.basename(root)}/log</string>`) },
    { name: 'an installer profile at <parent>/./<name>', label: BOT_ERRORS, build: (root, home) => installerForm(root, home).replace(`${root}/deploy/health-profiles/`, `${path.dirname(root)}/./${path.basename(root)}/deploy/health-profiles/`) },
    { name: 'an installer log path with a trailing slash', label: BOT_ERRORS, build: (root, home) => withLines(installerForm(root, home), '  <key>StandardErrorPath</key>', `  <string>${root}/logs/</string>`) },
    { name: 'a maintenance WorkingDirectory <root>/../x', label: MAINTENANCE, build: (root, home) => maintenanceForm(root, home).replace(`<string>${root}</string>`, `<string>${root}/../x</string>`) },
    { name: 'a maintenance WorkingDirectory <root>/./deploy', label: MAINTENANCE, build: (root, home) => maintenanceForm(root, home).replace(`<string>${root}</string>`, `<string>${root}/./deploy</string>`) },
  ])('refuses $name as not in closed form', async ({ label, build }) => {
    expectStaged((await planWith(label, build)).plan, label, 'absolute plist string value is not in closed form (empty, . or .. segment, or trailing slash)');
  });

  it('admits an installer-form plist whose comment holds a non-canonical <string>', async () => {
    const { plan } = await planWith(BOT_ERRORS, (root, home) => withLines(installerForm(root, home), '  <!-- <string>/tmp/../x</string> -->'));
    expect(plan.ready).toBe(true);
    expect(stagedFor(plan, BOT_ERRORS)).toContain('<!-- <string>/tmp/../x</string> -->');
  });

  it.each([
    { installer: 'install-bot-errors-health-launchd.sh', others: [] as string[] },
    { installer: 'install-bot-errors-launchd.sh', others: ['dispatcher', 'deadman', 'heartbeat-watchdog'] },
  ])('admits the health job exactly as deploy/scripts/$installer writes it by default', async ({ installer, others }) => {
    const { world, checkout, declaration } = pathRebaseWorld();
    const shims = path.join(world.root, 'installer-shims'); mkdirSync(shims);
    for (const command of ['launchctl', 'plutil']) writeFileSync(path.join(shims, command), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    for (const script of ['bot-errors-runner.py', 'bot-errors-health-check.py', 'bot-errors-dispatcher.py', 'bot-errors-heartbeat-watchdog.py']) writeFileSync(path.join(checkout, 'deploy', 'scripts', script), '');
    const profile = path.join(checkout, 'deploy', 'health-profiles', 'host-a.json');
    mkdirSync(path.dirname(profile), { recursive: true }); writeFileSync(profile, '{}\n');
    execFileSync('/bin/bash', [path.join(process.cwd(), 'deploy', 'scripts', installer)], {
      env: { HOME: world.home, PATH: `${shims}:/usr/bin:/bin`, BOT_ERRORS_REPO_ROOT: checkout, BOT_ERRORS_HEALTH_PROFILE: profile }, stdio: 'pipe', timeout: 5_000,
    });
    // The combined installer also writes three other jobs; this unit declares only the health job.
    for (const name of others) unlinkSync(path.join(world.launchAgents, `com.bot-errors.${name}.plist`));
    const source = readFileSync(path.join(world.launchAgents, `${BOT_ERRORS}.plist`), 'utf8');
    world.addJob(BOT_ERRORS, source);
    const plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(true);
    expect(stagedFor(plan, BOT_ERRORS)).toBe(source.replaceAll(`${checkout}/`, `${world.newRelease}/`).replace(`<string>${checkout}</string>`, `<string>${world.newRelease}</string>`));
  });

  it('admits the installer plain form and retains a closed-form prefix sibling unrewritten', async () => {
    const { world, checkout, declaration } = pathRebaseWorld();
    const runner = `${checkout}/deploy/scripts/bot-errors-runner.py`;
    const state = `${world.home}/.local/state/bot-errors`;
    const sibling = `${checkout}2/log`;
    // The argv and environment keys that deploy/scripts/install-bot-errors-health-launchd.sh writes.
    const source = withLines(plist(BOT_ERRORS, [
      '/usr/bin/python3', runner, '--instance', 'bot-errors-health', '--source', 'service-exit', '--summary', 'BOT ERRORS daily health command failed',
      '--log-hint', `${state}/logs/health.err.log`, '--diagnostic', `launchd_label=${BOT_ERRORS}`, '--', '/usr/bin/python3', `${checkout}/deploy/scripts/bot-errors-health-check.py`, '--daily',
    ], checkout), ...environment(
      `<key>PATH</key><string>${world.home}/.local/bin:/usr/bin:/bin</string>`, `<key>BOT_ERRORS_STATE_DIR</key><string>${state}</string>`,
      '<key>BOT_ERRORS_SOCKET_PATH</key><string></string>', `<key>BOT_ERRORS_HEALTH_PROFILE</key><string>${checkout}/deploy/health-profiles/host-a.json</string>`,
    ), '  <key>StandardOutPath</key>', `  <string>${sibling}</string>`);
    world.addJob(BOT_ERRORS, source);
    const plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(true);
    const staged = stagedFor(plan, BOT_ERRORS);
    expect(staged).toBe(source.replaceAll(`${checkout}/`, `${world.newRelease}/`).replace(`<string>${checkout}</string>`, `<string>${world.newRelease}</string>`));
    expect(staged).toContain(`<string>${sibling}</string>`);
  });

  it('rebases only the closed legacy bot-errors health profile default inside its reviewed shell wrapper', async () => {
    const world = twoMemberWorld();
    const checkout = path.join(world.root, 'legacy-checkout'); writeRelease(checkout, OLD, true);
    const label = BOT_ERRORS;
    const shell = legacyShell(checkout, world.home);
    // The environment key is one the installers write (BOT_ERRORS_DB); the wrapper admits no other.
    const source = legacyWrapper(checkout, world.home);
    const declaration = { schemaVersion: 2, members: members(world), hostAuxiliaries: [
      { label, mode: 'path-rebase', expectCurrent: checkout },
    ] };
    const encodedShell = shell.replaceAll('"', '&quot;');
    for (const serialized of [source, source.replace(`<string>${shell}</string>`, `<string>${encodedShell}</string>`)]) {
      world.addJob(label, serialized);
      const plan = await planHostUnit(world, declaration);
      expect(plan.ready).toBe(true);
      const staged = (plan.applyContext as unknown as { hostAuxiliaries: Array<{ label: string; staged: string }> }).hostAuxiliaries.find((entry) => entry.label === label)!.staged;
      expect(staged).toBe(serialized.replaceAll(checkout, world.newRelease));
      expect(staged).toContain(serialized.includes('&quot;') ? 'source &quot;$BOT_ERRORS_ENV_FILE&quot;' : 'source "$BOT_ERRORS_ENV_FILE"');
      expect(staged).toContain('BOT_ERRORS_JID must be a WhatsApp group JID');
      expect(staged).toContain('<key>Minute</key><integer>20</integer>');
      expect(staged).toContain('preserve-me');
    }

    // Another host has the same native wrapper and closed argv, differing only
    // by the profile basename below the selected release.
    const otherSource = source.replace('/health-profiles/edge9.json', '/health-profiles/core1.json');
    world.addJob(label, otherSource);
    const otherPlan = await planHostUnit(world, declaration);
    expect(otherPlan.ready).toBe(true);
    const otherStaged = (otherPlan.applyContext as unknown as { hostAuxiliaries: Array<{ label: string; staged: string }> }).hostAuxiliaries.find((entry) => entry.label === label)!.staged;
    expect(otherStaged).toBe(otherSource.replaceAll(checkout, world.newRelease));

    const unsafeRelease = path.join(world.root, 'releases', 'new release;injected');
    writeRelease(unsafeRelease, NEXT, true);
    const unsafeUnit = path.join(world.root, 'host-unit-unsafe-release.json');
    writeFileSync(unsafeUnit, JSON.stringify(declaration));
    vi.stubEnv('HOME', world.home); vi.stubEnv('XDG_CONFIG_HOME', path.join(world.home, '.config')); vi.stubEnv('XDG_DATA_HOME', path.join(world.home, '.local', 'share'));
    try {
      const unsafePlan = await buildHostUnitPlan(world.host, {
        unitPath: unsafeUnit, release: unsafeRelease, backupDir: path.join(world.root, 'backups'), mode: 'plan', exitTimeoutSeconds: 1, verifyTimeoutSeconds: 1,
      });
      expect(unsafePlan.ready).toBe(false);
      expect(unsafePlan.document.preconditions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `host-aux-plist-staged:${label}`, ok: false, detail: expect.stringContaining('embedded') }),
      ]));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a legacy wrapper that differs from the reviewed shell, naming the reinstall route', async () => {
    const world = twoMemberWorld();
    const checkout = path.join(world.root, 'legacy-checkout'); writeRelease(checkout, OLD, true);
    const source = legacyWrapper(checkout, world.home);
    const declaration = { schemaVersion: 2, members: members(world), hostAuxiliaries: [{ label: BOT_ERRORS, mode: 'path-rebase', expectCurrent: checkout }] };
    for (const malformed of [
      source.replace('/health-profiles/edge9.json', '/health-profiles/not-edge9.json'),
      source.replace('/health-profiles/edge9.json', '/health-profiles/Edge9.json'),
      source.replace('/health-profiles/edge9.json', '/health-profiles/edge9.json.bak'),
      source.replace('exec "$@"', `printf '%s' ${checkout}; exec "$@"`),
      source.replace('BOT_ERRORS_JID must be a WhatsApp group JID" >/dev/stderr; exit 65;', 'BOT_ERRORS_JID must be a WhatsApp group JID" >/dev/stderr; exit 0;'),
      source.replace('  exec "$@"', ' ; printf injected;  exec "$@"'),
    ]) {
      world.addJob(BOT_ERRORS, malformed);
      expectStaged(await planHostUnit(world, declaration), BOT_ERRORS, HEALTH_SHAPE);
    }
  });

  it('refuses a legacy wrapper whose environment file and log hint name a folder other than the job user\'s home', async () => {
    const { plan } = await planWith(BOT_ERRORS, (root, _home, world) => legacyWrapper(root, `${world.root}/other-home`));
    expectStaged(plan, BOT_ERRORS, 'bot-errors health legacy wrapper does not source the BOT ERRORS environment file in the job user\'s home folder');
  });

  it('refuses a target release that is not a closed-form shell-token path', async () => {
    const world = twoMemberWorld();
    const checkout = path.join(world.root, 'shell-checkout'); writeRelease(checkout, OLD, true);
    const label = BOT_ERRORS;
    const declaration = { schemaVersion: 2, members: members(world), hostAuxiliaries: [{ label, mode: 'path-rebase', expectCurrent: checkout }] };
    world.addJob(label, installerForm(checkout, world.home));
    expect((await planHostUnit(world, declaration)).ready).toBe(true);
    const unit = path.join(world.root, 'host-unit-shell-release.json');
    writeFileSync(unit, JSON.stringify(declaration));
    for (const [unsafeRelease, detail] of [
      [path.join(world.root, 'releases', 'new release'), 'shell-token'],
      [path.join(world.root, 'releases', 'new;injected'), 'shell-token'],
      [`${world.root}/releases/./new-dot`, 'target release is not a closed-form shell-token path'],
    ] as const) {
      writeRelease(unsafeRelease, NEXT, true);
      vi.stubEnv('HOME', world.home); vi.stubEnv('XDG_CONFIG_HOME', path.join(world.home, '.config')); vi.stubEnv('XDG_DATA_HOME', path.join(world.home, '.local', 'share'));
      try {
        const unsafe = await buildHostUnitPlan(world.host, {
          unitPath: unit, release: unsafeRelease, backupDir: path.join(world.root, 'backups'), mode: 'plan', exitTimeoutSeconds: 1, verifyTimeoutSeconds: 1,
        });
        expect(unsafe.ready).toBe(false);
        expect(unsafe.document.preconditions).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: `host-aux-plist-staged:${label}`, ok: false, detail: expect.stringContaining(detail) }),
        ]));
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  it('refuses a host setup timer when its rendered argv drops an external guard', async () => {
    const world = twoMemberWorld();
    const label = 'com.whatsoup.harness-maintenance';
    const oldScript = `${world.oldRelease}/deploy/scripts/harness-maintenance.sh`;
    const newScript = `${world.newRelease}/deploy/scripts/harness-maintenance.sh`;
    writeFileSync(path.join(world.newRelease, 'deploy', `${label}.plist`), plist(label, ['/bin/bash', newScript], world.newRelease));
    const declaration = { schemaVersion: 2, members: members(world), hostAuxiliaries: [
      { label, mode: 'setup-timer', expectCurrent: world.oldRelease },
    ] };
    world.addJob(label, plist(label, ['/bin/bash', oldScript], world.oldRelease));
    expect((await planHostUnit(world, declaration)).ready).toBe(true);

    world.addJob(label, plist(label, [
      '/bin/bash', `${world.home}/.local/libexec/fleet-reauth/maint-ccd-guard.sh`, '/bin/bash', oldScript,
    ], world.oldRelease));
    const plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `host-aux-plist-staged:${label}`, ok: false, detail: 'rendered ProgramArguments drift after exact root rebase' }),
    ]));
  });

  it('refuses a host setup timer whose rendered plist carries another label', async () => {
    const world = twoMemberWorld();
    const label = 'com.whatsoup.harness-maintenance';
    writeFileSync(path.join(world.newRelease, 'deploy', `${label}.plist`),
      plist('com.whatsoup.line-a', ['/bin/bash', `${world.newRelease}/deploy/scripts/harness-maintenance.sh`], world.newRelease));
    world.addJob(label, plist(label, ['/bin/bash', `${world.oldRelease}/deploy/scripts/harness-maintenance.sh`], world.oldRelease));
    const plan = await planHostUnit(world, { schemaVersion: 2, members: members(world), hostAuxiliaries: [
      { label, mode: 'setup-timer', expectCurrent: world.oldRelease },
    ] });
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `host-aux-plist-staged:${label}`, ok: false, detail: 'staged plist Label is not the declared host auxiliary label' }),
    ]));
  });

  it.each(['harness-maintenance', 'reply-guarantee'])('refuses planning when host auxiliary com.whatsoup.%s is a configured instance\'s primary label', async (name) => {
    const world = twoMemberWorld();
    const timer = (timerName: string) => {
      const label = `com.whatsoup.${timerName}`;
      writeFileSync(path.join(world.newRelease, 'deploy', `${label}.plist`), plist(label, ['/bin/bash', `${world.newRelease}/deploy/scripts/${timerName}.sh`], world.newRelease));
      world.addJob(label, plist(label, ['/bin/bash', `${world.oldRelease}/deploy/scripts/${timerName}.sh`], world.oldRelease));
      return { label, mode: 'setup-timer', expectCurrent: world.oldRelease };
    };
    const declaration = { schemaVersion: 2, members: members(world), hostAuxiliaries: [timer('harness-maintenance'), timer('reply-guarantee')] };
    // With no such configured instance, planning is unchanged.
    expect((await planHostUnit(world, declaration)).ready).toBe(true);

    // A configured instance as fleet discovery finds it: <config root>/<name>/config.json.
    const config = path.join(world.home, '.config', 'whatsoup', 'instances', name); mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, 'config.json'), JSON.stringify({ healthPort: 19003 }));
    const plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(false);
    expect(plan.applyContext).toBeNull();
    const other = name === 'harness-maintenance' ? 'reply-guarantee' : 'harness-maintenance';
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      { id: `host-aux-not-instance:com.whatsoup.${name}`, ok: false, detail: 'names another configured instance' },
      { id: `host-aux-not-instance:com.whatsoup.${other}`, ok: true, detail: 'names no configured instance' },
    ]));
  });

  it('path-rebases only the reviewed native maintenance and reply timer argv contracts', async () => {
    const world = twoMemberWorld();
    const maintenanceLabel = MAINTENANCE;
    const replyLabel = REPLY;
    const guard = `${world.home}/.local/libexec/fleet-reauth/maint-ccd-guard.sh`;
    const maintenanceSource = maintenanceForm(world.oldRelease, world.home);
    const replySource = replyForm(world.oldRelease, world.home);
    const declaration = { schemaVersion: 2, members: members(world), hostAuxiliaries: [
      { label: maintenanceLabel, mode: 'path-rebase', expectCurrent: world.oldRelease },
      { label: replyLabel, mode: 'path-rebase', expectCurrent: world.oldRelease },
    ] };
    world.addJob(maintenanceLabel, maintenanceSource);
    world.addJob(replyLabel, replySource);
    let plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(true);
    let staged = (plan.applyContext as unknown as { hostAuxiliaries: Array<{ label: string; staged: string }> }).hostAuxiliaries;
    expect(staged.find((entry) => entry.label === maintenanceLabel)!.staged).toBe(maintenanceSource.replaceAll(world.oldRelease, world.newRelease));
    expect(staged.find((entry) => entry.label === replyLabel)!.staged).toBe(replySource.replaceAll(world.oldRelease, world.newRelease));

    const replyWithoutOnce = replySource.replace('    <string>--once</string>\n', '');
    world.addJob(replyLabel, replyWithoutOnce);
    plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(true);
    staged = (plan.applyContext as unknown as { hostAuxiliaries: Array<{ label: string; staged: string }> }).hostAuxiliaries;
    expect(staged.find((entry) => entry.label === replyLabel)!.staged).toBe(replyWithoutOnce.replaceAll(world.oldRelease, world.newRelease));

    for (const [label, malformed, detail] of [
      [maintenanceLabel, maintenanceSource.replace('maint-ccd-guard.sh', 'other-guard.sh'), 'reviewed path-rebase contract'],
      [maintenanceLabel, maintenanceSource.replace(guard, `${world.root}/other-home/.local/libexec/fleet-reauth/maint-ccd-guard.sh`), 'reviewed path-rebase contract'],
      [replyLabel, replySource.replace('    <string>--once</string>\n', '    <string>--unknown</string>\n'), 'reviewed path-rebase contract'],
      [replyLabel, replySource.replace('    <string>--once</string>\n', '    <string>--once</string>\n    <string>--unknown</string>\n'), 'reviewed path-rebase contract'],
      [replyLabel, replySource.replace('v24.15.0/bin/node', 'v24.15/bin/node'), 'reviewed path-rebase contract'],
      [maintenanceLabel, withLines(maintenanceSource, '  <key>StandardOutPath</key>', `  <string>cd ${world.oldRelease} &amp;&amp; run</string>`), 'embedded'],
    ] as const) {
      world.addJob(maintenanceLabel, maintenanceSource);
      world.addJob(replyLabel, replySource);
      world.addJob(label, malformed);
      const refused = await planHostUnit(world, declaration);
      expect(refused.ready).toBe(false);
      expect(refused.document.preconditions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `host-aux-plist-staged:${label}`, ok: false, detail: expect.stringContaining(detail) }),
      ]));
    }
  });

  it('refuses at apply, before any write, a staged path-rebase plist changed after planning', async () => {
    const { world, checkout, declaration } = pathRebaseWorld();
    const source = installerForm(checkout, world.home);
    const plistPath = world.addJob(BOT_ERRORS, source);
    const plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(true);
    // launchd would run Program in place of ProgramArguments[0]; the selector check before the switch reads only the latter.
    const changed = { ...plan.applyContext!, hostAuxiliaries: plan.applyContext!.hostAuxiliaries!.map((entry) => ({
      ...entry, staged: withLines(entry.staged, '  <key>Program</key>', '  <string>/opt/example/bin/other</string>'),
    })) };
    const result = await (async () => {
      vi.stubEnv('HOME', world.home); vi.stubEnv('XDG_CONFIG_HOME', path.join(world.home, '.config')); vi.stubEnv('XDG_DATA_HOME', path.join(world.home, '.local', 'share'));
      try { return await applyHostUnitActivation(world.host, changed); } finally { vi.unstubAllEnvs(); }
    })();
    expect(result.outcome).toBe('refused');
    expect(result.failure).toBe(`${BOT_ERRORS}: staged plist does not match its path-rebase contract: ${rootKey('Program')}`);
    expect(result.steps).toEqual(expect.arrayContaining([{ step: `recheck-staged-path-rebase:${BOT_ERRORS}`, ok: false, detail: rootKey('Program') }]));
    expect(readFileSync(plistPath, 'utf8')).toBe(source);
    expect(readlinkSync(world.link)).toBe(path.join(world.oldRelease, 'deploy', 'whatsoup'));
    expect(world.calls.filter((call) => /^(?:bootout|bootstrap|kickstart):/.test(call))).toEqual([]);
  });

  it('requires the complete loaded consumer union for a separate fleet wrapper', async () => {
    const world = twoMemberWorld();
    writeFileSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    writeFileSync(path.join(world.newRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    const fleetLink = path.join(world.home, '.local', 'bin', 'whatsoup-fleet');
    symlinkSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), fleetLink);
    const fleetLabel = 'com.whatsoup.whatsoup-fleet';
    world.addJob(fleetLabel, plist(fleetLabel, [fleetLink, '9099'], world.oldRelease));
    const declaration = { schemaVersion: 2, members: members(world), hostAuxiliaries: [
      { label: fleetLabel, mode: 'fleet-wrapper', expectCurrent: world.oldRelease, link: fleetLink },
    ] };
    expect((await planHostUnit(world, declaration)).ready).toBe(true);
    world.addJob('com.whatsoup.fleet-rogue', plist('com.whatsoup.fleet-rogue', [fleetLink, '9191'], world.oldRelease));
    const plan = await planHostUnit(world, declaration);
    expect(plan.ready).toBe(false);
    expect(plan.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `shared-launcher-members:${fleetLink}`, ok: false }),
    ]));
  });

  it('restores a separate fleet wrapper on group rollback', async () => {
    const world = twoMemberWorld(); world.setFailure('second-health');
    writeFileSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    writeFileSync(path.join(world.newRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    const fleetLink = path.join(world.home, '.local', 'bin', 'whatsoup-fleet');
    symlinkSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), fleetLink);
    const fleetLabel = 'com.whatsoup.whatsoup-fleet';
    const fleetPlist = world.addJob(fleetLabel, plist(fleetLabel, [fleetLink, '9099'], world.oldRelease));
    const result = await applyHostUnitActivation(world.host, {
      release: world.newRelease, commit: NEXT, backupDir: path.join(world.root, 'backups'), members: world.contexts,
      sharedLaunchers: new Map([[world.link, ['shared']]]),
      hostLaunchers: [{ label: fleetLabel, plistPath: fleetPlist, installedSha256: plistDigest(readFileSync(fleetPlist, 'utf8')), link: fleetLink, wrapper: 'whatsoup-fleet', expectCurrent: world.oldRelease }],
    } as never);
    expect(result.outcome).toBe('rolled-back');
    expect(world.calls).toContain(`bootout:${fleetLabel}`);
    expect(readlinkSync(fleetLink)).toBe(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'));
  });

  it('rejects a post-switch fleet wrapper when its loaded definition differs from installed bytes', async () => {
    const world = twoMemberWorld();
    writeFileSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    writeFileSync(path.join(world.newRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    const fleetLink = path.join(world.home, '.local', 'bin', 'whatsoup-fleet');
    symlinkSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), fleetLink);
    const fleetLabel = 'com.whatsoup.whatsoup-fleet';
    const fleetPlist = world.addJob(fleetLabel, plist(fleetLabel, [fleetLink, '9099'], world.oldRelease));
    world.setFailure('host-loaded-mismatch');
    const result = await applyHostUnitActivation(world.host, {
      release: world.newRelease, commit: NEXT, backupDir: path.join(world.root, 'backups'), members: world.contexts,
      sharedLaunchers: new Map([[world.link, ['shared']]]),
      hostLaunchers: [{ label: fleetLabel, plistPath: fleetPlist, installedSha256: plistDigest(readFileSync(fleetPlist, 'utf8')), link: fleetLink, wrapper: 'whatsoup-fleet', expectCurrent: world.oldRelease }],
    } as never);
    expect(result.outcome).toBe('rollback-unverified');
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'verify-host-auxiliaries', ok: false, detail: expect.stringContaining('installed and loaded definitions differ') }),
    ]));
  });

  it('quiesces watchdogs before selectors and leaves them stopped when migration blocks rollback', async () => {
    const world = twoMemberWorld(); world.setFailure('migrate-second-before-gate');
    const watchdogLabel = 'com.whatsoup.shared-watchdog';
    const watchdogPlist = world.addJob(watchdogLabel,
      plist(watchdogLabel, [path.join(world.home, '.local', 'bin', 'shared-watchdog')], path.join(world.home, '.local')));
    const result = await applyHostUnitActivation(world.host, {
      release: world.newRelease, commit: NEXT, backupDir: path.join(world.root, 'backups'), members: world.contexts,
      sharedLaunchers: new Map([[world.link, ['shared']]]),
      watchdogs: [{ label: watchdogLabel, plistPath: watchdogPlist, installedSha256: plistDigest(readFileSync(watchdogPlist, 'utf8')) }],
    } as never);
    expect(result.outcome).toBe('rollback-blocked-migrated');
    expect(world.calls.indexOf(`bootout:${watchdogLabel}`)).toBeGreaterThanOrEqual(0);
    expect(world.calls.indexOf(`bootout:${watchdogLabel}`)).toBeLessThan(world.calls.indexOf('bootout:com.whatsoup.shared'));
    expect(world.calls).not.toContain(`bootstrap:${watchdogLabel}`);
  });

  it('retains watchdogs when old-process verification makes rollback unverified', async () => {
    const world = twoMemberWorld(); world.setFailure('second-and-old-health');
    const watchdogLabel = 'com.whatsoup.shared-watchdog';
    const watchdogPlist = world.addJob(watchdogLabel,
      plist(watchdogLabel, [path.join(world.home, '.local', 'bin', 'shared-watchdog')], path.join(world.home, '.local')));
    const result = await applyHostUnitActivation(world.host, {
      release: world.newRelease, commit: NEXT, backupDir: path.join(world.root, 'backups'), members: world.contexts,
      sharedLaunchers: new Map([[world.link, ['shared']]]), watchdogs: [{ label: watchdogLabel, plistPath: watchdogPlist, installedSha256: plistDigest(readFileSync(watchdogPlist, 'utf8')) }],
    } as never);
    expect(result.outcome).toBe('rollback-unverified');
    expect(world.calls).not.toContain(`bootstrap:${watchdogLabel}`);
    expect(result.rollback?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: `watchdog-retained:${watchdogLabel}`, ok: false }),
    ]));
  });
});

describe('release:activate-host rechecks launcher and watchdog plists it loads but never writes', () => {
  const FLEET_LABEL = 'com.whatsoup.whatsoup-fleet';
  const WATCHDOG_LABEL = 'com.whatsoup.shared-watchdog';
  const changedOutside = (label: string): string => `${label}: installed plist changed outside this activation`;
  const liveMutations = (world: TwoMemberWorld): string[] => world.calls.filter((call) => /^(bootout|bootstrap|kickstart):/.test(call));
  /** Schema v2 with the separate fleet wrapper and one member watchdog. */
  const launcherAndWatchdog = (world: TwoMemberWorld) => {
    writeFileSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    writeFileSync(path.join(world.newRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    const fleetLink = path.join(world.home, '.local', 'bin', 'whatsoup-fleet');
    symlinkSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), fleetLink);
    const fleetPlist = world.addJob(FLEET_LABEL, plist(FLEET_LABEL, [fleetLink, '9099'], world.oldRelease));
    const watchdogPlist = world.addJob(WATCHDOG_LABEL,
      plist(WATCHDOG_LABEL, [path.join(world.home, '.local', 'bin', 'shared-watchdog')], path.join(world.home, '.local')));
    const declaration = { schemaVersion: 2, members: [
      { instance: 'shared', expectCurrent: world.oldRelease, auxLabels: [] },
      { instance: 'direct', expectCurrent: world.oldRelease, auxLabels: [] },
    ], hostAuxiliaries: [
      { label: FLEET_LABEL, mode: 'fleet-wrapper', expectCurrent: world.oldRelease, link: fleetLink },
      { label: WATCHDOG_LABEL, mode: 'quiesce' },
    ] };
    return { fleetLink, fleetPlist, watchdogPlist, declaration };
  };
  const editAfterPlanning = (plistPath: string): string => {
    const edited = readFileSync(plistPath, 'utf8').replace('</plist>', '<!-- edited after planning -->\n</plist>');
    writeFileSync(plistPath, edited);
    return edited;
  };
  /** Apply exactly the context the planner accepted, under the planning home. */
  const applyPlanned = async (world: TwoMemberWorld, plan: Awaited<ReturnType<typeof buildHostUnitPlan>>, host: ActivationHost = world.host) => {
    expect(plan.ready).toBe(true);
    vi.stubEnv('HOME', world.home); vi.stubEnv('XDG_CONFIG_HOME', path.join(world.home, '.config')); vi.stubEnv('XDG_DATA_HOME', path.join(world.home, '.local', 'share'));
    try { return await applyHostUnitActivation(host, plan.applyContext!); } finally { vi.unstubAllEnvs(); }
  };
  /** Another writer that runs `write` once, right after the first launchctl call recorded as `trigger`. */
  const writerAfter = (world: TwoMemberWorld, trigger: string, write: () => void): ActivationHost => {
    let written = false;
    return {
      ...world.host,
      exec: async (file, args, options) => {
        const result = await world.host.exec(file, args, options);
        if (!written && world.calls.at(-1) === trigger) { written = true; write(); }
        return result;
      },
    };
  };

  it('plans each launcher and watchdog plist digest and activates while both are unchanged', async () => {
    const world = twoMemberWorld();
    const { fleetLink, fleetPlist, watchdogPlist, declaration } = launcherAndWatchdog(world);
    const plan = await planHostUnit(world, declaration);
    expect(plan.applyContext?.hostLaunchers).toEqual([expect.objectContaining({ plistPath: fleetPlist, installedSha256: plistDigest(readFileSync(fleetPlist, 'utf8')) })]);
    expect(plan.applyContext?.watchdogs).toEqual([expect.objectContaining({ plistPath: watchdogPlist, installedSha256: plistDigest(readFileSync(watchdogPlist, 'utf8')) })]);
    const result = await applyPlanned(world, plan);
    expect(result.outcome).toBe('activated');
    expect(result.steps).toEqual(expect.arrayContaining([
      { step: 'recheck-live-identity-before-switch', ok: true },
      { step: 'verify-live-identity', ok: true },
      { step: `restore-watchdog:${WATCHDOG_LABEL}`, ok: true },
    ]));
    expect(readlinkSync(fleetLink)).toBe(path.join(world.newRelease, 'deploy', 'whatsoup-fleet'));
    expect(world.calls).toContain(`bootstrap:${FLEET_LABEL}`);
    expect(world.calls).toContain(`bootstrap:${WATCHDOG_LABEL}`);
  });

  it('refuses before any selector move when a host launcher plist changed after planning', async () => {
    const world = twoMemberWorld();
    const { fleetLink, fleetPlist, declaration } = launcherAndWatchdog(world);
    const plan = await planHostUnit(world, declaration);
    const directBefore = readFileSync(world.directPlist, 'utf8');
    const edited = editAfterPlanning(fleetPlist);
    const result = await applyPlanned(world, plan);
    expect(result.outcome).toBe('refused');
    expect(result.failure).toBe(changedOutside(FLEET_LABEL));
    expect(readlinkSync(fleetLink)).toBe(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'));
    expect(readlinkSync(world.link)).toBe(path.join(world.oldRelease, 'deploy', 'whatsoup'));
    expect(readFileSync(world.directPlist, 'utf8')).toBe(directBefore);
    expect(readFileSync(fleetPlist, 'utf8')).toBe(edited);
    expect(liveMutations(world)).toEqual([]);
  });

  it.each([
    { when: 'before its reload', trigger: 'bootstrap:com.whatsoup.shared' },
    { when: 'between its bootout and bootstrap', trigger: `bootout:${FLEET_LABEL}` },
  ])('never loads a host launcher plist changed after the switch $when, and fails into the group rollback', async ({ trigger }) => {
    const world = twoMemberWorld();
    const { fleetPlist, declaration } = launcherAndWatchdog(world);
    const plan = await planHostUnit(world, declaration);
    const result = await applyPlanned(world, plan, writerAfter(world, trigger, () => { editAfterPlanning(fleetPlist); }));
    expect(result.outcome).toBe('rollback-unverified');
    expect(result.failure).toBe(changedOutside(FLEET_LABEL));
    expect(result.steps).toContainEqual({ step: `reload:${FLEET_LABEL}`, ok: false, detail: changedOutside(FLEET_LABEL) });
    expect(result.rollback?.steps).toContainEqual(expect.objectContaining({ step: 'recheck-live-identity-before-instance-stop', ok: false }));
    expect(world.calls).not.toContain(`bootstrap:${FLEET_LABEL}`);
    expect(world.calls).not.toContain(`bootstrap:${WATCHDOG_LABEL}`);
  });

  it('refuses with no live change when a watchdog plist changed after planning', async () => {
    const world = twoMemberWorld();
    const { watchdogPlist, declaration } = launcherAndWatchdog(world);
    const plan = await planHostUnit(world, declaration);
    editAfterPlanning(watchdogPlist);
    const result = await applyPlanned(world, plan);
    expect(result.outcome).toBe('refused');
    expect(result.failure).toBe(changedOutside(WATCHDOG_LABEL));
    expect(readlinkSync(world.link)).toBe(path.join(world.oldRelease, 'deploy', 'whatsoup'));
    expect(liveMutations(world)).toEqual([]);
  });

  it('never reloads a watchdog whose plist another writer replaced while it was quiesced', async () => {
    const world = twoMemberWorld();
    const { watchdogPlist, declaration } = launcherAndWatchdog(world);
    const plan = await planHostUnit(world, declaration);
    const result = await applyPlanned(world, plan, writerAfter(world, `bootout:${WATCHDOG_LABEL}`, () => { editAfterPlanning(watchdogPlist); }));
    expect(result.outcome).toBe('rollback-unverified');
    expect(result.failure).toBe(changedOutside(WATCHDOG_LABEL));
    expect(result.steps).toContainEqual({ step: `restore-watchdog:${WATCHDOG_LABEL}`, ok: false, detail: changedOutside(WATCHDOG_LABEL) });
    expect(readlinkSync(world.link)).toBe(path.join(world.oldRelease, 'deploy', 'whatsoup'));
    expect(world.calls).not.toContain(`bootstrap:${WATCHDOG_LABEL}`);
  });

  it('never reloads a watchdog whose plist changed after the switch, and does not report activated', async () => {
    const world = twoMemberWorld();
    const { watchdogPlist, declaration } = launcherAndWatchdog(world);
    const plan = await planHostUnit(world, declaration);
    const result = await applyPlanned(world, plan, writerAfter(world, 'bootstrap:com.whatsoup.shared', () => { editAfterPlanning(watchdogPlist); }));
    expect(result.outcome).toBe('rollback-unverified');
    expect(result.failure).toBe(changedOutside(WATCHDOG_LABEL));
    expect(result.steps).toContainEqual({ step: 'verify-live-identity', ok: false, detail: changedOutside(WATCHDOG_LABEL) });
    expect(world.calls).not.toContain(`bootstrap:${WATCHDOG_LABEL}`);
  });
});
