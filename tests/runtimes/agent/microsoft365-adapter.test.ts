import { spawnSync } from 'node:child_process';
import {
  accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  m365MutationExceptionAllowed, m365TurnAuthority, m365WorkflowAuthorityLive, narrowM365RoutePolicy, withdrawM365WorkflowAuthority,
  type M365MutationPolicy,
} from '../../../src/core/m365-bridge-policy.ts';
import { SessionTokenRegistry } from '../../../src/mcp/caller-attribution.ts';
import { registerM365WorkflowAuthorityTool } from '../../../src/mcp/m365-workflow-authority.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { WhatSoupSocketServer } from '../../../src/mcp/socket-server.ts';
import type { ExecutingSessionContext, SessionContext } from '../../../src/mcp/types.ts';
import { M365_MUTATION_DENY } from '../../../src/core/settings-template.ts';
import {
  aclListingGrantsNothing,
  admitMicrosoft365Workflow,
  loadMicrosoft365PluginLaunch,
  Microsoft365SettingsFiles,
  microsoft365AuthorityKey,
  microsoft365SpawnPolicy,
  recheckMicrosoft365Workflow,
  registerMicrosoft365Adapter,
} from '../../../src/runtimes/agent/microsoft365-adapter.ts';
import { createProviderMcpBridge } from '../../../src/runtimes/agent/providers/mcp-bridge.ts';
import type { SingletonLoggerMock } from '../../helpers/logger-mock.ts';

type OsModule = typeof os;

const { AGENT365_HOME, FOREIGN_OWNED, IO_ERROR, LS_OVERRIDES, LS_PROBES } = vi.hoisted(() => {
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');
  return {
    AGENT365_HOME: nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'whatsoup-m365-home-'))),
    // Paths that lstat reports as owned by another user: a test cannot chown without root.
    FOREIGN_OWNED: new Set<string>(),
    // Paths whose lstat, stat and read fail with EIO: a test cannot make a disk fail.
    IO_ERROR: new Set<string>(),
    // `/bin/ls` results to report for a path, in place of running it: a failed or unparseable listing.
    LS_OVERRIDES: new Map<string, { status: number; stdout: string }>(),
    // Every `/bin/ls` argument vector the adapter ran, so a test can assert which path and flags it probed.
    LS_PROBES: [] as string[][],
  };
});

// The adapter's own logger, captured so a withdrawal's reason can be asserted; other components log normally.
const adapterLog = vi.hoisted(() => ({}) as SingletonLoggerMock);
vi.mock('../../../src/logger.ts', async (importOriginal: () => Promise<typeof import('../../../src/logger.ts')>) => {
  const actual = await importOriginal();
  const { componentLoggerMock } = await import('../../helpers/logger-mock.ts');
  const mock = componentLoggerMock('microsoft365-adapter', actual.createChildLogger);
  Object.assign(adapterLog, mock.log);
  return { ...actual, createChildLogger: mock.createChildLogger };
});

vi.mock('node:os', async (importOriginal: () => Promise<OsModule>) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => AGENT365_HOME };
});

vi.mock('node:fs', async (importOriginal: () => Promise<typeof import('node:fs')>) => {
  const actual = await importOriginal();
  const failWithIoError = (path: import('node:fs').PathLike): void => {
    if (IO_ERROR.has(String(path))) throw Object.assign(new Error(`EIO: i/o error, ${String(path)}`), { code: 'EIO' });
  };
  const lstatSync = ((path: import('node:fs').PathLike, options?: import('node:fs').StatSyncOptions) => {
    failWithIoError(path);
    const stat = actual.lstatSync(path, options);
    if (stat === undefined || !FOREIGN_OWNED.has(String(path))) return stat;
    // Keep the Stats prototype so isFile, isDirectory and isSymbolicLink still answer.
    return Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as typeof stat, stat, { uid: Number(stat.uid) + 1 });
  }) as typeof actual.lstatSync;
  const statSync = ((path: import('node:fs').PathLike, options?: import('node:fs').StatSyncOptions) => {
    failWithIoError(path);
    return actual.statSync(path, options);
  }) as typeof actual.statSync;
  const readFileSync = ((path: import('node:fs').PathOrFileDescriptor, options?: Parameters<typeof actual.readFileSync>[1]) => {
    if (typeof path !== 'number') failWithIoError(path);
    return actual.readFileSync(path, options);
  }) as typeof actual.readFileSync;
  const existsSync = ((path: import('node:fs').PathLike) => !IO_ERROR.has(String(path)) && actual.existsSync(path)) as typeof actual.existsSync;
  return { ...actual, lstatSync, statSync, readFileSync, existsSync };
});

vi.mock('node:child_process', async (importOriginal: () => Promise<typeof import('node:child_process')>) => {
  const actual = await importOriginal();
  const spawnSync = ((command: string, args?: readonly string[], options?: object) => {
    if (command !== '/bin/ls' || args === undefined) return actual.spawnSync(command, args ?? [], options ?? {});
    LS_PROBES.push([...args]);
    const override = LS_OVERRIDES.get(args[args.length - 1] ?? '');
    return override === undefined
      ? actual.spawnSync(command, args, options ?? {})
      : { pid: 0, output: [null, override.stdout, ''], stdout: override.stdout, stderr: '', status: override.status, signal: null };
  }) as typeof actual.spawnSync;
  return { ...actual, spawnSync };
});

const GUARDED_FIXTURE = join(process.cwd(), 'tests/mcp/bin/fake-microsoft365-guarded-mcp.cjs');
const LAUNCHER_FIXTURE = join(process.cwd(), 'tests/mcp/bin/fake-m365-bridge-launcher.py');
const ACCOUNT_ID = 'employee-account';
const EMPLOYEE = '15551230001@s.whatsapp.net';
const DELIVERY_JID = '15551230001@g.us';
const CONVERSATION_KEY = '15551230001_at_g.us';
// The adapter's interpreter rule (microsoft365-adapter.ts, resolvePythonLauncher): an executable regular file whose
// invocation path and real path, every symlink hop and every ancestor belong to root or this user, and are not
// group- or world-writable unless they are sticky directories.
function hasAdmissiblePathChain(path: string): boolean {
  const uid = process.getuid?.();
  const pending = [path];
  const checked = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (checked.has(current)) continue;
    checked.add(current);
    const stat = lstatSync(current);
    if (uid === undefined || (stat.uid !== 0 && stat.uid !== uid)) return false;
    if (stat.isSymbolicLink()) pending.push(resolvePath(dirname(current), readlinkSync(current)));
    else if ((stat.mode & 0o022) !== 0 && (!stat.isDirectory() || (stat.mode & 0o1000) === 0)) return false;
    if (dirname(current) !== current) pending.push(dirname(current));
  }
  return true;
}

function admissibleSystemPython(): string {
  for (const candidate of ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
    try {
      if (!existsSync(candidate)) continue;
      const real = realpathSync(candidate);
      const stat = statSync(real);
      if (!stat.isFile() || (stat.mode & 0o100) === 0) continue;
      accessSync(candidate, constants.X_OK);
      if (hasAdmissiblePathChain(candidate) && hasAdmissiblePathChain(real)) return candidate;
    } catch { /* deliberately: an unreadable candidate is not admissible; try the next */ }
  }
  return '';
}

const SYSTEM_PYTHON = admissibleSystemPython();
const temporaryPaths: string[] = [];
const servers: WhatSoupSocketServer[] = [];

/**
 * The host tool that sets a real ACL entry: macOS `chmod +a` (no root needed for an owned path) or Linux `setfacl`.
 * Empty when neither exists, and the ACL test then cannot run.
 */
const ACL_TOOL = process.platform === 'darwin' ? '/bin/chmod'
  : process.platform === 'linux' && existsSync('/usr/bin/setfacl') ? '/usr/bin/setfacl' : '';
const aclPaths = new Set<string>();

/**
 * Adds an ACL entry that grants another principal access, leaving owner and group/other write bits unchanged.
 * macOS grants write. Linux grants read: there a write grant also sets the group mode bits through the ACL mask,
 * which the mode check already refuses, so only the `+` marker can show the remaining entries.
 */
function grantAclWrite(path: string): void {
  const directory = statSync(path).isDirectory();
  const args = process.platform === 'darwin'
    ? ['+a', `group:everyone allow ${directory ? 'add_file,add_subdirectory,delete_child' : 'write,append'}`, path]
    : ['-m', 'u:65534:r', path];
  const result = spawnSync(ACL_TOOL, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`could not set a fixture ACL: ${result.stderr}`);
  aclPaths.add(path);
}

/** macOS only: an ACL entry that denies a right and grants nothing, like the default on every macOS home directory. */
function denyAclDelete(path: string): void {
  const result = spawnSync('/bin/chmod', ['+a', 'group:everyone deny delete', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`could not set a fixture ACL: ${result.stderr}`);
  aclPaths.add(path);
}

/** Removes every fixture ACL entry; a deny-delete entry also binds the owner, so it must go before removal. */
function clearFixtureAcls(): void {
  for (const path of aclPaths) {
    if (existsSync(path)) spawnSync(ACL_TOOL, process.platform === 'darwin' ? ['-N', path] : ['-b', path]);
  }
  aclPaths.clear();
}

afterEach(() => {
  vi.unstubAllEnvs();
  FOREIGN_OWNED.clear();
  IO_ERROR.clear();
  LS_OVERRIDES.clear();
  LS_PROBES.length = 0;
  clearFixtureAcls();
  for (const server of servers.splice(0)) server.stop();
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
  rmSync(AGENT365_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(AGENT365_HOME, { recursive: true, mode: 0o700 });
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function pluginDirectory(trace: string, valid = true): { root: string; python: string; launcher: string; config: string; entry: string } {
  const root = temporaryDirectory('whatsoup-m365-plugin-');
  const entry = join(root, 'mcp-server', 'dist', 'index.cjs');
  const python = join(AGENT365_HOME, '.local', 'opt', 'agent365', 'launchers', '57a3b84', '.venv', 'bin', 'python3.12');
  const launcher = join(AGENT365_HOME, '.local', 'opt', 'agent365', 'launchers', '57a3b84', 'm365_bridge_launcher.py');
  const config = join(AGENT365_HOME, '.config', 'agent365', 'm365-bridge.json');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'mcp-server', 'dist'), { recursive: true });
  mkdirSync(join(AGENT365_HOME, '.local', 'opt', 'agent365', 'launchers', '57a3b84', '.venv', 'bin'), { recursive: true, mode: 0o700 });
  mkdirSync(join(AGENT365_HOME, '.config', 'agent365'), { recursive: true, mode: 0o700 });
  copyFileSync(GUARDED_FIXTURE, entry);
  copyFileSync(LAUNCHER_FIXTURE, launcher);
  chmodSync(launcher, 0o700);
  writeFileSync(python, `#!/bin/sh\nexec ${SYSTEM_PYTHON} \"$@\"\n`, { mode: 0o700 });
  chmodSync(python, 0o700);
  writeFileSync(config, '{}', { mode: 0o600 });
  chmodSync(config, 0o600);
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'microsoft_365', version: 'fixture-v1',
    mcpServers: { microsoft_365: valid ? admittedServerShape() : { command: '/bin/sh', args: ['-c', 'bad'] } },
  }));
  return { root, python, launcher, config, entry };
}

/** The guarded manifest's single server, as `pluginDirectory` writes it: the shape a native copy must repeat exactly. */
function admittedServerShape(): Record<string, unknown> {
  const release = join(AGENT365_HOME, '.local', 'opt', 'agent365', 'launchers', '57a3b84');
  return {
    command: SYSTEM_PYTHON,
    args: [
      join(release, 'm365_bridge_launcher.py'), '--config', join(AGENT365_HOME, '.config', 'agent365', 'm365-bridge.json'),
      '--', '${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.cjs',
    ],
    env: {
      MS365_CLIENT_ID: 'fixture-client-id',
      MS365_TENANT_ID: '11111111-2222-3333-4444-555555555555',
      MS365_PROFILE: 'user-full-v1',
      MS365_WORKFLOW_AUTHORITY_REQUIRED: '1',
    },
  };
}

