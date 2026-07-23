import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildProviderMcpConfigArgs,
  writeProviderMcpConfig,
} from '../../core/provider-mcp-config.ts';
import {
  deletePrivateFileSync,
  ensurePrivateDirectorySync,
  writeAtomicPrivateFileSync,
} from '../../lib/private-fs.ts';
import {
  acquireProcessLock,
  releaseProcessLock,
} from '../../lib/process-lock.ts';
import { buildChildEnv, getProviderBinary } from './session.ts';
import {
  buildInitializeRequest,
  buildSessionNewRequest,
} from './providers/gemini-acp-parser.ts';
import {
  PROVIDER_IDS,
  isProviderId,
  mcpModeForProvider,
  type ProviderId,
} from './providers/index.ts';
import {
  CANARY_CONTRACT_VERSION,
  collectProviderCanaryEvidence,
  providerCanaryReceiptPath,
  validateProviderCanaryReceipt,
  type ProviderCanaryReceipt,
} from './provider-canary-proof.ts';

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
    case 'claude-cli':
      return { providerId, binary, args: [...configArgs, 'mcp', 'list'], cwd, stdinFrames: [] };
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
        if (!line.trim()) continue;
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

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function waitUntil(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return predicate();
}

async function reapProcessGroup(pgid: number, deadlineMs: number): Promise<boolean> {
  if (!groupExists(pgid)) return true;
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* checked below */ }
  if (await waitUntil(() => !groupExists(pgid), Math.min(deadlineMs, Date.now() + 2_000))) {
    return true;
  }
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* checked below */ }
  return waitUntil(() => !groupExists(pgid), Math.min(deadlineMs, Date.now() + 2_000));
}

export async function executeOwnedProvider(
  input: OwnedExecutionInput,
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
    processGroupReaped = pgid > 0
      ? await reapProcessGroup(pgid, deadline)
      : false;
    await Promise.all([
      dynamicStarted ? dynamic.stop() : Promise.resolve(),
      staticStarted ? staticSentinel.stop() : Promise.resolve(),
    ]);
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
    const receipt: ProviderCanaryReceipt = {
      schemaVersion: 1,
      contractVersion: CANARY_CONTRACT_VERSION,
      recordedAt: new Date().toISOString(),
      ...evidence,
      dynamicInitialize: true,
      dynamicToolsList: true,
      staticConnections: 0,
      proxyDescendant: true,
      processGroupReaped: true,
    };
    const validation = validateProviderCanaryReceipt(receipt, evidence);
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
