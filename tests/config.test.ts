import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { homedir as osHomedir } from 'node:os';
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
    KNOWLEDGE_EMBED_URL: process.env.KNOWLEDGE_EMBED_URL,
    MW_MIND_EMBED_URL: process.env.MW_MIND_EMBED_URL,
    RECENCY_HALF_LIFE_DAYS: process.env.RECENCY_HALF_LIFE_DAYS,
    MAX_AGE_DAYS: process.env.MAX_AGE_DAYS,
    LOG_LEVEL: process.env.LOG_LEVEL,
    WHATSOUP_CONFIG_DIR: process.env.WHATSOUP_CONFIG_DIR,
    WHATSOUP_DATA_DIR: process.env.WHATSOUP_DATA_DIR,
    WHATSOUP_STATE_DIR: process.env.WHATSOUP_STATE_DIR,
    WHATSOUP_GUI_PORT: process.env.WHATSOUP_GUI_PORT,
    WHATSOUP_OUTBOUND_IDENTITY_MODE: process.env.WHATSOUP_OUTBOUND_IDENTITY_MODE,
    TMPDIR: process.env.TMPDIR,
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
  delete process.env.KNOWLEDGE_EMBED_URL;
  delete process.env.MW_MIND_EMBED_URL;
  delete process.env.RECENCY_HALF_LIFE_DAYS;
  delete process.env.MAX_AGE_DAYS;
  delete process.env.LOG_LEVEL;
  delete process.env.WHATSOUP_GUI_PORT;
  delete process.env.WHATSOUP_OUTBOUND_IDENTITY_MODE;
  delete process.env.TMPDIR;
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

describe('config — outbound identity mode', () => {
  it('defaults to enforce when the environment variable is absent', async () => {
    const { config } = await import('../src/config.ts');
    expect(config.outboundIdentityMode).toBe('enforce');
  });

  it('preserves explicit log-only as the compatibility rollback', async () => {
    process.env.WHATSOUP_OUTBOUND_IDENTITY_MODE = 'log-only';
    const { config } = await import('../src/config.ts');
    expect(config.outboundIdentityMode).toBe('log-only');
  });

  it('rejects an invalid mode instead of silently disabling enforcement', async () => {
    process.env.WHATSOUP_OUTBOUND_IDENTITY_MODE = 'warn';
    await expect(import('../src/config.ts')).rejects.toThrow(
      /WHATSOUP_OUTBOUND_IDENTITY_MODE must be "enforce" or "log-only"/,
    );
  });
});

describe('config — INSTANCE_CONFIG validation', () => {
  it('rejects invalid INSTANCE_CONFIG JSON with parse context', async () => {
    process.env.INSTANCE_CONFIG = '{ not valid json';

    await expect(import('../src/config.ts')).rejects.toThrow(
      /INSTANCE_CONFIG contains invalid JSON:/,
    );
  });

  it('rejects INSTANCE_CONFIG without required root paths', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      paths: {
        configRoot: path.join(tmpDir, 'inst-config'),
        dataRoot: path.join(tmpDir, 'inst-data'),
      },
    }));

    await expect(import('../src/config.ts')).rejects.toThrow(
      /INSTANCE_CONFIG.*paths object/,
    );
  });
});

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
    expect(config.models.conversation).toBe('claude-opus-4-8');
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
    expect(config.toolUpdateRedirectJid).toBeNull();
    expect(config.textAggregateDelayMs).toBe(2_000);
    // Startup gates default to true (preserve pre-existing behavior).
    expect(config.startupNotifications).toBe(true);
    expect(config.proactiveResumeOnStartup).toBe(true);
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
    expect(config.tmpDir).toBe(path.join(tmpDir, 'data', 'tmp'));
    expect(process.env.TMPDIR).toBe(config.tmpDir);
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
      toolUpdateRedirectJid: 'status-log@g.us',
      textAggregateDelayMs: 30_000,
      startupNotifications: false,
      proactiveResumeOnStartup: false,
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
    expect(config.toolUpdateRedirectJid).toBe('status-log@g.us');
    expect(config.textAggregateDelayMs).toBe(30_000);
    expect(config.startupNotifications).toBe(false);
    expect(config.proactiveResumeOnStartup).toBe(false);
    expect(config.chatAliases).toEqual({
      ops: '15555550100@s.whatsapp.net',
      support: '120363001@g.us',
    });
    expect(config.configRoot).toBe(instancePaths.configRoot);
    expect(config.dataRoot).toBe(instancePaths.dataRoot);
    expect(config.stateRoot).toBe(instancePaths.stateRoot);
  });

  it('resolves transcriptionOptions.openaiProviderConfig for the shared Whisper client', async () => {
    const openaiProviderConfig = {
      baseUrl: 'https://transcribe.example.com/openai/v1',
      apiKeyService: 'groq',
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      transcriptionOptions: { openaiProviderConfig },
    }));

    const { config } = await import('../src/config.ts');

    expect(config.transcriptionOpenAIProviderConfig).toEqual(openaiProviderConfig);
  });
});

// ---------------------------------------------------------------------------
// Startup gates: startupNotifications + proactiveResumeOnStartup
// ---------------------------------------------------------------------------

describe('config — startup gates', () => {
  const makeMinimal = (overrides: Record<string, unknown>) => ({
    name: 'gate-bot',
    type: 'agent',
    paths: {
      configRoot: path.join(tmpDir, 'g-config'),
      dataRoot: path.join(tmpDir, 'g-data'),
      stateRoot: path.join(tmpDir, 'g-state'),
      authDir: path.join(tmpDir, 'g-config', 'auth_info'),
      dbPath: path.join(tmpDir, 'g-data', 'bot.db'),
      logDir: path.join(tmpDir, 'g-data', 'logs'),
      lockPath: path.join(tmpDir, 'g-state', 'bot.lock'),
      mediaDir: path.join(tmpDir, 'g-data', 'media', 'tmp'),
    },
    ...overrides,
  });

  it('each gate is independently overridable', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeMinimal({ startupNotifications: false, proactiveResumeOnStartup: true }),
    );
    const { config } = await import('../src/config.ts');
    expect(config.startupNotifications).toBe(false);
    expect(config.proactiveResumeOnStartup).toBe(true);
  });

  it('omitted gates fall back to true even when other fields are set', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeMinimal({ proactiveResumeOnStartup: false }),
    );
    const { config } = await import('../src/config.ts');
    // startupNotifications omitted → default true; proactiveResumeOnStartup explicit false.
    expect(config.startupNotifications).toBe(true);
    expect(config.proactiveResumeOnStartup).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C5 restart-loop guard knobs (src/runtimes/agent/restart-loop-guard.ts)
