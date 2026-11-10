import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as canaryRunner from '../../../scripts/lib/provider-canary-runner.ts';
import {
  buildProviderCanaryInvocation,
  executeOwnedProvider,
  runProviderCanary,
  type ProviderCanaryObservation,
} from '../../../scripts/lib/provider-canary-runner.ts';
import { CANARY_CONTRACT_VERSION } from '../../../src/runtimes/agent/provider-canary-proof.ts';
import {
  acquireProcessLock,
  releaseProcessLock,
} from '../../../src/lib/process-lock.ts';
import {
  FIXTURE_LEAK_NET_MS,
  groupKillError,
  reapFixtureGroups,
  settleWithin,
  waitForPidGone,
  type GroupMembershipAnswer,
  type GroupSignalSeam,
} from '../../helpers/group-kill-seams.ts';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'provider-canary-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('provider canary invocation adapter', () => {
  it('uses the production adapter for every eligible CLI without a model turn', () => {
    const root = tempRoot();
    const proxy = join(root, 'proxy.ts');
    writeFileSync(proxy, 'proxy fixture');
    chmodSync(proxy, 0o700);

    const rows = [
      buildProviderCanaryInvocation('claude-cli', root, '/static.sock', proxy),
      buildProviderCanaryInvocation('codex-cli', root, '/static.sock', proxy),
      buildProviderCanaryInvocation('gemini-cli', root, '/static.sock', proxy),
      buildProviderCanaryInvocation('opencode-cli', root, '/static.sock', proxy),
    ];

    expect(rows.map((row) => row.binary)).toEqual(['claude', 'codex', 'gemini', 'opencode']);
    expect(rows[0].args).toEqual([
      `--settings=${join(root, '.whatsoup-canary-settings.json')}`,
      '--strict-mcp-config',
      `--mcp-config=${join(root, '.mcp.json')}`,
      'mcp',
      'list',
    ]);
    expect(rows[1].args.slice(0, 1)).toEqual(['app-server']);
    expect(rows[1].args.join('\n')).toContain('mcp_servers.whatsoup');
    expect(rows[2].args).toEqual(['--acp']);
    expect(rows[2].stdinFrames.map((frame) => JSON.parse(frame).method))
      .toEqual(['initialize', 'session/new']);
    expect(rows[3].args).toEqual(['mcp', 'list', '--pure']);
    expect(JSON.stringify(rows)).not.toMatch(/session\/prompt|thread\/turn|send_message|whatsapp/i);
  });
});

