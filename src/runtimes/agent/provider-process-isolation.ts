import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { SERVICE_ENV_MAP } from '../../lib/provider-key-service.ts';

const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 1024;
const ISOLATED_PATH = '/usr/bin:/bin';
const DEFAULT_RECEIPT_TIMEOUT_MS = 10_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_REAP_TIMEOUT_MS = 5_000;

/**
 * A deployment-provided Linux privilege boundary. The launcher and policy are
 * installed outside the agent-writable tree; the controller rechecks both on
 * every provider process launch before trusting the launcher's fd-3 receipt.
 */
export interface ProviderProcessIsolationConfig {
  readonly controllerUid: number;
  readonly controllerGid: number;
  readonly workerUid: number;
  readonly workerGid: number;
  readonly launcherPath: string;
  readonly launcherSha256: string;
  readonly policyPath: string;
  readonly policySha256: string;
  readonly homeDir: string;
  readonly configHome: string;
  readonly dataHome: string;
  /** Credentials, service configuration, browser profiles, and SSH roots the worker must not access. */
  readonly protectedPaths: readonly string[];
}

export class ProviderProcessIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderProcessIsolationError';
  }
}

interface IsolationStat {
  uid: number;
  gid: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

type IsolationChild = ChildProcess;

export interface ProviderProcessIsolationDependencies {
  readonly platform: NodeJS.Platform;
  readonly getuid: () => number | undefined;
  readonly getgid: () => number | undefined;
  readonly lstat: (path: string) => IsolationStat;
  readonly readFile: (path: string) => Buffer;
  readonly sha256: (value: Buffer) => string;
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: { cwd: string; detached: true; stdio: ['pipe', 'pipe', 'pipe', 'pipe']; env: NodeJS.ProcessEnv },
  ) => IsolationChild;
  readonly createNonce: () => string;
  readonly killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearTimer: (timer: NodeJS.Timeout) => void;
  readonly receiptTimeoutMs: number;
  readonly terminationGraceMs: number;
  readonly reapTimeoutMs: number;
}

const defaultDependencies: ProviderProcessIsolationDependencies = {
  platform: process.platform,
  getuid: () => process.getuid?.(),
  getgid: () => process.getgid?.(),
  lstat: lstatSync,
  readFile: readFileSync,
  sha256: (value) => createHash('sha256').update(value).digest('hex'),
  spawn: (command, args, options) => spawn(command, [...args], options) as IsolationChild,
  createNonce: () => randomBytes(32).toString('hex'),
  killProcessGroup: (pid, signal) => process.kill(-pid, signal),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  receiptTimeoutMs: DEFAULT_RECEIPT_TIMEOUT_MS,
  terminationGraceMs: DEFAULT_TERMINATION_GRACE_MS,
  reapTimeoutMs: DEFAULT_REAP_TIMEOUT_MS,
};

const SAFE_ENV_NAMES = new Set([
  'LANG',
  'TERM',
  'WHATSOUP_INSTANCE',
  'WHATSOUP_MCP_SOCKET',
  'WHATSOUP_MCP_SESSION_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  ...Object.values(SERVICE_ENV_MAP).filter((name) => name !== 'WHATSOUP_HEALTH_TOKEN'),
]);

/** Values that the controller deliberately replaces rather than inheriting. */
const RESET_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'TMPDIR',
]);
const VERIFIED_ENV_NAMES = new Set([
  ...SAFE_ENV_NAMES,
  'PATH',
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
]);

const FORBIDDEN_ENV_NAME = /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|SUDO_|SSH_|GIT_(?:ASKPASS|CONFIG|SSH)|WHATSOUP_HEALTH_TOKEN$|WHATSOUP_.*(?:AUTH|BEARER|REFRESH|ACCESS)_|TRANSPORT_.*(?:TOKEN|AUTH|BEARER)|AUTHORIZATION$|.*(?:REFRESH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN)$|(?:CHROME|PLAYWRIGHT|PUPPETEER|BROWSER|CDP)_)/;

