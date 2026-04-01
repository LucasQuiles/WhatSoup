import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadInstance } from '../src/instance-loader.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

function writeInstance(baseDir: string, name: string, content: unknown): void {
  const instanceDir = path.join(baseDir, 'whatsoup', 'instances', name);
  fs.mkdirSync(instanceDir, { recursive: true });
  const json = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(path.join(instanceDir, 'config.json'), json, 'utf8');
}

const minimalChat = {
  name: 'test-chat',
  type: 'chat',
  systemPrompt: 'You are a test bot.',
  adminPhones: ['15551234567'],
  accessMode: 'allowlist',
};

const minimalAgent = {
  name: 'test-agent',
  type: 'agent',
  systemPrompt: 'You are an agent.',
  adminPhones: ['15551234567'],
  accessMode: 'self_only',
};

beforeEach(() => {
  // Save environment
  savedEnv = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    INSTANCE_CONFIG: process.env.INSTANCE_CONFIG,
    HOME: process.env.HOME,
  };

  // Create temp directory
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-loader-test-'));

  // Point XDG env vars at separate subdirs to catch wrong-root bugs
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');

  // Clear any existing INSTANCE_CONFIG
  delete process.env.INSTANCE_CONFIG;
});

afterEach(() => {
  // Restore environment
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clean up temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path: valid chat instance
// ---------------------------------------------------------------------------

describe('loadInstance — happy path: chat', () => {
  it('sets INSTANCE_CONFIG with correct fields and paths', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', minimalChat);
    loadInstance('test-chat');

    expect(process.env.INSTANCE_CONFIG).toBeDefined();
    const config = JSON.parse(process.env.INSTANCE_CONFIG!);

    // Identity fields
    expect(config.name).toBe('test-chat');
    expect(config.type).toBe('chat');
    expect(config.systemPrompt).toBe('You are a test bot.');
    expect(config.adminPhones).toEqual(['15551234567']);
    expect(config.accessMode).toBe('allowlist');

    // Path resolution — canonical whatsoup/instances/ namespace
    expect(config.paths).toBeDefined();
    const p = config.paths;
    const configRoot = path.join(tmpDir, 'config', 'whatsoup', 'instances', 'test-chat');
    const dataRoot = path.join(tmpDir, 'data', 'whatsoup', 'instances', 'test-chat');
    const stateRoot = path.join(tmpDir, 'state', 'whatsoup', 'instances', 'test-chat');

    expect(p.configRoot).toBe(configRoot);
    expect(p.authDir).toBe(path.join(configRoot, 'auth'));
    expect(p.dbPath).toBe(path.join(dataRoot, 'bot.db'));
    expect(p.logDir).toBe(path.join(dataRoot, 'logs'));
    expect(p.lockPath).toBe(path.join(stateRoot, 'whatsoup.lock'));
    expect(p.mediaDir).toBe(path.join(dataRoot, 'media', 'tmp'));

    // Cross-root checks: data/state must not bleed into config
    expect(p.dataRoot).toContain('/data/whatsoup/instances/');
    expect(p.stateRoot).toContain('/state/whatsoup/instances/');
    expect(p.dataRoot).not.toContain('/config/');
    expect(p.stateRoot).not.toContain('/config/');
  });
});

// ---------------------------------------------------------------------------
// Happy path: valid agent instance
// ---------------------------------------------------------------------------

describe('loadInstance — happy path: agent', () => {
  it('sets INSTANCE_CONFIG with accessMode self_only', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-agent', minimalAgent);
    loadInstance('test-agent');

    expect(process.env.INSTANCE_CONFIG).toBeDefined();
    const config = JSON.parse(process.env.INSTANCE_CONFIG!);

    expect(config.name).toBe('test-agent');
    expect(config.type).toBe('agent');
    expect(config.accessMode).toBe('self_only');
    expect(config.paths).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Optional chat fields preserved in INSTANCE_CONFIG
// ---------------------------------------------------------------------------

describe('loadInstance — optional fields preserved', () => {
  it('preserves models, pineconeIndex, maxTokens, tokenBudget, rateLimitPerHour, healthPort', () => {
    const richChat = {
      ...minimalChat,
      models: {
        conversation: 'claude-opus-4-6',
        extraction: 'claude-sonnet-4-6',
        validation: 'claude-haiku-4-5',
        fallback: 'gpt-4',
      },
      pineconeIndex: 'whatsapp-bot',
      maxTokens: 750,
      tokenBudget: 100000,
      rateLimitPerHour: 45,
      healthPort: 9090,
    };
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', richChat);
    loadInstance('test-chat');

    const config = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(config.models).toEqual(richChat.models);
    expect(config.pineconeIndex).toBe('whatsapp-bot');
    expect(config.maxTokens).toBe(750);
    expect(config.tokenBudget).toBe(100000);
    expect(config.rateLimitPerHour).toBe(45);
    expect(config.healthPort).toBe(9090);
  });
});

// ---------------------------------------------------------------------------
// Different instances get different paths (CON-001.AC-01)
// ---------------------------------------------------------------------------

describe('loadInstance — different instances have different paths', () => {
  it('instance-a and instance-b get independent paths', () => {
    writeInstance(path.join(tmpDir, 'config'), 'instance-a', { ...minimalChat, name: 'instance-a' });
    writeInstance(path.join(tmpDir, 'config'), 'instance-b', { ...minimalChat, name: 'instance-b' });

    loadInstance('instance-a');
    const configA = JSON.parse(process.env.INSTANCE_CONFIG!);

    loadInstance('instance-b');
    const configB = JSON.parse(process.env.INSTANCE_CONFIG!);

    expect(configA.paths.configRoot).not.toBe(configB.paths.configRoot);
    expect(configA.paths.authDir).not.toBe(configB.paths.authDir);
    expect(configA.paths.dbPath).not.toBe(configB.paths.dbPath);
    expect(configA.paths.configRoot).toContain('instance-a');
    expect(configB.paths.configRoot).toContain('instance-b');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('loadInstance — error: missing config.json', () => {
  it('throws when config.json does not exist', () => {
    // Do not write anything
    expect(() => loadInstance('nonexistent')).toThrow();
  });
});

describe('loadInstance — error: empty name', () => {
  it('throws when name is empty string', () => {
    expect(() => loadInstance('')).toThrow(/required|name/i);
  });
});

describe('loadInstance — error: invalid JSON', () => {
  it('throws when config.json contains invalid JSON', () => {
    const instanceDir = path.join(tmpDir, 'config', 'whatsoup', 'instances', 'bad-json');
    fs.mkdirSync(instanceDir, { recursive: true });
    fs.writeFileSync(path.join(instanceDir, 'config.json'), '{ not valid json', 'utf8');

    expect(() => loadInstance('bad-json')).toThrow();
  });
});

describe('loadInstance — error: name mismatch', () => {
  it('throws when instance.name does not match the directory name', () => {
    writeInstance(path.join(tmpDir, 'config'), 'folder-name', { ...minimalChat, name: 'different-name' });
    expect(() => loadInstance('folder-name')).toThrow(/name.*mismatch|mismatch.*name/i);
  });
});

describe('loadInstance — error: invalid type', () => {
  it('throws when type is not "chat" or "agent"', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-type', { ...minimalChat, name: 'bad-type', type: 'robot' });
    expect(() => loadInstance('bad-type')).toThrow(/type/i);
  });
});

describe('loadInstance — error: agent without accessMode self_only', () => {
  it('throws when type is "agent" but accessMode is not "self_only"', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-agent', {
      name: 'test-agent',
      type: 'agent',
      systemPrompt: 'Agent without self_only accessMode.',
      adminPhones: ['15551234567'],
      accessMode: 'allowlist',
    });
    expect(() => loadInstance('test-agent')).toThrow(/accessMode.*self_only|self_only/i);
  });
});

describe('loadInstance — agent with multiple admin phones (JID + LID)', () => {
  it('accepts agent with multiple phones representing same person (JID + LID)', () => {
    writeInstance(path.join(tmpDir, 'config'), 'multi-admin', {
      name: 'multi-admin',
      type: 'agent',
      adminPhones: ['15550100001', '15550100002'],
      accessMode: 'self_only',
    });
    loadInstance('multi-admin');
    const parsed = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(parsed.adminPhones).toHaveLength(2);
  });
});

describe('loadInstance — error: chat missing systemPrompt', () => {
  it('throws when type is "chat" and systemPrompt is missing', () => {
    const { systemPrompt: _omit, ...noPrompt } = minimalChat;
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', noPrompt);
    expect(() => loadInstance('test-chat')).toThrow(/systemPrompt/i);
  });
});

describe('loadInstance — error: missing adminPhones', () => {
  it('throws when adminPhones is absent', () => {
    const { adminPhones: _omit, ...noAdmin } = minimalChat;
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', noAdmin);
    expect(() => loadInstance('test-chat')).toThrow(/adminPhones/i);
  });

  it('throws when adminPhones is an empty array', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', { ...minimalChat, adminPhones: [] });
    expect(() => loadInstance('test-chat')).toThrow(/adminPhones/i);
  });

  it('throws when adminPhones contains non-string or empty-string elements', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', { ...minimalChat, adminPhones: [null, 42, ''] });
    expect(() => loadInstance('test-chat')).toThrow(/adminPhones/i);
  });
});

describe('loadInstance — error: invalid accessMode', () => {
  it('throws when accessMode is not one of the valid values', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', { ...minimalChat, accessMode: 'everyone' });
    expect(() => loadInstance('test-chat')).toThrow(/accessMode/i);
  });
});

// ---------------------------------------------------------------------------
// agentOptions validation (CON-007)
// ---------------------------------------------------------------------------

describe('loadInstance — agentOptions: sessionScope "shared" allows non-self_only accessMode', () => {
  it('accepts agent with agentOptions + sessionScope:"shared" + accessMode:"allowlist"', () => {
    writeInstance(path.join(tmpDir, 'config'), 'shared-agent', {
      name: 'shared-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'allowlist',
      agentOptions: {
        sessionScope: 'shared',
        cwd: '/tmp',
      },
    });
    loadInstance('shared-agent');
    const parsed = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(parsed.accessMode).toBe('allowlist');
    expect(parsed.agentOptions.sessionScope).toBe('shared');
  });
});

describe('loadInstance — agentOptions: sessionScope "single" still requires self_only', () => {
  it('rejects agent with agentOptions + sessionScope:"single" + accessMode:"allowlist"', () => {
    writeInstance(path.join(tmpDir, 'config'), 'single-agent', {
      name: 'single-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'allowlist',
      agentOptions: {
        sessionScope: 'single',
        cwd: '/tmp',
      },
    });
    expect(() => loadInstance('single-agent')).toThrow(/accessMode.*self_only|self_only/i);
  });
});

describe('loadInstance — agentOptions: sessionScope is required', () => {
  it('rejects agent with agentOptions missing sessionScope', () => {
    writeInstance(path.join(tmpDir, 'config'), 'no-scope-agent', {
      name: 'no-scope-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        cwd: '/tmp',
      },
    });
    expect(() => loadInstance('no-scope-agent')).toThrow(/sessionScope/i);
  });
});

