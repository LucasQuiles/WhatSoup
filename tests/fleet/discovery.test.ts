import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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

  it('defaults healthPort to 3010 when not specified', () => {
    writeInstanceConfig('minimal', { type: 'chat' });

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('minimal');

    expect(inst!.healthPort).toBe(3010);
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
    discovery.scan();
    const inst = discovery.getInstance('loops');

    expect(inst!.healthToken).toBeNull();
  });

  it('returns null when tokens.env has no WHATSOUP_HEALTH_TOKEN line', () => {
    writeInstanceConfig('loops', chatInstance);
    writeTokensEnv('loops', 'SOME_OTHER_TOKEN=abc\nFOO=bar\n');

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('loops');

    expect(inst!.healthToken).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// malformed config.json
// ---------------------------------------------------------------------------

describe('FleetDiscovery.scan — malformed config.json', () => {
  it('skips instances with invalid JSON and continues scanning', () => {
    writeInstanceConfig('loops', chatInstance);

    // Write malformed JSON for another instance
    const badDir = path.join(configRoot, 'broken');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'config.json'), '{ not valid json', 'utf8');

    const discovery = new FleetDiscovery(configRoot);
    const instances = discovery.scan();

    // Should find the good instance, skip the bad one
    expect(instances.size).toBe(1);
    expect(instances.has('loops')).toBe(true);
    expect(instances.has('broken')).toBe(false);
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

  it('agent instances get a socket path', () => {
    writeInstanceConfig('q-agent', agentInstance);

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('q-agent');

    const stateRoot = path.join(tmpDir, 'state', 'whatsoup', 'instances', 'q-agent');
    expect(inst!.socketPath).toBe(path.join(stateRoot, 'whatsoup.sock'));
  });

  it('chat instances have no socket path', () => {
    writeInstanceConfig('loops', chatInstance);

    const discovery = new FleetDiscovery(configRoot);
    discovery.scan();
    const inst = discovery.getInstance('loops');

    expect(inst!.socketPath).toBeNull();
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

  it('stop is safe to call multiple times', () => {
    const discovery = new FleetDiscovery(configRoot);
    discovery.stop();
    discovery.stop();
    // No throw
  });
});
