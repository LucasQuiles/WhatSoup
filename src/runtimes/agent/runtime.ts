// src/runtimes/agent/runtime.ts
// AgentRuntime implements the Runtime interface, tying all agent components together.

import type { AgentCommandRequest, AgentCommandResult, Runtime, RuntimeTurnCapabilityHealth } from '../types.ts';
import type { ContentType, IncomingMessage, Messenger, RuntimeHealth } from '../../core/types.ts';
import type { Database } from '../../core/database.ts';
import type {
  DurabilityEngine,
  SessionCheckpointRow,
  StaleReclaimedInbound,
} from '../../core/durability.ts';
import type { TurnRecoveryClaimFence, TurnRecoveryJobRow } from '../../core/turn-recovery-store.ts';
import type {
  TurnRecoveryDispatchTarget,
  TurnRecoveryReplayAbortControl,
  TurnRecoverySupervisor,
  TurnRecoveryReplayDispatchResult,
} from './turn-recovery-supervisor.ts';
import { createTurnRecoverySupervisorForRuntime, dispatchTurnRecoveryReplayForJob, shutdownTurnRecoverySupervisorSafely, getTurnRecoveryHealthDetails } from './turn-recovery-dispatch.ts';
import { TurnRecoveryDeadman } from './turn-recovery-deadman.ts';
import { splitInputTokenUsage, type AgentEvent } from './stream-parser.ts';
import {
  classifyProviderFailure,
  classifyStreamedProviderFailure,
  detectAutoSwitchNotice,
  isProviderAuthRequiredMessage,
  MAX_STREAMED_BANNER_LENGTH,
  type ProviderFailureKind,
} from './failure-taxonomy.ts';
import {
  workflowForProviderText,
  type ResponseWorkflow,
  type UserTemplateId,
} from './response-registry.ts';
import { autoSwitchNoticeMessage, renderUserMessage, providerUnknownTerminalNotice, renderFallbackAdvanceNotice } from './response-templates.ts';
import { runDiagnosticBundle } from './diagnostic-bundle.ts';
import { buildDiagnosticProbes } from './diagnostic-probes.ts';
import {
  ensureStandbyNoticeSchema,
  clearStandbyNotice,
} from './standby-notice.ts';
import {
  stashHandoffNotice as stashHandoffNoticeImpl,
  withHandoffPrefix as withHandoffPrefixImpl,
  flushPendingHandoffNotice as flushPendingHandoffNoticeImpl,
} from './handoff-notice-prefix.ts';
import { providerPreview } from './provider-preview-sanitizer.ts';
import { formatContextLines } from './context-lines.ts';
import { redactHandoffPii } from './handoff-pii-redactor.ts';
import { seamForProvider } from './handoff-seam-routing.ts';
import { ensureHandoffArtifactSchema, getHandoffArtifact, deleteHandoffArtifact } from './handoff-artifact.ts';
import { buildHandoffPrelude } from './handoff-prelude.ts';
import type { AgentProvider } from './providers/types.ts';
import { triggerSelfRestart, assertRestartSelfAdmin, type ServiceRestarter } from './self-restart.ts';
import { registerRuntimeInlineTools } from './runtime-tool-registrations.ts';
import { dequeueNextReport, emitHealReport, parseHealContext } from '../../core/heal.ts';
import { allowlistedHealCrashClass, errorClassForHealEvidence } from '../../core/heal-evidence.ts';
import { sendTracked } from '../../core/durability.ts';
import { classifyErrorForInbound } from '../../core/inbound-failure-class.ts';
import { PerChatTurnFifoOwnerConflictError } from './turn-admission-errors.ts';
import { initializeRuntimeLifecycleEmitter, runtimeLifecycleEmitter } from '../../core/observability/lifecycle-emission.ts';
import {
  normalizeFallbackEntriesFromAgentOptions,
  type AgentFallbackDiscoveryConfig,
  type AgentFallbackEntry,
} from '../../core/fallback-chain.ts';
import {
  type ProviderBoundaryMode,
  type ProviderDataPolicy,
} from '../../core/provider-data-policy.ts';
import {
  createReplyGuaranteeLivenessSender,
  DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS,
  ReplyGuaranteeManager,
} from '../../core/reply-guarantee.ts';
import { systemClock } from '../../lib/clock.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../../lib/emit-alert.ts';
import { lookupCredential, resolveProviderKeyService } from '../../lib/keyring.ts';
import { MS_PER_SECOND, MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY } from '../../lib/time-units.ts';
import {
  SESSION_IDLE_MS,
  SESSION_SWEEP_INTERVAL_MS,
  ZOMBIE_SESSION_SWEEP_INTERVAL_MS,
  AMBIGUOUS_SESSION_MAX_AGE_MS,
  MAX_RESIDENT_SESSIONS,
  SESSION_MIN_RESIDENCY_MS,
  MAX_TOOL_FAILURE_ALERT_DEDUP_KEYS,
  diagnosticBundleEnabled,
  DIAGNOSTIC_BUNDLE_THROTTLE_MS,
  HANDOFF_STALE_MS,
  AUTO_COMPACT_TIMEOUT_MS,
  SYSTEM_TURN_TIMEOUT_MS,
  AUTO_COMPACT_TIMEOUT_BACKOFF_MS,
} from './runtime-tunables.ts';
import { resolveProviderCredentialState, isProviderRoutable, spawnFailureCredentialNote } from '../../lib/provider-credential-eligibility.ts';
import { createChildLogger } from '../../logger.ts';
import {
  ensureAgentSchema,
  getActiveSession,
  backfillWorkspaceKeys,
  markOrphaned,
  getResumableSessionForChat,
  accumulateSessionTokens,
  insertTokenEvent,
  accumulateTokensWithEvent,
  backfillSessionProvider,
  getSessionTokenSnapshot,
  markSessionCompacted,
} from './session-db.ts';
import { reconcileResidentSessionStatuses } from './resident-session-reconciler.ts';
import {
  ensureFallbackStateSchema,
  getFallbackState,
} from './fallback-state-db.ts';
import { chatJidToWorkspace, provisionWorkspace, writeSandboxArtifacts, ensurePermissionsSettings } from '../../core/workspace.ts';
import { inspectUserClaudeSettings } from '../../core/user-claude-settings.ts';
import { isSamePhysicalDirectory } from '../../lib/home-path.ts';
import { classifyActiveSessions, resolveAmbiguousAgeFallback } from './session-classifier.ts';
import {
  SessionManager,
  formatAge,
  getProviderBinary,
  type SessionCrashInfo,
} from './session.ts';
import { createProviderExecutionGate, ProviderExecutionGate } from './provider-execution-gate.ts';
import { dispatchProviderTurn, withProviderApplicationContext } from './provider-boundary-dispatch.ts';
import { TurnChronologyTracker, type TurnDeliveryKind } from './turn-chronology.ts';
import {
  receivedAtUnixSeconds,
  renderPendingReplay,
  renderUserTurnForProvider,
  sharedReplayApplicationContext,
  sharedRuntimeApplicationContext,
} from './turn-provider-text.ts';
import { markDeferredSystemTurn, requireSystemTurnProviderBoundary } from './system-turn-deadline.ts';
import {
  OutboundQueue,
  type IOutboundQueue,
  type ToolUpdate,
  type ToolCategory,
} from './outbound-queue.ts';
import { ControlQueue } from './control-queue.ts';
import { classifyInput } from './commands.ts';
import { renderHelp, renderHelpDetail } from './help-render.ts';
import {
  ensureChatPreferenceSchema,
  pruneExpired,
} from './chat-preference-db.ts';
import { preferenceKeys } from './preference-keys.ts';
import type { RouteDecision } from './route-resolution.ts';
import type { fetchAnthropicModelIdsWithStatus } from '../../lib/model-advisor.ts';
import type { ModelRouteEvent } from './route-events.ts';
import { RuntimeRoutingCoordinator, type RuntimeRoutingPort } from './runtime-routing.ts';
import { RuntimeFallbackCoordinator, type RuntimeFallbackPort } from './runtime-fallback.ts';
import { emitManagedLoopDegradedNotice, isManagedLoopFallbackDegraded, managedLoopDegradedSystemBlock } from './managed-loop-disclosure.ts';
import { RuntimePollBridgeCoordinator, type RuntimePollBridgePort } from './runtime-poll-bridge.ts';
import { buildRoutingPromptContract } from './route-intent.ts';
import { createCatalogueSnapshotCache, type CatalogueSnapshotCache } from './model-snapshot-cache.ts';
import { tiersConfigured as modelTiersConfigured } from './model-catalogue-render.ts';
import {
  handleModelCommand,
  tryHandleBareKeep,
  consumePendingRecycleIfIdle as consumePendingRecycleIfIdleForPort,
  type ModelPinPort,
  type RouteRecycleOutcome,
} from './model-pin.ts';
import { RouteRecycleLifecycle } from './route-recycle-lifecycle.ts';
import {
  runKillSessionCommand,
  runSessionsCommand,
  shutdownOwnedSessions,
  type RuntimeSessionLifecycleHost,
} from './runtime-session-lifecycle.ts';
import {
  resolveExecutingActor as resolveExecutingActorForPort,
  wirePerChatActorSocket as wirePerChatActorSocketForPort,
  teardownPerChatActorSocket as teardownPerChatActorSocketForPort,
  findMapKeyForSession as findMapKeyForSessionForPort,
  getQueueForChat as getQueueForChatForPort,
  createOperationTracker as createOperationTrackerForPort,
  getTracker as getTrackerForPort,
  sendDirect as sendDirectForPort,
  sendDirectWithReceipt as sendDirectWithReceiptForPort,
  type ChatTransportPort,
  type SendDirectOutcome,
} from './chat-transport.ts';
import { getRecentMessages, getMessagesSince, hasFromMeReplyAfter } from '../../core/messages.ts';
import { toConversationKey, isGroupConversationKey, GLOBAL_CONVERSATION_KEY } from '../../core/conversation-key.ts';
import { classifyAssistantTextEgress } from '../../core/outbound-message-safety.ts';
import {
  isolateScheduledAgentJobPrompt,
  isScheduledAgentJobMapKey,
  resolveAgentTurnMapKey,
} from './scheduled-agent-job-isolation.ts';
import { resolveConfiguredAdminJid, toPersonalJid, isGroupJid } from '../../core/jid-constants.ts';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { contextMessagesForTurn } from './context-handoff.ts';
import { canonicalizeChatJid } from '../../core/lid-resolver.ts';
import { TurnQueue, type QueuedTurn, type TurnRejectReason } from './turn-queue.ts';
import {
  markRuntimeTurnReplayUnsafe,
  type RuntimeTurnContext,
} from './runtime-turn-context.ts';
import { resolveResumeIdentity, type PersistedResumeIdentity } from './resume-identity.ts';
import type { FinalizeRuntimeTurnResult } from './turn-finalizer.ts';
import { runtimeTurnRecoveryIsDegraded, RuntimeTurnSupervisor } from './runtime-turn-supervisor.ts';
import { CrashTracker } from './crash-tracker.ts';
import { AutoCompactController, AUTO_COMPACT_RAPID_REARM_WINDOW_MS } from './auto-compact-controller.ts';
import { ImageCoalescer } from './image-coalescer.ts';
import {
  PendingSystemResultTracker,
  type PendingSystemTurnOwner,
  type PendingSystemTurnSnapshot,
  type SystemTurnPurpose,
  type SystemTurnLeaseToken,
} from './pending-system-result-tracker.ts';
import {
  decideProviderEventAdmission,
  systemPurposeAllowsOutput,
  type ProviderEventOwner,
} from './runtime-event-admission.ts';
import {
  handleProviderFailureResult as handleProviderFailureResultWithPort,
  handleGlobalRuntimeResult,
  handleScopedRuntimeResult,
  type ProviderFailureResultContext,
  type ProviderFallbackReason,
  type ProviderFallbackActivation,
  type RuntimeResultHandlerPort,
} from './runtime-turn-result-handler.ts';
import {
  FallbackReplayInvalidatedError,
  RuntimeTurnCoordinator,
  RUNTIME_TURN_SHUTDOWN_FINALIZATION_TIMEOUT_MS,
  type PerChatRuntimeScopeRef,
  type ProviderFallbackReplayArgs,
  type ResolvedReplayRoute,
  type RuntimeTurnAfterTerminalAction,
  type RuntimeTurnCompletion,
  type RuntimeTurnCoordinatorPort,
  type RuntimeTurnPostEffects,
  type RuntimeTurnQueueTeardown,
  type RuntimeTurnSourceSnapshot,
  WedgedTurnReclaimedError,
} from './runtime-turn-coordinator.ts';
import { TurnCapabilityTracker, type TurnCapabilityErrorClass } from './turn-capability-tracker.ts';
import { SessionOwnershipRegistry } from './session-ownership.ts';
import { killSessionTree } from './process-tree.ts';
import { FallbackWindowMetrics } from './fallback-window-metrics.ts';
import { FallbackWindowState } from './fallback-window-state.ts';
import { FallbackChain } from './fallback-chain-state.ts';
import { FallbackEmptyAdvance } from './fallback-empty-advance.ts';
import { PendingPollStore } from './pending-poll-store.ts';
import { PendingPollPersistence } from './pending-poll-persistence.ts';
import {
  ConsumptionReceiptRecorder,
  OfflineDecisionRetryScheduler,
  QueuedDecisionConsumer,
} from './pending-poll-health.ts';
import { HandoffDistillCoordinator } from './handoff-distill-coordinator.ts';
import { CapabilityObligationRuntime, maybeActivateCapabilityObligationRuntime, shutdownCapabilityObligationRuntimeSafely } from './capability-obligation-runtime.ts';
import { handoffDistillerEnabled, handoffContextEnabled, handoffDistillModel } from './handoff-distill-config.ts';
import { config } from '../../config.ts';
import type { StartupNotificationEvent } from '../../core/startup-notification-controller.ts';
import {
  checkAndRecordInterruptedBoot,
  markBootInProgress,
  readRestartLoopGuardHealth,
  restartLoopGuardPath,
} from './restart-loop-guard.ts';
import { canonicalConversationKey, resolvePhoneFromJid, resolvePhoneFromJidForGrant } from '../../core/access-list.ts';
import { isAdminPhone } from '../../lib/phone.ts';
import { getCommandSpec } from './command-registry.ts';
import { matchImperative, extractImperativeTarget } from '../../core/substrate/inline-extractor.ts';
import { createBead } from '../../core/substrate/beads.ts';
import { mkdirSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EgressProxy } from './egress-proxy.ts';
import { ToolRegistry } from '../../mcp/registry.ts';
import { PerChatMcpSocketManager } from './per-chat-mcp-socket-manager.ts';
import { WhatSoupSocketServer } from '../../mcp/socket-server.ts';
import type { ExecutingSessionContext, SessionContext } from '../../mcp/types.ts';
import type { ConnectionManager } from '../../transport/connection.ts';
import { registerAllTools } from '../../mcp/register-all.ts';
import { startMediaBridge, setMediaBridgeChat, type MediaBridge } from './media-bridge.ts';
import { WorkspaceSweeper, type WorkspaceResource } from './workspace-sweeper.ts';
import {
  fallbackProviderConfigFor,
} from './fallback-config.ts';
import {
  formatClockForUser,
  formatTokenCount,
  modelCardLabel,
  providerDisplayName,
  templateForFallbackReason,
} from './runtime-presentation.ts';
import {
  buildProviderMcpConfigArgs,
  createProviderMcpBridge,
  providerMcpProxyScriptPath,
  writeProviderMcpConfig,
  writeProviderMcpConfigTarget,
} from './providers/mcp-bridge.ts';
import {
  executionModeForProvider,
  isProviderId,
  providerUsesWhatSoupMcp,
  requiresPerChatActorSocket,
} from './providers/index.ts';
import { canaryStoreProvisioned, readProviderCanaryAdmission } from './provider-canary-proof.ts';
import { probeBinaryAuthStatus, type listModelCatalog } from './providers/binary-preflight.ts';
import {
  probePrimaryModelUsability,
  primaryModelUsabilityRequiresAlert,
  type PrimaryModelUsabilityResult,
} from './providers/primary-model-usability.ts';
import { createPrimaryModelProbeAdapters } from './providers/primary-model-usability-adapters.ts';
import {
  buildPrimaryProbeAdapterDeps,
  expectedProbeDeadlineFromDueMs,
  expectedProbeDeadlineMs,
  periodicProbeBackoffMultiple,
} from './primary-readiness-probe.ts';
import {
  MessageHandlerDrainTimeoutError,
  drainMessageHandlersForShutdown,
} from './shutdown-message-handler-drain.ts';
import { ensureClaudeFileStoreCredential } from './providers/claude-filestore-heal.ts';
import {
  AccountIdentityVerifier,
  type AccountIdentityProbeTrigger,
  type AccountIdentityVerifierHost,
  type AccountIdentityVerifyFn,
} from './account-identity-verifier.ts';
import {
  accountIdentityDegradedReasons,
  deriveAccountIdentityHealth,
  type AccountIdentityHealth,
  type AccountIdentityVerification,
} from './providers/claude-account-identity.ts';
import {
  resolveFallbackRecoveryDecision,
  type FallbackRecoveryEvidence,
  type FallbackRecoveryReceipt,
} from './fallback-recovery-transaction.ts';
import { jitteredDelay, sleep } from '../../core/retry.ts';
import { synthesizeSpeech } from '../chat/providers/elevenlabs.ts';
import { writeTempFile } from '../../core/media-download.ts';
import { OperationTracker } from './operation-tracker.ts';
// Media prep (message → agent content + workspace relocation) extracted to media-prep.ts.
// Imported for the inbound pipeline; the public surface (prepareContentForAgent + the
// __*ForTests helpers) is re-exported below so namespace-importing tests are unchanged.
import { prepareContentForAgent, relocateMediaToWorkspace } from './media-prep.ts';
export {
  prepareContentForAgent,
  relocateMediaToWorkspace,
  __resetCreatedMediaDirsForTests,
  __rememberCreatedMediaDirForTests,
  __getCreatedMediaDirsSizeForTests,
  __hasCreatedMediaDirForTests,
} from './media-prep.ts';

const log = createChildLogger('agent-runtime');

interface LegacyProviderTurnOwner {
  readonly owner: PendingSystemTurnOwner;
  readonly routeChatJid: string;
}

/** Maximum duration (ms) a control session is allowed to run before force-shutdown. */
const CONTROL_SESSION_TIMEOUT_MS = 15 * MS_PER_MINUTE;

/** Max consecutive crashes before auto-respawn gives up and waits for user action. */
const AUTO_RESPAWN_MAX_CRASHES = 3;
/** Base delay (ms) before attempting auto-respawn after a crash. Actual delay uses exponential backoff. */
const AUTO_RESPAWN_BASE_MS = 2 * MS_PER_SECOND;
/** Maximum respawn delay (ms) — caps the exponential backoff. */
const AUTO_RESPAWN_MAX_DELAY_MS = 15 * MS_PER_SECOND;
/** Periodic runtime health stats emission interval. */
const HEALTH_STATS_INTERVAL_MS = MS_PER_MINUTE;
const SHARED_QUEUE_IDLE_MS = MS_PER_HOUR;
const SHARED_QUEUE_SWEEP_INTERVAL_MS = 10 * MS_PER_MINUTE;
// Single-sourced from conversation-key.ts so the tool/crash scope keys and the
// tool_calls telemetry sentinel can never drift apart.
const GLOBAL_TOOL_SCOPE_KEY = GLOBAL_CONVERSATION_KEY;
const GLOBAL_CRASH_SCOPE_KEY = GLOBAL_CONVERSATION_KEY;
// (TOOL_FAILURE_ALERT_EXCERPT_CHARS moved to ./tool-update.ts with alertExcerpt.)
/**
 * `modelUsable` reports `true` only when the primary-model usability probe behind
 * it is no older than this window. A stale `usable` probe (e.g. after reverting to
 * primary and then sitting idle, or if an external process strips creds) is
 * downgraded to `null` (unknown) so /health and monitors cannot read a green that
 * is hours out of date. See RCA 2026-06-24 (rb-bot stale-`modelUsable` gap).
 */
const MODEL_USABILITY_FRESHNESS_MS = 30 * MS_PER_MINUTE;

export type RuntimeTurnCapability = RuntimeTurnCapabilityHealth & {
  modelUsabilityStatus: PrimaryModelUsabilityResult['status'] | null;
  lastTurnErrorClass: TurnCapabilityErrorClass | null;
};

// The success-cooldown, rapid-rearm window, and backoff tiers now live in
// auto-compact-controller.ts alongside the state machine that uses them;
// AUTO_COMPACT_RAPID_REARM_WINDOW_MS is imported above for the trigger gate.
// Default auto-compact threshold: trigger /compact after 150k input tokens since last compact.
// Claude's context window is 200k tokens; compacting at 150k prevents "prompt too long" errors
// while leaving headroom for tool results and system prompts. Override per-instance via
// agentOptions.autoCompactInputTokens in config.json.
const DEFAULT_AUTO_COMPACT_INPUT_TOKENS = 150_000;

class AgentCommandRuntimeError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'AgentCommandRuntimeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface SandboxPolicy {
  allowedPaths: string[];
  allowedTools: string[];
  allowedMcpTools?: string[];
  bash: { enabled: boolean };
  /**
   * Opt-in egress allowlist (#1607 / QR-008). A non-empty list makes
   * `start()` boot a loopback `EgressProxy` bound to this policy and inject
   * its port into the child process env (see `egressProxyPort` on
   * `SessionManager`/`buildBaseChildEnv`). Absent or empty: no proxy, no env
   * injection — unchanged pre-#1607 behavior.
   */
  allowedEgress?: string[];
}

export type SessionScope = 'single' | 'shared' | 'per_chat';

export interface AgentRuntimeOptions {
  shared?: boolean;
  /** Session scope: 'single' (one chat), 'shared' (one session, many chats), 'per_chat' (one session per chat). */
  sessionScope?: SessionScope;
  cwd?: string;
  configSystemPrompt?: string;
  instructionsPath?: string;
  sandbox?: SandboxPolicy;
  /** Claude model identifier to pass via --model flag (e.g. 'claude-opus-4-6[1m]'). */
  model?: string;
  /** When true, each chat gets an isolated workspace directory with its own Claude config. Requires sessionScope 'per_chat'. */
  sandboxPerChat?: boolean;
  /**
   * When true, the per-chat actor socket carries a conversation-bound
   * SessionContext (see per-chat-actor-session.ts and docs/configuration.md).
   * Default false — the #1785 rec-3 behavior (send confinement only) is
   * unchanged. Requires sessionScope 'per_chat'; incompatible with sandboxPerChat.
   */
  perChatConversationBound?: boolean;
  /** Plugin directories to pass via --plugin-dir to the claude subprocess. */
  pluginDirs?: string[];
  /** Per-instance plugin enablement. Written to project settings.json to override global. */
  enabledPlugins?: Record<string, boolean>;
  /** Per-instance opt-in for propagating ALLOW_M365_MUTATIONS when fail-closed mode is enabled. */
  allowM365Mutations?: boolean;
  /** Automatically run a silent /compact after this many input tokens since the last compact. */
  autoCompactInputTokens?: number;
  /** Reply Guarantee timeout override for tests and tightly controlled deployments. */
  replyGuaranteeTimeoutMs?: number;
  /**
   * #3295 S2 (default OFF): defer replay-safe per_chat followers blocked
   * solely by outstanding turn recovery into durable obligations instead of
   * terminally rejecting them. Evaluated PER ADMISSION (kill-switch
   * semantics): flipping `enabled` off stops deferral immediately. Drain is
   * S3; until it lands an obligation only accumulates.
   */
  deferredTurnAdmission?: { enabled: boolean };
  /**
   * Systemd restart capability, injected from the composition root. The runtimes
   * layer cannot import the fleet layer, so main.ts constructs the concrete
   * ServiceManager and passes it here. When absent, the restart_self tool is not
   * registered (the agent cannot restart itself without it).
   */
  serviceRestarter?: ServiceRestarter;
  /**
   * Test-injectable catalogue probes for the `/model N` pin-time verify
   * (Task H — resolveModelCatalogue's own listFn/anthropicFn seam, threaded
   * one level further out so a test constructing the runtime can supply a
   * fake catalogue without spawning a real binary or hitting a real
   * keychain). Undefined in production — resolveModelCatalogue falls back
   * to the real probes.
   */
  modelCatalogueListFn?: typeof listModelCatalog;
  modelCatalogueAnthropicFn?: typeof fetchAnthropicModelIdsWithStatus;
  /**
   * Ratified account-identity digest (`service.expectedAccountDigest`,
   * task-21). When set, the runtime verifies the claude CLI's serving
   * identity against it on startup and on every primary-usability probe and
   * alerts on mismatch; it never writes a credential. null/undefined =
   * verification disabled (one info note at the first probe).
   */
  expectedAccountDigest?: string | null;
  /** Test seam for the identity verification (defaults to the real CLI probe). */
  accountIdentityVerify?: AccountIdentityVerifyFn;
}

export type RuntimePrimaryModelUsability = PrimaryModelUsabilityResult & {
  checkedAt: number | null;
  probeInFlight: boolean;
};

/**
 * Pure derivation of the `modelUsable` health verdict from the last usability
 * probe, gated on freshness. Either verdict — a `usable` green OR a
 * requires-alert red — older than `freshnessMs` is reported as `null` (unknown)
 * with `modelUsableStale=true` rather than a stale green or a stale red (#1884).
 * Pure + exported for direct unit testing (the probe state itself is private).
 */
export function deriveModelUsable(
  usability: RuntimePrimaryModelUsability | null,
  nowMs: number,
  freshnessMs: number = MODEL_USABILITY_FRESHNESS_MS,
): { modelUsable: boolean | null; modelUsableStale: boolean; modelUsableCheckedAt: number | null } {
  const modelUsableCheckedAt = usability?.checkedAt ?? null;
  if (!usability || usability.probeInFlight) {
    return { modelUsable: null, modelUsableStale: false, modelUsableCheckedAt };
  }
  if (usability.status === 'usable') {
    const fresh = typeof modelUsableCheckedAt === 'number'
      && (nowMs - modelUsableCheckedAt) <= freshnessMs;
    return fresh
      ? { modelUsable: true, modelUsableStale: false, modelUsableCheckedAt }
      : { modelUsable: null, modelUsableStale: true, modelUsableCheckedAt };
  }
  if (primaryModelUsabilityRequiresAlert(usability)) {
    // Symmetric with the `usable` branch (#1884): a "not usable" verdict older
    // than freshnessMs (e.g. a credential-unavailable cached at startup) is
    // stale evidence, not an authoritative red — report null (unknown) +
    // modelUsableStale=true so it re-probes rather than caching a stale false.
    const fresh = typeof modelUsableCheckedAt === 'number'
      && (nowMs - modelUsableCheckedAt) <= freshnessMs;
    return fresh
      ? { modelUsable: false, modelUsableStale: false, modelUsableCheckedAt }
      : { modelUsable: null, modelUsableStale: true, modelUsableCheckedAt };
  }
  return { modelUsable: null, modelUsableStale: false, modelUsableCheckedAt };
}

/**
 * Freshness window for `deriveModelUsable`. While the periodic primary-readiness
 * probe is armed the evidence can legitimately be as old as the scheduler's
 * next fire (interval × backoff, plus the full jitter band and a grace), so the
 * window follows the scheduler via `expectedProbeDeadlineMs`; a flat 30min
 * window declared it stale for up to 3 minutes every cycle and for the back
 * half of every backoff>=2 cycle (the canary `turn_capability_evidence_stale`
 * flap). With no periodic probe armed the flat window is preserved unchanged.
 * Pure + exported for direct unit testing.
 */
export function resolveModelUsabilityFreshnessMs(
  periodicProbeExpected: boolean,
  backoffMultiple: number,
  schedule: { nextProbeDueAt: number | null; checkedAt: number | null } | null = null,
): number {
  if (!periodicProbeExpected) return MODEL_USABILITY_FRESHNESS_MS;
  // The armed timer's due instant is the source of truth when known: cadence
  // and window can then never diverge (a manual probe that resets the backoff
  // re-arms the timer and moves this instant with it). The scheduler formula
  // is the fallback only while no due instant has been recorded.
  if (schedule !== null && schedule.nextProbeDueAt !== null && schedule.checkedAt !== null) {
    return expectedProbeDeadlineFromDueMs(schedule.nextProbeDueAt, schedule.checkedAt);
  }
  return expectedProbeDeadlineMs(backoffMultiple);
}
// ---------------------------------------------------------------------------
// AskUserQuestion → Poll formatting / resolution helpers
//
// Extracted to ./poll-resolution.ts (module-level FILE-reduction slice of the
// god-class decomposition). Imported here for AgentRuntime's use and re-exported
// to preserve the original public surface for external consumers (unchanged).
// ---------------------------------------------------------------------------
export {
  serializePendingPoll,
  deserializePendingPoll,
  evaluateResolution,
  evaluateResolutionOnTimeout,
  formatPollQuestion,
  type ResolutionStrategy,
  type PollVote,
  type ResolutionResult,
  type SerializedPendingPoll,
  type PendingPollQuestion,
} from './poll-resolution.ts';
import {
  deserializePendingPoll,
  evaluateResolution,
  evaluateResolutionOnTimeout,
  formatPollQuestion,
  resolveTypedPollAnswer,
  isLowSignalPollStatusReply,
  clearPendingPollTimers,
  removePollIdsForQuestion,
  advancePendingPollIndex,
  type PendingPollQuestion,
  type SerializedPendingPoll,
  type ResolutionStrategy,
  type PollVote,
  type AskUserQuestion,
  type AskUserOption,
} from './poll-resolution.ts';
import {
  isOperatorDmPeer,
  isTrustedInternalDmPeer,
} from '../../core/outbound-message-safety.ts';

// Tool_use → ToolUpdate formatting, tool-error classification, and operator-alert
// gating extracted to ./tool-update.ts (module-level FILE-reduction slice). Re-exported
// to preserve the public surface; imported here for AgentRuntime's use.
export {
  buildToolUpdate,
  classifyToolError,
  isOperatorActionableToolError,
  shouldEmitToolFailureAlert,
  stripToolErrorTags,
  isParallelSiblingCancellation,
} from './tool-update.ts';
import {
  buildToolUpdate,
  classifyToolError,
} from './tool-update.ts';
import { maybeEmitToolFailureAlert, type ToolFailureAlertDeps } from './tool-failure-alert.ts';
import { runNewCommand } from './runtime-new-command.ts';

// Provider-failure string matchers are the single source of truth in
// `./failure-taxonomy.ts`. They are imported above for internal use and re-exported
// here so existing importers (e.g. tests) keep `runtime.ts` as their entry point.
export {
  isUsageLimitMessage,
  isProviderAuthRequiredMessage,
  isRateLimitResultMessage,
  isProviderPolicyBlockMessage,
  isPromptTooLongMessage,
  isProviderModelUnavailableMessage,
} from './failure-taxonomy.ts';
import { errorMessage } from '../../lib/error-message.ts';







/**
 * Extract the usage-limit reset time from a provider usage-limit message.
 *
 * Claude usage-limit notices often name when the cap resets — e.g.
 *   "resets at 3pm", "resets at 15:00", "try again at 9:30am",
 *   "will be available at 11pm", or a raw Unix-epoch seconds value.
 * The fallback state machine uses this to schedule auto-revert to the primary
 * provider. Parsing is conservative: anything it cannot confidently interpret
 * yields `null`, and the caller then applies a default rolling-window estimate.
 *
 * Returned times are always in the future relative to `now` — a clock time like
 * "3pm" that has already passed today is rolled forward to tomorrow.
 *
 * @param text the usage-limit message text
 * @param now  injectable clock for deterministic tests (defaults to Date.now)
 * @returns the reset Date, or null when unparseable
 */
export function extractUsageLimitResetTime(text: string, now: Date = new Date()): Date | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lower = text.toLowerCase();

  // 1) Clock time after a reset cue: "resets at 3pm", "available at 15:00",
  //    "come back at 9:30am", "try again at 11 pm".
  //    Parsed FIRST so an explicit clock cue always wins over an incidental
  //    long number elsewhere in the message (e.g. an order/quota figure).
  //    The trailing (?!\d) prevents the clock hour from matching the leading
  //    digits of a longer number (e.g. "5551234567").
  const cue = /(?:reset[s]?|available|come\s+back|try\s+again|back)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?!\d)\s*(am|pm)?/i;
  const m = lower.match(cue);
  if (m) {
    let hour = Number.parseInt(m[1]!, 10);
    const minute = m[2] ? Number.parseInt(m[2], 10) : 0;
    const meridiem = m[3];
    if (
      Number.isFinite(hour) &&
      Number.isFinite(minute) &&
      hour >= 0 &&
      minute >= 0 &&
      minute < 60 &&
      (meridiem ? hour >= 1 && hour <= 12 : hour <= 23)
    ) {
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      const candidate = new Date(now);
      candidate.setHours(hour, minute, 0, 0);
      // A clock time already past today rolls forward to tomorrow.
      if (candidate.getTime() <= now.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
      }
      return candidate;
    }
  }

  // 2) Raw Unix epoch (seconds, 10 digits) — e.g. "resets at 1771000000".
  //    Milliseconds (13 digits) are also accepted. Cue-anchored: the epoch must
  //    directly follow a reset cue, so an incidental long number (order/quota
  //    figure) is never mistaken for a reset time.
  const epochMatch = lower.match(
    /(?:reset[s]?|available|try\s+again|come\s+back|back)\D{0,12}(1[5-9]\d{8}|[2-9]\d{9})(\d{3})?\b/,
  );
  if (epochMatch) {
    const seconds = epochMatch[1]!;
    const millis = epochMatch[2];
    const epochMs = millis
      ? Number.parseInt(seconds + millis, 10)
      : Number.parseInt(seconds, 10) * 1000;
    if (Number.isFinite(epochMs) && epochMs > now.getTime()) {
      return new Date(epochMs);
    }
  }

  return null;
}

// `isPromptTooLongMessage` lives in `./failure-taxonomy.ts` (imported + re-exported above).


export class AgentRuntime implements Runtime {

  private readonly db: Database;
  private readonly messenger: Messenger;
  private readonly instanceName: string;
  /** #3295 S2: live-read flag object for deferred-turn admission (null = feature absent). */
  private readonly deferredTurnAdmissionOptions: { enabled: boolean } | null;
  /** #2397: mapKeys that have exhausted auto-respawn and are not yet recovered. */
  private readonly exhaustedRespawnOwners = new Set<string>();
  private readonly shared: boolean;
  private readonly sessionScope: SessionScope;
  private readonly cwd: string | undefined;
  private readonly configSystemPrompt: string | undefined;
  private readonly instructionsPath: string | undefined;
  private readonly sandbox: SandboxPolicy | undefined;
  /** Opt-in egress-allowlist proxy (#1607); undefined when allowedEgress is absent/empty. */
  private egressProxy: EgressProxy | undefined;
  /** Test observability only — the egress proxy's bound port has no other externally visible signal. */
  get egressProxyPortForTest(): number | undefined {
    return this.egressProxy?.port;
  }
  private readonly model: string | undefined;
  private readonly sandboxPerChat: boolean;
  private readonly perChatConversationBound: boolean;
  /** F-STICKY-ACTOR (QR-263): nlRouting adds a DYNAMIC actor-race surface — a live
   *  per-sender `/model` pin can route a turn to a non-claude CLI provider at runtime,
   *  independent of the static primary/fallback config. Mutable only in tests. */
  private nlRoutingEnabled: boolean = config.nlRouting === true;
  private readonly serviceRestarter: ServiceRestarter | undefined;
  /** Task H injectable catalogue seam (AgentRuntimeOptions doc comment) — undefined in production. */
  private readonly modelCatalogueListFn: typeof listModelCatalog | undefined;
  private readonly modelCatalogueAnthropicFn: typeof fetchAnthropicModelIdsWithStatus | undefined;
  private readonly pluginDirs: string[];
  private readonly enabledPlugins: Record<string, boolean> | undefined;
  private readonly allowM365Mutations: boolean | undefined;
  private readonly autoCompactInputTokens: number | undefined;
  private readonly agentProvider: string;
  private readonly agentProviderConfig: Record<string, unknown> | undefined;
  private readonly agentDataPolicy: ProviderDataPolicy | null;
  private readonly providerBoundaryMode: ProviderBoundaryMode;
  // Automatic provider fallback (claude-cli → opencode-cli etc.) on usage limit.
  // The legacy scalar pair is normalized as entry zero for compatibility.
  // Discovery mode (R6): the array starts empty and the fallback coordinator
  // derives + maintains its contents IN PLACE from the gateway's model
  // catalogue — the reference must stay stable (ports hold it by identity).
  private readonly agentFallbacks: AgentFallbackEntry[];
  private readonly agentFallbackDiscovery: AgentFallbackDiscoveryConfig | null;
  private readonly replyGuaranteeTimeoutMs: number;
  private readonly registry: ToolRegistry;
  /** Coordinate snapshot for numbered-drill stability (D16/D17) — the exact
   *  ordered catalogue a `/model list` render showed, so `/model N` resolves
   *  against what the user actually saw. Not wired to any consumer besides
   *  the /model list render + apply path added in this task. */
  private readonly catalogueSnapshot: CatalogueSnapshotCache;
  private readonly providerExecutionGate: ProviderExecutionGate;

  // single mode: one session, one queue
  private session: SessionManager | null = null;
  private queue: IOutboundQueue | null = null;
  private activeChatJid: string | null = null;

  // shared mode: single session, per-chat outbound queues + global turn queue
  private outboundQueues: Map<string, IOutboundQueue> = new Map();

  // per_chat mode: independent session + queue per chatJid
  // When sandboxPerChat=true, maps are keyed by workspaceKey; when false, keyed by raw chatJid.
  private chatSessions: Map<string, SessionManager> = new Map();
  private chatQueues: Map<string, IOutboundQueue> = new Map();
  private readonly sessionOwnership = new SessionOwnershipRegistry();
  private readonly sessionManagerIds = new WeakMap<SessionManager, string>();
  private readonly sessionEventToolScopes = new WeakMap<SessionManager, string>();
  private readonly ownedSessionManagers = new Map<string, SessionManager>();

  // Operation tracker: per-session progress reporting & stall detection
  // Parallels session storage — single/shared uses operationTracker, per_chat uses operationTrackers map.
  private operationTracker: OperationTracker | null = null;
  private operationTrackers: Map<string, OperationTracker> = new Map();
  private workspaceResources: Map<string, WorkspaceResource> = new Map();
  private readonly perChatMcpSocketManager: PerChatMcpSocketManager;
  private globalMcpSocketPath: string | null = null;
  private replyGuarantee: ReplyGuaranteeManager | null = null;
  private turnQueue: TurnQueue;
  private currentTurnChatJid: string | null = null;

  // NOTE: turnHadVisibleOutput is only tracked in the non-per-chat handleEvent path.
  // Spawn-per-turn providers route through handleEventWithContext which does not
  // use this flag. The "(no response)" fallback only exists in handleEvent.
  private turnHadVisibleOutput = false;
  private turnHadSuppressedReplySatisfaction = false;
  private turnChain: Promise<void> = Promise.resolve();
  private healthStatsTimer: ReturnType<typeof setInterval> | null = null;
  private proactiveResumeIdentityRejects = 0;
  // C5 restart-loop guard: true when this boot follows an unclean exit
  // (captured at the top of start()); consumed by the startup resume gate.
  private restartLoopInterruptedBoot = false;
  private unownedProviderEventRejects = 0;
  /**
   * BY-DESIGN suppressions: effects of an OWNED system_request turn rejected
   * as purpose_disallows_effect. Counted apart from unownedProviderEventRejects
   * so designed suppression (a chatty model on a context-injection turn) is
   * distinguishable in health from genuine attribution leakage (no_owner /
   * source_session_not_current) — conflating them was the operator trap in the
   * ml-bot 2026-08-10/11 investigations.
   */
  private suppressedSystemTurnEffectRejects = 0;
  private readonly turnChronology = new TurnChronologyTracker();
  private readonly providerEventRejectReasonCounts = new Map<string, number>();
  /**
   * Explicit source-bound ownership for turns admitted without a durability
   * journal row. Production normally uses RuntimeTurnContext; this lane keeps
   * legacy/test deployments fail-closed without inferring ownership from a
   * queue or mutable current-chat field.
   */
  private readonly legacyProviderTurnOwners = new Map<string, LegacyProviderTurnOwner>();
  private workspaceSweeper: WorkspaceSweeper;
  private queueSweepTimer: ReturnType<typeof setInterval> | null = null;
  private sessionSweepTimer: ReturnType<typeof setInterval> | null = null;
  private zombieSessionSweepTimer: ReturnType<typeof setInterval> | null = null;
  // Background handoff distiller (flag-gated). The coordinator owns the timer +
  // runner lifecycle; it stays inert when the flag is off OR the model/key fails
  // to resolve. Initialized in the constructor (needs db + instanceName + the
  // config readers, which stay on AgentRuntime for the health/context callers).
  private readonly handoffDistill: HandoffDistillCoordinator;
  private pendingRespawnTimers = new Set<ReturnType<typeof setTimeout>>();
  // Provider-fallback window lifecycle scalars (active-until / activated-at /
  // arm-reason / reset-at / recovery-probe-required / active-entry). Owned by the
  // collaborator; the arm / activate / deactivate / revert / probe orchestration
  // stays in AgentRuntime and pokes these fields directly. isActive() carries the
  // only read logic. Pure field-relocation — no behavior change.
  private readonly fallbackWindow = new FallbackWindowState();
  // Process-local fallback-window telemetry (turns served/empty + arm-time
  // snapshots, lifetime activation/revert/replay totals, and window USD cost).
  // Increment/snapshot/delta logic lives in the collaborator; the orchestration
  // (window-active gate on cost, served-vs-empty decision + alerting, and the
  // arm/deactivate/replay call sites) stays in AgentRuntime.
  private readonly fallbackMetrics = new FallbackWindowMetrics();
  // Per-window fallback-chain state (failed-entry keys + last-selection
  // eligibility + entry-key/snapshot/exhausted queries). The selection DECISION
  // (selectFallbackEntryForWindow / markActiveFallbackFailed) stays in AgentRuntime
  // and drives this; agentFallbacks (config) stays here and is passed in.
  private readonly fallbackChain = new FallbackChain();
  // Empty-output advance accounting for the CURRENT active fallback entry: the
  // consecutive-empty-turn run + the attempted-key guard. A structurally-dead
  // fallback model (connects but emits no assistant text) returns empty every turn;
  // once the run reaches EMPTY_OUTPUT_FALLBACK_THRESHOLD the entry is advanced
  // through the SAME path terminal failures use. The advance ACTION (re-select +
  // alert) stays in recordFallbackTurnOutcome; the collaborator owns the state +
  // the should-advance predicate.
  private readonly fallbackEmptyAdvance = new FallbackEmptyAdvance();
  private revertTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackPrimaryProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicUsabilityProbeTimer: ReturnType<typeof setTimeout> | null = null; private periodicUsabilityProbeBackoff = 0;
  /** Epoch ms the armed periodic probe timer is due (same clock as checkedAt); null while no timer is armed. */
  private periodicUsabilityProbeDueAt: number | null = null;
  // Consecutive failed recovery probes on the revert-timer EXTENSION path
  // (process-local, reset on deactivation — which a successful probe triggers).
  // Early-window standing probes do not count: nothing is extending yet.
  // At config.fallbackTunables.probeStallThreshold one fallback_recovery_stalled
  // alert fires per stall episode; the window keeps extending regardless.
  private fallbackProbeAttempts = 0;
  // Epoch ms of the most recent recovery probe (either path); null until the
  // first probe. Process-local observability only — never persisted.
  private fallbackLastProbeAt: number | null = null;
  // #3019: true when the current fallback window was restored from persisted
  // state (a restart mid-window), false when freshly activated in this
  // process. Content-free continuity evidence surfaced in the health snapshot.
  private fallbackWindowRestored = false;
  // A2: set on a probe-confirmed revert; cleared by the first real post-revert turn success (the honest canary) — a failing turn leaves it untouched.
  private pendingPostRevertConfirmation = false;
  // Epoch ms of the last diagnostic-bundle kick (instance-level throttle).
  private lastDiagnosticBundleAt = 0;
  private primaryModelUsability: RuntimePrimaryModelUsability | null = null;
  private primaryModelUsabilityAlertActive = false;
  /** Ratified account-identity digest; null = identity verification disabled (task-21). */
  private readonly expectedAccountDigest: string | null;
  /** Last identity verification result — runtime-owned so the health snapshot reads it directly. */
  private accountIdentity: AccountIdentityVerification | null = null;
  /** When the expectation was armed (construction); `never-verified` is judged from here. */
  private readonly accountIdentityArmedAt: number | null;
  private readonly accountIdentityVerifier: AccountIdentityVerifier;
  /** Consecutive empty PRIMARY-provider user turns; reset on any successful turn
   *  or when an empty-output fallback is armed. Drives the empty-output fallback
   *  trigger — see maybeArmFallbackAfterEmptyPrimaryTurn. */
  private consecutivePrimaryEmptyTurns = 0;
  /** Consecutive unclassified-terminal (is_error, classifyProviderFailure→null)
   *  PRIMARY user turns; reset on any successful turn or when the unknown-terminal
   *  fallback is armed. Drives the unknown-terminal fallback trigger — see
   *  maybeArmFallbackAfterUnknownTerminal. Kept SEPARATE from
   *  consecutivePrimaryEmptyTurns (short-circuited on this path) and from the
   *  cumulative errorCounts['unknown-terminal'] (which is not consecutive). */
  private consecutiveUnknownTerminalTurns = 0;
  /** Monotonic construction timestamp (performance.now()), used for the
   *  empty-output arming startup grace — see EMPTY_OUTPUT_ARM_STARTUP_GRACE_MS.
   *  Using performance.now() rather than Date.now() so NTP steps and
   *  sleep-wake clock jumps cannot prematurely end or over-extend the grace
   *  window (R1 hardening). */
  private readonly runtimeBootPerfMs = performance.now();
  // Turn-outcome telemetry feeding the fallback decision + /health: last successful
  // user turn, last user-turn error class/time, and cumulative per-class failure
  // counts. The is-user-turn guard + consecutivePrimaryEmptyTurns reset stay in
  // recordTurnCapabilitySuccess/Failure; the field mutations live in the tracker.
  private readonly turnCapabilityTracker = new TurnCapabilityTracker();
  // Silent-compact + auto-compact rearm state machine (cooldown/last-success/
  // rapid-rearm/measure/boundary maps, in-flight waiters, and cumulative health
  // counters). Constructed in the constructor once autoCompactInputTokens is known.
  // See src/runtimes/agent/auto-compact-controller.ts.
  private readonly autoCompact: AutoCompactController;

  /**
   * Post-turn event gate — tracks mapKeys where a 'result' event has been
   * processed but no new user message has arrived yet. Events arriving while
   * the gate is active are SDK-injected artifacts (system-reminders that
   * trigger phantom model output) and must be suppressed.
   *
   * Set: on 'result' event in handleEventWithContext
   * Cleared: in sendTurnPerChat when the next user message initiates a turn
   */
  private postTurnGate = new Set<string>();

  // ---------------------------------------------------------------------------
  // AskUserQuestion → Poll bridge state
  // ---------------------------------------------------------------------------
  // The pending-poll map + its two active-guard queries live in the collaborator;
  // AgentRuntime's settle/expiry/persist/restore/cleanup orchestration drives
  // this.pendingPolls.questions directly.
  private readonly pendingPolls = new PendingPollStore();
  /** Exact source-turn terminal barrier for each live AskUser continuation. */
  private readonly pendingPollSourceTurnBarriers = new WeakMap<PendingPollQuestion, Promise<void>>();
  /** Tool IDs for which the auto-resolved is_error tool_result should be suppressed. */
  private suppressedAskUserToolIds = new Set<string>();
  private groupMetadataCache = new Map<string, { adminJids: Set<string>; fetchedAt: number }>();
  private static readonly GROUP_METADATA_CACHE_TTL_MS = 5 * MS_PER_MINUTE;
  private static readonly GROUP_METADATA_CACHE_MAX = 256;

  // Crash tracking — keyed by per-chat mapKey for per_chat runtimes and by a
  // single global key for single/shared mode. Counts survive session map deletions
  // so health reporting can surface recent failures until a successful respawn decays them.
  // The count map + lastCrashAt live in CrashTracker; scope-KEY derivation
  // (getCrashScopeKey) stays here because it depends on runtime config.
  private readonly crashes = new CrashTracker();

  /** Maps toolScopeKey → (toolId → toolName) so tool_result errors stay isolated per session scope. */
  private activeToolNames = new Map<string, Map<string, string>>();
  private nextToolScopeOrdinal = 0;
  private recentProviderFallbackNotices = new Map<string, number>();
  private recentFallbackEmptyTurnAlerts = new Map<string, number>();
  private recentToolFailureAlerts = new Map<string, number>();
  /**
   * Dedup for {@link emitNoFallbackReauthNotice} (QR-211), keyed `${chatJid}:auth-required`.
   * A dedicated map rather than folding into recentProviderFallbackNotices — that
   * map's keys are 4-part (chatJid:reason:fallbackProvider:fallbackModel) and mean
   * "already told this chat which backup took over"; this is the opposite case
   * (no backup took over at all) and needs its own 2-part key shape.
   */
  private recentNoFallbackReauthNotices = new Map<string, number>();

  /**
   * Dedup for {@link emitManagedLoopDegradedNotice}
   * (#3149), keyed `${chatJid}:managed-loop-degraded` — "this chat was already
   * told it is being served with reduced capabilities" within the notice window.
   */
  private recentManagedLoopDegradedNotices = new Map<string, number>();

  /**
   * Tracks toolScopeKeys where at least one non-phantom tool_use event was
   * processed for the current turn. Used to suppress the empty-turn fallback
   * notice when the agent's entire reply was tool work (e.g. send_message,
   * send_media MCP tools) — in that case the user already received a visible
   * result via the outbound channel and the "no reply" notice would be wrong.
   *
   * Lifecycle: set on tool_use (after post-turn-gate check); cleared by
   * clearToolNames at the start of each result event (same lifecycle as
   * activeToolNames). Not persisted — process-local only.
   */
  private turnHadToolActivity = new Set<string>();

  /** For the single/shared path (handleEvent): mirrors turnHadToolActivity
   *  as a boolean since that path uses a single global scope key. */
  private singleTurnHadToolActivity = false;

  // Best-effort SQLite durability for pending polls (save/remove/loadRows + the
  // swallowed-error counter surfaced in health). Initialized in the constructor —
  // it needs the db. rehydratePendingPolls orchestrates loadRows() into the store +
  // timers + downtime notify; settle/delete/expiry call save/remove.
  private readonly pollPersistence: PendingPollPersistence;
  // CAR-20 (#2539): offline poll-decision retry owner + durable consumption receipts.
  private readonly offlineDecisionRetry = new OfflineDecisionRetryScheduler();
  private readonly consumptionReceipts!: ConsumptionReceiptRecorder;
  private readonly queuedDecisionConsumer!: QueuedDecisionConsumer;

  private recordCrash(mapKey: string): number {
    return this.crashes.record(mapKey);
  }

  private getCrashCount(mapKey: string): number {
    return this.crashes.count(mapKey);
  }

  /**
   * Window for the health-degraded crash signal (#1427). A crash older than this
   * no longer degrades health, so a transient crash that immediately recovers
   * clears within the window instead of pinning status=degraded forever. Sustained
   * crash LOOPS are still caught by auto-respawn exhaustion (a separate alert), so
   * a short window here only governs the soft "crashed recently" health hint.
   */
  private static readonly CRASH_HEALTH_DECAY_WINDOW_MS = 10 * MS_PER_MINUTE;

  private getRecentCrashCount(): number {
    return this.crashes.recentWithin(AgentRuntime.CRASH_HEALTH_DECAY_WINDOW_MS);
  }

  private decrementCrashCount(mapKey: string): void {
    this.crashes.decrement(mapKey);
  }

  private getCrashScopeKey(chatJid: string): string {
    if (this.sessionScope !== 'per_chat') {
      return GLOBAL_CRASH_SCOPE_KEY;
    }
    return this.sandboxPerChat
      ? chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey
      : chatJid;
  }

  private createToolScopeKey(scopeBase: string): string {
    this.nextToolScopeOrdinal += 1;
    return `${scopeBase}#${this.nextToolScopeOrdinal}`;
  }

  private requireSessionToolScopeKey(session: SessionManager): string {
    const toolScopeKey = this.sessionEventToolScopes.get(session);
    if (!toolScopeKey) {
      throw new Error('Cannot dispatch a runtime turn for an unregistered session manager');
    }
    return toolScopeKey;
  }

  private getToolNames(toolScopeKey: string): Map<string, string> {
    let names = this.activeToolNames.get(toolScopeKey);
    if (!names) {
      names = new Map<string, string>();
      this.activeToolNames.set(toolScopeKey, names);
    }
    return names;
  }

  private clearToolNames(toolScopeKey: string): void {
    this.activeToolNames.delete(toolScopeKey);
    // Note: turnHadToolActivity is NOT cleared here — the result handler captures
    // it for the empty-turn check and clears it explicitly after the check.
  }

  /**
   * Bound an evict-oldest dedup map. Mirrors the recentToolFailureAlerts cap so
   * window-pruned maps can't grow without limit between prunes (e.g. one entry per
   * distinct chat that never recurs within the window).
   */
  private capDedupeMap(map: Map<string, unknown>, max = MAX_TOOL_FAILURE_ALERT_DEDUP_KEYS): void {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /**
   * Clear all tool-scope state belonging to one mapKey. Tool scope keys are
   * `${mapKey}#${ordinal}` (see createToolScopeKey), so on a per_chat crash we must
   * drop only the crashing chat's scopes — a blanket `.clear()` would stomp other
   * concurrent chats' in-flight tool state (mislabeled tool errors, mis-fired
   * empty-turn notices for bystander chats).
   */
  private clearToolScopeFor(mapKey: string): void {
    // Scope keys are always `${mapKey}#${ordinal}` (createToolScopeKey), so a prefix
    // match on `${mapKey}#` is exact — `chat#…` never matches `chat2#…`.
    const prefix = `${mapKey}#`;
    for (const key of this.activeToolNames.keys()) {
      if (key.startsWith(prefix)) this.activeToolNames.delete(key);
    }
    for (const key of this.turnHadToolActivity) {
      if (key.startsWith(prefix)) this.turnHadToolActivity.delete(key);
    }
  }

  /**
   * Bind the runtime's live state + collaborators for tool-failure alerting
   * (tool-failure-alert.ts). Built fresh at each tool-error call site so the
   * provider label and dedup map are read on the same tick as the failure, and
   * the shared capDedupeMap keeps the dedup map bounded — identical to the
   * former inline method.
   */
  private toolFailureAlertDeps(): ToolFailureAlertDeps {
    return {
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      cwd: this.cwd,
      toolFailureAlertsEnabled: config.toolFailureAlertsEnabled,
      resolveProvider: () => this.effectiveProvider || this.agentProvider || 'unknown-provider',
      recentToolFailureAlerts: this.recentToolFailureAlerts,
      capDedupeMap: (map) => this.capDedupeMap(map),
    };
  }

  // The auto-compact bookkeeping state machine lives in AutoCompactController
  // (src/runtimes/agent/auto-compact-controller.ts). These privates stay as thin
  // delegators so the turn-pipeline call sites (and their characterization tests)
  // are unchanged; the TRIGGER decision maybeStartAutoCompact stays below because
  // it depends on the db/session/pending-system tracking, not on this state.
  private beginSilentCompact(scopeKey: string): void {
    this.autoCompact.beginSilentCompact(scopeKey);
  }

  private isSilentCompact(scopeKey?: string): boolean {
    return this.autoCompact.isSilentCompact(scopeKey);
  }

  private clearSilentCompact(scopeKey?: string): void {
    this.autoCompact.clearSilentCompact(scopeKey);
  }

  private finishAutoCompact(scopeKey: string): void {
    this.autoCompact.finishAutoCompact(scopeKey);
  }

  private consumeCompactBoundary(scopeKey: string): boolean {
    return this.autoCompact.consumeCompactBoundary(scopeKey);
  }

  private recordAutoCompactSuccess(scopeKey: string): void {
    this.autoCompact.recordAutoCompactSuccess(scopeKey);
  }

  private recordAutoCompactRapidRearm(scopeKey: string, lastSuccessAt: number, now: number): void {
    this.autoCompact.recordAutoCompactRapidRearm(scopeKey, lastSuccessAt, now);
  }

  private recordAutoCompactNextTurnIfNeeded(
    scopeKey: string,
    inputTokens: number | undefined,
    consumeWhenNotOverThreshold = true,
  ): void {
    this.autoCompact.recordAutoCompactNextTurnIfNeeded(scopeKey, inputTokens, consumeWhenNotOverThreshold);
  }

  /**
   * A provider stream without request IDs cannot safely retain a timed-out
   * classification slot while admitting another request. Prove the old process
   * tree is gone before cancelling the exact lease and reopening the lane.
   */
  private quarantineTimedOutSystemTurn(
    session: SessionManager,
    scopeKey: string,
    lease: SystemTurnLeaseToken,
  ): Promise<boolean> {
    const existing = this.systemTurnQuarantines.get(scopeKey);
    if (existing) return existing;

    let quarantine!: Promise<boolean>;
    quarantine = session.shutdown(false).then(
      () => true,
      (err) => {
        log.error(
          { err, scopeKey, leaseId: lease.id },
          'timed-out system request quarantine failed — provider lane remains closed',
        );
        return false;
      },
    ).then((provedClosed) => {
      if (provedClosed && this.systemTurnQuarantines.get(scopeKey) === quarantine) {
        this.systemTurnQuarantines.delete(scopeKey);
      }
      return provedClosed;
    });
    this.systemTurnQuarantines.set(scopeKey, quarantine);
    return quarantine;
  }

  private async waitForSystemTurnQuarantine(scopeKey: string): Promise<void> {
    const quarantine = this.systemTurnQuarantines.get(scopeKey);
    if (!quarantine) return;
    if (await quarantine) return;
    throw new Error(`SYSTEM_TURN_QUARANTINE_FAILED: provider lane "${scopeKey}" remains closed`);
  }

  private async settleFailedSystemTurnDispatch(
    session: SessionManager,
    scopeKey: string,
    lease: SystemTurnLeaseToken | null | undefined,
    error: unknown,
  ): Promise<void> {
    if (!lease) return;
    const message = error instanceof Error ? error.message : String(error);
    const status = session.getStatus();
    // A synchronous one-flight rejection proves this new lease never crossed
    // the provider boundary. Likewise, a manager reporting no request owner has
    // already proved pre-dispatch failure or completed teardown.
    if (message.includes('PROVIDER_TURN_IN_FLIGHT') || status.turnInFlight !== true) {
      this.pendingSystemResults.cancel(lease);
      return;
    }
    const provedClosed = await this.quarantineTimedOutSystemTurn(session, scopeKey, lease);
    if (provedClosed) {
      this.pendingSystemResults.cancel(lease);
      return;
    }
    throw new Error(`SYSTEM_TURN_QUARANTINE_FAILED: provider lane "${scopeKey}" remains closed`, {
      cause: error,
    });
  }

  private maybeStartAutoCompact(session: SessionManager | null, mapKey?: string): void {
    if (this.autoCompactInputTokens === undefined || session === null) return;
    // QR-105: '/compact' is a claude-cli-only slash command. For any other provider
    // (codex-cli/opencode-cli/gemini-cli, anthropic-api/openai-api) sending it is a
    // plain user message that never emits a compact_boundary — so markSessionCompacted
    // never advances and EVERY over-threshold turn re-fires it, UNTHROTTLED (the
    // rapid-rearm + cooldown safeguards below key on the claude-only compact_boundary /
    // success / timeout events, which never fire). Gate on the SESSION's actual provider
    // (getProviderId, not the primary this.agentProvider) so a fallback-to-non-claude
    // session is skipped too. If per-provider compaction is added later, extend here.
    // Defensive typeof check mirrors the getProviderId call site at ~5366; an
    // indeterminate provider fails safe (skip the claude-only command).
    const sessionProvider =
      typeof session.getProviderId === 'function' ? session.getProviderId() : null;
    if (sessionProvider !== 'claude-cli') return;
    if (this.sessionScope === 'shared') return;
    if (!session.getStatus().active) return;

    const rowId = session.getDbRowId();
    if (rowId === null) return;

    const snapshot = getSessionTokenSnapshot(this.db, rowId);
    if (!snapshot) return;

    // #1774: total_input_tokens no longer includes cache_read (it is
    // genuinely-new input only — see the schema note above ensureAgentSchema
    // in session-db.ts). This heuristic's job is unchanged: approximate how
    // much of the model's context window this session has consumed since
    // its last compact. cache_read IS that consumed context being re-read,
    // so the combined value below is deliberately the SAME quantity the
    // pre-split single column used to hold — this preserves today's
    // trigger point exactly, with zero recalibration of autoCompactInputTokens.
    const totalCombined = snapshot.totalInputTokens + snapshot.totalCacheReadTokens;
    const lastCompactCombined = snapshot.lastCompactInputTokens + snapshot.lastCompactCacheReadTokens;
    const inputSinceCompact = Math.max(0, totalCombined - lastCompactCombined);
    if (inputSinceCompact < this.autoCompactInputTokens) return;

    const scopeKey = mapKey ?? GLOBAL_TOOL_SCOPE_KEY;

    // Rollout bootstrap: existing sessions that already accumulated past the
    // threshold before this knob was enabled would otherwise fire /compact
    // on their very next turn — a fleet-wide enable could trigger a compact
    // storm. Detect by lastCompactInputTokens=0 + totalInputTokens at or
    // above threshold (matches the outer gate's >= semantics), advance the
    // baseline once silently, and let the natural threshold cycle take over.
    //
    // Side effect to be aware of: a brand-new session whose first turn
    // happens to cross the threshold (large file ingestion, very low
    // threshold) will also take this path and silently skip its first real
    // compact. Same anti-storm behaviour; documented in docs/runbook.md.
    if (snapshot.lastCompactInputTokens === 0 && totalCombined >= this.autoCompactInputTokens) {
      markSessionCompacted(this.db, rowId);
      log.info({
        scopeKey,
        rowId,
        totalInputTokens: snapshot.totalInputTokens,
        totalCacheReadTokens: snapshot.totalCacheReadTokens,
        lastCompactInputTokens: snapshot.lastCompactInputTokens,
        threshold: this.autoCompactInputTokens,
      }, 'auto compact baseline initialised for existing session');
      return;
    }

    if (this.autoCompact.waiters.has(scopeKey) || this.isSilentCompact(scopeKey)) return;

    const now = Date.now();
    const lastSuccessAt = this.autoCompact.lastSuccessAt.get(scopeKey);
    if (lastSuccessAt !== undefined) {
      const withinRapidRearmWindow = now - lastSuccessAt < AUTO_COMPACT_RAPID_REARM_WINDOW_MS;
      const alreadyRecordedForSuccess =
        this.autoCompact.rapidRearmRecordedForSuccessAt.get(scopeKey) === lastSuccessAt;
      if (withinRapidRearmWindow && !alreadyRecordedForSuccess) {
        this.recordAutoCompactRapidRearm(scopeKey, lastSuccessAt, now);
        return;
      }
      if (!withinRapidRearmWindow && !alreadyRecordedForSuccess) {
        this.autoCompact.consecutiveRapidRearms.delete(scopeKey);
        this.autoCompact.lastSuccessAt.delete(scopeKey);
      }
    }

    const cooldownUntil = this.autoCompact.cooldownUntil.get(scopeKey);
    if (cooldownUntil !== undefined) {
      if (now < cooldownUntil) return;
      this.autoCompact.cooldownUntil.delete(scopeKey);
    }

    let resolveWaiter!: () => void;
    let compactLease: SystemTurnLeaseToken | null = null;
    const timer = setTimeout(() => {
      log.error(
        { scopeKey, rowId, timeoutMs: AUTO_COMPACT_TIMEOUT_MS, backoffMs: AUTO_COMPACT_TIMEOUT_BACKOFF_MS },
        'auto compact timed out',
      );
      this.clearSilentCompact(scopeKey);
      this.finishAutoCompact(scopeKey);
      this.autoCompact.cooldownUntil.set(scopeKey, Date.now() + AUTO_COMPACT_TIMEOUT_BACKOFF_MS);
      // The stream has no per-request correlation. If /compact produced no
      // terminal result, retaining its FIFO slot while admitting a user request
      // lets the user's result consume the compact slot. Tear down the source
      // process first; only proven teardown cancels the exact lease.
      if (compactLease) {
        void this.quarantineTimedOutSystemTurn(session, scopeKey, compactLease)
          .then((provedClosed) => {
            if (provedClosed) this.pendingSystemResults.cancel(compactLease);
          });
      }
    }, AUTO_COMPACT_TIMEOUT_MS);
    timer.unref?.();

    const promise = new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
    this.autoCompact.waiters.set(scopeKey, { promise, resolve: resolveWaiter, timer });
    this.beginSilentCompact(scopeKey);

    log.info({
      scopeKey,
      rowId,
      inputSinceCompact,
      threshold: this.autoCompactInputTokens,
    }, 'auto compact triggered');

    compactLease = this.markSystemTurn(
      session,
      scopeKey,
      'auto_compact_silent',
      mapKey !== undefined
        ? this.chatQueues.get(mapKey)?.targetChatJid
        : (this.currentTurnChatJid ?? this.activeChatJid ?? undefined),
    );
    void session.sendTurn('/compact').catch(async (err) => {
      log.warn({ err, scopeKey, rowId }, 'auto compact send failed');
      this.clearSilentCompact(scopeKey);
      this.finishAutoCompact(scopeKey);
      await this.settleFailedSystemTurnDispatch(session, scopeKey, compactLease, err);
    }).catch((err) => {
      log.error({ err, scopeKey, rowId }, 'auto compact failed to quarantine ambiguous dispatch');
    });
  }

  /**
   * True while a turn is dispatching/pending for scopeKey — per-chat
   * (perChatInboundSeqQueue + that chat's runtime TurnQueue) or the single/
   * shared scope (currentInboundSeq/currentTurnChatJid + the global
   * turnQueue). Pure predicate, no throw — shared by assertNoActiveUserTurn
   * (which throws for command rejection) and Task G's recycle gating (which
   * must never throw: a busy chat defers the recycle instead of rejecting
   * the pin that triggered it).
   */
  private isTurnInFlight(scopeKey: string): boolean {
    if (this.sessionScope === 'per_chat') {
      const runtimeQueue = this.perChatTurnQueues.get(scopeKey);
      return (
        (this.perChatInboundSeqQueue.get(scopeKey)?.length ?? 0) > 0
        || (this.perChatRuntimeTurnContexts.get(scopeKey)?.length ?? 0) > 0
        || this.perChatRuntimeTurnCompletions.has(scopeKey)
        || runtimeQueue?.isProcessing === true
        || (runtimeQueue?.pending ?? 0) > 0
        || this.runtimeTurnCoordinator.hasPerChatTeardownPending(scopeKey)
      );
    }
    return (
      this.currentInboundSeq !== undefined
      || this.currentTurnChatJid !== null
      || this.currentRuntimeTurnContext !== null
      || this.pendingSingletonRuntimeTurnContext !== null
      || this.currentRuntimeTurnCompletion !== null
      || this.turnQueue.isProcessing
      || this.turnQueue.pending > 0
      || this.runtimeTurnCoordinator.hasGlobalTeardownPending()
    );
  }

  private assertNoActiveUserTurn(scopeKey: string): void {
    if (!this.isTurnInFlight(scopeKey)) return;
    throw new AgentCommandRuntimeError(
      'turn_in_progress',
      this.sessionScope === 'per_chat'
        ? 'agent command rejected because the target chat already has a turn in progress'
        : 'agent command rejected because the agent already has a turn in progress',
      409,
    );
  }

  private getOpenFileDescriptorCount(): number | null {
    if (process.platform !== 'linux') return null;
    try {
      return readdirSync('/proc/self/fd').length;
    } catch (err) {
      log.debug({ err }, 'failed to count open file descriptors');
      return null;
    }
  }

  private logHealthStats(): void {
    const memoryUsage = process.memoryUsage();
    const finalizationHealth = this.runtimeTurnSupervisor.health();
    const recoveryHealth = getTurnRecoveryHealthDetails(this.durability);

    log.info({
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
      chatSessions: this.chatSessions.size,
      chatQueues: this.chatQueues.size,
      perChatSessionsWithoutOwner: this.sweepPerChatSessionsWithoutOwner(),
      outboundQueues: this.outboundQueues.size,
      workspaceResources: this.workspaceResources.size,
      fdCount: this.getOpenFileDescriptorCount(),
      memoryUsage: {
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        external: memoryUsage.external,
        arrayBuffers: memoryUsage.arrayBuffers,
      },
      recentCrashCount: this.getRecentCrashCount(),
      lastCrashAt: this.crashes.lastCrashAt,
      proactiveResumeIdentityRejects: this.proactiveResumeIdentityRejects,
      restartLoopGuard: {
        enabled: config.restartLoopGuard.enabled,
        ...readRestartLoopGuardHealth(
          restartLoopGuardPath(config.stateRoot),
          config.restartLoopGuard.windowMs,
        ),
      },
      unownedProviderEventRejects: this.unownedProviderEventRejects,
      suppressedSystemTurnEffectRejects: this.suppressedSystemTurnEffectRejects,
      providerEventRejectReasons: Object.fromEntries(this.providerEventRejectReasonCounts),
      turnFinalizationRetainedRetries: finalizationHealth.retainedRetries,
      turnFinalizationDegradedScopes: finalizationHealth.degradedScopes,
      turnFinalizationRetryAttempts: finalizationHealth.retryAttempts,
      turnFinalizationRetryRecoveries: finalizationHealth.retryRecoveries,
      turnFinalizationRetryExhaustions: finalizationHealth.retryExhaustions,
      ...recoveryHealth,
    }, 'agent runtime health stats');
  }

  private startHealthStatsTimer(): void {
    if (this.healthStatsTimer) return;
    this.healthStatsTimer = setInterval(() => {
      try {
        this.logHealthStats();
      } catch (err) {
        log.warn({ err, instanceName: this.instanceName }, 'agent runtime health stats failed');
      }
    }, HEALTH_STATS_INTERVAL_MS);
    this.healthStatsTimer.unref?.();
  }

  private startQueueSweepTimer(): void {
    if (!this.shared || this.queueSweepTimer) return;
    this.queueSweepTimer = setInterval(() => this.sweepIdleQueues(), SHARED_QUEUE_SWEEP_INTERVAL_MS);
    this.queueSweepTimer.unref?.();
  }

  private sweepIdleQueues(): void {
    if (!this.shared) return;

    const now = Date.now();
    for (const [chatJid, queue] of this.outboundQueues) {
      const lastActivity = typeof queue.lastActivity === 'number' ? queue.lastActivity : now;
      const idleMs = now - lastActivity;
      if (idleMs <= SHARED_QUEUE_IDLE_MS) continue;
      if (chatJid === this.currentTurnChatJid) continue;
      if (queue.hasPendingWork?.() === true) continue;

      log.debug({ chatJid, idleMs }, 'evicting idle outbound queue');
      void this.observeOutboundQueueOperation(
        GLOBAL_TOOL_SCOPE_KEY,
        queue,
        () => queue.shutdown(),
      ).catch((err) => {
        log.warn({ err, chatJid }, 'idle outbound queue shutdown failed');
      });
      this.outboundQueues.delete(chatJid);
    }
  }

  private startSessionSweepTimer(): void {
    if (this.sessionSweepTimer) return;
    this.sessionSweepTimer = setInterval(() => this.sweepIdleSessions(), SESSION_SWEEP_INTERVAL_MS);
    this.sessionSweepTimer.unref?.();
  }

  /**
   * #1756: classifyActiveSessions used to run startup-only, so its 'ambiguous'
   * bucket was a permanent no-op — an init-failure session that never
   * checkpointed stayed 'active' forever. This interval re-runs the same
   * sweep start() does, so any row still 'ambiguous' gets a fresh chance at
   * the age-based fallback disposition in sweepStaleAgentSessions.
   */
  private startZombieSessionSweepTimer(): void {
    if (!(this.sessionScope === 'per_chat' || this.sandboxPerChat) || this.zombieSessionSweepTimer) return;
    this.zombieSessionSweepTimer = setInterval(() => {
      this.sweepStaleAgentSessions().catch((err) => {
        log.warn({ err, instanceName: this.instanceName }, 'interval zombie-session sweep failed');
      });
    }, ZOMBIE_SESSION_SWEEP_INTERVAL_MS);
    this.zombieSessionSweepTimer.unref?.();
  }

  /**
   * Sweep stale sessions for all per_chat modes (including Q's non-sandboxed
   * per_chat). Cross-references agent_sessions with session_checkpoints to
   * safely identify which processes to keep and which to reap. Only kills
   * PIDs verified as owned children. Called once at startup and, per #1756,
   * again on an interval (startZombieSessionSweepTimer) so a session that
   * lands in 'ambiguous' — the classifier's do-not-touch bucket — is not
   * skipped forever; resolveAmbiguousAgeFallback gives every pass a chance to
   * retire a row that has sat idle with zero activity past the age
   * threshold. Returns the set of conversation keys that must not be
   * proactively resumed this pass (a live or ambiguous session was already
   * left running for that key) — only meaningful to the startup caller.
   */
  /**
   * C5 restart-loop guard consult for the startup resume gate. Returns true
   * when proactive resume must be suppressed for this boot: the guard is
   * enabled, resumable work exists, this boot follows an unclean exit, and
   * the crashy-boot journal has reached the trip threshold. On trip, queues
   * ONE operator notice through the typed startup-event channel (popped and sent
   * by main.ts after connect). Fail-open throughout — any guard error
   * degrades to "do not suppress".
   */
  private shouldSuppressProactiveResume(resumableCount: number): boolean {
    if (!config.restartLoopGuard.enabled) return false;
    if (resumableCount < 1) return false;
    if (!this.restartLoopInterruptedBoot) return false;
    const trip = checkAndRecordInterruptedBoot({
      statePath: restartLoopGuardPath(config.stateRoot),
      maxRestarts: config.restartLoopGuard.maxRestarts,
      windowMs: config.restartLoopGuard.windowMs,
    });
    if (!trip.tripped) return false;
    log.warn(
      { bootsInWindow: trip.bootsInWindow, resumableCount, windowMs: config.restartLoopGuard.windowMs },
      'restart-loop guard tripped — suppressing proactive resume for this boot',
    );
    const adminPhone = [...config.adminPhones][0];
    if (adminPhone) {
      const windowSec = Math.round(config.restartLoopGuard.windowMs / 1000);
      this.pendingStartupEvent = {
        kind: 'restart_loop_guard_alert',
        chatJid: resolveConfiguredAdminJid(config.transport, adminPhone),
        text:
          `*Restart-loop guard tripped* ⚠️ — ${trip.bootsInWindow} crash-interrupted boots ` +
          `inside ${windowSec}s with resumable sessions pending. Proactive resume is ` +
          `suppressed for this boot to break a possible resume-replay loop; sessions ` +
          `resume on their next message. Check the journal for the implicated chat.`,
      };
    }
    return true;
  }

  private async sweepStaleAgentSessions(): Promise<Set<string>> {
    const proactiveResumeBlockedConversationKeys = new Set<string>();
    if (!(this.sessionScope === 'per_chat' || this.sandboxPerChat)) {
      return proactiveResumeBlockedConversationKeys;
    }
    if (!this.durability) {
      log.warn('durability engine not set — skipping active session classification');
      return proactiveResumeBlockedConversationKeys;
    }

    const residentRowIds = reconcileResidentSessionStatuses(this.db, this.chatSessions.values());
    const classified = classifyActiveSessions(this.db, this.durability);
    for (const session of classified) {
      if (residentRowIds.has(session.id)) {
        log.warn(
          { id: session.id, conversationKey: session.conversationKey, classification: session.classification,
            reason: session.reason, providerSessionId: session.sessionId },
          'skipping zombie-session disposition for current-process resident manager');
        if (session.conversationKey) proactiveResumeBlockedConversationKeys.add(session.conversationKey);
        continue;
      }
      switch (session.classification) {
        case 'stale_dead':
          markOrphaned(this.db, session.id);
          break;
        case 'stale_live':
          log.warn({
            id: session.id,
            pid: session.claudePid,
            conversationKey: session.conversationKey,
            reason: session.reason,
          }, 'reaping stale session');
          try {
            await killSessionTree(session.claudePid, 'SIGTERM', {
              generationMarker:
                `stale:${session.id}:${session.sessionId ?? 'unknown'}:${session.claudePid}`,
            });
          } catch (err) {
            log.error({
              err,
              id: session.id,
              pid: session.claudePid,
              conversationKey: session.conversationKey,
            }, 'stale session tree cleanup inconclusive — blocking proactive resume');
            if (session.conversationKey) {
              proactiveResumeBlockedConversationKeys.add(session.conversationKey);
              break;
            }
            throw err;
          }
          markOrphaned(this.db, session.id);
          break;
        case 'ambiguous': {
          const fallback = resolveAmbiguousAgeFallback(
            {
              id: session.id,
              claudePid: session.claudePid,
              startedAt: session.startedAt,
              messageCount: session.messageCount,
            },
            Date.now(),
            AMBIGUOUS_SESSION_MAX_AGE_MS,
          );
          if (fallback === 'orphan') {
            markOrphaned(this.db, session.id);
            log.warn({
              id: session.id,
              pid: session.claudePid,
              conversationKey: session.conversationKey,
              reason: session.reason,
            }, 'ambiguous session past age threshold with no activity — marked orphaned (#1756)');
            break;
          }
          log.warn({
            id: session.id,
            pid: session.claudePid,
            conversationKey: session.conversationKey,
            reason: session.reason,
          }, 'ambiguous session — not touching');
          // Left running — block a duplicate proactive resume for this key.
          if (session.conversationKey) proactiveResumeBlockedConversationKeys.add(session.conversationKey);
          break;
        }
        case 'authoritative_live':
          // Verified-live child left in place — block a duplicate proactive resume.
          if (session.conversationKey) proactiveResumeBlockedConversationKeys.add(session.conversationKey);
          break;
      }
    }
    return proactiveResumeBlockedConversationKeys;
  }

  /**
   * True only if a resident agent session is safe to suspend right now. A session
   * is evictable when it is live, between turns, past the minimum-residency floor,
   * idle beyond the TTL, and not blocking on a pending poll vote. Mirrors the
   * guards proven necessary by the eviction design (turn-in-flight, anti-thrash
   * residency floor, awaited-poll exemption).
   */
  private isSessionSafeToEvict(mapKey: string, session: SessionManager, now: number): boolean {
    if (session === this.controlSession) return false;    // synthetic self-heal session has its own lifecycle
    const st = session.getStatus();
    if (st.active !== true) return false;                 // not a live resident session
    if (st.turnInFlight === true) return false;           // mid-turn (covers mid-tool-call)
    // A turn is queued/dispatching for this chat. pendingTurnText is set before the
    // session ref is captured for dispatch and cleared at turn completion, so it
    // closes the window where a sweep could evict a session mid-dispatch (before its
    // watchdog arms) and the captured ref then gets respawned off-map. Fail-safe:
    // a lingering pending turn only defers eviction, never forces it.
    if (this.pendingTurnText.has(mapKey)) return false;
    if (this.pendingPolls.questions.has(mapKey)) return false; // awaiting a poll vote
    // Images are buffered for IMAGE_COALESCE_MS before dispatch and do NOT set
    // pendingTurnText or refresh lastMessageAt — so without this guard an idle/LRU
    // sweep could evict mid-buffer, and cleanupPerChatState would abort the buffer,
    // silently dropping the user's images and disarming the reply guarantee.
    if (this.imageCoalesce.buffers.has(mapKey)) return false;
    const startedMs = st.startedAt ? Date.parse(st.startedAt) : now;
    if (Number.isFinite(startedMs) && now - startedMs < SESSION_MIN_RESIDENCY_MS) return false; // anti-thrash floor
    return true;
  }

  private sessionIdleMs(session: SessionManager, now: number): number {
    const st = session.getStatus();
    const startedMs = st.startedAt ? Date.parse(st.startedAt) : now;
    const lastMs = st.lastMessageAt ? Date.parse(st.lastMessageAt) : startedMs;
    return Number.isFinite(lastMs) ? now - lastMs : 0;
  }

  /** TTL-pass eligibility: safe to evict AND idle beyond the TTL. */
  private isSessionEvictable(mapKey: string, session: SessionManager, now: number): boolean {
    return this.isSessionSafeToEvict(mapKey, session, now) && this.sessionIdleMs(session, now) > SESSION_IDLE_MS;
  }

  /**
   * Suspend resident per-chat agent sessions that have gone idle, so the resident
   * session set stays bounded instead of accumulating one process (plus its MCP
   * and browser children) per distinct chat until the host exhausts memory.
   *
   * Pass 1 (TTL): suspend anything idle beyond SESSION_IDLE_MS. Pass 2 (LRU
   * ceiling): if still over MAX_RESIDENT_SESSIONS, suspend the longest-idle
   * evictable sessions down toward the cap. Eviction goes through the session's
   * own graceful shutdown(true) — which suspends (resumable) and routes through
   * the exit-handler's clean-shutdown path — never an external kill.
   */
  private sweepIdleSessions(): void {
    const now = Date.now();

    // Pass 1 — TTL.
    for (const [mapKey, session] of this.chatSessions) {
      if (!this.isSessionEvictable(mapKey, session, now)) continue;
      this.evictIdleSession(mapKey, session, 'idle-ttl');
    }

    // Pass 2 — LRU ceiling. Unlike pass 1 this evicts even sessions still within
    // the TTL (longest-idle first), to bound memory under a burst of many active
    // chats; it still honors the safety guards (live, between-turns, no pending
    // poll, past the residency floor).
    if (this.chatSessions.size > MAX_RESIDENT_SESSIONS) {
      const overBy = this.chatSessions.size - MAX_RESIDENT_SESSIONS;
      const candidates = [...this.chatSessions.entries()]
        .filter(([mapKey, session]) => this.isSessionSafeToEvict(mapKey, session, now))
        .map(([mapKey, session]) => ({ mapKey, session, idleMs: this.sessionIdleMs(session, now) }))
        .sort((a, b) => b.idleMs - a.idleMs); // longest-idle first
      for (const { mapKey, session } of candidates.slice(0, overBy)) {
        this.evictIdleSession(mapKey, session, 'lru-ceiling');
      }
    }
  }

  private evictIdleSession(mapKey: string, session: SessionManager, reason: string): void {
    log.info({ chatJid: mapKey, reason, residentCount: this.chatSessions.size }, 'suspending idle agent session');
    const childStopped = session.shutdown(true);
    this.perChatMcpSocketManager.releaseAfter(mapKey, childStopped);
    // Remove first so a concurrent inbound message cleanly re-spawns/resumes.
    this.deleteOwnedPerChatSession(mapKey, session);
    // Tear down the chat's outbound queue too (mirrors every other session-removal
    // site). In per_chat mode the queue sweep never runs, so without this the queue
    // map grows one dead entry per evicted chat under a burst — undercutting the
    // memory bound this feature exists to enforce.
    this.chatQueues.get(mapKey)?.abortTurn();
    this.chatQueues.delete(mapKey);
    // Canonical teardown of all co-keyed per-chat state (operation tracker,
    // auto-compact timers, image-coalesce buffers, turn bookkeeping). Required
    // whenever a session leaves chatSessions — otherwise eviction leaks the very
    // auxiliary state/timers this feature exists to bound. Next message re-spawns
    // and repopulates. Safe at this point: the safety guards already exclude a
    // chat with a pending turn or pending poll.
    this.cleanupPerChatState(mapKey, { preserveActorSocket: true });
    void childStopped.catch((err) => {
      log.warn({ err, chatJid: mapKey }, 'idle session shutdown failed');
    });
  }

  // Tracks inbound seq for the current turn (single/shared mode)
  private currentInboundSeq: number | undefined;
  // Tracks inbound seq per chat key (per_chat mode — chats are concurrent)
  // FIFO queue: push on dispatch, shift on result to prevent race when turns overlap.
  private perChatInboundSeqQueue: Map<string, number[]> = new Map();
  /** Immutable journal/identity/replay snapshots, aligned with the per-chat seq FIFO. */
  private perChatRuntimeTurnContexts = new Map<string, RuntimeTurnContext[]>();
  private perChatRuntimeTurnCompletions = new Map<string, RuntimeTurnCompletion>();
  private readonly perChatRuntimeTurnScopeRefs = new Map<string, PerChatRuntimeScopeRef>();
  private perChatTurnQueues = new Map<string, TurnQueue>();
  /** Deferred and in-progress live-route recycle ownership by scope key. */
  private readonly routeRecycleLifecycle = new RouteRecycleLifecycle<SessionManager>();
  private pendingRecycle = this.routeRecycleLifecycle.pending;
  private recyclePromises = this.routeRecycleLifecycle.promises;
  private recycleOwners = this.routeRecycleLifecycle.owners;
  private recycleFailures = this.routeRecycleLifecycle.failures;
  /** Mutable callback key for a queue that may be re-keyed from LID to phone JID. */
  private readonly perChatTurnQueueKeys = new WeakMap<TurnQueue, PerChatRuntimeScopeRef>();
  /** The sole shared/singleton user turn whose provider result is still unresolved. */
  private currentRuntimeTurnContext: RuntimeTurnContext | null = null;
  /** Singleton turn admitted but not yet published into an outbound evidence epoch. */
  private pendingSingletonRuntimeTurnContext: RuntimeTurnContext | null = null;
  private currentRuntimeTurnCompletion: RuntimeTurnCompletion | null = null;
  /** Owns bounded terminal retries and sticky affected-scope degradation. */
  private readonly runtimeTurnSupervisor: RuntimeTurnSupervisor<RuntimeTurnPostEffects>;
  private readonly turnRecoverySupervisor: TurnRecoverySupervisor;
  /** Obligation replay drain; null unless opted in (all-or-inert). */
  private capabilityObligationRuntime: CapabilityObligationRuntime | null = null;
  private readonly turnRecoveryDeadman: TurnRecoveryDeadman;
  private readonly runtimeTurnHost: RuntimeTurnCoordinatorPort & RuntimeResultHandlerPort;
  private readonly runtimeTurnCoordinator: RuntimeTurnCoordinator;
  private readonly modelPinHost: ModelPinPort;
  private readonly routing: RuntimeRoutingCoordinator;
  private readonly fallback: RuntimeFallbackCoordinator;
  private readonly pollBridge: RuntimePollBridgeCoordinator;
  private readonly sessionLifecycleHost: RuntimeSessionLifecycleHost<SessionManager, RuntimeTurnQueueTeardown>;
  private readonly chatTransportHost: ChatTransportPort;
  private readonly runtimeTurnAfterTerminal = new Map<string, RuntimeTurnAfterTerminalAction>();
  private readonly recoveryManagerId = randomUUID();
  private recoveryGeneration = 0;

  /** Last pin-block notice per conversation (one notice per transition). */
  private lastPinBlockNotice = new Map<string, string>();
  /** Last spawn provider per conversation — runtime_switched detection (slice 4). */
  private lastSpawnRouteProvider = new Map<string, string>();
  // Counts pending system-turn results (context injection, continuation) that should
  // not consume from perChatInboundSeqQueue when their result event arrives. The
  // counter invariants (mark / unmark / consumeIfPending / count) live in the
  // collaborator; the raw map is reachable via .counts for per-chat cleanup/shutdown.
  private readonly pendingSystemResults = new PendingSystemResultTracker();
  /** Latest alias update deferred until an uncorrelated provider lane is empty. */
  private readonly pendingJidAliasChanges = new Map<string, { newJid: string }>();
  /** Provider teardown barriers created when a system request misses its terminal result. */
  private readonly systemTurnQuarantines = new Map<string, Promise<boolean>>();
  /** Exact-source teardowns for terminal results that could not be safely attributed. */
  private readonly rejectedTerminalTeardowns = new WeakMap<SessionManager, Promise<boolean>>();
  private readonly activeMessageHandlers = new Set<Promise<void>>();
  private readonly routeRecycleCommandWork = this.routeRecycleLifecycle.commandWork;
  private readonly routeRecyclePublicationWork = this.routeRecycleLifecycle.publicationWork;
  private shutdownRequested = false;

  // Startup events are deferred until main's strict-readiness controller runs.
  private pendingStartupEvent: StartupNotificationEvent | null = null;

  // Voice reply state (SP4) — tracks inbound contentType and accumulated assistant text per turn.
  // Per-chat mode uses Maps keyed by mapKey; single/shared mode uses scalar fields.
  private currentTurnInboundContentType: string | null = null;
  private currentTurnAssistantText = '';
  private currentTurnAssistantItemText: Map<string, string> = new Map();
  // Inbound message id anchoring the current turn — reply-guarantee evidence
  // (hasFromMeReplyAfter) is scoped to the origin conversation via this id.
  private currentTurnSourceMessageId: string | null = null;
  private perChatTurnSourceMessageId: Map<string, string> = new Map();
  private perChatTurnContentType: Map<string, string> = new Map();
  private perChatTurnText: Map<string, string> = new Map();
  private perChatTurnSuppressedReplySatisfaction: Set<string> = new Set();
  private perChatAssistantItemText: Map<string, Map<string, string>> = new Map();
  // R1 streaming marker scan: hold the FIRST line of a turn's assistant text
  // until it is resolvable (a newline arrived, or it can no longer be a
  // [[wa-route: …]] marker) so a marker split across token-streamed deltas
  // never leaks and always registers. null = not scanning (base per-delta
  // path); '' or a partial line = actively holding. Shared/single mode uses
  // the scalar, per_chat uses the map; both armed at turn start and flushed at
  // the terminal 'result', all flag-gated (flag off leaves them untouched).
  private currentTurnRouteMarkerHold: string | null = null;
  private perChatRouteMarkerHold: Map<string, string> = new Map();

  // Tracks the most recent turn text per chat (keyed by workspaceKey or chatJid).
  // Used to replay a message when session resume fails and the turn was lost.
  private pendingTurnText: Map<string, string> = new Map();
  private pendingTurnActorJid: Map<string, string | undefined> = new Map();
  private pendingTurnPurpose: Map<string, SessionContext['purpose']> = new Map();
  // Per-chat executing-turn authorization context. HEAD =
  // oldest-dispatched-unresolved = the turn the subprocess is currently running.
  // Read fail-closed by the context resolvers (empty/absent -> deny). Cleared on
  // every abnormal termination (cleanupPerChatState + crash/resume/fallback).
  private perChatExecActorQueue: Map<string, ExecutingSessionContext[]> = new Map();
  /** Exact actor FIFO slot owned by an output-producing system lease (poll continuation). */
  private readonly systemTurnExecActors = new Map<number, {
    scopeKey: string;
    actorJid: string | undefined;
  }>();
  private currentTurnReplayText: string | null = null;
  private currentTurnReplayActorJid: string | undefined;
  private currentTurnReplayPurpose: SessionContext['purpose'];

  // ---------------------------------------------------------------------------
  // Image coalescing — batch rapid image sends into a single turn
  // ---------------------------------------------------------------------------
  // When multiple images arrive for the same chat within IMAGE_COALESCE_MS,
  // they're collected and sent as one combined turn to avoid hitting Claude's
  // per-image dimension limits in multi-image sessions.
  private static readonly IMAGE_COALESCE_MS = 3 * MS_PER_SECOND;
  private static readonly MAX_COALESCE_BATCH = 20;
  // Owns the per-chat image coalesce buffer map + durability marking / abort.
  // The turn-pipeline methods (coalesceImageTurn / flushImageCoalesce / LID rekey)
  // stay here and drive this.imageCoalesce.buffers directly. durability and
  // replyGuarantee are late-bound, so they are read through getter thunks.
  private readonly imageCoalesce = new ImageCoalescer(
    () => this.durability,
    () => this.replyGuarantee,
  );

  // Set of mapKeys for which handleResumeFailed is currently managing context
  // injection + pending-turn replay. Used to suppress context injection in any
  // concurrent sendTurnToSession call for the same chat, preventing double injection.
  private resumeFailedHandling: Set<string> = new Set();

  // Global socket server (non-sandboxPerChat mode)
  private globalSocketServer: WhatSoupSocketServer | null = null;
  private singletonProviderToolSession: SessionContext | null = null;

  private durability: DurabilityEngine | null = null;

  private getPerChatAssistantItemMap(mapKey: string): Map<string, string> {
    const existing = this.perChatAssistantItemText.get(mapKey);
    if (existing) return existing;
    const created = new Map<string, string>();
    this.perChatAssistantItemText.set(mapKey, created);
    return created;
  }

  private abortImageCoalesceBuffer(mapKey: string, reason: string): boolean {
    return this.imageCoalesce.abort(mapKey, reason);
  }

  /**
   * Remove all per-chat auxiliary state for a given map key.
   * Call this whenever a session is removed from chatSessions.
   */
  private cleanupPerChatState(
    mapKey: string,
    options: {
      preserveCrashHistory?: boolean;
      preserveProviderTurnOwnership?: boolean;
      preserveActorSocket?: boolean;
    } = {},
  ): void {
    this.cleanupPerChatGenerationState(mapKey, options);
    // F-STICKY-ACTOR: terminal cleanup also stops the per-chat socket. A /new
    // generation replacement deliberately calls only cleanupPerChatGenerationState
    // so socket/config ownership stays with the mapped manager.
    if (!options.preserveActorSocket) this.teardownPerChatActorSocket(mapKey);
    // Slice-4 route bookkeeping is keyed by conversationKey, not the raw
    // mapKey: in sandbox mode mapKey already IS the conversationKey
    // (workspaceKey = toConversationKey), while in canonical-JID mode it is a
    // JID that must be reduced. Reconcile so teardown reaches these maps and
    // they cannot grow unbounded (LEAK-15).
    const conversationKey = mapKey.includes('@') ? toConversationKey(mapKey) : mapKey;
    this.lastSpawnRouteProvider.delete(conversationKey);
    this.lastPinBlockNotice.delete(conversationKey);
  }

  /** Clear resources owned by one child generation while preserving its logical owner. */
  private cleanupPerChatGenerationState(
    mapKey: string,
    options: {
      preserveCrashHistory?: boolean;
      preserveProviderTurnOwnership?: boolean;
    } = {},
  ): void {
    if (options.preserveCrashHistory !== true) this.crashes.forget(mapKey);
    this.perChatInboundSeqQueue.delete(mapKey);
    if (options.preserveProviderTurnOwnership !== true) {
      this.pendingSystemResults.clearScope(mapKey);
      this.legacyProviderTurnOwners.delete(mapKey);
      this.systemTurnQuarantines.delete(mapKey);
    }
    this.perChatTurnSourceMessageId.delete(mapKey);
    this.perChatTurnContentType.delete(mapKey);
    this.perChatTurnText.delete(mapKey);
    this.perChatTurnSuppressedReplySatisfaction.delete(mapKey);
    this.perChatAssistantItemText.delete(mapKey);
    this.perChatRouteMarkerHold.delete(mapKey);
    this.pendingTurnText.delete(mapKey);
    this.pendingTurnActorJid.delete(mapKey);
    this.pendingTurnPurpose.delete(mapKey);
    this.perChatExecActorQueue.delete(mapKey);
    this.clearSystemTurnExecutingActors(mapKey);
    this.resumeFailedHandling.delete(mapKey);
    this.postTurnGate.delete(mapKey);
    // Drop all auto-compact bookkeeping for this scope (cooldown/last-success/
    // rapid-rearm/measure/boundary + resolve any in-flight waiter + silent timer).
    this.autoCompact.cleanupScope(mapKey);
    // Clean up pending poll question state
    this.deletePendingPollQuestions(mapKey);
    // Cancel any pending image coalesce buffer
    this.abortImageCoalesceBuffer(mapKey, 'cleanup_aborted');
    // Clean up operation tracker for this chat
    const tracker = this.operationTrackers.get(mapKey);
    if (tracker) {
      tracker.shutdown();
      this.operationTrackers.delete(mapKey);
    }
  }

  private cleanupGlobalAutoCompactState(): void {
    this.autoCompact.cleanupScope(GLOBAL_TOOL_SCOPE_KEY);
    this.pendingSystemResults.clearScope(GLOBAL_TOOL_SCOPE_KEY);
    this.legacyProviderTurnOwners.delete(GLOBAL_TOOL_SCOPE_KEY);
    this.systemTurnQuarantines.delete(GLOBAL_TOOL_SCOPE_KEY);
  }

  // ---------------------------------------------------------------------------
  // Image coalescing methods
  // ---------------------------------------------------------------------------

  /**
   * Buffer an image turn. If more images arrive within IMAGE_COALESCE_MS,
   * they're appended. When the timer fires (or a non-image message arrives),
   * all buffered images are sent as a single combined turn.
   *
   * Seq/state setup is deferred to flush time — only the representative
   * turn gets a seq entry, preventing desync with the shift-one-per-turn
   * logic in handleEventPerChat.
   */
  private async coalesceImageTurn(mapKey: string, chatJid: string, text: string, msg: IncomingMessage): Promise<void> {
    const existing = this.imageCoalesce.buffers.get(mapKey);
    if (existing) {
      // More images arriving — append and reset timer
      existing.texts.push(text);
      // The representative seq is the last image, so its journaled message id
      // must travel with that same last message into the immutable turn snapshot.
      existing.msg = msg;
      if (msg.inboundSeq !== undefined) existing.inboundSeqs.push(msg.inboundSeq);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => void this.flushImageCoalesce(mapKey), AgentRuntime.IMAGE_COALESCE_MS);
      if (existing.texts.length >= AgentRuntime.MAX_COALESCE_BATCH) {
        log.warn({
          mapKey,
          bufferedCount: existing.texts.length,
          maxBatch: AgentRuntime.MAX_COALESCE_BATCH,
        }, 'image coalesce batch limit reached — flushing immediately');
        await this.flushImageCoalesce(mapKey);
        return;
      }
      log.info({ mapKey, bufferedCount: existing.texts.length }, 'image coalesced into batch');
    } else {
      // First image — start the coalesce window
      const timer = setTimeout(() => void this.flushImageCoalesce(mapKey), AgentRuntime.IMAGE_COALESCE_MS);
      this.imageCoalesce.buffers.set(mapKey, {
        texts: [text],
        timer,
        msg,
        inboundSeqs: msg.inboundSeq !== undefined ? [msg.inboundSeq] : [],
      });
      log.info({ mapKey }, 'image coalesce window opened');
    }
  }

  /**
   * Flush the image coalesce buffer for a chat — send all buffered images
   * as a single combined turn. Returns a Promise so callers can await it
   * to prevent concurrent turn injection.
   *
   * Durability: only the LAST inboundSeq is pushed onto perChatInboundSeqQueue
   * (the representative seq for this combined turn). Earlier seqs are marked
   * skipped with reason 'coalesced_image' via durability engine.
   */
  private async flushImageCoalesce(mapKey: string): Promise<void> {
    if (this.resumeFailedHandling.has(mapKey)) {
      const aborted = this.abortImageCoalesceBuffer(mapKey, 'resume_failed');
      if (aborted) {
        log.warn({ mapKey }, 'image coalesce flush skipped during resume-failed recovery');
      }
      return;
    }

    const entry = this.imageCoalesce.buffers.get(mapKey);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.imageCoalesce.buffers.delete(mapKey);

    const { texts, msg, inboundSeqs } = entry;
    const chatJid = msg.chatJid;
    const count = texts.length;
    const representativeSeq = inboundSeqs.length > 0 ? inboundSeqs[inboundSeqs.length - 1] : undefined;

    try {
      // Mark all-but-last inbound seqs as coalesced (they won't get their own turn)
      if (inboundSeqs.length > 1) {
        this.imageCoalesce.markSeqsSkipped(mapKey, inboundSeqs.slice(0, -1), 'coalesced_image');
      }

      // Combine all image references into one turn
      let combinedText: string;
      if (count === 1) {
        combinedText = texts[0];
      } else {
        combinedText = `[${count} images received]\n${texts.join('\n')}`;
        log.info({ mapKey, imageCount: count, coalescedSeqs: inboundSeqs.length - 1 }, 'flushing coalesced image batch as single turn');
      }

      const session = this.chatSessions.get(mapKey);
      if (!session) throw new Error(`Coalesced image turn has no session for "${mapKey}"`);
      const source: RuntimeTurnSourceSnapshot = {
        sourceMessageId: msg.messageId,
        receivedAtUnixSeconds: receivedAtUnixSeconds(msg),
        conversationKey: canonicalConversationKey(chatJid, this.db),
        senderJid: msg.senderJid,
        senderName: msg.senderName,
        contentType: 'image',
        isGroup: msg.isGroup,
        ...(msg.isGroup ? { groupName: chatJid } : {}),
      };
      const runtimeContext = this.runtimeTurnCoordinator.createRuntimeTurnForDispatch({
        scope: 'per_chat',
        chatJid,
        text: combinedText,
        inboundSeq: representativeSeq,
        source,
        session,
        toolScopeKey: this.requireSessionToolScopeKey(session),
        mapKey,
      });
      this.enqueuePerChatRuntimeTurn(mapKey, {
        sourceMessageId: source.sourceMessageId,
        receivedAtUnixSeconds: source.receivedAtUnixSeconds,
        conversationKey: source.conversationKey,
        chatJid,
        senderJid: source.senderJid,
        senderName: source.senderName,
        text: combinedText,
        isGroup: source.isGroup,
        groupName: source.groupName,
        contentType: 'image',
        ...(runtimeContext ? { runtimeContext } : {}),
        inboundSeq: representativeSeq,
      });
    } catch (err) {
      if (representativeSeq !== undefined) {
        this.imageCoalesce.markSeqFailed(mapKey, representativeSeq, classifyErrorForInbound(err));
      }
      this.pendingTurnText.delete(mapKey);
      this.pendingTurnActorJid.delete(mapKey);
      this.pendingTurnPurpose.delete(mapKey);
      this.perChatTurnSourceMessageId.delete(mapKey);
      this.perChatTurnContentType.delete(mapKey);
      this.perChatTurnText.delete(mapKey);
      this.perChatTurnSuppressedReplySatisfaction.delete(mapKey);
      this.perChatAssistantItemText.delete(mapKey);
      log.error({ err, mapKey, imageCount: count }, 'failed to send coalesced image turn');
    }
  }

  private normalizeAssistantTextForDelivery(
    event: Extract<AgentEvent, { type: 'assistant_text' }>,
    mapKey?: string,
  ): string | null {
    if (!event.itemId) return event.text;

    const itemMap = mapKey !== undefined
      ? this.getPerChatAssistantItemMap(mapKey)
      : this.currentTurnAssistantItemText;

    const prior = itemMap.get(event.itemId) ?? '';

    if (!event.complete) {
      itemMap.set(event.itemId, prior + event.text);
      return event.text;
    }

    itemMap.delete(event.itemId);
    if (!prior) return event.text;
    if (event.text === prior) return null;
    if (event.text.startsWith(prior)) return event.text.slice(prior.length);
    return event.text;
  }

  private gateAssistantTextForOutbound(
    text: string,
    queue: IOutboundQueue,
    inboundSeq: number | undefined,
    mapKey?: string,
  ): string | null {
    if (mapKey !== undefined && isScheduledAgentJobMapKey(mapKey)) {
      this.perChatTurnSuppressedReplySatisfaction.add(mapKey);
      log.info(
        {
          chatJid: queue.targetChatJid,
          reason: 'scheduled_job_plain_text',
          satisfiesReplyGuarantee: true,
          textPreview: providerPreview(text, 200),
        },
        'assistant_text egress gate suppressed scheduled-job plain text',
      );
      return null;
    }
    const decision = classifyAssistantTextEgress(text);
    if (decision.action === 'allow') return text;

    log.info(
      {
        chatJid: queue.targetChatJid,
        reason: decision.reason,
        satisfiesReplyGuarantee: decision.satisfiesReplyGuarantee,
        textPreview: providerPreview(text, 200),
      },
      'assistant_text egress gate suppressed non-user-facing text',
    );

    if (decision.satisfiesReplyGuarantee) {
      // Invariant: any suppression whose TEXT asserts the origin chat was
      // served must prove it with byte-derived evidence — a from-me message
      // stored in the ORIGIN conversation after this turn's inbound. Only
      // send_verification carries that assertion ("I already replied via a
      // send tool"). Without evidence (observed live: agent sent to a
      // DIFFERENT chat, then its verification text disarmed the origin
      // chat's guarantee → permanent silence), suppress the text but leave
      // the reply guarantee armed so the silence fallback still fires.
      // ack_filler and noop are exempt: both assert NOTHING was sent
      // anywhere (deliberate silence — "lane parked", "no user ask",
      // "staying silent", bare punctuation) and are the intentional-silence
      // contract for turns where the agent correctly chose not to reply
      // (#1751 investigation: gating all of ack_filler broke exactly this —
      // a "do not reply" turn that never sends anywhere has no evidence to
      // produce and would wrongly stay armed forever). The one ack_filler
      // pattern that DOES assert a delivery happened ("confirmed delivery",
      // "landed clean") lives under send_verification instead (see
      // outbound-message-safety.ts SEND_VERIFICATION_PATTERNS), so it is
      // already evidence-gated here without widening this condition. Turns
      // with no inbound (proactive/system) have no armed guarantee to
      // protect.
      if (
        decision.reason === 'send_verification' &&
        inboundSeq !== undefined &&
        !this.originChatRepliedThisTurn(mapKey)
      ) {
        log.warn(
          {
            chatJid: queue.targetChatJid,
            inboundSeq,
            textPreview: providerPreview(text, 200),
          },
          'send_verification text without origin-chat outbound — reply guarantee stays armed',
        );
        return null;
      }
      if (mapKey !== undefined) this.perChatTurnSuppressedReplySatisfaction.add(mapKey);
      else this.turnHadSuppressedReplySatisfaction = true;
    }
    return null;
  }

  /** Evidence check for send_verification suppression: fails closed when the
   *  turn's inbound message id is untracked or has no stored inbound row. */
  private originChatRepliedThisTurn(mapKey: string | undefined): boolean {
    const sourceMessageId = mapKey !== undefined
      ? this.perChatTurnSourceMessageId.get(mapKey)
      : this.currentTurnSourceMessageId;
    if (sourceMessageId === undefined || sourceMessageId === null) return false;
    try {
      return hasFromMeReplyAfter(this.db, sourceMessageId);
    } catch (err) {
      log.warn({ err, mapKey }, 'origin-chat reply evidence query failed — failing closed');
      return false;
    }
  }

  /**
   * Two-tier gate for provider-failure text that streamed as assistant_text (QR-209).
   * The permissive `classifyProviderFailure` suppression used to drop ANY match,
   * silently discarding genuine replies that merely discussed an auth/limit error
   * (observed live: replies about an expired OAuth token dropped to silence). Now
   * only BANNER-confident matches (the text IS the error — short + error-opener /
   * usage-limit) are suppressed; AMBIENT matches (prose about an error) are let
   * through to the egress gate. Fallback is still armed only on the terminal
   * 'result' event, never here. Shared by both assistant_text handlers so their
   * suppression policy can't drift.
   *
   * Returns `{ suppress: true }` when THIS gate drops the chunk (caller must
   * `break`). Otherwise returns `{ suppress: false, ambient }`, where `ambient`
   * is non-null when the text matched a provider-failure token but was let
   * through as prose about an error, not the error itself — the caller must run
   * this result through the egress gate and log the ambient tripwire with that
   * gate's REAL outcome (#1758: logging "delivered" here fired one gate before
   * `gateAssistantTextForOutbound`, which can still suppress the same chunk for
   * an unrelated reason — a suppressed chunk logged as "delivered" is worse than
   * useless in incident forensics).
   */
  private suppressStreamedProviderFailure(
    normalizedText: string,
    chatJid: string | null,
  ): { suppress: boolean; ambient: { kind: ProviderFailureKind } | null } {
    const classification = classifyStreamedProviderFailure(normalizedText);
    if (classification === null) return { suppress: false, ambient: null };
    if (classification.confidence === 'banner') {
      log.warn(
        { chatJid, kind: classification.kind, textPreview: providerPreview(normalizedText, MAX_STREAMED_BANNER_LENGTH) },
        'suppressed provider-failure message from assistant_text',
      );
      return { suppress: true, ambient: null };
    }
    // Ambient: matched a provider-failure token but is prose about an error, not the
    // error itself. Dropping it is the QR-209 silent-reply defect, so this gate lets
    // it through — but the egress gate downstream can still suppress it for an
    // unrelated reason. The tripwire log therefore fires at the call site, after
    // that gate has run, tagged with its actual outcome.
    return { suppress: false, ambient: { kind: classification.kind } };
  }

  /**
   * Logs the QR-209 ambient-provider-failure tripwire with the REAL post-egress-gate
   * outcome (#1758). `delivered` when the fleet should see a novel banner shape that
   * ought to become a suppressible opener instead; `suppressed` when an unrelated
   * egress-gate reason (ack_filler, internal_narration, ...) already handled it, so
   * forensics must not read this line as evidence of delivery.
   */
  private logAmbientProviderFailureOutcome(
    ambient: { kind: ProviderFailureKind } | null,
    normalizedText: string,
    chatJid: string | null,
    delivered: boolean,
  ): void {
    if (!ambient) return;
    log.warn(
      {
        chatJid,
        kind: ambient.kind,
        textLength: normalizedText.length,
        textPreview: providerPreview(normalizedText, MAX_STREAMED_BANNER_LENGTH),
        outcome: delivered ? 'delivered' : 'suppressed',
      },
      delivered
        ? 'delivered assistant_text despite provider-failure classification'
        : 'suppressed assistant_text despite provider-failure classification (egress gate)',
    );
  }

  // ─── Control session (self-healing repair) ────────────────────────────────
  private activeControlReportId: string | null = null;
  /** Tool protocol completed, but the owning provider request has not terminalized yet. */
  private controlProtocolCompletedReportId: string | null = null;
  /** Prevent duplicate terminal-result effects while teardown proof is pending. */
  private controlTerminalizingReportId: string | null = null;
  private controlSession: SessionManager | null = null;
  private controlSessionTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(db: Database, messenger: Messenger, instanceName?: string, options?: AgentRuntimeOptions) {
    this.db = db;
    this.pollPersistence = new PendingPollPersistence(db);
    this.consumptionReceipts = new ConsumptionReceiptRecorder(db);
    this.queuedDecisionConsumer = new QueuedDecisionConsumer(
      db,
      this.consumptionReceipts,
      () => this.offlineDecisionRetry.scheduleRetry(() => {
        void this.consumeQueuedPollDecisions();
      }),
    );
    this.messenger = messenger;
    this.instanceName = instanceName ?? 'personal';
    // FLOS Stage 1: initialize the lifecycle-emission singleton from config
    // here (composition edge already exists in this module — the domain
    // module itself must stay config-free). First caller wins; the build
    // thunk is evaluated inside the module's fail-closed boundary.
    initializeRuntimeLifecycleEmitter(() => ({
      phase: config.fleetLifecyclePhase,
      storePath: join(config.dataRoot, 'lifecycle-events.db'),
      instance: this.instanceName,
    }));
    // #3295 S2: keep the OPTIONS OBJECT (not a copied boolean) so the flag is
    // read live at every admission — the kill-switch contract.
    this.deferredTurnAdmissionOptions = options?.deferredTurnAdmission ?? null;
    this.providerExecutionGate = createProviderExecutionGate(this.instanceName);
    this.runtimeTurnSupervisor = new RuntimeTurnSupervisor(
      this.instanceName,
      () => this.durability,
      (result, retained) => this.runtimeTurnCoordinator.applyRecoveredRuntimeTurnFinalization(result, retained),
    );
    this.turnRecoverySupervisor = createTurnRecoverySupervisorForRuntime({ // started in setDurability, stopped at shutdown
      instanceName: this.instanceName, getDurability: () => this.durability,
      dispatchReplay: (job, fence, target, abortControl) => (
        this.dispatchTurnRecoveryReplay(job, fence, target, abortControl)
      ),
      recoveryManagerId: this.recoveryManagerId, nextRecoveryGeneration: () => ++this.recoveryGeneration,
      resolveDispatchTarget: (job) => this.resolveTurnRecoveryDispatchTarget(job),
    });
    this.turnRecoveryDeadman = new TurnRecoveryDeadman({
      instanceName: this.instanceName,
      enabled: () => this.sessionScope === 'per_chat' && this.durability !== null,
      health: () => this.turnRecoverySupervisor.health(),
      emitAlert: emitAlertChecked,
      clearAlert: clearAlertSourceChecked,
    });
    this.handoffDistill = new HandoffDistillCoordinator({
      db,
      instanceName: this.instanceName,
      isEnabled: () => handoffDistillerEnabled(),
      getModel: () => handoffDistillModel(),
    });
    this.sessionScope = options?.sessionScope ?? (options?.shared ? 'shared' : 'single');
    this.shared = this.sessionScope === 'shared';
    this.cwd = options?.cwd;
    this.configSystemPrompt = options?.configSystemPrompt;
    this.instructionsPath = options?.instructionsPath;
    this.sandbox = options?.sandbox;
    this.model = options?.model;
    this.sandboxPerChat = options?.sandboxPerChat ?? false;
    this.perChatConversationBound = options?.perChatConversationBound ?? false;
    this.serviceRestarter = options?.serviceRestarter;
    this.modelCatalogueListFn = options?.modelCatalogueListFn;
    this.modelCatalogueAnthropicFn = options?.modelCatalogueAnthropicFn;
    this.expectedAccountDigest = options?.expectedAccountDigest ?? null;
    this.accountIdentityArmedAt = this.expectedAccountDigest === null ? null : systemClock.now();
    this.accountIdentityVerifier = new AccountIdentityVerifier(
      this.createAccountIdentityVerifierHost(),
      options?.accountIdentityVerify ? { verify: options.accountIdentityVerify } : {},
    );
    this.workspaceSweeper = new WorkspaceSweeper(
      this.sandboxPerChat,
      this.workspaceResources,
      (workspaceKey) => this.chatSessions.get(workspaceKey)?.getStatus().active === true,
    );
    this.pluginDirs = options?.pluginDirs ?? [];
    this.enabledPlugins = options?.enabledPlugins;
    this.allowM365Mutations = options?.allowM365Mutations;
    this.autoCompactInputTokens =
      typeof options?.autoCompactInputTokens === 'number' &&
      Number.isFinite(options.autoCompactInputTokens) &&
      options.autoCompactInputTokens > 0
        ? Math.floor(options.autoCompactInputTokens)
        : DEFAULT_AUTO_COMPACT_INPUT_TOKENS;
    this.autoCompact = new AutoCompactController(this.autoCompactInputTokens);
    this.replyGuaranteeTimeoutMs = options?.replyGuaranteeTimeoutMs ?? DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS;
    this.agentProvider = config.agentProvider;
    this.agentProviderConfig = config.agentProviderConfig;
    this.agentDataPolicy = config.agentProviderDataPolicy ?? null;
    this.providerBoundaryMode = config.agentProviderBoundaryMode ?? 'shadow';
    const configuredFallbacks = Array.isArray(config.agentFallbacks)
      ? config.agentFallbacks
      : normalizeFallbackEntriesFromAgentOptions({
          fallbackProvider: config.agentFallbackProvider,
          fallbackModel: config.agentFallbackModel,
          fallbackDataPolicy: config.agentFallbackDataPolicy,
        });
    this.agentFallbacks = configuredFallbacks.map((entry) => ({ ...entry }));
    this.agentFallbackDiscovery = config.agentFallbackDiscovery ?? null;
    this.registry = new ToolRegistry();
    this.registerAllTools();
    this.perChatMcpSocketManager = new PerChatMcpSocketManager({
      stateRoot: config.stateRoot,
      registry: this.registry,
      allowedRoot: this.cwd ?? homedir(),
      conversationBound: this.perChatConversationBound,
      resolveExecutingSession: (mapKey) => this.resolveExecutingSessionByMapKey(mapKey),
    });
    this.catalogueSnapshot = createCatalogueSnapshotCache();

    this.turnQueue = this.createGlobalTurnQueue();
    this.runtimeTurnHost = this.createRuntimeTurnHost();
    this.runtimeTurnCoordinator = new RuntimeTurnCoordinator(this.runtimeTurnHost);
    this.modelPinHost = this.createModelPinHost();
    this.sessionLifecycleHost = this.createSessionLifecycleHost();
    this.chatTransportHost = this.createChatTransportHost();
    this.routing = new RuntimeRoutingCoordinator(this.createRuntimeRoutingHost());
    this.fallback = new RuntimeFallbackCoordinator(this.createRuntimeFallbackHost());
    this.pollBridge = new RuntimePollBridgeCoordinator(this.createRuntimePollBridgeHost());

    // Subscribe to poll vote events for AskUserQuestion → Poll bridge
    const connection = this.messenger as ConnectionManager;
    if (typeof connection.on === 'function') {
      connection.on('pollVoteReceived', (data) => {
        this.handlePollVoteReceived(data);
      });
      connection.on('pollVoteFailed', (data) => {
        this.handlePollVoteFailed(data);
      });
    }
  }

  private createGlobalTurnQueue(): TurnQueue {
    const turnQueue = new TurnQueue({
      maxDepth: config.agentMaxQueueDepth,
      onReject: (turn, reason) => {
        this.finalizeRejectedRuntimeTurn(turn, reason);
        log.warn({ chatJid: turn.chatJid, senderJid: turn.senderJid, reason },
          'turn rejected — agent queue full');
      },
      onProcessorError: (turn, error) => this.finalizeSharedProcessorError(turn, error),
    });
    turnQueue.setProcessor((turn) => this.processTurn(turn));
    return turnQueue;
  }

  private replaceGlobalTurnQueue(expected: TurnQueue): void {
    if (this.turnQueue !== expected) {
      throw new Error('Cannot replace a superseded singleton/shared runtime TurnQueue');
    }
    this.turnQueue = this.createGlobalTurnQueue();
  }

  /** Narrow host for model-pin.ts and model-catalogue-render.ts. */
  private createModelPinHost(): ModelPinPort {
    const runtime = this;
    return {
      db: runtime.db,
      instanceName: runtime.instanceName,
      sessionScope: runtime.sessionScope,
      agentProvider: runtime.agentProvider,
      agentProviderConfig: runtime.agentProviderConfig,
      model: runtime.model,
      agentFallbacks: runtime.agentFallbacks,
      catalogueSnapshot: runtime.catalogueSnapshot,
      nlRoutingTiers: config.nlRoutingTiers,
      pendingRecycle: runtime.pendingRecycle,
      recyclePromises: runtime.recyclePromises,
      recycleOwners: runtime.recycleOwners,
      recycleFailures: runtime.recycleFailures,
      routeRecycleLifecycle: runtime.routeRecycleLifecycle,
      chatSessions: runtime.chatSessions,
      chatQueues: runtime.chatQueues,
      modelCatalogueListFn: runtime.modelCatalogueListFn,
      modelCatalogueAnthropicFn: runtime.modelCatalogueAnthropicFn,
      get effectiveFallbackEntry() { return runtime.effectiveFallbackEntry; },
      get runtimeTurnCoordinator() { return runtime.runtimeTurnCoordinator; },
      get session() { return runtime.session; },
      set session(value) { runtime.session = value; },
      get queue() { return runtime.queue; },
      set queue(value) { runtime.queue = value; },
      get activeChatJid() { return runtime.activeChatJid; },
      set activeChatJid(value) { runtime.activeChatJid = value; },
      get operationTracker() { return runtime.operationTracker; },
      set operationTracker(value) { runtime.operationTracker = value; },
      sendDirect: (chatJid, text) => runtime.sendDirect(chatJid, text),
      // F2a (#2121): the id-bearing send, used by the pin-receipt path only.
      sendDirectWithReceipt: (chatJid, text) => runtime.sendDirectWithReceipt(chatJid, text),
      resolveRouteForTurn: (chatJid, actorJid) => runtime.resolveRouteForTurn(chatJid, actorJid),
      resolvePerChatMapKey: (chatJid) => runtime.resolvePerChatMapKey(chatJid),
      routeSessionProviderConfig: (route) => runtime.routeSessionProviderConfig(route),
      isTurnInFlight: (scopeKey) => runtime.isTurnInFlight(scopeKey),
      getActiveQueue: () => runtime.getActiveQueue(),
      deleteOwnedPerChatSession: (mapKey, expected) => runtime.deleteOwnedPerChatSession(mapKey, expected),
      cleanupPerChatState: (mapKey, options) => runtime.cleanupPerChatState(mapKey, options),
      retirePerChatProviderTransitionAfter: (mapKey, transitionSettled) =>
        runtime.perChatMcpSocketManager.releaseAfter(mapKey, transitionSettled),
      cleanupGlobalAutoCompactState: () => runtime.cleanupGlobalAutoCompactState(),
      emitRouteEventChecked: (ev) => runtime.emitRouteEventChecked(ev),
      recordRoutePreference: (chatJid, chatKey, senderKey, intent, requestedProvider) =>
        runtime.routing.recordRoutePreference(chatJid, chatKey, senderKey, intent, requestedProvider),
      routablePinTargets: () => runtime.routablePinTargets(),
      renderRouteStatus: (chatJid, senderJid) => runtime.routing.renderRouteStatus(chatJid, senderJid),
      loadRouteView: (chatJid, senderJid) => runtime.routing.loadRouteView(chatJid, senderJid),
      completeLocalInbound: (inboundSeq) => { if (inboundSeq !== undefined) runtime.durability?.completeInbound(inboundSeq, 'local_command_handled'); },
    };
  }

  private createSessionLifecycleHost(): RuntimeSessionLifecycleHost<SessionManager, RuntimeTurnQueueTeardown> {
    const runtime = this;
    return {
      db: runtime.db,
      instanceName: runtime.instanceName,
      sessionScope: runtime.sessionScope,
      get chatSessions() { return runtime.chatSessions; },
      getSession: () => runtime.session,
      getActiveChatJid: () => runtime.activeChatJid,
      resolvePerChatMapKey: (chatJid) => runtime.resolvePerChatMapKey(chatJid),
      sendDirect: (chatJid, text, force) => runtime.sendDirect(chatJid, text, force),
      abortPerChatQueue: (mapKey) => runtime.chatQueues.get(mapKey)?.abortTurn({ preserveEvidence: true }),
      terminalizePerChatTurn: (mapKey) =>
        runtime.runtimeTurnCoordinator.terminalizePerChatTurnQueueForKill(mapKey),
      retirePerChatTurn: (teardown) =>
        runtime.runtimeTurnCoordinator.retirePerChatTurnQueueAfterKill(teardown),
      deletePerChatSessionAndQueue: (mapKey, session) => {
        runtime.deleteOwnedPerChatSession(mapKey, session);
        runtime.chatQueues.delete(mapKey);
      },
      cleanupPerChatState: (mapKey) => runtime.cleanupPerChatState(mapKey),
      getGlobalInterruptChatJid: () => runtime.getGlobalInterruptChatJid(),
      abortGlobalInterruptQueue: () =>
        runtime.getGlobalInterruptQueue()?.abortTurn({ preserveEvidence: true }),
      terminalizeGlobalTurn: () =>
        runtime.runtimeTurnCoordinator.terminalizeGlobalTurnForReset(),
      shutdownOperationTracker: () => {
        runtime.operationTracker?.shutdown();
        runtime.operationTracker = null;
      },
      cleanupGlobalAutoCompactState: () => runtime.cleanupGlobalAutoCompactState(),
      retireGlobalTurn: (teardown) =>
        runtime.runtimeTurnCoordinator.retireGlobalTurnQueueAfterReset(teardown),
      clearGlobalSessionRefs: () => {
        runtime.session = null;
        runtime.queue = null;
        runtime.activeChatJid = null;
        runtime.currentInboundSeq = undefined;
        runtime.currentTurnChatJid = null;
      },
    };
  }

  /**
   * Host object for the extracted per-chat transport surface
   * (chat-transport.ts) — same shape as createModelPinHost: readonly state
   * and mutable Maps are captured by reference, the two fields that are
   * reassigned elsewhere on the runtime (queue, operationTracker) are
   * read-only getters since this surface never writes them, and every
   * collaborator is a bound delegate.
   */
  private createChatTransportHost(): ChatTransportPort {
    const runtime = this;
    // Every data field is a live getter, not a value/reference captured once
    // here — several tests replace these (chatSessions/chatQueues/
    // operationTrackers with Observed* wrapper Maps, agentFallbacks/
    // nlRoutingEnabled by direct field assignment) on the runtime instance
    // AFTER construction to observe mutations or set up scenarios. A captured
    // reference would keep reading the pre-test-setup value.
    return {
      get sessionScope() { return runtime.sessionScope; },
      get sandboxPerChat() { return runtime.sandboxPerChat; },
      get shared() { return runtime.shared; },
      get instanceName() { return runtime.instanceName; },
      get messenger() { return runtime.messenger; },
      get queue() { return runtime.queue; },
      get operationTracker() { return runtime.operationTracker; },
      get chatSessions() { return runtime.chatSessions; },
      get chatQueues() { return runtime.chatQueues; },
      get outboundQueues() { return runtime.outboundQueues; },
      get perChatExecActorQueue() { return runtime.perChatExecActorQueue; },
      get perChatMcpSocketManager() { return runtime.perChatMcpSocketManager; },
      get operationTrackers() { return runtime.operationTrackers; },
      get operationTrackerConfig() { return config.operationTracker; },
      resolvePerChatMapKey: (chatJid) => runtime.resolvePerChatMapKey(chatJid),
      teardownPerChatActorSocket: (mapKey) => runtime.teardownPerChatActorSocket(mapKey),
      getQueueForChat: (chatJid, mapKey) => runtime.getQueueForChat(chatJid, mapKey),
    };
  }

  /**
   * Host for the extracted routing coordinator (runtime-routing.ts, #1977 D1)
   * — same live-getter shape as createChatTransportHost: every data field is
   * a live getter because tests replace several of these (agentFallbacks,
   * nlRoutingEnabled, chatSessions) by direct field assignment on the runtime
   * instance after construction. The two conversation-keyed route bookkeeping
   * maps stay owned here (torn down in cleanupPerChatState, LEAK-15) and pass
   * through by live reference.
   */
  private createRuntimeRoutingHost(): RuntimeRoutingPort {
    const runtime = this;
    return {
      get db() { return runtime.db; },
      get instanceName() { return runtime.instanceName; },
      get sessionScope() { return runtime.sessionScope; },
      get agentProvider() { return runtime.agentProvider; },
      get agentProviderConfig() { return runtime.agentProviderConfig; },
      get model() { return runtime.model; },
      get agentFallbacks() { return runtime.agentFallbacks; },
      get nlRoutingEnabled() { return runtime.nlRoutingEnabled; },
      get nlRouting() { return config.nlRouting; },
      get nlRoutingTiers() { return config.nlRoutingTiers; },
      get nlRoutingEventsDir() { return config.nlRoutingEventsDir; },
      get agentDataPolicy() { return runtime.agentDataPolicy; },
      get providerBoundaryMode() { return runtime.providerBoundaryMode; },
      get chatSessions() { return runtime.chatSessions; },
      get session() { return runtime.session; },
      get effectiveFallbackEntry() { return runtime.effectiveFallbackEntry; },
      get effectiveModel() { return runtime.effectiveModel; },
      get isFallbackWindowActive() { return runtime.isFallbackWindowActive; },
      get modelPinHost() { return runtime.modelPinHost; },
      get lastPinBlockNotice() { return runtime.lastPinBlockNotice; },
      get lastSpawnRouteProvider() { return runtime.lastSpawnRouteProvider; },
      sessionProviderConfig: () => runtime.sessionProviderConfig(),
      resolvePerChatMapKey: (chatJid) => runtime.resolvePerChatMapKey(chatJid),
      sendDirect: (chatJid, text) => runtime.sendDirect(chatJid, text),
      routablePinTargets: () => runtime.routablePinTargets(),
      isEntryCredentialed: (entry) => runtime.isEntryCredentialed(entry),
    };
  }

  /**
   * Host for the extracted fallback coordinator (runtime-fallback.ts, #1977
   * D2) — live-getter shape. ALL fallback state stays owned here: the
   * characterization suites bind these fields on the runtime instance, and
   * probePrimaryProviderRecovered / deactivateProviderFallback are stub/spy
   * seams that must observe in-cluster calls.
   */
  private createRuntimeFallbackHost(): RuntimeFallbackPort {
    const runtime = this;
    return {
      get db() { return runtime.db; },
      get instanceName() { return runtime.instanceName; },
      get fallbackTunables() { return config.fallbackTunables; },
      get cwd() { return runtime.cwd; },
      get model() { return runtime.model; },
      get agentProvider() { return runtime.agentProvider; },
      get agentProviderConfig() { return runtime.agentProviderConfig; },
      get agentFallbacks() { return runtime.agentFallbacks; },
      get agentFallbackDiscovery() { return runtime.agentFallbackDiscovery; },
      get modelCatalogueListFn() { return runtime.modelCatalogueListFn; },
      get allowM365Mutations() { return runtime.allowM365Mutations; },
      get runtimeBootPerfMs() { return runtime.runtimeBootPerfMs; },
      get globalMcpSocketPath() { return runtime.globalMcpSocketPath; },
      get egressProxy() { return runtime.egressProxy; },
      get providerExecutionGate() { return runtime.providerExecutionGate; },
      get controlSession() { return runtime.controlSession; },
      get fallbackWindow() { return runtime.fallbackWindow; },
      get fallbackMetrics() { return runtime.fallbackMetrics; },
      get fallbackChain() { return runtime.fallbackChain; },
      get fallbackEmptyAdvance() { return runtime.fallbackEmptyAdvance; },
      get turnCapabilityTracker() { return runtime.turnCapabilityTracker; },
      get recentNoFallbackReauthNotices() { return runtime.recentNoFallbackReauthNotices; },
      get recentFallbackEmptyTurnAlerts() { return runtime.recentFallbackEmptyTurnAlerts; },
      get revertTimer() { return runtime.revertTimer; },
      set revertTimer(value) { runtime.revertTimer = value; },
      get fallbackPrimaryProbeTimer() { return runtime.fallbackPrimaryProbeTimer; },
      set fallbackPrimaryProbeTimer(value) { runtime.fallbackPrimaryProbeTimer = value; },
      get periodicUsabilityProbeTimer() { return runtime.periodicUsabilityProbeTimer; },
      set periodicUsabilityProbeTimer(value) { runtime.periodicUsabilityProbeTimer = value; },
      get periodicUsabilityProbeBackoff() { return runtime.periodicUsabilityProbeBackoff; },
      set periodicUsabilityProbeBackoff(value) { runtime.periodicUsabilityProbeBackoff = value; },
      get periodicUsabilityProbeDueAt() { return runtime.periodicUsabilityProbeDueAt; },
      set periodicUsabilityProbeDueAt(value) { runtime.periodicUsabilityProbeDueAt = value; },
      get shutdownRequested() { return runtime.shutdownRequested; },
      get fallbackProbeAttempts() { return runtime.fallbackProbeAttempts; },
      set fallbackProbeAttempts(value) { runtime.fallbackProbeAttempts = value; },
      get fallbackLastProbeAt() { return runtime.fallbackLastProbeAt; },
      set fallbackLastProbeAt(value) { runtime.fallbackLastProbeAt = value; },
      get fallbackWindowRestored() { return runtime.fallbackWindowRestored; },
      set fallbackWindowRestored(value) { runtime.fallbackWindowRestored = value; },
      get pendingPostRevertConfirmation() { return runtime.pendingPostRevertConfirmation; },
      set pendingPostRevertConfirmation(value) { runtime.pendingPostRevertConfirmation = value; },
      get primaryModelUsability() { return runtime.primaryModelUsability; },
      set primaryModelUsability(value) { runtime.primaryModelUsability = value; },
      get primaryModelUsabilityAlertActive() { return runtime.primaryModelUsabilityAlertActive; },
      set primaryModelUsabilityAlertActive(value) { runtime.primaryModelUsabilityAlertActive = value; },
      get consecutivePrimaryEmptyTurns() { return runtime.consecutivePrimaryEmptyTurns; },
      set consecutivePrimaryEmptyTurns(value) { runtime.consecutivePrimaryEmptyTurns = value; },
      get consecutiveUnknownTerminalTurns() { return runtime.consecutiveUnknownTerminalTurns; },
      set consecutiveUnknownTerminalTurns(value) { runtime.consecutiveUnknownTerminalTurns = value; },
      get idleFallbackEligibilityResolver() { return runtime.idleFallbackEligibilityResolver; },
      set idleFallbackEligibilityResolver(value) { runtime.idleFallbackEligibilityResolver = value; },
      get effectiveProvider() { return runtime.effectiveProvider; },
      get effectiveFallbackEntry() { return runtime.effectiveFallbackEntry; },
      get isFallbackWindowActive() { return runtime.isFallbackWindowActive; },
      isEntryCredentialed: (entry) => runtime.isEntryCredentialed(entry),
      emitRouteEventChecked: (ev) => runtime.emitRouteEventChecked(ev),
      capDedupeMap: (map, max) => runtime.capDedupeMap(map, max),
      getTurnCapability: () => runtime.getTurnCapability(),
      verifyAccountIdentity: (trigger) => runtime.verifyAccountIdentity(trigger),
      scheduleFallbackReplay: (args) => runtime.scheduleFallbackReplay(args),
      notifyProviderFallbackActivated: (queue, activation, replay) =>
        runtime.notifyProviderFallbackActivated(queue, activation, replay),
      probePrimaryProviderRecovered: (onEvidence, signal) =>
        runtime.probePrimaryProviderRecovered(onEvidence, signal),
      deactivateProviderFallback: (reason, receipt) => runtime.deactivateProviderFallback(reason, receipt),
      schedulePostTransitionRouteRecycles: () => runtime.schedulePostTransitionRouteRecycles(),
    };
  }

  /**
   * Host for the account-identity verifier (task-21): live getters, and the
   * verification result as runtime-owned state so getHealthSnapshot reads it
   * without a second copy.
   */
  private createAccountIdentityVerifierHost(): AccountIdentityVerifierHost {
    const runtime = this;
    return {
      get instanceName() { return runtime.instanceName; },
      get agentProvider() { return runtime.agentProvider; },
      get expectedAccountDigest() { return runtime.expectedAccountDigest; },
      get shutdownRequested() { return runtime.shutdownRequested; },
      get accountIdentity() { return runtime.accountIdentity; },
      set accountIdentity(value) { runtime.accountIdentity = value; },
    };
  }

  /** Fire-and-forget identity verification after a usability probe settles
   *  (the coordinator's seam); the verifier never rejects. */
  private verifyAccountIdentity(trigger: AccountIdentityProbeTrigger): void {
    void this.accountIdentityVerifier.run(trigger);
  }

  /**
   * Host for the extracted poll bridge (runtime-poll-bridge.ts, #1977 D3) —
   * live-getter, getter-only shape: the bridge never reassigns runtime state.
   * Poll collaborators stay owned here (scaffold/stub seams bind them on the
   * runtime instance); deletePendingPollQuestions and fetchGroupAdminJids stay
   * whole on the runtime (structural-source and spy seams) and the bridge
   * reaches them through this host. The three config reads pass through so
   * the module never imports src/config.ts (ring boundary).
   */
  private createRuntimePollBridgeHost(): RuntimePollBridgePort {
    const runtime = this;
    return {
      get db() { return runtime.db; },
      get messenger() { return runtime.messenger; },
      get chatSessions() { return runtime.chatSessions; },
      get pendingPolls() { return runtime.pendingPolls; },
      get pollPersistence() { return runtime.pollPersistence; },
      get suppressedAskUserToolIds() { return runtime.suppressedAskUserToolIds; },
      get pendingPollSourceTurnBarriers() { return runtime.pendingPollSourceTurnBarriers; },
      get queuedDecisionConsumer() { return runtime.queuedDecisionConsumer; },
      get runtimeTurnCoordinator() { return runtime.runtimeTurnCoordinator; },
      get perChatRuntimeTurnCompletions() { return runtime.perChatRuntimeTurnCompletions; },
      get isFallbackWindowActive() { return runtime.isFallbackWindowActive; },
      get adminPhones() { return config.adminPhones; },
      get internalPeerJids() { return config.internalPeerJids; },
      get pollResolution() { return config.pollResolution; },
      observeOutboundQueueOperation: (scopeKey, queue, operation) =>
        runtime.observeOutboundQueueOperation(scopeKey, queue, operation),
      getQueueForChat: (chatJid, mapKey) => runtime.getQueueForChat(chatJid, mapKey),
      sendDirect: (chatJid, text) => runtime.sendDirect(chatJid, text),
      deletePendingPollQuestions: (mapKey) => runtime.deletePendingPollQuestions(mapKey),
      fetchGroupAdminJids: (chatJid) => runtime.fetchGroupAdminJids(chatJid),
      markSystemTurn: (session, scopeKey, purpose, routeChatJid) =>
        runtime.markSystemTurn(session, scopeKey, purpose, routeChatJid),
      sendTurnPerChat: (chatJid, text, mapKey, actorJid, runtimeContext, scopeRef, systemTurnLease, excludeJobId, requestedDeliveryKind, targetDispatchAllowed, onProviderBoundary) =>
        runtime.sendTurnPerChat(chatJid, text, mapKey, actorJid, runtimeContext, scopeRef, systemTurnLease, excludeJobId, requestedDeliveryKind, targetDispatchAllowed, onProviderBoundary),
      settleFailedSystemTurnDispatch: (session, scopeKey, lease, error) =>
        runtime.settleFailedSystemTurnDispatch(session, scopeKey, lease, error),
    };
  }

  private createRuntimeTurnHost(): RuntimeTurnCoordinatorPort & RuntimeResultHandlerPort {
    const runtime = this;
    return {
      db: runtime.db,
      instanceName: runtime.instanceName,
      get sessionScope() { return runtime.sessionScope; },
      deferredTurnAdmissionEnabled: () => runtime.deferredTurnAdmissionEnabled(),
      shared: runtime.shared,
      runtimeTurnSupervisor: runtime.runtimeTurnSupervisor,
      sessionOwnership: runtime.sessionOwnership,
      recoveryManagerId: runtime.recoveryManagerId,
      pendingPolls: runtime.pendingPolls,
      pendingSystemResults: runtime.pendingSystemResults,
      workspaceSweeper: runtime.workspaceSweeper,
      postTurnGate: runtime.postTurnGate,
      turnHadToolActivity: runtime.turnHadToolActivity,
      perChatInboundSeqQueue: runtime.perChatInboundSeqQueue,
      perChatRuntimeTurnContexts: runtime.perChatRuntimeTurnContexts,
      perChatRuntimeTurnCompletions: runtime.perChatRuntimeTurnCompletions,
      perChatRuntimeTurnScopeRefs: runtime.perChatRuntimeTurnScopeRefs,
      get turnQueue() { return runtime.turnQueue; },
      replaceGlobalTurnQueue: (expected) => runtime.replaceGlobalTurnQueue(expected),
      perChatTurnQueues: runtime.perChatTurnQueues,
      perChatTurnQueueKeys: runtime.perChatTurnQueueKeys,
      perChatExecActorQueue: runtime.perChatExecActorQueue,
      pendingTurnText: runtime.pendingTurnText,
      pendingTurnActorJid: runtime.pendingTurnActorJid,
      perChatTurnSourceMessageId: runtime.perChatTurnSourceMessageId,
      perChatTurnContentType: runtime.perChatTurnContentType,
      perChatTurnText: runtime.perChatTurnText,
      perChatTurnSuppressedReplySatisfaction: runtime.perChatTurnSuppressedReplySatisfaction,
      perChatAssistantItemText: runtime.perChatAssistantItemText,
      perChatRouteMarkerHold: runtime.perChatRouteMarkerHold,
      currentTurnAssistantItemText: runtime.currentTurnAssistantItemText,
      chatQueues: runtime.chatQueues,
      chatSessions: runtime.chatSessions,
      runtimeTurnAfterTerminal: runtime.runtimeTurnAfterTerminal,
      get durability() { return runtime.durability; },
      get runtimeTurnCoordinator() { return runtime.runtimeTurnCoordinator; },
      get replyGuarantee() { return runtime.replyGuarantee; },
      get recoveryGeneration() { return runtime.recoveryGeneration; },
      set recoveryGeneration(value) { runtime.recoveryGeneration = value; },
      get session() { return runtime.session; },
      set session(value) { runtime.session = value; },
      get pendingSingletonRuntimeTurnContext() { return runtime.pendingSingletonRuntimeTurnContext; },
      set pendingSingletonRuntimeTurnContext(value) { runtime.pendingSingletonRuntimeTurnContext = value; },
      get activeChatJid() { return runtime.activeChatJid; },
      set activeChatJid(value) { runtime.activeChatJid = value; },
      get currentInboundSeq() { return runtime.currentInboundSeq; },
      set currentInboundSeq(value) { runtime.currentInboundSeq = value; },
      get currentRuntimeTurnContext() { return runtime.currentRuntimeTurnContext; },
      set currentRuntimeTurnContext(value) { runtime.currentRuntimeTurnContext = value; },
      get currentRuntimeTurnCompletion() { return runtime.currentRuntimeTurnCompletion; },
      set currentRuntimeTurnCompletion(value) { runtime.currentRuntimeTurnCompletion = value; },
      get currentTurnChatJid() { return runtime.currentTurnChatJid; },
      set currentTurnChatJid(value) { runtime.currentTurnChatJid = value; },
      get currentTurnReplayText() { return runtime.currentTurnReplayText; },
      set currentTurnReplayText(value) { runtime.currentTurnReplayText = value; },
      get currentTurnReplayActorJid() { return runtime.currentTurnReplayActorJid; },
      set currentTurnReplayActorJid(value) { runtime.currentTurnReplayActorJid = value; },
      get currentTurnRouteMarkerHold() { return runtime.currentTurnRouteMarkerHold; },
      set currentTurnRouteMarkerHold(value) { runtime.currentTurnRouteMarkerHold = value; },
      get currentTurnInboundContentType() { return runtime.currentTurnInboundContentType; },
      set currentTurnInboundContentType(value) { runtime.currentTurnInboundContentType = value; },
      get currentTurnAssistantText() { return runtime.currentTurnAssistantText; },
      set currentTurnAssistantText(value) { runtime.currentTurnAssistantText = value; },
      get turnHadVisibleOutput() { return runtime.turnHadVisibleOutput; },
      set turnHadVisibleOutput(value) { runtime.turnHadVisibleOutput = value; },
      get turnHadSuppressedReplySatisfaction() { return runtime.turnHadSuppressedReplySatisfaction; },
      set turnHadSuppressedReplySatisfaction(value) { runtime.turnHadSuppressedReplySatisfaction = value; },
      get singleTurnHadToolActivity() { return runtime.singleTurnHadToolActivity; },
      set singleTurnHadToolActivity(value) { runtime.singleTurnHadToolActivity = value; },
      get isFallbackWindowActive() { return runtime.isFallbackWindowActive; },
      managerIdFor: (session) => runtime.managerIdFor(session),
      deriveCapabilityDecision: (context, session) => runtime.capabilityObligationRuntime?.deriveCapabilityDecision(context, session) ?? Promise.resolve(undefined),
      isShuttingDown: () => runtime.shutdownRequested,
      getActiveQueue: () => runtime.getActiveQueue(),
      getQueueForChat: (chatJid, mapKey) => runtime.getQueueForChat(chatJid, mapKey),
      sendTurnPerChat: (chatJid, text, mapKey, actorJid, context, scopeRef, systemTurnLease, excludeJobId, deliveryKind, dispatchAllowed, onProviderBoundary, purpose) =>
        runtime.sendTurnPerChat(chatJid, text, mapKey, actorJid, context, scopeRef, systemTurnLease, excludeJobId, deliveryKind, dispatchAllowed, onProviderBoundary, purpose),
      deleteOwnedPerChatSession: (mapKey, expected) => runtime.deleteOwnedPerChatSession(mapKey, expected),
      discardPerChatSessionForFallback: (mapKey, expected) =>
        runtime.discardPerChatSessionForFallback(mapKey, expected),
      discardSingletonSessionForFallback: (expected) => runtime.discardSingletonSessionForFallback(expected),
      recreatePerChatSessionForFallback: (mapKey, chatJid, actorJid, routeOverride) =>
        runtime.recreatePerChatSessionForFallback(mapKey, chatJid, actorJid, routeOverride),
      recreateSingletonSessionForFallback: (chatJid, actorJid, routeOverride) =>
        runtime.recreateSingletonSessionForFallback(chatJid, actorJid, routeOverride),
      isReplayRouteCurrent: (chatJid, actorJid, routeOverride) =>
        runtime.isReplayRouteCurrent(chatJid, actorJid, routeOverride),
      bindActiveGlobalMcpConversation: (chatJid) => runtime.bindActiveGlobalMcpConversation(chatJid),
      sendTurnToSession: (...args) => runtime.sendTurnToSession(...args),
      sendVoiceReply: (chatJid, responseText) => runtime._sendVoiceReply(chatJid, responseText),
      isSilentCompact: (scopeKey) => runtime.isSilentCompact(scopeKey),
      clearSilentCompact: (scopeKey) => runtime.clearSilentCompact(scopeKey),
      consumeCompactBoundary: (scopeKey) => runtime.consumeCompactBoundary(scopeKey),
      finishAutoCompact: (scopeKey) => runtime.finishAutoCompact(scopeKey),
      recordAutoCompactSuccess: (scopeKey) => runtime.recordAutoCompactSuccess(scopeKey),
      recordAutoCompactNextTurnIfNeeded: (scopeKey, inputTokens, consumeWhenNotOverThreshold) =>
        runtime.recordAutoCompactNextTurnIfNeeded(scopeKey, inputTokens, consumeWhenNotOverThreshold),
      maybeStartAutoCompact: (session, mapKey) => runtime.maybeStartAutoCompact(session, mapKey),
      flushRouteMarker: (held, chatJid, actorJid) => runtime.routing.flushRouteMarker(held, chatJid, actorJid),
      clearToolNames: (toolScopeKey) => runtime.clearToolNames(toolScopeKey),
      recordTurnCostUsd: (event) => runtime.recordTurnCostUsd(event),
      recordTurnCapabilitySuccess: (isUserTurnResult, session) =>
        runtime.recordTurnCapabilitySuccess(isUserTurnResult, session),
      recordTurnCapabilityFailure: (isUserTurnResult, errorClass) =>
        runtime.recordTurnCapabilityFailure(isUserTurnResult, errorClass),
      recordFallbackTurnOutcome: (queue, hadVisibleOutput, hadToolWork, session, wasUnclassifiedError) =>
        runtime.fallback.recordFallbackTurnOutcome(queue, hadVisibleOutput, hadToolWork, session, wasUnclassifiedError),
      maybeArmFallbackAfterEmptyPrimaryTurn: (queue, session, turnHadToolWork, mapKey) =>
        runtime.fallback.maybeArmFallbackAfterEmptyPrimaryTurn(queue, session, turnHadToolWork, mapKey),
      maybeArmFallbackAfterUnknownTerminal: (queue, session, turnHadToolWork, mapKey, isUserTurnResult, evidenceText) =>
        runtime.fallback.maybeArmFallbackAfterUnknownTerminal(queue, session, turnHadToolWork, mapKey, isUserTurnResult, evidenceText),
      enqueueAutoSwitchNotice: (queue, text, logChatJid, mode) =>
        runtime.enqueueAutoSwitchNotice(queue, text, logChatJid, mode),
      withHandoffPrefix: (chatJid, text) => runtime.withHandoffPrefix(chatJid, text),
      flushPendingHandoffNotice: (queue) => runtime.flushPendingHandoffNotice(queue),
      activateProviderFallback: (resetAt, reason, failedSession) =>
        runtime.fallback.activateProviderFallbackForSession(resetAt, reason ?? 'usage-limit', failedSession ?? null),
      activateProviderFallbackAfterTerminalResult: (resetAt, reason, session, evidenceText) =>
        runtime.fallback.activateProviderFallbackAfterTerminalResult(resetAt, reason, session, evidenceText),
      scheduleFallbackReplay: (args) => runtime.scheduleFallbackReplay(args),
      notifyProviderFallbackActivated: (queue, activation, replay) =>
        runtime.notifyProviderFallbackActivated(queue, activation, replay),
      emitNoFallbackReauthNotice: (queue) => runtime.fallback.emitNoFallbackReauthNotice(queue),
      usageLimitNotice: () => runtime.fallback.usageLimitNotice(),
      kickDiagnosticBundle: (workflow, providerText) => runtime.kickDiagnosticBundle(workflow, providerText),
    } satisfies RuntimeTurnCoordinatorPort & RuntimeResultHandlerPort;
  }

  private observeOutboundQueueOperation<T>(
    scopeKey: string,
    queue: IOutboundQueue,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runtimeTurnCoordinator.observeOutboundQueueOperation(scopeKey, queue, operation);
  }

  private registerAllTools(): void {
    const allowGlobalKnowledgeSearch = (config as {
      memory?: { pinecone?: { knowledgeSearch?: { allowGlobalAgentSessions?: boolean } } };
    }).memory?.pinecone?.knowledgeSearch?.allowGlobalAgentSessions === true;
    registerAllTools(this.registry, this.messenger as ConnectionManager, this.db, {
      enableKnowledgeSearch: this.sandboxPerChat || allowGlobalKnowledgeSearch,
      pollRegistrar: {
        register: (pollId, chatJid, options, resolution, timeoutMs, abortSignal) =>
          this.registerSendPollAwaiter(pollId, chatJid, options, resolution, timeoutMs, abortSignal),
      },
      fallbackActive: () => this.isFallbackWindowActive, // T8-F2: mirrors the outbound queue's fallback signal
    });
  }

  /**
   * Find the echo-guard token of any existing queue still targeting this chat,
   * across all three stores + the canonical key (QR-069). A replacement queue
   * inherits it so the predecessor's still-active group cooldown does not
   * silently flood-suppress the replacement's first (often terminal) reply.
   */
  private priorSenderTokenForChat(chatJid: string): string | undefined {
    const canonical = canonicalizeChatJid(chatJid, this.db);
    const prior =
      this.outboundQueues.get(chatJid) ??
      this.outboundQueues.get(canonical) ??
      this.chatQueues.get(chatJid) ??
      this.chatQueues.get(canonical) ??
      this.queue ??
      undefined;
    return prior?.getSenderToken();
  }

  /** Create and configure an OutboundQueue with shared settings (durability, toolUpdateMode). */
  private createOutboundQueue(chatJid: string, reason: string): OutboundQueue {
    // Durable attribution is DB-canonical and immutable. Delivery routing may
    // later move between a phone JID and LID without rewriting conversation_key.
    const conversationKey = canonicalConversationKey(chatJid, this.db);
    // QR-069: inherit a prior queue's echo-guard token when one exists.
    const priorToken = this.priorSenderTokenForChat(chatJid);
    const q = new OutboundQueue(this.messenger, chatJid, { // T8-F1+F2: inject admin-peer + fallback-window queries
      conversationKey, ...(priorToken === undefined ? {} : { senderToken: priorToken }),
      peerIsAdmin: (jid) => isOperatorDmPeer(jid, isGroupJid(jid), this.db, config.adminPhones),
      peerIsTrustedInternal: (jid) =>
        isTrustedInternalDmPeer(jid, isGroupJid(jid), config.internalPeerJids),
      fallbackActive: () => this.isFallbackWindowActive,
    });
    if (this.durability) q.setDurability(this.durability);
    q.setToolUpdateMode(config.toolUpdateMode);
    q.setToolUpdateRedirectJid(config.toolUpdateRedirectJid);
    q.setTextAggregateDelayMs(config.textAggregateDelayMs);
    log.debug({
      chatJid,
      conversationKey,
      reason,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
      hasDurability: this.durability !== null,
    }, 'created outbound queue');
    return q;
  }

  setDurability(engine: DurabilityEngine): void {
    this.durability = engine;
    this.registry.setDurability(engine);
    this.replyGuarantee?.shutdown();
    this.replyGuarantee = new ReplyGuaranteeManager({
      durability: engine,
      timeoutMs: this.replyGuaranteeTimeoutMs,
      sendFallback: createReplyGuaranteeLivenessSender({
        messenger: this.messenger,
      }),
    });
    // Propagate to any already-created outbound queues
    if (this.queue) this.queue.setDurability(engine);
    for (const q of this.outboundQueues.values()) q.setDurability(engine);
    for (const q of this.chatQueues.values()) q.setDurability(engine);
    this.turnRecoverySupervisor.start(); // PRESTAGE-T4; idempotent
    this.turnRecoveryDeadman.start();

    // #3374 ask 2: when the W2 sweep durably reclaims a stale open inbound, a
    // RUNTIME lane may still be pinned by that exact turn (provider terminal
    // never arrived — the live wedge class). Durable reclamation alone repairs
    // only the journal; this listener releases the wedged lane too.
    if (typeof engine.setStaleInboundReclaimListener === 'function') {
      engine.setStaleInboundReclaimListener((rows) => this.releaseWedgedReclaimedLanes(rows));
    }

    // Obligation replay: opt-in, per_chat only; the helper keeps ABSENT fields inert.
    this.capabilityObligationRuntime = maybeActivateCapabilityObligationRuntime({
      enabled: this.sessionScope === 'per_chat', alreadyActive: this.capabilityObligationRuntime !== null,
      options: config.capabilityObligations, db: this.db, store: engine.capabilityObligations, registry: this.registry,
      getDurability: () => this.durability, resolveMapKey: (jid) => this.resolvePerChatMapKey(jid),
      perChatTurnContexts: () => this.perChatRuntimeTurnContexts, turnCoordinator: this.runtimeTurnCoordinator,
      resolveDispatchTarget: (jid) => this.resolvePerChatDispatchTarget(jid),
      requireSessionToolScopeKey: (sess) => this.requireSessionToolScopeKey(sess),
      isDispatchTargetCurrent: (t) => this.isTurnRecoveryDispatchTargetCurrent(t),
      getChatSession: (key) => this.chatSessions.get(key),
      captureOwnedGeneration: (key, s) => this.captureOwnedPerChatGeneration(key, s),
      activateSpawnedSession: (key, s, o) => this.activateSpawnedOwnedPerChatSession(key, s, o),
    }) ?? this.capabilityObligationRuntime;
  }

  /** #3295 S2: live per-admission flag read (RuntimeTurnCoordinatorPort). */
  deferredTurnAdmissionEnabled(): boolean {
    return this.deferredTurnAdmissionOptions?.enabled === true;
  }

  /**
   * #3374 ask 2 — wedged-lane release, coupled to durable stale reclamation.
   *
   * A turn whose provider terminal never arrives pins its TurnQueue's
   * activeTurn forever: the turn watchdog clears at provider-turn terminal,
   * the idle sweep refuses mid-turn sessions, and the W2 sweep repairs only
   * the journal row (after its 24h grace). When that sweep reclaims a stale
   * open inbound that is STILL the active turn of a live lane, this handler
   * drives the same crash-finalization path a provider death would: the held
   * processor settles, queued followers drain to a fresh session, and the
   * wedge ends without a process restart. Lanes that do not match a reclaimed
   * row are untouched; the sweep's 24h grace means no legitimate long turn is
   * at risk (the long-op liveness ceiling caps genuine work far below that).
   */
  private releaseWedgedReclaimedLanes(rows: readonly StaleReclaimedInbound[]): void {
    if (rows.length === 0) return;
    const byMessageId = new Map(rows.map((row) => [row.sourceMessageId, row]));
    for (const [mapKey, turnQueue] of this.perChatTurnQueues) {
      const active = turnQueue.activeTurn;
      if (!active) continue;
      const row = byMessageId.get(active.sourceMessageId);
      if (row === undefined) continue;
      // The reclaimed row must identify THIS lane's turn, not a cross-chat
      // message-id collision: the journaled inbound and the queued turn share
      // a chat, so their conversation keys must agree.
      if (row.conversationKey !== toConversationKey(active.chatJid)) {
        log.warn(
          { inboundSeq: row.seq, mapKey },
          'wedged-lane release: reclaimed row conversation does not match the lane — skipping',
        );
        continue;
      }
      const session = this.chatSessions.get(mapKey);
      if (!session || session === this.controlSession) {
        log.warn(
          { inboundSeq: row.seq, queuedBehind: turnQueue.pending },
          'wedged-lane release: reclaimed turn pins a queue with no owned session — skipping',
        );
        continue;
      }
      const managerId = this.sessionManagerIds.get(session);
      const owner = this.sessionOwnership.get(mapKey);
      if (!managerId || !owner || owner.managerId !== managerId) {
        log.warn({ inboundSeq: row.seq }, 'wedged-lane release: session ownership is not current — skipping');
        continue;
      }
      // A session whose provider turn is NOT in flight is not wedged: its
      // terminal arrived and ordinary finalization is racing the sweep —
      // killing it would shoot a healthy child. Doubles without the field
      // report undefined and proceed.
      if (session.getStatus().turnInFlight === false) {
        log.warn(
          { inboundSeq: row.seq, mapKey },
          'wedged-lane release: provider turn already terminalized — leaving finalization to its owner',
        );
        continue;
      }
      // Exactly one published context is the releasable shape; anything else
      // is an anomalous lane no release action should touch (disclosed, not
      // silent — and checked BEFORE the alert and the child kill).
      const publishedContexts = this.perChatRuntimeTurnContexts.get(mapKey) ?? [];
      if (publishedContexts.length !== 1) {
        log.warn(
          { inboundSeq: row.seq, mapKey, publishedContexts: publishedContexts.length },
          'wedged-lane release: lane does not hold exactly one runtime turn context — skipping',
        );
        continue;
      }
      log.warn(
        { inboundSeq: row.seq, queuedBehind: turnQueue.pending, scope: this.sessionScope },
        'durably reclaimed turn still pins a live lane — releasing via crash finalization',
      );
      emitAlertChecked(
        this.instanceName,
        'agent_wedged_turn_released',
        'Wedged agent turn released after durable reclamation',
        `inbound_seq=${row.seq} queued_behind=${turnQueue.pending} scope=${this.sessionScope}`,
        'warning',
      );
      // A live provider child (real-process wedge) is killed intentionally so
      // its exit routes through the session's own crash machinery; session
      // doubles and managed-provider sessions have no child to kill.
      if (typeof session.reapWedgedProviderChild === 'function') {
        session.reapWedgedProviderChild();
      }
      // Reject the held turn's runtime completion (the turn-recovery
      // replay-abort pattern), then settle the session's provider-turn
      // promise: the pinned processor is parked inside `sendTurn`, which by
      // contract resolves only at provider TERMINALIZATION — an event the
      // wedge, by definition, will never produce. A killed real child
      // resolves it from its exit handler; resolving directly keeps the
      // release independent of a child existing (completeProviderTurn is
      // idempotent). The processor then observes the rejected completion and
      // the queue's ordinary processor-error finalization retires the turn —
      // the finalizer recognizes the sweep-owned durable terminal
      // (reclaimed_by_sweep) and retires the runtime state through the
      // standard post-effects, so followers drain to a fresh session.
      // Deliberately NOT pre-finalized here: a second finalization owner
      // would race the canonical one.
      this.runtimeTurnCoordinator.rejectRuntimeTurnCompletion(
        new WedgedTurnReclaimedError(),
        mapKey,
        publishedContexts[0],
      );
      session.completeProviderTurn();
    }
  }

  /**
   * Update delivery JID for active sessions and queues when a LID→phone
   * mapping changes. Iterates per-chat queues and socket servers keyed
  * by conversationKey (sandboxPerChat mode) or raw chatJid.
  */
  handleJidAliasChanged(
    conversationKey: string,
    newJid: string,
    deferIfActive: boolean = true,
  ): void {
    const activeContext = this.currentRuntimeTurnContext?.identity.conversationKey === conversationKey
      ? this.currentRuntimeTurnContext
      : [...this.perChatRuntimeTurnContexts.values()]
          .flat()
          .find((context) => context.identity.conversationKey === conversationKey)
        ?? [...this.perChatTurnQueues.values()]
          .map((queue) => queue.activeTurn?.runtimeContext)
          .find((context) => context?.identity.conversationKey === conversationKey);
    if (deferIfActive && activeContext) {
      const turnId = activeContext.identity.logicalTurnId;
      const priorAction = this.runtimeTurnAfterTerminal.get(turnId);
      this.runtimeTurnAfterTerminal.set(turnId, async (result) => {
        this.handleJidAliasChanged(conversationKey, newJid, false);
        await priorAction?.(result);
      });
      log.info(
        { conversationKey, newJid, turnId },
        'deferred delivery JID migration until active turn terminalized',
      );
      return;
    }

    if (deferIfActive && this.sessionScope === 'per_chat' && !this.sandboxPerChat) {
      const lidKey = `${conversationKey}@lid`;
      if (this.chatSessions.has(lidKey) && this.pendingSystemResults.count(lidKey) > 0) {
        const existing = this.pendingJidAliasChanges.get(conversationKey);
        if (existing) {
          existing.newJid = newJid;
        } else {
          const pending = { newJid };
          this.pendingJidAliasChanges.set(conversationKey, pending);
          void this.pendingSystemResults.waitUntilEmpty(lidKey).then(() => {
            if (this.pendingJidAliasChanges.get(conversationKey) !== pending) return;
            this.pendingJidAliasChanges.delete(conversationKey);
            if (this.shutdownRequested) return;
            this.handleJidAliasChanged(conversationKey, pending.newJid, false);
          });
        }
        log.info(
          { conversationKey, newJid, systemScopeKey: lidKey },
          'deferred delivery JID migration until provider system requests terminalized',
        );
        return;
      }
    }

    // Per-chat queues (sandboxPerChat or per_chat mode)
    const queue = this.chatQueues.get(conversationKey);
    if (queue) {
      queue.updateDeliveryJid(newJid);
      log.info({ conversationKey, newJid }, 'updated delivery JID on outbound queue');
    }

    // Per-chat socket servers
    const res = this.workspaceResources.get(conversationKey);
    if (res?.socketServer) {
      res.socketServer.updateDeliveryJid(newJid);
      log.info({ conversationKey, newJid }, 'updated delivery JID on socket server');
    }

    // Shared-mode outbound queues (keyed by canonical JID — may need re-key)
    for (const [key, q] of this.outboundQueues) {
      try {
        if (toConversationKey(key) === conversationKey) {
          q.updateDeliveryJid(newJid);
          // Re-key from old LID-based key to canonical phone JID
          const canonical = canonicalizeChatJid(newJid, this.db);
          if (key !== canonical) {
            this.outboundQueues.delete(key);
            this.outboundQueues.set(canonical, q);
            log.info({ oldKey: key, newKey: canonical }, 'shared-mode: re-keyed outbound queue after LID resolution');
          }
        }
      } catch (err) {
        log.debug({ err, key }, 'JID parsing failed during session resume — skipping');
      }
    }

    // Single-mode queue
    if (this.queue) {
      this.queue.updateDeliveryJid(newJid);
    }

    // Re-key per_chat maps: if a session is stored under a LID-based key,
    // migrate it to the canonical phone JID now that the mapping is known.
    // All co-keyed maps must be migrated atomically.
    if (this.sessionScope === 'per_chat' && !this.sandboxPerChat) {
      const lidKey = `${conversationKey}@lid`;
      const canonical = canonicalizeChatJid(newJid, this.db);
      this.runtimeTurnCoordinator.rekeyPerChatTurnQueueHaltScope(lidKey, canonical);
      this.runtimeTurnCoordinator.rekeyPerChatOutboundQueuePoisonScope(lidKey, canonical);
      if (this.chatSessions.has(lidKey)) {
        if (canonical !== lidKey && !this.chatSessions.has(canonical)) {
          const legacyProviderTurn = this.legacyProviderTurnOwners.get(lidKey);
          if (legacyProviderTurn && this.legacyProviderTurnOwners.has(canonical)) {
            throw new Error(`Cannot rekey provider turn ownership onto occupied scope "${canonical}"`);
          }
          this.pendingSystemResults.rekeyScope(lidKey, canonical);
          if (legacyProviderTurn) {
            this.legacyProviderTurnOwners.delete(lidKey);
            this.legacyProviderTurnOwners.set(canonical, legacyProviderTurn);
          }

          // Migrate session
          const session = this.chatSessions.get(lidKey)!;
          this.rekeyOwnedPerChatSession(lidKey, canonical, session);

          // Migrate queue
          const chatQueue = this.chatQueues.get(lidKey);
          if (chatQueue) {
            chatQueue.updateDeliveryJid(newJid);
            this.chatQueues.delete(lidKey);
            this.chatQueues.set(canonical, chatQueue);
          }

          // Migrate all co-keyed per-chat maps
          const seqQueue = this.perChatInboundSeqQueue.get(lidKey);
          if (seqQueue) {
            this.perChatInboundSeqQueue.delete(lidKey);
            this.perChatInboundSeqQueue.set(canonical, seqQueue);
          }
          const runtimeContexts = this.perChatRuntimeTurnContexts.get(lidKey);
          if (runtimeContexts) {
            this.perChatRuntimeTurnContexts.delete(lidKey);
            this.perChatRuntimeTurnContexts.set(canonical, runtimeContexts);
            for (const runtimeContext of runtimeContexts) {
              const scopeRef = this.perChatRuntimeTurnScopeRefs.get(
                runtimeContext.identity.logicalTurnId,
              );
              if (scopeRef) scopeRef.value = canonical;
            }
          }
          const runtimeCompletion = this.perChatRuntimeTurnCompletions.get(lidKey);
          if (runtimeCompletion) {
            this.perChatRuntimeTurnCompletions.delete(lidKey);
            this.perChatRuntimeTurnCompletions.set(canonical, runtimeCompletion);
          }
          const runtimeTurnQueue = this.perChatTurnQueues.get(lidKey);
          if (runtimeTurnQueue) {
            this.perChatTurnQueues.delete(lidKey);
            this.perChatTurnQueues.set(canonical, runtimeTurnQueue);
            const queueKey = this.perChatTurnQueueKeys.get(runtimeTurnQueue);
            if (queueKey) queueKey.value = canonical;
          }
          const pending = this.pendingTurnText.get(lidKey);
          if (pending !== undefined) {
            this.pendingTurnText.delete(lidKey);
            this.pendingTurnText.set(canonical, pending);
          }
          if (this.pendingTurnActorJid.has(lidKey)) {
            const pendingActor = this.pendingTurnActorJid.get(lidKey);
            this.pendingTurnActorJid.delete(lidKey);
            this.pendingTurnActorJid.set(canonical, pendingActor);
          }
          if (this.pendingTurnPurpose.has(lidKey)) {
            const pendingPurpose = this.pendingTurnPurpose.get(lidKey);
            this.pendingTurnPurpose.delete(lidKey);
            this.pendingTurnPurpose.set(canonical, pendingPurpose);
          }
          // F-STICKY-ACTOR (QR-247, F4): migrate the executing-actor queue and
          // actor-socket identity together so the live resolver follows the new key.
          const execActors = this.perChatExecActorQueue.get(lidKey);
          if (execActors !== undefined) {
            this.perChatExecActorQueue.delete(lidKey);
            this.perChatExecActorQueue.set(canonical, execActors);
          }
          for (const binding of this.systemTurnExecActors.values()) {
            if (binding.scopeKey === lidKey) binding.scopeKey = canonical;
          }
          this.perChatMcpSocketManager.rekey(lidKey, canonical, newJid);
          // QR-049: migrate the per_chat OperationTracker. It holds a setInterval
          // progress timer + slow/stall setTimeouts that are cleared only by
          // shutdown() keyed on the canonical mapKey — leaving it under lidKey
          // leaks the timer and loses the chat's in-flight progress/stall state.
          const opTracker = this.operationTrackers.get(lidKey);
          if (opTracker) {
            this.operationTrackers.delete(lidKey);
            this.operationTrackers.set(canonical, opTracker);
          }
          this.crashes.rekey(lidKey, canonical);
          const contentType = this.perChatTurnContentType.get(lidKey);
          if (contentType !== undefined) {
            this.perChatTurnContentType.delete(lidKey);
            this.perChatTurnContentType.set(canonical, contentType);
          }
          const sourceMessageId = this.perChatTurnSourceMessageId.get(lidKey);
          if (sourceMessageId !== undefined) {
            this.perChatTurnSourceMessageId.delete(lidKey);
            this.perChatTurnSourceMessageId.set(canonical, sourceMessageId);
          }
          const turnText = this.perChatTurnText.get(lidKey);
          if (turnText !== undefined) {
            this.perChatTurnText.delete(lidKey);
            this.perChatTurnText.set(canonical, turnText);
          }
          if (this.perChatTurnSuppressedReplySatisfaction.has(lidKey)) {
            this.perChatTurnSuppressedReplySatisfaction.delete(lidKey);
            this.perChatTurnSuppressedReplySatisfaction.add(canonical);
          }
          const itemText = this.perChatAssistantItemText.get(lidKey);
          if (itemText) {
            this.perChatAssistantItemText.delete(lidKey);
            this.perChatAssistantItemText.set(canonical, itemText);
          }
          if (this.resumeFailedHandling.has(lidKey)) {
            this.resumeFailedHandling.delete(lidKey);
            this.resumeFailedHandling.add(canonical);
          }
          // MINOR 4 (final-review): carry a deferred route recycle (Task G,
          // a /model pin that arrived while the chat was busy) onto the
          // canonical key too — without this, a mapKey migration between the
          // defer and its consumption (ensureSessionAndQueueSync's next-
          // inbound check, keyed by the CURRENT canonical key) would strand
          // the flag under the dead lidKey and silently drop the recycle
          // (the pin still applies on the next fresh spawn, so this is
          // non-destructive either way — but cheap to carry correctly).
          this.routeRecycleLifecycle.rekeyScope(lidKey, canonical);
          // Migrate auto-compact cooldown/last-success/rapid-rearm/measure state
          // from the LID key onto the canonical JID (silent timers, boundary set,
          // and in-flight waiters are intentionally left untouched, as before).
          this.autoCompact.rekey(lidKey, canonical);
          const pendingPoll = this.pendingPolls.questions.get(lidKey);
          if (pendingPoll) {
            this.pendingPolls.questions.delete(lidKey);
            this.pollPersistence.remove(lidKey);
            clearPendingPollTimers(pendingPoll);
            pendingPoll.chatJidAliases.add(lidKey);
            pendingPoll.chatJidAliases.add(newJid);
            pendingPoll.chatJidAliases.add(canonical);
            pendingPoll.chatJid = canonical;
            this.pendingPolls.questions.set(canonical, pendingPoll);
            this.pollPersistence.save(canonical, pendingPoll);
            this.startPendingPollExpiry(canonical, pendingPoll);
          }
          const imageBuffer = this.imageCoalesce.buffers.get(lidKey);
          if (imageBuffer) {
            clearTimeout(imageBuffer.timer);
            imageBuffer.timer = setTimeout(
              () => void this.flushImageCoalesce(canonical),
              AgentRuntime.IMAGE_COALESCE_MS,
            );
            imageBuffer.msg = { ...imageBuffer.msg, chatJid: newJid };
            this.imageCoalesce.buffers.delete(lidKey);
            this.imageCoalesce.buffers.set(canonical, imageBuffer);
          }
          this.cleanupPerChatState(lidKey, { preserveProviderTurnOwnership: true });
          log.info({ lidKey, canonical, newJid }, 'per_chat: re-keyed session and all maps after LID resolution');
        }
      }
    }
  }

  private checkpointResumeIdentity(
    checkpoint: SessionCheckpointRow,
    expectedScope: PersistedResumeIdentity['scope'],
  ): PersistedResumeIdentity | null {
    const identity = resolveResumeIdentity({
      scope: checkpoint.completed_scope,
      conversationKey: checkpoint.conversation_key,
      deliveryJid: checkpoint.completed_delivery_jid,
      deliveryNamespace: checkpoint.completed_delivery_namespace,
      inboundSeq: checkpoint.completed_inbound_seq,
      logicalTurnId: checkpoint.completed_logical_turn_id,
      managerId: checkpoint.completed_manager_id,
      generation: checkpoint.completed_generation,
    });
    return identity?.scope === expectedScope ? identity : null;
  }

  private completedDeliveryIdentityAdmissionReason(
    checkpoint: SessionCheckpointRow | undefined,
    expectedScope: PersistedResumeIdentity['scope'],
  ): 'missing' | 'invalid' | 'scope_mismatch' {
    if (checkpoint === undefined) return 'missing';
    const fields = [
      checkpoint.completed_scope,
      checkpoint.completed_delivery_jid,
      checkpoint.completed_delivery_namespace,
      checkpoint.completed_inbound_seq,
      checkpoint.completed_logical_turn_id,
      checkpoint.completed_manager_id,
      checkpoint.completed_generation,
    ];
    if (fields.some((field) => field === null || field === undefined)) return 'missing';
    const identity = resolveResumeIdentity({
      scope: checkpoint.completed_scope,
      conversationKey: checkpoint.conversation_key,
      deliveryJid: checkpoint.completed_delivery_jid,
      deliveryNamespace: checkpoint.completed_delivery_namespace,
      inboundSeq: checkpoint.completed_inbound_seq,
      logicalTurnId: checkpoint.completed_logical_turn_id,
      managerId: checkpoint.completed_manager_id,
      generation: checkpoint.completed_generation,
    });
    if (identity === null) return 'invalid';
    return identity.scope === expectedScope ? 'invalid' : 'scope_mismatch';
  }

  private completedDeliveryIdentityAdmissionHealth(): {
    unresolvedCount: number;
    oldestTransitionAt: string | null;
    maximumAttempts: number;
    nextAction: 'fresh_inbound' | 'operator' | null;
  } {
    const empty = {
      unresolvedCount: 0,
      oldestTransitionAt: null,
      maximumAttempts: 0,
      nextAction: null,
    } as const;
    if (!this.durability || typeof this.durability.getCompletedDeliveryIdentityAdmissionHealth !== 'function') {
      return empty;
    }
    return this.durability.getCompletedDeliveryIdentityAdmissionHealth();
  }

  private recordProactiveResumeIdentityReject(
    conversationKey: string | null,
    reason: 'legacy_or_ambiguous_identity' | 'scope_mismatch',
  ): void {
    this.proactiveResumeIdentityRejects += 1;
    log.warn(
      { conversationKey, reason },
      'skipping proactive resume — persisted delivery identity is not provable',
    );
  }

  async start(): Promise<void> {
    // C5 restart-loop guard: mark this boot BEFORE any fallible work so a
    // later crash leaves the marker standing. Consumed at the resume gate
    // below; fail-open inside the guard (a broken breaker never wedges a
    // healthy instance).
    this.restartLoopInterruptedBoot = config.restartLoopGuard.enabled
      ? markBootInProgress(restartLoopGuardPath(config.stateRoot))
      : false;
    this.db.assertWritableCompatibility();
    if (this.cwd && isSamePhysicalDirectory(this.cwd, homedir())) throw new Error('configured agent cwd must not resolve to the user home directory');
    ensureAgentSchema(this.db);
    // Crash-safe latch table for the one-message handoff collapse. Idempotent;
    // created eagerly so an unconsumed notice from a prior process can flush.
    ensureStandbyNoticeSchema(this.db);
    // Handoff-artifact store for the distilled-context injection seam. Idempotent;
    // created eagerly so a fresh stand-in session can read a prior distill. The
    // injection itself is flag-gated (WHATSOUP_HANDOFF_CONTEXT); creating the
    // table unconditionally is inert when the flag is off.
    ensureHandoffArtifactSchema(this.db);
    this.fallback.restorePersistedFallbackWindow();
    // Periodic real-completion canary over the chain (no-op unless
    // WHATSOUP_FALLBACK_CANARY_MS > 0) — see fallback-canary-config.ts.
    this.fallback.startChainCanary();
    // Discovery mode (R6): derive the chain from the live model catalogue
    // BEFORE the MCP-config write below iterates the chain. Awaited but
    // bounded (the catalogue probe carries its own kill-timer) and honest-
    // degrading — an unavailable catalogue leaves the chain empty + alerted,
    // never fails boot.
    await this.fallback.refreshDiscoveredFallbackChain('boot');
    backfillSessionProvider(this.db, this.agentProvider ?? 'claude-cli');
    if (config.nlRouting) {
      // Additive + idempotent; gated so flag-off leaves the DB untouched.
      ensureChatPreferenceSchema(this.db);
      // Retention sweep at boot: expired rows are DELETED, not merely
      // ignored on read (F13) — keeps DB audits honest about live pins.
      pruneExpired(this.db);
    }

    const sandboxHookPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/hooks/agent-sandbox.sh');

    // Write sandbox policy and hook settings when sandbox config is present
    if (this.sandbox) {
      const cwd = this.cwd ?? homedir();
      try {
        const claudeDir = join(cwd, '.claude');
        mkdirSync(claudeDir, { recursive: true, mode: 0o700 });

        // Resolve allowedPaths to absolute paths before writing
        const resolvedPolicy = {
          ...this.sandbox,
          allowedPaths: this.sandbox.allowedPaths.map(p =>
            p.startsWith('~/') ? join(homedir(), p.slice(2)) : resolve(p),
          ),
        };
        const pollLintHookPath = resolve(
          new URL('.', import.meta.url).pathname,
          '../../../deploy/hooks/poll-interaction-lint.mjs',
        );
        const postToolUseLogHookPath = resolve(
          new URL('.', import.meta.url).pathname,
          '../../../deploy/hooks/post-tool-use-log.sh',
        );
        writeSandboxArtifacts(claudeDir, resolvedPolicy, sandboxHookPath, pollLintHookPath, postToolUseLogHookPath);
        log.info({ cwd, hookPath: sandboxHookPath, pollLintHookPath, postToolUseLogHookPath }, 'wrote sandbox-policy.json and settings.json');

        // Opt-in egress-allowlist proxy (#1607 / QR-008): whenever the sandbox
        // policy carries a PRESENT allowedEgress array (even []=deny-all, F1).
        // Reads the policy BACK off disk (not the in-memory resolvedPolicy) on
        // every request, so a live edit to sandbox-policy.json takes effect
        // without a restart; a corrupt/unreadable file fails closed (egress-proxy.ts).
        if (Array.isArray(this.sandbox.allowedEgress)) {
          // Own try so a proxy bind failure is labelled as such (not as a
          // sandbox-artifact write failure) — then re-throw to abort start():
          // an opted-in instance must NOT run with egress unconfined (fail-closed).
          try {
            const policyPath = join(claudeDir, 'sandbox-policy.json');
            this.egressProxy = await EgressProxy.start({
              policy: {
                read: () => {
                  const raw = JSON.parse(readFileSync(policyPath, 'utf8'));
                  return { allowedEgress: Array.isArray(raw.allowedEgress) ? raw.allowedEgress.filter((e: unknown) => typeof e === 'string') : [] };
                },
              },
              failOpen: config.sandboxFailOpen,
              log: (event) => log.info(event, 'egress adjudication'),
            });
            log.info(
              { port: this.egressProxy.port, allowlistSize: this.sandbox.allowedEgress.length },
              'started egress-allowlist proxy',
            );
          } catch (proxyErr) {
            log.error({ err: proxyErr, cwd }, 'failed to start egress-allowlist proxy — aborting start (fail-closed)');
            throw proxyErr;
          }
        }
      } catch (err) {
        log.error({ err, cwd }, 'failed to initialize sandbox artifacts');
        throw err;
      }
    }

    // Ensure settings.json has a permissions block — safety net for instances
    // without sandbox config. Prevents CLI "sensitive file" protections.
    {
      const cwd = this.cwd ?? homedir();
      try {
        const claudeDir = join(cwd, '.claude');
        ensurePermissionsSettings(claudeDir, 'agent', this.enabledPlugins, { hasSandbox: !!this.sandbox });
        // User-level settings are not owned by this instance. Startup only
        // inspects for its exact hook and warns; it never repairs or normalizes
        // global hooks, permissions, or plugins.
        if (!this.sandbox) {
          const homeClaudeDir = join(homedir(), '.claude');
          if (homeClaudeDir !== claudeDir) {
            inspectUserClaudeSettings(homeClaudeDir, sandboxHookPath);
          }
        }
      } catch (err) {
        log.error({ err, cwd }, 'failed to ensure permissions settings during startup');
        throw err;
      }
    }

    // Start global WhatSoup socket server (non-sandboxPerChat mode only)
    if (!this.sandboxPerChat) {
      const agentCwd = this.cwd ?? homedir();
      try {
        const claudeDir = join(agentCwd, '.claude');
        mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
        const socketPath = join(claudeDir, 'whatsoup.sock');

        // Fail-closed file boundary (audit #1094): the global session must carry
        // an explicit allowedRoot or file-capable tools (post_status/send_media/
        // schedule_message) would be denied. agentCwd is the agent's working root
        // (the parent of every chatJidToWorkspace() workspace), so legit media the
        // agent stages under its tree stays reachable while paths outside it
        // (system dirs, credentials, the instance DB) are rejected.
        if (!this.cwd) {
          log.warn(
            { agentCwd },
            'agent cwd unset; global MCP file boundary falls back to home directory',
          );
        }
        const globalSession: SessionContext = { tier: 'global', allowedRoot: agentCwd };
        // #2976 (ii): identity is resolved per request from the executing-turn
        // register — never stored on the session (no broadcast to go stale).
        this.globalSocketServer = new WhatSoupSocketServer(
          socketPath,
          this.registry,
          globalSession,
          () => this.resolveExecutingGlobalSession(),
        );
        this.globalSocketServer.start();
        this.globalMcpSocketPath = socketPath;
        log.info({ socketPath }, 'global WhatSoup socket server started');
        // Write the whatsoup MCP config to every configured CLI provider target:
        // primary first, then fallback when it uses a distinct config file.
        const mcpServerScript = providerMcpProxyScriptPath();
        const writtenTargets = new Set<string>();
        const writtenPaths: string[] = [];
        const writeFor = (provider: string, providerConfig?: { baseUrl?: string; model?: string; apiKeyService?: string }): void => {
          const target = writeProviderMcpConfigTarget(provider, agentCwd);
          if (target === null) return;
          if (writtenTargets.has(target)) {
            log.warn(
              { primary: this.agentProvider, fallback: provider, target },
              'primary and fallback providers share an MCP config target — primary shape kept',
            );
            return;
          }
          const written = writeProviderMcpConfig(
            provider,
            agentCwd,
            socketPath,
            mcpServerScript,
            providerConfig,
          );
          if (written) {
            writtenTargets.add(written);
            writtenPaths.push(written);
          }
        };

        const primaryOpencodeProviderConfig = this.fallback.primaryOpencodeProviderConfig();
        writeFor(this.agentProvider, primaryOpencodeProviderConfig);
        for (const entry of this.agentFallbacks) {
          if (entry.provider === this.agentProvider) continue;
          writeFor(
            entry.provider,
            entry.provider === 'opencode-cli'
              ? { model: entry.model }
              : undefined,
          );
        }
        log.info({ agentCwd, provider: this.agentProvider, fallbackChain: this.agentFallbacks, mcpConfigPaths: writtenPaths }, 'wrote whatsoup MCP config');
      } catch (err) {
        if (this.globalSocketServer) {
          try {
            this.globalSocketServer.stop();
          } catch (stopErr) {
            log.warn({ err: stopErr, agentCwd }, 'failed to clean up global socket server after startup error');
          }
          this.globalSocketServer = null;
        }
        this.globalMcpSocketPath = null;
        log.error({ err, agentCwd }, 'failed to initialize global MCP socket resources');
        throw err;
      }
    }

    // sandboxPerChat: backfill workspace keys for legacy rows
    if (this.sandboxPerChat) {
      backfillWorkspaceKeys(this.db, this.cwd ?? homedir());
    }

    // QR-099: conversation keys whose prior-instance child the sweep left running
    // (authoritative_live) or declined to touch (ambiguous). The proactive-resume
    // loop below MUST NOT spawn a second session for these — a live child + a
    // resumable checkpoint for the same key would otherwise yield two agent
    // sessions for one chat (duplicate turn processing / replies, contended
    // per-chat state). The in-loop `chatSessions.has()` guard only dedupes THIS
    // instance's own spawns; it cannot see a prior-instance child.
    const proactiveResumeBlockedConversationKeys = await this.sweepStaleAgentSessions();

    // per_chat (non-sandboxed): proactively resume sessions that were active or suspended
    // (graceful shutdown) when we last ran. This lets agents pick up mid-conversation instead
    // of waiting for the user to send a message after a service restart.
    // sandboxPerChat is excluded — its resume path requires workspace provisioning which happens lazily.
    if (this.sessionScope === 'per_chat' && !this.sandboxPerChat && this.durability && config.proactiveResumeOnStartup) {
      const resumableCheckpointsRaw = this.durability.getResumableCheckpoints();
      // C5 restart-loop guard: on trip, suppress proactive resume for this
      // boot — sessions still lazy-resume on their next inbound message
      // (the existing fail-safe for every other skip), the instance stays up
      // serving inbound, and the operator gets one notice. An empty list
      // makes the loop below a no-op.
      const resumableCheckpoints = this.shouldSuppressProactiveResume(resumableCheckpointsRaw.length)
        ? []
        : resumableCheckpointsRaw;
      for (const cp of resumableCheckpoints) {
        const full = this.durability.getSessionCheckpoint(cp.conversation_key);
        if (!full?.session_id) continue;

        // QR-099: a still-live (authoritative_live) or ambiguous session for this
        // key was left running by the sweep above — resuming would double-spawn.
        // Skipping degrades to lazy resume on the next message (fail-safe).
        if (proactiveResumeBlockedConversationKeys.has(cp.conversation_key)) {
          log.info({ conversationKey: cp.conversation_key }, 'skipping proactive resume — live/ambiguous session already present');
          continue;
        }

        const resumeIdentity = this.checkpointResumeIdentity(full, 'per_chat');
        if (!resumeIdentity) {
          const admissionReason = this.completedDeliveryIdentityAdmissionReason(full, 'per_chat');
          this.recordProactiveResumeIdentityReject(
            cp.conversation_key,
            admissionReason === 'scope_mismatch'
              ? 'scope_mismatch'
              : 'legacy_or_ambiguous_identity',
          );
          if (typeof this.durability.quarantineCompletedDeliveryIdentityCheckpoint === 'function') {
            this.durability.quarantineCompletedDeliveryIdentityCheckpoint({
              conversationKey: cp.conversation_key,
              providerSessionId: full.session_id,
              provider: this.effectiveProvider,
              reason: admissionReason,
            });
          }
          continue;
        }
        const chatJid = resumeIdentity.deliveryJid;

        // AE1: Skip group conversations — groups should not be proactively resumed.
        // Agents in groups are orchestrated via @mentions. Proactive resume bypasses
        // the ingest pipeline's sibling filter (access-policy.ts:121-124), causing
        // unsolicited messages. Group sessions start fresh on the next @mention.
        if (isGroupConversationKey(cp.conversation_key) || isGroupJid(chatJid)) {
          log.info({ conversationKey: cp.conversation_key }, 'skipping proactive resume — group chat');
          this.durability.upsertSessionCheckpoint(cp.conversation_key, { sessionStatus: 'ended' });
          continue;
        }

        // Skip stale sessions — don't resume conversations that have been inactive for over 60 minutes.
        // Without this, every restart tries to resurrect days-old sessions and fires unsolicited messages.
        const RESUME_MAX_AGE_MS = MS_PER_HOUR;
        if (full.updated_at) {
          const age = Date.now() - new Date(full.updated_at + 'Z').getTime();
          if (age > RESUME_MAX_AGE_MS) {
            log.info({ conversationKey: cp.conversation_key, ageMinutes: Math.round(age / 60_000) }, 'skipping proactive resume — session too stale');
            this.durability.upsertSessionCheckpoint(cp.conversation_key, { sessionStatus: 'ended' });
            continue;
          }
        }

        const initialMapKey = this.resolvePerChatMapKey(chatJid);
        if (this.chatSessions.has(initialMapKey)) continue; // already created by sweep or prior iteration

        log.info({ conversationKey: cp.conversation_key, sessionId: full.session_id, chatJid, mapKey: initialMapKey }, 'proactive per_chat resume on startup');

        // Create session + queue (same as ensureSessionAndQueueSync but with resume)
        const toolScopeKey = this.createToolScopeKey(initialMapKey);
        let session!: SessionManager;
        const resolveSessionMapKey = () => this.findMapKeyForSession(session, initialMapKey);
        try {
          session = this.createSessionManager({
            chatJid,
            cwd: this.cwd,
            onEvent: (event) => {
              this.handleEventPerChat(session, event, toolScopeKey);
            },
            onCrash: (info) => {
              const mapKey = resolveSessionMapKey() ?? initialMapKey;
              this.handlePerChatCrash(mapKey, chatJid, info, session);
            },
            notifyUser: (msg) => {
              this.handleCrashNotify(msg, chatJid);
            },
            eventToolScopeKey: toolScopeKey,
          });
        } catch (err) {
          // F-STICKY-ACTOR (QR-247 hardening): per-chat socket wiring now runs inside
          // createSessionManager, so a socket/config failure here must not abort the
          // whole startup proactive-resume loop — skip this chat, which then lazy-resumes
          // on its next inbound message (fail-safe).
          log.warn({ err, chatJid, mapKey: initialMapKey }, 'proactive resume: per-chat session creation failed — skipping (will lazy-resume on next message)');
          continue;
        }
        this.setOwnedPerChatSession(initialMapKey, session);
        const perChatQ = this.createOutboundQueue(chatJid, 'startup proactive per-chat resume');
        this.chatQueues.set(initialMapKey, perChatQ);

        // Wire operation tracker for this proactively-resumed per-chat session
        const startupTracker = this.createOperationTracker(session, () => {
          const currentMapKey = this.findMapKeyForSession(session, initialMapKey);
          return currentMapKey ? this.chatQueues.get(currentMapKey) : undefined;
        });
        if (startupTracker) this.operationTrackers.set(initialMapKey, startupTracker);

        // Attempt resume, then inject any messages the agent missed during
        // downtime and send a continuation turn so the agent picks up where it
        // left off without requiring the user to send "proceed".
        const checkpointUpdatedAt = full.updated_at
          ? Math.floor(new Date(full.updated_at + 'Z').getTime() / 1000)
          : undefined;
        const resumeOwnership = this.captureOwnedPerChatGeneration(initialMapKey, session);
        session.spawnSession(full.session_id).then(async () => {
          let contextLease: SystemTurnLeaseToken | null = null;
          let continuationLease: SystemTurnLeaseToken | null = null;
          const effectiveMapKey = await this.activateSpawnedOwnedPerChatSession(
            initialMapKey,
            session,
            resumeOwnership,
          );
          // Small delay to let the init event propagate (confirms resume succeeded)
          await sleep(MS_PER_SECOND);
          if (!session.getStatus().active) return; // resume failed, onResumeFailed handles it
          try {
            // Inject messages that arrived while the service was down.
            // Without this, the agent resumes with stale context — it has no
            // awareness of messages sent during the downtime window.
            if (checkpointUpdatedAt) {
              contextLease = this.markSystemTurn(
                session,
                effectiveMapKey,
                'proactive_resume_context',
                chatJid,
              );
              const injected = await this.injectMissedMessages(
                session,
                chatJid,
                checkpointUpdatedAt,
                () => this.requireSystemTurnProviderBoundary(contextLease!),
              );
              if (!injected) this.pendingSystemResults.cancel(contextLease);
              else {
                await this.pendingSystemResults.waitUntilEmpty(effectiveMapKey);
                await this.waitForSystemTurnQuarantine(effectiveMapKey);
                if (!session.getStatus().active) return;
              }
            }
            continuationLease = this.markSystemTurn(
              session,
              effectiveMapKey,
              'proactive_resume_continuation',
              chatJid,
            );
            await this.dispatchSystemTurn(
              session, '[System: session resumed after service restart — continue where you left off]', continuationLease!,
            );
            log.info({ chatJid }, 'sent continuation turn after proactive resume');
          } catch (err) {
            log.warn({ err, chatJid }, 'failed to send continuation turn after resume');
            await this.settleFailedSystemTurnDispatch(
              session,
              effectiveMapKey,
              continuationLease ?? contextLease,
              err,
            );
          }
        }).catch((err) => {
          log.warn({ err, chatJid, sessionId: full.session_id }, 'proactive resume failed — will retry on next message');
        });
      }
    }

    // Attempt to resume a prior active session.
    // Skipped for per_chat mode (all variants) — per_chat resume is handled above (proactive) or lazily.
    // Without this guard, per_chat + !sandboxPerChat would set this.session to a stale session
    // that no subsequent handleMessage call routes to (they use chatSessions maps instead).
    const prior = (this.sandboxPerChat || this.sessionScope === 'per_chat')
      ? null
      : getActiveSession(this.db, this.effectiveProvider);

    // AE2: Staleness check for shared/single mode — match per_chat's 60-minute threshold.
    let priorSession = prior;
    let priorResumeIdentity: PersistedResumeIdentity | null = null;

    if (priorSession) {
      const expectedScope = this.shared ? 'shared' : 'singleton';
      const checkpoint = this.durability && priorSession.session_id
        ? this.durability.getLatestCompletedCheckpointForSession(priorSession.session_id)
        : undefined;
      priorResumeIdentity = checkpoint
        ? this.checkpointResumeIdentity(checkpoint, expectedScope)
        : null;
      if (!priorResumeIdentity) {
        const admissionReason = this.completedDeliveryIdentityAdmissionReason(checkpoint, expectedScope);
        this.recordProactiveResumeIdentityReject(
          checkpoint?.conversation_key ?? null,
          admissionReason === 'scope_mismatch'
            ? 'scope_mismatch'
            : 'legacy_or_ambiguous_identity',
        );
        if (this.durability && typeof this.durability.quarantineCompletedDeliveryIdentityAgentSession === 'function') {
          this.durability.quarantineCompletedDeliveryIdentityAgentSession({
            agentSessionRowId: priorSession.id,
            providerSessionId: priorSession.session_id!,
            provider: this.effectiveProvider,
            workspaceKey: priorSession.workspace_key ?? null,
            reason: admissionReason,
          });
        }
        priorSession = null;
      } else if (checkpoint?.updated_at) {
        const ageMs = Date.now() - new Date(checkpoint.updated_at + 'Z').getTime();
        if (ageMs > MS_PER_HOUR) {
          log.info({ chatJid: priorResumeIdentity.deliveryJid, ageMinutes: Math.round(ageMs / 60_000) },
            'skipping shared/single resume — session too stale');
          if (priorSession.workspace_key === null) {
            log.warn({
              rowId: priorSession.id,
              conversationKey: checkpoint.conversation_key,
            }, 'cannot retire stale shared/single resume without exact workspace identity');
          } else {
            this.durability!.retireExactSessionLifecycle({
              agentSessionRowId: priorSession.id,
              providerSessionId: priorSession.session_id!,
              provider: this.effectiveProvider,
              workspaceKey: priorSession.workspace_key,
              conversationKey: checkpoint.conversation_key,
            });
          }
          priorSession = null;
          priorResumeIdentity = null;
        }
      } else {
        // No checkpoint or updated_at absent — cannot verify freshness, skip resume
        log.info(
          { chatJid: priorResumeIdentity.deliveryJid },
          'skipping shared/single resume — no checkpoint or no updated_at',
        );
        priorSession = null;
        priorResumeIdentity = null;
      }
    }

    if (priorSession?.session_id && priorResumeIdentity) {
      // Capture narrowed values before closures — TypeScript does not propagate
      // if-guard narrowing into lambdas, so priorSession.chat_jid inside the closure
      // would remain typed as string | null even though we've checked it.
      const resumeChatJid = priorResumeIdentity.deliveryJid;
      const resumeSessionId: string = priorSession.session_id;
      const isGroupChat = isGroupJid(resumeChatJid);

      // ── C1/C2/I2: Hoist group check before spawn/queue creation ──────────
      if (isGroupChat && !this.shared) {
        // Single mode + group: session can't serve DMs, skip entirely (Bug I2 fix —
        // previously spawned a full subprocess then immediately killed it).
        log.info({ chatJid: resumeChatJid, sessionId: resumeSessionId }, 'skipping single-mode resume — group chat');
      } else {
        log.info({ sessionId: resumeSessionId, chatJid: resumeChatJid }, 'resuming prior session');
        this.activeChatJid = resumeChatJid;
        let resumedSession!: SessionManager;
        resumedSession = this.createSessionManager({
          chatJid: resumeChatJid,
          cwd: this.cwd,
          trackSingletonMcpSession: true,
          onEvent: (event) => this.handleEvent(resumedSession, event),
          onResumeFailed: () => this.handleResumeFailed(resumeChatJid),
          onCrash: (info) => {
            this.recordCrash(GLOBAL_CRASH_SCOPE_KEY);
            const turnWasInFlight = this.currentRuntimeTurnContext !== null;
            const queue = this.getActiveQueue();
            this.finalizeRuntimeCrash(this.currentRuntimeTurnContext, queue, this.session);
            this.cleanupSharedCrashTurnState();
            this.emitCrashHealReport(resumeChatJid, info, turnWasInFlight);
          },
          notifyUser: (msg) => this.handleCrashNotify(msg),
        });
        this.session = resumedSession;

        // Bug C2 fix: Do NOT create a group-keyed queue for shared mode — it would
        // remain as a stale entry in outboundQueues since no startup message is sent.
        // The queue is created on-demand via ensureOutboundQueue when a real message arrives.
        if (!isGroupChat) {
          if (this.shared) {
            const q = this.createOutboundQueue(resumeChatJid, 'startup resume shared');
            this.outboundQueues.set(canonicalizeChatJid(resumeChatJid, this.db), q);
          } else {
            const q = this.createOutboundQueue(resumeChatJid, 'startup resume single');
            this.queue = q;
          }
        }

        // Wire operation tracker for resumed single/shared session
        this.operationTracker = this.createOperationTracker(this.session, () => this.getActiveQueue());

        // Bug C1 fix: Wrap spawnSession in try/catch — every other call site does this.
        // If spawn fails (bad session ID, corrupted state, claude-cli not found), clean up
        // gracefully instead of crashing the runtime.
        try {
          await this.session.spawnSession(resumeSessionId, priorSession.id);
        } catch (err) {
          log.warn({ err, sessionId: resumeSessionId, chatJid: resumeChatJid }, 'spawnSession failed during resume — cleaning up');
          this.operationTracker?.shutdown();
          this.operationTracker = null;
          this.session = null;
          this.activeChatJid = null;
          if (this.shared) {
            this.outboundQueues.delete(canonicalizeChatJid(resumeChatJid, this.db));
          } else {
            this.queue = null;
          }
          // Fall through — runtime continues without a resumed session
        }

        // Defer notification until after WA connects (sending here causes a fatal crash)
        if (this.session) {
          if (isGroupChat) {
            // Shared mode + group: session stays alive (serves DMs too), just no unsolicited group message.
            log.info({ chatJid: resumeChatJid }, 'suppressing startup message — shared-mode group chat');
          } else {
            const age = formatAge(priorSession.started_at);
            this.pendingStartupEvent = {
              kind: 'resume',
              chatJid: resumeChatJid,
              text: `_Resuming session_ from *${age}*. Send a message to continue, or /new to start fresh.`,
            };
          }
        }
      }
    }

    // Register the runtime's inline MCP tools (emit_heal_result + restart_self)
    // with their exact activation gates; the tool declarations live in
    // runtime-tool-registrations.ts. The emit_heal_result handler receives a
    // narrow control-report port rather than `this`, since that slot
    // (activeControlReportId / controlProtocolCompletedReportId) is shared with
    // the control-terminal path.
    const serviceRestarter = this.serviceRestarter;
    registerRuntimeInlineTools(this.registry, {
      // `sandbox` is a SandboxPolicy|undefined used only via `!sandbox` in the
      // original guards; coerce to the boolean the guard actually consumed.
      sandbox: !!this.sandbox,
      sandboxPerChat: this.sandboxPerChat,
      emitHealResult: {
        getActiveControlReportId: () => this.activeControlReportId,
        isControlReportCompleted: (reportId) => this.controlProtocolCompletedReportId === reportId,
        markControlReportCompleted: (reportId) => { this.controlProtocolCompletedReportId = reportId; },
        getControlQueue: () => this.getControlQueue(),
        getDurability: () => this.durability,
        messenger: this.messenger,
        db: this.db,
        controlPeers: config.controlPeers,
        adminPhones: config.adminPhones,
        resolveConfiguredAdminJid: (identity) => resolveConfiguredAdminJid(config.transport, identity),
      },
      restartSelf: serviceRestarter ? {
        instanceName: this.instanceName,
        dataRoot: config.dataRoot,
        resolveChatJid: () => this.currentTurnChatJid ?? this.activeChatJid ?? undefined,
        sendAck: async (chatJid, text) => {
          await sendTracked(this.messenger, chatJid, text, this.durability ?? undefined, { replayPolicy: 'unsafe' });
        },
        serviceManager: serviceRestarter,
        trigger: triggerSelfRestart,
        // QR-047 + QR-143: admin gate hoisted to assertRestartSelfAdmin — gates on
        // authenticated transport BEFORE the phone match, so a spoofed @sms actor
        // that collapses to admin digits cannot induce a restart.
        assertAdmin: (session) => assertRestartSelfAdmin(session, { db: this.db, adminPhones: config.adminPhones }),
      } : null,
    });

    // Heal the claude file-store credential from the keychain BEFORE the first
    // turn can run, so a keychain-only refresh (native login) can't false-arm
    // the provider fallback on turn 1 (the recovery probe path heals for the
    // mid-run case). No-op off-darwin / when CLAUDE_CONFIG_DIR is unset / when
    // the file store is already current. Fail-open by contract.
    if (this.agentProvider === 'claude-cli') {
      ensureClaudeFileStoreCredential();
    }
    this.fallback.schedulePrimaryModelUsabilityProbe('startup');
    this.fallback.scheduleNextPeriodicUsabilityProbe();
    this.startHealthStatsTimer();
    this.workspaceSweeper.start();
    this.startQueueSweepTimer();
    this.startSessionSweepTimer();
    this.startZombieSessionSweepTimer();
    this.handoffDistill.start();

    // Restore any pending polls from the previous process so votes-in-flight
    // and active AskUserQuestion polls survive a restart. Errors logged inside;
    // never throws.
    await this.rehydratePendingPolls();
    await this.consumeQueuedPollDecisions();

    log.info({
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
      sandboxed: this.sandbox !== undefined,
    }, 'AgentRuntime started');
  }

  /**
   * Dispatch a scheduled `agent_job` as a real agent turn. Wired into the
   * TriggerPoller (main.ts) so a schedule.cron/at_time fire whose linked bead
   * is an agent_job RUNS the prompt instead of posting a bare "cron tick". The
   * synthetic turn flows through the normal handleMessage path, so it works in
   * shared / per_chat / single modes alike. Returns synchronously once the turn
   * is ACCEPTED onto the turn chain — the turn itself runs async (we never block
   * the poller tick for the whole turn). Throwing here is reported by the poller
   * as a fail-CLOSED dispatch (the schedule does not silently no-op).
   */
  dispatchAgentJob(ctx: {
    beadId: number; triggerId: number; occurrenceId: number;
    prompt: string; title: string; reportChatJid: string;
  }): { dispatched: boolean; detail?: string } {
    try {
      this.db.assertWritableCompatibility();
      // #2144: the acknowledgement below is what the poller records as an ok
      // trigger run (and what expires a one-shot schedule), so the occurrence
      // must have a DURABLE owner before we return it. Journaling the
      // synthetic inbound first means a crash between ack and turn start
      // leaves a journaled 'processing' row that the W2 stuck-inbound
      // reconciler surfaces — never a silent loss behind successful history.
      // Per the agent_turn_admission_rejected disposition, a journaled but
      // undispatched turn is surfaced for owner resend, not auto-replayed.
      if (!this.durability) {
        return {
          dispatched: false,
          detail: 'durability engine not set — refusing unowned scheduled dispatch (#2144)',
        };
      }
      const now = Math.floor(Date.now() / 1000);
      // #2566 slice 3 — the occurrence id suffix makes the journaled inbound
      // deterministically joinable to its trigger_occurrences row (the bare
      // trigger-id + wall-clock prefix is kept for existing consumers).
      const messageId = `agentjob-${ctx.triggerId}-${now}-occ${ctx.occurrenceId}`;
      const inboundSeq = this.durability.journalInbound(
        messageId,
        toConversationKey(ctx.reportChatJid),
        ctx.reportChatJid,
        'agent',
        now,
      );
      // FLOS Stage 1 (plan §3): the occurrence is durably owned from here —
      // L-SCH `admitted`, then `dispatched` once it is handed to the turn
      // chain below. emit() is phase-gated (dark default) and never throws.
      runtimeLifecycleEmitter().emit({
        lane: 'L-SCH',
        work_id: messageId,
        phase: 'admitted',
        correlation: { trigger_occurrence_id: String(ctx.occurrenceId), inbound_seq: inboundSeq },
        attrs: { trigger_id: ctx.triggerId, bead_id: ctx.beadId },
      });
      const synthetic: IncomingMessage = {
        messageId,
        chatJid: ctx.reportChatJid,
        senderJid: config.memory.adminJid,
        senderName: ctx.title ? `Scheduled job: ${ctx.title}`.slice(0, 80) : 'Scheduled job',
        content: isolateScheduledAgentJobPrompt(ctx.prompt),
        contentText: null,
        contentType: 'text',
        isFromMe: false,
        isGroup: ctx.reportChatJid.endsWith('@g.us'),
        mentionedJids: [],
        timestamp: now,
        quotedMessageId: null,
        isResponseWorthy: true,
        inboundSeq,
        isSyntheticJob: true,
      };
      // Fire-and-forget onto the turn chain; failures inside the turn are logged
      // by handleMessage's own turn-chain error handler.
      void this.handleMessage(synthetic).catch((err: unknown) => {
        log.error(
          { err, triggerId: ctx.triggerId, beadId: ctx.beadId },
          'agent job turn failed after dispatch',
        );
      });
      runtimeLifecycleEmitter().emit({
        lane: 'L-SCH',
        work_id: messageId,
        phase: 'dispatched',
        correlation: { trigger_occurrence_id: String(ctx.occurrenceId), inbound_seq: inboundSeq },
        attrs: { trigger_id: ctx.triggerId, bead_id: ctx.beadId },
      });
      return {
        dispatched: true,
        detail: `enqueued turn for bead ${ctx.beadId} (inbound seq ${inboundSeq})`,
      };
    } catch (err) {
      return { dispatched: false, detail: errorMessage(err) };
    }
  }

  handleMessage(msg: IncomingMessage): Promise<void> {
    try {
      this.db.assertWritableCompatibility();
    } catch (err) {
      return Promise.reject(err);
    }
    if (this.shutdownRequested) {
      return Promise.reject(new Error('Agent runtime is shutting down; new turns are not accepted'));
    }
    const initialClassification = msg.content === null
      ? null
      : classifyInput(msg.content, { routingAliases: config.nlRouting });
    const tracksRouteRecycle = (
      initialClassification?.type === 'local'
      && (
        initialClassification.command === 'model'
        || initialClassification.command === 'reset'
      )
    );
    const processing = this.handleMessageInner(msg, tracksRouteRecycle);
    this.activeMessageHandlers.add(processing);
    if (tracksRouteRecycle) {
      const scopeKey = this.sessionScope === 'per_chat'
        ? this.resolvePerChatMapKey(msg.chatJid)
        : GLOBAL_TOOL_SCOPE_KEY;
      this.routeRecycleLifecycle.trackRouteCommand(processing, scopeKey);
    }
    void processing.finally(() => {
      this.activeMessageHandlers.delete(processing);
      if (tracksRouteRecycle) {
        this.routeRecycleLifecycle.untrackRouteCommand(processing);
      }
    }).catch((err) => log.warn({ err }, 'runtime: message handler cleanup rejected'));
    return processing;
  }

  private async handleMessageInner(
    msg: IncomingMessage,
    awaitQueuedRouteCommand = false,
  ): Promise<void> {
    // Process media messages (transcription, text extraction, etc.) before routing.
    // For text messages this is a no-op. For all other types we attempt to convert
    // to a plain-text representation suitable for the stream-json agent protocol.
    if (msg.contentType !== 'text') {
      try {
        msg.content = await prepareContentForAgent(msg, this.db, msg.messageId);
      } catch (err) {
        log.warn(
          { err, contentType: msg.contentType, messageId: msg.messageId },
          'media processing failed — using fallback label',
        );
        msg.content = `[${msg.contentType} message — processing failed]`;
      }
    }

    const content = msg.content;
    if (content === null || content.trim() === '') {
      log.warn(
        { messageId: msg.messageId, contentType: msg.contentType },
        'empty content after media processing — skipping',
      );
      // Mark inbound event as skipped so it doesn't stay stuck in 'processing'
      if (this.durability && msg.inboundSeq !== undefined) {
        this.durability.markInboundSkipped(msg.inboundSeq, 'empty_content');
      }
      return;
    }

    // Substrate slice 1: inline imperative extractor.
    // Gate on sender identity (admin-only), not deliveryJid. For any admin-authored
    // message containing an explicit imperative (remind/schedule/watch/track/...),
    // persist a proposed task bead immediately so the intent survives even if the
    // agent turn fails downstream. The bead lands as status='proposed' so a
    // drowsy or misfired match doesn't silently commit real work to the task list.
    try {
      // senderPhone stays on the PLAIN resolver — it feeds the bead's ownerJid
      // attribution (display-side, below), which is transport-agnostic.
      const senderPhone = resolvePhoneFromJid(msg.senderJid, this.db);
      // QR-143 (B4): the admin GRANT (auto-creating a proposed bead) routes
      // through the grant primitive, which returns null for a spoofable
      // <admin-digits>@sms transport — so it cannot induce an admin-attributed
      // proposal. Skip synthetic agent-job turns (already durable agent_job
      // beads, not ad-hoc imperatives to capture).
      const grantPhone = resolvePhoneFromJidForGrant(msg.senderJid, this.db);
      if (grantPhone !== null && isAdminPhone(grantPhone, config.adminPhones) && !msg.isSyntheticJob) {
        const hit = matchImperative(content);
        if (hit) {
          const target = extractImperativeTarget(content);
          const title = target && target.length > 0 ? target.slice(0, 200) : content.slice(0, 120);
          // review_by_at records a review horizon on the proposal. It is stored on
          // the bead and surfaced via get_bead/list_beads for manual/operator
          // review. #2384 added an automatic terminal sweep: proposals still
          // 'proposed' past review_by_at + a grace window (default 24h) are
          // transitioned to 'cancelled' by the poller's expiry step with actor
          // 'system:overdue-sweep'. Manual approve_proposal/reject_proposal
          // remain available and win any race against the sweep.
          // Default is config.memory.sweep.reviewByDays * 86400 seconds.
          const reviewByAt = Math.floor(Date.now() / 1000) + config.memory.sweep.reviewByDays * 86400;
          createBead(this.db.raw, {
            kind: 'task',
            title,
            body: content,
            ownerJid: config.memory.adminJid || (senderPhone ?? msg.senderJid),
            chatJid: msg.chatJid,
            sourceMessagePk: null,
            status: 'proposed',
            confidence: 0.7,
            proposalReason: `inline imperative: ${hit.verb}`,
            reviewByAt,
            actor: 'inline',
          });
          // A successful createBead proves database writes recovered after a
          // prior unrecoverable failure (#2406).  Idempotent clear — no-op if
          // no incident exists.
          clearAlertSourceChecked(this.instanceName, 'substrate-inline-hook');
          log.info(
            { verb: hit.verb, messageId: msg.messageId, chatJid: msg.chatJid, reviewByAt },
            'inline imperative persisted as proposed bead',
          );
        }
      }
    } catch (err) {
      // Classify DB errors: unrecoverable ones (disk full, readonly, corrupt)
      // indicate infrastructure failure — surface them to the operator by
      // emitting alert and marking the inbound failed. Everything else
      // (extractor bugs, constraint errors on malformed extraction output)
      // is swallowed with a warn so a substrate bug doesn't drop the user's
      // message. Per spec §8.4 / INV-7: observability is a product surface.
      const msgText = errorMessage(err);
      const code = (err as { code?: unknown })?.code;
      const codeStr = typeof code === 'string' ? code : '';
      const isUnrecoverable =
        /SQLITE_(FULL|READONLY|CORRUPT|IOERR|CANTOPEN|NOTADB)/i.test(msgText) ||
        /SQLITE_(FULL|READONLY|CORRUPT|IOERR|CANTOPEN|NOTADB)/i.test(codeStr);
      if (isUnrecoverable) {
        log.error(
          { err, messageId: msg.messageId, code: codeStr || 'unknown' },
          'inline extractor hook hit unrecoverable DB error — surfacing to operator',
        );
        emitAlertChecked(
          this.instanceName,
          'substrate-inline-hook',
          `Unrecoverable DB error in inline extractor: ${msgText}`,
          `messageId=${msg.messageId} chatJid=${msg.chatJid} code=${codeStr || 'unknown'}`,
        );
        if (this.runtimeTurnCoordinator.finalizeMessageProcessingFailure(msg.inboundSeq)) {
          // Immutable admitted turns terminalize through the coordinator.
        } else if (this.durability && msg.inboundSeq !== undefined) {
          this.markRuntimeFaultContinuityCandidate(msg.inboundSeq);
          this.replyGuarantee?.disarm(msg.inboundSeq);
          this.durability.markInboundFailed(msg.inboundSeq, classifyErrorForInbound(err));
        }
        // Propagate so the outer turn-chain handler notifies the user and
        // the fleet supervisor sees the PID enter recovery rather than
        // silently continuing past disk-full conditions.
        throw err;
      }
      log.warn({ err, messageId: msg.messageId }, 'inline extractor hook failed (continuing)');
    }

    const queuedWork = this.turnChain
      .then(() => this._handleMessageInner(msg))
      .catch((err) => {
        log.error(
          { err, messageId: msg.messageId, chatJid: msg.chatJid },
          'unhandled error in message processing',
        );
        // Admitted turns have one terminal owner; pre-admission failures retain
        // the legacy inbound owner so they cannot stay stuck in processing.
        if (this.runtimeTurnCoordinator.finalizeMessageProcessingFailure(msg.inboundSeq)) {
          // Coordinator owns terminal persistence and reply-guarantee disarm.
        } else if (this.durability && msg.inboundSeq !== undefined) {
          this.markRuntimeFaultContinuityCandidate(msg.inboundSeq);
          this.replyGuarantee?.disarm(msg.inboundSeq);
          this.durability.markInboundFailed(msg.inboundSeq, classifyErrorForInbound(err));
        }
        // Notify user of failure
        this.sendDirect(msg.chatJid, 'Something went wrong processing that message. Try again?');
      });
    const recycleScopeKey = this.sessionScope === 'per_chat'
      ? resolveAgentTurnMapKey(
          this.resolvePerChatMapKey(msg.chatJid),
          msg.isSyntheticJob === true && !this.sandboxPerChat,
        )
      : GLOBAL_TOOL_SCOPE_KEY;
    this.routeRecycleLifecycle.trackPublication(queuedWork, recycleScopeKey);
    this.turnChain = queuedWork;
    if (awaitQueuedRouteCommand) await queuedWork;
  }

  private async _handleMessageInner(msg: IncomingMessage): Promise<void> {
    let content = msg.content;
    const chatJid = msg.chatJid;
    // Mirrors ingest's journal key exactly, including mapped-LID DMs whose
    // durable conversation key is the resolved phone while delivery stays @lid.
    const journalConversationKey = canonicalConversationKey(chatJid, this.db);
    const perChatMapKey = this.sessionScope === 'per_chat'
      ? resolveAgentTurnMapKey(
          this.resolvePerChatMapKey(chatJid),
          msg.isSyntheticJob === true && !this.sandboxPerChat,
        )
      : undefined;

    // Substrate slice 1: propagate sender identity to every MCP session so
    // admin-gated substrate tools can distinguish the caller from the target
    // chat. In groups, msg.chatJid IS the group JID; without this propagation
    // admin gating would compare against the group JID and always reject.
    //
    // #2976 direction (ii): the global socket NEVER receives an actor
    // broadcast. single/shared identity is resolved read-time per request
    // from the executing-turn register (resolveExecutingGlobalActor), so no
    // stored actor can go stale and a missed cleanup denies instead of
    // allowing. Per-chat sockets (sandboxPerChat=true, below) keep their
    // chat-scoped update; every non-sandbox per_chat subprocess uses its own
    // actor-bound socket and the global socket stays actor-less for the
    // whole mode so any accidental fallback fails closed.
    const recycleScopeKey = this.sessionScope === 'per_chat'
      ? perChatMapKey!
      : GLOBAL_TOOL_SCOPE_KEY;
    if (this.routeRecycleLifecycle.isPendingOrRunning(recycleScopeKey)) {
      await consumePendingRecycleIfIdleForPort(this.modelPinHost, recycleScopeKey);
    }
    if (this.sandboxPerChat) {
      await this.ensureSessionAndQueue(chatJid, msg.senderJid);
      const key = perChatMapKey ?? this.resolvePerChatMapKey(chatJid);
      const res = this.workspaceResources.get(key);
      res?.socketServer?.updateActorJid(msg.senderJid);
      // Relocate media files from global temp dir into user's workspace
      // so the agent can read them within its sandbox-allowed paths.
      if (content) {
        const { workspacePath } = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);
        content = relocateMediaToWorkspace(content, workspacePath);
        msg.content = content;
      }
    } else if (this.sessionScope === 'per_chat') {
      this.ensureSessionAndQueueSync(chatJid, perChatMapKey!, msg.senderJid);
    } else {
      this.ensureSessionAndQueueSync(chatJid, undefined, msg.senderJid);
    }
    const classified = classifyInput(content as string, { routingAliases: config.nlRouting });
    if (tryHandleBareKeep(this.modelPinHost, classified, chatJid, msg)) return;

    // Set only by /model default (R8): the handler clears the route pref
    // locally and then falls through to forward the raw command so the agent
    // CLI's own /model default reset still runs. Null for every other command.
    let forwardAfterLocalCommand: string | null = null;

    if (classified.type === 'local') {
      const spec = getCommandSpec(classified.command);
      // Gate enforcement by gate class. Both gated classes share the same
      // authenticated-admin core: isWhatsAppAuthenticatedJid FIRST (QR-143 —
      // a non-authenticated transport like @sms resolves to the SAME bare
      // phone as the WhatsApp admin but its sender-ID is spoofable, so the
      // transport check must precede the phone match), THEN admin-phone.
      //  - 'admin'              → authenticated admin, any venue (B21-A F3, base
      //                           parity: the deleted pre-registry gates were
      //                           phone-only, so admins could run these from
      //                           groups; isAdminMessage's DM-only clause is
      //                           deliberately NOT used here): /sessions,
      //                           /kill-session.
      //  - 'admin-shared-scope' → /new: admin required ONLY where the reset hits SHARED
      //                           session state (single/shared mode, or a per_chat GROUP —
      //                           WG-5; this.session is one session across ALL chats there,
      //                           :760); a per_chat 1:1 DM reset touches only the sender's
      //                           own conversation → ungated. Group-permitting (an admin may
      //                           /new in a group) AND @sms-closing (authenticated-JID check).
      //                           With EMPTY adminPhones /new stays ungated too (B21-A F2,
      //                           base parity): a no-admin instance has no other reset path,
      //                           so deny-everyone would be a total /new lockout, not a
      //                           security posture. The empty-set exemption is THIS gate
      //                           only — plain 'admin' commands were admin-gated on base
      //                           and stay denied when no admin is configured.
      // Lazy so gate:'none' commands never pay the resolvePhoneFromJid DB read.
      // B4: the grant primitive gates authenticated-transport-FIRST then resolves;
      // a non-authenticated (@sms) sender yields null and is denied. Behaviour is
      // identical to the prior isWhatsAppAuthenticatedJid && isAdminPhone(...) form
      // (isAdminPhone(null) === false).
      const isAuthenticatedAdmin = (): boolean => {
        const phone = resolvePhoneFromJidForGrant(msg.senderJid, this.db);
        return phone !== null && isAdminPhone(phone, config.adminPhones);
      };
      const denied =
        spec.gate === 'admin'
          ? !isAuthenticatedAdmin()
          : spec.gate === 'admin-shared-scope'
            ? (this.sessionScope !== 'per_chat' || msg.isGroup) &&
              config.adminPhones.size > 0 &&
              !isAuthenticatedAdmin()
            : false;
      if (denied) {
        // NFR-3: unsampled — never silent (V19). ids only, no content (U6).
        // @check CHK-067 // @traces REQ-012.AC-06
        log.warn(
          { command: spec.name, senderJid: msg.senderJid, outcome: 'denied', errorClass: 'not-authorized' },
          'command denied: sender not authorized',
        );
        // B21-A F4a: denial must be user-visible, never a silent drop — same
        // queue-routed send path the other local-command replies use.
        this.sendDirect(chatJid, '_Not authorized._');
        // B21-A F1: this return bypasses the R14 post-switch completion below,
        // so the denied inbound must be finalized HERE — same shape as the
        // 'empty_content' skip in handleMessageInner — or the row strands in
        // 'processing' until the stuck-inbound sweep falsely reclaims an authz
        // denial as a processing FAILURE (stale_reclaim).
        if (this.durability && msg.inboundSeq !== undefined) {
          this.durability.markInboundSkipped(msg.inboundSeq, 'not_authorized');
        }
        return;
      }
      try {
        switch (classified.command) {
          case 'new':
            // Extracted leaf collaborator: runtime-new-command.ts owns the control flow.
            await runNewCommand<SessionManager, RuntimeTurnQueueTeardown>({
              chatJid,
              sessionScope: this.sessionScope,
              shared: this.shared,
              sandboxPerChat: this.sandboxPerChat,
              scopeKey: perChatMapKey ?? GLOBAL_TOOL_SCOPE_KEY,
              perChatMapKey: perChatMapKey ?? null,
              isTurnInFlight: () => this.isTurnInFlight(perChatMapKey ?? GLOBAL_TOOL_SCOPE_KEY),
              isOutboundQueuePoisoned: () => this.runtimeTurnCoordinator
                .isOutboundQueuePoisoned(perChatMapKey ?? GLOBAL_TOOL_SCOPE_KEY),
              getPerChatSession: () => this.chatSessions.get(perChatMapKey!),
              abortPerChatQueue: () => this.chatQueues.get(perChatMapKey!)
                ?.abortTurn({ preserveEvidence: true }),
              disposePerChatSession: async (session, teardown) => {
                await session.shutdown(false);
                await this.runtimeTurnCoordinator.retirePerChatTurnQueueAfterKill(teardown);
                this.deleteOwnedPerChatSession(perChatMapKey!, session);
                this.chatQueues.delete(perChatMapKey!);
                this.cleanupPerChatState(perChatMapKey!);
              },
              resetOwnedPerChatSession: (session) => this.resetOwnedPerChatSession(perChatMapKey!, chatJid, session),
              getSingleSession: () => this.session,
              abortActiveQueue: () => this.getGlobalInterruptQueue()
                ?.abortTurn({ preserveEvidence: true }),
              terminalizeTurnForInterrupt: () => this.sessionScope === 'per_chat'
                ? this.runtimeTurnCoordinator.terminalizePerChatTurnQueueForKill(perChatMapKey!)
                : this.runtimeTurnCoordinator.terminalizeGlobalTurnForReset(),
              retireTurnQueueAfterInterrupt: (teardown) => this.sessionScope === 'per_chat'
                ? this.runtimeTurnCoordinator.retirePerChatTurnQueueAfterKill(teardown)
                : this.runtimeTurnCoordinator.retireGlobalTurnQueueAfterReset(teardown),
              shutdownOperationTracker: () => { this.operationTracker?.shutdown(); this.operationTracker = null; },
              cleanupGlobalAutoCompactState: () => this.cleanupGlobalAutoCompactState(),
              shutdownSingleSession: (session) => session.shutdown(false),
              clearSingleScopeRefs: () => {
                this.session = null; this.queue = null; this.activeChatJid = null;
                this.currentInboundSeq = undefined; this.currentTurnChatJid = null;
              },
              abortChatQueue: () => this.getQueueForChat(chatJid)?.abortTurn(),
              replaceOutboundQueue: () => {
                if (this.shared) {
                  const queue = this.createOutboundQueue(chatJid, '/new shared replacement');
                  this.outboundQueues.set(chatJid, queue);
                } else {
                  this.queue = this.createOutboundQueue(chatJid, '/new single replacement');
                }
              },
              resetSingleSession: async (session) => {
                await this.waitForRejectedTerminalTeardown(session);
                await session.handleNew();
                this.rejectedTerminalTeardowns.delete(session);
              },
              clearHandoffLatches: () => {
                const resetKey = toConversationKey(chatJid);
                clearStandbyNotice(this.db, resetKey);
                deleteHandoffArtifact(this.db, resetKey);
              },
              clearTurnHadVisibleOutput: () => { this.turnHadVisibleOutput = false; },
              sendDirect: (text) => this.sendDirect(chatJid, text),
            });
            break;

          case 'status': {
            // Look up session from per-chat maps (not the shared field) to avoid race.
            const sessionForStatus = this.sessionScope === 'per_chat'
              ? this.chatSessions.get(perChatMapKey!)
              : this.session;
            const status = sessionForStatus?.getStatus();
            let text: string;
            if (status?.active) {
              const sessionShort = status.sessionId
                ? status.sessionId.slice(0, 8) + '...'
                : 'pending';
              const started = status.startedAt ? formatAge(status.startedAt) : 'unknown';
              const lastActivity = status.lastMessageAt
                ? formatAge(status.lastMessageAt)
                : 'none';
              // B26 owner ruling: /status must show the model explicitly, the
              // session's token counts, and the session limit. Model follows
              // the SAME honesty rule as /model status (describeRouteModel:
              // config-derived only, '(configured)' label — the served weight
              // is unobservable). Defensive typeof mirrors the getProviderId
              // call site at maybeStartAutoCompact.
              const statusModelRef =
                typeof sessionForStatus?.getModelRef === 'function'
                  ? sessionForStatus.getModelRef()
                  : undefined;
              const statusProvider =
                typeof sessionForStatus?.getProviderId === 'function'
                  ? sessionForStatus.getProviderId()
                  : this.agentProvider;
              text =
                '*Session active*\n' +
                `PID: \`${status.pid ?? 'unknown'}\`\n` +
                `Session: \`${sessionShort}\`\n` +
                `Model: ${this.routing.describeRouteModel(statusModelRef, statusProvider)}\n` +
                `Started: ${started}\n` +
                `Messages: ${status.messageCount}\n` +
                `Last activity: ${lastActivity}`;
              // B26: session token counts from the agent_sessions denorm
              // columns (same source as /sessions); omitted honestly when no
              // row exists yet. The context line pairs the since-last-compact
              // quantity maybeStartAutoCompact actually compares (input +
              // cache_read minus the last-compact baseline, :1273-76) with
              // the threshold the runtime actually applies (configured value,
              // else DEFAULT_AUTO_COMPACT_INPUT_TOKENS) — and renders ONLY
              // where auto-compact can genuinely run (claude-cli session,
              // non-shared scope): a budget meter for a limit that never
              // fires would be a lie. NO provider quota meters here — that is
              // the /account lane.
              const statusRowId = sessionForStatus?.getDbRowId() ?? null;
              const statusSnap = statusRowId !== null ? getSessionTokenSnapshot(this.db, statusRowId) : null;
              if (statusSnap) {
                text +=
                  `\nTokens: ${formatTokenCount(statusSnap.totalInputTokens)} in / ${formatTokenCount(statusSnap.totalOutputTokens)} out`;
                if (
                  statusProvider === 'claude-cli' &&
                  this.sessionScope !== 'shared' &&
                  this.autoCompactInputTokens !== undefined
                ) {
                  const contextUsed = Math.max(
                    0,
                    statusSnap.totalInputTokens + statusSnap.totalCacheReadTokens -
                      (statusSnap.lastCompactInputTokens + statusSnap.lastCompactCacheReadTokens),
                  );
                  text +=
                    `\nContext: ${formatTokenCount(contextUsed)} / ${formatTokenCount(this.autoCompactInputTokens)} before auto-compact`;
                }
              }
            } else {
              text = '_No active session._ Send a message to start one.';
            }
            this.sendDirect(chatJid, text);
            break;
          }

          case 'model': {
            // NL-first routing alias (owner-approved design). Records a
            // chat-scoped REASONING preference and renders route visibility —
            // never tool, mutation, or authority changes (capability-preserved
            // routing). Reachable only when agentOptions.nlRouting is true (the
            // classifier gates on the same flag). The handler body lives in
            // model-pin.ts over this runtime's ModelPinPort host.
            await handleModelCommand(this.modelPinHost, {
              chatJid,
              senderJid: msg.senderJid,
              args: classified.args,
              perChatMapKey,
            });
            break;
          }

          case 'reset': {
            // Idempotent by construction: clearing an absent row is a no-op and
            // the reply is identical, so a doubled /reset cannot spam or error.
            const { chatKey, senderKey } = preferenceKeys(this.db, chatJid, msg.senderJid);
            this.routing.clearRoutePreference(chatJid, chatKey, senderKey);
            // Task G: /reset undoes just as immediately as a pin applies —
            // recycle back toward the default route (idle now, or deferred to
            // the next message if a turn is in flight).
            await this.applyRouteChangeAndRecycle(chatJid, msg.senderJid, perChatMapKey);
            break;
          }

          case 'help': {
            // W1-T5: registry-derived render (help-render.ts), pure functions
            // of (registry, {nlRouting}) — no runtime reads (R3c-1.3). Detail
            // shares the flag: alias commands hide local semantics when off (D7).
            // D15: tiersConfigured is a config read, kept in the runtime layer
            // and passed IN — help-render.ts stays a pure function of its args.
            const helpOpts = { nlRouting: config.nlRouting === true, tiersConfigured: modelTiersConfigured(config.nlRoutingTiers) };
            const helpText = classified.args
              ? renderHelpDetail(classified.args, helpOpts)
              : renderHelp(helpOpts);
            this.sendDirect(chatJid, helpText);
            break;
          }

          case 'sessions': {
            runSessionsCommand(this.sessionLifecycleHost, chatJid);
            break;
          }

          case 'kill-session': {
            // MAIN-PARITY: unconditional delegated call — runKillSessionCommand
            // handles per_chat/global branching internally and sends its own
            // confirmation message through host.sendDirect.
            const killPromise = runKillSessionCommand(
              this.sessionLifecycleHost,
              chatJid,
              classified.args ?? '',
            );
            // FROZEN FEATURE (per_chat only): schedule socket release after kill
            // completes. MapKey derived from chatJid via the canonical resolver;
            // only applies in per_chat scope where resolvePerChatMapKey returns a
            // session-bound key.
            if (this.sessionScope === 'per_chat') {
              this.perChatMcpSocketManager.releaseAfter(
                this.resolvePerChatMapKey(chatJid),
                killPromise,
              );
            }
            await killPromise;
            // FROZEN FEATURE: preserve actor socket during cleanup — guarded on
            // session absence so that a failed terminalization (runKillSessionCommand
            // returns early preserving all owners) does not clear the per-chat
            // inbound seq queue that the Group A contract expects untouched.
            if (this.sessionScope === 'per_chat' && !this.chatSessions.has(this.resolvePerChatMapKey(chatJid))) {
              this.cleanupPerChatState(this.resolvePerChatMapKey(chatJid), { preserveActorSocket: true });
            }
            break;
          }

          default: {
            // B21-A F4b: a COMMAND_REGISTRY entry the classifier admits but
            // this switch has no case for must fall through LOUDLY as a
            // forwarded turn — the pre-registry behavior for unrecognized
            // commands — never be silently swallowed with a bogus
            // 'local_command_handled' completion. The forwarded turn owns
            // terminal inbound durability (same contract as the /model
            // default fall-through above). Unreachable today (the switch
            // covers every registry entry — `classified.command` is `never`
            // here); this guards future registry appends without handlers.
            log.warn(
              { command: classified.command, chatJid },
              'local command has no handler — forwarding to agent',
            );
            forwardAfterLocalCommand = content as string;
            break;
          }
        }
        // #2357 B1: handler succeeded AND a compound body is present → dispatch
        // the body as a follow-on agent turn under the same inbound. Reuses
        // forwardAfterLocalCommand (the existing fall-through-to-turn lever) so
        // the body enqueues through the normal turn path and the inbound completes
        // via the turn's durable terminal — NOT local_command_handled. The body is
        // a NEW first-turn admission (not #2334 active-turn steering).
        if (classified.type === 'local' && classified.compoundBody !== undefined) {
          forwardAfterLocalCommand = classified.compoundBody;
        }
      } catch (err) {
        if (err instanceof AgentCommandRuntimeError && err.code === 'turn_in_progress') {
          log.info({ command: classified.command, chatJid }, 'local command deferred while turn is active');
          this.sendDirect(chatJid, '_A response is still in progress. Send /new again after it finishes._');
        } else {
        // Contain local-command handler faults: without this, a throwing handler
        // escapes to the turnChain catch-all, whose unguarded markInboundFailed
        // would count a command-handler fault as an inbound processing failure.
        // The R14 completion below still runs and finalizes the row truthfully
        // (the inbound WAS a locally-handled command).
          log.error({ err, command: classified.command, chatJid }, 'local command handler failed');
          this.sendDirect(chatJid, 'Something went wrong processing that command. Try again?');
          // #2357 B1 AC4: command failed with a compound body present → retain it
          // truthfully (NOT dispatched). Running the body under failed-command
          // semantics would violate the issue's exactly-once rule. Complete the
          // inbound with a truthful reason and log sanitized (length only — never
          // the body text, per the telemetry AC). Return here to skip the
          // local_command_handled fall-through (which would double-complete).
          if (classified.type === 'local' && classified.compoundBody !== undefined) {
            if (msg.inboundSeq !== undefined) {
              this.durability?.completeInbound(msg.inboundSeq, 'command_failed_body_retained');
            }
            log.warn(
              { command: classified.command, chatJid, compoundBodyLength: classified.compoundBody.length },
              'local command failed with a compound body retained — body not dispatched',
            );
            return;
          }
        }
      }
      if (forwardAfterLocalCommand === null) {
        if (msg.inboundSeq !== undefined) {
          // Terminal durability completion for ANY locally-handled command (R14).
          // Local handling never reaches the turn path that completes the inbound
          // journal, so the row would stay 'processing' and restart recovery would
          // falsely mark it failed. This covers the routing aliases AND the base
          // local commands (/new /status /help /sessions /kill-session), closing
          // the pre-existing stuck-'processing' gap once for all of them instead
          // of a per-command name-list opt-in.
          this.durability?.completeInbound(msg.inboundSeq, 'local_command_handled');
        }
        return;
      }
      // R8 fall-through: /model default cleared the route pref above; forward
      // the raw command below so the CLI resets its own model. Durability is
      // completed by the forwarded turn's normal terminal path, not here.
    }

    // forwarded or message — enqueue as turn (shared) or send directly (non-shared).
    // forwardAfterLocalCommand is set only by the /model default fall-through (R8);
    // in every other path here classified is 'forwarded' | 'message'.
    const text = forwardAfterLocalCommand ?? (classified as { text: string }).text;

    if (this.shared) {
      // @check CHK-062 // @traces REQ-012.AC-01
      // @check CHK-063 // @traces REQ-012.AC-04
      // Track inbound contentType for voice reply (SP4)
      this.currentTurnInboundContentType = msg.contentType;
      this.currentTurnSourceMessageId = msg.messageId;
      this.currentTurnAssistantText = '';
      this.currentTurnAssistantItemText.clear();
      const runtimeContext = this.runtimeTurnCoordinator.createRuntimeTurnForDispatch({
        scope: 'shared',
        chatJid,
        text,
        inboundSeq: msg.inboundSeq,
        source: {
          sourceMessageId: msg.messageId,
          receivedAtUnixSeconds: receivedAtUnixSeconds(msg),
          conversationKey: journalConversationKey,
          senderJid: msg.senderJid,
          senderName: msg.senderName,
          contentType: msg.contentType,
          isGroup: msg.isGroup,
          ...(msg.isGroup ? { groupName: chatJid } : {}),
        },
        session: this.session!,
        toolScopeKey: GLOBAL_TOOL_SCOPE_KEY,
      });
      this.runtimeTurnCoordinator.enqueueSharedRuntimeTurn({
        sourceMessageId: msg.messageId,
        receivedAtUnixSeconds: receivedAtUnixSeconds(msg),
        conversationKey: journalConversationKey,
        chatJid,
        senderJid: msg.senderJid,
        senderName: msg.senderName ?? null,
        text,
        isGroup: msg.isGroup,
        groupName: msg.isGroup ? chatJid : undefined,
        contentType: msg.contentType,
        purpose: msg.isSyntheticJob === true ? 'scheduled-agent-job' : undefined,
        ...(runtimeContext ? { runtimeContext } : {}),
        inboundSeq: msg.inboundSeq,
      });
    } else if (this.sessionScope === 'per_chat') {
      const mapKey = perChatMapKey!;

      // Image coalescing: batch rapid image sends into a single turn.
      // For coalesced images, defer seq/state setup until flush time — only
      // the representative turn gets a seq entry, preventing desync.
      if (msg.contentType === 'image') {
        await this.coalesceImageTurn(mapKey, chatJid, text, msg);
      } else {
        // Flush any pending image buffer first (text message after images = done uploading).
        // Await to prevent concurrent turn injection with the text turn below.
        await this.flushImageCoalesce(mapKey);

        const session = this.chatSessions.get(mapKey);
        if (!session) throw new Error(`Per-chat runtime turn has no session for "${mapKey}"`);
        const runtimeContext = this.runtimeTurnCoordinator.createRuntimeTurnForDispatch({
          scope: 'per_chat',
          chatJid,
          text,
          inboundSeq: msg.inboundSeq,
          source: {
            sourceMessageId: msg.messageId,
            receivedAtUnixSeconds: receivedAtUnixSeconds(msg),
            conversationKey: journalConversationKey,
            senderJid: msg.senderJid,
            senderName: msg.senderName,
            contentType: msg.contentType,
            isGroup: msg.isGroup,
            ...(msg.isGroup ? { groupName: chatJid } : {}),
          },
          session,
          toolScopeKey: this.requireSessionToolScopeKey(session),
          mapKey,
        });

        this.enqueuePerChatRuntimeTurn(mapKey, {
          sourceMessageId: msg.messageId,
          receivedAtUnixSeconds: receivedAtUnixSeconds(msg),
          conversationKey: journalConversationKey,
          chatJid,
          senderJid: msg.senderJid,
          senderName: msg.senderName,
          text,
          isGroup: msg.isGroup,
          groupName: msg.isGroup ? chatJid : undefined,
          contentType: msg.contentType,
          purpose: msg.isSyntheticJob === true ? 'scheduled-agent-job' : undefined,
          ...(runtimeContext ? { runtimeContext } : {}),
          inboundSeq: msg.inboundSeq,
        });
      }
    } else {
      // single mode: store inbound seq on runtime + queue
      this.currentInboundSeq = msg.inboundSeq;
      this.queue?.setInboundSeq(msg.inboundSeq);
      this.replyGuarantee?.arm({ inboundSeq: msg.inboundSeq, chatJid });
      // Track inbound contentType for voice reply (SP4)
      this.currentTurnInboundContentType = msg.contentType;
      this.currentTurnSourceMessageId = msg.messageId;
      this.currentTurnAssistantText = '';
      this.turnHadSuppressedReplySatisfaction = false;
      this.currentTurnAssistantItemText.clear();
      // Arm the R1 first-line marker scan for this turn (flag-gated).
      this.currentTurnRouteMarkerHold = config.nlRouting ? '' : null;
      await this.sendTurnNonShared(chatJid, text, msg.senderJid, {
        sourceMessageId: msg.messageId,
        receivedAtUnixSeconds: receivedAtUnixSeconds(msg),
        conversationKey: journalConversationKey,
        senderJid: msg.senderJid,
        senderName: msg.senderName,
        contentType: msg.contentType,
        isGroup: msg.isGroup,
        ...(msg.isGroup ? { groupName: chatJid } : {}),
      }, msg.inboundSeq, msg.isSyntheticJob === true ? 'scheduled-agent-job' : undefined);
    }
  }

  private enqueuePerChatRuntimeTurn(mapKey: string, turn: QueuedTurn): boolean {
    return this.runtimeTurnCoordinator.enqueuePerChatRuntimeTurn(mapKey, turn);
  }

  private finalizeRejectedRuntimeTurn(turn: QueuedTurn, reason?: TurnRejectReason): void {
    this.runtimeTurnCoordinator.finalizeRejectedRuntimeTurn(turn, reason);
  }

  private finalizePerChatProcessorError(
    mapKey: string,
    turn: QueuedTurn,
    error: unknown,
  ): Promise<void> {
    return this.runtimeTurnCoordinator.finalizePerChatProcessorError(mapKey, turn, error);
  }

  private finalizeSharedProcessorError(turn: QueuedTurn, error: unknown): Promise<void> {
    return this.runtimeTurnCoordinator.finalizeSharedProcessorError(turn, error);
  }

  private finalizeRuntimeCrash(
    context: RuntimeTurnContext | null | undefined,
    queue: IOutboundQueue | null | undefined,
    session: SessionManager | null,
    mapKey?: string,
  ): void {
    if (context && this.runtimeTurnCoordinator.cancelRuntimeTurnContinuation(context)) {
      try {
        clearStandbyNotice(this.db, toConversationKey(context.identity.deliveryJid));
      } catch (err) {
        log.warn({ err, chatJid: context.identity.deliveryJid },
          'failed to clear crashed fallback handoff notice');
      }
    }
    // #3398: every call into this wrapper is a genuine provider death
    // mid-turn, so the queue may salvage an owed reply the crashed turn never
    // delivered (status-role; crash finalization semantics unchanged).
    this.runtimeTurnCoordinator.finalizeRuntimeCrash(context, queue, session, mapKey, {
      salvageOwedReply: true,
    });
  }

  private processPerChatTurn(scopeRef: PerChatRuntimeScopeRef, turn: QueuedTurn): Promise<void> {
    return this.runtimeTurnCoordinator.processPerChatTurn(scopeRef, turn);
  }

  private async processTurn(
    turn: QueuedTurn,
    // #2170: set only by the turn-recovery supervisor's scope-native replay
    // dispatch (never by the live global-queue processor): threads the job's
    // excludeJobId into admission (self-block exemption), re-checks the
    // dispatch target immediately before the provider send, and signals the
    // provider boundary for abort accounting.
    recoveryDispatch?: {
      excludeJobId: number;
      dispatchAllowed: () => boolean;
      onProviderBoundary: () => void;
    },
  ): Promise<void> {
    const { chatJid, senderJid, senderName, text, isGroup, purpose } = turn;

    // Clear post-turn gate — legitimate new user turn begins (shared mode)
    this.postTurnGate.delete(GLOBAL_TOOL_SCOPE_KEY);

    // Ensure outbound queue exists for this chat
    this.ensureOutboundQueue(chatJid);

    // The journal-backed context was minted at admission so queue rejection and
    // processor failure use the same immutable identity. Legacy unjournaled
    // test/system turns still derive only their display text here.
    const exactText = turn.runtimeContext?.replay.text ?? text;
    const participantContext = sharedRuntimeApplicationContext(turn, this.db);

    // Track which chat this turn belongs to for event routing
    // @check CHK-065 // @traces REQ-012.AC-03
    this.currentTurnChatJid = chatJid;
    this.bindActiveGlobalMcpConversation(chatJid);
    this.currentInboundSeq = turn.inboundSeq;
    this.turnHadVisibleOutput = false;
    this.turnHadSuppressedReplySatisfaction = false;
    // Arm the R1 first-line marker scan for this shared turn (flag-gated).
    this.currentTurnRouteMarkerHold = config.nlRouting ? '' : null;
    this.currentTurnReplayText = exactText;
    this.currentTurnReplayActorJid = senderJid;
    this.currentTurnReplayPurpose = purpose;
    this.replyGuarantee?.arm({ inboundSeq: turn.inboundSeq, chatJid });

    // Thread inbound seq into the outbound queue so ops can link back
    const queue = this.getActiveQueue();
    queue?.setInboundSeq(turn.inboundSeq);
    const context = turn.runtimeContext
      ? this.runtimeTurnCoordinator.rebindRuntimeTurnForDispatch(turn.runtimeContext, this.session!)
      : null;
    let completion: RuntimeTurnCompletion | null = null;
    if (context) {
      if (!queue) throw new Error('Shared runtime turn has no outbound queue');
      this.runtimeTurnCoordinator.beginRuntimeTurnEvidence(queue, context, recoveryDispatch?.excludeJobId);
      this.currentRuntimeTurnContext = context;
      completion = this.runtimeTurnCoordinator.createRuntimeTurnCompletion(context);
      this.currentRuntimeTurnCompletion = completion;
    }

    await this.waitForRejectedTerminalTeardown(this.session!);
    if (!this.session!.getStatus().active) {
      await this.session!.spawnSession();
    }

    const legacyOwner = context === null
      ? this.publishLegacyProviderTurn(
          this.session!,
          GLOBAL_TOOL_SCOPE_KEY,
          chatJid,
        )
      : null;
    try {
      if (recoveryDispatch) {
        if (!recoveryDispatch.dispatchAllowed()) {
          throw new Error('turn recovery replay target lost before provider send');
        }
        recoveryDispatch.onProviderBoundary();
      }
      this.updateSessionActorJid(this.session!, senderJid);
      // #2976 (ii): publish the executing turn's actor for the global-socket
      // read-time resolver at the provider boundary (shared-mode dispatch
      // bypasses sendTurnToSession, so it publishes here).
      const sharedExecQ = this.perChatExecActorQueue.get(GLOBAL_TOOL_SCOPE_KEY) ?? [];
      sharedExecQ.push({
        actorJid: senderJid,
        purpose,
        conversationKey: canonicalConversationKey(chatJid, this.db),
      });
      this.perChatExecActorQueue.set(GLOBAL_TOOL_SCOPE_KEY, sharedExecQ);
      try {
        await this.session!.sendTurn(withProviderApplicationContext(
          renderUserTurnForProvider(this.turnChronology, exactText, context, 'live'),
          participantContext,
        ));
      } catch (sendErr) {
        this.removeFailedExecutingActor(GLOBAL_TOOL_SCOPE_KEY, senderJid);
        throw sendErr;
      }
    } catch (err) {
      if (legacyOwner) {
        this.clearLegacyProviderTurn(GLOBAL_TOOL_SCOPE_KEY, legacyOwner);
      }
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('STDIN_WRITE_TIMEOUT')) {
        const status = this.session?.getStatus() ?? { sessionId: null, pid: null };
        log.warn({
          chatJid,
          sessionId: status.sessionId,
          pid: status.pid,
        }, 'stdin write timed out — notifying user');
        this.sendDirect(chatJid, 'Agent is not responding — try /new to start a fresh session.');
        throw err;
      } else {
        throw err;
      }
    }
    if (completion) await completion.promise;
    // currentTurnChatJid is cleared in handleEvent('result')
  }

  /**
   * Shared helper: spawn session if needed, send the turn, and handle the
   * STDIN_WRITE_TIMEOUT error consistently across all non-shared modes.
   */
  private async sendTurnToSession(
    session: SessionManager,
    chatJid: string,
    text: string,
    mapKey?: string,
    actorJid?: string,
    beforeUserSend?: () => void,
    systemTurnLease?: SystemTurnLeaseToken,
    dispatchAllowed?: () => boolean,
    runtimeContext?: RuntimeTurnContext,
    deliveryKind: TurnDeliveryKind = 'live',
    purpose?: SessionContext['purpose'],
  ): Promise<void> {
    let effectiveMapKey = mapKey;
    let spawnedForTurn = false;
    const dispatchCancelled = (): boolean => dispatchAllowed?.() === false;
    const stopCancelledSpawn = async (): Promise<void> => {
      if (!spawnedForTurn) return;
      try {
        await session.shutdown();
      } catch (err) {
        log.warn({ err, chatJid }, 'failed to shut down a session spawned for a cancelled turn');
      }
    };
    // Defense-in-depth (#1095): every inbound turn dispatched to a shared/single
    // global session MUST be pinned to its originating conversation before it
    // runs, so an injected tool call cannot target a different chat. Enforced
    // here at the single dispatch chokepoint, independent of the per-path binds.
    this.enforceGlobalConversationBinding(chatJid);
    this.updateSessionActorJid(session, actorJid);
    // Derive mapKey for sandboxPerChat coordination (used to suppress duplicate
    // context injection when handleResumeFailed is already handling recovery).
    const mapKeyForChat = this.sandboxPerChat
      ? chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey
      : undefined;
    const crashScopeKey = this.getCrashScopeKey(chatJid);
    let systemScopeKey = effectiveMapKey ?? GLOBAL_TOOL_SCOPE_KEY;
    const autoCompactWaiter = this.autoCompact.waiters.get(systemScopeKey);
    if (autoCompactWaiter) await autoCompactWaiter.promise;
    await this.waitForRejectedTerminalTeardown(session);
    await this.waitForSystemTurnQuarantine(systemScopeKey);
    await this.pendingSystemResults.waitUntilDispatchable(systemScopeKey, systemTurnLease);
    if (dispatchCancelled()) return;

    // Fresh-spawn history preamble; provider-boundary merge only (see below).
    let contextPreamble: string | null = null;
    const wasInactive = !session.getStatus().active;
    if (wasInactive) {
      const spawnOwnership = effectiveMapKey !== undefined
        ? this.captureOwnedPerChatGeneration(effectiveMapKey, session)
        : null;
      // Flush any buffered output from the dying session before shutting down.
      // Without this, text in the 2-second stream debounce buffer is lost when
      // the child process is killed, because the stream parser stops emitting events.
      const queue = this.getQueueForChat(chatJid, effectiveMapKey);
      if (queue) {
        await this.observeOutboundQueueOperation(
          effectiveMapKey ?? GLOBAL_TOOL_SCOPE_KEY,
          queue,
          () => queue.flush(),
        );
      }
      if (dispatchCancelled()) return;

      // Shut down old session first to prevent zombie processes.
      // Without this, spawnSession() overwrites this.child, orphaning the old
      // process and its DB row. Mirrors handleNew() pattern.
      await session.shutdown();
      if (dispatchCancelled()) return;
      await session.spawnSession();
      spawnedForTurn = true;
      if (dispatchCancelled()) {
        await stopCancelledSpawn();
        return;
      }
      if (effectiveMapKey !== undefined && spawnOwnership !== null) {
        effectiveMapKey = await this.activateSpawnedOwnedPerChatSession(
          effectiveMapKey,
          session,
          spawnOwnership,
        );
        // A LID→canonical rekey may land while spawn is in flight. Every
        // post-spawn system barrier must follow the activated scope rather than
        // consulting the retired key and admitting the user request early.
        systemScopeKey = effectiveMapKey;
        if (dispatchCancelled()) {
          await stopCancelledSpawn();
          return;
        }
      }
      // Successful spawn after a crash — decay the crash counter
      this.decrementCrashCount(effectiveMapKey ?? crashScopeKey);

      // Fresh spawns merge recent context into the active turn; see context-handoff.ts.
      const resumeFailedOwnsContext = mapKeyForChat !== undefined && this.resumeFailedHandling.has(mapKeyForChat);
      if (!resumeFailedOwnsContext) {
        try {
          const convKey = canonicalConversationKey(chatJid, this.db);
          const recent = contextMessagesForTurn(getRecentMessages(this.db, convKey, 20), text, actorJid);
          if (recent.length > 0) {
            const lines = formatContextLines(recent, this.isCrossProviderSession(session));
            contextPreamble = `[Recent chat context — read before responding]\n${lines}`;
          }
        } catch (err) {
          log.warn({ err, chatJid }, 'chat context assembly failed — proceeding without context');
        }
      }
      // Stand-in introduction (once per manager): the first turn a fallback
      // stand-in serves must open by identifying itself and then CONTINUE the
      // conversation — without this, users get an unexplained voice change and
      // the stand-in answers as if the thread just started (#2121 shape,
      // incident 2026-08-15). Prepended so the model reads WHO it is before
      // the recent-context block it is asked to continue from.
      if (
        this.isFallbackWindowActive
        && this.isCrossProviderSession(session)
        && !this.introducedStandIns.has(session)
      ) {
        this.introducedStandIns.add(session);
        const entry = this.effectiveFallbackEntry;
        const standInCard = entry
          ? modelCardLabel(entry.provider, entry.model)
          : modelCardLabel(session.getProviderId(), undefined);
        const primaryCard = modelCardLabel(this.agentProvider, this.model);
        const reason = (this.fallbackWindow.armReason ?? 'a temporary failure').replace(/-/g, ' ');
        const intro = [
          '[Provider handoff — read before responding]',
          `You are ${standInCard}, temporarily standing in for the primary model (${primaryCard}) because of ${reason}.`,
          'In your first reply only: introduce yourself in one short sentence (say which model you are), then continue the ongoing conversation and any in-progress task from the context above as the same assistant.',
          'Do not re-greet, do not restart the conversation, and do not claim capabilities you have not verified in this environment.',
        ].join('\n');
        contextPreamble = contextPreamble === null ? intro : `${intro}\n\n${contextPreamble}`;
      }
    }

    if (dispatchCancelled()) {
      await stopCancelledSpawn();
      return;
    }

    // Activate the immutable user-turn evidence epoch only after fresh-session
    // context injection has completed. System-turn output must never inherit the
    // journal identity or answer-op evidence of the following user turn.
    await this.pendingSystemResults.waitUntilDispatchable(systemScopeKey, systemTurnLease);
    if (dispatchCancelled()) {
      await stopCancelledSpawn();
      return;
    }
    let actorPushed = false;
    // Hoisted so the dispatch-failure retirement (removeFailedExecutingActor)
    // shifts the SAME register key the provider boundary pushed onto — the two
    // must never drift.
    let pushedExecScopeKey: string | undefined;
    const onProviderBoundaryReady = (): void => {
      if (dispatchCancelled()) {
        throw new Error('TURN_RECOVERY_DISPATCH_TARGET_SUPERSEDED');
      }
      if (systemTurnLease) this.requireSystemTurnProviderBoundary(systemTurnLease);
      beforeUserSend?.();
      // Publish actor and typing evidence only when provider execution begins.
      // #2976: single/shared turns publish into the SAME executing-actor
      // register under GLOBAL_TOOL_SCOPE_KEY — the global socket's read-time
      // resolver (resolveExecutingGlobalActor) reads it. per_chat sessions that
      // ride a per-chat actor socket publish under their mapKey; #2976 residual:
      // per_chat managed-loop (API) sessions have no socket but serve tools
      // through the in-process bridge, so they publish under the mapKey too, and
      // the provider bridge resolves it read-time.
      const usesPerChatActorRegister =
        this.sandboxPerChat
        || this.sessionUsesPerChatActorSocket(session)
        || (this.sessionScope === 'per_chat' && this.sessionUsesInProcessBridge(session));
      const execScopeKey = usesPerChatActorRegister && effectiveMapKey !== undefined
        ? effectiveMapKey
        : (this.sessionScope !== 'per_chat' ? GLOBAL_TOOL_SCOPE_KEY : undefined);
      if (execScopeKey !== undefined) {
        if (!session.getStatus().active) this.perChatExecActorQueue.delete(execScopeKey);
        const execQ = this.perChatExecActorQueue.get(execScopeKey) ?? [];
        execQ.push({
          actorJid,
          purpose,
          conversationKey: canonicalConversationKey(chatJid, this.db),
        });
        this.perChatExecActorQueue.set(execScopeKey, execQ);
        actorPushed = true;
        pushedExecScopeKey = execScopeKey;
        if (systemTurnLease) {
          this.systemTurnExecActors.set(systemTurnLease.id, {
            scopeKey: execScopeKey,
            actorJid,
          });
        }
      }
      const queue = this.getQueueForChat(chatJid, effectiveMapKey);
      if (queue) queue.indicateTyping();
    };
    try {
      const userTurnText = renderUserTurnForProvider(
        this.turnChronology, text, runtimeContext ?? null, deliveryKind,
        sharedReplayApplicationContext(runtimeContext, this.db),
      );
      const turnInput = contextPreamble === null
        ? userTurnText
        : withProviderApplicationContext(userTurnText, contextPreamble);
      await dispatchProviderTurn(session, turnInput, onProviderBoundaryReady);
    } catch (err) {
      if (actorPushed && pushedExecScopeKey !== undefined) {
        this.removeFailedExecutingActor(
          pushedExecScopeKey,
          actorJid,
          systemTurnLease,
        );
      }
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('STDIN_WRITE_TIMEOUT')) {
        const status = session.getStatus();
        log.warn({
          chatJid,
          sessionId: status.sessionId,
          pid: status.pid,
        }, 'stdin write timed out — notifying user');
        this.sendDirect(chatJid, 'Agent is not responding — try /new to start a fresh session.');
        throw err;
      } else {
        throw err;
      }
    }
  }

  /**
   * Send a turn in non-shared (legacy) mode.
   */
  private async sendTurnNonShared(
    chatJid: string,
    text: string,
    actorJid: string,
    source?: RuntimeTurnSourceSnapshot,
    inboundSeq?: number,
    purpose?: SessionContext['purpose'],
  ): Promise<void> {
    // Clear post-turn gate for shared session scope
    this.postTurnGate.delete(GLOBAL_TOOL_SCOPE_KEY);
    this.currentTurnChatJid = chatJid;
    this.bindActiveGlobalMcpConversation(chatJid);
    this.turnHadVisibleOutput = false;
    this.currentTurnReplayText = text;
    this.currentTurnReplayActorJid = actorJid;
    this.currentTurnReplayPurpose = purpose;
    let context: RuntimeTurnContext | null = null;
    const completion: { value: RuntimeTurnCompletion | null } = { value: null };
    if (source) {
      const queue = this.queue;
      if (!queue) throw new Error('Singleton runtime turn has no outbound queue');
      context = this.runtimeTurnCoordinator.createRuntimeTurnForDispatch({
        scope: 'singleton',
        chatJid,
        text,
        inboundSeq,
        source,
        session: this.session!,
        toolScopeKey: GLOBAL_TOOL_SCOPE_KEY,
      });
      if (context && this.runtimeTurnCoordinator.rejectRuntimeTurnIfOutboundQueuePoisoned(
        GLOBAL_TOOL_SCOPE_KEY,
        {
          sourceMessageId: source.sourceMessageId,
          receivedAtUnixSeconds: source.receivedAtUnixSeconds,
          conversationKey: source.conversationKey,
          chatJid,
          senderJid: source.senderJid,
          senderName: source.senderName,
          text,
          isGroup: source.isGroup,
          ...(source.groupName === undefined ? {} : { groupName: source.groupName }),
          contentType: source.contentType,
          runtimeContext: context,
          inboundSeq,
        },
      )) {
        await this.runtimeTurnCoordinator.awaitRejectedRuntimeTurnFinalizations();
        return;
      }
      this.pendingSingletonRuntimeTurnContext = context;
    }
    let legacyOwner: LegacyProviderTurnOwner | null = null;
    try {
      await this.sendTurnToSession(this.session!, chatJid, text, undefined, actorJid, () => {
        if (!context) {
          legacyOwner = this.publishLegacyProviderTurn(
            this.session!,
            GLOBAL_TOOL_SCOPE_KEY,
            chatJid,
          );
          return;
        }
        this.runtimeTurnCoordinator.beginRuntimeTurnEvidence(this.queue!, context);
        this.currentRuntimeTurnContext = context;
        this.pendingSingletonRuntimeTurnContext = null;
        completion.value = this.runtimeTurnCoordinator.createRuntimeTurnCompletion(context);
        this.currentRuntimeTurnCompletion = completion.value;
      }, undefined, () => (
        !this.shutdownRequested
        && (context === null || !this.runtimeTurnCoordinator.isUndispatchedRuntimeTurnCancelled(context))
      ), context ?? undefined, 'live', purpose);
      if (context && completion.value === null) {
        if (!this.runtimeTurnCoordinator.isUndispatchedRuntimeTurnCancelled(context)) {
          this.runtimeTurnCoordinator.terminalizeUndispatchedRuntimeCrash(context);
        }
        return;
      }
      if (completion.value !== null) await completion.value.promise;
    } catch (err) {
      if (legacyOwner) {
        this.clearLegacyProviderTurn(GLOBAL_TOOL_SCOPE_KEY, legacyOwner);
      }
      throw err;
    } finally {
      if (this.pendingSingletonRuntimeTurnContext === context) {
        this.pendingSingletonRuntimeTurnContext = null;
      }
    }
  }

  /**
   * Send a turn in per_chat mode — each chat has its own session.
   * Serializes within a chat but runs concurrently across chats.
   */
  private async sendTurnPerChat(
    chatJid: string,
    text: string,
    mapKey: string = this.resolvePerChatMapKey(chatJid),
    actorJid?: string,
    runtimeContext?: RuntimeTurnContext,
    scopeRef?: PerChatRuntimeScopeRef,
    systemTurnLease?: SystemTurnLeaseToken,
    excludeJobId?: number, // PRESTAGE-T4: set only by the recovery supervisor's own replay; see beginRuntimeTurnEvidence
    requestedDeliveryKind?: TurnDeliveryKind,
    targetDispatchAllowed?: () => boolean,
    onProviderBoundary?: () => void,
    purpose?: SessionContext['purpose'],
  ): Promise<void> {
    mapKey = scopeRef?.value ?? mapKey;
    const dispatchAllowed = runtimeContext === undefined && targetDispatchAllowed === undefined
      ? undefined
      : () => (
        (runtimeContext === undefined
          || !this.runtimeTurnCoordinator.isUndispatchedRuntimeTurnCancelled(runtimeContext))
        && targetDispatchAllowed?.() !== false
      );
    const continuationContext = runtimeContext === undefined
      ? this.perChatRuntimeTurnContexts.get(mapKey)?.[0]
      : undefined;
    const providerTurnContext = runtimeContext ?? continuationContext;
    const providerDeliveryKind = requestedDeliveryKind ?? (
      excludeJobId === undefined && (continuationContext === undefined
        || !this.runtimeTurnCoordinator.isRuntimeTurnContinuation(continuationContext))
        ? 'live'
        : 'recovery_replay'
    );
    // AskUserQuestion → Poll bridge: if a poll question is pending for this
    // chat and the user sends a text reply, resolve it as an option number,
    // label, description match, or free-text answer and inject it back.
    const pendingPoll = this.pendingPolls.questions.get(mapKey);
    if (pendingPoll) {
      // In groups, determine whether this sender's text should be intercepted
      let bypassPollIntercept = false;
      if (isGroupJid(pendingPoll.chatJid) && actorJid) {
        const canonicalActor = jidNormalizedUser(actorJid);
        bypassPollIntercept =
          // admin-only / admin-wins: non-admin text is not a poll answer
          ((pendingPoll.resolution === 'admin-only' || pendingPoll.resolution === 'admin-wins')
            && !pendingPoll.adminJids?.has(canonicalActor)) ||
          // majority-after-timeout: text input never counts — only poll widget votes
          (pendingPoll.resolution ?? 'first-vote-wins') === 'majority-after-timeout';
      }

      if (!bypassPollIntercept) {
        advancePendingPollIndex(pendingPoll);

        const currentQ = pendingPoll.questions[pendingPoll.currentQuestionIndex];
        if (currentQ) {
          if (pendingPoll.mode === 'poll' && isLowSignalPollStatusReply(text, currentQ.options)) {
            const queue = this.getQueueForChat(pendingPoll.chatJid, mapKey);
            if (queue) {
              queue.enqueueText('I am waiting for the poll vote itself. Tap an option in the poll, or type the option label if WhatsApp does not send the vote.');
              try {
                await this.observeOutboundQueueOperation(mapKey, queue, () => queue.flush());
              } catch (err) {
                log.error({ err, chatJid: pendingPoll.chatJid }, 'failed to flush pending poll status clarification');
              }
            } else {
              this.sendDirect(
                pendingPoll.chatJid,
                'I am waiting for the poll vote itself. Tap an option in the poll, or type the option label if WhatsApp does not send the vote.',
              );
            }
            await this.completeConsumedPerChatInbound(mapKey, 'poll_status_reply', runtimeContext, scopeRef);
            return;
          }

          const answeredQuestionIndex = pendingPoll.currentQuestionIndex;
          pendingPoll.answersCollected[answeredQuestionIndex] = resolveTypedPollAnswer(text, currentQ);
          removePollIdsForQuestion(pendingPoll, answeredQuestionIndex);
          pendingPoll.currentQuestionIndex++;
          advancePendingPollIndex(pendingPoll);

          if (Object.keys(pendingPoll.answersCollected).length >= pendingPoll.questions.length) {
            this.stageResolvedAskUserPoll(mapKey, pendingPoll);
            await this.completeConsumedPerChatInbound(
              mapKey,
              'poll_answer_collected',
              runtimeContext,
              scopeRef,
            );
            await this.injectPollAnswers(mapKey, pendingPoll, actorJid);
          } else {
            log.info({
              mapKey,
              answered: Object.keys(pendingPoll.answersCollected).length,
              total: pendingPoll.questions.length,
            }, 'free-text answer collected — waiting for more');
            await this.completeConsumedPerChatInbound(
              mapKey,
              'poll_partial_answer_collected',
              runtimeContext,
              scopeRef,
            );
          }
          return; // consume the message — don't send as a new turn
        }
      }
      // When bypassPollIntercept is true, execution falls through to the
      // normal sendTurnToSession path below
    }

    // Clear post-turn gate — legitimate new user turn begins
    this.postTurnGate.delete(mapKey);

    // When sandboxPerChat=true maps are keyed by workspaceKey, not raw chatJid
    // Store the turn text so it can be replayed if a session resume fails
    // before the agent can process it.
    this.pendingTurnText.set(mapKey, text);
    this.pendingTurnActorJid.set(mapKey, actorJid);
    this.pendingTurnPurpose.set(mapKey, purpose);

    const legacyOwner: { value: LegacyProviderTurnOwner | null } = { value: null };
    const beginDispatchedTurn = (
      targetSession: SessionManager,
      currentMapKey: string,
    ): RuntimeTurnCompletion | null => {
      if (runtimeContext === undefined && systemTurnLease === undefined) {
        legacyOwner.value = this.publishLegacyProviderTurn(
          targetSession,
          currentMapKey,
          chatJid,
        );
        return null;
      }
      return this.beginPerChatRuntimeTurn(
        targetSession,
        chatJid,
        currentMapKey,
        runtimeContext,
        scopeRef,
        excludeJobId,
      );
    };

    const mappedSession = this.chatSessions.get(mapKey);
    // A mapped session whose dispatch ownership was lost cannot serve a turn:
    // it throws at the ownership rebind below and, because the spawn-and-claim
    // repair is gated on this very lookup MISSING, it would keep throwing for
    // the process lifetime. Drop the stale entry so this turn falls through to
    // that repair — a one-turn delay instead of a permanent wedge.
    const session = mappedSession !== undefined
      && this.evictUnownedPerChatSession(mapKey, mappedSession)
      ? undefined
      : mappedSession;
    if (!session) {
      log.warn({ chatJid, mapKey }, 'no active session for chat — spawning new session');
      // Instead of silently dropping, initialize session and queue so message is handled
      if (this.sandboxPerChat) {
        await this.ensureSessionAndQueue(chatJid, actorJid);
      } else {
        if (this.routeRecycleLifecycle.isPendingOrRunning(mapKey)) {
          await consumePendingRecycleIfIdleForPort(this.modelPinHost, mapKey);
        }
        this.ensureSessionAndQueueSync(chatJid, mapKey, actorJid);
      }
      const currentMapKey = scopeRef?.value ?? mapKey;
      const retrySession = this.chatSessions.get(currentMapKey);
      if (!retrySession) {
        log.error({ chatJid, mapKey: currentMapKey }, 'failed to create session for chat — message dropped');
        this.pendingTurnText.delete(currentMapKey);
        this.pendingTurnActorJid.delete(currentMapKey);
        this.pendingTurnPurpose.delete(currentMapKey);
        if (runtimeContext) {
          await this.runtimeTurnCoordinator.finalizeUndispatchedRuntimeTurnAndWait(runtimeContext, scopeRef);
        } else if (this.durability && this.perChatInboundSeqQueue.get(currentMapKey)?.[0] !== undefined) {
          const failedSeq = this.perChatInboundSeqQueue.get(currentMapKey)![0];
          this.markRuntimeFaultContinuityCandidate(failedSeq);
          this.replyGuarantee?.disarm(failedSeq);
          this.durability.markInboundFailed(failedSeq, 'session_spawn_failed');
        }
        // Eligible-side disclosure (Slice 1): the common config is a primary
        // routed on a `present-expired-refreshable` credential (routable because
        // a refresh was expected) that then fails. F07 does not gate the primary,
        // so this is where that turn gets its explanation. The note HEDGES — the
        // failure here is not distinguishable as a refresh failure, so it names
        // the observed classification and the likely cause without asserting it.
        const credNote = spawnFailureCredentialNote(
          resolveProviderCredentialState({
            provider: this.agentProvider,
            model: this.model,
            providerConfig: this.agentProviderConfig,
          }),
        );
        this.sendDirect(chatJid, credNote ?? 'Something went wrong starting a session. Try sending your message again.');
        return;
      }
      const completion: { value: RuntimeTurnCompletion | null } = { value: null };
      try {
        await this.sendTurnToSession(retrySession, chatJid, text, currentMapKey, actorJid, () => {
          completion.value = beginDispatchedTurn(
            retrySession,
            scopeRef?.value ?? currentMapKey,
          );
          onProviderBoundary?.();
        }, systemTurnLease, dispatchAllowed, providerTurnContext, providerDeliveryKind, purpose);
      } catch (err) {
        if (legacyOwner.value) {
          this.clearLegacyProviderTurn(currentMapKey, legacyOwner.value);
        }
        throw err;
      }
      if (completion.value) await completion.value.promise;
      return;
    }
    const completion: { value: RuntimeTurnCompletion | null } = { value: null };
    try {
      await this.sendTurnToSession(session, chatJid, text, mapKey, actorJid, () => {
        completion.value = beginDispatchedTurn(
          session,
          scopeRef?.value ?? mapKey,
        );
        onProviderBoundary?.();
      }, systemTurnLease, dispatchAllowed, providerTurnContext, providerDeliveryKind, purpose);
    } catch (err) {
      if (legacyOwner.value) {
        this.clearLegacyProviderTurn(scopeRef?.value ?? mapKey, legacyOwner.value);
      }
      throw err;
    }
    if (completion.value) await completion.value.promise;
  }

  private beginPerChatRuntimeTurn(
    session: SessionManager,
    chatJid: string,
    mapKey: string,
    context: RuntimeTurnContext | undefined,
    scopeRef?: PerChatRuntimeScopeRef,
    excludeJobId?: number,
  ): RuntimeTurnCompletion | null {
    if (!context) return null;
    mapKey = scopeRef?.value ?? mapKey;
    const queue = this.getQueueForChat(chatJid, mapKey);
    if (!queue) throw new Error('Per-chat runtime turn has no outbound queue');
    context = this.runtimeTurnCoordinator.rebindRuntimeTurnForDispatch(context, session, mapKey);
    const contexts = this.perChatRuntimeTurnContexts.get(mapKey) ?? [];
    if (contexts.length > 0) {
      throw new PerChatTurnFifoOwnerConflictError(mapKey);
    }
    this.runtimeTurnCoordinator.beginRuntimeTurnEvidence(queue, context, excludeJobId);
    contexts.push(context);
    this.perChatRuntimeTurnContexts.set(mapKey, contexts);
    this.perChatRuntimeTurnScopeRefs.set(
      context.identity.logicalTurnId,
      scopeRef ?? { value: mapKey },
    );
    const completion = this.runtimeTurnCoordinator.createRuntimeTurnCompletion(context);
    this.perChatRuntimeTurnCompletions.set(mapKey, completion);
    return completion;
  }

  private resolveTurnRecoveryDispatchTarget(job: TurnRecoveryJobRow): TurnRecoveryDispatchTarget | null {
    if (job.scope === 'shared' || job.scope === 'singleton') {
      // #2170: singleton/shared target = the instance's one live session.
      // No cold session creation here (that is the owner-gated cold-activation
      // lane); an inactive/absent session leaves the job pending for a later
      // scan, exactly like an absent per_chat session.
      const session = this.session;
      if (!session?.getStatus().active) return null;
      return { scope: job.scope, managerId: this.managerIdFor(session), generation: 1, session };
    }
    if (job.scope !== 'per_chat') return null;
    return this.resolvePerChatDispatchTarget(job.delivery_jid);
  }

  /** Shared by turn recovery and capability-obligation dispatch. */
  private resolvePerChatDispatchTarget(deliveryJid: string): TurnRecoveryDispatchTarget | null {
    const mapKey = this.resolvePerChatMapKey(deliveryJid);
    let session = this.chatSessions.get(mapKey);
    if (!session?.getStatus().active) {
      // #2169: cold per_chat turn recovery — create session proactively when
      // the in-memory session map has none (e.g. after cold restart before any
      // inbound message arrives for this conversation).
      if (!this.chatSessions.has(mapKey)) {
        this.ensureSessionAndQueueSync(deliveryJid, mapKey);
        session = this.chatSessions.get(mapKey);
      }
      if (!session?.getStatus().active) return null;
    }
    const managerId = this.sessionManagerIds.get(session);
    const owner = managerId ? this.sessionOwnership.get(mapKey) : undefined;
    if (
      !managerId
      || owner?.state !== 'active'
      || !this.sessionOwnership.isCurrent(mapKey, managerId, owner.generation)
    ) {
      return null;
    }
    return { scope: 'per_chat', mapKey, managerId, generation: owner.generation, session };
  }

  private isTurnRecoveryDispatchTargetCurrent(target: TurnRecoveryDispatchTarget): boolean {
    const session = target.session as SessionManager;
    if (target.scope !== 'per_chat') {
      // #2170: singleton/shared currency — the exact session object is still
      // THE instance session, still active, still the same manager identity.
      return this.session === session
        && session.getStatus().active
        && this.sessionManagerIds.get(session) === target.managerId;
    }
    const owner = this.sessionOwnership.get(target.mapKey);
    return this.chatSessions.get(target.mapKey) === session
      && this.sessionManagerIds.get(session) === target.managerId
      && session.getStatus().active
      && owner?.state === 'active'
      && this.sessionOwnership.isCurrent(target.mapKey, target.managerId, target.generation);
  }

  private async abortTurnRecoveryReplay(
    target: TurnRecoveryDispatchTarget,
    context: RuntimeTurnContext,
  ): Promise<boolean> {
    const session = target.session as SessionManager;
    if (!this.isTurnRecoveryDispatchTargetCurrent(target)) {
      const status = session.getStatus();
      return !status.active && status.pid === null && status.turnInFlight !== true;
    }
    // #2170: singleton/shared targets have no mapKey — the reject/finalize
    // pair and queue lookup take their global (mapKey-less) forms.
    const mapKey = target.scope === 'per_chat' ? target.mapKey : undefined;
    const queue = (mapKey !== undefined ? this.chatQueues.get(mapKey) : this.getActiveQueue()) ?? null;
    this.runtimeTurnCoordinator.rejectRuntimeTurnCompletion(
      new Error('TURN_RECOVERY_REPLAY_ABORTED'),
      mapKey,
      context,
    );
    this.runtimeTurnCoordinator.finalizeRuntimeCrash(context, queue, session, mapKey);
    try {
      await session.shutdown(false);
    } catch (err) {
      log.error({ err }, 'turn recovery replay exact-generation shutdown failed');
      return false;
    }
    const status = session.getStatus();
    return !status.active && status.pid === null && status.turnInFlight !== true;
  }

  private async dispatchTurnRecoveryReplay(
    job: TurnRecoveryJobRow,
    _fence: TurnRecoveryClaimFence,
    target?: TurnRecoveryDispatchTarget,
    abortControl?: TurnRecoveryReplayAbortControl,
  ): Promise<TurnRecoveryReplayDispatchResult> { // real dispatcher body in turn-recovery-dispatch.ts
    const dispatchTarget = target ?? this.resolveTurnRecoveryDispatchTarget(job) ?? undefined;
    return dispatchTurnRecoveryReplayForJob(
      this.runtimeTurnCoordinator, (jid) => this.resolvePerChatMapKey(jid),
      (mapKey) => this.chatSessions.get(mapKey), (s) => this.requireSessionToolScopeKey(s),
      (candidate) => this.isTurnRecoveryDispatchTargetCurrent(candidate),
      (candidate, context) => this.abortTurnRecoveryReplay(candidate, context),
      (turn, recoveryDispatch) => this.processTurn(turn, recoveryDispatch),
      GLOBAL_TOOL_SCOPE_KEY,
      job, dispatchTarget, abortControl,
    );
  }

  private updateSessionActorJid(session: SessionManager, actorJid: string | undefined): void {
    if (!actorJid) return;
    const maybeSession = session as SessionManager & { updateMcpActorJid?: (actorJid: string) => void };
    maybeSession.updateMcpActorJid?.(actorJid);
  }

  private bindActiveGlobalMcpConversation(chatJid: string): void {
    const conversationKey = toConversationKey(chatJid);
    if (this.singletonProviderToolSession) {
      this.singletonProviderToolSession.conversationKey = conversationKey;
    }
    this.globalSocketServer?.updateConversationKey(conversationKey);
  }

  /**
   * Defense-in-depth for the cross-conversation guard (#1095). A shared/single
   * global MCP session is pinned to the originating chat per turn via
   * bindActiveGlobalMcpConversation(); the registry's cross-conversation guard
   * relies on that binding to stop an injected tool call from targeting another
   * chat. But the four turn-entry paths each call bind() separately — an
   * unenforced invariant. This runs at the single turn-dispatch chokepoint
   * (sendTurnToSession): it re-asserts the binding so a future path that forgets
   * to bind cannot silently process an inbound turn under a stale/unbound key,
   * and loudly flags any drift to a *different* conversation (the dangerous case).
   *
   * non-sandbox per_chat children use actor-bound per-chat sockets. The shared
   * global server stays actor-less there and is not a provider transport; this
   * pin remains defense in depth for any accidental call path.
   */
  private enforceGlobalConversationBinding(chatJid: string): void {
    const expected = toConversationKey(chatJid);
    const bound = this.singletonProviderToolSession?.conversationKey;
    if (bound !== undefined && bound !== expected) {
      log.error(
        { chatJid, expected, bound, sessionScope: this.sessionScope },
        'global MCP conversation-binding drift at turn dispatch — re-pinning fail-closed (#1095)',
      );
    }
    this.bindActiveGlobalMcpConversation(chatJid);
  }

  /**
   * Handle events from a per_chat session — routes to that chat's outbound queue.
   * Resolves queue and session locally from the mapKey to avoid mutating shared
   * instance fields that another concurrent chat could overwrite.
   */
  private resolveProviderEventOwner(
    event: AgentEvent,
    logicalOwnerMatches: boolean,
    systemTurn: PendingSystemTurnSnapshot | null,
  ): { owner: ProviderEventOwner; systemTurn: PendingSystemTurnSnapshot | null } {
    if (systemTurn) {
      const systemOwner: ProviderEventOwner = {
        kind: 'system_request',
        purpose: systemTurn.purpose,
      };
      const systemDecision = decideProviderEventAdmission(event, systemOwner);
      if (
        event.type === 'result'
        || !logicalOwnerMatches
        || (event.type === 'compact_boundary' && systemDecision.admit)
      ) {
        return { owner: systemOwner, systemTurn };
      }
    }
    if (logicalOwnerMatches) {
      return { owner: { kind: 'logical_turn' }, systemTurn: null };
    }
    if (event.type === 'init') {
      return { owner: { kind: 'session_accounting' }, systemTurn: null };
    }
    return { owner: { kind: 'none' }, systemTurn: null };
  }

  private rejectProviderEvent(
    eventType: AgentEvent['type'],
    runtimeScope: 'per_chat' | 'singleton_shared',
    ownerKind: string,
    reason: string,
    sourceSession?: SessionManager,
  ): void {
    if (ownerKind === 'system_request' && reason === 'purpose_disallows_effect') {
      this.suppressedSystemTurnEffectRejects = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.suppressedSystemTurnEffectRejects + 1,
      );
    } else {
      this.unownedProviderEventRejects = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.unownedProviderEventRejects + 1,
      );
    }
    const reasonCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      (this.providerEventRejectReasonCounts.get(reason) ?? 0) + 1,
    );
    this.providerEventRejectReasonCounts.set(reason, reasonCount);
    if (reasonCount === 1 || (reasonCount & (reasonCount - 1)) === 0) {
      log.warn(
        { eventType, runtimeScope, ownerKind, reason, reasonCount },
        'provider event rejected before runtime effects',
      );
    }
    // A malformed stdout record on an owned JSON stream destroys framing just
    // as decisively as an unattributable terminal. Reap/finalize immediately;
    // waiting for the activity-rearmed watchdog can otherwise hold the lane for
    // its full hard timeout with no usable terminal event.
    if ((eventType === 'result' || eventType === 'parse_error') && sourceSession) {
      this.invalidateRejectedTerminalSource(sourceSession, runtimeScope, reason);
    }
  }

  private invalidateRejectedTerminalSource(
    sourceSession: SessionManager,
    runtimeScope: 'per_chat' | 'singleton_shared',
    reason: string,
  ): void {
    if (this.rejectedTerminalTeardowns.has(sourceSession)) return;
    const logicalOwner = this.captureRejectedTerminalLogicalOwner(sourceSession, runtimeScope);
    const systemTurn = this.captureRejectedTerminalSystemTurn(sourceSession);

    let teardown!: Promise<boolean>;
    teardown = sourceSession.shutdown(false).then(async () => {
      if (systemTurn && this.pendingSystemResults.cancel(systemTurn.lease)) {
        this.releaseSystemTurnExecutingActor(systemTurn);
      }
      if (logicalOwner) {
        await this.finalizeRejectedTerminalLogicalOwner(logicalOwner, sourceSession);
      }
      return true;
    }).then(
      () => true,
      (err) => {
        log.error(
          { err, runtimeScope, reason },
          'rejected terminal source teardown failed — provider lane remains closed',
        );
        if (logicalOwner) {
          // shutdown() clears the provider watchdog before process-tree or
          // lifecycle persistence can reject. Settle the exact processor
          // waiter even though quarantine remains closed; otherwise no future
          // event or watchdog can release this logical turn.
          this.rejectRejectedTerminalLogicalOwner(logicalOwner, err);
        }
        return false;
      },
    ).then((provedClosed) => {
      // SessionManager instances survive /new generation changes. Retain a
      // failed proof to block automatic respawn, but retire a successful proof
      // so a future generation on the same manager can be quarantined anew.
      if (provedClosed && this.rejectedTerminalTeardowns.get(sourceSession) === teardown) {
        this.rejectedTerminalTeardowns.delete(sourceSession);
      }
      return provedClosed;
    });
    this.rejectedTerminalTeardowns.set(sourceSession, teardown);
  }

  private captureRejectedTerminalSystemTurn(
    sourceSession: SessionManager,
  ): PendingSystemTurnSnapshot | null {
    const managerId = this.sessionManagerIds.get(sourceSession);
    if (!managerId) return null;
    for (const scopeKey of this.pendingSystemResults.counts.keys()) {
      const candidate = this.pendingSystemResults.peek(scopeKey);
      if (candidate?.owner?.managerId === managerId) return candidate;
    }
    return null;
  }

  private captureRejectedTerminalLogicalOwner(
    sourceSession: SessionManager,
    runtimeScope: 'per_chat' | 'singleton_shared',
  ): { context: RuntimeTurnContext; queue: IOutboundQueue; mapKey?: string } | null {
    const managerId = this.sessionManagerIds.get(sourceSession);
    if (!managerId) return null;

    if (runtimeScope === 'singleton_shared') {
      const context = this.currentRuntimeTurnContext;
      if (!context || context.identity.managerId !== managerId) return null;
      const queue = this.shared
        ? this.outboundQueues.get(context.identity.deliveryJid)
          ?? this.outboundQueues.get(canonicalizeChatJid(context.identity.deliveryJid, this.db))
        : this.queue;
      return {
        context,
        queue: queue ?? this.createOutboundQueue(
          context.identity.deliveryJid,
          'rejected terminal detached finalization',
        ),
      };
    }

    for (const [mapKey, contexts] of this.perChatRuntimeTurnContexts) {
      const context = contexts.find((candidate) => candidate.identity.managerId === managerId);
      if (!context) continue;
      return {
        context,
        queue: this.chatQueues.get(mapKey) ?? this.createOutboundQueue(
          context.identity.deliveryJid,
          'rejected terminal detached finalization',
        ),
        mapKey,
      };
    }
    return null;
  }

  private async finalizeRejectedTerminalLogicalOwner(
    owner: { context: RuntimeTurnContext; queue: IOutboundQueue; mapKey?: string },
    sourceSession: SessionManager,
  ): Promise<void> {
    try {
      owner.queue.abortTurn({ preserveEvidence: true });
      const result = await this.finalizeRuntimeTurnContext({
        context: owner.context,
        queue: owner.queue,
        attemptOutcome: { kind: 'failed', class: 'provider_stream_corrupt' },
        session: sourceSession,
        ...(owner.mapKey === undefined ? {} : { mapKey: owner.mapKey }),
        clearReplayOnSuccess: false,
      });
      if (result.kind !== 'terminal' && !result.mayAdvance) {
        await this.runtimeTurnSupervisor.waitForRecovery(owner.context);
      }
    } catch (err) {
      this.rejectRejectedTerminalLogicalOwner(owner, err);
      throw err;
    }
  }

  private rejectRejectedTerminalLogicalOwner(
    owner: { context: RuntimeTurnContext; mapKey?: string },
    error: unknown,
  ): void {
    this.runtimeTurnCoordinator.markRuntimeTurnDegraded(owner.context);
    this.runtimeTurnCoordinator.rejectRuntimeTurnCompletion(
      error,
      owner.mapKey,
      owner.context,
    );
  }

  private async waitForRejectedTerminalTeardown(sourceSession: SessionManager): Promise<void> {
    const teardown = this.rejectedTerminalTeardowns.get(sourceSession);
    if (!teardown) return;
    if (await teardown) return;
    throw new Error('REJECTED_TERMINAL_QUARANTINE_FAILED: exact provider source was not proven closed');
  }

  private handleRestrictedSystemResult(
    sourceSession: SessionManager,
    scopeKey: string,
    systemTurn: PendingSystemTurnSnapshot,
    event: Extract<AgentEvent, { type: 'result' }>,
    tracker: OperationTracker | null,
  ): void {
    sourceSession.completeProviderTurn(event.providerTurnOwnerToken);
    tracker?.onTurnComplete();
    const rowId = sourceSession.getDbRowId();
    if (rowId !== null && (event.inputTokens !== undefined || event.outputTokens !== undefined)) {
      const { newInputTokens, cacheReadTokens } = splitInputTokenUsage(event);
      accumulateTokensWithEvent(
        this.db,
        rowId,
        newInputTokens,
        event.outputTokens ?? 0,
        cacheReadTokens,
      );
    }
    this.recordTurnCostUsd(event);

    // A restricted-purpose system turn can end in a terminal FAILURE
    // (auth-required, server error, context overflow). This was the only
    // terminal path that inspected neither event.isError nor event.text —
    // forensics on effect-suppressed system turns (the ml-bot 2026-08-10/11
    // purpose_disallows_effect incidents) saw the rejected stream events but
    // never the terminal cause. Log-only by design: fallback arming and user
    // notices stay user-turn concerns.
    const systemTurnFailureKind = event.text !== null ? classifyProviderFailure(event.text) : null;
    if (event.isError || systemTurnFailureKind !== null) {
      log.warn({
        scopeKey,
        purpose: systemTurn.purpose,
        isError: event.isError === true,
        failureKind: systemTurnFailureKind,
        textPreview: event.text !== null ? providerPreview(event.text, 300) : null,
      }, 'restricted-purpose system turn ended in terminal failure');
    }

    const compactPurpose = systemTurn.purpose === 'auto_compact_silent'
      || systemTurn.purpose === 'manual_compact_silent'
      || systemTurn.purpose === 'manual_compact_notice';
    if (compactPurpose) {
      const hadCompactBoundary = this.consumeCompactBoundary(scopeKey);
      if (hadCompactBoundary && rowId !== null) {
        markSessionCompacted(this.db, rowId);
        this.recordAutoCompactSuccess(scopeKey);
      }
      this.finishAutoCompact(scopeKey);
      if (
        systemTurn.purpose === 'auto_compact_silent'
        || systemTurn.purpose === 'manual_compact_silent'
      ) {
        this.clearSilentCompact(scopeKey);
      }
    }
    // endTurn runs for EVERY purpose: the previous non-compact early return
    // skipped it, leaving any asserted composing state to a watchdog.
    const routeQueue = scopeKey === GLOBAL_TOOL_SCOPE_KEY
      ? (systemTurn.routeChatJid
          ? this.getQueueForChat(systemTurn.routeChatJid)
          : this.getActiveQueue())
      : this.chatQueues.get(scopeKey) ?? null;
    routeQueue?.endTurn();
    if (scopeKey === GLOBAL_TOOL_SCOPE_KEY) {
      this.currentTurnChatJid = null;
    }
  }

  /**
   * Control turns are synthetic repair traffic. Their terminal result releases
   * only control ownership/accounting; it must never enter user fallback,
   * durability, reply-guarantee, voice, or post-turn finalization paths.
   */
  private handleControlTerminalResult(
    sourceSession: SessionManager,
    controlQueue: IOutboundQueue,
    toolScopeKey: string,
    event: Extract<AgentEvent, { type: 'result' }>,
  ): void {
    const reportId = this.activeControlReportId;
    if (reportId === null || this.controlTerminalizingReportId === reportId) return;

    sourceSession.completeProviderTurn(event.providerTurnOwnerToken);

    this.operationTrackers.get('control@heal.internal')?.onTurnComplete();
    controlQueue.endTurn();
    this.turnHadToolActivity.delete(toolScopeKey);
    this.clearToolNames(toolScopeKey);
    const rowId = sourceSession.getDbRowId();
    if (rowId !== null && (event.inputTokens !== undefined || event.outputTokens !== undefined)) {
      const { newInputTokens, cacheReadTokens } = splitInputTokenUsage(event);
      accumulateTokensWithEvent(
        this.db,
        rowId,
        newInputTokens,
        event.outputTokens ?? 0,
        cacheReadTokens,
      );
    }
    this.recordTurnCostUsd(event);

    if (this.controlProtocolCompletedReportId !== reportId) return;
    this.controlTerminalizingReportId = reportId;
    void this.finishControlReportAfterTerminal(reportId, sourceSession);
  }

  private async finishControlReportAfterTerminal(
    reportId: string,
    sourceSession: SessionManager,
  ): Promise<void> {
    try {
      // A provider result is final for the request, but this persistent process
      // has no supported request ID on later events. Reap it before admitting
      // the next report so report A can never bleed into report B.
      await sourceSession.shutdown(false);
    } catch (err) {
      log.error(
        { err, reportId },
        'control terminal teardown failed — repair lane remains closed',
      );
      return;
    }

    if (
      this.activeControlReportId !== reportId
      || this.controlSession !== sourceSession
      || this.controlProtocolCompletedReportId !== reportId
    ) return;

    this.releaseControlSession(reportId, sourceSession);
    this.dispatchNextControlReport();
  }

  private releaseControlSession(reportId: string, sourceSession: SessionManager): void {
    if (this.activeControlReportId !== reportId || this.controlSession !== sourceSession) return;
    if (this.controlSessionTimeout) {
      clearTimeout(this.controlSessionTimeout);
      this.controlSessionTimeout = null;
    }
    const syntheticJid = 'control@heal.internal';
    const tracker = this.operationTrackers.get(syntheticJid);
    tracker?.shutdown();
    this.operationTrackers.delete(syntheticJid);
    this.chatSessions.delete(syntheticJid);
    this.chatQueues.delete(syntheticJid);
    this.controlSession = null;
    this.activeControlReportId = null;
    this.controlProtocolCompletedReportId = null;
    this.controlTerminalizingReportId = null;
  }

  private dispatchNextControlReport(): void {
    const next = dequeueNextReport(this.db);
    if (!next) return;
    const evidence = parseHealContext(next.context);
    const errorClass = errorClassForHealEvidence(evidence);
    void this.handleControlTurn(next.report_id, JSON.stringify({
      reportId: next.report_id,
      errorClass,
      evidence,
    })).catch((err) => {
      log.error({ err, reportId: next.report_id }, 'unhandled error in handleControlTurn');
    });
  }

  private handleEventPerChat(
    sourceSession: SessionManager,
    event: AgentEvent,
    toolScopeKey: string,
  ): void {
    const controlSource = sourceSession === this.controlSession;
    let mapKey: string | null = null;
    for (const [candidateKey, currentSession] of this.chatSessions) {
      if (currentSession === sourceSession) {
        mapKey = candidateKey;
        break;
      }
    }
    const registeredToolScope = this.sessionEventToolScopes.get(sourceSession);
    if (!mapKey || registeredToolScope !== toolScopeKey) {
      this.rejectProviderEvent(event.type, 'per_chat', 'none', 'source_session_not_current', sourceSession);
      return;
    }

    if (controlSource) {
      if (
        mapKey !== 'control@heal.internal'
        || this.activeControlReportId === null
        || this.chatSessions.get(mapKey) !== sourceSession
      ) {
        this.rejectProviderEvent(event.type, 'per_chat', 'control', 'control_owner_missing', sourceSession);
        return;
      }
      if (event.type === 'tool_use' && event.toolName === 'AskUserQuestion') {
        this.rejectProviderEvent(event.type, 'per_chat', 'control', 'event_not_allowed_for_owner', sourceSession);
        return;
      }
      const decision = decideProviderEventAdmission(event, { kind: 'control' });
      if (!decision.admit) {
        this.rejectProviderEvent(event.type, 'per_chat', 'control', decision.reason, sourceSession);
        return;
      }
      if (event.type === 'ignored') return;
      const controlQueue = this.chatQueues.get(mapKey);
      if (!controlQueue) {
        this.rejectProviderEvent(event.type, 'per_chat', 'control', 'control_owner_missing', sourceSession);
        return;
      }
      if (event.type === 'result') {
        this.handleControlTerminalResult(sourceSession, controlQueue, toolScopeKey, event);
        return;
      }
      this.handleEventWithContext(
        event,
        controlQueue,
        sourceSession,
        toConversationKey(controlQueue.targetChatJid),
        undefined,
        mapKey,
        toolScopeKey,
        false,
        null,
      );
      return;
    }

    const managerId = this.sessionManagerIds.get(sourceSession);
    const generationOwner = managerId ? this.sessionOwnership.get(mapKey) : undefined;
    if (
      !managerId
      || !generationOwner
      || !this.sessionOwnership.isCurrent(mapKey, managerId, generationOwner.generation)
    ) {
      this.rejectProviderEvent(event.type, 'per_chat', 'none', 'source_generation_not_current', sourceSession);
      return;
    }

    const runtimeContext = this.runtimeTurnCoordinator.runtimeTurnContext(mapKey);
    const runtimeOwnerMatches = runtimeContext !== null
      && runtimeContext.identity.managerId === managerId
      && runtimeContext.identity.generation === generationOwner.generation
      && runtimeContext.toolScopeKey === toolScopeKey;
    const legacyOwner = this.legacyProviderTurnMatches(
      mapKey,
      managerId,
      generationOwner.generation,
      toolScopeKey,
    );
    const logicalOwnerMatches = runtimeOwnerMatches || legacyOwner !== null;
    const systemTurn = this.pendingSystemResults.peek(mapKey);
    const systemOwnerMatches = systemTurn?.owner != null
      && systemTurn.owner.managerId === managerId
      && systemTurn.owner.generation === generationOwner.generation
      && systemTurn.owner.toolScopeKey === toolScopeKey;
    const resolved = this.resolveProviderEventOwner(
      event,
      logicalOwnerMatches,
      systemOwnerMatches ? systemTurn : null,
    );
    const decision = decideProviderEventAdmission(event, resolved.owner);
    if (!decision.admit) {
      this.rejectProviderEvent(event.type, 'per_chat', resolved.owner.kind, decision.reason, sourceSession);
      return;
    }
    if (event.type === 'ignored') return;

    let queue = this.chatQueues.get(mapKey);
    if (!queue && event.type === 'result') {
      const recoveryChatJid = runtimeOwnerMatches
        ? runtimeContext!.identity.deliveryJid
        : legacyOwner?.routeChatJid ?? resolved.systemTurn?.routeChatJid;
      if (recoveryChatJid) {
        queue = this.createOutboundQueue(recoveryChatJid, 'provider terminal route recovery');
        this.chatQueues.set(mapKey, queue);
        log.warn(
          { mapKey, recoveryChatJid, ownerKind: resolved.owner.kind },
          'reconstructed missing output route for an owned provider terminal',
        );
      }
    }
    const resultNeedsRoute = event.type === 'result'
      && (
        resolved.owner.kind === 'logical_turn'
        || (resolved.systemTurn !== null && systemPurposeAllowsOutput(resolved.systemTurn.purpose))
      );
    if (resultNeedsRoute && !queue) {
      this.rejectProviderEvent(
        event.type,
        'per_chat',
        resolved.owner.kind,
        'owner_queue_missing',
        sourceSession,
      );
      return;
    }

    if (
      event.type === 'result'
      && resolved.owner.kind === 'logical_turn'
      && legacyOwner !== null
    ) {
      this.clearLegacyProviderTurn(mapKey, legacyOwner);
    }

    let consumedSystemTurn: PendingSystemTurnSnapshot | null = null;
    if (event.type === 'result' && resolved.systemTurn) {
      consumedSystemTurn = this.pendingSystemResults.consumeResult(resolved.systemTurn.lease);
      if (!consumedSystemTurn) {
        this.rejectProviderEvent(event.type, 'per_chat', 'system_request', 'system_owner_race', sourceSession);
        return;
      }
      this.releaseSystemTurnExecutingActor(consumedSystemTurn);
      if (!systemPurposeAllowsOutput(consumedSystemTurn.purpose)) {
        this.handleRestrictedSystemResult(
          sourceSession,
          mapKey,
          consumedSystemTurn,
          event,
          this.getTracker(mapKey),
        );
        return;
      }
    }

    if (!queue) {
      this.rejectProviderEvent(event.type, 'per_chat', resolved.owner.kind, 'owner_queue_missing', sourceSession);
      return;
    }
    const conversationKey = toConversationKey(queue.targetChatJid);
    const inboundSeq = this.perChatInboundSeqQueue.get(mapKey)?.[0];
    this.handleEventWithContext(
      event,
      queue,
      sourceSession,
      conversationKey,
      inboundSeq,
      mapKey,
      toolScopeKey,
      consumedSystemTurn !== null,
      consumedSystemTurn?.purpose ?? null,
    );
  }

  // ---------------------------------------------------------------------------
  // AskUserQuestion → WhatsApp Poll bridge
  // ---------------------------------------------------------------------------

  private deletePendingPollQuestions(mapKey: string): void {
    const pending = this.pendingPolls.questions.get(mapKey);
    if (!pending) return;
    clearPendingPollTimers(pending);
    // Clean up suppression for askuser source
    if (pending.source === 'askuser' || pending.source === undefined) {
      this.suppressedAskUserToolIds.delete(pending.toolId);
    }
    // Reject ONLY if awaiters haven't already been settled by settlePoll()
    // (settlePoll nulls callbacks after settlement, so this is safe)
    if (pending.awaitReject) {
      pending.awaitReject(new Error('Poll abandoned'));
      pending.awaitResolve = undefined;
      pending.awaitReject = undefined;
    }
    this.pendingPolls.questions.delete(mapKey);
    this.pollPersistence.remove(mapKey);
  }

  // ---------------------------------------------------------------------------
  // AskUserQuestion→poll bridge (#1977 D3) — extracted to runtime-poll-bridge.ts.
  // Spread delegators keep every externally-reached name (ctor subscriptions,
  // start() calls, the public console API, and the characterization suites
  // that invoke these on the runtime) working unchanged.
  // ---------------------------------------------------------------------------

  private detachPendingPollContinuation(...args: Parameters<RuntimePollBridgeCoordinator['detachPendingPollContinuation']>): ReturnType<RuntimePollBridgeCoordinator['detachPendingPollContinuation']> {
    return this.pollBridge.detachPendingPollContinuation(...args);
  }

  private stageResolvedAskUserPoll(...args: Parameters<RuntimePollBridgeCoordinator['stageResolvedAskUserPoll']>): ReturnType<RuntimePollBridgeCoordinator['stageResolvedAskUserPoll']> {
    return this.pollBridge.stageResolvedAskUserPoll(...args);
  }

  private consumeQueuedPollDecisions(...args: Parameters<RuntimePollBridgeCoordinator['consumeQueuedPollDecisions']>): ReturnType<RuntimePollBridgeCoordinator['consumeQueuedPollDecisions']> {
    return this.pollBridge.consumeQueuedPollDecisions(...args);
  }

  private rehydratePendingPolls(...args: Parameters<RuntimePollBridgeCoordinator['rehydratePendingPolls']>): ReturnType<RuntimePollBridgeCoordinator['rehydratePendingPolls']> {
    return this.pollBridge.rehydratePendingPolls(...args);
  }

  private startPendingPollExpiry(...args: Parameters<RuntimePollBridgeCoordinator['startPendingPollExpiry']>): ReturnType<RuntimePollBridgeCoordinator['startPendingPollExpiry']> {
    return this.pollBridge.startPendingPollExpiry(...args);
  }

  private handlePendingPollSoftExpiry(...args: Parameters<RuntimePollBridgeCoordinator['handlePendingPollSoftExpiry']>): ReturnType<RuntimePollBridgeCoordinator['handlePendingPollSoftExpiry']> {
    return this.pollBridge.handlePendingPollSoftExpiry(...args);
  }

  private handlePendingPollHardExpiry(...args: Parameters<RuntimePollBridgeCoordinator['handlePendingPollHardExpiry']>): ReturnType<RuntimePollBridgeCoordinator['handlePendingPollHardExpiry']> {
    return this.pollBridge.handlePendingPollHardExpiry(...args);
  }

  private registerSendPollAwaiter(...args: Parameters<RuntimePollBridgeCoordinator['registerSendPollAwaiter']>): ReturnType<RuntimePollBridgeCoordinator['registerSendPollAwaiter']> {
    return this.pollBridge.registerSendPollAwaiter(...args);
  }

  private handleAskUserQuestionAsPoll(...args: Parameters<RuntimePollBridgeCoordinator['handleAskUserQuestionAsPoll']>): ReturnType<RuntimePollBridgeCoordinator['handleAskUserQuestionAsPoll']> {
    return this.pollBridge.handleAskUserQuestionAsPoll(...args);
  }

  private handlePollVoteReceived(...args: Parameters<RuntimePollBridgeCoordinator['handlePollVoteReceived']>): ReturnType<RuntimePollBridgeCoordinator['handlePollVoteReceived']> {
    return this.pollBridge.handlePollVoteReceived(...args);
  }

  private handlePollVoteFailed(...args: Parameters<RuntimePollBridgeCoordinator['handlePollVoteFailed']>): ReturnType<RuntimePollBridgeCoordinator['handlePollVoteFailed']> {
    return this.pollBridge.handlePollVoteFailed(...args);
  }

  public async resolvePollDecisionFromConsole(...args: Parameters<RuntimePollBridgeCoordinator['resolvePollDecisionFromConsole']>): Promise<Awaited<ReturnType<RuntimePollBridgeCoordinator['resolvePollDecisionFromConsole']>>> {
    return this.pollBridge.resolvePollDecisionFromConsole(...args);
  }

  private injectPollAnswers(...args: Parameters<RuntimePollBridgeCoordinator['injectPollAnswers']>): ReturnType<RuntimePollBridgeCoordinator['injectPollAnswers']> {
    return this.pollBridge.injectPollAnswers(...args);
  }

  private async completeConsumedPerChatInbound(
    mapKey: string,
    terminalReason: string,
    runtimeContext?: RuntimeTurnContext,
    scopeRef?: PerChatRuntimeScopeRef,
  ): Promise<void> {
    if (runtimeContext) {
      await this.runtimeTurnCoordinator.finalizeUndispatchedRuntimeTurnAndWait(
        runtimeContext,
        scopeRef,
        { kind: 'suppressed_by_policy' },
      );
      return;
    }
    const seqQueue = this.perChatInboundSeqQueue.get(mapKey);
    const inboundSeq = seqQueue?.shift();
    if (seqQueue && seqQueue.length === 0) {
      this.perChatInboundSeqQueue.delete(mapKey);
    }
    this.chatQueues.get(mapKey)?.setInboundSeq(seqQueue?.[0]);

    if (inboundSeq === undefined) return;
    this.durability?.completeInbound(inboundSeq, terminalReason);
    this.replyGuarantee?.disarm(inboundSeq);
  }

  private markRuntimeFaultContinuityCandidate(inboundSeq: number | undefined): void {
    if (inboundSeq === undefined || !this.durability || !this.replyGuarantee?.isArmed(inboundSeq)) return;
    try {
      this.durability.markContinuityCandidateIfNoTerminalOutbound(
        inboundSeq,
        'runtime_fault_no_terminal_outbound',
        'runtime_fault_disarm',
      );
    } catch (err) {
      log.warn({ err, inboundSeq }, 'failed to mark runtime-fault continuity candidate');
    }
  }


  private async fetchGroupAdminJids(chatJid: string): Promise<Set<string> | null> {
    if (!isGroupJid(chatJid)) return null;
    const cached = this.groupMetadataCache.get(chatJid);
    if (cached && Date.now() - cached.fetchedAt < AgentRuntime.GROUP_METADATA_CACHE_TTL_MS) {
      return cached.adminJids;
    }
    try {
      const connection = this.messenger as ConnectionManager;
      const sock = connection.getSocket();
      if (!sock) return null;
      const metadata = await sock.groupMetadata(chatJid);
      const adminJids = new Set<string>();
      for (const p of metadata.participants) {
        if (p.admin === 'admin' || p.admin === 'superadmin') {
          adminJids.add(jidNormalizedUser(p.id));
        }
      }
      this.groupMetadataCache.set(chatJid, { adminJids, fetchedAt: Date.now() });
      this.capDedupeMap(this.groupMetadataCache, AgentRuntime.GROUP_METADATA_CACHE_MAX);
      return adminJids;
    } catch (err) {
      // QR-036: returns null → callers KEEP the admin gate (fail-closed), they no
      // longer downgrade an admin-gated GROUP poll to first-vote-wins on this error.
      log.warn({ err, chatJid }, 'failed to fetch group metadata — admin-gated polls keep the gate (fail-closed)');
      return null;
    }
  }


  /**
   * Core event handler that operates on explicitly-passed queue and session
   * references rather than shared instance fields. Used by handleEventPerChat
   * so concurrent per_chat events do not overwrite each other's context.
   */
  private handleEventWithContext(
    event: AgentEvent,
    queue: IOutboundQueue,
    session: SessionManager | null,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
    toolScopeKey: string = mapKey ?? GLOBAL_TOOL_SCOPE_KEY,
    isSystemResult: boolean = false,
    systemTurnPurpose: SystemTurnPurpose | null = null,
  ): void {
    const tracker = this.getTracker(mapKey);
    switch (event.type) {
      case 'init':
        log.debug({ sessionId: event.sessionId }, 'session init');
        break;

      case 'assistant_text':
        session?.tickWatchdog();
        tracker?.onAnyActivity();
        // Post-turn gate: suppress assistant_text events that arrive after a result
        // but before the next user message. These are model reactions to SDK-injected
        // system-reminders (e.g., TodoWrite) and must not trigger typing or outbound messages.
        if (mapKey !== undefined && this.postTurnGate.has(mapKey)) {
          log.info({ mapKey, textPreview: providerPreview(event.text, 200) }, 'post-turn gate: suppressed phantom assistant_text');
          break;
        }
        if (this.isSilentCompact(mapKey)) break;

        {
          const rawAssistantText = this.normalizeAssistantTextForDelivery(event, mapKey);
          if (!rawAssistantText) break;
          // Slice-3 NL routing: consume typed intent markers before delivery
          // (flag off → pass-through, byte-identical). Streaming-safe: the
          // first line is buffered across token deltas so a split marker never
          // leaks (R1).
          let normalizedText: string | null;
          if (config.nlRouting) {
            const scanActorJid = mapKey !== undefined ? this.pendingTurnActorJid.get(mapKey) : this.currentTurnReplayActorJid;
            const scanKey = mapKey ?? GLOBAL_TOOL_SCOPE_KEY;
            const held = this.perChatRouteMarkerHold.has(scanKey) ? this.perChatRouteMarkerHold.get(scanKey)! : null;
            const step = this.scanRouteMarkerDelta(held, rawAssistantText, queue.targetChatJid, scanActorJid);
            if (step.held === null) this.perChatRouteMarkerHold.delete(scanKey);
            else this.perChatRouteMarkerHold.set(scanKey, step.held);
            normalizedText = step.deliver;
          } else {
            normalizedText = rawAssistantText;
          }
          if (!normalizedText) break;
          if (this.enqueueAutoSwitchNotice(queue, normalizedText, queue.targetChatJid, 'streaming')) break;
          // Two-tier provider-failure gate (QR-209). Fallback is armed on the
          // terminal 'result' event, never here (activating on streaming text would
          // race the usage-limit session kill/respawn). Only BANNER-confident text
          // (the error itself) is suppressed; AMBIENT prose about an error, and text
          // matching no failure pattern, are delivered — dropping them is the QR-209
          // silent-reply defect. See suppressStreamedProviderFailure.
          const providerFailureCheck = this.suppressStreamedProviderFailure(normalizedText, queue.targetChatJid);
          if (providerFailureCheck.suppress) break;
          const gatedText = this.gateAssistantTextForOutbound(normalizedText, queue, inboundSeq, mapKey);
          this.logAmbientProviderFailureOutcome(providerFailureCheck.ambient, normalizedText, queue.targetChatJid, gatedText !== null);
          normalizedText = gatedText;
          if (!normalizedText) break;
          const markReplayUnsafe = mapKey !== undefined
            && this.pendingSystemResults.count(mapKey) === 0;
          if (config.toolUpdateMode === 'minimal') {
            const committedText = normalizedText;
            queue.enqueueStreamingText(committedText, 'answer', () => {
              if (markReplayUnsafe) {
                this.runtimeTurnCoordinator.markRuntimeTurnReplayUnsafe(mapKey);
              }
              this.replyGuarantee?.notifyActivity(queue.targetChatJid);
              if (mapKey !== undefined) {
                this.perChatTurnText.set(
                  mapKey,
                  (this.perChatTurnText.get(mapKey) ?? '') + committedText,
                );
              }
            });
          } else {
            queue.enqueueStreamingText(normalizedText);
            if (markReplayUnsafe) {
              this.runtimeTurnCoordinator.markRuntimeTurnReplayUnsafe(mapKey);
            }
            // Reply-guarantee: visible output reached the user, so reset the
            // silence window for this chat. The "still working" fallback then
            // only fires after a full window of TRUE silence, not while a long
            // turn is actively streaming replies.
            this.replyGuarantee?.notifyActivity(queue.targetChatJid);
            // Accumulate assistant text for voice reply (SP4)
            if (mapKey !== undefined) {
              this.perChatTurnText.set(mapKey, (this.perChatTurnText.get(mapKey) ?? '') + normalizedText);
            }
          }
        }
        break;

      case 'tool_use':
        session?.trackToolStart(event.toolId);
        session?.tickWatchdog();
        // Post-turn gate: suppress phantom tool_use events (same rationale as assistant_text)
        if (mapKey !== undefined && this.postTurnGate.has(mapKey)) {
          log.info({ mapKey, toolName: event.toolName }, 'post-turn gate: suppressed phantom tool_use');
          break;
        }
        if (this.isSilentCompact(mapKey)) break;

        if (mapKey !== undefined && this.pendingSystemResults.count(mapKey) === 0) {
          const contexts = this.perChatRuntimeTurnContexts.get(mapKey);
          if (contexts?.[0]) contexts[0] = markRuntimeTurnReplayUnsafe(contexts[0]);
        }

        // AskUserQuestion → WhatsApp poll bridge (per_chat mode).
        // Shared mode is excluded — see handleEvent tool_use case for rationale.
        if (event.toolName === 'AskUserQuestion' && mapKey !== undefined) {
          const questions = event.toolInput['questions'];
          if (Array.isArray(questions) && questions.length > 0) {
            // Suppression state (suppressedAskUserToolIds) is registered synchronously
            // inside handleAskUserQuestionAsPoll before any async work, so tool_result
            // suppression is guaranteed even though we fire-and-forget the async poll send.
            void this.handleAskUserQuestionAsPoll(questions, event.toolId, mapKey, queue)
              .catch((err) => log.error({ err, mapKey }, 'AskUserQuestion poll send aborted'));
            break; // skip normal tool_use handling — poll sent instead
          }
        }

        queue.discardPreToolAssistantText?.();

        this.getToolNames(toolScopeKey).set(event.toolId, event.toolName);
        this.turnHadToolActivity.add(toolScopeKey);
        {
          const toolUpdate = buildToolUpdate(event.toolName, event.toolInput ?? {});
          queue.enqueueToolUpdate(toolUpdate);
          tracker?.onToolStart(event.toolId, event.toolName, toolUpdate.category);
        }
        break;

      case 'compact_boundary':
        session?.tickWatchdog();
        tracker?.onAnyActivity();
        this.autoCompact.compactBoundaryScopes.add(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
        if (this.isSilentCompact(mapKey)) {
          log.info({ chatJid: queue.targetChatJid }, 'silent agent compact boundary observed');
          break;
        }
        queue.indicateTyping();
        queue.enqueueText(
          'Context compacted — older details summarized. Restate any important context I should carry forward.',
        );
        break;

      case 'tool_result':
        session?.trackToolEnd(event.toolId);
        session?.tickWatchdog();
        tracker?.onToolEnd(event.toolId);

        // Suppress the auto-resolved "Answer questions?" error for AskUserQuestion
        if (this.suppressedAskUserToolIds.has(event.toolId)) {
          this.suppressedAskUserToolIds.delete(event.toolId);
          log.info({ toolId: event.toolId }, 'suppressed AskUserQuestion auto-resolved tool_result');
          break;
        }

        // Note: tool_result is NOT gated. Phantom tool_use is already blocked,
        // so phantom tool_result cannot arrive. Gating tool_result would break
        // legitimate session-replacement scenarios where two sessions share a mapKey.
        if (this.isSilentCompact(mapKey)) break;
        const toolNames = this.activeToolNames.get(toolScopeKey);
        const trackedToolName = toolNames?.get(event.toolId);
        const resultToolName = event.toolName?.trim() || undefined;
        if (trackedToolName === undefined) {
          this.turnHadToolActivity.add(toolScopeKey);
          if (mapKey !== undefined && this.pendingSystemResults.count(mapKey) === 0) {
            const contexts = this.perChatRuntimeTurnContexts.get(mapKey);
            if (contexts?.[0]) contexts[0] = markRuntimeTurnReplayUnsafe(contexts[0]);
          }
        }
        if (event.isError) {
          const toolName = trackedToolName ?? resultToolName ?? 'unknown';
          const errorPreview = event.content.length > 200 ? `${providerPreview(event.content, 200)}...` : providerPreview(event.content, event.content.length);
          log.warn({ toolId: event.toolId, toolName, error: errorPreview }, 'tool error reported by agent');
          const classification = classifyToolError(toolName, event.content);
          queue.enqueueToolUpdate(classification);
          maybeEmitToolFailureAlert({
            chatJid: queue.targetChatJid,
            toolId: event.toolId,
            toolName,
            content: event.content,
            classification,
            toolScopeKey,
            mapKey,
          }, this.toolFailureAlertDeps());
        }
        toolNames?.delete(event.toolId);
        if (toolNames && toolNames.size === 0) {
          this.activeToolNames.delete(toolScopeKey);
        }
        break;

      case 'result':
        handleScopedRuntimeResult(this.runtimeTurnHost, {
          event,
          queue,
          session,
          conversationKey,
          inboundSeq,
          mapKey,
          toolScopeKey,
          isSystemResult,
          systemTurnPurpose,
          tracker: tracker ?? undefined,
          extractUsageLimitResetTime,
        });
        break;
      case 'token_usage':
        // Record token usage without triggering turn completion.
        // Codex emits thread/tokenUsage/updated mid-turn; the actual turn
        // completion comes from turn/completed → type:'result'.
        if (
          mapKey !== undefined &&
          !this.isSilentCompact(mapKey) &&
          !isSystemResult &&
          this.pendingSystemResults.count(mapKey) === 0
        ) {
          this.recordAutoCompactNextTurnIfNeeded(mapKey, event.inputTokens, false);
        }
        if (event.inputTokens !== undefined || event.outputTokens !== undefined) {
          const rowId = session?.getDbRowId() ?? null;
          if (rowId !== null) {
            const { newInputTokens, cacheReadTokens } = splitInputTokenUsage(event);
            accumulateTokensWithEvent(this.db, rowId, newInputTokens, event.outputTokens ?? 0, cacheReadTokens);
          }
        }
        break;

      case 'unknown_block':
      case 'unknown':
      case 'parse_error':
        log.debug({ event }, 'ignored/unknown_block/unknown/parse_error event');
        break;
    }
  }

  /** Pop and return the pending startup notification (set during resume), or null. */
  popStartupNotificationEvent(): StartupNotificationEvent | null {
    const event = this.pendingStartupEvent;
    this.pendingStartupEvent = null;
    return event;
  }

  getHealthSnapshot(): RuntimeHealth {
    const fallbackState = this.getFallbackState();
    const autoCompactHealth = this.autoCompact.healthSnapshot();
    const providerExecution = this.providerExecutionGate.snapshot();
    const finalizationHealth = this.runtimeTurnSupervisor.health();
    const recoveryHealth = getTurnRecoveryHealthDetails(this.durability);
    const completedDeliveryIdentityAdmissions = this.completedDeliveryIdentityAdmissionHealth();
    const completedDeliveryIdentityDebt = completedDeliveryIdentityAdmissions.unresolvedCount > 0;
    const finalizationDegraded = runtimeTurnRecoveryIsDegraded(finalizationHealth, recoveryHealth);
    // Chats wedged with a session entry no ownership record backs. Read pure
    // here: this snapshot is polled, so the warning sweep stays on the tick.
    const perChatSessionsWithoutOwner = this.perChatSessionsWithoutOwner();
    const turnQueueHealth = this.runtimeTurnCoordinator.turnQueueHaltHealth(this.sessionScope);
    const poisonHealth = this.runtimeTurnCoordinator.outboundQueuePoisonHealth();
    const publicPoisonHealth = {
      outboundQueuePoisoned: poisonHealth.outboundQueuePoisoned,
      outboundQueuePoisonedScopes: poisonHealth.outboundQueuePoisonedScopes,
    };
    // CAR-20 (#2539): current-vs-historical poll-persistence health + offline-decision
    // retry state, surfaced in BOTH health branches below.
    const pollPersistenceHealth = this.pollPersistence.healthDetails();
    const offlineDecisionRetry = this.offlineDecisionRetry.healthDetails();
    // task-21: identity verdict as a status class (+ digest prefixes) and its
    // companion degradedReason, pushed by both branches below.
    const accountIdentity = this.accountIdentityHealth();
    const accountIdentityReasons = accountIdentityDegradedReasons(accountIdentity);
    // Health-detail fields shared verbatim by both session-scope branches below.
    // Computed once here (all inputs are already in scope) and spread into each
    // branch's `details` at the same position, preserving key order and output.
    const sharedHealthDetails = {
      accountIdentity,
      pollPersistenceErrors: this.pollPersistence.errors,
      pollPersistenceHealth,
      offlineDecisionRetry,
      autoCompactIneffective: this.autoCompact.ineffective,
      autoCompactConsecutiveRapidRearmsMax: this.autoCompact.consecutiveRapidRearmsMax,
      autoCompactNextTurnOverThreshold: this.autoCompact.nextTurnOverThreshold,
      autoCompactState: autoCompactHealth.state,
      autoCompactActiveBackoffScopes: autoCompactHealth.activeBackoffScopes,
      autoCompactWorstCurrentBackoffTier: autoCompactHealth.worstCurrentBackoffTier,
      proactiveResumeIdentityRejects: this.proactiveResumeIdentityRejects,
      completedDeliveryIdentityAdmissions,
      restartLoopGuard: {
        enabled: config.restartLoopGuard.enabled,
        ...readRestartLoopGuardHealth(
          restartLoopGuardPath(config.stateRoot),
          config.restartLoopGuard.windowMs,
        ),
      },
      unownedProviderEventRejects: this.unownedProviderEventRejects,
      suppressedSystemTurnEffectRejects: this.suppressedSystemTurnEffectRejects,
      providerEventRejectReasons: Object.fromEntries(this.providerEventRejectReasonCounts),
      perChatSessionsWithoutOwner: perChatSessionsWithoutOwner.length,
      ...this.turnChronology.healthDetails(),
      providerExecution,
      turnFinalizationRetainedRetries: finalizationHealth.retainedRetries,
      turnFinalizationDegradedScopes: finalizationHealth.degradedScopes,
      turnFinalizationRetryAttempts: finalizationHealth.retryAttempts,
      turnFinalizationRetryRecoveries: finalizationHealth.retryRecoveries,
      turnFinalizationRetryExhaustions: finalizationHealth.retryExhaustions,
      ...turnQueueHealth,
      ...publicPoisonHealth,
      ...recoveryHealth,
      ...fallbackState,
    };
    if (this.sessionScope === 'per_chat') {
      const sessions = [...this.chatSessions.values()];
      let activeSessions = 0;
      let lastSessionStatus: string | null = null;
      let lastSessionStartedAt: string | null = null;
      let mostRecentStartMs = -1;
      for (const s of sessions) {
        const st = s.getStatus();
        if (st.active) activeSessions++;
        // Track the most recently started session for lastSession* fields
        if (st.startedAt) {
          const startMs = new Date(st.startedAt).getTime();
          if (startMs > mostRecentStartMs) {
            mostRecentStartMs = startMs;
            lastSessionStatus = st.active ? 'active' : 'idle';
            lastSessionStartedAt = st.startedAt;
          }
        }
      }
      const degradedReasons: string[] = [];
      // Idle per-chat sessions are normal; recent crashes degrade even after map cleanup.
      const recentCrashCount = this.getRecentCrashCount();
      if (recentCrashCount > 0) degradedReasons.push('recent_crashes');
      if (autoCompactHealth.activeBackoffScopes > 0) degradedReasons.push('auto_compact_backoff');
      if (fallbackState.fallbackActiveUntil !== null) degradedReasons.push('provider_fallback_active');
      if (finalizationDegraded) degradedReasons.push('turn_finalization_debt');
      if (completedDeliveryIdentityDebt) degradedReasons.push('completed_delivery_identity_debt');
      // This state rejects every inbound turn in the affected chat and, before
      // the eviction path, did so with no operator-visible signal at all.
      if (perChatSessionsWithoutOwner.length > 0) {
        degradedReasons.push('per_chat_session_without_owner');
      }
      if (turnQueueHealth.turnQueueHalted) degradedReasons.push('turn_queue_halted');
      if (poisonHealth.outboundQueuePoisoned) degradedReasons.push('outbound_queue_poisoned');
      if (providerExecution.pressureActive) degradedReasons.push('provider_execution_pressure');
      if (pollPersistenceHealth.degraded) degradedReasons.push('poll_persistence_failure');
      if (offlineDecisionRetry.exhausted) degradedReasons.push('offline_decision_retry_exhausted');
      degradedReasons.push(...accountIdentityReasons);
      const healthStatus: RuntimeHealth['status'] = degradedReasons.length > 0 ? 'degraded' : 'healthy';
      return {
        status: healthStatus,
        details: {
          degradedReasons,
          activeSessions,
          lastSessionStatus,
          lastSessionStartedAt,
          sessionCount: sessions.length,
          recentCrashes: recentCrashCount,
          lastCrashAt: this.crashes.lastCrashAt,
          ...sharedHealthDetails,
        },
      };
    }

    const status = this.session?.getStatus();
    // If a session exists but its child process is not active, it has crashed
    const degradedReasons: string[] = [];
    if (this.session !== null && status?.active === false) degradedReasons.push('session_inactive');
    if (autoCompactHealth.activeBackoffScopes > 0) degradedReasons.push('auto_compact_backoff');
    if (fallbackState.fallbackActiveUntil !== null) degradedReasons.push('provider_fallback_active');
    if (finalizationDegraded) degradedReasons.push('turn_finalization_debt');
    if (completedDeliveryIdentityDebt) degradedReasons.push('completed_delivery_identity_debt');
    if (providerExecution.pressureActive) degradedReasons.push('provider_execution_pressure');
    if (turnQueueHealth.turnQueueHalted) degradedReasons.push('turn_queue_halted');
    if (poisonHealth.outboundQueuePoisoned) degradedReasons.push('outbound_queue_poisoned');
    if (pollPersistenceHealth.degraded) degradedReasons.push('poll_persistence_failure');
    if (offlineDecisionRetry.exhausted) degradedReasons.push('offline_decision_retry_exhausted');
    degradedReasons.push(...accountIdentityReasons);
    // A halted single/shared queue is the active admission path — unhealthy/503,
    // matching the public-surface contract; every other reason degrades only.
    const healthStatus: RuntimeHealth['status'] =
      turnQueueHealth.turnQueueHalted || poisonHealth.activeAdmissionLaneBlocked
        ? 'unhealthy'
        : degradedReasons.length > 0
          ? 'degraded'
          : 'healthy';
    return {
      status: healthStatus,
      details: {
        degradedReasons,
        active: status?.active ?? false,
        pid: status?.pid ?? null,
        sessionId: status?.sessionId ?? null,
        ...sharedHealthDetails,
      },
    };
  }

  /**
   * Inject a repair turn into the control session for self-healing.
   * Single-flight: if a repair is already in-flight the call returns immediately;
   * the caller (heal.ts) is responsible for queuing subsequent reports.
   */
  async handleControlTurn(reportId: string, payload: string): Promise<void> {
    this.db.assertWritableCompatibility();
    const syntheticJid = 'control@heal.internal';
    try {
      // Only non-sandboxed instances (Q) can run repairs
      if (this.sandboxPerChat || this.sandbox) {
        log.warn({ reportId }, 'handleControlTurn called on sandboxed instance — ignoring');
        return;
      }
      // Single-flight gate
      if (this.activeControlReportId) {
        log.info(
          { reportId, activeReportId: this.activeControlReportId },
          'repair slot occupied — report will be queued by caller',
        );
        return;
      }

      this.activeControlReportId = reportId;

      // Use a workspace at <cwd>/heal/ for the control session
      const controlCwd = this.cwd ? join(this.cwd, 'heal') : join(homedir(), 'heal');
      mkdirSync(controlCwd, { recursive: true, mode: 0o700 });

      // Create or reuse control session
      if (!this.controlSession) {
        const toolScopeKey = this.createToolScopeKey('control@heal.internal');
        let controlSession!: SessionManager;
        controlSession = this.createSessionManager({
          chatJid: syntheticJid,
          cwd: controlCwd,
          onEvent: (event) => this.handleEventPerChat(controlSession, event, toolScopeKey),
          onCrash: (info) => {
            const crashedReportId = this.activeControlReportId ?? reportId;
            log.warn({
              exitCode: info.exitCode,
              signal: info.signal,
              sessionId: info.sessionId,
              reportId: crashedReportId,
            }, 'control session crashed');
            this.releaseControlSession(crashedReportId, controlSession);
          },
          notifyUser: () => {},
          onResumeFailed: () => {},
          eventToolScopeKey: toolScopeKey,
        });
        this.controlSession = controlSession;

        // Use ControlQueue instead of OutboundQueue so output is not forwarded as WhatsApp messages
        const controlQueue = new ControlQueue(syntheticJid, this.messenger);
        this.chatQueues.set(syntheticJid, controlQueue);
        this.chatSessions.set(syntheticJid, this.controlSession);

        // Wire operation tracker for control session
        const controlTracker = this.createOperationTracker(this.controlSession, () => this.chatQueues.get(syntheticJid));
        if (controlTracker) this.operationTrackers.set(syntheticJid, controlTracker);
      }

      // Spawn session if not active
      if (!this.controlSession.getStatus().active) {
        await this.controlSession.spawnSession();
      }

      // Format the turn
      const turn = `[REPAIR REQUEST — report_id: ${reportId}]\n${payload}`;

      await this.controlSession.sendTurn(turn);
      // Start hard timeout — if the control session doesn't resolve within 15 minutes,
      // force-escalate and shut it down to prevent resource exhaustion.
      this.controlSessionTimeout = setTimeout(() => {
        log.warn({ reportId }, 'control session timed out after 15 minutes — force-escalating');

        // Send HEAL_ESCALATE to Loops so its heal state is updated
        const controlQueue = this.getControlQueue();
        const loopsPhone = [...config.controlPeers.entries()].find(([name]) => name === 'loops')?.[1];
        if (controlQueue && loopsPhone) {
          const loopsJid = toPersonalJid(loopsPhone);
          controlQueue.sendControlMessage(loopsJid, 'HEAL_ESCALATE', {
            reportId,
            errorClass: 'timeout',
            diagnosis: 'Repair session timed out after 15 minutes without resolution',
          }, this.durability ?? undefined).catch(err =>
            log.error({ err, reportId }, 'failed to send HEAL_ESCALATE on timeout'));
        }

        // DM admin
        const adminPhone = [...config.adminPhones][0];
        if (adminPhone) {
          const adminJid = resolveConfiguredAdminJid(config.transport, adminPhone);
          sendTracked(this.messenger, adminJid,
            `[HEAL_ESCALATE] Repair for report ${reportId} timed out after 15 minutes.`,
            this.durability ?? undefined, { replayPolicy: 'safe' })
            .catch(err => log.error({ err }, 'failed to DM admin on timeout'));
        }

        const timedOutSession = this.controlSession;
        if (timedOutSession) {
          void this.finishTimedOutControlReport(reportId, timedOutSession);
        }
      }, CONTROL_SESSION_TIMEOUT_MS);
    } catch (err) {
      log.error({ err, reportId }, 'control session failed to start — releasing slot');
      if (this.controlSessionTimeout) {
        clearTimeout(this.controlSessionTimeout);
        this.controlSessionTimeout = null;
      }

      this.activeControlReportId = null;
      this.controlProtocolCompletedReportId = null;
      this.controlTerminalizingReportId = null;
      const controlSession = this.controlSession;
      this.controlSession = null;
      this.chatSessions.delete(syntheticJid);
      this.chatQueues.delete(syntheticJid);
      // QR-094: the control OperationTracker (wired above alongside the session/
      // queue) arms progress/liveness timers. This error path nulls controlSession
      // and deletes its map entries, so the next handleControlTurn RECREATES the
      // tracker and overwrites operationTrackers[syntheticJid] — orphaning the old
      // tracker's armed timers. Shut it down here too, mirroring the per-chat
      // cleanup teardown, so a heal-error-recreate cycle does not leak timers.
      const controlTracker = this.operationTrackers.get(syntheticJid);
      if (controlTracker) {
        controlTracker.shutdown();
        this.operationTrackers.delete(syntheticJid);
      }
      if (controlSession) {
        try {
          await controlSession.shutdown();
        } catch (shutdownErr) {
          log.warn({ shutdownErr, reportId }, 'failed to shutdown control session during error cleanup');
        }
      }
    }
  }

  private async finishTimedOutControlReport(
    reportId: string,
    sourceSession: SessionManager,
  ): Promise<void> {
    try {
      await sourceSession.shutdown(false);
    } catch (err) {
      log.error(
        { err, reportId },
        'timed-out control teardown failed — repair lane remains closed',
      );
      return;
    }
    if (this.activeControlReportId !== reportId || this.controlSession !== sourceSession) return;
    this.releaseControlSession(reportId, sourceSession);
    this.dispatchNextControlReport();
  }

  async handleAgentCommand(request: AgentCommandRequest): Promise<AgentCommandResult> {
    this.db.assertWritableCompatibility();
    if (request.command !== 'compact') {
      throw new AgentCommandRuntimeError(
        'unsupported_command',
        `unsupported agent command: ${String(request.command)}`,
        400,
      );
    }

    const silent = request.silent === true;

    if (this.sessionScope === 'per_chat') {
      if (!request.chatJid) {
        throw new AgentCommandRuntimeError(
          'chat_jid_required',
          'chatJid is required for per_chat agent commands',
          400,
        );
      }

      const mapKey = this.resolvePerChatMapKey(request.chatJid);
      this.assertNoActiveUserTurn(mapKey);
      const session = this.chatSessions.get(mapKey);
      if (!session) {
        throw new AgentCommandRuntimeError(
          'session_not_found',
          `no agent session exists for ${request.chatJid}`,
          404,
        );
      }
      if (!session.getStatus().active) {
        throw new AgentCommandRuntimeError(
          'session_inactive',
          `agent session for ${request.chatJid} is not active`,
          409,
        );
      }

      if (silent) this.beginSilentCompact(mapKey);
      // A manual /compact is a system turn: its result must not consume a user
      // inbound seq or arm the post-turn gate. Mirror the auto-compact path.
      const compactLease = this.markSystemTurn(
        session,
        mapKey,
        silent ? 'manual_compact_silent' : 'manual_compact_notice',
        request.chatJid,
      );
      try {
        await this.waitForSystemTurnQuarantine(mapKey);
        await this.pendingSystemResults.waitUntilDispatchable(mapKey, compactLease);
        await this.dispatchSystemTurn(session, '/compact', compactLease);
      } catch (err) {
        if (silent) this.clearSilentCompact(mapKey);
        await this.settleFailedSystemTurnDispatch(session, mapKey, compactLease, err);
        throw err;
      }

      return { ok: true, command: 'compact', chatJid: request.chatJid, silent };
    }

    const session = this.session;
    if (!session) {
      throw new AgentCommandRuntimeError('session_not_found', 'no agent session exists', 404);
    }
    if (!session.getStatus().active) {
      throw new AgentCommandRuntimeError('session_inactive', 'agent session is not active', 409);
    }

    this.assertNoActiveUserTurn(GLOBAL_TOOL_SCOPE_KEY);
    const targetChatJid = request.chatJid ?? this.activeChatJid;
    if (!targetChatJid || (this.shared && !request.chatJid)) {
      throw new AgentCommandRuntimeError(
        'chat_jid_required',
        'chatJid is required for shared agent commands and for single agent commands without an active chat',
        400,
      );
    }
    if (this.shared) {
      this.ensureOutboundQueue(targetChatJid);
    } else if (!this.queue) {
      throw new AgentCommandRuntimeError('session_queue_not_found', 'agent session has no active outbound queue', 409);
    }

    if (silent) this.beginSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
    this.currentTurnChatJid = targetChatJid;
    this.bindActiveGlobalMcpConversation(targetChatJid);
    // A manual /compact is a system turn: its result must not arm the post-turn
    // gate. Mirror the auto-compact path (single/shared discriminate on this in
    // handleEvent's result case).
    const compactLease = this.markSystemTurn(
      session,
      GLOBAL_TOOL_SCOPE_KEY,
      silent ? 'manual_compact_silent' : 'manual_compact_notice',
      targetChatJid,
    );
    try {
      await this.waitForSystemTurnQuarantine(GLOBAL_TOOL_SCOPE_KEY);
      await this.pendingSystemResults.waitUntilDispatchable(
        GLOBAL_TOOL_SCOPE_KEY,
        compactLease,
      );
      await this.dispatchSystemTurn(session, '/compact', compactLease);
    } catch (err) {
      if (silent) this.clearSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
      this.currentTurnChatJid = null;
      await this.settleFailedSystemTurnDispatch(
        session,
        GLOBAL_TOOL_SCOPE_KEY,
        compactLease,
        err,
      );
      throw err;
    }

    return { ok: true, command: 'compact', chatJid: targetChatJid, silent };
  }

  /** Return the ControlQueue for the control session, or null if none exists. */
  getControlQueue(): ControlQueue | null {
    return (this.chatQueues.get('control@heal.internal') as unknown as ControlQueue) ?? null;
  }

  /** Report ID currently being repaired, or null if no repair is in-flight. */
  get currentControlReportId(): string | null {
    return this.activeControlReportId;
  }

  /** Clear the in-flight repair slot so the next report can be dispatched. */
  clearControlReport(): void {
    this.activeControlReportId = null;
    this.controlProtocolCompletedReportId = null;
    this.controlTerminalizingReportId = null;
  }

  async shutdown(): Promise<void> {
    const shutdownFailures: unknown[] = [];
    const failedPerChatSessions = new Map<string, SessionManager>();
    const recycleShutdownSkipOwners = new Set<SessionManager>();
    let singletonSessionShutdownFailed = false;
    let preserveRuntimeTurnState = false;
    this.shutdownRequested = true;
    log.info({
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
    }, 'AgentRuntime shutting down');
    const startedAt = Date.now();
    const shutdownDeadlineAt = startedAt + RUNTIME_TURN_SHUTDOWN_FINALIZATION_TIMEOUT_MS;

    if (this.controlSessionTimeout) {
      clearTimeout(this.controlSessionTimeout);
      this.controlSessionTimeout = null;
    }

    if (this.healthStatsTimer) {
      clearInterval(this.healthStatsTimer);
      this.healthStatsTimer = null;
    }
    this.workspaceSweeper.stop();
    this.turnRecoveryDeadman.stop();
    // H2: quiesce the recovery scan loop FIRST, before any per-chat teardown
    // below -- stop() clears the scan timer synchronously and blocks
    // scheduleScan from re-arming it, so a scan cannot fire mid-shutdown and
    // dispatch a replay into a session that teardown is tearing down or has
    // already torn down. The later shutdownTurnRecoverySupervisorSafely call
    // still awaits any scan that was ALREADY in flight before this line ran
    // -- that's a different, narrower race this stop() call does not (and
    // cannot) close by itself.
    this.turnRecoverySupervisor.stop();
    this.capabilityObligationRuntime?.stop();
    if (this.queueSweepTimer) {
      clearInterval(this.queueSweepTimer);
      this.queueSweepTimer = null;
    }
    if (this.sessionSweepTimer) {
      clearInterval(this.sessionSweepTimer);
      this.sessionSweepTimer = null;
    }
    if (this.zombieSessionSweepTimer) {
      clearInterval(this.zombieSessionSweepTimer);
      this.zombieSessionSweepTimer = null;
    }
    this.handoffDistill.shutdown();
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
    if (this.fallbackPrimaryProbeTimer) {
      clearTimeout(this.fallbackPrimaryProbeTimer);
      this.fallbackPrimaryProbeTimer = null;
    }
    if (this.periodicUsabilityProbeTimer) { clearTimeout(this.periodicUsabilityProbeTimer); this.periodicUsabilityProbeTimer = null; }
    this.periodicUsabilityProbeDueAt = null;
    this.fallback.stopChainCanary();
    this.fallbackWindow.activeUntil = null;
    this.fallbackWindow.activatedAt = null;
    this.fallbackWindow.armReason = null;
    this.fallbackWindow.resetAt = null;
    this.fallbackWindow.recoveryProbeRequired = false;
    this.fallbackEmptyAdvance.reset();
    for (const timer of this.pendingRespawnTimers) {
      clearTimeout(timer);
    }
    this.pendingRespawnTimers.clear();
    this.postTurnGate.clear();
    for (const mapKey of Array.from(this.pendingPolls.questions.keys())) {
      this.deletePendingPollQuestions(mapKey);
    }
    // Clear silent-compact timers, resolve+clear in-flight waiters, and drop all
    // per-scope auto-compact bookkeeping (cumulative health counters persist).
    this.autoCompact.shutdown();

    try {
      await this.runtimeTurnCoordinator.finalizeActiveRuntimeTurnsForShutdown(shutdownDeadlineAt);
    } catch (err) {
      shutdownFailures.push(err);
      preserveRuntimeTurnState = true;
      log.error({ err }, 'active runtime turns could not finalize during shutdown');
    }
    this.pendingSystemResults.clear();
    if (!preserveRuntimeTurnState) {
      // E20 slice 1 (#3315): the handler join is bounded by the SAME absolute
      // deadline the coordinator above and the recycle lifecycle below honor.
      // A handler that never settles no longer pins shutdown until main.ts's
      // hard kill; it is counted, receipted content-free, and left to E20
      // proper (which will abort it). Turn state is preserved because the
      // blockers may still be mid-turn.
      const drain = await drainMessageHandlersForShutdown(
        [...this.activeMessageHandlers].filter(
          (handler) => !this.routeRecycleCommandWork.has(handler),
        ),
        shutdownDeadlineAt,
      );
      if (drain.timedOut) {
        log.warn(
          { phase: 'message_handlers', blockers: drain.blockers, timedOut: true },
          'message handlers did not drain before the shutdown deadline',
        );
        shutdownFailures.push(new MessageHandlerDrainTimeoutError(drain.blockers));
        preserveRuntimeTurnState = true;
      }
      const rejectedMessageHandlers = drain.settled.filter(
        (item): item is PromiseRejectedResult => item.status === 'rejected',
      );
      if (rejectedMessageHandlers.length > 0) {
        shutdownFailures.push(new AggregateError(
          rejectedMessageHandlers.map((item) => item.reason),
          'message handlers remained unresolved during shutdown',
        ));
        preserveRuntimeTurnState = true;
      }
    }

    try {
      await this.routeRecycleLifecycle.awaitForShutdown(shutdownDeadlineAt);
    } catch (err) {
      shutdownFailures.push(err);
      preserveRuntimeTurnState = true;
      log.error({ err }, 'route recycle lifecycles did not quiesce during shutdown');
      for (const session of this.routeRecycleLifecycle.retainedOwners((scopeKey) =>
        scopeKey === GLOBAL_TOOL_SCOPE_KEY ? this.session ?? undefined : this.chatSessions.get(scopeKey)
      )) {
        recycleShutdownSkipOwners.add(session);
      }
    }
    const recycleFailures = this.routeRecycleLifecycle.takeFailures();
    if (recycleFailures.length > 0) {
      preserveRuntimeTurnState = true;
      for (const failure of recycleFailures) {
        recycleShutdownSkipOwners.add(failure.session);
        shutdownFailures.push(failure.error);
      }
      log.error(
        { failureCount: recycleFailures.length },
        'route recycle lifecycle failed during shutdown',
      );
    }

    // Shutdown per_chat sessions
    let perChatKeys: Set<string> | null = null;
    if (this.sessionScope === 'per_chat') {
      perChatKeys = new Set<string>([
        ...this.chatSessions.keys(),
        ...this.chatQueues.keys(),
        ...this.imageCoalesce.buffers.keys(),
      ]);
    }
    const ownedSessionShutdown = await shutdownOwnedSessions(
      this.sessionLifecycleHost,
      recycleShutdownSkipOwners,
    );
    shutdownFailures.push(...ownedSessionShutdown.failures);
    for (const [mapKey, session] of ownedSessionShutdown.failedPerChatSessions) {
      failedPerChatSessions.set(mapKey, session);
    }
    singletonSessionShutdownFailed = ownedSessionShutdown.singletonSessionShutdownFailed;

    // Session shutdown can synchronously surface a final result or failure.
    // Drain those records while their queues, FIFO maps, and reply guarantee
    // still exist; only then close retry ownership and tear the scopes down.
    try {
      await this.runtimeTurnSupervisor.shutdown();
    } catch (err) {
      shutdownFailures.push(err);
      preserveRuntimeTurnState = true;
      log.error({ err }, 'runtime turn finalizations remained unresolved during shutdown');
    }
    const trErr = await shutdownTurnRecoverySupervisorSafely(this.turnRecoverySupervisor);
    if (trErr) shutdownFailures.push(trErr);
    const coErr = await shutdownCapabilityObligationRuntimeSafely(this.capabilityObligationRuntime);
    if (coErr) shutdownFailures.push(coErr);
    try {
      await this.runtimeTurnCoordinator.awaitUndispatchedCrashFinalizations();
    } catch (err) {
      shutdownFailures.push(err);
      preserveRuntimeTurnState = true;
      log.error({ err }, 'undispatched runtime turns remained unresolved during shutdown');
    }
    try {
      await this.runtimeTurnCoordinator.awaitRejectedRuntimeTurnFinalizations();
    } catch (err) {
      shutdownFailures.push(err);
      preserveRuntimeTurnState = true;
      log.error({ err }, 'rejected runtime turns remained unresolved during shutdown');
    }
    if (!preserveRuntimeTurnState) {
      this.replyGuarantee?.shutdown();
      this.replyGuarantee = null;
    }

    if (perChatKeys && !preserveRuntimeTurnState) {
      for (const [mapKey, session] of [...this.chatSessions]) {
        if (failedPerChatSessions.get(mapKey) === session) continue;
        this.deleteOwnedPerChatSession(mapKey, session);
      }
      for (const [chatJid, queue] of this.chatQueues) {
        try {
          await this.observeOutboundQueueOperation(chatJid, queue, () => queue.shutdown());
        } catch (err) {
          log.warn({ err, chatJid }, 'per_chat queue shutdown failed');
        }
      }
      this.chatQueues.clear();
      for (const mapKey of perChatKeys) {
        const failedOwner = failedPerChatSessions.get(mapKey);
        if (failedOwner && this.chatSessions.get(mapKey) === failedOwner) continue;
        this.cleanupPerChatState(mapKey);
      }
    }

    if (!preserveRuntimeTurnState && this.shared) {
      // Shutdown all per-chat outbound queues
      for (const [chatJid, queue] of this.outboundQueues) {
        try {
          await this.observeOutboundQueueOperation(
            GLOBAL_TOOL_SCOPE_KEY,
            queue,
            () => queue.shutdown(),
          );
        } catch (err) {
          log.warn({ err, chatJid }, 'queue shutdown failed — pending messages may be lost');
        }
      }
      this.outboundQueues.clear();
    } else if (!preserveRuntimeTurnState) {
      if (this.queue) {
        try {
          const queue = this.queue;
          await this.observeOutboundQueueOperation(
            GLOBAL_TOOL_SCOPE_KEY,
            queue,
            () => queue.shutdown(),
          );
        } catch (err) {
          log.warn({ err }, 'queue shutdown failed — pending messages may be lost');
        }
      }
      this.queue = null;
    }

    if (!preserveRuntimeTurnState) {
      if (!singletonSessionShutdownFailed) this.session = null;
      this.activeChatJid = null;
      this.currentTurnChatJid = null;
      this.singletonProviderToolSession = null;
    }

    // Shutdown all operation trackers
    this.operationTracker?.shutdown();
    this.operationTracker = null;
    for (const tracker of this.operationTrackers.values()) {
      tracker.shutdown();
    }
    this.operationTrackers.clear();

    // Stop global socket server
    if (this.globalSocketServer) {
      try {
        this.globalSocketServer.stop();
        log.debug({ instanceName: this.instanceName }, 'global socket server stopped');
      } catch (err) {
        log.warn({ err, instanceName: this.instanceName }, 'global socket server stop failed');
      }
      this.globalSocketServer = null;
      this.globalMcpSocketPath = null;
    }

    // Stop the opt-in egress-allowlist proxy (#1607), if one was started.
    if (this.egressProxy) {
      try {
        await this.egressProxy.close();
        log.debug({ instanceName: this.instanceName }, 'egress-allowlist proxy stopped');
      } catch (err) {
        log.warn({ err, instanceName: this.instanceName }, 'egress-allowlist proxy stop failed');
      }
      this.egressProxy = undefined;
    }

    // Stop workspace-scoped socket servers and media bridges (sandboxPerChat)
    let workspaceSocketServersStopped = 0;
    let workspaceMediaBridgesStopped = 0;
    for (const [conversationKey, res] of this.workspaceResources) {
      if (res.socketServer) {
        try {
          res.socketServer.stop();
          workspaceSocketServersStopped += 1;
        } catch (err) {
          log.warn({ err, conversationKey, socketPath: res.socketPath }, 'workspace socket server stop failed');
        }
      }
      if (res.mediaBridge) {
        try {
          res.mediaBridge();  // MediaBridge handle is a cleanup function
          workspaceMediaBridgesStopped += 1;
        } catch (err) {
          log.warn({ err, conversationKey, workspacePath: res.workspacePath }, 'workspace media bridge stop failed');
        }
      }
    }
    log.info({
      workspaceResourcesStopped: this.workspaceResources.size,
      workspaceSocketServersStopped,
      workspaceMediaBridgesStopped,
    }, 'workspace resources stopped in shutdown');
    this.workspaceResources.clear();

    if (!preserveRuntimeTurnState) {
      for (const mapKey of [...this.imageCoalesce.buffers.keys()]) {
        this.abortImageCoalesceBuffer(mapKey, 'cleanup_aborted');
      }

      this.outboundQueues.clear();
      for (const [mapKey, session] of [...this.chatSessions]) {
        if (failedPerChatSessions.get(mapKey) === session) continue;
        this.deleteOwnedPerChatSession(mapKey, session);
      }
      this.chatQueues.clear();
      this.crashes.clear();
      this.activeToolNames.clear();
      this.turnHadToolActivity.clear();
      this.perChatInboundSeqQueue.clear();
      this.perChatRuntimeTurnContexts.clear();
      this.perChatRuntimeTurnCompletions.clear();
      this.perChatRuntimeTurnScopeRefs.clear();
      this.perChatTurnQueues.clear();
      this.runtimeTurnAfterTerminal.clear();
      this.currentTurnInboundContentType = null;
      this.currentTurnSourceMessageId = null;
      this.currentTurnAssistantText = '';
      this.currentTurnAssistantItemText.clear();
      this.perChatTurnSourceMessageId.clear();
      this.perChatTurnContentType.clear();
      this.perChatTurnText.clear();
      this.perChatTurnSuppressedReplySatisfaction.clear();
      this.perChatAssistantItemText.clear();
      this.pendingTurnText.clear();
      this.pendingTurnActorJid.clear();
      this.pendingTurnPurpose.clear();
      this.currentTurnReplayText = null;
      this.currentTurnReplayActorJid = undefined;
      this.currentTurnReplayPurpose = undefined;
      this.resumeFailedHandling.clear();
      this.imageCoalesce.buffers.clear();
    }

    log.info({
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
      durationMs: Date.now() - startedAt,
      failureCount: shutdownFailures.length,
    }, shutdownFailures.length === 0
      ? 'AgentRuntime shut down'
      : 'AgentRuntime shutdown cleanup completed with failures');
    if (shutdownFailures.length === 1) throw shutdownFailures[0];
    if (shutdownFailures.length > 1) {
      throw new AggregateError(shutdownFailures, 'AgentRuntime shutdown failed');
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Get the currently-active outbound queue.
   * In shared mode: the queue for the current turn's chat (or null if no turn in flight).
   * In non-shared mode: the single queue.
   */
  private getActiveQueue(): IOutboundQueue | null {
    if (this.sessionScope === 'per_chat') {
      // per_chat mode: this.queue is NOT set (shared field removed to fix race).
      // Callers in per_chat mode should use getQueueForChat(chatJid) instead.
      return null;
    }
    if (this.shared) {
      const jid = this.currentTurnChatJid ?? this.activeChatJid;
      return jid ? (this.outboundQueues.get(jid) ?? null) : null;
    }
    return this.queue;
  }

  private getGlobalInterruptChatJid(): string | null {
    return this.currentRuntimeTurnContext?.identity.deliveryJid
      ?? this.pendingSingletonRuntimeTurnContext?.identity.deliveryJid
      ?? this.turnQueue.activeTurn?.chatJid
      ?? this.currentTurnChatJid
      ?? (this.turnQueue.isProcessing ? null : this.activeChatJid);
  }

  private getGlobalInterruptQueue(): IOutboundQueue | null {
    const chatJid = this.getGlobalInterruptChatJid();
    return chatJid === null ? this.getActiveQueue() : this.getQueueForChat(chatJid);
  }

  private resolvePerChatMapKey(chatJid: string): string {
    if (this.sandboxPerChat) {
      return chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey;
    }
    return canonicalizeChatJid(chatJid, this.db);
  }

  private finalizeRuntimeTurnContext(
    args: Parameters<RuntimeTurnCoordinator['finalizeRuntimeTurnContext']>[0],
  ): ReturnType<RuntimeTurnCoordinator['finalizeRuntimeTurnContext']> {
    return this.runtimeTurnCoordinator.finalizeRuntimeTurnContext(args);
  }

  private retryRuntimeTurnFinalizations(): ReturnType<RuntimeTurnCoordinator['retryRuntimeTurnFinalizations']> {
    return this.runtimeTurnCoordinator.retryRuntimeTurnFinalizations();
  }

  private managerIdFor(session: SessionManager): string {
    const existing = this.sessionManagerIds.get(session);
    if (existing) return existing;
    const managerId = randomUUID();
    this.sessionManagerIds.set(session, managerId);
    return managerId;
  }

  private captureSystemTurnOwner(
    session: SessionManager,
    scopeKey: string,
  ): PendingSystemTurnOwner {
    const managerId = this.sessionManagerIds.get(session);
    const toolScopeKey = this.sessionEventToolScopes.get(session);
    if (!managerId || !toolScopeKey) {
      throw new Error('Cannot mark a system turn for an unregistered session manager');
    }
    if (scopeKey === GLOBAL_TOOL_SCOPE_KEY) {
      if (this.session !== session) {
        throw new Error('Cannot mark a global system turn for a non-current session');
      }
      return { managerId, generation: 1, toolScopeKey };
    }
    const owned = this.sessionOwnership.get(scopeKey);
    if (
      this.chatSessions.get(scopeKey) !== session
      || !owned
      || !this.sessionOwnership.isCurrent(scopeKey, managerId, owned.generation)
    ) {
      throw new Error('Cannot mark a per-chat system turn for a non-current session');
    }
    return { managerId, generation: owned.generation, toolScopeKey };
  }

  private publishLegacyProviderTurn(
    session: SessionManager,
    scopeKey: string,
    routeChatJid: string,
  ): LegacyProviderTurnOwner {
    if (this.legacyProviderTurnOwners.has(scopeKey)) {
      throw new Error(`Legacy provider turn already owns scope "${scopeKey}"`);
    }
    const turn = Object.freeze({
      owner: Object.freeze(this.captureSystemTurnOwner(session, scopeKey)),
      routeChatJid,
    });
    this.legacyProviderTurnOwners.set(scopeKey, turn);
    return turn;
  }

  private legacyProviderTurnMatches(
    scopeKey: string,
    managerId: string,
    generation: number,
    toolScopeKey: string,
  ): LegacyProviderTurnOwner | null {
    const turn = this.legacyProviderTurnOwners.get(scopeKey);
    if (
      !turn
      || turn.owner.managerId !== managerId
      || turn.owner.generation !== generation
      || turn.owner.toolScopeKey !== toolScopeKey
    ) return null;
    return turn;
  }

  private clearLegacyProviderTurn(
    scopeKey: string,
    expected?: LegacyProviderTurnOwner,
  ): boolean {
    const current = this.legacyProviderTurnOwners.get(scopeKey);
    if (!current || (expected !== undefined && current !== expected)) return false;
    this.legacyProviderTurnOwners.delete(scopeKey);
    return true;
  }

  private markSystemTurn(
    session: SessionManager,
    scopeKey: string,
    purpose: SystemTurnPurpose,
    routeChatJid?: string,
  ): SystemTurnLeaseToken {
    return markDeferredSystemTurn({
      tracker: this.pendingSystemResults,
      scopeKey,
      purpose,
      owner: this.captureSystemTurnOwner(session, scopeKey),
      ...(routeChatJid !== undefined ? { routeChatJid } : {}),
      timeoutMs: SYSTEM_TURN_TIMEOUT_MS,
      quarantine: async (lease) => {
        const provedClosed = await this.quarantineTimedOutSystemTurn(session, scopeKey, lease);
        if (provedClosed) this.releaseSystemTurnExecutingActorByLease(lease);
        return provedClosed;
      },
    });
  }

  private requireSystemTurnProviderBoundary(lease: SystemTurnLeaseToken): void {
    requireSystemTurnProviderBoundary(this.pendingSystemResults, lease);
  }

  private dispatchSystemTurn(session: SessionManager, text: string, lease: SystemTurnLeaseToken, onBoundary?: () => void): Promise<void> {
    return dispatchProviderTurn(session, text, () => {
      this.requireSystemTurnProviderBoundary(lease); onBoundary?.();
    });
  }

  private setOwnedPerChatSession(mapKey: string, session: SessionManager): void {
    const managerId = this.managerIdFor(session);
    const current = this.sessionOwnership.get(mapKey);
    if (current && current.managerId !== managerId) {
      const previous = this.ownedSessionManagers.get(current.managerId);
      if (previous?.getStatus().active) {
        throw new Error(`Session "${mapKey}" already has a different live owner`);
      }
      this.sessionOwnership.transition(mapKey, current.managerId, 'closing');
      this.sessionOwnership.release(mapKey, current.managerId);
      this.ownedSessionManagers.delete(current.managerId);
    }
    if (!this.sessionOwnership.get(mapKey)) {
      this.sessionOwnership.claim(mapKey, managerId);
    }
    this.ownedSessionManagers.set(managerId, session);
    this.chatSessions.set(mapKey, session);
    session.bindGenerationOwnership(() => {
      const currentMapKey = this.findMapKeyForSession(session);
      if (!currentMapKey) return null;
      const current = this.sessionOwnership.get(currentMapKey);
      if (
        !current ||
        !this.sessionOwnership.isCurrent(currentMapKey, managerId, current.generation)
      ) return null;
      return { managerId, generation: current.generation };
    });
  }

  private clearOwnedRespawnTimer(
    mapKey: string,
    owner: { managerId: string; generation: number; respawnTimer: ReturnType<typeof setTimeout> | null },
  ): void {
    if (owner.respawnTimer === null) return;
    clearTimeout(owner.respawnTimer);
    this.pendingRespawnTimers.delete(owner.respawnTimer);
    this.sessionOwnership.clearRespawnTimer(
      mapKey,
      owner.managerId,
      owner.generation,
      owner.respawnTimer,
    );
  }

  private deleteOwnedPerChatSession(mapKey: string, expected?: SessionManager): boolean {
    const mapped = this.chatSessions.get(mapKey);
    if (expected && mapped !== expected) return false;
    const current = this.sessionOwnership.get(mapKey);
    try {
      if (current) {
        this.clearOwnedRespawnTimer(mapKey, current);
        this.sessionOwnership.transition(mapKey, current.managerId, 'closing');
        this.sessionOwnership.release(mapKey, current.managerId);
        this.ownedSessionManagers.delete(current.managerId);
      }
    } finally {
      // The session-map entry must never outlive its ownership record. A
      // retained entry with no owner is the state that wedges every later turn
      // at the dispatch rebind, so drop it even if the release above threw.
      this.chatSessions.delete(mapKey);
    }
    return mapped !== undefined;
  }

  /**
   * A per-chat session entry is only usable while `sessionOwnership` holds a
   * record naming the mapped session's manager: `rebindRuntimeTurnForDispatch`
   * rejects every turn otherwise. Treat a violation as a stale entry and drop
   * it, so the caller re-spawns and re-claims instead of wedging forever.
   *
   * Fail closed in three cases. A published runtime-turn context means a turn
   * in this chat is still in flight and still needs the entry, so eviction
   * waits. A child that is not provably gone could still be running, and
   * detaching it would let the spawn start a second one. The heal control
   * session is deliberately mapped without an ownership record and is never
   * dispatched through this path (the wedged-lane sweep carries the same
   * guard), so it is not a violation.
   */
  private evictUnownedPerChatSession(mapKey: string, session: SessionManager): boolean {
    if (!this.isPerChatSessionWithoutOwner(mapKey, session)) return false;
    if ((this.perChatRuntimeTurnContexts.get(mapKey)?.length ?? 0) > 0) return false;
    // Fail closed unless the child is PROVABLY gone. A cleared `active` flag
    // alone is not that proof: `SessionManager.shutdown` clears it before it
    // kills the child, and `resetFailedSessionStart` clears it while
    // deliberately retaining a child whose kill failed. Use the file's own
    // provably-dead idiom instead — cleared flag AND no pid — because
    // detaching a live child would let the spawn below run a second child for
    // one conversation. The state this exists to recover is an exited child,
    // so the recovery still lands; anything less certain stays wedged, and
    // stays reported by the sweep.
    const status = session.getStatus();
    if (status.active || status.pid !== null) return false;
    log.warn(
      { mapKey, hasOwner: this.sessionOwnership.get(mapKey) !== undefined },
      'per-chat session entry has no current dispatch owner — evicting the stale entry so the next turn respawns',
    );
    // The replacement overwrites this chat's outbound queue and operation
    // tracker unconditionally, so retire the current pair rather than orphan
    // it — an abandoned tracker keeps its armed timers running (QR-094).
    const tracker = this.operationTrackers.get(mapKey);
    tracker?.shutdown();
    this.operationTrackers.delete(mapKey);
    this.chatQueues.get(mapKey)?.abortTurn();
    this.chatQueues.delete(mapKey);
    // Deliberately NOT cleanupPerChatState: unlike idle eviction, this runs at
    // the head of a turn that is about to be dispatched, and that helper drops
    // the in-flight turn's journal seq and pending text. Detaching to exactly
    // the state the ordinary "no active session" spawn path expects is the
    // point — that path also runs with this turn's state already set.
    this.deleteOwnedPerChatSession(mapKey, session);
    return true;
  }

  /** True when this chat holds a session entry no ownership record backs. */
  private isPerChatSessionWithoutOwner(mapKey: string, session: SessionManager): boolean {
    if (session === this.controlSession) return false;
    const owner = this.sessionOwnership.get(mapKey);
    // Read the manager id rather than minting one: `managerIdFor` assigns an id
    // as a side effect, which a predicate must not do.
    return owner === undefined || owner.managerId !== this.sessionManagerIds.get(session);
  }

  /**
   * Chats holding a session entry with no current dispatch owner — a state
   * that should be impossible and that silently rejects every inbound turn in
   * the affected chat. Pure, so the polled health snapshot can read it without
   * emitting a log line per poll.
   */
  private perChatSessionsWithoutOwner(): string[] {
    const unowned: string[] = [];
    for (const [mapKey, session] of this.chatSessions) {
      if (this.isPerChatSessionWithoutOwner(mapKey, session)) unowned.push(mapKey);
    }
    return unowned;
  }

  /** Periodic sweep: report the impossible state. Health tick only. */
  private sweepPerChatSessionsWithoutOwner(): number {
    const unowned = this.perChatSessionsWithoutOwner();
    for (const mapKey of unowned) {
      log.warn(
        { mapKey, hasOwner: this.sessionOwnership.get(mapKey) !== undefined },
        'per-chat session entry has no current dispatch owner — turns in this chat are rejected until it is evicted',
      );
    }
    return unowned.length;
  }

  private rekeyOwnedPerChatSession(fromMapKey: string, toMapKey: string, session: SessionManager): void {
    const managerId = this.managerIdFor(session);
    if (this.chatSessions.get(fromMapKey) !== session) {
      throw new Error(`Cannot rekey unowned per-chat session "${fromMapKey}"`);
    }
    this.sessionOwnership.rekey(fromMapKey, toMapKey, managerId);
    this.chatSessions.delete(fromMapKey);
    this.chatSessions.set(toMapKey, session);
  }

  private captureOwnedPerChatGeneration(
    mapKey: string,
    session: SessionManager,
  ): { managerId: string; generation: number } {
    const managerId = this.managerIdFor(session);
    const owner = this.sessionOwnership.get(mapKey);
    if (
      this.chatSessions.get(mapKey) !== session ||
      !owner ||
      !this.sessionOwnership.isCurrent(mapKey, managerId, owner.generation)
    ) {
      throw new Error(`Cannot spawn unowned per-chat session "${mapKey}"`);
    }
    return { managerId, generation: owner.generation };
  }

  private markOwnedPerChatSessionActive(
    initialMapKey: string,
    session: SessionManager,
    expected: { managerId: string; generation: number },
  ): string {
    const mapKey = this.findMapKeyForSession(session, initialMapKey);
    const owner = mapKey ? this.sessionOwnership.get(mapKey) : undefined;
    if (
      !mapKey ||
      this.managerIdFor(session) !== expected.managerId ||
      !owner ||
      !this.sessionOwnership.isCurrent(mapKey, expected.managerId, expected.generation)
    ) {
      throw new Error(`Cannot activate superseded per-chat session "${initialMapKey}"`);
    }
    if (owner.state !== 'active') {
      this.sessionOwnership.transition(mapKey, expected.managerId, 'active');
    }
    return mapKey;
  }

  private async activateSpawnedOwnedPerChatSession(
    mapKey: string,
    session: SessionManager,
    expected: { managerId: string; generation: number },
  ): Promise<string> {
    const spawnedPid = session.getStatus().pid;
    try {
      return this.markOwnedPerChatSessionActive(mapKey, session, expected);
    } catch (err) {
      const cleanupFailures: unknown[] = [];
      let shutdownProvedTreeEmpty = false;
      try {
        await session.shutdown(false);
        shutdownProvedTreeEmpty = true;
      } catch (cleanupErr) {
        cleanupFailures.push(cleanupErr);
      }
      if (!shutdownProvedTreeEmpty) {
        try {
          await this.terminateKnownProcesses([spawnedPid, session.getStatus().pid]);
        } catch (cleanupErr) {
          cleanupFailures.push(cleanupErr);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [err, ...cleanupFailures],
          `Spawned per-chat session "${mapKey}" lost ownership and cleanup failed`,
        );
      }
      throw err;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw err;
    }
  }

  private async awaitProcessExit(pid: number | null, timeoutMs = 6_000): Promise<void> {
    if (pid === null) return;
    const deadline = Date.now() + timeoutMs;
    while (this.isProcessAlive(pid)) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for prior session process ${pid} to exit`);
      }
      await sleep(25);
    }
  }

  private async terminateKnownProcess(pid: number): Promise<void> {
    await killSessionTree(pid, 'SIGTERM', {
      generationMarker: `ownership-loss:${pid}:${randomUUID()}`,
    });
  }

  private async terminateKnownProcesses(pids: Array<number | null>): Promise<void> {
    const failures: unknown[] = [];
    for (const pid of new Set(pids.filter((value): value is number => value !== null))) {
      try {
        if (!this.isProcessAlive(pid)) continue;
        await this.terminateKnownProcess(pid);
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Unable to prove all session processes terminated');
    }
  }

  private async resetOwnedPerChatSession(
    mapKey: string,
    chatJid: string,
    session: SessionManager,
  ): Promise<void> {
    const managerId = this.managerIdFor(session);
    const owner = this.sessionOwnership.get(mapKey);
    if (this.chatSessions.get(mapKey) !== session || owner?.managerId !== managerId) {
      throw new Error(`Cannot reset unowned per-chat session "${mapKey}"`);
    }

    this.clearOwnedRespawnTimer(mapKey, owner);
    this.sessionOwnership.transition(mapKey, managerId, 'resetting');
    this.getQueueForChat(chatJid, mapKey)?.abortTurn();
    const oldPid = session.getStatus().pid;
    const generation = this.sessionOwnership.advanceGeneration(mapKey, managerId);
    let replacementPid: number | null = null;
    let oldTreeProvedEmpty = false;

    try {
      await this.waitForRejectedTerminalTeardown(session);
      await session.shutdown(false);
      this.rejectedTerminalTeardowns.delete(session);
      oldTreeProvedEmpty = true;
      await this.awaitProcessExit(oldPid);

      if (
        this.chatSessions.get(mapKey) !== session ||
        !this.sessionOwnership.isCurrent(mapKey, managerId, generation)
      ) {
        throw new Error(`Per-chat session "${mapKey}" lost ownership during reset shutdown`);
      }

      this.cleanupPerChatGenerationState(mapKey);
      this.chatQueues.delete(mapKey);
      this.chatQueues.set(mapKey, this.createOutboundQueue(chatJid, '/new per-chat replacement'));
      const tracker = this.createOperationTracker(session, () => this.chatQueues.get(mapKey));
      if (tracker) this.operationTrackers.set(mapKey, tracker);

      await session.spawnSession();
      replacementPid = session.getStatus().pid;
      if (
        this.chatSessions.get(mapKey) !== session ||
        !this.sessionOwnership.isCurrent(mapKey, managerId, generation)
      ) {
        throw new Error(`Per-chat session "${mapKey}" lost ownership during reset`);
      }
      this.sessionOwnership.transition(mapKey, managerId, 'active');
    } catch (err) {
      const knownPids = [
        ...(oldTreeProvedEmpty ? [] : [oldPid]),
        replacementPid,
        session.getStatus().pid,
      ];
      let cleanupError: unknown = null;
      try {
        await this.terminateKnownProcesses(knownPids);
      } catch (cleanupErr) {
        cleanupError = cleanupErr;
      }

      let allKnownProcessesDead = cleanupError === null;
      if (allKnownProcessesDead) {
        try {
          allKnownProcessesDead = knownPids.every((pid) => pid === null || !this.isProcessAlive(pid));
        } catch (probeErr) {
          cleanupError = probeErr;
          allKnownProcessesDead = false;
        }
      }

      if (this.sessionOwnership.isCurrent(mapKey, managerId, generation)) {
        this.sessionOwnership.transition(
          mapKey,
          managerId,
          allKnownProcessesDead ? 'recoverable_dead' : 'closing',
        );
      }
      if (cleanupError !== null) {
        throw new AggregateError([err, cleanupError], `Failed to reset and clean up per-chat session "${mapKey}"`);
      }
      throw err;
    }
  }

  private removeFailedExecutingActor(
    mapKey: string,
    actorJid: string | undefined,
    systemTurnLease?: SystemTurnLeaseToken,
  ): void {
    if (systemTurnLease) this.systemTurnExecActors.delete(systemTurnLease.id);
    const queue = this.perChatExecActorQueue.get(mapKey);
    if (!queue) return;
    if (queue.at(-1)?.actorJid === actorJid) queue.pop();
    else {
      log.error({ mapKey }, 'executing actor FIFO drift on failed dispatch — clearing fail-closed');
      queue.length = 0;
    }
    if (queue.length === 0) this.perChatExecActorQueue.delete(mapKey);
  }

  private releaseSystemTurnExecutingActor(systemTurn: PendingSystemTurnSnapshot): void {
    this.releaseSystemTurnExecutingActorByLease(systemTurn.lease);
  }

  private releaseSystemTurnExecutingActorByLease(lease: SystemTurnLeaseToken): void {
    const binding = this.systemTurnExecActors.get(lease.id);
    if (!binding) return;
    this.systemTurnExecActors.delete(lease.id);
    const queue = this.perChatExecActorQueue.get(binding.scopeKey);
    if (!queue) return;
    if (queue[0]?.actorJid === binding.actorJid) queue.shift();
    else {
      log.error(
        { scopeKey: binding.scopeKey, leaseId: lease.id },
        'system executing actor FIFO drift — clearing fail-closed',
      );
      queue.length = 0;
    }
    if (queue.length === 0) this.perChatExecActorQueue.delete(binding.scopeKey);
  }

  private clearSystemTurnExecutingActors(scopeKey: string): void {
    for (const [leaseId, binding] of this.systemTurnExecActors) {
      if (binding.scopeKey === scopeKey) this.systemTurnExecActors.delete(leaseId);
    }
  }

  /**
   * F-STICKY-ACTOR (QR-245): resolve the actor for a per-chat socket tool call
   * at read time = the actor of the turn the subprocess is CURRENTLY executing
   * (queue HEAD). Fail-closed: no live active session or empty queue -> undefined,
   * which the sensitive-tool gate denies. Non-blocking (sync map/status reads).
   * Re-derives mapKey each call so it is transparent to LID rekey.
   */
  private resolveExecutingActorByMapKey(mapKey: string): string | undefined {
    return this.resolveExecutingSessionByMapKey(mapKey).actorJid;
  }

  private resolveExecutingSessionByMapKey(mapKey: string): ExecutingSessionContext {
    const session = this.chatSessions.get(mapKey);
    if (!session || !session.getStatus().active) {
      return { actorJid: undefined, purpose: undefined, conversationKey: undefined };
    }
    return this.perChatExecActorQueue.get(mapKey)?.[0]
      ?? { actorJid: undefined, purpose: undefined, conversationKey: undefined };
  }

  private resolveExecutingActor(chatJid: string): string | undefined {
    return resolveExecutingActorForPort(this.chatTransportHost, chatJid);
  }

  /**
   * #2976 direction (ii): read-time actor resolution for the GLOBAL socket.
   * Returns the currently EXECUTING single/shared turn's sender, or undefined
   * (fail-closed deny) when no turn executes, the session is down, or the
   * runtime is per_chat scope (whose senders ride per-chat actor sockets).
   */
  private resolveExecutingGlobalActor(): string | undefined {
    return this.resolveExecutingGlobalSession().actorJid;
  }

  private resolveExecutingGlobalSession(): ExecutingSessionContext {
    if (this.sessionScope === 'per_chat') {
      return { actorJid: undefined, purpose: undefined, conversationKey: undefined };
    }
    if (!this.session?.getStatus().active) {
      return { actorJid: undefined, purpose: undefined, conversationKey: undefined };
    }
    return this.perChatExecActorQueue.get(GLOBAL_TOOL_SCOPE_KEY)?.[0]
      ?? { actorJid: undefined, purpose: undefined, conversationKey: undefined };
  }

  private sessionUsesPerChatActorSocket(session: SessionManager): boolean {
    if (this.sessionScope !== 'per_chat' || this.sandboxPerChat) return false;
    const provider = session.getProviderId();
    return providerUsesWhatSoupMcp(provider);
  }

  /**
   * #2976 residual: managed-loop (API) providers advertise/execute WhatSoup
   * tools through the in-process provider MCP bridge (createProviderMcpBridge),
   * never a stdio-proxy socket. They therefore never wire a per-chat actor
   * socket, so in per_chat scope their executing turn's actor was NOT published
   * to the actor register — the bridge fell back to the stored session's stale
   * actorJid. Detect the bridge sessions so the provider boundary publishes
   * their actor into the same per-chat register (retired by the coordinator
   * post-effects seam) and the bridge resolver can read it at request time.
   */
  private sessionUsesInProcessBridge(session: SessionManager): boolean {
    const provider = session.getProviderId();
    return isProviderId(provider) && executionModeForProvider(provider) === 'managed_loop';
  }

  private wirePerChatActorSocket(chatJid: string, provider: string, mapKeyOverride?: string):
    | { mcpSocketPath?: string; providerTransitionReady: Promise<void> }
    | undefined {
    return wirePerChatActorSocketForPort(this.chatTransportHost, chatJid, provider, mapKeyOverride);
  }

  private teardownPerChatActorSocket(mapKey: string): void {
    teardownPerChatActorSocketForPort(this.chatTransportHost, mapKey);
  }

  private findMapKeyForSession(session: SessionManager | undefined, fallbackMapKey?: string): string | null {
    return findMapKeyForSessionForPort(this.chatTransportHost, session, fallbackMapKey);
  }

  private getQueueForChat(chatJid: string, mapKey?: string): IOutboundQueue | null {
    return getQueueForChatForPort(this.chatTransportHost, chatJid, mapKey);
  }

  private createOperationTracker(
    session: SessionManager,
    resolveQueue: () => IOutboundQueue | null | undefined,
  ): OperationTracker | null {
    return createOperationTrackerForPort(this.chatTransportHost, session, resolveQueue);
  }

  private getTracker(mapKey?: string): OperationTracker | null {
    return getTrackerForPort(this.chatTransportHost, mapKey);
  }

  // #2981 car-A SHIM — fire-and-forget wrapper. The free function now returns
  // Promise<boolean> but this method's callers (53 sites) still expect void.
  // Car-C deletes this shim and propagates the boolean to F2a consumers.
  // Tracking marker: #2981-SHIM-RUNTIME-SENDDIRECT
  private sendDirect(chatJid: string, text: string, bypassEchoGuard = false): void {
    void sendDirectForPort(this.chatTransportHost, chatJid, text, bypassEchoGuard);
  }

  /**
   * Id-bearing direct send (#2981 car-B): returns the SendDirectOutcome
   * envelope so reply-threading consumers (F2a #2121) can reference the sent
   * message. The void shim above stays for the legacy fire-and-forget sites.
   */
  sendDirectWithReceipt(chatJid: string, text: string, bypassEchoGuard = false): Promise<SendDirectOutcome> {
    return sendDirectWithReceiptForPort(this.chatTransportHost, chatJid, text, bypassEchoGuard);
  }

  // ---------------------------------------------------------------------------
  // Routing + model preference (#1977 D1) — extracted to runtime-routing.ts.
  // The delegators below keep the runtime's externally-reached entry points
  // under their existing names (host-port factories and characterization
  // suites reach them here); all other routing internals live on the
  // coordinator behind RuntimeRoutingPort.
  // ---------------------------------------------------------------------------

  /** Per-spawn route resolution — delegates to the routing coordinator (#1977 D1). */
  private resolveRouteForTurn(
    chatJid: string,
    actorJid?: string,
  ): RouteDecision & { pinnedProvider: string | null } {
    return this.routing.resolveRouteForTurn(chatJid, actorJid);
  }

  /** Route-decided session provider config — delegates to the routing coordinator (#1977 D1). */
  private routeSessionProviderConfig(route: RouteDecision): Record<string, unknown> | undefined {
    return this.routing.routeSessionProviderConfig(route);
  }

  /** Spawn-time route bookkeeping — delegates to the routing coordinator (#1977 D1). */
  private noteRouteAtSpawn(
    chatJid: string,
    conversationKey: string,
    route: RouteDecision & { pinnedProvider: string | null },
  ): void {
    this.routing.noteRouteAtSpawn(chatJid, conversationKey, route);
  }

  private emitRouteEventChecked(ev: Omit<ModelRouteEvent, 'ts' | 'instance' | 'chatScope' | 'authority'>): void {
    this.routing.emitRouteEventChecked(ev);
  }

  /**
   * Task G (D14) route recycle — delegates to the routing coordinator. Kept as
   * a named private method because /reset and the recycle characterization
   * suite both reach it by name.
   */
  private async applyRouteChangeAndRecycle(
    chatJid: string,
    senderJid: string,
    perChatMapKey: string | undefined,
  ): Promise<RouteRecycleOutcome> {
    return this.routing.applyRouteChangeAndRecycle(chatJid, senderJid, perChatMapKey);
  }

  /** Streaming route-marker scan — delegates to the routing coordinator (#1977 D1). */
  private scanRouteMarkerDelta(
    held: string | null,
    text: string,
    chatJid: string,
    actorJid: string | undefined,
  ): { deliver: string | null; held: string | null } {
    return this.routing.scanRouteMarkerDelta(held, text, chatJid, actorJid);
  }

  /**
   * Providers this instance can actually route to: the configured primary
   * plus the configured fallback chain, minus entries whose key service
   * resolves but has no credential (same probe the fallback selector uses).
   * A pin outside this set could only be honored by silent impersonation —
   * strict pins never silently fall back — so it is rejected at SET time (F07).
   *
   * Stays on AgentRuntime (not the routing coordinator, #1977 D1): it is the
   * credential-probe seam the characterization suites stub as an instance
   * property, and isEntryCredentialed below is shared with the fallback
   * selector's eligibility loop. The coordinator reaches both via its port.
   */
  private routablePinTargets(): string[] {
    // The primary is unconditionally routable — it is the provider serving
    // the instance right now; a credential probe must never filter it (an
    // API-primary instance would otherwise reject pins to its own route).
    const targets: string[] = [this.agentProvider];
    for (const entry of this.agentFallbacks) {
      if (targets.includes(entry.provider)) continue;
      if (!this.isEntryCredentialed(entry)) continue;
      targets.push(entry.provider);
    }
    return targets;
  }

  /**
   * Single credential-presence predicate for a fallback entry (C4): true when
   * the entry's key service resolves to a present credential, or when no key
   * service maps (native-auth CLI). Shared by routablePinTargets (pin
   * eligibility) and the fallback selector's eligibility loop so the two can
   * never silently desync — the fallback selector keeps its own service/alert
   * bookkeeping, but the eligibility DECISION lives here alone.
   */
  private isEntryCredentialed(entry: AgentFallbackEntry): boolean {
    // INVARIANT this return depends on: `AgentFallbackEntry` carries no auth of
    // its own (it is `{provider, model}`; `fallbackProviderConfigFor` returns the
    // PRIMARY's config by identity for a same-provider entry). So a same-provider
    // tier shares the primary's credential and inherits its unconditional
    // routability rather than being re-checked — re-checking would de-route a
    // tier whose own primary is still routing on the same credential. If an
    // auth-bearing field is ever added to the entry, this inherit becomes a
    // silent under-exclude and must be conditioned on "no entry-level auth
    // override", not provider equality alone. F07: cross-provider entries (which
    // DO carry a distinct credential) read the unified accessor
    // (eligibility projection) — replacing the old presence-only `service ?
    // lookup : true` that treated null-service providers as always credentialed;
    // now a cross-provider claude-cli fallback's expired-no-refresh OAuth is
    // de-routed, while codex/gemini stay `native` → routable.
    if (entry.provider === this.agentProvider) return true;
    return isProviderRoutable(
      resolveProviderCredentialState({
        provider: entry.provider,
        model: entry.model,
        providerConfig: fallbackProviderConfigFor(entry.provider, this.agentProvider, this.agentProviderConfig),
      }),
    );
  }

  /**
   * Provider routing for the *next* session. While a fallback window is active
   * (and a fallback provider is configured), new sessions use the fallback
   * provider/model; otherwise the primary. Existing sessions are unaffected —
   * `SessionManager.provider`/`model` are per-session and read-only, so fallback
   * takes effect on the next auto-respawned or freshly created session.
   */
  private get effectiveProvider(): string {
    const fallbackEntry = this.effectiveFallbackEntry;
    return fallbackEntry
      ? fallbackEntry.provider
      : this.agentProvider;
  }

  /** True while a fallback window is armed and not yet expired. */
  private get isFallbackWindowActive(): boolean {
    return this.fallbackWindow.isActive();
  }

  private isCrossProviderSession(session: SessionManager): boolean {
    return session.getProviderId() !== this.agentProvider;
  }

  /**
   * True when a live manager's FROZEN provider/model still matches the route a
   * NEW session would resolve right now. A manager's provider is fixed at
   * construction and the session-map hit never re-resolves the route, so after
   * a fallback window transition (arm / chain advance / revert) existing
   * managers can silently keep serving the OLD route — live-proven 2026-08-15:
   * turns (including a fresh /new) kept arming the dead fallback for 7+
   * minutes after "reverting to primary provider". Model is compared only
   * against an active fallback entry's explicit model (same-provider chains
   * like opencode kimi→glm differ only by model); with no window active the
   * primary comparison is provider-only.
   */
  private sessionMatchesCurrentRoute(session: SessionManager, chatJid?: string): boolean {
    const provider = typeof session.getProviderId === 'function' ? session.getProviderId() : null;
    if (provider === null) return true; // unattributable — never block on a guess
    const entry = this.effectiveFallbackEntry;
    if (entry) {
      // Window active: anything not serving the armed entry is stale — a
      // PRIMARY manager (would immediately re-hit the failed primary) or a
      // dead prior chain entry after an advance.
      if (provider !== entry.provider) return false;
      if (entry.model === undefined) return true;
      const model = typeof session.getModelRef === 'function' ? session.getModelRef() : null;
      return model === null || model === entry.model;
    }
    // No window: retire ONLY a manager stranded on a CONFIGURED FALLBACK
    // provider (the post-revert remnant this incident proved). Anything else —
    // the primary, per-chat pinned providers, test scaffolds — is not this
    // guard's to retire; being over-broad here blocked legitimate respawns.
    if (!this.agentFallbacks.some((candidate) => candidate.provider === provider)) return true;
    // A per-chat pin can legitimately route a chat onto a fallback-listed
    // provider — honor the resolved route before declaring the manager stale.
    if (chatJid) {
      try {
        if (this.resolveRouteForTurn(chatJid, undefined).provider === provider) return true;
      } catch (err) {
        log.debug({ err, chatJid }, 'route resolution failed during currency check — falling back to primary compare');
      }
    }
    return provider === this.agentProvider;
  }

  /**
   * After a fallback window transition, mark every live manager whose frozen
   * route went stale for the deferred route recycle (Task G machinery): the
   * pending flag is consumed at the next turn-idle boundary, which detaches
   * the idle manager so ensureSessionAndQueueSync rebuilds it on the current
   * route. Never touches a busy manager — the consumption site enforces idle.
   */
  private schedulePostTransitionRouteRecycles(): void {
    if (this.sessionScope === 'per_chat') {
      for (const [mapKey, session] of this.chatSessions) {
        const deliveryJid = this.chatQueues.get(mapKey)?.targetChatJid;
        if (!this.sessionMatchesCurrentRoute(session, deliveryJid)) {
          this.pendingRecycle.add(mapKey);
          log.info({ mapKey, sessionProvider: session.getProviderId?.() }, 'route transition left manager stale — recycle pended');
        }
      }
      return;
    }
    if (this.session && !this.sessionMatchesCurrentRoute(this.session, this.activeChatJid ?? undefined)) {
      this.pendingRecycle.add(GLOBAL_TOOL_SCOPE_KEY);
      log.info({ sessionProvider: this.session.getProviderId?.() }, 'route transition left singleton manager stale — recycle pended');
    }
  }

  private get effectiveFallbackEntry(): AgentFallbackEntry | null {
    if (!this.isFallbackWindowActive) return null;
    return this.fallbackWindow.activeEntry ?? this.agentFallbacks[0] ?? null;
  }

  /**
   * TTL-memoised resolver for idle (pre-selection) fallback eligibility. Built
   * lazily so the keyring is consulted at most once per entry per TTL even though
   * getFallbackState backs the frequently-polled /health endpoint.
   */
  private idleFallbackEligibilityResolver?: (entry: AgentFallbackEntry) => boolean | null;

  // ---------------------------------------------------------------------------
  // Provider fallback core (#1977 D2) — extracted to runtime-fallback.ts.
  // Public Runtime-interface surface and the deactivation spy seam stay here
  // as named delegators; everything else lives on the coordinator behind
  // RuntimeFallbackPort.
  // ---------------------------------------------------------------------------

  getFallbackState(): ReturnType<RuntimeFallbackCoordinator['getFallbackState']> {
    return this.fallback.getFallbackState();
  }

  forceFallback(durationMs?: number): ReturnType<RuntimeFallbackCoordinator['forceFallback']> {
    return this.fallback.forceFallback(durationMs);
  }

  disableFallback(): { ok: true } {
    return this.fallback.disableFallback();
  }

  /** Named seam: fallback-probe suites spy this method on the runtime instance;
   *  coordinator-internal callers route through the host so the spy sees them. */
  private deactivateProviderFallback(reason: string, receipt: FallbackRecoveryReceipt | null = null): void {
    this.fallback.deactivateProviderFallback(reason, receipt);
  }

  /**
   * Test-seam delegator (no production callers — the fallback suites reach it
   * through the runtime-view cast). Routes through the tier-aware
   * activateProviderFallbackForSession so the failing session, when one
   * exists, is REQUIRED at the signature: a future runtime-internal caller
   * cannot silently derive the primary tier by omitting it. Passing null
   * states "no session evidence" explicitly (primary tier).
   */
  private activateProviderFallback(
    resetAt: Date | null,
    reason: ProviderFallbackReason,
    failedSession: SessionManager | null,
  ): ReturnType<RuntimeFallbackCoordinator['activateProviderFallbackForSession']> {
    return this.fallback.activateProviderFallbackForSession(resetAt, reason ?? 'usage-limit', failedSession ?? null);
  }

  private armFallbackWindow(until: number, reason: string, activatedAt?: number, opts?: { restored?: boolean }): boolean {
    return this.fallback.armFallbackWindow(until, reason, activatedAt, opts);
  }

  private restorePersistedFallbackWindow(): void {
    this.fallback.restorePersistedFallbackWindow();
  }

  private recordFallbackTurnOutcome(
    queue: IOutboundQueue,
    hadVisibleOutput: boolean,
    hadToolWork: boolean = false,
    session: SessionManager | null = null,
    wasUnclassifiedError: boolean = false,
  ): void {
    this.fallback.recordFallbackTurnOutcome(queue, hadVisibleOutput, hadToolWork, session, wasUnclassifiedError);
  }

  private fallbackKeyPresent(provider: string | undefined, model: string | undefined): boolean | null {
    return this.fallback.fallbackKeyPresent(provider, model);
  }

  private usageLimitNotice(): string {
    return this.fallback.usageLimitNotice();
  }

  private emitNoFallbackReauthNotice(queue: IOutboundQueue): void {
    this.fallback.emitNoFallbackReauthNotice(queue);
  }
  getMcpLivenessSnapshot(): {
    pendingCount: number;
    oldestCallAgeMs: number | null;
    oldestCallTool: string | null;
  } {
    return this.registry.getInFlightCallStats();
  }

  getToolDurabilityTelemetrySnapshot() {
    return this.registry.getDurabilityTelemetrySnapshot();
  }

  private lastSuccessfulTurnSessionCurrent(): boolean | null {
    const session = this.turnCapabilityTracker.lastSuccessfulTurnSession;
    const binding = this.turnCapabilityTracker.lastSuccessfulTurnSessionBinding;
    const provider = this.turnCapabilityTracker.lastSuccessfulTurnProvider;
    if (session === null || binding === null || provider === null) return null;
    const currentSessions = this.sessionScope === 'per_chat'
      ? [...this.chatSessions.values()]
      : this.session === null ? [] : [this.session];
    if (!currentSessions.includes(session as SessionManager)) return false;
    const current = session as SessionManager;
    if (!current.getStatus().active) return false;
    if (current.getProviderId() !== provider) return false;
    if (typeof current.isEvidenceBindingCurrent !== 'function') return null;
    return current.isEvidenceBindingCurrent(binding);
  }

  /** The freshness window the live verdict is judged against: scheduler-derived
   *  while the periodic probe is armed, the flat 30min otherwise. */
  private modelUsabilityFreshnessMs(): number {
    return resolveModelUsabilityFreshnessMs(
      this.periodicUsabilityProbeTimer !== null,
      periodicProbeBackoffMultiple(this.periodicUsabilityProbeBackoff),
      {
        nextProbeDueAt: this.periodicUsabilityProbeDueAt,
        checkedAt: this.primaryModelUsability?.checkedAt ?? null,
      },
    );
  }

  /** Freshness-honest identity verdict for /health, judged against the same
   *  window as model usability (the identity check rides the same probe). */
  private accountIdentityHealth(): AccountIdentityHealth {
    return deriveAccountIdentityHealth({
      expectedConfigured: this.expectedAccountDigest !== null,
      verification: this.accountIdentity,
      armedAtMs: this.accountIdentityArmedAt,
      nowMs: systemClock.now(),
      freshnessMs: this.modelUsabilityFreshnessMs(),
    });
  }

  private getTurnCapability(): RuntimeTurnCapability {
    const usability = this.primaryModelUsability;
    const periodicProbeExpected = this.periodicUsabilityProbeTimer !== null;
    const backoffMultiple = periodicProbeBackoffMultiple(this.periodicUsabilityProbeBackoff);
    const modelUsableFreshnessMs = this.modelUsabilityFreshnessMs();
    const { modelUsable, modelUsableStale, modelUsableCheckedAt } =
      deriveModelUsable(usability, Date.now(), modelUsableFreshnessMs);
    return {
      modelUsable,
      modelUsableStale,
      modelUsableCheckedAt,
      modelUsabilityStatus: usability?.status ?? null,
      lastSuccessfulTurnAt: this.turnCapabilityTracker.lastSuccessfulTurnAt,
      lastSuccessfulTurnProvider: this.turnCapabilityTracker.lastSuccessfulTurnProvider,
      lastSuccessfulTurnModel: this.turnCapabilityTracker.lastSuccessfulTurnModel,
      lastSuccessfulTurnSessionCurrent: this.lastSuccessfulTurnSessionCurrent(),
      primaryModel: this.model ?? null,
      lastTurnErrorClass: this.turnCapabilityTracker.lastTurnErrorClass,
      lastTurnErrorAt: this.turnCapabilityTracker.lastTurnErrorAt,
      periodicProbeExpected,
      periodicProbeBackoffMultiple: backoffMultiple,
      modelUsableFreshnessMs,
      nextProbeDueAt: this.periodicUsabilityProbeDueAt,
    };
  }

  private recordTurnCapabilitySuccess(isUserTurnResult: boolean, session: SessionManager | null = null): void {
    if (!isUserTurnResult) return;
    const sessionBinding =
      typeof session?.captureEvidenceBinding === 'function'
        ? session.captureEvidenceBinding()
        : null;
    // Defensive typeof guard mirrors the other getProviderId call sites in this
    // file (e.g. maybeStartAutoCompact, /status, recordProviderFallback) and the
    // sibling captureEvidenceBinding read above: an indeterminate provider fails
    // safe to null rather than throwing on a session that lacks the accessor.
    const successProvider =
      typeof session?.getProviderId === 'function' ? session.getProviderId() : null;
    const successModel =
      typeof session?.getModelRef === 'function' ? session.getModelRef() ?? null : null;
    this.turnCapabilityTracker.recordSuccess(
      successProvider,
      successModel,
      session,
      sessionBinding,
    );
    this.consecutivePrimaryEmptyTurns = 0;
    this.consecutiveUnknownTerminalTurns = 0;
    if (this.isFallbackWindowActive) return;
    if (session !== null) { const sm = typeof session?.getModelRef === 'function' ? session.getModelRef() : undefined; if (successProvider !== this.agentProvider || (sm ?? null) !== (this.model ?? null)) return; }
    // A2: this real post-revert turn IS the honest canary — the deferred clear a probe-confirmed revert withheld.
    if (this.pendingPostRevertConfirmation) {
      clearAlertSourceChecked(this.instanceName, 'provider_fallback_activated', 'reason=post-revert-turn-success');
      this.pendingPostRevertConfirmation = false;
    }
    const wasStale = deriveModelUsable(this.primaryModelUsability, Date.now(), this.modelUsabilityFreshnessMs()).modelUsableStale;
    this.fallback.recordPrimaryModelUsability({ status: 'usable', provider: this.agentProvider, model: this.model ?? null, reason: 'turn-success' }, 'manual');
    if (wasStale) log.info({ provider: this.agentProvider, model: this.model ?? null }, 'primary model usability refreshed by turn success after going stale');
  }

  private recordTurnCapabilityFailure(
    isUserTurnResult: boolean,
    errorClass: TurnCapabilityErrorClass,
  ): void {
    if (!isUserTurnResult) return;
    this.turnCapabilityTracker.recordFailure(errorClass);
  }

  /**
   * Record a provider-reported turn cost from a result event. Always logged
   * alongside the token counts; accumulated into {@link fallbackWindowCostUsd}
   * only while a fallback window is active (the field answers "what has
   * fallback serving cost this process"). Non-finite values are ignored —
   * the opencode parser validates finite ≥ 0, but the handler stays defensive
   * for other providers that may grow a cost field.
   */
  private recordTurnCostUsd(event: { costUsd?: number; inputTokens?: number; outputTokens?: number }): void {
    if (typeof event.costUsd !== 'number' || !Number.isFinite(event.costUsd)) return;
    const onFallback = this.isFallbackWindowActive;
    log.info({
      instanceName: this.instanceName,
      costUsd: event.costUsd,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      provider: this.effectiveProvider,
      onFallback,
    }, 'provider reported turn cost');
    if (onFallback) {
      this.fallbackMetrics.addWindowCost(event.costUsd);
    }
  }


  /** Model paired with {@link effectiveProvider}: fallbackModel while the window is active, else the primary model. */
  private get effectiveModel(): string | undefined {
    const fallbackEntry = this.effectiveFallbackEntry;
    return fallbackEntry
      ? fallbackEntry.model
      : this.model;
  }


  /**
   * Probe whether the primary provider can serve again. Recovery requires a
   * real model-usability success, not credential presence: a revoked API key or
   * expired OAuth token can still be present in the key store while live turns
   * continue returning auth failures. The probe is deadline-cancelled and never
   * rejects; a timeout result waits for cancellation acknowledgement.
   * `onEvidence` (DUR-02) gets the full result pre-resolve — see
   * resolveFallbackRecoveryDecision for why a callback, not a field.
   */
  private async probePrimaryProviderRecovered(
    onEvidence?: (evidence: FallbackRecoveryEvidence) => void,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const target = { provider: this.agentProvider, model: this.model ?? null };
    const adapters = createPrimaryModelProbeAdapters(this.agentProviderConfig, buildPrimaryProbeAdapterDeps(this.agentProvider, this.model, this.cwd, this.egressProxy?.port, this.providerExecutionGate));
    const result = signal
      ? await probePrimaryModelUsability(target, adapters, { signal })
      : await probePrimaryModelUsability(target, adapters);
    onEvidence?.({ ...result, checkedAt: Date.now() });
    return result.status === 'usable';
  }

  private handleProviderFailureResult(wf: ResponseWorkflow, ctx: ProviderFailureResultContext): void {
    handleProviderFailureResultWithPort(this.runtimeTurnHost, wf, ctx, extractUsageLimitResetTime);
  }

  private kickDiagnosticBundle(wf: ResponseWorkflow, providerText: string): void {
    const now = Date.now();
    // Instance-level throttle (see DIAGNOSTIC_BUNDLE_THROTTLE_MS): skip if we
    // diagnosed the primary within the window — a storm cannot fan out probes.
    if (now - this.lastDiagnosticBundleAt < DIAGNOSTIC_BUNDLE_THROTTLE_MS) return;
    this.lastDiagnosticBundleAt = now;
    try {
      const probes = buildDiagnosticProbes({
        providerText,
        target: {
          provider: this.agentProvider,
          model: this.model ?? undefined,
          providerConfig: this.agentProviderConfig,
        },
        getHealthSnapshot: () => {
          const s = this.getFallbackState();
          return {
            summary: `effective=${s.effectiveProvider} fallbackReason=${s.fallbackReason ?? 'none'}`
              + ` modelUsable=${s.turnCapability.modelUsable ?? 'unknown'}`,
            data: {
              effectiveProvider: s.effectiveProvider,
              fallbackReason: s.fallbackReason,
              fallbackActiveUntil: s.fallbackActiveUntil,
              modelUsabilityStatus: s.turnCapability.modelUsabilityStatus,
            },
          };
        },
        parseUsageLimitReset: (text) => {
          const d = extractUsageLimitResetTime(text);
          return d ? d.getTime() : null;
        },
        runPrimaryModelUsability: (signal) => probePrimaryModelUsability(
          { provider: this.agentProvider, model: this.model ?? null },
          createPrimaryModelProbeAdapters(this.agentProviderConfig, buildPrimaryProbeAdapterDeps(this.agentProvider, this.model, this.cwd, this.egressProxy?.port, this.providerExecutionGate)),
          { signal },
        ),
        runPrimaryRecoveryProbe: (signal) => this.probePrimaryProviderRecovered(undefined, signal),
        accountAuthDeps: {
          resolveKeyService: resolveProviderKeyService,
          lookupCredential,
          getProviderBinary,
          probeBinaryAuthStatus,
          isAuthRequiredMessage: isProviderAuthRequiredMessage,
          // Explicit allowlist — never hand the CLI probe the full process env.
          // CLAUDE_CONFIG_DIR is forwarded if set so the auth-status probe reads
          // creds from the same place as the model probe + turns (launchd keychain
          // unreadable; see RCA 2026-06-24). Omitted when unset → no change.
          env: {
            // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
            HOME: process.env['HOME'],
            // env-allowed: ambient OS PATH contract for executable resolution
            PATH: process.env['PATH'],
            // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
            USER: process.env['USER'],
            // env-allowed: external-tool interop; must track the env the spawned claude CLI sees
            ...(process.env['CLAUDE_CONFIG_DIR'] ? { CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'] } : {}),
          },
        },
      });
      void runDiagnosticBundle({ workflow: wf, probes, now })
        .then((bundle) => {
          const digest = bundle.findings
            .map((f) => `${f.id}:${f.ok ? 'ok' : 'flagged'}/${f.confidence}`)
            .join(' ');
          const resetClause = bundle.resetAt ? ` resetAt=${new Date(bundle.resetAt).toISOString()}` : '';
          emitAlertChecked(
            this.instanceName,
            'provider_failure_diagnostics',
            `Diagnostics for ${wf.providerKind} on ${this.agentProvider}`,
            `${digest}${resetClause}`,
          );
        })
        .catch((err) => {
          log.warn({ err, provider: this.agentProvider }, 'diagnostic bundle failed');
        });
    } catch (err) {
      log.warn({ err }, 'failed to kick diagnostic bundle');
    }
  }

  private notifyProviderFallbackActivated(
    queue: IOutboundQueue,
    activation: ProviderFallbackActivation,
    replay: { replayScheduled: boolean; blockedByToolActivity?: boolean } = { replayScheduled: false },
  ): void {
    const now = Date.now();
    for (const [key, recordedAt] of this.recentProviderFallbackNotices) {
      if (now - recordedAt > config.fallbackTunables.noticeDedupMs) {
        this.recentProviderFallbackNotices.delete(key);
      }
    }
    const noticeKey = [
      queue.targetChatJid,
      activation.reason,
      activation.fallbackProvider,
      activation.fallbackModel ?? 'default',
    ].join(':');
    if (this.recentProviderFallbackNotices.has(noticeKey)) return;
    this.recentProviderFallbackNotices.set(noticeKey, now);
    this.capDedupeMap(this.recentProviderFallbackNotices);

    const card = modelCardLabel(activation.fallbackProvider, activation.fallbackModel);
    const credentialsMissing = activation.keyPresent === false;
    // A stand-in only continues the turn when a replay is scheduled, the first
    // attempt did not already start an action, and the backup credentials are
    // present. This is the SAME boolean the inline suffix used to pick
    // "I will continue here." over "Please resend …".
    const hasContinuation =
      replay.replayScheduled && !replay.blockedByToolActivity && !credentialsMissing;
    // Map the fallback reason to its deterministic user template. Some internal
    // reasons reuse user-facing transient copy; the credentials-missing case
    // overrides it below.
    const templateId: UserTemplateId = credentialsMissing
      ? 'credentials-missing'
      : templateForFallbackReason(activation.reason);
    // When the replay is blocked because the first attempt already started an
    // action, the reason template renders the dedicated tool-activity-blocked
    // directive in place of its continue/resend clause (the copy now lives in
    // response-templates.ts via the `tool-activity-blocked` template id and the
    // `blockedByToolActivity` render flag — no longer composed at this call site).
    const blockedByToolActivity = !credentialsMissing && replay.blockedByToolActivity === true;
    const message = renderUserMessage(templateId, {
      hasContinuation,
      backupCard: credentialsMissing ? null : card,
      activeUntil: activation.activeUntil,
      bundle: null,
      formatClock: formatClockForUser,
      blockedByToolActivity,
    });
    // One-message collapse: when the stand-in will continue (a replay is
    // scheduled, not blocked, with credentials), stash the notice so it prepends
    // to the stand-in's first reply instead of being a separate message. Any
    // other case (resend / blocked / missing creds) has no continuation coming,
    // so the notice is sent standalone as before. Stash failure falls back to
    // standalone — the notice is never lost.
    const collapse = config.oneMessageHandoff
      && replay.replayScheduled
      && !replay.blockedByToolActivity
      && activation.keyPresent !== false;
    if (collapse && this.stashHandoffNotice(queue.targetChatJid, message, now)) {
      return;
    }
    if (hasContinuation) queue.enqueueText(message, 'lifecycle');
    else queue.enqueueText(message);
  }

  private enqueueAutoSwitchNotice(
    queue: IOutboundQueue,
    text: string,
    logChatJid: string | null | undefined,
    mode: 'streaming' | 'result',
  ): boolean {
    const notice = detectAutoSwitchNotice(text);
    if (!notice) return false;
    const message = autoSwitchNoticeMessage(notice);
    log.info({
      chatJid: logChatJid,
      from: notice.from,
      to: notice.to,
      reason: notice.reason,
    }, 'surfaced provider auto-switch notice');
    if (mode === 'streaming') queue.enqueueStreamingText(message);
    else queue.enqueueResultText(this.withHandoffPrefix(queue.targetChatJid, message));
    return true;
  }

  // Thin delegators to handoff-notice-prefix.ts: the stash/prefix/flush logic
  // lives in that pure module, but these instance methods stay so the turn-host
  // Port wiring and the characterization tests that exercise the collapse via the
  // runtime instance are unchanged (same discipline as the auto-compact delegators).
  private stashHandoffNotice(chatJid: string, message: string, now: number): boolean {
    return stashHandoffNoticeImpl(this.db, chatJid, message, now);
  }

  private withHandoffPrefix(chatJid: string, text: string): string {
    return withHandoffPrefixImpl(config.oneMessageHandoff, this.db, chatJid, text);
  }

  private flushPendingHandoffNotice(queue: IOutboundQueue): void {
    flushPendingHandoffNoticeImpl(config.oneMessageHandoff, this.db, queue);
  }

  private recreatePerChatSessionForFallback(
    mapKey: string,
    chatJid: string,
    actorJid?: string,
    routeOverride?: ResolvedReplayRoute,
  ): void {
    this.operationTrackers.get(mapKey)?.shutdown();
    this.operationTrackers.delete(mapKey);

    const workspace = this.sandboxPerChat
      ? this.workspaceResources.get(mapKey) ?? {
          workspacePath: chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspacePath,
          socketPath: undefined,
        }
      : null;
    const toolScopeKey = this.createToolScopeKey(mapKey);
    let session!: SessionManager;
    const resolveSessionMapKey = () => this.findMapKeyForSession(session, mapKey);
    session = this.createSessionManager({
      chatJid,
      cwd: workspace?.workspacePath ?? this.cwd,
      actorJid,
      mcpSocketPath: workspace?.socketPath,
      onEvent: (event) => this.handleEventPerChat(session, event, toolScopeKey),
      onCrash: (info) => {
        const currentMapKey = resolveSessionMapKey() ?? mapKey;
        this.handlePerChatCrash(currentMapKey, chatJid, info, session);
      },
      notifyUser: (msg) => this.handleCrashNotify(msg, chatJid),
      onResumeFailed: () => this.handleResumeFailed(chatJid),
      eventToolScopeKey: toolScopeKey,
      routeOverride,
    });
    this.setOwnedPerChatSession(mapKey, session);
    if (!this.chatQueues.has(mapKey)) {
      this.chatQueues.set(mapKey, this.createOutboundQueue(chatJid, 'fallback per-chat session replacement'));
    }
    const tracker = this.createOperationTracker(session, () => {
      const currentMapKey = resolveSessionMapKey();
      return currentMapKey ? this.chatQueues.get(currentMapKey) : undefined;
    });
    if (tracker) this.operationTrackers.set(mapKey, tracker);
  }

  /** Remove a shutdown fallback source without disturbing a newer owner. */
  private discardPerChatSessionForFallback(mapKey: string, expected: SessionManager): boolean {
    if (this.chatSessions.get(mapKey) !== expected) return false;
    this.operationTrackers.get(mapKey)?.shutdown();
    this.operationTrackers.delete(mapKey);
    return this.deleteOwnedPerChatSession(mapKey, expected);
  }

  private recreateSingletonSessionForFallback(
    chatJid: string,
    actorJid?: string,
    routeOverride?: ResolvedReplayRoute,
  ): void {
    this.operationTracker?.shutdown();
    this.operationTracker = null;
    let replacementSession!: SessionManager;
    replacementSession = this.createSessionManager({
      chatJid,
      cwd: this.cwd,
      actorJid,
      trackSingletonMcpSession: true,
      onEvent: (event) => this.handleEvent(replacementSession, event),
      onCrash: (info) => {
        this.recordCrash(GLOBAL_CRASH_SCOPE_KEY);
        const queue = this.getActiveQueue();
        this.finalizeRuntimeCrash(this.currentRuntimeTurnContext, queue, this.session);
        this.cleanupSharedCrashTurnState();
        log.error({
          chatJid,
          sessionId: info.sessionId ?? null,
          exitCode: info.exitCode ?? null,
          signal: info.signal ?? null,
          provider: info.provider ?? null,
          crashClass: info.crashClass ?? null,
          stderrPreview: info.stderrPreview ?? null,
        }, 'fallback singleton session crashed');
      },
      notifyUser: (msg) => this.handleCrashNotify(msg),
      onResumeFailed: () => this.handleResumeFailed(chatJid),
      routeOverride,
    });
    this.session = replacementSession;
    this.activeChatJid = chatJid;
    if (this.shared) {
      this.ensureOutboundQueue(chatJid);
    } else if (!this.queue) {
      this.queue = this.createOutboundQueue(chatJid, 'fallback single session replacement');
    }
    this.operationTracker = this.createOperationTracker(this.session, () => this.getActiveQueue());
  }

  /** Remove a shutdown singleton fallback source without clearing a replacement. */
  private discardSingletonSessionForFallback(expected: SessionManager): boolean {
    if (this.session !== expected) return false;
    this.operationTracker?.shutdown();
    this.operationTracker = null;
    this.session = null;
    return true;
  }

  private scheduleFallbackReplay(args: {
    activation: ProviderFallbackActivation;
    chatJid: string;
    mapKey?: string;
    oldSession: SessionManager | null;
    hadToolActivity?: boolean;
    /**
     * Dispatch the replay as a FRESH turn even when the crashed turn's
     * journaled context is still published. The continuation path assumes the
     * result-driven state a terminal result leaves behind ("keep evidence,
     * FIFO slot, completion owned until the fallback result") — a process
     * crash produces none of it, and the crash path finalizes the context
     * asynchronously, so reading it here would race that finalization.
     */
    forceFresh?: boolean;
    /**
     * Awaited before the replay dispatch touches the session or queue. The
     * managed-crash caller resolves it with the advance notice's outbound
     * flush: the replay's own pre-spawn flush racing a notice still draining
     * under send pacing trips the queue's completed-with-pending-work
     * invariant, which POISONS the per-chat queue (live 2026-08-16).
     */
    preDispatch?: Promise<void>;
  }): boolean {
    // QR-103: never replay a turn that ALREADY delivered a visible reply — the
    // fallback replay would send a SECOND full answer (user gets both the primary
    // streamed reply AND the backup reply). The sibling recordFallbackTurnOutcome
    // already treats hadVisibleOutput||hadToolWork as a delivered reply; mirror
    // that here. Derived from the same per-turn state the streaming path sets
    // (reset at turn start, so never stale): per_chat reads its accumulated
    // perChatTurnText[mapKey], singleton/shared reads turnHadVisibleOutput. Uses
    // the streamed reply text, NOT the terminal result text (which is the failure
    // string that was just classified) — so a genuinely silent turn still replays.
    const hadVisibleOutput = args.mapKey !== undefined
      ? ((this.perChatTurnText.get(args.mapKey)?.trim() ?? '') !== '')
      : this.turnHadVisibleOutput;
    if (
      args.activation.keyPresent === false
      || args.hadToolActivity
      || hadVisibleOutput
    ) return false;
    const replayText = args.mapKey !== undefined
      ? this.pendingTurnText.get(args.mapKey)
      : this.currentTurnReplayText;
    if (!replayText) return false;
    const actorJid = args.mapKey !== undefined
      ? this.pendingTurnActorJid.get(args.mapKey)
      : this.currentTurnReplayActorJid;
    const purpose = args.mapKey !== undefined
      ? this.pendingTurnPurpose.get(args.mapKey)
      : this.currentTurnReplayPurpose;

    let routeOverride: ResolvedReplayRoute;
    try {
      routeOverride = this.resolveRouteForTurn(args.chatJid, actorJid);
    } catch {
      return false;
    }
    // The route is captured and later passed to session creation, so an
    // extended replay cannot pass this identity check then respawn onto a
    // different route after the old session has shut down.
    const replayTargetSafe = !args.activation.extended || (
      args.oldSession !== null
      && typeof args.oldSession.getProviderId === 'function'
      && typeof args.oldSession.getModelRef === 'function'
      && (
        args.oldSession.getProviderId() !== routeOverride.provider
        || args.oldSession.getModelRef() !== routeOverride.model
      )
    );
    if (!replayTargetSafe) return false;

    const runtimeContext = args.forceFresh
      ? undefined
      : args.mapKey !== undefined
        ? this.perChatRuntimeTurnContexts.get(args.mapKey)?.[0]
        : this.currentRuntimeTurnContext;
    if (runtimeContext) {
      if (
        runtimeContext.replay.text !== replayText
        || runtimeContext.identity.deliveryJid !== args.chatJid
      ) {
        log.error({
          chatJid: args.chatJid,
          mapKey: args.mapKey,
          logicalTurnId: runtimeContext.identity.logicalTurnId,
        }, 'refusing fallback replay with mismatched captured turn context');
        return false;
      }
      const scopeRef = args.mapKey === undefined
        ? undefined
        : this.perChatRuntimeTurnScopeRefs.get(runtimeContext.identity.logicalTurnId)
          ?? { value: args.mapKey };
      if (!this.runtimeTurnCoordinator.beginRuntimeTurnContinuation(runtimeContext)) return false;
      this.runtimeTurnCoordinator.appendRuntimeTurnAfterTerminalAction(runtimeContext, (result) => {
        if (result.terminal.attemptOutcome.kind !== 'completed') return;
        this.fallbackMetrics.recordReplay();
        emitAlertChecked(
          this.instanceName,
          'provider_fallback_replayed',
          'Interrupted turn replayed on fallback provider',
          `reason=${args.activation.reason} provider=${args.activation.fallbackProvider} model=${args.activation.fallbackModel ?? 'default'}`,
          'info',
        );
      });
      void this.dispatchFallbackReplay(
        {
          ...(scopeRef === undefined ? args : { ...args, mapKey: scopeRef.value }),
          runtimeContext,
          routeOverride,
        },
        replayText,
        actorJid,
        purpose,
      ).catch((err) => this.finalizeFailedFallbackContinuation(
        scopeRef === undefined ? args : { ...args, mapKey: scopeRef.value },
        runtimeContext,
        err,
      ));
    } else {
      void this.dispatchFallbackReplay({ ...args, routeOverride }, replayText, actorJid, purpose)
        .then(() => {
          this.fallbackMetrics.recordReplay();
          emitAlertChecked(
            this.instanceName,
            'provider_fallback_replayed',
            'Interrupted turn replayed on fallback provider',
            `reason=${args.activation.reason} provider=${args.activation.fallbackProvider} model=${args.activation.fallbackModel ?? 'default'}`,
            'info',
          );
        })
        .catch((err) => {
          // ANY replay failure means the user's turn is definitively not being
          // answered — always say so. The previous invalidated-only gate left
          // generic errors (e.g. spawn refusals) as pure silence plus a log
          // line (incident 2026-08-15).
          const queue = this.getQueueForChat(args.chatJid, args.mapKey);
          if (queue) this.notifyFailedFallbackReplay(queue, args.chatJid);
          // errorMessage() explicitly: the log serializer reduces unknown Error
          // subclasses to {errorClass} and drops the message — the incident
          // journal recorded only {"errorClass":"Error"}, leaving the root
          // cause unrecoverable from logs.
          log.error({ err, errorMessage: errorMessage(err), chatJid: args.chatJid, mapKey: args.mapKey }, 'failed to replay unjournaled turn');
          emitAlertChecked(
            this.instanceName,
            'runtime_provider_fallback_replay_failed',
            'Provider fallback replay failed',
            `provider=${args.activation.fallbackProvider} model=${args.activation.fallbackModel ?? 'default'} reason=${args.activation.reason}`,
          );
        });
    }
    return true;
  }

  /**
   * Confirm that the route captured for a fallback replay still represents the
   * live session target after the old child has stopped. Route source and
   * effort affect spawn configuration too, so this is intentionally stricter
   * than a provider/model-only comparison.
   */
  private isReplayRouteCurrent(
    chatJid: string,
    actorJid: string | undefined,
    captured: ResolvedReplayRoute,
  ): boolean {
    try {
      const live = this.resolveRouteForTurn(chatJid, actorJid);
      return (
        live.provider === captured.provider
        && live.model === captured.model
        && live.source === captured.source
        && live.reasonCode === captured.reasonCode
        && live.dataPolicy === captured.dataPolicy
        && live.policyVersion === captured.policyVersion
        && live.policyState === captured.policyState
        && live.pinnedProvider === captured.pinnedProvider
        && live.effort === captured.effort
      );
    } catch {
      return false;
    }
  }

  private async dispatchFallbackReplay(
    args: {
      activation: ProviderFallbackActivation;
      chatJid: string;
      mapKey?: string;
      oldSession: SessionManager | null;
      runtimeContext?: RuntimeTurnContext;
      routeOverride?: ResolvedReplayRoute;
      preDispatch?: Promise<void>;
    },
    replayText: string,
    actorJid: string | undefined,
    purpose: SessionContext['purpose'],
  ): Promise<void> {
    if (args.preDispatch) await args.preDispatch;
    await this.replayTurnOnFallback({
      chatJid: args.chatJid,
      mapKey: args.mapKey,
      replayText,
      actorJid,
      purpose,
      oldSession: args.oldSession,
      runtimeContext: args.runtimeContext,
      routeOverride: args.routeOverride,
    });
  }

  private notifyFailedFallbackReplay(queue: IOutboundQueue, chatJid: string): void {
    try {
      clearStandbyNotice(this.db, toConversationKey(chatJid));
    } catch (noticeError) {
      log.warn({ err: noticeError, chatJid }, 'failed to clear abandoned fallback handoff notice');
    }
    queue.enqueueText('_The backup model could not continue this turn. Please try again._');
  }

  private async finalizeFailedFallbackContinuation(
    args: {
      activation: ProviderFallbackActivation;
      chatJid: string;
      mapKey?: string;
    },
    context: RuntimeTurnContext,
    error: unknown,
  ): Promise<void> {
    if (!await this.runtimeTurnCoordinator.claimFailedRuntimeTurnContinuation(context)) return;
    const queue = args.mapKey === undefined
      ? this.getActiveQueue()
      : this.chatQueues.get(args.mapKey) ?? null;
    if (!queue) {
      this.runtimeTurnCoordinator.markRuntimeTurnDegraded(context);
      log.error({ err: error, logicalTurnId: context.identity.logicalTurnId },
        'fallback continuation failed without an outbound queue');
      return;
    }
    this.notifyFailedFallbackReplay(queue, args.chatJid);
    // errorMessage() explicitly: the log serializer reduces unknown Error
    // subclasses to {errorClass} and drops the message — the 2026-08-15
    // incident journal recorded only {"errorClass":"Error"} here, leaving the
    // replay root cause unrecoverable from logs.
    log.error({
      err: error,
      errorMessage: errorMessage(error),
      chatJid: args.chatJid,
      mapKey: args.mapKey,
      fallbackProvider: args.activation.fallbackProvider,
    }, 'failed to replay turn on fallback provider');
    emitAlertChecked(
      this.instanceName,
      'runtime_provider_fallback_replay_failed',
      'Provider fallback replay failed',
      `provider=${args.activation.fallbackProvider} model=${args.activation.fallbackModel ?? 'default'} reason=${args.activation.reason}`,
    );
    await this.finalizeRuntimeTurnContext({
      context,
      queue,
      attemptOutcome: { kind: 'failed', class: 'processor_throw' },
      session: args.mapKey === undefined ? this.session : this.chatSessions.get(args.mapKey) ?? null,
      ...(args.mapKey === undefined ? {} : { mapKey: args.mapKey }),
      clearReplayOnSuccess: false,
    });
  }

  private replayTurnOnFallback(args: ProviderFallbackReplayArgs): Promise<void> {
    return this.runtimeTurnCoordinator.replayTurnOnFallback(args);
  }

  /**
   * providerConfig handed to a new SessionManager.
   *
   * Fallback execution config is selected centrally by
   * `fallbackProviderConfigFor`: OpenCode drops the primary route's custom
   * endpoint fields, while managed-loop API fallbacks retain them. Primary
   * sessions receive the configured providerConfig unchanged.
   */
  private sessionProviderConfig(): Record<string, unknown> | undefined {
    return this.fallback.effectiveProviderConfig;
  }


  /**
   * Build the `handoffSystemBlock` callback for a fresh/stand-in SessionManager.
   * Returns `undefined` (no callback) unless the context flag is on AND this
   * provider routes its handoff via the system prompt. The callback itself
   * yields the distilled summary block only when a fresh artifact exists; a
   * stale or absent artifact yields `null` (SessionManager omits it).
   *
   * Flag off → returns `undefined`, so buildSystemPrompt is byte-identical.
   */
  private buildHandoffSystemBlock(
    conversationKey: string,
    provider: string,
  ): (() => string | null) | undefined {
    if (!handoffContextEnabled()) return undefined;
    if (seamForProvider(provider as AgentProvider) !== 'system') return undefined;
    return () => {
      // Seed the distilled handoff context only into a STAND-IN session spawned
      // during an active fallback window — never a primary session (which still
      // owns its own conversation, so a same-conversation summary is redundant and
      // wastes context). Checked at prompt-build time so it reflects the live
      // window state, which can activate after this SessionManager is constructed.
      if (!this.isFallbackWindowActive) return null;
      const artifact = getHandoffArtifact(this.db, conversationKey);
      if (!artifact) return null;
      return buildHandoffPrelude({
        artifact,
        now: Date.now(),
        staleAfterMs: HANDOFF_STALE_MS,
        // PII-hardened handoff redactor: provider-preview sanitizer (Bearer /
        // secret / token / email) plus phone-number redaction. This path injects
        // a distilled summary built from WhatsApp content into the system prompt.
        redact: (t) => redactHandoffPii(t),
      }).systemBlock;
    };
  }

  /**
   * Compose the flag-gated NL routing prompt contract from live instance
   * state (slice 3). Evaluated per prompt build so tier/provider facts are
   * current; flag off never reaches this (the opt stays undefined).
   */
  private buildRoutingContractBlock(provider: string): string {
    // Fail-open (R13): the routablePinTargets credential probe does I/O and can
    // throw; the routing prompt block must never fail a spawn. Degrade to the
    // always-routable primary rather than propagating out of prompt build.
    let routableProviders: string[];
    try {
      routableProviders = this.routablePinTargets();
    } catch (err) {
      log.warn({ err, instance: this.instanceName }, 'routable-pin probe failed building routing contract - listing primary only');
      routableProviders = [this.agentProvider];
    }
    return buildRoutingPromptContract({
      // Thread the provider the session actually spawned on (R6), as the
      // adjacent handoffSystemBlock is — hardcoding effectiveProvider told a
      // pin/tier-routed agent it was the default provider (contradicting /why).
      provider,
      tierMap: config.nlRoutingTiers ?? null,
      routableProviders,
    });
  }

  /**
   * Construct a SessionManager with all instance-level fields pre-filled.
   * Callers supply only the variable parts: chatJid, cwd, and the three callbacks.
   */
  private createSessionManager(opts: {
    chatJid: string;
    sessionMapKey?: string;
    cwd: string | undefined;
    actorJid?: string;
    trackSingletonMcpSession?: boolean;
    onEvent: (event: AgentEvent) => void;
    onCrash: (info: SessionCrashInfo) => void;
    notifyUser: (msg: string) => void;
    onResumeFailed?: () => void;
    mcpSocketPath?: string;
    providerConfigOverride?: Record<string, unknown>;
    eventToolScopeKey?: string;
    routeOverride?: ResolvedReplayRoute;
  }): SessionManager {
    const deliveryConversationKey = toConversationKey(opts.chatJid);
    const sessionConversationKey = opts.sessionMapKey ?? deliveryConversationKey;
    // Resolve the provider/model/policy tuple for every session. NL preferences
    // remain flag-gated inside resolveRouteForTurn; policy admission does not.
    const route = opts.routeOverride ?? this.resolveRouteForTurn(opts.chatJid, opts.actorJid);
    if (this.nlRoutingEnabled) this.noteRouteAtSpawn(opts.chatJid, deliveryConversationKey, route);
    // F-STICKY-ACTOR (QR-247 hardening): wire the per-chat actor socket HERE — the
    // single choke point every spawn path (ensure / proactive-resume / provider-
    // fallback) flows through — keyed on the session's ACTUAL provider, not the
    // instance-global one. A fallback to a non-claude provider tears the socket down.
    const sessionProvider = route ? route.provider : this.effectiveProvider;
    const mcpServerScript = providerMcpProxyScriptPath();
    // #3149: a managed-loop API provider standing in for the configured primary
    // silently loses the whole child-process tool surface. Mark the session so
    // its system prompt discloses that to the MODEL, and tell the USER below.
    const managedLoopDegraded = isManagedLoopFallbackDegraded(
      sessionProvider ?? '', this.agentProvider, route !== undefined && route !== null,
    );
    // BRNCH: undefined provider (no route, no effectiveProvider) means no per-chat
    // actor socket to wire — skip entirely (main parity on the undefined path).
    const actorSocketMapKey = opts.sessionMapKey !== undefined
      && opts.sessionMapKey !== this.resolvePerChatMapKey(opts.chatJid)
      ? opts.sessionMapKey
      : undefined;
    const perChatWire = sessionProvider
      ? (actorSocketMapKey === undefined
          ? this.wirePerChatActorSocket(opts.chatJid, sessionProvider)
          : this.wirePerChatActorSocket(opts.chatJid, sessionProvider, actorSocketMapKey))
      : undefined;
    const mcpSocketPath = opts.mcpSocketPath ?? perChatWire?.mcpSocketPath;
    const providerTransitionReady = perChatWire?.providerTransitionReady;
    const actorSocketRequired = requiresPerChatActorSocket(
      sessionProvider,
      this.sessionScope,
      this.sandboxPerChat,
    );
    if (actorSocketRequired && !mcpSocketPath?.trim()) {
      throw new Error(`per_chat ${sessionProvider} session for ${sessionConversationKey} would spawn without an actor-bound socket`);
    }
    const providerToolSession: SessionContext =
      this.sandboxPerChat || this.sessionScope === 'per_chat'
        ? {
            tier: 'chat-scoped',
            conversationKey: deliveryConversationKey,
            deliveryJid: opts.chatJid,
            ...(opts.actorJid ? { actorJid: opts.actorJid } : {}),
            ...(opts.cwd ? { allowedRoot: opts.cwd } : {}),
            ...(isScheduledAgentJobMapKey(sessionConversationKey)
              ? { purpose: 'scheduled-agent-job' as const }
              : {}),
          }
        : {
            tier: 'global',
            ...(opts.actorJid ? { actorJid: opts.actorJid } : {}),
            ...(!this.shared ? { conversationKey: deliveryConversationKey } : {}),
        };
    if (opts.trackSingletonMcpSession) {
      this.singletonProviderToolSession = providerToolSession;
    }

    const session = new SessionManager({
      db: this.db,
      messenger: this.messenger,
      chatJid: opts.chatJid,
      persistenceConversationKey: sessionConversationKey,
      onEvent: opts.onEvent,
      instanceName: this.instanceName,
      onResumeFailed: opts.onResumeFailed,
      onCrash: opts.onCrash,
      notifyUser: opts.notifyUser,
      cwd: opts.cwd,
      configRoot: this.sandboxPerChat && opts.cwd ? join(opts.cwd, '.agent-home') : undefined,
      configSystemPrompt: this.configSystemPrompt,
      instructionsPath: this.instructionsPath,
      model: route.model,
      pluginDirs: this.pluginDirs,
      allowM365Mutations: this.allowM365Mutations,
      provider: route ? route.provider : this.effectiveProvider,
      providerConfig: opts.providerConfigOverride
        ? { ...(route ? this.routeSessionProviderConfig(route) : this.sessionProviderConfig()), ...opts.providerConfigOverride }
        : (route ? this.routeSessionProviderConfig(route) : this.sessionProviderConfig()),
      mcpBridge: createProviderMcpBridge(
        this.registry,
        providerToolSession,
        () => this.sessionScope === 'per_chat'
          ? this.resolveExecutingSessionByMapKey(
              opts.sessionMapKey ?? this.resolvePerChatMapKey(opts.chatJid),
            )
          : this.resolveExecutingGlobalSession(),
      ),
      mcpSessionContext: providerToolSession,
      whatsoupInstance: this.instanceName,
      whatsoupMcpSocket: mcpSocketPath ?? this.globalMcpSocketPath ?? undefined,
      providerTransitionReady,
      handoffSystemBlock: this.buildHandoffSystemBlock(sessionConversationKey, route ? route.provider : this.effectiveProvider),
      degradedCapabilitiesBlock: managedLoopDegraded
        ? managedLoopDegradedSystemBlock
        : undefined,
      routingSystemBlock: config.nlRouting ? () => this.buildRoutingContractBlock(route ? route.provider : this.effectiveProvider) : undefined,
      routePolicy: route ?? undefined,
      egressProxyPort: this.egressProxy?.port,
      providerExecutionGate: this.providerExecutionGate,
      providerMcpConfigArgs: this.globalMcpSocketPath
        ? buildProviderMcpConfigArgs(
            sessionProvider,
            opts.cwd ?? this.cwd ?? homedir(),
            this.globalMcpSocketPath,
            mcpServerScript,
          )
        : [],
      providerCanaryAdmission: actorSocketRequired && canaryStoreProvisioned(config.stateRoot)
        ? async () => {
            const admission = await readProviderCanaryAdmission({
              providerId: sessionProvider,
              binary: getProviderBinary(sessionProvider) ?? '',
              proxyScriptPath: mcpServerScript,
              stateRoot: config.stateRoot,
              sessionScope: this.sessionScope,
              sandboxPerChat: this.sandboxPerChat,
            });
            if (!admission.allowed) {
              throw new Error('provider MCP canary proof unavailable');
            }
            return admission;
          }
        : undefined,
    });
    this.sessionManagerIds.set(session, randomUUID());
    this.sessionEventToolScopes.set(
      session,
      opts.eventToolScopeKey ?? GLOBAL_TOOL_SCOPE_KEY,
    );
    // #3149: user-facing half of the disclosure — deduped per chat, emitted at
    // the degraded session's creation so it precedes the first reduced reply.
    if (managedLoopDegraded) {
      const degradedQueue = this.getQueueForChat(opts.chatJid, opts.sessionMapKey);
      if (degradedQueue) {
        emitManagedLoopDegradedNotice({
          queue: degradedQueue,
          recentNotices: this.recentManagedLoopDegradedNotices,
          noticeDedupMs: config.fallbackTunables.noticeDedupMs,
          capDedupeMap: (map) => this.capDedupeMap(map),
        });
      }
    }
    if (this.durability) {
      session.setDurability(this.durability);
    }
    return session;
  }

  private cleanupFailedSandboxWorkspace(workspaceKey: string): void {
    const queue = this.chatQueues.get(workspaceKey);
    if (queue) {
      try {
        queue.abortTurn();
      } catch (err) {
        log.warn({ err, workspaceKey }, 'failed to abort queued turn during workspace cleanup');
      }
      this.chatQueues.delete(workspaceKey);
    }

    this.deleteOwnedPerChatSession(workspaceKey);
    this.cleanupPerChatState(workspaceKey);

    const res = this.workspaceResources.get(workspaceKey);
    if (!res) return;

    if (res.socketServer) {
      try {
        res.socketServer.stop();
      } catch (err) {
        log.warn({ err, workspaceKey }, 'failed to stop socket server during workspace cleanup');
      }
    }
    if (res.mediaBridge) {
      try {
        res.mediaBridge();
      } catch (err) {
        log.warn({ err, workspaceKey }, 'failed to stop media bridge during workspace cleanup');
      }
    }

    this.workspaceResources.delete(workspaceKey);
  }

  /**
   * Async variant of session/queue initialization for sandboxPerChat mode.
   * Called only when sandboxPerChat=true so the async/await overhead doesn't
   * affect the microtask ordering of existing non-sandboxPerChat tests.
   */
  private async ensureSessionAndQueue(chatJid: string, actorJid?: string): Promise<void> {
    // sandboxPerChat: each chat gets an isolated workspace; map keyed by workspaceKey
    const { workspaceKey, workspacePath } = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);

    if (!this.chatSessions.has(workspaceKey)) {
      try {
        // Provision workspace (deterministic rewrite of control files)
        const hookPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/hooks/agent-sandbox.sh');
        const pollLintHookPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/hooks/poll-interaction-lint.mjs');
        const postToolUseLogHookPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/hooks/post-tool-use-log.sh');
        const mcpServerPath = providerMcpProxyScriptPath();
        const sendMediaServerPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/mcp/send-media-server.ts');
        const chatScopedToolNames = this.registry.getChatScopedToolNames();
        const providerConfig =
          this.effectiveProvider === 'opencode-cli' && this.effectiveFallbackEntry === null
            ? this.fallback.primaryOpencodeProviderConfig()
            : undefined;
        const socketPath = provisionWorkspace({
          workspacePath,
          instanceCwd: this.cwd ?? homedir(),
          provider: this.effectiveProvider,
          providerConfig,
          sandbox: this.sandbox!,
          hookPath,
          pollLintHookPath,
          postToolUseLogHookPath,
          mcpServerPath,
          sendMediaServerPath,
          chatScopedToolNames,
        });

        // Start chat-scoped WhatSoup socket server + media bridge for this workspace if not already running
        if (!this.workspaceResources.has(workspaceKey)) {
          let socketServer: WhatSoupSocketServer | null = null;
          let mediaBridge: MediaBridge | null = null;
          try {
            const chatSession: SessionContext = {
              tier: 'chat-scoped',
              conversationKey: workspaceKey,
              deliveryJid: chatJid,
              ...(actorJid ? { actorJid } : {}),
              allowedRoot: workspacePath,
            };
            socketServer = new WhatSoupSocketServer(
              socketPath,
              this.registry,
              chatSession,
              () => this.resolveExecutingSessionByMapKey(workspaceKey),
            );
            socketServer.start();
            log.info({ socketPath, workspaceKey }, 'chat-scoped WhatSoup socket server started');
          } catch (err) {
            log.warn({ err, socketPath }, 'failed to start WhatSoup socket server for workspace');
          }

          // Start media bridge — allows Claude Code subprocess to send media via Unix socket.
          // The bridge socket lives at .claude/media-bridge.sock alongside whatsoup.sock.
          const mediaBridgeSocketPath = join(workspacePath, '.claude', 'media-bridge.sock');
          try {
            mediaBridge = startMediaBridge(mediaBridgeSocketPath, this.messenger, workspacePath);
            setMediaBridgeChat(mediaBridge, chatJid);
            log.info({ mediaBridgeSocketPath, workspaceKey }, 'media bridge started');
          } catch (err) {
            log.warn({ err, mediaBridgeSocketPath }, 'failed to start media bridge for workspace');
          }

          this.workspaceResources.set(workspaceKey, {
            socketPath,
            workspacePath,
            socketServer,
            mediaBridge,
            lastActivity: Date.now(),
          });
        }

        // Create SessionManager with workspace-scoped cwd
        const toolScopeKey = this.createToolScopeKey(workspaceKey);
        let session!: SessionManager;
        session = this.createSessionManager({
          chatJid,
          cwd: workspacePath,  // scoped cwd instead of this.cwd
          actorJid,
          mcpSocketPath: socketPath,
          onEvent: (event) => this.handleEventPerChat(session, event, toolScopeKey),
          onCrash: (info) => this.handlePerChatCrash(workspaceKey, chatJid, info, session),
          notifyUser: (msg) => {
            this.handleCrashNotify(msg, chatJid);
          },
          onResumeFailed: () => this.handleResumeFailed(chatJid),
          eventToolScopeKey: toolScopeKey,
        });
        const resumable = getResumableSessionForChat(
          this.db,
          workspaceKey,
          session.getProviderId(),
        );
        log.info({ chatJid, workspaceKey, workspacePath }, 'created sandbox per-chat session manager');
        this.setOwnedPerChatSession(workspaceKey, session);
        const chatQ = this.createOutboundQueue(chatJid, 'sandbox per-chat session init');
        this.chatQueues.set(workspaceKey, chatQ);

        // Wire operation tracker for this sandbox session
        const tracker = this.createOperationTracker(session, () => this.chatQueues.get(workspaceKey));
        if (tracker) this.operationTrackers.set(workspaceKey, tracker);

        // Spawn with resume if available — fall back to fresh session if resume fails
        if (resumable) {
          const resumeOwnership = this.captureOwnedPerChatGeneration(workspaceKey, session);
          try {
            await session.spawnSession(resumable.session_id, resumable.id);
          } catch (err) {
            log.warn({ err, workspaceKey, sessionId: resumable.session_id }, 'resume threw — spawning fresh session');
            try {
              await session.spawnSession();
            } catch (spawnErr) {
              log.error({ err: spawnErr, workspaceKey }, 'fresh spawn also failed — cleaning up workspace');
              throw spawnErr;
            }
          }
          await this.activateSpawnedOwnedPerChatSession(workspaceKey, session, resumeOwnership);
        }
      } catch (err) {
        this.cleanupFailedSandboxWorkspace(workspaceKey);
        throw err;
      }
    }

    // Update delivery JID on existing queue (handles JID variant changes)
    this.chatQueues.get(workspaceKey)?.updateDeliveryJid(chatJid);

    // Update delivery JID on the chat-scoped socket server and media bridge
    const res = this.workspaceResources.get(workspaceKey);
    if (res?.socketServer) {
      res.socketServer.updateDeliveryJid(chatJid);
    }
    if (res?.mediaBridge) {
      setMediaBridgeChat(res.mediaBridge, chatJid);
    }
    if (res) {
      res.lastActivity = Date.now();
    }

    // sandboxPerChat: do NOT set this.session/this.queue shared fields.
    // All per_chat code paths look up from chatSessions/chatQueues maps directly.
  }

  /**
   * Synchronous session/queue initialization for non-sandboxPerChat mode.
   * Kept synchronous to preserve microtask ordering in existing code paths.
   */
  private ensureSessionAndQueueSync(
    chatJid: string,
    initialMapKey: string = this.resolvePerChatMapKey(chatJid),
    actorJid?: string,
  ): void {
    // Task G (D14): consume a deferred route recycle BEFORE the "does a
    // session already exist" checks below — every inbound message reaches
    // this point ahead of any turn dispatch, so this is the turn-idle
    // boundary a busy-time pin deferred to. Detaching here (only when truly
    // idle) makes the per_chat/single checks below see no session and
    // respawn fresh via createSessionManager, which re-resolves the route.
    if (this.sessionScope === 'per_chat') {
      // per_chat: independent session + queue per canonical chat key
      if (!this.chatSessions.has(initialMapKey)) {
        const toolScopeKey = this.createToolScopeKey(initialMapKey);
        let session!: SessionManager;
        const resolveSessionMapKey = () => this.findMapKeyForSession(session, initialMapKey);
        // F-STICKY-ACTOR (QR-247 hardening): the per-chat actor socket is now wired
        // INSIDE createSessionManager (keyed on the session's actual provider), so the
        // proactive-resume + provider-fallback spawn paths bind identically. See
        // wirePerChatActorSocket + the choke-point guard.
        session = this.createSessionManager({
          chatJid,
          ...(isScheduledAgentJobMapKey(initialMapKey) ? { sessionMapKey: initialMapKey } : {}),
          cwd: this.cwd,
          actorJid,
          onEvent: (event) => this.handleEventPerChat(session, event, toolScopeKey),
          onCrash: (info) => {
            const mapKey = resolveSessionMapKey() ?? initialMapKey;
            this.handlePerChatCrash(mapKey, chatJid, info, session);
          },
          notifyUser: isScheduledAgentJobMapKey(initialMapKey)
            ? () => {
                log.warn(
                  { mapKey: initialMapKey },
                  'scheduled agent job crash notification suppressed',
                );
              }
            : (msg) => {
                this.handleCrashNotify(msg, chatJid, session);
              },
          eventToolScopeKey: toolScopeKey,
        });
        log.info({ chatJid, mapKey: initialMapKey, sessionScope: this.sessionScope }, 'created per-chat session manager');
        this.setOwnedPerChatSession(initialMapKey, session);
        const perChatQ = this.createOutboundQueue(chatJid, 'per-chat session init');
        this.chatQueues.set(initialMapKey, perChatQ);

        // Wire operation tracker for this per-chat session
        const tracker = this.createOperationTracker(session, () => {
          const currentMapKey = resolveSessionMapKey();
          return currentMapKey ? this.chatQueues.get(currentMapKey) : undefined;
        });
        if (tracker) this.operationTrackers.set(initialMapKey, tracker);
      }
      this.chatQueues.get(initialMapKey)?.updateDeliveryJid(chatJid);
      // per_chat mode: do NOT set this.session/this.queue shared fields.
      // /status, /new, and crash handlers look up from chatSessions/chatQueues maps directly.
      return;
    }

    // single/shared: singleton session
    if (!this.session) {
      this.activeChatJid = chatJid;
      let singletonSession!: SessionManager;
      singletonSession = this.createSessionManager({
        chatJid,
        cwd: this.cwd,
        actorJid,
        trackSingletonMcpSession: true,
        onEvent: (event) => this.handleEvent(singletonSession, event),
        onCrash: (info) => {
          this.recordCrash(GLOBAL_CRASH_SCOPE_KEY);
          const turnWasInFlight = this.currentRuntimeTurnContext !== null;
          const queue = this.getActiveQueue();
          this.finalizeRuntimeCrash(this.currentRuntimeTurnContext, queue, this.session);
          this.cleanupSharedCrashTurnState();
          this.emitCrashHealReport(chatJid, info, turnWasInFlight);
        },
        notifyUser: (msg) => this.handleCrashNotify(msg, undefined, singletonSession),
      });
      this.session = singletonSession;
      log.info({ chatJid, shared: this.shared, sessionScope: this.sessionScope }, 'created shared/single session manager');
      if (this.shared) {
        this.ensureOutboundQueue(chatJid);
      } else {
        const singletonQ = this.createOutboundQueue(chatJid, 'single session init');
        this.queue = singletonQ;
      }

      // Wire operation tracker for single/shared session
      this.operationTracker = this.createOperationTracker(this.session, () => this.getActiveQueue());
    } else if (this.shared) {
      this.ensureOutboundQueue(chatJid);
    }
  }

  /**
   * Ensure a per-chat outbound queue exists for the given JID (shared mode).
   * @check CHK-066 // @traces REQ-012.AC-05
   */
  private ensureOutboundQueue(chatJid: string): void {
    if (!this.outboundQueues.has(chatJid)) {
      const q = this.createOutboundQueue(chatJid, 'shared ensureOutboundQueue');
      this.outboundQueues.set(chatJid, q);
    }
  }

  /**
   * Report a provider crash to the heal pipeline.
   *
   * #1754: a crash must ALWAYS attempt to report — even with zero control peers configured,
   * emitHealReport's own BOT ERRORS fallback (heal.ts) is the guaranteed-or-alerted delivery
   * path, so this is never gated on `config.controlPeers.size > 0`.
   *
   * The one exception is the supervisor's own idle reap with no turn in flight: the 30-min
   * inactivity kill is routine housekeeping on a healthy session, and paging an operator to
   * "investigate and remediate" a SIGKILL we issued on purpose is noise, not a fault. A reap
   * that interrupts an in-flight turn IS a fault (the provider stalled), so it still reports.
   */
  private emitCrashHealReport(
    chatJid: string,
    info: SessionCrashInfo,
    turnWasInFlight: boolean,
  ): void {
    if (info.terminationReason === 'idle_watchdog' && !turnWasInFlight) {
      log.info({ chatJid, signal: info.signal ?? null, terminationReason: info.terminationReason }, 'idle-watchdog reap on an idle session — no heal report');
      return;
    }
    try {
      const crashClass = allowlistedHealCrashClass(info.crashClass);
      emitHealReport(this.db, this.messenger, this.durability, {
        type: 'crash',
        ...(crashClass ? { crashClass } : {}),
        ...(info.exitCode !== null || info.signal ? { termination: 'exit_or_signal' as const } : {}),
      }, this.activeControlReportId);
    } catch (err) {
      log.warn({ err }, 'failed to emit heal report for session crash');
    }
  }

  private handlePerChatCrash(
    mapKey: string,
    chatJid?: string,
    info?: SessionCrashInfo,
    expectedSession?: SessionManager,
  ): void {
    const session = expectedSession ?? this.chatSessions.get(mapKey);
    const currentMapKey = this.findMapKeyForSession(session, mapKey);
    if (!session || !currentMapKey || this.chatSessions.get(currentMapKey) !== session) {
      log.debug({ mapKey, chatJid }, 'crash callback dropped — manager is no longer mapped');
      return;
    }
    const managerId = this.sessionManagerIds.get(session);
    const owner = this.sessionOwnership.get(currentMapKey);
    const generationIdentity = info?.generationIdentity;
    if (
      !managerId ||
      !owner ||
      owner.managerId !== managerId ||
      !this.sessionOwnership.isCurrent(currentMapKey, managerId, owner.generation) ||
      !generationIdentity ||
      generationIdentity.managerId !== managerId ||
      generationIdentity.generation !== owner.generation
    ) {
      log.debug({
        mapKey: currentMapKey,
        chatJid,
        expectedManagerId: managerId ?? null,
        expectedGeneration: owner?.generation ?? null,
        callbackManagerId: generationIdentity?.managerId ?? null,
        callbackGeneration: generationIdentity?.generation ?? null,
      }, 'crash callback dropped — manager generation is not current');
      return;
    }
    if (
      owner.state === 'recoverable_dead' ||
      owner.state === 'exhausted' ||
      owner.state === 'closing' ||
      owner.state === 'resetting'
    ) {
      log.debug({ mapKey: currentMapKey, state: owner.state }, 'duplicate or terminal crash callback dropped');
      return;
    }

    // MANAGED FALLBACK HANDOFF (incident 2026-08-15): a process failure of the
    // ACTIVE fallback entry's session is chain evidence, not a plain crash —
    // without this, a fallback whose account is suspended (connects, exits 1
    // every turn, never emits a terminal result) pins the window forever while
    // healthy entries wait behind it. recordFallbackTurnProcessFailure
    // attributes the crash (null for primary/other sessions — those take the
    // ordinary machinery below), marks the entry failed, and advances the
    // window to the next eligible entry.
    if (info) {
      const processFailure = this.fallback.recordFallbackTurnProcessFailure(
        session,
        `process_exit code=${info.exitCode ?? 'null'} signal=${info.signal ?? 'none'}`
          + (info.stderrPreview ? ` stderr=${info.stderrPreview.slice(-160)}` : ''),
      );
      if (processFailure) {
        const noticeQueue = this.chatQueues.get(currentMapKey);
        const deliveryJid = chatJid ?? noticeQueue?.targetChatJid;
        // The managed copy replaces the raw session-crash line: mark the
        // session so the notifyUnexpectedExit that follows this callback —
        // and any same-episode echo (e.g. the pended route recycle's
        // teardown) — is suppressed in handleCrashNotify.
        this.managedCrashNotices.set(session, systemClock.now());
        if (processFailure.advanced && processFailure.activation && deliveryJid) {
          // Managed handoff = finalize the crashed turn FULLY, then re-dispatch
          // the interrupted text as a FRESH turn on the advanced route. The
          // journaled-continuation replay is a terminal-result instrument: that
          // path deliberately keeps the crashed turn's evidence, FIFO slot, and
          // completion open "until the fallback result" — state only a terminal
          // result's processing prepares. A process crash produces none of it,
          // so a continuation replay here either parks pre-spawn on the dirty
          // physical turn state or dies against the crash finalization (both
          // observed live 2026-08-15: replay sessions armed with
          // message_count=0, later inbounds queued unserved until restart).
          //
          // Captured BEFORE cleanup wipes the streamed-text evidence: a crashed
          // turn that already delivered visible output must not be replayed
          // (QR-103 double-answer rule) — threaded through the schedule gate
          // via hadToolActivity, which ORs into the same delivered-reply check.
          const crashTurnDeliveredOutput =
            (this.perChatTurnText.get(currentMapKey)?.trim() ?? '') !== '';
          const managedPublishedContexts = this.perChatRuntimeTurnContexts.get(currentMapKey) ?? [];
          const managedPublishedContext = managedPublishedContexts.length === 1
            ? managedPublishedContexts[0]
            : undefined;
          const managedTurnQueue = this.perChatTurnQueues.get(currentMapKey);
          const managedActiveTurn = managedTurnQueue?.activeTurn;
          const managedActiveContext = managedActiveTurn?.runtimeContext;
          const managedJournaledSeq = this.perChatInboundSeqQueue.get(currentMapKey)?.[0];
          const managedUndispatchedContext = managedPublishedContexts.length === 0
            && managedActiveContext?.identity.scope === 'per_chat'
            && managedActiveTurn?.inboundSeq !== undefined
            && managedActiveContext.identity.inboundSeq === managedActiveTurn.inboundSeq
            && managedJournaledSeq === managedActiveTurn.inboundSeq
            ? managedActiveContext
            : undefined;
          if (managedUndispatchedContext) {
            const managedScopeRef = managedTurnQueue
              ? this.perChatTurnQueueKeys.get(managedTurnQueue) ?? { value: currentMapKey }
              : { value: currentMapKey };
            this.runtimeTurnCoordinator.terminalizeUndispatchedRuntimeCrash(
              managedUndispatchedContext,
              managedScopeRef,
            );
          } else {
            // The wrapper's continuation cancel is a no-op here — the fresh
            // dispatch below never claims one — and its synchronous
            // queue.abortTurn clears the crashed turn's outbound evidence
            // before the replacement turn begins its own.
            this.finalizeRuntimeCrash(
              managedPublishedContext,
              this.chatQueues.get(currentMapKey),
              session,
              currentMapKey,
            );
          }
          const managedTracker = this.operationTrackers.get(currentMapKey);
          managedTracker?.shutdown();
          this.operationTrackers.delete(currentMapKey);
          this.cleanupPerChatCrashTurnState(currentMapKey);
          // The replay dispatch holds on this gate until the advance notice
          // below has fully drained: its pre-spawn queue flush racing a notice
          // still pacing out trips the completed-with-pending-work invariant
          // and poisons the per-chat queue (live 2026-08-16).
          let releaseReplayDispatch!: () => void;
          const noticeDrained = new Promise<void>((resolve) => {
            releaseReplayDispatch = resolve;
          });
          const replayScheduled = this.scheduleFallbackReplay({
            activation: processFailure.activation,
            chatJid: deliveryJid,
            mapKey: currentMapKey,
            oldSession: session,
            hadToolActivity: crashTurnDeliveredOutput,
            forceFresh: true,
            preDispatch: noticeDrained,
          });
          noticeQueue?.enqueueText(renderFallbackAdvanceNotice({
            fromCard: modelCardLabel(processFailure.fromProvider, processFailure.fromModel ?? undefined),
            toCard: modelCardLabel(
              processFailure.activation.fallbackProvider,
              processFailure.activation.fallbackModel,
            ),
            replayScheduled,
          }));
          void Promise.resolve(noticeQueue?.flush())
            .catch((flushErr: unknown) => {
              // A failed notice flush must not strand the replay — its own
              // dispatch path reports queue failures with a user notice.
              log.debug({ err: flushErr, mapKey: currentMapKey }, 'advance notice flush failed before replay dispatch');
            })
            .finally(releaseReplayDispatch);
          // The crashed turn is finalized and the replacement dispatch (when
          // scheduled) owns the dead manager's disposal + recreation — the
          // respawn/heal machinery below must not touch this manager. Later
          // duplicate exit callbacks drop on the unmapped-manager guard.
          log.info({
            mapKey: currentMapKey,
            fromProvider: processFailure.fromProvider,
            fromModel: processFailure.fromModel,
            replayScheduled,
          }, 'fallback process failure handled as managed handoff');
          return;
        }
        noticeQueue?.enqueueText(renderFallbackAdvanceNotice({
          fromCard: modelCardLabel(processFailure.fromProvider, processFailure.fromModel ?? undefined),
          toCard: null,
          replayScheduled: false,
        }));
      }
    }

    const recoveryGeneration = owner.generation;
    const journaledCrashSeq = this.perChatInboundSeqQueue.get(currentMapKey)?.[0];
    const publishedCrashContexts = this.perChatRuntimeTurnContexts.get(currentMapKey) ?? [];
    const publishedCrashContext = publishedCrashContexts.length === 1
      ? publishedCrashContexts[0]
      : undefined;
    const activeTurnQueue = this.perChatTurnQueues.get(currentMapKey);
    const activeTurn = activeTurnQueue?.activeTurn;
    const activeTurnContext = activeTurn?.runtimeContext;
    const undispatchedCrashContext = publishedCrashContexts.length === 0
      && activeTurnContext?.identity.scope === 'per_chat'
      && activeTurn?.inboundSeq !== undefined
      && activeTurnContext.identity.inboundSeq === activeTurn.inboundSeq
      && journaledCrashSeq === activeTurn.inboundSeq
      ? activeTurnContext
      : undefined;
    const crashContext = publishedCrashContext ?? undispatchedCrashContext;
    const crashQueue = this.chatQueues.get(currentMapKey);
    if (publishedCrashContexts.length > 1) {
      log.error(
        { mapKey: currentMapKey, contextCount: publishedCrashContexts.length },
        'per-chat crash has multiple published turn owners; retaining the FIFO fail-closed',
      );
    }

    this.sessionOwnership.transition(currentMapKey, managerId, 'recoverable_dead');
    // #3395: a marked-intentional exit (#3394's takeIntentionalKill match —
    // the reap/suspend kill this manager issued on purpose) is a resumable
    // suspend-class exit, not a crash: it must not charge the auto-respawn
    // attempt budget, or a bot whose idle sessions are reaped repeatedly
    // exhausts the budget and goes dark. Unmarked exits — an external SIGTERM,
    // a bare 143 no marker claimed — keep counting, so a genuinely crashing
    // child still exhausts at the same threshold.
    const intentionalExit = info?.terminationReason !== undefined;
    if (!intentionalExit) this.recordCrash(currentMapKey);
    const crashCount = this.getCrashCount(currentMapKey);
    const exhausted = !intentionalExit && crashCount > AUTO_RESPAWN_MAX_CRASHES;
    if (exhausted) {
      this.terminalizeExhaustedPerChatSession(
        currentMapKey,
        session,
        managerId,
        recoveryGeneration,
        crashContext,
      );
    }
    if (undispatchedCrashContext) {
      const scopeRef = activeTurnQueue
        ? this.perChatTurnQueueKeys.get(activeTurnQueue) ?? { value: currentMapKey }
        : { value: currentMapKey };
      this.runtimeTurnCoordinator.terminalizeUndispatchedRuntimeCrash(
        undispatchedCrashContext,
        scopeRef,
      );
    } else if (!crashContext && journaledCrashSeq !== undefined) {
      // #3398: provider crash — salvage any owed reply before the wipe.
      crashQueue?.abortTurn({ preserveEvidence: true, salvageOwedReply: true });
      log.error(
        { mapKey: currentMapKey, inboundSeq: journaledCrashSeq },
        'journaled per-chat crash has no provable immutable context; retaining exhausted ownership',
      );
    } else {
      this.finalizeRuntimeCrash(crashContext, crashQueue, session, currentMapKey);
    }
    const tracker = this.operationTrackers.get(currentMapKey);
    tracker?.shutdown();
    this.operationTrackers.delete(currentMapKey);
    this.cleanupPerChatCrashTurnState(currentMapKey);
    const idleScheduledSession = isScheduledAgentJobMapKey(currentMapKey)
      && crashContext === undefined
      && journaledCrashSeq === undefined;
    if (idleScheduledSession) {
      this.chatQueues.get(currentMapKey)?.abortTurn();
      this.chatQueues.delete(currentMapKey);
      this.cleanupPerChatState(currentMapKey);
      this.deleteOwnedPerChatSession(currentMapKey, session);
      log.info(
        { mapKey: currentMapKey },
        'idle scheduled agent job session retired after provider exit',
      );
      return;
    }
    if (chatJid && info) {
      this.emitCrashHealReport(
        chatJid,
        info,
        crashContext !== undefined || journaledCrashSeq !== undefined,
      );
    }

    // Auto-respawn: if we haven't hit the crash limit, try to resume the session
    // after a short delay. This lets the agent continue mid-conversation without
    // requiring the user to send a new message.
    if (crashCount <= AUTO_RESPAWN_MAX_CRASHES && info?.sessionId) {
      const sessionId = info.sessionId;
      const dbRowId = info.dbRowId;
      const crashedAtSec = Math.floor(Date.now() / 1000);
      // crashCount can be 0 here (#3395: an uncharged intentional exit) —
      // clamp so the backoff exponent never goes negative.
      const delayMs = jitteredDelay(AUTO_RESPAWN_BASE_MS, Math.max(crashCount - 1, 0), AUTO_RESPAWN_MAX_DELAY_MS);
      log.info({ mapKey: currentMapKey, sessionId, attempt: crashCount, delayMs }, 'scheduling auto-respawn');
      const timer = setTimeout(() => {
        void this.runOwnedPerChatRespawn({
          initialMapKey: currentMapKey,
          chatJid,
          session,
          managerId,
          recoveryGeneration,
          sessionId,
          dbRowId,
          crashedAtSec,
          timer,
        });
      }, delayMs);
      if (this.sessionOwnership.setRespawnTimer(currentMapKey, managerId, recoveryGeneration, timer)) {
        this.pendingRespawnTimers.add(timer);
      } else {
        clearTimeout(timer);
      }
    } else if (exhausted) {
      this.exhaustedRespawnOwners.add(currentMapKey);
      // #3052: prune after 1h so a never-recovered conversation does not leak.
      // Unref so the timer does not prevent process shutdown.
      setTimeout(() => { this.exhaustedRespawnOwners.delete(currentMapKey); }, 3600_000).unref();
      log.error({ mapKey: currentMapKey, crashes: crashCount }, 'auto-respawn exhausted — emitting alert');
      emitAlertChecked(
        this.instanceName,
        'agent_respawn_failed',
        `whatsoup@${this.instanceName} agent respawn exhausted (${crashCount} crashes)`,
        [
          `Chat: ${currentMapKey}`,
          `Last exit: code=${info?.exitCode ?? '?'} signal=${info?.signal ?? 'none'}`,
          `Provider: ${info?.provider ?? 'unknown'}`,
          `Crash class: ${info?.crashClass ?? 'unknown'}`,
          info?.stderrPreview ? `Stderr preview: ${info.stderrPreview.slice(-500)}` : null,
        ].filter(Boolean).join('\n'),
      );
    }
  }

  private async runOwnedPerChatRespawn(args: {
    initialMapKey: string;
    chatJid?: string;
    session: SessionManager;
    managerId: string;
    recoveryGeneration: number;
    sessionId: string;
    dbRowId: number | null;
    crashedAtSec: number;
    timer: ReturnType<typeof setTimeout>;
  }): Promise<void> {
    this.pendingRespawnTimers.delete(args.timer);
    const mapKey = this.findMapKeyForSession(args.session, args.initialMapKey);
    if (!mapKey) return;
    if (
      !this.sessionOwnership.clearRespawnTimer(
        mapKey,
        args.managerId,
        args.recoveryGeneration,
        args.timer,
      )
    ) {
      const current = this.sessionOwnership.get(mapKey);
      if (current?.managerId === args.managerId && current.respawnTimer === args.timer) {
        this.sessionOwnership.clearRespawnTimer(
          mapKey,
          args.managerId,
          current.generation,
          args.timer,
        );
      }
      return;
    }

    const owner = this.sessionOwnership.get(mapKey);
    const status = args.session.getStatus();
    if (
      this.chatSessions.get(mapKey) !== args.session ||
      owner?.managerId !== args.managerId ||
      owner.generation !== args.recoveryGeneration ||
      owner.state !== 'recoverable_dead' ||
      status.active ||
      status.pid !== null
    ) {
      return;
    }

    // Route-currency guard: never resume a manager whose frozen provider/model
    // no longer matches the route a new session would resolve — a PRIMARY
    // manager auto-respawning into an active fallback window immediately
    // re-hits the failed primary (2026-08-15: resumed claude re-hit its usage
    // limit within seconds and re-extended the window), and a FALLBACK manager
    // resuming after a revert re-arms the dead backup. Pend the deferred
    // recycle instead: the next inbound detaches the stale manager at the
    // turn-idle boundary and rebuilds on the current route.
    if (!this.sessionMatchesCurrentRoute(args.session, args.chatJid)) {
      this.pendingRecycle.add(mapKey);
      log.info({
        mapKey,
        sessionProvider: args.session.getProviderId?.(),
        effectiveProvider: this.effectiveProvider,
      }, 'auto-respawn skipped — manager route is stale; recycle pended');
      return;
    }

    this.sessionOwnership.transition(mapKey, args.managerId, 'respawning');
    const respawnGeneration = this.sessionOwnership.advanceGeneration(mapKey, args.managerId);
    log.info({ mapKey, sessionId: args.sessionId, generation: respawnGeneration }, 'auto-respawn: attempting resume');

    try {
      await args.session.spawnSession(args.sessionId, args.dbRowId ?? undefined);
      const activeMapKey = await this.activateSpawnedOwnedPerChatSession(
        mapKey,
        args.session,
        { managerId: args.managerId, generation: respawnGeneration },
      );
      const tracker = this.createOperationTracker(
        args.session,
        () => {
          const currentMapKey = this.findMapKeyForSession(args.session, activeMapKey);
          return currentMapKey ? this.chatQueues.get(currentMapKey) : undefined;
        },
      );
      if (tracker) this.operationTrackers.set(activeMapKey, tracker);

      await sleep(1_000);
      if (
        this.chatSessions.get(activeMapKey) !== args.session ||
        !this.sessionOwnership.isCurrent(activeMapKey, args.managerId, respawnGeneration) ||
        this.sessionOwnership.get(activeMapKey)?.state !== 'active' ||
        !args.session.getStatus().active
      ) {
        return;
      }
      let respawnRecoveryPublished = false;
      const publishRespawnRecovery = (): void => {
        if (respawnRecoveryPublished) return;
        respawnRecoveryPublished = true;
        // Remove this conversation from the exhausted set (#2397).
        this.exhaustedRespawnOwners.delete(mapKey);
        if (this.exhaustedRespawnOwners.size > 0) {
          log.info(
            { remaining: [...this.exhaustedRespawnOwners].length },
            'respawn recovery: not clearing — other conversations still exhausted',
          );
          return;
        }
        clearAlertSourceChecked(this.instanceName, 'agent_respawn_failed');
      };
      let contextLease: SystemTurnLeaseToken | null = null;
      let continuationLease: SystemTurnLeaseToken | null = null;
      try {
        if (args.chatJid) {
          contextLease = this.markSystemTurn(
            args.session,
            activeMapKey,
            'respawn_context',
            args.chatJid,
          );
          const injected = await this.injectMissedMessages(
            args.session,
            args.chatJid,
            args.crashedAtSec,
            () => {
              this.requireSystemTurnProviderBoundary(contextLease!);
            },
          );
          if (!injected) this.pendingSystemResults.cancel(contextLease);
          else {
            await this.pendingSystemResults.waitUntilEmpty(activeMapKey);
            await this.waitForSystemTurnQuarantine(activeMapKey);
            if (!args.session.getStatus().active) return;
          }
        }
        // #3398: the post-turn gate armed by the pre-crash turn's completed
        // result survives the crash — no new user message has arrived to clear
        // it. Left in place, it suppresses the continuation reply as
        // 'post-turn gate: suppressed phantom assistant_text', silently
        // dropping a user-owed reply. Clear the per-chat entry (and, outside
        // per_chat scope, the shared entry gating keys on) before dispatching
        // the continuation. Trade (reviewed): if a queued user turn completed
        // inside the awaits above, its legitimately armed gate is wiped too —
        // worst case one leaked phantom line, chosen over silently dropping
        // the user-owed continuation reply.
        this.postTurnGate.delete(activeMapKey);
        if (this.sessionScope !== 'per_chat') this.postTurnGate.delete(GLOBAL_TOOL_SCOPE_KEY);
        continuationLease = this.markSystemTurn(
          args.session,
          activeMapKey,
          'respawn_continuation',
          args.chatJid,
        );
        await this.dispatchSystemTurn(
          args.session, '[System: session resumed after crash — continue where you left off]',
          continuationLease!, publishRespawnRecovery,
        );
        log.info({ mapKey: activeMapKey }, 'sent continuation turn after auto-respawn');
      } catch (err) {
        log.warn({ err, mapKey: activeMapKey }, 'failed to send continuation turn after auto-respawn');
        await this.settleFailedSystemTurnDispatch(
          args.session,
          activeMapKey,
          continuationLease ?? contextLease,
          err,
        );
      }
    } catch (err) {
      const currentMapKey = this.findMapKeyForSession(args.session, mapKey);
      if (
        currentMapKey &&
        this.sessionOwnership.isCurrent(currentMapKey, args.managerId, respawnGeneration)
      ) {
        const failedStatus = args.session.getStatus();
        this.sessionOwnership.transition(
          currentMapKey,
          args.managerId,
          !failedStatus.active && failedStatus.pid === null ? 'recoverable_dead' : 'closing',
        );
      }
      log.warn({ err, mapKey, sessionId: args.sessionId }, 'auto-respawn resume failed — will retry on next message');
    }
  }

  private terminalizeExhaustedPerChatSession(
    mapKey: string,
    session: SessionManager,
    managerId: string,
    generation: number,
    crashContext?: RuntimeTurnContext,
  ): void {
    if (
      this.chatSessions.get(mapKey) !== session ||
      !this.sessionOwnership.isCurrent(mapKey, managerId, generation)
    ) {
      return;
    }
    const owner = this.sessionOwnership.get(mapKey);
    if (!owner) return;
    this.clearOwnedRespawnTimer(mapKey, owner);
    this.sessionOwnership.transition(mapKey, managerId, 'exhausted');
    const journaledInboundSeq = this.perChatInboundSeqQueue.get(mapKey)?.[0];
    if (!crashContext && journaledInboundSeq !== undefined) {
      log.error(
        { mapKey, inboundSeq: journaledInboundSeq },
        'exhausted per-chat session retained because its journaled turn has no immutable context',
      );
      return;
    }
    const release = (): void => {
      const releaseKey = this.findMapKeyForSession(session, mapKey);
      if (
        !releaseKey ||
        this.chatSessions.get(releaseKey) !== session ||
        !this.sessionOwnership.isCurrent(releaseKey, managerId, generation)
      ) {
        return;
      }
      this.chatQueues.get(releaseKey)?.abortTurn();
      this.chatQueues.delete(releaseKey);
      this.cleanupPerChatState(releaseKey, { preserveCrashHistory: true });
      // Drop the session entry and the ownership record together. Releasing
      // them separately can desync — this closure may run long after the
      // ownership state was set, and a release rejected on an unexpected state
      // would strand one half of the pair.
      this.deleteOwnedPerChatSession(releaseKey, session);
    };
    if (crashContext) {
      this.runtimeTurnCoordinator.appendRuntimeTurnAfterTerminalAction(
        crashContext,
        release,
      );
      return;
    }
    release();
  }

  private cleanupSharedCrashTurnState(): void {
    this.pendingSystemResults.clearScope(GLOBAL_TOOL_SCOPE_KEY);
    this.legacyProviderTurnOwners.delete(GLOBAL_TOOL_SCOPE_KEY);
    this.activeToolNames.clear();
    this.turnHadToolActivity.clear();
    this.singleTurnHadToolActivity = false;
    this.turnHadVisibleOutput = false;
    this.turnHadSuppressedReplySatisfaction = false;
    this.currentTurnChatJid = null;
    this.currentTurnReplayText = null;
    this.currentTurnReplayActorJid = undefined;
    this.currentTurnReplayPurpose = undefined;
    this.currentTurnInboundContentType = null;
    this.currentTurnSourceMessageId = null;
    this.currentTurnAssistantText = '';
    this.currentTurnAssistantItemText.clear();
    // Shutdown operation tracker on crash (timers must be cleared)
    this.operationTracker?.shutdown();
    this.operationTracker = null;
    // If a compact_boundary was already observed before the crash, the SDK
    // produced a fresh compacted context — persist the baseline before
    // dropping the flag, so the next turn doesn't immediately re-fire
    // /compact against a stale lastCompactInputTokens.
    this.persistBaselineIfBoundaryObserved(GLOBAL_TOOL_SCOPE_KEY, this.session?.getDbRowId() ?? null);
    this.consumeCompactBoundary(GLOBAL_TOOL_SCOPE_KEY);
    this.finishAutoCompact(GLOBAL_TOOL_SCOPE_KEY);
    this.clearSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
  }

  private cleanupPerChatCrashTurnState(mapKey: string): void {
    this.pendingSystemResults.clearScope(mapKey);
    this.legacyProviderTurnOwners.delete(mapKey);
    // F-STICKY-ACTOR (QR-247, S-CRASH): a crash discards ALL of the subprocess's
    // in-flight turns (executing + buffered), so clear the WHOLE executing-actor
    // queue — NOT shift-one. This runs synchronously in handlePerChatCrash BEFORE
    // the auto-respawn setTimeout, so the direct-sendTurn continuation hits an empty
    // queue -> fail-closed deny, and a later user turn cannot append behind a stale
    // (possibly admin) head and be served that actor = escalation.
    this.perChatExecActorQueue.delete(mapKey);
    this.clearToolScopeFor(mapKey);
    this.singleTurnHadToolActivity = false;
    this.turnHadVisibleOutput = false;
    this.currentTurnChatJid = null;
    this.perChatTurnSourceMessageId.delete(mapKey);
    this.perChatTurnContentType.delete(mapKey);
    this.perChatTurnText.delete(mapKey);
    this.perChatTurnSuppressedReplySatisfaction.delete(mapKey);
    this.perChatAssistantItemText.delete(mapKey);
    // Persist baseline first if compact_boundary was observed — see
    // cleanupSharedCrashTurnState for rationale.
    this.persistBaselineIfBoundaryObserved(mapKey, this.chatSessions.get(mapKey)?.getDbRowId() ?? null);
    this.consumeCompactBoundary(mapKey);
    this.finishAutoCompact(mapKey);
    this.clearSilentCompact(mapKey);
  }

  /**
   * On crash cleanup, if compact_boundary was already observed for `scopeKey`
   * (the SDK emitted boundary but the `result` event never landed), persist
   * the baseline now. Otherwise the next turn re-fires /compact against a
   * stale lastCompactInputTokens — one redundant compact per
   * crash-during-compact.
   */
  private persistBaselineIfBoundaryObserved(scopeKey: string, rowId: number | null): void {
    if (rowId === null) return;
    if (!this.autoCompact.compactBoundaryScopes.has(scopeKey)) return;
    markSessionCompacted(this.db, rowId);
    this.recordAutoCompactSuccess(scopeKey);
    log.info({ scopeKey, rowId }, 'auto compact baseline persisted on crash cleanup (compact_boundary observed pre-crash)');
  }

  /**
   * Routes a crash notification through the outbound queue so it arrives after
   * any partial turn output that was already enqueued before the crash.
   * Falls back to a direct send if the queue is gone.
   */
  /**
   * Sessions whose latest crash was handled as a MANAGED fallback handoff
   * (chain advance / single-entry preservation notice already sent), mapped
   * to the mark time. Raw "Agent session ended (exited with code N)" lines
   * from such a session are suppressed for a short EPISODE WINDOW rather
   * than one-shot-consumed: the session layer can emit more than one exit
   * notification for the same crash episode — observed live 2026-08-16
   * (round-5 cascade): the pended post-transition route recycle tore the
   * crashed manager down ~600ms after its managed notice, and the teardown's
   * second exit notification leaked the raw line past the already-consumed
   * one-shot mark. Window-scoped suppression swallows every echo of the
   * same episode while a genuinely new crash of the (respawned) manager
   * minutes later still notifies normally. WeakMap: a discarded manager's
   * entry vanishes with it.
   */
  private readonly managedCrashNotices = new WeakMap<SessionManager, number>();
  private static readonly MANAGED_CRASH_SUPPRESS_WINDOW_MS = 5_000;

  /**
   * Stand-in managers that already received their one-shot handoff
   * introduction block (see the fresh-spawn context assembly) — spawn-per-turn
   * providers reuse the manager across turns, so without this the stand-in
   * would re-introduce itself on every message.
   */
  private readonly introducedStandIns = new WeakSet<SessionManager>();

  /** Whether `session` is inside its managed-crash suppression window. */
  private managedCrashNoticeActive(session: SessionManager | undefined): boolean {
    if (!session) return false;
    const markedAt = this.managedCrashNotices.get(session);
    if (markedAt === undefined) return false;
    return systemClock.now() - markedAt <= AgentRuntime.MANAGED_CRASH_SUPPRESS_WINDOW_MS;
  }

  private handleCrashNotify(msg: string, chatJid?: string, session?: SessionManager): void {
    // A crash the fallback machinery already handled as a managed handoff has
    // its user-facing copy sent by that path — drop the raw session-crash line
    // (and every same-episode echo of it; see managedCrashNotices).
    if (this.managedCrashNoticeActive(session)) return;
    // In per_chat mode, chatJid MUST be passed — this.queue is not set.
    // In single/shared mode, chatJid is optional (falls back to shared fields).
    const queue = chatJid ? this.getQueueForChat(chatJid) : this.queue;
    if (queue) {
      queue.enqueueText(msg);
      const scopeKey = this.sessionScope === 'per_chat' && chatJid
        ? this.resolvePerChatMapKey(chatJid)
        : GLOBAL_TOOL_SCOPE_KEY;
      this.observeOutboundQueueOperation(scopeKey, queue, () => queue.flush())
        .catch((err) => log.error({ err }, 'flush after crash failed'));
    } else {
      const target = chatJid ?? this.activeChatJid;
      if (target) {
        this.messenger
          .sendMessage(target, msg)
          .catch((err) => log.error({ err }, 'crash notice fallback send failed'));
      }
    }
  }

  /**
   * Inject messages the agent missed during downtime into a resumed session.
   * Uses `sinceUnixSec` (typically the checkpoint's updated_at) to fetch only
   * messages that arrived after the session was last active.
   * Returns true if any context was injected.
   */
  private async injectMissedMessages(
    session: SessionManager,
    chatJid: string,
    sinceUnixSec: number,
    onProviderBoundaryReady: () => void = () => {},
  ): Promise<boolean> {
    let lines: string;
    let messageCount: number;
    try {
      const convKey = canonicalConversationKey(chatJid, this.db);
      const missed = getMessagesSince(this.db, convKey, sinceUnixSec, 30);
      if (missed.length === 0) return false;
      lines = formatContextLines(missed, this.isCrossProviderSession(session));
      messageCount = missed.length;
    } catch (err) {
      log.warn({ err, chatJid }, 'missed message lookup failed — agent continues without context');
      return false;
    }
    // Dispatch errors propagate so the caller can distinguish a proven
    // pre-dispatch failure from an ambiguous accepted write and quarantine the
    // provider generation before releasing this system lease.
    await dispatchProviderTurn(
      session,
      `[Recent chat context — read before responding]\n${lines}`,
      onProviderBoundaryReady,
    );
    log.info({ chatJid, messageCount, sinceUnixSec }, 'injected missed messages after resume');
    return true;
  }

  /**
   * Called by SessionManager when a --resume attempt is rejected by Claude
   * (exit code 1, no init event). Sends a clear status message and spawns a
   * fresh session so the user can continue without manual intervention.
   */
  private handleResumeFailed(chatJid: string): void {
    log.warn({ chatJid }, 'resume failed — spawning fresh session');

    // Resolve the correct session and mapKey — sandboxPerChat uses the per-chat map,
    // single/shared mode uses the shared this.session field.
    let session: SessionManager | undefined;
    let mapKey: string | undefined;
    if (this.sandboxPerChat) {
      const ws = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);
      mapKey = ws.workspaceKey;
      session = this.chatSessions.get(mapKey);
    } else {
      session = this.session ?? undefined;
    }
    if (mapKey) this.abortImageCoalesceBuffer(mapKey, 'resume_failed');
    if (!session) {
      log.warn({ chatJid }, 'handleResumeFailed: no session — skipping');
      return;
    }

    // Pending-turn replay only applies to sandboxPerChat (per_chat) mode.
    // sendTurnPerChat sets pendingTurnText[mapKey] before calling sendTurnToSession,
    // so if a resume fails mid-send the turn text is available for replay.
    // single/shared mode uses sendTurnNonShared → sendTurnToSession directly and never
    // populates pendingTurnText, so mapKey is undefined here and pendingText will
    // always be undefined — which is correct, as no turn is in-flight at resume time.
    const pendingText = mapKey ? this.pendingTurnText.get(mapKey) : undefined;
    const pendingActorJid = mapKey ? this.pendingTurnActorJid.get(mapKey) : undefined;

    if (!pendingText) {
      // No pending message — notify user to resend
      const msg = '_Previous session expired_ — starting fresh. Send a message to begin.';
      if (this.pendingStartupEvent !== null) {
        this.pendingStartupEvent = { kind: 'expired_session_notice', chatJid, text: msg };
      } else {
        this.sendDirect(chatJid, msg);
      }
    }

    // Mark this mapKey as owned by handleResumeFailed before spawning
    // so that any concurrent sendTurnToSession call for the same chat skips its own
    // context injection (preventing double context blocks on the fresh session).
    if (mapKey) this.resumeFailedHandling.add(mapKey);

    // Spawn a clean session and replay the pending turn if one exists.
    // The `pendingText && mapKey` guard below is a no-op for single/shared mode
    // (mapKey is always undefined) — replay is sandboxPerChat-only by design.
    const resumeOwnership = mapKey
      ? this.captureOwnedPerChatGeneration(mapKey, session)
      : null;
    session
      .spawnSession()
      .then(async () => {
        if (mapKey && resumeOwnership) {
          mapKey = await this.activateSpawnedOwnedPerChatSession(mapKey, session, resumeOwnership);
        }

        // context injection + replay wrapped in turnChain to preserve serialization
        this.turnChain = this.turnChain.then(async () => {
          // Clear the resumeFailedHandling flag once we are inside the chain —
          // the context injection below is about to run, after which concurrent
          // sendTurnToSession calls may inject normally.
          if (mapKey) this.resumeFailedHandling.delete(mapKey);

          let contextLease: SystemTurnLeaseToken | null = null;
          try {
            const recent = contextMessagesForTurn(
              getRecentMessages(this.db, canonicalConversationKey(chatJid, this.db), 30), pendingText, pendingActorJid);
            if (recent.length > 0) {
              const lines = formatContextLines(recent, this.isCrossProviderSession(session));
              // QR-095: same fix as the sendTurnToSession injection — in single/
              // shared mode mapKey is undefined here, so mark under GLOBAL to match
              // the single/shared consumeIfPending(GLOBAL_TOOL_SCOPE_KEY); otherwise
              // the '[CONTEXT RECOVERY]' system turn's result leaks to the user.
              // No-op in per_chat (mapKey defined, consumed per-chat).
              contextLease = this.markSystemTurn(
                session,
                mapKey ?? GLOBAL_TOOL_SCOPE_KEY,
                'resume_failure_context',
                chatJid,
              );
              await this.dispatchSystemTurn(
                session, `[CONTEXT RECOVERY — prior session expired]\n${lines}`, contextLease!,
              );
              await this.pendingSystemResults.waitUntilEmpty(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
              await this.waitForSystemTurnQuarantine(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
              if (!session.getStatus().active) return;
            }
          } catch (err) {
            log.warn({ err, chatJid }, 'context recovery failed — starting blank session');
            await this.settleFailedSystemTurnDispatch(
              session,
              mapKey ?? GLOBAL_TOOL_SCOPE_KEY,
              contextLease,
              err,
            );
          }
          // Replay the pending turn that was lost during the failed resume
          if (pendingText && mapKey) {
            log.info({ chatJid, mapKey, textPreview: providerPreview(pendingText, 80) }, 'replaying pending turn after resume failure');
            try {
              await session.sendTurn(renderPendingReplay(this.turnChronology, pendingText,
                this.perChatRuntimeTurnContexts.get(mapKey)?.[0], this.perChatTurnQueues.get(mapKey)?.activeTurn ?? null));
            } catch (err) {
              log.warn({ err, chatJid }, 'pending turn replay failed');
              // Retain the replay evidence. A failed or ambiguously accepted
              // write must never silently discard the user's original turn.
            }
          }
        }).catch((err) => {
          log.error({ err, chatJid, mapKey }, 'context recovery turn failed after resume failure');
        });
      })
      .catch((err) => {
        if (mapKey) this.resumeFailedHandling.delete(mapKey);
        log.error({ err }, 'failed to spawn fresh session after resume failure');
      });
  }

  /**
   * Synthesize the agent's text response via ElevenLabs and send as a PTT voice note.
   * Non-fatal — called after the text response has already been delivered. (SP4)
   */
  private async _sendVoiceReply(chatJid: string, responseText: string): Promise<void> {
    try {
      const voiceResult = await synthesizeSpeech(responseText, {
        voiceId: config.elevenlabs.defaultVoiceId,
        modelId: config.elevenlabs.defaultModel,
        stability: config.elevenlabs.stability,
        similarityBoost: config.elevenlabs.similarityBoost,
      });

      const voicePath = writeTempFile(voiceResult.buffer, 'mp3');
      const { readFileSync } = await import('node:fs');
      const voiceBuffer = readFileSync(voicePath);

      await (this.messenger as ConnectionManager).sendMedia(chatJid, {
        type: 'audio',
        buffer: voiceBuffer,
        mimetype: 'audio/mpeg',
        ptt: true,
        seconds: voiceResult.duration,
      });

      log.info({ chatJid, duration: voiceResult.duration }, 'voice reply sent');
    } catch (err) {
      // Non-fatal: text response was already sent. Log and continue.
      log.warn({ err, chatJid }, 'voice reply failed — text response already sent');
    }
  }

  private handleEvent(sourceSession: SessionManager, event: AgentEvent): void {
    if (
      sourceSession !== this.session
      || this.sessionEventToolScopes.get(sourceSession) !== GLOBAL_TOOL_SCOPE_KEY
    ) {
      this.rejectProviderEvent(
        event.type,
        'singleton_shared',
        'none',
        'source_session_not_current',
        sourceSession,
      );
      return;
    }
    const managerId = this.sessionManagerIds.get(sourceSession);
    if (!managerId) {
      this.rejectProviderEvent(
        event.type,
        'singleton_shared',
        'none',
        'source_generation_not_current',
        sourceSession,
      );
      return;
    }
    const runtimeContext = this.runtimeTurnCoordinator.runtimeTurnContext();
    const runtimeOwnerMatches = runtimeContext !== null
      && runtimeContext.identity.managerId === managerId
      && runtimeContext.identity.generation === 1
      && runtimeContext.toolScopeKey === GLOBAL_TOOL_SCOPE_KEY;
    const legacyOwner = this.legacyProviderTurnMatches(
      GLOBAL_TOOL_SCOPE_KEY,
      managerId,
      1,
      GLOBAL_TOOL_SCOPE_KEY,
    );
    const logicalOwnerMatches = runtimeOwnerMatches || legacyOwner !== null;
    const systemTurn = this.pendingSystemResults.peek(GLOBAL_TOOL_SCOPE_KEY);
    const systemOwnerMatches = systemTurn?.owner != null
      && systemTurn.owner.managerId === managerId
      && systemTurn.owner.generation === 1
      && systemTurn.owner.toolScopeKey === GLOBAL_TOOL_SCOPE_KEY;
    const resolved = this.resolveProviderEventOwner(
      event,
      logicalOwnerMatches,
      systemOwnerMatches ? systemTurn : null,
    );
    const decision = decideProviderEventAdmission(event, resolved.owner);
    if (!decision.admit) {
      this.rejectProviderEvent(
        event.type,
        'singleton_shared',
        resolved.owner.kind,
        decision.reason,
        sourceSession,
      );
      return;
    }
    if (event.type === 'ignored') return;

    const routeChatJid = resolved.owner.kind === 'logical_turn'
      ? (runtimeOwnerMatches
          ? runtimeContext!.identity.deliveryJid
          : legacyOwner?.routeChatJid)
      : resolved.systemTurn?.routeChatJid;
    let queue = this.shared
      ? (routeChatJid
          ? this.outboundQueues.get(routeChatJid)
            ?? this.outboundQueues.get(canonicalizeChatJid(routeChatJid, this.db))
            ?? null
          : null)
      : this.queue;
    if (!queue && event.type === 'result' && routeChatJid) {
      queue = this.createOutboundQueue(routeChatJid, 'provider terminal route recovery');
      if (this.shared) this.outboundQueues.set(routeChatJid, queue);
      else this.queue = queue;
      log.warn(
        { routeChatJid, ownerKind: resolved.owner.kind, shared: this.shared },
        'reconstructed missing output route for an owned provider terminal',
      );
    }
    const resultNeedsRoute = event.type === 'result'
      && (
        resolved.owner.kind === 'logical_turn'
        || (resolved.systemTurn !== null && systemPurposeAllowsOutput(resolved.systemTurn.purpose))
      );
    if (resultNeedsRoute && !queue) {
      this.rejectProviderEvent(
        event.type,
        'singleton_shared',
        resolved.owner.kind,
        'owner_queue_missing',
        sourceSession,
      );
      return;
    }

    if (
      event.type === 'result'
      && resolved.owner.kind === 'logical_turn'
      && legacyOwner !== null
    ) {
      this.clearLegacyProviderTurn(GLOBAL_TOOL_SCOPE_KEY, legacyOwner);
    }

    let consumedSystemTurn: PendingSystemTurnSnapshot | null = null;
    if (event.type === 'result' && resolved.systemTurn) {
      consumedSystemTurn = this.pendingSystemResults.consumeResult(resolved.systemTurn.lease);
      if (!consumedSystemTurn) {
        this.rejectProviderEvent(
          event.type,
          'singleton_shared',
          'system_request',
          'system_owner_race',
          sourceSession,
        );
        return;
      }
      this.releaseSystemTurnExecutingActor(consumedSystemTurn);
      if (!systemPurposeAllowsOutput(consumedSystemTurn.purpose)) {
        this.handleRestrictedSystemResult(
          sourceSession,
          GLOBAL_TOOL_SCOPE_KEY,
          consumedSystemTurn,
          event,
          this.operationTracker,
        );
        return;
      }
    }

    if (!queue) {
      if (event.type === 'init') {
        log.debug('session init observed without an active output route');
        return;
      }
      this.rejectProviderEvent(
        event.type,
        'singleton_shared',
        resolved.owner.kind,
        'owner_queue_missing',
        sourceSession,
      );
      return;
    }

    const tracker = this.operationTracker;

    switch (event.type) {
      case 'init':
        log.debug({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, sessionId: event.sessionId }, 'session init');
        break;

      case 'assistant_text':
        this.session?.tickWatchdog();
        tracker?.onAnyActivity();
        // Post-turn gate: suppress phantom assistant_text (same as handleEventWithContext)
        if (this.postTurnGate.has(GLOBAL_TOOL_SCOPE_KEY)) {
          log.info({ textPreview: providerPreview(event.text, 200) }, 'post-turn gate: suppressed phantom assistant_text (shared)');
          break;
        }
        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) break;

        {
          const rawAssistantText = this.normalizeAssistantTextForDelivery(event);
          if (!rawAssistantText) break;
          // Slice-3 NL routing: consume typed intent markers before delivery
          // (flag off → pass-through, byte-identical). Streaming-safe: the
          // first line is buffered across token deltas so a split marker never
          // leaks (R1).
          let normalizedText: string | null;
          if (config.nlRouting) {
            const step = this.scanRouteMarkerDelta(
              this.currentTurnRouteMarkerHold,
              rawAssistantText,
              (this.shared ? this.currentTurnChatJid : this.activeChatJid) ?? queue.targetChatJid,
              this.currentTurnReplayActorJid,
            );
            this.currentTurnRouteMarkerHold = step.held;
            normalizedText = step.deliver;
          } else {
            normalizedText = rawAssistantText;
          }
          if (!normalizedText) break;
          if (this.enqueueAutoSwitchNotice(queue, normalizedText, this.shared ? this.currentTurnChatJid : this.activeChatJid, 'streaming')) {
            this.turnHadVisibleOutput = true;
            break;
          }
          // Two-tier provider-failure gate (QR-209) — same policy as the per-chat
          // handler. Fallback is armed on the terminal 'result' event, not here.
          // Only BANNER-confident text (the error itself) is suppressed; AMBIENT
          // prose about an error is delivered, so genuine replies are never silently
          // dropped. See suppressStreamedProviderFailure.
          const sharedChatJid = this.shared ? this.currentTurnChatJid : this.activeChatJid;
          const providerFailureCheck = this.suppressStreamedProviderFailure(normalizedText, sharedChatJid);
          if (providerFailureCheck.suppress) break;
          const gatedText = this.gateAssistantTextForOutbound(normalizedText, queue, this.currentInboundSeq);
          this.logAmbientProviderFailureOutcome(providerFailureCheck.ambient, normalizedText, sharedChatJid, gatedText !== null);
          normalizedText = gatedText;
          if (!normalizedText) break;
          const markReplayUnsafe = this.pendingSystemResults.count(GLOBAL_TOOL_SCOPE_KEY) === 0;
          if (config.toolUpdateMode === 'minimal') {
            const committedText = normalizedText;
            queue.enqueueStreamingText(committedText, 'answer', () => {
              this.turnHadVisibleOutput = true;
              if (markReplayUnsafe) {
                this.runtimeTurnCoordinator.markRuntimeTurnReplayUnsafe();
              }
              this.replyGuarantee?.notifyActivity(queue.targetChatJid);
              this.currentTurnAssistantText += committedText;
            });
          } else {
            queue.enqueueStreamingText(normalizedText);
            this.turnHadVisibleOutput = true;
            if (markReplayUnsafe) {
              this.runtimeTurnCoordinator.markRuntimeTurnReplayUnsafe();
            }
            // Reply-guarantee: visible output reached the user — reset the silence
            // window so the "still working" fallback only fires after a full window
            // of TRUE silence, not while a long turn is actively streaming replies.
            this.replyGuarantee?.notifyActivity(queue.targetChatJid);
            // Accumulate text for voice reply (SP4)
            this.currentTurnAssistantText += normalizedText;
          }
        }
        break;

      case 'tool_use':
        this.session?.trackToolStart(event.toolId);
        this.session?.tickWatchdog();
        // Post-turn gate: suppress phantom tool_use (same as handleEventWithContext)
        if (this.postTurnGate.has(GLOBAL_TOOL_SCOPE_KEY)) {
          log.info({ toolName: event.toolName }, 'post-turn gate: suppressed phantom tool_use (shared)');
          break;
        }
        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) break;

        if (this.pendingSystemResults.count(GLOBAL_TOOL_SCOPE_KEY) === 0 && this.currentRuntimeTurnContext) {
          this.currentRuntimeTurnContext = markRuntimeTurnReplayUnsafe(this.currentRuntimeTurnContext);
        }

        queue.discardPreToolAssistantText?.();

        // AskUserQuestion → Poll bridge is NOT supported in shared mode.
        // Shared mode's turn lifecycle (currentTurnChatJid, turnQueue) makes
        // safe answer injection non-trivial — currentTurnChatJid is cleared
        // after the result event, so the injected answer turn would have no
        // queue context and events would be dropped. Future enhancement.
        // In shared mode, AskUserQuestion falls through to normal tool_use
        // handling — Claude's auto-resolved error is shown to the user.
        if (event.toolName === 'AskUserQuestion') {
          log.info({ toolName: event.toolName }, 'AskUserQuestion poll bridge not supported in shared mode — falling through to normal handling');
        }

        this.getToolNames(GLOBAL_TOOL_SCOPE_KEY).set(event.toolId, event.toolName);
        this.singleTurnHadToolActivity = true;
        {
          const toolUpdate = buildToolUpdate(event.toolName, event.toolInput ?? {});
          queue.enqueueToolUpdate(toolUpdate);
          tracker?.onToolStart(event.toolId, event.toolName, toolUpdate.category);
        }
        break;

      // @check CHK-023
      // @traces REQ-005.AC-05
      case 'compact_boundary':
        this.session?.tickWatchdog();
        tracker?.onAnyActivity();
        this.autoCompact.compactBoundaryScopes.add(GLOBAL_TOOL_SCOPE_KEY);
        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) {
          log.info({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid }, 'silent agent compact boundary observed');
          break;
        }
        // Start the composing indicator so the user sees activity during compaction,
        // then send the notification. The indicator stays alive via the heartbeat
        // until the turn's result event fires flush().
        queue.indicateTyping();
        queue.enqueueText(
          'Context compacted — older details summarized. Restate any important context I should carry forward.',
        );
        this.turnHadVisibleOutput = true;
        break;

      case 'tool_result':
        this.session?.trackToolEnd(event.toolId);
        this.session?.tickWatchdog();
        tracker?.onToolEnd(event.toolId);

        // Note: AskUserQuestion poll bridge is per_chat only. In shared mode,
        // tool_result flows normally (no suppression needed — interception is
        // not active). suppressedAskUserToolIds is only populated by per_chat
        // handleEventWithContext.

        if (this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY)) break;
        const toolNames = this.activeToolNames.get(GLOBAL_TOOL_SCOPE_KEY);
        const trackedToolName = toolNames?.get(event.toolId);
        const resultToolName = event.toolName?.trim() || undefined;
        if (trackedToolName === undefined) {
          this.singleTurnHadToolActivity = true;
          if (this.pendingSystemResults.count(GLOBAL_TOOL_SCOPE_KEY) === 0 && this.currentRuntimeTurnContext) {
            this.currentRuntimeTurnContext = markRuntimeTurnReplayUnsafe(this.currentRuntimeTurnContext);
          }
        }
        if (event.isError) {
          const toolName = trackedToolName ?? resultToolName ?? 'unknown';
          const errorPreview = event.content.length > 200 ? `${providerPreview(event.content, 200)}...` : providerPreview(event.content, event.content.length);
          log.warn({
            chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid,
            toolId: event.toolId,
            toolName,
            error: errorPreview,
          }, 'tool error reported by agent');
          const classification = classifyToolError(toolName, event.content);
          queue.enqueueToolUpdate(classification);
          maybeEmitToolFailureAlert({
            chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid,
            toolId: event.toolId,
            toolName,
            content: event.content,
            classification,
            toolScopeKey: GLOBAL_TOOL_SCOPE_KEY,
          }, this.toolFailureAlertDeps());
        }
        toolNames?.delete(event.toolId);
        if (toolNames && toolNames.size === 0) {
          this.activeToolNames.delete(GLOBAL_TOOL_SCOPE_KEY);
        }
        break;

      case 'result':
        handleGlobalRuntimeResult(this.runtimeTurnHost, {
          event,
          queue,
          systemTurnPurpose: consumedSystemTurn?.purpose ?? null,
          tracker: tracker ?? undefined,
          extractUsageLimitResetTime,
        });
        break;
      case 'token_usage':
        // Record token usage without triggering turn completion (non-per-chat path).
        if (
          !this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY) &&
          this.pendingSystemResults.count(GLOBAL_TOOL_SCOPE_KEY) === 0
        ) {
          this.recordAutoCompactNextTurnIfNeeded(GLOBAL_TOOL_SCOPE_KEY, event.inputTokens, false);
        }
        if (event.inputTokens !== undefined || event.outputTokens !== undefined) {
          const rowId = this.session?.getDbRowId() ?? null;
          if (rowId !== null) {
            const { newInputTokens, cacheReadTokens } = splitInputTokenUsage(event);
            accumulateTokensWithEvent(this.db, rowId, newInputTokens, event.outputTokens ?? 0, cacheReadTokens);
          }
        }
        break;

      case 'unknown_block':
      case 'unknown':
      case 'parse_error':
        log.debug({ event }, 'ignored/unknown_block/unknown/parse_error event');
        break;
    }
  }

}
