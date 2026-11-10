import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isNonEmptyString } from '../../src/lib/type-guards.ts';
import {
  buildProviderMcpConfigArgs,
  writeProviderMcpConfig,
} from '../../src/core/provider-mcp-config.ts';
import {
  deletePrivateFileSync,
  ensurePrivateDirectorySync,
  writeAtomicPrivateFileSync,
  writePrivateFileSync,
} from '../../src/lib/private-fs.ts';
import {
  acquireProcessLock,
  releaseProcessLock,
} from '../../src/lib/process-lock.ts';
import { systemClock } from '../../src/lib/clock.ts';
import {
  groupGone,
  probeGroupMembers,
  probeGroupMembership,
  type GroupMembership,
} from '../../src/lib/process-group-membership.ts';
import { buildChildEnv, getProviderBinary } from '../../src/runtimes/agent/session.ts';
import {
  buildInitializeRequest,
  buildSessionNewRequest,
} from '../../src/runtimes/agent/providers/gemini-acp-parser.ts';
import {
  PROVIDER_IDS,
  isProviderId,
  mcpModeForProvider,
  type ProviderId,
} from '../../src/runtimes/agent/providers/index.ts';
import {
  CANARY_CONTRACT_VERSION,
  collectProviderCanaryEvidence,
  providerCanaryReceiptPath,
  validateProviderCanaryReceipt,
  type ProviderCanaryReceipt,
} from '../../src/runtimes/agent/provider-canary-proof.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
const CANARY_TMP_ROOT = process.platform === 'win32' ? tmpdir() : '/tmp';

export interface ProviderCanaryInvocation {
  providerId: ProviderId;
  binary: string;
  args: string[];
  cwd: string;
  stdinFrames: string[];
}

export interface ProviderCanaryObservation {
  providerStarted: boolean;
  conclusive: boolean;
  dynamicInitialize: boolean;
  dynamicToolsList: boolean;
  staticConnections: number;
  proxyDescendant: boolean;
  processGroupReaped: boolean;
}

export interface RunProviderCanaryOptions {
  providerId: string;
  stateRoot: string;
  proxyScriptPath: string;
  binary?: string;
  binaryVersion?: string;
  timeoutMs?: number;
}

interface OwnedExecutionInput {
  invocation: ProviderCanaryInvocation;
  dynamicSocketPath: string;
  staticSocketPath: string;
  proxyScriptPath: string;
  isolatedHome: string;
  isolatedConfig: string;
  isolatedData: string;
  isolatedTemp: string;
  timeoutMs: number;
}

export interface ProviderCanaryRunnerDeps {
  executeOwnedProvider: (input: OwnedExecutionInput) => Promise<ProviderCanaryObservation>;
}

function assertEligibleProvider(providerId: string): asserts providerId is ProviderId {
  if (!isProviderId(providerId) || mcpModeForProvider(providerId) !== 'stdio_proxy') {
    throw new Error(`eligible provider required; valid providers: ${PROVIDER_IDS.join(', ')}`);
  }
}

