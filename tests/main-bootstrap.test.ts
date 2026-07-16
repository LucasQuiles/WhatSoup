import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MainHarness = Awaited<ReturnType<typeof importMainWithMocks>>;

type HealthServerDepsForTest = {
  handleAccessDecision: (subjectType: string, subjectId: string, action: string) => Promise<void>;
  getEnrichmentStats: () => unknown;
};

class FakeConnection extends EventEmitter {
  botJid: string | null = 'bot@s.whatsapp.net';
  botLid: string | null = 'bot@lid';
  onMessage: ((msg: unknown) => void) | null = null;
  contactsDir = {
    invalidateLidCache: vi.fn(),
    setDatabase: vi.fn(),
    observe: vi.fn(),
    size: 0,
  };
  presenceCache = {};
  connect = vi.fn(async () => {});
  shutdown = vi.fn();
  sendRaw = vi.fn(async () => ({ waMessageId: 'raw-1' }));
  sendPollMessage = vi.fn(async () => ({ waMessageId: 'poll-1', hasSecret: false }));
  getSocket = vi.fn(() => null);
  setIdentityStore = vi.fn();
}

function runtimeStub() {
  return {
    start: vi.fn(async () => {}),
    setDurability: vi.fn(),
    getHealthSnapshot: vi.fn(() => ({
      status: 'healthy',
      details: { enrichmentLastRunAt: '2026-06-14T00:00:00.000Z' },
    })),
    shutdown: vi.fn(async () => {}),
    handleMessage: vi.fn(async () => {}),
    handleJidAliasChanged: vi.fn(),
    handleDatabaseCompatibilityRejection: vi.fn(),
  };
}

function installProcessOnCapture() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const onSpy = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    const key = String(event);
    const current = handlers.get(key) ?? [];
    current.push(listener as (...args: unknown[]) => unknown);
    handlers.set(key, current);
    return process;
  });
  return { handlers, onSpy };
}

