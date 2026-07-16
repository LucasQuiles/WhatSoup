import { splitInputTokenUsage, type AgentEvent } from './stream-parser.ts';
import type { IOutboundQueue } from './outbound-queue.ts';
import type { SessionManager } from './session.ts';
import type { OperationTracker } from './operation-tracker.ts';
import type { Database } from '../../core/database.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import { config } from '../../config.ts';
import { GLOBAL_CONVERSATION_KEY, toConversationKey } from '../../core/conversation-key.ts';
import { classifyProviderFailure } from './failure-taxonomy.ts';
import { providerUnknownTerminalNotice, renderUserMessage } from './response-templates.ts';
import { emitAlertChecked } from '../../lib/emit-alert.ts';
import { accumulateTokensWithEvent, markSessionCompacted } from './session-db.ts';
import { createChildLogger } from '../../logger.ts';
import type { TurnCapabilityErrorClass } from './turn-capability-tracker.ts';
import { workflowForProviderText, type ResponseWorkflow } from './response-registry.ts';
import type { PendingPollStore } from './pending-poll-store.ts';
import type {
  PendingSystemResultTracker,
  SystemTurnPurpose,
} from './pending-system-result-tracker.ts';
import type { WorkspaceSweeper } from './workspace-sweeper.ts';
import type { RuntimeTurnCoordinator } from './runtime-turn-coordinator.ts';

const log = createChildLogger('agent-runtime');
const GLOBAL_TOOL_SCOPE_KEY = GLOBAL_CONVERSATION_KEY;

export type ProviderFallbackReason =
  | 'usage-limit'
  | 'rate-limit'
  | 'auth-required'
  | 'model-unavailable'
  | 'server-error'
  | 'empty-output'
  | 'probe-unusable';

export interface ProviderFallbackActivation {
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

function responseRegistryDispatchEnabled(): boolean {
  return process.env['WHATSOUP_RESPONSE_REGISTRY_DISPATCH'] === '1';
}

function fallbackReasonForResultText(text: string): ProviderFallbackReason | null {
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

function contextOverflowNotice(): string {
  return renderUserMessage('context-overflow', {
    hasContinuation: false,
    bundle: null,
    formatClock: (epochMs) => new Date(epochMs).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    }),
  });
}

type NoFallbackTerminalNoticeReason = 'rate-limit' | 'model-unavailable';

function enqueueNoFallbackTerminalNotice(
  queue: IOutboundQueue,
  reason: NoFallbackTerminalNoticeReason,
): void {
  queue.enqueueText(renderUserMessage(reason, {
    hasContinuation: false,
    bundle: null,
    formatClock: () => '',
  }));
}

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

export interface RuntimeResultHandlerPort {
  readonly runtimeTurnCoordinator: RuntimeTurnCoordinator;
  readonly db: Database;
  readonly durability: DurabilityEngine | null;
  readonly instanceName: string;
  readonly shared: boolean;
  readonly pendingPolls: PendingPollStore;
  readonly pendingSystemResults: PendingSystemResultTracker;
  readonly workspaceSweeper: WorkspaceSweeper;
  readonly postTurnGate: Set<string>;
  readonly turnHadToolActivity: Set<string>;
  readonly perChatRouteMarkerHold: Map<string, string>;
  readonly pendingTurnText: Map<string, string>;
  readonly pendingTurnActorJid: Map<string, string | undefined>;
  readonly perChatTurnText: Map<string, string>;
  readonly perChatAssistantItemText: Map<string, Map<string, string>>;
  readonly perChatTurnContentType: Map<string, string>;
  readonly perChatTurnSuppressedReplySatisfaction: Set<string>;
  readonly currentTurnAssistantItemText: Map<string, string>;
  session: SessionManager | null;
  activeChatJid: string | null;
  currentInboundSeq: number | undefined;
  currentTurnChatJid: string | null;
  currentTurnReplayText: string | null;
  currentTurnReplayActorJid: string | undefined;
  currentTurnRouteMarkerHold: string | null;
  currentTurnInboundContentType: string | null;
  currentTurnAssistantText: string;
  turnHadVisibleOutput: boolean;
  turnHadSuppressedReplySatisfaction: boolean;
  singleTurnHadToolActivity: boolean;
  readonly isFallbackWindowActive: boolean;
  isSilentCompact(scopeKey?: string): boolean;
  clearSilentCompact(scopeKey?: string): void;
  consumeCompactBoundary(scopeKey: string): boolean;
  finishAutoCompact(scopeKey: string): void;
  recordAutoCompactSuccess(scopeKey: string): void;
  recordAutoCompactNextTurnIfNeeded(
    scopeKey: string,
    inputTokens: number | undefined,
    consumeWhenNotOverThreshold?: boolean,
  ): void;
  maybeStartAutoCompact(session: SessionManager | null, mapKey?: string): void;
  flushRouteMarker(held: string | null, chatJid: string, actorJid: string | undefined): string | null;
  clearToolNames(toolScopeKey: string): void;
  recordTurnCostUsd(event: Extract<AgentEvent, { type: 'result' }>): void;
  recordTurnCapabilitySuccess(isUserTurnResult: boolean): void;
  recordTurnCapabilityFailure(
    isUserTurnResult: boolean,
    errorClass: TurnCapabilityErrorClass,
  ): void;
  recordFallbackTurnOutcome(
    queue: IOutboundQueue,
    hadVisibleOutput: boolean,
    hadToolWork?: boolean,
    session?: SessionManager | null,
  ): void;
  maybeArmFallbackAfterEmptyPrimaryTurn(
    queue: IOutboundQueue,
    session: SessionManager | null,
    turnHadToolWork: boolean,
    mapKey: string | undefined,
  ): boolean;
  enqueueAutoSwitchNotice(
    queue: IOutboundQueue,
    text: string,
    logChatJid: string | null | undefined,
    mode: 'streaming' | 'result',
  ): boolean;
  withHandoffPrefix(chatJid: string, text: string): string;
  flushPendingHandoffNotice(queue: IOutboundQueue): void;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: ProviderFallbackReason,
  ): ProviderFallbackActivation | null;
  activateProviderFallbackAfterTerminalResult(
    resetAt: Date | null,
    reason: ProviderFallbackReason,
    session: SessionManager | null,
    evidenceText?: string,
  ): ProviderFallbackActivation | null;
  scheduleFallbackReplay(args: {
    activation: ProviderFallbackActivation;
    chatJid: string;
    mapKey?: string;
    oldSession: SessionManager | null;
    hadToolActivity?: boolean;
  }): boolean;
  notifyProviderFallbackActivated(
    queue: IOutboundQueue,
    activation: ProviderFallbackActivation,
    replay?: { replayScheduled: boolean; blockedByToolActivity?: boolean },
  ): void;
  emitNoFallbackReauthNotice(queue: IOutboundQueue): void;
  usageLimitNotice(): string;
  kickDiagnosticBundle(workflow: ResponseWorkflow, providerText: string): void;
}