// ---------------------------------------------------------------------------

describe('config — restartLoopGuard', () => {
  const makeMinimal = (overrides: Record<string, unknown>) => ({
    name: 'guard-bot',
    type: 'agent',
    paths: {
      configRoot: path.join(tmpDir, 'rlg-config'),
      dataRoot: path.join(tmpDir, 'rlg-data'),
      stateRoot: path.join(tmpDir, 'rlg-state'),
      authDir: path.join(tmpDir, 'rlg-config', 'auth_info'),
      dbPath: path.join(tmpDir, 'rlg-data', 'bot.db'),
      logDir: path.join(tmpDir, 'rlg-data', 'logs'),
      lockPath: path.join(tmpDir, 'rlg-state', 'bot.lock'),
      mediaDir: path.join(tmpDir, 'rlg-data', 'media', 'tmp'),
    },
    ...overrides,
  });

  it('defaults to enabled with the spec thresholds (3 crashy boots / 300s)', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeMinimal({}));
    const { config } = await import('../src/config.ts');
    expect(config.restartLoopGuard).toEqual({ enabled: true, maxRestarts: 3, windowMs: 300_000 });
  });

  it('honors instance.json overrides', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeMinimal({ restartLoopGuard: { enabled: false, maxRestarts: 5, windowMs: 60_000 } }),
    );
    const { config } = await import('../src/config.ts');
    expect(config.restartLoopGuard).toEqual({ enabled: false, maxRestarts: 5, windowMs: 60_000 });
  });

  it('falls back to defaults for non-positive numbers', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeMinimal({ restartLoopGuard: { maxRestarts: 0, windowMs: -1 } }),
    );
    const { config } = await import('../src/config.ts');
    expect(config.restartLoopGuard.maxRestarts).toBe(3);
    expect(config.restartLoopGuard.windowMs).toBe(300_000);
  });

  it('non-boolean gate values fall back to the default (true)', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      makeMinimal({ startupNotifications: 'nope', proactiveResumeOnStartup: 0 }),
    );
    const { config } = await import('../src/config.ts');
    expect(config.startupNotifications).toBe(true);
    expect(config.proactiveResumeOnStartup).toBe(true);
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
// Substrate memory config — tilde expansion and defaults
// ---------------------------------------------------------------------------

