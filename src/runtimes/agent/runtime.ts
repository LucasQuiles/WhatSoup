// src/runtimes/agent/runtime.ts
// AgentRuntime implements the Runtime interface, tying all agent components together.

import type { AgentCommandRequest, AgentCommandResult, Runtime, RuntimeTurnCapabilityHealth } from '../types.ts';
import type { IncomingMessage, Messenger, RuntimeHealth } from '../../core/types.ts';
import type { Database } from '../../core/database.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import type { AgentEvent } from './stream-parser.ts';
import {
  classifyProviderFailure,
  classifyStreamedProviderFailure,
  detectAutoSwitchNotice,
  isProviderAuthRequiredMessage,
  MAX_STREAMED_BANNER_LENGTH,
} from './failure-taxonomy.ts';
import {
  workflowForProviderText,
  type ResponseWorkflow,
  type UserTemplateId,
} from './response-registry.ts';
import { autoSwitchNoticeMessage, renderUserMessage, providerUnknownTerminalNotice } from './response-templates.ts';
import { runDiagnosticBundle } from './diagnostic-bundle.ts';
import { buildDiagnosticProbes } from './diagnostic-probes.ts';
import {
  ensureStandbyNoticeSchema,
  stashStandbyNotice,
  consumeStandbyNotice,
  clearStandbyNotice,
} from './standby-notice.ts';
import { sanitizeProviderPreviewText } from './provider-preview-sanitizer.ts';
import { redactHandoffPii } from './handoff-pii-redactor.ts';
import { seamForProvider } from './handoff-seam-routing.ts';
import { ensureHandoffArtifactSchema, getHandoffArtifact, deleteHandoffArtifact } from './handoff-artifact.ts';
import { buildHandoffPrelude } from './handoff-prelude.ts';
import type { AgentProvider } from './providers/types.ts';
import { EmitHealResultSchema } from '../../core/heal-protocol.ts';
import { buildRestartSelfTool, triggerSelfRestart, type ServiceRestarter } from './self-restart.ts';
import { dequeueNextReport, emitHealReport, parseHealContext } from '../../core/heal.ts';
import { sendTracked } from '../../core/durability.ts';
import { classifyErrorForInbound } from '../../core/inbound-failure-class.ts';
import {
  normalizeFallbackEntriesFromAgentOptions,
  type AgentFallbackEntry,
} from '../../core/fallback-chain.ts';
import {
  createReplyGuaranteeLivenessSender,
  DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS,
  ReplyGuaranteeManager,
} from '../../core/reply-guarantee.ts';
import { emitAlertChecked, clearAlertSourceChecked } from '../../lib/emit-alert.ts';
import { lookupCredential, resolveProviderKeyService } from '../../lib/keyring.ts';
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
import {
  ensureFallbackStateSchema,
  saveFallbackState,
  loadFallbackState,
  clearFallbackState,
} from './fallback-state-db.ts';
import { chatJidToWorkspace, provisionWorkspace, writeSandboxArtifacts, ensurePermissionsSettings } from '../../core/workspace.ts';
import { classifyActiveSessions } from './session-classifier.ts';
import { SessionManager, formatAge, getProviderBinary, type SessionCrashInfo } from './session.ts';
import {
  OutboundQueue,
  type IOutboundQueue,
  type ToolUpdate,
  type ToolCategory,
} from './outbound-queue.ts';
import { ControlQueue } from './control-queue.ts';
import { classifyInput } from './commands.ts';
import {
  ensureChatPreferenceSchema,
  getPreference,
  setPreference,
  clearPreference,
  pruneExpired,
  type ChatModelPreference,
  type PreferenceIntent,
} from './chat-preference-db.ts';
import { preferenceKeys } from './preference-keys.ts';
import { resolveRoute, type RouteDecision } from './route-resolution.ts';
import { deriveChatScope, emitRouteEvent, type ModelRouteEvent } from './route-events.ts';
import { buildRoutingPromptContract, extractRouteIntents } from './route-intent.ts';
import { isProviderId } from './providers/index.ts';
import { getRecentMessages, getMessagesSince } from '../../core/messages.ts';
import { toConversationKey, isGroupConversationKey, GLOBAL_CONVERSATION_KEY } from '../../core/conversation-key.ts';
import { classifyAssistantTextEgress } from '../../core/outbound-message-safety.ts';
import { toPersonalJid, isGroupJid } from '../../core/jid-constants.ts';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { canonicalizeChatJid } from '../../core/lid-resolver.ts';
import { TurnQueue, type QueuedTurn } from './turn-queue.ts';
import { CrashTracker } from './crash-tracker.ts';
import { AutoCompactController, AUTO_COMPACT_RAPID_REARM_WINDOW_MS } from './auto-compact-controller.ts';
import { ImageCoalescer } from './image-coalescer.ts';
import { PendingSystemResultTracker } from './pending-system-result-tracker.ts';
import { TurnCapabilityTracker, type TurnCapabilityErrorClass } from './turn-capability-tracker.ts';
import { FallbackWindowMetrics } from './fallback-window-metrics.ts';
import { FallbackWindowState } from './fallback-window-state.ts';
import { FallbackChain } from './fallback-chain-state.ts';
import { FallbackEmptyAdvance } from './fallback-empty-advance.ts';
import { PendingPollStore } from './pending-poll-store.ts';
import { PendingPollPersistence } from './pending-poll-persistence.ts';
import { HandoffDistillCoordinator } from './handoff-distill-coordinator.ts';
import { handoffDistillerEnabled, handoffContextEnabled, handoffDistillModel } from './handoff-distill-config.ts';
import { config } from '../../config.ts';
import { canonicalConversationKey, resolvePhoneFromJid } from '../../core/access-list.ts';
import { isAdminPhone } from '../../lib/phone.ts';
import { matchImperative, extractImperativeTarget } from '../../core/substrate/inline-extractor.ts';
import { createBead } from '../../core/substrate/beads.ts';
import { mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { ToolRegistry } from '../../mcp/registry.ts';
import { WhatSoupSocketServer } from '../../mcp/socket-server.ts';
import type { SessionContext } from '../../mcp/types.ts';
import type { ConnectionManager } from '../../transport/connection.ts';
import { registerAllTools } from '../../mcp/register-all.ts';
import { startMediaBridge, setMediaBridgeChat, type MediaBridge } from './media-bridge.ts';
import { WorkspaceSweeper, type WorkspaceResource } from './workspace-sweeper.ts';
import { fallbackProviderConfigFor, fallbackKeyPresent as fallbackKeyPresentFor } from './fallback-config.ts';
import { makeIdleEligibilityResolver } from './fallback-eligibility-cache.ts';
import {
  createProviderMcpBridge,
  writeMcpConfigToPath,
  writeProviderMcpConfig,
  writeProviderMcpConfigTarget,
  type OpencodeProviderConfig,
} from './providers/mcp-bridge.ts';
import { verifyFallbackCredential } from './providers/credential-verify.ts';
import { probeFallbackBinary, probeModelCatalog, probeBinaryAuthStatus } from './providers/binary-preflight.ts';
import {
  probePrimaryModelUsability,
  primaryModelUsabilityRequiresAlert,
  type PrimaryModelUsabilityResult,
} from './providers/primary-model-usability.ts';
import { createPrimaryModelProbeAdapters } from './providers/primary-model-usability-adapters.ts';
import { ensureClaudeFileStoreCredential } from './providers/claude-filestore-heal.ts';
import { jitteredDelay, sleep } from '../../core/retry.ts';
import { synthesizeSpeech } from '../chat/providers/elevenlabs.ts';
import { writeTempFile } from '../../core/media-download.ts';
import { OperationTracker } from './operation-tracker.ts';
import type { ProgressEvent } from './operation-tracker.ts';
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

/** Maximum duration (ms) a control session is allowed to run before force-shutdown. */
const CONTROL_SESSION_TIMEOUT_MS = 15 * 60 * 1000;

/** Max consecutive crashes before auto-respawn gives up and waits for user action. */
const AUTO_RESPAWN_MAX_CRASHES = 3;
/** Base delay (ms) before attempting auto-respawn after a crash. Actual delay uses exponential backoff. */
const AUTO_RESPAWN_BASE_MS = 2_000;
/** Maximum respawn delay (ms) — caps the exponential backoff. */
const AUTO_RESPAWN_MAX_DELAY_MS = 15_000;
/** Periodic runtime health stats emission interval. */
const HEALTH_STATS_INTERVAL_MS = 60_000;
const SHARED_QUEUE_IDLE_MS = 60 * 60 * 1000;
const SHARED_QUEUE_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
// Idle per-chat agent session lifecycle bounds. A resident session idle (no
// message) beyond SESSION_IDLE_MS is suspended; sessions support --resume so the
// next message rehydrates. MAX_RESIDENT_SESSIONS is an LRU ceiling so a burst of
// distinct chats cannot pin unbounded memory; SESSION_MIN_RESIDENCY_MS is an
// anti-thrash floor so a freshly-spawned session is never immediately evicted.
const envPositiveInt = (key: string, fallback: number): number => {
  const raw = Number(process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};
const SESSION_IDLE_MS = envPositiveInt('WHATSOUP_SESSION_IDLE_MS', 60 * 60 * 1000); // 1h
const SESSION_SWEEP_INTERVAL_MS = envPositiveInt('WHATSOUP_SESSION_SWEEP_MS', 10 * 60 * 1000); // 10m
const MAX_RESIDENT_SESSIONS = envPositiveInt('WHATSOUP_MAX_SESSIONS', 12);
const SESSION_MIN_RESIDENCY_MS = envPositiveInt('WHATSOUP_SESSION_MIN_RESIDENCY_MS', 5 * 60 * 1000); // 5m
// Single-sourced from conversation-key.ts so the tool/crash scope keys and the
// tool_calls telemetry sentinel can never drift apart.
const GLOBAL_TOOL_SCOPE_KEY = GLOBAL_CONVERSATION_KEY;
const GLOBAL_CRASH_SCOPE_KEY = GLOBAL_CONVERSATION_KEY;
const TOOL_FAILURE_ALERT_DEDUP_MS = 60 * 1000;
const MAX_TOOL_FAILURE_ALERT_DEDUP_KEYS = 1_000;
// (TOOL_FAILURE_ALERT_EXCERPT_CHARS moved to ./tool-update.ts with alertExcerpt.)
// Default provider-fallback window when the usage-limit message names no reset
// time. Claude usage limits operate on 5-hour rolling windows, so 5h is a safe
// upper-bound estimate for when the primary provider becomes available again.
const DEFAULT_FALLBACK_WINDOW_MS = 5 * 60 * 60 * 1000; // 18_000_000 ms (5h)
// Clamp the fallback window so a malformed/adversarial reset time can neither
// revert almost immediately nor pin the fallback for an unreasonable span.
const MIN_FALLBACK_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const PROVIDER_FALLBACK_NOTICE_DEDUP_MS = (() => {
  const raw = Number(process.env['WHATSOUP_PROVIDER_FALLBACK_NOTICE_DEDUP_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
})();
const PROVIDER_FALLBACK_PRIMARY_RECHECK_MS = (() => {
  const raw = Number(process.env['WHATSOUP_PROVIDER_FALLBACK_PRIMARY_RECHECK_MS']);
  if (!Number.isFinite(raw) || raw <= 0) return 5 * 60 * 1000;
  return Math.min(Math.max(raw, 30 * 1000), 30 * 60 * 1000);
})();
// The primary model usability probe has its own longer CLI deadline in
// primary-model-usability-adapters.ts; shorter binary presence checks keep
// their 5 s preflight timeout in providers/binary-preflight.ts.
// Consecutive failed recovery probes (revert-timer extension path) before a
// single fallback_recovery_stalled alert is emitted. The cap only surfaces the
// stall — the window keeps extending so the instance is never stranded on a
// dead primary. One alert per stall episode; the counter resets on deactivation
// (which a successful probe triggers).
const PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD = (() => {
  const raw = Number(process.env['WHATSOUP_PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD']);
  if (!Number.isFinite(raw) || raw <= 0) return 12;
  return Math.min(Math.max(Math.trunc(raw), 3), 100);
})();
// Opt-in: route terminal provider-failure results through the declarative
// response-workflow registry (handleProviderFailureResult) instead of the
// hand-rolled per-chat / singleton branch ladders. Behaviour-preserving — the
// legacy ladders remain the default and the fall-through for non-failure text.
// Read per-call (not memoised) so tests can toggle it without re-importing.
function responseRegistryDispatchEnabled(): boolean {
  return process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'] === '1';
}
// Opt-in: on an arming provider failure (via the registry dispatcher), run the
// best-effort diagnostic bundle and emit its findings to the alert outbox.
// Fire-and-forget — never blocks, delays, or alters the turn's fallback path.
function diagnosticBundleEnabled(): boolean {
  return process.env['WHATSOUP_DIAGNOSTIC_BUNDLE'] === '1';
}
// Guardrail: the diagnostic bundle probes the PRIMARY provider's health, which
// is instance-global (identical across chats). Throttle it to at most once per
// window so a fallback storm — many chats failing at once, or rapid repeated
// failures — cannot spawn a flurry of CLI auth-status probes, and so we do not
// re-probe the same primary health redundantly.
const DIAGNOSTIC_BUNDLE_THROTTLE_MS = 60_000;
// Max age of a handoff artifact before it is considered stale and dropped from
// the injected system block. A stale summary misleads the stand-in, so the
// prelude builder rejects artifacts older than this when composing context.
const HANDOFF_STALE_MS = 120_000;
/**
 * `modelUsable` reports `true` only when the primary-model usability probe behind
 * it is no older than this window. A stale `usable` probe (e.g. after reverting to
 * primary and then sitting idle, or if an external process strips creds) is
 * downgraded to `null` (unknown) so /health and monitors cannot read a green that
 * is hours out of date. See RCA 2026-06-24 (rb-bot stale-`modelUsable` gap).
 */
const MODEL_USABILITY_FRESHNESS_MS = 30 * 60_000;
// ── Background handoff-distiller sweep tuning (all gated behind the flag) ──────
// One periodic sweep enumerates active conversations and asks the runner to
// (maybe) distill each. The runner+gate own growth/budget/breaker/concurrency,
// so the interval only sets how often that machinery is consulted.
// Opt-in: collapse the fallback notice and the stand-in's reply into ONE
// user-facing message. When a replay is scheduled the notice is stashed (via the
// crash-safe standby latch) and prepended to the stand-in's first visible reply
// instead of being sent on its own. Off → the notice is enqueued standalone
// exactly as before (byte-identical default path).
function oneMessageHandoffEnabled(): boolean {
  return process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'] === '1';
}

type ProviderFallbackReason =
  | 'usage-limit'
  | 'rate-limit'
  | 'auth-required'
  | 'model-unavailable'
  | 'server-error'
  | 'empty-output'
  | 'probe-unusable';

/** Narrow an arbitrary (possibly null) string to a ProviderFallbackReason. */
function isProviderFallbackReason(value: unknown): value is ProviderFallbackReason {
  return value === 'usage-limit' || value === 'rate-limit'
    || value === 'auth-required' || value === 'model-unavailable'
    || value === 'server-error' || value === 'empty-output'
    || value === 'probe-unusable';
}

/**
 * Reasons whose failover borrows the auth-required control semantics: the revert
 * is gated on a fresh primary probe AND same-provider fallback entries are
 * skipped (a re-auth/empty-primary needs an independent provider to stand in).
 *
 * `empty-output` / `probe-unusable` — the consecutive-empty-output and
 * usability-probe triggers of {@link AgentRuntime.maybeArmFallbackAfterEmptyPrimaryTurn}
 * — previously reused the literal `'auth-required'` reason SOLELY to inherit
 * these two side-effects, which then leaked into the operator-facing
 * `provider_fallback_activated` alert as a false `reason=auth-required` (#1421).
 * They are now first-class reasons the alert can name honestly while this helper
 * preserves the identical control behaviour. Accepts a raw string because
 * {@link AgentRuntime.selectFallbackEntryForWindow} carries the reason untyped.
 */
function fallbackRequiresIndependentProbe(reason: string | null | undefined): boolean {
  return reason === 'auth-required' || reason === 'empty-output' || reason === 'probe-unusable';
}

/**
 * Consecutive empty PRIMARY-provider user turns that force a provider fallback
 * even when the independent usability probe has not (yet) flagged the primary.
 * A healthy primary effectively never returns two pure-empty user turns in a
 * row; a broken primary auth/session (e.g. claude-cli after a silent CLI
 * auto-update invalidated its keychain login) exits cleanly with NO text on
 * every turn. Deterministic trigger threshold — see
 * {@link AgentRuntime.maybeArmFallbackAfterEmptyPrimaryTurn}.
 */
const EMPTY_OUTPUT_FALLBACK_THRESHOLD = 2;

/**
 * Startup grace for empty-output fallback arming. The boot/recovery sequence
 * (proactive per-chat resume → resume-fail → context-recovery / replayed turns)
 * emits empty results while the usability probe is still transiently `unknown`,
 * which `primaryModelUsabilityRequiresAlert` treats as unusable. Arming on that
 * noise via the single-empty probe fast-path falsely fails the instance over to
 * the backup on every restart (and persists the window, so it reloads on the
 * next restart — a primary/backup flap). Within this window, before the instance
 * has proven it can serve a turn (`lastSuccessfulTurnAt === null`), ONLY the
 * probe fast-path is suppressed: empty turns are still counted toward
 * {@link EMPTY_OUTPUT_FALLBACK_THRESHOLD} so the consecutive-empty threshold can
 * still arm (a genuinely-dead primary on real early traffic still fails over,
 * and the per-chat replay that arms via the threshold is preserved). The
 * fast-path is live again immediately after the window elapses or the first
 * successful turn.
 *
 * The elapsed measurement uses `performance.now()` (monotonic clock) rather
 * than `Date.now()` so wall-clock steps — NTP corrections, host sleep/wake, VM
 * migration, all most likely in the first seconds of process life — cannot
 * prematurely end or over-extend the window (R1 hardening).
 *
 * See {@link AgentRuntime.maybeArmFallbackAfterEmptyPrimaryTurn}.
 */
const EMPTY_OUTPUT_ARM_STARTUP_GRACE_MS = 60_000;
type RuntimeTurnCapability = RuntimeTurnCapabilityHealth & {
  modelUsabilityStatus: PrimaryModelUsabilityResult['status'] | null;
  lastTurnErrorClass: TurnCapabilityErrorClass | null;
};

interface ProviderFallbackActivation {
  primaryProvider: string;
  fallbackProvider: string;
  fallbackModel: string | undefined;
  reason: ProviderFallbackReason;
  resetAt: Date | null;
  activeUntil: number;
  extended: boolean;
  keyPresent: boolean | null;
  recoveryProbeRequired: boolean;
}
// Time to wait for an auto-triggered /compact to complete before giving up.
// A /compact must summarize the whole conversation, so on large contexts it can
// legitimately take a few minutes; 2 min was too short and produced false
// timeouts that fed an unbounded-growth spiral. Must stay < SILENT_COMPACT_TTL_MS
// (defined in auto-compact-controller.ts) so the silent-compact flag does not
// expire mid-compaction.
const AUTO_COMPACT_TIMEOUT_MS = 4 * 60 * 1000;
// Cooldown after a timed-out /compact before another auto-compact may be tried.
// Kept short so a session that times out retries soon (bounding how far it grows
// between attempts) rather than degrading for a long window; still long enough to
// prevent a per-turn retry storm. A session that genuinely cannot compact is
// ultimately recovered by the prompt-too-long kill+respawn path.
const AUTO_COMPACT_TIMEOUT_BACKOFF_MS = 5 * 60 * 1000;
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
   * Systemd restart capability, injected from the composition root. The runtimes
   * layer cannot import the fleet layer, so main.ts constructs the concrete
   * ServiceManager and passes it here. When absent, the restart_self tool is not
   * registered (the agent cannot restart itself without it).
   */
  serviceRestarter?: ServiceRestarter;
}

export type RuntimePrimaryModelUsability = PrimaryModelUsabilityResult & {
  checkedAt: number | null;
  probeInFlight: boolean;
};

/**
 * Pure derivation of the `modelUsable` health verdict from the last usability
 * probe, gated on freshness. A `usable` probe older than `freshnessMs` is reported
 * as `null` (unknown) with `modelUsableStale=true` rather than a stale green. Pure
 * + exported for direct unit testing (the probe state itself is private).
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
    return { modelUsable: false, modelUsableStale: false, modelUsableCheckedAt };
  }
  return { modelUsable: null, modelUsableStale: false, modelUsableCheckedAt };
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
  pendingPollMatchesChatJid,
  normalizePendingPollTimeoutMs,
  formatTextFallbackQuestion,
  answerForPollSelection,
  resolveTypedPollAnswer,
  normalizeAskUserQuestions,
  isLowSignalPollStatusReply,
  hasEscapeHatchOption,
  configuredDefaultPollTimeoutMs,
  clearPendingPollTimers,
  removePollIdsForQuestion,
  advancePendingPollIndex,
  unansweredPollQuestions,
  type PendingPollQuestion,
  type SerializedPendingPoll,
  type ResolutionStrategy,
  type PollVote,
  type AskUserQuestion,
  type AskUserOption,
} from './poll-resolution.ts';
import { resolveOutboundAudience } from '../../core/outbound-message-safety.ts';

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
  shouldEmitToolFailureAlert,
  safeAlertSegment,
  alertEvidenceValue,
  alertExcerpt,
} from './tool-update.ts';

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

/** TTL for this_thread route preferences (echoed in user copy as "24h"). */
const PREFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

function providerDisplayName(provider: string): string {
  switch (provider) {
    case 'claude-cli': return 'Claude';
    case 'codex-cli': return 'Codex';
    case 'gemini-cli': return 'Gemini';
    case 'opencode-cli': return 'OpenCode';
    case 'openai-api': return 'OpenAI';
    case 'anthropic-api': return 'Anthropic';
    default: return provider;
  }
}

function modelCardLabel(provider: string, model: string | undefined): string {
  const providerName = providerDisplayName(provider);
  return model && model.trim() ? `${providerName} / ${model.trim()}` : providerName;
}

function formatClockForUser(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function contextOverflowNotice(): string {
  return renderUserMessage('context-overflow', {
    hasContinuation: false,
    bundle: null,
    formatClock: formatClockForUser,
  });
}

function fallbackRequiresPrimaryProbe(reason: ProviderFallbackReason): boolean {
  // Recovery-probe gating is intentionally BROADER than independent-provider
  // routing (`fallbackRequiresIndependentProbe`, used at the routing call-site).
  // Usage/rate limits carry an unreliable reset estimate — e.g. a weekly limit's
  // "resets 9am" is parsed as a daily clock time — so we must re-probe the
  // primary and revert the moment it recovers rather than blind-waiting for the
  // window to elapse. Routing semantics are unchanged; only the recovery path widens.
  return (
    fallbackRequiresIndependentProbe(reason) ||
    reason === 'usage-limit' ||
    reason === 'rate-limit'
  );
}


function fallbackReasonForResultText(text: string): ProviderFallbackReason | null {
  // Routed through the central classifier (SSOT). Only fallback-arming kinds map to
  // a ProviderFallbackReason; policy-block / context-overflow classify but do not
  // arm fallback (they are suppressed and the session is killed by the handlers).
  const kind = classifyProviderFailure(text);
  if (
    kind === 'usage-limit' ||
    kind === 'rate-limit' ||
    kind === 'auth-required' ||
    kind === 'model-unavailable' ||
    kind === 'server-error'
  ) {
    return kind;
  }
  return null;
}

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

/**
 * Per-call context for {@link AgentRuntime.handleProviderFailureResult}. Captures
 * the only points where the per-chat and singleton result handlers diverge
 * (session reference, replay map key, cleanup args, log subject) so one method
 * serves both. The trailing `this.singleTurnHadToolActivity = false` the
 * singleton arming branches set is redundant — `cleanupUsageLimitTurn` already
 * clears it on every path — so it is intentionally not threaded here.
 */
interface ProviderFailureResultContext {
  queue: IOutboundQueue;
  session: SessionManager | null;
  providerText: string;
  turnHadToolWork: boolean;
  /** Subject for log lines: per-chat target jid, or the singleton's active/turn jid. */
  logChatJid: string | null | undefined;
  /** Forwarded to scheduleFallbackReplay; undefined in singleton/shared mode. */
  scheduleReplayMapKey?: string;
  /** Cleanup arguments matching the originating handler's shape. */
  cleanupArgs: {
    inboundSeq?: number;
    conversationKey?: string;
    mapKey?: string;
    clearCurrentInboundSeq?: boolean;
  };
  recordTurnFailure: (errorClass: TurnCapabilityErrorClass) => void;
}

/** Per-kind log message for an arming terminal provider failure (matches the legacy ladders verbatim). */
function armingFailureLogMessage(reason: ProviderFallbackReason): string {
  switch (reason) {
    case 'usage-limit':
      return 'suppressed usage-limit message from result — session will be killed';
    case 'auth-required':
      return 'suppressed provider auth-required message from result — session will be shut down';
    case 'rate-limit':
      return 'terminal provider rate-limit result observed';
    case 'server-error':
      return 'terminal provider server-error result observed';
    case 'model-unavailable':
      return 'suppressed provider model-unavailable message from result — session will be shut down';
    case 'empty-output':
      return 'primary provider returned consecutive empty output — failing over';
    case 'probe-unusable':
      return 'primary provider usability probe flagged unusable — failing over';
  }
}

function templateForFallbackReason(reason: ProviderFallbackReason): UserTemplateId {
  // empty-output / probe-unusable are transient primary failovers from the
  // user's perspective (no hard auth/usage fault) — they reuse the existing
  // 'transient' user copy rather than minting new user-facing templates (#1421).
  if (reason === 'server-error' || reason === 'empty-output' || reason === 'probe-unusable') {
    return 'transient';
  }
  return reason;
}

export class AgentRuntime implements Runtime {

  private readonly db: Database;
  private readonly messenger: Messenger;
  private readonly instanceName: string;
  private readonly shared: boolean;
  private readonly sessionScope: SessionScope;
  private readonly cwd: string | undefined;
  private readonly configSystemPrompt: string | undefined;
  private readonly instructionsPath: string | undefined;
  private readonly sandbox: SandboxPolicy | undefined;
  private readonly model: string | undefined;
  private readonly sandboxPerChat: boolean;
  /** F-STICKY-ACTOR (QR-263): nlRouting adds a DYNAMIC actor-race surface — a live
   *  per-sender `/model` pin can route a turn to a non-claude CLI provider at runtime,
   *  independent of the static primary/fallback config. Mutable only in tests. */
  private nlRoutingEnabled: boolean = config.nlRouting === true;
  private readonly serviceRestarter: ServiceRestarter | undefined;
  private readonly pluginDirs: string[];
  private readonly enabledPlugins: Record<string, boolean> | undefined;
  private readonly allowM365Mutations: boolean | undefined;
  private readonly autoCompactInputTokens: number | undefined;
  private readonly agentProvider: string;
  private readonly agentProviderConfig: Record<string, unknown> | undefined;
  // Automatic provider fallback (claude-cli → opencode-cli etc.) on usage limit.
  // The legacy scalar pair is normalized as entry zero for compatibility.
  private readonly agentFallbacks: AgentFallbackEntry[];
  private readonly replyGuaranteeTimeoutMs: number;
  private readonly registry: ToolRegistry;

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

  // Operation tracker: per-session progress reporting & stall detection
  // Parallels session storage — single/shared uses operationTracker, per_chat uses operationTrackers map.
  private operationTracker: OperationTracker | null = null;
  private operationTrackers: Map<string, OperationTracker> = new Map();
  private workspaceResources: Map<string, WorkspaceResource> = new Map();
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
  private workspaceSweeper: WorkspaceSweeper;
  private queueSweepTimer: ReturnType<typeof setInterval> | null = null;
  private sessionSweepTimer: ReturnType<typeof setInterval> | null = null;
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
  // Consecutive failed recovery probes on the revert-timer EXTENSION path
  // (process-local, reset on deactivation — which a successful probe triggers).
  // Early-window standing probes do not count: nothing is extending yet.
  // At PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD one fallback_recovery_stalled
  // alert fires per stall episode; the window keeps extending regardless.
  private fallbackProbeAttempts = 0;
  // Epoch ms of the most recent recovery probe (either path); null until the
  // first probe. Process-local observability only — never persisted.
  private fallbackLastProbeAt: number | null = null;
  // Epoch ms of the last diagnostic-bundle kick (instance-level throttle).
  private lastDiagnosticBundleAt = 0;
  private primaryModelUsability: RuntimePrimaryModelUsability | null = null;
  private primaryModelUsabilityAlertActive = false;
  /** Consecutive empty PRIMARY-provider user turns; reset on any successful turn
   *  or when an empty-output fallback is armed. Drives the empty-output fallback
   *  trigger — see maybeArmFallbackAfterEmptyPrimaryTurn. */
  private consecutivePrimaryEmptyTurns = 0;
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
  /** Tool IDs for which the auto-resolved is_error tool_result should be suppressed. */
  private suppressedAskUserToolIds = new Set<string>();
  private groupMetadataCache = new Map<string, { adminJids: Set<string>; fetchedAt: number }>();
  private static readonly GROUP_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
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
  private static readonly CRASH_HEALTH_DECAY_WINDOW_MS = 10 * 60_000;

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

  private maybeEmitToolFailureAlert(args: {
    chatJid: string | null | undefined;
    toolId: string;
    toolName: string;
    content: string;
    classification: ToolUpdate;
    toolScopeKey: string;
    mapKey?: string;
  }): void {
    if (process.env['BOT_ERRORS_RUNTIME_TOOL_FAILURE_ALERTS'] === '0') return;

    // Root-cause noise gate: a non-zero Bash exit (glob/grep no-match, failed
    // conditional, missing path) is reported by claude-cli as `is_error` but is
    // a normal agent-loop result, not an operator-actionable failure. Only page
    // when the error carries an infra/provider-health signature.
    if (!shouldEmitToolFailureAlert(args.classification.category, args.content)) {
      log.debug(
        {
          instance: this.instanceName,
          toolName: args.toolName,
          category: args.classification.category,
        },
        'suppressing benign tool-error (not operator-actionable) — no BOT ERRORS alert',
      );
      return;
    }

    const now = Date.now();
    for (const [key, recordedAt] of this.recentToolFailureAlerts) {
      if (now - recordedAt > TOOL_FAILURE_ALERT_DEDUP_MS) {
        this.recentToolFailureAlerts.delete(key);
      }
    }

    const provider = this.effectiveProvider || this.agentProvider || 'unknown-provider';
    const source = `runtime-tool-error:${safeAlertSegment(provider)}:${safeAlertSegment(args.toolName)}`;
    const fingerprint = [
      this.instanceName,
      provider,
      args.toolName,
      args.classification.category,
      args.content.replace(/\s+/g, ' ').trim().slice(0, 500),
    ].join('\n');

    if (this.recentToolFailureAlerts.has(fingerprint)) return;
    this.recentToolFailureAlerts.set(fingerprint, now);
    this.capDedupeMap(this.recentToolFailureAlerts);

    const evidence = [
      'runtime_source=src/runtimes/agent/runtime.ts:tool_result',
      `instance=${alertEvidenceValue(this.instanceName)}`,
      `provider=${alertEvidenceValue(provider)}`,
      `session_scope=${this.sessionScope}`,
      `chat_jid=${alertEvidenceValue(args.chatJid ?? null)}`,
      `tool_scope_key=${alertEvidenceValue(args.toolScopeKey)}`,
      `map_key=${alertEvidenceValue(args.mapKey ?? null)}`,
      `tool_id=${alertEvidenceValue(args.toolId)}`,
      `tool_name=${alertEvidenceValue(args.toolName)}`,
      `classification=${args.classification.category}`,
      `detail=${alertEvidenceValue(args.classification.detail)}`,
      `cwd=${alertEvidenceValue(this.cwd ?? process.cwd())}`,
      'error_excerpt:',
      alertExcerpt(args.content) || 'unknown',
    ].join('\n');

    try {
      emitAlertChecked(
        this.instanceName,
        source,
        `Agent tool failure: ${args.toolName}`,
        evidence,
        'warning',
      );
    } catch (err) {
      log.warn({
        instance: this.instanceName,
        provider,
        toolId: args.toolId,
        toolName: args.toolName,
        err: errorMessage(err),
      }, 'failed to emit BOT ERRORS tool failure alert');
    }
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

    const inputSinceCompact = Math.max(0, snapshot.totalInputTokens - snapshot.lastCompactInputTokens);
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
    if (snapshot.lastCompactInputTokens === 0 && snapshot.totalInputTokens >= this.autoCompactInputTokens) {
      markSessionCompacted(this.db, rowId);
      log.info({
        scopeKey,
        rowId,
        totalInputTokens: snapshot.totalInputTokens,
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
    const timer = setTimeout(() => {
      log.error(
        { scopeKey, rowId, timeoutMs: AUTO_COMPACT_TIMEOUT_MS, backoffMs: AUTO_COMPACT_TIMEOUT_BACKOFF_MS },
        'auto compact timed out',
      );
      this.clearSilentCompact(scopeKey);
      this.finishAutoCompact(scopeKey);
      this.autoCompact.cooldownUntil.set(scopeKey, Date.now() + AUTO_COMPACT_TIMEOUT_BACKOFF_MS);
      // Note: the pending-system count is intentionally NOT decremented here.
      // The /compact result arrives FIFO before any later turn's result on the
      // same subprocess, so it decrements the count itself. If the result never
      // arrives (subprocess replaced/killed), respawn/cleanup clears the count.
      // A stranded count only causes a rare, self-healing one-turn seq skew.
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

    this.pendingSystemResults.mark(scopeKey);
    void session.sendTurn('/compact').catch((err) => {
      log.warn({ err, scopeKey, rowId }, 'auto compact send failed');
      this.clearSilentCompact(scopeKey);
      this.finishAutoCompact(scopeKey);
      // No result event will arrive for a failed send.
      this.pendingSystemResults.unmark(scopeKey);
    });
  }

  private assertNoActiveUserTurn(scopeKey: string): void {
    if (this.sessionScope === 'per_chat') {
      if ((this.perChatInboundSeqQueue.get(scopeKey)?.length ?? 0) > 0) {
        throw new AgentCommandRuntimeError(
          'turn_in_progress',
          'agent command rejected because the target chat already has a turn in progress',
          409,
        );
      }
      return;
    }

    if (this.currentInboundSeq !== undefined || this.currentTurnChatJid !== null) {
      throw new AgentCommandRuntimeError(
        'turn_in_progress',
        'agent command rejected because the agent already has a turn in progress',
        409,
      );
    }
  }

  private getOpenFileDescriptorCount(): number | null {
    try {
      return readdirSync('/proc/self/fd').length;
    } catch (err) {
      log.debug({ err }, 'failed to count open file descriptors');
      return null;
    }
  }

  private logHealthStats(): void {
    const memoryUsage = process.memoryUsage();

    log.info({
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
      chatSessions: this.chatSessions.size,
      chatQueues: this.chatQueues.size,
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
    }, 'agent runtime health stats');
  }

  private startHealthStatsTimer(): void {
    if (this.healthStatsTimer) return;
    this.healthStatsTimer = setInterval(() => this.logHealthStats(), HEALTH_STATS_INTERVAL_MS);
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
      void queue.shutdown().catch((err) => {
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
    // Remove first so a concurrent inbound message cleanly re-spawns/resumes.
    this.chatSessions.delete(mapKey);
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
    this.cleanupPerChatState(mapKey);
    void session.shutdown(true).catch((err) => {
      log.warn({ err, chatJid: mapKey }, 'idle session shutdown failed');
    });
  }

  // Tracks inbound seq for the current turn (single/shared mode)
  private currentInboundSeq: number | undefined;
  // Tracks inbound seq per chat key (per_chat mode — chats are concurrent)
  // FIFO queue: push on dispatch, shift on result to prevent race when turns overlap.
  private perChatInboundSeqQueue: Map<string, number[]> = new Map();

  /** Last pin-block notice per conversation (one notice per transition). */
  private lastPinBlockNotice = new Map<string, string>();
  /** Last spawn provider per conversation — runtime_switched detection (slice 4). */
  private lastSpawnRouteProvider = new Map<string, string>();
  // Counts pending system-turn results (context injection, continuation) that should
  // not consume from perChatInboundSeqQueue when their result event arrives. The
  // counter invariants (mark / unmark / consumeIfPending / count) live in the
  // collaborator; the raw map is reachable via .counts for per-chat cleanup/shutdown.
  private readonly pendingSystemResults = new PendingSystemResultTracker();

  // Startup notification deferred until after WA connects
  private pendingStartupMessage: { chatJid: string; text: string } | null = null;

  // Voice reply state (SP4) — tracks inbound contentType and accumulated assistant text per turn.
  // Per-chat mode uses Maps keyed by mapKey; single/shared mode uses scalar fields.
  private currentTurnInboundContentType: string | null = null;
  private currentTurnAssistantText = '';
  private currentTurnAssistantItemText: Map<string, string> = new Map();
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
  // F-STICKY-ACTOR (QR-245): per-chat executing-turn actor register. HEAD =
  // oldest-dispatched-unresolved = the turn the subprocess is currently running.
  // Read fail-closed by resolveExecutingActor (empty/absent -> deny). Cleared on
  // every abnormal termination (cleanupPerChatState + crash/resume/fallback).
  private perChatExecActorQueue: Map<string, (string | undefined)[]> = new Map();
  private perChatSocketResources: Map<string, { socketServer: WhatSoupSocketServer; socketPath: string; cfgPath: string }> = new Map();
  private currentTurnReplayText: string | null = null;
  private currentTurnReplayActorJid: string | undefined;

  // ---------------------------------------------------------------------------
  // Image coalescing — batch rapid image sends into a single turn
  // ---------------------------------------------------------------------------
  // When multiple images arrive for the same chat within IMAGE_COALESCE_MS,
  // they're collected and sent as one combined turn to avoid hitting Claude's
  // per-image dimension limits in multi-image sessions.
  private static readonly IMAGE_COALESCE_MS = 3_000;
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
  private cleanupPerChatState(mapKey: string): void {
    this.crashes.forget(mapKey);
    this.perChatInboundSeqQueue.delete(mapKey);
    this.pendingSystemResults.counts.delete(mapKey);
    this.perChatTurnContentType.delete(mapKey);
    this.perChatTurnText.delete(mapKey);
    this.perChatTurnSuppressedReplySatisfaction.delete(mapKey);
    this.perChatAssistantItemText.delete(mapKey);
    this.perChatRouteMarkerHold.delete(mapKey);
    this.pendingTurnText.delete(mapKey);
    this.pendingTurnActorJid.delete(mapKey);
    // F-STICKY-ACTOR: clear the executing-actor register (fail-closed) and stop
    // the per-chat socket. cleanupPerChatState covers idle-eviction, /new,
    // dead-session, and shutdown-via-cleanup.
    this.teardownPerChatActorSocket(mapKey);
    this.resumeFailedHandling.delete(mapKey);
    this.postTurnGate.delete(mapKey);
    // Slice-4 route bookkeeping is keyed by conversationKey, not the raw
    // mapKey: in sandbox mode mapKey already IS the conversationKey
    // (workspaceKey = toConversationKey), while in canonical-JID mode it is a
    // JID that must be reduced. Reconcile so teardown reaches these maps and
    // they cannot grow unbounded (LEAK-15).
    const conversationKey = mapKey.includes('@') ? toConversationKey(mapKey) : mapKey;
    this.lastSpawnRouteProvider.delete(conversationKey);
    this.lastPinBlockNotice.delete(conversationKey);
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
    let queuedRepresentativeSeq = false;

    try {
      // Mark all-but-last inbound seqs as coalesced (they won't get their own turn)
      if (inboundSeqs.length > 1) {
        this.imageCoalesce.markSeqsSkipped(mapKey, inboundSeqs.slice(0, -1), 'coalesced_image');
      }

      // Push only the representative (last) seq onto the per-chat queue
      const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
      if (representativeSeq !== undefined) {
        seqQueue.push(representativeSeq);
        queuedRepresentativeSeq = true;
      }
      this.perChatInboundSeqQueue.set(mapKey, seqQueue);
      this.getQueueForChat(chatJid, mapKey)?.setInboundSeq(representativeSeq);

      // Set state for this turn
      this.perChatTurnContentType.set(mapKey, 'image');
      this.perChatTurnText.set(mapKey, '');
      this.perChatTurnSuppressedReplySatisfaction.delete(mapKey);
      this.perChatAssistantItemText.delete(mapKey);

      // Combine all image references into one turn
      let combinedText: string;
      if (count === 1) {
        combinedText = texts[0];
      } else {
        combinedText = `[${count} images received]\n${texts.join('\n')}`;
        log.info({ mapKey, imageCount: count, coalescedSeqs: inboundSeqs.length - 1 }, 'flushing coalesced image batch as single turn');
      }

      await this.sendTurnPerChat(chatJid, combinedText, mapKey, msg.senderJid);
    } catch (err) {
      if (representativeSeq !== undefined) {
        if (queuedRepresentativeSeq) {
          const seqQueue = this.perChatInboundSeqQueue.get(mapKey);
          const idx = seqQueue?.indexOf(representativeSeq) ?? -1;
          if (seqQueue && idx >= 0) seqQueue.splice(idx, 1);
          if (seqQueue?.length === 0) this.perChatInboundSeqQueue.delete(mapKey);
        }
        this.imageCoalesce.markSeqFailed(mapKey, representativeSeq, classifyErrorForInbound(err));
      }
      this.pendingTurnText.delete(mapKey);
      this.pendingTurnActorJid.delete(mapKey);
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
    const decision = classifyAssistantTextEgress(text);
    if (decision.action === 'allow') return text;

    log.info(
      {
        chatJid: queue.targetChatJid,
        reason: decision.reason,
        satisfiesReplyGuarantee: decision.satisfiesReplyGuarantee,
        textPreview: sanitizeProviderPreviewText(text).slice(0, 200),
      },
      'assistant_text egress gate suppressed non-user-facing text',
    );

    if (decision.satisfiesReplyGuarantee) {
      this.replyGuarantee?.disarm(inboundSeq);
      if (mapKey !== undefined) this.perChatTurnSuppressedReplySatisfaction.add(mapKey);
      else this.turnHadSuppressedReplySatisfaction = true;
    }
    return null;
  }

  /**
   * Two-tier gate for provider-failure text that streamed as assistant_text (QR-209).
   * The permissive `classifyProviderFailure` suppression used to drop ANY match,
   * silently discarding genuine replies that merely discussed an auth/limit error
   * (observed live: replies about an expired OAuth token dropped to silence). Now
   * only BANNER-confident matches (the text IS the error — short + error-opener /
   * usage-limit) are suppressed; AMBIENT matches (prose about an error) are
   * DELIVERED. Fallback is still armed only on the terminal 'result' event, never
   * here. Shared by both assistant_text handlers so their suppression policy can't
   * drift. Returns true = suppress (caller must `break`), false = deliver.
   */
  private suppressStreamedProviderFailure(normalizedText: string, chatJid: string | null): boolean {
    const classification = classifyStreamedProviderFailure(normalizedText);
    if (classification === null) return false;
    if (classification.confidence === 'banner') {
      log.warn(
        { chatJid, kind: classification.kind, textPreview: normalizedText.slice(0, MAX_STREAMED_BANNER_LENGTH) },
        'suppressed provider-failure message from assistant_text',
      );
      return true;
    }
    // Ambient: matched a provider-failure token but is prose about an error, not the
    // error itself. Deliver it — dropping it is the QR-209 silent-reply defect. Log
    // (structured) so the fleet can spot a novel banner shape that should become a
    // suppressible opener instead.
    log.warn(
      {
        chatJid,
        kind: classification.kind,
        textLength: normalizedText.length,
        textPreview: normalizedText.slice(0, MAX_STREAMED_BANNER_LENGTH),
      },
      'delivered assistant_text despite provider-failure classification',
    );
    return false;
  }

  // ─── Control session (self-healing repair) ────────────────────────────────
  private activeControlReportId: string | null = null;
  private controlSession: SessionManager | null = null;
  private controlSessionTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(db: Database, messenger: Messenger, instanceName?: string, options?: AgentRuntimeOptions) {
    this.db = db;
    this.pollPersistence = new PendingPollPersistence(db);
    this.messenger = messenger;
    this.instanceName = instanceName ?? 'personal';
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
    this.serviceRestarter = options?.serviceRestarter;
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
    const configuredFallbacks = Array.isArray(config.agentFallbacks)
      ? config.agentFallbacks
      : normalizeFallbackEntriesFromAgentOptions({
          fallbackProvider: config.agentFallbackProvider,
          fallbackModel: config.agentFallbackModel,
        });
    this.agentFallbacks = configuredFallbacks.map((entry) =>
      entry.model ? { provider: entry.provider, model: entry.model } : { provider: entry.provider },
    );
    this.registry = new ToolRegistry();
    this.registerAllTools();

    this.turnQueue = new TurnQueue({
      maxDepth: config.agentMaxQueueDepth,
      onReject: (turn) => {
        log.warn({ chatJid: turn.chatJid, senderJid: turn.senderJid },
          'turn rejected — agent queue full');
      },
    });
    this.turnQueue.setProcessor((turn) => this.processTurn(turn));

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
    // QR-069: inherit a prior queue's echo-guard token when one exists. Pass the
    // 3rd arg only when defined so a genuinely-new queue keeps the 2-arg
    // construction contract (no trailing `undefined`) — mirrors the QR-028
    // conditional-call precedent for optional positional params.
    const priorToken = this.priorSenderTokenForChat(chatJid);
    const q = priorToken !== undefined
      ? new OutboundQueue(this.messenger, chatJid, priorToken)
      : new OutboundQueue(this.messenger, chatJid);
    if (this.durability) q.setDurability(this.durability);
    q.setToolUpdateMode(config.toolUpdateMode);
    q.setToolUpdateRedirectJid(config.toolUpdateRedirectJid);
    q.setTextAggregateDelayMs(config.textAggregateDelayMs);
    log.debug({
      chatJid,
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
  }

  /**
   * Update delivery JID for active sessions and queues when a LID→phone
   * mapping changes. Iterates per-chat queues and socket servers keyed
   * by conversationKey (sandboxPerChat mode) or raw chatJid.
   */
  handleJidAliasChanged(conversationKey: string, newJid: string): void {
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
      if (this.chatSessions.has(lidKey)) {
        const canonical = canonicalizeChatJid(newJid, this.db);
        if (canonical !== lidKey && !this.chatSessions.has(canonical)) {
          // Migrate session
          const session = this.chatSessions.get(lidKey)!;
          this.chatSessions.delete(lidKey);
          this.chatSessions.set(canonical, session);

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
          // F-STICKY-ACTOR (QR-247, F4): migrate the executing-actor queue + the
          // per-chat socket resource to the canonical key so a LID->phone rekey does
          // not orphan the in-flight actor or leave the socket keyed by the dead lidKey.
          // The resolver re-derives mapKey each read, so it follows the canonical key.
          const execActors = this.perChatExecActorQueue.get(lidKey);
          if (execActors !== undefined) {
            this.perChatExecActorQueue.delete(lidKey);
            this.perChatExecActorQueue.set(canonical, execActors);
          }
          const sockRes = this.perChatSocketResources.get(lidKey);
          if (sockRes !== undefined) {
            this.perChatSocketResources.delete(lidKey);
            this.perChatSocketResources.set(canonical, sockRes);
          }
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
          this.cleanupPerChatState(lidKey);
          log.info({ lidKey, canonical, newJid }, 'per_chat: re-keyed session and all maps after LID resolution');
        }
      }
    }
  }

  async start(): Promise<void> {
    ensureAgentSchema(this.db);
    // Crash-safe latch table for the one-message handoff collapse. Idempotent;
    // created eagerly so an unconsumed notice from a prior process can flush.
    ensureStandbyNoticeSchema(this.db);
    // Handoff-artifact store for the distilled-context injection seam. Idempotent;
    // created eagerly so a fresh stand-in session can read a prior distill. The
    // injection itself is flag-gated (WHATSOUP_HANDOFF_CONTEXT); creating the
    // table unconditionally is inert when the flag is off.
    ensureHandoffArtifactSchema(this.db);
    this.restorePersistedFallbackWindow();
    backfillSessionProvider(this.db, this.agentProvider ?? 'claude-cli');
    if (config.nlRouting) {
      // Additive + idempotent; gated so flag-off leaves the DB untouched.
      ensureChatPreferenceSchema(this.db);
      // Retention sweep at boot: expired rows are DELETED, not merely
      // ignored on read (F13) — keeps DB audits honest about live pins.
      pruneExpired(this.db);
    }

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
        const hookPath = resolve(
          new URL('.', import.meta.url).pathname,
          '../../../deploy/hooks/agent-sandbox.sh',
        );
        const pollLintHookPath = resolve(
          new URL('.', import.meta.url).pathname,
          '../../../deploy/hooks/poll-interaction-lint.mjs',
        );
        const postToolUseLogHookPath = resolve(
          new URL('.', import.meta.url).pathname,
          '../../../deploy/hooks/post-tool-use-log.sh',
        );
        writeSandboxArtifacts(claudeDir, resolvedPolicy, hookPath, pollLintHookPath, postToolUseLogHookPath);
        log.info({ cwd, hookPath, pollLintHookPath, postToolUseLogHookPath }, 'wrote sandbox-policy.json and settings.json');
      } catch (err) {
        log.error({ err, cwd }, 'failed to initialize sandbox artifacts');
        throw err;
      }
    }

    // Ensure settings.json has a permissions block — safety net for instances
    // without sandbox config. Prevents Claude Code's "sensitive file" blocks.
    {
      const cwd = this.cwd ?? homedir();
      try {
        const claudeDir = join(cwd, '.claude');
        ensurePermissionsSettings(claudeDir, 'agent', this.enabledPlugins, { hasSandbox: !!this.sandbox });
        // Non-sandbox agents whose cwd != home also carry the user-level ~/.claude
        // settings (cwd-independent, applied to every Claude session). An orphaned
        // fail-closed agent-sandbox hook there is not covered by the cwd-derived
        // reconcile above, so sweep it too. No-op when cwd == home (same dir).
        if (!this.sandbox) {
          const homeClaudeDir = join(homedir(), '.claude');
          if (homeClaudeDir !== claudeDir) {
            ensurePermissionsSettings(homeClaudeDir, 'agent', undefined, { hasSandbox: false });
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
        this.globalSocketServer = new WhatSoupSocketServer(socketPath, this.registry, globalSession);
        this.globalSocketServer.start();
        this.globalMcpSocketPath = socketPath;
        log.info({ socketPath }, 'global WhatSoup socket server started');
        // F-STICKY-ACTOR (QR-247 hardening): the per-turn actor binding covers
        // claude-cli per_chat only. A non-claude subprocess provider — as PRIMARY, as
        // a configured FALLBACK, or (QR-263) selected at runtime by a live nlRouting
        // per-sender pin — in non-sandbox per_chat stays on THIS shared global socket,
        // so the concurrent-sender actor race is NOT closed for it.
        // Warn (naming the exposed surfaces) rather than imply fixed.
        if (this.perChatActorRaceExposed()) {
          log.warn(
            { provider: this.effectiveProvider, exposedProviders: this.exposedCliProviders(), nlRoutingPinSurface: this.nlRoutingEnabled, sessionScope: this.sessionScope },
            'per-chat actor binding covers claude-cli only: a non-claude subprocess (primary, configured fallback, or a live nlRouting per-sender pin) in non-sandbox per_chat uses the shared global MCP socket, so the concurrent-sender actor race (QR-247) is NOT closed for it.',
          );
        }

        // Write the whatsoup MCP config to every configured CLI provider target:
        // primary first, then fallback when it uses a distinct config file.
        const mcpServerScript = resolve(
          new URL('.', import.meta.url).pathname,
          '../../../deploy/mcp/whatsoup-proxy.ts',
        );
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

        const primaryOpencodeProviderConfig = this.primaryOpencodeProviderConfig();
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
    const proactiveResumeBlockedConversationKeys = new Set<string>();

    // Sweep stale sessions for all per_chat modes (including Q's non-sandboxed per_chat).
    // Cross-references agent_sessions with session_checkpoints to safely identify which
    // processes to keep and which to reap. Only kills PIDs verified as owned children.
    if (this.sessionScope === 'per_chat' || this.sandboxPerChat) {
      if (!this.durability) {
        log.warn('durability engine not set — skipping active session classification');
      } else {
        const classified = classifyActiveSessions(this.db, this.durability);
        for (const session of classified) {
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
              try { process.kill(session.claudePid, 'SIGTERM'); } catch { /* already gone */ }
              markOrphaned(this.db, session.id);
              break;
            case 'ambiguous':
              log.warn({
                id: session.id,
                pid: session.claudePid,
                conversationKey: session.conversationKey,
                reason: session.reason,
              }, 'ambiguous session — not touching');
              // Left running — block a duplicate proactive resume for this key.
              if (session.conversationKey) proactiveResumeBlockedConversationKeys.add(session.conversationKey);
              break;
            case 'authoritative_live':
              // Verified-live child left in place — block a duplicate proactive resume.
              if (session.conversationKey) proactiveResumeBlockedConversationKeys.add(session.conversationKey);
              break;
          }
        }
      }
    }

    // per_chat (non-sandboxed): proactively resume sessions that were active or suspended
    // (graceful shutdown) when we last ran. This lets agents pick up mid-conversation instead
    // of waiting for the user to send a message after a service restart.
    // sandboxPerChat is excluded — its resume path requires workspace provisioning which happens lazily.
    if (this.sessionScope === 'per_chat' && !this.sandboxPerChat && this.durability && config.proactiveResumeOnStartup) {
      const resumableCheckpoints = this.durability.getResumableCheckpoints();
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

        // AE1: Skip group conversations — groups should not be proactively resumed.
        // Agents in groups are orchestrated via @mentions. Proactive resume bypasses
        // the ingest pipeline's sibling filter (access-policy.ts:121-124), causing
        // unsolicited messages. Group sessions start fresh on the next @mention.
        if (isGroupConversationKey(cp.conversation_key)) {
          log.info({ conversationKey: cp.conversation_key }, 'skipping proactive resume — group chat');
          this.durability.upsertSessionCheckpoint(cp.conversation_key, { sessionStatus: 'ended' });
          continue;
        }

        // Skip stale sessions — don't resume conversations that have been inactive for over 60 minutes.
        // Without this, every restart tries to resurrect days-old sessions and fires unsolicited messages.
        const RESUME_MAX_AGE_MS = 60 * 60 * 1000;
        if (full.updated_at) {
          const age = Date.now() - new Date(full.updated_at + 'Z').getTime();
          if (age > RESUME_MAX_AGE_MS) {
            log.info({ conversationKey: cp.conversation_key, ageMinutes: Math.round(age / 60_000) }, 'skipping proactive resume — session too stale');
            this.durability.upsertSessionCheckpoint(cp.conversation_key, { sessionStatus: 'ended' });
            continue;
          }
        }

        // Derive chatJid from conversation_key — for DMs, append @lid; for groups, use as-is
        const chatJid = cp.conversation_key.includes('_at_')
          ? cp.conversation_key.replace('_at_', '@')
          : `${cp.conversation_key}@lid`;

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
              const mapKey = resolveSessionMapKey();
              if (!mapKey) {
                log.debug({ initialMapKey, chatJid, eventType: event.type }, 'event dropped — session key missing for per-chat callback');
                return;
              }
              this.handleEventPerChat(mapKey, event, toolScopeKey);
            },
            onCrash: (info) => {
              const mapKey = resolveSessionMapKey() ?? initialMapKey;
              this.handlePerChatCrash(mapKey, chatJid, info);
            },
            notifyUser: (msg) => {
              const mapKey = resolveSessionMapKey();
              if (mapKey) {
                const s = this.chatSessions.get(mapKey);
                if (s && !s.getStatus().active) {
                  this.chatSessions.delete(mapKey);
                  this.chatQueues.get(mapKey)?.abortTurn();
                  this.chatQueues.delete(mapKey);
                  this.cleanupPerChatState(mapKey);
                }
              }
              this.handleCrashNotify(msg, chatJid);
            },
          });
        } catch (err) {
          // F-STICKY-ACTOR (QR-247 hardening): per-chat socket wiring now runs inside
          // createSessionManager, so a socket/config failure here must not abort the
          // whole startup proactive-resume loop — skip this chat, which then lazy-resumes
          // on its next inbound message (fail-safe).
          log.warn({ err, chatJid, mapKey: initialMapKey }, 'proactive resume: per-chat session creation failed — skipping (will lazy-resume on next message)');
          continue;
        }
        this.chatSessions.set(initialMapKey, session);
        const perChatQ = this.createOutboundQueue(chatJid, 'startup proactive per-chat resume');
        this.chatQueues.set(initialMapKey, perChatQ);

        // Wire operation tracker for this proactively-resumed per-chat session
        const startupTracker = this.createOperationTracker(session, () => this.chatQueues.get(initialMapKey));
        if (startupTracker) this.operationTrackers.set(initialMapKey, startupTracker);

        // Attempt resume, then inject any messages the agent missed during
        // downtime and send a continuation turn so the agent picks up where it
        // left off without requiring the user to send "proceed".
        const checkpointUpdatedAt = full.updated_at
          ? Math.floor(new Date(full.updated_at + 'Z').getTime() / 1000)
          : undefined;
        session.spawnSession(full.session_id).then(async () => {
          // Small delay to let the init event propagate (confirms resume succeeded)
          await sleep(1_000);
          if (!session.getStatus().active) return; // resume failed, onResumeFailed handles it
          try {
            // Inject messages that arrived while the service was down.
            // Without this, the agent resumes with stale context — it has no
            // awareness of messages sent during the downtime window.
            if (checkpointUpdatedAt) {
              const injected = await this.injectMissedMessages(session, chatJid, checkpointUpdatedAt);
              if (injected) this.pendingSystemResults.mark(initialMapKey);
            }
            this.pendingSystemResults.mark(initialMapKey);
            await session.sendTurn('[System: session resumed after service restart — continue where you left off]');
            log.info({ chatJid }, 'sent continuation turn after proactive resume');
          } catch (err) {
            log.warn({ err, chatJid }, 'failed to send continuation turn after resume');
            // Continuation send failed — no result will arrive for its mark.
            this.pendingSystemResults.unmark(initialMapKey);
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
    const prior = (this.sandboxPerChat || this.sessionScope === 'per_chat') ? null : getActiveSession(this.db);

    // AE2: Staleness check for shared/single mode — match per_chat's 60-minute threshold.
    let priorSession = prior;

    // Guard: chat_jid may be null for legacy session rows
    if (priorSession && !priorSession.chat_jid) {
      log.info('skipping shared/single resume — no chat_jid on session row');
      priorSession = null;
    }

    if (priorSession && this.durability) {
      const ck = toConversationKey(priorSession.chat_jid!);
      const checkpoint = this.durability.getSessionCheckpoint(ck);
      if (checkpoint?.updated_at) {
        const ageMs = Date.now() - new Date(checkpoint.updated_at + 'Z').getTime();
        if (ageMs > 60 * 60 * 1000) {
          log.info({ chatJid: priorSession.chat_jid, ageMinutes: Math.round(ageMs / 60_000) },
            'skipping shared/single resume — session too stale');
          this.durability.upsertSessionCheckpoint(ck, { sessionStatus: 'ended' });
          priorSession = null;
        }
      } else {
        // No checkpoint or updated_at absent — cannot verify freshness, skip resume
        log.info({ chatJid: priorSession?.chat_jid }, 'skipping shared/single resume — no checkpoint or no updated_at');
        priorSession = null;
      }
    }

    // AE2 fallback: when durability is absent, use started_at directly
    if (priorSession && !this.durability && priorSession.started_at) {
      const ageMs = Date.now() - new Date(priorSession.started_at).getTime();
      if (ageMs > 60 * 60 * 1000) {
        log.info({ chatJid: priorSession.chat_jid, ageMinutes: Math.round(ageMs / 60_000) },
          'skipping shared/single resume — stale (no durability)');
        priorSession = null;
      }
    }

    if (priorSession?.session_id && priorSession?.chat_jid) {
      // Capture narrowed values before closures — TypeScript does not propagate
      // if-guard narrowing into lambdas, so priorSession.chat_jid inside the closure
      // would remain typed as string | null even though we've checked it.
      const resumeChatJid: string = priorSession.chat_jid;
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
        this.session = this.createSessionManager({
          chatJid: resumeChatJid,
          cwd: this.cwd,
          trackSingletonMcpSession: true,
          onEvent: (event) => this.handleEvent(event),
          onResumeFailed: () => this.handleResumeFailed(resumeChatJid),
          onCrash: (info) => {
            this.recordCrash(GLOBAL_CRASH_SCOPE_KEY);
            this.getActiveQueue()?.abortTurn();
            this.cleanupSharedCrashTurnState();
            // Mark inbound event failed so it doesn't stay stuck in processing
            if (this.durability && this.currentInboundSeq !== undefined) {
              this.markRuntimeFaultContinuityCandidate(this.currentInboundSeq);
              this.replyGuarantee?.disarm(this.currentInboundSeq);
              this.durability.markInboundFailed(this.currentInboundSeq, 'session_crash');
              this.currentInboundSeq = undefined;
            }
            if (config.controlPeers.size > 0) {
              try {
                emitHealReport(this.db, this.messenger, this.durability, {
                  type: 'crash',
                  chatJid: resumeChatJid,
                  exitCode: info.exitCode ?? undefined,
                  signal: info.signal ?? undefined,
                  provider: info.provider,
                  crashClass: info.crashClass,
                  stderr: info.stderrPreview,
                }, this.activeControlReportId);
              } catch (err) {
                log.warn({ err }, 'failed to emit heal report for session crash');
              }
            }
          },
          notifyUser: (msg) => this.handleCrashNotify(msg),
        });

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
            this.pendingStartupMessage = {
              chatJid: resumeChatJid,
              text: `_Resuming session_ from *${age}*. Send a message to continue, or /new to start fresh.`,
            };
          }
        }
      }
    }

    // Register emit_heal_result MCP tool (once, for control-plane repair completion).
    // Only on non-sandboxed instances (Q) — sandboxed instances (Loops) are repair targets, not repairers.
    // Tagged `core: false` because this registration is conditional on configured control peers;
    // see `src/mcp/types.ts` for the contract — non-core tools must tolerate absence on instances
    // that do not meet the gate (no control peers, sandbox mode, or per-chat sandbox).
    if (config.controlPeers.size > 0 && !this.sandboxPerChat && !this.sandbox) {
      this.registry.register({
        name: 'emit_heal_result',
        description: 'Signal completion of a repair cycle. Only callable during an active repair session.',
        schema: EmitHealResultSchema,
        scope: 'global',
        targetMode: 'caller-supplied',
        replayPolicy: 'unsafe',
        core: false,
        handler: async (params) => {
          const parsed = EmitHealResultSchema.parse(params);

          // Validate: must match active repair
          if (!this.activeControlReportId) {
            throw new Error('No active repair session');
          }
          if (parsed.reportId !== this.activeControlReportId) {
            throw new Error(`No active repair for reportId ${parsed.reportId}. Active: ${this.activeControlReportId}`);
          }

          const controlQueue = this.getControlQueue();
          if (!controlQueue) {
            throw new Error('Control queue not found');
          }

          // Determine target JID (Loops)
          const loopsPhone = [...config.controlPeers.entries()].find(([name]) => name === 'loops')?.[1];
          const loopsJid = loopsPhone ? toPersonalJid(loopsPhone) : null;

          if (parsed.result === 'fixed') {
            if (loopsJid) {
              await controlQueue.sendControlMessage(loopsJid, 'HEAL_COMPLETE', {
                reportId: parsed.reportId,
                errorClass: parsed.errorClass,
                result: 'fixed',
                commitSha: parsed.commitSha,
                diagnosis: parsed.diagnosis,
              }, this.durability ?? undefined);
            }
          } else {
            // escalate
            if (loopsJid) {
              await controlQueue.sendControlMessage(loopsJid, 'HEAL_ESCALATE', {
                reportId: parsed.reportId,
                errorClass: parsed.errorClass,
                diagnosis: parsed.diagnosis,
              }, this.durability ?? undefined);
            }
            // Also DM admin
            const adminPhone = [...config.adminPhones][0];
            if (adminPhone) {
              const adminJid = toPersonalJid(adminPhone);
              await sendTracked(this.messenger, adminJid,
                `[HEAL_ESCALATE] Repair for ${parsed.errorClass} escalated.\n\n${parsed.diagnosis}`,
                this.durability ?? undefined, { replayPolicy: 'safe' });
            }
          }

          // Resolve pending_heal_reports row (Type 3 cleanup)
          try {
            this.db.raw.prepare(
              "UPDATE pending_heal_reports SET state = 'resolved' WHERE report_id = ?",
            ).run(parsed.reportId);
          } catch (err) {
            // best-effort, but visible: a stuck-pending row re-fires stale-open re-notify
            log.warn({ err, reportId: parsed.reportId }, 'failed to mark heal report resolved; row stays pending');
          }

          // Clear hard timeout (normal completion path)
          if (this.controlSessionTimeout) {
            clearTimeout(this.controlSessionTimeout);
            this.controlSessionTimeout = null;
          }

          // Clear single-flight slot
          this.clearControlReport();

          // Dequeue next report if any
          const next = dequeueNextReport(this.db);
          if (next) {
            const context = parseHealContext(next.context);
            void this.handleControlTurn(next.report_id, JSON.stringify({
              ...context,
              reportId: next.report_id,
              errorClass: next.error_class,
            })).catch(err => {
              log.error({ err, reportId: next.report_id }, 'unhandled error in handleControlTurn');
            });
          }

          return { sent: true, reportId: parsed.reportId, result: parsed.result };
        },
      });
    }

    // Register restart_self MCP tool (agent instance only — sandboxed instances
    // are repair targets, not self-restarters). Routes through the existing
    // graceful shutdown via ServiceManager.restart; logic lives in self-restart.ts.
    // Requires the fleet-owned restarter injected from the composition root.
    if (!this.sandbox && !this.sandboxPerChat && this.serviceRestarter) {
      const serviceRestarter = this.serviceRestarter;
      this.registry.register(buildRestartSelfTool({
        instanceName: this.instanceName,
        dataRoot: config.dataRoot,
        resolveChatJid: () => this.currentTurnChatJid ?? this.activeChatJid ?? undefined,
        sendAck: async (chatJid, text) => {
          await sendTracked(this.messenger, chatJid, text, this.durability ?? undefined, { replayPolicy: 'unsafe' });
        },
        serviceManager: serviceRestarter,
        trigger: triggerSelfRestart,
        // QR-047: admin gate, same resolve+isAdminPhone check the other admin paths use.
        assertAdmin: (session) => {
          const phone = session.actorJid ? resolvePhoneFromJid(session.actorJid, this.db) : null;
          if (!phone || !isAdminPhone(phone, config.adminPhones)) {
            throw new Error(
              `restart_self is admin-only: caller "${phone ?? 'unresolved'}" is not on the instance admin list`,
            );
          }
        },
      }));
    }

    // Heal the claude file-store credential from the keychain BEFORE the first
    // turn can run, so a keychain-only refresh (native login) can't false-arm
    // the provider fallback on turn 1 (the recovery probe path heals for the
    // mid-run case). No-op off-darwin / when CLAUDE_CONFIG_DIR is unset / when
    // the file store is already current. Fail-open by contract.
    if (this.agentProvider === 'claude-cli') {
      ensureClaudeFileStoreCredential();
    }
    this.schedulePrimaryModelUsabilityProbe('startup');
    this.startHealthStatsTimer();
    this.workspaceSweeper.start();
    this.startQueueSweepTimer();
    this.startSessionSweepTimer();
    this.handoffDistill.start();

    // Restore any pending polls from the previous process so votes-in-flight
    // and active AskUserQuestion polls survive a restart. Errors logged inside;
    // never throws.
    await this.rehydratePendingPolls();

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
    beadId: number; triggerId: number; prompt: string; title: string; reportChatJid: string;
  }): { dispatched: boolean; detail?: string } {
    try {
      const now = Math.floor(Date.now() / 1000);
      const synthetic: IncomingMessage = {
        messageId: `agentjob-${ctx.triggerId}-${now}`,
        chatJid: ctx.reportChatJid,
        senderJid: config.memory.adminJid,
        senderName: ctx.title ? `Scheduled job: ${ctx.title}`.slice(0, 80) : 'Scheduled job',
        content: ctx.prompt,
        contentText: null,
        contentType: 'text',
        isFromMe: false,
        isGroup: ctx.reportChatJid.endsWith('@g.us'),
        mentionedJids: [],
        timestamp: now,
        quotedMessageId: null,
        isResponseWorthy: true,
        inboundSeq: undefined,
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
      return { dispatched: true, detail: `enqueued turn for bead ${ctx.beadId}` };
    } catch (err) {
      return { dispatched: false, detail: errorMessage(err) };
    }
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
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
      const senderPhone = resolvePhoneFromJid(msg.senderJid, this.db);
      // Skip the inline imperative extractor for synthetic agent-job turns —
      // otherwise a scheduled prompt would spawn a proposed task bead on every
      // fire. The job is already a durable agent_job bead; it is not an ad-hoc
      // imperative to capture.
      if (isAdminPhone(senderPhone, config.adminPhones) && !msg.isSyntheticJob) {
        const hit = matchImperative(content);
        if (hit) {
          const target = extractImperativeTarget(content);
          const title = target && target.length > 0 ? target.slice(0, 200) : content.slice(0, 120);
          // review_by_at records a review horizon on the proposal. It is stored on
          // the bead and surfaced via get_bead/list_beads for manual/operator
          // review; no automatic sweep cancels unreviewed rows past this horizon.
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
        if (this.durability && msg.inboundSeq !== undefined) {
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

    this.turnChain = this.turnChain
      .then(() => this._handleMessageInner(msg))
      .catch((err) => {
        log.error(
          { err, messageId: msg.messageId, chatJid: msg.chatJid },
          'unhandled error in message processing',
        );
        // Mark inbound event as failed so it doesn't stay stuck in 'processing'
        if (this.durability && msg.inboundSeq !== undefined) {
          this.markRuntimeFaultContinuityCandidate(msg.inboundSeq);
          this.replyGuarantee?.disarm(msg.inboundSeq);
          this.durability.markInboundFailed(msg.inboundSeq, classifyErrorForInbound(err));
        }
        // Notify user of failure
        this.sendDirect(msg.chatJid, 'Something went wrong processing that message. Try again?');
      });
  }

  private async _handleMessageInner(msg: IncomingMessage): Promise<void> {
    let content = msg.content;
    const chatJid = msg.chatJid;
    const perChatMapKey = this.sessionScope === 'per_chat'
      ? this.resolvePerChatMapKey(chatJid)
      : undefined;

    // Substrate slice 1: propagate sender identity to every MCP session so
    // admin-gated substrate tools can distinguish the caller from the target
    // chat. In groups, msg.chatJid IS the group JID; without this propagation
    // admin gating would compare against the group JID and always reject.
    //
    // Two cases to cover:
    //   1. Global socket (single / shared / non-sandbox per_chat modes) —
    //      always active when !sandboxPerChat; update unconditionally.
    //   2. Per-chat sockets — only populated in workspaceResources when
    //      sandboxPerChat=true (async ensureSessionAndQueue path). The
    //      synchronous per_chat-without-sandbox path uses the global socket
    //      above and never allocates a per-chat socket, so the `workspaceResources`
    //      lookup here is only reachable under sandboxPerChat=true.
    // F-STICKY-ACTOR (QR-247): keep the shared global socket actor-LESS for claude-cli
    // per_chat — its per-chat sockets resolve the actor per-request from the executing
    // register, so the global socket must never carry a sender's actor. A non-claude
    // fallback subprocess reads the global socket, and an undefined actor there is
    // fail-closed (deny). Instance-global (NOT presence-based on a per-chat socket): the
    // fail-closed property must hold from the FIRST message, before any per-chat socket
    // exists — a presence gate would broadcast the first-message sender onto the global
    // socket and reopen the confused-deputy race for the fallback path. single/shared
    // broadcast (they legitimately use the global socket); non-claude per_chat stays on
    // the pre-fix path (validator-warned, F11).
    if (!this.usesPerChatActorSocket()) {
      this.globalSocketServer?.updateActorJid(msg.senderJid);
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

    // Set only by /model default (R8): the handler clears the route pref
    // locally and then falls through to forward the raw command so the agent
    // CLI's own /model default reset still runs. Null for every other command.
    let forwardAfterLocalCommand: string | null = null;

    if (classified.type === 'local') {
      try {
        switch (classified.command) {
          case 'new':
            // Shared mode: /new is admin-only
            if (this.shared && !isAdminPhone(resolvePhoneFromJid(msg.senderJid, this.db), config.adminPhones)) {
              // @check CHK-067 // @traces REQ-012.AC-06
              return;
            }
            // Capture session ref before branches may delete it from the map.
            // In per_chat mode, this.session is NOT reliable (shared field race),
            // so we look up the correct session from the per-chat maps.
            const sessionForNew = this.sessionScope === 'per_chat'
              ? this.chatSessions.get(perChatMapKey!)
              : this.session;
            log.info({
              chatJid,
              sessionScope: this.sessionScope,
              shared: this.shared,
              sandboxPerChat: this.sandboxPerChat,
            }, 'resetting session and queue for /new');
            // Abort the old queue — clears timers and typing heartbeat before discarding.
            // Use getQueueForChat (map-based) instead of getActiveQueue (shared-field-based).
            this.getQueueForChat(chatJid, perChatMapKey)?.abortTurn();
            if (this.sessionScope !== 'per_chat') {
              this.cleanupGlobalAutoCompactState();
            }
            // Create a fresh queue before spawning so stale output from the old session
            // can never leak into the new session's delivery channel.
            if (this.sandboxPerChat && this.sessionScope === 'per_chat') {
              // sandboxPerChat: replace session+queue keyed by workspaceKey; workspace resources survive
              const { workspaceKey } = chatJidToWorkspace(this.cwd ?? homedir(), chatJid);
              this.cleanupPerChatState(workspaceKey);
              this.chatSessions.delete(workspaceKey);
              const q1 = this.createOutboundQueue(chatJid, '/new sandbox per-chat replacement');
              this.chatQueues.set(workspaceKey, q1);
            } else if (this.shared) {
              const q2 = this.createOutboundQueue(chatJid, '/new shared replacement');
              this.outboundQueues.set(chatJid, q2);
            } else if (this.sessionScope === 'per_chat') {
              // non-sandboxPerChat per_chat: keyed by canonical chat key
              this.cleanupPerChatState(perChatMapKey!);
              this.chatSessions.delete(perChatMapKey!);
              const q3 = this.createOutboundQueue(chatJid, '/new per-chat replacement');
              this.chatQueues.set(perChatMapKey!, q3);
            } else {
              const q4 = this.createOutboundQueue(chatJid, '/new single replacement');
              this.queue = q4;
            }
            // NOTE: sessionForNew was captured before the map delete above. handleNew()
            // signals the old session to reset. Any async events from the dying session
            // arrive with the old workspaceKey — handleEventPerChat tolerates missing
            // queue entries (returns early). The next message triggers ensureSessionAndQueue
            // which creates a fresh session+queue in the map. This is a narrow window
            // inherited from the original design, not a regression from the race fix.
            await sessionForNew?.handleNew();
            // QR-108: /new is a clean reset, so drop the one-message-handoff latches
            // for this conversation too — otherwise a standby notice or handoff
            // artifact stashed before /new leaks into the NEXT reply/prelude (both
            // tables are keyed by the stable conversation_key, which /new does not
            // change). Both fns are idempotent no-ops when nothing is pending, and
            // their own JSDoc already documents "cleared on /new".
            {
              const resetKey = toConversationKey(chatJid);
              clearStandbyNotice(this.db, resetKey);
              deleteHandoffArtifact(this.db, resetKey);
            }
            // Reset turn flag — stale value from the old session must not suppress the
            // _(no response)_ fallback if the first new-session turn has no visible text.
            this.turnHadVisibleOutput = false;
            this.sendDirect(chatJid, '*Starting new session* ✓');
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
              text =
                '*Session active*\n' +
                `PID: \`${status.pid ?? 'unknown'}\`\n` +
                `Session: \`${sessionShort}\`\n` +
                `Started: ${started}\n` +
                `Messages: ${status.messageCount}\n` +
                `Last activity: ${lastActivity}`;
            } else {
              text = '_No active session._ Send a message to start one.';
            }
            this.sendDirect(chatJid, text);
            break;
          }

          case 'model': {
            // NL-first routing alias (owner-approved design). Records a
            // per-sender REASONING preference and renders route visibility —
            // never tool, mutation, or authority changes (capability-preserved
            // routing). Reachable only when agentOptions.nlRouting is true (the
            // classifier gates on the same flag).
            const sub = (classified.args ?? 'status').trim().toLowerCase();
            const { chatKey, senderKey } = preferenceKeys(this.db, chatJid, msg.senderJid);
            if (sub === '' || sub === 'status') {
              // Opportunistic retention sweep on read (F13); also runs at init.
              // Fail-open (R11): a store error on the sweep must not throw out of
              // this read-only handler — status still renders on the default route.
              try {
                pruneExpired(this.db);
              } catch (err) {
                log.warn({ err, instance: this.instanceName }, 'pruneExpired failed during /model status - continuing');
              }
              this.sendDirect(chatJid, this.renderRouteStatus(chatJid, msg.senderJid));
              break;
            }
            if (sub === 'default') {
              // R8: clear the sender's route override, then forward /model
              // default to the CLI so its own model reset still runs — do not
              // shadow that base capability. The forwarded turn owns terminal
              // inbound durability, so this path must NOT complete it locally.
              this.clearRoutePreference(chatJid, chatKey, senderKey);
              forwardAfterLocalCommand = content as string;
              break;
            }
            const isIntent = sub === 'strongest' || sub === 'fastest';
            const isProvider = isProviderId(sub);
            if (isProvider) {
              const routable = this.routablePinTargets();
              if (!routable.includes(sub)) {
                // A pin this instance cannot honor must fail at SET time (F07):
                // recording it would force slice-2 resolution into either a
                // hard-fail or a silent fallback. No row is written.
                this.sendDirect(
                  chatJid,
                  `_${sub} isn't available on this instance. Available: ${routable.join(', ')}. /model status shows the current route._`,
                );
                break;
              }
            }
            if (!isIntent && !isProvider) {
              // Out-of-contract value: no state change, honest reply (UH-001).
              // Never echo unbounded user text into a (possibly group) chat:
              // strip markdown-breaking chars and cap the length (F03).
              // Defense-in-depth: unreachable while classifyInput admits only the
              // recognized /model grammar (bare | verb | provider-id), so a
              // non-verb/non-provider `sub` never arrives here. Kept as a
              // fail-safe against any future widening of that grammar (F03).
              const safeSub = sub.replace(/[`_*\n\r]/g, '').slice(0, 24) + (sub.length > 24 ? '…' : '');
              this.sendDirect(
                chatJid,
                `_I do not recognize "${safeSub}". Use /model status to see available routes._`,
              );
              break;
            }
            const intent = isIntent ? (sub as 'strongest' | 'fastest') : 'provider_specific';
            const requestedProvider = isProvider ? sub : null;
            const outcome = this.recordRoutePreference(chatJid, chatKey, senderKey, intent, requestedProvider);
            if (outcome === 'refreshed') {
              this.sendDirect(chatJid, '_Already set — extended for another 24h. /reset to go back to the default route._');
              break;
            }
            if (outcome === 'sticky_kept') {
              this.sendDirect(chatJid, '_Already set (sticky). /reset to go back to the default route._');
              break;
            }
            const what = isProvider ? `\`${sub}\`` : `my ${sub} model`;
            this.sendDirect(chatJid, `_Okay — preferring ${what} for you in this chat (24h). Applies from your next session — say /new to start one now._`);
            break;
          }

          case 'why': {
            this.sendDirect(chatJid, this.renderRouteWhy(chatJid, msg.senderJid));
            break;
          }

          case 'reset': {
            // Idempotent by construction: clearing an absent row is a no-op and
            // the reply is identical, so a doubled /reset cannot spam or error.
            const { chatKey, senderKey } = preferenceKeys(this.db, chatJid, msg.senderJid);
            this.clearRoutePreference(chatJid, chatKey, senderKey);
            break;
          }

          case 'help': {
            const helpText =
              '*/new* — start a fresh session\n' +
              '*/status* — show current session status\n' +
              '*/sessions* — list all active sessions _(admin)_\n' +
              '*/kill-session <N>* — terminate a session by number _(admin)_\n' +
              '*/help* — show this help\n' +
              (config.nlRouting
                ? '*/model* — route status; `/model strongest|fastest|default|<provider>`\n' +
                  '*/why* — why this model answered\n' +
                  '*/reset* — back to the default route\n'
                : '') +
            '_Any other message is forwarded to Claude Code._\n' +
            'Other slash commands (e.g. `/compact`) are passed directly to Claude Code.';
            this.sendDirect(chatJid, helpText);
            break;
          }

          case 'sessions': {
            // Admin-only
            if (!isAdminPhone(resolvePhoneFromJid(msg.senderJid, this.db), config.adminPhones)) {
              return;
            }
            const entries: string[] = [];
            let idx = 1;
            if (this.sessionScope === 'per_chat') {
              for (const [mapKey, sess] of this.chatSessions) {
                const st = sess.getStatus();
                if (!st.active) continue;
                const isGrp = isGroupConversationKey(mapKey);
                const label = isGrp ? 'Group' : 'DM';
                const ageStr = st.startedAt ? formatAge(st.startedAt) : '?';
                const dbRowId = sess.getDbRowId();
                let tkStr = '0';
                if (dbRowId !== null) {
                  const tokenRow = this.db.raw.prepare(
                    'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?'
                  ).get(dbRowId) as { total_input_tokens: number | null; total_output_tokens: number | null } | undefined;
                  if (tokenRow) {
                    const tkTotal = (tokenRow.total_input_tokens ?? 0) + (tokenRow.total_output_tokens ?? 0);
                    tkStr = tkTotal > 1000 ? `${(tkTotal / 1000).toFixed(1)}k` : String(tkTotal);
                  }
                }
                entries.push(`${idx}. ${mapKey} (${label}) — ${ageStr}, ${st.messageCount} msgs, ${tkStr} tokens`);
                idx++;
              }
            } else {
              const st = this.session?.getStatus();
              if (st?.active) {
                const ageStr = st.startedAt ? formatAge(st.startedAt) : '?';
                const dbRowId = this.session?.getDbRowId() ?? null;
                let tkStr = '0';
                if (dbRowId !== null) {
                  const tokenRow = this.db.raw.prepare(
                    'SELECT total_input_tokens, total_output_tokens FROM agent_sessions WHERE id = ?'
                  ).get(dbRowId) as { total_input_tokens: number | null; total_output_tokens: number | null } | undefined;
                  if (tokenRow) {
                    const tkTotal = (tokenRow.total_input_tokens ?? 0) + (tokenRow.total_output_tokens ?? 0);
                    tkStr = tkTotal > 1000 ? `${(tkTotal / 1000).toFixed(1)}k` : String(tkTotal);
                  }
                }
                entries.push(`1. ${this.activeChatJid ?? 'unknown'} — ${ageStr}, ${st.messageCount} msgs, ${tkStr} tokens`);
              }
            }
            const sessionsText = entries.length > 0
              ? `*Active Sessions (${entries.length})*\n\n${entries.join('\n')}\n\n/kill-session <number> to terminate`
              : '_No active sessions._';
            this.sendDirect(chatJid, sessionsText, true);
            break;
          }

          case 'kill-session': {
            // Admin-only
            if (!isAdminPhone(resolvePhoneFromJid(msg.senderJid, this.db), config.adminPhones)) {
              return;
            }
            const targetIdx = parseInt(classified.args ?? '', 10);
            if (isNaN(targetIdx) || targetIdx < 1) {
              this.sendDirect(chatJid, '_Usage: /kill-session <number>_\nRun /sessions first to see the list.', true);
              break;
            }
            if (this.sessionScope === 'per_chat') {
              const activeSessions = [...this.chatSessions.entries()].filter(([, s]) => s.getStatus().active);
              if (targetIdx > activeSessions.length) {
                this.sendDirect(chatJid, `_Invalid session number. ${activeSessions.length} active._`, true);
                break;
              }
              const [mapKey, targetSession] = activeSessions[targetIdx - 1];
              this.chatQueues.get(mapKey)?.abortTurn();
              this.chatSessions.delete(mapKey);
              this.chatQueues.delete(mapKey);
              this.cleanupPerChatState(mapKey);
              await targetSession.shutdown(false);
              const killLabel = isGroupConversationKey(mapKey) ? 'Group' : 'DM';
              this.sendDirect(chatJid, `_Session killed: ${mapKey} (${killLabel})_`, true);
            } else {
              if (!this.session?.getStatus().active) {
                this.sendDirect(chatJid, '_No active session to kill._', true);
                break;
              }
              this.getActiveQueue()?.abortTurn();
              this.operationTracker?.shutdown();
              this.operationTracker = null;
              this.cleanupGlobalAutoCompactState();
              await this.session.shutdown(false);
              this.session = null;
              this.queue = null;
              this.activeChatJid = null;
              this.sendDirect(chatJid, '_Session killed._', true);
            }
            break;
          }
        }
      } catch (err) {
        // Contain local-command handler faults: without this, a throwing handler
        // escapes to the turnChain catch-all, whose unguarded markInboundFailed
        // would count a command-handler fault as an inbound processing failure.
        // The R14 completion below still runs and finalizes the row truthfully
        // (the inbound WAS a locally-handled command).
        log.error({ err, command: classified.command, chatJid }, 'local command handler failed');
        this.sendDirect(chatJid, 'Something went wrong processing that command. Try again?');
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
      this.currentTurnAssistantText = '';
      this.currentTurnAssistantItemText.clear();
      this.turnQueue.enqueue({
        chatJid,
        senderJid: msg.senderJid,
        senderName: msg.senderName ?? null,
        text,
        isGroup: msg.isGroup,
        groupName: msg.isGroup ? chatJid : undefined,
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

        // per_chat: enqueue inbound seq keyed by chat before sending turn
        const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
        if (msg.inboundSeq !== undefined) seqQueue.push(msg.inboundSeq);
        this.perChatInboundSeqQueue.set(mapKey, seqQueue);
        this.getQueueForChat(chatJid, mapKey)?.setInboundSeq(msg.inboundSeq);
        this.replyGuarantee?.arm({ inboundSeq: msg.inboundSeq, chatJid });
        // Track inbound contentType for voice reply (SP4)
        this.perChatTurnContentType.set(mapKey, msg.contentType);
        this.perChatTurnText.set(mapKey, '');
        this.perChatTurnSuppressedReplySatisfaction.delete(mapKey);
        this.perChatAssistantItemText.delete(mapKey);
        // Arm the R1 first-line marker scan for this turn (flag-gated).
        if (config.nlRouting) this.perChatRouteMarkerHold.set(mapKey, '');
        else this.perChatRouteMarkerHold.delete(mapKey);
        await this.sendTurnPerChat(chatJid, text, mapKey, msg.senderJid);
      }
    } else {
      // single mode: store inbound seq on runtime + queue
      this.currentInboundSeq = msg.inboundSeq;
      this.queue?.setInboundSeq(msg.inboundSeq);
      this.replyGuarantee?.arm({ inboundSeq: msg.inboundSeq, chatJid });
      // Track inbound contentType for voice reply (SP4)
      this.currentTurnInboundContentType = msg.contentType;
      this.currentTurnAssistantText = '';
      this.turnHadSuppressedReplySatisfaction = false;
      this.currentTurnAssistantItemText.clear();
      // Arm the R1 first-line marker scan for this turn (flag-gated).
      this.currentTurnRouteMarkerHold = config.nlRouting ? '' : null;
      await this.sendTurnNonShared(chatJid, text, msg.senderJid);
    }
  }

  /**
   * Process a single turn from the TurnQueue (shared mode).
   * Sets currentTurnChatJid so event routing knows where to send output.
   */
  private async processTurn(turn: QueuedTurn): Promise<void> {
    const { chatJid, senderJid, senderName, text, isGroup } = turn;

    // Clear post-turn gate — legitimate new user turn begins (shared mode)
    this.postTurnGate.delete(GLOBAL_TOOL_SCOPE_KEY);

    // Ensure outbound queue exists for this chat
    this.ensureOutboundQueue(chatJid);

    if (!this.session!.getStatus().active) {
      await this.session!.spawnSession();
    }

    // Build context prefix
    // @check CHK-064 // @traces REQ-012.AC-02
    const phone = resolvePhoneFromJid(senderJid, this.db);
    const displayName = senderName ?? phone;
    const prefix = isGroup
      ? `[Group: ${chatJid} — ${displayName}]`
      : `[DM from ${displayName} (${phone})]`;
    const prefixedText = `${prefix}\n${text}`;

    // Track which chat this turn belongs to for event routing
    // @check CHK-065 // @traces REQ-012.AC-03
    this.currentTurnChatJid = chatJid;
    this.bindActiveGlobalMcpConversation(chatJid);
    this.currentInboundSeq = turn.inboundSeq;
    this.turnHadVisibleOutput = false;
    this.turnHadSuppressedReplySatisfaction = false;
    // Arm the R1 first-line marker scan for this shared turn (flag-gated).
    this.currentTurnRouteMarkerHold = config.nlRouting ? '' : null;
    this.currentTurnReplayText = prefixedText;
    this.currentTurnReplayActorJid = senderJid;
    this.replyGuarantee?.arm({ inboundSeq: turn.inboundSeq, chatJid });

    // Thread inbound seq into the outbound queue so ops can link back
    this.getActiveQueue()?.setInboundSeq(turn.inboundSeq);

    try {
      this.updateSessionActorJid(this.session!, senderJid);
      await this.session!.sendTurn(prefixedText);
    } catch (err) {
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('STDIN_WRITE_TIMEOUT')) {
        const status = this.session?.getStatus() ?? { sessionId: null, pid: null };
        log.warn({
          chatJid,
          sessionId: status.sessionId,
          pid: status.pid,
        }, 'stdin write timed out — notifying user');
        this.sendDirect(chatJid, 'Agent is not responding — try /new to start a fresh session.');
      } else {
        throw err;
      }
    }
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
  ): Promise<void> {
    // Defense-in-depth (#1095): every inbound turn dispatched to a shared/single
    // global session MUST be pinned to its originating conversation before it
    // runs, so an injected tool call cannot target a different chat. Enforced
    // here at the single dispatch chokepoint, independent of the per-path binds.
    this.enforceGlobalConversationBinding(chatJid);
    this.updateSessionActorJid(session, actorJid);
    // F-STICKY-ACTOR (QR-247): push this turn's actor onto the per-chat executing
    // register. sendTurnToSession is the single dispatch chokepoint reached only
    // with a confirmed-live session (past sendTurnPerChat's :3534 spawn-fail drop),
    // so a pushed entry always corresponds to a turn that will run. HEAD = the turn
    // the subprocess is currently executing; shifted on that turn's result, cleared
    // on any abnormal termination (Slice-4). per_chat non-sandbox claude-cli only
    // (instance-global gate, matching the broadcast-skip: the exec-queue that feeds the
    // per-chat resolver is populated exactly when the global socket is kept fail-closed).
    if (this.usesPerChatActorSocket() && mapKey !== undefined) {
      // If the session is not active, any pre-existing entries are from a dead
      // subprocess (a prior turn whose session crashed/resume-failed without an
      // in-band clear) — drop them so a stale actor cannot survive a subprocess
      // restart. A fresh subprocess starts with only this turn. (handleResumeFailed
      // is a no-op for non-sandbox per_chat, so this is the resume-fail coverage.)
      if (!session.getStatus().active) this.perChatExecActorQueue.delete(mapKey);
      const execQ = this.perChatExecActorQueue.get(mapKey) ?? [];
      execQ.push(actorJid);
      this.perChatExecActorQueue.set(mapKey, execQ);
    }
    // Derive mapKey for sandboxPerChat coordination (used to suppress duplicate
    // context injection when handleResumeFailed is already handling recovery).
    const mapKeyForChat = this.sandboxPerChat
      ? chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey
      : undefined;
    const crashScopeKey = this.getCrashScopeKey(chatJid);
    const autoCompactWaiter = this.autoCompact.waiters.get(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
    if (autoCompactWaiter) await autoCompactWaiter.promise;

    const wasInactive = !session.getStatus().active;
    if (wasInactive) {
      // Flush any buffered output from the dying session before shutting down.
      // Without this, text in the 2-second stream debounce buffer is lost when
      // the child process is killed, because the stream parser stops emitting events.
      const queue = this.getQueueForChat(chatJid, mapKey);
      if (queue) await queue.flush();

      // Shut down old session first to prevent zombie processes.
      // Without this, spawnSession() overwrites this.child, orphaning the old
      // process and its DB row. Mirrors handleNew() pattern.
      await session.shutdown();
      await session.spawnSession();
      // Successful spawn after a crash — decay the crash counter
      this.decrementCrashCount(crashScopeKey);

      // Inject recent chat history so the agent has conversational context.
      // This runs on every fresh session spawn (not just resume failures),
      // giving the agent awareness of what's been discussed recently.
      // Skipped when handleResumeFailed manages its own context recovery to
      // avoid sending two context blocks to the same fresh session.
      const resumeFailedOwnsContext = mapKeyForChat !== undefined && this.resumeFailedHandling.has(mapKeyForChat);
      if (!resumeFailedOwnsContext) {
        try {
          const convKey = canonicalConversationKey(chatJid, this.db);
          const recent = getRecentMessages(this.db, convKey, 20);
          if (recent.length > 0) {
            const lines = this.formatContextLines(recent.reverse());
            // QR-095: mark under the SAME scope the single/shared result handler
            // consumes (GLOBAL_TOOL_SCOPE_KEY). mapKey is undefined for single/
            // shared callers (sendTurnNonShared), so mark(mapKey) would be a no-op
            // and the injected system turn's result would be mis-classified as a
            // USER turn (phantom '[Recent chat context]' reply leaks to the user +
            // wrong post-turn gate). In per_chat mapKey is defined so this is a
            // no-op there (consumed by the per_chat consumeIfPending(mapKey)).
            this.pendingSystemResults.mark(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
            await session.sendTurn(`[Recent chat context — read before responding]\n${lines}`);
          }
        } catch (err) {
          log.warn({ err, chatJid }, 'chat context injection failed — proceeding without context');
          // Context-injection send failed — no result will arrive for its mark.
          this.pendingSystemResults.unmark(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
        }
      }
    }

    // Assert typing immediately so the user sees the indicator while the agent thinks.
    // Without this, there's a visible gap between message receipt and first tool call.
    const queue = this.getQueueForChat(chatJid, mapKey);
    if (queue) queue.indicateTyping();

    try {
      await session.sendTurn(text);
    } catch (err) {
      const errMsg = (err as Error).message ?? '';
      if (errMsg.includes('STDIN_WRITE_TIMEOUT')) {
        const status = session.getStatus();
        log.warn({
          chatJid,
          sessionId: status.sessionId,
          pid: status.pid,
        }, 'stdin write timed out — notifying user');
        this.sendDirect(chatJid, 'Agent is not responding — try /new to start a fresh session.');
      } else {
        throw err;
      }
    }
  }

  /**
   * Send a turn in non-shared (legacy) mode.
   */
  private async sendTurnNonShared(chatJid: string, text: string, actorJid: string): Promise<void> {
    // Clear post-turn gate for shared session scope
    this.postTurnGate.delete(GLOBAL_TOOL_SCOPE_KEY);
    this.currentTurnChatJid = chatJid;
    this.bindActiveGlobalMcpConversation(chatJid);
    this.turnHadVisibleOutput = false;
    this.currentTurnReplayText = text;
    this.currentTurnReplayActorJid = actorJid;
    await this.sendTurnToSession(this.session!, chatJid, text, undefined, actorJid);
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
  ): Promise<void> {
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
                await queue.flush();
              } catch (err) {
                log.error({ err, chatJid: pendingPoll.chatJid }, 'failed to flush pending poll status clarification');
              }
            } else {
              this.sendDirect(
                pendingPoll.chatJid,
                'I am waiting for the poll vote itself. Tap an option in the poll, or type the option label if WhatsApp does not send the vote.',
              );
            }
            this.completeConsumedPerChatInbound(mapKey, 'poll_status_reply');
            return;
          }

          const answeredQuestionIndex = pendingPoll.currentQuestionIndex;
          pendingPoll.answersCollected[answeredQuestionIndex] = resolveTypedPollAnswer(text, currentQ);
          removePollIdsForQuestion(pendingPoll, answeredQuestionIndex);
          pendingPoll.currentQuestionIndex++;
          advancePendingPollIndex(pendingPoll);

          if (Object.keys(pendingPoll.answersCollected).length >= pendingPoll.questions.length) {
            this.injectPollAnswers(mapKey, pendingPoll, actorJid);
          } else {
            log.info({
              mapKey,
              answered: Object.keys(pendingPoll.answersCollected).length,
              total: pendingPoll.questions.length,
            }, 'free-text answer collected — waiting for more');
            this.completeConsumedPerChatInbound(mapKey, 'poll_partial_answer_collected');
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

    const session = this.chatSessions.get(mapKey);
    if (!session) {
      log.warn({ chatJid, mapKey }, 'no active session for chat — spawning new session');
      // Instead of silently dropping, initialize session and queue so message is handled
      if (this.sandboxPerChat) {
        await this.ensureSessionAndQueue(chatJid, actorJid);
      } else {
        this.ensureSessionAndQueueSync(chatJid, mapKey, actorJid);
      }
      const retrySession = this.chatSessions.get(mapKey);
      if (!retrySession) {
        log.error({ chatJid, mapKey }, 'failed to create session for chat — message dropped');
        this.pendingTurnText.delete(mapKey);
        this.pendingTurnActorJid.delete(mapKey);
        if (this.durability && this.perChatInboundSeqQueue.get(mapKey)?.[0] !== undefined) {
          const failedSeq = this.perChatInboundSeqQueue.get(mapKey)![0];
          this.markRuntimeFaultContinuityCandidate(failedSeq);
          this.replyGuarantee?.disarm(failedSeq);
          this.durability.markInboundFailed(failedSeq, 'session_spawn_failed');
        }
        this.sendDirect(chatJid, 'Something went wrong starting a session. Try sending your message again.');
        return;
      }
      await this.sendTurnToSession(retrySession, chatJid, text, mapKey, actorJid);
      return;
    }
    await this.sendTurnToSession(session, chatJid, text, mapKey, actorJid);
  }

  private updateSessionActorJid(session: SessionManager, actorJid: string | undefined): void {
    if (!actorJid) return;
    const maybeSession = session as SessionManager & { updateMcpActorJid?: (actorJid: string) => void };
    maybeSession.updateMcpActorJid?.(actorJid);
  }

  private bindActiveGlobalMcpConversation(chatJid: string): void {
    if (this.sessionScope === 'per_chat') return;
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
   * It does not touch per_chat sessions (already isolated) or the operator's
   * passive/global socket clients (which never dispatch agent turns here).
   */
  private enforceGlobalConversationBinding(chatJid: string): void {
    if (this.sessionScope === 'per_chat') return;
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
  private handleEventPerChat(mapKey: string, event: AgentEvent, toolScopeKey: string): void {
    const queue = this.chatQueues.get(mapKey);
    if (!queue) {
      log.debug({ mapKey, eventType: event.type }, 'event dropped — no queue for chat');
      return;
    }
    const session = this.chatSessions.get(mapKey) ?? null;
    // Use queue.targetChatJid — mapKey may be a workspaceKey (not a raw JID) when sandboxPerChat=true
    const conversationKey = toConversationKey(queue.targetChatJid);
    const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
    const inboundSeq = seqQueue[0]; // peek — don't shift yet
    let isSystemResult = false;
    if (event.type === 'result') {
      if (this.pendingSystemResults.consumeIfPending(mapKey)) {
        // This result belongs to a system turn (context injection, continuation) — don't consume user seq
        isSystemResult = true;
      } else {
        // Consume the seq for this completed user turn
        seqQueue.shift();
        // F-STICKY-ACTOR (QR-247): advance the executing-actor head in lockstep
        // with the seq FIFO on a completed user turn (unconditional; NOT the
        // conditional pendingTurnActorJid.delete below, and NOT completeConsumedPerChatInbound).
        this.perChatExecActorQueue.get(mapKey)?.shift();
        const fallbackReason = event.text ? fallbackReasonForResultText(event.text) : null;
        // Turn completed successfully with visible output — clear pending replay
        // text. Provider limit/auth/rate failures keep it so the fallback replay
        // can continue the interrupted request.
        // Empty-output turns (event.text null/empty) also keep it: the
        // empty-output arming path (maybeArmFallbackAfterEmptyPrimaryTurn →
        // scheduleFallbackReplay) runs inside handleEventWithContext and reads
        // pendingTurnText to dispatch the replay. Deleting here before that call
        // would cause scheduleFallbackReplay to find undefined and silently drop
        // the replay. The entry is cleaned up by sendTurnPerChat when the replay
        // turn is dispatched, or overwritten by the next sendTurnPerChat call.
        if (event.text && fallbackReason === null) {
          this.pendingTurnText.delete(mapKey);
          this.pendingTurnActorJid.delete(mapKey);
        }
      }
    }
    this.handleEventWithContext(event, queue, session, conversationKey, inboundSeq, mapKey, toolScopeKey, isSystemResult);
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

  private completeConsumedPerChatInbound(mapKey: string, terminalReason: string): void {
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

  /**
   * Restore pending polls from the persistence table on runtime start. Live
   * polls (hard_closes_at > now) are rehydrated into `pendingPolls.questions`
   * with re-armed timers using the remaining time. Expired polls
   * (hard_closes_at <= now) have a brief "decision expired during downtime"
   * message sent to the originating chat (best-effort via outbound queue) and
   * are deleted from the table.
   *
   * Persistence errors are logged and swallowed; rehydration always succeeds
   * structurally even if some rows are unreadable.
   */
  private async rehydratePendingPolls(): Promise<void> {
    const rows = this.pollPersistence.loadRows();
    if (rows.length === 0) return;

    const now = Date.now();
    let restored = 0;
    let expired = 0;
    // Accumulate expired-poll counts per chat so a long downtime that strands
    // many polls in one chat produces a single consolidated notification rather
    // than one message per stranded poll.
    const expiredByChat = new Map<string, number>();
    for (const row of rows) {
      try {
        if (row.hard_closes_at !== null && row.hard_closes_at <= now) {
          this.pollPersistence.remove(row.map_key);
          expiredByChat.set(row.chat_jid, (expiredByChat.get(row.chat_jid) ?? 0) + 1);
          expired += 1;
          continue;
        }
        const serialized = JSON.parse(row.payload) as SerializedPendingPoll;
        const pending = deserializePendingPoll(serialized);
        this.pendingPolls.questions.set(row.map_key, pending);
        this.startPendingPollExpiry(row.map_key, pending);
        restored += 1;
      } catch (err) {
        this.pollPersistence.errors += 1;
        log.error({ err, mapKey: row.map_key }, 'rehydratePendingPolls: row deserialize failed; skipping');
      }
    }
    for (const [chatJid, count] of expiredByChat) {
      this.notifyPollExpiredDuringDowntime(chatJid, count);
    }
    if (restored > 0 || expired > 0) {
      log.info({ restored, expired, chatsNotified: expiredByChat.size }, 'rehydratePendingPolls: completed');
    }
  }

  /**
   * Best-effort notification that one or more pending polls expired during
   * process downtime. The recipient sees a single consolidated line per chat;
   * the polls themselves are dropped. Failure to send (messenger not ready,
   * JID unresolvable) is logged.
   */
  private notifyPollExpiredDuringDowntime(chatJid: string, count = 1): void {
    const message = count > 1
      ? `${count} polls I was waiting on expired before I picked them back up — ask me again if you still need those decisions.`
      : 'A poll I was waiting on expired before I picked it back up — ask me again if you still need that decision.';
    try {
      void this.messenger.sendMessage(chatJid, message).catch((err) =>
        log.warn({ err, chatJid }, 'notifyPollExpiredDuringDowntime: send failed (non-fatal)'),
      );
    } catch (err) {
      log.warn({ err, chatJid }, 'notifyPollExpiredDuringDowntime: dispatch failed (non-fatal)');
    }
  }

  private startPendingPollExpiry(mapKey: string, pending: PendingPollQuestion): void {
    const timeoutMs = normalizePendingPollTimeoutMs(pending.timeoutMs);
    pending.timeoutMs = timeoutMs;
    const softMs = timeoutMs;
    const hardMs = timeoutMs * 2;

    if (pending.mode === 'poll' && !pending.softExpiryTimer) {
      pending.softExpiryTimer = setTimeout(() => {
        pending.softExpiryTimer = undefined;
        this.handlePendingPollSoftExpiry(mapKey, pending);
      }, softMs);
      pending.softExpiryTimer.unref?.();
    }
    if (!pending.hardExpiryTimer) {
      pending.hardExpiryTimer = setTimeout(() => {
        pending.hardExpiryTimer = undefined;
        this.handlePendingPollHardExpiry(mapKey, pending);
      }, hardMs);
      pending.hardExpiryTimer.unref?.();
    }
  }

  private sendUnansweredPollTextFallback(
    pending: PendingPollQuestion,
    intro: string,
  ): void {
    const unanswered = unansweredPollQuestions(pending);
    unanswered.forEach(({ question }, fallbackIndex) => {
      this.sendDirect(
        pending.chatJid,
        formatTextFallbackQuestion(
          question,
          fallbackIndex === 0 ? intro : 'Remaining decision question:',
          undefined,
          resolveOutboundAudience(pending.chatJid),
        ),
      );
    });
  }

  private settlePoll(
    mapKey: string,
    pending: PendingPollQuestion,
    reason: 'vote' | 'timeout' | 'abort' | 'expiry',
    answer: string,
  ): void {
    // Re-read and verify object identity — idempotent guard
    const current = this.pendingPolls.questions.get(mapKey);
    if (current !== pending || pending.resolvedAt !== undefined) {
      log.debug({ mapKey, reason }, 'settlePoll called but poll already settled or removed');
      return;
    }
    pending.resolvedAt = Date.now();

    // Clear timers
    if (pending.softExpiryTimer) { clearTimeout(pending.softExpiryTimer); pending.softExpiryTimer = undefined; }
    if (pending.hardExpiryTimer) { clearTimeout(pending.hardExpiryTimer); pending.hardExpiryTimer = undefined; }

    // Clear transport poll tracking using preserved sent IDs
    const connection = this.messenger as ConnectionManager;
    if (typeof connection.clearPollTracking === 'function' && pending.sentPollMessageIds) {
      for (const pollMsgId of pending.sentPollMessageIds) {
        connection.clearPollTracking(pollMsgId);
      }
    }

    // Resolve/reject BEFORE removing from map
    if (pending.source === 'send_poll') {
      if (reason === 'abort' || reason === 'expiry') {
        if (pending.awaitReject) {
          pending.awaitReject(new Error(`Poll ${reason}: ${answer}`));
        }
      } else if (pending.awaitResolve) {
        pending.awaitResolve(answer);
      }
      pending.awaitResolve = undefined;
      pending.awaitReject = undefined;
    }

    // Remove from pending map (safe — awaiters already settled)
    this.deletePendingPollQuestions(mapKey);

    // AskUser: inject answer into session (treat undefined source as 'askuser' for legacy compat)
    if (pending.source === 'askuser' || pending.source === undefined) {
      this.injectPollAnswers(mapKey, pending);
    }

    // Mark queue as no longer poll-pending
    const queue = this.getQueueForChat(pending.chatJid, mapKey);
    queue?.setPollPending(false);

    log.info({ mapKey, reason, source: pending.source }, 'poll settled');
  }

  private handlePendingPollSoftExpiry(mapKey: string, expectedPending: PendingPollQuestion): void {
    const pending = this.pendingPolls.questions.get(mapKey);
    if (!pending || pending !== expectedPending || pending.mode !== 'poll') return;

    // send_poll awaiters should settle/reject without sending AskUser fallback text
    if (pending.source === 'send_poll') {
      if (pending.resolution === 'majority-after-timeout') {
        // Tally and settle with majority result
        for (const [qIndex, votes] of pending.votesByQuestion) {
          if (pending.answersCollected[qIndex] === undefined) {
            const winner = evaluateResolutionOnTimeout(votes);
            pending.answersCollected[qIndex] = winner ?? '[No votes received — decision expired]';
          }
        }
        for (let i = 0; i < pending.questions.length; i++) {
          if (pending.answersCollected[i] === undefined) {
            pending.answersCollected[i] = '[No votes received — decision expired]';
          }
        }
        const answer = pending.questions.map((_, i) => pending.answersCollected[i]).join('\n');
        this.settlePoll(mapKey, pending, 'timeout', answer);
        return;
      }

      // admin-wins timeout fallback: if no admin voted, use majority of recorded non-admin votes
      if (pending.resolution === 'admin-wins' && pending.adminJids !== null) {
        for (const [qIndex, votes] of pending.votesByQuestion) {
          if (pending.answersCollected[qIndex] === undefined) {
            const winner = evaluateResolutionOnTimeout(votes);
            pending.answersCollected[qIndex] = winner ?? '[No admin responded — decision expired]';
          }
        }
        for (let i = 0; i < pending.questions.length; i++) {
          if (pending.answersCollected[i] === undefined) {
            pending.answersCollected[i] = '[No admin responded — decision expired]';
          }
        }
        const answer = pending.questions.map((_, i) => pending.answersCollected[i]).join('\n');
        this.settlePoll(mapKey, pending, 'timeout', answer);
        return;
      }

      this.settlePoll(mapKey, pending, 'expiry', '[Poll timed out — no qualifying vote received]');
      return;
    }

    // For AskUser majority-after-timeout, resolve with tally
    if (pending.resolution === 'majority-after-timeout') {
      for (const [qIndex, votes] of pending.votesByQuestion) {
        if (pending.answersCollected[qIndex] === undefined) {
          const winner = evaluateResolutionOnTimeout(votes);
          pending.answersCollected[qIndex] = winner ?? '[No votes received — decision expired]';
        }
      }
      for (let i = 0; i < pending.questions.length; i++) {
        if (pending.answersCollected[i] === undefined) {
          pending.answersCollected[i] = '[No votes received — decision expired]';
        }
      }
      const answer = pending.questions.map((_, i) => pending.answersCollected[i]).join('\n');
      this.settlePoll(mapKey, pending, 'timeout', answer);
      return;
    }

    // AskUser admin-wins timeout fallback: if no admin voted, use majority of recorded non-admin votes
    if (pending.resolution === 'admin-wins' && pending.adminJids !== null) {
      for (const [qIndex, votes] of pending.votesByQuestion) {
        if (pending.answersCollected[qIndex] === undefined) {
          const winner = evaluateResolutionOnTimeout(votes);
          pending.answersCollected[qIndex] = winner ?? '[No admin responded — decision expired]';
        }
      }
      for (let i = 0; i < pending.questions.length; i++) {
        if (pending.answersCollected[i] === undefined) {
          pending.answersCollected[i] = '[No admin responded — decision expired]';
        }
      }
      const answer = pending.questions.map((_, i) => pending.answersCollected[i]).join('\n');
      this.settlePoll(mapKey, pending, 'timeout', answer);
      return;
    }

    const unanswered = unansweredPollQuestions(pending);
    if (unanswered.length === 0) return;

    pending.mode = 'textFallback';
    pending.pollMessageIdToQuestionIndex.clear();
    pending.softExpiryTimer = undefined;
    advancePendingPollIndex(pending);
    this.pollPersistence.save(mapKey, pending);
    this.sendUnansweredPollTextFallback(
      pending,
      'I did not receive the poll vote. Please reply with option number or text for the remaining decision question(s):',
    );
    log.warn({ mapKey, chatJid: pending.chatJid, unanswered: unanswered.length }, 'AskUserQuestion poll soft-expired to text fallback');
  }

  private handlePendingPollHardExpiry(mapKey: string, expectedPending: PendingPollQuestion): void {
    const pending = this.pendingPolls.questions.get(mapKey);
    if (!pending || pending !== expectedPending) return;

    if (unansweredPollQuestions(pending).length > 0) {
      this.sendDirect(pending.chatJid, 'This decision has expired — please re-trigger when ready.');
    }
    log.warn({ mapKey, chatJid: pending.chatJid }, 'AskUserQuestion poll hard-expired and was cleared');
    this.deletePendingPollQuestions(mapKey);
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
   * Register a send_poll tool call as a pending poll awaiter.
   * Bridges the MCP tool layer to the runtime's poll resolution engine
   * so that `awaitResult: true` polls block until a vote resolves them.
   */
  private registerSendPollAwaiter(
    pollId: string,
    chatJid: string,
    options: string[],
    resolution: ResolutionStrategy,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const mapKey = `send_poll:${pollId}`;

      // DMs always use first-vote-wins — admin strategies require group metadata
      if (!isGroupJid(chatJid) && (resolution === 'admin-only' || resolution === 'admin-wins')) {
        log.warn({ pollId, chatJid, resolution }, 'admin poll strategy used in DM — degrading to first-vote-wins');
        resolution = 'first-vote-wins';
      }

      const pending: PendingPollQuestion = {
        questions: [{ question: 'send_poll', header: 'Poll', options: options.map(o => ({ label: o, description: '' })), multiSelect: false }],
        toolId: `send_poll:${pollId}`,
        chatJid,
        chatJidAliases: new Set([chatJid]),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([[pollId, 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt: Date.now(),
        resolution,
        timeoutMs,
        votesByQuestion: new Map(),
        adminJids: null,
        awaitResolve: resolve,
        awaitReject: reject,
        source: 'send_poll',
        sentPollMessageIds: [pollId],
      };
      this.pendingPolls.questions.set(mapKey, pending);
      this.pollPersistence.save(mapKey, pending);
      this.startPendingPollExpiry(mapKey, pending);

      // Wire AbortSignal for MCP client disconnect
      if (abortSignal) {
        const onAbort = () => {
          this.settlePoll(mapKey, pending, 'abort', 'MCP client disconnected');
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
        // Wrap resolve/reject to clean up abort listener on normal settlement
        const origResolve = pending.awaitResolve;
        const origReject = pending.awaitReject;
        if (origResolve) {
          pending.awaitResolve = (answer: string) => {
            abortSignal.removeEventListener('abort', onAbort);
            origResolve(answer);
          };
        }
        if (origReject) {
          pending.awaitReject = (err: Error) => {
            abortSignal.removeEventListener('abort', onAbort);
            origReject(err);
          };
        }
      }

      // Fetch admin JIDs if strategy requires it
      if ((resolution === 'admin-only' || resolution === 'admin-wins') && isGroupJid(chatJid)) {
        void this.fetchGroupAdminJids(chatJid).then(admins => {
          if (this.pendingPolls.questions.get(mapKey) === pending) {
            pending.adminJids = admins;
            if (admins === null) {
              // QR-036: fail CLOSED, not open. Keep the admin-only/admin-wins
              // strategy with adminJids=null so NO member vote qualifies as admin
              // (a non-admin can no longer hijack the gated decision when group
              // metadata is transiently unavailable). Liveness is bounded by the
              // existing soft-expiry timeout fallback (admin-wins → non-admin
              // majority-after-timeout, admin-only → operator text-fallback).
              log.warn({ mapKey, resolution }, 'admin metadata unavailable — keeping admin gate (fail-closed)');
            }
          }
        });
      }
    });
  }

  /**
   * Intercept an AskUserQuestion tool_use: send WhatsApp polls for each
   * question, store pending state, and register the toolId for tool_result
   * suppression.
   */
  private async handleAskUserQuestionAsPoll(
    questions: AskUserQuestion[],
    toolId: string,
    mapKey: string,
    queue: IOutboundQueue,
  ): Promise<void> {
    const chatJid = queue.targetChatJid;

    const normalizedQuestions = normalizeAskUserQuestions(questions);
    questions.forEach((question, index) => {
      const sourceOptions = question.options.map((option) => ({
        label: option.label,
        description: option.description ?? '',
      }));
      if (
        sourceOptions.length >= 12
        && !hasEscapeHatchOption(sourceOptions)
        && normalizedQuestions[index]?.options.length === sourceOptions.length
      ) {
        log.warn({ chatJid, toolId, question: question.question.slice(0, 80), optionCount: sourceOptions.length }, 'AskUserQuestion options at WhatsApp cap — default Other option not appended');
      }
    });

    const connection = this.messenger as import('../../transport/connection.ts').ConnectionManager;

    const instanceConfig = config.pollResolution;
    const isGroup = isGroupJid(chatJid);
    let resolvedStrategy: ResolutionStrategy = isGroup
      ? ((instanceConfig?.defaultStrategy as ResolutionStrategy | undefined) ?? 'first-vote-wins')
      : 'first-vote-wins';
    let adminJids: Set<string> | null = null;
    if (isGroup && (resolvedStrategy === 'admin-only' || resolvedStrategy === 'admin-wins')) {
      adminJids = await this.fetchGroupAdminJids(chatJid);
      if (adminJids === null) {
        // QR-036: fail CLOSED. Keep the admin-only/admin-wins strategy with
        // adminJids=null so no member vote qualifies as admin (no non-admin can
        // resolve the gated decision on transient metadata failure); liveness via
        // the soft-expiry timeout fallback.
        log.warn({ chatJid, resolvedStrategy }, 'admin metadata unavailable — keeping admin gate (fail-closed)');
      }
    }

    // Register ALL synchronous state BEFORE any async work — tool_result and
    // result events may arrive while we're awaiting poll send.
    this.deletePendingPollQuestions(mapKey);
    this.suppressedAskUserToolIds.add(toolId);
    const pending: PendingPollQuestion = {
      questions: normalizedQuestions,
      toolId,
      chatJid,
      chatJidAliases: new Set([chatJid]),
      mode: 'poll',
      pollMessageIdToQuestionIndex: new Map<string, number>(),
      currentQuestionIndex: 0,
      answersCollected: {},
      createdAt: Date.now(),
      resolution: resolvedStrategy,
      timeoutMs: configuredDefaultPollTimeoutMs(),
      votesByQuestion: new Map(),
      adminJids,
      sentPollMessageIds: [],
      source: 'askuser' as const,
      resolvedAt: undefined,
    };
    this.pendingPolls.questions.set(mapKey, pending);
    this.pollPersistence.save(mapKey, pending);

    const pollMessageIds: string[] = [];
    let allHaveSecret = true;
    const pollAudience = resolveOutboundAudience(chatJid);
    const formattedQuestions = normalizedQuestions.map((q, index) => ({
      index,
      question: q,
      formatted: formatPollQuestion(q, pollAudience),
    }));
    const detailFlushedQuestionIndexes = new Set<number>();

    const sendPollLoop = async (): Promise<void> => {
      for (const { index, question: q, formatted } of formattedQuestions) {
        const selectableCount = q.multiSelect ? q.options.length : 1;

        if (formatted.followUpText) {
          queue.enqueueText(formatted.followUpText);
          // Long option details should arrive before the poll so the user can read
          // context first instead of scrolling back after the tap target appears.
          try {
            await queue.flush();
            detailFlushedQuestionIndexes.add(index);
          } catch (err) {
            log.warn({ err, chatJid }, 'failed to flush poll details before poll send');
          }
          if (!this.pendingPolls.shouldContinueSend(mapKey, pending)) return;
        }

        try {
          const result = await connection.sendPollMessage(chatJid, formatted.pollName, formatted.pollValues, selectableCount);
          if (!this.pendingPolls.shouldContinueSend(mapKey, pending)) return;
          if (result.waMessageId) {
            pollMessageIds.push(result.waMessageId);
            pending.pollMessageIdToQuestionIndex.set(result.waMessageId, index);
          }
          if (!result.hasSecret) {
            allHaveSecret = false;
          }
        } catch (err) {
          if (!this.pendingPolls.shouldContinueSend(mapKey, pending)) return;
          log.error({ err, chatJid, question: q.question.slice(0, 80) }, 'failed to send poll for AskUserQuestion');
          allHaveSecret = false;
        }
      }
    };

    const pollQueue = this.getQueueForChat(chatJid, mapKey);
    if (pollQueue) {
      await pollQueue.enqueuePoll(sendPollLoop);
      pollQueue.setPollPending(true);
    } else {
      await sendPollLoop();
    }

    if (!this.pendingPolls.shouldContinueSend(mapKey, pending)) return;

    pending.sentPollMessageIds = [...pollMessageIds];

    if (pollMessageIds.length === 0 || !allHaveSecret) {
      pending.mode = 'textFallback';
      pending.pollMessageIdToQuestionIndex.clear();
      // Fall back: send as text with numbered options.
      // Text fallback already includes full descriptions — no follow-up needed.
      log.warn({ chatJid, toolId }, 'poll send failed or missing secret — falling back to text question');
      for (const { index, question: q } of formattedQuestions) {
        queue.enqueueText(formatTextFallbackQuestion(q, undefined, {
          includeDescriptions: !detailFlushedQuestionIndexes.has(index),
        }, pollAudience));
      }
    }

    this.startPendingPollExpiry(mapKey, pending);
    log.info({ chatJid, mapKey, toolId, questionCount: normalizedQuestions.length, pollCount: pollMessageIds.length }, 'AskUserQuestion intercepted → polls sent');
  }

  /**
   * Handle a poll vote received from the transport layer.
   * Matches the vote to a pending AskUserQuestion and injects the answer
   * as a sendTurn text message.
   */
  private handlePollVoteReceived(data: {
    pollMessageId: string;
    chatJid: string;
    voterJid: string;
    selectedOptions: string[];
  }): void {
    let matchedMapKey: string | null = null;
    let matchedQuestionIndex: number | undefined;
    for (const [mapKey, pending] of this.pendingPolls.questions) {
      if (!pendingPollMatchesChatJid(pending, data.chatJid) || pending.mode !== 'poll') continue;
      const index = pending.pollMessageIdToQuestionIndex.get(data.pollMessageId);
      if (index !== undefined) {
        matchedMapKey = mapKey;
        matchedQuestionIndex = index;
        break;
      }
    }

    if (matchedMapKey === null || matchedQuestionIndex === undefined) {
      log.debug({ chatJid: data.chatJid, pollMessageId: data.pollMessageId }, 'poll vote received but no matching pending poll');
      return;
    }

    const pending = this.pendingPolls.questions.get(matchedMapKey)!;
    const currentQ = pending.questions[matchedQuestionIndex];
    if (!currentQ) {
      log.warn({ mapKey: matchedMapKey, index: matchedQuestionIndex }, 'poll vote for out-of-range question index');
      pending.pollMessageIdToQuestionIndex.delete(data.pollMessageId);
      return;
    }

    if (pending.answersCollected[matchedQuestionIndex] !== undefined) {
      log.debug({ mapKey: matchedMapKey, pollMessageId: data.pollMessageId, index: matchedQuestionIndex }, 'duplicate poll vote ignored');
      return;
    }

    // Determine admin status for this voter
    const isAdmin = pending.adminJids?.has(jidNormalizedUser(data.voterJid)) ?? false;

    const vote: PollVote = {
      voterJid: data.voterJid,
      selectedOptions: data.selectedOptions,
      isAdmin,
      timestamp: Date.now(),
    };

    // Store vote per question (votesByQuestion may be absent on legacy state)
    if (!pending.votesByQuestion) pending.votesByQuestion = new Map();
    let questionVotes = pending.votesByQuestion.get(matchedQuestionIndex);
    if (!questionVotes) {
      questionVotes = new Map();
      pending.votesByQuestion.set(matchedQuestionIndex, questionVotes);
    }
    const canonicalVoter = jidNormalizedUser(data.voterJid);
    questionVotes.set(canonicalVoter, vote);

    // Evaluate resolution for this question (resolution may be absent on legacy state)
    const resolutionResult = evaluateResolution(pending.resolution ?? 'first-vote-wins', questionVotes, pending.adminJids);
    if (resolutionResult.status === 'resolved' && resolutionResult.answer !== undefined) {
      if (pending.answersCollected[matchedQuestionIndex] === undefined) {
        // Use answerForPollSelection to apply question-aware formatting (e.g. "Other" directive)
        const winningVote = questionVotes.get(canonicalVoter) ?? vote;
        pending.answersCollected[matchedQuestionIndex] = answerForPollSelection(currentQ, winningVote.selectedOptions);
        removePollIdsForQuestion(pending, matchedQuestionIndex);
        advancePendingPollIndex(pending);
      }
    }

    // Persist ballot/answer mutations so a restart during a multi-vote poll
    // doesn't lose the in-progress tally.
    this.pollPersistence.save(matchedMapKey, pending);

    // Check if all questions resolved
    const answered = Object.keys(pending.answersCollected).length;
    if (answered >= pending.questions.length) {
      const fullAnswer = pending.questions.map((_, i) => pending.answersCollected[i] ?? '(no answer)').join('\n');
      this.settlePoll(matchedMapKey, pending, 'vote', fullAnswer);
    } else {
      log.info({ mapKey: matchedMapKey, answered, total: pending.questions.length }, 'poll vote collected — waiting for more');
    }
  }

  private handlePollVoteFailed(data: {
    pollMessageId: string;
    chatJid: string;
    reason: string;
  }): void {
    let matchedMapKey: string | null = null;
    for (const [mapKey, pending] of this.pendingPolls.questions) {
      if (!pendingPollMatchesChatJid(pending, data.chatJid) || pending.mode !== 'poll') continue;
      if (pending.pollMessageIdToQuestionIndex.has(data.pollMessageId)) {
        matchedMapKey = mapKey;
        break;
      }
    }

    if (matchedMapKey === null) {
      log.debug({ chatJid: data.chatJid, pollMessageId: data.pollMessageId, reason: data.reason }, 'poll vote failure received but no matching pending poll');
      return;
    }

    const pending = this.pendingPolls.questions.get(matchedMapKey);
    if (!pending || pending.mode !== 'poll') return;

    if (pending.source === 'send_poll') {
      this.settlePoll(matchedMapKey, pending, 'expiry', '[Poll vote decryption failed]');
      return;
    }

    pending.mode = 'textFallback';
    pending.pollMessageIdToQuestionIndex.clear();
    if (pending.softExpiryTimer) {
      clearTimeout(pending.softExpiryTimer);
      pending.softExpiryTimer = undefined;
    }
    advancePendingPollIndex(pending);
    this.sendUnansweredPollTextFallback(
      pending,
      "I couldn't read your poll vote. Please type your choice for the remaining decision question(s):",
    );
    log.warn({ mapKey: matchedMapKey, chatJid: pending.chatJid, pollMessageId: data.pollMessageId, reason: data.reason }, 'poll vote failure switched AskUserQuestion to text fallback');
  }

  /**
   * Inject collected poll answers back into the session as a user turn.
   * Routes through the runtime's normal turn path (sendTurnPerChat / shared
   * sendTurn) so pendingTurnText, post-turn-gate, and durability state stay
   * consistent.
   */
  private injectPollAnswers(
    mapKey: string,
    pending: PendingPollQuestion,
    answererActorJid?: string,
  ): void {
    // Format the answer as structured context for Claude.
    const lines = ['[User answered poll]'];
    pending.questions.forEach((q, index) => {
      const a = pending.answersCollected[index] ?? '(no answer)';
      lines.push(`Q: ${q.question}`);
      if (a.includes('\n')) {
        lines.push('A:');
        lines.push(a);
      } else {
        lines.push(`A: ${a}`);
      }
      lines.push('');
    });
    const answerText = lines.join('\n').trim();

    // Clear pending state BEFORE sending the turn — sendTurnPerChat checks
    // pendingPolls.questions and would re-intercept as another answer.
    this.deletePendingPollQuestions(mapKey);

    // Route through sendTurnPerChat for proper lifecycle handling.
    // Poll bridge is per_chat only — shared mode guard in handleEvent prevents
    // pendingPolls.questions from being populated in shared mode.
    void this.sendTurnPerChat(pending.chatJid, answerText, mapKey, answererActorJid).catch((err) => {
      log.error({ err, mapKey, chatJid: pending.chatJid }, 'failed to inject poll answer via sendTurnPerChat');
    });

    log.info({ mapKey, chatJid: pending.chatJid, questionCount: pending.questions.length }, 'poll answers injected');
  }

  /**
   * Core event handler that operates on explicitly-passed queue and session
   * references rather than shared instance fields. Used by handleEventPerChat
   * so concurrent per_chat events do not overwrite each other's context.
   */
  private handleEventWithContext(event: AgentEvent, queue: IOutboundQueue, session: SessionManager | null, conversationKey?: string, inboundSeq?: number, mapKey?: string, toolScopeKey: string = mapKey ?? GLOBAL_TOOL_SCOPE_KEY, isSystemResult: boolean = false): void {
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
          log.info({ mapKey, textPreview: event.text.slice(0, 200) }, 'post-turn gate: suppressed phantom assistant_text');
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
          if (this.suppressStreamedProviderFailure(normalizedText, queue.targetChatJid)) break;
          normalizedText = this.gateAssistantTextForOutbound(normalizedText, queue, inboundSeq, mapKey);
          if (!normalizedText) break;
          queue.enqueueStreamingText(normalizedText);
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

        // AskUserQuestion → WhatsApp poll bridge (per_chat mode).
        // Shared mode is excluded — see handleEvent tool_use case for rationale.
        if (event.toolName === 'AskUserQuestion' && mapKey !== undefined) {
          const questions = (event.toolInput as any)?.questions;
          if (Array.isArray(questions) && questions.length > 0) {
            // Suppression state (suppressedAskUserToolIds) is registered synchronously
            // inside handleAskUserQuestionAsPoll before any async work, so tool_result
            // suppression is guaranteed even though we fire-and-forget the async poll send.
            void this.handleAskUserQuestionAsPoll(questions, event.toolId, mapKey, queue);
            break; // skip normal tool_use handling — poll sent instead
          }
        }

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
        if (event.isError) {
          const toolName = toolNames?.get(event.toolId) ?? 'unknown';
          const errorPreview = event.content.length > 200 ? event.content.slice(0, 200) + '...' : event.content;
          log.warn({ toolId: event.toolId, toolName, error: errorPreview }, 'tool error reported by agent');
          const classification = classifyToolError(toolName, event.content);
          queue.enqueueToolUpdate(classification);
          this.maybeEmitToolFailureAlert({
            chatJid: queue.targetChatJid,
            toolId: event.toolId,
            toolName,
            content: event.content,
            classification,
            toolScopeKey,
            mapKey,
          });
        }
        toolNames?.delete(event.toolId);
        if (toolNames && toolNames.size === 0) {
          this.activeToolNames.delete(toolScopeKey);
        }
        break;

      case 'result': {
        const wasSilentCompact = this.isSilentCompact(mapKey);
        // R1: flush any held first-line marker buffer for this chat at turn
        // end — a marker-only / no-newline reply registers its intent here and
        // delivers whatever remains. No-op when nothing was held.
        if (config.nlRouting) {
          const markerScanKey = mapKey ?? GLOBAL_TOOL_SCOPE_KEY;
          const heldMarker = this.perChatRouteMarkerHold.get(markerScanKey);
          if (heldMarker !== undefined) {
            this.perChatRouteMarkerHold.delete(markerScanKey);
            const flushActorJid = mapKey !== undefined ? this.pendingTurnActorJid.get(mapKey) : this.currentTurnReplayActorJid;
            const tail = this.flushRouteMarker(heldMarker, queue.targetChatJid, flushActorJid);
            if (tail) {
              queue.enqueueStreamingText(tail);
              if (mapKey !== undefined) this.perChatTurnText.set(mapKey, (this.perChatTurnText.get(mapKey) ?? '') + tail);
            }
          }
        }
        const compactScopeKey = mapKey ?? GLOBAL_TOOL_SCOPE_KEY;
        const hadCompactBoundary = this.consumeCompactBoundary(compactScopeKey);
        session?.clearTurnWatchdog();
        tracker?.onTurnComplete();
        // Turn-end choke point: clear the typing indicator unconditionally so no
        // early-break branch below can leave 'composing' asserted into the idle
        // persistent session. Idempotent with the normal-path queue.flush().
        queue.endTurn();
        // Provider-reported turn cost: log it beside the token counts and
        // accumulate it while a fallback window is active.
        this.recordTurnCostUsd(event);
        // Capture before clearToolNames so the empty-turn check can read it.
        const turnHadToolWork = this.turnHadToolActivity.has(toolScopeKey);
        this.turnHadToolActivity.delete(toolScopeKey);
        this.clearToolNames(toolScopeKey);
        // Activate post-turn gate — suppress any SDK-injected events until next user turn
        const hasPendingPoll = mapKey !== undefined && this.pendingPolls.questions.has(mapKey);
        if (mapKey !== undefined) {
          if (hasPendingPoll) {
            // Do NOT gate — the turn is logically still open (waiting for poll vote).
            // Allow the poll vote handler to send the next turn.
            this.postTurnGate.delete(mapKey);
          } else if (!isSystemResult) {
            // Only genuine user-turn completions arm the gate. System-turn results
            // (context injection on respawn, resume continuation, auto-compact
            // /compact) are followed by — or resume — a real user turn whose
            // assistant_text/tool_use must NOT be suppressed as phantom. Arming
            // the gate on those silently dropped real replies (incl. send_message
            // / send_poll), so leave the gate state unchanged for system results.
            this.postTurnGate.add(mapKey);
          }
        }
        const isUserTurnResult = !isSystemResult && !hasPendingPoll && !wasSilentCompact;
        let turnCapabilityFailureRecorded = false;
        const recordTurnFailure = (errorClass: TurnCapabilityErrorClass): void => {
          this.recordTurnCapabilityFailure(isUserTurnResult, errorClass);
          turnCapabilityFailureRecorded = turnCapabilityFailureRecorded || isUserTurnResult;
        };

        if (event.text && !hasPendingPoll) {
          if (this.enqueueAutoSwitchNotice(queue, event.text, queue.targetChatJid, 'result')) break;
          if (responseRegistryDispatchEnabled() && this.dispatchProviderFailureResult({
            queue,
            session,
            providerText: event.text,
            turnHadToolWork,
            logChatJid: queue.targetChatJid,
            scheduleReplayMapKey: mapKey,
            cleanupArgs: { inboundSeq, conversationKey, mapKey },
            recordTurnFailure,
          })) {
            break;
          }
          const providerFailureKind = classifyProviderFailure(event.text);
          // Suppress usage-limit messages — log and skip instead of forwarding
          if (providerFailureKind === 'usage-limit') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed usage-limit message from result — session will be killed');
            // Route the auto-respawned next session to the fallback provider
            // (if configured) until the limit resets, before tearing down.
            const activation = this.activateProviderFallbackAfterTerminalResult(
              extractUsageLimitResetTime(event.text),
              'usage-limit',
              session,
              event.text,
            );
            const replayScheduled = activation
              ? this.scheduleFallbackReplay({
                  activation,
                  chatJid: queue.targetChatJid,
                  mapKey,
                  oldSession: session,
                  hadToolActivity: turnHadToolWork,
                })
              : false;
            if (activation) {
              this.notifyProviderFallbackActivated(queue, activation, {
                replayScheduled,
                blockedByToolActivity: turnHadToolWork,
              });
            }
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq,
              conversationKey,
              mapKey,
            });
            if (!replayScheduled) {
              if (!activation) queue.enqueueText(this.usageLimitNotice());
              session?.shutdown();
            }
            break;
          }
          if (providerFailureKind === 'policy-block') {
            recordTurnFailure(providerFailureKind);
            log.error({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider policy-block message from result — session will be killed');
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq,
              conversationKey,
              mapKey,
            });
            session?.shutdown();
            break;
          }
          if (providerFailureKind === 'auth-required') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider auth-required message from result — session will be shut down');
            const activation = this.activateProviderFallbackAfterTerminalResult(
              null,
              'auth-required',
              session,
              event.text,
            );
            const replayScheduled = activation
              ? this.scheduleFallbackReplay({
                  activation,
                  chatJid: queue.targetChatJid,
                  mapKey,
                  oldSession: session,
                  hadToolActivity: turnHadToolWork,
                })
              : false;
            if (activation) {
              this.notifyProviderFallbackActivated(queue, activation, {
                replayScheduled,
                blockedByToolActivity: turnHadToolWork,
              });
            }
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq,
              conversationKey,
              mapKey,
            });
            if (!replayScheduled) {
              // QR-211: no fallback took over — without this, the turn ends in
              // permanent silence (session shuts down, nothing forwarded to chat).
              if (!activation) this.emitNoFallbackReauthNotice(queue);
              session?.shutdown();
            }
            break;
          }
          if (providerFailureKind === 'rate-limit' || providerFailureKind === 'server-error') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, armingFailureLogMessage(providerFailureKind));
            const activation = this.activateProviderFallbackAfterTerminalResult(
              null,
              providerFailureKind,
              session,
              event.text,
            );
            const replayScheduled = activation
              ? this.scheduleFallbackReplay({
                  activation,
                  chatJid: queue.targetChatJid,
                  mapKey,
                  oldSession: session,
                  hadToolActivity: turnHadToolWork,
                })
              : false;
            if (activation) {
              this.notifyProviderFallbackActivated(queue, activation, {
                replayScheduled,
                blockedByToolActivity: turnHadToolWork,
              });
            }
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq,
              conversationKey,
              mapKey,
            });
            if (!replayScheduled) {
              if (!activation && providerFailureKind === 'server-error') queue.enqueueText(providerUnknownTerminalNotice());
              session?.shutdown();
            }
            break;
          }
          if (providerFailureKind === 'model-unavailable') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider model-unavailable message from result — session will be shut down');
            const activation = this.activateProviderFallback(null, 'model-unavailable');
            const replayScheduled = activation
              ? this.scheduleFallbackReplay({
                  activation,
                  chatJid: queue.targetChatJid,
                  mapKey,
                  oldSession: session,
                  hadToolActivity: turnHadToolWork,
                })
              : false;
            if (activation) {
              this.notifyProviderFallbackActivated(queue, activation, {
                replayScheduled,
                blockedByToolActivity: turnHadToolWork,
              });
            }
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq,
              conversationKey,
              mapKey,
            });
            if (!replayScheduled) session?.shutdown();
            break;
          }
          // Context overflow — session is unsalvageable, kill and let next message respawn
          if (providerFailureKind === 'context-overflow') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'prompt too long — killing session');
            queue.enqueueText(contextOverflowNotice());
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq,
              conversationKey,
              mapKey,
            });
            session?.shutdown();
            break;
          }
          // Transient streaming-socket drop — recoverable, next message respawns the session.
          // Suppress raw provider text; emit a generic notice and a WARNING (not CRITICAL) alert.
          if (providerFailureKind === 'transient-network') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'transient provider connection drop — session will recover on next message');
            emitAlertChecked(
              this.instanceName,
              'provider_transient_network',
              'Transient provider connection drop (recoverable)',
              event.text.slice(0, 400),
              'warning',
            );
            queue.enqueueText(providerUnknownTerminalNotice());
            break;
          }
          if (!wasSilentCompact) {
            if (event.isError) {
              recordTurnFailure('unknown-terminal');
              // Default-deny: an is_error result with no recognised failure class is an
              // UNKNOWN terminal provider error. Never forward raw provider/CLI text to the
              // user — emit one generic notice and alert ops with the raw text.
              log.error({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed unclassified terminal provider error from result — not forwarded to user');
              emitAlertChecked(
                this.instanceName,
                'provider_unknown_terminal',
                'Unclassified terminal provider error suppressed from user',
                event.text.slice(0, 400),
              );
              queue.enqueueText(providerUnknownTerminalNotice());
            } else {
              queue.enqueueResultText(this.withHandoffPrefix(queue.targetChatJid, event.text));
              // Accumulate result text for voice reply (SP4)
              if (mapKey !== undefined) {
                this.perChatTurnText.set(mapKey, (this.perChatTurnText.get(mapKey) ?? '') + event.text);
              }
            }
          }
        }
        if (mapKey !== undefined) {
          this.perChatAssistantItemText.delete(mapKey);
        }
        this.workspaceSweeper.touch(mapKey);
        const rowId = session?.getDbRowId() ?? null;
        const lastOpId = queue.getLastOpId();
        if (this.durability) {
          this.durability.completeTurn({
            ...((event.inputTokens !== undefined || event.outputTokens !== undefined) && rowId !== null
              ? {
                  sessionTokens: {
                    dbRowId: rowId,
                    inputTokens: event.inputTokens ?? 0,
                    outputTokens: event.outputTokens ?? 0,
                  },
                }
              : {}),
            ...(conversationKey
              ? {
                  checkpoint: {
                    conversationKey,
                    fields: {
                      activeTurnId: null,
                      ...(inboundSeq !== undefined && { lastInboundSeq: inboundSeq }),
                      ...(lastOpId !== undefined && { lastFlushedOutboundId: lastOpId }),
                    },
                  },
                }
              : {}),
            // Only a genuine user-turn result terminates the user's inbound seq
            // and disarms its reply guarantee. A system-turn result (context
            // injection on respawn, resume continuation, /compact) carries the
            // *peeked* user seq but must NOT mark it response_sent or disarm —
            // otherwise a crash before the real turn replies drops the reply
            // with no replay (a150f7e8 stopped the seq-queue shift but not this).
            ...(inboundSeq !== undefined && !isSystemResult
              ? {
                  inbound: {
                    seq: inboundSeq,
                    terminalReason: 'response_sent',
                  },
                }
              : {}),
            ...(lastOpId !== undefined ? { lastOpId } : {}),
          });
          if (!isSystemResult) this.replyGuarantee?.disarm(inboundSeq);
          if (lastOpId !== undefined) {
            queue.markLastTerminal({
              dedupeText: event.isError === true && !wasSilentCompact,
              skipDurabilityMark: true,
            });
          }
        } else {
          if ((event.inputTokens !== undefined || event.outputTokens !== undefined) && rowId !== null) {
            accumulateTokensWithEvent(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
          }
          // Defense-in-depth: mark last op terminal so echo auto-complete fires if
          // the process crashes after send but before completeInbound runs.
          queue.markLastTerminal({ dedupeText: event.isError === true && !wasSilentCompact });
        }
        // Only advance the compact baseline when the SDK actually emitted a
        // compact_boundary on this turn. wasSilentCompact alone means "we
        // suppressed user-facing chrome for an auto-trigger"; it does not
        // prove the /compact succeeded. A failed compact must not reset the
        // baseline, otherwise auto-compact silently disables itself for
        // another full threshold's worth of tokens. The waiter still
        // unblocks in either case so the next user turn is not stuck behind
        // a failed compact.
        if (!wasSilentCompact && !hadCompactBoundary && !isSystemResult && mapKey !== undefined) {
          this.recordAutoCompactNextTurnIfNeeded(mapKey, event.inputTokens);
        }
        if (hadCompactBoundary && rowId !== null) {
          markSessionCompacted(this.db, rowId);
          this.recordAutoCompactSuccess(compactScopeKey);
        }
        if (wasSilentCompact || hadCompactBoundary) {
          this.finishAutoCompact(compactScopeKey);
        } else {
          this.maybeStartAutoCompact(session, mapKey);
        }
        {
          // Capture voice reply context before flush (SP4)
          const chatJidForVoice = queue.targetChatJid;
          const inboundContentType = mapKey !== undefined ? (this.perChatTurnContentType.get(mapKey) ?? null) : null;
          const responseText = !wasSilentCompact && mapKey !== undefined ? (this.perChatTurnText.get(mapKey) ?? '') : '';
          const hadSuppressedReplySatisfaction = mapKey !== undefined
            ? this.perChatTurnSuppressedReplySatisfaction.delete(mapKey)
            : false;
          // Clean up per-chat voice state
          if (mapKey !== undefined) {
            this.perChatTurnContentType.delete(mapKey);
            this.perChatTurnText.delete(mapKey);
          }
          if (!isSystemResult && !hasPendingPoll && !wasSilentCompact) {
            const hadVisible =
              responseText.trim() !== '' ||
              (typeof event.text === 'string' && event.text.trim() !== '');
            // A fallback turn whose entire reply was MCP tool sends (e.g.
            // send_message, send_media) is NOT silent — the user received the
            // result through the outbound channel. Only fire the notice and
            // increment the empty counter when neither text nor tool work occurred.
            // turnHadToolWork was captured before clearToolNames above.
            this.recordFallbackTurnOutcome(
              queue,
              hadVisible || hadSuppressedReplySatisfaction,
              turnHadToolWork,
              session,
            );
            // Empty/tool-only turn: surface any still-pending handoff notice
            // standalone rather than deferring it to the next reply.
            this.flushPendingHandoffNotice(queue);
            let armedFallbackNow = false;
            if (!turnCapabilityFailureRecorded) {
              if (hadVisible || turnHadToolWork || hadSuppressedReplySatisfaction) {
                this.recordTurnCapabilitySuccess(true);
              } else {
                this.recordTurnCapabilityFailure(true, 'empty-output');
                // QR-226: the turnErrorCounts increment above is in-memory only —
                // without a log line, journal greps are blind to empty-output
                // turns (an on-call canary once needed manual timestamp
                // correlation to decode this from raw counters alone).
                log.warn(
                  { reason: 'empty-output', chatJid: queue.targetChatJid, mapKey, rowId, turnHadToolWork },
                  'recorded empty-output turn failure',
                );
                armedFallbackNow = this.maybeArmFallbackAfterEmptyPrimaryTurn(queue, session, turnHadToolWork, mapKey);
              }
            }
            if (
              !hadVisible &&
              !turnHadToolWork &&
              !hadSuppressedReplySatisfaction &&
              this.isFallbackWindowActive &&
              !armedFallbackNow
            ) {
              // This path has no '_(no response)_' fallback and the reply guarantee
              // was just disarmed — without this the user gets pure silence.
              // Suppressed when we JUST armed the provider fallback above: the
              // activation notice already told the user and the turn is being
              // replayed on the backup, so this would be a contradictory message.
              queue.enqueueText('_The backup model returned no reply — please resend or rephrase your message._');
            }
          }
          queue.flush()
            .then(() => {
              // Send voice reply after text is delivered (non-fatal, SP4)
              if (
                chatJidForVoice &&
                responseText &&
                config.voiceReply !== 'never' &&
                (config.voiceReply === 'always' || inboundContentType === 'audio')
              ) {
                return this._sendVoiceReply(chatJidForVoice, responseText);
              }
            })
            .catch((err) => log.error({ err }, 'flush or voice reply failed'));
        }
        if (wasSilentCompact) this.clearSilentCompact(mapKey);
        break;
      }

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
            accumulateTokensWithEvent(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
          }
        }
        break;

      case 'ignored':
      case 'unknown':
      case 'parse_error':
        log.debug({ event }, 'ignored/unknown/parse_error event');
        break;
    }
  }

  /** Pop and return the pending startup notification (set during resume), or null. */
  popStartupMessage(): { chatJid: string; text: string } | null {
    const msg = this.pendingStartupMessage;
    this.pendingStartupMessage = null;
    return msg;
  }

  getHealthSnapshot(): RuntimeHealth {
    const fallbackState = this.getFallbackState();
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
      let healthStatus: RuntimeHealth['status'] = 'healthy';
      // For per_chat: idle sessions (all inactive) are normal — not degraded.
      // Only degrade if we have sessions that SHOULD be active but aren't
      // (indicated by recent crashes, not by inactivity).
      // Crash counter survives session map deletions — if sessions have been crashing
      // recently but were cleaned up before this health check, recentCrashCount captures it.
      const recentCrashCount = this.getRecentCrashCount();
      if (recentCrashCount > 0 && healthStatus === 'healthy') {
        healthStatus = 'degraded';
      }
      if (fallbackState.fallbackActiveUntil !== null && healthStatus === 'healthy') {
        healthStatus = 'degraded';
      }
      return {
        status: healthStatus,
        details: {
          activeSessions,
          lastSessionStatus,
          lastSessionStartedAt,
          sessionCount: sessions.length,
          recentCrashes: recentCrashCount,
          lastCrashAt: this.crashes.lastCrashAt,
          pollPersistenceErrors: this.pollPersistence.errors,
          autoCompactIneffective: this.autoCompact.ineffective,
          autoCompactConsecutiveRapidRearmsMax: this.autoCompact.consecutiveRapidRearmsMax,
          autoCompactNextTurnOverThreshold: this.autoCompact.nextTurnOverThreshold,
          ...fallbackState,
        },
      };
    }

    const status = this.session?.getStatus();
    // If a session exists but its child process is not active, it has crashed
    const healthStatus: RuntimeHealth['status'] =
      this.session !== null && status?.active === false
        ? 'degraded'
        : fallbackState.fallbackActiveUntil !== null
          ? 'degraded'
          : 'healthy';
    return {
      status: healthStatus,
      details: {
        active: status?.active ?? false,
        pid: status?.pid ?? null,
        sessionId: status?.sessionId ?? null,
        pollPersistenceErrors: this.pollPersistence.errors,
        autoCompactIneffective: this.autoCompact.ineffective,
        autoCompactConsecutiveRapidRearmsMax: this.autoCompact.consecutiveRapidRearmsMax,
        autoCompactNextTurnOverThreshold: this.autoCompact.nextTurnOverThreshold,
        ...fallbackState,
      },
    };
  }

  /**
   * Inject a repair turn into the control session for self-healing.
   * Single-flight: if a repair is already in-flight the call returns immediately;
   * the caller (heal.ts) is responsible for queuing subsequent reports.
   */
  async handleControlTurn(reportId: string, payload: string): Promise<void> {
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
        this.controlSession = this.createSessionManager({
          chatJid: syntheticJid,
          cwd: controlCwd,
          onEvent: (event) => this.handleEventPerChat('control@heal.internal', event, toolScopeKey),
          onCrash: (info) => {
            log.warn({
              exitCode: info.exitCode,
              signal: info.signal,
              sessionId: info.sessionId,
              reportId: this.activeControlReportId ?? reportId,
            }, 'control session crashed');
            if (this.controlSessionTimeout) {
              clearTimeout(this.controlSessionTimeout);
              this.controlSessionTimeout = null;
            }
            this.activeControlReportId = null;
          },
          notifyUser: () => {},
          onResumeFailed: () => {},
        });

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
          const adminJid = toPersonalJid(adminPhone);
          sendTracked(this.messenger, adminJid,
            `[HEAL_ESCALATE] Repair for report ${reportId} timed out after 15 minutes.`,
            this.durability ?? undefined, { replayPolicy: 'safe' })
            .catch(err => log.error({ err }, 'failed to DM admin on timeout'));
        }

        if (this.controlSession) {
          void this.controlSession.shutdown().catch(() => {});
        }
        this.clearControlReport();

        // Dequeue next report if any
        const next = dequeueNextReport(this.db);
        if (next) {
          const context = parseHealContext(next.context);
          void this.handleControlTurn(next.report_id, JSON.stringify({
            ...context,
            reportId: next.report_id,
            errorClass: next.error_class,
          })).catch(err => {
            log.error({ err, reportId: next.report_id }, 'unhandled error in handleControlTurn');
          });
        }
      }, CONTROL_SESSION_TIMEOUT_MS);
    } catch (err) {
      log.error({ err, reportId }, 'control session failed to start — releasing slot');
      if (this.controlSessionTimeout) {
        clearTimeout(this.controlSessionTimeout);
        this.controlSessionTimeout = null;
      }

      this.activeControlReportId = null;
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

  async handleAgentCommand(request: AgentCommandRequest): Promise<AgentCommandResult> {
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
      this.pendingSystemResults.mark(mapKey);
      try {
        await session.sendTurn('/compact');
      } catch (err) {
        if (silent) this.clearSilentCompact(mapKey);
        // No result will arrive for a failed send.
        this.pendingSystemResults.unmark(mapKey);
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
    this.pendingSystemResults.mark(GLOBAL_TOOL_SCOPE_KEY);
    try {
      await session.sendTurn('/compact');
    } catch (err) {
      if (silent) this.clearSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
      this.currentTurnChatJid = null;
      // No result will arrive for a failed send.
      this.pendingSystemResults.unmark(GLOBAL_TOOL_SCOPE_KEY);
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
  }

  async shutdown(): Promise<void> {
    log.info({
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
    }, 'AgentRuntime shutting down');
    const startedAt = Date.now();

    if (this.controlSessionTimeout) {
      clearTimeout(this.controlSessionTimeout);
      this.controlSessionTimeout = null;
    }

    if (this.healthStatsTimer) {
      clearInterval(this.healthStatsTimer);
      this.healthStatsTimer = null;
    }
    this.workspaceSweeper.stop();
    if (this.queueSweepTimer) {
      clearInterval(this.queueSweepTimer);
      this.queueSweepTimer = null;
    }
    if (this.sessionSweepTimer) {
      clearInterval(this.sessionSweepTimer);
      this.sessionSweepTimer = null;
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
    this.replyGuarantee?.shutdown();
    this.replyGuarantee = null;

    // Shutdown per_chat sessions
    if (this.sessionScope === 'per_chat') {
      const perChatKeys = new Set<string>([
        ...this.chatSessions.keys(),
        ...this.chatQueues.keys(),
        ...this.imageCoalesce.buffers.keys(),
      ]);
      for (const [chatJid, session] of this.chatSessions) {
        try { await session.shutdown(); } catch (err) { log.warn({ err, chatJid }, 'per_chat session shutdown failed'); }
      }
      for (const [chatJid, queue] of this.chatQueues) {
        try { await queue.shutdown(); } catch (err) { log.warn({ err, chatJid }, 'per_chat queue shutdown failed'); }
      }
      this.chatSessions.clear();
      this.chatQueues.clear();
      for (const mapKey of perChatKeys) {
        this.cleanupPerChatState(mapKey);
      }
    }

    if (this.session && this.sessionScope !== 'per_chat') {
      try {
        await this.session.shutdown();
      } catch (err) {
        log.warn({ err, instanceName: this.instanceName }, 'session shutdown failed');
      }
    }

    if (this.shared) {
      // Shutdown all per-chat outbound queues
      for (const [chatJid, queue] of this.outboundQueues) {
        try {
          await queue.shutdown();
        } catch (err) {
          log.warn({ err, chatJid }, 'queue shutdown failed — pending messages may be lost');
        }
      }
      this.outboundQueues.clear();
    } else {
      if (this.queue) {
        try {
          await this.queue.shutdown();
        } catch (err) {
          log.warn({ err }, 'queue shutdown failed — pending messages may be lost');
        }
      }
      this.queue = null;
    }

    this.session = null;
    this.activeChatJid = null;
    this.currentTurnChatJid = null;
    this.singletonProviderToolSession = null;

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

    for (const mapKey of [...this.imageCoalesce.buffers.keys()]) {
      this.abortImageCoalesceBuffer(mapKey, 'cleanup_aborted');
    }

    this.outboundQueues.clear();
    this.chatSessions.clear();
    this.chatQueues.clear();
    this.crashes.clear();
    this.activeToolNames.clear();
    this.turnHadToolActivity.clear();
    this.perChatInboundSeqQueue.clear();
    this.pendingSystemResults.counts.clear();
    this.currentTurnInboundContentType = null;
    this.currentTurnAssistantText = '';
    this.currentTurnAssistantItemText.clear();
    this.perChatTurnContentType.clear();
    this.perChatTurnText.clear();
    this.perChatTurnSuppressedReplySatisfaction.clear();
    this.perChatAssistantItemText.clear();
    this.pendingTurnText.clear();
    this.pendingTurnActorJid.clear();
    this.currentTurnReplayText = null;
    this.currentTurnReplayActorJid = undefined;
    this.resumeFailedHandling.clear();
    this.imageCoalesce.buffers.clear();

    log.info({
      instanceName: this.instanceName,
      sessionScope: this.sessionScope,
      shared: this.shared,
      sandboxPerChat: this.sandboxPerChat,
      durationMs: Date.now() - startedAt,
    }, 'AgentRuntime shut down');
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

  private resolvePerChatMapKey(chatJid: string): string {
    if (this.sandboxPerChat) {
      return chatJidToWorkspace(this.cwd ?? homedir(), chatJid).workspaceKey;
    }
    return canonicalizeChatJid(chatJid, this.db);
  }

  /**
   * F-STICKY-ACTOR (QR-245): resolve the actor for a per-chat socket tool call
   * at read time = the actor of the turn the subprocess is CURRENTLY executing
   * (queue HEAD). Fail-closed: no live active session or empty queue -> undefined,
   * which the sensitive-tool gate denies. Non-blocking (sync map/status reads).
   * Re-derives mapKey each call so it is transparent to LID rekey.
   */
  private resolveExecutingActor(chatJid: string): string | undefined {
    const mapKey = this.resolvePerChatMapKey(chatJid);
    const session = this.chatSessions.get(mapKey);
    if (!session || !session.getStatus().active) return undefined;
    return this.perChatExecActorQueue.get(mapKey)?.[0];
  }

  /** F-STICKY-ACTOR (QR-247): per-chat socket path under <cwd>/.claude, sha1-shortened if it would exceed the unix sun_path limit. */
  private derivePerChatSocketPath(chatJid: string): string {
    const dir = join(this.cwd ?? homedir(), '.claude');
    const key = toConversationKey(chatJid);
    const full = join(dir, `whatsoup-${key}.sock`);
    if (Buffer.byteLength(full, 'utf8') <= 100) return full;
    const h = createHash('sha1').update(key).digest('hex').slice(0, 16);
    return join(dir, `whatsoup-${h}.sock`);
  }

  /** F-STICKY-ACTOR (QR-247): true only for the mode the fix covers — claude-cli, per_chat, non-sandbox. Gates the global-broadcast SKIP (keep the shared global socket actor-less = fail-closed) and the exec-queue push. Instance-global by design: the global socket's fail-closed property must not depend on per-chat socket timing. */
  private usesPerChatActorSocket(): boolean {
    return this.sessionScope === 'per_chat' && !this.sandboxPerChat && this.effectiveProvider === 'claude-cli';
  }

  /**
   * F-STICKY-ACTOR (QR-247): create this chat's own MCP socket (tier:'global',
   * bound to resolveExecutingActor) and write its per-session --mcp-config so the
   * subprocess talks to it instead of the shared global socket. Returns the socket
   * + cfg paths for the provider override. Torn down in cleanupPerChatState.
   */
  private createPerChatActorSocket(mapKey: string, chatJid: string): { socketPath: string; cfgPath: string } {
    const socketPath = this.derivePerChatSocketPath(chatJid);
    // Ensure <cwd>/.claude exists (mirrors the global-socket setup at startup). In
    // production the dir already exists; wiring now runs from more spawn paths
    // (resume / provider-fallback), so make socket creation self-sufficient.
    mkdirSync(join(this.cwd ?? homedir(), '.claude'), { recursive: true, mode: 0o700 });
    const cfgPath = socketPath.replace(/\.sock$/, '.mcp.json');
    const proxyScriptPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/mcp/whatsoup-proxy.ts');
    writeMcpConfigToPath('claude-cli', cfgPath, socketPath, proxyScriptPath);
    const socketServer = new WhatSoupSocketServer(
      socketPath,
      this.registry,
      { tier: 'global', allowedRoot: this.cwd ?? homedir() },
      () => this.resolveExecutingActor(chatJid),
    );
    socketServer.start();
    this.perChatSocketResources.set(mapKey, { socketServer, socketPath, cfgPath });
    return { socketPath, cfgPath };
  }

  /**
   * F-STICKY-ACTOR (QR-247 hardening): the single seam that binds a per-chat
   * session to its own actor socket, keyed on the ACTUAL session provider
   * (route?.provider ?? effectiveProvider) — NOT the instance-global provider.
   * Called from createSessionManager so the ensure / proactive-resume / provider-
   * fallback spawn paths all bind identically. claude-cli non-sandbox per_chat ->
   * create-or-reuse the socket and return the strict --mcp-config override; any
   * other provider -> tear down a stale socket (so a fallback subprocess now on the
   * shared global socket is not frozen behind the presence-based broadcast gate)
   * and return undefined.
   */
  private wirePerChatActorSocket(chatJid: string, provider: string):
    | { mcpSocketPath: string; providerConfigOverride: { mcpConfig: string[]; strictMcpConfig: true } }
    | undefined {
    if (this.sessionScope !== 'per_chat' || this.sandboxPerChat) return undefined;
    const mapKey = this.resolvePerChatMapKey(chatJid);
    if (provider !== 'claude-cli') {
      this.teardownPerChatActorSocket(mapKey);
      return undefined;
    }
    const existing = this.perChatSocketResources.get(mapKey);
    const { socketPath, cfgPath } = existing
      ? { socketPath: existing.socketPath, cfgPath: existing.cfgPath }
      : this.createPerChatActorSocket(mapKey, chatJid);
    return { mcpSocketPath: socketPath, providerConfigOverride: { mcpConfig: [cfgPath], strictMcpConfig: true } };
  }

  /** F-STICKY-ACTOR (QR-247 hardening): stop + unlink a per-chat actor socket and clear its exec-queue. Idempotent — safe when no entry exists. */
  private teardownPerChatActorSocket(mapKey: string): void {
    this.perChatExecActorQueue.delete(mapKey);
    const sockRes = this.perChatSocketResources.get(mapKey);
    if (sockRes) {
      try { sockRes.socketServer.stop(); } catch (err) { log.warn({ err, mapKey }, 'per-chat socket stop failed'); }
      try { unlinkSync(sockRes.cfgPath); } catch { /* best-effort */ }
      this.perChatSocketResources.delete(mapKey);
    }
  }

  /** F-STICKY-ACTOR (QR-247): non-claude subprocess CLI providers (PRIMARY and/or configured FALLBACK) that stay on the shared global socket for this instance — the still-uncovered actor-race exposure. */
  private exposedCliProviders(): string[] {
    const isExposedCli = (p: string | undefined): p is string =>
      typeof p === 'string' && p.endsWith('-cli') && p !== 'claude-cli';
    const providers = new Set<string>();
    if (isExposedCli(this.effectiveProvider)) providers.add(this.effectiveProvider);
    for (const entry of this.agentFallbacks) if (isExposedCli(entry.provider)) providers.add(entry.provider);
    return [...providers];
  }

  /** F-STICKY-ACTOR (QR-247): true when a non-sandbox per_chat instance has ANY non-claude subprocess CLI provider on the shared global socket, so the concurrent-sender actor race is NOT closed for it. Covers the STATIC config surface (primary OR fallback) and — QR-263 — the DYNAMIC nlRouting surface (a live per-sender pin can select a non-claude CLI provider at runtime even when the static config is claude-only). Drives the honest startup warning (F11). */
  private perChatActorRaceExposed(): boolean {
    if (this.sessionScope !== 'per_chat' || this.sandboxPerChat) return false;
    return this.exposedCliProviders().length > 0 || this.nlRoutingEnabled;
  }

  private findMapKeyForSession(session: SessionManager | undefined, fallbackMapKey?: string): string | null {
    if (session) {
      for (const [mapKey, currentSession] of this.chatSessions) {
        if (currentSession === session) return mapKey;
      }
    }
    if (fallbackMapKey && this.chatSessions.has(fallbackMapKey)) {
      return fallbackMapKey;
    }
    return null;
  }

  /**
   * Get the outbound queue for a specific chatJid (shared mode).
   * Falls back to single queue (non-shared mode).
   */
  private getQueueForChat(chatJid: string, mapKey?: string): IOutboundQueue | null {
    if (this.sessionScope === 'per_chat') {
      return this.chatQueues.get(mapKey ?? this.resolvePerChatMapKey(chatJid)) ?? null;
    }
    if (this.shared) {
      return this.outboundQueues.get(chatJid) ?? null;
    }
    return this.queue;
  }

  /**
   * Create an OperationTracker for a session and wire its callbacks to the
   * appropriate queue and session methods. Returns null if tracking is disabled.
   */
  private createOperationTracker(
    session: SessionManager,
    resolveQueue: () => IOutboundQueue | null | undefined,
  ): OperationTracker | null {
    if (!config.operationTracker?.enabled) return null;
    return new OperationTracker(
      this.instanceName,
      config.operationTracker,
      {
        onProgress: (event: ProgressEvent) => {
          const q = resolveQueue();
          if (q) q.enqueueProgressUpdate(event, this.instanceName);
        },
        onStalled: (toolId: string, toolName: string) => {
          session.recoverStalledOperation(toolId, toolName);
        },
        onThinkingStalled: () => {
          session.probeLiveness();
        },
      },
    );
  }

  /** Resolve the operation tracker for a given mapKey (per_chat) or the singleton (single/shared).
   *  Always checks the per-key map first — control sessions store their tracker there even in
   *  single/shared scope, so the map lookup must precede the singleton fallback to prevent
   *  control session stalls from triggering recovery on the main session's process. */
  private getTracker(mapKey?: string): OperationTracker | null {
    if (mapKey !== undefined) {
      const perKeyTracker = this.operationTrackers.get(mapKey);
      if (perKeyTracker) return perKeyTracker;
    }
    if (this.sessionScope === 'per_chat') return null;
    return this.operationTracker;
  }

  private sendDirect(chatJid: string, text: string, bypassEchoGuard = false): void {
    if (bypassEchoGuard) {
      // Bypass queue entirely — direct send for admin responses
      this.messenger.sendMessage(chatJid, text).catch((err) =>
        log.error({ err }, 'sendDirect bypass failed'),
      );
      return;
    }
    const queue = this.getQueueForChat(chatJid);
    if (queue) {
      queue.enqueueText(text);
    } else {
      this.messenger.sendMessage(chatJid, text).catch((err) =>
        log.error({ err }, 'sendDirect fallback failed'),
      );
    }
  }

  /**
   * Per-spawn route resolution (slice-2 B2). Preferences are an INPUT to the
   * pure resolveRoute core, never an override of fallback/health state; the
   * decision applies to the session being spawned (provider/model stay
   * per-session and read-only).
   */
  private resolveRouteForTurn(
    chatJid: string,
    actorJid?: string,
  ): RouteDecision & { pinnedProvider: string | null } {
    // Fail-open over the WHOLE resolution (R13): the preference read AND the
    // routablePinTargets credential probe both do I/O that can throw. A
    // resolution failure must degrade to the default route and NEVER drop a
    // turn — so the pin probe is inside this guard, not just the pref read.
    try {
      const pref = actorJid ? this.loadSenderPreference(chatJid, actorJid) : null;
      const pinned = pref?.intent === 'provider_specific' ? pref.requestedProvider : null;
      // The tier provider this pref maps to (if any) is probed for routability
      // the same way a pin is — an ineligible tier degrades to the default
      // route (R5), never a keyless session. One probe, reused for both (C5).
      const tierProvider =
        pref?.intent === 'strongest' ? config.nlRoutingTiers?.strongest
        : pref?.intent === 'fastest' ? config.nlRoutingTiers?.fastest
        : undefined;
      const routable = this.routablePinTargets();
      const decision = resolveRoute({
        agentProvider: this.agentProvider,
        effectiveModel: this.effectiveModel,
        fallbackEntry: this.effectiveFallbackEntry,
        pref,
        pinnedProviderEligible: pinned !== null && routable.includes(pinned),
        tierMap: config.nlRoutingTiers,
        tierProviderEligible: tierProvider !== undefined && routable.includes(tierProvider),
      });
      return { ...decision, pinnedProvider: pinned };
    } catch (err) {
      log.warn({ err, instance: this.instanceName }, 'route resolution failed - routing on default');
      return {
        provider: this.agentProvider,
        model: this.effectiveModel,
        source: 'default',
        reasonCode: 'route_resolution_failed',
        pinnedProvider: null,
      };
    }
  }

  /**
   * Canonical-keyed preference read with fail-open (C3): owns key derivation
   * (preferenceKeys) AND the fail-open contract, so every reader — the spawn
   * path, /model status, and /why — degrades identically on a store error
   * (warn + treat as no preference) instead of one path throwing out of a
   * read-only command. A preference read failure must never surface as an
   * error or drop a turn.
   */
  private loadSenderPreference(chatJid: string, senderJid: string): ChatModelPreference | null {
    try {
      const { chatKey, senderKey } = preferenceKeys(this.db, chatJid, senderJid);
      return getPreference(this.db, chatKey, senderKey);
    } catch (err) {
      log.warn({ err, instance: this.instanceName }, 'preference read failed - routing on default');
      return null;
    }
  }

  /**
   * Provider config for a route-decided session: same inheritance rules as
   * the fallback path (fallbackProviderConfigFor), including the opencode
   * strip of primary-specific baseUrl/apiKeyService when routing away from
   * the primary provider.
   */
  private routeSessionProviderConfig(route: RouteDecision): Record<string, unknown> | undefined {
    if (route.source !== 'preference' || route.provider === this.agentProvider) {
      return this.sessionProviderConfig();
    }
    if (route.provider === 'opencode-cli') {
      if (!this.agentProviderConfig) return undefined;
      const { baseUrl: _baseUrl, apiKeyService: _apiKeyService, ...rest } = this.agentProviderConfig;
      return rest;
    }
    // Match the fallback path (effectiveProviderConfig): a provider with no
    // config of its own inherits the agent's providerConfig — including the
    // budget cap — instead of spawning with providerConfig=undefined (R2).
    return fallbackProviderConfigFor(route.provider, this.agentProvider, this.agentProviderConfig) ?? this.agentProviderConfig;
  }

  /** Spawn-time route bookkeeping: pin-blocked notice (once per transition) + route events. */
  private noteRouteAtSpawn(
    chatJid: string,
    conversationKey: string,
    route: RouteDecision & { pinnedProvider: string | null },
  ): void {
    // Route-transition tracking (slice 4): a spawn whose provider differs
    // from this conversation's previous spawn is a SWITCH, recorded exactly
    // once whatever moved it (preference, fallback, or back to default).
    const previousProvider = this.lastSpawnRouteProvider.get(conversationKey);
    this.lastSpawnRouteProvider.set(conversationKey, route.provider);
    const switched = previousProvider !== undefined && previousProvider !== route.provider;
    if (route.source === 'pin_blocked_default' && route.pinnedProvider) {
      let noticeSent = false;
      if (this.lastPinBlockNotice.get(conversationKey) !== route.pinnedProvider) {
        this.lastPinBlockNotice.set(conversationKey, route.pinnedProvider);
        noticeSent = true;
        // Strict pins never silently fall back: the block is VISIBLE and the
        // pin survives (the user clears it, we never do).
        this.sendDirect(
          chatJid,
          `_Your pinned ${route.pinnedProvider} isn't available right now. Using the default route — your pin stays set; /reset to clear it._`,
        );
      }
      this.emitRouteEventChecked({
        event: 'user_pin_unreachable',
        conversationKey,
        provider: route.provider,
        modelRef: route.model ?? null,
        source: 'default',
        userVisible: noticeSent,
        reasonCode: route.reasonCode,
      });
      return;
    }
    this.lastPinBlockNotice.delete(conversationKey);
    if (switched || route.source !== 'default') {
      this.emitRouteEventChecked({
        event: switched ? 'runtime_switched' : 'runtime_selected',
        conversationKey,
        provider: route.provider,
        modelRef: route.model ?? null,
        source: route.source === 'fallback' ? 'auto_fallback' : route.source === 'preference' ? 'user' : 'default',
        userVisible: false,
        reasonCode: route.reasonCode,
      });
    }
  }

  private emitRouteEventChecked(ev: Omit<ModelRouteEvent, 'ts' | 'instance' | 'chatScope' | 'authority'>): void {
    if (!config.nlRouting) return;
    const dir =
      config.nlRoutingEventsDir ?? join(homedir(), '.config', 'whatsoup', 'instances', this.instanceName);
    emitRouteEvent(
      dir,
      {
        ts: Date.now(),
        instance: this.instanceName,
        chatScope: deriveChatScope(ev.conversationKey),
        authority: 'advisory_only',
        ...ev,
      },
      (m) => log.warn({ instance: this.instanceName }, m),
    );
  }

  /**
   * Providers this instance can actually route to: the configured primary
   * plus the configured fallback chain, minus entries whose key service
   * resolves but has no credential (same probe the fallback selector uses).
   * A pin outside this set could only be honored by silent impersonation —
   * strict pins never silently fall back — so it is rejected at SET time (F07).
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
    const service = resolveProviderKeyService(
      entry.provider,
      entry.model,
      fallbackProviderConfigFor(entry.provider, this.agentProvider, this.agentProviderConfig),
    );
    return service ? lookupCredential(service) !== null : true;
  }

  /** Clear a sender's route preference — shared by `/model default` and `/reset`. */
  private clearRoutePreference(chatJid: string, chatKey: string, senderKey: string): void {
    this.clearRoutePreferenceSilent(chatJid, chatKey, senderKey);
    this.sendDirect(chatJid, '_Back to the default route._');
  }

  /** Store clear + route event without the reply echo. The NL typed-intent
   *  path acknowledges through the agent's own reply (prompt contract), so
   *  a runtime echo on top would double-message. */
  private clearRoutePreferenceSilent(chatJid: string, chatKey: string, senderKey: string): void {
    clearPreference(this.db, chatKey, senderKey);
    this.emitRouteEventChecked({
      event: 'model_preference_cleared',
      conversationKey: toConversationKey(chatJid),
      provider: this.agentProvider,
      modelRef: null,
      source: 'default',
      userVisible: true,
      reasonCode: 'user_reset',
    });
  }

  /**
   * Shared preference write for the /model aliases AND NL typed intents —
   * one path, so the two surfaces can never drift (slice-3 contract). An
   * identical repeat refreshes the TTL (sticky rows are never demoted); a
   * durable change writes the row and emits exactly one route event.
   */
  private recordRoutePreference(
    chatJid: string,
    chatKey: string,
    senderKey: string,
    intent: PreferenceIntent,
    requestedProvider: string | null,
  ): 'set' | 'refreshed' | 'sticky_kept' {
    const now = Date.now();
    const existing = getPreference(this.db, chatKey, senderKey, now);
    if (existing && existing.intent === intent && existing.requestedProvider === requestedProvider) {
      // Re-confirmation refreshes the TTL (F08) — "already set" must stay
      // true for a full window after the user re-asserts it. Sticky rows
      // (expiresAt null) are never demoted to ephemeral by a repeat.
      if (existing.expiresAt !== null) {
        setPreference(this.db, { ...existing, updatedAt: now, expiresAt: now + PREFERENCE_TTL_MS });
        return 'refreshed';
      }
      return 'sticky_kept';
    }
    setPreference(this.db, {
      chatJid: chatKey,
      senderJid: senderKey,
      intent,
      requestedProvider,
      scope: 'this_thread',
      pinStrict: true,
      fallbackPermitted: false,
      updatedAt: now,
      // this_thread preferences are ephemeral by design (24h TTL);
      // sticky pins require explicit confirmation and are a later slice.
      expiresAt: now + PREFERENCE_TTL_MS,
    });
    this.emitRouteEventChecked({
      event: 'model_preference_set',
      conversationKey: toConversationKey(chatJid),
      provider: requestedProvider ?? `intent:${intent}`,
      modelRef: null,
      source: 'user',
      userVisible: true,
      reasonCode: requestedProvider ? 'user_pin_set' : `intent_${intent}_set`,
    });
    return 'set';
  }

  /**
   * Slice-3 NL typed-intent consumption (call sites are flag-gated): strip
   * route-intent marker lines from agent output and feed the FIRST strictly-
   * valid intent into the same per-sender preference path as the /model
   * aliases. The agent's own reply carries the user-visible acknowledgement
   * (prompt contract), so the runtime acts silently here. Malformed or
   * ambiguous marker content changes nothing durable (UH-010); a store
   * failure never blocks delivery of the reply (fail-open, same rule as the
   * spawn-time preference read). Returns the delivery text, or null when
   * the reply was marker-only and nothing remains to deliver.
   */
  private consumeRouteIntents(
    text: string,
    chatJid: string,
    actorJid: string | undefined,
  ): string | null {
    const { cleaned, intents, invalid } = extractRouteIntents(text);
    if (invalid.length > 0) {
      log.warn({ chatJid: toConversationKey(chatJid), invalid }, 'route-intent marker failed strict validation - no state change');
    }
    if (intents.length > 1) {
      log.warn({ chatJid: toConversationKey(chatJid), count: intents.length }, 'multiple route-intent markers in one reply - acting on the first only');
    }
    const intent = intents[0];
    if (intent) {
      if (!actorJid) {
        // No resolvable sender for this turn — record nothing (UH-007).
        log.warn({ chatJid: toConversationKey(chatJid), intent }, 'route intent without a resolvable sender - no state change');
      } else {
        try {
          const { chatKey, senderKey } = preferenceKeys(this.db, chatJid, actorJid);
          if (intent === 'reset') {
            this.clearRoutePreferenceSilent(chatJid, chatKey, senderKey);
          } else {
            this.recordRoutePreference(chatJid, chatKey, senderKey, intent, null);
          }
        } catch (err) {
          log.warn({ err, intent, instance: this.instanceName }, 'route-intent apply failed - reply delivered without state change');
        }
      }
    }
    // Suppress delivery ONLY when a marker envelope was actually stripped and
    // nothing meaningful remains (R12) — a whitespace-only reply that carried
    // no marker must pass through unchanged, exactly as the flag-off path
    // would deliver it, instead of being silently swallowed.
    const markerStripped = intents.length > 0 || invalid.length > 0;
    return markerStripped && cleaned.trim().length === 0 ? null : cleaned;
  }

  /**
   * True while `held` could still grow into a `[[wa-route: …]]` envelope line.
   * Leading spaces/tabs are tolerated (extractRouteIntents trims each line),
   * but an all-whitespace buffer is NOT a marker precursor — a whitespace-only
   * reply is a genuine (empty-ish) reply and must not be held.
   */
  private routeMarkerStillPossible(held: string): boolean {
    const t = held.replace(/^[ \t]+/, '');
    if (t.length === 0) return false;
    const marker = '[[wa-route:';
    return marker.startsWith(t) || t.startsWith(marker);
  }

  /**
   * One streaming delta of a turn's assistant text (R1). Token-streaming
   * providers (anthropic-api/openai-api) emit assistant_text one fragment at a
   * time with no itemId, so a marker line is split across deltas and the
   * whole-event extractor never matches it — leaking the syntax and dropping
   * the intent. This buffers the FIRST line until it is resolvable (a newline
   * arrived, or it can no longer be a marker), runs the SAME extractRouteIntents
   * on the resolved prefix, then streams the body untouched. `held` is null
   * when not scanning (turn not armed, or first line already resolved) → base
   * per-delta extraction, byte-identical to flag-off body handling.
   */
  private scanRouteMarkerDelta(
    held: string | null,
    text: string,
    chatJid: string,
    actorJid: string | undefined,
  ): { deliver: string | null; held: string | null } {
    if (held === null) {
      return { deliver: this.consumeRouteIntents(text, chatJid, actorJid), held: null };
    }
    const next = held + text;
    if (next.includes('\n')) {
      // First line complete — resolve the whole held buffer with the shared
      // extractor (whole-block providers land here on their first delta).
      return { deliver: this.consumeRouteIntents(next, chatJid, actorJid), held: null };
    }
    if (this.routeMarkerStillPossible(next)) {
      return { deliver: null, held: next };
    }
    // The first line is plain text — release it and stop scanning this turn.
    return { deliver: this.consumeRouteIntents(next, chatJid, actorJid), held: null };
  }

  /**
   * Resolve a still-held first-line buffer at turn end (R1): a marker-only or
   * no-newline reply never saw a newline while streaming, so the terminal
   * 'result' flushes it — registering the intent and delivering whatever
   * remains. No-op when nothing was held.
   */
  private flushRouteMarker(
    held: string | null,
    chatJid: string,
    actorJid: string | undefined,
  ): string | null {
    if (held === null || held.length === 0) return null;
    return this.consumeRouteIntents(held, chatJid, actorJid);
  }

  /**
   * The route actually serving this chat right now, from the chat's LIVE
   * session delegate. The runtime-global effectiveProvider/effectiveModel
   * getters describe routing for the NEXT session only — existing sessions
   * keep their per-session provider/model (cf. markActiveFallbackFailed) —
   * so route visibility must read the live session first.
   */
  private liveSessionRoute(chatJid: string): { provider: string; model: string | undefined } | null {
    const session = this.sessionScope === 'per_chat'
      ? this.chatSessions.get(this.resolvePerChatMapKey(chatJid))
      : this.session;
    if (!session || !session.getStatus().active) return null;
    return { provider: session.getProviderId(), model: session.getModelRef() };
  }

  /**
   * Shared route-view head for the two visibility surfaces (C6): the live
   * session route, the sender's fail-open preference, AND the route the NEXT
   * spawn will actually resolve to — computed via resolveRouteForTurn (R7), the
   * SAME resolution the next session uses, so /model status and /why can never
   * misreport the next-session provider by reading effectiveProvider (which
   * reflects only the fallback window and ignores the pin).
   */
  private loadRouteView(chatJid: string, senderJid: string): {
    live: { provider: string; model: string | undefined } | null;
    pref: ChatModelPreference | null;
    next: RouteDecision & { pinnedProvider: string | null };
  } {
    return {
      live: this.liveSessionRoute(chatJid),
      pref: this.loadSenderPreference(chatJid, senderJid),
      next: this.resolveRouteForTurn(chatJid, senderJid),
    };
  }

  /**
   * End-user route status (/model status). Visibility policy (capability-
   * preserved routing): provider, model route, preference, fallback state,
   * delegation state, and authority class only — never tool names, socket
   * paths, pids, account JIDs, or cross-conversation metadata.
   */
  private renderRouteStatus(chatJid: string, senderJid: string): string {
    const { live, pref, next } = this.loadRouteView(chatJid, senderJid);
    // Next-session provider/model come from resolveRouteForTurn (R7), so an
    // eligible pin or tier is reflected here — not the fallback-only
    // effectiveProvider, which contradicted the "steers new sessions" line.
    const nextProvider = next.provider || 'unknown-provider';
    const provider = live?.provider ?? nextProvider;
    const model = (live ? live.model : next.model) ?? 'provider default';
    const prefLine = pref
      ? `Preference: ${pref.requestedProvider ?? pref.intent} for you in this chat` +
        (pref.expiresAt !== null
          ? ` (expires in ~${Math.max(1, Math.round((pref.expiresAt - Date.now()) / 3_600_000))}h)`
          : '') +
        ' — steers new sessions'
      : 'Preference: none';
    const fallbackLine = this.isFallbackWindowActive
      ? `Fallback: active — new sessions route via ${nextProvider}`
      : this.agentFallbacks.length > 0
        ? `Fallback chain (configured): ${this.agentFallbacks.map((e) => e.provider).join(' → ')}`
        : 'Fallback: none configured';
    const nextLine = live && live.provider !== nextProvider
      ? `\nNext session: ${nextProvider}`
      : '';
    return (
      `*Current route:* ${provider}${live ? '' : ' (no live session — next session route)'}\n` +
      `Model: ${model}\n` +
      `${prefLine}\n` +
      `${fallbackLine}${nextLine}\n` +
      'Delegation: none\n' +
      // Capability-preserved phrasing, true on EVERY instance (F10): this
      // surface must not claim the bot can or cannot act — only that
      // routing choices never change what it may do.
      'Authority: routing never changes what I am allowed to do'
    );
  }

  /** Compact route receipt (/why): what answered and why, one line. */
  private renderRouteWhy(chatJid: string, senderJid: string): string {
    const { live, pref, next } = this.loadRouteView(chatJid, senderJid);
    // With no live session, report the provider the NEXT spawn will use (R7)
    // — the pinned/tier provider, not the fallback-only effectiveProvider.
    const provider = live?.provider ?? (next.provider || 'unknown-provider');
    const reason = live
      ? this.isFallbackWindowActive && live.provider !== next.provider
        ? "serving this chat's current session (new sessions use the fallback route)"
        : "serving this chat's current session"
      : next.source === 'fallback'
        ? 'a fallback window is active'
        : next.source === 'preference'
          ? 'your preferred route for the next session'
          : next.source === 'pin_blocked_default'
            ? 'your pinned provider is unavailable — using the default route'
            : 'instance default route';
    const prefNote = pref
      ? '; your preference steers new sessions'
      : '';
    return `_Route: ${provider} (${reason})${prefNote}. No delegation; routing never changes what I am allowed to do._`;
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

  private get effectiveFallbackEntry(): AgentFallbackEntry | null {
    if (!this.isFallbackWindowActive) return null;
    return this.fallbackWindow.activeEntry ?? this.agentFallbacks[0] ?? null;
  }

  private selectFallbackEntryForWindow(reason?: string): { entry: AgentFallbackEntry; selectedHadMissingCredential: boolean } | null {
    if (this.agentFallbacks.length === 0) {
      this.fallbackChain.chainState = [];
      return null;
    }

    const requireIndependentProvider = fallbackRequiresIndependentProbe(reason);
    let firstEligibleIndex = -1;
    let firstIndependentIndex = -1;
    const state: Array<AgentFallbackEntry & { eligible: boolean }> = [];
    for (let i = 0; i < this.agentFallbacks.length; i++) {
      const entry = this.agentFallbacks[i]!;
      if (requireIndependentProvider && entry.provider === this.agentProvider) {
        state.push({ ...entry, eligible: false });
        continue;
      }
      if (this.fallbackChain.failedKeys.has(this.fallbackChain.entryKey(entry))) {
        state.push({ ...entry, eligible: false });
        continue;
      }
      if (entry.provider !== this.agentProvider && firstIndependentIndex === -1) {
        firstIndependentIndex = i;
      }
      // Eligibility DECISION comes from the shared predicate (C4) so it can
      // never desync from pin eligibility; `service` is recomputed only for
      // the credential-missing alert below (the selector's own concern).
      const eligible = this.isEntryCredentialed(entry);
      const service = resolveProviderKeyService(
        entry.provider,
        entry.model,
        fallbackProviderConfigFor(entry.provider, this.agentProvider, this.agentProviderConfig),
      );
      state.push({ ...entry, eligible });
      if (eligible && firstEligibleIndex === -1) {
        firstEligibleIndex = i;
      }
      if (!eligible) {
        emitAlertChecked(
          this.instanceName,
          'fallback_credential_missing',
          'Fallback provider key not found in keyring',
          `entry=${i} service=${service} provider=${entry.provider} model=${entry.model ?? ''}`,
        );
      }
    }
    this.fallbackChain.chainState = state;
    if (requireIndependentProvider && firstEligibleIndex === -1 && firstIndependentIndex === -1) {
      emitAlertChecked(
        this.instanceName,
        'fallback_no_independent_provider',
        'Fallback requires an independent provider target',
        `primaryProvider=${this.agentProvider} reason=${reason}`,
      );
      return null;
    }
    const selectedIndex = firstEligibleIndex === -1
      ? (requireIndependentProvider ? firstIndependentIndex : 0)
      : firstEligibleIndex;
    return {
      entry: this.agentFallbacks[selectedIndex]!,
      selectedHadMissingCredential: state[selectedIndex]?.eligible === false,
    };
  }

  private markActiveFallbackFailed(
    session: SessionManager | null,
    reason: ProviderFallbackReason,
    evidenceText?: string,
  ): string | null {
    if (!this.isFallbackWindowActive || !this.fallbackWindow.activeEntry || !session) return null;
    const sessionProvider = typeof session.getProviderId === 'function' ? session.getProviderId() : null;
    if (sessionProvider !== null) {
      if (sessionProvider !== this.fallbackWindow.activeEntry.provider) return null;
    } else {
      const sessionId = session.getStatus().sessionId;
      if (!sessionId?.startsWith(`${this.fallbackWindow.activeEntry.provider}-`)) return null;
    }

    const key = this.fallbackChain.entryKey(this.fallbackWindow.activeEntry);
    if (!this.fallbackChain.failedKeys.has(key)) {
      this.fallbackChain.failedKeys.add(key);
      emitAlertChecked(
        this.instanceName,
        'fallback_provider_failed',
        'Active fallback provider failed during fallback window',
        `provider=${this.fallbackWindow.activeEntry.provider} model=${this.fallbackWindow.activeEntry.model ?? 'default'}`
          + ` reason=${reason}`
          + (evidenceText ? ` evidence=${evidenceText.slice(0, 160)}` : ''),
      );
    }
    return key;
  }

  /**
   * Arm provider fallback when the PRIMARY provider returns empty output — the
   * failure mode a broken primary auth/session produces (e.g. claude-cli after
   * a silent CLI auto-update invalidated its keychain login). Such a turn exits
   * cleanly with NO text, so it never classifies as a provider-failure message
   * and the normal text-driven arming path never fires; without this the bot
   * stays pinned to the dead primary and only reports `degraded` forever while
   * the configured fallback ladder sits idle.
   *
   * Deterministic trigger (the user-facing message is templated; the DECISION
   * is fully deterministic):
   *   - arm on the FIRST empty primary turn when the independent usability probe
   *     already flags the primary unusable, OR
   *   - arm after {@link EMPTY_OUTPUT_FALLBACK_THRESHOLD} consecutive empty
   *     primary turns (a healthy primary never returns two pure-empty turns).
   *
   * Armed with first-class empty-output/probe-unusable reasons while preserving
   * the old auth-required control semantics: fallback SELECTION skips same-
   * provider entries (a broken claude-cli login breaks every claude-cli fallback
   * too → jump straight to the independent provider) and REVERT is gated on a
   * fresh primary probe — so it self-heals once the primary auth is restored.
   * No-op (returns false) when already on a fallback window or when no fallback
   * is configured. Returns true only when it armed a window this call.
   */
  private maybeArmFallbackAfterEmptyPrimaryTurn(
    queue: IOutboundQueue,
    session: SessionManager | null,
    turnHadToolWork: boolean,
    mapKey: string | undefined,
  ): boolean {
    if (this.isFallbackWindowActive) return false;
    if (this.agentFallbacks.length === 0) return false;
    // The control/repair session (control@heal.internal) is a synthetic
    // diagnostic probe, not a real conversation turn. Its emptiness must NOT
    // feed the production consecutivePrimaryEmptyTurns counter: a canned repair
    // prompt can legitimately produce no text, and counting it cross-contaminates
    // the threshold that the NEXT real-chat turn trips on. The control session
    // has its own lifecycle (onCrash → HEAL_ESCALATE, 15min hard timeout) and
    // does not need the fallback ladder. (Seen in production on ml-bot: a /heal
    // provider-reset repair turn returned empty, bumped the counter to 1, then a
    // single real-chat empty armed the fallback at threshold 2 — false failover.)
    // The controlSession !== null guard avoids the null===null trap: per-chat
    // turns pass session=null here, and this.controlSession also defaults to
    // null, so a bare session===this.controlSession would match every turn.
    if ((this.controlSession !== null && session === this.controlSession) || mapKey === 'control@heal.internal') {
      return false;
    }

    this.consecutivePrimaryEmptyTurns += 1;
    // R2 guard: mirror getTurnCapability's probeInFlight check. When the
    // startup probe has not yet resolved ({probeInFlight:true}), the usability
    // field carries {status:'unknown', reason:'probe-in-flight'}, which
    // primaryModelUsabilityRequiresAlert() would (correctly) treat as unusable
    // — but that is indeterminate, not confirmed-unusable.  Treating it as
    // confirmed-unusable arms the probe fast-path against a healthy primary
    // whenever the probe takes longer than the grace window.  Gate exactly as
    // getTurnCapability does: skip the alert check while the probe is still
    // in-flight.  A resolved-unusable probe (probeInFlight:false) still arms
    // normally; the threshold path is entirely unaffected.
    const probeFlagsUnusable = this.primaryModelUsability && !this.primaryModelUsability.probeInFlight
      ? primaryModelUsabilityRequiresAlert(this.primaryModelUsability)
      : false;
    const reachedThreshold =
      this.consecutivePrimaryEmptyTurns >= EMPTY_OUTPUT_FALLBACK_THRESHOLD;

    // Startup grace (anti-flap): during the boot/recovery window the usability
    // probe is transiently 'unknown', which primaryModelUsabilityRequiresAlert
    // treats as unusable. That makes the single-empty *probe fast-path* arm on
    // the very first empty turn and flap the instance onto the backup on every
    // restart (seen in production: the spurious startup activations were all
    // single-empty 'probe-unusable', none from the threshold). Suppress ONLY the
    // probe fast-path during the grace window. We still COUNT the empty and
    // still honour the consecutive-empty threshold — so a genuinely dead
    // primary taking real inbound traffic in the first 60s still fails over
    // (at most one extra turn of latency, no silent blind spot), and the
    // per-chat empty-output replay that arms via the threshold (#972) is
    // preserved. The counter resets on any successful turn.
    // R1 hardening: use monotonic performance.now() so wall-clock steps (NTP
    // corrections, host sleep/wake, VM migration — all most likely right after
    // process start) cannot prematurely end or over-extend the grace window.
    const inStartupGrace =
      this.turnCapabilityTracker.lastSuccessfulTurnAt === null &&
      performance.now() - this.runtimeBootPerfMs < EMPTY_OUTPUT_ARM_STARTUP_GRACE_MS;
    const armViaProbe = probeFlagsUnusable && !inStartupGrace;
    if (!armViaProbe && !reachedThreshold) return false;

    log.warn(
      {
        instanceName: this.instanceName,
        primaryProvider: this.agentProvider,
        consecutivePrimaryEmptyTurns: this.consecutivePrimaryEmptyTurns,
        // `trigger` names the dominant signal (probe fast-path vs threshold);
        // `triggeredByThreshold` is the one non-derivable observable kept beside
        // it so a dual-arm (probe unusable AND threshold reached) stays visible —
        // the load-bearing signal for catching a startup-flap regression on this
        // failover path. The probe-arm fact is recoverable from `trigger` alone.
        trigger: armViaProbe ? 'probe-unusable' : 'consecutive-empty-output',
        triggeredByThreshold: reachedThreshold,
      },
      'primary provider returned empty output — arming provider fallback',
    );

    // Emit the TRUE trigger as the fallback reason so the operator-facing
    // provider_fallback_activated alert names the real cause (empty-output /
    // probe-unusable) instead of the misleading 'auth-required' this path used
    // to borrow purely for its control side-effects (#1421). The probe + the
    // independent-provider gates that 'auth-required' provided are preserved for
    // both reasons via fallbackRequiresIndependentProbe().
    const activation = this.activateProviderFallbackAfterTerminalResult(
      null,
      armViaProbe ? 'probe-unusable' : 'empty-output',
      session,
      '',
    );
    if (!activation) return false;

    const replayScheduled = this.scheduleFallbackReplay({
      activation,
      chatJid: queue.targetChatJid,
      mapKey,
      oldSession: session,
      hadToolActivity: turnHadToolWork,
    });
    this.notifyProviderFallbackActivated(queue, activation, {
      replayScheduled,
      blockedByToolActivity: turnHadToolWork,
    });
    this.consecutivePrimaryEmptyTurns = 0;
    return true;
  }

  private activateProviderFallbackAfterTerminalResult(
    resetAt: Date | null,
    reason: ProviderFallbackReason,
    session: SessionManager | null,
    evidenceText?: string,
  ): ProviderFallbackActivation | null {
    const failedKey = this.markActiveFallbackFailed(session, reason, evidenceText);
    const activation = this.activateProviderFallback(resetAt, reason);
    if (activation || !failedKey) return activation;

    // Preserve previous single-fallback behavior when no alternate exists:
    // keep the current fallback window instead of reverting to a known-bad primary.
    this.fallbackChain.failedKeys.delete(failedKey);
    return this.activateProviderFallback(resetAt, reason);
  }

  /**
   * Public, read-only view of the provider-fallback state for observability
   * (health snapshot / fleet provider-status). Returns the currently effective
   * provider, the epoch-ms expiry of an active fallback window (`null` when
   * the bot is on its primary provider), and process-local turn counters (reset
   * on restart). Mirrors {@link effectiveProvider} but does not widen the
   * underlying fields' visibility.
   *
   * Health spreads this object verbatim into /health, so new fields must be
   * JSON-safe and additive.
   */
  /**
   * TTL-memoised resolver for idle (pre-selection) fallback eligibility. Built
   * lazily so the keyring is consulted at most once per entry per TTL even though
   * getFallbackState backs the frequently-polled /health endpoint.
   */
  private idleFallbackEligibilityResolver?: (entry: AgentFallbackEntry) => boolean | null;

  getFallbackState(): {
    effectiveProvider: string;
    fallbackActiveUntil: number | null;
    fallbackReason: string | null;
    fallbackModel: string | null;
    fallbackResetAt: number | null;
    fallbackRecoveryProbeRequired: boolean;
    fallbackTurnsServed: number;
    fallbackTurnsEmpty: number;
    lastFallbackTurnAt: number | null;
    probeAttempts: number;
    lastProbeAt: number | null;
    fallbackActivations: number;
    fallbackReverts: number;
    fallbackReplays: number;
    fallbackWindowCostUsd: number;
    primaryModelUsability: RuntimePrimaryModelUsability | null;
    turnCapability: RuntimeTurnCapability;
    activeFallbackEntry: AgentFallbackEntry | null;
    fallbackChain: Array<AgentFallbackEntry & { eligible: boolean | null }>;
    fallbackChainExhausted: boolean;
    failedEntryCount: number;
    turnErrorCounts: Record<string, number>;
    handoffDistiller: { enabled: boolean; contextInjection: boolean; model: string | null };
  } {
    const active = this.isFallbackWindowActive;
    const fallbackEntry = active ? this.effectiveFallbackEntry : null;
    this.idleFallbackEligibilityResolver ??= makeIdleEligibilityResolver(
      (entry) => this.fallbackKeyPresent(entry.provider, entry.model),
      Date.now,
    );
    return {
      effectiveProvider: this.effectiveProvider,
      fallbackActiveUntil: active ? this.fallbackWindow.activeUntil : null,
      fallbackReason: active ? this.fallbackWindow.armReason : null,
      fallbackModel: fallbackEntry?.model ?? null,
      fallbackResetAt: active ? this.fallbackWindow.resetAt : null,
      fallbackRecoveryProbeRequired: active ? this.fallbackWindow.recoveryProbeRequired : false,
      fallbackTurnsServed: this.fallbackMetrics.turnsServed,
      fallbackTurnsEmpty: this.fallbackMetrics.turnsEmpty,
      lastFallbackTurnAt: this.fallbackMetrics.lastTurnAt,
      probeAttempts: this.fallbackProbeAttempts,
      lastProbeAt: this.fallbackLastProbeAt,
      fallbackActivations: this.fallbackMetrics.activations,
      fallbackReverts: this.fallbackMetrics.reverts,
      fallbackReplays: this.fallbackMetrics.replays,
      fallbackWindowCostUsd: this.fallbackMetrics.windowCostUsd,
      primaryModelUsability: this.primaryModelUsability ? { ...this.primaryModelUsability } : null,
      turnCapability: this.getTurnCapability(),
      activeFallbackEntry: fallbackEntry ? { ...fallbackEntry } : null,
      fallbackChain: this.fallbackChain.snapshot(this.agentFallbacks, this.idleFallbackEligibilityResolver),
      fallbackChainExhausted: this.fallbackChain.isExhausted(this.agentFallbacks),
      failedEntryCount: this.fallbackChain.failedKeys.size,
      turnErrorCounts: Object.fromEntries(this.turnCapabilityTracker.errorCounts),
      handoffDistiller: {
        enabled: handoffDistillerEnabled(),
        contextInjection: handoffContextEnabled(),
        model: handoffDistillModel(),
      },
    };
  }

  private getTurnCapability(): RuntimeTurnCapability {
    const usability = this.primaryModelUsability;
    const { modelUsable, modelUsableStale, modelUsableCheckedAt } = deriveModelUsable(usability, Date.now());
    return {
      modelUsable,
      modelUsableStale,
      modelUsableCheckedAt,
      modelUsabilityStatus: usability?.status ?? null,
      lastSuccessfulTurnAt: this.turnCapabilityTracker.lastSuccessfulTurnAt,
      lastTurnErrorClass: this.turnCapabilityTracker.lastTurnErrorClass,
      lastTurnErrorAt: this.turnCapabilityTracker.lastTurnErrorAt,
    };
  }

  private recordTurnCapabilitySuccess(isUserTurnResult: boolean): void {
    if (!isUserTurnResult) return;
    this.turnCapabilityTracker.recordSuccess();
    this.consecutivePrimaryEmptyTurns = 0;
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

  /**
   * Admin override (FALLBACK ON): force a fallback window. Unlike usage-limit
   * activation, the window is set EXACTLY — it may shorten an active window;
   * operator intent wins over extend-never-shorten. Arms via the shared
   * hardened path (persistence + credential pre-flight).
   *
   * Reason provenance: an admin force is always treated as a NEW cause, even
   * when a usage-limit window is already active. The stored reason is reset to
   * 'admin-forced' so the persisted record accurately reflects the current
   * operator action rather than the original automatic trigger.
   */
  forceFallback(durationMs?: number): { ok: true; activeUntil: number; clamped: boolean } | { ok: false; reason: string } {
    if (this.agentFallbacks.length === 0) {
      return { ok: false, reason: 'no fallback provider or chain configured for this instance' };
    }
    const requested = durationMs ?? DEFAULT_FALLBACK_WINDOW_MS;
    const dur = Math.min(MAX_FALLBACK_WINDOW_MS, Math.max(MIN_FALLBACK_WINDOW_MS, requested));
    const until = Date.now() + dur;
    // Reset reason so armFallbackWindow stores 'admin-forced' as the new
    // original cause, replacing any prior reason (e.g. 'usage-limit').
    this.fallbackWindow.armReason = null;
    this.fallbackChain.failedKeys.clear();
    this.fallbackEmptyAdvance.reset();
    this.armFallbackWindow(until, 'admin-forced');
    log.info({ activeUntil: new Date(until).toISOString() }, 'fallback window forced by admin');
    return { ok: true, activeUntil: until, clamped: dur !== requested };
  }

  /** Admin override (FALLBACK OFF): end any active fallback window now. Idempotent. */
  disableFallback(): { ok: true } {
    this.deactivateProviderFallback('admin-disabled');
    return { ok: true };
  }

  /** Model paired with {@link effectiveProvider}: fallbackModel while the window is active, else the primary model. */
  private get effectiveModel(): string | undefined {
    const fallbackEntry = this.effectiveFallbackEntry;
    return fallbackEntry
      ? fallbackEntry.model
      : this.model;
  }

  /** Provider config paired with {@link effectiveProvider}. */
  private get effectiveProviderConfig(): Record<string, unknown> | undefined {
    const fallbackEntry = this.effectiveFallbackEntry;
    if (!fallbackEntry) return this.agentProviderConfig;
    if (fallbackEntry.provider === 'opencode-cli') return this.agentProviderConfig;
    return fallbackProviderConfigFor(fallbackEntry.provider, this.agentProvider, this.agentProviderConfig) ?? this.agentProviderConfig;
  }

  private primaryOpencodeProviderConfig(): OpencodeProviderConfig | undefined {
    if (this.agentProvider !== 'opencode-cli' || !this.agentProviderConfig) return undefined;

    const providerConfig: OpencodeProviderConfig = {};
    const baseUrl = this.agentProviderConfig['baseUrl'];
    if (typeof baseUrl === 'string') {
      providerConfig.baseUrl = baseUrl;
    }
    if (this.model) {
      providerConfig.model = this.model;
    }
    const apiKeyService = this.agentProviderConfig['apiKeyService'];
    if (typeof apiKeyService === 'string') {
      providerConfig.apiKeyService = apiKeyService;
    }
    return providerConfig;
  }

  /**
   * Whether the keyring holds an API key for the configured fallback target.
   *
   * Returns:
   *  - `true`  — a key is present for the resolved service.
   *  - `false` — a key is expected but absent (opencode sessions would fail auth).
   *  - `null`  — not applicable: native-auth CLI providers (claude-cli,
   *              codex-cli, gemini-cli) authenticate via subscription/login,
   *              so no keyring key is checked.
   *
   * Service mapping: opencode-cli → the model's provider prefix
   * (`minimax/...` → `minimax`); openai-api → `openai`;
   * anthropic-api → `anthropic`. Managed API fallbacks honor inherited
   * `providerConfig.apiKeyService`. Never logs the value.
   */
  private fallbackKeyPresent(provider: string | undefined, model: string | undefined): boolean | null {
    return fallbackKeyPresentFor(provider, model, this.agentProvider, this.agentProviderConfig);
  }

  /** User-facing notice for a usage-limit teardown when no fallback replay can run. */
  private usageLimitNotice(): string {
    return this.agentFallbacks.length > 0
      ? '_Primary model hit a token/quota limit, but the backup could not continue this turn. An operator has been notified._'
      : '_Primary model hit a token/quota limit. Please try again after the limit resets._';
  }

  /**
   * QR-211: user-visible notice for an auth-required terminal result when no
   * fallback could be activated (not configured, or activation failed) — the
   * three legacy-ladder / registry-handler auth-required branches otherwise end
   * in permanent silence: the session shuts down with nothing ever forwarded to
   * the chat. Generic by design (seam-6: no secrets, no provider internals).
   *
   * Owns its own enqueue AND de-dup (unlike usageLimitNotice, a pure string
   * factory called from a single site) because it is invoked from three
   * independent call sites and must not spam one notice per turn during a
   * sustained auth-required episode. Mirrors the recentFallbackEmptyTurnAlerts
   * prune→check→set→capDedupeMap idiom, reusing PROVIDER_FALLBACK_NOTICE_DEDUP_MS.
   */
  private emitNoFallbackReauthNotice(queue: IOutboundQueue): void {
    const now = Date.now();
    for (const [key, recordedAt] of this.recentNoFallbackReauthNotices) {
      if (now - recordedAt > PROVIDER_FALLBACK_NOTICE_DEDUP_MS) {
        this.recentNoFallbackReauthNotices.delete(key);
      }
    }
    const noticeKey = [queue.targetChatJid, 'auth-required'].join(':');
    if (this.recentNoFallbackReauthNotices.has(noticeKey)) return;
    this.recentNoFallbackReauthNotices.set(noticeKey, now);
    this.capDedupeMap(this.recentNoFallbackReauthNotices);
    queue.enqueueText('_The agent needs re-authentication before it can reply here. An operator has been notified._');
  }

  /**
   * Count a completed turn during an active fallback window; alert and enqueue
   * a user notice when the turn produced neither visible text nor tool activity.
   *
   * A turn whose entire reply was MCP tool sends (send_message, send_media, etc.)
   * is NOT silent — the user already received the visible result through the
   * outbound channel. hadToolWork suppresses both the counter and the notice for
   * those turns, preserving the signal for genuinely empty ones.
   */
  private recordFallbackTurnOutcome(
    queue: IOutboundQueue,
    hadVisibleOutput: boolean,
    hadToolWork: boolean = false,
    session: SessionManager | null = null,
  ): void {
    if (!this.isFallbackWindowActive) return;
    this.fallbackMetrics.recordServedTurn();
    if (hadVisibleOutput || hadToolWork) {
      // The active entry produced a real reply — it is healthy. Clear the
      // empty-advance accounting so a later isolated empty turn starts fresh.
      this.fallbackEmptyAdvance.reset();
      return;
    }
    this.fallbackMetrics.recordEmptyTurn();
    this.fallbackEmptyAdvance.recordEmpty();
    const entry = this.fallbackWindow.activeEntry ?? this.agentFallbacks[0] ?? null;
    log.warn({
      chatJid: queue.targetChatJid,
      fallbackProvider: entry?.provider,
      fallbackModel: entry?.model,
      served: this.fallbackMetrics.turnsServed,
      empty: this.fallbackMetrics.turnsEmpty,
    }, 'fallback turn completed with zero visible output');
    // Per-chat dedup: reuse PROVIDER_FALLBACK_NOTICE_DEDUP_MS window to avoid
    // one alert per empty turn in a sustained silent-bot episode.
    const emptyAlertNow = Date.now();
    for (const [k, ts] of this.recentFallbackEmptyTurnAlerts) {
      if (emptyAlertNow - ts > PROVIDER_FALLBACK_NOTICE_DEDUP_MS) this.recentFallbackEmptyTurnAlerts.delete(k);
    }
    if (!this.recentFallbackEmptyTurnAlerts.has(queue.targetChatJid)) {
      this.recentFallbackEmptyTurnAlerts.set(queue.targetChatJid, emptyAlertNow);
      this.capDedupeMap(this.recentFallbackEmptyTurnAlerts);
      emitAlertChecked(
        this.instanceName,
        'fallback_empty_turn',
        'Fallback turn produced no visible output',
        `provider=${entry?.provider} model=${entry?.model} served=${this.fallbackMetrics.turnsServed} empty=${this.fallbackMetrics.turnsEmpty} chat=${queue.targetChatJid}`,
      );
    }

    // Advance the chain when the ACTIVE fallback entry is structurally empty.
    // An entry that connects but emits no assistant text (e.g. a broken
    // opencode provider integration) produces no terminal-failure MESSAGE, so
    // the text-driven advance path (activateProviderFallbackAfterTerminalResult
    // on a classified failure) never fires and the bot pins to the dead entry,
    // emitting "_backup returned no reply — resend_" every turn while a working
    // entry sits behind it. Mirror the PRIMARY empty-output trigger: after
    // EMPTY_OUTPUT_FALLBACK_THRESHOLD consecutive empty turns on the same entry,
    // route it through the SAME advance path terminal failures use — mark the
    // entry failed and re-select the next eligible entry. Preserve the window's
    // original arm reason so selection keeps skipping same-as-primary entries
    // (an auth-required window must not advance back onto a dead primary
    // provider). The attempted-key guard stops re-advancing (and re-alerting)
    // the same entry when no alternate exists. Reuses the terminal path's
    // single-fallback preservation: when no alternate remains the window keeps
    // the current entry rather than reverting to a known-bad primary.
    const entryKey = entry ? this.fallbackChain.entryKey(entry) : null;
    if (
      session !== null &&
      entryKey !== null &&
      this.fallbackEmptyAdvance.shouldAttemptAdvance(entryKey, EMPTY_OUTPUT_FALLBACK_THRESHOLD)
    ) {
      const advanceReason = isProviderFallbackReason(this.fallbackWindow.armReason)
        ? this.fallbackWindow.armReason
        : 'auth-required';
      const resetAt = this.fallbackWindow.resetAt !== null ? new Date(this.fallbackWindow.resetAt) : null;
      const activation = this.activateProviderFallbackAfterTerminalResult(
        resetAt,
        advanceReason,
        session,
        'fallback entry returned empty output',
      );
      if (activation) {
        // Advanced to a fresh entry — clear the empty run so the new entry
        // starts from zero (the attempted-key guard now tracks the prior key,
        // which differs from the newly-selected entry).
        this.fallbackEmptyAdvance.clearConsecutive();
        log.warn({
          chatJid: queue.targetChatJid,
          deadProvider: entry?.provider,
          deadModel: entry?.model,
          advancedTo: this.fallbackWindow.activeEntry?.provider,
          advancedModel: this.fallbackWindow.activeEntry?.model,
        }, 'advanced fallback chain past structurally-empty entry');
      }
    }
  }

  /** Arm (or move) the fallback window to `until`, schedule the revert timer,
   *  and persist best-effort so a restart mid-window resumes on fallback.
   *  Pass `activatedAt` explicitly when restoring to preserve the original
   *  time, and `opts.restored` so a resumed window is not re-counted. */
  private armFallbackWindow(until: number, reason: string, activatedAt: number = Date.now(), opts?: { restored?: boolean }): boolean {
    const selection = this.selectFallbackEntryForWindow(reason);
    if (!selection) return false;
    const fallbackEntry = selection.entry;
    this.fallbackWindow.activeEntry = fallbackEntry;
    this.fallbackWindow.activeUntil = until;
    this.fallbackWindow.activatedAt = activatedAt;
    // First-arm discriminator, captured before the guard below consumes it:
    // null means this call is the window's first arm in this process (a fresh
    // activation or a post-restart restore), non-null means an extension of
    // the already-armed window. Pre-flight runs only on first arms — an
    // extension re-arm re-spawning the credential/binary/catalog probes and
    // re-firing their alerts on every per-turn usage-limit is an unthrottled
    // storm, and nothing about the target entry's environment changed.
    const firstArm = this.fallbackWindow.armReason === null;
    // Preserve original cause: only set on first arm; extensions and restores
    // must pass the original reason so it is not overwritten. The activation
    // alert + counter fire exactly once per window, never on extensions. A
    // restored window is the SAME window resuming after a restart — the
    // first-arm discriminator is per-process, so without the restored flag
    // every restart would re-count and re-alert the activation that already
    // fired before the restart.
    if (firstArm) {
      // Slice-4 observability: exactly one auto_fallback_started per window
      // (extensions re-arm the same window; a restore resumes it quietly).
      this.emitRouteEventChecked({
        event: 'auto_fallback_started',
        conversationKey: null,
        provider: fallbackEntry.provider,
        modelRef: fallbackEntry.model ?? null,
        source: 'auto_fallback',
        userVisible: !opts?.restored,
        reasonCode: opts?.restored ? `${reason} (restored)` : reason,
      });
      this.fallbackWindow.armReason = reason;
      // Snapshot the lifetime turn counters at the first arm of every window
      // (the null-guard skips extensions; restores hit it too because the
      // guard is per-process, which is correct — the counters are also
      // per-process, so a restored window counts from this process's zero).
      this.fallbackMetrics.snapshotAtArm();
      if (opts?.restored) {
        // A restored window is the SAME window resuming after a restart, so
        // it never re-counts as an activation — but the resume itself is an
        // operator-visible transition (a restart mid-window; repeated
        // restores are the crash-loop signature), so it gets its own
        // additive source instead of silence.
        // A restore is a RESUMPTION, not a new fault: the activation already
        // fired before the restart and its window is still open. Paging an
        // operator to "investigate/remediate" a healthy service restart mid-
        // window is noise. Downgraded to 'info' (BE-G3 gap 2).
        emitAlertChecked(
          this.instanceName,
          'provider_fallback_restored',
          'Provider fallback window restored after restart',
          `reason=${reason} provider=${fallbackEntry.provider} model=${fallbackEntry.model ?? 'default'}`
            + ` until=${new Date(until).toISOString()} probeAttempts=${this.fallbackProbeAttempts}`,
          'info',
        );
      } else {
        this.fallbackMetrics.recordActivation();
        emitAlertChecked(
          this.instanceName,
          'provider_fallback_activated',
          'Provider fallback window activated',
          `reason=${reason} provider=${fallbackEntry.provider} model=${fallbackEntry.model ?? 'default'} until=${new Date(until).toISOString()}`,
        );
      }
    }
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
    this.revertTimer = setTimeout(() => {
      this.handleFallbackRevertTimer();
    }, Math.max(0, until - Date.now()));
    // Do not let the revert timer keep the process alive at shutdown.
    this.revertTimer.unref?.();
    // Belt-and-suspenders: persist the memory-authoritative reason (fallbackArmReason
    // after the set-when-null guard above) so the DB can never diverge from the
    // in-memory value even if a caller passes an incorrect reason directly.
    const persistReason = this.fallbackWindow.armReason ?? reason;
    this.fallbackWindow.recoveryProbeRequired = fallbackRequiresPrimaryProbe(persistReason as ProviderFallbackReason);
    this.scheduleFallbackPrimaryProbe();
    try {
      saveFallbackState(this.db, {
        activeUntil: until,
        activatedAt,
        reason: persistReason,
        probeAttempts: this.fallbackProbeAttempts,
      });
    } catch (err) {
      log.warn({ err }, 'failed to persist fallback window — continuing in-memory');
      emitAlertChecked(
        this.instanceName,
        'fallback_persist_failed',
        'Failed to persist fallback window — will not survive restart',
        `until=${new Date(until).toISOString()} reason=${persistReason}`,
      );
    }
    // Pre-flight is gated to first arms (fresh activation or post-restart
    // restore). An extension re-arm changes nothing about the target entry's
    // environment, and per-turn usage-limit extensions would otherwise
    // re-spawn every probe and re-fire every pre-flight alert — an
    // unthrottled storm under sustained load.
    if (!firstArm) return true;
    // Pre-flight: check key presence and probe validity; never blocks or reverts
    // the window — fail-open on anything except a definitive 401/403.
    const service = resolveProviderKeyService(
      fallbackEntry.provider,
      fallbackEntry.model,
      fallbackProviderConfigFor(fallbackEntry.provider, this.agentProvider, this.agentProviderConfig),
    );
    if (service) {
      const key = lookupCredential(service);
      if (!key) {
        log.warn({
          instanceName: this.instanceName,
          fallbackProvider: fallbackEntry.provider,
          fallbackModel: fallbackEntry.model,
        }, 'fallback provider key not found in keyring — opencode sessions will fail auth');
        if (!selection.selectedHadMissingCredential) {
          emitAlertChecked(
            this.instanceName,
            'fallback_credential_missing',
            'Fallback provider key not found in keyring',
            `service=${service} provider=${fallbackEntry.provider} model=${fallbackEntry.model}`,
          );
        }
      } else {
        void verifyFallbackCredential(service, key).then((result) => {
          if (result !== 'invalid') return;
          log.error({ service, fallbackProvider: fallbackEntry.provider }, 'fallback credential rejected by provider (401/403)');
          emitAlertChecked(
            this.instanceName,
            'fallback_credential_invalid',
            'Fallback API key rejected by provider',
            `service=${service} provider=${fallbackEntry.provider} model=${fallbackEntry.model}`,
          );
        });
      }
    }
    // Pre-flight: check binary presence for CLI-backed fallback providers.
    // Managed-loop providers (openai-api, anthropic-api) have no binary to probe.
    // Never blocks or reverts the window — fail-open on anything except ENOENT.
    const fallbackBinary = getProviderBinary(fallbackEntry.provider);
    if (fallbackBinary) {
      void probeFallbackBinary(fallbackBinary).then((r) => {
        if (r.status === 'missing') {
          log.error(
            { fallbackProvider: fallbackEntry.provider, binary: fallbackBinary },
            'fallback provider binary not found on this host',
          );
          emitAlertChecked(
            this.instanceName,
            'fallback_binary_missing',
            'Fallback provider binary not found on this host',
            `binary=${fallbackBinary} provider=${fallbackEntry.provider} model=${fallbackEntry.model}`,
          );
        } else if (r.status === 'present') {
          if (r.version) {
            log.info(
              { fallbackProvider: fallbackEntry.provider, binary: fallbackBinary, version: r.version },
              'fallback provider binary present',
            );
          }
          // Pre-flight: check the configured model against the provider's model
          // catalog. Model ids are case-sensitive on the provider side and a
          // wrong-case id fails every session with an opaque error, so warn the
          // operator now instead of at first-turn failure. opencode-cli only —
          // it is the one CLI provider whose `models` output we parse.
          // Fire-and-forget, fail-open: never blocks or reverts the window.
          if (fallbackEntry.model && fallbackEntry.provider === 'opencode-cli') {
            const fallbackModel = fallbackEntry.model;
            void probeModelCatalog(fallbackBinary, fallbackModel).then((catalog) => {
              if (catalog.status !== 'not_found') return;
              log.error(
                {
                  fallbackProvider: fallbackEntry.provider,
                  fallbackModel,
                  catalogSuggestion: catalog.suggestion,
                },
                'fallback model not found in provider catalog — sessions will fail until corrected',
              );
              emitAlertChecked(
                this.instanceName,
                'fallback_model_unknown',
                'Fallback model not found in provider catalog',
                `model=${fallbackModel}`
                  + (catalog.suggestion ? ` suggestion=${catalog.suggestion}` : '')
                  + ` provider=${fallbackEntry.provider}`,
              );
            });
          }
        }
      });
    }
    return true;
  }

  /**
   * Re-arm a persisted fallback window after a process restart. Never throws —
   * a corrupt, missing, or stale row is cleared and startup proceeds on the primary.
   * loadFallbackState returns null for both "no row" and "bad-typed row" (SQLite
   * affinity can store TEXT in INTEGER columns); clearing on null ensures corrupt
   * rows do not linger across restarts.
   */
  private restorePersistedFallbackWindow(): void {
    try {
      ensureFallbackStateSchema(this.db);
      const persisted = loadFallbackState(this.db);
      if (!persisted) {
        clearFallbackState(this.db);
        return;
      }
      if (this.agentFallbacks.length === 0 || persisted.activeUntil <= Date.now()) {
        clearFallbackState(this.db);
        return;
      }
      // Clamp the restored window so a clock-skew or tampered row cannot pin
      // the fallback for longer than MAX_FALLBACK_WINDOW_MS from now.
      const clampedUntil = Math.min(persisted.activeUntil, Date.now() + MAX_FALLBACK_WINDOW_MS);
      // Resume the stall clock BEFORE re-arming: the persisted attempts feed
      // both the re-persist inside armFallbackWindow and the restore alert's
      // evidence. Without this, every restart reset the count to zero and a
      // dead primary could extend forever without ever reaching the stall
      // threshold (restarts happen more often than 12 recheck cadences).
      this.fallbackProbeAttempts = Number.isFinite(persisted.probeAttempts) ? persisted.probeAttempts : 0;
      // Pass persisted.reason so the original cause survives the restart, and
      // restored:true so the resumed window is not re-counted as an
      // activation — provider_fallback_activated already fired when the
      // window first armed; the resume emits provider_fallback_restored.
      const restored = this.armFallbackWindow(clampedUntil, persisted.reason, persisted.activatedAt, { restored: true });
      if (!restored) {
        clearFallbackState(this.db);
        return;
      }
      const wasClamped = clampedUntil < persisted.activeUntil;
      log.info({
        activeUntil: new Date(clampedUntil).toISOString(),
        ...(wasClamped ? { persistedUntil: new Date(persisted.activeUntil).toISOString() } : {}),
        originalReason: persisted.reason,
      }, 'restored provider-fallback window from persisted state');
    } catch (err) {
      log.warn({ err }, 'failed to restore persisted fallback window');
    }
  }

  /**
   * Activate provider fallback after the primary provider cannot serve a turn.
   *
   * No-op unless a fallback provider is configured. The window ends at the
   * parsed `resetAt` when available, else `DEFAULT_FALLBACK_WINDOW_MS` from now,
   * clamped to [MIN_FALLBACK_WINDOW_MS, MAX_FALLBACK_WINDOW_MS]. Idempotent: a
   * second activation while already active extends the window to the later of
   * the two. Schedules an auto-revert timer (unref'd so it never keeps the
   * process alive).
   */
  private activateProviderFallback(
    resetAt: Date | null,
    reason: ProviderFallbackReason = 'usage-limit',
  ): ProviderFallbackActivation | null {
    if (this.agentFallbacks.length === 0) return null;

    const now = Date.now();
    const rawUntil = resetAt ? resetAt.getTime() : now + DEFAULT_FALLBACK_WINDOW_MS;
    const clampedUntil = Math.min(
      now + MAX_FALLBACK_WINDOW_MS,
      Math.max(now + MIN_FALLBACK_WINDOW_MS, rawUntil),
    );
    // Extend rather than shorten an already-active window.
    const until = this.fallbackWindow.activeUntil
      ? Math.max(this.fallbackWindow.activeUntil, clampedUntil)
      : clampedUntil;

    const wasActive = this.fallbackWindow.activeUntil !== null;
    // Preserve the original first-engagement time across extensions so the
    // persisted record always reflects when the fallback was first triggered,
    // not when it was last extended.
    const activatedAt = wasActive && this.fallbackWindow.activatedAt !== null
      ? this.fallbackWindow.activatedAt
      : now;
    // Pass the original cause on extension so the root cause is preserved;
    // on first activation fallbackArmReason is null so armFallbackWindow
    // stores 'usage-limit' as the original cause.
    const persistedReason = wasActive && this.fallbackWindow.armReason !== null ? this.fallbackWindow.armReason : reason;
    this.fallbackWindow.resetAt = resetAt?.getTime() ?? null;
    const armed = this.armFallbackWindow(until, persistedReason, activatedAt);
    if (!armed) return null;
    const fallbackEntry = this.fallbackWindow.activeEntry;
    if (!fallbackEntry) return null;
    const keyPresent = this.fallbackKeyPresent(fallbackEntry.provider, fallbackEntry.model);

    log.info({
      instanceName: this.instanceName,
      primaryProvider: this.agentProvider,
      fallbackProvider: fallbackEntry.provider,
      fallbackModel: fallbackEntry.model,
      fallbackChain: this.fallbackChain.snapshot(this.agentFallbacks),
      resetAt: resetAt ? resetAt.toISOString() : null,
      activeUntil: new Date(until).toISOString(),
      extended: wasActive,
      keyPresent,
      recoveryProbeRequired: this.fallbackWindow.recoveryProbeRequired,
      reason,
    }, 'activating provider fallback after primary provider failure');

    return {
      primaryProvider: this.agentProvider,
      fallbackProvider: fallbackEntry.provider,
      fallbackModel: fallbackEntry.model,
      reason,
      resetAt,
      activeUntil: until,
      extended: wasActive,
      keyPresent,
      recoveryProbeRequired: this.fallbackWindow.recoveryProbeRequired,
    };
  }

  /** Clear the fallback window + timer, reverting new sessions to the primary provider. */
  private deactivateProviderFallback(reason: string): void {
    if (this.revertTimer) {
      clearTimeout(this.revertTimer);
      this.revertTimer = null;
    }
    if (this.fallbackPrimaryProbeTimer) {
      clearTimeout(this.fallbackPrimaryProbeTimer);
      this.fallbackPrimaryProbeTimer = null;
    }
    if (this.fallbackWindow.activeUntil === null) return;
    // Capture before clearing: the revert alert reports how long the window
    // ran. The idempotency guard above means this fires once per window.
    const windowMs = this.fallbackWindow.activatedAt !== null ? Date.now() - this.fallbackWindow.activatedAt : null;
    // Per-window deltas against the arm-time snapshots — the lifetime counters
    // are NOT reset here (getFallbackState keeps reporting process totals).
    const { served: windowTurnsServed, empty: windowTurnsEmpty } = this.fallbackMetrics.windowDeltas();
    // Slice-4 observability: one auto_fallback_cleared per window. Recovery
    // restores QUIETLY — the record is /why-retrievable, not a user notice
    // (UH-003).
    this.emitRouteEventChecked({
      event: 'auto_fallback_cleared',
      conversationKey: null,
      provider: this.fallbackWindow.activeEntry?.provider ?? this.agentProvider,
      modelRef: this.fallbackWindow.activeEntry?.model ?? null,
      source: 'auto_fallback',
      userVisible: false,
      reasonCode: reason,
    });
    this.fallbackWindow.activeUntil = null;
    this.fallbackWindow.activatedAt = null;
    this.fallbackWindow.armReason = null;
    this.fallbackWindow.activeEntry = null;
    this.fallbackChain.failedKeys.clear();
    this.fallbackEmptyAdvance.reset();
    this.fallbackWindow.resetAt = null;
    this.fallbackWindow.recoveryProbeRequired = false;
    // End of the stall episode (covers both successful-probe reverts and
    // manual/elapsed deactivations) — the next episode counts from zero and
    // may alert again at the threshold. fallbackLastProbeAt is kept as
    // historical observability, mirroring lastFallbackTurnAt.
    this.fallbackProbeAttempts = 0;
    try {
      clearFallbackState(this.db);
    } catch (err) {
      log.warn({ err }, 'failed to clear persisted fallback state');
    }
    log.info({
      instanceName: this.instanceName,
      primaryProvider: this.agentProvider,
      reason,
    }, 'reverting to primary provider');
    this.fallbackMetrics.recordRevert();
    // A revert is a RECOVERY, not a fault: the window ran its course (or was
    // manually disabled) and new sessions are back on the primary provider.
    // It carries useful per-window telemetry (turns served/empty, duration) so
    // it stays an emitted source rather than a bare clear — but at `info`, not
    // the emitAlertChecked `critical` default. Paging an operator to
    // "investigate/remediate" a healthy revert is pure noise (it was firing
    // critical for clean window-elapsed cycles). The matching FAULT alert —
    // provider_fallback_activated — keeps its critical default.
    emitAlertChecked(
      this.instanceName,
      'provider_fallback_reverted',
      'Provider fallback window ended — reverted to primary provider',
      `reason=${reason} turnsServed=${windowTurnsServed} turnsEmpty=${windowTurnsEmpty}`
        + ` windowMs=${windowMs ?? 'unknown'}`,
      'info',
    );
    // Recovery clears the activation incident this window opened. Mirrors the
    // primary_model_unusable → clear pairing above; a clear of a non-open
    // incident is a downstream no-op, so this is safe across restarts and
    // manual disables alike.
    clearAlertSourceChecked(
      this.instanceName,
      'provider_fallback_activated',
      `reason=${reason} windowMs=${windowMs ?? 'unknown'}`,
    );
  }

  private handleFallbackRevertTimer(): void {
    if (this.fallbackWindow.activeUntil === null) return;
    if (!this.fallbackWindow.recoveryProbeRequired) {
      this.deactivateProviderFallback('window-elapsed');
      return;
    }
    this.fallbackLastProbeAt = Date.now();
    // The probe spawns a child process; fire-and-forget with the result
    // driving deactivate-or-extend in the resolution. While the probe is in
    // flight (≤5 s) the window shows expired — acceptable: the previous
    // spawnSync froze the WHOLE event loop for the same duration, forever on
    // a dead auth primary.
    const windowAtProbe = this.fallbackWindow.activeUntil;
    void Promise.resolve()
      .then(() => this.probePrimaryProviderRecovered())
      .catch((err) => {
        // probePrimaryProviderRecovered never throws by contract; this guards
        // test stubs and future edits — a throwing probe is a failed probe.
        log.warn({ err }, 'primary provider recovery probe threw — treating as failed');
        return false;
      })
      .then((recovered) => {
        // Stale-result guards: drop the probe outcome if the window was
        // deactivated or re-armed while the probe was in flight (a stale
        // extend would shorten a fresh window; the next cadence re-probes).
        if (this.fallbackWindow.activeUntil === null || this.fallbackWindow.activeUntil !== windowAtProbe) return;
        if (recovered) {
          this.deactivateProviderFallback('primary-probe-ok');
          return;
        }
        this.fallbackProbeAttempts += 1;
        const now = Date.now();
        const until = now + PROVIDER_FALLBACK_PRIMARY_RECHECK_MS;
        this.fallbackWindow.activeUntil = until;
        this.revertTimer = setTimeout(() => {
          this.handleFallbackRevertTimer();
        }, PROVIDER_FALLBACK_PRIMARY_RECHECK_MS);
        this.revertTimer.unref?.();
        try {
          saveFallbackState(this.db, {
            activeUntil: until,
            activatedAt: this.fallbackWindow.activatedAt ?? now,
            reason: this.fallbackWindow.armReason ?? 'auth-required',
            // Persist the stall clock with the window so a restart mid-stall
            // resumes the count instead of resetting it.
            probeAttempts: this.fallbackProbeAttempts,
          });
        } catch (err) {
          log.warn({ err }, 'failed to extend persisted fallback window after failed recovery probe');
        }
        // Stall alert at threshold and every subsequent multiple (T, 2T, 3T ...).
        // Re-alerting on multiples surfaces a long-running stall without
        // drowning operators with per-probe noise. The counter only resets on
        // deactivation. Extension continues regardless — surfacing must never
        // strand the instance on a dead primary.
        const T = PROVIDER_FALLBACK_PROBE_STALL_THRESHOLD;
        const atts = this.fallbackProbeAttempts;
        if (atts === T || (atts > T && (atts - T) % T === 0)) {
          emitAlertChecked(
            this.instanceName,
            'fallback_recovery_stalled',
            'Primary provider recovery probe is stalled — fallback window extending indefinitely',
            `reason=${this.fallbackWindow.armReason ?? 'auth-required'} attempts=${atts} `
              + `windowEnd=${new Date(until).toISOString()} primaryProvider=${this.agentProvider}`,
          );
        }
        // No scheduleFallbackPrimaryProbe() here: the extension window equals the
        // recheck cadence, so this timer IS the probe cadence. Re-arming the
        // standing probe alongside it produced a double-probe (two probes per
        // cadence); the standing probe's guard makes it a no-op in this state.
        log.warn({
          instanceName: this.instanceName,
          primaryProvider: this.agentProvider,
          fallbackProvider: this.fallbackWindow.activeEntry?.provider,
          reason: this.fallbackWindow.armReason,
          probeAttempts: this.fallbackProbeAttempts,
        }, 'primary provider recovery probe still failing; keeping fallback armed');
      });
  }

  /**
   * Standing early-recovery probe. Its only purpose is to revert BEFORE a long
   * window (e.g. the 5h usage-limit default) elapses; once the remaining window
   * is within one recheck cadence the revert timer itself probes on the same
   * cadence, so arming this timer too would double-probe — the guard below
   * makes it a no-op in that state (the revert-timer path is authoritative).
   */
  private scheduleFallbackPrimaryProbe(): void {
    if (this.fallbackPrimaryProbeTimer) {
      clearTimeout(this.fallbackPrimaryProbeTimer);
      this.fallbackPrimaryProbeTimer = null;
    }
    if (!this.fallbackWindow.recoveryProbeRequired) return;
    if (
      this.fallbackWindow.activeUntil === null
      || this.fallbackWindow.activeUntil - Date.now() <= PROVIDER_FALLBACK_PRIMARY_RECHECK_MS
    ) {
      return;
    }
    this.fallbackPrimaryProbeTimer = setTimeout(() => {
      this.fallbackPrimaryProbeTimer = null;
      if (this.fallbackWindow.activeUntil === null || !this.fallbackWindow.recoveryProbeRequired) return;
      this.fallbackLastProbeAt = Date.now();
      const windowAtProbe = this.fallbackWindow.activeUntil;
      void Promise.resolve()
        .then(() => this.probePrimaryProviderRecovered())
        .catch((err) => {
          log.warn({ err }, 'primary provider recovery probe threw — treating as failed');
          return false;
        })
        .then((recovered) => {
          if (
            this.fallbackWindow.activeUntil === null ||
            !this.fallbackWindow.recoveryProbeRequired ||
            this.fallbackWindow.activeUntil !== windowAtProbe
          ) return;
          if (recovered) {
            this.deactivateProviderFallback('primary-probe-ok');
            return;
          }
          this.scheduleFallbackPrimaryProbe();
        });
    }, PROVIDER_FALLBACK_PRIMARY_RECHECK_MS);
    this.fallbackPrimaryProbeTimer.unref?.();
  }

  private schedulePrimaryModelUsabilityProbe(trigger: 'startup' | 'manual'): void {
    const target = {
      provider: this.agentProvider,
      model: this.model ?? null,
    };
    this.primaryModelUsability = {
      status: 'unknown',
      provider: target.provider,
      model: target.model,
      reason: 'probe-in-flight',
      checkedAt: this.primaryModelUsability?.checkedAt ?? null,
      probeInFlight: true,
    };

    const adapters = createPrimaryModelProbeAdapters(this.agentProviderConfig, {
      cwd: this.cwd ?? homedir(),
    });
    void Promise.resolve()
      .then(() => probePrimaryModelUsability(target, adapters))
      .then((result) => this.recordPrimaryModelUsability(result, trigger))
      .catch((err) => {
        log.warn({ err, provider: target.provider, model: target.model }, 'primary model usability probe threw');
        this.recordPrimaryModelUsability({
          status: 'unknown',
          provider: target.provider,
          model: target.model,
          reason: 'probe-threw',
        }, trigger);
      });
  }

  private recordPrimaryModelUsability(
    result: PrimaryModelUsabilityResult,
    trigger: 'startup' | 'manual',
  ): void {
    this.primaryModelUsability = {
      ...result,
      checkedAt: Date.now(),
      probeInFlight: false,
    };

    if (result.status === 'usable') {
      if (this.primaryModelUsabilityAlertActive) {
        clearAlertSourceChecked(
          this.instanceName,
          'primary_model_unusable',
          `provider=${alertEvidenceValue(result.provider)} model=${alertEvidenceValue(result.model)}`,
        );
        this.primaryModelUsabilityAlertActive = false;
      }
      return;
    }

    if (!primaryModelUsabilityRequiresAlert(result)) return;

    this.primaryModelUsabilityAlertActive = true;
    emitAlertChecked(
      this.instanceName,
      'primary_model_unusable',
      'Primary model usability probe failed',
      this.primaryModelUsabilityEvidence(result, trigger),
      'warning',
    );
  }


  private primaryModelUsabilityEvidence(
    result: PrimaryModelUsabilityResult,
    trigger: 'startup' | 'manual',
  ): string {
    const parts = [
      `trigger=${trigger}`,
      `status=${alertEvidenceValue(result.status)}`,
      `provider=${alertEvidenceValue(result.provider)}`,
      `model=${alertEvidenceValue(result.model)}`,
    ];
    if (result.reason) parts.push(`reason=${alertEvidenceValue(result.reason)}`);
    if (result.suggestion) parts.push(`suggestion=${alertEvidenceValue(result.suggestion)}`);
    return parts.join(' ');
  }

  /**
   * Probe whether the primary provider can serve again. Recovery requires a
   * real model-usability success, not credential presence: a revoked API key or
   * expired OAuth token can still be present in the key store while live turns
   * continue returning auth failures. The probe is timeout-bounded and never
   * rejects.
   */
  private async probePrimaryProviderRecovered(): Promise<boolean> {
    const result = await probePrimaryModelUsability(
      { provider: this.agentProvider, model: this.model ?? null },
      createPrimaryModelProbeAdapters(this.agentProviderConfig, { cwd: this.cwd ?? homedir() }),
    );
    return result.status === 'usable';
  }

  /**
   * Registry-driven entry point for a terminal result's text. Returns true if
   * the text classified as a provider failure and was fully handled (the caller
   * must `break`); false if it is not a provider failure (caller falls through
   * to normal result handling). Gated by {@link responseRegistryDispatchEnabled}.
   */
  private dispatchProviderFailureResult(ctx: ProviderFailureResultContext): boolean {
    const wf = workflowForProviderText(ctx.providerText);
    // Not a provider failure, OR a class-only failure whose providerKind is null
    // (server-error → provider_server_error, transient-network →
    // provider_network_error). handleProviderFailureResult only acts on a
    // non-null providerKind, so a null-kind workflow here would otherwise be a
    // silent no-op (lost user notice, lost ops alert, lost recordTurnFailure).
    // Return false so the caller falls through to the legacy ladders, which own
    // the notice/alert/turn-failure handling for these two kinds.
    if (!wf || wf.providerKind === null) return false;
    this.handleProviderFailureResult(wf, ctx);
    return true;
  }

  /**
   * Execute the response workflow for a terminal provider-failure result —
   * the single, behaviour-preserving replacement for the six hand-rolled
   * `providerFailureKind === …` branches in both result handlers. Only invoked
   * with a workflow whose `providerKind` is non-null (the provider-text path).
   */
  private handleProviderFailureResult(wf: ResponseWorkflow, ctx: ProviderFailureResultContext): void {
    const { queue, session, providerText, turnHadToolWork, logChatJid } = ctx;
    const kind = wf.providerKind;
    // Defensive: dispatchProviderFailureResult already filters null-providerKind
    // (class-only) workflows out of the text path and routes them to the legacy
    // ladders, so this is unreachable via dispatch. Kept as a guard against a
    // future direct caller — never silently no-op a null kind here.
    if (kind === null) return;
    ctx.recordTurnFailure(kind);
    const textPreview = providerText.slice(0, 300);

    // Non-arming, kill-and-respawn classes: context-overflow surfaces a notice,
    // policy-block stays silent. Neither activates a fallback.
    if (!wf.fallback.arms) {
      if (wf.userTemplate === 'context-overflow') {
        log.warn({ chatJid: logChatJid, textPreview }, 'prompt too long — killing session');
        queue.enqueueText(contextOverflowNotice());
      } else {
        log.error({ chatJid: logChatJid, textPreview }, 'suppressed provider policy-block message from result — session will be killed');
      }
      this.cleanupUsageLimitTurn(queue, ctx.cleanupArgs);
      session?.shutdown();
      return;
    }

    // Arming classes: usage-limit / auth-required / rate-limit / model-unavailable.
    const reason = kind as ProviderFallbackReason;
    log.warn({ chatJid: logChatJid, textPreview }, armingFailureLogMessage(reason));
    // Best-effort diagnostics (opt-in) — fire-and-forget, never blocks the turn.
    if (diagnosticBundleEnabled()) this.kickDiagnosticBundle(wf, providerText);
    const resetAt = reason === 'usage-limit' ? extractUsageLimitResetTime(providerText) : null;
    const activation = wf.fallback.markActiveEntryFailedOnTrigger
      ? this.activateProviderFallbackAfterTerminalResult(resetAt, reason, session, providerText)
      : this.activateProviderFallback(resetAt, reason);
    const replayScheduled = activation
      ? this.scheduleFallbackReplay({
          activation,
          chatJid: queue.targetChatJid,
          ...(ctx.scheduleReplayMapKey !== undefined ? { mapKey: ctx.scheduleReplayMapKey } : {}),
          oldSession: session,
          hadToolActivity: turnHadToolWork,
        })
      : false;
    if (activation) {
      this.notifyProviderFallbackActivated(queue, activation, {
        replayScheduled,
        blockedByToolActivity: turnHadToolWork,
      });
    }
    this.cleanupUsageLimitTurn(queue, ctx.cleanupArgs);
    if (!replayScheduled) {
      // usage-limit and auth-required each emit a standalone notice when no
      // fallback armed (QR-211); rate-limit / model-unavailable stay silent here
      // — this central path is only reached under WHATSOUP_RESPONSE_REGISTRY_DISPATCH=1.
      if (reason === 'usage-limit' && !activation) queue.enqueueText(this.usageLimitNotice());
      if (reason === 'auth-required' && !activation) this.emitNoFallbackReauthNotice(queue);
      session?.shutdown();
    }
  }

  /**
   * Best-effort diagnostics for an arming provider failure. Builds the probe map
   * from this runtime's capabilities, runs the bundle, and emits the findings to
   * the alert outbox as operator observability. Fully fire-and-forget: it never
   * throws into the turn, never blocks the fallback path, and surfaces only a
   * redacted digest (probe summaries are pre-redacted by their probes).
   */
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
        runPrimaryModelUsability: () => probePrimaryModelUsability(
          { provider: this.agentProvider, model: this.model ?? null },
          createPrimaryModelProbeAdapters(this.agentProviderConfig, { cwd: this.cwd ?? homedir() }),
        ),
        runPrimaryRecoveryProbe: () => this.probePrimaryProviderRecovered(),
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
            HOME: process.env['HOME'],
            PATH: process.env['PATH'],
            USER: process.env['USER'],
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
      if (now - recordedAt > PROVIDER_FALLBACK_NOTICE_DEDUP_MS) {
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
    const collapse = oneMessageHandoffEnabled()
      && replay.replayScheduled
      && !replay.blockedByToolActivity
      && activation.keyPresent !== false;
    if (collapse && this.stashHandoffNotice(queue.targetChatJid, message, now)) {
      return;
    }
    queue.enqueueText(message);
  }

  /** Stash the handoff notice for prepend-on-first-reply. Returns false on failure. */
  private stashHandoffNotice(chatJid: string, message: string, now: number): boolean {
    try {
      stashStandbyNotice(this.db, toConversationKey(chatJid), message, now);
      return true;
    } catch (err) {
      log.warn({ err, chatJid }, 'failed to stash handoff notice — sending standalone');
      return false;
    }
  }

  /**
   * Prepend a pending handoff notice (if any) to a stand-in reply, collapsing the
   * fallback notice and the reply into one message. No-op when the flag is off or
   * no notice is pending. Never throws into the reply path.
   */
  private withHandoffPrefix(chatJid: string, text: string): string {
    if (!oneMessageHandoffEnabled()) return text;
    let prefix: string | null = null;
    try {
      prefix = consumeStandbyNotice(this.db, toConversationKey(chatJid));
    } catch (err) {
      log.warn({ err, chatJid }, 'failed to consume handoff notice');
      return text;
    }
    return prefix ? `${prefix}\n\n${text}` : text;
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

  /**
   * Flush a still-pending handoff notice as a standalone message at turn end.
   * Closes the empty-turn gap: if the stand-in's turn produced no visible reply,
   * {@link withHandoffPrefix} never consumed the notice, so it would otherwise
   * defer to the next reply. Consume-once means this is a no-op when a reply
   * already prepended the notice this turn. Never throws into the turn.
   */
  private flushPendingHandoffNotice(queue: IOutboundQueue): void {
    if (!oneMessageHandoffEnabled()) return;
    let pending: string | null = null;
    try {
      pending = consumeStandbyNotice(this.db, toConversationKey(queue.targetChatJid));
    } catch (err) {
      log.warn({ err, chatJid: queue.targetChatJid }, 'failed to flush pending handoff notice');
      return;
    }
    if (pending) queue.enqueueText(pending);
  }

  private recreatePerChatSessionForFallback(mapKey: string, chatJid: string, actorJid?: string): void {
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
      onEvent: (event) => {
        const currentMapKey = resolveSessionMapKey();
        if (!currentMapKey) {
          log.debug({ mapKey, chatJid, eventType: event.type }, 'event dropped — fallback session key missing');
          return;
        }
        this.handleEventPerChat(currentMapKey, event, toolScopeKey);
      },
      onCrash: (info) => {
        const currentMapKey = resolveSessionMapKey() ?? mapKey;
        this.handlePerChatCrash(currentMapKey, chatJid, info);
      },
      notifyUser: (msg) => this.handleCrashNotify(msg, chatJid),
      onResumeFailed: () => this.handleResumeFailed(chatJid),
    });
    this.chatSessions.set(mapKey, session);
    if (!this.chatQueues.has(mapKey)) {
      this.chatQueues.set(mapKey, this.createOutboundQueue(chatJid, 'fallback per-chat session replacement'));
    }
    const tracker = this.createOperationTracker(session, () => this.chatQueues.get(mapKey));
    if (tracker) this.operationTrackers.set(mapKey, tracker);
  }

  private recreateSingletonSessionForFallback(chatJid: string, actorJid?: string): void {
    this.operationTracker?.shutdown();
    this.operationTracker = null;
    this.session = this.createSessionManager({
      chatJid,
      cwd: this.cwd,
      actorJid,
      trackSingletonMcpSession: true,
      onEvent: (event) => this.handleEvent(event),
      onCrash: (info) => {
        this.recordCrash(GLOBAL_CRASH_SCOPE_KEY);
        this.getActiveQueue()?.abortTurn();
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
    });
    this.activeChatJid = chatJid;
    if (this.shared) {
      this.ensureOutboundQueue(chatJid);
    } else if (!this.queue) {
      this.queue = this.createOutboundQueue(chatJid, 'fallback single session replacement');
    }
    this.operationTracker = this.createOperationTracker(this.session, () => this.getActiveQueue());
  }

  private scheduleFallbackReplay(args: {
    activation: ProviderFallbackActivation;
    chatJid: string;
    mapKey?: string;
    oldSession: SessionManager | null;
    hadToolActivity?: boolean;
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
      args.activation.extended
      || args.activation.keyPresent === false
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

    // Past every gate: the replay dispatches. Once-per-activation by the
    // extended-guard above (extensions never reach this point). The replayed
    // counter + alert report a COMPLETED replay, so they fire only after the
    // dispatch resolves — emitting before the await meant a rejected replay
    // produced success AND failure telemetry for the same turn.
    // Known limitation: sendTurnToSession swallows STDIN_WRITE_TIMEOUT
    // (notifies the user, resolves normally), so that delivery failure still
    // lands in the success branch here — fixing it means changing
    // sendTurnToSession's contract for ALL callers, tracked separately.
    void this.replayTurnOnFallback({
      chatJid: args.chatJid,
      mapKey: args.mapKey,
      replayText,
      actorJid,
      oldSession: args.oldSession,
    }).then(() => {
      this.fallbackMetrics.recordReplay();
      // A completed replay is a HEALTHY lifecycle event: the interrupted turn
      // was successfully handed off to the fallback provider. Not operator-
      // actionable — downgraded to 'info' (BE-G3 gap 2). The failure branch
      // below keeps its critical default (a failed replay IS actionable).
      emitAlertChecked(
        this.instanceName,
        'provider_fallback_replayed',
        'Interrupted turn replayed on fallback provider',
        `reason=${args.activation.reason} provider=${args.activation.fallbackProvider} model=${args.activation.fallbackModel ?? 'default'}`,
        'info',
      );
    }).catch((err) => {
      log.error({
        err,
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
    });
    return true;
  }

  private async replayTurnOnFallback(args: {
    chatJid: string;
    mapKey?: string;
    replayText: string;
    actorJid?: string;
    oldSession: SessionManager | null;
  }): Promise<void> {
    if (args.oldSession) {
      await args.oldSession.shutdown(false);
    }
    if (args.mapKey !== undefined) {
      // F-STICKY-ACTOR (QR-247): the fallback kills the child (active=false, so
      // onCrash never fires) and replays on a fresh session. Clear the executing-actor
      // queue so the old in-flight turn's actor cannot linger as HEAD; the replay
      // re-pushes via sendTurnPerChat -> sendTurnToSession.
      this.perChatExecActorQueue.delete(args.mapKey);
      this.chatSessions.delete(args.mapKey);
      this.recreatePerChatSessionForFallback(args.mapKey, args.chatJid, args.actorJid);
      await this.sendTurnPerChat(args.chatJid, args.replayText, args.mapKey, args.actorJid);
      return;
    }
    this.recreateSingletonSessionForFallback(args.chatJid, args.actorJid);
    this.currentTurnChatJid = args.chatJid;
    this.bindActiveGlobalMcpConversation(args.chatJid);
    this.turnHadVisibleOutput = false;
    this.currentTurnReplayText = args.replayText;
    this.currentTurnReplayActorJid = args.actorJid;
    await this.sendTurnToSession(this.session!, args.chatJid, args.replayText, undefined, args.actorJid);
  }

  /**
   * providerConfig handed to a new SessionManager.
   *
   * The custom-endpoint fields (`baseUrl`/`apiKeyService`) belong to the
   * PRIMARY provider+model: an opencode session serving a fallback entry must
   * not inherit them, or the custom-endpoint argv contract (omit `-m` when a
   * baseUrl is configured) would drop the entry's model and re-route the turn
   * to the primary's endpoint block — or to opencode's default model when no
   * block was written for the entry. Every other providerConfig key (budget,
   * model, …) keeps applying to all sessions, and managed-loop API fallback
   * sessions keep full inheritance (same-provider API fallback deliberately
   * honors the primary's endpoint and apiKeyService).
   */
  private sessionProviderConfig(): Record<string, unknown> | undefined {
    const selected = this.effectiveProviderConfig;
    if (!selected) return undefined;
    if (this.effectiveFallbackEntry === null || this.effectiveProvider !== 'opencode-cli') {
      return selected;
    }
    const { baseUrl: _baseUrl, apiKeyService: _apiKeyService, ...rest } = selected;
    return rest;
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
    cwd: string | undefined;
    actorJid?: string;
    trackSingletonMcpSession?: boolean;
    onEvent: (event: AgentEvent) => void;
    onCrash: (info: SessionCrashInfo) => void;
    notifyUser: (msg: string) => void;
    onResumeFailed?: () => void;
    mcpSocketPath?: string;
    providerConfigOverride?: Record<string, unknown>;
  }): SessionManager {
    const conversationKey = toConversationKey(opts.chatJid);
    // Slice-2 routing wiring (flag-gated): preferences steer the session being
    // spawned; flag off keeps the exact base expressions below.
    const route = config.nlRouting ? this.resolveRouteForTurn(opts.chatJid, opts.actorJid) : null;
    if (route) this.noteRouteAtSpawn(opts.chatJid, conversationKey, route);
    // F-STICKY-ACTOR (QR-247 hardening): wire the per-chat actor socket HERE — the
    // single choke point every spawn path (ensure / proactive-resume / provider-
    // fallback) flows through — keyed on the session's ACTUAL provider, not the
    // instance-global one. A fallback to a non-claude provider tears the socket down.
    const sessionProvider = route ? route.provider : this.effectiveProvider;
    const perChatWire = this.wirePerChatActorSocket(opts.chatJid, sessionProvider);
    const mcpSocketPath = opts.mcpSocketPath ?? perChatWire?.mcpSocketPath;
    const providerConfigOverride = opts.providerConfigOverride ?? perChatWire?.providerConfigOverride;
    if (this.sessionScope === 'per_chat' && !this.sandboxPerChat && sessionProvider === 'claude-cli' && !mcpSocketPath) {
      // Fail-closed sentinel: an eligible claude-cli per_chat session with no actor
      // socket would silently reinstate the QR-247 confused-deputy race on the shared
      // global socket. Refuse rather than spawn unbound.
      throw new Error(`F-STICKY-ACTOR (QR-247): per_chat claude-cli session for ${conversationKey} would spawn without an actor-bound socket`);
    }
    const providerToolSession: SessionContext =
      this.sandboxPerChat || this.sessionScope === 'per_chat'
        ? {
            tier: 'chat-scoped',
            conversationKey,
            deliveryJid: opts.chatJid,
            ...(opts.actorJid ? { actorJid: opts.actorJid } : {}),
            ...(opts.cwd ? { allowedRoot: opts.cwd } : {}),
          }
        : {
            tier: 'global',
            ...(opts.actorJid ? { actorJid: opts.actorJid } : {}),
            ...(!this.shared ? { conversationKey } : {}),
        };
    if (opts.trackSingletonMcpSession) {
      this.singletonProviderToolSession = providerToolSession;
    }

    const session = new SessionManager({
      db: this.db,
      messenger: this.messenger,
      chatJid: opts.chatJid,
      onEvent: opts.onEvent,
      instanceName: this.instanceName,
      onResumeFailed: opts.onResumeFailed,
      onCrash: opts.onCrash,
      notifyUser: opts.notifyUser,
      cwd: opts.cwd,
      configRoot: this.sandboxPerChat && opts.cwd ? join(opts.cwd, '.agent-home') : undefined,
      configSystemPrompt: this.configSystemPrompt,
      instructionsPath: this.instructionsPath,
      model: route ? route.model : this.effectiveModel,
      pluginDirs: this.pluginDirs,
      allowM365Mutations: this.allowM365Mutations,
      provider: route ? route.provider : this.effectiveProvider,
      providerConfig: providerConfigOverride
        ? { ...(route ? this.routeSessionProviderConfig(route) : this.sessionProviderConfig()), ...providerConfigOverride }
        : (route ? this.routeSessionProviderConfig(route) : this.sessionProviderConfig()),
      mcpBridge: createProviderMcpBridge(this.registry, providerToolSession),
      mcpSessionContext: providerToolSession,
      whatsoupInstance: this.instanceName,
      whatsoupMcpSocket: mcpSocketPath ?? this.globalMcpSocketPath ?? undefined,
      handoffSystemBlock: this.buildHandoffSystemBlock(conversationKey, route ? route.provider : this.effectiveProvider),
      routingSystemBlock: config.nlRouting ? () => this.buildRoutingContractBlock(route ? route.provider : this.effectiveProvider) : undefined,
    });
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

    this.chatSessions.delete(workspaceKey);
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
        const mcpServerPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/mcp/whatsoup-proxy.ts');
        const sendMediaServerPath = resolve(new URL('.', import.meta.url).pathname, '../../../deploy/mcp/send-media-server.ts');
        const chatScopedToolNames = this.registry.getChatScopedToolNames();
        const providerConfig =
          this.effectiveProvider === 'opencode-cli' && this.effectiveFallbackEntry === null
            ? this.primaryOpencodeProviderConfig()
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
            socketServer = new WhatSoupSocketServer(socketPath, this.registry, chatSession);
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

        // Check for resumable session
        const resumable = getResumableSessionForChat(this.db, workspaceKey);

        // Create SessionManager with workspace-scoped cwd
        const toolScopeKey = this.createToolScopeKey(workspaceKey);
        const session = this.createSessionManager({
          chatJid,
          cwd: workspacePath,  // scoped cwd instead of this.cwd
          actorJid,
          mcpSocketPath: socketPath,
          onEvent: (event) => this.handleEventPerChat(workspaceKey, event, toolScopeKey),
          onCrash: (info) => this.handlePerChatCrash(workspaceKey, chatJid, info),
          notifyUser: (msg) => {
            // Only remove session from map if it's actually dead (crash/exit).
            // Watchdog warnings fire on ACTIVE sessions — removing those breaks
            // event routing and causes cascading false-idle notifications.
            const s = this.chatSessions.get(workspaceKey);
            if (s && !s.getStatus().active) {
              this.chatSessions.delete(workspaceKey);
              this.chatQueues.get(workspaceKey)?.abortTurn();
              this.chatQueues.delete(workspaceKey);
              this.cleanupPerChatState(workspaceKey);
            }
            this.handleCrashNotify(msg, chatJid);
          },
          onResumeFailed: () => this.handleResumeFailed(chatJid),
        });
        log.info({ chatJid, workspaceKey, workspacePath }, 'created sandbox per-chat session manager');
        this.chatSessions.set(workspaceKey, session);
        const chatQ = this.createOutboundQueue(chatJid, 'sandbox per-chat session init');
        this.chatQueues.set(workspaceKey, chatQ);

        // Wire operation tracker for this sandbox session
        const tracker = this.createOperationTracker(session, () => this.chatQueues.get(workspaceKey));
        if (tracker) this.operationTrackers.set(workspaceKey, tracker);

        // Spawn with resume if available — fall back to fresh session if resume fails
        if (resumable) {
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
          cwd: this.cwd,
          actorJid,
          onEvent: (event) => {
            const mapKey = resolveSessionMapKey();
            if (!mapKey) {
              log.debug({ initialMapKey, chatJid, eventType: event.type }, 'event dropped — session key missing for per-chat callback');
              return;
            }
            this.handleEventPerChat(mapKey, event, toolScopeKey);
          },
          onCrash: (info) => {
            const mapKey = resolveSessionMapKey() ?? initialMapKey;
            this.handlePerChatCrash(mapKey, chatJid, info);
          },
          notifyUser: (msg) => {
            // Only remove session from map if it's actually dead (crash/exit).
            // Watchdog warnings fire on ACTIVE sessions — removing those breaks
            // event routing and causes cascading false-idle notifications.
            const mapKey = resolveSessionMapKey();
            if (mapKey) {
              const s = this.chatSessions.get(mapKey);
              if (s && !s.getStatus().active) {
                this.chatSessions.delete(mapKey);
                this.chatQueues.get(mapKey)?.abortTurn();
                this.chatQueues.delete(mapKey);
                this.cleanupPerChatState(mapKey);
              }
            }
            this.handleCrashNotify(msg, chatJid);
          },
        });
        log.info({ chatJid, mapKey: initialMapKey, sessionScope: this.sessionScope }, 'created per-chat session manager');
        this.chatSessions.set(initialMapKey, session);
        const perChatQ = this.createOutboundQueue(chatJid, 'per-chat session init');
        this.chatQueues.set(initialMapKey, perChatQ);

        // Wire operation tracker for this per-chat session
        const tracker = this.createOperationTracker(session, () => this.chatQueues.get(initialMapKey));
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
      this.session = this.createSessionManager({
        chatJid,
        cwd: this.cwd,
        actorJid,
        trackSingletonMcpSession: true,
        onEvent: (event) => this.handleEvent(event),
        onCrash: (info) => {
          this.recordCrash(GLOBAL_CRASH_SCOPE_KEY);
          this.getActiveQueue()?.abortTurn();
          this.cleanupSharedCrashTurnState();
          // Mark inbound event failed so it doesn't stay stuck in processing
          if (this.durability && this.currentInboundSeq !== undefined) {
            this.markRuntimeFaultContinuityCandidate(this.currentInboundSeq);
            this.replyGuarantee?.disarm(this.currentInboundSeq);
            this.durability.markInboundFailed(this.currentInboundSeq, 'session_crash');
            this.currentInboundSeq = undefined;
          }
          if (config.controlPeers.size > 0) {
            try {
              emitHealReport(this.db, this.messenger, this.durability, {
                type: 'crash',
                chatJid,
                exitCode: info.exitCode ?? undefined,
                signal: info.signal ?? undefined,
                provider: info.provider,
                crashClass: info.crashClass,
                stderr: info.stderrPreview,
              }, this.activeControlReportId);
            } catch (err) {
              log.warn({ err }, 'failed to emit heal report for session crash');
            }
          }
        },
        notifyUser: (msg) => this.handleCrashNotify(msg),
      });
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

  private handlePerChatCrash(mapKey: string, chatJid?: string, info?: SessionCrashInfo): void {
    this.recordCrash(mapKey);
    const crashCount = this.getCrashCount(mapKey);
    this.chatQueues.get(mapKey)?.abortTurn();
    // Shutdown operation tracker for this crashed session
    this.operationTrackers.get(mapKey)?.shutdown();
    const seqQueue = this.perChatInboundSeqQueue.get(mapKey) ?? [];
    const inboundSeq = seqQueue[0];
    if (this.durability && inboundSeq !== undefined) {
      this.markRuntimeFaultContinuityCandidate(inboundSeq);
      this.replyGuarantee?.disarm(inboundSeq);
      this.durability.markInboundFailed(inboundSeq, 'session_crash');
      seqQueue.shift();
    }
    this.cleanupPerChatCrashTurnState(mapKey);
    if (config.controlPeers.size > 0 && chatJid) {
      try {
        emitHealReport(this.db, this.messenger, this.durability, {
          type: 'crash',
          chatJid,
          exitCode: info?.exitCode ?? undefined,
          signal: info?.signal ?? undefined,
          provider: info?.provider,
          crashClass: info?.crashClass,
          stderr: info?.stderrPreview,
        }, this.activeControlReportId);
      } catch (err) {
        log.warn({ err }, 'failed to emit heal report for session crash');
      }
    }

    // Auto-respawn: if we haven't hit the crash limit, try to resume the session
    // after a short delay. This lets the agent continue mid-conversation without
    // requiring the user to send a new message.
    if (crashCount <= AUTO_RESPAWN_MAX_CRASHES && info?.sessionId) {
      const session = this.chatSessions.get(mapKey);
      if (session) {
        const sessionId = info.sessionId;
        const dbRowId = info.dbRowId;
        const crashedAtSec = Math.floor(Date.now() / 1000);
        const delayMs = jitteredDelay(AUTO_RESPAWN_BASE_MS, crashCount - 1, AUTO_RESPAWN_MAX_DELAY_MS);
        log.info({ mapKey, sessionId, attempt: crashCount, delayMs }, 'scheduling auto-respawn');
        const timer = setTimeout(() => {
          this.pendingRespawnTimers.delete(timer);
          // Verify the session is still in the map and still inactive
          const current = this.chatSessions.get(mapKey);
          if (!current || current !== session || current.getStatus().active) return;

          log.info({ mapKey, sessionId }, 'auto-respawn: attempting resume');
          session.spawnSession(sessionId, dbRowId ?? undefined).then(async () => {
            await sleep(1_000);
            if (!session.getStatus().active) return;
            clearAlertSourceChecked(this.instanceName, 'agent_respawn_failed');
            try {
              // Inject messages that arrived during the crash window
              if (chatJid) {
                const injected = await this.injectMissedMessages(session, chatJid, crashedAtSec);
                if (injected) this.pendingSystemResults.mark(mapKey);
              }
              this.pendingSystemResults.mark(mapKey);
              await session.sendTurn('[System: session resumed after crash ��� continue where you left off]');
              log.info({ mapKey }, 'sent continuation turn after auto-respawn');
            } catch (err) {
              log.warn({ err, mapKey }, 'failed to send continuation turn after auto-respawn');
              // Continuation send failed — no result will arrive for its mark.
              this.pendingSystemResults.unmark(mapKey);
            }
          }).catch((err) => {
            log.warn({ err, mapKey, sessionId }, 'auto-respawn resume failed — will retry on next message');
          });
        }, delayMs);
        this.pendingRespawnTimers.add(timer);
      }
    } else if (crashCount > AUTO_RESPAWN_MAX_CRASHES) {
      log.error({ mapKey, crashes: crashCount }, 'auto-respawn exhausted — emitting alert');
      emitAlertChecked(
        this.instanceName,
        'agent_respawn_failed',
        `whatsoup@${this.instanceName} agent respawn exhausted (${crashCount} crashes)`,
        [
          `Chat: ${mapKey}`,
          `Last exit: code=${info?.exitCode ?? '?'} signal=${info?.signal ?? 'none'}`,
          `Provider: ${info?.provider ?? 'unknown'}`,
          `Crash class: ${info?.crashClass ?? 'unknown'}`,
          info?.stderrPreview ? `Stderr preview: ${info.stderrPreview.slice(-500)}` : null,
        ].filter(Boolean).join('\n'),
      );
    }
  }

  private cleanupSharedCrashTurnState(): void {
    this.activeToolNames.clear();
    this.turnHadToolActivity.clear();
    this.singleTurnHadToolActivity = false;
    this.turnHadVisibleOutput = false;
    this.turnHadSuppressedReplySatisfaction = false;
    this.currentTurnChatJid = null;
    this.currentTurnReplayText = null;
    this.currentTurnReplayActorJid = undefined;
    this.currentTurnInboundContentType = null;
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
  private handleCrashNotify(msg: string, chatJid?: string): void {
    // In per_chat mode, chatJid MUST be passed — this.queue is not set.
    // In single/shared mode, chatJid is optional (falls back to shared fields).
    const queue = chatJid ? this.getQueueForChat(chatJid) : this.queue;
    if (queue) {
      queue.enqueueText(msg);
      queue.flush().catch((err) => log.error({ err }, 'flush after crash failed'));
    } else {
      const target = chatJid ?? this.activeChatJid;
      if (target) {
        this.messenger
          .sendMessage(target, msg)
          .catch((err) => log.error({ err }, 'crash notice fallback send failed'));
      }
    }
  }

  private formatRecoveryTimestamp(unixMs: number): string {
    const d = new Date(unixMs * 1000); // timestamps are unix seconds
    return d.toTimeString().slice(0, 5); // HH:MM
  }

  /**
   * Format chat messages into the `[HH:MM] sender: content` lines injected as
   * recent-context into a fresh/stand-in session. Single source of truth for
   * that line shape (previously duplicated across the three injection sites).
   * Caller controls ordering — getRecentMessages is reverse-chronological (pass
   * a reversed copy), getMessagesSince is already chronological.
   *
   * Cross-provider safety: while a fallback window is active the target session
   * is a DIFFERENT provider than the conversation originated on, so message
   * content is scrubbed of secret shapes (tokens, keys, Bearer, emails) before
   * it crosses the provider boundary. Same-provider respawns inject verbatim —
   * the content was already seen by that provider, so there is no new exposure.
   */
  private formatContextLines(
    messages: ReadonlyArray<{ timestamp: number; senderName: string | null; senderJid: string; content: string | null }>,
  ): string {
    const redactForBackup = this.isFallbackWindowActive;
    return messages
      .map((m) => {
        const content = m.content ?? '[media]';
        const safe = redactForBackup ? sanitizeProviderPreviewText(content) : content;
        return `[${this.formatRecoveryTimestamp(m.timestamp)}] ${m.senderName ?? m.senderJid}: ${safe}`;
      })
      .join('\n');
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
  ): Promise<boolean> {
    try {
      const convKey = canonicalConversationKey(chatJid, this.db);
      const missed = getMessagesSince(this.db, convKey, sinceUnixSec, 30);
      if (missed.length === 0) return false;

      const lines = this.formatContextLines(missed);
      await session.sendTurn(`[Recent chat context — read before responding]\n${lines}`);
      log.info({ chatJid, messageCount: missed.length, sinceUnixSec }, 'injected missed messages after resume');
      return true;
    } catch (err) {
      log.warn({ err, chatJid }, 'missed message injection failed — agent continues without context');
      return false;
    }
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

    if (!pendingText) {
      // No pending message — notify user to resend
      const msg = '_Previous session expired_ — starting fresh. Send a message to begin.';
      if (this.pendingStartupMessage !== null) {
        this.pendingStartupMessage = { chatJid, text: msg };
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
    session
      .spawnSession()
      .then(async () => {
        // Re-check the session reference after spawn — race condition guard. The crash
        // callback (notifyUser) may have deleted it from chatSessions during spawn.
        // Continuing with an orphaned reference would send turns to a dead session.
        if (mapKey) {
          const currentSession = this.chatSessions.get(mapKey);
          if (!currentSession || currentSession !== session) {
            log.warn({ chatJid, mapKey }, 'handleResumeFailed: session was replaced or removed during spawn — aborting replay');
            this.resumeFailedHandling.delete(mapKey);
            return;
          }
        }

        // context injection + replay wrapped in turnChain to preserve serialization
        this.turnChain = this.turnChain.then(async () => {
          // Clear the resumeFailedHandling flag once we are inside the chain —
          // the context injection below is about to run, after which concurrent
          // sendTurnToSession calls may inject normally.
          if (mapKey) this.resumeFailedHandling.delete(mapKey);

          try {
            const recent = getRecentMessages(this.db, canonicalConversationKey(chatJid, this.db), 30);
            if (recent.length > 0) {
              const lines = this.formatContextLines(recent.reverse());
              // QR-095: same fix as the sendTurnToSession injection — in single/
              // shared mode mapKey is undefined here, so mark under GLOBAL to match
              // the single/shared consumeIfPending(GLOBAL_TOOL_SCOPE_KEY); otherwise
              // the '[CONTEXT RECOVERY]' system turn's result leaks to the user.
              // No-op in per_chat (mapKey defined, consumed per-chat).
              this.pendingSystemResults.mark(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
              await session.sendTurn(`[CONTEXT RECOVERY — prior session expired]\n${lines}`);
            }
          } catch (err) {
            log.warn({ err, chatJid }, 'context recovery failed — starting blank session');
            // Context-recovery send failed — no result will arrive for its mark.
            this.pendingSystemResults.unmark(mapKey ?? GLOBAL_TOOL_SCOPE_KEY);
          }

          // Replay the pending turn that was lost during the failed resume
          if (pendingText && mapKey) {
            log.info({ chatJid, mapKey, textPreview: pendingText.slice(0, 80) }, 'replaying pending turn after resume failure');
            try {
              await session.sendTurn(pendingText);
            } catch (err) {
              log.warn({ err, chatJid }, 'pending turn replay failed');
              this.pendingTurnText.delete(mapKey);
              this.pendingTurnActorJid.delete(mapKey);
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

  private handleEvent(event: AgentEvent): void {
    // Route to current turn's chat in shared mode, or the single queue in non-shared mode
    const queue = this.shared
      ? (this.currentTurnChatJid ? this.outboundQueues.get(this.currentTurnChatJid) ?? null : null)
      : this.queue;

    if (!queue) return;

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
          log.info({ textPreview: event.text.slice(0, 200) }, 'post-turn gate: suppressed phantom assistant_text (shared)');
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
          if (this.suppressStreamedProviderFailure(normalizedText, this.shared ? this.currentTurnChatJid : this.activeChatJid)) break;
          normalizedText = this.gateAssistantTextForOutbound(normalizedText, queue, this.currentInboundSeq);
          if (!normalizedText) break;
          queue.enqueueStreamingText(normalizedText);
          this.turnHadVisibleOutput = true;
          // Reply-guarantee: visible output reached the user — reset the silence
          // window so the "still working" fallback only fires after a full window
          // of TRUE silence, not while a long turn is actively streaming replies.
          this.replyGuarantee?.notifyActivity(queue.targetChatJid);
          // Accumulate text for voice reply (SP4)
          this.currentTurnAssistantText += normalizedText;
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
        if (event.isError) {
          const toolName = toolNames?.get(event.toolId) ?? 'unknown';
          const errorPreview = event.content.length > 200 ? event.content.slice(0, 200) + '...' : event.content;
          log.warn({
            chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid,
            toolId: event.toolId,
            toolName,
            error: errorPreview,
          }, 'tool error reported by agent');
          const classification = classifyToolError(toolName, event.content);
          queue.enqueueToolUpdate(classification);
          this.maybeEmitToolFailureAlert({
            chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid,
            toolId: event.toolId,
            toolName,
            content: event.content,
            classification,
            toolScopeKey: GLOBAL_TOOL_SCOPE_KEY,
          });
        }
        toolNames?.delete(event.toolId);
        if (toolNames && toolNames.size === 0) {
          this.activeToolNames.delete(GLOBAL_TOOL_SCOPE_KEY);
        }
        break;

      case 'result': {
        const wasSilentCompact = this.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
        // R1: flush any held first-line marker buffer at turn end (see the
        // per-chat handler) — registers a marker-only / no-newline intent and
        // delivers whatever remains. No-op when nothing was held.
        if (config.nlRouting && this.currentTurnRouteMarkerHold !== null) {
          const heldMarker = this.currentTurnRouteMarkerHold;
          this.currentTurnRouteMarkerHold = null;
          const tail = this.flushRouteMarker(
            heldMarker,
            (this.shared ? this.currentTurnChatJid : this.activeChatJid) ?? queue.targetChatJid,
            this.currentTurnReplayActorJid,
          );
          if (tail) {
            queue.enqueueStreamingText(tail);
            this.turnHadVisibleOutput = true;
            this.currentTurnAssistantText += tail;
          }
        }
        const hadCompactBoundary = this.consumeCompactBoundary(GLOBAL_TOOL_SCOPE_KEY);
        this.session?.clearTurnWatchdog();
        tracker?.onTurnComplete();
        // Turn-end choke point: clear the typing indicator unconditionally so no
        // early-break branch below can leave 'composing' asserted into the idle
        // persistent session. Idempotent with the normal-path queue.flush().
        queue.endTurn();
        // Provider-reported turn cost: log it beside the token counts and
        // accumulate it while a fallback window is active.
        this.recordTurnCostUsd(event);
        const turnHadToolWork = this.singleTurnHadToolActivity;
        this.clearToolNames(GLOBAL_TOOL_SCOPE_KEY);

        // System-turn results (auto-compact /compact, manual /compact) must not
        // arm the post-turn gate — otherwise the next real turn's output is
        // suppressed as phantom (the per_chat bug, same class, single mode).
        // Mirror handleEventPerChat: the GLOBAL pending-system counter is
        // incremented by maybeStartAutoCompact / handleAgentCommand. Shared mode
        // never increments GLOBAL (auto-compact early-returns), so this is a
        // no-op there.
        const isSystemResult = this.pendingSystemResults.consumeIfPending(GLOBAL_TOOL_SCOPE_KEY);

        // AskUserQuestion poll bridge is per_chat only — no pending-poll
        // suppression in shared mode. Normal result lifecycle applies.
        // Activate post-turn gate — suppress any SDK-injected events until next user turn
        if (!isSystemResult) {
          this.postTurnGate.add(GLOBAL_TOOL_SCOPE_KEY);
        }
        const isUserTurnResult = !isSystemResult && !wasSilentCompact;
        let turnCapabilityFailureRecorded = false;
        const recordTurnFailure = (errorClass: TurnCapabilityErrorClass): void => {
          this.recordTurnCapabilityFailure(isUserTurnResult, errorClass);
          turnCapabilityFailureRecorded = turnCapabilityFailureRecorded || isUserTurnResult;
        };

        // Render result.text if present (e.g. terminal context-limit errors)
        if (event.text) {
          if (this.enqueueAutoSwitchNotice(queue, event.text, this.shared ? this.currentTurnChatJid : this.activeChatJid, 'result')) {
            this.turnHadVisibleOutput = true;
            break;
          }
          if (responseRegistryDispatchEnabled() && this.dispatchProviderFailureResult({
            queue,
            session: this.session,
            providerText: event.text,
            turnHadToolWork,
            logChatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid,
            cleanupArgs: {
              inboundSeq: this.currentInboundSeq,
              conversationKey: toConversationKey(queue.targetChatJid),
              clearCurrentInboundSeq: true,
            },
            recordTurnFailure,
          })) {
            break;
          }
          const providerFailureKind = classifyProviderFailure(event.text);
          // Suppress usage-limit messages — log and kill session instead of forwarding
          if (providerFailureKind === 'usage-limit') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed usage-limit message from result — session will be killed');
            // Route the auto-respawned next session to the fallback provider
            // (if configured) until the limit resets, before tearing down.
            const activation = this.activateProviderFallbackAfterTerminalResult(
              extractUsageLimitResetTime(event.text),
              'usage-limit',
              this.session,
              event.text,
            );
            const replayScheduled = activation
              ? this.scheduleFallbackReplay({
                  activation,
                  chatJid: queue.targetChatJid,
                  oldSession: this.session,
                  hadToolActivity: turnHadToolWork,
                })
              : false;
            if (activation) {
              this.notifyProviderFallbackActivated(queue, activation, {
                replayScheduled,
                blockedByToolActivity: turnHadToolWork,
              });
            }
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq: this.currentInboundSeq,
              conversationKey: toConversationKey(queue.targetChatJid),
              clearCurrentInboundSeq: true,
            });
            if (!replayScheduled) {
              if (!activation) queue.enqueueText(this.usageLimitNotice());
              this.session?.shutdown();
            }
            this.singleTurnHadToolActivity = false;
            break;
          }
          if (providerFailureKind === 'policy-block') {
            recordTurnFailure(providerFailureKind);
            log.error({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider policy-block message from result — session will be killed');
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq: this.currentInboundSeq,
              conversationKey: toConversationKey(queue.targetChatJid),
              clearCurrentInboundSeq: true,
            });
            this.session?.shutdown();
            break;
          }
          if (providerFailureKind === 'auth-required') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider auth-required message from result — session will be shut down');
            const activation = this.activateProviderFallbackAfterTerminalResult(
              null,
              'auth-required',
              this.session,
              event.text,
            );
            const replayScheduled = activation
              ? this.scheduleFallbackReplay({
                  activation,
                  chatJid: queue.targetChatJid,
                  oldSession: this.session,
                  hadToolActivity: turnHadToolWork,
                })
              : false;
            if (activation) {
              this.notifyProviderFallbackActivated(queue, activation, {
                replayScheduled,
                blockedByToolActivity: turnHadToolWork,
              });
            }
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq: this.currentInboundSeq,
              conversationKey: toConversationKey(queue.targetChatJid),
              clearCurrentInboundSeq: true,
            });
            if (!replayScheduled) {
              // QR-211: no fallback took over — without this, the turn ends in
              // permanent silence (session shuts down, nothing forwarded to chat).
              if (!activation) this.emitNoFallbackReauthNotice(queue);
              this.session?.shutdown();
            }
            this.singleTurnHadToolActivity = false;
            break;
          }
          if (providerFailureKind === 'rate-limit' || providerFailureKind === 'server-error') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, textPreview: event.text.slice(0, 300) }, armingFailureLogMessage(providerFailureKind));
            const activation = this.activateProviderFallbackAfterTerminalResult(
              null,
              providerFailureKind,
              this.session,
              event.text,
            );
            const replayScheduled = activation
              ? this.scheduleFallbackReplay({
                  activation,
                  chatJid: queue.targetChatJid,
                  oldSession: this.session,
                  hadToolActivity: turnHadToolWork,
                })
              : false;
            if (activation) {
              this.notifyProviderFallbackActivated(queue, activation, {
                replayScheduled,
                blockedByToolActivity: turnHadToolWork,
              });
            }
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq: this.currentInboundSeq,
              conversationKey: toConversationKey(queue.targetChatJid),
              clearCurrentInboundSeq: true,
            });
            if (!replayScheduled) {
              if (!activation && providerFailureKind === 'server-error') queue.enqueueText(providerUnknownTerminalNotice());
              this.session?.shutdown();
            }
            this.singleTurnHadToolActivity = false;
            break;
          }
          if (providerFailureKind === 'model-unavailable') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider model-unavailable message from result — session will be shut down');
            const activation = this.activateProviderFallback(null, 'model-unavailable');
            const replayScheduled = activation
              ? this.scheduleFallbackReplay({
                  activation,
                  chatJid: queue.targetChatJid,
                  oldSession: this.session,
                  hadToolActivity: turnHadToolWork,
                })
              : false;
            if (activation) {
              this.notifyProviderFallbackActivated(queue, activation, {
                replayScheduled,
                blockedByToolActivity: turnHadToolWork,
              });
            }
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq: this.currentInboundSeq,
              conversationKey: toConversationKey(queue.targetChatJid),
              clearCurrentInboundSeq: true,
            });
            if (!replayScheduled) this.session?.shutdown();
            this.singleTurnHadToolActivity = false;
            break;
          }
          // Context overflow — session is unsalvageable, kill and let next message respawn
          if (providerFailureKind === 'context-overflow') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, textPreview: event.text.slice(0, 300) }, 'prompt too long — killing session');
            queue.enqueueText(contextOverflowNotice());
            this.cleanupUsageLimitTurn(queue, {
              inboundSeq: this.currentInboundSeq,
              conversationKey: toConversationKey(queue.targetChatJid),
              clearCurrentInboundSeq: true,
            });
            this.session?.shutdown();
            break;
          }
          // Transient streaming-socket drop — recoverable, next message respawns the session.
          // Suppress raw provider text; emit a generic notice and a WARNING (not CRITICAL) alert.
          if (providerFailureKind === 'transient-network') {
            recordTurnFailure(providerFailureKind);
            log.warn({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, textPreview: event.text.slice(0, 300) }, 'transient provider connection drop — session will recover on next message');
            emitAlertChecked(
              this.instanceName,
              'provider_transient_network',
              'Transient provider connection drop (recoverable)',
              event.text.slice(0, 400),
              'warning',
            );
            queue.enqueueText(providerUnknownTerminalNotice());
            this.singleTurnHadToolActivity = false;
            break;
          }
          if (!wasSilentCompact) {
            if (event.isError) {
              recordTurnFailure('unknown-terminal');
              // Default-deny: is_error result with no recognised class = unknown terminal
              // provider error. Suppress the raw text; emit a generic notice + ops alert.
              log.error({ chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed unclassified terminal provider error from result — not forwarded to user');
              emitAlertChecked(
                this.instanceName,
                'provider_unknown_terminal',
                'Unclassified terminal provider error suppressed from user',
                event.text.slice(0, 400),
              );
              queue.enqueueText(providerUnknownTerminalNotice());
            } else {
              queue.enqueueResultText(this.withHandoffPrefix(queue.targetChatJid, event.text));
              this.turnHadVisibleOutput = true;
              // Accumulate result text for voice reply (SP4)
              this.currentTurnAssistantText += event.text;
            }
          }
        }
        this.currentTurnAssistantItemText.clear();
        const rowId = this.session?.getDbRowId() ?? null;
        const lastOpId = queue.getLastOpId();
        const hadSuppressedReplySatisfaction = this.turnHadSuppressedReplySatisfaction;
        this.turnHadSuppressedReplySatisfaction = false;
        let armedFallbackNow = false;
        if (!wasSilentCompact && !isSystemResult) {
          this.recordFallbackTurnOutcome(
            queue,
            this.turnHadVisibleOutput || hadSuppressedReplySatisfaction,
            turnHadToolWork,
            this.session,
          );
          // Empty/tool-only turn: surface any still-pending handoff notice
          // standalone rather than deferring it to the next reply.
          this.flushPendingHandoffNotice(queue);
          if (!turnCapabilityFailureRecorded) {
            if (this.turnHadVisibleOutput || turnHadToolWork || hadSuppressedReplySatisfaction) {
              this.recordTurnCapabilitySuccess(true);
            } else {
              this.recordTurnCapabilityFailure(true, 'empty-output');
              // QR-226: see the matching log.warn in handleEventWithContext — the
              // turnErrorCounts increment above is in-memory only, so without a
              // log line journal greps are blind to empty-output turns here too.
              log.warn(
                {
                  reason: 'empty-output',
                  chatJid: this.shared ? this.currentTurnChatJid : this.activeChatJid,
                  rowId,
                  turnHadToolWork,
                },
                'recorded empty-output turn failure',
              );
              armedFallbackNow = this.maybeArmFallbackAfterEmptyPrimaryTurn(queue, this.session, turnHadToolWork, undefined);
            }
          }
        }
        this.singleTurnHadToolActivity = false;
        // If nothing visible was emitted this turn, send an explicit fallback —
        // unless we just armed the provider fallback (its activation notice has
        // already informed the user and the turn is being replayed on the backup).
        if (!this.turnHadVisibleOutput && !hadSuppressedReplySatisfaction && !wasSilentCompact && !armedFallbackNow) {
          queue.enqueueText('_(no response)_');
        }
        this.turnHadVisibleOutput = false;
        this.currentTurnChatJid = null;
        this.currentTurnReplayText = null;
        this.currentTurnReplayActorJid = undefined;
        if (this.durability) {
          this.durability.completeTurn({
            ...((event.inputTokens !== undefined || event.outputTokens !== undefined) && rowId !== null
              ? {
                  sessionTokens: {
                    dbRowId: rowId,
                    inputTokens: event.inputTokens ?? 0,
                    outputTokens: event.outputTokens ?? 0,
                  },
                }
              : {}),
            ...(this.activeChatJid
              ? {
                  checkpoint: {
                    conversationKey: toConversationKey(this.activeChatJid),
                    fields: {
                      activeTurnId: null,
                      ...(this.currentInboundSeq !== undefined && { lastInboundSeq: this.currentInboundSeq }),
                      ...(lastOpId !== undefined && { lastFlushedOutboundId: lastOpId }),
                    },
                  },
                }
              : {}),
            // System-turn results must not terminate the user's inbound seq or
            // disarm its guarantee (see the per_chat handler). Not reachable in
            // single mode today (system results arrive with currentInboundSeq
            // cleared), but guarded for parity and future safety.
            ...(this.currentInboundSeq !== undefined && !isSystemResult
              ? {
                  inbound: {
                    seq: this.currentInboundSeq,
                    terminalReason: 'response_sent',
                  },
                }
              : {}),
            ...(lastOpId !== undefined ? { lastOpId } : {}),
          });
          if (!isSystemResult) this.replyGuarantee?.disarm(this.currentInboundSeq);
          if (this.currentInboundSeq !== undefined && !isSystemResult) {
            this.currentInboundSeq = undefined;
          }
          if (lastOpId !== undefined) {
            queue.markLastTerminal({
              dedupeText: event.isError === true && !wasSilentCompact,
              skipDurabilityMark: true,
            });
          }
        } else {
          if ((event.inputTokens !== undefined || event.outputTokens !== undefined) && rowId !== null) {
            accumulateTokensWithEvent(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
          }
          // Defense-in-depth: mark last op terminal so echo auto-complete fires if
          // the process crashes after send but before completeInbound runs.
          queue.markLastTerminal({ dedupeText: event.isError === true && !wasSilentCompact });
        }
        // Only advance the compact baseline when the SDK actually emitted a
        // compact_boundary. wasSilentCompact alone means "we suppressed
        // user-facing chrome for an auto-trigger" and doesn't prove /compact
        // succeeded — advancing on it silently disables auto-compact for
        // another threshold's worth of tokens. See the per_chat handler for
        // the parallel gate.
        if (!wasSilentCompact && !hadCompactBoundary && !isSystemResult) {
          this.recordAutoCompactNextTurnIfNeeded(GLOBAL_TOOL_SCOPE_KEY, event.inputTokens);
        }
        if (hadCompactBoundary && rowId !== null) {
          markSessionCompacted(this.db, rowId);
          this.recordAutoCompactSuccess(GLOBAL_TOOL_SCOPE_KEY);
        }
        if (wasSilentCompact || hadCompactBoundary) {
          this.finishAutoCompact(GLOBAL_TOOL_SCOPE_KEY);
        } else {
          this.maybeStartAutoCompact(this.session);
        }
        {
          // Capture voice reply context before flush (SP4)
          const chatJidForVoice = this.shared ? this.currentTurnChatJid : this.activeChatJid;
          const inboundContentType = this.currentTurnInboundContentType;
          const responseText = wasSilentCompact ? '' : this.currentTurnAssistantText;
          // Reset per-turn voice state
          this.currentTurnInboundContentType = null;
          this.currentTurnAssistantText = '';
          queue.flush()
            .then(() => {
              // Send voice reply after text is delivered (non-fatal, SP4)
              if (
                chatJidForVoice &&
                responseText &&
                config.voiceReply !== 'never' &&
                (config.voiceReply === 'always' || inboundContentType === 'audio')
              ) {
                return this._sendVoiceReply(chatJidForVoice, responseText);
              }
            })
            .catch((err) => log.error({ err }, 'flush or voice reply failed'));
        }
        if (wasSilentCompact) this.clearSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
        break;
      }

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
            accumulateTokensWithEvent(this.db, rowId, event.inputTokens ?? 0, event.outputTokens ?? 0);
          }
        }
        break;

      case 'ignored':
      case 'unknown':
      case 'parse_error':
        log.debug({ event }, 'ignored/unknown/parse_error event');
        break;
    }
  }

  private cleanupUsageLimitTurn(
    queue: IOutboundQueue,
    opts: {
      inboundSeq?: number;
      conversationKey?: string;
      mapKey?: string;
      clearCurrentInboundSeq?: boolean;
    } = {},
  ): void {
    const { inboundSeq, conversationKey, mapKey, clearCurrentInboundSeq = false } = opts

    // Per_chat: scope tool-state cleanup to this chat so a usage-limit turn in one
    // chat does not wipe another concurrent chat's in-flight tool state. Shared/single
    // scope has one logical session, so the blanket clear is correct there.
    if (mapKey !== undefined) {
      this.clearToolScopeFor(mapKey)
    } else {
      this.activeToolNames.clear()
      this.turnHadToolActivity.clear()
    }
    this.singleTurnHadToolActivity = false
    this.currentTurnChatJid = null
    this.turnHadVisibleOutput = false
    this.turnHadSuppressedReplySatisfaction = false
    this.currentTurnReplayText = null
    this.currentTurnReplayActorJid = undefined

    this.currentTurnInboundContentType = null
    this.currentTurnAssistantText = ''
    this.currentTurnAssistantItemText.clear()

    if (mapKey !== undefined) {
      this.perChatTurnContentType.delete(mapKey)
      this.perChatTurnText.delete(mapKey)
      this.perChatTurnSuppressedReplySatisfaction.delete(mapKey)
      this.perChatAssistantItemText.delete(mapKey)
    }

    if (this.durability && conversationKey) {
      this.durability.upsertSessionCheckpoint(conversationKey, {
        activeTurnId: null,
        ...(inboundSeq !== undefined && { lastInboundSeq: inboundSeq }),
        ...(queue.getLastOpId() !== undefined && { lastFlushedOutboundId: queue.getLastOpId() }),
      })
    }
    if (this.durability && inboundSeq !== undefined) {
      this.durability.completeInbound(inboundSeq, 'response_sent')
    }
    this.replyGuarantee?.disarm(inboundSeq)
    if (clearCurrentInboundSeq) {
      this.currentInboundSeq = undefined
    }

    queue.flush().catch((err) => log.error({ err }, 'usage-limit cleanup flush failed'))
  }
}
