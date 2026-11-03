import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  ProviderProcessIsolationError,
  launchIsolatedProviderProcess,
  prepareIsolatedProviderEnvironment,
  verifyIsolatedProviderProcess,
  type ProviderProcessIsolationConfig,
} from '../../../src/runtimes/agent/provider-process-isolation.ts';

const isolation: ProviderProcessIsolationConfig = {
  controllerUid: 501,
  controllerGid: 20,
  workerUid: 502,
  workerGid: 502,
  launcherPath: '/usr/local/libexec/whatsoup-agent-isolation-launcher',
  launcherSha256: 'a'.repeat(64),
  policyPath: '/etc/whatsoup/agent-isolation.policy',
  policySha256: 'b'.repeat(64),
  homeDir: '/var/lib/whatsoup-agent',
  configHome: '/var/lib/whatsoup-agent/.config',
  dataHome: '/var/lib/whatsoup-agent/.local/share',
  protectedPaths: ['/var/db/whatsoup/transport-authority.bearer'],
};

function stat(uid: number, mode: number, type: 'file' | 'directory' = 'file') {
  return {
    uid,
    gid: uid,
    mode,
    isFile: () => type === 'file',
    isDirectory: () => type === 'directory',
    isSymbolicLink: () => false,
  };
}

function controllerDeps(overrides: Record<string, unknown> = {}) {
  const status = [
    'Name:\tprovider',
    'Uid:\t502\t502\t502\t502',
    'Gid:\t502\t502\t502\t502',
    'Groups:\t502',
  ].join('\n');
  const environment = [
    'PATH=/usr/bin:/bin',
    'HOME=/var/lib/whatsoup-agent',
    'XDG_CONFIG_HOME=/var/lib/whatsoup-agent/.config',
    'XDG_DATA_HOME=/var/lib/whatsoup-agent/.local/share',
    'WHATSOUP_MCP_SOCKET=/run/whatsoup/mcp.sock',
    'WHATSOUP_MCP_SESSION_TOKEN=one-turn-token',
  ].join('\0');
  return {
    platform: 'linux' as NodeJS.Platform,
    getuid: () => 501,
    getgid: () => 20,
    lstat: (path: string) => {
      if (path === isolation.launcherPath) return stat(0, 0o104755);
      if (path === isolation.policyPath) return stat(0, 0o100600);
      if (path === '/usr/bin/fake-provider') return stat(0, 0o100755);
      if (path === isolation.homeDir || path === isolation.configHome || path === isolation.dataHome) {
        return stat(502, 0o40700, 'directory');
      }
      if (path === isolation.protectedPaths[0]) return stat(501, 0o100600);
      return stat(0, 0o40755, 'directory');
    },
    readFile: (path: string) => {
      if (path === isolation.launcherPath) return Buffer.from('launcher');
      if (path === isolation.policyPath) return Buffer.from('policy');
      if (path === '/usr/bin/fake-provider') return Buffer.from('provider');
      if (path === '/proc/31337/status') return Buffer.from(status);
      if (path === '/proc/31337/environ') return Buffer.from(environment);
      throw new Error(`unexpected read ${path}`);
    },
    sha256: (value: Buffer) => {
      if (value.toString() === 'launcher') return 'a'.repeat(64);
      if (value.toString() === 'policy') return 'b'.repeat(64);
      return 'c'.repeat(64);
    },
    createNonce: () => '0'.repeat(64),
    ...overrides,
  };
}

function fakeChild() {
  const child = new ChildProcess();
  const receipt = new PassThrough();
  const stdio: ChildProcess['stdio'] = [
    new PassThrough(),
    new PassThrough(),
    new PassThrough(),
    receipt,
    null,
  ];
  Object.defineProperties(child, {
    pid: { configurable: true, value: 31337 },
    stdio: { configurable: true, value: stdio },
  });
  return Object.assign(child, {
    hideReceipt: () => {
      Object.defineProperty(child, 'stdio', {
        configurable: true,
        value: [stdio[0], stdio[1], stdio[2], null, stdio[4]],
      });
    },
  });
}