async function importMainWithMocks(options: {
  instanceConfig?: Record<string, unknown> | null;
  pineconeState?: 'ready' | 'missing_index';
  accessMode?: 'self_only' | 'allowlist';
  adminPhones?: string[];
  existingPaths?: string[];
  messageCount?: number;
} = {}) {
  vi.resetModules();
  vi.useFakeTimers();

  if (options.instanceConfig === null || options.instanceConfig === undefined) {
    delete process.env.INSTANCE_CONFIG;
  } else {
    process.env.INSTANCE_CONFIG = JSON.stringify(options.instanceConfig);
  }
  process.env.XDG_DATA_HOME = '/tmp/whatsoup-main-data';
  process.env.XDG_CONFIG_HOME = '/tmp/whatsoup-main-config';
  process.env.TMPDIR = '/tmp/whatsoup-main-tmp';

  const existingPaths = new Set(options.existingPaths ?? []);
  const processOn = installProcessOnCapture();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  };
  const dbRows = [
    { sender_jid: '15551230000@s.whatsapp.net', sender_name: 'Ada' },
  ];
  const db = {
    raw: {
      prepare: vi.fn(() => ({
        all: vi.fn(() => dbRows),
      })),
    },
    open: vi.fn(),
    close: vi.fn(),
    clearChat: vi.fn(() => 2),
    importFromLegacyDb: vi.fn(),
  };
  const connection = new FakeConnection();
  const chatRuntime = runtimeStub();
  const passiveRuntime = runtimeStub();
  const agentInstances: Array<ReturnType<typeof runtimeStub> & { popStartupMessage: ReturnType<typeof vi.fn> }> = [];
  const healthServer = { close: vi.fn() };
  const memoryScheduler = { start: vi.fn(), stop: vi.fn(async () => {}) };
  const mediaRetentionTimer = { start: vi.fn(), stop: vi.fn() };
  const processTmpRetentionTimer = { start: vi.fn(), stop: vi.fn() };
  const databaseRetentionTimer = { start: vi.fn(), stop: vi.fn() };
  const messageScheduler = { recoverStale: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const triggerPoller = { start: vi.fn(), stop: vi.fn() };
  const durability = {
    preConnectRecovery: vi.fn(),
    postConnectRecovery: vi.fn(),
    sweepStaleSubmitted: vi.fn(),
  };
  let capturedHealthDeps: HealthServerDepsForTest | null = null;
  const getHealthDeps = () => {
    if (!capturedHealthDeps) {
      throw new Error('health server dependencies were not captured');
    }
    return capturedHealthDeps;
  };
  const config = {
    botName: 'q',
    pineconeIndex: 'mw-mind',
    pineconeSearchMode: 'hybrid',
    pineconeRerank: true,
    pineconeTopK: 8,
    accessMode: options.accessMode ?? 'allowlist',
    models: {
      conversation: 'claude-sonnet',
      extraction: 'gpt-4.1-mini',
      validation: 'gpt-4.1-mini',
      fallback: 'gpt-4.1',
    },
    adminPhones: new Set(options.adminPhones ?? ['15551230000']),
    lockPath: '/tmp/whatsoup-main.lock',
    dbPath: '/tmp/whatsoup-main.db',
    chatAliases: { q: '15551230000@s.whatsapp.net' },
    profiles: { q: { displayName: 'Q' } },
    authDir: '/tmp/whatsoup-main-auth',
    memory: {
      consolidation: {
        enabled: true,
        intervalHours: 6,
        lookbackDays: 7,
        dryRun: false,
      },
      sweep: { beadProposeMin: 0.55, beadUpdateMin: 0.80, lookbackHours: 48, reviewByDays: 7, overdueProposalAlertThreshold: 10 },
      pinecone: { allowedIndexes: [] },
      fileWatch: { allowedRoots: [] },
    },
    advanced: { enableRelayMessage: false, enableResync: false, relayMaxPayloadBytes: 1_048_576, enableUrlWatch: false },
    controlPeers: new Set(['q']),
    configRoot: '/tmp/whatsoup-main-config-root',
    adminReplayMax: 5,
    retentionDays: 30,
    enrichmentIntervalMs: 60_000,
    mediaDir: '/tmp/whatsoup-main-media/tmp',
    mediaRetention: {
      intervalHours: 1,
      tempHours: 1,
      cacheHours: 24,
    },
    dataRoot: '/tmp/whatsoup-main-data-root',
    startupNotifications: true,
    toolUpdateMode: 'full',
  };

  const Database = vi.fn(function () {
    return db;
  });
  const DurabilityEngine = vi.fn(function () {
    return durability;
  });
  const ChatRuntime = vi.fn(function () {
    return chatRuntime;
  });
  const PassiveRuntime = vi.fn(function () {
    return passiveRuntime;
  });
  const AgentRuntime = vi.fn(function (this: any) {
    const runtime = runtimeStub() as ReturnType<typeof runtimeStub> & {
      popStartupMessage: ReturnType<typeof vi.fn>;
    };
    runtime.popStartupMessage = vi.fn(() => null);
    Object.assign(this, runtime);
    agentInstances.push(this);
  });

  const mocks = {
    logger,
    db,
    connection,
    chatRuntime,
    passiveRuntime,
    agentInstances,
    healthServer,
    memoryScheduler,
    mediaRetentionTimer,
    processTmpRetentionTimer,
    databaseRetentionTimer,
    messageScheduler,
    triggerPoller,
    durability,
    config,
    Database,
    DurabilityEngine,
    ChatRuntime,
    PassiveRuntime,
    AgentRuntime,
    storeDecryptionFailure: vi.fn(),
    cleanupOldRateLimits: vi.fn(() => 1),
    deleteOldMessages: vi.fn(() => 1),
    getMessagesBySender: vi.fn(() => [{
      messageId: 'queued-1',
      chatJid: '15551230000@s.whatsapp.net',
      senderJid: '15551230000@s.whatsapp.net',
      senderName: 'Ada',
      content: { conversation: 'hello' },
      contentText: 'hello',
      contentType: 'text',
      timestamp: 123,
      quotedMessageId: null,
    }]),
    getMessageCount: vi.fn(() => options.messageCount ?? 1),
    getUnprocessedCount: vi.fn(() => 4),
    processHistoryBatch: vi.fn(() => ({ inserted: 1, upgraded: 0, placeholders: 0, skipped: 0 })),
    execFileSync: vi.fn(),
    existsSync: vi.fn((path: string) => existingPaths.has(path)),
    createConnection: vi.fn(() => connection),
    resolveLatestPluginDir: vi.fn((dir: string) => `${dir}-latest`),
    resolveAgentModel: vi.fn(() => 'claude-sonnet'),
    PineconeMemory: vi.fn(function () {}),
    getPineconeReadiness: vi.fn(async () => ({
      index: 'mw-mind',
      state: options.pineconeState ?? 'ready',
    })),
    createAnthropicProvider: vi.fn(() => ({ name: 'anthropic' })),
    createOpenAIProvider: vi.fn(() => ({ name: 'openai' })),
    withDatabaseCompatibility: vi.fn((
      _db: unknown,
      provider: { name: string },
      _onCompatibilityRejection?: (rejection: Error) => void,
    ) => ({
      name: provider.name,
      guardedProvider: provider,
    })),
    MemoryConsolidationScheduler: vi.fn(function () {
      return memoryScheduler;
    }),
    startHealthServer: vi.fn((deps: HealthServerDepsForTest) => {
      capturedHealthDeps = deps;
      return healthServer;
    }),
    checkDegradationSignals: vi.fn(),
    createIngestHandler: vi.fn(() => vi.fn()),
    toConversationKey: vi.fn((jid: string) => `conversation:${jid}`),
    toPersonalJid: vi.fn((phone: string) => `${phone}@s.whatsapp.net`),
    toLidJid: vi.fn((phone: string) => `${phone}@lid`),
    selectReplayableDms: vi.fn((stored: unknown[]) => ({ toReplay: stored, groupSkipped: 1 })),
    rememberReplayedId: vi.fn(),
    sendTracked: vi.fn(async () => ({ waMessageId: 'sent-1' })),
    drainPendingOutbound: vi.fn(async () => 0),
    waitForHistorySyncThenRecover: vi.fn(async ({ recover }: { recover: () => unknown }) => {
      await recover();
    }),
    seedChatAliases: vi.fn(() => 1),
    createProfileRegistry: vi.fn(() => ({ profiles: ['q'] })),
    createOutboundSendsWriter: vi.fn(() => ({ write: vi.fn() })),
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
    lookupAccess: vi.fn(() => null),
    updateAccess: vi.fn(),
    insertAllowed: vi.fn(),
    seedAutoRespondGroups: vi.fn(() => 0),
    resolvePhoneFromJid: vi.fn(() => '15551230000'),
    hydrateLidMappings: vi.fn(() => 1),
    upsertLidMapping: vi.fn(),
    mineMessageKey: vi.fn(() => ({ lid: 'user@lid', phoneJid: '15551230000@s.whatsapp.net' })),
    mineGroupParticipants: vi.fn(() => 1),
    reconcileLidMappings: vi.fn(() => ({ hydrated: 1, unresolvedLids: ['stale@lid'] })),
    setLidAuthDir: vi.fn(),
    isAdminPhone: vi.fn(() => true),
    handleGroupsUpsert: vi.fn(),
    handleGroupsUpdate: vi.fn(),
    MediaRetentionTimer: vi.fn(function () {
      return mediaRetentionTimer;
    }),
    ProcessTmpRetentionTimer: vi.fn(function () {
      return processTmpRetentionTimer;
    }),
    DatabaseRetentionTimer: vi.fn(function () {
      return databaseRetentionTimer;
    }),
    persistIntroSentFlag: vi.fn(),
    MessageScheduler: vi.fn(function () {
      return messageScheduler;
    }),
    TriggerPoller: vi.fn(function () {
      return triggerPoller;
    }),
    backfillMetrics: vi.fn(),
    collectHourlyMetrics: vi.fn(),
    startModelCurrencyMonitor: vi.fn(),
    acquireProcessLock: vi.fn(() => ({ path: '/tmp/whatsoup-main.lock' })),
    isProcessLockError: vi.fn(() => false),
    releaseProcessLock: vi.fn(() => true),
    flushLogger: vi.fn(async () => {}),
  };

  vi.doMock('../src/config.ts', () => ({ config }));
  vi.doMock('../src/logger.ts', () => ({
    default: logger,
    createChildLogger: vi.fn(() => logger),
    flushLogger: mocks.flushLogger,
  }));
  vi.doMock('../src/core/database.ts', () => ({
    Database,
    storeDecryptionFailure: mocks.storeDecryptionFailure,
  }));
  vi.doMock('../src/runtimes/chat/rate-limits-db.ts', () => ({
    cleanupOldRateLimits: mocks.cleanupOldRateLimits,
  }));
  vi.doMock('../src/core/messages.ts', () => ({
    deleteOldMessages: mocks.deleteOldMessages,
    getMessagesBySender: mocks.getMessagesBySender,
    getMessageCount: mocks.getMessageCount,
    getUnprocessedCount: mocks.getUnprocessedCount,
  }));
  vi.doMock('../src/core/history-sync.ts', () => ({
    processHistoryBatch: mocks.processHistoryBatch,
  }));
  vi.doMock('node:fs', async (importOriginal: () => Promise<typeof import('node:fs')>) => ({
    ...(await importOriginal()),
    existsSync: mocks.existsSync,
  }));
  vi.doMock('node:child_process', async (importOriginal: () => Promise<typeof import('node:child_process')>) => ({
    ...(await importOriginal()),
    execFileSync: mocks.execFileSync,
  }));
  vi.doMock('../src/transport/factory.ts', () => ({ createConnection: mocks.createConnection }));
  vi.doMock('../src/runtimes/chat/runtime.ts', () => ({ ChatRuntime }));
  vi.doMock('../src/runtimes/agent/runtime.ts', () => ({ AgentRuntime }));
  vi.doMock('../src/runtimes/passive/runtime.ts', () => ({ PassiveRuntime }));
  vi.doMock('../src/runtimes/agent/plugin-dir-resolver.ts', () => ({ resolveLatestPluginDir: mocks.resolveLatestPluginDir }));
  vi.doMock('../src/instance-loader.ts', () => ({ resolveAgentModel: mocks.resolveAgentModel }));
  vi.doMock('../src/runtimes/chat/providers/pinecone.ts', () => ({
    PineconeMemory: mocks.PineconeMemory,
    getPineconeReadiness: mocks.getPineconeReadiness,
  }));
  vi.doMock('../src/runtimes/chat/providers/anthropic.ts', () => ({ createAnthropicProvider: mocks.createAnthropicProvider }));
  vi.doMock('../src/runtimes/chat/providers/openai.ts', () => ({ createOpenAIProvider: mocks.createOpenAIProvider }));
  vi.doMock('../src/runtimes/chat/providers/database-compatibility.ts', () => ({
    withDatabaseCompatibility: mocks.withDatabaseCompatibility,
  }));
  vi.doMock('../src/memory/consolidation-scheduler.ts', () => ({
    MemoryConsolidationScheduler: mocks.MemoryConsolidationScheduler,
  }));
  vi.doMock('../src/core/health.ts', () => ({ startHealthServer: mocks.startHealthServer }));
  vi.doMock('../src/core/heal.ts', () => ({ checkDegradationSignals: mocks.checkDegradationSignals }));
  vi.doMock('../src/core/ingest.ts', () => ({ createIngestHandler: mocks.createIngestHandler }));
  vi.doMock('../src/core/conversation-key.ts', () => ({ toConversationKey: mocks.toConversationKey }));
  vi.doMock('../src/core/jid-constants.ts', () => ({
    toPersonalJid: mocks.toPersonalJid,
    toLidJid: mocks.toLidJid,
  }));
  vi.doMock('../src/core/admin.ts', () => ({
    selectReplayableDms: mocks.selectReplayableDms,
    rememberReplayedId: mocks.rememberReplayedId,
  }));
  vi.doMock('../src/core/durability.ts', () => ({
    DurabilityEngine,
    sendTracked: mocks.sendTracked,
    drainPendingOutbound: mocks.drainPendingOutbound,
  }));
  vi.doMock('../src/core/post-connect-recovery.ts', () => ({
    waitForHistorySyncThenRecover: mocks.waitForHistorySyncThenRecover,
  }));
  vi.doMock('../src/core/chats-resolver.ts', () => ({ seedChatAliases: mocks.seedChatAliases }));
  vi.doMock('../src/core/profiles.ts', () => ({ createProfileRegistry: mocks.createProfileRegistry }));
  vi.doMock('../src/core/outbound-sends.ts', () => ({
    createOutboundSendsWriter: mocks.createOutboundSendsWriter,
  }));
  vi.doMock('../src/core/contacts-sync.ts', () => ({
    handleContactsUpsert: mocks.handleContactsUpsert,
    handleContactsUpdate: mocks.handleContactsUpdate,
  }));
  vi.doMock('../src/core/chat-sync.ts', () => ({
    handleReaction: mocks.handleReaction,
    handleReceipt: mocks.handleReceipt,
    handleChatsUpsert: mocks.handleChatsUpsert,
    handleChatsUpdate: mocks.handleChatsUpdate,
    handleChatsDelete: mocks.handleChatsDelete,
  }));
  vi.doMock('../src/core/label-sync.ts', () => ({
    handleLabelsEdit: mocks.handleLabelsEdit,
    handleLabelsAssociation: mocks.handleLabelsAssociation,
    cleanupOrphanedAssociations: mocks.cleanupOrphanedAssociations,
  }));
  vi.doMock('../src/core/blocklist-sync.ts', () => ({
    handleBlocklistSet: mocks.handleBlocklistSet,
    handleBlocklistUpdate: mocks.handleBlocklistUpdate,
  }));
  vi.doMock('../src/core/access-list.ts', () => ({
    lookupAccess: mocks.lookupAccess,
    updateAccess: mocks.updateAccess,
    insertAllowed: mocks.insertAllowed,
    seedAutoRespondGroups: mocks.seedAutoRespondGroups,
    resolvePhoneFromJid: mocks.resolvePhoneFromJid,
  }));
  vi.doMock('../src/core/lid-resolver.ts', () => ({
    hydrateLidMappings: mocks.hydrateLidMappings,
    upsertLidMapping: mocks.upsertLidMapping,
    mineMessageKey: mocks.mineMessageKey,
    mineGroupParticipants: mocks.mineGroupParticipants,
    reconcileLidMappings: mocks.reconcileLidMappings,
    setLidAuthDir: mocks.setLidAuthDir,
  }));
  vi.doMock('../src/lib/phone.ts', () => ({ isAdminPhone: mocks.isAdminPhone }));
  vi.doMock('../src/core/group-sync.ts', () => ({
    handleGroupsUpsert: mocks.handleGroupsUpsert,
    handleGroupsUpdate: mocks.handleGroupsUpdate,
  }));
  vi.doMock('../src/core/media-retention.ts', () => ({ MediaRetentionTimer: mocks.MediaRetentionTimer }));
  vi.doMock('../src/core/process-tmp-retention.ts', () => ({
    ProcessTmpRetentionTimer: mocks.ProcessTmpRetentionTimer,
    DEFAULT_PROCESS_TMP_RETENTION: { intervalMs: 12_000 },
  }));
  vi.doMock('../src/core/database-retention.ts', () => ({
    DatabaseRetentionTimer: mocks.DatabaseRetentionTimer,
    DEFAULT_DATABASE_RETENTION: { intervalMs: 60_000 },
  }));
  vi.doMock('../src/core/intro-sent-config.ts', () => ({ persistIntroSentFlag: mocks.persistIntroSentFlag }));
  vi.doMock('../src/core/scheduler.ts', () => ({ MessageScheduler: mocks.MessageScheduler }));
  vi.doMock('../src/core/substrate/poller.ts', () => ({ TriggerPoller: mocks.TriggerPoller }));
  vi.doMock('../src/core/metrics-collector.ts', () => ({
    backfillMetrics: mocks.backfillMetrics,
    collectHourlyMetrics: mocks.collectHourlyMetrics,
  }));
  vi.doMock('../src/lib/model-advisor.ts', () => ({
    startModelCurrencyMonitor: mocks.startModelCurrencyMonitor,
  }));
  vi.doMock('../src/lib/process-lock.ts', () => ({
    acquireProcessLock: mocks.acquireProcessLock,
    isProcessLockError: mocks.isProcessLockError,
    releaseProcessLock: mocks.releaseProcessLock,
  }));

  await import('../src/main.ts');
  await vi.waitFor(() => expect(connection.connect).toHaveBeenCalledOnce());

  return { ...mocks, processOn, getHealthDeps };
}