describe('config — memory section (substrate slice 1)', () => {
  it('expands leading ~/ in vaultPath to $HOME', async () => {
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
      name: 'mem-test', type: 'chat',
      adminPhones: ['15550100001'],
      accessMode: 'allowlist', paths: instancePaths,
      memory: {
        vaultPath: '~/Documents/Obsidian/test-vault',
      },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);
    const { config } = await import('../src/config.ts');

    expect(config.memory.vaultPath.startsWith('~')).toBe(false);
    expect(config.memory.vaultPath).toBe(`${process.env.HOME}/Documents/Obsidian/test-vault`);
  });

  it('defaults apply when memory is absent from instance.json', async () => {
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
      name: 'mem-default', type: 'chat',
      adminPhones: ['15550100001'],
      accessMode: 'allowlist', paths: instancePaths,
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);
    const { config } = await import('../src/config.ts');

    expect(config.memory.observationConfidenceMin).toBe(0.4);
    expect(config.memory.sweep.beadProposeMin).toBe(0.55);
    expect(config.memory.sweep.beadUpdateMin).toBe(0.8);
    expect(config.memory.sweep.reviewByDays).toBe(7);
    expect(config.memory.sweep.overdueProposalAlertThreshold).toBe(10);
    expect(config.memory.watchTtl.defaultHours).toBe(24);
    expect(config.memory.watchTtl.maxHours).toBe(72);
    expect(config.memory.vaultPath.startsWith('/')).toBe(true);
  });

  it('defaults memory consolidation to disabled dry-run', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({}));
    const { config } = await import('../src/config.ts');

    expect(config.memory.consolidation).toEqual({
      enabled: false,
      intervalHours: 24,
      lookbackDays: 14,
      dryRun: true,
    });
  });

  it('reads memory consolidation overrides', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      memory: {
        consolidation: {
          enabled: true,
          intervalHours: 12,
          lookbackDays: 21,
          dryRun: false,
        },
      },
    }));
    const { config } = await import('../src/config.ts');

    expect(config.memory.consolidation).toEqual({
      enabled: true,
      intervalHours: 12,
      lookbackDays: 21,
      dryRun: false,
    });
  });

  it('disables memory consolidation when schedule values are non-positive', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      memory: {
        consolidation: {
          enabled: true,
          intervalHours: 0,
          lookbackDays: -7,
        },
      },
    }));
    const { config } = await import('../src/config.ts');

    expect(config.memory.consolidation).toEqual({
      enabled: false,
      intervalHours: 24,
      lookbackDays: 14,
      dryRun: true,
    });
  });

  it('disables memory consolidation when schedule values are out of bounds', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      memory: {
        consolidation: {
          enabled: true,
          intervalHours: 0.000001,
          lookbackDays: 3650,
        },
      },
    }));
    const { config } = await import('../src/config.ts');

    expect(config.memory.consolidation).toEqual({
      enabled: false,
      intervalHours: 24,
      lookbackDays: 14,
      dryRun: true,
    });
  });

  it('accepts absolute vaultPath unchanged', async () => {
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
      name: 'abs', type: 'chat',
      adminPhones: ['15550100001'],
      accessMode: 'allowlist', paths: instancePaths,
      memory: { vaultPath: '/tmp/some/absolute/vault' },
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig);
    const { config } = await import('../src/config.ts');
    expect(config.memory.vaultPath).toBe('/tmp/some/absolute/vault');
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
    expect(config.tmpDir).toBe(path.join(instDataRoot, 'tmp'));
    expect(process.env.TMPDIR).toBe(config.tmpDir);
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
          embedUrl: 'http://127.0.0.1:9901/embed',
          knowledgeProfiles: {
            'mw-mind': { namespace: '', namespaces: [], searchMode: 'vector' },
          },
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
    expect(config.memory.pinecone.embedUrl).toBe('http://127.0.0.1:9901/embed');
    expect(config.memory.pinecone.knowledgeProfiles['mw-mind'].embedUrl).toBe('http://127.0.0.1:9901/embed');
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

  it('uses KNOWLEDGE_EMBED_URL before the deprecated MW_MIND_EMBED_URL alias', async () => {
    delete process.env.INSTANCE_CONFIG;
    process.env.KNOWLEDGE_EMBED_URL = 'http://127.0.0.1:9910/embed';
    process.env.MW_MIND_EMBED_URL = 'http://127.0.0.1:9920/embed';

    const { config } = await import('../src/config.ts');

    expect(config.memory.pinecone.embedUrl).toBe('http://127.0.0.1:9910/embed');
    expect(config.memory.pinecone.knowledgeProfiles['mw-mind'].embedUrl).toBe('http://127.0.0.1:9910/embed');
  });

  it('keeps MW_MIND_EMBED_URL as a deprecated compatibility alias', async () => {
    delete process.env.INSTANCE_CONFIG;
    process.env.MW_MIND_EMBED_URL = 'http://127.0.0.1:9920/embed';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { config } = await import('../src/config.ts');

      expect(config.memory.pinecone.embedUrl).toBe('http://127.0.0.1:9920/embed');
      expect(config.memory.pinecone.knowledgeProfiles['mw-mind'].embedUrl).toBe('http://127.0.0.1:9920/embed');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('config — memory env alias warnings', () => {
  it('warns when MW_MIND_EMBED_URL is used without a canonical value', async () => {
    delete process.env.INSTANCE_CONFIG;
    delete process.env.KNOWLEDGE_EMBED_URL;
    process.env.MW_MIND_EMBED_URL = 'http://127.0.0.1:9920/embed';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { resolveMemoryConfig } = await import('../src/config.ts');
      resolveMemoryConfig(null);

      expect(warnSpy.mock.calls).toContainEqual([
        expect.objectContaining({
          alias: 'MW_MIND_EMBED_URL',
          canonical: 'memory.pinecone.embedUrl or KNOWLEDGE_EMBED_URL',
          expires: '2026-10-26',
        }),
        'memory.pinecone.embedUrl is using a deprecated environment alias',
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn for MW_MIND_EMBED_URL when a canonical env value is present', async () => {
    delete process.env.INSTANCE_CONFIG;
    process.env.KNOWLEDGE_EMBED_URL = 'http://127.0.0.1:9910/embed';
    process.env.MW_MIND_EMBED_URL = 'http://127.0.0.1:9920/embed';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { resolveMemoryConfig } = await import('../src/config.ts');
      resolveMemoryConfig(null);

      expect(warnSpy.mock.calls).not.toContainEqual([
        expect.objectContaining({ alias: 'MW_MIND_EMBED_URL' }),
        expect.any(String),
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns when allowedIndexes references a built-in profile that is not declared', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { resolveMemoryConfig } = await import('../src/config.ts');
      resolveMemoryConfig({
        memory: {
          pinecone: {
            allowedIndexes: ['mw-mind'],
            knowledgeProfiles: {},
          },
        },
      });

      expect(warnSpy.mock.calls).toContainEqual([
        expect.objectContaining({
          profile: 'mw-mind',
          expires: '2026-10-26',
        }),
        'memory.pinecone.allowedIndexes references a built-in profile that is not declared in knowledgeProfiles',
      ]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when knowledgeProfiles declares the allowed built-in profile', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { resolveMemoryConfig } = await import('../src/config.ts');
      resolveMemoryConfig({
        memory: {
          pinecone: {
            allowedIndexes: ['mw-mind'],
            knowledgeProfiles: {
              'mw-mind': { namespace: '', namespaces: [], searchMode: 'vector' },
            },
          },
        },
      });

      expect(warnSpy.mock.calls).not.toContainEqual([
        expect.objectContaining({ profile: 'mw-mind' }),
        expect.any(String),
      ]);
    } finally {
      warnSpy.mockRestore();
    }
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

describe('config — outbound queue controls', () => {
  it('ignores non-positive streaming aggregation overrides', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      textAggregateDelayMs: 0,
    }));

    const { config } = await import('../src/config.ts');

    expect(config.textAggregateDelayMs).toBe(2_000);
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
    expect(config.operationTracker.progressPlaceholderRateLimitMs).toBe(180_000);
    expect(config.operationTracker.toolThresholds).toBeDefined();
    expect(config.operationTracker.toolThresholds.agent).toEqual({
      expectedMs: 120_000, slowMultiplier: 1.5, stallMultiplier: 3,
    });
    expect(config.operationTracker.toolThresholds.default).toEqual({
      expectedMs: 10_000, slowMultiplier: 2, stallMultiplier: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// expandTilde: standalone ~ and HOME fallback
// ---------------------------------------------------------------------------

describe('config — expandTilde edge cases', () => {
  it('expands standalone ~ to HOME when vaultPath is exactly "~"', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      memory: { vaultPath: '~' },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.memory.vaultPath).toBe(process.env.HOME);
  });
});

// ---------------------------------------------------------------------------
// stringRecordProp: error paths (null value, empty key, non-string value,
// empty string value, duplicate key after trim)
// ---------------------------------------------------------------------------

describe('config — stringRecordProp validation', () => {
  it('rejects chatAliases when a value is a non-string (number)', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      chatAliases: { ops: 42 },
    }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /chatAliases must be an object of non-empty string values/,
    );
  });

  it('rejects chatAliases when a value is an empty string', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      chatAliases: { ops: '' },
    }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /chatAliases must be an object of non-empty string values/,
    );
  });

  it('rejects chatAliases when the key is empty after trimming', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      chatAliases: { '   ': 'some-jid@s.whatsapp.net' },
    }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /chatAliases must be an object of non-empty string values/,
    );
  });

  it('rejects chatAliases when the entire value is not an object', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      chatAliases: 'not-an-object',
    }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /chatAliases must be an object of non-empty string values/,
    );
  });
});