describe('loadInstance — agentOptions: cwd is required', () => {
  it('rejects agent with agentOptions missing cwd', () => {
    writeInstance(path.join(tmpDir, 'config'), 'no-cwd-agent', {
      name: 'no-cwd-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'single',
      },
    });
    expect(() => loadInstance('no-cwd-agent')).toThrow(/cwd/i);
  });
});

describe('loadInstance — agentOptions: valid single scope + self_only', () => {
  it('accepts agent with agentOptions + sessionScope:"single" + accessMode:"self_only"', () => {
    writeInstance(path.join(tmpDir, 'config'), 'single-self-agent', {
      name: 'single-self-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'single',
        cwd: '/tmp',
        instructionsPath: 'CLAUDE.md',
      },
    });
    loadInstance('single-self-agent');
    const parsed = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(parsed.agentOptions.sessionScope).toBe('single');
    expect(parsed.agentOptions.cwd).toBe('/tmp');
    expect(parsed.agentOptions.instructionsPath).toBe('CLAUDE.md');
  });
});

describe('loadInstance — agentOptions: sandboxPerChat requires per_chat scope', () => {
  it('rejects agent with sandboxPerChat:true and sessionScope:"shared"', () => {
    writeInstance(path.join(tmpDir, 'config'), 'sandbox-bad-scope', {
      name: 'sandbox-bad-scope',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'allowlist',
      agentOptions: {
        sessionScope: 'shared',
        cwd: '/tmp',
        sandboxPerChat: true,
      },
    });
    expect(() => loadInstance('sandbox-bad-scope')).toThrow(/sandboxPerChat.*per_chat|per_chat/i);
  });

  it('rejects agent with sandboxPerChat:true and sessionScope:"single"', () => {
    writeInstance(path.join(tmpDir, 'config'), 'sandbox-single-bad', {
      name: 'sandbox-single-bad',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'single',
        cwd: '/tmp',
        sandboxPerChat: true,
      },
    });
    expect(() => loadInstance('sandbox-single-bad')).toThrow(/sandboxPerChat.*per_chat|per_chat/i);
  });

  it('accepts agent with sandboxPerChat:true and sessionScope:"per_chat"', () => {
    writeInstance(path.join(tmpDir, 'config'), 'sandbox-per-chat', {
      name: 'sandbox-per-chat',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'allowlist',
      agentOptions: {
        sessionScope: 'per_chat',
        cwd: '/tmp',
        sandboxPerChat: true,
      },
    });
    loadInstance('sandbox-per-chat');
    const parsed = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(parsed.agentOptions.sessionScope).toBe('per_chat');
    expect(parsed.agentOptions.sandboxPerChat).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// passive instance type
// ---------------------------------------------------------------------------

describe('passive instance type', () => {
  it('accepts type passive with self_only access', () => {
    writeInstance(path.join(tmpDir, 'config'), 'my-passive', {
      name: 'my-passive',
      type: 'passive',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
    });
    loadInstance('my-passive');

    expect(process.env.INSTANCE_CONFIG).toBeDefined();
    const config = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(config.type).toBe('passive');
    expect(config.accessMode).toBe('self_only');
  });

  it('rejects passive with systemPrompt', () => {
    writeInstance(path.join(tmpDir, 'config'), 'my-passive', {
      name: 'my-passive',
      type: 'passive',
      systemPrompt: 'Should not be here.',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
    });
    expect(() => loadInstance('my-passive')).toThrow(/must not have a systemPrompt/i);
  });

  it('rejects passive with accessMode other than self_only', () => {
    writeInstance(path.join(tmpDir, 'config'), 'my-passive', {
      name: 'my-passive',
      type: 'passive',
      adminPhones: ['15551234567'],
      accessMode: 'open_dm',
    });
    expect(() => loadInstance('my-passive')).toThrow(/self_only/i);
  });
});

// ---------------------------------------------------------------------------
// loops instance config loads and validates correctly
// ---------------------------------------------------------------------------

describe('loadInstance — loops instance config', () => {
  it('loads the loops instance.json from repo and validates correctly', () => {
    // Read the actual loops instance.json from repo
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const loopsJson = fs.readFileSync(
      path.join(repoRoot, 'instances', 'loops', 'instance.json'),
      'utf8',
    );
    const loops = JSON.parse(loopsJson) as Record<string, unknown>;

    // Write to temp dir and load
    writeInstance(path.join(tmpDir, 'config'), 'loops', loops);
    loadInstance('loops');

    const config = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(config.name).toBe('loops');
    expect(config.type).toBe('agent');
    expect(config.accessMode).toBe('allowlist');
    expect(config.agentOptions).toBeDefined();
    expect(config.agentOptions.sessionScope).toBe('per_chat');
    expect(config.agentOptions.sandboxPerChat).toBe(true);
    expect(config.agentOptions.cwd).toBe('~/LAB/Loops');
    expect(config.agentOptions.instructionsPath).toBe('CLAUDE.md');
  });
});

// ---------------------------------------------------------------------------
// Canonical namespace paths
// ---------------------------------------------------------------------------

describe('canonical namespace paths', () => {
  it('resolves config under whatsoup/instances/<name>/', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', minimalChat);
    loadInstance('test-chat');

    const config = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(config.paths.configRoot).toContain('whatsoup/instances/test-chat');
  });

  it('resolves auth under configRoot/auth/', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', minimalChat);
    loadInstance('test-chat');

    const config = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(config.paths.authDir).toBe(path.join(config.paths.configRoot, 'auth'));
  });

  it('resolves lock as whatsoup.lock', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', minimalChat);
    loadInstance('test-chat');

    const config = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(config.paths.lockPath).toMatch(/whatsoup\.lock$/);
  });
});