function error(message: string): never {
  throw new ProviderProcessIsolationError(message);
}

function configuredPath(value: string, name: string): void {
  if (!isAbsolute(value) || value.includes('\0')) error(`process isolation ${name} must be an absolute path`);
}

function configuredId(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) error(`process isolation ${name} must be a positive non-root ID`);
}

function configuredDigest(value: string, name: string): void {
  if (!DIGEST_RE.test(value)) error(`process isolation ${name} must be a SHA-256 digest`);
}

function boundedTimeout(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    error(`process isolation ${name} must be a bounded positive millisecond duration`);
  }
}

function secureInstalledFile(
  path: string,
  expectedDigest: string,
  label: string,
  deps: ProviderProcessIsolationDependencies,
  requiresSetuid = false,
): void {
  let metadata: IsolationStat;
  try {
    metadata = deps.lstat(path);
  } catch {
    error(`process isolation ${label} is unavailable`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
    error(`process isolation ${label} is not a root-owned non-writable regular file`);
  }
  secureRootOwnedParentDirectories(path, label, deps);
  if (requiresSetuid && (metadata.mode & 0o4000) === 0) {
    error('process isolation launcher is not setuid-root');
  }
  let contents: Buffer;
  try {
    contents = deps.readFile(path);
  } catch {
    error(`process isolation ${label} cannot be read for digest verification`);
  }
  if (deps.sha256(contents) !== expectedDigest) {
    error(`process isolation ${label} digest changed`);
  }
}

function secureRootOwnedParentDirectories(
  path: string,
  label: string,
  deps: ProviderProcessIsolationDependencies,
): void {
  let parent = dirname(path);
  while (true) {
    let metadata: IsolationStat;
    try {
      metadata = deps.lstat(parent);
    } catch {
      error(`process isolation ${label} parent is unavailable`);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      error(`process isolation ${label} parent is not root-owned and non-writable`);
    }
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
}

function secureWorkerDirectory(
  path: string,
  label: string,
  config: ProviderProcessIsolationConfig,
  deps: ProviderProcessIsolationDependencies,
): void {
  let metadata: IsolationStat;
  try {
    metadata = deps.lstat(path);
  } catch {
    error(`process isolation ${label} is unavailable`);
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || metadata.uid !== config.workerUid
    || metadata.gid !== config.workerGid
    || (metadata.mode & 0o077) !== 0
  ) {
    error(`process isolation ${label} is not a private worker directory`);
  }
}

function secureProtectedPath(
  path: string,
  config: ProviderProcessIsolationConfig,
  deps: ProviderProcessIsolationDependencies,
): void {
  let metadata: IsolationStat;
  try {
    metadata = deps.lstat(path);
  } catch {
    error('process isolation protected path is unavailable');
  }
  if (metadata.isSymbolicLink() || metadata.uid === config.workerUid || (metadata.mode & 0o022) !== 0) {
    error('process isolation protected path is writable by or owned by the worker');
  }
  let parent = dirname(path);
  while (true) {
    let parentMetadata: IsolationStat;
    try {
      parentMetadata = deps.lstat(parent);
    } catch {
      error('process isolation protected path parent is unavailable');
    }
    if (
      parentMetadata.isSymbolicLink()
      || !parentMetadata.isDirectory()
      || parentMetadata.uid === config.workerUid
      || (parentMetadata.mode & 0o022) !== 0
    ) {
      error('process isolation protected path parent is writable by or owned by the worker');
    }
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
}

/** Verify the controller-side part of the Linux boundary before every launch. */
export function assertProviderProcessIsolationConfig(
  config: ProviderProcessIsolationConfig,
  dependencies: Partial<ProviderProcessIsolationDependencies> = {},
): void {
  const deps = { ...defaultDependencies, ...dependencies };
  if (deps.platform !== 'linux') error('process isolation is Linux-only; environment stripping is not identity proof');
  for (const [value, name] of [
    [config.controllerUid, 'controllerUid'],
    [config.controllerGid, 'controllerGid'],
    [config.workerUid, 'workerUid'],
    [config.workerGid, 'workerGid'],
  ] as const) configuredId(value, name);
  if (config.controllerUid === config.workerUid) error('process isolation requires distinct controller UID and worker UID');
  if (config.controllerGid === config.workerGid) error('process isolation requires distinct controller GID and worker GID');
  if (deps.getuid() !== config.controllerUid) error('process isolation controller UID attestation failed');
  if (deps.getgid() !== config.controllerGid) error('process isolation controller GID attestation failed');

  for (const [path, name] of [
    [config.launcherPath, 'launcherPath'],
    [config.policyPath, 'policyPath'],
    [config.homeDir, 'homeDir'],
    [config.configHome, 'configHome'],
    [config.dataHome, 'dataHome'],
  ] as const) configuredPath(path, name);
  if (!Array.isArray(config.protectedPaths) || config.protectedPaths.length === 0) {
    error('process isolation requires protected paths');
  }
  for (const protectedPath of config.protectedPaths) configuredPath(protectedPath, 'protected path');
  configuredDigest(config.launcherSha256, 'launcherSha256');
  configuredDigest(config.policySha256, 'policySha256');
  secureInstalledFile(config.launcherPath, config.launcherSha256, 'launcher', deps, true);
  secureInstalledFile(config.policyPath, config.policySha256, 'policy', deps);
  secureWorkerDirectory(config.homeDir, 'homeDir', config, deps);
  secureWorkerDirectory(config.configHome, 'configHome', config, deps);
  secureWorkerDirectory(config.dataHome, 'dataHome', config, deps);
  for (const protectedPath of config.protectedPaths) secureProtectedPath(protectedPath, config, deps);
}

function isForbiddenEnvironmentName(name: string): boolean {
  return FORBIDDEN_ENV_NAME.test(name.replace(/\n/g, ''));
}

function assertCheckedProxyEnvironment(environment: NodeJS.ProcessEnv): void {
  const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;
  const proxyValues = proxyNames.map((name) => environment[name]);
  const hasProxy = proxyValues.some((value) => value !== undefined);
  if (!hasProxy) {
    if (environment.NO_PROXY !== undefined || environment.no_proxy !== undefined) {
      error('process isolation proxy bypass configuration is incomplete');
    }
    return;
  }
  const [proxy] = proxyValues;
  if (
    proxy === undefined
    || !/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d|655[0-2]\d|6553[0-5])$/.test(proxy)
    || proxyValues.some((value) => value !== proxy)
    || environment.NO_PROXY !== 'localhost,127.0.0.1'
    || environment.no_proxy !== 'localhost,127.0.0.1'
  ) {
    error('process isolation proxy must use the checked loopback egress route');
  }
}

/**
 * Rebuild the provider environment from an explicit allowlist. A checked MCP
 * session token is retained only with its Unix-socket proxy; authority tokens,
 * SSH agents, browser pipes, and dynamic-loader injection are launch errors.
 */
export function prepareIsolatedProviderEnvironment(
  source: NodeJS.ProcessEnv,
  config: ProviderProcessIsolationConfig,
  dependencies: Partial<ProviderProcessIsolationDependencies> = {},
): NodeJS.ProcessEnv {
  assertProviderProcessIsolationConfig(config, dependencies);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isForbiddenEnvironmentName(name)) error(`process isolation rejects inherited ${name}`);
    if (RESET_ENV_NAMES.has(name)) continue;
    if (!SAFE_ENV_NAMES.has(name)) error(`process isolation rejects non-allowlisted ${name}`);
    environment[name] = value;
  }
  assertCheckedProxyEnvironment(environment);
  const socket = environment.WHATSOUP_MCP_SOCKET;
  const token = environment.WHATSOUP_MCP_SESSION_TOKEN;
  if ((socket === undefined) !== (token === undefined)) {
    error('process isolation requires an MCP session token to use only the checked Unix-socket proxy');
  }
  if (socket !== undefined && (!isAbsolute(socket) || socket.includes('\0'))) {
    error('process isolation MCP proxy must be an absolute Unix socket path');
  }
  return {
    ...environment,
    PATH: ISOLATED_PATH,
    HOME: config.homeDir,
    XDG_CONFIG_HOME: config.configHome,
    XDG_DATA_HOME: config.dataHome,
  };
}