// ---------------------------------------------------------------------------
// profileRecordProp: additional error paths
// ---------------------------------------------------------------------------

describe('config — profileRecordProp error paths', () => {
  it('rejects profiles when a profile name is empty after trimming', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      profiles: {
        '   ': { prefix: 'x' },
      },
    }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /profiles.*empty profile names|must not contain empty profile names/i,
    );
  });

  it('rejects profiles when a profile value is not an object', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      profiles: {
        bot: 'string-not-object',
      },
    }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /profiles.*must be an object/i,
    );
  });

  it('rejects profile prefix that is not a string', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      profiles: {
        bot: { prefix: 123 },
      },
    }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /prefix must be a string/i,
    );
  });

  it('rejects profile tag that is not a string', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      profiles: {
        bot: { tag: true },
      },
    }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /tag must be a string/i,
    );
  });

  it('accepts profile with only a tag (no prefix)', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      profiles: {
        tagsonly: { tag: ' #tag' },
      },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.profiles).toEqual({ tagsonly: { tag: ' #tag' } });
  });

  it('accepts profile with linkPreview: "auto"', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      profiles: {
        autobot: { linkPreview: 'auto' },
      },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.profiles).toEqual({ autobot: { linkPreview: 'auto' } });
  });
});

// ---------------------------------------------------------------------------
// mergeToolThresholds: null, array, partial field overrides, unknown tool key
// ---------------------------------------------------------------------------

describe('config — mergeToolThresholds edge cases', () => {
  it('handles null operationTracker.toolThresholds — uses defaults', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      operationTracker: { toolThresholds: null },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.operationTracker.toolThresholds.agent).toEqual({
      expectedMs: 120_000, slowMultiplier: 1.5, stallMultiplier: 3,
    });
    expect(config.operationTracker.toolThresholds.bash).toEqual({
      expectedMs: 15_000, slowMultiplier: 2, stallMultiplier: 5,
    });
  });

  it('handles array operationTracker.toolThresholds — uses defaults', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      operationTracker: { toolThresholds: [{ expectedMs: 999 }] },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.operationTracker.toolThresholds.agent).toEqual({
      expectedMs: 120_000, slowMultiplier: 1.5, stallMultiplier: 3,
    });
  });

  it('merges partial tool threshold overrides with defaults', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      operationTracker: {
        toolThresholds: {
          bash: { expectedMs: 30_000 },
        },
      },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.operationTracker.toolThresholds.bash).toEqual({
      expectedMs: 30_000,
      slowMultiplier: 2,
      stallMultiplier: 5,
    });
  });

  it('adds a new unknown tool using default base thresholds', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      operationTracker: {
        toolThresholds: {
          custom_tool: { expectedMs: 5_000, slowMultiplier: 3, stallMultiplier: 8 },
        },
      },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.operationTracker.toolThresholds['custom_tool']).toEqual({
      expectedMs: 5_000,
      slowMultiplier: 3,
      stallMultiplier: 8,
    });
  });

  it('skips null values inside toolThresholds object', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      operationTracker: {
        toolThresholds: {
          bash: null,
        },
      },
    }));
    const { config } = await import('../src/config.ts');
    // null override is skipped, bash retains defaults
    expect(config.operationTracker.toolThresholds.bash).toEqual({
      expectedMs: 15_000, slowMultiplier: 2, stallMultiplier: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// rateLimitWindowMs: instance has rateLimitWindowMs or only rateLimitNoticeWindowMs
// ---------------------------------------------------------------------------

describe('config — rateLimitWindowMs migration (SP6)', () => {
  it('uses rateLimitWindowMs from instance when explicitly set', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      rateLimitWindowMs: 1_800_000,
    }));
    const { config } = await import('../src/config.ts');
    expect(config.rateLimitWindowMs).toBe(1_800_000);
  });

  it('falls back to rateLimitNoticeWindowMs with deprecation warning when rateLimitWindowMs is absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
        rateLimitNoticeWindowMs: 900_000,
      }));
      const { config } = await import('../src/config.ts');
      expect(config.rateLimitWindowMs).toBe(900_000);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('DEPRECATION'),
        900_000,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('defaults rateLimitWindowMs to 1 hour when neither field is set', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({}));
    const { config } = await import('../src/config.ts');
    expect(config.rateLimitWindowMs).toBe(60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// resolvePineconeNamespaces: non-string values are skipped
// ---------------------------------------------------------------------------

describe('config — resolvePineconeNamespaces edge cases', () => {
  it('skips non-string namespace overrides, keeps defaults', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      memory: {
        pinecone: {
          namespaces: {
            facts: 42,
            chunks: null,
            summaries: 'custom-summaries',
          },
        },
      },
    }));
    const { config } = await import('../src/config.ts');
    // non-string values are skipped; defaults apply for facts + chunks
    expect(config.memory.pinecone.namespaces.facts).toBe('whatsapp-facts');
    expect(config.memory.pinecone.namespaces.chunks).toBe('whatsapp-chunks');
    expect(config.memory.pinecone.namespaces.summaries).toBe('custom-summaries');
  });

  it('skips empty-string namespace overrides, keeps defaults', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      memory: {
        pinecone: {
          namespaces: {
            facts: '',
            summaries: 'my-summaries',
          },
        },
      },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.memory.pinecone.namespaces.facts).toBe('whatsapp-facts');
    expect(config.memory.pinecone.namespaces.summaries).toBe('my-summaries');
  });
});

