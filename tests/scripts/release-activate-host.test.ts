import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
import type { ActivationContext } from '../../scripts/lib/release-activation/plan.ts';
import { parseHostActivationArgs, RELEASE_ACTIVATE_HOST_EXIT, runReleaseActivateHostCli } from '../../scripts/release-activate-host.ts';
import { diagnosticBody, plist, writeRelease } from '../helpers/release-activate-world.ts';

const DOMAIN = [
  'gui/501 = {',
  '\tservices = {',
  '\t\t   56045      0 \tcom.whatsoup.ana-bot',
  '\t\t       0      0 \tcom.whatsoup.reply-guarantee',
  '\t\t       0   (pe) \tcom.apple.finder',
  '\t}',
  '}',
  '',
].join('\n');

const JOB = [
  'gui/501/com.whatsoup.ana-bot = {',
  '\tpath = /fixture-home/Library/LaunchAgents/com.whatsoup.ana-bot.plist',
  '\ttype = LaunchAgent',
  '\tprogram = /fixture-home/.local/bin/whatsoup',
  '\tstate = running',
  '\tpid = 56045',
  '\truns = 3',
  '\tworking directory = /ignored',
  '\tinherited environment = {',
  '\t\tPATH = redacted',
  '\t}',
  '\targuments = {',
  '\t\t/fixture-home/.local/bin/whatsoup',
  '\t\tana-bot',
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
  migrate: (which: 'first' | 'second') => void;
  setFailure: (value: 'second-health' | 'wrong-pid' | 'migrate-first-before-gate' | 'migrate-second-before-gate' | 'migrate-first-during-quiesce' | 'migrate-second-during-quiesce' | 'unreadable-first-before-gate' | 'unreadable-second-before-gate' | 'unreadable-first-during-quiesce' | 'unreadable-second-during-quiesce' | null) => void;
}