function parseKernelIds(status: string, label: 'Uid' | 'Gid'): number[] {
  const match = status.match(new RegExp(`^${label}:\\s+(.+)$`, 'm'));
  if (!match) error(`process isolation kernel ${label} proof is missing`);
  const values = match[1]!.trim().split(/\s+/).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isSafeInteger(value))) {
    error(`process isolation kernel ${label} proof is malformed`);
  }
  return values;
}

function parseKernelGroups(status: string): number[] {
  const match = status.match(/^Groups:\s*(.*)$/m);
  if (!match) error('process isolation kernel groups proof is missing');
  if (!match[1]!.trim()) return [];
  const values = match[1]!.trim().split(/\s+/).map(Number);
  if (values.some((value) => !Number.isSafeInteger(value))) error('process isolation kernel groups proof is malformed');
  return values;
}

function parseProcessEnvironment(contents: Buffer): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const entry of contents.toString('utf8').split('\0')) {
    if (!entry) continue;
    const index = entry.indexOf('=');
    if (index <= 0 || Object.prototype.hasOwnProperty.call(env, entry.slice(0, index))) {
      error('process isolation kernel environment proof is malformed');
    }
    env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return env;
}

/**
 * Optional verifier for a privileged external observer with permission to read
 * the worker's /proc entries. An ordinary controller loses that access after a
 * real UID drop, so launch uses the nonce-bound receipt from the protected
 * launcher instead of treating an unavailable /proc read as proof.
 */