/** Adds top-level keys to a pluginDirs copy's manifest. */
function extendManifest(root: string, extra: Record<string, unknown>): void {
  const manifestPath = join(root, '.claude-plugin', 'plugin.json');
  writeFileSync(manifestPath, JSON.stringify({ ...(JSON.parse(readFileSync(manifestPath, 'utf8')) as object), ...extra }));
}

/** What a withdrawal leaves: the bridge environment without the workflow assignment. */
function withdrawnShape(approved: M365MutationPolicy): M365MutationPolicy {
  return { status: 'approved', childEnv: approved.status === 'approved' ? approved.childEnv : {} };
}

function setManifestCommand(root: string, command: string): void {
  const manifestPath = join(root, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    mcpServers: { microsoft_365: { command: string } };
  };
  manifest.mcpServers.microsoft_365.command = command;
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

function writeExecutable(path: string): void {
  writeFileSync(path, `#!/bin/sh\nexec ${SYSTEM_PYTHON} \"$@\"\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function policy(trace: string): M365MutationPolicy {
  return { status: 'approved', workflowAuthority: { accountId: ACCOUNT_ID, employeeActorJid: EMPLOYEE }, childEnv: {
    ALLOW_M365_MUTATIONS: '1', MS365_AGENT365_BRIDGE: 'true',
    MS365_AGENT365_BASE_URL: 'https://127.0.0.1:10000', MS365_AGENT365_API_KEY: 'test-agent365-key',
    MS365_AGENT365_ACCOUNT_ID: ACCOUNT_ID, MS365_TENANT_ID: '11111111-2222-3333-4444-555555555555',
    MS365_PROFILE: 'user-full-v1', MS365_HUB_URL: 'https://127.0.0.1:10000',
    MS365_DURABLE_MAIL_STATE_DIR: dirname(trace),
    UNRELATED_M365_FIXTURE_SECRET: 'must-not-reach-child',
    MS365_WORKFLOW_AUTHORITY_SOCKET: '/untrusted-policy-authority.sock',
    WHATSOUP_MCP_SESSION_TOKEN: 'untrusted-policy-token',
  } };
}

function authorizedExecuting(): ExecutingSessionContext {
  return {
    actorJid: EMPLOYEE, purpose: undefined, conversationKey: CONVERSATION_KEY, requestRef: 'request-fixture',
    workflowAuthority: { accountId: ACCOUNT_ID, employeeActorJid: EMPLOYEE }, workflowAuthorityScope: 'per_chat',
    m365RouteProvider: 'claude-cli',
  };
}

const NATIVE_REGISTRY = join(AGENT365_HOME, '.claude', 'plugins', 'installed_plugins.json');

/**
 * Installs the copy that `enabledPlugins` names, the way the Claude CLI records it:
 * `installed_plugins.json` lists each install path under the plugin key.
 */
function nativeInstall(
  entrySource: string,
  server: Record<string, unknown> = admittedServerShape(),
  manifestExtra: Record<string, unknown> = {},
): string {
  const root = join(AGENT365_HOME, '.claude', 'plugins', 'microsoft-365');
  // Each install starts from an empty directory, so no file of an earlier install survives.
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'mcp-server', 'dist'), { recursive: true });
  copyFileSync(entrySource, join(root, 'mcp-server', 'dist', 'index.cjs'));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'microsoft_365', version: 'fixture-v1', mcpServers: { microsoft_365: server }, ...manifestExtra,
  }));
  writeFileSync(NATIVE_REGISTRY, JSON.stringify({
    version: 2,
    plugins: { 'microsoft_365@microsoft-365-dev': [{ scope: 'user', installPath: root, version: 'fixture-v1' }] },
  }));
  return root;
}

const BROKER_REQUEST = {
  version: 1, toolName: 'send-mail', params: { subject: 'Hi' }, accountId: ACCOUNT_ID, requestId: 'plugin-request-1',
};

/**
 * Talks to a broker socket the way the guarded plugin does: the session notification
 * first, then `initialize`, then one `authorize_m365_action`. `beforeCall` runs after
 * the server has answered `initialize`, so it has already read the token.
 */
function brokerExchange(
  socketPath: string,
  token: string,
  beforeCall: () => void = () => {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/whatsoup/session', params: { token } })}\n`);
      client.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'broker-test', version: '1' } } })}\n`);
    });
    let buffer = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; result?: { content?: Array<{ text?: string }> } };
        if (message.id === 1) {
          Promise.resolve().then(beforeCall).then(() => {
            client.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'authorize_m365_action', arguments: BROKER_REQUEST } })}\n`);
          }, (error: unknown) => { client.destroy(); reject(error); });
        } else if (message.id === 2) {
          client.end();
          resolve(JSON.parse(message.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>);
        }
      }
    });
    client.on('error', reject);
  });
}

async function brokerServer(directory: string, name: string, tokens: SessionTokenRegistry, executing: () => ExecutingSessionContext): Promise<string> {
  const authorityRegistry = new ToolRegistry();
  registerM365WorkflowAuthorityTool(authorityRegistry);
  const socketPath = join(directory, `${name}.sock`);
  const server = new WhatSoupSocketServer(socketPath, authorityRegistry,
    { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID }, executing, undefined, { sessionTokens: tokens });
  servers.push(server);
  await server.startAndWait();
  return socketPath;
}

type BindingTokens = SessionTokenRegistry & {
  mint(binding: Record<string, unknown>): string;
  revoke(token: string): void;
};

function traceRows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