// ---------------------------------------------------------------------------
// XDG fallback when XDG_CONFIG_HOME not set
// ---------------------------------------------------------------------------

describe('loadInstance — XDG fallback', () => {
  it('falls back to ~/.config/whatsoup/instances when XDG_CONFIG_HOME is not set', () => {
    const fakeHome = path.join(tmpDir, 'fake-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;

    const fallbackConfig = path.join(fakeHome, '.config');
    const fallbackData = path.join(fakeHome, '.local', 'share');
    const fallbackState = path.join(fakeHome, '.local', 'state');

    // Write the instance under the fake fallback path (canonical whatsoup/instances namespace)
    writeInstance(fallbackConfig, 'xdg-fallback-instance', {
      ...minimalChat,
      name: 'xdg-fallback-instance',
    });

    loadInstance('xdg-fallback-instance');

    const config = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(config.paths.configRoot).toBe(
      path.join(fallbackConfig, 'whatsoup', 'instances', 'xdg-fallback-instance'),
    );
    expect(config.paths.authDir).toBe(
      path.join(fallbackConfig, 'whatsoup', 'instances', 'xdg-fallback-instance', 'auth'),
    );
    expect(config.paths.dbPath).toBe(
      path.join(fallbackData, 'whatsoup', 'instances', 'xdg-fallback-instance', 'bot.db'),
    );
    expect(config.paths.lockPath).toBe(
      path.join(fallbackState, 'whatsoup', 'instances', 'xdg-fallback-instance', 'whatsoup.lock'),
    );
  });
});
