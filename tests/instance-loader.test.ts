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
    TMPDIR: process.env.TMPDIR,
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
  delete process.env.TMPDIR;
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
    expect(p.tmpDir).toBe(path.join(tmpDir, 'data', 'whatsoup', 'tmp', 'test-chat'));
    expect(process.env.TMPDIR).toBe(p.tmpDir);
    expect(fs.statSync(process.env.TMPDIR!).isDirectory()).toBe(true);

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
    expect(config.paths).toEqual({
      configRoot: path.join(tmpDir, 'config', 'whatsoup', 'instances', 'test-agent'),
      dataRoot: path.join(tmpDir, 'data', 'whatsoup', 'instances', 'test-agent'),
      stateRoot: path.join(tmpDir, 'state', 'whatsoup', 'instances', 'test-agent'),
      authDir: path.join(tmpDir, 'config', 'whatsoup', 'instances', 'test-agent', 'auth'),
      dbPath: path.join(tmpDir, 'data', 'whatsoup', 'instances', 'test-agent', 'bot.db'),
      logDir: path.join(tmpDir, 'data', 'whatsoup', 'instances', 'test-agent', 'logs'),
      lockPath: path.join(tmpDir, 'state', 'whatsoup', 'instances', 'test-agent', 'whatsoup.lock'),
      mediaDir: path.join(tmpDir, 'data', 'whatsoup', 'instances', 'test-agent', 'media', 'tmp'),
      tmpDir: path.join(tmpDir, 'data', 'whatsoup', 'tmp', 'test-agent'),
    });
  });
});

// ---------------------------------------------------------------------------
// Optional chat fields preserved in INSTANCE_CONFIG
// ---------------------------------------------------------------------------