// ---------------------------------------------------------------------------
// pineconeSearchMode: invalid value falls back to default
// ---------------------------------------------------------------------------

describe('config — pineconeSearchMode invalid value fallback', () => {
  it('falls back to default searchMode when an invalid value is provided', async () => {
    const { resolveMemoryConfig } = await import('../src/config.ts');
    const result = resolveMemoryConfig({
      memory: {
        pinecone: {
          index: 'whatsapp-bot',
          searchMode: 'invalid-mode',
        },
      },
    });
    // default index → default mode 'memory'
    expect(result.pinecone.searchMode).toBe('memory');
  });
});

// ---------------------------------------------------------------------------
// mergeKnowledgeProfiles: non-object profile value skipped, new custom profile
// ---------------------------------------------------------------------------

describe('config — mergeKnowledgeProfiles edge cases', () => {
  it('skips non-object knowledge profile values', async () => {
    const { resolveMemoryConfig } = await import('../src/config.ts');
    const result = resolveMemoryConfig({
      memory: {
        pinecone: {
          knowledgeProfiles: {
            'bad-profile': 'not-an-object',
          },
        },
      },
    });
    // non-object profile is skipped; bad-profile is not present
    expect(result.pinecone.knowledgeProfiles['bad-profile']).toBeUndefined();
    // built-ins still present
    expect(result.pinecone.knowledgeProfiles['mw-mind'].searchMode).toBe('vector');
  });

  it('creates a new custom knowledge profile from scratch', async () => {
    const { resolveMemoryConfig } = await import('../src/config.ts');
    const result = resolveMemoryConfig({
      memory: {
        pinecone: {
          knowledgeProfiles: {
            'my-custom-index': {
              namespace: 'my-ns',
              namespaces: ['ns-a', 'ns-b'],
              searchMode: 'text',
              rerank: true,
              topK: 15,
              rerankTopN: 4,
              description: 'My custom index',
            },
          },
        },
      },
    });
    const profile = result.pinecone.knowledgeProfiles['my-custom-index'];
    expect(profile).toBeDefined();
    expect(profile.namespace).toBe('my-ns');
    expect(profile.namespaces).toEqual(['ns-a', 'ns-b']);
    expect(profile.searchMode).toBe('text');
    expect(profile.rerank).toBe(true);
    expect(profile.topK).toBe(15);
    expect(profile.rerankTopN).toBe(4);
    expect(profile.description).toBe('My custom index');
  });

  it('merges override namespaces into existing profile (non-empty replaces base)', async () => {
    const { resolveMemoryConfig } = await import('../src/config.ts');
    const result = resolveMemoryConfig({
      memory: {
        pinecone: {
          knowledgeProfiles: {
            'mw-mind': {
              namespaces: ['override-ns-1', 'override-ns-2'],
            },
          },
        },
      },
    });
    expect(result.pinecone.knowledgeProfiles['mw-mind'].namespaces).toEqual([
      'override-ns-1',
      'override-ns-2',
    ]);
  });

  it('falls back to base namespaces when override namespaces is empty', async () => {
    const { resolveMemoryConfig } = await import('../src/config.ts');
    const result = resolveMemoryConfig({
      memory: {
        pinecone: {
          knowledgeProfiles: {
            'mw-mind': {
              namespaces: [],
            },
          },
        },
      },
    });
    // empty override → base namespaces retained
    expect(result.pinecone.knowledgeProfiles['mw-mind'].namespaces.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// resolveTwilioSmsConfig: various branches
// ---------------------------------------------------------------------------

describe('config — resolveTwilioSmsConfig', () => {
  it('returns undefined when rawSource is null', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    expect(resolveTwilioSmsConfig(null)).toBeUndefined();
  });

  it('returns undefined when rawSource is undefined', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    expect(resolveTwilioSmsConfig(undefined)).toBeUndefined();
  });

  it('returns undefined when rawSource lacks account field', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    expect(resolveTwilioSmsConfig({ accountSid: 'AC123' })).toBeUndefined();
  });

  it('returns config with defaults when minimal valid rawSource provided', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({ account: 'ml-bot' });
    expect(result).not.toBeUndefined();
    expect(result!.account).toBe('ml-bot');
    expect(result!.accountSid).toBe('');
    expect(result!.authTokenService).toBe('');
    expect(result!.inboundMode).toBe('poll');
    expect(result!.pollIntervalMs).toBe(15000);
    expect(result!.rateLimit.smsPerMinute).toBe(30);
    expect(result!.phoneNumber).toBeUndefined();
    expect(result!.messagingServiceSid).toBeUndefined();
    expect(result!.webhook).toBeUndefined();
    expect(result!.voice).toBeUndefined();
    expect(result!.inboundMode).toBe('poll');
  });

  it('applies explicit inboundMode: webhook', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({ account: 'ml-bot', inboundMode: 'webhook' });
    expect(result!.inboundMode).toBe('webhook');
  });

  it('falls back to default inboundMode when invalid value given', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({ account: 'ml-bot', inboundMode: 'fax' });
    expect(result!.inboundMode).toBe('poll');
  });

  it('sets phoneNumber when provided', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({ account: 'ml-bot', phoneNumber: '+15551230001' });
    expect(result!.phoneNumber).toBe('+15551230001');
  });

  it('sets messagingServiceSid when provided', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'ml-bot',
      messagingServiceSid: 'MGabc123',
    });
    expect(result!.messagingServiceSid).toBe('MGabc123');
  });

  it('resolves webhook block and strips trailing slash from publicBaseUrl', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'ml-bot',
      webhook: {
        publicBaseUrl: 'https://example.ngrok.app/',
        listenPort: 5080,
        listenAddress: '0.0.0.0',
      },
    });
    expect(result!.webhook).toEqual({
      publicBaseUrl: 'https://example.ngrok.app',
      listenPort: 5080,
      listenAddress: '0.0.0.0',
    });
  });

  it('resolves webhook block without trailing slash — publicBaseUrl unchanged', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'ml-bot',
      webhook: {
        publicBaseUrl: 'https://example.ngrok.app',
        listenPort: 5080,
      },
    });
    expect(result!.webhook!.publicBaseUrl).toBe('https://example.ngrok.app');
  });

  it('resolves webhook block without listenAddress — field absent from result', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'ml-bot',
      webhook: { publicBaseUrl: 'https://example.ngrok.app', listenPort: 5080 },
    });
    expect(result!.webhook).toBeDefined();
    expect('listenAddress' in result!.webhook!).toBe(false);
  });

  it('resolves voice block with explicit enabled: true', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'ml-bot',
      voice: { enabled: true, voicemailMaxLengthSec: 90, voicemailGreeting: 'Hi there!' },
    });
    expect(result!.voice).toEqual({
      enabled: true,
      voicemailMaxLengthSec: 90,
      voicemailGreeting: 'Hi there!',
    });
  });

  it('resolves voice block with non-boolean enabled — falls back to default (false)', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'ml-bot',
      voice: { enabled: 'yes', voicemailMaxLengthSec: 60 },
    });
    expect(result!.voice!.enabled).toBe(false);
    expect(result!.voice!.voicemailMaxLengthSec).toBe(60);
  });

  it('resolves voice block without voicemailGreeting — field absent', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'ml-bot',
      voice: { enabled: false },
    });
    expect(result!.voice).toBeDefined();
    expect('voicemailGreeting' in result!.voice!).toBe(false);
  });

  it('resolves rateLimit.smsPerMinute override', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'ml-bot',
      rateLimit: { smsPerMinute: 60 },
    });
    expect(result!.rateLimit.smsPerMinute).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// transport + twilioConfig wiring
