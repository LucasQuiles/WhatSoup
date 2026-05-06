import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Env var management
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  savedEnv = {
    INSTANCE_CONFIG: process.env.INSTANCE_CONFIG,
    CONVERSATION_MODEL: process.env.CONVERSATION_MODEL,
    EXTRACTION_MODEL: process.env.EXTRACTION_MODEL,
    VALIDATION_MODEL: process.env.VALIDATION_MODEL,
    FALLBACK_MODEL: process.env.FALLBACK_MODEL,
    PINECONE_INDEX: process.env.PINECONE_INDEX,
    PINECONE_PROJECT_ID: process.env.PINECONE_PROJECT_ID,
    PINECONE_EXPECTED_HOST_SUFFIX: process.env.PINECONE_EXPECTED_HOST_SUFFIX,
    MW_MIND_EMBED_URL: process.env.MW_MIND_EMBED_URL,
    RECENCY_HALF_LIFE_DAYS: process.env.RECENCY_HALF_LIFE_DAYS,
    MAX_AGE_DAYS: process.env.MAX_AGE_DAYS,
    LOG_LEVEL: process.env.LOG_LEVEL,
    WHATSOUP_CONFIG_DIR: process.env.WHATSOUP_CONFIG_DIR,
    WHATSOUP_DATA_DIR: process.env.WHATSOUP_DATA_DIR,
    WHATSOUP_STATE_DIR: process.env.WHATSOUP_STATE_DIR,
    WHATSOUP_GUI_PORT: process.env.WHATSOUP_GUI_PORT,
    // P3.6 D-2: new env var that overrides apiTimeoutMs.
    WHATSOUP_API_TIMEOUT_MS: process.env.WHATSOUP_API_TIMEOUT_MS,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };

  // Create a temp dir for filesystem side effects from config
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));

  // Point explicit dirs at temp dir so mkdirSync doesn't touch real user dirs
  process.env.WHATSOUP_CONFIG_DIR = path.join(tmpDir, 'config');
  process.env.WHATSOUP_DATA_DIR = path.join(tmpDir, 'data');
  process.env.WHATSOUP_STATE_DIR = path.join(tmpDir, 'state');

  // Clear env vars that affect config defaults
  delete process.env.INSTANCE_CONFIG;
  delete process.env.CONVERSATION_MODEL;
  delete process.env.EXTRACTION_MODEL;
  delete process.env.VALIDATION_MODEL;
  delete process.env.FALLBACK_MODEL;
  delete process.env.PINECONE_INDEX;
  delete process.env.PINECONE_PROJECT_ID;
  delete process.env.PINECONE_EXPECTED_HOST_SUFFIX;
  delete process.env.MW_MIND_EMBED_URL;
  delete process.env.RECENCY_HALF_LIFE_DAYS;
  delete process.env.MAX_AGE_DAYS;
  delete process.env.LOG_LEVEL;
  delete process.env.WHATSOUP_GUI_PORT;
  // D-2: keep existing "apiTimeoutMs defaults to 30_000" tests deterministic
  // regardless of what the parent env has set for WHATSOUP_API_TIMEOUT_MS.
  delete process.env.WHATSOUP_API_TIMEOUT_MS;

  vi.resetModules();
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

function makeInstanceConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'profile-test',
    type: 'chat',
    systemPrompt: 'Profile test.',
    adminPhones: ['15550000001'],
    accessMode: 'allowlist',
    paths: {
      configRoot: path.join(tmpDir, 'inst-config'),
      dataRoot: path.join(tmpDir, 'inst-data'),
      stateRoot: path.join(tmpDir, 'inst-state'),
      authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
      dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
      logDir: path.join(tmpDir, 'inst-data', 'logs'),
      lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
      mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: No INSTANCE_CONFIG — built-in defaults (backward compat)
// ---------------------------------------------------------------------------

describe('config — no INSTANCE_CONFIG (backward compat)', () => {
  it('uses built-in defaults when INSTANCE_CONFIG is not set', async () => {
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');

    expect(config.botName).toBe('Loops');
    expect(config.maxTokens).toBe(750);
    expect(config.adminPhones).toBeInstanceOf(Set);
    expect(config.adminPhones.size).toBe(0);
    expect(config.models.conversation).toBe('claude-opus-4-6');
    expect(config.models.extraction).toBe('claude-sonnet-4-6');
    expect(config.models.validation).toBe('claude-haiku-4-5');
    expect(config.models.fallback).toBe('gpt-5.4');
    expect(config.systemPrompt).toContain('You are Loops');
    expect(config.rateLimitPerHour).toBe(45);
    expect(config.healthPort).toBe(9090);
    expect(config.gui).toBe(false);
    expect(config.guiPort).toBe(9099);
    expect(config.tokenBudget).toBe(100_000);
    expect(config.pineconeIndex).toBe('whatsapp-bot');
    expect(config.memory.pinecone.apiKeyEnv).toBe('PINECONE_API_KEY');
    expect(config.memory.pinecone.index).toBe('whatsapp-bot');
    expect(config.memory.pinecone.namespaces.facts).toBe('whatsapp-facts');
    expect(config.memory.pinecone.knowledgeProfiles['mw-mind'].namespaces).toContain('whatsapp-summaries');
    expect(config.logLevel).toBe('info');
  });

  it('preserves non-overridable constants', async () => {
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');

    expect(config.conversationWindow).toBe(50);
    expect(config.enrichmentIntervalMs).toBe(60_000);
    expect(config.apiTimeoutMs).toBe(30_000);
    expect(config.conversationWindowExtended).toBe(100);
  });

  it('env var overrides still work without INSTANCE_CONFIG', async () => {
    delete process.env.INSTANCE_CONFIG;
    process.env.CONVERSATION_MODEL = 'claude-test-model';
    process.env.PINECONE_INDEX = 'test-index';
    process.env.LOG_LEVEL = 'debug';

    const { config } = await import('../src/config.ts');
    expect(config.models.conversation).toBe('claude-test-model');
    expect(config.pineconeIndex).toBe('test-index');
    expect(config.logLevel).toBe('debug');
  });

  it('paths are derived from WHATSOUP_*_DIR env vars', async () => {
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');

    expect(config.configRoot).toBe(path.join(tmpDir, 'config'));
    expect(config.dataRoot).toBe(path.join(tmpDir, 'data'));
    expect(config.stateRoot).toBe(path.join(tmpDir, 'state'));
    expect(config.authDir).toBe(path.join(tmpDir, 'config', 'auth_info'));
    expect(config.dbPath).toBe(path.join(tmpDir, 'data', 'bot.db'));
    expect(config.logDir).toBe(path.join(tmpDir, 'data', 'logs'));
    expect(config.lockPath).toBe(path.join(tmpDir, 'state', 'bot.lock'));
    expect(config.mediaDir).toBe(path.join(tmpDir, 'data', 'media', 'tmp'));
  });
});

// ---------------------------------------------------------------------------
// Test 2: Full INSTANCE_CONFIG — all overridable fields overridden
// ---------------------------------------------------------------------------

describe('config — full INSTANCE_CONFIG override', () => {
  it('applies all overridable fields from INSTANCE_CONFIG', async () => {
    const instancePaths = {
      configRoot: path.join(tmpDir, 'inst-config'),
      dataRoot: path.join(tmpDir, 'inst-data'),
      stateRoot: path.join(tmpDir, 'inst-state'),
      authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
      dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
      logDir: path.join(tmpDir, 'inst-data', 'logs'),
      lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
      mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
    };
    const instanceConfig = {
      name: 'my-bot',
      type: 'chat',
      systemPrompt: 'You are my custom bot.',
      adminPhones: ['15550000001', '15550000002'],
      accessMode: 'allowlist',
      paths: instancePaths,
      models: {
        conversation: 'claude-custom-conv',
        extraction: 'claude-custom-ext',
        validation: 'claude-custom-val',
        fallback: 'gpt-custom',
      },
      maxTokens: 1000,
      rateLimitPerHour: 60,
      healthPort: 9999,
      tokenBudget: 200_000,
      pineconeIndex: 'custom-index',
      chatAliases: {
        ops: '15555550100@s.whatsapp.net',
        support: '120363001@g.us',
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);

    const { config } = await import('../src/config.ts');

    expect(config.botName).toBe('my-bot');
    expect(config.systemPrompt).toBe('You are my custom bot.');
    expect(config.adminPhones).toBeInstanceOf(Set);
    expect(config.adminPhones.has('15550000001')).toBe(true);
    expect(config.adminPhones.has('15550000002')).toBe(true);
    expect(config.adminPhones.size).toBe(2);
    expect(config.models.conversation).toBe('claude-custom-conv');
    expect(config.models.extraction).toBe('claude-custom-ext');
    expect(config.models.validation).toBe('claude-custom-val');
    expect(config.models.fallback).toBe('gpt-custom');
    expect(config.maxTokens).toBe(1000);
    expect(config.rateLimitPerHour).toBe(60);
    expect(config.healthPort).toBe(9999);
    expect(config.tokenBudget).toBe(200_000);
    expect(config.pineconeIndex).toBe('custom-index');
    expect(config.chatAliases).toEqual({
      ops: '15555550100@s.whatsapp.net',
      support: '120363001@g.us',
    });
    expect(config.configRoot).toBe(instancePaths.configRoot);
    expect(config.dataRoot).toBe(instancePaths.dataRoot);
    expect(config.stateRoot).toBe(instancePaths.stateRoot);
  });
});

describe('config — chatAliases validation', () => {
  it('trims aliases and rejects duplicate aliases after trimming', async () => {
    const instancePaths = {
      configRoot: path.join(tmpDir, 'inst-config'),
      dataRoot: path.join(tmpDir, 'inst-data'),
      stateRoot: path.join(tmpDir, 'inst-state'),
      authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
      dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
      logDir: path.join(tmpDir, 'inst-data', 'logs'),
      lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
      mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
    };
    const instanceConfig = {
      name: 'my-bot',
      type: 'chat',
      systemPrompt: 'You are my custom bot.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      paths: instancePaths,
      chatAliases: {
        ops: '15555550100@s.whatsapp.net',
        ' ops ': '15555550101@s.whatsapp.net',
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);

    await expect(import('../src/config.ts')).rejects.toThrow(/duplicate alias/i);
  });
});

describe('config — transport profiles', () => {
  it('preserves valid top-level profiles from INSTANCE_CONFIG', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      profiles: {
        satellite: {
          prefix: '[SAT] ',
          tag: ' #satellite',
          linkPreview: 'off',
        },
      },
    }));

    const { config } = await import('../src/config.ts');

    expect(config.profiles).toEqual({
      satellite: {
        prefix: '[SAT] ',
        tag: ' #satellite',
        linkPreview: 'off',
      },
    });
  });

  it('rejects unknown profile fields in INSTANCE_CONFIG', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      profiles: {
        satellite: {
          prefix: '[SAT] ',
          chunkSize: 1200,
        },
      },
    }));

    await expect(import('../src/config.ts')).rejects.toThrow(/profiles.*chunkSize|chunkSize.*profiles|unknown.*profile/i);
  });

  it('rejects invalid linkPreview profile policy values in INSTANCE_CONFIG', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      profiles: {
        satellite: {
          linkPreview: 'always',
        },
      },
    }));

    await expect(import('../src/config.ts')).rejects.toThrow(/linkPreview.*auto.*off/);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Partial models deep merge
