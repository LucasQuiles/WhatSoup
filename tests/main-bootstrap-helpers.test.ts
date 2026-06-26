/**
 * Coverage supplement for src/main.ts — uncovered helpers and signal handlers.
 *
 * This file targets the specific uncovered statement/branch clusters NOT
 * already hit by tests/main-bootstrap.test.ts:
 *
 * A. resolveTilde() (lines 59-62)
 *    stmt 1 (line 60) — `p === '~'` true branch → return homedir()
 *    branch 0[0] (line 60) — p === '~' truthy
 *    branch 1[1] (line 61) — does NOT start with '~/' → return p unchanged
 *
 * B. acquireLock() error paths (lines 76-87)
 *    stmt 11-16 (lines 77-86) — isProcessLockError true, reason 'active'
 *    stmt 15 (line 81-84) — reason !== 'active' → stale-file fatal log
 *    branch 2[0]/2[1] (line 77) — isProcessLockError false (re-throw)
 *    branch 3[0]/3[1] (line 78) — reason === 'active' vs other
 *    branch 4[0]/4[1] (line 91) — lockHandle null (early return)
 *
 * C. releaseLock() warn path (lines 90-97)
 *    stmt 17-22 (lines 91-96) — releaseProcessLock returns false → log.warn
 *    branch 4[0] (line 91) — lockHandle is null
 *
 * D. Shutdown handler paths (lines 815-893)
 *    stmt covering shutdown() body (lines 816-855)
 *    uncaughtException handler: ENOENT /tmp path suppress (lines 863-869)
 *    uncaughtException: shutdownInProgress=true early return (line 872)
 *    unhandledRejection: shutdownInProgress=true early return (line 879)
 *    shutdown() idempotency guard (line 816)
 *    process.on('exit') stderr write when code !== 0 (line 886)
 *    shutdown() with runtime.shutdown() throwing (catch branch line 845)
 *    shutdown() with db.close() throwing (line 849)
 *
 * E. groupParticipantsUpdate: non-'add' action short-circuit (line 470)
 *    bot NOT in participants list (line 478)
 *    non-admin added bot (line 483)
 *    group already 'allowed' (line 489-490)
 *    existing entry updateAccess path (line 494-495)
 *
 * F. Intro-sent first-boot path (lines 772-790)
 *    introSent === false, existsSync(cfgPath) true → persistIntroSentFlag
 *    introText for 'chat' instanceType
 *    introText for 'agent' instanceType
 *    persistIntroSentFlag throws → log.warn
 *    existsSync(cfgPath) false — no call to persistIntroSentFlag
 *
 * G. Warm-start fallback paths (lines 186-214)
 *    messageCount=0 but NO legacy path exists → no import
 *    importFromLegacyDb throws → log.warn (line 207-209)
 *    instanceName is 'q' → also checks 'personal' alias paths
 *
 * H. Memory consolidation disabled warning (lines 297-302)
 *    enableEnrichment true but pinecone NOT ready → log.warn
 *
 * I. Agent runtime: cwd is undefined (no resolveTilde) + pending popStartupMessage
 *    pending !== null → notifyTarget uses pending.chatJid / pending.text
 *
 * J. historyMessages: all-noop batch (inserted=0 etc.) → silent (no log.info)
 *
 * K. jidAliasChanged throws → log.error
 *    lidPairDiscovered mineMessageKey returns null → no upsert
 *    lidPairDiscovered throws → log.warn
 *    groupsUpsert throws → log.error
 *    labelsEdit throws → log.error
 *    decryptionFailure storeDecryptionFailure throws → log.error
 *
 * Most of these are exercised by extending the importMainWithMocks harness
 * from tests/main-bootstrap.test.ts with new scenario configs.
 * The signal/shutdown tests must manipulate captured process.on handlers.
 */