// ---------------------------------------------------------------------------

describe('config — transport + twilioConfig', () => {
  it('resolves twilioConfig when transport is twilio and twilioConfig is present', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      transport: 'twilio',
      twilioConfig: {
        account: 'ml-bot',
        accountSid: 'ACabc123',
        authTokenService: 'whatsoup-twilio-ml-bot',
        phoneNumber: '+15551230001',
      },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.transport).toBe('twilio');
    expect(config.twilioConfig).toBeDefined();
    expect(config.twilioConfig!.account).toBe('ml-bot');
    expect(config.twilioConfig!.accountSid).toBe('ACabc123');
    expect(config.twilioConfig!.phoneNumber).toBe('+15551230001');
  });

  it('leaves twilioConfig undefined when transport is baileys even if twilioConfig is present', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      transport: 'baileys',
      twilioConfig: { account: 'ml-bot' },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.transport).toBe('baileys');
    expect(config.twilioConfig).toBeUndefined();
    expect(config.botName).toBe('profile-test');
  });

  it('defaults transport to baileys when not specified', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({}));
    const { config } = await import('../src/config.ts');
    expect(config.transport).toBe('baileys');
    expect(config.twilioConfig).toBeUndefined();
    expect(config.botName).toBe('profile-test');
  });

  it('falls back to default transport when instance.transport is invalid', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      transport: 'smoke-signals',
    }));
    const { config } = await import('../src/config.ts');
    expect(config.transport).toBe('baileys');
  });
});

// ---------------------------------------------------------------------------
// siblingPhones, pausedChats, echoGuard
// ---------------------------------------------------------------------------

describe('config — siblingPhones, pausedChats, echoGuard', () => {
  it('populates siblingPhones from instance config', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      siblingPhones: ['+15550000099'],
    }));
    const { config } = await import('../src/config.ts');
    // normalizePhoneE164('+15550000099') strips leading +
    expect(config.siblingPhones.size).toBe(1);
    expect(config.siblingPhones.has('15550000099')).toBe(true);
  });

  it('filters blank strings from siblingPhones', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      siblingPhones: ['+15550000099', '', '   '],
    }));
    const { config } = await import('../src/config.ts');
    expect(config.siblingPhones.size).toBe(1);
    expect(config.siblingPhones.has('15550000099')).toBe(true);
  });

  it('defaults siblingPhones to empty set when field is absent', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({}));
    const { config } = await import('../src/config.ts');
    expect(config.siblingPhones.size).toBe(0);
    expect(config.siblingPhones.has('15550000001')).toBe(false);
  });

  it('defaults siblingPhones to empty set when field is not an array', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      siblingPhones: 'not-an-array',
    }));
    const { config } = await import('../src/config.ts');
    expect(config.siblingPhones.size).toBe(0);
    expect(config.siblingPhones.has('15550000001')).toBe(false);
  });

  it('populates pausedChats from instance config', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      pausedChats: ['111111100000000002@g.us', 'abc@s.whatsapp.net'],
    }));
    const { config } = await import('../src/config.ts');
    expect(config.pausedChats.has('111111100000000002@g.us')).toBe(true);
    expect(config.pausedChats.has('abc@s.whatsapp.net')).toBe(true);
    expect(config.pausedChats.size).toBe(2);
  });

  it('filters blank strings from pausedChats', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      pausedChats: ['111111100000000002@g.us', '', '  '],
    }));
    const { config } = await import('../src/config.ts');
    expect(config.pausedChats.size).toBe(1);
    expect(config.pausedChats.has('111111100000000002@g.us')).toBe(true);
  });

  it('defaults pausedChats to empty set when field is not an array', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      pausedChats: null,
    }));
    const { config } = await import('../src/config.ts');
    expect(config.pausedChats.size).toBe(0);
    expect(config.pausedChats.has('111111100000000002@g.us')).toBe(false);
  });

  it('populates pausedChatBypassPatterns from instance config', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      pausedChatBypassPatterns: ['-> Q', 'escalate to owner'],
    }));
    const { config } = await import('../src/config.ts');
    expect(config.pausedChatBypassPatterns).toEqual(['-> Q', 'escalate to owner']);
  });

  it('filters blank and non-string entries from pausedChatBypassPatterns', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      pausedChatBypassPatterns: ['-> Q', '', '  ', 42],
    }));
    const { config } = await import('../src/config.ts');
    expect(config.pausedChatBypassPatterns).toEqual(['-> Q']);
  });

  it('defaults pausedChatBypassPatterns to empty array when field is absent or not an array', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      pausedChatBypassPatterns: 'not-an-array',
    }));
    const { config } = await import('../src/config.ts');
    expect(config.pausedChatBypassPatterns).toEqual([]);
  });

  it('echoGuard defaults to enabled with 1000ms cooldown', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({}));
    const { config } = await import('../src/config.ts');
    expect(config.echoGuard.enabled).toBe(true);
    expect(config.echoGuard.groupCooldownMs).toBe(1_000);
  });

  it('echoGuard can be explicitly disabled', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      echoGuard: { enabled: false, groupCooldownMs: 500 },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.echoGuard.enabled).toBe(false);
    expect(config.echoGuard.groupCooldownMs).toBe(500);
  });

  it('echoGuard stays enabled when enabled field is absent', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      echoGuard: { groupCooldownMs: 2_000 },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.echoGuard.enabled).toBe(true);
    expect(config.echoGuard.groupCooldownMs).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// accessMode: invalid value throws