// ---------------------------------------------------------------------------

describe('config — partial models deep merge', () => {
  it('overrides only specified model fields, keeps defaults for the rest', async () => {
    const instanceConfig = {
      name: 'partial-bot',
      type: 'chat',
      systemPrompt: 'Partial models test.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
        stateRoot: path.join(tmpDir, 'inst-state'),
        authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
        dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
        logDir: path.join(tmpDir, 'inst-data', 'logs'),
        lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
        mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
      },
      models: {
        conversation: 'claude-override-only',
        // extraction, validation, fallback NOT specified → should use defaults
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);

    const { config } = await import('../src/config.ts');

    expect(config.models.conversation).toBe('claude-override-only');
    expect(config.models.extraction).toBe('claude-sonnet-4-6');   // default
    expect(config.models.validation).toBe('claude-haiku-4-5'); // default
    expect(config.models.fallback).toBe('gpt-5.4');               // default
  });

  it('env vars fill model defaults when instance.models is not present', async () => {
    process.env.CONVERSATION_MODEL = 'claude-env-model';
    const instanceConfig = {
      name: 'env-model-bot',
      type: 'chat',
      systemPrompt: 'Env model test.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
        stateRoot: path.join(tmpDir, 'inst-state'),
        authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
        dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
        logDir: path.join(tmpDir, 'inst-data', 'logs'),
        lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
        mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
      },
      // No models field
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);

    const { config } = await import('../src/config.ts');

    // INSTANCE_CONFIG has no models, env var should be used
    expect(config.models.conversation).toBe('claude-env-model');
  });

  it('instance models take priority over env vars', async () => {
    process.env.CONVERSATION_MODEL = 'claude-env-model';
    const instanceConfig = {
      name: 'priority-bot',
      type: 'chat',
      systemPrompt: 'Priority test.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
        stateRoot: path.join(tmpDir, 'inst-state'),
        authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
        dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
        logDir: path.join(tmpDir, 'inst-data', 'logs'),
        lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
        mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
      },
      models: {
        conversation: 'claude-instance-wins',
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);

    const { config } = await import('../src/config.ts');

    expect(config.models.conversation).toBe('claude-instance-wins');
  });
});