describe('provider canary runner', () => {
  const pass: ProviderCanaryObservation = {
    providerStarted: true,
    conclusive: true,
    dynamicInitialize: true,
    dynamicToolsList: true,
    staticConnections: 0,
    proxyDescendant: true,
    processGroupReaped: true,
  };

  it('writes only a redacted bound receipt after an owned-process proof', async () => {
    const root = tempRoot();
    const proxy = join(root, 'proxy.ts');
    const binary = join(root, 'fake-provider');
    writeFileSync(proxy, 'proxy fixture');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o700);
    const executeOwnedProvider = vi.fn(async () => pass);

    const receipt = await runProviderCanary({
      providerId: 'codex-cli',
      stateRoot: root,
      proxyScriptPath: proxy,
      binary,
      binaryVersion: 'fake-provider 1.0',
    }, { executeOwnedProvider });

    expect(executeOwnedProvider).toHaveBeenCalledTimes(1);
    expect(receipt).toMatchObject({
      contractVersion: CANARY_CONTRACT_VERSION,
      providerId: 'codex-cli',
      dynamicInitialize: true,
      dynamicToolsList: true,
      staticConnections: 0,
      proxyDescendant: true,
      processGroupReaped: true,
    });
    const raw = readFileSync(join(root, 'provider-canaries', 'codex-cli.json'), 'utf8');
    expect(statSync(join(root, 'provider-canaries')).mode & 0o077).toBe(0);
    expect(statSync(join(root, 'provider-canaries', 'codex-cli.json')).mode & 0o077).toBe(0);
    expect(raw).not.toContain(root);
    expect(raw).not.toContain('argv');
    expect(raw).not.toContain('output');
  });

  it.each([
    'claude-cli',
    'codex-cli',
    'gemini-cli',
    'opencode-cli',
  ])('proves dynamic-only RPC and reaps a real %s-shaped fake process group', async (providerId) => {
    const root = tempRoot();
    const hostRoots = {
      HOME: join(root, 'host-home'),
      XDG_CONFIG_HOME: join(root, 'host-config'),
      XDG_DATA_HOME: join(root, 'host-data'),
      TMPDIR: join(root, 'host-tmp'),
      CLAUDE_CONFIG_DIR: join(root, 'host-claude'),
    };
    const previous = Object.fromEntries(
      Object.keys(hostRoots).map((key) => [key, process.env[key]]),
    );
    for (const [key, path] of Object.entries(hostRoots)) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      writeFileSync(join(path, 'forbidden-canary-config'), key);
      process.env[key] = path;
    }
    const binary = fileURLToPath(new URL('./bin/fake-mcp-canary-provider.mjs', import.meta.url));
    const proxy = fileURLToPath(
      new URL('../../../deploy/mcp/whatsoup-proxy.ts', import.meta.url),
    );
    chmodSync(binary, 0o700);

    let receipt;
    try {
      receipt = await runProviderCanary({
        providerId,
        stateRoot: root,
        proxyScriptPath: proxy,
        binary,
        binaryVersion: 'fake-provider 1.0',
        timeoutMs: 10_000,
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(receipt).toMatchObject({
      dynamicInitialize: true,
      dynamicToolsList: true,
      staticConnections: 0,
      proxyDescendant: true,
      processGroupReaped: true,
    });
  }, 15_000);

  it.each([
    ['providerStarted', false],
    ['conclusive', false],
    ['dynamicInitialize', false],
    ['dynamicToolsList', false],
    ['staticConnections', 1],
    ['proxyDescendant', false],
    ['processGroupReaped', false],
  ] as const)('does not write a receipt when %s is unsafe', async (key, value) => {
    const root = tempRoot();
    const proxy = join(root, 'proxy.ts');
    const binary = join(root, 'fake-provider');
    writeFileSync(proxy, 'proxy fixture');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o700);

    await expect(runProviderCanary({
      providerId: 'codex-cli',
      stateRoot: root,
      proxyScriptPath: proxy,
      binary,
      binaryVersion: 'fake-provider 1.0',
    }, {
      executeOwnedProvider: async () => ({ ...pass, [key]: value }),
    })).rejects.toThrow(/unproven/);

    expect(() => readFileSync(join(root, 'provider-canaries', 'codex-cli.json')))
      .toThrow();
  });

  it('invalidates an exact prior receipt after a conclusive provider-negative rerun', async () => {
    const root = tempRoot();
    const proxy = join(root, 'proxy.ts');
    const binary = join(root, 'fake-provider');
    const receiptPath = join(root, 'provider-canaries', 'codex-cli.json');
    writeFileSync(proxy, 'proxy fixture');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o700);
    mkdirSync(join(root, 'provider-canaries'), { mode: 0o700 });
    writeFileSync(receiptPath, '{"prior":true}\n', { mode: 0o600 });

    await expect(runProviderCanary({
      providerId: 'codex-cli',
      stateRoot: root,
      proxyScriptPath: proxy,
      binary,
      binaryVersion: 'fake-provider 1.0',
    }, {
      executeOwnedProvider: async () => ({
        ...pass,
        dynamicToolsList: false,
      }),
    })).rejects.toThrow(/unproven/);

    expect(() => readFileSync(receiptPath)).toThrow();
  });

  it('preserves an exact prior receipt when setup never exercises the provider', async () => {
    const root = tempRoot();
    const proxy = join(root, 'proxy.ts');
    const binary = join(root, 'fake-provider');
    const receiptPath = join(root, 'provider-canaries', 'codex-cli.json');
    writeFileSync(proxy, 'proxy fixture');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o700);
    mkdirSync(join(root, 'provider-canaries'), { mode: 0o700 });
    writeFileSync(receiptPath, '{"prior":true}\n', { mode: 0o600 });

    await expect(runProviderCanary({
      providerId: 'codex-cli',
      stateRoot: root,
      proxyScriptPath: proxy,
      binary,
      binaryVersion: 'fake-provider 1.0',
    }, {
      executeOwnedProvider: async () => ({
        ...pass,
        providerStarted: false,
        conclusive: false,
        dynamicInitialize: false,
      }),
    })).rejects.toThrow(/unproven/);

    expect(readFileSync(receiptPath, 'utf8')).toBe('{"prior":true}\n');
  });

  it('preserves an exact prior receipt under same-provider lock contention', async () => {
    const root = tempRoot();
    const proxy = join(root, 'proxy.ts');
    const binary = join(root, 'fake-provider');
    const receiptDirectory = join(root, 'provider-canaries');
    const receiptPath = join(receiptDirectory, 'codex-cli.json');
    writeFileSync(proxy, 'proxy fixture');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o700);
    mkdirSync(receiptDirectory, { mode: 0o700 });
    writeFileSync(receiptPath, '{"prior":true}\n', { mode: 0o600 });
    const lock = acquireProcessLock(join(receiptDirectory, 'codex-cli.lock'));
    try {
      await expect(runProviderCanary({
        providerId: 'codex-cli',
        stateRoot: root,
        proxyScriptPath: proxy,
        binary,
        binaryVersion: 'fake-provider 1.0',
      })).rejects.toThrow(/process lock active/);
      expect(readFileSync(receiptPath, 'utf8')).toBe('{"prior":true}\n');
    } finally {
      releaseProcessLock(lock);
    }
  });
});