describe('provider process isolation', () => {
  it('constructs a Linux launcher run with an isolated home and only the checked MCP proxy token route', () => {
    const env = prepareIsolatedProviderEnvironment({
      PATH: '/usr/bin',
      HOME: '/service/home',
      XDG_CONFIG_HOME: '/service/config',
      XDG_DATA_HOME: '/service/data',
      WHATSOUP_MCP_SOCKET: '/run/whatsoup/mcp.sock',
      WHATSOUP_MCP_SESSION_TOKEN: 'one-turn-token',
      OPENAI_API_KEY: 'provider-key',
    }, isolation, controllerDeps());

    expect(env).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: isolation.homeDir,
      XDG_CONFIG_HOME: isolation.configHome,
      XDG_DATA_HOME: isolation.dataHome,
      WHATSOUP_MCP_SOCKET: '/run/whatsoup/mcp.sock',
      WHATSOUP_MCP_SESSION_TOKEN: 'one-turn-token',
      OPENAI_API_KEY: 'provider-key',
    });
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    expect(env).not.toHaveProperty('SUDO_ASKPASS');
  });

  it('rejects inherited authority tokens, SSH agents, and browser debugging routes before a child is launched', () => {
    for (const forbidden of [
      'WHATSOUP_HEALTH_TOKEN',
      'TRANSPORT_AUTHORITY_BEARER',
      'SSH_AUTH_SOCK',
      'CHROME_REMOTE_DEBUGGING_PORT',
      'CHROMIUM_USER_DATA_DIR',
      'LD_PRELOAD',
    ]) {
      expect(() => prepareIsolatedProviderEnvironment({
        PATH: '/usr/bin',
        [forbidden]: 'must-not-cross',
      }, isolation, controllerDeps())).toThrow(ProviderProcessIsolationError);
    }
  });

  it('resets ambient executable and config routes instead of inheriting them', () => {
    const env = prepareIsolatedProviderEnvironment({
      PATH: '/agent-controlled/bin',
      HOME: '/agent-controlled/home',
      XDG_CONFIG_HOME: '/agent-controlled/config',
      XDG_DATA_HOME: '/agent-controlled/data',
    }, isolation, controllerDeps());

    expect(env).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: isolation.homeDir,
      XDG_CONFIG_HOME: isolation.configHome,
      XDG_DATA_HOME: isolation.dataHome,
    });
  });

  it('rejects a configured boundary on macOS instead of treating environment stripping as identity proof', () => {
    expect(() => prepareIsolatedProviderEnvironment(
      { PATH: '/usr/bin' },
      isolation,
      controllerDeps({ platform: 'darwin' }),
    )).toThrow('Linux-only');
  });

  it('rejects a controller that has not actually separated its UID from the worker', () => {
    expect(() => prepareIsolatedProviderEnvironment(
      { PATH: '/usr/bin' },
      isolation,
      controllerDeps({ getuid: () => isolation.workerUid }),
    )).toThrow('controller UID');
  });

  it('accepts a fake provider workflow only after the controller verifies kernel uid, gid, groups, environment, and protected paths', () => {
    expect(() => verifyIsolatedProviderProcess(31337, isolation, controllerDeps())).not.toThrow();
  });

  it('rejects a non-Linux kernel verifier without reading /proc', () => {
    const procReads: string[] = [];
    const deps = controllerDeps({
      platform: 'darwin' as NodeJS.Platform,
      readFile: (path: string) => {
        if (path.startsWith('/proc/')) procReads.push(path);
        throw new Error(`unexpected read ${path}`);
      },
    });

    expect(() => verifyIsolatedProviderProcess(31337, isolation, deps)).toThrow('Linux-only');
    expect(procReads).toEqual([]);
  });

  it('rejects an inherited supplementary group even when the child claims the expected UID and GID', () => {
    const deps = controllerDeps({
      readFile: (path: string) => {
        if (path === '/proc/31337/status') return Buffer.from([
          'Uid:\t502\t502\t502\t502',
          'Gid:\t502\t502\t502\t502',
          'Groups:\t20 502',
        ].join('\n'));
        if (path === '/proc/31337/environ') return Buffer.from([
          'PATH=/usr/bin',
          'HOME=/var/lib/whatsoup-agent',
          'XDG_CONFIG_HOME=/var/lib/whatsoup-agent/.config',
          'XDG_DATA_HOME=/var/lib/whatsoup-agent/.local/share',
        ].join('\0'));
        if (path === isolation.launcherPath) return Buffer.from('launcher');
        if (path === isolation.policyPath) return Buffer.from('policy');
        throw new Error(`unexpected read ${path}`);
      },
    });
    expect(() => verifyIsolatedProviderProcess(31337, isolation, deps)).toThrow('supplementary groups');
  });

  it('does not expose the provider child until the protected launcher returns its nonce-bound post-drop proof', async () => {
    const child = fakeChild();
    const result = launchIsolatedProviderProcess({
      binary: '/usr/bin/fake-provider',
      expectedBinarySha256: 'c'.repeat(64),
      args: ['--safe'],
      cwd: '/srv/whatsoup/work',
      env: { PATH: '/usr/bin', WHATSOUP_MCP_SOCKET: '/run/whatsoup/mcp.sock', WHATSOUP_MCP_SESSION_TOKEN: 'one-turn-token' },
      isolation,
    }, {
      ...controllerDeps(),
      spawn: (command: string, args: readonly string[]) => {
        expect(command).toBe(isolation.launcherPath);
        expect(args.slice(0, 6)).toEqual([
          '--policy', isolation.policyPath,
          '--receipt-fd', '3',
          '--nonce', expect.any(String),
        ]);
        expect(args.slice(6)).toEqual(['--', '/usr/bin/fake-provider', '--safe']);
        return child;
      },
    });

    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stdio[3]!.emit('data', Buffer.from(
      '{"version":1,"state":"isolated","pid":31337,"nonce":"' + '0'.repeat(64) + '","uid":502,"gid":502,"groups":[502]}\n',
    ));
    child.stdio[3]!.emit('end');
    await expect(result).resolves.toBe(child);
  });

  it('rejects a launcher receipt that does not bind the controller nonce', async () => {
    const child = fakeChild();
    const result = launchIsolatedProviderProcess({
      binary: '/usr/bin/fake-provider',
      expectedBinarySha256: 'c'.repeat(64),
      args: [],
      cwd: '/srv/whatsoup/work',
      env: { PATH: '/usr/bin' },
      isolation,
    }, {
      ...controllerDeps(),
      spawn: () => child,
      terminationGraceMs: 1,
      killProcessGroup: () => {
        child.emit('exit', null, 'SIGTERM');
      },
    });

    child.stdio[3]!.emit('data', Buffer.from(
      '{"version":1,"state":"isolated","pid":31337,"nonce":"' + 'f'.repeat(64) + '","uid":502,"gid":502,"groups":[502]}\n',
    ));
    child.stdio[3]!.emit('end');
    await expect(result).rejects.toThrow('controller nonce');
  });

  it('terminates and reaps its process group before rejecting a malformed receipt', async () => {
    const child = fakeChild();
    const signals: NodeJS.Signals[] = [];
    const result = launchIsolatedProviderProcess({
      binary: '/usr/bin/fake-provider',
      expectedBinarySha256: 'c'.repeat(64),
      args: [],
      cwd: '/srv/whatsoup/work',
      env: { PATH: '/usr/bin' },
      isolation,
    }, {
      ...controllerDeps(),
      spawn: () => child,
      terminationGraceMs: 1,
      killProcessGroup: (_pid: number, signal: NodeJS.Signals) => {
        signals.push(signal);
        child.emit('exit', null, signal);
      },
    });

    child.stdio[3]!.emit('data', Buffer.from('{"not":"a receipt"}\n'));
    child.stdio[3]!.emit('end');

    await expect(result).rejects.toThrow('does not bind');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('terminates and reaps its process group when the launcher omits its receipt fd', async () => {
    const child = fakeChild();
    child.hideReceipt();
    const signals: NodeJS.Signals[] = [];
    const result = launchIsolatedProviderProcess({
      binary: '/usr/bin/fake-provider',
      expectedBinarySha256: 'c'.repeat(64),
      args: [],
      cwd: '/srv/whatsoup/work',
      env: { PATH: '/usr/bin' },
      isolation,
    }, {
      ...controllerDeps(),
      spawn: () => child,
      terminationGraceMs: 1,
      killProcessGroup: (_pid: number, signal: NodeJS.Signals) => {
        signals.push(signal);
        child.emit('exit', null, signal);
      },
    });

    await expect(result).rejects.toThrow('did not expose its receipt fd');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('terminates and reaps its process group when the receipt stream errors', async () => {
    const child = fakeChild();
    const signals: NodeJS.Signals[] = [];
    const result = launchIsolatedProviderProcess({
      binary: '/usr/bin/fake-provider',
      expectedBinarySha256: 'c'.repeat(64),
      args: [],
      cwd: '/srv/whatsoup/work',
      env: { PATH: '/usr/bin' },
      isolation,
    }, {
      ...controllerDeps(),
      spawn: () => child,
      terminationGraceMs: 1,
      killProcessGroup: (_pid: number, signal: NodeJS.Signals) => {
        signals.push(signal);
        child.emit('exit', null, signal);
      },
    });

    child.stdio[3]!.emit('error', new Error('receipt pipe broke'));

    await expect(result).rejects.toThrow('receipt stream failed');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reaps an owned offline process after its receipt times out', async () => {
    let child: ChildProcess | undefined;
    let exited: Promise<unknown> | undefined;
    const result = launchIsolatedProviderProcess({
      binary: '/usr/bin/fake-provider',
      expectedBinarySha256: 'c'.repeat(64),
      args: [],
      cwd: process.cwd(),
      env: { PATH: '/usr/bin' },
      isolation,
    }, {
      ...controllerDeps(),
      receiptTimeoutMs: 100,
      terminationGraceMs: 100,
      reapTimeoutMs: 2_000,
      spawn: (_command, _args, options) => {
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], options);
        exited = once(child, 'exit');
        return child;
      },
    });

    await expect(result).rejects.toThrow('timed out');
    await expect(exited).resolves.toBeDefined();
    expect(child?.pid).toBeDefined();
    expect(() => process.kill(child!.pid!, 0)).toThrow();
  });
});