// ---------------------------------------------------------------------------
// Test 4: adminPhones rehydration — string[] → Set<string>
// ---------------------------------------------------------------------------

describe('config — adminPhones rehydration', () => {
  it('rehydrates adminPhones from string[] to Set<string>', async () => {
    const instanceConfig = {
      name: 'admin-test',
      type: 'chat',
      systemPrompt: 'Admin test.',
      adminPhones: ['15550000001', '15550000002', '15550000003'],
      accessMode: 'allowlist',
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
        stateRoot: path.join(tmpDir, 'inst-state'),
        authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
        dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
        logDir: path.join(tmpDir, 'inst-data', 'logs'),
        lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
        mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);

    const { config } = await import('../src/config.ts');

    expect(config.adminPhones).toBeInstanceOf(Set);
    expect(config.adminPhones.size).toBe(3);
    expect(config.adminPhones.has('15550000001')).toBe(true);
    expect(config.adminPhones.has('15550000002')).toBe(true);
    expect(config.adminPhones.has('15550000003')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Instance paths used for directory fields
// ---------------------------------------------------------------------------

describe('config — instance paths', () => {
  it('uses instance paths for all path fields', async () => {
    const instCfgRoot = path.join(tmpDir, 'inst-config');
    const instDataRoot = path.join(tmpDir, 'inst-data');
    const instStateRoot = path.join(tmpDir, 'inst-state');

    const instanceConfig = {
      name: 'path-test',
      type: 'chat',
      systemPrompt: 'Path test.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      paths: {
        configRoot: instCfgRoot,
        dataRoot: instDataRoot,
        stateRoot: instStateRoot,
        authDir: path.join(instCfgRoot, 'auth_info'),
        dbPath: path.join(instDataRoot, 'bot.db'),
        logDir: path.join(instDataRoot, 'logs'),
        lockPath: path.join(instStateRoot, 'bot.lock'),
        mediaDir: path.join(instDataRoot, 'media', 'tmp'),
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);

    const { config } = await import('../src/config.ts');

    expect(config.configRoot).toBe(instCfgRoot);
    expect(config.dataRoot).toBe(instDataRoot);
    expect(config.stateRoot).toBe(instStateRoot);
    expect(config.authDir).toBe(path.join(instCfgRoot, 'auth_info'));
    expect(config.dbPath).toBe(path.join(instDataRoot, 'bot.db'));
    expect(config.logDir).toBe(path.join(instDataRoot, 'logs'));
    expect(config.lockPath).toBe(path.join(instStateRoot, 'bot.lock'));
    expect(config.mediaDir).toBe(path.join(instDataRoot, 'media', 'tmp'));
  });

  it('creates instance directories via mkdirSync', async () => {
    const instCfgRoot = path.join(tmpDir, 'inst-config');
    const instDataRoot = path.join(tmpDir, 'inst-data');
    const instStateRoot = path.join(tmpDir, 'inst-state');

    const instanceConfig = {
      name: 'mkdir-test',
      type: 'chat',
      systemPrompt: 'mkdir test.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      paths: {
        configRoot: instCfgRoot,
        dataRoot: instDataRoot,
        stateRoot: instStateRoot,
        authDir: path.join(instCfgRoot, 'auth_info'),
        dbPath: path.join(instDataRoot, 'bot.db'),
        logDir: path.join(instDataRoot, 'logs'),
        lockPath: path.join(instStateRoot, 'bot.lock'),
        mediaDir: path.join(instDataRoot, 'media', 'tmp'),
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);

    await import('../src/config.ts');

    expect(fs.existsSync(instCfgRoot)).toBe(true);
    expect(fs.existsSync(instDataRoot)).toBe(true);
    expect(fs.existsSync(instStateRoot)).toBe(true);
    expect(fs.existsSync(path.join(instDataRoot, 'logs'))).toBe(true);
    expect(fs.existsSync(path.join(instDataRoot, 'media', 'tmp'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Non-overridable constants unchanged
// ---------------------------------------------------------------------------

describe('config — non-overridable constants', () => {
  it('preserves constants with INSTANCE_CONFIG set', async () => {
    const instanceConfig = {
      name: 'const-test',
      type: 'chat',
      systemPrompt: 'Const test.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
        stateRoot: path.join(tmpDir, 'inst-state'),
        authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
        dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
        logDir: path.join(tmpDir, 'inst-data', 'logs'),
        lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
        mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);

    const { config } = await import('../src/config.ts');

    // These must never be overridden by instance config
    expect(config.conversationWindow).toBe(50);
    expect(config.conversationWindowExtended).toBe(100);
    expect(config.windowExtensionThresholdMs).toBe(10 * 60 * 1000);
    expect(config.rateLimitNoticeWindowMs).toBe(60 * 60 * 1000);
    expect(config.enrichmentIntervalMs).toBe(60_000);
    expect(config.enrichmentBatchSize).toBe(200);
    expect(config.enrichmentMinConfidence).toBe(0.7);
    expect(config.enrichmentDedupThreshold).toBe(0.95);
    expect(config.pineconeContextTopK).toBe(10);
    expect(config.pineconeSenderTopK).toBe(5);
    expect(config.pineconeSelfFactTopK).toBe(5);
    expect(config.apiTimeoutMs).toBe(30_000);
    expect(config.apiRetryDelayMs).toBe(2_000);
    expect(config.retentionDays).toBe(30);
    expect(config.enrichmentMaxRetries).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Entity-search config fields
// ---------------------------------------------------------------------------

describe('config — entity-search fields', () => {
  it('pineconeSearchMode defaults to "memory" when pineconeIndex is "whatsapp-bot"', async () => {
    delete process.env.PINECONE_INDEX;
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.pineconeIndex).toBe('whatsapp-bot');
    expect(config.pineconeSearchMode).toBe('memory');
  });

  it('pineconeSearchMode defaults to "entity" when PINECONE_INDEX is set to a non-default value', async () => {
    process.env.PINECONE_INDEX = 'crm-entities';
    const { config } = await import('../src/config.ts');
    expect(config.pineconeSearchMode).toBe('entity');
  });

  it('pineconeRerank defaults to false', async () => {
    delete process.env.PINECONE_INDEX;
    const { config } = await import('../src/config.ts');
    expect(config.pineconeRerank).toBe(false);
  });

  it('pineconeTopK defaults to 20', async () => {
    delete process.env.PINECONE_INDEX;
    const { config } = await import('../src/config.ts');
    expect(config.pineconeTopK).toBe(20);
  });

  it('pineconeRerankTopN defaults to 6', async () => {
    delete process.env.PINECONE_INDEX;
    const { config } = await import('../src/config.ts');
    expect(config.pineconeRerankTopN).toBe(6);
  });

  it('instance override: pineconeSearchMode can be forced to "entity"', async () => {
    const instanceConfig = {
      name: 'entity-bot',
      type: 'chat',
      systemPrompt: 'Entity bot.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      pineconeIndex: 'whatsapp-bot',
      pineconeSearchMode: 'entity',
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
        stateRoot: path.join(tmpDir, 'inst-state'),
        authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
        dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
        logDir: path.join(tmpDir, 'inst-data', 'logs'),
        lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
        mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);
    const { config } = await import('../src/config.ts');
    // Instance explicitly forces entity mode even though pineconeIndex is whatsapp-bot
    expect(config.pineconeSearchMode).toBe('entity');
  });

  it('instance override: pineconeRerank can be set to true', async () => {
    const instanceConfig = {
      name: 'rerank-bot',
      type: 'chat',
      systemPrompt: 'Rerank bot.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      pineconeRerank: true,
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
        stateRoot: path.join(tmpDir, 'inst-state'),
        authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
        dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
        logDir: path.join(tmpDir, 'inst-data', 'logs'),
        lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
        mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);
    const { config } = await import('../src/config.ts');
    expect(config.pineconeRerank).toBe(true);
  });

  it('instance override: pineconeTopK and pineconeRerankTopN can be set', async () => {
    const instanceConfig = {
      name: 'topk-bot',
      type: 'chat',
      systemPrompt: 'TopK bot.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      pineconeTopK: 30,
      pineconeRerankTopN: 10,
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
        stateRoot: path.join(tmpDir, 'inst-state'),
        authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
        dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
        logDir: path.join(tmpDir, 'inst-data', 'logs'),
        lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
        mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);
    const { config } = await import('../src/config.ts');
    expect(config.pineconeTopK).toBe(30);
    expect(config.pineconeRerankTopN).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Test 8: GUI config fields
// ---------------------------------------------------------------------------

describe('config — gui fields', () => {
  it('gui defaults to false without INSTANCE_CONFIG', async () => {
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.gui).toBe(false);
  });

  it('guiPort defaults to 9099 without INSTANCE_CONFIG', async () => {
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.guiPort).toBe(9099);
  });

  it('gui: true is accepted from instance config', async () => {
    const instanceConfig = {
      name: 'gui-bot',
      type: 'chat',
      systemPrompt: 'GUI bot.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      gui: true,
      guiPort: 8080,
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
        stateRoot: path.join(tmpDir, 'inst-state'),
        authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
        dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
        logDir: path.join(tmpDir, 'inst-data', 'logs'),
        lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
        mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);
    const { config } = await import('../src/config.ts');
    expect(config.gui).toBe(true);
    expect(config.guiPort).toBe(8080);
  });

  it('guiPort falls back to WHATSOUP_GUI_PORT env var', async () => {
    process.env.WHATSOUP_GUI_PORT = '7777';
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.guiPort).toBe(7777);
    delete process.env.WHATSOUP_GUI_PORT;
  });
});

// ---------------------------------------------------------------------------
// Test 9: P3.6 D-2 — WHATSOUP_API_TIMEOUT_MS env var override
// ---------------------------------------------------------------------------
// Before D-2, config.apiTimeoutMs was fixed at 30_000 and operators
// following the runbook's "raise apiTimeoutMs" recovery step needed a code
// edit to tune it. These tests lock the env-var fallback contract so the
// runbook recommendation becomes operator-actionable.
describe('config — apiTimeoutMs env-var override (P3.6 D-2)', () => {
  it('defaults to 30000 when WHATSOUP_API_TIMEOUT_MS is unset', async () => {
    delete process.env.WHATSOUP_API_TIMEOUT_MS;
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.apiTimeoutMs).toBe(30_000);
  });

  it('defaults to 30000 when WHATSOUP_API_TIMEOUT_MS is the empty string', async () => {
    // intEnv() treats whitespace / empty as unset and returns the fallback.
    process.env.WHATSOUP_API_TIMEOUT_MS = '';
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.apiTimeoutMs).toBe(30_000);
  });

  it('defaults to 30000 when WHATSOUP_API_TIMEOUT_MS is malformed ("abc")', async () => {
    // parseInt('abc', 10) → NaN → intEnv returns the fallback → 30_000.
    process.env.WHATSOUP_API_TIMEOUT_MS = 'abc';
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.apiTimeoutMs).toBe(30_000);
  });

  it('accepts a valid positive integer ("60000" → 60000)', async () => {
    // The documented recovery path for 72B models in the runbook.
    process.env.WHATSOUP_API_TIMEOUT_MS = '60000';
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.apiTimeoutMs).toBe(60_000);
  });

  it('falls back to 30000 for "0" (non-positive → invalid)', async () => {
    // Zero timeouts would mean "never wait" in Node's HTTP layer — safer to
    // coerce to the built-in default than to accept the nonsense.
    process.env.WHATSOUP_API_TIMEOUT_MS = '0';
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.apiTimeoutMs).toBe(30_000);
  });

  it('falls back to 30000 for "-5000" (negative → invalid)', async () => {
    process.env.WHATSOUP_API_TIMEOUT_MS = '-5000';
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.apiTimeoutMs).toBe(30_000);
  });
});

describe('config — BYOK memory block', () => {
  it('uses canonical memory.pinecone values before legacy aliases', async () => {
    const instanceConfig = {
      name: 'byok-bot',
      type: 'chat',
      systemPrompt: 'BYOK bot.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      pineconeIndex: 'legacy-index',
      memory: {
        conversation: { recent: 12, extended: 24, extendedWithinMs: 90_000 },
        retention: { days: 14 },
        enrichment: { intervalMs: 5_000, batchSize: 9, minConfidence: 0.6, dedupThreshold: 0.8, maxRetries: 7 },
        pinecone: {
          apiKeyEnv: 'PINECONE_TEAM_KEY',
          projectId: 'nf9hzvy',
          expectedHostSuffix: '-nf9hzvy.svc.aped-4627-b74a.pinecone.io',
          index: 'mw-mind',
          namespaces: {
            facts: 'team-facts',
            chunks: 'team-chunks',
            summaries: 'team-summaries',
          },
          allowedIndexes: ['mw-mind'],
          knowledgeSearch: { enabled: true, allowGlobalAgentSessions: true },
        },
      },
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
        stateRoot: path.join(tmpDir, 'inst-state'),
        authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
        dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
        logDir: path.join(tmpDir, 'inst-data', 'logs'),
        lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
        mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);

    const { config } = await import('../src/config.ts');

    expect(config.pineconeIndex).toBe('mw-mind');
    expect(config.memory.pinecone.apiKeyEnv).toBe('PINECONE_TEAM_KEY');
    expect(config.memory.pinecone.projectId).toBe('nf9hzvy');
    expect(config.memory.pinecone.expectedHostSuffix).toBe('-nf9hzvy.svc.aped-4627-b74a.pinecone.io');
    expect(config.memory.pinecone.namespaces.facts).toBe('team-facts');
    expect(config.memory.pinecone.namespaces.chunks).toBe('team-chunks');
    expect(config.memory.pinecone.namespaces.summaries).toBe('team-summaries');
    expect(config.pineconeAllowedIndexes).toEqual(['mw-mind']);
    expect(config.memory.pinecone.knowledgeSearch.allowGlobalAgentSessions).toBe(true);
    expect(config.conversationWindow).toBe(12);
    expect(config.conversationWindowExtended).toBe(24);
    expect(config.windowExtensionThresholdMs).toBe(90_000);
    expect(config.retentionDays).toBe(14);
    expect(config.enrichmentMaxRetries).toBe(7);
  });

  it('projects legacy flat fields into the canonical memory block at runtime', async () => {
    const instanceConfig = {
      name: 'legacy-bot',
      type: 'chat',
      systemPrompt: 'Legacy bot.',
      adminPhones: ['15550000001'],
      accessMode: 'allowlist',
      pineconeApiKeyEnv: 'PINECONE_LEGACY_KEY',
      pineconeProjectId: 'o6fsxb8',
      pineconeIndex: 'legacy-memory',
      pineconeAllowedIndexes: ['legacy-memory'],
      pineconeFactsNamespace: 'legacy-facts',
      pineconeSummariesNamespace: 'legacy-summaries',
      conversationWindow: 33,
      enrichmentBatchSize: 44,
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
        stateRoot: path.join(tmpDir, 'inst-state'),
        authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
        dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
        logDir: path.join(tmpDir, 'inst-data', 'logs'),
        lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
        mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);

    const { config } = await import('../src/config.ts');

    expect(config.memory.pinecone.apiKeyEnv).toBe('PINECONE_LEGACY_KEY');
    expect(config.memory.pinecone.projectId).toBe('o6fsxb8');
    expect(config.memory.pinecone.index).toBe('legacy-memory');
    expect(config.memory.pinecone.allowedIndexes).toEqual(['legacy-memory']);
    expect(config.memory.pinecone.namespaces.facts).toBe('legacy-facts');
    expect(config.memory.pinecone.namespaces.summaries).toBe('legacy-summaries');
    expect(config.conversationWindow).toBe(33);
    expect(config.enrichmentBatchSize).toBe(44);
  });
});

describe('config — memory recency env-var overrides', () => {
  it('defaults memory recency settings when env vars are unset', async () => {
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.recencyHalfLifeDays).toBe(14);
    expect(config.maxAgeDays).toBe(90);
  });

  it('accepts positive integer memory recency env vars', async () => {
    process.env.RECENCY_HALF_LIFE_DAYS = '21';
    process.env.MAX_AGE_DAYS = '180';
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.recencyHalfLifeDays).toBe(21);
    expect(config.maxAgeDays).toBe(180);
  });

  it('falls back for malformed or partial-numeric memory recency env vars', async () => {
    process.env.RECENCY_HALF_LIFE_DAYS = '14abc';
    process.env.MAX_AGE_DAYS = '1.5';
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.recencyHalfLifeDays).toBe(14);
    expect(config.maxAgeDays).toBe(90);
  });

  it('falls back for zero or negative memory recency env vars', async () => {
    process.env.RECENCY_HALF_LIFE_DAYS = '0';
    process.env.MAX_AGE_DAYS = '-30';
    delete process.env.INSTANCE_CONFIG;
    const { config } = await import('../src/config.ts');
    expect(config.recencyHalfLifeDays).toBe(14);
    expect(config.maxAgeDays).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Test 10: operationTracker config
// ---------------------------------------------------------------------------

describe('operationTracker config', () => {
  it('provides default operationTracker config when instance has none', async () => {
    const { config } = await import('../src/config.ts');
    expect(config.operationTracker).toBeDefined();
    expect(config.operationTracker.enabled).toBe(true);
    expect(config.operationTracker.progressIntervalMs).toBe(30_000);
    expect(config.operationTracker.thinkingLongMs).toBe(45_000);
    expect(config.operationTracker.thinkingStallMs).toBe(300_000);
    expect(config.operationTracker.toolThresholds).toBeDefined();
    expect(config.operationTracker.toolThresholds.agent).toEqual({
      expectedMs: 120_000, slowMultiplier: 1.5, stallMultiplier: 3,
    });
    expect(config.operationTracker.toolThresholds.default).toEqual({
      expectedMs: 10_000, slowMultiplier: 2, stallMultiplier: 5,
    });
  });
});