describe('loadInstance — optional fields preserved', () => {
  it('preserves models, pineconeIndex, chatAliases, maxTokens, tokenBudget, rateLimitPerHour, healthPort', () => {
    const richChat = {
      ...minimalChat,
      models: {
        conversation: 'claude-opus-4-6',
        extraction: 'claude-sonnet-4-6',
        validation: 'claude-haiku-4-5',
        fallback: 'gpt-4',
      },
      memory: {
        pinecone: {
          apiKeyEnv: 'PINECONE_TEST_KEY',
          index: 'mw-mind',
          projectId: 'o6fsxb8',
        },
      },
      pineconeIndex: 'whatsapp-bot',
      pineconeAllowedIndexes: ['mw-mind'],
      chatAliases: {
        ops: '15555550100@s.whatsapp.net',
        support: '120363001@g.us',
      },
      maxTokens: 750,
      tokenBudget: 100000,
      rateLimitPerHour: 45,
      healthPort: 9090,
    };
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', richChat);
    loadInstance('test-chat');

    const config = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(config.models).toEqual(richChat.models);
    expect(config.memory).toEqual(richChat.memory);
    expect(config.pineconeIndex).toBe('whatsapp-bot');
    expect(config.pineconeAllowedIndexes).toEqual(['mw-mind']);
    expect(config.chatAliases).toEqual(richChat.chatAliases);
    expect(config.maxTokens).toBe(750);
    expect(config.tokenBudget).toBe(100000);
    expect(config.rateLimitPerHour).toBe(45);
    expect(config.healthPort).toBe(9090);
  });

  it('preserves gui and guiPort fields', () => {
    const guiChat = {
      ...minimalChat,
      gui: true,
      guiPort: 8080,
    };
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', guiChat);
    loadInstance('test-chat');

    const config = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(config.gui).toBe(true);
    expect(config.guiPort).toBe(8080);
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

describe('loadInstance — agent without agentOptions accepts any accessMode', () => {
  it('accepts type "agent" with non-self_only accessMode and no agentOptions (AE1-AE4 protections live)', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-agent', {
      name: 'test-agent',
      type: 'agent',
      systemPrompt: 'Agent without agentOptions.',
      adminPhones: ['15551234567'],
      accessMode: 'allowlist',
    });
    loadInstance('test-agent');
    const parsed = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(parsed.accessMode).toBe('allowlist');
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
  it('throws when name is absent', () => {
    const { name: _omit, ...noName } = minimalChat;
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', noName);
    expect(() => loadInstance('test-chat')).toThrow(/name/i);
  });

  it('throws when type is absent', () => {
    const { type: _omit, ...noType } = minimalChat;
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', noType);
    expect(() => loadInstance('test-chat')).toThrow(/type/i);
  });

  it('throws when accessMode is absent', () => {
    const { accessMode: _omit, ...noAccessMode } = minimalChat;
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', noAccessMode);
    expect(() => loadInstance('test-chat')).toThrow(/accessMode/i);
  });

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

  it('throws when chatAliases contains non-string or empty aliases', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', {
      ...minimalChat,
      chatAliases: { ' ': '15555550100@s.whatsapp.net', ops: '' },
    });
    expect(() => loadInstance('test-chat')).toThrow(/chatAliases/i);
  });

  it('throws when chatAliases contains duplicate aliases after trimming', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', {
      ...minimalChat,
      chatAliases: {
        ops: '15555550100@s.whatsapp.net',
        ' ops ': '15555550101@s.whatsapp.net',
      },
    });
    expect(() => loadInstance('test-chat')).toThrow(/duplicate alias/i);
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

describe('loadInstance — agentOptions: sessionScope "single" accepts any accessMode', () => {
  it('accepts agent with agentOptions + sessionScope:"single" + accessMode:"allowlist" (AE1-AE4 protections live)', () => {
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
    loadInstance('single-agent');
    const parsed = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(parsed.accessMode).toBe('allowlist');
    expect(parsed.agentOptions.sessionScope).toBe('single');
  });
});

describe('loadInstance — agentOptions: sessionScope is optional', () => {
  it('accepts agent with agentOptions missing sessionScope (runtime defaults to "single")', () => {
    // Inverted from the original required-on-load rule: AgentRuntime defaults
    // a missing sessionScope to 'single' (src/runtimes/agent/runtime.ts), so
    // the loader must not brick a config the runtime would boot.
    writeInstance(path.join(tmpDir, 'config'), 'no-scope-agent', {
      name: 'no-scope-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        cwd: '/tmp',
      },
    });
    loadInstance('no-scope-agent');
    const parsed = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(parsed.agentOptions).toEqual({ cwd: '/tmp' });
  });

  it('still rejects agent with an invalid sessionScope value', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-scope-agent', {
      name: 'bad-scope-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'global',
        cwd: '/tmp',
      },
    });
    expect(() => loadInstance('bad-scope-agent')).toThrow(/sessionScope/i);
  });
});

describe('loadInstance — agentOptions: cwd is optional', () => {
  it('accepts agent with agentOptions missing cwd (defaults to homedir at runtime)', () => {
    writeInstance(path.join(tmpDir, 'config'), 'no-cwd-agent', {
      name: 'no-cwd-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'single',
      },
    });
    loadInstance('no-cwd-agent');
    const config = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(config.agentOptions).toEqual({ sessionScope: 'single' });
  });

  it('accepts agent with empty string cwd (defaults to homedir at runtime)', () => {
    writeInstance(path.join(tmpDir, 'config'), 'empty-cwd-agent', {
      name: 'empty-cwd-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'single',
        cwd: '',
      },
    });
    loadInstance('empty-cwd-agent');
    const config = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(config.agentOptions.cwd).toBe('');
  });

  it('rejects agent with non-string cwd', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-cwd-agent', {
      name: 'bad-cwd-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'single',
        cwd: 42,
      },
    });
    expect(() => loadInstance('bad-cwd-agent')).toThrow(/cwd/i);
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