/** A two-member launchd world: first member follows one shared link, second is direct. */
function twoMemberWorld(): TwoMemberWorld {
  const root = mkdtempSync(path.join(os.tmpdir(), 'whatsoup-host-unit-'));
  const home = path.join(root, 'home');
  const oldRelease = path.join(root, 'releases', 'old');
  const newRelease = path.join(root, 'releases', 'new');
  writeRelease(oldRelease, OLD, true); writeRelease(newRelease, NEXT, true);
  const agents = path.join(home, 'Library', 'LaunchAgents'); mkdirSync(agents, { recursive: true });
  const link = path.join(home, '.local', 'bin', 'whatsoup'); mkdirSync(path.dirname(link), { recursive: true }); symlinkSync(path.join(oldRelease, 'deploy', 'whatsoup'), link);
  const firstLabel = 'com.whatsoup.shared'; const secondLabel = 'com.whatsoup.direct';
  const firstPlist = path.join(agents, `${firstLabel}.plist`); const directPlist = path.join(agents, `${secondLabel}.plist`);
  writeFileSync(firstPlist, plist(firstLabel, [link, 'shared'], oldRelease));
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
    staged: [{ label, role: 'instance', renderer: 'instance-edit', plistPath, staged: plist(label, [shared ? link : path.join(newRelease, 'deploy', 'whatsoup'), instance], newRelease), edits: [], renderDriftLines: 0 }],
  });
  const contexts = [context('shared', firstLabel, firstPlist, firstDb, 19001, true), context('direct', secondLabel, directPlist, secondDb, 19002, false)];
  let nextPid = 900;
  let clock = 1_700_000_000_000;
  let rollbackPhase = false;
  let fault: 'second-health' | 'wrong-pid' | 'migrate-first-before-gate' | 'migrate-second-before-gate' | 'migrate-first-during-quiesce' | 'migrate-second-during-quiesce' | 'unreadable-first-before-gate' | 'unreadable-second-before-gate' | 'unreadable-first-during-quiesce' | 'unreadable-second-during-quiesce' | null = null;
  const jobs = new Map<string, { pid: number; alive: boolean; plist: string }>([
    [firstLabel, { pid: nextPid++, alive: true, plist: firstPlist }], [secondLabel, { pid: nextPid++, alive: true, plist: directPlist }],
  ]);
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
      const entry = contexts.find((candidate) => candidate.healthPort === port)!; const job = jobs.get(entry.instanceLabel)!;
      const rootForJob = rootFor(job); const isSecond = entry.instanceLabel === secondLabel;
      if (fault === 'migrate-first-before-gate' && !isSecond && rootForJob === newRelease) migrate('first');
      if (fault === 'migrate-second-before-gate' && isSecond && rootForJob === newRelease) migrate('second');
      if (fault === 'unreadable-first-before-gate' && !isSecond && rootForJob === newRelease) unlinkSync(firstDb);
      if (fault === 'unreadable-second-before-gate' && isSecond && rootForJob === newRelease) unlinkSync(secondDb);
      const pid = fault === 'wrong-pid' && isSecond && rootForJob === newRelease ? job.pid + 1 : job.pid;
      const failedSecond = isSecond && rootForJob === newRelease && ['second-health', 'migrate-first-before-gate', 'migrate-second-before-gate', 'migrate-first-during-quiesce', 'migrate-second-during-quiesce', 'unreadable-first-before-gate', 'unreadable-second-before-gate', 'unreadable-first-during-quiesce', 'unreadable-second-during-quiesce'].includes(fault ?? '');
      if (failedSecond) rollbackPhase = true;
      return { status: 200, body: diagnosticBody(rootForJob === newRelease ? NEXT : OLD, !failedSecond, undefined, { pid }) };
    },
    exec: async (file, args) => {
      if (file === 'git') return { code: 0, stdout: `${OLD}\n`, stderr: '' };
      if (file === 'plutil') return { code: 0, stdout: '', stderr: '' };
      if (file === 'ps') { const job = [...jobs.values()].find((candidate) => candidate.pid === Number(args[1]) && candidate.alive); return job === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: `node ${rootFor(job)}/src/bootstrap.ts\n`, stderr: '' }; }
      if (file === '/bin/launchctl' && args[0] === 'print' && args[1] === 'gui/501') {
        return { code: 0, stdout: `gui/501 = {\n\tservices = {\n\t\t${jobs.get(firstLabel)!.pid} 0 \t${firstLabel}\n\t\t${jobs.get(secondLabel)!.pid} 0 \t${secondLabel}\n\t}\n}\n`, stderr: '' };
      }
      if (file === '/bin/launchctl' && args[0] === 'print') {
        const name = label(args[1]!); const job = jobs.get(name); if (job === undefined) return { code: 113, stdout: '', stderr: '' };
        const program = readFileSync(job.plist, 'utf8').match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)/)?.[1] ?? '';
        const argv = readFileSync(job.plist, 'utf8').match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1].match(/<string>([^<]+)/g)?.map((entry) => entry.replace(/^<string>|<\/string>$/g, '')) ?? [];
        return { code: 0, stdout: `gui/501/${name} = {\n\tpath = ${job.plist}\n\ttype = LaunchAgent\n\tprogram = ${program}\n\tstate = running\n\tpid = ${job.pid}\n\targuments = {\n${argv.map((entry) => `\t\t${entry}\n`).join('')}\t}\n}\n`, stderr: '' };
      }
      if (file === 'launchctl') {
        const verb = args[0]!; const target = args.at(-1) ?? ''; const name = verb === 'bootstrap' ? path.basename(args[2]!, '.plist') : label(target); const job = jobs.get(name);
        if (verb === 'print') return job?.alive ? { code: 0, stdout: `gui/501/${name} = {\n\tpid = ${job.pid}\n}\n`, stderr: '' } : { code: 113, stdout: '', stderr: '' };
        if (verb === 'bootout') { if (job !== undefined) { job.alive = false; if (rollbackPhase && fault === 'migrate-first-during-quiesce' && name === firstLabel) migrate('first'); if (rollbackPhase && fault === 'migrate-second-during-quiesce' && name === secondLabel) migrate('second'); if (rollbackPhase && fault === 'unreadable-first-during-quiesce' && name === firstLabel) unlinkSync(firstDb); if (rollbackPhase && fault === 'unreadable-second-during-quiesce' && name === secondLabel) unlinkSync(secondDb); } return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'bootstrap') { jobs.set(name, { pid: nextPid++, alive: true, plist: args[2]! }); return { code: 0, stdout: '', stderr: '' }; }
        if (verb === 'kickstart') { if (job !== undefined) { job.alive = false; jobs.set(name, { pid: nextPid++, alive: true, plist: job.plist }); } return { code: 0, stdout: '', stderr: '' }; }
      }
      return { code: 127, stdout: '', stderr: `${file} unsupported` };
    },
  };
  return { root, home, launchAgents: agents, oldRelease, newRelease, link, directPlist, firstDb, secondDb, contexts, host, migrate, setFailure: (value) => { fault = value; } };
}