export function buildProviderCanaryInvocation(
  providerId: string,
  cwd: string,
  staticSocketPath: string,
  proxyScriptPath: string,
  binaryOverride?: string,
): ProviderCanaryInvocation {
  assertEligibleProvider(providerId);
  writeProviderMcpConfig(providerId, cwd, staticSocketPath, proxyScriptPath);
  const configArgs = buildProviderMcpConfigArgs(
    providerId,
    cwd,
    staticSocketPath,
    proxyScriptPath,
  );
  const binary = binaryOverride ?? getProviderBinary(providerId);
  if (!binary) throw new Error('eligible provider binary is unavailable');
  switch (providerId) {
    case 'claude-cli': {
      const settingsPath = join(cwd, '.whatsoup-canary-settings.json');
      writePrivateFileSync(
        settingsPath,
        `${JSON.stringify({ enableAllProjectMcpServers: true })}\n`,
      );
      return {
        providerId,
        binary,
        args: [
          `--settings=${settingsPath}`,
          '--strict-mcp-config',
          ...configArgs,
          'mcp',
          'list',
        ],
        cwd,
        stdinFrames: [],
      };
    }
    case 'codex-cli':
      return {
        providerId,
        binary,
        args: ['app-server', ...configArgs, '--listen', 'stdio://'],
        cwd,
        stdinFrames: [
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 'canary-initialize',
            method: 'initialize',
            params: {
              clientInfo: { name: 'WhatSoup MCP canary', title: null, version: '1' },
              capabilities: { experimentalApi: true },
            },
          })}\n`,
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 'canary-thread',
            method: 'thread/start',
            params: {
              cwd,
              approvalPolicy: 'never',
              sandbox: 'read-only',
              persistExtendedHistory: false,
            },
          })}\n`,
        ],
      };
    case 'gemini-cli':
      return {
        providerId,
        binary,
        args: ['--acp'],
        cwd,
        stdinFrames: [
          buildInitializeRequest(1),
          buildSessionNewRequest(2, cwd, []),
        ],
      };
    case 'opencode-cli':
      return { providerId, binary, args: ['mcp', 'list', '--pure'], cwd, stdinFrames: [] };
    default:
      throw new Error('eligible provider adapter is unavailable');
  }
}

