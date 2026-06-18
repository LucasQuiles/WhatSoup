import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { homedir } from 'node:os';

type ProcessEvent = Parameters<typeof process.on>[0];
type ProcessListener = Parameters<typeof process.on>[1];

const state = vi.hoisted(() => {
  type Logger = {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    fatal: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  type RuntimeMock = {
    start: ReturnType<typeof vi.fn>;
    handleMessage: ReturnType<typeof vi.fn>;
    getHealthSnapshot: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
    setDurability: ReturnType<typeof vi.fn>;
  };

  const makeLogger = (): Logger => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  });

  const makeRuntime = (): RuntimeMock => ({
    start: vi.fn(async () => {
      if (s.runtimeStartError) throw s.runtimeStartError;
    }),
    handleMessage: vi.fn(async () => undefined),
    getHealthSnapshot: vi.fn(() => ({ status: 'healthy', details: {} })),
    shutdown: vi.fn(async () => undefined),
    setDurability: vi.fn(),
  });

  const makeConfig = () => ({
    botName: 'loops',
    configRoot: '/tmp/whatsoup/config',
    dataRoot: '/tmp/whatsoup/data',
    stateRoot: '/tmp/whatsoup/state',
    authDir: '/tmp/whatsoup/config/auth',
    dbPath: '/tmp/whatsoup/data/bot.db',
    lockPath: '/tmp/whatsoup/state/whatsoup.lock',
    mediaDir: '/tmp/whatsoup/data/media/tmp',
    pineconeIndex: 'whatsoup-memory',
    pineconeSearchMode: 'hybrid',
    pineconeRerank: false,
    pineconeTopK: 20,
    accessMode: 'allowlist',
    models: { conversation: 'claude-test' },
    adminPhones: new Set(['15550000001']),
    controlPeers: new Map<string, string>(),
    chatAliases: {},
    profiles: {},
    memory: {
      consolidation: {
        enabled: false,
        intervalHours: 1,
        lookbackDays: 7,
        dryRun: true,
      },
    },
    retentionDays: 30,
    enrichmentIntervalMs: 60_000,
    mediaRetention: {
      intervalHours: 6,
      tempHours: 72,
      cacheHours: 168,
    },
    toolUpdateMode: 'full',
  });

  const s = {
    config: makeConfig(),
    loggers: [] as Logger[],
    rootLogger: makeLogger(),
    createChildLogger: vi.fn((_: string) => {
      const logger = makeLogger();
      s.loggers.push(logger);
      return logger;
    }),
    flushLogger: vi.fn(async () => undefined),

    nextFd: 41,
    openSync: vi.fn(),
    writeFileSync: vi.fn(),
    closeSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(),
    execFileSync: vi.fn(),

    processHandlers: [] as Array<{ event: ProcessEvent; listener: ProcessListener }>,
    exitCodes: [] as Array<string | number | null | undefined>,
    killImpl: vi.fn(),

    databaseInstances: [] as Array<InstanceType<typeof MockDatabase>>,
    connectionInstances: [] as Array<InstanceType<typeof MockConnectionManager>>,
    chatRuntimeInstances: [] as Array<InstanceType<typeof MockChatRuntime>>,
    agentRuntimeInstances: [] as Array<InstanceType<typeof MockAgentRuntime>>,
    passiveRuntimeInstances: [] as Array<InstanceType<typeof MockPassiveRuntime>>,
    durabilityInstances: [] as Array<InstanceType<typeof MockDurabilityEngine>>,
    memorySchedulers: [] as Array<InstanceType<typeof MockMemoryConsolidationScheduler>>,
    mediaRetentionTimers: [] as Array<InstanceType<typeof MockMediaRetentionTimer>>,
    processTmpRetentionTimers: [] as Array<InstanceType<typeof MockProcessTmpRetentionTimer>>,
    databaseRetentionTimers: [] as Array<InstanceType<typeof MockDatabaseRetentionTimer>>,
    messageSchedulers: [] as Array<InstanceType<typeof MockMessageScheduler>>,
    triggerPollers: [] as Array<InstanceType<typeof MockTriggerPoller>>,
    pineconeMemories: [] as Array<InstanceType<typeof MockPineconeMemory>>,

    getMessageCountReturn: 1,
    pineconeReadiness: { index: 'whatsoup-memory', state: 'ready' },
    resolvedAgentModel: 'resolved-agent-model',
    agentStartupMessage: null as { chatJid: string; text: string } | null,
    legacyImportError: null as Error | null,
    contactRows: [] as Array<{ sender_jid: string; sender_name: string }>,
    runtimeStartError: null as Error | null,
    throwOnExit: true,

    startHealthServer: vi.fn(),
    healthServer: { close: vi.fn() },
    createIngestHandler: vi.fn(),
    ingestHandler: vi.fn(async () => undefined),
    waitForHistorySyncThenRecover: vi.fn(),
    resolveAgentModel: vi.fn(),
    getPineconeReadiness: vi.fn(),
    createAnthropicProvider: vi.fn(),
    createOpenAIProvider: vi.fn(),
    seedChatAliases: vi.fn(),
    createProfileRegistry: vi.fn(),
    createOutboundSendsWriter: vi.fn(),
    insertAllowed: vi.fn(),
    setLidAuthDir: vi.fn(),
    hydrateLidMappings: vi.fn(),
    getMessageCount: vi.fn(),
    getMessagesBySender: vi.fn(),
    getUnprocessedCount: vi.fn(),
    deleteOldMessages: vi.fn(),
    cleanupOldRateLimits: vi.fn(),
    processHistoryBatch: vi.fn(),
    handleContactsUpsert: vi.fn(),
    handleContactsUpdate: vi.fn(),
    handleReaction: vi.fn(),
    handleReceipt: vi.fn(),
    handleChatsUpsert: vi.fn(),
    handleChatsUpdate: vi.fn(),
    handleChatsDelete: vi.fn(),
    handleLabelsEdit: vi.fn(),
    handleLabelsAssociation: vi.fn(),
    cleanupOrphanedAssociations: vi.fn(),
    handleBlocklistSet: vi.fn(),
    handleBlocklistUpdate: vi.fn(),
    lookupAccess: vi.fn(),
    updateAccess: vi.fn(),
    resolvePhoneFromJid: vi.fn(),
    isAdminPhone: vi.fn(),
    handleGroupsUpsert: vi.fn(),
    handleGroupsUpdate: vi.fn(),
    storeDecryptionFailure: vi.fn(),
    checkDegradationSignals: vi.fn(),
    persistIntroSentFlag: vi.fn(),
    backfillMetrics: vi.fn(),
    collectHourlyMetrics: vi.fn(),
    sendTracked: vi.fn(),
    toConversationKey: vi.fn(),
    toPersonalJid: vi.fn(),
    toLidJid: vi.fn(),
    reconcileLidMappings: vi.fn(),
    upsertLidMapping: vi.fn(),
    mineMessageKey: vi.fn(),
    mineGroupParticipants: vi.fn(),
    shutdownExitCode: vi.fn(),
    openMocksReset: () => undefined,
  };

  class MockDatabase {
    readonly dbPath: string;
    readonly raw: {
      prepare: ReturnType<typeof vi.fn>;
      exec: ReturnType<typeof vi.fn>;
    };
    readonly open = vi.fn();
    readonly close = vi.fn();
    readonly importFromLegacyDb = vi.fn(() => {
      if (s.legacyImportError) throw s.legacyImportError;
    });
    readonly clearChat = vi.fn(() => 0);

    constructor(dbPath: string) {
      this.dbPath = dbPath;
      this.raw = {
        prepare: vi.fn(() => ({
          all: vi.fn(() => s.contactRows),
          get: vi.fn(() => ({ total: 0, last_at: null })),
          run: vi.fn(() => ({ changes: 0 })),
        })),
        exec: vi.fn(),
      };
      s.databaseInstances.push(this);
    }
  }

  class MockConnectionManager {
    botJid: string | null = '15550000001@s.whatsapp.net';
    botLid: string | null = '15550000001@lid';
    onMessage: unknown = null;
    readonly sendMessage = vi.fn(async () => ({ waMessageId: 'sent-message-id' }));
    readonly sendMedia = vi.fn(async () => ({ waMessageId: 'sent-media-id' }));
    readonly setTyping = vi.fn(async () => undefined);
    readonly connect = vi.fn(async () => undefined);
    readonly shutdown = vi.fn();
    readonly listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
    readonly contactsDir = {
      setDatabase: vi.fn(),
      observe: vi.fn(),
      invalidateLidCache: vi.fn(),
      size: 0,
    };

    constructor() {
      s.connectionInstances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => unknown): this {
      const current = this.listeners.get(event) ?? [];
      current.push(handler);
      this.listeners.set(event, current);
      return this;
    }
  }

  class MockChatRuntime {
    readonly mock = makeRuntime();
    readonly args: unknown[];
    start = this.mock.start;
    handleMessage = this.mock.handleMessage;
    getHealthSnapshot = this.mock.getHealthSnapshot;
    shutdown = this.mock.shutdown;
    setDurability = this.mock.setDurability;

    constructor(...args: unknown[]) {
      this.args = args;
      s.chatRuntimeInstances.push(this);
    }
  }

  class MockAgentRuntime {
    readonly mock = makeRuntime();
    readonly args: unknown[];
    readonly popStartupMessage = vi.fn(() => s.agentStartupMessage);
    start = this.mock.start;
    handleMessage = this.mock.handleMessage;
    getHealthSnapshot = this.mock.getHealthSnapshot;
    shutdown = this.mock.shutdown;
    setDurability = this.mock.setDurability;

    constructor(...args: unknown[]) {
      this.args = args;
      s.agentRuntimeInstances.push(this);
    }
  }

  class MockPassiveRuntime {
    readonly mock = makeRuntime();
    readonly args: unknown[];
    start = this.mock.start;
    handleMessage = this.mock.handleMessage;
    getHealthSnapshot = this.mock.getHealthSnapshot;
    shutdown = this.mock.shutdown;
    setDurability = this.mock.setDurability;

    constructor(...args: unknown[]) {
      this.args = args;
      s.passiveRuntimeInstances.push(this);
    }
  }

  class MockDurabilityEngine {
    readonly db: unknown;
    readonly preConnectRecovery = vi.fn();
    readonly postConnectRecovery = vi.fn(() => ({
      inboundReplayed: 0,
      outboundReconciled: 0,
      outboundReplayed: 0,
      outboundQuarantined: 0,
      toolCallsRecovered: 0,
      toolCallsReplayed: 0,
      toolCallsQuarantined: 0,
      sessionsRestored: 0,
    }));
    readonly sweepStaleSubmitted = vi.fn();

    constructor(db: unknown) {
      this.db = db;
      s.durabilityInstances.push(this);
    }
  }

  class MockMemoryConsolidationScheduler {
    readonly args: unknown[];
    readonly start = vi.fn();
    readonly stop = vi.fn(async () => undefined);

    constructor(...args: unknown[]) {
      this.args = args;
      s.memorySchedulers.push(this);
    }
  }

  class MockMediaRetentionTimer {
    readonly args: unknown[];
    readonly start = vi.fn();
    readonly stop = vi.fn();

    constructor(...args: unknown[]) {
      this.args = args;
      s.mediaRetentionTimers.push(this);
    }
  }

  class MockProcessTmpRetentionTimer {
    readonly args: unknown[];
    readonly start = vi.fn();
    readonly stop = vi.fn();

    constructor(...args: unknown[]) {
      this.args = args;
      s.processTmpRetentionTimers.push(this);
    }
  }

  class MockDatabaseRetentionTimer {
    readonly args: unknown[];
    readonly start = vi.fn();
    readonly stop = vi.fn();

    constructor(...args: unknown[]) {
      this.args = args;
      s.databaseRetentionTimers.push(this);
    }
  }

  class MockMessageScheduler {
    readonly args: unknown[];
    readonly recoverStale = vi.fn();
    readonly start = vi.fn();
    readonly stop = vi.fn();

    constructor(...args: unknown[]) {
      this.args = args;
      s.messageSchedulers.push(this);
    }
  }

  class MockTriggerPoller {
    readonly args: unknown[];
    readonly start = vi.fn();
    readonly stop = vi.fn();

    constructor(...args: unknown[]) {
      this.args = args;
      s.triggerPollers.push(this);
    }
  }

  class MockPineconeMemory {
    constructor() {
      s.pineconeMemories.push(this);
    }
  }

  s.openMocksReset = () => {
    const freshConfig = makeConfig();
    for (const key of Object.keys(s.config)) {
      delete s.config[key as keyof typeof s.config];
    }
    Object.assign(s.config, freshConfig);
    s.loggers = [];
    s.rootLogger = makeLogger();
    s.processHandlers = [];
    s.exitCodes = [];
    s.databaseInstances = [];
    s.connectionInstances = [];
    s.chatRuntimeInstances = [];
    s.agentRuntimeInstances = [];
    s.passiveRuntimeInstances = [];
    s.durabilityInstances = [];
    s.memorySchedulers = [];
    s.mediaRetentionTimers = [];
    s.processTmpRetentionTimers = [];
    s.databaseRetentionTimers = [];
    s.messageSchedulers = [];
    s.triggerPollers = [];
    s.pineconeMemories = [];
    s.nextFd = 41;
    s.getMessageCountReturn = 1;
    s.pineconeReadiness = { index: 'whatsoup-memory', state: 'ready' };
    s.resolvedAgentModel = 'resolved-agent-model';
    s.agentStartupMessage = null;
    s.legacyImportError = null;
    s.contactRows = [];
    s.runtimeStartError = null;
    s.throwOnExit = true;

    for (const fn of [
      s.createChildLogger,
      s.flushLogger,
      s.openSync,
      s.writeFileSync,
      s.closeSync,
      s.readFileSync,
      s.unlinkSync,
      s.existsSync,
      s.execFileSync,
      s.killImpl,
      s.startHealthServer,
      s.healthServer.close,
      s.createIngestHandler,
      s.ingestHandler,
      s.waitForHistorySyncThenRecover,
      s.resolveAgentModel,
      s.getPineconeReadiness,
      s.createAnthropicProvider,
      s.createOpenAIProvider,
      s.seedChatAliases,
      s.createProfileRegistry,
      s.createOutboundSendsWriter,
      s.insertAllowed,
      s.setLidAuthDir,
      s.hydrateLidMappings,
      s.getMessageCount,
      s.getMessagesBySender,
      s.getUnprocessedCount,
      s.deleteOldMessages,
      s.cleanupOldRateLimits,
      s.processHistoryBatch,
      s.handleContactsUpsert,
      s.handleContactsUpdate,
      s.handleReaction,
      s.handleReceipt,
      s.handleChatsUpsert,
      s.handleChatsUpdate,
      s.handleChatsDelete,
      s.handleLabelsEdit,
      s.handleLabelsAssociation,
      s.cleanupOrphanedAssociations,
      s.handleBlocklistSet,
      s.handleBlocklistUpdate,
      s.lookupAccess,
      s.updateAccess,
      s.resolvePhoneFromJid,
      s.isAdminPhone,
      s.handleGroupsUpsert,
      s.handleGroupsUpdate,
      s.storeDecryptionFailure,
      s.checkDegradationSignals,
      s.persistIntroSentFlag,
      s.backfillMetrics,
      s.collectHourlyMetrics,
      s.sendTracked,
      s.toConversationKey,
      s.toPersonalJid,
      s.toLidJid,
      s.reconcileLidMappings,
      s.upsertLidMapping,
      s.mineMessageKey,
      s.mineGroupParticipants,
      s.shutdownExitCode,
    ]) {
      fn.mockReset();
    }

    s.createChildLogger.mockImplementation((_: string) => {
      const logger = makeLogger();
      s.loggers.push(logger);
      return logger;
    });
    s.flushLogger.mockResolvedValue(undefined);
    s.openSync.mockImplementation(() => s.nextFd++);
    s.readFileSync.mockReturnValue(JSON.stringify({ pid: 999, startedAt: '2026-06-10T00:00:00.000Z' }));
    s.existsSync.mockReturnValue(false);
    s.execFileSync.mockReturnValue(Buffer.from('/usr/bin/ffmpeg\n'));
    s.killImpl.mockReturnValue(true);
    s.startHealthServer.mockImplementation((deps: unknown) => {
      void deps;
      return s.healthServer;
    });
    s.createIngestHandler.mockReturnValue(s.ingestHandler);
    s.waitForHistorySyncThenRecover.mockImplementation(async (opts: { recover: () => unknown }) => {
      opts.recover();
    });
    s.resolveAgentModel.mockImplementation(() => s.resolvedAgentModel);
    s.getPineconeReadiness.mockImplementation(async () => s.pineconeReadiness);
    s.createAnthropicProvider.mockReturnValue({ kind: 'anthropic' });
    s.createOpenAIProvider.mockReturnValue({ kind: 'openai' });
    s.seedChatAliases.mockReturnValue(0);
    s.createProfileRegistry.mockReturnValue({ kind: 'profiles' });
    s.createOutboundSendsWriter.mockReturnValue({ kind: 'audit-writer' });
    s.hydrateLidMappings.mockReturnValue(0);
    s.getMessageCount.mockImplementation(() => s.getMessageCountReturn);
    s.getMessagesBySender.mockReturnValue([]);
    s.getUnprocessedCount.mockReturnValue(0);
    s.deleteOldMessages.mockReturnValue(0);
    s.cleanupOldRateLimits.mockReturnValue(0);
    s.processHistoryBatch.mockReturnValue({ inserted: 0, upgraded: 0, placeholders: 0, skipped: 0 });
    s.lookupAccess.mockReturnValue(null);
    s.resolvePhoneFromJid.mockReturnValue('15550000001');
    s.isAdminPhone.mockReturnValue(true);
    s.sendTracked.mockResolvedValue({ waMessageId: 'tracked-message-id' });
    s.toConversationKey.mockImplementation((jid: string) => `conversation:${jid}`);
    s.toPersonalJid.mockImplementation((phone: string) => `${phone}@s.whatsapp.net`);
    s.toLidJid.mockImplementation((phone: string) => `${phone}@lid`);
    s.reconcileLidMappings.mockReturnValue({ hydrated: 0, unresolvedLids: [] });
    s.mineMessageKey.mockReturnValue(null);
    s.mineGroupParticipants.mockReturnValue(0);
    s.shutdownExitCode.mockImplementation((signal: string) => signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1);
  };

  return Object.assign(s, {
    MockDatabase,
    MockConnectionManager,
    MockChatRuntime,
    MockAgentRuntime,
    MockPassiveRuntime,
    MockDurabilityEngine,
    MockMemoryConsolidationScheduler,
    MockMediaRetentionTimer,
    MockProcessTmpRetentionTimer,
    MockDatabaseRetentionTimer,
    MockMessageScheduler,
    MockTriggerPoller,
    MockPineconeMemory,
  });
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: state.openSync,
    writeFileSync: state.writeFileSync,
    closeSync: state.closeSync,
    readFileSync: state.readFileSync,
    unlinkSync: state.unlinkSync,
    existsSync: state.existsSync,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: state.execFileSync,
  };
});

