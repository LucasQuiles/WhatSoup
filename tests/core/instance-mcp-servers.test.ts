import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORBIDDEN_MCP_ENV_KEYS,
  MAX_ADDITIONAL_MCP_SERVERS,
  MCP_ENV_VAR_RE,
  MCP_SERVER_NAME_RE,
  RESERVED_MCP_SERVER_NAMES,
  requiredMcpServerNames,
  resolveInstanceMcpServers,
  type InstanceMcpServerSpec,
} from '../../src/core/instance-mcp-servers.ts';

function fakeHome(): { home: string; script: string; tsScript: string } {
  const home = mkdtempSync(join(tmpdir(), 'imcp-home-'));
  const dir = join(home, 'plugins', 'srv');
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'server.js');
  writeFileSync(script, '// stub\n');
  const tsScript = join(dir, 'proxy.ts');
  writeFileSync(tsScript, '// stub\n');
  return { home, script, tsScript };
}

function opts(home: string, overrides: Partial<Parameters<typeof resolveInstanceMcpServers>[1]> = {}) {
  return {
    instanceName: 'test-bot',
    lookup: (_service: string) => 'resolved-secret-value',
    homeDir: home,
    nodeBinary: '/pinned/node-24',
    ...overrides,
  };
}

describe('constants and guards', () => {
  it('reserves the platform server names', () => {
    expect(RESERVED_MCP_SERVER_NAMES.has('whatsoup')).toBe(true);
    expect(RESERVED_MCP_SERVER_NAMES.has('send-media')).toBe(true);
  });

  it('server-name regex accepts sane names and rejects hostile ones', () => {
    expect(MCP_SERVER_NAME_RE.test('microsoft_365')).toBe(true);
    expect(MCP_SERVER_NAME_RE.test('a')).toBe(true);
    expect(MCP_SERVER_NAME_RE.test('')).toBe(false);
    expect(MCP_SERVER_NAME_RE.test('-leading-dash')).toBe(false);
    expect(MCP_SERVER_NAME_RE.test('has space')).toBe(false);
    expect(MCP_SERVER_NAME_RE.test('x'.repeat(65))).toBe(false);
  });

  it('env-var regex requires SCREAMING_SNAKE', () => {
    expect(MCP_ENV_VAR_RE.test('MS365_HUB_URL')).toBe(true);
    expect(MCP_ENV_VAR_RE.test('lower')).toBe(false);
    expect(MCP_ENV_VAR_RE.test('1LEADING')).toBe(false);
  });

  it('forbids loader-hijack env keys and caps entries at 16', () => {
    for (const k of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) {
      expect(FORBIDDEN_MCP_ENV_KEYS.has(k)).toBe(true);
    }
    expect(MAX_ADDITIONAL_MCP_SERVERS).toBe(16);
  });
});

describe('resolveInstanceMcpServers — launch resolution', () => {
  it('substitutes the pinned node binary for command "node" and keeps args', () => {
    const { home, script } = fakeHome();
    const specs: InstanceMcpServerSpec[] = [
      { name: 'm365', command: 'node', args: [script], env: { A_B: 'x' } },
    ];
    const [resolved] = resolveInstanceMcpServers(specs, opts(home));
    expect(resolved.command).toBe('/pinned/node-24');
    expect(resolved.args).toEqual([script]);
    expect(resolved.name).toBe('m365');
  });

  it('tilde-expands command, args, and proxyScriptPath against the injected home', () => {
    const { home } = fakeHome();
    const specs: InstanceMcpServerSpec[] = [
      { name: 'm365', command: 'node', args: ['~/plugins/srv/server.js'] },
      { name: 'proxy_srv', proxyScriptPath: '~/plugins/srv/proxy.ts' },
    ];
    const resolved = resolveInstanceMcpServers(specs, opts(home));
    expect(resolved[0].args?.[0]).toBe(join(home, 'plugins', 'srv', 'server.js'));
    expect(resolved[1].proxyScriptPath).toBe(join(home, 'plugins', 'srv', 'proxy.ts'));
  });

  it('rejects a command outside the home directory', () => {
    const { home } = fakeHome();
    const specs: InstanceMcpServerSpec[] = [
      { name: 'evil', command: '/usr/bin/nc', args: [] },
    ];
    expect(() => resolveInstanceMcpServers(specs, opts(home))).toThrow(/home/i);
  });

  it('rejects a node-lane script outside the home directory', () => {
    const { home } = fakeHome();
    const outside = mkdtempSync(join(tmpdir(), 'imcp-out-'));
    const escapee = join(outside, 'x.js');
    writeFileSync(escapee, '// stub\n');
    const specs: InstanceMcpServerSpec[] = [
      { name: 'esc', command: 'node', args: [escapee] },
    ];
    expect(() => resolveInstanceMcpServers(specs, opts(home))).toThrow(/home/i);
  });

  it('rejects a missing script file', () => {
    const { home } = fakeHome();
    const specs: InstanceMcpServerSpec[] = [
      { name: 'ghost', command: 'node', args: [join(home, 'plugins', 'srv', 'missing.js')] },
    ];
    expect(() => resolveInstanceMcpServers(specs, opts(home))).toThrow(/missing|not found|does not exist/i);
  });

  it('rejects reserved names even if the validator was bypassed', () => {
    const { home, script } = fakeHome();
    const specs: InstanceMcpServerSpec[] = [
      { name: 'whatsoup', command: 'node', args: [script] },
    ];
    expect(() => resolveInstanceMcpServers(specs, opts(home))).toThrow(/reserved/i);
  });

  it('rejects reserved names case-insensitively', () => {
    const { home, script } = fakeHome();
    for (const name of ['Whatsoup', 'WHATSOUP', 'Send-Media']) {
      const specs: InstanceMcpServerSpec[] = [{ name, command: 'node', args: [script] }];
      expect(() => resolveInstanceMcpServers(specs, opts(home))).toThrow(/reserved/i);
    }
  });
});