describe('main bootstrap', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.INSTANCE_CONFIG = process.env.INSTANCE_CONFIG;
    savedEnv.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
    savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    savedEnv.TMPDIR = process.env.TMPDIR;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('boots the default chat runtime and wires recovery, health, timers, and connection handlers', async () => {
    const h = await importMainWithMocks();

    expect(h.acquireProcessLock).toHaveBeenCalledWith('/tmp/whatsoup-main.lock');
    expect(h.db.open).toHaveBeenCalledOnce();
    expect(h.seedChatAliases).toHaveBeenCalledWith(h.db.raw, h.config.chatAliases);
    expect(h.insertAllowed).toHaveBeenCalledWith(h.db, 'phone', '15551230000');
    expect(h.setLidAuthDir).toHaveBeenCalledWith('/tmp/whatsoup-main-auth');
    expect(h.hydrateLidMappings).toHaveBeenCalledWith(h.db, '/tmp/whatsoup-main-auth');
    expect(h.DurabilityEngine).toHaveBeenCalledWith(h.db);
    expect(h.durability.preConnectRecovery).toHaveBeenCalledOnce();
    expect(h.startModelCurrencyMonitor).toHaveBeenCalledWith('q', expect.objectContaining({
      conversation: 'claude-sonnet',
      agent: 'claude-sonnet',
    }));
    expect(h.withDatabaseCompatibility).toHaveBeenCalledTimes(2);
    expect(h.withDatabaseCompatibility).toHaveBeenNthCalledWith(
      1,
      h.db,
      h.createAnthropicProvider.mock.results[0]?.value,
      expect.any(Function),
    );
    expect(h.withDatabaseCompatibility).toHaveBeenNthCalledWith(
      2,
      h.db,
      h.createOpenAIProvider.mock.results[0]?.value,
      expect.any(Function),
    );
    const compatibilityHandler = h.withDatabaseCompatibility.mock.calls[0]?.[2] as
      | ((rejection: Error) => void)
      | undefined;
    expect(compatibilityHandler).toBe(h.withDatabaseCompatibility.mock.calls[1]?.[2]);
    const guardedAnthropic = h.withDatabaseCompatibility.mock.results[0]?.value;
    const guardedOpenAI = h.withDatabaseCompatibility.mock.results[1]?.value;
    expect(h.ChatRuntime).toHaveBeenCalledWith(
      h.db,
      h.connection,
      expect.any(Object),
      guardedAnthropic,
      guardedOpenAI,
      expect.objectContaining({ enableEnrichment: true, botName: 'q' }),
    );
    expect(h.MemoryConsolidationScheduler).toHaveBeenCalledWith(
      expect.any(Object),
      guardedAnthropic,
      expect.any(Object),
    );
    expect(h.memoryScheduler.start).toHaveBeenCalledOnce();
    expect(h.ChatRuntime.mock.invocationCallOrder[0])
      .toBeLessThan(h.memoryScheduler.start.mock.invocationCallOrder[0]!);
    const compatibilityRejection = new Error('future schema');
    compatibilityHandler?.(compatibilityRejection);
    expect(h.chatRuntime.handleDatabaseCompatibilityRejection)
      .toHaveBeenCalledWith(compatibilityRejection);
    expect(h.memoryScheduler.stop).toHaveBeenCalledOnce();
    expect(h.chatRuntime.setDurability).toHaveBeenCalledWith(h.durability);
    expect(h.createIngestHandler).toHaveBeenCalledWith(
      h.db,
      h.connection,
      h.chatRuntime,
      expect.any(Function),
      expect.any(Function),
      h.durability,
      'chat',
      undefined, // grantManager — only agent instances construct one
    );
    expect(h.startHealthServer).toHaveBeenCalledWith(expect.objectContaining({
      db: h.db,
      connectionManager: h.connection,
      durability: h.durability,
      runtime: h.chatRuntime,
      instanceName: 'q',
      instanceType: 'chat',
      accessMode: 'allowlist',
    }));
    expect(h.mediaRetentionTimer.start).toHaveBeenCalledOnce();
    expect(h.processTmpRetentionTimer.start).toHaveBeenCalledWith(12_000);
    expect(h.databaseRetentionTimer.start).toHaveBeenCalledWith(60_000);
    // #1445 QR-012: the retired standalone messages retention read
    // config.retentionDays directly — confirm that knob now flows into the
    // unified sweep's config instead of silently reverting to a hardcoded default.
    expect(h.DatabaseRetentionTimer).toHaveBeenCalledWith(
      h.db,
      expect.objectContaining({ messageRetentionDays: 30 }),
    );
    expect(h.messageScheduler.recoverStale).toHaveBeenCalledOnce();
    expect(h.messageScheduler.start).toHaveBeenCalledOnce();
    expect(h.triggerPoller.start).toHaveBeenCalledOnce();
    expect(h.connection.contactsDir.setDatabase).toHaveBeenCalledWith(h.db);
    expect(h.connection.contactsDir.observe).toHaveBeenCalledWith('15551230000@s.whatsapp.net', 'Ada');
    expect(h.chatRuntime.start).toHaveBeenCalledOnce();
    expect(h.connection.connect).toHaveBeenCalledOnce();
    expect(h.waitForHistorySyncThenRecover).toHaveBeenCalledOnce();
    expect(h.durability.postConnectRecovery).toHaveBeenCalledOnce();
    expect(h.processOn.handlers.get('SIGTERM')).toHaveLength(1);
    expect(h.processOn.handlers.get('uncaughtException')).toHaveLength(1);

    const healthDeps = h.getHealthDeps();
    await healthDeps.handleAccessDecision('phone', '15551230000', 'allow');
    expect(h.getMessagesBySender).toHaveBeenCalledWith(h.db, '15551230000@s.whatsapp.net');
    expect(h.getMessagesBySender).toHaveBeenCalledWith(h.db, '15551230000@lid');
    expect(h.rememberReplayedId).toHaveBeenCalledWith('queued-1');
    expect(h.chatRuntime.handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'queued-1',
      isGroup: false,
      isResponseWorthy: true,
    }));
    expect(healthDeps.getEnrichmentStats()).toEqual({
      lastRun: '2026-06-14T00:00:00.000Z',
      unprocessed: 4,
      runtimeDegraded: false,
    });
    h.getUnprocessedCount.mockImplementationOnce(() => {
      throw new Error('stats failed');
    });
    expect(healthDeps.getEnrichmentStats()).toEqual({
      lastRun: '2026-06-14T00:00:00.000Z',
      unprocessed: 0,
      runtimeDegraded: false,
    });

    h.connection.emit('chatCleared', 'chat@s.whatsapp.net');
    expect(h.db.clearChat).toHaveBeenCalledWith('conversation:chat@s.whatsapp.net');

    h.db.clearChat.mockImplementationOnce(() => {
      throw new Error('clear failed');
    });
    h.connection.emit('chatCleared', 'bad@s.whatsapp.net');
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'chatCleared: failed to soft-delete messages');

    h.connection.emit('historyMessages', 'not-array');
    expect(h.logger.warn).toHaveBeenCalledWith({ type: 'string' }, 'historyMessages: expected array');
    h.connection.emit('historyMessages', [{ id: 'history-1' }]);
    expect(h.processHistoryBatch).toHaveBeenCalledWith(h.db, [{ id: 'history-1' }], h.logger);

    h.handleContactsUpsert.mockImplementationOnce(() => {
      throw new Error('contacts failed');
    });
    h.connection.emit('contactsUpsert', [{ id: 'contact-1' }]);
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'contactsUpsert: failed to persist contacts');

    h.handleContactsUpdate.mockImplementationOnce(() => {
      throw new Error('contacts update failed');
    });
    h.connection.emit('contactsUpdate', [{ id: 'contact-1' }]);
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'contactsUpdate: failed to update contacts');

    h.handleReaction.mockImplementationOnce(() => {
      throw new Error('reaction failed');
    });
    h.connection.emit('reactionReceived', { messageId: 'm1' });
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'reactionReceived: failed to persist reaction');

    h.handleReceipt.mockImplementationOnce(() => {
      throw new Error('receipt failed');
    });
    h.connection.emit('receiptUpdate', { messageId: 'm1' });
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'receiptUpdate: failed to persist receipt');

    h.connection.emit('mediaUpdate', [{ messageId: 'm1' }]);
    expect(h.logger.info).toHaveBeenCalledWith({ count: 1 }, 'media URLs refreshed');

    h.handleChatsUpsert.mockImplementationOnce(() => {
      throw new Error('chats upsert failed');
    });
    h.connection.emit('chatsUpsert', [{ id: 'chat-1' }]);
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'chatsUpsert: failed to persist chats');

    h.handleChatsUpdate.mockImplementationOnce(() => {
      throw new Error('chats update failed');
    });
    h.connection.emit('chatsUpdate', [{ id: 'chat-1' }]);
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'chatsUpdate: failed to update chats');

    h.handleChatsDelete.mockImplementationOnce(() => {
      throw new Error('chats delete failed');
    });
    h.connection.emit('chatsDelete', ['chat-1']);
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'chatsDelete: failed to delete chats');

    h.connection.emit('jidAliasChanged', 'user@lid', '15551230000@s.whatsapp.net');
    expect(h.chatRuntime.handleJidAliasChanged).toHaveBeenCalledWith('user@lid', '15551230000@s.whatsapp.net');
    expect(h.upsertLidMapping).toHaveBeenCalledWith(h.db, 'user@lid', '15551230000@s.whatsapp.net');
    expect(h.connection.contactsDir.invalidateLidCache).toHaveBeenCalled();

    h.connection.emit('lidPairDiscovered', 'user@lid', '15551230000@s.whatsapp.net');
    expect(h.mineMessageKey).toHaveBeenCalledWith(h.db, 'user@lid', '15551230000@s.whatsapp.net');
    expect(h.upsertLidMapping).toHaveBeenCalledWith(h.db, 'user@lid', '15551230000@s.whatsapp.net', 'L3');

    h.connection.emit('groupsUpsert', [{ id: 'group@s.whatsapp.net', participants: [{ lid: 'member@lid' }] }]);
    expect(h.handleGroupsUpsert).toHaveBeenCalled();
    expect(h.mineGroupParticipants).toHaveBeenCalledWith(h.db, [{ lid: 'member@lid' }]);

    h.connection.emit('groupParticipantsUpdate', {
      groupJid: 'group@s.whatsapp.net',
      author: '15551230000@s.whatsapp.net',
      participants: ['bot@s.whatsapp.net'],
      action: 'add',
    });
    expect(h.insertAllowed).toHaveBeenCalledWith(h.db, 'group', 'group@s.whatsapp.net');

    h.connection.emit('labelsEdit', [{ id: 'label-1' }]);
    expect(h.handleLabelsEdit).toHaveBeenCalledWith(h.db, [{ id: 'label-1' }]);
    expect(h.cleanupOrphanedAssociations).toHaveBeenCalledWith(h.db);

    h.handleLabelsAssociation.mockImplementationOnce(() => {
      throw new Error('label association failed');
    });
    h.connection.emit('labelsAssociation', { labelId: 'label-1' });
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'labelsAssociation: failed to persist label association');

    h.handleBlocklistSet.mockImplementationOnce(() => {
      throw new Error('blocklist set failed');
    });
    h.connection.emit('blocklistSet', ['blocked@s.whatsapp.net']);
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'blocklistSet: failed to persist blocklist');

    h.handleBlocklistUpdate.mockImplementationOnce(() => {
      throw new Error('blocklist update failed');
    });
    h.connection.emit('blocklistUpdate', { added: ['blocked@s.whatsapp.net'] });
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'blocklistUpdate: failed to persist blocklist update');

    h.handleGroupsUpdate.mockImplementationOnce(() => {
      throw new Error('group update failed');
    });
    h.connection.emit('groupsUpdate', [{ id: 'group@s.whatsapp.net' }]);
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'groupsUpdate: failed to persist group updates');

    h.connection.emit('newsletterReaction', { id: 'n1' });
    h.connection.emit('newsletterView', { id: 'n1' });
    h.connection.emit('newsletterParticipantsUpdate', { id: 'n1' });
    h.connection.emit('newsletterSettingsUpdate', { id: 'n1' });
    expect(h.logger.info).toHaveBeenCalledWith({ data: { id: 'n1' } }, 'newsletterReaction: newsletter reaction received');

    h.connection.emit('decryptionFailure', {
      messageId: 'm1',
      senderJid: 'sender@s.whatsapp.net',
      chatJid: 'chat@s.whatsapp.net',
      errorMessage: 'bad mac',
    });
    expect(h.storeDecryptionFailure).toHaveBeenCalledWith(h.db, expect.objectContaining({ messageId: 'm1' }));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.backfillMetrics).toHaveBeenCalledWith(h.db);
    // #1445 QR-012: messages retention no longer runs from a standalone
    // main.ts timeout — it flows through databaseRetentionTimer (asserted
    // separately below / in the periodic-timer coverage tests).
    expect(h.collectHourlyMetrics).toHaveBeenCalledWith(h.db);
    expect(h.durability.sweepStaleSubmitted).toHaveBeenCalled();
    expect(h.checkDegradationSignals).toHaveBeenCalledWith(h.db, h.connection, h.durability, null);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.reconcileLidMappings).toHaveBeenCalledWith(
      h.db,
      '/tmp/whatsoup-main-auth',
      expect.objectContaining({ lastMaxPk: expect.any(Number), knownUnresolvedLids: expect.any(Set) }),
    );
    expect(h.connection.contactsDir.invalidateLidCache).toHaveBeenCalled();
  });

  it('imports a legacy q database on empty warm start', async () => {
    const h = await importMainWithMocks({
      instanceConfig: { name: 'q' },
      messageCount: 0,
      existingPaths: ['/tmp/whatsoup-main-data/whatsapp-instances/q/bot.db'],
    });

    expect(h.existsSync).toHaveBeenCalledWith('/tmp/whatsoup-main-data/whatsapp-instances/q/bot.db');
    expect(h.db.importFromLegacyDb).toHaveBeenCalledWith('/tmp/whatsoup-main-data/whatsapp-instances/q/bot.db');
    expect(h.logger.info).toHaveBeenCalledWith(
      { legacyDbPath: '/tmp/whatsoup-main-data/whatsapp-instances/q/bot.db' },
      'warm-start: import complete',
    );
  });

  it('logs missing admin configuration without seeding access or sending startup notice', async () => {
    const h = await importMainWithMocks({ adminPhones: [] });

    expect(h.logger.warn).toHaveBeenCalledWith('No admin phones configured \u2014 approval requests will not be delivered');
    expect(h.logger.warn).toHaveBeenCalledWith('no admin phones configured \u2014 skipping startup notification');
    expect(h.insertAllowed).not.toHaveBeenCalledWith(h.db, 'phone', expect.any(String));
    expect(h.sendTracked).not.toHaveBeenCalled();
  });

  it('selects passive runtime without startup notification or memory consolidation when Pinecone is not ready', async () => {
    const h = await importMainWithMocks({
      instanceConfig: { name: 'relay', type: 'passive', paths: { root: '/tmp/relay' }, socketPath: '/tmp/relay.sock' },
      pineconeState: 'missing_index',
    });

    expect(h.PassiveRuntime).toHaveBeenCalledWith(h.db, h.connection, {
      name: 'q',
      paths: { root: '/tmp/relay' },
      socketPath: '/tmp/relay.sock',
    });
    expect(h.ChatRuntime).not.toHaveBeenCalled();
    expect(h.AgentRuntime).not.toHaveBeenCalled();
    expect(h.memoryScheduler.start).not.toHaveBeenCalled();
    expect(h.sendTracked).not.toHaveBeenCalled();
  });

  it('selects agent runtime, resolves cwd and plugin dirs, and sends the restart notification', async () => {
    const h = await importMainWithMocks({
      instanceConfig: {
        name: 'q',
        type: 'agent',
        systemPrompt: 'system prompt',
        introSent: true,
        agentOptions: {
          sessionScope: 'shared',
          cwd: '~/LAB/WhatSoup',
          instructionsPath: '/tmp/instructions.md',
          sandbox: {
            allowedPaths: ['/tmp'],
            allowedTools: ['Read'],
            bash: { enabled: false },
          },
          sandboxPerChat: true,
          pluginDirs: ['~/plugins/one'],
          enabledPlugins: { test: true },
          allowM365Mutations: false,
          autoCompactInputTokens: 123,
        },
      },
    });

    expect(h.AgentRuntime).toHaveBeenCalledWith(
      h.db,
      h.connection,
      'q',
      expect.objectContaining({
        shared: true,
        sessionScope: 'shared',
        cwd: expect.stringMatching(/\/LAB\/WhatSoup$/),
        configSystemPrompt: 'system prompt',
        instructionsPath: '/tmp/instructions.md',
        sandboxPerChat: true,
        pluginDirs: [expect.stringMatching(/\/plugins\/one-latest$/)],
        enabledPlugins: { test: true },
        allowM365Mutations: false,
        autoCompactInputTokens: 123,
      }),
    );
    expect(h.resolveLatestPluginDir).toHaveBeenCalledWith(expect.stringMatching(/\/plugins\/one$/));
    expect(h.chatRuntime.start).not.toHaveBeenCalled();
    expect(h.agentInstances[0].start).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.sendTracked).toHaveBeenCalledWith(
      h.connection,
      '15551230000@s.whatsapp.net',
      '*Agent back online* \u2713',
      h.durability,
      { replayPolicy: 'safe' },
    );
  });
});