vi.mock('../src/config.ts', () => ({ config: state.config }));
vi.mock('../src/logger.ts', () => ({
  default: state.rootLogger,
  createChildLogger: state.createChildLogger,
  flushLogger: state.flushLogger,
}));
vi.mock('../src/core/database.ts', () => ({
  Database: state.MockDatabase,
  storeDecryptionFailure: state.storeDecryptionFailure,
}));
vi.mock('../src/runtimes/chat/rate-limits-db.ts', () => ({ cleanupOldRateLimits: state.cleanupOldRateLimits }));
vi.mock('../src/core/messages.ts', () => ({
  deleteOldMessages: state.deleteOldMessages,
  getMessagesBySender: state.getMessagesBySender,
  getMessageCount: state.getMessageCount,
  getUnprocessedCount: state.getUnprocessedCount,
}));
vi.mock('../src/core/history-sync.ts', () => ({ processHistoryBatch: state.processHistoryBatch }));
vi.mock('../src/transport/connection.ts', () => ({ ConnectionManager: state.MockConnectionManager }));
vi.mock('../src/runtimes/chat/runtime.ts', () => ({ ChatRuntime: state.MockChatRuntime }));
vi.mock('../src/runtimes/agent/runtime.ts', () => ({ AgentRuntime: state.MockAgentRuntime }));
vi.mock('../src/runtimes/passive/runtime.ts', () => ({ PassiveRuntime: state.MockPassiveRuntime }));
vi.mock('../src/instance-loader.ts', () => ({ resolveAgentModel: state.resolveAgentModel }));
vi.mock('../src/runtimes/chat/providers/pinecone.ts', () => ({
  PineconeMemory: state.MockPineconeMemory,
  getPineconeReadiness: state.getPineconeReadiness,
}));
vi.mock('../src/runtimes/chat/providers/anthropic.ts', () => ({ createAnthropicProvider: state.createAnthropicProvider }));
vi.mock('../src/runtimes/chat/providers/openai.ts', () => ({ createOpenAIProvider: state.createOpenAIProvider }));
vi.mock('../src/memory/consolidation-scheduler.ts', () => ({ MemoryConsolidationScheduler: state.MockMemoryConsolidationScheduler }));
vi.mock('../src/core/health.ts', () => ({ startHealthServer: state.startHealthServer }));
vi.mock('../src/core/heal.ts', () => ({ checkDegradationSignals: state.checkDegradationSignals }));
vi.mock('../src/core/ingest.ts', () => ({ createIngestHandler: state.createIngestHandler }));
vi.mock('../src/core/conversation-key.ts', () => ({ toConversationKey: state.toConversationKey }));
vi.mock('../src/core/jid-constants.ts', () => ({
  toPersonalJid: state.toPersonalJid,
  toLidJid: state.toLidJid,
}));
vi.mock('../src/core/durability.ts', () => ({
  DurabilityEngine: state.MockDurabilityEngine,
  sendTracked: state.sendTracked,
}));
vi.mock('../src/core/post-connect-recovery.ts', () => ({ waitForHistorySyncThenRecover: state.waitForHistorySyncThenRecover }));
vi.mock('../src/core/chats-resolver.ts', () => ({ seedChatAliases: state.seedChatAliases }));
vi.mock('../src/core/profiles.ts', () => ({ createProfileRegistry: state.createProfileRegistry }));
vi.mock('../src/core/outbound-sends.ts', () => ({ createOutboundSendsWriter: state.createOutboundSendsWriter }));
vi.mock('../src/core/contacts-sync.ts', () => ({
  handleContactsUpsert: state.handleContactsUpsert,
  handleContactsUpdate: state.handleContactsUpdate,
}));
vi.mock('../src/core/chat-sync.ts', () => ({
  handleReaction: state.handleReaction,
  handleReceipt: state.handleReceipt,
  handleChatsUpsert: state.handleChatsUpsert,
  handleChatsUpdate: state.handleChatsUpdate,
  handleChatsDelete: state.handleChatsDelete,
}));
vi.mock('../src/core/label-sync.ts', () => ({
  handleLabelsEdit: state.handleLabelsEdit,
  handleLabelsAssociation: state.handleLabelsAssociation,
  cleanupOrphanedAssociations: state.cleanupOrphanedAssociations,
}));
vi.mock('../src/core/blocklist-sync.ts', () => ({
  handleBlocklistSet: state.handleBlocklistSet,
  handleBlocklistUpdate: state.handleBlocklistUpdate,
}));
vi.mock('../src/core/access-list.ts', () => ({
  lookupAccess: state.lookupAccess,
  updateAccess: state.updateAccess,
  insertAllowed: state.insertAllowed,
  resolvePhoneFromJid: state.resolvePhoneFromJid,
}));
vi.mock('../src/core/lid-resolver.ts', () => ({
  hydrateLidMappings: state.hydrateLidMappings,
  upsertLidMapping: state.upsertLidMapping,
  mineMessageKey: state.mineMessageKey,
  mineGroupParticipants: state.mineGroupParticipants,
  reconcileLidMappings: state.reconcileLidMappings,
  setLidAuthDir: state.setLidAuthDir,
}));
vi.mock('../src/lib/phone.ts', () => ({ isAdminPhone: state.isAdminPhone }));
vi.mock('../src/core/group-sync.ts', () => ({
  handleGroupsUpsert: state.handleGroupsUpsert,
  handleGroupsUpdate: state.handleGroupsUpdate,
}));
vi.mock('../src/core/media-retention.ts', () => ({ MediaRetentionTimer: state.MockMediaRetentionTimer }));
vi.mock('../src/core/process-tmp-retention.ts', () => ({
  ProcessTmpRetentionTimer: state.MockProcessTmpRetentionTimer,
  DEFAULT_PROCESS_TMP_RETENTION: { intervalMs: 3_000, maxAgeMs: 30_000 },
}));
vi.mock('../src/core/database-retention.ts', () => ({
  DatabaseRetentionTimer: state.MockDatabaseRetentionTimer,
  DEFAULT_DATABASE_RETENTION: { intervalMs: 4_000, terminalDurabilityDays: 30, exportedFactDays: 30 },
}));
vi.mock('../src/core/intro-sent-config.ts', () => ({ persistIntroSentFlag: state.persistIntroSentFlag }));
vi.mock('../src/core/scheduler.ts', () => ({ MessageScheduler: state.MockMessageScheduler }));
vi.mock('../src/core/substrate/poller.ts', () => ({ TriggerPoller: state.MockTriggerPoller }));
vi.mock('../src/core/metrics-collector.ts', () => ({
  backfillMetrics: state.backfillMetrics,
  collectHourlyMetrics: state.collectHourlyMetrics,
}));
vi.mock('../src/main-shutdown-policy.ts', () => ({ shutdownExitCode: state.shutdownExitCode }));