export function verifyIsolatedProviderProcess(
  pid: number,
  config: ProviderProcessIsolationConfig,
  dependencies: Partial<ProviderProcessIsolationDependencies> = {},
): void {
  const deps = { ...defaultDependencies, ...dependencies };
  assertProviderProcessIsolationConfig(config, deps);
  if (!Number.isSafeInteger(pid) || pid <= 0) error('process isolation child PID is invalid');
  let status: string;
  let environmentContents: Buffer;
  try {
    status = deps.readFile(`/proc/${pid}/status`).toString('utf8');
    environmentContents = deps.readFile(`/proc/${pid}/environ`);
  } catch {
    error('process isolation kernel proof is unavailable');
  }
  for (const [label, expected] of [
    ['Uid', config.workerUid],
    ['Gid', config.workerGid],
  ] as const) {
    if (parseKernelIds(status, label).some((value) => value !== expected)) {
      error(`process isolation kernel ${label} does not match the worker identity`);
    }
  }
  const groups = parseKernelGroups(status);
  if (groups.length !== 1 || groups[0] !== config.workerGid) {
    error('process isolation child has unexpected supplementary groups');
  }
  const environment = parseProcessEnvironment(environmentContents);
  for (const [name, value] of Object.entries(environment)) {
    if (isForbiddenEnvironmentName(name) || !VERIFIED_ENV_NAMES.has(name)) {
      error(`process isolation child environment contains ${name}`);
    }
    if (value === undefined || value.includes('\0')) {
      error(`process isolation child environment contains an invalid ${name}`);
    }
  }
  if (
    environment.PATH !== ISOLATED_PATH
    ||
    environment.HOME !== config.homeDir
    || environment.XDG_CONFIG_HOME !== config.configHome
    || environment.XDG_DATA_HOME !== config.dataHome
  ) {
    error('process isolation child home/config environment proof does not match the launch policy');
  }
  if ((environment.WHATSOUP_MCP_SOCKET === undefined) !== (environment.WHATSOUP_MCP_SESSION_TOKEN === undefined)) {
    error('process isolation child has an unpaired MCP token route');
  }
  assertCheckedProxyEnvironment(environment);
  for (const protectedPath of config.protectedPaths) secureProtectedPath(protectedPath, config, deps);
}