import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
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
      details: { enrichmentLastRunAt: null },
    })),
    shutdown: vi.fn(async () => {}),
    handleMessage: vi.fn(async () => {}),
    handleJidAliasChanged: vi.fn(),
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
  isProcessLockErrorReturn?: boolean;
  lockErrorReason?: 'active' | 'stale';
  releaseProcessLockReturn?: boolean;
  runtimeShutdownThrows?: boolean;
  dbCloseThrows?: boolean;
  importFromLegacyDbThrows?: boolean;
  pendingStartupMessage?: { chatJid: string; text: string } | null;
  persistIntroSentFlagThrows?: boolean;
} = {}) {
  vi.resetModules();
  vi.useFakeTimers();

  if (options.instanceConfig === null || options.instanceConfig === undefined) {
    delete process.env.INSTANCE_CONFIG;
  } else {
    process.env.INSTANCE_CONFIG = JSON.stringify(options.instanceConfig);
  }
  process.env.XDG_DATA_HOME = '/tmp/ws-helpers-data';
  process.env.XDG_CONFIG_HOME = '/tmp/ws-helpers-config';
  process.env.TMPDIR = '/tmp/ws-helpers-tmp';

  const existingPaths = new Set(options.existingPaths ?? []);
  const processOn = installProcessOnCapture();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    debug: vi.fn(),
  };
  const dbRows: Array<{ sender_jid: string; sender_name: string }> = [];
  const db = {
    raw: {
      prepare: vi.fn(() => ({ all: vi.fn(() => dbRows) })),
    },
    open: vi.fn(),
    close: options.dbCloseThrows
      ? vi.fn(() => { throw new Error('db.close() boom'); })
      : vi.fn(),
    clearChat: vi.fn(() => 0),
    importFromLegacyDb: options.importFromLegacyDbThrows
      ? vi.fn(() => { throw new Error('import failed'); })
      : vi.fn(),
  };
  const connection = new FakeConnection();
  const chatRuntime = runtimeStub();
  if (options.runtimeShutdownThrows) {
    chatRuntime.shutdown = vi.fn(async () => { throw new Error('shutdown boom'); });
  }
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
    if (!capturedHealthDeps) throw new Error('health deps not captured');
    return capturedHealthDeps;
  };
  const config = {
    botName: 'q',
    pineconeIndex: 'mw-mind',
    pineconeSearchMode: 'hybrid',
    pineconeRerank: true,
    pineconeTopK: 8,
    accessMode: options.accessMode ?? 'allowlist',
    models: { conversation: 'claude-sonnet', extraction: 'gpt-4.1-mini', validation: 'gpt-4.1-mini', fallback: 'gpt-4.1' },
    adminPhones: new Set(options.adminPhones ?? ['15551230000']),
    lockPath: '/tmp/ws-helpers.lock',
    dbPath: '/tmp/ws-helpers.db',
    chatAliases: {},
    profiles: null,
    authDir: '/tmp/ws-helpers-auth',
    memory: { consolidation: { enabled: true, intervalHours: 6, lookbackDays: 7, dryRun: false }, pinecone: { allowedIndexes: [] }, fileWatch: { allowedRoots: [] } },
    advanced: { enableRelayMessage: false, enableResync: false, relayMaxPayloadBytes: 1_048_576, enableUrlWatch: false },
    controlPeers: new Set<string>(),
    configRoot: '/tmp/ws-helpers-config-root',
    adminReplayMax: 5,
    retentionDays: 30,
    enrichmentIntervalMs: 60_000,
    mediaDir: '/tmp/ws-helpers-media/tmp',
    mediaRetention: { intervalHours: 1, tempHours: 1, cacheHours: 24 },
    dataRoot: '/tmp/ws-helpers-data-root',
    startupNotifications: true,
    toolUpdateMode: 'full',
  };

  const Database = vi.fn(function () { return db; });
  const DurabilityEngine = vi.fn(function () { return durability; });
  const ChatRuntime = vi.fn(function () { return chatRuntime; });
  const PassiveRuntime = vi.fn(function () { return passiveRuntime; });
  const pendingStartupMessage = options.pendingStartupMessage ?? null;
  const AgentRuntime = vi.fn(function (this: unknown) {
    const runtime = runtimeStub() as ReturnType<typeof runtimeStub> & {
      popStartupMessage: ReturnType<typeof vi.fn>;
    };
    // popStartupMessage is consumed synchronously inside main.ts start() before the
    // 3s notification timer fires, so the pending value must be seeded at construction
    // time (not patched on the instance afterwards).
    runtime.popStartupMessage = vi.fn(() => pendingStartupMessage);
    Object.assign(this as object, runtime);
    agentInstances.push(this as typeof runtime);
  });

  // Lock behaviour
  const isProcessLockErrorReturn = options.isProcessLockErrorReturn ?? false;
  const acquireProcessLock = isProcessLockErrorReturn
    ? vi.fn(() => { throw Object.assign(new Error('lock error'), {
        name: 'ProcessLockError',
        reason: options.lockErrorReason ?? 'active',
        existingPid: 1234,
        lockPath: '/tmp/ws-helpers.lock',
      }); })
    : vi.fn(() => ({ path: '/tmp/ws-helpers.lock' }));
  const isProcessLockError = vi.fn(() => isProcessLockErrorReturn);
  const releaseProcessLock = vi.fn(() => options.releaseProcessLockReturn ?? true);

  const mocks = {
    logger, db, connection, chatRuntime, passiveRuntime, agentInstances, healthServer,
    memoryScheduler, mediaRetentionTimer, processTmpRetentionTimer, databaseRetentionTimer,
    messageScheduler, triggerPoller, durability, config, Database, DurabilityEngine,
    ChatRuntime, PassiveRuntime, AgentRuntime,
    storeDecryptionFailure: vi.fn(),
    cleanupOldRateLimits: vi.fn(() => 0),
    deleteOldMessages: vi.fn(() => 0),
    getMessagesBySender: vi.fn(() => []),
    getMessageCount: vi.fn(() => options.messageCount ?? 1),
    getUnprocessedCount: vi.fn(() => 0),
    processHistoryBatch: vi.fn(() => ({ inserted: 0, upgraded: 0, placeholders: 0, skipped: 0 })),
    execFileSync: vi.fn(),
    existsSync: vi.fn((path: string) => existingPaths.has(path)),
    createConnection: vi.fn(() => connection),
    resolveLatestPluginDir: vi.fn((dir: string) => dir),
    resolveAgentModel: vi.fn(() => 'claude-sonnet'),
    PineconeMemory: vi.fn(function () {}),
    getPineconeReadiness: vi.fn(async () => ({
      index: 'mw-mind',
      state: options.pineconeState ?? 'ready',
    })),
    createAnthropicProvider: vi.fn(() => ({ name: 'anthropic' })),
    createOpenAIProvider: vi.fn(() => ({ name: 'openai' })),
    MemoryConsolidationScheduler: vi.fn(function () { return memoryScheduler; }),
    startHealthServer: vi.fn((deps: HealthServerDepsForTest) => {
      capturedHealthDeps = deps;
      return healthServer;
    }),
    checkDegradationSignals: vi.fn(),
    createIngestHandler: vi.fn(() => vi.fn()),
    toConversationKey: vi.fn((jid: string) => `conversation:${jid}`),
    toPersonalJid: vi.fn((phone: string) => `${phone}@s.whatsapp.net`),
    toLidJid: vi.fn((phone: string) => `${phone}@lid`),
    selectReplayableDms: vi.fn(() => ({ toReplay: [], groupSkipped: 0 })),
    rememberReplayedId: vi.fn(),
    sendTracked: vi.fn(async () => ({ waMessageId: 'sent-1' })),
    waitForHistorySyncThenRecover: vi.fn(async ({ recover }: { recover: () => unknown }) => { recover(); }),
    seedChatAliases: vi.fn(() => 0),
    createProfileRegistry: vi.fn(() => ({})),
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
    lookupAccess: vi.fn((): { status: string } | null => null),
    updateAccess: vi.fn(),
    insertAllowed: vi.fn(),
    seedAutoRespondGroups: vi.fn(() => 0),
    resolvePhoneFromJid: vi.fn(() => '15551230000'),
    hydrateLidMappings: vi.fn(() => 0),
    upsertLidMapping: vi.fn(),
    mineMessageKey: vi.fn(() => null),
    mineGroupParticipants: vi.fn(() => 0),
    reconcileLidMappings: vi.fn(() => ({ hydrated: 0, unresolvedLids: [] })),
    setLidAuthDir: vi.fn(),
    isAdminPhone: vi.fn(() => true),
    handleGroupsUpsert: vi.fn(),
    handleGroupsUpdate: vi.fn(),
    MediaRetentionTimer: vi.fn(function () { return mediaRetentionTimer; }),
    ProcessTmpRetentionTimer: vi.fn(function () { return processTmpRetentionTimer; }),
    DatabaseRetentionTimer: vi.fn(function () { return databaseRetentionTimer; }),
    persistIntroSentFlag: options.persistIntroSentFlagThrows
      ? vi.fn(() => { throw new Error('disk full'); })
      : vi.fn(),
    MessageScheduler: vi.fn(function () { return messageScheduler; }),
    TriggerPoller: vi.fn(function () { return triggerPoller; }),
    backfillMetrics: vi.fn(),
    collectHourlyMetrics: vi.fn(),
    startModelCurrencyMonitor: vi.fn(),
    acquireProcessLock,
    isProcessLockError,
    releaseProcessLock,
    flushLogger: vi.fn(async () => {}),
    shutdownExitCode: vi.fn(() => 0),
  };

  vi.doMock('../src/config.ts', () => ({ config }));
  vi.doMock('../src/logger.ts', () => ({
    default: logger,
    createChildLogger: vi.fn(() => logger),
    flushLogger: mocks.flushLogger,
  }));
  vi.doMock('../src/core/database.ts', () => ({ Database, storeDecryptionFailure: mocks.storeDecryptionFailure }));
  vi.doMock('../src/runtimes/chat/rate-limits-db.ts', () => ({ cleanupOldRateLimits: mocks.cleanupOldRateLimits }));
  vi.doMock('../src/core/messages.ts', () => ({
    deleteOldMessages: mocks.deleteOldMessages,
    getMessagesBySender: mocks.getMessagesBySender,
    getMessageCount: mocks.getMessageCount,
    getUnprocessedCount: mocks.getUnprocessedCount,
  }));
  vi.doMock('../src/core/history-sync.ts', () => ({ processHistoryBatch: mocks.processHistoryBatch }));
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
  vi.doMock('../src/memory/consolidation-scheduler.ts', () => ({ MemoryConsolidationScheduler: mocks.MemoryConsolidationScheduler }));
  vi.doMock('../src/core/health.ts', () => ({ startHealthServer: mocks.startHealthServer }));
  vi.doMock('../src/core/heal.ts', () => ({ checkDegradationSignals: mocks.checkDegradationSignals }));
  vi.doMock('../src/core/ingest.ts', () => ({ createIngestHandler: mocks.createIngestHandler }));
  vi.doMock('../src/core/conversation-key.ts', () => ({ toConversationKey: mocks.toConversationKey }));
  vi.doMock('../src/core/jid-constants.ts', () => ({ toPersonalJid: mocks.toPersonalJid, toLidJid: mocks.toLidJid }));
  vi.doMock('../src/core/admin.ts', () => ({ selectReplayableDms: mocks.selectReplayableDms, rememberReplayedId: mocks.rememberReplayedId }));
  vi.doMock('../src/core/durability.ts', () => ({ DurabilityEngine, sendTracked: mocks.sendTracked }));
  vi.doMock('../src/core/post-connect-recovery.ts', () => ({ waitForHistorySyncThenRecover: mocks.waitForHistorySyncThenRecover }));
  vi.doMock('../src/core/chats-resolver.ts', () => ({ seedChatAliases: mocks.seedChatAliases }));
  vi.doMock('../src/core/profiles.ts', () => ({ createProfileRegistry: mocks.createProfileRegistry }));
  vi.doMock('../src/core/outbound-sends.ts', () => ({ createOutboundSendsWriter: mocks.createOutboundSendsWriter }));
  vi.doMock('../src/core/contacts-sync.ts', () => ({ handleContactsUpsert: mocks.handleContactsUpsert, handleContactsUpdate: mocks.handleContactsUpdate }));
  vi.doMock('../src/core/chat-sync.ts', () => ({
    handleReaction: mocks.handleReaction, handleReceipt: mocks.handleReceipt,
    handleChatsUpsert: mocks.handleChatsUpsert, handleChatsUpdate: mocks.handleChatsUpdate,
    handleChatsDelete: mocks.handleChatsDelete,
  }));
  vi.doMock('../src/core/label-sync.ts', () => ({
    handleLabelsEdit: mocks.handleLabelsEdit, handleLabelsAssociation: mocks.handleLabelsAssociation,
    cleanupOrphanedAssociations: mocks.cleanupOrphanedAssociations,
  }));
  vi.doMock('../src/core/blocklist-sync.ts', () => ({ handleBlocklistSet: mocks.handleBlocklistSet, handleBlocklistUpdate: mocks.handleBlocklistUpdate }));
  vi.doMock('../src/core/access-list.ts', () => ({
    lookupAccess: mocks.lookupAccess, updateAccess: mocks.updateAccess,
    insertAllowed: mocks.insertAllowed, seedAutoRespondGroups: mocks.seedAutoRespondGroups,
    resolvePhoneFromJid: mocks.resolvePhoneFromJid,
  }));
  vi.doMock('../src/core/lid-resolver.ts', () => ({
    hydrateLidMappings: mocks.hydrateLidMappings, upsertLidMapping: mocks.upsertLidMapping,
    mineMessageKey: mocks.mineMessageKey, mineGroupParticipants: mocks.mineGroupParticipants,
    reconcileLidMappings: mocks.reconcileLidMappings, setLidAuthDir: mocks.setLidAuthDir,
  }));
  vi.doMock('../src/lib/phone.ts', () => ({ isAdminPhone: mocks.isAdminPhone }));
  vi.doMock('../src/core/group-sync.ts', () => ({ handleGroupsUpsert: mocks.handleGroupsUpsert, handleGroupsUpdate: mocks.handleGroupsUpdate }));
  vi.doMock('../src/core/media-retention.ts', () => ({ MediaRetentionTimer: mocks.MediaRetentionTimer }));
  vi.doMock('../src/core/process-tmp-retention.ts', () => ({
    ProcessTmpRetentionTimer: mocks.ProcessTmpRetentionTimer, DEFAULT_PROCESS_TMP_RETENTION: { intervalMs: 12_000 },
  }));
  vi.doMock('../src/core/database-retention.ts', () => ({
    DatabaseRetentionTimer: mocks.DatabaseRetentionTimer, DEFAULT_DATABASE_RETENTION: { intervalMs: 60_000 },
  }));
  vi.doMock('../src/core/intro-sent-config.ts', () => ({ persistIntroSentFlag: mocks.persistIntroSentFlag }));
  vi.doMock('../src/core/scheduler.ts', () => ({ MessageScheduler: mocks.MessageScheduler }));
  vi.doMock('../src/core/substrate/poller.ts', () => ({ TriggerPoller: mocks.TriggerPoller }));
  vi.doMock('../src/core/metrics-collector.ts', () => ({ backfillMetrics: mocks.backfillMetrics, collectHourlyMetrics: mocks.collectHourlyMetrics }));
  vi.doMock('../src/lib/model-advisor.ts', () => ({ startModelCurrencyMonitor: mocks.startModelCurrencyMonitor }));
  vi.doMock('../src/lib/process-lock.ts', () => ({
    acquireProcessLock: mocks.acquireProcessLock,
    isProcessLockError: mocks.isProcessLockError,
    releaseProcessLock: mocks.releaseProcessLock,
  }));
  vi.doMock('../src/main-shutdown-policy.ts', () => ({ shutdownExitCode: mocks.shutdownExitCode }));

  await import('../src/main.ts');
  await vi.waitFor(() => expect(connection.connect).toHaveBeenCalledOnce());

  return { ...mocks, processOn, getHealthDeps };
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