describe('loadInstance — agentOptions: providerConfig validation', () => {
  it('rejects non-object providerConfig', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-provider-config-agent', {
      name: 'bad-provider-config-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'single',
        providerConfig: [],
      },
    });

    expect(() => loadInstance('bad-provider-config-agent')).toThrow(
      /agentOptions\.providerConfig.*object/,
    );
  });

  it('rejects non-object providerConfig.budget', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-provider-budget-agent', {
      name: 'bad-provider-budget-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'single',
        providerConfig: {
          budget: 'daily',
        },
      },
    });

    expect(() => loadInstance('bad-provider-budget-agent')).toThrow(
      /agentOptions\.providerConfig\.budget.*object/,
    );
  });
});

describe('loadInstance — chatOptions: openaiProviderConfig validation (QR-218 PR-2)', () => {
  it('accepts a chat instance with no chatOptions at all (backward-compat)', () => {
    writeInstance(path.join(tmpDir, 'config'), 'test-chat', minimalChat);
    expect(() => loadInstance('test-chat')).not.toThrow();
  });

  it('accepts a valid chatOptions.openaiProviderConfig', () => {
    writeInstance(path.join(tmpDir, 'config'), 'good-chat-provider-config', {
      ...minimalChat,
      name: 'good-chat-provider-config',
      chatOptions: {
        openaiProviderConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService: 'openai' },
      },
    });
    expect(() => loadInstance('good-chat-provider-config')).not.toThrow();
  });

  it('rejects a non-object chatOptions rather than silently booting', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-chat-options', {
      ...minimalChat,
      name: 'bad-chat-options',
      chatOptions: 'nope',
    });
    expect(() => loadInstance('bad-chat-options')).toThrow(/chatOptions.*object/);
  });

  it('rejects a non-object chatOptions.openaiProviderConfig', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-chat-provider-config', {
      ...minimalChat,
      name: 'bad-chat-provider-config',
      chatOptions: { openaiProviderConfig: [] },
    });
    expect(() => loadInstance('bad-chat-provider-config')).toThrow(
      /chatOptions\.openaiProviderConfig.*object/,
    );
  });

  it('rejects a malformed chatOptions.openaiProviderConfig.baseUrl', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-chat-baseurl', {
      ...minimalChat,
      name: 'bad-chat-baseurl',
      chatOptions: { openaiProviderConfig: { baseUrl: 'not a url' } },
    });
    expect(() => loadInstance('bad-chat-baseurl')).toThrow(
      /chatOptions\.openaiProviderConfig\.baseUrl/,
    );
  });

  it('rejects an unknown chatOptions.openaiProviderConfig.apiKeyService', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-chat-keyservice', {
      ...minimalChat,
      name: 'bad-chat-keyservice',
      chatOptions: {
        openaiProviderConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService: 'nope-svc' },
      },
    });
    expect(() => loadInstance('bad-chat-keyservice')).toThrow(
      /chatOptions\.openaiProviderConfig\.apiKeyService/,
    );
  });

  it('rejects chatOptions.openaiProviderConfig.apiKeyService set without baseUrl', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-chat-keyservice-no-baseurl', {
      ...minimalChat,
      name: 'bad-chat-keyservice-no-baseurl',
      chatOptions: { openaiProviderConfig: { apiKeyService: 'openai' } },
    });
    expect(() => loadInstance('bad-chat-keyservice-no-baseurl')).toThrow(
      /chatOptions\.openaiProviderConfig\.apiKeyService/,
    );
  });
});

