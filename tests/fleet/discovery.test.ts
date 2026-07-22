import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Logger mock — capture every warn call so tests can introspect.
type WarnCall = { obj: Record<string, unknown> | undefined; msg: string };
const warnCalls: WarnCall[] = [];

vi.mock('../../src/logger.ts', () => {
  const noop = () => {};
  const warn = (obj: unknown, msg?: unknown) => {
    if (typeof obj === 'string') {
      warnCalls.push({ obj: undefined, msg: obj });
    } else {
      warnCalls.push({
        obj: obj as Record<string, unknown> | undefined,
        msg: typeof msg === 'string' ? msg : '',
      });
    }
  };
  const child = () => fakeLogger;
  const fakeLogger: Record<string, unknown> = {
    info: noop, warn, error: noop, debug: noop, trace: noop, fatal: noop,
    child, flush: noop,
  };
  return { default: fakeLogger, createChildLogger: () => fakeLogger, flushLogger: async () => {} };
});

import { FleetDiscovery, type DiscoveredInstance } from '../../src/fleet/discovery.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let configRoot: string;
let savedEnv: Record<string, string | undefined>;

/** Write an instance config.json into the temp instances directory */
function writeInstanceConfig(name: string, content: unknown): void {
  const instanceDir = path.join(configRoot, name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const json = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(path.join(instanceDir, 'config.json'), json, 'utf8');
}

/** Write a tokens.env file for an instance */
function writeTokensEnv(name: string, content: string): void {
  const instanceDir = path.join(configRoot, name);
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(path.join(instanceDir, 'tokens.env'), content, 'utf8');
}

const chatInstance = {
  name: 'loops',
  type: 'chat',
  systemPrompt: 'You are Loops.',
  adminPhones: ['15551234567'],
  accessMode: 'allowlist',
  healthPort: 9090,
  gui: true,
  guiPort: 9099,
};

const agentInstance = {
  name: 'q-agent',
  type: 'agent',
  adminPhones: ['15551234567'],
  accessMode: 'self_only',
  healthPort: 9091,
};

const passiveInstance = {
  name: 'relay',
  type: 'passive',
  adminPhones: ['15551234567'],
  accessMode: 'self_only',
  healthPort: 9092,
};

beforeEach(() => {
  warnCalls.length = 0;
  savedEnv = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-discovery-test-'));
  configRoot = path.join(tmpDir, 'config', 'whatsoup', 'instances');
  fs.mkdirSync(configRoot, { recursive: true });

  // Point XDG env vars at temp subdirs so path resolution is deterministic
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// scan finds all valid instances
// ---------------------------------------------------------------------------

describe('FleetDiscovery.scan — finds all valid instances', () => {
  it('discovers multiple instances from the config directory', () => {
    writeInstanceConfig('loops', chatInstance);
    writeInstanceConfig('q-agent', agentInstance);
    writeInstanceConfig('relay', passiveInstance);

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    expect(instances.size).toBe(3);
    expect(instances.has('loops')).toBe(true);
    expect(instances.has('q-agent')).toBe(true);
    expect(instances.has('relay')).toBe(true);
  });

  it('populates all fields correctly for a chat instance', () => {
    writeInstanceConfig('loops', chatInstance);

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('loops');

    expect(inst).toBeDefined();
    expect(inst!.name).toBe('loops');
    expect(inst!.type).toBe('chat');
    expect(inst!.accessMode).toBe('allowlist');
    expect(inst!.healthPort).toBe(9090);
    expect(inst!.gui).toBe(true);
    expect(inst!.guiPort).toBe(9099);
    expect(inst!.socketPath).toBeNull();
    expect(inst!.healthToken).toBeNull();

    // Path resolution
    const dataRoot = path.join(tmpDir, 'data', 'whatsoup', 'instances', 'loops');
    const stateRoot = path.join(tmpDir, 'state', 'whatsoup', 'instances', 'loops');
    expect(inst!.dbPath).toBe(path.join(dataRoot, 'bot.db'));
    expect(inst!.logDir).toBe(path.join(dataRoot, 'logs'));
    expect(inst!.stateRoot).toBe(stateRoot);
    expect(inst!.configPath).toBe(path.join(configRoot, 'loops', 'config.json'));
  });

  it('defaults to type chat and accessMode self_only when fields are missing', () => {
    writeInstanceConfig('bare', { healthPort: 4000 });

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('bare');

    expect(inst).toBeDefined();
    expect(inst!.type).toBe('chat');
    expect(inst!.accessMode).toBe('self_only');
    expect(inst!.healthPort).toBe(4000);
  });

  it('defaults healthPort to the runtime health port when not specified', () => {
    writeInstanceConfig('minimal', { type: 'chat' });

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('minimal');

    expect(inst!.healthPort).toBe(9090);
  });
});

// ---------------------------------------------------------------------------
// tokens.env handling
// ---------------------------------------------------------------------------

describe('FleetDiscovery.scan — tokens.env', () => {
  it('reads health token from tokens.env', () => {
    writeInstanceConfig('loops', chatInstance);
    writeTokensEnv('loops', 'WHATSOUP_HEALTH_TOKEN=secret123\nOTHER_VAR=ignored\n');

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('loops');

    expect(inst!.healthToken).toBe('secret123');
  });

  it('handles missing tokens.env gracefully', () => {
    writeInstanceConfig('loops', chatInstance);
    // No tokens.env written

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    expect(instances.size).toBe(1);
    expect(instances.get('loops')).toMatchObject({
      name: 'loops',
      healthToken: null,
      configPath: path.join(configRoot, 'loops', 'config.json'),
    });
  });

  it('returns null when tokens.env has no WHATSOUP_HEALTH_TOKEN line', () => {
    writeInstanceConfig('loops', chatInstance);
    writeTokensEnv('loops', 'SOME_OTHER_TOKEN=abc\nFOO=bar\n');

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    expect(instances.size).toBe(1);
    expect(instances.get('loops')).toMatchObject({
      name: 'loops',
      healthToken: null,
      configPath: path.join(configRoot, 'loops', 'config.json'),
    });
  });

  it('warns and keeps polling when tokens.env is unreadable', () => {
    writeInstanceConfig('loops', chatInstance);
    fs.mkdirSync(path.join(configRoot, 'loops', 'tokens.env'));

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    expect(instances.get('loops')).toMatchObject({
      name: 'loops',
      healthToken: null,
    });
    expect(warnCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        msg: 'tokens.env unreadable; instance polled without a health token',
        obj: expect.objectContaining({
          tokensPath: path.join(configRoot, 'loops', 'tokens.env'),
        }),
      }),
    ]));
  });
});