async function planTwoMemberWorld(world: TwoMemberWorld): Promise<Awaited<ReturnType<typeof buildHostUnitPlan>>> {
  const unit = path.join(world.root, 'host-unit.json');
  writeFileSync(unit, JSON.stringify({ schemaVersion: 1, members: [
    { instance: 'shared', expectCurrent: world.oldRelease, auxLabels: [] },
    { instance: 'direct', expectCurrent: world.oldRelease, auxLabels: [] },
  ] }));
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
      { instance: 'ana-bot', expectCurrent: '/releases/old-a', auxLabels: [{ label: 'com.whatsoup.reply-guarantee', renderer: 'setup-timer' }] },
      { instance: 'personal', expectCurrent: '/releases/old-b', auxLabels: [] },
    ] })).not.toBeNull();
    expect(parseHostUnitDeclaration({ schemaVersion: 1, members: [
      { instance: 'ana-bot', expectCurrent: '/releases/old-a', auxLabels: [] },
      { instance: 'ana-bot', expectCurrent: '/releases/old-b', auxLabels: [] },
    ] })).toBeNull();
    expect(parseHostUnitDeclaration({ schemaVersion: 1, members: [
      { instance: 'ana-bot', expectCurrent: '/releases/old-a', auxLabels: [{ label: 'com.whatsoup.personal', renderer: 'setup-timer' }] },
      { instance: 'personal', expectCurrent: '/releases/old-b', auxLabels: [] },
    ] })).toBeNull();
  });

  it('accepts selected primary and loaded-but-idle auxiliary services', () => {
    expect(parseLoadedDomain(DOMAIN)).toEqual([
      { label: 'com.whatsoup.ana-bot', pid: 56045, status: '0' },
      { label: 'com.whatsoup.reply-guarantee', pid: 0, status: '0' },
    ]);
  });

  it('fails closed on duplicate, truncated, or malformed services', () => {
    expect(parseLoadedDomain(DOMAIN.replace('com.apple.finder', 'com.whatsoup.ana-bot'))).toBeNull();
    expect(parseLoadedDomain(DOMAIN.replace('\t}', ''))).toBeNull();
    expect(parseLoadedDomain(DOMAIN.replace('56045      0', 'pid = nope'))).toBeNull();
  });

  it('retains only selector-bearing loaded job fields', () => {
    expect(parseLoadedJob(JOB, 'com.whatsoup.ana-bot', 'gui/501')).toEqual({
      label: 'com.whatsoup.ana-bot',
      path: '/fixture-home/Library/LaunchAgents/com.whatsoup.ana-bot.plist',
      type: 'LaunchAgent',
      program: '/fixture-home/.local/bin/whatsoup',
      state: 'running',
      pid: 56045,
      arguments: ['/fixture-home/.local/bin/whatsoup', 'ana-bot'],
    });
  });

  it('refuses malformed, duplicate, or mismatched loaded definitions', () => {
    expect(parseLoadedJob(JOB.replace('gui/501/com.whatsoup.ana-bot = {', 'gui/501/com.whatsoup.other = {'), 'com.whatsoup.ana-bot', 'gui/501')).toBeNull();
    expect(parseLoadedJob(JOB.replace('\tstate = running', '\tstate = running\n\tstate = waiting'), 'com.whatsoup.ana-bot', 'gui/501')).toBeNull();
    expect(parseLoadedJob(JOB.replace('\t\tana-bot', '\t'), 'com.whatsoup.ana-bot', 'gui/501')).toBeNull();
    expect(parseLoadedJob(JOB.replace('\t}\n\targuments', '\targuments'), 'com.whatsoup.ana-bot', 'gui/501')).toBeNull();
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