// ---------------------------------------------------------------------------

describe('config — accessMode validation', () => {
  it('throws for invalid accessMode in INSTANCE_CONFIG', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      accessMode: 'superadmin',
    }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /Invalid accessMode "superadmin"/,
    );
  });

  it('accepts valid accessMode: open_dm', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      accessMode: 'open_dm',
    }));
    const { config } = await import('../src/config.ts');
    expect(config.accessMode).toBe('open_dm');
  });
});

// ---------------------------------------------------------------------------
// adminJid fallback to resolvedAdminPhones[0]
// ---------------------------------------------------------------------------

describe('config — adminJid fallback', () => {
  it('falls back to resolvedAdminPhones[0] when admin_jid is absent', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      adminPhones: ['+15550001111'],
    }));
    const { config } = await import('../src/config.ts');
    // normalizePhoneE164('+15550001111') → '15550001111'
    expect(config.memory.adminJid).toBe('15550001111');
  });

  it('uses memory.admin_jid when explicitly set, ignoring adminPhones', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      adminPhones: ['+15550001111'],
      memory: { admin_jid: '15559999999@s.whatsapp.net' },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.memory.adminJid).toBe('15559999999@s.whatsapp.net');
  });

  it('defaults to empty string when no adminPhones and no admin_jid', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      adminPhones: [],
    }));
    const { config } = await import('../src/config.ts');
    expect(config.memory.adminJid).toBe('');
  });
});

// ---------------------------------------------------------------------------
// processTmpDir: instance.paths.tmpDir
// ---------------------------------------------------------------------------

describe('config — processTmpDir from instance.paths.tmpDir', () => {
  it('uses instance.paths.tmpDir when provided', async () => {
    const customTmpDir = path.join(tmpDir, 'inst-custom-tmp');
    const basePaths = {
      configRoot: path.join(tmpDir, 'inst-config'),
      dataRoot: path.join(tmpDir, 'inst-data'),
      stateRoot: path.join(tmpDir, 'inst-state'),
      authDir: path.join(tmpDir, 'inst-config', 'auth_info'),
      dbPath: path.join(tmpDir, 'inst-data', 'bot.db'),
      logDir: path.join(tmpDir, 'inst-data', 'logs'),
      lockPath: path.join(tmpDir, 'inst-state', 'bot.lock'),
      mediaDir: path.join(tmpDir, 'inst-data', 'media', 'tmp'),
    };
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      paths: { ...basePaths, tmpDir: customTmpDir },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.tmpDir).toBe(customTmpDir);
    expect(process.env.TMPDIR).toBe(customTmpDir);
  });

  it('falls back to <dataRoot>/tmp when instance.paths.tmpDir is absent', async () => {
    const instDataRoot = path.join(tmpDir, 'inst-data');
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({}));
    const { config } = await import('../src/config.ts');
    expect(config.tmpDir).toBe(path.join(instDataRoot, 'tmp'));
  });
});

// ---------------------------------------------------------------------------
// PINECONE_PROJECT_ID / PINECONE_EXPECTED_HOST_SUFFIX env var overrides
// ---------------------------------------------------------------------------

describe('config — pinecone env var overrides', () => {
  it('picks up PINECONE_PROJECT_ID env var when not set in instance', async () => {
    process.env.PINECONE_PROJECT_ID = 'env-proj-id';
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({}));
    const { config } = await import('../src/config.ts');
    expect(config.memory.pinecone.projectId).toBe('env-proj-id');
  });

  it('picks up PINECONE_EXPECTED_HOST_SUFFIX env var when not set in instance', async () => {
    process.env.PINECONE_EXPECTED_HOST_SUFFIX = '.svc.aped.pinecone.io';
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({}));
    const { config } = await import('../src/config.ts');
    expect(config.memory.pinecone.expectedHostSuffix).toBe('.svc.aped.pinecone.io');
  });

  it('instance memory.pinecone.projectId takes priority over env var', async () => {
    process.env.PINECONE_PROJECT_ID = 'env-proj-id';
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      memory: { pinecone: { index: 'whatsapp-bot', projectId: 'instance-proj-id' } },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.memory.pinecone.projectId).toBe('instance-proj-id');
  });
});

// ---------------------------------------------------------------------------
// Residual reachable branches — cover_ HOME-unset tilde fallback, XDG path
// resolution, webhook publicBaseUrl default, toolThresholds non-number override,
// profileRecordProp non-object/duplicate, mergeKnowledgeProfile non-default index.
// ---------------------------------------------------------------------------