function setInstanceConfig(overrides: Record<string, unknown>): void {
  process.env.INSTANCE_CONFIG = JSON.stringify({
    name: 'line-under-test',
    type: 'chat',
    paths: {
      configRoot: '/tmp/instance/config',
      dataRoot: '/tmp/instance/data',
      stateRoot: '/tmp/instance/state',
      authDir: '/tmp/instance/config/auth',
      dbPath: '/tmp/instance/data/bot.db',
      logDir: '/tmp/instance/data/logs',
      lockPath: '/tmp/instance/state/whatsoup.lock',
      mediaDir: '/tmp/instance/data/media/tmp',
    },
    ...overrides,
  });
}

async function importMainAndFlushStart(): Promise<void> {
  await import('../src/main.ts');
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function processHandler(event: ProcessEvent): (...args: unknown[]) => unknown {
  const entry = state.processHandlers.find((handler) => handler.event === event);
  expect(entry).toBeDefined();
  return entry!.listener as (...args: unknown[]) => unknown;
}

function connectionListener(event: string): (...args: unknown[]) => unknown {
  const handlers = state.connectionInstances[0]!.listeners.get(event);
  expect(handlers?.length).toBeGreaterThan(0);
  return handlers![0]!;
}

function eexist(): NodeJS.ErrnoException {
  return Object.assign(new Error('lock exists'), { code: 'EEXIST' });
}

function esrch(): NodeJS.ErrnoException {
  return Object.assign(new Error('process missing'), { code: 'ESRCH' });
}

function eperm(): NodeJS.ErrnoException {
  return Object.assign(new Error('process exists but cannot be signaled'), { code: 'EPERM' });
}

describe('main entrypoint behavior', () => {
  let savedInstanceConfig: string | undefined;
  let processOnSpy: { mockRestore(): void };
  let processExitSpy: { mockRestore(): void };
  let processKillSpy: { mockRestore(): void };

  beforeEach(() => {
    savedInstanceConfig = process.env.INSTANCE_CONFIG;
    process.env.INSTANCE_CONFIG = '';
    vi.useFakeTimers();
    vi.resetModules();
    state.openMocksReset();

    processOnSpy = vi.spyOn(process, 'on').mockImplementation((event: ProcessEvent, listener: ProcessListener) => {
      state.processHandlers.push({ event, listener });
      return process;
    });
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      state.exitCodes.push(code);
      if (!state.throwOnExit) return undefined as never;
      throw new Error(`process.exit(${String(code)})`);
    }) as typeof process.exit);
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      return state.killImpl(pid, signal);
    }) as typeof process.kill);
  });

  afterEach(() => {
    if (savedInstanceConfig === undefined) {
      delete process.env.INSTANCE_CONFIG;
    } else {
      process.env.INSTANCE_CONFIG = savedInstanceConfig;
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
    processKillSpy.mockRestore();
    vi.resetModules();
  });

  it('boots the default chat runtime and shuts down the wired resources on SIGTERM', async () => {
    await importMainAndFlushStart();

    expect(state.openSync).toHaveBeenCalledWith(
      state.config.lockPath,
      expect.any(Number),
      0o600,
    );
    const lockFlags = state.openSync.mock.calls[0]![1] as number;
    expect(lockFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(state.writeFileSync).toHaveBeenCalledOnce();
    expect(JSON.parse(String(state.writeFileSync.mock.calls[0]![1]))).toMatchObject({
      pid: process.pid,
    });
    expect(state.closeSync).toHaveBeenCalledWith(41);

    expect(state.chatRuntimeInstances).toHaveLength(1);
    expect(state.agentRuntimeInstances).toHaveLength(0);
    expect(state.passiveRuntimeInstances).toHaveLength(0);

    const runtime = state.chatRuntimeInstances[0]!;
    const connection = state.connectionInstances[0]!;
    const db = state.databaseInstances[0]!;
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(connection.connect).toHaveBeenCalledOnce();
    expect(state.waitForHistorySyncThenRecover).toHaveBeenCalledOnce();
    expect(state.durabilityInstances[0]!.postConnectRecovery).toHaveBeenCalledOnce();

    const ingestArgs = state.createIngestHandler.mock.calls[0]!;
    expect(ingestArgs[0]).toBe(db);
    expect(ingestArgs[1]).toBe(connection);
    expect(ingestArgs[2]).toBe(runtime);
    expect(ingestArgs[6]).toBe('chat');

    expect(state.startHealthServer).toHaveBeenCalledWith(expect.objectContaining({
      db,
      connectionManager: connection,
      runtime,
      instanceName: state.config.botName,
      instanceType: 'chat',
      accessMode: state.config.accessMode,
    }));

    await expect(Promise.resolve(processHandler('SIGTERM')())).rejects.toThrow('process.exit(0)');

    expect(state.healthServer.close).toHaveBeenCalledOnce();
    expect(runtime.shutdown).toHaveBeenCalledOnce();
    expect(connection.shutdown).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(state.unlinkSync).toHaveBeenCalledWith(state.config.lockPath);
    expect(state.flushLogger).toHaveBeenCalledOnce();
    expect(state.shutdownExitCode).toHaveBeenCalledWith('SIGTERM');
    expect(state.exitCodes).toEqual([0]);
    expect(runtime.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      connection.shutdown.mock.invocationCallOrder[0]!,
    );
  });

  it('routes connection events into the persistence and access helpers', async () => {
    await importMainAndFlushStart();

    const db = state.databaseInstances[0]!;
    const runtime = state.chatRuntimeInstances[0]!;
    const handleJidAliasChanged = vi.fn();
    Object.assign(runtime, { handleJidAliasChanged });

    connectionListener('chatCleared')('chat-1@s.whatsapp.net');
    expect(state.toConversationKey).toHaveBeenCalledWith('chat-1@s.whatsapp.net');
    expect(db.clearChat).toHaveBeenCalledWith('conversation:chat-1@s.whatsapp.net');

    connectionListener('contactsUpsert')([{ id: 'contact-1' }]);
    expect(state.handleContactsUpsert).toHaveBeenCalledWith(db, [{ id: 'contact-1' }]);

    connectionListener('contactsUpdate')([{ id: 'contact-1', notify: 'Name' }]);
    expect(state.handleContactsUpdate).toHaveBeenCalledWith(db, [{ id: 'contact-1', notify: 'Name' }]);

    connectionListener('reactionReceived')({ messageId: 'message-1' });
    expect(state.handleReaction).toHaveBeenCalledWith(db, { messageId: 'message-1' });

    connectionListener('receiptUpdate')({ id: 'receipt-1' });
    expect(state.handleReceipt).toHaveBeenCalledWith(db, { id: 'receipt-1' });

    connectionListener('mediaUpdate')([{ messageId: 'media-1' }, { messageId: 'media-2' }]);

    connectionListener('chatsUpsert')([{ id: 'chat-1' }]);
    expect(state.handleChatsUpsert).toHaveBeenCalledWith(db, [{ id: 'chat-1' }]);

    connectionListener('chatsUpdate')([{ id: 'chat-1', unreadCount: 3 }]);
    expect(state.handleChatsUpdate).toHaveBeenCalledWith(db, [{ id: 'chat-1', unreadCount: 3 }]);

    connectionListener('chatsDelete')(['chat-1@s.whatsapp.net']);
    expect(state.handleChatsDelete).toHaveBeenCalledWith(db, ['chat-1@s.whatsapp.net']);

    connectionListener('historyMessages')('not-array');
    state.processHistoryBatch.mockReturnValueOnce({ inserted: 1, upgraded: 0, placeholders: 0, skipped: 0 });
    connectionListener('historyMessages')([{ messageId: 'history-1' }]);
    expect(state.processHistoryBatch).toHaveBeenCalledWith(db, [{ messageId: 'history-1' }], expect.any(Object));

    connectionListener('jidAliasChanged')('conversation-key', 'new-jid@s.whatsapp.net');
    expect(handleJidAliasChanged).toHaveBeenCalledWith('conversation-key', 'new-jid@s.whatsapp.net');
    expect(state.upsertLidMapping).toHaveBeenCalledWith(db, 'conversation-key', 'new-jid@s.whatsapp.net');
    expect(state.connectionInstances[0]!.contactsDir.invalidateLidCache).toHaveBeenCalled();

    state.mineMessageKey.mockReturnValueOnce({ lid: 'lid-1@lid', phoneJid: '15550000001@s.whatsapp.net' });
    connectionListener('lidPairDiscovered')('lid-1@lid', '15550000001@s.whatsapp.net');
    expect(state.upsertLidMapping).toHaveBeenCalledWith(db, 'lid-1@lid', '15550000001@s.whatsapp.net', 'L3');

    state.mineGroupParticipants.mockReturnValueOnce(2);
    connectionListener('groupsUpsert')([{ id: 'group-1@g.us', participants: [{ id: 'lid-1@lid' }] }]);
    expect(state.handleGroupsUpsert).toHaveBeenCalledWith(db, [{ id: 'group-1@g.us', participants: [{ id: 'lid-1@lid' }] }]);
    expect(state.mineGroupParticipants).toHaveBeenCalledWith(db, [{ id: 'lid-1@lid' }]);

    connectionListener('groupsUpdate')([{ id: 'group-1@g.us', subject: 'Group' }]);
    expect(state.handleGroupsUpdate).toHaveBeenCalledWith(db, [{ id: 'group-1@g.us', subject: 'Group' }]);

    connectionListener('groupJoinRequest')({ groupJid: 'group-1@g.us', requesterJid: 'user@s.whatsapp.net' });

    connectionListener('groupParticipantsUpdate')({
      groupJid: 'group-1@g.us',
      author: 'admin@s.whatsapp.net',
      participants: ['15550000001@s.whatsapp.net'],
      action: 'add',
    });
    expect(state.resolvePhoneFromJid).toHaveBeenCalledWith('admin@s.whatsapp.net', db);
    expect(state.insertAllowed).toHaveBeenCalledWith(db, 'group', 'group-1@g.us');

    connectionListener('blocklistSet')(['blocked@s.whatsapp.net']);
    expect(state.handleBlocklistSet).toHaveBeenCalledWith(db, ['blocked@s.whatsapp.net']);

    connectionListener('blocklistUpdate')({ blocklist: ['blocked@s.whatsapp.net'], type: 'add' });
    expect(state.handleBlocklistUpdate).toHaveBeenCalledWith(db, { blocklist: ['blocked@s.whatsapp.net'], type: 'add' });

    connectionListener('newsletterReaction')({ id: 'reaction-1' });
    connectionListener('newsletterView')({ id: 'view-1' });
    connectionListener('newsletterParticipantsUpdate')({ id: 'participants-1' });
    connectionListener('newsletterSettingsUpdate')({ id: 'settings-1' });

    connectionListener('labelsEdit')([{ id: 'label-1' }]);
    expect(state.handleLabelsEdit).toHaveBeenCalledWith(db, [{ id: 'label-1' }]);
    expect(state.cleanupOrphanedAssociations).toHaveBeenCalledWith(db);

    connectionListener('labelsAssociation')({ labelId: 'label-1', chatId: 'chat-1' });
    expect(state.handleLabelsAssociation).toHaveBeenCalledWith(db, { labelId: 'label-1', chatId: 'chat-1' });

    connectionListener('decryptionFailure')({
      messageId: 'message-1',
      senderJid: 'sender@s.whatsapp.net',
      chatJid: 'chat-1@s.whatsapp.net',
      errorMessage: 'failed',
    });
    expect(state.storeDecryptionFailure).toHaveBeenCalledWith(db, {
      messageId: 'message-1',
      senderJid: 'sender@s.whatsapp.net',
      chatJid: 'chat-1@s.whatsapp.net',
      errorMessage: 'failed',
    });
  });

  it('contains connection handler failures and keeps the process alive', async () => {
    await importMainAndFlushStart();

    const db = state.databaseInstances[0]!;
    const runtime = state.chatRuntimeInstances[0]!;
    Object.assign(runtime, { handleJidAliasChanged: vi.fn(() => { throw new Error('alias failed'); }) });

    db.clearChat.mockImplementationOnce(() => { throw new Error('clear failed'); });
    expect(() => connectionListener('chatCleared')('chat-1@s.whatsapp.net')).not.toThrow();

    state.handleContactsUpsert.mockImplementationOnce(() => { throw new Error('contacts upsert failed'); });
    expect(() => connectionListener('contactsUpsert')([{ id: 'contact-1' }])).not.toThrow();

    state.handleContactsUpdate.mockImplementationOnce(() => { throw new Error('contacts update failed'); });
    expect(() => connectionListener('contactsUpdate')([{ id: 'contact-1' }])).not.toThrow();

    state.handleReaction.mockImplementationOnce(() => { throw new Error('reaction failed'); });
    expect(() => connectionListener('reactionReceived')({ messageId: 'message-1' })).not.toThrow();

    state.handleReceipt.mockImplementationOnce(() => { throw new Error('receipt failed'); });
    expect(() => connectionListener('receiptUpdate')({ id: 'receipt-1' })).not.toThrow();

    state.handleChatsUpsert.mockImplementationOnce(() => { throw new Error('chats upsert failed'); });
    expect(() => connectionListener('chatsUpsert')([{ id: 'chat-1' }])).not.toThrow();

    state.handleChatsUpdate.mockImplementationOnce(() => { throw new Error('chats update failed'); });
    expect(() => connectionListener('chatsUpdate')([{ id: 'chat-1' }])).not.toThrow();

    state.handleChatsDelete.mockImplementationOnce(() => { throw new Error('chats delete failed'); });
    expect(() => connectionListener('chatsDelete')(['chat-1@s.whatsapp.net'])).not.toThrow();

    expect(() => connectionListener('jidAliasChanged')('conversation-key', 'new-jid@s.whatsapp.net')).not.toThrow();

    state.mineMessageKey.mockImplementationOnce(() => { throw new Error('mine failed'); });
    expect(() => connectionListener('lidPairDiscovered')('lid-1@lid', '15550000001@s.whatsapp.net')).not.toThrow();

    state.handleGroupsUpsert.mockImplementationOnce(() => { throw new Error('groups upsert failed'); });
    expect(() => connectionListener('groupsUpsert')([{ id: 'group-1@g.us', participants: [] }])).not.toThrow();

    state.handleGroupsUpdate.mockImplementationOnce(() => { throw new Error('groups update failed'); });
    expect(() => connectionListener('groupsUpdate')([{ id: 'group-1@g.us' }])).not.toThrow();

    state.handleBlocklistSet.mockImplementationOnce(() => { throw new Error('blocklist set failed'); });
    expect(() => connectionListener('blocklistSet')(['blocked@s.whatsapp.net'])).not.toThrow();

    state.handleBlocklistUpdate.mockImplementationOnce(() => { throw new Error('blocklist update failed'); });
    expect(() => connectionListener('blocklistUpdate')({ blocklist: ['blocked@s.whatsapp.net'], type: 'remove' })).not.toThrow();

    state.handleLabelsEdit.mockImplementationOnce(() => { throw new Error('labels edit failed'); });
    expect(() => connectionListener('labelsEdit')([{ id: 'label-1' }])).not.toThrow();

    state.handleLabelsAssociation.mockImplementationOnce(() => { throw new Error('labels association failed'); });
    expect(() => connectionListener('labelsAssociation')({ labelId: 'label-1', chatId: 'chat-1' })).not.toThrow();

    state.storeDecryptionFailure.mockImplementationOnce(() => { throw new Error('decryption write failed'); });
    expect(() => connectionListener('decryptionFailure')({
      messageId: 'message-1',
      senderJid: 'sender@s.whatsapp.net',
      chatJid: 'chat-1@s.whatsapp.net',
      errorMessage: 'failed',
    })).not.toThrow();
  });

  it('handles group participant auto-allow edge cases explicitly', async () => {
    await importMainAndFlushStart();

    const db = state.databaseInstances[0]!;
    const participantUpdate = {
      groupJid: 'group-1@g.us',
      author: 'author@s.whatsapp.net',
      participants: ['15550000001@s.whatsapp.net'],
      action: 'add',
    };

    state.isAdminPhone.mockReturnValueOnce(false);
    connectionListener('groupParticipantsUpdate')(participantUpdate);
    expect(state.lookupAccess).not.toHaveBeenCalledWith(db, 'group', 'group-1@g.us');

    state.lookupAccess.mockReturnValueOnce({ status: 'allowed' });
    connectionListener('groupParticipantsUpdate')(participantUpdate);
    expect(state.updateAccess).not.toHaveBeenCalledWith(db, 'group', 'group-1@g.us', 'allowed');

    state.lookupAccess.mockReturnValueOnce({ status: 'pending' });
    connectionListener('groupParticipantsUpdate')(participantUpdate);
    expect(state.updateAccess).toHaveBeenCalledWith(db, 'group', 'group-1@g.us', 'allowed');
  });

  it('exposes health callbacks that replay allowed phones and report enrichment state', async () => {
    await importMainAndFlushStart();

    const db = state.databaseInstances[0]!;
    const runtime = state.chatRuntimeInstances[0]!;
    const healthDeps = state.startHealthServer.mock.calls[0]![0] as {
      handleAccessDecision: (subjectType: 'phone' | 'group', subjectId: string, action: 'allow' | 'block') => Promise<void>;
      getEnrichmentStats: () => { lastRun: string | null; unprocessed: number; runtimeDegraded: boolean };
    };
    const queued = {
      messageId: 'queued-1',
      chatJid: 'chat-1@s.whatsapp.net',
      senderJid: '15550000001@s.whatsapp.net',
      senderName: 'Sender',
      content: 'hello',
      contentText: null,
      contentType: 'text',
      timestamp: 123,
      quotedMessageId: null,
    };
    state.getMessagesBySender.mockImplementation((_: unknown, senderJid: string) =>
      senderJid === '15550000001@s.whatsapp.net' ? [queued] : [],
    );

    await healthDeps.handleAccessDecision('phone', '15550000001', 'allow');

    expect(state.toPersonalJid).toHaveBeenCalledWith('15550000001');
    expect(state.toLidJid).toHaveBeenCalledWith('15550000001');
    expect(state.getMessagesBySender).toHaveBeenCalledWith(db, '15550000001@s.whatsapp.net');
    expect(runtime.handleMessage).toHaveBeenCalledWith({
      messageId: 'queued-1',
      chatJid: 'chat-1@s.whatsapp.net',
      senderJid: '15550000001@s.whatsapp.net',
      senderName: 'Sender',
      content: 'hello',
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      isGroup: false,
      mentionedJids: [],
      timestamp: 123,
      quotedMessageId: null,
      isResponseWorthy: true,
    });

    await healthDeps.handleAccessDecision('group', 'group-1@g.us', 'allow');
    await healthDeps.handleAccessDecision('phone', '15550000001', 'block');

    runtime.getHealthSnapshot.mockReturnValueOnce({
      status: 'degraded',
      details: { enrichmentLastRunAt: '2026-06-10T12:00:00.000Z' },
    });
    state.getUnprocessedCount.mockReturnValueOnce(7);
    expect(healthDeps.getEnrichmentStats()).toEqual({
      lastRun: '2026-06-10T12:00:00.000Z',
      unprocessed: 7,
      runtimeDegraded: true,
    });

    runtime.getHealthSnapshot.mockReturnValueOnce({ status: 'healthy', details: {} });
    state.getUnprocessedCount.mockImplementationOnce(() => { throw new Error('db unavailable'); });
    expect(healthDeps.getEnrichmentStats()).toEqual({
      lastRun: null,
      unprocessed: 0,
      runtimeDegraded: false,
    });
  });

  it('runs configured startup timers and optional degradation sweeps', async () => {
    state.config.controlPeers = new Map([['q', '15550000001@s.whatsapp.net']]);
    state.deleteOldMessages.mockReturnValue(2);
    state.cleanupOldRateLimits.mockReturnValue(3);
    state.reconcileLidMappings.mockReturnValue({ hydrated: 1, unresolvedLids: ['lid-1@lid'] });

    await importMainAndFlushStart();
    Object.assign(state.chatRuntimeInstances[0]!, { currentControlReportId: 'report-1' });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.backfillMetrics).toHaveBeenCalledWith(state.databaseInstances[0]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.durabilityInstances[0]!.sweepStaleSubmitted).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50_000);
    expect(state.deleteOldMessages).toHaveBeenCalledWith(state.databaseInstances[0], state.config.retentionDays);
    expect(state.collectHourlyMetrics).toHaveBeenCalledWith(state.databaseInstances[0]);
    expect(state.checkDegradationSignals).toHaveBeenCalledWith(
      state.databaseInstances[0],
      state.connectionInstances[0],
      state.durabilityInstances[0],
      'report-1',
    );

    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
    expect(state.reconcileLidMappings).toHaveBeenCalledWith(state.databaseInstances[0], state.config.authDir);
    expect(state.connectionInstances[0]!.contactsDir.invalidateLidCache).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync((24 * 60 * 60 * 1000) - (30 * 60 * 1000));
    expect(state.cleanupOldRateLimits).toHaveBeenCalledWith(state.databaseInstances[0]);
  });

  it('logs startup seed work and hydrates contacts from message history', async () => {
    state.seedChatAliases.mockReturnValue(2);
    state.hydrateLidMappings.mockReturnValue(1);
    state.contactRows = [
      { sender_jid: 'sender-1@s.whatsapp.net', sender_name: 'Sender One' },
      { sender_jid: 'sender-2@s.whatsapp.net', sender_name: 'Sender Two' },
    ];

    await importMainAndFlushStart();

    expect(state.seedChatAliases).toHaveBeenCalledWith(state.databaseInstances[0]!.raw, state.config.chatAliases);
    expect(state.hydrateLidMappings).toHaveBeenCalledWith(state.databaseInstances[0], state.config.authDir);
    expect(state.connectionInstances[0]!.contactsDir.observe).toHaveBeenCalledWith('sender-1@s.whatsapp.net', 'Sender One');
    expect(state.connectionInstances[0]!.contactsDir.observe).toHaveBeenCalledWith('sender-2@s.whatsapp.net', 'Sender Two');
  });

  it('imports from the first existing legacy database when a named instance starts empty', async () => {
    setInstanceConfig({ name: 'q', type: 'chat' });
    state.getMessageCountReturn = 0;
    state.existsSync.mockImplementation((path: string) => path.endsWith('/whatsapp-instances/q/bot.db'));

    await importMainAndFlushStart();

    expect(state.databaseInstances[0]!.importFromLegacyDb).toHaveBeenCalledOnce();
    const importCalls = state.databaseInstances[0]!.importFromLegacyDb.mock.calls as unknown as Array<[string]>;
    expect(importCalls[0]![0]).toMatch(/whatsapp-instances\/q\/bot\.db$/);
  });

  it('continues startup when a legacy database import fails', async () => {
    setInstanceConfig({ name: 'q', type: 'chat' });
    state.getMessageCountReturn = 0;
    state.existsSync.mockImplementation((path: string) => path.endsWith('/whatsapp-instances/q/bot.db'));
    state.legacyImportError = new Error('import failed');

    await importMainAndFlushStart();

    expect(state.databaseInstances[0]!.importFromLegacyDb).toHaveBeenCalledOnce();
    expect(state.chatRuntimeInstances).toHaveLength(1);
  });

  it('starts memory consolidation only when enabled enrichment is ready', async () => {
    state.config.memory.consolidation.enabled = true;
    state.config.memory.consolidation.intervalHours = 2;
    state.config.memory.consolidation.lookbackDays = 14;
    state.config.memory.consolidation.dryRun = false;
    state.pineconeReadiness = { index: 'whatsoup-memory', state: 'ready' };

    await importMainAndFlushStart();

    expect(state.memorySchedulers).toHaveLength(1);
    expect(state.memorySchedulers[0]!.args[2]).toEqual({
      intervalMs: 2 * 60 * 60 * 1000,
      lookbackDays: 14,
      dryRun: false,
    });
    expect(state.memorySchedulers[0]!.start).toHaveBeenCalledOnce();
  });

  it('warns instead of starting memory consolidation when readiness is not ready', async () => {
    state.config.memory.consolidation.enabled = true;
    state.pineconeReadiness = { index: 'whatsoup-memory', state: 'missing' };

    await importMainAndFlushStart();

    expect(state.memorySchedulers).toHaveLength(0);
    expect(state.chatRuntimeInstances).toHaveLength(1);
  });

  it('starts without admin phones and skips startup notifications', async () => {
    state.config.adminPhones = new Set();

    await importMainAndFlushStart();

    expect(state.insertAllowed).not.toHaveBeenCalled();
    expect(state.sendTracked).not.toHaveBeenCalled();
  });

  it('suppresses non-fatal temp-file ENOENT uncaught exceptions', async () => {
    await importMainAndFlushStart();

    processHandler('uncaughtException')(Object.assign(new Error('missing temp'), {
      code: 'ENOENT',
      path: '/tmp/whatsoup-transient-file',
    }));

    expect(state.exitCodes).toEqual([]);
  });

  it('routes fatal uncaught exceptions through failure shutdown', async () => {
    await importMainAndFlushStart();
    state.throwOnExit = false;

    processHandler('uncaughtException')(new Error('boom'));
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }

    expect(state.shutdownExitCode).toHaveBeenCalledWith('uncaughtException');
    expect(state.exitCodes).toContain(1);
  });

  it('routes unhandled rejections through failure shutdown', async () => {
    await importMainAndFlushStart();
    state.throwOnExit = false;

    processHandler('unhandledRejection')(new Error('rejected'));
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }

    expect(state.shutdownExitCode).toHaveBeenCalledWith('unhandledRejection');
    expect(state.exitCodes).toContain(1);
  });

  it('shuts down with a failure exit code when startup fails', async () => {
    state.throwOnExit = false;
    state.runtimeStartError = new Error('start failed');

    await importMainAndFlushStart();

    expect(state.shutdownExitCode).toHaveBeenCalledWith('startupError');
    expect(state.exitCodes).toContain(1);
  });

  it('still closes database and exits cleanly when runtime shutdown fails', async () => {
    await importMainAndFlushStart();

    const runtime = state.chatRuntimeInstances[0]!;
    runtime.shutdown.mockRejectedValueOnce(new Error('shutdown failed'));

    await expect(Promise.resolve(processHandler('SIGINT')())).rejects.toThrow('process.exit(0)');

    expect(state.databaseInstances[0]!.close).toHaveBeenCalledOnce();
    expect(state.unlinkSync).toHaveBeenCalledWith(state.config.lockPath);
    expect(state.exitCodes).toEqual([0]);
  });

  it('writes a diagnostic line for non-zero process exits', async () => {
    await importMainAndFlushStart();

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const exitHandlers = state.processHandlers
        .filter((handler) => handler.event === 'exit')
        .map((handler) => handler.listener as (code: number) => void);
      expect(exitHandlers.length).toBeGreaterThan(1);
      exitHandlers.at(-1)!(7);
      expect(stderrWrite).toHaveBeenCalledWith('exit code 7\n');
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('removes a corrupt existing lock file and retries acquisition', async () => {
    state.openSync
      .mockImplementationOnce(() => { throw eexist(); })
      .mockImplementationOnce(() => 55);
    state.readFileSync.mockReturnValueOnce('{ not-json');

    await importMainAndFlushStart();

    expect(state.unlinkSync).toHaveBeenCalledWith(state.config.lockPath);
    expect(state.openSync).toHaveBeenCalledTimes(2);
    expect(state.writeFileSync).toHaveBeenCalledWith(55, expect.any(String));
    expect(state.exitCodes).toEqual([]);
    expect(state.databaseInstances).toHaveLength(1);
  });

  it('removes a stale lock owner and retries acquisition', async () => {
    state.openSync
      .mockImplementationOnce(() => { throw eexist(); })
      .mockImplementationOnce(() => 56);
    state.readFileSync.mockReturnValueOnce(JSON.stringify({ pid: 12345, startedAt: '2026-06-10T00:00:00.000Z' }));
    state.killImpl.mockImplementationOnce(() => { throw esrch(); });

    await importMainAndFlushStart();

    expect(process.kill).toHaveBeenCalledWith(12345, 0);
    expect(state.unlinkSync).toHaveBeenCalledWith(state.config.lockPath);
    expect(state.openSync).toHaveBeenCalledTimes(2);
    expect(state.writeFileSync).toHaveBeenCalledWith(56, expect.any(String));
    expect(state.exitCodes).toEqual([]);
  });

  it('exits before opening the database when another lock owner is alive', async () => {
    state.openSync.mockImplementation(() => { throw eexist(); });
    state.readFileSync.mockReturnValueOnce(JSON.stringify({ pid: 23456, startedAt: '2026-06-10T00:00:00.000Z' }));
    state.killImpl.mockImplementationOnce(() => { throw eperm(); });

    await expect(import('../src/main.ts')).rejects.toThrow('process.exit(1)');

    expect(process.kill).toHaveBeenCalledWith(23456, 0);
    expect(state.exitCodes).toEqual([1]);
    expect(state.databaseInstances).toHaveLength(0);
    expect(state.writeFileSync).not.toHaveBeenCalled();
  });

  it('routes agent INSTANCE_CONFIG into AgentRuntime and ingest wiring', async () => {
    const agentOptions = {
      sessionScope: 'shared',
      cwd: '~/agent-work',
      instructionsPath: '/tmp/instructions.md',
      sandbox: {
        allowedPaths: ['/tmp/work'],
        allowedTools: ['Read'],
        allowedMcpTools: ['mcp__whatsoup__list_chats'],
        bash: { enabled: true },
      },
      sandboxPerChat: true,
      pluginDirs: ['~/agent-plugin'],
      enabledPlugins: { github: true },
      allowM365Mutations: false,
      autoCompactInputTokens: 123456,
    };
    setInstanceConfig({
      type: 'agent',
      systemPrompt: 'Agent-specific system prompt',
      agentOptions,
      introSent: true,
    });
    state.agentStartupMessage = { chatJid: 'resume-chat@s.whatsapp.net', text: 'resume text' };

    await importMainAndFlushStart();

    expect(state.agentRuntimeInstances).toHaveLength(1);
    expect(state.chatRuntimeInstances).toHaveLength(0);
    expect(state.passiveRuntimeInstances).toHaveLength(0);
    expect(state.resolveAgentModel).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent',
      agentOptions,
    }));

    const runtime = state.agentRuntimeInstances[0]!;
    expect(runtime.args[2]).toBe(state.config.botName);
    expect(runtime.args[3]).toMatchObject({
      shared: true,
      sessionScope: 'shared',
      cwd: `${homedir()}/agent-work`,
      configSystemPrompt: 'Agent-specific system prompt',
      instructionsPath: '/tmp/instructions.md',
      sandbox: agentOptions.sandbox,
      model: state.resolvedAgentModel,
      sandboxPerChat: true,
      pluginDirs: [`${homedir()}/agent-plugin`],
      enabledPlugins: { github: true },
      allowM365Mutations: false,
      autoCompactInputTokens: 123456,
    });
    expect(state.createIngestHandler.mock.calls[0]![6]).toBe('agent');
    expect(state.startHealthServer.mock.calls[0]![0]).toEqual(expect.objectContaining({
      instanceType: 'agent',
      instanceName: state.config.botName,
    }));

    await vi.advanceTimersByTimeAsync(3_000);
    expect(runtime.popStartupMessage).toHaveBeenCalledOnce();
    expect(state.sendTracked).toHaveBeenCalledWith(
      state.connectionInstances[0],
      'resume-chat@s.whatsapp.net',
      'resume text',
      state.durabilityInstances[0],
      { replayPolicy: 'safe' },
    );
  });

  it('uses agent-specific introduction copy on first boot', async () => {
    setInstanceConfig({
      type: 'agent',
      introSent: false,
    });

    await importMainAndFlushStart();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(state.sendTracked).toHaveBeenCalledWith(
      state.connectionInstances[0],
      '15550000001@s.whatsapp.net',
      expect.stringContaining("I'm an AI agent with tool access"),
      state.durabilityInstances[0],
      { replayPolicy: 'safe' },
    );
  });

  it('sends the default agent restart ping when no resume message is pending', async () => {
    setInstanceConfig({
      type: 'agent',
      introSent: true,
    });

    await importMainAndFlushStart();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(state.sendTracked).toHaveBeenCalledWith(
      state.connectionInstances[0],
      '15550000001@s.whatsapp.net',
      '*Agent back online* ✓',
      state.durabilityInstances[0],
      { replayPolicy: 'safe' },
    );
  });

  it('routes passive INSTANCE_CONFIG into PassiveRuntime and suppresses startup notifications', async () => {
    const paths = {
      configRoot: '/tmp/passive/config',
      dataRoot: '/tmp/passive/data',
      stateRoot: '/tmp/passive/state',
      authDir: '/tmp/passive/config/auth',
      dbPath: '/tmp/passive/data/bot.db',
      logDir: '/tmp/passive/data/logs',
      lockPath: '/tmp/passive/state/whatsoup.lock',
      mediaDir: '/tmp/passive/data/media/tmp',
    };
    setInstanceConfig({
      type: 'passive',
      paths,
      socketPath: '/tmp/passive/state/custom.sock',
      introSent: false,
    });

    await importMainAndFlushStart();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(state.passiveRuntimeInstances).toHaveLength(1);
    expect(state.agentRuntimeInstances).toHaveLength(0);
    expect(state.chatRuntimeInstances).toHaveLength(0);
    expect(state.passiveRuntimeInstances[0]!.args[2]).toEqual({
      name: state.config.botName,
      paths,
      socketPath: '/tmp/passive/state/custom.sock',
    });
    expect(state.createIngestHandler.mock.calls[0]![6]).toBe('passive');
    expect(state.startHealthServer.mock.calls[0]![0]).toEqual(expect.objectContaining({
      instanceType: 'passive',
      instanceName: state.config.botName,
    }));
    expect(state.persistIntroSentFlag).not.toHaveBeenCalled();
    expect(state.sendTracked).not.toHaveBeenCalled();
  });

  it('persists introSent before scheduling an introduction send', async () => {
    setInstanceConfig({
      type: 'chat',
      introSent: false,
    });
    state.existsSync.mockImplementation((path: string) => path === `${state.config.configRoot}/config.json`);

    await importMainAndFlushStart();

    expect(state.persistIntroSentFlag).toHaveBeenCalledWith(`${state.config.configRoot}/config.json`, true);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(state.sendTracked).toHaveBeenCalledWith(
      state.connectionInstances[0],
      '15550000001@s.whatsapp.net',
      expect.stringContaining('*Loops* is online and ready'),
      state.durabilityInstances[0],
      { replayPolicy: 'safe' },
    );
  });
});