// ---------------------------------------------------------------------------
// malformed config.json
// ---------------------------------------------------------------------------

describe('FleetDiscovery.scan — malformed config.json', () => {
  it('keeps instances with invalid JSON and marks them config_error', () => {
    writeInstanceConfig('loops', chatInstance);

    // Write malformed JSON for another instance
    const badDir = path.join(configRoot, 'broken');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'config.json'), '{ not valid json', 'utf8');

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    // Should find the good instance and keep the bad one with an error state
    expect(instances.size).toBe(2);
    expect(instances.has('loops')).toBe(true);
    expect(instances.has('broken')).toBe(true);

    const broken = instances.get('broken');
    expect(broken?.configError).toMatch(/Expected property name/i);
  });

  it('keeps instances with a non-object config root and marks them config_error', () => {
    writeInstanceConfig('array-root', []);

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    expect(instances.get('array-root')).toMatchObject({
      name: 'array-root',
      type: 'chat',
      configError: 'Invalid config.json: config is not a JSON object',
    });
  });

  it('keeps instances with schema errors and marks them config_error', () => {
    writeInstanceConfig('broken-schema', {
      name: 'broken-schema',
      type: 'not-a-real-type',
      accessMode: 'self_only',
      adminPhones: ['15551234567'],
    });

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    expect(instances.size).toBe(1);
    const broken = instances.get('broken-schema');
    expect(broken).toBeDefined();
    expect(broken?.configError).toMatch(/Invalid type/i);
  });

  it('preserves an explicitly unknown transport so clients cannot mistake it for Baileys', () => {
    writeInstanceConfig('future-transport', {
      ...chatInstance,
      name: 'future-transport',
      transport: 'future-provider',
    });

    const discovery = new FleetDiscovery(configRoot);
    const instance = discovery.scan().get('future-transport');

    expect(instance?.configError).toMatch(/transport/i);
    expect(instance?.transport).toBe('future-provider');
  });

  it('keeps instances with load-invalid healthPort and marks them config_error', () => {
    writeInstanceConfig('low-port', {
      name: 'low-port',
      type: 'chat',
      systemPrompt: 'You are low port.',
      accessMode: 'self_only',
      adminPhones: ['15551234567'],
      healthPort: 80,
    });

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    const broken = instances.get('low-port');
    expect(broken).toBeDefined();
    expect(broken?.configError).toMatch(/healthPort must be between 1024 and 65535/);
  });

  it('keeps instances with invalid chatAliases and marks them config_error', () => {
    writeInstanceConfig('bad-aliases', {
      ...chatInstance,
      name: 'bad-aliases',
      chatAliases: { ops: '' },
    });

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    const broken = instances.get('bad-aliases');
    expect(broken).toBeDefined();
    expect(broken?.configError).toMatch(/chatAliases/i);
  });

  it('keeps instances with duplicate trimmed chatAliases and marks them config_error', () => {
    writeInstanceConfig('duplicate-aliases', {
      ...chatInstance,
      name: 'duplicate-aliases',
      chatAliases: {
        ops: '15555550100@s.whatsapp.net',
        ' ops ': '15555550101@s.whatsapp.net',
      },
    });

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    const broken = instances.get('duplicate-aliases');
    expect(broken).toBeDefined();
    expect(broken?.configError).toMatch(/duplicate alias/i);
  });


  it('skips directories without config.json', () => {
    writeInstanceConfig('loops', chatInstance);

    // Create a directory with no config.json
    const emptyDir = path.join(configRoot, 'empty-dir');
    fs.mkdirSync(emptyDir, { recursive: true });

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    expect(instances.size).toBe(1);
    expect(instances.has('loops')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// re-scan picks up new instances
// ---------------------------------------------------------------------------

describe('FleetDiscovery.scan — re-scan picks up new instances', () => {
  it('finds instances added after the first scan', () => {
    writeInstanceConfig('loops', chatInstance);

    const discovery = new FleetDiscovery(configRoot);
    let instances = discovery.scan();
    expect(instances.size).toBe(1);

    // Add a new instance after first scan
    writeInstanceConfig('q-agent', agentInstance);
    instances = discovery.scan();

    expect(instances.size).toBe(2);
    expect(instances.has('q-agent')).toBe(true);
  });

  it('drops instances removed between scans', () => {
    writeInstanceConfig('loops', chatInstance);
    writeInstanceConfig('q-agent', agentInstance);

    const discovery = new FleetDiscovery(configRoot);
    let instances = discovery.scan();
    expect(instances.size).toBe(2);

    // Remove one instance
    fs.rmSync(path.join(configRoot, 'q-agent'), { recursive: true, force: true });
    instances = discovery.scan();

    expect(instances.size).toBe(1);
    expect(instances.has('loops')).toBe(true);
    expect(instances.has('q-agent')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// socket path resolution per instance type
// ---------------------------------------------------------------------------

describe('FleetDiscovery.scan — socket path resolution', () => {
  it('passive instances get a socket path (default or from config)', () => {
    writeInstanceConfig('relay', passiveInstance);

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('relay');

    const stateRoot = path.join(tmpDir, 'state', 'whatsoup', 'instances', 'relay');
    expect(inst!.socketPath).toBe(path.join(stateRoot, 'whatsoup.sock'));
  });

  it('passive instances respect custom socketPath from config', () => {
    writeInstanceConfig('relay', {
      ...passiveInstance,
      socketPath: '/tmp/custom.sock',
    });

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('relay');

    expect(inst!.socketPath).toBe('/tmp/custom.sock');
  });

  it('agent instances get a socket path from cwd or homedir', () => {
    writeInstanceConfig('q-agent', agentInstance);

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('q-agent');

    // Agent without agentOptions.cwd falls back to os.homedir()
    expect(inst!.socketPath).toBe(path.join(os.homedir(), '.claude', 'whatsoup.sock'));
  });

  it('agent instances with explicit cwd use that path', () => {
    writeInstanceConfig('q-agent-cwd', {
      ...agentInstance,
      name: 'q-agent-cwd',
      agentOptions: { sessionScope: 'per_chat', cwd: '/opt/myagent' },
    });

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('q-agent-cwd');

    expect(inst!.socketPath).toBe(path.join('/opt/myagent', '.claude', 'whatsoup.sock'));
  });

  it('agent instances with tilde cwd expand ~ to homedir', () => {
    writeInstanceConfig('q-agent-tilde', {
      ...agentInstance,
      name: 'q-agent-tilde',
      agentOptions: { sessionScope: 'per_chat', cwd: '~/LAB/myagent' },
    });

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('q-agent-tilde');

    expect(inst!.socketPath).toBe(path.join(os.homedir(), 'LAB', 'myagent', '.claude', 'whatsoup.sock'));
  });

  it('chat instances have no socket path', () => {
    writeInstanceConfig('loops', chatInstance);

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    expect(instances.size).toBe(1);
    expect(instances.get('loops')).toMatchObject({
      name: 'loops',
      type: 'chat',
      socketPath: null,
      stateRoot: path.join(tmpDir, 'state', 'whatsoup', 'instances', 'loops'),
    });
  });
});

// ---------------------------------------------------------------------------
// getInstances / getInstance
// ---------------------------------------------------------------------------

describe('FleetDiscovery — getInstances / getInstance', () => {
  it('getInstances returns a copy of the map', () => {
    writeInstanceConfig('loops', chatInstance);

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();

    const copy = discovery.getInstances();
    expect(copy.size).toBe(1);

    // Mutating the copy should not affect internal state
    copy.delete('loops');
    expect(discovery.getInstance('loops')).toBeDefined();
  });

  it('getInstance returns undefined for unknown instances', () => {
    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();

    expect(discovery.getInstance('nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// missing instances directory
// ---------------------------------------------------------------------------

describe('FleetDiscovery.scan — missing instances directory', () => {
  it('returns empty map when configRoot does not exist', () => {
    const discovery = new FleetDiscovery(path.join(tmpDir, 'nonexistent', 'path'));
    const instances = discovery.scan();

    expect(instances.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// auto-refresh lifecycle
// ---------------------------------------------------------------------------

describe('FleetDiscovery — auto-refresh lifecycle', () => {
  it('startAutoRefresh performs initial scan', () => {
    writeInstanceConfig('loops', chatInstance);

    const discovery = new FleetDiscovery(configRoot);
    discovery.startAutoRefresh();

    expect(discovery.getInstance('loops')).toBeDefined();

    discovery.stop();
  });

  it('startAutoRefresh is idempotent — a second call is a no-op', () => {
    vi.useFakeTimers();
    try {
      const discovery = new FleetDiscovery(configRoot);
      const scanSpy = vi.spyOn(discovery, 'scan');

      discovery.startAutoRefresh();
      discovery.startAutoRefresh();
      expect(scanSpy).toHaveBeenCalledTimes(1); // one immediate scan, not two

      vi.advanceTimersByTime(60_000);
      expect(scanSpy).toHaveBeenCalledTimes(2); // one interval tick, not two

      discovery.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop is safe to call multiple times', () => {
    const discovery = new FleetDiscovery(configRoot);
    expect(() => {
      discovery.stop();
      discovery.stop();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// shared agent cwd warning
// ---------------------------------------------------------------------------

describe('FleetDiscovery.scan — shared agent cwd warning', () => {
  function sharedCwdWarns(): WarnCall[] {
    return warnCalls.filter((c) => c.msg === 'fleet scan: agent instances share a working directory');
  }

  it('warns once when two agent instances resolve the same explicit cwd', () => {
    writeInstanceConfig('agent-a', {
      ...agentInstance,
      name: 'agent-a',
      agentOptions: { cwd: '/opt/shared-agent' },
    });
    writeInstanceConfig('agent-b', {
      ...agentInstance,
      name: 'agent-b',
      healthPort: 9093,
      agentOptions: { cwd: '/opt/shared-agent' },
    });

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();

    const warns = sharedCwdWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0].obj).toMatchObject({
      cwd: '/opt/shared-agent',
      instances: ['agent-a', 'agent-b'],
    });

    expect(discovery.getInstance('agent-a')!.sharedCwdWith).toEqual(['agent-b']);
    expect(discovery.getInstance('agent-b')!.sharedCwdWith).toEqual(['agent-a']);
  });

  it('warns when two agent instances both default to the home directory', () => {
    writeInstanceConfig('agent-a', { ...agentInstance, name: 'agent-a' });
    writeInstanceConfig('agent-b', { ...agentInstance, name: 'agent-b', healthPort: 9093 });

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();

    const warns = sharedCwdWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0].obj).toMatchObject({
      cwd: '<home-default>',
      instances: ['agent-a', 'agent-b'],
    });

    expect(discovery.getInstance('agent-a')!.sharedCwdWith).toEqual(['agent-b']);
    expect(discovery.getInstance('agent-b')!.sharedCwdWith).toEqual(['agent-a']);
  });

  it('does not warn when agent instances use distinct cwds', () => {
    writeInstanceConfig('agent-a', {
      ...agentInstance,
      name: 'agent-a',
      agentOptions: { cwd: '/opt/agent-a' },
    });
    writeInstanceConfig('agent-b', {
      ...agentInstance,
      name: 'agent-b',
      healthPort: 9093,
      agentOptions: { cwd: '/opt/agent-b' },
    });

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();

    expect(sharedCwdWarns()).toHaveLength(0);
    expect(discovery.getInstance('agent-a')!.sharedCwdWith).toBeUndefined();
    expect(discovery.getInstance('agent-b')!.sharedCwdWith).toBeUndefined();
  });

  it('excludes chat-type instances from the shared-cwd check', () => {
    // Two chat instances plus a single home-default agent: chat instances have
    // no agent cwd, so no group reaches two members.
    writeInstanceConfig('loops', chatInstance);
    writeInstanceConfig('loops2', { ...chatInstance, name: 'loops2', healthPort: 9094 });
    writeInstanceConfig('agent-a', { ...agentInstance, name: 'agent-a' });

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();

    expect(sharedCwdWarns()).toHaveLength(0);
    expect(discovery.getInstance('loops')!.sharedCwdWith).toBeUndefined();
    expect(discovery.getInstance('loops2')!.sharedCwdWith).toBeUndefined();
    expect(discovery.getInstance('agent-a')!.sharedCwdWith).toBeUndefined();
  });
});

describe('FleetDiscovery - enabled flag', () => {
  it('skips instances with enabled: false (ghost-instance opt-out)', () => {
    // Write a fully valid passive instance but mark it disabled.
    writeInstanceConfig('ghost', {
      name: 'ghost',
      type: 'passive',
      adminPhones: ['15550000000'],
      accessMode: 'self_only',
      healthPort: 9999,
      enabled: false,
    });
    // And an enabled instance alongside it to confirm scan still picks up others.
    writeInstanceConfig('loops', chatInstance);

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    expect(instances.has('ghost')).toBe(false);
    expect(instances.has('loops')).toBe(true);
  });

  it('keeps instances with enabled: true or enabled omitted', () => {
    writeInstanceConfig('active', { ...chatInstance, name: 'active', enabled: true });
    writeInstanceConfig('defaulted', { ...chatInstance, name: 'defaulted' });

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    expect(instances.has('active')).toBe(true);
    expect(instances.has('defaulted')).toBe(true);
  });
});