export interface ScopedRuntimeResultArgs {
  event: Extract<AgentEvent, { type: 'result' }>;
  queue: IOutboundQueue;
  session: SessionManager | null;
  conversationKey?: string;
  inboundSeq?: number;
  mapKey?: string;
  toolScopeKey: string;
  isSystemResult: boolean;
  systemTurnPurpose?: SystemTurnPurpose | null;
  tracker?: OperationTracker;
  extractUsageLimitResetTime(text: string): Date | null;
}

export function handleScopedRuntimeResult(
  host: RuntimeResultHandlerPort,
  args: ScopedRuntimeResultArgs,
): void {
  const {
    event,
    queue,
    session,
    conversationKey,
    inboundSeq,
    mapKey,
    toolScopeKey,
    isSystemResult,
    tracker,
    extractUsageLimitResetTime,
  } = args;
const wasSilentCompact = host.isSilentCompact(mapKey);
const runtimeContext = !isSystemResult && mapKey !== undefined
  ? host.runtimeTurnCoordinator.runtimeTurnContext(mapKey)
  : null;
const classifiedOutcome = host.runtimeTurnCoordinator.attemptOutcomeForResult(event);
const attemptOutcome = classifiedOutcome.kind === 'completed'
  && mapKey !== undefined
  && host.perChatTurnSuppressedReplySatisfaction.has(mapKey)
    ? { kind: 'suppressed_by_policy' as const }
    : classifiedOutcome;
const clearReplayOnSuccess = attemptOutcome.kind === 'completed'
  && (event.text === null || fallbackReasonForResultText(event.text) === null);
let voice: { chatJid: string; responseText: string; inboundContentType: string | null } | undefined;
try {
// R1: flush any held first-line marker buffer for this chat at turn
// end — a marker-only / no-newline reply registers its intent here and
// delivers whatever remains. No-op when nothing was held.
if (config.nlRouting) {
  const markerScanKey = mapKey ?? GLOBAL_TOOL_SCOPE_KEY;
  const heldMarker = host.perChatRouteMarkerHold.get(markerScanKey);
  if (heldMarker !== undefined) {
    host.perChatRouteMarkerHold.delete(markerScanKey);
    const flushActorJid = mapKey !== undefined ? host.pendingTurnActorJid.get(mapKey) : host.currentTurnReplayActorJid;
    const tail = host.flushRouteMarker(heldMarker, queue.targetChatJid, flushActorJid);
    if (tail) {
      queue.enqueueStreamingText(tail);
      host.runtimeTurnCoordinator.markRuntimeTurnReplayUnsafe(mapKey);
      if (mapKey !== undefined) host.perChatTurnText.set(mapKey, (host.perChatTurnText.get(mapKey) ?? '') + tail);
    }
  }
}
const compactScopeKey = mapKey ?? GLOBAL_TOOL_SCOPE_KEY;
const hadCompactBoundary = host.consumeCompactBoundary(compactScopeKey);
session?.completeProviderTurn();
tracker?.onTurnComplete();
// Turn-end choke point: clear the typing indicator unconditionally so no
// early-break branch below can leave 'composing' asserted into the idle
// persistent session. Idempotent with the normal-path queue.flush().
queue.endTurn();
// Provider-reported turn cost: log it beside the token counts and
// accumulate it while a fallback window is active.
host.recordTurnCostUsd(event);
// Capture before clearToolNames so the empty-turn check can read it.
const turnHadToolWork = host.turnHadToolActivity.has(toolScopeKey);
host.turnHadToolActivity.delete(toolScopeKey);
host.clearToolNames(toolScopeKey);
// Activate post-turn gate — suppress any SDK-injected events until next user turn
const hasPendingPoll = mapKey !== undefined && host.pendingPolls.questions.has(mapKey);
if (mapKey !== undefined) {
  if (hasPendingPoll) {
    // Do NOT gate — the turn is logically still open (waiting for poll vote).
    // Allow the poll vote handler to send the next turn.
    host.postTurnGate.delete(mapKey);
  } else if (!isSystemResult) {
    // Only genuine user-turn completions arm the gate. System-turn results
    // (context injection on respawn, resume continuation, auto-compact
    // /compact) are followed by — or resume — a real user turn whose
    // assistant_text/tool_use must NOT be suppressed as phantom. Arming
    // the gate on those silently dropped real replies (incl. send_message
    // / send_poll), so leave the gate state unchanged for system results.
    host.postTurnGate.add(mapKey);
  }
}
const isUserTurnResult = !isSystemResult && !hasPendingPoll && !wasSilentCompact;
let turnCapabilityFailureRecorded = false;
const recordTurnFailure = (errorClass: TurnCapabilityErrorClass): void => {
  host.recordTurnCapabilityFailure(isUserTurnResult, errorClass);
  turnCapabilityFailureRecorded = turnCapabilityFailureRecorded || isUserTurnResult;
};

if (event.text && !hasPendingPoll) {
  if (host.enqueueAutoSwitchNotice(queue, event.text, queue.targetChatJid, 'result')) return;
  if (responseRegistryDispatchEnabled() && dispatchProviderFailureResult(host, {
    queue,
    session,
    providerText: event.text,
    turnHadToolWork,
    logChatJid: queue.targetChatJid,
    scheduleReplayMapKey: mapKey,
    cleanupArgs: { inboundSeq, conversationKey, mapKey },
    recordTurnFailure,
  }, extractUsageLimitResetTime)) {
    return;
  }
  const providerFailureKind = classifyProviderFailure(event.text);
  // Suppress usage-limit messages — log and skip instead of forwarding
  if (providerFailureKind === 'usage-limit') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed usage-limit message from result — session will be killed');
    // Route the auto-respawned next session to the fallback provider
    // (if configured) until the limit resets, before tearing down.
    const activation = host.activateProviderFallbackAfterTerminalResult(
      extractUsageLimitResetTime(event.text),
      'usage-limit',
      session,
      event.text,
    );
    const replayScheduled = activation
      ? host.scheduleFallbackReplay({
          activation,
          chatJid: queue.targetChatJid,
          mapKey,
          oldSession: session,
          hadToolActivity: turnHadToolWork,
        })
      : false;
    if (activation) {
      host.notifyProviderFallbackActivated(queue, activation, {
        replayScheduled,
        blockedByToolActivity: turnHadToolWork,
      });
    }
    if (!replayScheduled) {
      if (!activation) queue.enqueueText(host.usageLimitNotice());
      session?.shutdown();
    }
    return;
  }
  if (providerFailureKind === 'policy-block') {
    recordTurnFailure(providerFailureKind);
    log.error({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider policy-block message from result — session will be killed');
    session?.shutdown();
    return;
  }
  if (providerFailureKind === 'auth-required') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider auth-required message from result — session will be shut down');
    const activation = host.activateProviderFallbackAfterTerminalResult(
      null,
      'auth-required',
      session,
      event.text,
    );
    const replayScheduled = activation
      ? host.scheduleFallbackReplay({
          activation,
          chatJid: queue.targetChatJid,
          mapKey,
          oldSession: session,
          hadToolActivity: turnHadToolWork,
        })
      : false;
    if (activation) {
      host.notifyProviderFallbackActivated(queue, activation, {
        replayScheduled,
        blockedByToolActivity: turnHadToolWork,
      });
    }
    if (!replayScheduled) {
      // QR-211: no fallback took over — without this, the turn ends in
      // permanent silence (session shuts down, nothing forwarded to chat).
      if (!activation) host.emitNoFallbackReauthNotice(queue);
      session?.shutdown();
    }
    return;
  }
  if (providerFailureKind === 'rate-limit' || providerFailureKind === 'server-error') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, armingFailureLogMessage(providerFailureKind));
    const activation = host.activateProviderFallbackAfterTerminalResult(
      null,
      providerFailureKind,
      session,
      event.text,
    );
    const replayScheduled = activation
      ? host.scheduleFallbackReplay({
          activation,
          chatJid: queue.targetChatJid,
          mapKey,
          oldSession: session,
          hadToolActivity: turnHadToolWork,
        })
      : false;
    if (activation) {
      host.notifyProviderFallbackActivated(queue, activation, {
        replayScheduled,
        blockedByToolActivity: turnHadToolWork,
      });
    }
    if (!replayScheduled) {
      if (!activation && providerFailureKind === 'server-error') queue.enqueueText(providerUnknownTerminalNotice());
      if (!activation && providerFailureKind === 'rate-limit') {
        enqueueNoFallbackTerminalNotice(queue, providerFailureKind);
      }
      session?.shutdown();
    }
    return;
  }
  if (providerFailureKind === 'model-unavailable') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider model-unavailable message from result — session will be shut down');
    const activation = host.activateProviderFallback(null, 'model-unavailable');
    const replayScheduled = activation
      ? host.scheduleFallbackReplay({
          activation,
          chatJid: queue.targetChatJid,
          mapKey,
          oldSession: session,
          hadToolActivity: turnHadToolWork,
        })
      : false;
    if (activation) {
      host.notifyProviderFallbackActivated(queue, activation, {
        replayScheduled,
        blockedByToolActivity: turnHadToolWork,
      });
    }
    if (!replayScheduled) {
      if (!activation) enqueueNoFallbackTerminalNotice(queue, providerFailureKind);
      session?.shutdown();
    }
    return;
  }
  // Context overflow — session is unsalvageable, kill and let next message respawn
  if (providerFailureKind === 'context-overflow') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'prompt too long — killing session');
    queue.enqueueText(contextOverflowNotice());
    session?.shutdown();
    return;
  }
  // Transient streaming-socket drop — recoverable, next message respawns the session.
  // Suppress raw provider text; emit a generic notice and a WARNING (not CRITICAL) alert.
  if (providerFailureKind === 'transient-network') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'transient provider connection drop — session will recover on next message');
    emitAlertChecked(
      host.instanceName,
      'provider_transient_network',
      'Transient provider connection drop (recoverable)',
      event.text.slice(0, 400),
      'warning',
    );
    queue.enqueueText(providerUnknownTerminalNotice());
    return;
  }
  if (!wasSilentCompact) {
    if (event.isError) {
      recordTurnFailure('unknown-terminal');
      // Default-deny: an is_error result with no recognised failure class is an
      // UNKNOWN terminal provider error. Never forward raw provider/CLI text to the
      // user — emit one generic notice and alert ops with the raw text.
      log.error({ chatJid: queue.targetChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed unclassified terminal provider error from result — not forwarded to user');
      emitAlertChecked(
        host.instanceName,
        'provider_unknown_terminal',
        'Unclassified terminal provider error suppressed from user',
        event.text.slice(0, 400),
      );
      queue.enqueueText(providerUnknownTerminalNotice());
    } else {
      queue.enqueueResultText(host.withHandoffPrefix(queue.targetChatJid, event.text));
      host.runtimeTurnCoordinator.markRuntimeTurnReplayUnsafe(mapKey);
      // Accumulate result text for voice reply (SP4)
      if (mapKey !== undefined) {
        host.perChatTurnText.set(mapKey, (host.perChatTurnText.get(mapKey) ?? '') + event.text);
      }
    }
  }
}
if (mapKey !== undefined) {
  host.perChatAssistantItemText.delete(mapKey);
}
host.workspaceSweeper.touch(mapKey);
const rowId = session?.getDbRowId() ?? null;
if (!runtimeContext && (event.inputTokens !== undefined || event.outputTokens !== undefined) && rowId !== null) {
  {
    const { newInputTokens, cacheReadTokens } = splitInputTokenUsage(event);
    accumulateTokensWithEvent(host.db, rowId, newInputTokens, event.outputTokens ?? 0, cacheReadTokens);
  }
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
  host.recordAutoCompactNextTurnIfNeeded(mapKey, event.inputTokens);
}
if (hadCompactBoundary && rowId !== null) {
  markSessionCompacted(host.db, rowId);
  host.recordAutoCompactSuccess(compactScopeKey);
}
if (wasSilentCompact || hadCompactBoundary) {
  host.finishAutoCompact(compactScopeKey);
} else if (runtimeContext) {
  host.runtimeTurnCoordinator.appendRuntimeTurnAfterTerminalAction(
    runtimeContext,
    () => host.maybeStartAutoCompact(session, mapKey),
  );
} else {
  host.maybeStartAutoCompact(session, mapKey);
}
{
  // Capture voice reply context before flush (SP4)
  const chatJidForVoice = queue.targetChatJid;
  const inboundContentType = mapKey !== undefined ? (host.perChatTurnContentType.get(mapKey) ?? null) : null;
  const responseText = !wasSilentCompact && mapKey !== undefined && !queue.hasToolReplyClaimed?.()
    ? (host.perChatTurnText.get(mapKey) ?? '')
    : '';
  const hadSuppressedReplySatisfaction = mapKey !== undefined
    ? host.perChatTurnSuppressedReplySatisfaction.delete(mapKey)
    : false;
  // Clean up per-chat voice state
  if (mapKey !== undefined) {
    host.perChatTurnContentType.delete(mapKey);
    host.perChatTurnText.delete(mapKey);
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
    host.recordFallbackTurnOutcome(
      queue,
      hadVisible || hadSuppressedReplySatisfaction,
      turnHadToolWork,
      session,
    );
    // Empty/tool-only turn: surface any still-pending handoff notice
    // standalone rather than deferring it to the next reply.
    host.flushPendingHandoffNotice(queue);
    let armedFallbackNow = false;
    if (!turnCapabilityFailureRecorded) {
      if (hadVisible || turnHadToolWork || hadSuppressedReplySatisfaction) {
        host.recordTurnCapabilitySuccess(true);
      } else {
        host.recordTurnCapabilityFailure(true, 'empty-output');
        // QR-226: the turnErrorCounts increment above is in-memory only —
        // without a log line, journal greps are blind to empty-output
        // turns (an on-call canary once needed manual timestamp
        // correlation to decode this from raw counters alone).
        log.warn(
          { reason: 'empty-output', chatJid: queue.targetChatJid, mapKey, rowId, turnHadToolWork },
          'recorded empty-output turn failure',
        );
        armedFallbackNow = host.maybeArmFallbackAfterEmptyPrimaryTurn(queue, session, turnHadToolWork, mapKey);
      }
    }
    if (
      !hadVisible &&
      !turnHadToolWork &&
      !hadSuppressedReplySatisfaction &&
      host.isFallbackWindowActive &&
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
  voice = { chatJid: chatJidForVoice, responseText, inboundContentType };
}
if (wasSilentCompact) host.clearSilentCompact(mapKey);
} finally {
  if (
    !isSystemResult
    && runtimeContext
    && host.runtimeTurnCoordinator.consumeRuntimeTurnContinuationDeferral(runtimeContext)
  ) {
    // The selected fallback continues the same admitted turn. Keep its evidence,
    // FIFO slot, completion, and reply guarantee owned until the fallback result.
  } else if (!isSystemResult && runtimeContext && mapKey !== undefined) {
    void host.runtimeTurnCoordinator.finalizeRuntimeTurnContext({
      context: runtimeContext,
      queue,
      attemptOutcome,
      session,
      event,
      mapKey,
      clearReplayOnSuccess,
      ...(voice ? { voice } : {}),
    }).catch((err: unknown) => {
      const scopeKey = host.runtimeTurnCoordinator.runtimeTurnScopeKey(runtimeContext);
      host.runtimeTurnCoordinator.markRuntimeTurnDegraded(runtimeContext);
      host.runtimeTurnCoordinator.rejectRuntimeTurnCompletion(err, mapKey);
      log.error({ err, mapKey, scopeKey }, 'per-chat runtime turn finalization escaped');
      // #1775: a log line alone is a silent drop from ops' perspective —
      // this turn's token/checkpoint bookkeeping may never have run. Route
      // through the same alert path other finalization failures use so the
      // loss is never invisible.
      emitAlertChecked(
        host.instanceName,
        'agent_turn_finalization_escaped',
        'Runtime turn finalization escaped (per-chat)',
        `mapKey=${mapKey} scope=${scopeKey} err=${err instanceof Error ? err.message : String(err)}`,
        'warning',
      );
    });
  } else if (isSystemResult || inboundSeq === undefined || host.durability === null) {
    if (!isSystemResult && mapKey !== undefined && clearReplayOnSuccess) {
      host.pendingTurnText.delete(mapKey);
      host.pendingTurnActorJid.delete(mapKey);
    }
    host.runtimeTurnCoordinator.flushUnownedRuntimeResult(queue, voice);
  } else if (!isSystemResult && inboundSeq !== undefined && host.durability) {
    // Invariant violation: the journaled result should have carried an immutable
    // runtime turn context. The turn is nonetheless terminal — release the
    // replay/eviction latch exactly like the unowned path so the stale entry
    // cannot feed a later fallback replay.
    if (mapKey !== undefined && clearReplayOnSuccess) {
      host.pendingTurnText.delete(mapKey);
      host.pendingTurnActorJid.delete(mapKey);
    }
    log.error({ mapKey, inboundSeq }, 'journaled per-chat result has no immutable runtime turn context');
  }
}
return;

}
export interface ProviderFailureResultContext {
  queue: IOutboundQueue;
  session: SessionManager | null;
  providerText: string;
  turnHadToolWork: boolean;
  logChatJid: string | null | undefined;
  scheduleReplayMapKey?: string;
  cleanupArgs: {
    inboundSeq?: number;
    conversationKey?: string;
    mapKey?: string;
    clearCurrentInboundSeq?: boolean;
  };
  recordTurnFailure: (errorClass: TurnCapabilityErrorClass) => void;
}

function diagnosticBundleEnabled(): boolean {
  return process.env['WHATSOUP_DIAGNOSTIC_BUNDLE'] === '1';
}

export function dispatchProviderFailureResult(
  host: RuntimeResultHandlerPort,
  ctx: ProviderFailureResultContext,
  parseUsageLimitResetTime: (text: string) => Date | null,
): boolean {
const wf = workflowForProviderText(ctx.providerText);
// Not a provider failure, OR a class-only failure whose providerKind is null
// (server-error → provider_server_error, transient-network →
// provider_network_error). handleProviderFailureResult only acts on a
// non-null providerKind, so a null-kind workflow here would otherwise be a
// silent no-op (lost user notice, lost ops alert, lost recordTurnFailure).
// Return false so the caller falls through to the legacy ladders, which own
// the notice/alert/turn-failure handling for these two kinds.
if (!wf || wf.providerKind === null) return false;
handleProviderFailureResult(host, wf, ctx, parseUsageLimitResetTime);
return true;
}

export function handleProviderFailureResult(
  host: RuntimeResultHandlerPort,
  wf: ResponseWorkflow,
  ctx: ProviderFailureResultContext,
  parseUsageLimitResetTime: (text: string) => Date | null,
): void {
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
  session?.shutdown();
  return;
}

// Arming classes: usage-limit / auth-required / rate-limit / model-unavailable.
const reason = kind as ProviderFallbackReason;
log.warn({ chatJid: logChatJid, textPreview }, armingFailureLogMessage(reason));
// Best-effort diagnostics (opt-in) — fire-and-forget, never blocks the turn.
if (diagnosticBundleEnabled()) host.kickDiagnosticBundle(wf, providerText);
const resetAt = reason === 'usage-limit' ? parseUsageLimitResetTime(providerText) : null;
const activation = wf.fallback.markActiveEntryFailedOnTrigger
  ? host.activateProviderFallbackAfterTerminalResult(resetAt, reason, session, providerText)
  : host.activateProviderFallback(resetAt, reason);
const replayScheduled = activation
  ? host.scheduleFallbackReplay({
      activation,
      chatJid: queue.targetChatJid,
      ...(ctx.scheduleReplayMapKey !== undefined ? { mapKey: ctx.scheduleReplayMapKey } : {}),
      oldSession: session,
      hadToolActivity: turnHadToolWork,
    })
  : false;
if (activation) {
  host.notifyProviderFallbackActivated(queue, activation, {
    replayScheduled,
    blockedByToolActivity: turnHadToolWork,
  });
}
if (!replayScheduled) {
  // Every fallback-eligible terminal class emits one standalone notice when no
  // fallback armed. Activated fallbacks keep their existing single notifier.
  if (reason === 'usage-limit' && !activation) queue.enqueueText(host.usageLimitNotice());
  if (reason === 'auth-required' && !activation) host.emitNoFallbackReauthNotice(queue);
  if (!activation && (reason === 'rate-limit' || reason === 'model-unavailable')) {
    enqueueNoFallbackTerminalNotice(queue, reason);
  }
  session?.shutdown();
}
}