type ProcessGroupReap = { reaped: boolean; reapError?: string; inconclusive?: true };
type ReapDeps = {
  kill?: GroupSignalSeam;
  probeGroup?: (pgid: number) => GroupMembershipAnswer;
  /** The live member pids of the group, or undefined when the listing cannot be read. */
  probeMembers?: (pgid: number) => number[] | undefined;
};
type ReapApi = {
  reapProcessGroup?: (pgid: number, deadlineMs: number, deps?: ReapDeps) => Promise<ProcessGroupReap>;
  /** The optional second argument carries the final reap's seams. */
  executeOwnedProvider?: (
    input: Parameters<typeof executeOwnedProvider>[0],
    reapDeps?: ReapDeps,
  ) => Promise<ProviderCanaryObservation>;
};
// Read through the namespace, so a missing export fails its own assertion instead of the import.
const reapApi = canaryRunner as unknown as ReapApi;

/** Above every pid limit (Linux 4194304, macOS 99999): a seam slip can signal no real group. */
const NO_SUCH_GROUP = 4_194_305;
/** Member pids above every pid limit too, for seams that answer signal 0 to one listed member. */
const NO_SUCH_MEMBER = NO_SUCH_GROUP + 1;
const NO_SUCH_MEMBER_2 = NO_SUCH_GROUP + 2;

/**
 * A group kill seam for the refused-kill cases. SIGTERM to the group is refused with EPERM, and
 * SIGKILL then ends the group. Signal 0 to a member pid (a positive target) is recorded in
 * `memberChecks`, and answers with `memberErrors[pid]` when one is set.
 */
function refusedThenGoneSeam(
  memberChecks: Array<[number, NodeJS.Signals | 0]>,
  memberErrors: Partial<Record<number, 'EPERM' | 'ESRCH' | 'EINVAL'>>,
): GroupSignalSeam {
  let killed = false;
  return (target, signal) => {
    if (target > 0) {
      memberChecks.push([target, signal]);
      const code = memberErrors[target];
      if (code !== undefined) throw groupKillError(code);
      return;
    }
    if (signal === 'SIGTERM') throw groupKillError('EPERM');
    if (signal === 'SIGKILL') { killed = true; return; }
    if (killed) throw groupKillError('ESRCH');
  };
}

type MemberAnswerRow = [
  string,
  () => number[] | undefined,
  Partial<Record<number, 'EPERM' | 'ESRCH' | 'EINVAL'>>,
  number[],
];

/**
 * A group kill refused with EPERM while the probe answers live, where no listed live member itself
 * refuses signal 0: the group-level EPERM was a membership race. Each row gives the member list,
 * the per-member signal-0 answers, and the member pids that must each get one signal-0 check.
 */