class RpcSentinel {
  readonly methods = new Set<string>();
  connections = 0;
  readonly socketPath: string;
  private server: Server | null = null;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async start(): Promise<void> {
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off('error', reject);
        chmodSync(this.socketPath, 0o600);
        resolve();
      });
    });
  }

  private handle(socket: Socket): void {
    this.connections += 1;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!isNonEmptyString(line)) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const method = frame['method'];
        if (typeof method !== 'string') continue;
        this.methods.add(method);
        if (!Object.prototype.hasOwnProperty.call(frame, 'id')) continue;
        const result = method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'whatsoup-canary', version: '1' },
            }
          : method === 'tools/list'
            ? { tools: [] }
            : {};
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame['id'], result })}\n`);
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
    try {
      const stat = lstatSync(this.socketPath);
      if (stat.isSocket()) rmSync(this.socketPath);
    } catch {
      // The server or OS may already have removed the exact owned path.
    }
  }
}

function processRows(): Array<{ pid: number; ppid: number; pgid: number; command: string }> {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return output.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }]
      : [];
  });
}

function hasProxyDescendant(rootPid: number, proxyScriptPath: string): boolean {
  const rows = processRows();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return rows.some((row) => {
    if (row.pgid !== rootPid || !row.command.includes(proxyScriptPath)) return false;
    let current = row;
    const visited = new Set<number>();
    while (!visited.has(current.pid)) {
      if (current.ppid === rootPid) return true;
      visited.add(current.pid);
      const parent = byPid.get(current.ppid);
      if (!parent) return false;
      current = parent;
    }
    return false;
  });
}

async function waitUntil(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return predicate();
}

/**
 * What `reapProcessGroup` found. `reapError` names the first failure by error code and probe
 * answer only, never by message, path or command text; when a live member later refuses signal 0
 * after a refused group kill, it names that refusal too. `inconclusive` marks a failure with no live
 * member to show for it: no live member itself refused signal 0, and the reap did not end with a
 * live member. Such a failure is infrastructure state, not evidence about the provider.
 */
export interface ProcessGroupReap {
  reaped: boolean;
  reapError?: string;
  inconclusive?: true;
}

/** Test seams for `reapProcessGroup`. */
export interface ProcessGroupReapDeps {
  /** Defaults to `process.kill`, looked up at call time. Also sends the signal-0 liveness check. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Defaults to `probeGroupMembership`. A probe that throws counts as `unknown`. */
  probeGroup?: (pgid: number) => GroupMembership;
  /**
   * Defaults to `probeGroupMembers`: the group's live member pids, or undefined when the listing
   * cannot be read. A probe that throws counts as unreadable.
   */
  probeMembers?: (pgid: number) => number[] | undefined;
}

/**
 * Ends the provider's process group: SIGTERM, then SIGKILL, each followed by a bounded wait
 * until `groupGone` proves the group gone (issue 3568). A group whose members are all zombies with
 * no running thread is gone; a live member, or a group the probe cannot read, is not.
 *
 * A group kill follows the #3625 contract: ESRCH, or EPERM on a group with no live member, is
 * fine. Any other kill failure, an unexpected liveness-check error, or a group never proven gone
 * is recorded in `reapError`, and the canary passes only without one. A failure is conclusive
 * when the reap ends with the group still holding a live member. It is also conclusive, even if the
 * group then went, when a group kill is refused with EPERM while the probe answers `live` and
 * signal 0 to a listed live member is itself refused with EPERM. A group-level EPERM whose listed
 * live members all accept signal 0, or whose member list cannot be read, is a membership race, for
 * example a member that forked and exited before its signal: it is not a refusal. Any other failure
 * is `inconclusive`. It never throws, so the caller's cleanup always runs.
 */
export async function reapProcessGroup(
  pgid: number,
  deadlineMs: number,
  deps: ProcessGroupReapDeps = {},
): Promise<ProcessGroupReap> {
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals | 0): void => { process.kill(pid, signal); });
  const probeGroup = (group: number): GroupMembership => {
    try {
      return (deps.probeGroup ?? probeGroupMembership)(group);
    } catch {
      return 'unknown';
    }
  };
  let reapError: string | undefined;
  // What the last liveness check could tell about the members. A check that failed tells nothing.
  let lastMembership: 'live' | 'unknown' = 'unknown';
  // A group kill refused with EPERM while a listed live member itself refused signal 0.
  let liveMemberRefused = false;
  // Member-level evidence: true only when signal 0 to a listed live member answers EPERM. Any other
  // answer, or a member list that cannot be read, means the group-level EPERM was a race.
  const liveMemberRefusesSignal = (): boolean => {
    let members: number[] | undefined;
    try {
      members = (deps.probeMembers ?? probeGroupMembers)(pgid);
    } catch {
      return false;
    }
    for (const member of members ?? []) {
      // Pid 0 would address the canary's own group, and pid 1 is never a provider's member.
      if (member <= 1) continue;
      try {
        kill(member, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'EPERM') return true;
      }
    }
    return false;
  };
  const gone = (): boolean => {
    const answer = groupGone(pgid, { kill, probeGroup });
    if (answer.gone) return true;
    if ('error' in answer) {
      reapError ??= `group liveness check failed: ${answer.error}`;
      lastMembership = 'unknown';
    } else {
      lastMembership = answer.membership;
    }
    return false;
  };
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      kill(-pgid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
      if (code === 'ESRCH') return;
      if (code === 'EPERM') {
        const membership = probeGroup(pgid);
        if (membership === 'no-live-members') return;
        const refusal = `group kill failed: EPERM; group membership probe: ${membership}`;
        if (membership === 'live' && !liveMemberRefused && liveMemberRefusesSignal()) {
          liveMemberRefused = true;
          // The refusal makes the reap conclusive, so the stderr line names it even after an earlier error.
          reapError = (reapError === undefined || reapError === refusal) ? refusal : `${reapError}; ${refusal}`;
          return;
        }
        reapError ??= refusal;
        return;
      }
      reapError ??= `group kill failed: ${typeof code === 'string' ? code : 'no error code'}`;
    }
  };
  const result = (reaped: boolean): ProcessGroupReap => {
    if (reapError === undefined) return { reaped };
    // Evidence about the provider: a live member that refused signal 0 after a refused group kill,
    // or a live member at the end.
    const conclusive = liveMemberRefused || (!reaped && lastMembership === 'live');
    return conclusive ? { reaped, reapError } : { reaped, reapError, inconclusive: true };
  };
  if (gone()) return result(true);
  signalGroup('SIGTERM');
  if (await waitUntil(gone, Math.min(deadlineMs, Date.now() + 2_000))) return result(true);
  signalGroup('SIGKILL');
  if (await waitUntil(gone, Math.min(deadlineMs, Date.now() + 2_000))) return result(true);
  // A liveness-check error is already recorded; otherwise name the probe's last answer.
  reapError ??= `group not proven gone; group membership probe: ${lastMembership}`;
  return result(false);
}

/** `reapDeps` are test seams for the final reap, as in `reapProcessGroup`; production passes none. */
export async function executeOwnedProvider(
  input: OwnedExecutionInput,
  reapDeps: ProcessGroupReapDeps = {},
): Promise<ProviderCanaryObservation> {
  const dynamic = new RpcSentinel(input.dynamicSocketPath);
  const staticSentinel = new RpcSentinel(input.staticSocketPath);
  const deadline = Date.now() + input.timeoutMs;
  const observationDeadline = Math.max(Date.now(), deadline - 4_000);
  let proxyDescendant = false;
  let pgid = 0;
  let processGroupReaped = false;
  let providerStarted = false;
  let conclusive = false;
  let controllerFailed = false;
  let childExited = false;
  let dynamicStarted = false;
  let staticStarted = false;
  try {
    await dynamic.start();
    dynamicStarted = true;
    await staticSentinel.start();
    staticStarted = true;
    const childEnv = buildChildEnv(
      input.invocation.providerId,
      {
        whatsoupMcpSocket: input.dynamicSocketPath,
        providerCredentials: 'omit',
      },
    );
    Object.assign(childEnv, {
      HOME: input.isolatedHome,
      XDG_CONFIG_HOME: input.isolatedConfig,
      XDG_DATA_HOME: input.isolatedData,
      XDG_RUNTIME_DIR: input.isolatedTemp,
      XDG_CACHE_HOME: join(input.isolatedHome, '.cache'),
      XDG_STATE_HOME: join(input.isolatedHome, '.local', 'state'),
      TMPDIR: input.isolatedTemp,
      TMP: input.isolatedTemp,
      TEMP: input.isolatedTemp,
    });
    delete childEnv.CLAUDE_CONFIG_DIR;
    delete childEnv.ALLOW_M365_MUTATIONS;
    delete childEnv.SUDO_ASKPASS;
    const child = spawn(input.invocation.binary, input.invocation.args, {
      cwd: input.invocation.cwd,
      detached: true,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    providerStarted = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!providerStarted || !child.pid) {
      throw new Error('provider canary process ownership is unavailable');
    }
    pgid = child.pid;
    child.once('exit', () => {
      childExited = true;
    });
    child.stdout?.resume();
    child.stderr?.resume();
    for (const frame of input.invocation.stdinFrames) child.stdin?.write(frame);
    await waitUntil(() => {
      if (!proxyDescendant) {
        try {
          proxyDescendant = hasProxyDescendant(pgid, input.proxyScriptPath);
        } catch {
          controllerFailed = true;
          return true;
        }
      }
      return childExited || (
        proxyDescendant
        && dynamic.methods.has('initialize')
        && dynamic.methods.has('tools/list')
      );
    }, observationDeadline);
    conclusive = !controllerFailed;
  } catch {
    // Preflight, spawn, and controller failures remain inconclusive so an
    // earlier exact receipt is not invalidated by infrastructure state.
  } finally {
    try {
      if (pgid > 0) {
        const reap = await reapProcessGroup(pgid, deadline, reapDeps);
        // A recorded failure keeps the proof unproven, even when the group then went (#3625).
        processGroupReaped = reap.reaped && reap.reapError === undefined;
        // An inconclusive reap is infrastructure state, so an earlier exact receipt stays valid.
        if (reap.inconclusive === true) conclusive = false;
        if (reap.reapError !== undefined) {
          // Content-free: the group id and the failure classes, never a path or command text. A
          // member-level refusal is named even after an earlier error.
          process.stderr.write(`provider MCP canary: process group ${pgid} not proven reaped (reapError=${reap.reapError})\n`);
        }
      }
    } finally {
      await Promise.all([
        dynamicStarted ? dynamic.stop() : Promise.resolve(),
        staticStarted ? staticSentinel.stop() : Promise.resolve(),
      ]);
    }
  }
  return {
    providerStarted,
    conclusive,
    dynamicInitialize: dynamic.methods.has('initialize'),
    dynamicToolsList: dynamic.methods.has('tools/list'),
    staticConnections: staticSentinel.connections,
    proxyDescendant,
    processGroupReaped,
  };
}

function observationPassed(value: ProviderCanaryObservation): boolean {
  return (
    value.providerStarted
    && value.conclusive
    && value.dynamicInitialize
    && value.dynamicToolsList
    && value.staticConnections === 0
    && value.proxyDescendant
    && value.processGroupReaped
  );
}

export async function runProviderCanary(
  options: RunProviderCanaryOptions,
  deps: ProviderCanaryRunnerDeps = { executeOwnedProvider },
): Promise<ProviderCanaryReceipt> {
  assertEligibleProvider(options.providerId);
  const receiptDirectory = join(options.stateRoot, 'provider-canaries');
  ensurePrivateDirectorySync(receiptDirectory);
  const lock = acquireProcessLock(join(receiptDirectory, `${options.providerId}.lock`));
  try {
    return await runLockedProviderCanary(options, deps);
  } finally {
    releaseProcessLock(lock);
  }
}

async function runLockedProviderCanary(
  options: RunProviderCanaryOptions,
  deps: ProviderCanaryRunnerDeps,
): Promise<ProviderCanaryReceipt> {
  const receiptPath = providerCanaryReceiptPath(options.stateRoot, options.providerId);
  const runDir = realpathSync(
    mkdtempSync(join(CANARY_TMP_ROOT, 'wspc-')),
  );
  chmodSync(runDir, 0o700);
  const isolatedHome = join(runDir, 'home');
  const isolatedConfig = join(runDir, 'config');
  const isolatedData = join(runDir, 'data');
  const isolatedTemp = join(runDir, 'tmp');
  const workspace = join(runDir, 'workspace');
  for (const directory of [
    isolatedHome,
    join(isolatedHome, '.cache'),
    join(isolatedHome, '.local', 'state'),
    isolatedConfig,
    isolatedData,
    isolatedTemp,
    workspace,
  ]) {
    ensurePrivateDirectorySync(directory);
  }
  const staticSocketPath = join(runDir, 'static.sock');
  const dynamicSocketPath = join(runDir, 'dynamic.sock');
  try {
    const binary = options.binary ?? getProviderBinary(options.providerId);
    if (!binary) throw new Error('provider binary is unavailable');
    const invocation = buildProviderCanaryInvocation(
      options.providerId,
      workspace,
      staticSocketPath,
      options.proxyScriptPath,
      binary,
    );
    const observation = await deps.executeOwnedProvider({
      invocation,
      dynamicSocketPath,
      staticSocketPath,
      proxyScriptPath: options.proxyScriptPath,
      isolatedHome,
      isolatedConfig,
      isolatedData,
      isolatedTemp,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (!observationPassed(observation)) {
      if (observation.providerStarted && observation.conclusive) {
        deletePrivateFileSync(receiptPath, 'provider canary receipt');
      }
      throw new Error('provider MCP canary is unproven');
    }
    const evidence = collectProviderCanaryEvidence(
      options.providerId,
      binary,
      options.proxyScriptPath,
      options.binaryVersion,
    );
    const nowMs = systemClock.now();
    const receipt: ProviderCanaryReceipt = {
      schemaVersion: 1,
      contractVersion: CANARY_CONTRACT_VERSION,
      recordedAt: new Date(nowMs).toISOString(),
      ...evidence,
      dynamicInitialize: true,
      dynamicToolsList: true,
      staticConnections: 0,
      proxyDescendant: true,
      processGroupReaped: true,
    };
    const validation = validateProviderCanaryReceipt(receipt, evidence, nowMs);
    if (!validation.proven) throw new Error('provider MCP canary receipt is unproven');
    writeAtomicPrivateFileSync(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
      'provider canary receipt',
      'required',
    );
    return receipt;
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}