export interface GlobalRuntimeResultArgs {
  event: Extract<AgentEvent, { type: 'result' }>;
  queue: IOutboundQueue;
  systemTurnPurpose?: SystemTurnPurpose | null;
  tracker?: OperationTracker;
  extractUsageLimitResetTime(text: string): Date | null;
}

export function handleGlobalRuntimeResult(
  host: RuntimeResultHandlerPort,
  args: GlobalRuntimeResultArgs,
): void {
  const { event, queue, tracker, extractUsageLimitResetTime } = args;
const wasSilentCompact = host.isSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
const runtimeContext = host.runtimeTurnCoordinator.runtimeTurnContext();
const classifiedOutcome = host.runtimeTurnCoordinator.attemptOutcomeForResult(event);
const attemptOutcome = classifiedOutcome.kind === 'completed'
  && host.turnHadSuppressedReplySatisfaction
    ? { kind: 'suppressed_by_policy' as const }
    : classifiedOutcome;
let voice: { chatJid: string; responseText: string; inboundContentType: string | null } | undefined;
let isSystemResult = false;
try {
// R1: flush any held first-line marker buffer at turn end (see the
// per-chat handler) — registers a marker-only / no-newline intent and
// delivers whatever remains. No-op when nothing was held.
if (config.nlRouting && host.currentTurnRouteMarkerHold !== null) {
  const heldMarker = host.currentTurnRouteMarkerHold;
  host.currentTurnRouteMarkerHold = null;
  const tail = host.flushRouteMarker(
    heldMarker,
    (host.shared ? host.currentTurnChatJid : host.activeChatJid) ?? queue.targetChatJid,
    host.currentTurnReplayActorJid,
  );
  if (tail) {
    queue.enqueueStreamingText(tail);
    host.runtimeTurnCoordinator.markRuntimeTurnReplayUnsafe();
    host.turnHadVisibleOutput = true;
    host.currentTurnAssistantText += tail;
  }
}
const hadCompactBoundary = host.consumeCompactBoundary(GLOBAL_TOOL_SCOPE_KEY);
host.session?.completeProviderTurn();
tracker?.onTurnComplete();
// Turn-end choke point: clear the typing indicator unconditionally so no
// early-break branch below can leave 'composing' asserted into the idle
// persistent session. Idempotent with the normal-path queue.flush().
queue.endTurn();
// Provider-reported turn cost: log it beside the token counts and
// accumulate it while a fallback window is active.
host.recordTurnCostUsd(event);
const turnHadToolWork = host.singleTurnHadToolActivity;
host.clearToolNames(GLOBAL_TOOL_SCOPE_KEY);

// System-turn results (auto-compact /compact, manual /compact) must not
// arm the post-turn gate — otherwise the next real turn's output is
// suppressed as phantom (the per_chat bug, same class, single mode).
// Mirror handleEventPerChat: the GLOBAL pending-system counter is
// incremented by maybeStartAutoCompact / handleAgentCommand. Shared mode
// never increments GLOBAL (auto-compact early-returns), so this is a
// no-op there.
isSystemResult = args.systemTurnPurpose !== undefined
  ? args.systemTurnPurpose !== null
  : host.pendingSystemResults.consumeIfPending(GLOBAL_TOOL_SCOPE_KEY);

// AskUserQuestion poll bridge is per_chat only — no pending-poll
// suppression in shared mode. Normal result lifecycle applies.
// Activate post-turn gate — suppress any SDK-injected events until next user turn
if (!isSystemResult) {
  host.postTurnGate.add(GLOBAL_TOOL_SCOPE_KEY);
}
const isUserTurnResult = !isSystemResult && !wasSilentCompact;
let turnCapabilityFailureRecorded = false;
const recordTurnFailure = (errorClass: TurnCapabilityErrorClass): void => {
  host.recordTurnCapabilityFailure(isUserTurnResult, errorClass);
  turnCapabilityFailureRecorded = turnCapabilityFailureRecorded || isUserTurnResult;
};

// Render result.text if present (e.g. terminal context-limit errors)
if (event.text) {
  if (host.enqueueAutoSwitchNotice(queue, event.text, host.shared ? host.currentTurnChatJid : host.activeChatJid, 'result')) {
    host.turnHadVisibleOutput = true;
    return;
  }
  if (responseRegistryDispatchEnabled() && dispatchProviderFailureResult(host, {
    queue,
    session: host.session,
    providerText: event.text,
    turnHadToolWork,
    logChatJid: host.shared ? host.currentTurnChatJid : host.activeChatJid,
    cleanupArgs: {
      inboundSeq: host.currentInboundSeq,
      conversationKey: toConversationKey(queue.targetChatJid),
      clearCurrentInboundSeq: true,
    },
    recordTurnFailure,
  }, extractUsageLimitResetTime)) {
    return;
  }
  const providerFailureKind = classifyProviderFailure(event.text);
  // Suppress usage-limit messages — log and kill session instead of forwarding
  if (providerFailureKind === 'usage-limit') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: host.shared ? host.currentTurnChatJid : host.activeChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed usage-limit message from result — session will be killed');
    // Route the auto-respawned next session to the fallback provider
    // (if configured) until the limit resets, before tearing down.
    const activation = host.activateProviderFallbackAfterTerminalResult(
      extractUsageLimitResetTime(event.text),
      'usage-limit',
      host.session,
      event.text,
    );
    const replayScheduled = activation
      ? host.scheduleFallbackReplay({
          activation,
          chatJid: queue.targetChatJid,
          oldSession: host.session,
          hadToolActivity: turnHadToolWork,
        })
      : false;
    if (activation) {
      host.notifyProviderFallbackActivated(queue, activation, {
        replayScheduled,
        blockedByToolActivity: turnHadToolWork,
      });
    }
    if (!replayScheduled) {
      if (!activation) queue.enqueueText(host.usageLimitNotice());
      host.session?.shutdown();
    }
    host.singleTurnHadToolActivity = false;
    return;
  }
  if (providerFailureKind === 'policy-block') {
    recordTurnFailure(providerFailureKind);
    log.error({ chatJid: host.shared ? host.currentTurnChatJid : host.activeChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider policy-block message from result — session will be killed');
    host.session?.shutdown();
    return;
  }
  if (providerFailureKind === 'auth-required') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: host.shared ? host.currentTurnChatJid : host.activeChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider auth-required message from result — session will be shut down');
    const activation = host.activateProviderFallbackAfterTerminalResult(
      null,
      'auth-required',
      host.session,
      event.text,
    );
    const replayScheduled = activation
      ? host.scheduleFallbackReplay({
          activation,
          chatJid: queue.targetChatJid,
          oldSession: host.session,
          hadToolActivity: turnHadToolWork,
        })
      : false;
    if (activation) {
      host.notifyProviderFallbackActivated(queue, activation, {
        replayScheduled,
        blockedByToolActivity: turnHadToolWork,
      });
    }
    if (!replayScheduled) {
      // QR-211: no fallback took over — without this, the turn ends in
      // permanent silence (session shuts down, nothing forwarded to chat).
      if (!activation) host.emitNoFallbackReauthNotice(queue);
      host.session?.shutdown();
    }
    host.singleTurnHadToolActivity = false;
    return;
  }
  if (providerFailureKind === 'rate-limit' || providerFailureKind === 'server-error') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: host.shared ? host.currentTurnChatJid : host.activeChatJid, textPreview: event.text.slice(0, 300) }, armingFailureLogMessage(providerFailureKind));
    const activation = host.activateProviderFallbackAfterTerminalResult(
      null,
      providerFailureKind,
      host.session,
      event.text,
    );
    const replayScheduled = activation
      ? host.scheduleFallbackReplay({
          activation,
          chatJid: queue.targetChatJid,
          oldSession: host.session,
          hadToolActivity: turnHadToolWork,
        })
      : false;
    if (activation) {
      host.notifyProviderFallbackActivated(queue, activation, {
        replayScheduled,
        blockedByToolActivity: turnHadToolWork,
      });
    }
    if (!replayScheduled) {
      if (!activation && providerFailureKind === 'server-error') queue.enqueueText(providerUnknownTerminalNotice());
      if (!activation && providerFailureKind === 'rate-limit') {
        enqueueNoFallbackTerminalNotice(queue, providerFailureKind);
      }
      host.session?.shutdown();
    }
    host.singleTurnHadToolActivity = false;
    return;
  }
  if (providerFailureKind === 'model-unavailable') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: host.shared ? host.currentTurnChatJid : host.activeChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed provider model-unavailable message from result — session will be shut down');
    const activation = host.activateProviderFallback(null, 'model-unavailable');
    const replayScheduled = activation
      ? host.scheduleFallbackReplay({
          activation,
          chatJid: queue.targetChatJid,
          oldSession: host.session,
          hadToolActivity: turnHadToolWork,
        })
      : false;
    if (activation) {
      host.notifyProviderFallbackActivated(queue, activation, {
        replayScheduled,
        blockedByToolActivity: turnHadToolWork,
      });
    }
    if (!replayScheduled) {
      if (!activation) enqueueNoFallbackTerminalNotice(queue, providerFailureKind);
      host.session?.shutdown();
    }
    host.singleTurnHadToolActivity = false;
    return;
  }
  // Context overflow — session is unsalvageable, kill and let next message respawn
  if (providerFailureKind === 'context-overflow') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: host.shared ? host.currentTurnChatJid : host.activeChatJid, textPreview: event.text.slice(0, 300) }, 'prompt too long — killing session');
    queue.enqueueText(contextOverflowNotice());
    host.session?.shutdown();
    return;
  }
  // Transient streaming-socket drop — recoverable, next message respawns the session.
  // Suppress raw provider text; emit a generic notice and a WARNING (not CRITICAL) alert.
  if (providerFailureKind === 'transient-network') {
    recordTurnFailure(providerFailureKind);
    log.warn({ chatJid: host.shared ? host.currentTurnChatJid : host.activeChatJid, textPreview: event.text.slice(0, 300) }, 'transient provider connection drop — session will recover on next message');
    emitAlertChecked(
      host.instanceName,
      'provider_transient_network',
      'Transient provider connection drop (recoverable)',
      event.text.slice(0, 400),
      'warning',
    );
    queue.enqueueText(providerUnknownTerminalNotice());
    host.singleTurnHadToolActivity = false;
    return;
  }
  if (!wasSilentCompact) {
    if (event.isError) {
      recordTurnFailure('unknown-terminal');
      // Default-deny: is_error result with no recognised class = unknown terminal
      // provider error. Suppress the raw text; emit a generic notice + ops alert.
      log.error({ chatJid: host.shared ? host.currentTurnChatJid : host.activeChatJid, textPreview: event.text.slice(0, 300) }, 'suppressed unclassified terminal provider error from result — not forwarded to user');
      emitAlertChecked(
        host.instanceName,
        'provider_unknown_terminal',
        'Unclassified terminal provider error suppressed from user',
        event.text.slice(0, 400),
      );
      queue.enqueueText(providerUnknownTerminalNotice());
    } else {
      queue.enqueueResultText(host.withHandoffPrefix(queue.targetChatJid, event.text));
      host.runtimeTurnCoordinator.markRuntimeTurnReplayUnsafe();
      host.turnHadVisibleOutput = true;
      // Accumulate result text for voice reply (SP4)
      host.currentTurnAssistantText += event.text;
    }
  }
}
host.currentTurnAssistantItemText.clear();
const rowId = host.session?.getDbRowId() ?? null;
const hadSuppressedReplySatisfaction = host.turnHadSuppressedReplySatisfaction;
host.turnHadSuppressedReplySatisfaction = false;
let armedFallbackNow = false;
if (!wasSilentCompact && !isSystemResult) {
  host.recordFallbackTurnOutcome(
    queue,
    host.turnHadVisibleOutput || hadSuppressedReplySatisfaction,
    turnHadToolWork,
    host.session,
  );
  // Empty/tool-only turn: surface any still-pending handoff notice
  // standalone rather than deferring it to the next reply.
  host.flushPendingHandoffNotice(queue);
  if (!turnCapabilityFailureRecorded) {
    if (host.turnHadVisibleOutput || turnHadToolWork || hadSuppressedReplySatisfaction) {
      host.recordTurnCapabilitySuccess(true);
    } else {
      host.recordTurnCapabilityFailure(true, 'empty-output');
      // QR-226: see the matching log.warn in handleEventWithContext — the
      // turnErrorCounts increment above is in-memory only, so without a
      // log line journal greps are blind to empty-output turns here too.
      log.warn(
        {
          reason: 'empty-output',
          chatJid: host.shared ? host.currentTurnChatJid : host.activeChatJid,
          rowId,
          turnHadToolWork,
        },
        'recorded empty-output turn failure',
      );
      armedFallbackNow = host.maybeArmFallbackAfterEmptyPrimaryTurn(queue, host.session, turnHadToolWork, undefined);
    }
  }
}
host.singleTurnHadToolActivity = false;
// If nothing visible was emitted this turn, send an explicit fallback —
// unless we just armed the provider fallback (its activation notice has
// already informed the user and the turn is being replayed on the backup).
if (!host.turnHadVisibleOutput && !hadSuppressedReplySatisfaction && !wasSilentCompact && !armedFallbackNow) {
  queue.enqueueText('_(no response)_');
}
host.turnHadVisibleOutput = false;
if (!runtimeContext && (event.inputTokens !== undefined || event.outputTokens !== undefined) && rowId !== null) {
  {
    const { newInputTokens, cacheReadTokens } = splitInputTokenUsage(event);
    accumulateTokensWithEvent(host.db, rowId, newInputTokens, event.outputTokens ?? 0, cacheReadTokens);
  }
}
// Only advance the compact baseline when the SDK actually emitted a
// compact_boundary. wasSilentCompact alone means "we suppressed
// user-facing chrome for an auto-trigger" and doesn't prove /compact
// succeeded — advancing on it silently disables auto-compact for
// another threshold's worth of tokens. See the per_chat handler for
// the parallel gate.
if (!wasSilentCompact && !hadCompactBoundary && !isSystemResult) {
  host.recordAutoCompactNextTurnIfNeeded(GLOBAL_TOOL_SCOPE_KEY, event.inputTokens);
}
if (hadCompactBoundary && rowId !== null) {
  markSessionCompacted(host.db, rowId);
  host.recordAutoCompactSuccess(GLOBAL_TOOL_SCOPE_KEY);
}
if (wasSilentCompact || hadCompactBoundary) {
  host.finishAutoCompact(GLOBAL_TOOL_SCOPE_KEY);
} else if (runtimeContext) {
  host.runtimeTurnCoordinator.appendRuntimeTurnAfterTerminalAction(
    runtimeContext,
    () => host.maybeStartAutoCompact(host.session),
  );
} else {
  host.maybeStartAutoCompact(host.session);
}
{
  // Capture voice reply context before flush (SP4)
  const chatJidForVoice = host.shared ? host.currentTurnChatJid : host.activeChatJid;
  const inboundContentType = host.currentTurnInboundContentType;
  const responseText = wasSilentCompact ? '' : host.currentTurnAssistantText;
  // Reset per-turn voice state
  host.currentTurnInboundContentType = null;
  host.currentTurnAssistantText = '';
  if (chatJidForVoice) {
    voice = { chatJid: chatJidForVoice, responseText, inboundContentType };
  }
}
if (wasSilentCompact) host.clearSilentCompact(GLOBAL_TOOL_SCOPE_KEY);
} finally {
  if (
    !isSystemResult
    && runtimeContext
    && host.runtimeTurnCoordinator.consumeRuntimeTurnContinuationDeferral(runtimeContext)
  ) {
    // See the scoped path: the fallback result, not this primary result, owns finalization.
  } else if (!isSystemResult && runtimeContext) {
    void host.runtimeTurnCoordinator.finalizeRuntimeTurnContext({
      context: runtimeContext,
      queue,
      attemptOutcome,
      session: host.session,
      event,
      ...(voice ? { voice } : {}),
    }).catch((err: unknown) => {
      const scopeKey = host.runtimeTurnCoordinator.runtimeTurnScopeKey(runtimeContext);
      host.runtimeTurnCoordinator.markRuntimeTurnDegraded(runtimeContext);
      host.runtimeTurnCoordinator.rejectRuntimeTurnCompletion(err);
      log.error({ err, scopeKey }, 'shared/singleton runtime turn finalization escaped');
      // #1775: see the matching per-chat catch — a log line alone is a
      // silent drop from ops' perspective. Alert so it is not.
      emitAlertChecked(
        host.instanceName,
        'agent_turn_finalization_escaped',
        'Runtime turn finalization escaped (shared/singleton)',
        `scope=${scopeKey} err=${err instanceof Error ? err.message : String(err)}`,
        'warning',
      );
    });
  } else if (isSystemResult || host.currentInboundSeq === undefined || host.durability === null) {
    host.runtimeTurnCoordinator.flushUnownedRuntimeResult(queue, voice);
    host.currentTurnChatJid = null;
    host.currentTurnReplayText = null;
    host.currentTurnReplayActorJid = undefined;
  } else if (!isSystemResult && host.currentInboundSeq !== undefined && host.durability) {
    log.error(
      { inboundSeq: host.currentInboundSeq },
      'journaled shared/singleton result has no immutable runtime turn context',
    );
  }
}
return;

}