const MEMBER_RACE_ROWS: MemberAnswerRow[] = [
  [
    'every listed member accepts signal 0, as when a member forks and exits before its signal',
    () => [NO_SUCH_MEMBER, NO_SUCH_MEMBER_2],
    {},
    [NO_SUCH_MEMBER, NO_SUCH_MEMBER_2],
  ],
  [
    'the listed member joined the group after the kill and accepts signal 0',
    () => [NO_SUCH_MEMBER],
    {},
    [NO_SUCH_MEMBER],
  ],
  [
    'one listed member is already gone and the other accepts signal 0',
    () => [NO_SUCH_MEMBER, NO_SUCH_MEMBER_2],
    { [NO_SUCH_MEMBER]: 'ESRCH' },
    [NO_SUCH_MEMBER, NO_SUCH_MEMBER_2],
  ],
  [
    'signal 0 to the listed member fails with an unexpected code',
    () => [NO_SUCH_MEMBER],
    { [NO_SUCH_MEMBER]: 'EINVAL' },
    [NO_SUCH_MEMBER],
  ],
  ['the member list holds no live member', () => [], {}, []],
  ['the member list cannot be read', () => undefined, {}, []],
  ['the member listing throws', () => { throw new Error('ps failed'); }, {}, []],
];

describe('provider canary process-group reap (issue 3568)', () => {
  it('reads a group whose members are all zombies after SIGTERM as reaped, with no SIGKILL', async () => {
    expect(typeof reapApi.reapProcessGroup).toBe('function');
    if (!reapApi.reapProcessGroup) return;
    const targets: number[] = [];
    const signals: Array<NodeJS.Signals | 0> = [];
    let terminated = false;
    // The macOS shape: kill(-pgid) succeeds while a member lives, then answers EPERM once only
    // zombies remain, and the probe finds no live member.
    const kill: GroupSignalSeam = (target, signal) => {
      targets.push(target);
      signals.push(signal);
      if (signal !== 0) { terminated = true; return; }
      if (terminated) throw groupKillError('EPERM');
    };
    const reap = await reapApi.reapProcessGroup(NO_SUCH_GROUP, Date.now() + 2_000, {
      kill,
      probeGroup: () => (terminated ? 'no-live-members' : 'live'),
    });
    expect(reap).toEqual({ reaped: true });
    expect(signals.filter((signal) => signal !== 0)).toEqual(['SIGTERM']);
    expect(new Set(targets)).toEqual(new Set([-NO_SUCH_GROUP]));
  });

  it('reads a group that holds only zombies from the start as reaped, without signalling it', async () => {
    expect(typeof reapApi.reapProcessGroup).toBe('function');
    if (!reapApi.reapProcessGroup) return;
    const signals: Array<NodeJS.Signals | 0> = [];
    const reap = await reapApi.reapProcessGroup(NO_SUCH_GROUP, Date.now() + 2_000, {
      kill: (_target, signal) => { signals.push(signal); throw groupKillError('EPERM'); },
      probeGroup: () => 'no-live-members',
    });
    expect(reap).toEqual({ reaped: true });
    expect(signals).toEqual([0]);
  });

  it('keeps a group with a live member it may not signal unreaped, and records the EPERM', async () => {
    expect(typeof reapApi.reapProcessGroup).toBe('function');
    if (!reapApi.reapProcessGroup) return;
    const signals: Array<NodeJS.Signals | 0> = [];
    const reap = await reapApi.reapProcessGroup(NO_SUCH_GROUP, Date.now() + 300, {
      kill: (_target, signal) => { signals.push(signal); throw groupKillError('EPERM'); },
      probeGroup: () => 'live',
    });
    expect(reap).toEqual({ reaped: false, reapError: 'group kill failed: EPERM; group membership probe: live' });
    expect(signals.filter((signal) => signal !== 0)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it.each([
    [
      'the probe cannot read the group',
      (): GroupMembershipAnswer => 'unknown',
      'group kill failed: EPERM; group membership probe: unknown',
    ],
    [
      'the probe throws',
      (): GroupMembershipAnswer => { throw new Error('ps failed'); },
      'group kill failed: EPERM; group membership probe: unknown',
    ],
  ] as const)('never reads a group as reaped when %s, and calls the reap inconclusive', async (_case, probeGroup, reapError) => {
    expect(typeof reapApi.reapProcessGroup).toBe('function');
    if (!reapApi.reapProcessGroup) return;
    const reap = await reapApi.reapProcessGroup(NO_SUCH_GROUP, Date.now() + 300, {
      kill: () => { throw groupKillError('EPERM'); },
      probeGroup,
    });
    expect(reap).toEqual({ reaped: false, reapError, inconclusive: true });
  });

  it('reads an unexpected signal-0 error as not reaped and inconclusive, records its code, and never asks the probe', async () => {
    expect(typeof reapApi.reapProcessGroup).toBe('function');
    if (!reapApi.reapProcessGroup) return;
    let probeCalls = 0;
    const reap = await reapApi.reapProcessGroup(NO_SUCH_GROUP, Date.now() + 300, {
      kill: (_target, signal) => { if (signal === 0) throw groupKillError('EINVAL'); },
      probeGroup: () => { probeCalls += 1; return 'no-live-members'; },
    });
    expect(reap).toEqual({ reaped: false, reapError: 'group liveness check failed: EINVAL', inconclusive: true });
    expect(probeCalls).toBe(0);
  });

  it('records an unexpected group-kill error even when the group then goes, and calls the reap inconclusive', async () => {
    expect(typeof reapApi.reapProcessGroup).toBe('function');
    if (!reapApi.reapProcessGroup) return;
    let killed = false;
    // SIGTERM fails with EINVAL and the member lives on; SIGKILL then ends the group.
    const kill: GroupSignalSeam = (_target, signal) => {
      if (signal === 'SIGTERM') throw groupKillError('EINVAL');
      if (signal === 'SIGKILL') { killed = true; return; }
      if (killed) throw groupKillError('ESRCH');
    };
    const reap = await reapApi.reapProcessGroup(NO_SUCH_GROUP, Date.now() + 300, { kill, probeGroup: () => 'live' });
    expect(reap).toEqual({ reaped: true, reapError: 'group kill failed: EINVAL', inconclusive: true });
  });

  it.each([
    [
      'the probe never reads the group after kills that succeed',
      // Every kill succeeds but delivers nothing.
      (): GroupSignalSeam => () => undefined,
      'unknown',
      { reaped: false, reapError: 'group not proven gone; group membership probe: unknown', inconclusive: true },
    ],
    [
      'a liveness check answers live, then a later one fails with EINVAL',
      // The first signal-0 check succeeds and the probe finds a live member; every later check
      // fails. The earlier `live` must not stand for the last check, which read nothing.
      (): GroupSignalSeam => {
        let checks = 0;
        return (_target, signal) => {
          if (signal !== 0) return;
          checks += 1;
          if (checks > 1) throw groupKillError('EINVAL');
        };
      },
      'live',
      { reaped: false, reapError: 'group liveness check failed: EINVAL', inconclusive: true },
    ],
  ] as const)('calls the reap inconclusive when %s: it does not end with a live member', async (_case, makeKill, membership, expected) => {
    expect(typeof reapApi.reapProcessGroup).toBe('function');
    if (!reapApi.reapProcessGroup) return;
    const reap = await reapApi.reapProcessGroup(NO_SUCH_GROUP, Date.now() + 300, {
      kill: makeKill(),
      probeGroup: () => membership,
    });
    expect(reap).toEqual(expected);
  });

  it('keeps the reap conclusive when a kill is refused with EPERM on a live member, even though the group then goes', async () => {
    expect(typeof reapApi.reapProcessGroup).toBe('function');
    if (!reapApi.reapProcessGroup) return;
    // SIGTERM to the group is refused while the probe answers live, and signal 0 to the listed live
    // member is itself refused: member-level evidence about the provider. SIGKILL then ends the group.
    const memberChecks: Array<[number, NodeJS.Signals | 0]> = [];
    const reap = await reapApi.reapProcessGroup(NO_SUCH_GROUP, Date.now() + 300, {
      kill: refusedThenGoneSeam(memberChecks, { [NO_SUCH_MEMBER]: 'EPERM' }),
      probeGroup: () => 'live',
      probeMembers: () => [NO_SUCH_MEMBER],
    });
    expect(reap).toEqual({ reaped: true, reapError: 'group kill failed: EPERM; group membership probe: live' });
    expect(memberChecks).toEqual([[NO_SUCH_MEMBER, 0]]);
  });

  it.each(MEMBER_RACE_ROWS)(
    'calls the reap inconclusive when a kill is refused with EPERM while the probe answers live, but %s, and the group then goes',
    async (_case, probeMembers, memberErrors, checkedMembers) => {
      expect(typeof reapApi.reapProcessGroup).toBe('function');
      if (!reapApi.reapProcessGroup) return;
      const memberChecks: Array<[number, NodeJS.Signals | 0]> = [];
      const reap = await reapApi.reapProcessGroup(NO_SUCH_GROUP, Date.now() + 300, {
        kill: refusedThenGoneSeam(memberChecks, memberErrors),
        probeGroup: () => 'live',
        probeMembers,
      });
      expect(reap).toEqual({
        reaped: true,
        reapError: 'group kill failed: EPERM; group membership probe: live',
        inconclusive: true,
      });
      expect(memberChecks).toEqual(checkedMembers.map((pid) => [pid, 0]));
    },
  );

  it.each([
    [
      'a live member remains after kills that succeed',
      // Every kill succeeds but delivers nothing.
      (): GroupSignalSeam => () => undefined,
      'group not proven gone; group membership probe: live',
    ],
    [
      'a live member remains after group kills that fail with an unexpected code',
      (): GroupSignalSeam => (_target, signal) => { if (signal !== 0) throw groupKillError('EINVAL'); },
      'group kill failed: EINVAL',
    ],
  ] as const)('keeps the reap conclusive when %s: the group is proven not reaped', async (_case, makeKill, reapError) => {
    expect(typeof reapApi.reapProcessGroup).toBe('function');
    if (!reapApi.reapProcessGroup) return;
    const reap = await reapApi.reapProcessGroup(NO_SUCH_GROUP, Date.now() + 300, {
      kill: makeKill(),
      probeGroup: () => 'live',
    });
    expect(reap).toEqual({ reaped: false, reapError });
  });

  /** An owned run whose provider is a plain long-lived process, with the reap left to its own deadline. */
  function ownedInput(root: string, timeoutMs: number): Parameters<typeof executeOwnedProvider>[0] {
    return {
      invocation: {
        providerId: 'codex-cli',
        // The member's own lifetime is the leak net, in case this test's teardown never runs.
        binary: '/bin/sleep',
        args: [String(FIXTURE_LEAK_NET_MS / 1_000)],
        cwd: root,
        stdinFrames: [],
      },
      dynamicSocketPath: join(root, 'd.sock'),
      staticSocketPath: join(root, 's.sock'),
      proxyScriptPath: join(root, 'proxy.ts'),
      isolatedHome: join(root, 'home'),
      isolatedConfig: join(root, 'config'),
      isolatedData: join(root, 'data'),
      isolatedTemp: join(root, 'tmp'),
      // Below the run's 4 s observation margin, so the run goes straight from spawn to the reap.
      timeoutMs,
    };
  }

  /** Kills the run's group in teardown unless it is already gone, then waits within a bound. */
  async function endOwnedGroup(groupTargets: readonly number[]): Promise<boolean> {
    const target = groupTargets[0];
    if (target === undefined) return true;
    if (!(await waitForPidGone(-target, 0))) reapFixtureGroups([target]);
    return waitForPidGone(-target);
  }

  function captureCanaryStderr(): string[] {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return lines;
  }

  it('stops both sentinels and reports the group unreaped and the run inconclusive when the signal-0 check fails unexpectedly', async () => {
    const root = tempRoot();
    const input = ownedInput(root, 1_500);
    const realKill = process.kill.bind(process);
    const groupTargets: number[] = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < -1) {
        groupTargets.push(pid);
        if (signal === 0) throw groupKillError('EINVAL');
      }
      return realKill(pid, signal);
    }) as typeof process.kill);
    const stderrLines = captureCanaryStderr();
    const run = executeOwnedProvider(input);
    try {
      // An unexpected error code proves nothing about the provider, so the run is inconclusive.
      await expect(settleWithin(run, 8_000, 'the owned run did not settle within 8 s'))
        .resolves.toMatchObject({ providerStarted: true, conclusive: false, processGroupReaped: false });
      // The reap no longer throws out of `finally`, so the sentinels are stopped.
      expect(existsSync(input.dynamicSocketPath)).toBe(false);
      expect(existsSync(input.staticSocketPath)).toBe(false);
      const canaryLines = stderrLines.filter((line) => line.startsWith('provider MCP canary:'));
      expect(canaryLines).toHaveLength(1);
      expect(canaryLines[0]).toMatch(
        /^provider MCP canary: process group \d+ not proven reaped \(reapError=group liveness check failed: EINVAL\)\n$/,
      );
    } finally {
      killSpy.mockRestore();
      const gone = await endOwnedGroup(groupTargets);
      await settleWithin(run, 2_000, 'the owned run did not settle after teardown').catch(() => undefined);
      expect(gone).toBe(true);
    }
  }, 20_000);

  it('reports the group unreaped and the run inconclusive when a group kill failed, even though the group then went', async () => {
    const root = tempRoot();
    // Long enough that SIGKILL, sent 2 s after SIGTERM, still has time to end the group.
    const input = ownedInput(root, 3_500);
    const realKill = process.kill.bind(process);
    const groupTargets: number[] = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (pid < -1) {
        groupTargets.push(pid);
        if (signal === 'SIGTERM') throw groupKillError('EINVAL');
      }
      return realKill(pid, signal);
    }) as typeof process.kill);
    const stderrLines = captureCanaryStderr();
    const run = executeOwnedProvider(input);
    try {
      await expect(settleWithin(run, 10_000, 'the owned run did not settle within 10 s'))
        .resolves.toMatchObject({ providerStarted: true, conclusive: false, processGroupReaped: false });
      const canaryLines = stderrLines.filter((line) => line.startsWith('provider MCP canary:'));
      expect(canaryLines).toHaveLength(1);
      expect(canaryLines[0]).toMatch(
        /^provider MCP canary: process group \d+ not proven reaped \(reapError=group kill failed: EINVAL\)\n$/,
      );
      // The SIGKILL after the failed SIGTERM ended the group within the run.
      expect(await waitForPidGone(-groupTargets[0]!, 0)).toBe(true);
    } finally {
      killSpy.mockRestore();
      const gone = await endOwnedGroup(groupTargets);
      await settleWithin(run, 2_000, 'the owned run did not settle after teardown').catch(() => undefined);
      expect(gone).toBe(true);
    }
  }, 20_000);

  /**
   * Reruns the canary over an exact prior receipt. The provider is a real `sh` that exits at once.
   * The reap's seams answer every group kill with EPERM and the probe with `membership`, and
   * deliver no signal, so nothing outlives the test.
   */
  async function rerunOverPriorReceipt(membership: GroupMembershipAnswer): Promise<{
    observation: ProviderCanaryObservation | undefined;
    receiptPath: string;
  }> {
    const root = tempRoot();
    const proxy = join(root, 'proxy.ts');
    const receiptPath = join(root, 'provider-canaries', 'claude-cli.json');
    writeFileSync(proxy, 'proxy fixture');
    mkdirSync(join(root, 'provider-canaries'), { mode: 0o700 });
    writeFileSync(receiptPath, '{"prior":true}\n', { mode: 0o600 });
    captureCanaryStderr();
    let observation: ProviderCanaryObservation | undefined;
    await expect(runProviderCanary({
      providerId: 'claude-cli',
      stateRoot: root,
      proxyScriptPath: proxy,
      binary: '/bin/sh',
      binaryVersion: 'fake-provider 1.0',
      // Below the run's 4 s observation margin, so the run goes straight from spawn to the reap.
      timeoutMs: 1_500,
    }, {
      executeOwnedProvider: async (input) => {
        observation = await reapApi.executeOwnedProvider!(
          { ...input, invocation: { ...input.invocation, args: ['-c', 'exit 0'], stdinFrames: [] } },
          { kill: () => { throw groupKillError('EPERM'); }, probeGroup: () => membership },
        );
        return observation;
      },
    })).rejects.toThrow(/unproven/);
    return { observation, receiptPath };
  }

  it('keeps an exact prior receipt when the reap cannot read the group: the run is inconclusive', async () => {
    expect(typeof reapApi.executeOwnedProvider).toBe('function');
    if (!reapApi.executeOwnedProvider) return;
    const { observation, receiptPath } = await rerunOverPriorReceipt('unknown');
    expect(observation).toMatchObject({ providerStarted: true, conclusive: false, processGroupReaped: false });
    expect(readFileSync(receiptPath, 'utf8')).toBe('{"prior":true}\n');
  });

  it('invalidates an exact prior receipt when the reap ends with a live member: the run stays conclusive', async () => {
    expect(typeof reapApi.executeOwnedProvider).toBe('function');
    if (!reapApi.executeOwnedProvider) return;
    const { observation, receiptPath } = await rerunOverPriorReceipt('live');
    expect(observation).toMatchObject({ providerStarted: true, conclusive: true, processGroupReaped: false });
    expect(existsSync(receiptPath)).toBe(false);
  });
});
