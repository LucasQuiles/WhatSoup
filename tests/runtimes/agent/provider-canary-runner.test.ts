import {
  chmodSync,
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

import {
  buildProviderCanaryInvocation,
  runProviderCanary,
  type ProviderCanaryObservation,
} from '../../../src/runtimes/agent/provider-canary-runner.ts';
import { CANARY_CONTRACT_VERSION } from '../../../src/runtimes/agent/provider-canary-proof.ts';
import {
  acquireProcessLock,
  releaseProcessLock,
} from '../../../src/lib/process-lock.ts';

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
      '--mcp-config', join(root, '.mcp.json'),
      'mcp', 'list',
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