// @skip-env no system python3 passes the adapter's interpreter rule on this host.
describe.skipIf(SYSTEM_PYTHON === '')('Microsoft 365 provider adapter', () => {
  it('admits a secured managed manifest Python launcher and rejects unsafe command paths', () => {
    const trace = join(temporaryDirectory('whatsoup-m365-trace-'), 'm365-fixture-trace.jsonl');
    const plugin = pluginDirectory(trace);

    setManifestCommand(plugin.root, plugin.python);
    expect(loadMicrosoft365PluginLaunch([plugin.root], policy(trace))?.command).toBe(plugin.python);

    setManifestCommand(plugin.root, 'python3');
    expect(loadMicrosoft365PluginLaunch([plugin.root], policy(trace))).toBeUndefined();

    const nonPython = join(dirname(plugin.python), 'node');
    writeExecutable(nonPython);
    setManifestCommand(plugin.root, nonPython);
    expect(loadMicrosoft365PluginLaunch([plugin.root], policy(trace))).toBeUndefined();

    const nonExecutable = join(dirname(plugin.python), 'python3');
    writeExecutable(nonExecutable);
    chmodSync(nonExecutable, 0o600);
    setManifestCommand(plugin.root, nonExecutable);
    expect(loadMicrosoft365PluginLaunch([plugin.root], policy(trace))).toBeUndefined();

    const writable = join(dirname(plugin.python), 'python');
    writeExecutable(writable);
    chmodSync(writable, 0o722);
    setManifestCommand(plugin.root, writable);
    expect(loadMicrosoft365PluginLaunch([plugin.root], policy(trace))).toBeUndefined();

    const unsafeDirectory = join(temporaryDirectory('whatsoup-m365-unsafe-python-'), 'unsafe');
    mkdirSync(unsafeDirectory, { mode: 0o700 });
    chmodSync(unsafeDirectory, 0o777);
    const unsafePython = join(unsafeDirectory, 'python3.12');
    writeExecutable(unsafePython);
    setManifestCommand(plugin.root, unsafePython);
    expect(loadMicrosoft365PluginLaunch([plugin.root], policy(trace))).toBeUndefined();

    const unsafeSymlink = join(dirname(plugin.python), 'python3.11');
    symlinkSync(unsafePython, unsafeSymlink);
    setManifestCommand(plugin.root, unsafeSymlink);
    expect(loadMicrosoft365PluginLaunch([plugin.root], policy(trace))).toBeUndefined();
  });

  it('preserves the installed virtual environment when launching a symlinked Python interpreter', () => {
    const trace = join(temporaryDirectory('whatsoup-m365-trace-'), 'trace.jsonl');
    const plugin = pluginDirectory(trace);
    const venv = join(AGENT365_HOME, 'venv');
    const created = spawnSync('python3', ['-m', 'venv', '--without-pip', '--copies', venv], { encoding: 'utf8' });
    expect(created.error).toBeUndefined();
    expect(created.status, created.stderr).toBe(0);
    const python = join(venv, 'bin', 'python3.99');
    symlinkSync(join(venv, 'bin', 'python'), python);
    setManifestCommand(plugin.root, python);
    const launch = loadMicrosoft365PluginLaunch([plugin.root], policy(trace));
    expect(launch?.command).toBe(python);
    if (!launch) throw new Error('virtual-environment launcher was not admitted');
    const result = spawnSync(launch.command, ['-c', 'import sys; print(sys.prefix)'], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(venv);
  });

  it('rejects an unsafe intermediate symlink even when the final Python target is safe', () => {
    const trace = join(temporaryDirectory('whatsoup-m365-trace-'), 'trace.jsonl');
    const plugin = pluginDirectory(trace);
    const unsafe = join(AGENT365_HOME, 'unsafe');
    mkdirSync(unsafe, { mode: 0o777 });
    chmodSync(unsafe, 0o777);
    const intermediate = join(unsafe, 'python3');
    symlinkSync(SYSTEM_PYTHON, intermediate);
    const python = join(dirname(plugin.python), 'python');
    symlinkSync(intermediate, python);
    setManifestCommand(plugin.root, python);
    expect(loadMicrosoft365PluginLaunch([plugin.root], policy(trace))).toBeUndefined();
  });

  it('rejects an interpreter that the current user cannot execute', () => {
    const trace = join(temporaryDirectory('whatsoup-m365-trace-'), 'trace.jsonl');
    const plugin = pluginDirectory(trace);
    chmodSync(plugin.python, 0o601);
    setManifestCommand(plugin.root, plugin.python);
    expect(loadMicrosoft365PluginLaunch([plugin.root], policy(trace))).toBeUndefined();
  });

  it('rejects interpreter admission when the current user identity is unavailable', () => {
    const trace = join(temporaryDirectory('whatsoup-m365-trace-'), 'trace.jsonl');
    const plugin = pluginDirectory(trace);
    vi.stubGlobal('process', { ...process, getuid: undefined });
    try {
      expect(loadMicrosoft365PluginLaunch([plugin.root], policy(trace))).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('loads only the canonical fixed bridge launcher manifest and policy environment', () => {
    const launcherTmpdir = temporaryDirectory('whatsoup-m365-launcher-tmp-');
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv('TMPDIR', launcherTmpdir);
    vi.stubEnv('LANG', 'en_US.UTF-8');
    vi.stubEnv('NODE_PATH', '/must-not-reach-plugin');
    vi.stubEnv('SUDO_ASKPASS', '/must-not-reach-plugin');
    const trace = join(temporaryDirectory('whatsoup-m365-trace-'), 'm365-fixture-trace.jsonl');
    const valid = pluginDirectory(trace);
    const invalid = pluginDirectory(trace, false);
    const weakened = pluginDirectory(trace);
    const weakenedManifestPath = join(weakened.root, '.claude-plugin', 'plugin.json');
    const weakenedManifest = JSON.parse(readFileSync(weakenedManifestPath, 'utf8')) as {
      mcpServers: { microsoft_365: { env: Record<string, string> } };
    };
    weakenedManifest.mcpServers.microsoft_365.env.MS365_WORKFLOW_AUTHORITY_REQUIRED = '0';
    writeFileSync(weakenedManifestPath, JSON.stringify(weakenedManifest));

    const launch = loadMicrosoft365PluginLaunch([valid.root], policy(trace));
    expect(launch).toMatchObject({
      command: SYSTEM_PYTHON, args: [valid.launcher, '--config', valid.config, '--', valid.entry], accountId: ACCOUNT_ID,
      env: expect.objectContaining({
        HOME: AGENT365_HOME, MS365_CLIENT_ID: 'fixture-client-id', MS365_AGENT365_ACCOUNT_ID: ACCOUNT_ID,
        MS365_DURABLE_MAIL_STATE_DIR: dirname(trace),
        PATH: '/usr/bin:/bin', TMPDIR: launcherTmpdir, LANG: 'en_US.UTF-8',
      }),
    });
    expect(launch?.env.UNRELATED_M365_FIXTURE_SECRET).toBeUndefined();
    expect(launch?.env.MS365_WORKFLOW_AUTHORITY_SOCKET).toBeUndefined();
    expect(launch?.env.WHATSOUP_MCP_SESSION_TOKEN).toBeUndefined();
    expect(launch?.env.NODE_PATH).toBeUndefined();
    expect(launch?.env.SUDO_ASKPASS).toBeUndefined();
    expect(loadMicrosoft365PluginLaunch([invalid.root], policy(trace))).toBeUndefined();
    expect(loadMicrosoft365PluginLaunch([weakened.root], policy(trace))).toBeUndefined();
    expect(loadMicrosoft365PluginLaunch([valid.root, valid.root], policy(trace))).toBeUndefined();

    const conflictingPolicy = policy(trace);
    if (conflictingPolicy.status !== 'approved') throw new Error('fixture policy must be approved');
    conflictingPolicy.childEnv.MS365_CLIENT_ID = 'policy-cannot-replace-manifest-client';
    conflictingPolicy.childEnv.MS365_WORKFLOW_AUTHORITY_REQUIRED = '0';
    expect(loadMicrosoft365PluginLaunch([valid.root], conflictingPolicy)?.env).toMatchObject({
      MS365_CLIENT_ID: 'fixture-client-id', MS365_WORKFLOW_AUTHORITY_REQUIRED: '1',
    });

    const external = pluginDirectory(trace);
    const externalLauncher = join(temporaryDirectory('whatsoup-m365-external-launcher-'), 'm365_bridge_launcher.py');
    copyFileSync(LAUNCHER_FIXTURE, externalLauncher);
    const externalManifestPath = join(external.root, '.claude-plugin', 'plugin.json');
    const externalManifest = JSON.parse(readFileSync(externalManifestPath, 'utf8')) as {
      mcpServers: { microsoft_365: { args: string[] } };
    };
    externalManifest.mcpServers.microsoft_365.args[0] = externalLauncher;
    writeFileSync(externalManifestPath, JSON.stringify(externalManifest));
    expect(loadMicrosoft365PluginLaunch([external.root], policy(trace))).toBeUndefined();

    const externalConfig = pluginDirectory(trace);
    const externalConfigPath = join(temporaryDirectory('whatsoup-m365-external-config-'), 'm365-bridge.json');
    writeFileSync(externalConfigPath, '{}', { mode: 0o600 });
    const externalConfigManifestPath = join(externalConfig.root, '.claude-plugin', 'plugin.json');
    const externalConfigManifest = JSON.parse(readFileSync(externalConfigManifestPath, 'utf8')) as {
      mcpServers: { microsoft_365: { args: string[] } };
    };
    externalConfigManifest.mcpServers.microsoft_365.args[2] = externalConfigPath;
    writeFileSync(externalConfigManifestPath, JSON.stringify(externalConfigManifest));
    expect(loadMicrosoft365PluginLaunch([externalConfig.root], policy(trace))).toBeUndefined();

    const symlinked = pluginDirectory(trace);
    const symlinkTarget = join(temporaryDirectory('whatsoup-m365-launcher-target-'), 'm365_bridge_launcher.py');
    copyFileSync(LAUNCHER_FIXTURE, symlinkTarget);
    rmSync(symlinked.launcher);
    symlinkSync(symlinkTarget, symlinked.launcher);
    expect(loadMicrosoft365PluginLaunch([symlinked.root], policy(trace))).toBeUndefined();

    const symlinkedConfig = pluginDirectory(trace);
    const configTarget = join(temporaryDirectory('whatsoup-m365-config-target-'), 'm365-bridge.json');
    writeFileSync(configTarget, '{}', { mode: 0o600 });
    rmSync(symlinkedConfig.config);
    symlinkSync(configTarget, symlinkedConfig.config);
    expect(loadMicrosoft365PluginLaunch([symlinkedConfig.root], policy(trace))).toBeUndefined();
  });

  it('keeps scheduled reads available while the guarded plugin rejects a write without a current turn', async () => {
    const directory = temporaryDirectory('whatsoup-m365-api-');
    const trace = join(directory, 'm365-fixture-trace.jsonl');
    const registry = new ToolRegistry();
    const authorityRegistry = new ToolRegistry();
    registerM365WorkflowAuthorityTool(authorityRegistry);
    const tokens = new SessionTokenRegistry();
    let executing = authorizedExecuting();
    const socketPath = join(directory, 'authority.sock');
    const server = new WhatSoupSocketServer(socketPath, authorityRegistry,
      { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID },
      () => executing, undefined, { sessionTokens: tokens });
    servers.push(server);
    await server.startAndWait();

    let releaseTransition!: () => void;
    const transitionReady = new Promise<void>((resolve) => { releaseTransition = resolve; });
    const manager = { acquire: vi.fn(() => ({ socketPath, ready: transitionReady })) };
    const plugin = pluginDirectory(trace);
    expect(registerMicrosoft365Adapter({ registry, policy: policy(trace), pluginDirs: [plugin.root],
      perChatMcpSocketManager: manager as never, resolvePerChatMapKey: (jid) => `map:${jid}`, sessionTokens: tokens })).toBe(true);

    const stored: SessionContext = { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID };
    const bridge = createProviderMcpBridge(registry, stored, () => executing);
    expect(bridge.listTools().map((tool) => tool.name)).toContain('microsoft365');
    vi.stubEnv('UNRELATED_M365_FIXTURE_SECRET', 'ambient-secret-must-not-reach-child');
    vi.stubEnv('MS365_WORKFLOW_AUTHORITY_SOCKET', '/ambient-authority-must-not-reach-child.sock');
    vi.stubEnv('WHATSOUP_MCP_SESSION_TOKEN', 'ambient-token-must-not-reach-child');
    try {
      const read = bridge.executeTool('microsoft365', { operation: 'call', name: 'list-mail-messages', args: { folderId: 'inbox' } });
      await Promise.resolve();
      expect(() => readFileSync(trace, 'utf8')).toThrow();
      releaseTransition();
      await expect(read).resolves.toMatchObject({ isError: false });
      expect(manager.acquire).toHaveBeenCalledWith(`map:${DELIVERY_JID}`, DELIVERY_JID, undefined);
      expect(traceRows(trace)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: 'boot', home: AGENT365_HOME, user: expect.any(String), logname: expect.any(String),
          pathPresent: true, durableMailStateDir: directory, unrelatedSecretPresent: false, authoritySocket: socketPath,
        }),
        expect.objectContaining({ event: 'request', method: 'tools/call', params: { name: 'list-mail-messages', arguments: { folderId: 'inbox' } } }),
      ]));
    } finally {
      vi.unstubAllEnvs();
    }

    executing = {
      actorJid: undefined, purpose: undefined, conversationKey: CONVERSATION_KEY, requestRef: undefined, workflowAuthority: undefined,
      m365RouteProvider: 'claude-cli',
    };
    const blocked = await bridge.executeTool('microsoft365', { operation: 'call', name: 'send-mail', args: { subject: 'blocked' } });
    expect(blocked).toMatchObject({ isError: true });
    expect(traceRows(trace)).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'workflow_authority', allowed: false })]));
    expect(traceRows(trace).some((row) => row.event === 'write_dispatched')).toBe(false);

    executing = {
      actorJid: undefined, purpose: 'scheduled-agent-job', conversationKey: CONVERSATION_KEY, requestRef: undefined, workflowAuthority: undefined,
      m365RouteProvider: 'claude-cli',
    };
    const scheduled = createProviderMcpBridge(registry, { ...stored, purpose: 'scheduled-agent-job' }, () => executing);
    await expect(scheduled.executeTool('microsoft365', { operation: 'call', name: 'list-mail-messages', args: {} })).resolves.toMatchObject({ isError: false });
    expect(manager.acquire).toHaveBeenLastCalledWith(`map:${DELIVERY_JID}::scheduled-agent-job`, DELIVERY_JID, 'scheduled-agent-job');
  });

  it('checks a scheduled write against its own turn while a live employee turn runs in the same chat', async () => {
    const directory = temporaryDirectory('whatsoup-m365-scheduled-');
    const trace = join(directory, 'm365-fixture-trace.jsonl');
    const registry = new ToolRegistry();
    const authorityRegistry = new ToolRegistry();
    registerM365WorkflowAuthorityTool(authorityRegistry);
    const tokens = new SessionTokenRegistry();
    const scheduledExecuting: ExecutingSessionContext = {
      actorJid: undefined, purpose: 'scheduled-agent-job', conversationKey: CONVERSATION_KEY, requestRef: undefined, workflowAuthority: undefined,
      m365RouteProvider: 'claude-cli',
    };
    // The employee's live turn executes on the chat key for the whole test.
    const liveSocket = join(directory, 'live.sock');
    const scheduledSocket = join(directory, 'scheduled.sock');
    const live = new WhatSoupSocketServer(liveSocket, authorityRegistry,
      { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID },
      () => authorizedExecuting(), undefined, { sessionTokens: tokens });
    const isolated = new WhatSoupSocketServer(scheduledSocket, authorityRegistry,
      { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID, purpose: 'scheduled-agent-job' },
      () => scheduledExecuting, undefined, { sessionTokens: tokens });
    servers.push(live, isolated);
    await live.startAndWait();
    await isolated.startAndWait();
    const sockets = new Map([[`map:${DELIVERY_JID}`, liveSocket], [`map:${DELIVERY_JID}::scheduled-agent-job`, scheduledSocket]]);
    const manager = { acquire: vi.fn((key: string) => ({ socketPath: sockets.get(key) ?? join(directory, 'unknown.sock'), ready: Promise.resolve() })) };
    const plugin = pluginDirectory(trace);
    expect(registerMicrosoft365Adapter({ registry, policy: policy(trace), pluginDirs: [plugin.root],
      perChatMcpSocketManager: manager as never, resolvePerChatMapKey: (jid) => `map:${jid}`, sessionTokens: tokens })).toBe(true);
    const stored: SessionContext = { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID };
    const writes = () => traceRows(trace).filter((row) => row.event === 'write_dispatched').length;

    // Positive control: the live employee turn's own write is authorized.
    const liveBridge = createProviderMcpBridge(registry, stored, () => authorizedExecuting());
    await expect(liveBridge.executeTool('microsoft365', { operation: 'call', name: 'send-mail', args: { subject: 'live' } }))
      .resolves.toMatchObject({ isError: false });
    expect(writes()).toBe(1);

    const scheduledBridge = createProviderMcpBridge(registry, { ...stored, purpose: 'scheduled-agent-job' }, () => scheduledExecuting);
    await expect(scheduledBridge.executeTool('microsoft365', { operation: 'call', name: 'send-mail', args: { subject: 'scheduled' } }))
      .resolves.toMatchObject({ isError: true });
    expect(manager.acquire).toHaveBeenLastCalledWith(`map:${DELIVERY_JID}::scheduled-agent-job`, DELIVERY_JID, 'scheduled-agent-job');
    expect(traceRows(trace).filter((row) => row.event === 'workflow_authority').map((row) => row.allowed)).toEqual([true, false]);
    expect(writes()).toBe(1);
  });

  it('refuses a scheduled call whose executing register is empty instead of keying the live chat socket (W3)', async () => {
    const directory = temporaryDirectory('whatsoup-m365-unresolved-');
    const trace = join(directory, 'm365-fixture-trace.jsonl');
    const registry = new ToolRegistry();
    const tokens = new SessionTokenRegistry();
    const liveSocket = await brokerServer(directory, 'live', tokens, () => authorizedExecuting());
    const scheduledSocket = join(directory, 'scheduled.sock');
    const sockets = new Map([[`map:${DELIVERY_JID}`, liveSocket], [`map:${DELIVERY_JID}::scheduled-agent-job`, scheduledSocket]]);
    const manager = { acquire: vi.fn((key: string) => ({ socketPath: sockets.get(key) ?? join(directory, 'unknown.sock'), ready: Promise.resolve() })) };
    const plugin = pluginDirectory(trace);
    expect(registerMicrosoft365Adapter({ registry, policy: policy(trace), pluginDirs: [plugin.root],
      perChatMcpSocketManager: manager as never, resolvePerChatMapKey: (jid) => `map:${jid}`, sessionTokens: tokens })).toBe(true);
    const stored: SessionContext = { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID };
    const writes = () => traceRows(trace).filter((row) => row.event === 'write_dispatched').length;

    // Positive control: the live employee turn's own write is authorized.
    await expect(createProviderMcpBridge(registry, stored, () => authorizedExecuting())
      .executeTool('microsoft365', { operation: 'call', name: 'send-mail', args: { subject: 'live' } }))
      .resolves.toMatchObject({ isError: false });
    expect(writes()).toBe(1);

    const acquiredBefore = manager.acquire.mock.calls.length;
    const emptyRegister: ExecutingSessionContext = { actorJid: undefined, purpose: undefined, conversationKey: undefined };
    const scheduledBridge = createProviderMcpBridge(registry, { ...stored, purpose: 'scheduled-agent-job' }, () => emptyRegister);
    await expect(scheduledBridge.executeTool('microsoft365', { operation: 'call', name: 'send-mail', args: { subject: 'scheduled' } }))
      .resolves.toMatchObject({ isError: true });
    expect(manager.acquire.mock.calls.slice(acquiredBefore).map(([key]) => key)).not.toContain(`map:${DELIVERY_JID}`);
    expect(writes()).toBe(1);
  });

  it('refuses a session token minted for one chat socket when it is presented on another chat socket (T2)', async () => {
    const directory = temporaryDirectory('whatsoup-m365-binding-');
    const tokens = new SessionTokenRegistry() as BindingTokens;
    const chatC = await brokerServer(directory, 'chat-c', tokens, () => authorizedExecuting());
    const chatD = await brokerServer(directory, 'chat-d', tokens, () => authorizedExecuting());
    const token = tokens.mint({ kind: 'session', socketPath: chatC });

    await expect(brokerExchange(chatC, token)).resolves.toMatchObject({ allowed: true });
    await expect(brokerExchange(chatD, token)).resolves.toEqual({ allowed: false, code: 'MISSING_SESSION_BINDING' });
  });

  it('refuses a request token once the executing turn on its socket has moved to another request (T3)', async () => {
    const directory = temporaryDirectory('whatsoup-m365-stale-');
    const tokens = new SessionTokenRegistry() as BindingTokens;
    let executing: ExecutingSessionContext = { ...authorizedExecuting(), requestRef: 'request-r1' };
    const socketPath = await brokerServer(directory, 'chat', tokens, () => executing);
    const token = tokens.mint({ kind: 'request', socketPath, conversationKey: CONVERSATION_KEY, requestRef: 'request-r1' });

    await expect(brokerExchange(socketPath, token)).resolves.toMatchObject({ allowed: true, receipt: { requestRef: 'request-r1' } });
    await expect(brokerExchange(socketPath, token, () => { executing = { ...executing, requestRef: 'request-r2' }; }))
      .resolves.toEqual({ allowed: false, code: 'STALE_REQUEST' });
  });

  it('refuses a token revoked after an open connection presented it (T4)', async () => {
    const directory = temporaryDirectory('whatsoup-m365-revoked-');
    const tokens = new SessionTokenRegistry() as BindingTokens;
    const socketPath = await brokerServer(directory, 'chat', tokens, () => authorizedExecuting());
    const token = tokens.mint({ kind: 'session', socketPath });

    await expect(brokerExchange(socketPath, token, () => tokens.revoke(token)))
      .resolves.toEqual({ allowed: false, code: 'MISSING_SESSION_BINDING' });
  });

  it('keys a scheduled job on its own isolated turn unless the runtime is sandboxed per chat', () => {
    const resolvePerChatMapKey = (jid: string) => `map:${jid}`;
    expect(microsoft365AuthorityKey({ deliveryJid: DELIVERY_JID, purpose: undefined }, { resolvePerChatMapKey }))
      .toEqual({ mapKey: `map:${DELIVERY_JID}`, purpose: undefined });
    expect(microsoft365AuthorityKey({ deliveryJid: DELIVERY_JID, purpose: 'scheduled-agent-job' }, { resolvePerChatMapKey }))
      .toEqual({ mapKey: `map:${DELIVERY_JID}::scheduled-agent-job`, purpose: 'scheduled-agent-job' });
    // A sandboxed scheduled job shares the chat key; a static scheduled purpose there would block later live writes.
    expect(microsoft365AuthorityKey({ deliveryJid: DELIVERY_JID, purpose: 'scheduled-agent-job' }, { resolvePerChatMapKey, sandboxPerChat: true }))
      .toEqual({ mapKey: `map:${DELIVERY_JID}`, purpose: undefined });
  });

  it('withdraws the workflow assignment unless the guarded plugin is admitted', () => {
    const trace = join(temporaryDirectory('whatsoup-m365-admission-'), 'm365-fixture-trace.jsonl');
    const approved = policy(trace);
    const options = (pluginDirs: string[], registry: ToolRegistry) => ({
      registry, policy: approved, pluginDirs, perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(),
    });

    const listed = (registry: ToolRegistry) => createProviderMcpBridge(registry,
      { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID }, () => authorizedExecuting())
      .listTools().some((tool) => tool.name === 'microsoft365');

    const unguardedRegistry = new ToolRegistry();
    const withdrawn = admitMicrosoft365Workflow(options([pluginDirectory(trace, false).root], unguardedRegistry));
    expect(withdrawn).toEqual({ status: 'approved', childEnv: approved.status === 'approved' ? approved.childEnv : {} });
    expect(m365MutationExceptionAllowed(withdrawn)).toBe(false);
    expect(listed(unguardedRegistry)).toBe(false);

    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    nativeInstall(GUARDED_FIXTURE);
    const guardedRegistry = new ToolRegistry();
    const kept = admitMicrosoft365Workflow(options([pluginDirectory(trace).root], guardedRegistry));
    expect(kept).toBe(approved);
    expect(m365MutationExceptionAllowed(kept)).toBe(true);
    expect(listed(guardedRegistry)).toBe(true);
  });

  it('refuses a plugin whose entry, manifest or directories are foreign-owned or group/world-writable', () => {
    const trace = join(temporaryDirectory('whatsoup-m365-ownership-'), 'm365-fixture-trace.jsonl');
    // Positive control: the same layout is admitted while its ownership and modes are safe.
    expect(loadMicrosoft365PluginLaunch([pluginDirectory(trace).root], policy(trace))).toBeDefined();

    const entry = (root: string) => join(root, 'mcp-server', 'dist', 'index.cjs');
    const manifest = (root: string) => join(root, '.claude-plugin', 'plugin.json');
    const weakenings: Array<[string, (root: string) => void]> = [
      ['world-writable entry', (root) => chmodSync(entry(root), 0o666)],
      ['group-writable entry', (root) => chmodSync(entry(root), 0o620)],
      ['world-writable manifest', (root) => chmodSync(manifest(root), 0o666)],
      ['world-writable entry directory', (root) => chmodSync(join(root, 'mcp-server', 'dist'), 0o777)],
      ['world-writable manifest directory', (root) => chmodSync(join(root, '.claude-plugin'), 0o777)],
      ['world-writable plugin root', (root) => chmodSync(root, 0o777)],
      ['foreign-owned entry', (root) => FOREIGN_OWNED.add(entry(root))],
      ['foreign-owned manifest', (root) => FOREIGN_OWNED.add(manifest(root))],
      ['foreign-owned entry directory', (root) => FOREIGN_OWNED.add(join(root, 'mcp-server', 'dist'))],
      ['foreign-owned plugin root', (root) => FOREIGN_OWNED.add(root)],
    ];
    for (const [label, weaken] of weakenings) {
      const plugin = pluginDirectory(trace);
      weaken(realpathSync(plugin.root));
      expect(loadMicrosoft365PluginLaunch([plugin.root], policy(trace)), label).toBeUndefined();
      FOREIGN_OWNED.clear();
    }

    const escaped = pluginDirectory(trace);
    const outside = join(temporaryDirectory('whatsoup-m365-outside-entry-'), 'index.cjs');
    copyFileSync(GUARDED_FIXTURE, outside);
    rmSync(escaped.entry);
    symlinkSync(outside, escaped.entry);
    expect(loadMicrosoft365PluginLaunch([escaped.root], policy(trace)), 'entry symlink outside the plugin').toBeUndefined();
  });

  it('withdraws the workflow assignment unless the native enabledPlugins copy runs the admitted entry', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-native-'), 'm365-fixture-trace.jsonl');
    const approved = policy(trace);
    const plugin = pluginDirectory(trace);
    const admit = () => admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: approved, pluginDirs: [plugin.root], perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(),
    });
    const withdrawn = approved.status === 'approved' ? { status: 'approved', childEnv: approved.childEnv } : undefined;

    // No native install record: the copy the Claude CLI loads cannot be checked.
    expect(admit()).toEqual(withdrawn);

    // Positive control: the native copy runs a byte-identical entry through the identical guarded manifest.
    const admittedServer = (JSON.parse(readFileSync(join(plugin.root, '.claude-plugin', 'plugin.json'), 'utf8')) as {
      mcpServers: { microsoft_365: Record<string, unknown> };
    }).mcpServers.microsoft_365;
    expect(admittedServer).toEqual(admittedServerShape());
    const nativeRoot = nativeInstall(GUARDED_FIXTURE, admittedServer);
    expect(admit()).toBe(approved);

    // The native manifest must repeat the admitted server exactly: one server, the same command, args and env,
    // and no hooks or extra servers in the manifest or in the plugin-root files the Claude CLI also loads.
    const nativeVariants: Array<[string, Record<string, unknown>, Record<string, unknown>?, ((root: string) => void)?]> = [
      ['a direct node launch of the entry', { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.cjs'] }],
      ['another interpreter', { ...admittedServer, command: '/bin/sh' }],
      ['an extra argument', { ...admittedServer, args: ['--require', '/fixture/preload.cjs', ...(admittedServer['args'] as string[])] }],
      ['an extra environment value', { ...admittedServer, env: { ...(admittedServer['env'] as Record<string, string>), NODE_OPTIONS: '--require /fixture/preload.cjs' } }],
      ['no environment', { command: admittedServer['command'], args: admittedServer['args'] }],
      ['an extra server', admittedServer, { mcpServers: { microsoft_365: admittedServer, helper: { command: 'node', args: ['/fixture/helper.cjs'] } } }],
      ['a server file path in place of the object', admittedServer, { mcpServers: './.mcp.json' }],
      ['manifest hooks', admittedServer, { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/fixture/hook.sh' }] }] } }],
      ['a plugin-root .mcp.json', admittedServer, {}, (root) => writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{}}')],
      ['a plugin-root hooks file', admittedServer, {}, (root) => {
        mkdirSync(join(root, 'hooks'), { recursive: true });
        writeFileSync(join(root, 'hooks', 'hooks.json'), '{"hooks":{}}');
      }],
    ];
    for (const [label, server, extra, alter] of nativeVariants) {
      const root = nativeInstall(GUARDED_FIXTURE, server, extra);
      alter?.(root);
      expect(admit(), label).toEqual(withdrawn);
    }

    // The native install root, its manifest, its entry and the install record get the plugin's trust rule.
    const nativeWeakenings: Array<[string, (root: string) => void]> = [
      ['world-writable native entry', (root) => chmodSync(join(root, 'mcp-server', 'dist', 'index.cjs'), 0o666)],
      ['world-writable native manifest', (root) => chmodSync(join(root, '.claude-plugin', 'plugin.json'), 0o666)],
      ['world-writable native install root', (root) => chmodSync(root, 0o777)],
      ['world-writable install record', () => chmodSync(NATIVE_REGISTRY, 0o666)],
      ['foreign-owned native entry', (root) => FOREIGN_OWNED.add(join(root, 'mcp-server', 'dist', 'index.cjs'))],
      ['foreign-owned native manifest', (root) => FOREIGN_OWNED.add(join(root, '.claude-plugin', 'plugin.json'))],
      ['foreign-owned native install root', (root) => FOREIGN_OWNED.add(root)],
      ['foreign-owned install record', () => FOREIGN_OWNED.add(NATIVE_REGISTRY)],
    ];
    for (const [label, weaken] of nativeWeakenings) {
      weaken(nativeInstall(GUARDED_FIXTURE));
      expect(admit(), label).toEqual(withdrawn);
      FOREIGN_OWNED.clear();
      chmodSync(NATIVE_REGISTRY, 0o644);
    }

    // Config-root isolation gives a sandboxed child another install record, so the assignment is refused.
    nativeInstall(GUARDED_FIXTURE);
    expect(admit()).toBe(approved);
    vi.stubEnv('WHATSOUP_AGENT_CONFIG_ROOT_ISOLATION', '1');
    expect(admit()).toEqual(withdrawn);
    vi.stubEnv('WHATSOUP_AGENT_CONFIG_ROOT_ISOLATION', undefined);

    // The native entry differs from the admitted one.
    nativeInstall(LAUNCHER_FIXTURE, admittedServer);
    expect(admit()).toEqual(withdrawn);

    // The native manifest runs a file other than the hashed entry.
    nativeInstall(GUARDED_FIXTURE, { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/other.cjs'] });
    expect(admit()).toEqual(withdrawn);

    // The native manifest turns the guard off.
    nativeInstall(GUARDED_FIXTURE, {
      ...admittedServer, env: { ...(admittedServer['env'] as Record<string, string>), MS365_WORKFLOW_AUTHORITY_REQUIRED: '0' },
    });
    expect(admit()).toEqual(withdrawn);

    // The native entry is missing or unreadable.
    nativeInstall(GUARDED_FIXTURE);
    rmSync(join(nativeRoot, 'mcp-server', 'dist', 'index.cjs'));
    expect(admit()).toEqual(withdrawn);

    // The install record is malformed.
    nativeInstall(GUARDED_FIXTURE);
    writeFileSync(NATIVE_REGISTRY, '{"version":2,"plugins":{"microsoft_365@microsoft-365-dev":[{"scope":"user"}]}}');
    expect(admit()).toEqual(withdrawn);

    // A configured CLAUDE_CONFIG_DIR is the registry the Claude CLI reads.
    nativeInstall(GUARDED_FIXTURE);
    vi.stubEnv('CLAUDE_CONFIG_DIR', temporaryDirectory('whatsoup-m365-empty-config-'));
    expect(admit()).toEqual(withdrawn);
  });

  it('re-checks the native copy before each settings write and withdraws authority once it no longer matches', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-recheck-'), 'm365-fixture-trace.jsonl');
    const approved = policy(trace);
    const plugin = pluginDirectory(trace);
    const admittedServer = (JSON.parse(readFileSync(join(plugin.root, '.claude-plugin', 'plugin.json'), 'utf8')) as {
      mcpServers: { microsoft_365: Record<string, unknown> };
    }).mcpServers.microsoft_365;
    const nativeRoot = nativeInstall(GUARDED_FIXTURE, admittedServer);
    const admitted = admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: approved, pluginDirs: [plugin.root], perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(), instanceName: 'test',
    });
    expect(admitted).toBe(approved);
    adapterLog.warn.mockClear();

    // Positive control: the guarded native copy is unchanged, so the write keeps the assignment.
    expect(recheckMicrosoft365Workflow(admitted, 'test')).toBe(approved);
    expect(adapterLog.warn).not.toHaveBeenCalled();

    // A marketplace update replaces the native entry with different bytes mid-run.
    const nativeEntry = join(nativeRoot, 'mcp-server', 'dist', 'index.cjs');
    copyFileSync(LAUNCHER_FIXTURE, nativeEntry);
    const withdrawn = recheckMicrosoft365Workflow(admitted, 'test');
    expect(withdrawn).toEqual({ status: 'approved', childEnv: approved.status === 'approved' ? approved.childEnv : {} });
    expect(m365MutationExceptionAllowed(withdrawn)).toBe(false);
    expect(adapterLog.warn).toHaveBeenCalledTimes(1);
    expect(adapterLog.warn.mock.calls[0]![0]).toEqual({ instance: 'test', reason: 'entry-differs' });
    // The log names a reason, never a path.
    expect(JSON.stringify(adapterLog.warn.mock.calls[0])).not.toContain(AGENT365_HOME);
    expect(JSON.stringify(adapterLog.warn.mock.calls[0])).not.toContain(plugin.root);

    // The withdrawal holds for the rest of the run, even after the guarded bytes return, and logs once.
    copyFileSync(GUARDED_FIXTURE, nativeEntry);
    expect(recheckMicrosoft365Workflow(withdrawn, 'test')).toBe(withdrawn);
    expect(adapterLog.warn).toHaveBeenCalledTimes(1);

    // A policy without an assignment passes through unchecked.
    expect(recheckMicrosoft365Workflow({ status: 'rejected' }, 'test')).toEqual({ status: 'rejected' });
    expect(recheckMicrosoft365Workflow(undefined, 'test')).toBeUndefined();
  });

  it('restores the deny floor in every settings file the runtime wrote once the native copy changes', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-floor-'), 'm365-fixture-trace.jsonl');
    const approved = policy(trace);
    const plugin = pluginDirectory(trace);
    const admittedServer = (JSON.parse(readFileSync(join(plugin.root, '.claude-plugin', 'plugin.json'), 'utf8')) as {
      mcpServers: { microsoft_365: Record<string, unknown> };
    }).mcpServers.microsoft_365;
    const nativeRoot = nativeInstall(GUARDED_FIXTURE, admittedServer);
    const admitted = admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: approved, pluginDirs: [plugin.root], perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(), instanceName: 'test',
    });
    expect(admitted).toBe(approved);
    const enabledPlugins = { 'microsoft_365@microsoft-365-dev': true };
    const settings = (claudeDir: string) => JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as {
      permissions: { deny: string[] }; enabledPlugins?: unknown; hooks?: { PreToolUse?: unknown[] };
    };
    const liftedM365Denies = (claudeDir: string) => M365_MUTATION_DENY.filter((entry) => settings(claudeDir).permissions.deny.includes(entry));
    const sandboxHook = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/fixture/agent-sandbox.sh' }] }] };
    const files = new Microsoft365SettingsFiles();
    // Recorded first, so a failed rewrite must not stop the files after it.
    const failing = join(temporaryDirectory('whatsoup-m365-failing-'), '.claude');
    files.write('chat', failing, enabledPlugins, { hasSandbox: true, m365MutationPolicy: admitted });
    const shared = join(temporaryDirectory('whatsoup-m365-shared-'), '.claude');
    files.write('shared', shared, enabledPlugins, { hasSandbox: false, m365MutationPolicy: admitted });
    const chat = join(temporaryDirectory('whatsoup-m365-chat-'), '.claude');
    mkdirSync(chat, { recursive: true, mode: 0o700 });
    writeFileSync(join(chat, 'settings.json'), JSON.stringify({ hooks: sandboxHook }), { mode: 0o600 });
    files.write('chat', chat, enabledPlugins, { hasSandbox: true, m365MutationPolicy: admitted });
    const removed = join(temporaryDirectory('whatsoup-m365-removed-'), '.claude');
    files.write('chat', removed, enabledPlugins, { hasSandbox: true, m365MutationPolicy: admitted });
    // Positive control: the approved writes lifted the Microsoft 365 mutation denies.
    for (const claudeDir of [failing, shared, chat]) expect(liftedM365Denies(claudeDir)).toEqual([]);
    // One workspace is removed; another can no longer be written.
    rmSync(dirname(removed), { recursive: true, force: true });
    rmSync(join(failing, 'settings.json'));
    mkdirSync(join(failing, 'settings.json'));
    adapterLog.error.mockClear();

    // A re-check that keeps the assignment rewrites nothing.
    expect(files.restoreFloorOnWithdrawal(admitted, recheckMicrosoft365Workflow(admitted, 'test'), 'test')).toBe(approved);
    expect(liftedM365Denies(shared)).toEqual([]);

    // A marketplace update replaces the native entry: the withdrawing re-check restores the floor everywhere.
    copyFileSync(LAUNCHER_FIXTURE, join(nativeRoot, 'mcp-server', 'dist', 'index.cjs'));
    const withdrawn = files.restoreFloorOnWithdrawal(admitted, recheckMicrosoft365Workflow(admitted, 'test'), 'test');
    expect(m365MutationExceptionAllowed(withdrawn)).toBe(false);
    expect(liftedM365Denies(shared)).toEqual([...M365_MUTATION_DENY]);
    expect(liftedM365Denies(chat)).toEqual([...M365_MUTATION_DENY]);
    // Each file keeps the sandbox flag it was written with: the per-chat sandbox hook survives.
    expect(settings(chat).hooks?.PreToolUse).toEqual(sandboxHook.PreToolUse);
    expect(settings(shared).enabledPlugins).toEqual(enabledPlugins);
    // A removed workspace is not recreated.
    expect(existsSync(removed)).toBe(false);
    // The failed write is logged with a reason, never a path.
    expect(adapterLog.error).toHaveBeenCalledTimes(1);
    expect(adapterLog.error.mock.calls[0]![0]).toMatchObject({ instance: 'test', target: 'chat' });
    expect(JSON.stringify(adapterLog.error.mock.calls[0])).not.toContain(failing);
    expect(JSON.stringify(adapterLog.error.mock.calls[0])).not.toContain(tmpdir());

    // The failed rewrite stays pending: every provider spawn is refused, whatever the session's snapshot.
    // Each refusal logs its own line, separate from the restoration failures counted below.
    const restorationFailures = () => adapterLog.error.mock.calls
      .filter((call) => String(call[1]).startsWith('Microsoft 365 deny floor not restored')).length;
    expect(files.hasPendingRestoration()).toBe(true);
    expect(() => microsoft365SpawnPolicy(approved, withdrawn, files)).toThrow(/M365_FLOOR_RESTORATION_PENDING/);
    expect(() => microsoft365SpawnPolicy(withdrawn, withdrawn, files)).toThrow(/M365_FLOOR_RESTORATION_PENDING/);
    expect(adapterLog.error).toHaveBeenCalledTimes(3);
    // A later check that withdraws nothing still retries it; while the file stays unwritable it stays pending.
    expect(files.restoreFloorOnWithdrawal(withdrawn, withdrawn, 'test')).toBe(withdrawn);
    expect(restorationFailures()).toBe(2);
    expect(adapterLog.error).toHaveBeenCalledTimes(4);
    expect(files.hasPendingRestoration()).toBe(true);
    // Once the file can be written, the next check writes the floor there and spawns may proceed.
    rmSync(join(failing, 'settings.json'), { recursive: true });
    writeFileSync(join(failing, 'settings.json'), JSON.stringify({ permissions: { allow: [], deny: [] } }), { mode: 0o600 });
    files.restoreFloorOnWithdrawal(withdrawn, withdrawn, 'test');
    expect(liftedM365Denies(failing)).toEqual([...M365_MUTATION_DENY]);
    expect(files.hasPendingRestoration()).toBe(false);
    expect(restorationFailures()).toBe(2);
    expect(adapterLog.error).toHaveBeenCalledTimes(4);
    // The admitted snapshot narrowed by the withdrawn runtime policy: rejected, so claude-cli gets the
    // full deny set as --disallowedTools and no bridge values.
    expect(microsoft365SpawnPolicy(approved, withdrawn, files)).toEqual({ status: 'rejected' });
    // After a plugin-copy withdrawal even a session created later, without the assignment, is rejected.
    expect(microsoft365SpawnPolicy(withdrawn, withdrawn, files)).toEqual({ status: 'rejected' });
    // Positive control: an admitted runtime keeps its policy at spawn.
    expect(microsoft365SpawnPolicy(admitted, admitted, new Microsoft365SettingsFiles())).toBe(approved);
  });

  it('rejects any policy that carries a workflow assignment but is not the admitted one', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-unadmitted-'), 'm365-fixture-trace.jsonl');
    const approved = policy(trace);
    const plugin = pluginDirectory(trace);
    nativeInstall(GUARDED_FIXTURE);
    const admitted = admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: approved, pluginDirs: [plugin.root], perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(), instanceName: 'test',
    });
    // Positive control: the admitted policy itself keeps its assignment.
    expect(recheckMicrosoft365Workflow(admitted, 'test')).toBe(approved);

    // The admission is bound to the policy it kept, not to its shape: an equal copy or a fresh policy is refused.
    expect(recheckMicrosoft365Workflow(admitted === undefined ? undefined : { ...admitted }, 'test')).toEqual({ status: 'rejected' });
    expect(recheckMicrosoft365Workflow(policy(trace), 'test')).toEqual({ status: 'rejected' });

    // The withdrawn shape carries no assignment, so it still passes through.
    const withdrawn: M365MutationPolicy = { status: 'approved', childEnv: approved.status === 'approved' ? approved.childEnv : {} };
    expect(recheckMicrosoft365Workflow(withdrawn, 'test')).toBe(withdrawn);
  });

  it('refuses reads and writes on a turn whose route is not an admitted Microsoft 365 provider', async () => {
    const directory = temporaryDirectory('whatsoup-m365-route-');
    const trace = join(directory, 'm365-fixture-trace.jsonl');
    const registry = new ToolRegistry();
    const tokens = new SessionTokenRegistry();
    let executing: ExecutingSessionContext = authorizedExecuting();
    const socketPath = await brokerServer(directory, 'chat', tokens, () => executing);
    const manager = { acquire: vi.fn(() => ({ socketPath, ready: Promise.resolve() })) };
    expect(registerMicrosoft365Adapter({ registry, policy: policy(trace), pluginDirs: [pluginDirectory(trace).root],
      perChatMcpSocketManager: manager as never, resolvePerChatMapKey: (jid) => `map:${jid}`, sessionTokens: tokens })).toBe(true);
    const bridge = createProviderMcpBridge(registry,
      { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID }, () => executing);

    // Positive control: the admitted claude-cli route reads.
    await expect(bridge.executeTool('microsoft365', { operation: 'call', name: 'list-mail-messages', args: {} }))
      .resolves.toMatchObject({ isError: false });
    const acquired = manager.acquire.mock.calls.length;

    for (const route of [{ m365RouteProvider: 'codex-cli' }, { m365RouteProvider: 'gemini-cli' }, { m365RouteProvider: undefined }]) {
      // A fallback turn publishes no assignment; even a stale one must not open the adapter.
      executing = { ...authorizedExecuting(), ...route };
      for (const name of ['list-mail-messages', 'send-mail']) {
        const result = await bridge.executeTool('microsoft365', { operation: 'call', name, args: {} });
        expect(result).toMatchObject({ isError: true });
        expect(JSON.stringify(result)).toContain('microsoft365_authority_unavailable');
      }
    }
    expect(manager.acquire.mock.calls.length).toBe(acquired);
    expect(traceRows(trace).filter((row) => row.event === 'write_dispatched')).toHaveLength(0);
  });

  it('refuses a write before acquiring a socket once the runtime withdraws the assignment an existing session snapshotted', async () => {
    const directory = temporaryDirectory('whatsoup-m365-narrow-');
    const trace = join(directory, 'm365-fixture-trace.jsonl');
    const registry = new ToolRegistry();
    const tokens = new SessionTokenRegistry();
    const snapshot = policy(trace);
    // What the existing session's turn publishes, given the runtime's current policy.
    const publish = (current: M365MutationPolicy): ExecutingSessionContext => ({
      ...authorizedExecuting(),
      ...m365TurnAuthority(narrowM365RoutePolicy(snapshot, current), true, 'request-fixture', 'per_chat', 'claude-cli'),
    });
    let executing = publish(snapshot);
    const socketPath = await brokerServer(directory, 'chat', tokens, () => executing);
    const manager = { acquire: vi.fn(() => ({ socketPath, ready: Promise.resolve() })) };
    expect(registerMicrosoft365Adapter({ registry, policy: snapshot, pluginDirs: [pluginDirectory(trace).root],
      perChatMcpSocketManager: manager as never, resolvePerChatMapKey: (jid) => `map:${jid}`, sessionTokens: tokens })).toBe(true);
    const bridge = createProviderMcpBridge(registry,
      { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID }, () => executing);

    // Positive control: while the runtime still holds the snapshot's assignment, the write is authorized and dispatched.
    expect(executing.workflowAuthority).toBe(snapshot.status === 'approved' ? snapshot.workflowAuthority : undefined);
    await expect(bridge.executeTool('microsoft365', { operation: 'call', name: 'send-mail', args: {} }))
      .resolves.toMatchObject({ isError: false });
    const acquired = manager.acquire.mock.calls.length;
    expect(acquired).toBeGreaterThan(0);
    const dispatched = traceRows(trace).filter((row) => row.event === 'write_dispatched').length;
    expect(dispatched).toBeGreaterThan(0);
    const sessionToken = (tokens as BindingTokens).mint({ kind: 'session', socketPath });
    await expect(brokerExchange(socketPath, sessionToken)).resolves.toMatchObject({ allowed: true });

    // The runtime withdraws the assignment while this turn is still executing: the context is NOT republished,
    // yet the adapter refuses before acquiring a socket and the broker refuses the native session's request.
    if (snapshot.status === 'approved') withdrawM365WorkflowAuthority(snapshot.workflowAuthority!);
    const inFlight = await bridge.executeTool('microsoft365', { operation: 'call', name: 'send-mail', args: {} });
    expect(inFlight).toMatchObject({ isError: true });
    expect(JSON.stringify(inFlight)).toContain('microsoft365_authority_unavailable');
    expect(manager.acquire.mock.calls.length).toBe(acquired);
    await expect(brokerExchange(socketPath, sessionToken)).resolves.toEqual({ allowed: false, code: 'WORKFLOW_AUTHORITY_DISABLED' });
    expect(traceRows(trace).filter((row) => row.event === 'write_dispatched')).toHaveLength(dispatched);

    // The same session's next turn publishes nothing.
    executing = publish({ status: 'approved', childEnv: snapshot.status === 'approved' ? snapshot.childEnv : {} });
    expect(executing).toMatchObject({ workflowAuthority: undefined, workflowAuthorityScope: undefined, m365RouteProvider: undefined });
    const refused = await bridge.executeTool('microsoft365', { operation: 'call', name: 'send-mail', args: {} });
    expect(refused).toMatchObject({ isError: true });
    expect(JSON.stringify(refused)).toContain('microsoft365_authority_unavailable');
    expect(manager.acquire.mock.calls.length).toBe(acquired);
    expect(traceRows(trace).filter((row) => row.event === 'write_dispatched')).toHaveLength(dispatched);
  });

  it.each([
    ['replaced entry bytes', (plugin: { entry: string }) => copyFileSync(LAUNCHER_FIXTURE, plugin.entry)],
    ['a world-writable entry', (plugin: { entry: string }) => chmodSync(plugin.entry, 0o666)],
    ['a changed manifest', (plugin: { root: string }) => {
      const manifestPath = join(plugin.root, '.claude-plugin', 'plugin.json');
      writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('fixture-v1', 'fixture-v2'));
    }],
  ])('withdraws the assignment and refuses the next adapter launch once the pluginDirs copy changes (%s)', async (_case, change) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const directory = temporaryDirectory('whatsoup-m365-plugin-pin-');
    const trace = join(directory, 'm365-fixture-trace.jsonl');
    const registry = new ToolRegistry();
    const tokens = new SessionTokenRegistry();
    const plugin = pluginDirectory(trace);
    nativeInstall(GUARDED_FIXTURE);
    let executing: ExecutingSessionContext = authorizedExecuting();
    const socketPath = await brokerServer(directory, 'chat', tokens, () => executing);
    const manager = { acquire: vi.fn(() => ({ socketPath, ready: Promise.resolve() })) };
    const admitted = admitMicrosoft365Workflow({ registry, policy: policy(trace), pluginDirs: [plugin.root],
      perChatMcpSocketManager: manager as never, resolvePerChatMapKey: (jid) => `map:${jid}`, sessionTokens: tokens, instanceName: 'test' });
    if (admitted?.status !== 'approved' || admitted.workflowAuthority === undefined) throw new Error('expected an admitted assignment');
    executing = { ...authorizedExecuting(), workflowAuthority: admitted.workflowAuthority };
    const bridge = createProviderMcpBridge(registry,
      { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID }, () => executing);

    // Positive control: the admitted copy is launched and the assignment holds.
    await expect(bridge.executeTool('microsoft365', { operation: 'call', name: 'list-mail-messages', args: {} }))
      .resolves.toMatchObject({ isError: false });
    expect(recheckMicrosoft365Workflow(admitted, 'test')).toBe(admitted);
    const acquired = manager.acquire.mock.calls.length;
    const launches = traceRows(trace).length;
    adapterLog.warn.mockClear();

    change(plugin);
    const refused = await bridge.executeTool('microsoft365', { operation: 'call', name: 'list-mail-messages', args: {} });
    expect(refused).toMatchObject({ isError: true });
    expect(JSON.stringify(refused)).toContain('microsoft365_authority_unavailable');
    expect(manager.acquire.mock.calls.length).toBe(acquired);
    expect(traceRows(trace)).toHaveLength(launches);
    // The adapter withdrew the assignment for the whole runtime: the in-flight turn's assignment is dead,
    // the next re-check returns the withdrawn policy, and the log names a reason, never a path.
    expect(m365WorkflowAuthorityLive(admitted.workflowAuthority)).toBe(false);
    expect(m365MutationExceptionAllowed(recheckMicrosoft365Workflow(admitted, 'test'))).toBe(false);
    expect(adapterLog.warn.mock.calls.map((call) => call[0])).toContainEqual({ instance: 'test', reason: 'plugin-differs' });
    expect(JSON.stringify(adapterLog.warn.mock.calls)).not.toContain(plugin.root);
  });

  it('marks the published assignment dead when a re-check finds a changed native copy', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-native-dead-'), 'm365-fixture-trace.jsonl');
    const nativeRoot = nativeInstall(GUARDED_FIXTURE);
    const admitted = admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: policy(trace), pluginDirs: [pluginDirectory(trace).root], perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(), instanceName: 'test',
    });
    if (admitted?.status !== 'approved' || admitted.workflowAuthority === undefined) throw new Error('expected an admitted assignment');
    expect(recheckMicrosoft365Workflow(admitted, 'test')).toBe(admitted);
    expect(m365WorkflowAuthorityLive(admitted.workflowAuthority)).toBe(true);
    copyFileSync(LAUNCHER_FIXTURE, join(nativeRoot, 'mcp-server', 'dist', 'index.cjs'));
    expect(m365MutationExceptionAllowed(recheckMicrosoft365Workflow(admitted, 'test'))).toBe(false);
    expect(m365WorkflowAuthorityLive(admitted.workflowAuthority)).toBe(false);
  });

  it.each([
    ['a plugin-root .mcp.json', (copy: { root: string }) => writeFileSync(join(copy.root, '.mcp.json'), '{"mcpServers":{}}')],
    ['a plugin-root hooks file', (copy: { root: string }) => {
      mkdirSync(join(copy.root, 'hooks'), { recursive: true });
      writeFileSync(join(copy.root, 'hooks', 'hooks.json'), '{"hooks":{}}');
    }],
    ['the entry symlink pointed at another file', (copy: { root: string; entry: string }) => {
      writeFileSync(join(copy.root, 'mcp-server', 'dist', 'other.cjs'), `${readFileSync(GUARDED_FIXTURE, 'utf8')}\n// another build\n`);
      rmSync(copy.entry);
      symlinkSync('other.cjs', copy.entry);
    }],
    ['the configured directory pointed at another copy', (copy: { configured: string; trace: string }) => {
      const other = pluginDirectory(copy.trace);
      rmSync(copy.configured);
      symlinkSync(other.root, copy.configured);
    }],
  ])('withdraws the assignment when a pluginDirs loading surface changes after admission (%s)', (_case, change) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-surfaces-'), 'm365-fixture-trace.jsonl');
    const plugin = pluginDirectory(trace);
    // The Claude CLI receives the configured path and follows the entry symlink, so both are resolved again at each check.
    copyFileSync(plugin.entry, join(plugin.root, 'mcp-server', 'dist', 'guarded.cjs'));
    rmSync(plugin.entry);
    symlinkSync('guarded.cjs', plugin.entry);
    const configured = join(temporaryDirectory('whatsoup-m365-configured-'), 'plugin');
    symlinkSync(plugin.root, configured);
    nativeInstall(GUARDED_FIXTURE);
    const approved = policy(trace);
    const admitted = admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: approved, pluginDirs: [configured], perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(), instanceName: 'test',
    });
    // Positive control: the symlinked layout is admitted and an unchanged copy keeps the assignment.
    expect(admitted).toBe(approved);
    expect(recheckMicrosoft365Workflow(admitted, 'test')).toBe(approved);
    adapterLog.warn.mockClear();

    change({ root: plugin.root, entry: plugin.entry, configured, trace });
    expect(recheckMicrosoft365Workflow(admitted, 'test')).toEqual(withdrawnShape(approved));
    expect(adapterLog.warn.mock.calls.map((call) => call[0])).toContainEqual({ instance: 'test', reason: 'plugin-differs' });
  });

  it.each([
    ['an extra server', { mcpServers: { microsoft_365: admittedServerShape(), helper: { command: 'node', args: ['/fixture/helper.cjs'] } } }, undefined],
    ['a command hook', { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '/fixture/hook.sh' }] }] } }, undefined],
    ['a plugin-root .mcp.json', {}, (root: string) => writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{}}')],
    ['a plugin-root hooks file', {}, (root: string) => {
      mkdirSync(join(root, 'hooks'), { recursive: true });
      writeFileSync(join(root, 'hooks', 'hooks.json'), '{"hooks":{}}');
    }],
  ])('withdraws the assignment when matching copies leave the canonical guarded shape (%s)', (_case, manifestExtra, addRootFile) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-canonical-'), 'm365-fixture-trace.jsonl');
    const approved = policy(trace);
    const plugin = pluginDirectory(trace);
    const admit = () => admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: approved, pluginDirs: [plugin.root], perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(),
    });
    // Positive control: canonical copies keep the assignment.
    nativeInstall(GUARDED_FIXTURE);
    expect(admit()).toBe(approved);

    // Both copies carry the same addition, so they still match each other byte for byte.
    extendManifest(plugin.root, manifestExtra);
    const nativeRoot = nativeInstall(GUARDED_FIXTURE, admittedServerShape(), manifestExtra);
    addRootFile?.(plugin.root);
    addRootFile?.(nativeRoot);
    expect(admit()).toEqual(withdrawnShape(approved));
  });

  it.each([
    ['a directory at .mcp.json (EISDIR)', (root: string) => mkdirSync(join(root, '.mcp.json'))],
    ['an unreadable .mcp.json (EACCES)', (root: string) => writeFileSync(join(root, '.mcp.json'), '{}', { mode: 0o000 })],
    ['a looping .mcp.json symlink (ELOOP)', (root: string) => symlinkSync('.mcp.json', join(root, '.mcp.json'))],
    ['a dangling .mcp.json symlink', (root: string) => symlinkSync('missing.json', join(root, '.mcp.json'))],
    ['a regular file at hooks (ENOTDIR)', (root: string) => writeFileSync(join(root, 'hooks'), '')],
    ['an .mcp.json that fails with EIO', (root: string) => IO_ERROR.add(join(realpathSync(root), '.mcp.json'))],
    ['a hooks file that fails with EIO', (root: string) => IO_ERROR.add(join(realpathSync(root), 'hooks', 'hooks.json'))],
  ])('treats only ENOENT as an absent plugin-root file: %s refuses', (_case, alter) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-enoent-'), 'm365-fixture-trace.jsonl');
    const admit = (pluginRoot: string, approved: M365MutationPolicy) => admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: approved, pluginDirs: [pluginRoot], perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(), instanceName: 'test',
    });

    // The native copy is admitted while both root files are absent; a later check meets an error other than ENOENT.
    const nativeRoot = nativeInstall(GUARDED_FIXTURE);
    const approved = policy(trace);
    const admitted = admit(pluginDirectory(trace).root, approved);
    expect(admitted).toBe(approved);
    alter(nativeRoot);
    expect(recheckMicrosoft365Workflow(admitted, 'test')).toEqual(withdrawnShape(approved));

    // The same error in the pluginDirs copy refuses that copy at admission.
    IO_ERROR.clear();
    nativeInstall(GUARDED_FIXTURE);
    const plugin = pluginDirectory(trace);
    const fresh = policy(trace);
    expect(admit(plugin.root, fresh)).toBe(fresh);
    const refused = pluginDirectory(trace);
    alter(refused.root);
    expect(admit(refused.root, fresh)).toEqual(withdrawnShape(fresh));
  });

  // @skip-env this host has no tool that sets a real ACL entry (macOS chmod +a or Linux setfacl).
  it.skipIf(ACL_TOOL === '')('refuses an ACL write grant on each path the trust rule walks, in both copies', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-acl-'), 'm365-fixture-trace.jsonl');
    const cases: Array<[string, 'native' | 'plugin', (root: string) => string]> = [
      ['native entry', 'native', (root) => join(root, 'mcp-server', 'dist', 'index.cjs')],
      ['native manifest', 'native', (root) => join(root, '.claude-plugin', 'plugin.json')],
      ['native install root', 'native', (root) => root],
      ['install record', 'native', () => NATIVE_REGISTRY],
      ['pluginDirs entry', 'plugin', (root) => join(root, 'mcp-server', 'dist', 'index.cjs')],
      ['pluginDirs entry directory', 'plugin', (root) => join(root, 'mcp-server', 'dist')],
      ['pluginDirs root', 'plugin', (root) => root],
    ];
    for (const [label, copy, target] of cases) {
      const nativeRoot = nativeInstall(GUARDED_FIXTURE);
      const plugin = pluginDirectory(trace);
      const approved = policy(trace);
      const admit = () => admitMicrosoft365Workflow({
        registry: new ToolRegistry(), policy: approved, pluginDirs: [plugin.root], perChatMcpSocketManager: {} as never,
        resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(),
      });
      // Positive control: the same copies are admitted before the ACL entry exists.
      expect(admit(), label).toBe(approved);
      const path = target(copy === 'native' ? nativeRoot : realpathSync(plugin.root));
      grantAclWrite(path);
      // Owner and mode bits are unchanged, so only the ACL entry grants the write.
      expect(statSync(path).mode & 0o022, label).toBe(0);
      LS_PROBES.length = 0;
      expect(admit(), label).toEqual(withdrawnShape(approved));
      // The decision read that exact path with the flags that print ACL entries on this platform.
      expect(LS_PROBES, label).toContainEqual(process.platform === 'darwin' ? ['-lde', '--', path] : ['-ld', '--', path]);
      clearFixtureAcls();
    }
  });

  // @skip-env deny-only ACL entries and the `@` mode marker exist only on macOS.
  it.skipIf(process.platform !== 'darwin')('admits deny-only ACL entries and finds a grant on a path that also has extended attributes', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-acl-deny-'), 'm365-fixture-trace.jsonl');
    const nativeRoot = nativeInstall(GUARDED_FIXTURE);
    const nativeEntry = join(nativeRoot, 'mcp-server', 'dist', 'index.cjs');
    const plugin = pluginDirectory(trace);
    const approved = policy(trace);
    const admit = () => admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: approved, pluginDirs: [plugin.root], perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(),
    });
    // Every macOS home directory carries a deny-only entry like these. It grants nothing, so the copies stay admitted.
    denyAclDelete(nativeRoot);
    denyAclDelete(nativeEntry);
    denyAclDelete(realpathSync(plugin.root));
    expect(admit()).toBe(approved);

    // With an extended attribute present, ls marks the mode with `@` in place of `+`; the entry lines still show the grant.
    expect(spawnSync('/usr/bin/xattr', ['-w', 'org.whatsoup.fixture', '1', nativeEntry]).status).toBe(0);
    grantAclWrite(nativeEntry);
    expect(spawnSync('/bin/ls', ['-ld', nativeEntry], { encoding: 'utf8' }).stdout.split(' ')[0]).toMatch(/@$/);
    expect(admit()).toEqual(withdrawnShape(approved));
  });

  it.each([
    ['ls fails', { status: 1, stdout: '' }],
    ['ls prints an unparseable listing', { status: 0, stdout: 'not a listing\n' }],
    ['ls prints an ACL entry line it cannot read', { status: 0, stdout: '-rw-r--r--+ 1 user staff 10 Nov 12 10:00 entry\n 0: unreadable entry line\n' }],
  ])('refuses a path whose ACL listing cannot be read (%s)', (_case, listing) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-acl-unread-'), 'm365-fixture-trace.jsonl');
    const nativeRoot = nativeInstall(GUARDED_FIXTURE);
    const nativeEntry = join(nativeRoot, 'mcp-server', 'dist', 'index.cjs');
    const approved = policy(trace);
    const admit = () => admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: approved, pluginDirs: [pluginDirectory(trace).root], perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(),
    });
    // Positive control: with the real listing, the copies are admitted.
    expect(admit()).toBe(approved);
    // The next check, in the same synchronous run: no verdict carries over from the previous check.
    LS_OVERRIDES.set(nativeEntry, listing);
    LS_PROBES.length = 0;
    expect(admit()).toEqual(withdrawnShape(approved));
    expect(LS_PROBES.some((args) => args[args.length - 1] === nativeEntry)).toBe(true);
  });

  it.each([
    // The workspace directory above `.claude`: the writer repairs `.claude` itself, but not its parent.
    ['an unsearchable workspace directory (EACCES)', (claudeDir: string) => chmodSync(dirname(claudeDir), 0o000),
      (claudeDir: string) => chmodSync(dirname(claudeDir), 0o700)],
    ['a settings file that fails with EIO', (claudeDir: string) => IO_ERROR.add(join(claudeDir, 'settings.json')),
      (claudeDir: string) => IO_ERROR.delete(join(claudeDir, 'settings.json'))],
  ])('keeps a floor rewrite pending when the settings file cannot be inspected (%s)', (_case, block, unblock) => {
    const trace = join(temporaryDirectory('whatsoup-m365-floor-pending-'), 'm365-fixture-trace.jsonl');
    const approved = policy(trace);
    const withdrawn = withdrawnShape(approved);
    const files = new Microsoft365SettingsFiles();
    const claudeDir = join(temporaryDirectory('whatsoup-m365-uninspectable-'), '.claude');
    const liftedM365Denies = () => {
      const deny = (JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as { permissions: { deny: string[] } }).permissions.deny;
      return M365_MUTATION_DENY.filter((entry) => deny.includes(entry));
    };
    files.write('chat', claudeDir, { 'microsoft_365@microsoft-365-dev': true }, { hasSandbox: false, m365MutationPolicy: approved });
    // Positive control: the approved write lifted the Microsoft 365 mutation denies.
    expect(liftedM365Denies()).toEqual([]);

    block(claudeDir);
    try {
      // existsSync cannot tell this file from a missing one.
      expect(existsSync(join(claudeDir, 'settings.json'))).toBe(false);
      files.restoreFloorOnWithdrawal(approved, withdrawn, 'test');
      expect(files.hasPendingRestoration()).toBe(true);
      expect(() => microsoft365SpawnPolicy(approved, withdrawn, files)).toThrow(/M365_FLOOR_RESTORATION_PENDING/);
    } finally {
      unblock(claudeDir);
    }
    // Once the file can be read again, the retry writes the floor and spawns may proceed.
    files.restoreFloorOnWithdrawal(withdrawn, withdrawn, 'test');
    expect(liftedM365Denies()).toEqual([...M365_MUTATION_DENY]);
    expect(files.hasPendingRestoration()).toBe(false);
  });

  it.each([
    ['an unsearchable workspace directory', (claudeDir: string) => chmodSync(dirname(claudeDir), 0o000),
      (claudeDir: string) => chmodSync(dirname(claudeDir), 0o700), 'EACCES'],
    ['a regular file in place of the .claude directory', (claudeDir: string) => {
      rmSync(claudeDir, { recursive: true, force: true });
      writeFileSync(claudeDir, '');
    }, (claudeDir: string) => {
      rmSync(claudeDir, { force: true });
      mkdirSync(claudeDir, { mode: 0o700 });
    }, 'ENOTDIR'],
  ])('logs the pending settings path and its error code at every refused spawn (%s)', (_case, block, unblock, code) => {
    const trace = join(temporaryDirectory('whatsoup-m365-refusal-log-'), 'm365-fixture-trace.jsonl');
    const approved = policy(trace);
    const withdrawn = withdrawnShape(approved);
    const files = new Microsoft365SettingsFiles();
    const claudeDir = join(temporaryDirectory('whatsoup-m365-refusal-'), '.claude');
    files.write('chat', claudeDir, { 'microsoft_365@microsoft-365-dev': true }, { hasSandbox: false, m365MutationPolicy: approved });

    block(claudeDir);
    try {
      files.restoreFloorOnWithdrawal(approved, withdrawn, 'test');
      expect(files.hasPendingRestoration()).toBe(true);
      adapterLog.error.mockClear();
      // The spawn stays refused (fail closed), and each refusal logs one line naming the file and the error code
      // that keeps its rewrite pending, so an operator can repair it.
      for (const attempt of [1, 2]) {
        expect(() => microsoft365SpawnPolicy(approved, withdrawn, files)).toThrow(/M365_FLOOR_RESTORATION_PENDING/);
        expect(adapterLog.error).toHaveBeenCalledTimes(attempt);
        expect(adapterLog.error.mock.calls[attempt - 1]![0]).toEqual({ pending: [{ path: join(claudeDir, 'settings.json'), code }] });
        expect(adapterLog.error.mock.calls[attempt - 1]![1]).toMatch(/spawn refused/);
      }
      // A path and a code only: no policy value reaches the line.
      expect(JSON.stringify(adapterLog.error.mock.calls)).not.toContain('test-agent365-key');
    } finally {
      unblock(claudeDir);
    }
    // After the repair the next check writes the floor, and a spawn proceeds without the line.
    files.restoreFloorOnWithdrawal(withdrawn, withdrawn, 'test');
    expect(files.hasPendingRestoration()).toBe(false);
    adapterLog.error.mockClear();
    expect(microsoft365SpawnPolicy(approved, withdrawn, files)).toEqual({ status: 'rejected' });
    expect(adapterLog.error).not.toHaveBeenCalled();
  });

  it('re-checks the plugin immediately before the adapter spawns it, after the socket became ready', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const directory = temporaryDirectory('whatsoup-m365-ready-');
    const trace = join(directory, 'm365-fixture-trace.jsonl');
    const registry = new ToolRegistry();
    const tokens = new SessionTokenRegistry();
    const plugin = pluginDirectory(trace);
    nativeInstall(GUARDED_FIXTURE);
    let executing: ExecutingSessionContext = authorizedExecuting();
    const socketPath = await brokerServer(directory, 'chat', tokens, () => executing);
    let ready: Promise<void> = Promise.resolve();
    const manager = { acquire: vi.fn(() => ({ socketPath, ready })) };
    const admitted = admitMicrosoft365Workflow({ registry, policy: policy(trace), pluginDirs: [plugin.root],
      perChatMcpSocketManager: manager as never, resolvePerChatMapKey: (jid) => `map:${jid}`, sessionTokens: tokens, instanceName: 'test' });
    if (admitted?.status !== 'approved' || admitted.workflowAuthority === undefined) throw new Error('expected an admitted assignment');
    executing = { ...authorizedExecuting(), workflowAuthority: admitted.workflowAuthority };
    const bridge = createProviderMcpBridge(registry,
      { tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID }, () => executing);

    // Positive control: with the socket ready at once, the admitted copy is launched.
    await expect(bridge.executeTool('microsoft365', { operation: 'call', name: 'list-mail-messages', args: {} }))
      .resolves.toMatchObject({ isError: false });
    const launches = traceRows(trace).length;
    expect(launches).toBeGreaterThan(0);

    // The next call waits for its socket, and the entry changes while it waits.
    let releaseReady!: () => void;
    ready = new Promise<void>((resolve) => { releaseReady = resolve; });
    const pending = bridge.executeTool('microsoft365', { operation: 'call', name: 'list-mail-messages', args: {} });
    await vi.waitFor(() => expect(manager.acquire).toHaveBeenCalledTimes(2));
    // The guarded code plus one line: it would boot and answer if it were spawned.
    writeFileSync(plugin.entry, `${readFileSync(GUARDED_FIXTURE, 'utf8')}\n// replaced while the socket was not ready\n`);
    releaseReady();
    const refused = await pending;
    expect(refused).toMatchObject({ isError: true });
    expect(JSON.stringify(refused)).toContain('microsoft365_authority_unavailable');
    // Nothing was spawned: the replacement never booted, and the assignment is withdrawn.
    expect(traceRows(trace)).toHaveLength(launches);
    expect(m365WorkflowAuthorityLive(admitted.workflowAuthority)).toBe(false);
  });

  it('lists ACLs again at every check, even when the inode and its change time are unchanged', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
    const trace = join(temporaryDirectory('whatsoup-m365-acl-recheck-'), 'm365-fixture-trace.jsonl');
    const nativeRoot = nativeInstall(GUARDED_FIXTURE);
    const nativeEntry = join(nativeRoot, 'mcp-server', 'dist', 'index.cjs');
    const approved = policy(trace);
    const admitted = admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: approved, pluginDirs: [pluginDirectory(trace).root], perChatMcpSocketManager: {} as never,
      resolvePerChatMapKey: (jid: string) => jid, sessionTokens: new SessionTokenRegistry(), instanceName: 'test',
    });
    expect(admitted).toBe(approved);

    // Positive control, in the same synchronous run: the unchanged chain keeps the assignment, and one check lists
    // the entry once although several chains pass through it.
    LS_PROBES.length = 0;
    expect(recheckMicrosoft365Workflow(admitted, 'test')).toBe(approved);
    expect(LS_PROBES.filter((args) => args[args.length - 1] === nativeEntry)).toHaveLength(1);

    // HFS+ keeps change times in whole seconds, so a grant added within the same second leaves the stat tuple as
    // it was. Model that: the listing now shows an allow entry while lstat reports the same inode and ctime.
    const before = lstatSync(nativeEntry);
    LS_OVERRIDES.set(nativeEntry, { status: 0, stdout: `-rw-r--r--+ 1 owner staff 10 Nov 12 10:00 ${nativeEntry}\n 0: user:other allow write,append\n` });
    expect([lstatSync(nativeEntry).ino, lstatSync(nativeEntry).ctimeMs]).toEqual([before.ino, before.ctimeMs]);
    LS_PROBES.length = 0;
    expect(recheckMicrosoft365Workflow(admitted, 'test')).toEqual(withdrawnShape(approved));
    expect(LS_PROBES.some((args) => args[args.length - 1] === nativeEntry)).toBe(true);
  });

  it('lists the adapter only to chat-scoped sessions bound to a delivery chat', () => {
    const trace = join(temporaryDirectory('whatsoup-m365-listing-'), 'm365-fixture-trace.jsonl');
    const registry = new ToolRegistry();
    expect(registerMicrosoft365Adapter({ registry, policy: policy(trace), pluginDirs: [pluginDirectory(trace).root],
      perChatMcpSocketManager: {} as never, resolvePerChatMapKey: (jid) => jid, sessionTokens: new SessionTokenRegistry() })).toBe(true);
    const names = (session: SessionContext) => createProviderMcpBridge(registry, session, () => authorizedExecuting())
      .listTools().map((tool) => tool.name);
    expect(names({ tier: 'chat-scoped', conversationKey: CONVERSATION_KEY, deliveryJid: DELIVERY_JID })).toContain('microsoft365');
    expect(names({ tier: 'global' })).not.toContain('microsoft365');
    expect(names({ tier: 'global', deliveryJid: DELIVERY_JID })).not.toContain('microsoft365');
  });
});

