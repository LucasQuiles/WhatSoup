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

import { m365MutationExceptionAllowed, type M365MutationPolicy } from '../../../src/core/m365-bridge-policy.ts';
import { SessionTokenRegistry } from '../../../src/mcp/caller-attribution.ts';
import { registerM365WorkflowAuthorityTool } from '../../../src/mcp/m365-workflow-authority.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { WhatSoupSocketServer } from '../../../src/mcp/socket-server.ts';
import type { ExecutingSessionContext, SessionContext } from '../../../src/mcp/types.ts';
import {
  admitMicrosoft365Workflow,
  loadMicrosoft365PluginLaunch,
  microsoft365AuthorityKey,
  recheckMicrosoft365Workflow,
  registerMicrosoft365Adapter,
} from '../../../src/runtimes/agent/microsoft365-adapter.ts';
import { createProviderMcpBridge } from '../../../src/runtimes/agent/providers/mcp-bridge.ts';

type OsModule = typeof os;

const { AGENT365_HOME, FOREIGN_OWNED } = vi.hoisted(() => {
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');
  return {
    AGENT365_HOME: nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'whatsoup-m365-home-'))),
    // Paths that lstat reports as owned by another user: a test cannot chown without root.
    FOREIGN_OWNED: new Set<string>(),
  };
});

// The adapter's own logger, captured so a withdrawal's reason can be asserted; other components log normally.
const { adapterLog } = vi.hoisted(() => ({ adapterLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../src/logger.ts', async (importOriginal: () => Promise<typeof import('../../../src/logger.ts')>) => {
  const actual = await importOriginal();
  return { ...actual, createChildLogger: (name: string) => name === 'microsoft365-adapter' ? adapterLog : actual.createChildLogger(name) };
});

vi.mock('node:os', async (importOriginal: () => Promise<OsModule>) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => AGENT365_HOME };
});

vi.mock('node:fs', async (importOriginal: () => Promise<typeof import('node:fs')>) => {
  const actual = await importOriginal();
  const lstatSync = ((path: import('node:fs').PathLike, options?: import('node:fs').StatSyncOptions) => {
    const stat = actual.lstatSync(path, options);
    if (stat === undefined || !FOREIGN_OWNED.has(String(path))) return stat;
    // Keep the Stats prototype so isFile, isDirectory and isSymbolicLink still answer.
    return Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as typeof stat, stat, { uid: Number(stat.uid) + 1 });
  }) as typeof actual.lstatSync;
  return { ...actual, lstatSync };
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

afterEach(() => {
  vi.unstubAllEnvs();
  FOREIGN_OWNED.clear();
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
    mcpServers: { microsoft_365: valid ? {
      command: SYSTEM_PYTHON,
      args: [launcher, '--config', config, '--', '${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.cjs'],
      env: {
        MS365_CLIENT_ID: 'fixture-client-id',
        MS365_TENANT_ID: '11111111-2222-3333-4444-555555555555',
        MS365_PROFILE: 'user-full-v1',
        MS365_WORKFLOW_AUTHORITY_REQUIRED: '1',
      },
    } : { command: '/bin/sh', args: ['-c', 'bad'] } },
  }));
  return { root, python, launcher, config, entry };
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
function nativeInstall(entrySource: string, server: Record<string, unknown> = {
  command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.cjs'],
}): string {
  const root = join(AGENT365_HOME, '.claude', 'plugins', 'microsoft-365');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'mcp-server', 'dist'), { recursive: true });
  copyFileSync(entrySource, join(root, 'mcp-server', 'dist', 'index.cjs'));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'microsoft_365', version: 'fixture-v1', mcpServers: { microsoft_365: server },
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

    // Positive controls: the native copy runs a byte-identical entry, through the identical
    // guarded manifest (the production shape) or through a direct node launch of that entry.
    const admittedServer = (JSON.parse(readFileSync(join(plugin.root, '.claude-plugin', 'plugin.json'), 'utf8')) as {
      mcpServers: { microsoft_365: Record<string, unknown> };
    }).mcpServers.microsoft_365;
    const nativeRoot = nativeInstall(GUARDED_FIXTURE, admittedServer);
    expect(admit()).toBe(approved);
    nativeInstall(GUARDED_FIXTURE);
    expect(admit()).toBe(approved);

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

    // A policy this adapter never admitted, or one without an assignment, passes through unchecked.
    expect(recheckMicrosoft365Workflow(policy(trace), 'test')).toEqual(policy(trace));
    expect(recheckMicrosoft365Workflow({ status: 'rejected' }, 'test')).toEqual({ status: 'rejected' });
    expect(recheckMicrosoft365Workflow(undefined, 'test')).toBeUndefined();
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