describe('loadInstance — transcriptionOptions: openaiProviderConfig validation (QR-218 PR-B)', () => {
  it('accepts a valid transcriptionOptions.openaiProviderConfig on agent instances', () => {
    writeInstance(path.join(tmpDir, 'config'), 'good-transcription-provider-config', {
      ...minimalAgent,
      name: 'good-transcription-provider-config',
      agentOptions: { sessionScope: 'single' },
      transcriptionOptions: {
        openaiProviderConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService: 'openai' },
      },
    });
    expect(() => loadInstance('good-transcription-provider-config')).not.toThrow();
  });

  it('rejects a non-object transcriptionOptions rather than silently booting', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-transcription-options', {
      ...minimalAgent,
      name: 'bad-transcription-options',
      transcriptionOptions: 'nope',
    });
    expect(() => loadInstance('bad-transcription-options')).toThrow(/transcriptionOptions.*object/);
  });

  it('rejects a non-object transcriptionOptions.openaiProviderConfig', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-transcription-provider-config', {
      ...minimalAgent,
      name: 'bad-transcription-provider-config',
      transcriptionOptions: { openaiProviderConfig: [] },
    });
    expect(() => loadInstance('bad-transcription-provider-config')).toThrow(
      /transcriptionOptions\.openaiProviderConfig.*object/,
    );
  });

  it('rejects a malformed transcriptionOptions.openaiProviderConfig.baseUrl', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-transcription-baseurl', {
      ...minimalAgent,
      name: 'bad-transcription-baseurl',
      transcriptionOptions: { openaiProviderConfig: { baseUrl: 'not a url' } },
    });
    expect(() => loadInstance('bad-transcription-baseurl')).toThrow(
      /transcriptionOptions\.openaiProviderConfig\.baseUrl/,
    );
  });

  it('rejects an unknown transcriptionOptions.openaiProviderConfig.apiKeyService', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-transcription-keyservice', {
      ...minimalAgent,
      name: 'bad-transcription-keyservice',
      transcriptionOptions: {
        openaiProviderConfig: { baseUrl: 'https://api.example.com/v1', apiKeyService: 'nope-svc' },
      },
    });
    expect(() => loadInstance('bad-transcription-keyservice')).toThrow(
      /transcriptionOptions\.openaiProviderConfig\.apiKeyService/,
    );
  });

  it('rejects transcriptionOptions.openaiProviderConfig.apiKeyService set without baseUrl', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bad-transcription-keyservice-no-baseurl', {
      ...minimalAgent,
      name: 'bad-transcription-keyservice-no-baseurl',
      transcriptionOptions: { openaiProviderConfig: { apiKeyService: 'openai' } },
    });
    expect(() => loadInstance('bad-transcription-keyservice-no-baseurl')).toThrow(
      /transcriptionOptions\.openaiProviderConfig\.apiKeyService/,
    );
  });
});