describe('ACL listing rule for the plugin trust chain', () => {
  const PATH = '/fixture/plugin/mcp-server/dist/index.cjs';
  const line = (mode: string) => `${mode} 1 owner staff 10 Nov 12 10:00 ${PATH}`;
  type Listing = { status: number | null; stdout: string; error?: Error };
  const listed = (stdout: string): Listing => ({ status: 0, stdout });

  /** Runs the rule against a canned `ls` result and records how ls was invoked. */
  function verdict(platform: NodeJS.Platform, listing: Listing, path = PATH) {
    const calls: Array<{ command: string; args: readonly string[]; options: { shell?: unknown; env?: NodeJS.ProcessEnv } }> = [];
    const allowed = aclListingGrantsNothing(path, platform, (command, args, options) => {
      calls.push({ command, args, options });
      return { pid: 0, output: [null, listing.stdout, ''], stdout: listing.stdout, stderr: '', status: listing.status, signal: null, error: listing.error };
    });
    return { allowed, calls };
  }

  it.each<[string, NodeJS.Platform, Listing, boolean]>([
    ['darwin: no ACL', 'darwin', listed(`${line('-rw-r--r--')}\n`), true],
    ['darwin: extended attributes only', 'darwin', listed(`${line('-rw-r--r--@')}\n`), true],
    ['darwin: an allow entry', 'darwin', listed(`${line('-rw-r--r--+')}\n 0: group:everyone allow write\n`), false],
    ['darwin: deny-only entries (the home-directory default)', 'darwin',
      listed(`${line('drwxr-x---+')}\n 0: group:everyone deny delete\n 1: user:other deny add_file,delete_child\n`), true],
    ['darwin: an inherited allow entry after a deny entry', 'darwin',
      listed(`${line('drwxr-xr-x+')}\n 0: group:everyone deny delete\n 1: user:other inherited allow add_file,delete_child,file_inherit\n`), false],
    ['darwin: an inherited deny entry', 'darwin', listed(`${line('drwxr-xr-x+')}\n 0: group:staff inherited deny delete\n`), true],
    ['darwin: an allow entry hidden behind the @ marker', 'darwin', listed(`${line('-rw-r--r--@')}\n 0: group:everyone allow write\n`), false],
    ['darwin: a + marker without entry lines', 'darwin', listed(`${line('-rw-r--r--+')}\n`), false],
    ['darwin: an entry line that does not parse', 'darwin', listed(`${line('-rw-r--r--+')}\n 0: something unexpected\n`), false],
    ['darwin: a Linux SELinux marker', 'darwin', listed(`${line('-rw-r--r--.')}\n`), false],
    ['linux: no ACL', 'linux', listed(`${line('-rw-r--r--')}\n`), true],
    ['linux: an SELinux context only', 'linux', listed(`${line('-rw-r--r--.')}\n`), true],
    ['linux: an ACL (+)', 'linux', listed(`${line('-rw-r--r--+')}\n`), false],
    ['linux: a macOS @ marker', 'linux', listed(`${line('-rw-r--r--@')}\n`), false],
    ['linux: an extra output line', 'linux', listed(`${line('-rw-r--r--')}\nextra\n`), false],
    ['darwin: ls exits non-zero', 'darwin', { status: 1, stdout: '' }, false],
    ['linux: ls exits non-zero', 'linux', { status: 2, stdout: '' }, false],
    ['darwin: ls cannot be started', 'darwin', { status: null, stdout: '', error: Object.assign(new Error('spawn /bin/ls ENOENT'), { code: 'ENOENT' }) }, false],
    ['linux: ls times out', 'linux', { status: null, stdout: '', error: Object.assign(new Error('spawnSync /bin/ls ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, false],
    ['darwin: unparseable output', 'darwin', listed('not a listing\n'), false],
    ['linux: unparseable output', 'linux', listed('total 0\n'), false],
    ['darwin: empty output', 'darwin', listed(''), false],
  ])('%s', (_case, platform, listing, expected) => {
    const { allowed, calls } = verdict(platform, listing);
    expect(allowed).toBe(expected);
    // ls runs once, by absolute path, with an argument vector and no shell, in the C locale.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('/bin/ls');
    expect(calls[0]!.args).toEqual(platform === 'darwin' ? ['-lde', '--', PATH] : ['-ld', '--', PATH]);
    expect(calls[0]!.options.shell).toBe(false);
    expect(calls[0]!.options.env).toEqual({ LC_ALL: 'C' });
  });

  it.each<[string, NodeJS.Platform, string]>([
    ['an unknown platform', 'freebsd', PATH],
    ['another unknown platform', 'win32', PATH],
    ['a path with a newline, which could forge an entry line', 'darwin', `${PATH}\n 0: group:everyone deny delete`],
  ])('refuses %s without running ls', (_case, platform, path) => {
    const { allowed, calls } = verdict(platform, listed(`${line('-rw-r--r--')}\n`), path);
    expect(allowed).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
