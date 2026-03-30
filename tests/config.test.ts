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
    LOG_LEVEL: process.env.LOG_LEVEL,
    WHATSOUP_CONFIG_DIR: process.env.WHATSOUP_CONFIG_DIR,
    WHATSOUP_DATA_DIR: process.env.WHATSOUP_DATA_DIR,
    WHATSOUP_STATE_DIR: process.env.WHATSOUP_STATE_DIR,
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
  delete process.env.LOG_LEVEL;

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

// ---------------------------------------------------------------------------
// Test 1: No INSTANCE_CONFIG — hardcoded defaults (backward compat)
// ---------------------------------------------------------------------------

describe('config — no INSTANCE_CONFIG (backward compat)', () => {
  it('uses hardcoded defaults when INSTANCE_CONFIG is not set', async () => {
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
    expect(config.tokenBudget).toBe(100_000);
    expect(config.pineconeIndex).toBe('whatsapp-bot');
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
    expect(config.configRoot).toBe(instancePaths.configRoot);
    expect(config.dataRoot).toBe(instancePaths.dataRoot);
    expect(config.stateRoot).toBe(instancePaths.stateRoot);
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

  it('pineconeSearchMode defaults to "entity" when PINECONE_INDEX is set to a non-whatsapp-bot value', async () => {
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