function isReceipt(value: unknown, pid: number, nonce: string, config: ProviderProcessIsolationConfig): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return Object.keys(receipt).length === 7
    && receipt.version === 1
    && receipt.state === 'isolated'
    && receipt.pid === pid
    && receipt.nonce === nonce
    && receipt.uid === config.workerUid
    && receipt.gid === config.workerGid
    && Array.isArray(receipt.groups)
    && receipt.groups.length === 1
    && receipt.groups[0] === config.workerGid;
}

export interface IsolatedProviderLaunchOptions {
  readonly binary: string;
  /** Digest from the existing provider canary admission for this exact binary. */
  readonly expectedBinarySha256: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly isolation: ProviderProcessIsolationConfig;
}

function isExited(child: IsolationChild): boolean {
  return (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);
}

function isNoSuchProcess(errorValue: unknown): boolean {
  return typeof errorValue === 'object'
    && errorValue !== null
    && 'code' in errorValue
    && (errorValue as NodeJS.ErrnoException).code === 'ESRCH';
}

/** Kill the detached process group and wait for Node to reap its direct child. */
function terminateAndReapIsolatedChild(
  child: IsolationChild,
  deps: ProviderProcessIsolationDependencies,
  directChildAlreadyExited = false,
): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.reject(new ProviderProcessIsolationError('process isolation child has no reappable process-group ID'));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let directChildExited = directChildAlreadyExited || isExited(child);
    let killSent = false;
    let killTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;
    const finish = (failure?: Error): void => {
      if (settled) return;
      settled = true;
      if (killTimer) deps.clearTimer(killTimer);
      if (reapTimer) deps.clearTimer(reapTimer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (failure) reject(failure);
      else resolve();
    };
    const maybeFinish = (): void => {
      if (directChildExited && killSent) finish();
    };
    const onExit = (): void => {
      directChildExited = true;
      maybeFinish();
    };
    const onError = (cause: Error): void => {
      if (isExited(child)) {
        directChildExited = true;
        return maybeFinish();
      }
      finish(new ProviderProcessIsolationError(`process isolation child could not be reaped: ${cause.message}`));
    };
    const send = (signal: NodeJS.Signals): void => {
      try {
        deps.killProcessGroup(pid, signal);
      } catch (cause) {
        if (isNoSuchProcess(cause)) {
          // The group has gone away. Node may still emit the direct-child exit
          // event, but do not wait past the bounded reaping deadline for it.
          return;
        }
        const message = cause instanceof Error ? cause.message : 'unknown process-group termination error';
        finish(new ProviderProcessIsolationError(`process isolation child process-group termination failed: ${message}`));
      }
    };

    child.once('exit', onExit);
    child.once('error', onError);
    killTimer = deps.setTimer(() => {
      killSent = true;
      send('SIGKILL');
      maybeFinish();
    }, deps.terminationGraceMs);
    reapTimer = deps.setTimer(
      () => finish(new ProviderProcessIsolationError('process isolation child did not exit after bounded process-group termination')),
      deps.reapTimeoutMs,
    );
    send('SIGTERM');
  });
}

/**
 * Starts the root-owned launcher and waits for its one-line synchronization
 * receipt. Every failed proof terminates the detached process group and waits
 * for Node to reap the direct child before this promise rejects.
 */