describe('config — expandTilde HOME-unset fallback to os.homedir', () => {
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
  });

  it('expands "~/" using os.homedir() when HOME is unset', async () => {
    delete process.env.HOME;
    // WHATSOUP_*_DIR are set by the outer beforeEach, so resolveDir uses the
    // explicit arm and never touches the real home directory.
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      memory: { vaultPath: '~/Documents/Obsidian/test-vault' },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.memory.vaultPath).toBe(`${osHomedir()}/Documents/Obsidian/test-vault`);
  });

  it('expands standalone "~" using os.homedir() when HOME is unset', async () => {
    delete process.env.HOME;
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      memory: { vaultPath: '~' },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.memory.vaultPath).toBe(osHomedir());
  });

  it('uses os.homedir() in the default vaultPath template when vaultPath and HOME are unset', async () => {
    delete process.env.HOME;
    // memory block present but no vaultPath → default template runs the
    // `process.env.HOME ?? homedir()` fallback (homedir arm).
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      memory: { conversation: { recent: 5 } },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.memory.vaultPath).toBe(`${osHomedir()}/Documents/Obsidian/whatsoup-memory`);
  });
});

describe('config — resolveDir XDG and homedir resolution', () => {
  let savedHome: string | undefined;
  let savedXdg: Record<string, string | undefined>;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedXdg = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    for (const [k, v] of Object.entries(savedXdg)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resolves roots under XDG base dirs when WHATSOUP_*_DIR are unset', async () => {
    const xdgConfig = path.join(tmpDir, 'xdg-config');
    const xdgData = path.join(tmpDir, 'xdg-data');
    const xdgState = path.join(tmpDir, 'xdg-state');
    delete process.env.WHATSOUP_CONFIG_DIR;
    delete process.env.WHATSOUP_DATA_DIR;
    delete process.env.WHATSOUP_STATE_DIR;
    process.env.XDG_CONFIG_HOME = xdgConfig;
    process.env.XDG_DATA_HOME = xdgData;
    process.env.XDG_STATE_HOME = xdgState;
    delete process.env.INSTANCE_CONFIG;

    const { config } = await import('../src/config.ts');
    expect(config.configRoot).toBe(path.join(xdgConfig, 'whatsoup'));
    expect(config.dataRoot).toBe(path.join(xdgData, 'whatsoup'));
    expect(config.stateRoot).toBe(path.join(xdgState, 'whatsoup'));
  });

  it('resolves roots under homedir defaults when neither WHATSOUP_*_DIR nor XDG base dirs are set', async () => {
    // Point HOME at the test temp dir so os.homedir() resolves there and
    // mkdirSync never touches the real user home.
    const fakeHome = path.join(tmpDir, 'fake-home');
    process.env.HOME = fakeHome;
    delete process.env.WHATSOUP_CONFIG_DIR;
    delete process.env.WHATSOUP_DATA_DIR;
    delete process.env.WHATSOUP_STATE_DIR;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;
    delete process.env.INSTANCE_CONFIG;

    const { config } = await import('../src/config.ts');
    expect(config.configRoot).toBe(path.join(fakeHome, '.config', 'whatsoup'));
    expect(config.dataRoot).toBe(path.join(fakeHome, '.local/share', 'whatsoup'));
    expect(config.stateRoot).toBe(path.join(fakeHome, '.local/state', 'whatsoup'));
  });
});

describe('config — resolveTwilioSmsConfig webhook publicBaseUrl default', () => {
  it('defaults publicBaseUrl to empty string when webhook block omits it', async () => {
    const { resolveTwilioSmsConfig } = await import('../src/config.ts');
    const result = resolveTwilioSmsConfig({
      account: 'ml-bot',
      accountSid: 'AC00000000000000000000000000000000',
      authTokenService: 'whatsoup-twilio-ml-bot',
      phoneNumber: '+15550000002',
      inboundMode: 'webhook',
      webhook: { listenPort: 8443 },
    });
    expect(result?.webhook?.publicBaseUrl).toBe('');
    expect(result?.webhook?.listenPort).toBe(8443);
  });
});

describe('config — mergeToolThresholds non-number override fallback', () => {
  it('keeps base threshold fields when overrides supply non-number values', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      operationTracker: {
        toolThresholds: {
          // non-number values must fall back to the agent base threshold fields
          agent: { expectedMs: 'fast', slowMultiplier: null, stallMultiplier: 'huge' },
        },
      },
    }));
    const { config } = await import('../src/config.ts');
    expect(config.operationTracker.toolThresholds.agent).toEqual({
      expectedMs: 120_000, slowMultiplier: 1.5, stallMultiplier: 3,
    });
  });
});

describe('config — profileRecordProp non-object and duplicate-after-trim', () => {
  it('rejects profiles when the entire profiles value is not an object', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      profiles: 'not-an-object',
    }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /profiles must be an object of profile names to profile objects/,
    );
  });

  it('rejects profiles with duplicate names after trimming whitespace', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      profiles: {
        bot: { prefix: 'a' },
        'bot ': { prefix: 'b' },
      },
    }));
    await expect(import('../src/config.ts')).rejects.toThrow(
      /profiles contains duplicate profile after trimming: bot/,
    );
  });
});

describe('config — mergeKnowledgeProfile non-default index base creation', () => {
  it('builds a fresh base profile for an index not present in defaults', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(makeInstanceConfig({
      memory: {
        pinecone: {
          index: 'custom-idx',
          knowledgeProfiles: {
            'custom-idx': {
              namespace: 'custom-ns',
              searchMode: 'text',
              rerank: true,
              topK: 11,
            },
          },
        },
      },
    }));
    const { config } = await import('../src/config.ts');
    const profile = config.memory.pinecone.knowledgeProfiles['custom-idx'];
    expect(profile.namespace).toBe('custom-ns');
    expect(profile.searchMode).toBe('text');
    expect(profile.rerank).toBe(true);
    expect(profile.topK).toBe(11);
    expect(profile.description).toBe('custom-idx');
  });
});