describe('loadInstance — agentOptions: autoCompactInputTokens validation', () => {
  it('preserves a valid autoCompactInputTokens threshold', () => {
    writeInstance(path.join(tmpDir, 'config'), 'compact-agent', {
      name: 'compact-agent',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'single',
        autoCompactInputTokens: 500000,
      },
    });

    loadInstance('compact-agent');
    const parsed = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(parsed.agentOptions.autoCompactInputTokens).toBe(500000);
  });

  it('rejects invalid autoCompactInputTokens thresholds', () => {
    writeInstance(path.join(tmpDir, 'config'), 'compact-agent-bad', {
      name: 'compact-agent-bad',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'single',
        autoCompactInputTokens: 1000,
      },
    });

    expect(() => loadInstance('compact-agent-bad')).toThrow(
      /agentOptions\.autoCompactInputTokens.*50,000/,
    );
  });

  it.each([
    ['below lower bound', 49_999],
    ['above upper bound', 100_000_001],
    ['non-integer', 50_000.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['string', 'one hundred thousand' as unknown as number],
  ])('rejects autoCompactInputTokens: %s', (_label, threshold) => {
    writeInstance(path.join(tmpDir, 'config'), 'compact-agent-bound', {
      name: 'compact-agent-bound',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'single',
        autoCompactInputTokens: threshold,
      },
    });
    expect(() => loadInstance('compact-agent-bound')).toThrow(
      /agentOptions\.autoCompactInputTokens/,
    );
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

describe('loadInstance — agentOptions: perChatConversationBound constraints', () => {
  it('rejects perChatConversationBound:true outside sessionScope "per_chat"', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bound-bad-scope', {
      name: 'bound-bad-scope',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'allowlist',
      agentOptions: {
        sessionScope: 'shared',
        cwd: '/tmp',
        perChatConversationBound: true,
      },
    });
    expect(() => loadInstance('bound-bad-scope')).toThrow(/perChatConversationBound.*per_chat/);
  });

  it('rejects perChatConversationBound:true combined with sandboxPerChat:true', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bound-sandbox-clash', {
      name: 'bound-sandbox-clash',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'allowlist',
      agentOptions: {
        sessionScope: 'per_chat',
        cwd: '/tmp',
        sandboxPerChat: true,
        perChatConversationBound: true,
      },
    });
    expect(() => loadInstance('bound-sandbox-clash')).toThrow(/perChatConversationBound.*incompatible with sandboxPerChat/);
  });

  it('accepts perChatConversationBound:true with sessionScope "per_chat" (non-sandbox)', () => {
    writeInstance(path.join(tmpDir, 'config'), 'bound-ok', {
      name: 'bound-ok',
      type: 'agent',
      adminPhones: ['15551234567'],
      accessMode: 'allowlist',
      agentOptions: {
        sessionScope: 'per_chat',
        cwd: '/tmp',
        perChatConversationBound: true,
      },
    });
    loadInstance('bound-ok');
    const parsed = JSON.parse(process.env.INSTANCE_CONFIG!);
    expect(parsed.agentOptions.perChatConversationBound).toBe(true);
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
    // Sanitized fixture — mirrors the real loops config shape without committing
    // phone numbers or API keys. Real instances/*/instance.json is .gitignored.
    const loops: Record<string, unknown> = {
      name: 'loops',
      type: 'agent',
      adminPhones: ['+15555550100'],
      accessMode: 'allowlist',
      agentOptions: {
        sessionScope: 'per_chat',
        sandboxPerChat: true,
        cwd: '~/LAB/Loops',
        instructionsPath: 'CLAUDE.md',
      },
    };

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

describe('resolveAgentModel', () => {
  it('returns the top-level model when set', async () => {
    const { resolveAgentModel } = await import('../src/instance-loader.ts');
    expect(resolveAgentModel({ model: 'claude-opus-4-7' })).toBe('claude-opus-4-7');
  });

  it('top-level model wins over models.conversation', async () => {
    const { resolveAgentModel } = await import('../src/instance-loader.ts');
    expect(
      resolveAgentModel({
        model: 'claude-opus-4-7',
        models: { conversation: 'claude-haiku-4-5' },
      }),
    ).toBe('claude-opus-4-7');
  });

  it('falls back to models.conversation when top-level model is unset', async () => {
    const { resolveAgentModel } = await import('../src/instance-loader.ts');
    expect(resolveAgentModel({ models: { conversation: 'claude-haiku-4-5' } })).toBe(
      'claude-haiku-4-5',
    );
  });

  it('falls back to models.conversation when top-level model is an empty string', async () => {
    const { resolveAgentModel } = await import('../src/instance-loader.ts');
    expect(
      resolveAgentModel({ model: '   ', models: { conversation: 'claude-haiku-4-5' } }),
    ).toBe('claude-haiku-4-5');
  });

  it('returns undefined when nothing is set', async () => {
    const { resolveAgentModel } = await import('../src/instance-loader.ts');
    expect(resolveAgentModel({})).toBeUndefined();
    expect(resolveAgentModel(null)).toBeUndefined();
    expect(resolveAgentModel(undefined)).toBeUndefined();
  });

  it('returns undefined when models.conversation is empty/non-string', async () => {
    const { resolveAgentModel } = await import('../src/instance-loader.ts');
    expect(resolveAgentModel({ models: { conversation: '' } })).toBeUndefined();
    expect(resolveAgentModel({ models: { conversation: 42 as unknown as string } })).toBeUndefined();
    expect(resolveAgentModel({ models: {} })).toBeUndefined();
  });
});