export function launchIsolatedProviderProcess(
  options: IsolatedProviderLaunchOptions,
  dependencies: Partial<ProviderProcessIsolationDependencies> = {},
): Promise<IsolationChild> {
  const deps = { ...defaultDependencies, ...dependencies };
  boundedTimeout(deps.receiptTimeoutMs, 'receipt timeout');
  boundedTimeout(deps.terminationGraceMs, 'termination grace period');
  boundedTimeout(deps.reapTimeoutMs, 'reap timeout');
  configuredPath(options.binary, 'provider binary');
  configuredPath(options.cwd, 'provider cwd');
  configuredDigest(options.expectedBinarySha256, 'provider binary digest');
  secureInstalledFile(options.binary, options.expectedBinarySha256, 'provider binary', deps);
  const env = prepareIsolatedProviderEnvironment(options.env, options.isolation, deps);
  const nonce = deps.createNonce();
  if (!/^[a-f0-9]{64}$/.test(nonce)) {
    return Promise.reject(new ProviderProcessIsolationError('process isolation controller nonce is malformed'));
  }
  let child: IsolationChild;
  try {
    child = deps.spawn(options.isolation.launcherPath, [
        '--policy', options.isolation.policyPath,
        '--receipt-fd', '3',
        '--nonce', nonce,
        '--', options.binary, ...options.args,
    ], {
      cwd: options.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env,
    });
  } catch {
    return Promise.reject(new ProviderProcessIsolationError('process isolation launcher could not start'));
  }
  const receiptStream = child.stdio[3];
  if (!receiptStream || typeof (receiptStream as NodeJS.ReadableStream).on !== 'function') {
    return terminateAndReapIsolatedChild(child, deps).then(
      () => Promise.reject(new ProviderProcessIsolationError('process isolation launcher did not expose its receipt fd')),
      (cleanupFailure: Error) => Promise.reject(cleanupFailure),
    );
  }
  return new Promise<IsolationChild>((resolve, reject) => {
    let bytes = 0;
    let receipt = '';
    let settled = false;
    let receiptTimer: NodeJS.Timeout | undefined;
    const finish = (failure?: Error, alreadyExited = false): void => {
      if (settled) return;
      settled = true;
      if (receiptTimer) deps.clearTimer(receiptTimer);
      receiptStream.removeListener('data', onData);
      receiptStream.removeListener('end', onEnd);
      receiptStream.removeListener('error', onError);
      child.removeListener('error', onChildError);
      child.removeListener('exit', onChildExit);
      if (!failure) return resolve(child);
      void terminateAndReapIsolatedChild(child, deps, alreadyExited).then(
        () => reject(failure),
        (cleanupFailure: Error) => reject(new AggregateError([failure, cleanupFailure], 'process isolation failure cleanup was not proved')),
      );
    };
    const fail = (message: string, alreadyExited = false): void => finish(new ProviderProcessIsolationError(message), alreadyExited);
    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_RECEIPT_BYTES) return fail('process isolation launcher receipt exceeded its limit');
      receipt += buffer.toString('utf8');
    };
    const onEnd = (): void => {
      if (settled) return;
      if (!receipt.endsWith('\n') || receipt.indexOf('\n') !== receipt.length - 1) {
        return fail('process isolation launcher receipt is incomplete');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(receipt);
      } catch {
        return fail('process isolation launcher receipt is malformed');
      }
      if (!isReceipt(parsed, child.pid ?? 0, nonce, options.isolation)) {
        return fail('process isolation launcher receipt does not bind the controller nonce and worker identity');
      }
      finish();
    };
    const onError = (): void => fail('process isolation launcher receipt stream failed');
    const onChildError = (): void => fail('process isolation launcher child failed');
    const onChildExit = (): void => fail('process isolation launcher exited before proof', true);
    receiptStream.on('data', onData);
    receiptStream.on('end', onEnd);
    receiptStream.on('error', onError);
    child.on('error', onChildError);
    child.on('exit', onChildExit);
    receiptTimer = deps.setTimer(
      () => fail('process isolation launcher receipt timed out'),
      deps.receiptTimeoutMs,
    );
  });
}