describe('resolveInstanceMcpServers — env and keyring', () => {
  it('merges plain env and keyring-resolved env', () => {
    const { home, script } = fakeHome();
    const specs: InstanceMcpServerSpec[] = [
      {
        name: 'm365',
        command: 'node',
        args: [script],
        env: { MS365_HUB_URL: 'https://hub.example:10000' },
        envFromKeyring: { MS365_HUB_API_KEY: 'ms365-hub' },
      },
    ];
    const [resolved] = resolveInstanceMcpServers(specs, opts(home));
    expect(resolved.env.MS365_HUB_URL).toBe('https://hub.example:10000');
    expect(resolved.env.MS365_HUB_API_KEY).toBe('resolved-secret-value');
  });

  it('throws loudly (naming instance/server/env/service, not the secret) on a missing credential', () => {
    const { home, script } = fakeHome();
    const specs: InstanceMcpServerSpec[] = [
      {
        name: 'm365',
        command: 'node',
        args: [script],
        envFromKeyring: { MS365_HUB_API_KEY: 'ms365-hub' },
      },
    ];
    try {
      resolveInstanceMcpServers(specs, opts(home, { lookup: () => null }));
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('test-bot');
      expect(msg).toContain('m365');
      expect(msg).toContain('MS365_HUB_API_KEY');
      expect(msg).toContain('ms365-hub');
      expect(msg).not.toContain('resolved-secret-value');
    }
  });

  it('treats an empty-string credential as missing', () => {
    const { home, script } = fakeHome();
    const specs: InstanceMcpServerSpec[] = [
      { name: 'm365', command: 'node', args: [script], envFromKeyring: { MS365_HUB_API_KEY: 'ms365-hub' } },
    ];
    expect(() =>
      resolveInstanceMcpServers(specs, opts(home, { lookup: () => '' })),
    ).toThrow(/MS365_HUB_API_KEY/);
  });

  it('rejects a keyring service outside MCP_ENV_KEY_SERVICES', () => {
    const { home, script } = fakeHome();
    const specs: InstanceMcpServerSpec[] = [
      { name: 'exfil', command: 'node', args: [script], envFromKeyring: { X_KEY: 'anthropic' } },
    ];
    expect(() => resolveInstanceMcpServers(specs, opts(home))).toThrow(/anthropic/);
  });

  it('rejects forbidden env keys in both env and envFromKeyring', () => {
    const { home, script } = fakeHome();
    expect(() =>
      resolveInstanceMcpServers(
        [{ name: 'a1', command: 'node', args: [script], env: { NODE_OPTIONS: '--x' } }],
        opts(home),
      ),
    ).toThrow(/NODE_OPTIONS/);
    expect(() =>
      resolveInstanceMcpServers(
        [{ name: 'a2', command: 'node', args: [script], envFromKeyring: { LD_PRELOAD: 'ms365-hub' } }],
        opts(home),
      ),
    ).toThrow(/LD_PRELOAD/);
  });

  it('rejects env/envFromKeyring key collisions', () => {
    const { home, script } = fakeHome();
    const specs: InstanceMcpServerSpec[] = [
      {
        name: 'dup',
        command: 'node',
        args: [script],
        env: { MS365_HUB_API_KEY: 'plain' },
        envFromKeyring: { MS365_HUB_API_KEY: 'ms365-hub' },
      },
    ];
    expect(() => resolveInstanceMcpServers(specs, opts(home))).toThrow(/collide|both/i);
  });
});

describe('requiredMcpServerNames', () => {
  it('always includes whatsoup implicitly and honors required:false', () => {
    const specs: InstanceMcpServerSpec[] = [
      { name: 'm365', command: 'node', args: ['~/x.js'] },
      { name: 'optional_extra', command: 'node', args: ['~/y.js'], required: false },
      { name: 'tmup', proxyScriptPath: '~/t.ts', required: true },
    ];
    expect(requiredMcpServerNames(specs)).toEqual(['whatsoup', 'm365', 'tmup']);
  });

  it('returns just whatsoup for no specs', () => {
    expect(requiredMcpServerNames([])).toEqual(['whatsoup']);
    expect(requiredMcpServerNames(undefined)).toEqual(['whatsoup']);
  });
});