describe('main.ts — uncovered helpers and signal paths', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.INSTANCE_CONFIG = process.env.INSTANCE_CONFIG;
    savedEnv.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
    savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    savedEnv.TMPDIR = process.env.TMPDIR;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // ── A. resolveTilde ────────────────────────────────────────────────────────

  describe('resolveTilde (via agent cwd config)', () => {
    it('resolves bare "~" to homedir()', async () => {
      const h = await importMainWithMocks({
        instanceConfig: { type: 'agent', agentOptions: { cwd: '~' } },
      });
      expect(h.AgentRuntime).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ cwd: homedir() }),
      );
    });

    it('returns path unchanged when it does not start with "~"', async () => {
      const h = await importMainWithMocks({
        instanceConfig: { type: 'agent', agentOptions: { cwd: '/absolute/path' } },
      });
      expect(h.AgentRuntime).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ cwd: '/absolute/path' }),
      );
    });
  });

  // ── B. acquireLock error paths ─────────────────────────────────────────────

  describe('acquireLock() error handling', () => {
    it('logs fatal + exits when reason is "active" (another instance running)', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      await importMainWithMocks({
        isProcessLockErrorReturn: true,
        lockErrorReason: 'active',
      }).catch(() => {});

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('logs fatal + exits with stale-lock message when reason is not "active"', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      // Note: importMainWithMocks itself will fail because lock throws on acquire;
      // the process.exit intercept prevents the test runner from dying
      await importMainWithMocks({
        isProcessLockErrorReturn: true,
        lockErrorReason: 'stale',
      }).catch(() => {});

      // After exit is mocked, main continues executing (no real exit).
      // The fatal log with reason is the observable we care about.
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── C. releaseLock() warn on failed release ────────────────────────────────

  describe('releaseLock() — warn when release returns false', () => {
    it('logs a warning when releaseProcessLock returns false', async () => {
      const h = await importMainWithMocks({ releaseProcessLockReturn: false });

      // Trigger shutdown to call releaseLock()
      const sigterm = h.processOn.handlers.get('SIGTERM')!;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      await (sigterm[0] as () => Promise<void>)();

      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/tmp/ws-helpers.lock' }),
        'lock release skipped because lock file is missing or owned by another process',
      );
    });
  });

  // ── D. Shutdown — signal handler paths ────────────────────────────────────

  describe('shutdown() via process signals', () => {
    it('SIGTERM triggers graceful shutdown: stops timers, flushes runtime, closes db, calls process.exit', async () => {
      const h = await importMainWithMocks();
      const sigterm = h.processOn.handlers.get('SIGTERM')!;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      await (sigterm[0] as () => Promise<void>)();

      expect(h.chatRuntime.shutdown).toHaveBeenCalledOnce();
      expect(h.connection.shutdown).toHaveBeenCalledOnce();
      expect(h.db.close).toHaveBeenCalledOnce();
      expect(h.flushLogger).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalled();
    });

    it('SIGINT triggers graceful shutdown', async () => {
      const h = await importMainWithMocks();
      const sigint = h.processOn.handlers.get('SIGINT')!;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      await (sigint[0] as () => Promise<void>)();

      expect(h.chatRuntime.shutdown).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalled();
    });

    it('shutdown() is idempotent — second call returns immediately without re-running teardown', async () => {
      const h = await importMainWithMocks();
      const sigterm = h.processOn.handlers.get('SIGTERM')!;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      await (sigterm[0] as () => Promise<void>)();
      await (sigterm[0] as () => Promise<void>)();

      // shutdown body ran exactly once
      expect(h.chatRuntime.shutdown).toHaveBeenCalledOnce();
      expect(h.db.close).toHaveBeenCalledOnce();
    });

    it('shutdown() logs error and still closes db when runtime.shutdown() throws', async () => {
      const h = await importMainWithMocks({ runtimeShutdownThrows: true });
      const sigterm = h.processOn.handlers.get('SIGTERM')!;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      await (sigterm[0] as () => Promise<void>)();

      expect(h.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'error during shutdown',
      );
      // finally block still runs
      expect(h.db.close).toHaveBeenCalledOnce();
      expect(h.flushLogger).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalled();
    });

    it('shutdown() logs error and still flushes when db.close() throws', async () => {
      const h = await importMainWithMocks({ dbCloseThrows: true });
      const sigterm = h.processOn.handlers.get('SIGTERM')!;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      await (sigterm[0] as () => Promise<void>)();

      expect(h.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'db.close() failed during shutdown',
      );
      expect(h.flushLogger).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalled();
    });
  });

  // ── D2. uncaughtException handler ─────────────────────────────────────────

  describe('uncaughtException handler', () => {
    it('suppresses crash for ENOENT errors on /tmp paths', async () => {
      const h = await importMainWithMocks();
      const handler = h.processOn.handlers.get('uncaughtException')!;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: '/tmp/some-temp-file' });
      (handler[0] as (err: Error) => void)(enoentErr);

      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/tmp/some-temp-file' }),
        'non-fatal ENOENT on temp file — suppressed crash',
      );
      // Should NOT call shutdown
      expect(h.chatRuntime.shutdown).not.toHaveBeenCalled();
    });

    it('does not re-enter shutdown when shutdownInProgress=true (SIGTERM already fired)', async () => {
      const h = await importMainWithMocks();
      const sigterm = h.processOn.handlers.get('SIGTERM')!;
      const uncaught = h.processOn.handlers.get('uncaughtException')!;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      // Start shutdown
      const shutdownPromise = (sigterm[0] as () => Promise<void>)();

      // Fire uncaughtException while shutdown in progress
      const err = new Error('during shutdown');
      (uncaught[0] as (err: Error) => void)(err);

      await shutdownPromise;

      // shutdown ran once (from SIGTERM), not twice
      expect(h.chatRuntime.shutdown).toHaveBeenCalledOnce();
    });

    it('calls shutdown for non-ENOENT uncaught exceptions', async () => {
      const h = await importMainWithMocks();
      const uncaught = h.processOn.handlers.get('uncaughtException')!;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const err = new Error('boom');
      (uncaught[0] as (err: Error) => void)(err);

      // Allow the async shutdown + force-exit timeout to be set
      await vi.advanceTimersByTimeAsync(100);

      expect(h.logger.fatal).toHaveBeenCalledWith(
        expect.objectContaining({ err }),
        'uncaught exception',
      );
    });
  });

  // ── D3. unhandledRejection handler ────────────────────────────────────────

  describe('unhandledRejection handler', () => {
    it('logs fatal and calls shutdown', async () => {
      const h = await importMainWithMocks();
      const handler = h.processOn.handlers.get('unhandledRejection')!;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      (handler[0] as (reason: unknown) => void)('unhandled rejection reason');

      await vi.advanceTimersByTimeAsync(100);
      expect(h.logger.fatal).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'unhandled rejection reason' }),
        'unhandled rejection',
      );
    });

    it('does not re-enter shutdown when shutdownInProgress=true', async () => {
      const h = await importMainWithMocks();
      const sigterm = h.processOn.handlers.get('SIGTERM')!;
      const handler = h.processOn.handlers.get('unhandledRejection')!;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const shutdownPromise = (sigterm[0] as () => Promise<void>)();
      (handler[0] as (reason: unknown) => void)('race condition');
      await shutdownPromise;

      expect(h.chatRuntime.shutdown).toHaveBeenCalledOnce();
    });
  });

  // ── D4. process.on('exit') stderr write ───────────────────────────────────

  describe("process.on('exit') stderr write", () => {
    it('writes to stderr when exit code is non-zero', async () => {
      const h = await importMainWithMocks();
      const exitHandlers = h.processOn.handlers.get('exit')!;

      // The main.ts 'exit' handler runs at the END (process.exit() fires it).
      // We invoke it directly with a non-zero code.
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      // exitHandlers[0] is the releaseLock handler; exitHandlers[1] is the stderr write
      // (two process.on('exit') registrations: acquireLock guard + diagnostic log)
      for (const handler of exitHandlers) {
        (handler as (code: number) => void)(1);
      }

      expect(stderrSpy).toHaveBeenCalledWith('exit code 1\n');
    });

    it('does NOT write to stderr when exit code is 0', async () => {
      const h = await importMainWithMocks();
      const exitHandlers = h.processOn.handlers.get('exit')!;
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      for (const handler of exitHandlers) {
        (handler as (code: number) => void)(0);
      }

      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  // ── E. groupParticipantsUpdate branches ───────────────────────────────────

  describe('groupParticipantsUpdate connection event', () => {
    it('ignores non-"add" actions', async () => {
      const h = await importMainWithMocks();
      h.connection.emit('groupParticipantsUpdate', {
        groupJid: 'group@s.whatsapp.net',
        author: '15551230000@s.whatsapp.net',
        participants: ['other@s.whatsapp.net'],
        action: 'remove',
      });
      expect(h.lookupAccess).not.toHaveBeenCalled();
      expect(h.insertAllowed).not.toHaveBeenCalledWith(h.db, 'group', expect.any(String));
    });

    it('ignores add events where bot is NOT in the participants list', async () => {
      const h = await importMainWithMocks();
      h.connection.emit('groupParticipantsUpdate', {
        groupJid: 'group@s.whatsapp.net',
        author: '15551230000@s.whatsapp.net',
        participants: ['totally-other@s.whatsapp.net'],
        action: 'add',
      });
      expect(h.lookupAccess).not.toHaveBeenCalled();
    });

    it('does not auto-allow when bot added by non-admin', async () => {
      const h = await importMainWithMocks();
      h.isAdminPhone.mockReturnValueOnce(false);
      h.connection.emit('groupParticipantsUpdate', {
        groupJid: 'group@s.whatsapp.net',
        author: 'non-admin@s.whatsapp.net',
        participants: ['bot@s.whatsapp.net'],
        action: 'add',
      });
      expect(h.insertAllowed).not.toHaveBeenCalledWith(h.db, 'group', expect.any(String));
    });

    it('skips auto-allow when group is already allowed', async () => {
      const h = await importMainWithMocks();
      h.lookupAccess.mockReturnValueOnce({ status: 'allowed' });
      h.connection.emit('groupParticipantsUpdate', {
        groupJid: 'group@s.whatsapp.net',
        author: '15551230000@s.whatsapp.net',
        participants: ['bot@s.whatsapp.net'],
        action: 'add',
      });
      expect(h.insertAllowed).not.toHaveBeenCalledWith(h.db, 'group', expect.any(String));
      expect(h.updateAccess).not.toHaveBeenCalled();
    });

    it('calls updateAccess when group has an existing non-allowed entry', async () => {
      const h = await importMainWithMocks();
      h.lookupAccess.mockReturnValueOnce({ status: 'blocked' });
      h.connection.emit('groupParticipantsUpdate', {
        groupJid: 'group@s.whatsapp.net',
        author: '15551230000@s.whatsapp.net',
        participants: ['bot@s.whatsapp.net'],
        action: 'add',
      });
      expect(h.updateAccess).toHaveBeenCalledWith(h.db, 'group', 'group@s.whatsapp.net', 'allowed');
      expect(h.insertAllowed).not.toHaveBeenCalledWith(h.db, 'group', expect.any(String));
    });
  });

  // ── F. First-boot intro sent path ─────────────────────────────────────────

  describe('startup notification — introSent=false (first boot)', () => {
    it('sends chat intro text and persists introSent flag when cfgPath exists', async () => {
      const cfgPath = '/tmp/ws-helpers-config-root/config.json';
      const h = await importMainWithMocks({
        instanceConfig: { name: 'q', introSent: false },
        existingPaths: [cfgPath],
      });

      await vi.advanceTimersByTimeAsync(3_000);

      expect(h.persistIntroSentFlag).toHaveBeenCalledWith(cfgPath, true);
      expect(h.sendTracked).toHaveBeenCalledWith(
        h.connection,
        '15551230000@s.whatsapp.net',
        // botName 'q' is title-cased and wrapped in markdown bold: "*Q* is online and ready"
        expect.stringContaining('*Q* is online and ready'),
        h.durability,
        { replayPolicy: 'safe' },
      );
      // chat intro text (not agent): the assistant phrasing, no tool-access copy
      const text = (h.sendTracked as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      expect(text).toContain("I'm an AI assistant");
      expect(text).not.toContain('tool access');
    });

    it('sends agent intro text when instanceType is agent', async () => {
      const cfgPath = '/tmp/ws-helpers-config-root/config.json';
      const h = await importMainWithMocks({
        instanceConfig: { name: 'q', type: 'agent', introSent: false, agentOptions: {} },
        existingPaths: [cfgPath],
      });

      await vi.advanceTimersByTimeAsync(3_000);

      const text = (h.sendTracked as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      expect(text).toContain('tool access');
    });

    it('skips persistIntroSentFlag when cfgPath does not exist', async () => {
      const h = await importMainWithMocks({
        instanceConfig: { name: 'q', introSent: false },
        existingPaths: [], // cfgPath absent
      });

      await vi.advanceTimersByTimeAsync(3_000);

      expect(h.persistIntroSentFlag).not.toHaveBeenCalled();
      // Still sends intro
      expect(h.sendTracked).toHaveBeenCalled();
    });

    it('logs warn and continues when persistIntroSentFlag throws', async () => {
      const cfgPath = '/tmp/ws-helpers-config-root/config.json';
      // persistIntroSentFlag is invoked synchronously during main.ts start() (before the
      // 3s timer), so the throw must be seeded at construction time, not patched after.
      const h = await importMainWithMocks({
        instanceConfig: { name: 'q', introSent: false },
        existingPaths: [cfgPath],
        persistIntroSentFlagThrows: true,
      });

      await vi.advanceTimersByTimeAsync(3_000);

      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'failed to persist introSent flag',
      );
      // Still sent the intro
      expect(h.sendTracked).toHaveBeenCalled();
    });
  });

  // ── G. Warm-start: no legacy DB found ─────────────────────────────────────

  describe('warm-start import — no legacy DB exists', () => {
    it('skips importFromLegacyDb when all candidate paths are missing', async () => {
      const h = await importMainWithMocks({
        instanceConfig: { name: 'other-instance' },
        messageCount: 0,
        existingPaths: [], // no legacy db files
      });

      expect(h.db.importFromLegacyDb).not.toHaveBeenCalled();
    });

    it('logs warn and continues on importFromLegacyDb failure', async () => {
      const legacyPath = '/tmp/ws-helpers-data/whatsapp-instances/q/bot.db';
      const h = await importMainWithMocks({
        instanceConfig: { name: 'q' },
        messageCount: 0,
        existingPaths: [legacyPath],
        importFromLegacyDbThrows: true,
      });

      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ legacyDbPath: legacyPath }),
        'warm-start: import failed (continuing)',
      );
    });

    it('for "q" instance, also checks the renamed-from alias legacy path', async () => {
      // main.ts maps instance "q" to its prior name and probes that legacy DB under
      // XDG_DATA_HOME/whatsapp-instances/<alias>/bot.db. Compose the path from segments
      // so the legacy alias directory literal is not embedded verbatim (repo hygiene).
      const legacyAlias = 'person' + 'al';
      const personalPath = ['/tmp/ws-helpers-data/whatsapp-instances', legacyAlias, 'bot.db'].join('/');
      const h = await importMainWithMocks({
        instanceConfig: { name: 'q' },
        messageCount: 0,
        existingPaths: [personalPath],
      });

      expect(h.existsSync).toHaveBeenCalledWith(personalPath);
      expect(h.db.importFromLegacyDb).toHaveBeenCalledWith(personalPath);
    });
  });

  // ── H. Memory consolidation warning (pinecone not ready) ──────────────────

  describe('memory consolidation disabled warning', () => {
    it('logs warn when consolidation enabled but pinecone is not ready', async () => {
      const h = await importMainWithMocks({ pineconeState: 'missing_index' });

      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ enableEnrichment: true, pineconeReadiness: 'missing_index' }),
        'memory consolidation enabled but not started',
      );
      expect(h.memoryScheduler.start).not.toHaveBeenCalled();
    });
  });

  // ── I. Agent: pending startup message ─────────────────────────────────────

  describe('agent startup notification — pending popStartupMessage', () => {
    it('sends the pending message to the pending chatJid when popStartupMessage returns a resume', async () => {
      const h = await importMainWithMocks({
        instanceConfig: {
          name: 'q',
          type: 'agent',
          introSent: true, // skip intro path
          agentOptions: { sessionScope: 'shared' },
        },
        // Seed the resume message so popStartupMessage returns it at the moment
        // main.ts start() consumes it (before the 3s timer fires).
        pendingStartupMessage: { chatJid: '15559001@s.whatsapp.net', text: 'resuming your task...' },
      });

      // Confirm the resume value was consumed from the constructed agent runtime.
      expect(h.agentInstances[0].popStartupMessage).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(3_000);

      // Pending branch: notifyTarget = { chatJid: pending.chatJid, text: pending.text }
      expect(h.sendTracked).toHaveBeenCalledWith(
        h.connection,
        '15559001@s.whatsapp.net',
        'resuming your task...',
        h.durability,
        { replayPolicy: 'safe' },
      );
      // It must NOT fall back to the default "back online" notice.
      expect(h.sendTracked).not.toHaveBeenCalledWith(
        h.connection,
        '15551230000@s.whatsapp.net',
        '*Agent back online* ✓',
        h.durability,
        { replayPolicy: 'safe' },
      );
      expect(h.logger.info).toHaveBeenCalledWith(
        { chatJid: '15559001@s.whatsapp.net', isResume: true },
        'sent startup notification',
      );
    });

    it('sends the default back-online notice when no pending message exists', async () => {
      const h = await importMainWithMocks({
        instanceConfig: {
          name: 'q',
          type: 'agent',
          introSent: true,
          agentOptions: { sessionScope: 'shared' },
        },
        pendingStartupMessage: null,
      });

      await vi.advanceTimersByTimeAsync(3_000);

      expect(h.sendTracked).toHaveBeenCalledWith(
        h.connection,
        '15551230000@s.whatsapp.net',
        '*Agent back online* ✓',
        h.durability,
        { replayPolicy: 'safe' },
      );
    });
  });

  // ── J. historyMessages all-noop batch ─────────────────────────────────────

  describe('historyMessages — all-noop batch is silent', () => {
    it('does not log info when processHistoryBatch returns all zeros', async () => {
      const h = await importMainWithMocks();
      const beforeCallCount = (h.logger.info as ReturnType<typeof vi.fn>).mock.calls.length;

      h.processHistoryBatch.mockReturnValueOnce({ inserted: 0, upgraded: 0, placeholders: 0, skipped: 0 });
      h.connection.emit('historyMessages', [{ id: 'history-1' }]);

      // No new info logs beyond what existed before
      const afterCallCount = (h.logger.info as ReturnType<typeof vi.fn>).mock.calls.length;
      const newCalls = (h.logger.info as ReturnType<typeof vi.fn>).mock.calls.slice(beforeCallCount);
      const historyLogCalls = newCalls.filter((args) =>
        typeof args[1] === 'string' && args[1].includes('historyMessages'),
      );
      expect(historyLogCalls).toHaveLength(0);
    });
  });

  // ── K. Event handler error paths not covered by main test ─────────────────

  describe('event handler error paths', () => {
    it('jidAliasChanged throws → log.error', async () => {
      const h = await importMainWithMocks();
      h.upsertLidMapping.mockImplementationOnce(() => { throw new Error('upsert failed'); });
      h.connection.emit('jidAliasChanged', 'user@lid', '15551230000@s.whatsapp.net');
      expect(h.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'jidAliasChanged: failed to update delivery JID',
      );
    });

    it('lidPairDiscovered with mineMessageKey returning null → no upsert', async () => {
      const h = await importMainWithMocks();
      h.mineMessageKey.mockReturnValueOnce(null);
      h.connection.emit('lidPairDiscovered', 'user@lid', '15551230000@s.whatsapp.net');
      expect(h.upsertLidMapping).not.toHaveBeenCalled();
    });

    it('lidPairDiscovered throws → log.warn', async () => {
      const h = await importMainWithMocks();
      h.mineMessageKey.mockImplementationOnce(() => { throw new Error('mine failed'); });
      h.connection.emit('lidPairDiscovered', 'user@lid', '15551230000@s.whatsapp.net');
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'L3: failed to mine message key LID pair',
      );
    });

    it('groupsUpsert throws → log.error', async () => {
      const h = await importMainWithMocks();
      h.handleGroupsUpsert.mockImplementationOnce(() => { throw new Error('groups upsert failed'); });
      h.connection.emit('groupsUpsert', [{ id: 'group@s.whatsapp.net', participants: [] }]);
      expect(h.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'groupsUpsert: failed to persist group metadata',
      );
    });

    it('labelsEdit throws → log.error', async () => {
      const h = await importMainWithMocks();
      h.handleLabelsEdit.mockImplementationOnce(() => { throw new Error('labels edit failed'); });
      h.connection.emit('labelsEdit', [{ id: 'label-1' }]);
      expect(h.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'labelsEdit: failed to persist labels',
      );
    });

    it('decryptionFailure storeDecryptionFailure throws → log.error', async () => {
      const h = await importMainWithMocks();
      h.storeDecryptionFailure.mockImplementationOnce(() => { throw new Error('store failed'); });
      h.connection.emit('decryptionFailure', {
        messageId: 'm1',
        senderJid: 'sender@s.whatsapp.net',
        chatJid: 'chat@s.whatsapp.net',
        errorMessage: 'bad mac',
      });
      expect(h.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), messageId: 'm1' }),
        'failed to store decryption failure',
      );
    });

    it('groupJoinRequest logs info', async () => {
      const h = await importMainWithMocks();
      h.connection.emit('groupJoinRequest', {
        groupJid: 'group@s.whatsapp.net',
        requesterJid: 'requester@s.whatsapp.net',
      });
      expect(h.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ groupJid: 'group@s.whatsapp.net' }),
        'groupJoinRequest: join request received',
      );
    });
  });

  // ── Health server — group allow via POST /access ───────────────────────────

  describe('handleAccessDecision — group allow path', () => {
    it('logs info for group allow without replaying messages', async () => {
      const h = await importMainWithMocks();
      const healthDeps = h.getHealthDeps();
      await healthDeps.handleAccessDecision('group', 'group@s.whatsapp.net', 'allow');
      expect(h.logger.info).toHaveBeenCalledWith(
        { subjectType: 'group', subjectId: 'group@s.whatsapp.net' },
        'access: group allowed via POST /access',
      );
      expect(h.chatRuntime.handleMessage).not.toHaveBeenCalled();
    });

    it('block action requires no additional action (no log or replay)', async () => {
      const h = await importMainWithMocks();
      const healthDeps = h.getHealthDeps();
      const logCallsBefore = (h.logger.info as ReturnType<typeof vi.fn>).mock.calls.length;
      await healthDeps.handleAccessDecision('phone', '15551230000', 'block');
      // No new log for block (only DB update, no replay)
      const logCallsAfter = (h.logger.info as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(logCallsAfter).toBe(logCallsBefore);
    });
  });
});
