import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
      if (receiptFault.fail) throw new Error('injected receipt publication failure');
      return actual.writeAtomicPrivateFileSync(...args);
    },
  };
});

import { parseLoadedDomain, parseLoadedJob } from '../../scripts/lib/release-activation/host.ts';
import type { ActivationHost } from '../../scripts/lib/release-activation/host.ts';
import { applyHostUnitActivation } from '../../scripts/lib/release-activation/host-unit-apply.ts';
import { buildHostUnitPlan, parseHostUnitDeclaration } from '../../scripts/lib/release-activation/host-unit-plan.ts';
import { plistDigest, type ActivationContext } from '../../scripts/lib/release-activation/plan.ts';
import { parseHostActivationArgs, RELEASE_ACTIVATE_HOST_EXIT, runReleaseActivateHostCli } from '../../scripts/release-activate-host.ts';
import { parsePlist } from '../../scripts/check-service-units.ts';
import { diagnosticBody, plist, writeRelease } from '../helpers/release-activate-world.ts';

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
  addJob: (label: string, contents: string) => string;
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
    refreshRollbackFence: { required: null, candidateDigest: null, targetCapability: null, targetDigest: null, targetCompatibleAtPlan: false, candidateDetail: 'not read', targetDetail: 'not read' },
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
  const addJob = (name: string, contents: string): string => {
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
      if (file === 'git') return { code: 0, stdout: `${OLD}\n`, stderr: '' };
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
      { instance: 'personal', expectCurrent: '/releases/old-b', auxLabels: [] },
    ] })).not.toBeNull();
    expect(parseHostUnitDeclaration({ schemaVersion: 1, members: [
      { instance: 'alpha-line', expectCurrent: '/releases/old-a', auxLabels: [] },
      { instance: 'alpha-line', expectCurrent: '/releases/old-b', auxLabels: [] },
    ] })).toBeNull();
    expect(parseHostUnitDeclaration({ schemaVersion: 1, members: [
      { instance: 'alpha-line', expectCurrent: '/releases/old-a', auxLabels: [{ label: 'com.whatsoup.personal', renderer: 'setup-timer' }] },
      { instance: 'personal', expectCurrent: '/releases/old-b', auxLabels: [] },
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

  it('returns rollback-unverified when an otherwise successful activation cannot publish its private receipt', async () => {
    const world = twoMemberWorld(); receiptFault.fail = true;
    await planTwoMemberWorld(world); // creates the declaration and verifies the read-only premise first
    let stdout = ''; let stderr = '';
    vi.stubEnv('HOME', world.home); vi.stubEnv('XDG_CONFIG_HOME', path.join(world.home, '.config')); vi.stubEnv('XDG_DATA_HOME', path.join(world.home, '.local', 'share'));
    try {
      const code = await runReleaseActivateHostCli(['--unit', path.join(world.root, 'host-unit.json'), '--release', world.newRelease, '--backup-dir', path.join(world.root, 'backups'), '--apply'], world.host, { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } });
      expect(code).toBe(RELEASE_ACTIVATE_HOST_EXIT.rollbackUnverified);
    } finally { vi.unstubAllEnvs(); receiptFault.fail = false; }
    expect(stderr).toBe('release:activate-host: receipt-write-failed\n');
    expect(JSON.parse(stdout)).toMatchObject({ outcome: { outcome: 'activated' } });
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

  it('rejects an XML-escaped reference to a selected host launcher', async () => {
    const world = twoMemberWorld(); const outside = reviewedInterpreter(world);
    writeFileSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    writeFileSync(path.join(world.newRelease, 'deploy', 'whatsoup-fleet'), '#!/bin/bash\n', { mode: 0o755 });
    const fleetLink = path.join(world.home, '.local', 'bin', 'whatsoup&fleet');
    symlinkSync(path.join(world.oldRelease, 'deploy', 'whatsoup-fleet'), fleetLink);
    const fleetLabel = 'com.whatsoup.whatsoup-fleet'; world.addJob(fleetLabel, plist(fleetLabel, [fleetLink, '9099'], world.oldRelease));
    const source = outside.source.replace('</dict>', `  <key>OpaqueRef</key>\n  <string>${fleetLink.replace('&', '&amp;')}</string>\n</dict>`);
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
      { instance: 'alpha-line', expectCurrent: '/releases/ana', auxLabels: [] },
    ], hostAuxiliaries: [
      { label: 'com.bot-errors.health', mode: 'path-rebase', expectCurrent: '/checkout' },
      { label: 'com.whatsoup.harness-maintenance', mode: 'setup-timer', expectCurrent: '/checkout' },
      { label: 'com.whatsoup.whatsoup-fleet', mode: 'fleet-wrapper', expectCurrent: '/checkout', link: '/fixture/.local/bin/whatsoup-fleet' },
      { label: 'com.whatsoup.alpha-line-watchdog', mode: 'quiesce' },
    ] })).not.toBeNull();
    expect(parseHostUnitDeclaration({ schemaVersion: 2, members: [
      { instance: 'alpha-line', expectCurrent: '/releases/ana', auxLabels: [] },
    ], hostAuxiliaries: [
      { label: 'com.bot-errors.health', mode: 'path-rebase', expectCurrent: '/checkout', hiddenSelector: '/unchecked' },
    ] })).toBeNull();
  });

  it('stages a declared bot-errors checkout outside every member root without losing its fields', async () => {
    const world = twoMemberWorld();
    const checkout = path.join(world.root, 'checkout'); writeRelease(checkout, OLD, true);
    const label = 'com.bot-errors.health';
    const sibling = `${checkout}-cache/log`;
    const source = plist(label, ['/usr/bin/python3', `${checkout}/deploy/scripts/bot-errors-runner.py`, '--daily'], checkout)
      .replace('  <key>WorkingDirectory</key>', `  <key>OpaqueHostField</key>\n  <string>preserve-me</string>\n  <key>SiblingLog</key>\n  <string>${sibling}</string>\n  <key>WorkingDirectory</key>`);
    world.addJob(label, source);
    const plan = await planHostUnit(world, { schemaVersion: 2, members: members(world), hostAuxiliaries: [
      { label, mode: 'path-rebase', expectCurrent: checkout },
    ] });
    expect(plan.ready).toBe(true);
    const auxiliary = (plan.applyContext as unknown as { hostAuxiliaries: Array<{ label: string; staged: string }> }).hostAuxiliaries.find((entry) => entry.label === label)!;
    expect(auxiliary.staged).toContain('preserve-me');
    expect(auxiliary.staged).toContain(sibling);
    expect(auxiliary.staged).toContain(world.newRelease);
    expect(auxiliary.staged).not.toContain(`${checkout}/`);

    const wrongRoot = await planHostUnit(world, { schemaVersion: 2, members: members(world), hostAuxiliaries: [
      { label, mode: 'path-rebase', expectCurrent: `${checkout}-other` },
    ] });
    expect(wrongRoot.ready).toBe(false);
    expect(wrongRoot.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `host-aux-on-expected-release:${label}`, ok: false }),
    ]));

    world.addJob(label, source.replace('preserve-me', `cd ${checkout} && run`));
    const embeddedRoot = await planHostUnit(world, { schemaVersion: 2, members: members(world), hostAuxiliaries: [
      { label, mode: 'path-rebase', expectCurrent: checkout },
    ] });
    expect(embeddedRoot.ready).toBe(false);
    expect(embeddedRoot.document.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `host-aux-plist-staged:${label}`, ok: false, detail: expect.stringContaining('embedded') }),
    ]));
  });

  it('rebases only the closed legacy bot-errors health profile default inside its reviewed shell wrapper', async () => {
    const world = twoMemberWorld();
    const checkout = path.join(world.root, 'legacy-checkout'); writeRelease(checkout, OLD, true);
    const label = 'com.bot-errors.health';
    const profile = `${checkout}/deploy/health-profiles/edge9.json`;
    const shell = [
      `BOT_ERRORS_ENV_FILE=${world.home}/.config/whatsoup/bot-errors.env; export BOT_ERRORS_ENV_FILE; `,
      'if [[ ! -r "$BOT_ERRORS_ENV_FILE" ]]; then printf "%s\\n" "missing BOT_ERRORS_ENV_FILE=$BOT_ERRORS_ENV_FILE" >/dev/stderr; exit 64; fi; ',
      'set -a; source "$BOT_ERRORS_ENV_FILE"; set +a; ',
      'if [[ -z "${BOT_ERRORS_JID:-}" ]]; then printf "%s\\n" "missing BOT_ERRORS_JID in $BOT_ERRORS_ENV_FILE" >/dev/stderr; exit 65; fi; ',
      'if [[ -z "${BOT_ERRORS_EXPECTED_JID:-}" ]]; then printf "%s\\n" "missing BOT_ERRORS_EXPECTED_JID in $BOT_ERRORS_ENV_FILE" >/dev/stderr; exit 65; fi; ',
      'if [[ "$BOT_ERRORS_JID" != *@g.us ]]; then printf "%s\\n" "BOT_ERRORS_JID must be a WhatsApp group JID" >/dev/stderr; exit 65; fi; ',
      'if [[ "$BOT_ERRORS_JID" != "$BOT_ERRORS_EXPECTED_JID" ]]; then printf "%s\\n" "BOT_ERRORS_JID does not match BOT_ERRORS_EXPECTED_JID" >/dev/stderr; exit 65; fi; ',
      `if [[ -z "\${BOT_ERRORS_STATE_DIR:-}" ]]; then export BOT_ERRORS_STATE_DIR=${world.home}/.local/state/bot-errors; fi; `,
      'if [[ -z "${BOT_ERRORS_HEALTH_PROFILE:-}" ]]; then export BOT_ERRORS_HEALTH_PROFILE=', profile, '; fi;  exec "$@"',
    ].join('');
    const source = plist(label, [
      '/bin/bash', '-c', shell, 'bot-errors-health', '/usr/bin/python3', `${checkout}/deploy/scripts/bot-errors-runner.py`,
      '--instance', 'bot-errors-health', '--source', 'service-exit', '--summary', 'BOT ERRORS daily health command failed',
      '--log-hint', `${world.home}/.local/state/bot-errors/logs/health.err.log`, '--diagnostic', 'launchd_label=com.bot-errors.health',
      '--', '/usr/bin/python3', `${checkout}/deploy/scripts/bot-errors-health-check.py`, '--daily',
    ], checkout).replace('  <key>WorkingDirectory</key>', [
      '  <key>EnvironmentVariables</key>', '  <dict><key>UNRELATED</key><string>preserve-me</string></dict>',
      '  <key>StartCalendarInterval</key>', '  <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>20</integer></dict>',
      '  <key>WorkingDirectory</key>',
    ].join('\n'));
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

    for (const malformed of [
      source.replace('/health-profiles/edge9.json', '/health-profiles/not-edge9.json'),
      source.replace('/health-profiles/edge9.json', '/health-profiles/Edge9.json'),
      source.replace('/health-profiles/edge9.json', '/health-profiles/edge9.json.bak'),
      source.replace('exec "$@"', `printf '%s' ${checkout}; exec "$@"`),
      source.replace('BOT_ERRORS_JID must be a WhatsApp group JID" >/dev/stderr; exit 65;', 'BOT_ERRORS_JID must be a WhatsApp group JID" >/dev/stderr; exit 0;'),
      source.replace('  exec "$@"', ' ; printf injected;  exec "$@"'),
    ]) {
      world.addJob(label, malformed);
      const refused = await planHostUnit(world, declaration);
      expect(refused.ready).toBe(false);
      expect(refused.document.preconditions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `host-aux-plist-staged:${label}`, ok: false, detail: expect.stringContaining('embedded') }),
      ]));
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

  it('path-rebases only the reviewed native maintenance and reply timer argv contracts', async () => {
    const world = twoMemberWorld();
    const maintenanceLabel = 'com.whatsoup.harness-maintenance';
    const replyLabel = 'com.whatsoup.reply-guarantee';
    const guard = `${world.home}/.local/libexec/fleet-reauth/maint-ccd-guard.sh`;
    const node = `${world.home}/.nvm/versions/node/v24.15.0/bin/node`;
    const maintenanceSource = plist(maintenanceLabel, [
      '/bin/bash', guard, '/bin/bash', `${world.oldRelease}/deploy/scripts/harness-maintenance.sh`,
    ], world.oldRelease).replace('  <key>WorkingDirectory</key>', [
      '  <key>RunAtLoad</key>', '  <true/>', '  <key>StartInterval</key>', '  <integer>3600</integer>',
      '  <key>KeepAlive</key>', '  <false/>', '  <key>WorkingDirectory</key>',
    ].join('\n'));
    const replySource = plist(replyLabel, [
      node, `${world.oldRelease}/deploy/hooks/drain-stuck-replies.mjs`, '--once',
    ], world.oldRelease).replace('  <key>WorkingDirectory</key>', [
      '  <key>RunAtLoad</key>', '  <true/>', '  <key>StartInterval</key>', '  <integer>300</integer>',
      '  <key>KeepAlive</key>', '  <false/>', '  <key>WorkingDirectory</key>',
    ].join('\n'));
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
      [maintenanceLabel, maintenanceSource.replace('  <key>WorkingDirectory</key>', `  <key>Opaque</key>\n  <string>cd ${world.oldRelease} &amp;&amp; run</string>\n  <key>WorkingDirectory</key>`), 'embedded'],
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
      hostLaunchers: [{ label: fleetLabel, plistPath: fleetPlist, link: fleetLink, wrapper: 'whatsoup-fleet', expectCurrent: world.oldRelease }],
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
      hostLaunchers: [{ label: fleetLabel, plistPath: fleetPlist, link: fleetLink, wrapper: 'whatsoup-fleet', expectCurrent: world.oldRelease }],
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
      watchdogs: [{ label: watchdogLabel, plistPath: watchdogPlist }],
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
      sharedLaunchers: new Map([[world.link, ['shared']]]), watchdogs: [{ label: watchdogLabel, plistPath: watchdogPlist }],
    } as never);
    expect(result.outcome).toBe('rollback-unverified');
    expect(world.calls).not.toContain(`bootstrap:${watchdogLabel}`);
    expect(result.rollback?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: `watchdog-retained:${watchdogLabel}`, ok: false }),
    ]));
  });
});
