/**
 * `/model` pin surface — the chat-scoped model pin write, its pin-time
 * catalogue verification, the live-session recycle that makes a pin take
 * effect, and the `/model` command handler that sequences them.
 *
 * Extracted from AgentRuntime as a slice of the god-class decomposition, in
 * the same shape as the runtime-turn port (`createRuntimeTurnHost` in
 * runtime.ts): free functions over a narrow `ModelPinPort` the runtime
 * satisfies with a host object, so AgentRuntime keeps thin delegating privates
 * for the call sites that remain in it and behavior is unchanged. See the
 * characterization suite in tests/runtimes/agent/model-pin.test.ts.
 */
import type { Database } from '../../core/database.ts';
import type { AgentFallbackEntry } from '../../core/fallback-chain.ts';
import type { IncomingMessage } from '../../core/types.ts';
import { createChildLogger } from '../../logger.ts';
import { GLOBAL_CONVERSATION_KEY, toConversationKey } from '../../core/conversation-key.ts';
import type { fetchAnthropicModelIdsWithStatus } from '../../lib/model-advisor.ts';
import type { CommandResult } from './commands.ts';
import {
  getPreference,
  setPreference,
  pruneExpired,
  clearChatPreference,
  promoteToSticky,
  type PreferenceIntent,
} from './chat-preference-db.ts';
import { preferenceKeys } from './preference-keys.ts';
import { decideModelPinResolution, type CatalogueOutcome } from './config-surface.ts';
import { resolveModelCatalogue } from './model-catalogue-resolver.ts';
import type { ModelRouteEvent } from './route-events.ts';
import type { RouteDecision } from './route-resolution.ts';
import { isProviderId } from './providers/index.ts';
import { isExplicitModelId } from './commands.ts';
import type { listModelCatalog } from './providers/binary-preflight.ts';
import { getProviderBinary, type SessionManager } from './session.ts';
import type { IOutboundQueue } from './outbound-queue.ts';
import type { TurnQueue } from './turn-queue.ts';
import type { OperationTracker } from './operation-tracker.ts';
import {
  sendModelCatalogue,
  configuredModelEntries,
  type ModelCatalogueRenderPort,
} from './model-catalogue-render.ts';
import { brandOf, listBrands } from './providers/provider-brand.ts';
import { MS_PER_DAY } from '../../lib/time-units.ts';
import { renderBrandLevel, renderEffortLevel, renderModelLevel, prettyEffortLabel, type RenderedLevel } from './model-drilldown-render.ts';
import { nativeReasoningControl, providerConfigEffort, providerHasNativeReasoningControl, type ReasoningControl } from './reasoning-control.ts';
import {
  RouteRecycleLifecycle,
  type RouteRecycleFailure as LifecycleRouteRecycleFailure,
} from './route-recycle-lifecycle.ts';
import {
  fallbackReconfirmationOutcome,
  fallbackRouteLabel,
  renderPinPreferenceOutcome,
  MODEL_CATALOGUE_CAP,
} from './owner-render-format.ts';

// Same component name as AgentRuntime: the warnings below keep their existing
// `component: 'agent-runtime'` log binding (no observable change).
const log = createChildLogger('agent-runtime');

/** Scope key for the single/shared session (mirrors runtime.ts's GLOBAL_TOOL_SCOPE_KEY). */
const GLOBAL_TOOL_SCOPE_KEY = GLOBAL_CONVERSATION_KEY;

class RouteRecycleOwnershipChangedError extends Error {}

/** TTL for an ephemeral (non-sticky) route preference row. */
export const PREFERENCE_TTL_MS = MS_PER_DAY;

// Only the receipt's promised bare reply mutates routing (Q-CANARY model-pin
// `keep` contract, 2026-07-23). Conversational uses such as "please keep it"
// must continue to the agent unchanged.
const BARE_KEEP_RE = /^\s*keep[\s!.]*$/i;

/**
 * Task G (D14) — outcome of applyRouteChangeAndRecycle: 'recycled' (idle,
 * torn down now — the next inbound respawns on the new route), 'deferred'
 * (a turn was in flight — a pendingRecycle flag was set instead), or 'noop'
 * (no live session, or the resolved route already matched it).
 */
export type RouteRecycleOutcome = 'recycled' | 'deferred' | 'noop';

export type RouteRecycleFailure = LifecycleRouteRecycleFailure<SessionManager>;

/**
 * The AgentRuntime surface the pin/recycle path reads and mutates. Declared
 * here rather than importing AgentRuntime so this module stays free of a cycle
 * back into runtime.ts; the runtime supplies it as a host object.
 */
export interface ModelPinPort extends ModelCatalogueRenderPort {
  readonly db: Database;
  readonly sessionScope: 'single' | 'shared' | 'per_chat';
  readonly pendingRecycle: Set<string>;
  readonly recyclePromises: Map<string, Promise<void>>;
  readonly recycleOwners: Map<string, SessionManager>;
  readonly recycleFailures: Map<string, RouteRecycleFailure>;
  readonly routeRecycleLifecycle?: RouteRecycleLifecycle<SessionManager>;
  readonly chatSessions: Map<string, SessionManager>;
  readonly chatQueues: Map<string, IOutboundQueue>;
  readonly runtimeTurnCoordinator: {
    captureIdlePerChatTurnQueueForRecycle(mapKey: string): TurnQueue | null;
    retireIdlePerChatTurnQueueForRecycle(
      mapKey: string,
      expectedQueue: TurnQueue | null,
    ): void;
  };
  readonly modelCatalogueListFn: typeof listModelCatalog | undefined;
  readonly modelCatalogueAnthropicFn: typeof fetchAnthropicModelIdsWithStatus | undefined;
  readonly effectiveFallbackEntry: AgentFallbackEntry | null;
  session: SessionManager | null;
  queue: IOutboundQueue | null;
  activeChatJid: string | null;
  operationTracker: OperationTracker | null;
  resolveRouteForTurn(chatJid: string, actorJid?: string): RouteDecision & { pinnedProvider: string | null };
  /** The effective provider config a route would spawn with — INCLUDING the
   *  Slice-3 effort override (applyRouteEffort is applied inside). The recycle
   *  diff reads `.effort` from it to compare against the live session's
   *  {@link SessionManager.getSpawnedEffort}. */
  routeSessionProviderConfig(route: RouteDecision): Record<string, unknown> | undefined;
  resolvePerChatMapKey(chatJid: string): string;
  isTurnInFlight(scopeKey: string): boolean;
  getActiveQueue(): IOutboundQueue | null;
  deleteOwnedPerChatSession(mapKey: string, expected?: SessionManager): boolean;
  cleanupPerChatState(
    mapKey: string,
    options?: {
      preserveCrashHistory?: boolean;
      preserveProviderTurnOwnership?: boolean;
      preserveActorSocket?: boolean;
    },
  ): void;
  retirePerChatProviderTransitionAfter(mapKey: string, transitionSettled: Promise<void>): void;
  cleanupGlobalAutoCompactState(): void;
  emitRouteEventChecked(ev: Omit<ModelRouteEvent, 'ts' | 'instance' | 'chatScope' | 'authority'>): void;
  recordRoutePreference(
    chatJid: string,
    chatKey: string,
    senderKey: string,
    intent: PreferenceIntent,
    requestedProvider: string | null,
  ): 'set' | 'refreshed' | 'sticky_kept';
  routablePinTargets(): string[];
  renderRouteStatus(chatJid: string, senderJid: string): string;
  /** Terminal durability completion for text handled locally without an
   *  agent turn (R14 shape) — a no-op when inboundSeq is undefined. */
  completeLocalInbound(inboundSeq: number | undefined): void;
}

/**
 * Full bare-`keep` interception (Q-CANARY model-pin `keep` contract,
 * 2026-07-23) — the ONE call site runtime.ts needs. Only the receipt's
 * promised bare reply mutates routing; conversational uses like "please keep
 * it" continue to the agent unchanged (BARE_KEEP_RE requires an exact match).
 * Eligibility is evaluated at `msg.timestamp` (the inbound's own receive
 * time, epoch seconds), never `Date.now()` at processing time, so a
 * provider-queue delay cannot turn an on-time reply into a false "expired"
 * refusal. Returns true iff this call fully handled the inbound (sent the
 * reply and terminalized the durability row) — the caller must return
 * immediately without any further dispatch.
 */
export function tryHandleBareKeep(port: ModelPinPort, classified: CommandResult, chatJid: string, msg: IncomingMessage): boolean {
  if (classified.type !== 'message' || !BARE_KEEP_RE.test(classified.text)) return false;
  const keepReply = handleBareKeep(port, chatJid, msg.senderJid, msg.timestamp * 1000);
  if (keepReply === null) return false;
  port.sendDirect(chatJid, keepReply);
  port.completeLocalInbound(msg.inboundSeq);
  return true;
}

/**
 * Promote the chat's current live route preference to a permanent pin.
 * `nowMs` is the caller's eligibility instant. Delegates the actual
 * compare-and-set to `promoteToSticky` (chat-preference-db.ts, the
 * preference SSOT): only the row that is STILL the chat's winning preference
 * at `nowMs` AND still belongs to the confirming sender is promoted — never
 * a stale, reset, or someone-else's pin. Returns null ONLY for `absent`
 * (nothing pending for this chat), which lets the bare "keep" fall through
 * as ordinary text via {@link tryHandleBareKeep}; every other outcome is
 * handled locally with a truthful, visible reply.
 */
function handleBareKeep(port: ModelPinPort, chatJid: string, senderJid: string, nowMs: number): string | null {
  const { chatKey, senderKey } = preferenceKeys(port.db, chatJid, senderJid);

  let result: ReturnType<typeof promoteToSticky>;
  try {
    result = promoteToSticky(port.db, chatKey, senderKey, nowMs);
  } catch (err) {
    log.warn({ err, instance: port.instanceName }, 'keep: preference promotion failed');
    return `_Couldn't confirm that pin right now — nothing changed. Try again, or /model to re-pin._`;
  }

  const label = result.preference
    ? (result.preference.modelPinVerified === true ? result.preference.requestedModel : null)
      ?? (result.preference.requestedProvider ?? result.preference.intent)
    : null;

  switch (result.outcome) {
    case 'absent':
      return null;
    case 'expired':
      return `_That pin already expired. /model to set a new one._`;
    case 'actor_mismatch':
      return `_Only whoever set this chat's pin can keep it. /model to set your own._`;
    case 'superseded':
      return `_That pin changed before "keep" landed — nothing was promoted. /model to check the current route._`;
    case 'already_sticky':
      return `_${label} is already kept for this chat. /reset to undo._`;
    case 'promoted': {
      const pref = result.preference!;
      port.emitRouteEventChecked({
        event: 'model_preference_made_sticky',
        conversationKey: toConversationKey(chatJid),
        provider: pref.requestedProvider ?? `intent:${pref.intent}`,
        modelRef: pref.requestedModel,
        source: 'user',
        userVisible: true,
        reasonCode: 'user_pin_kept',
      });
      return `_Keeping ${label} for this chat until you /reset._`;
    }
  }
}

/**
 * Model-level pin write (D6) — sibling of recordRoutePreference, for a pin
 * resolved from a numbered `/model N` pick rather than a bare provider-id
 * or intent verb. Mirrors the same TTL/refresh/sticky logic and event
 * shape; the difference is the F12 model-pin fields (chat-preference-db):
 * `requestedModel`/`validatedProvider` are populated and `modelPinVerified`
 * is written `false` (unverified) — the picked entry came from a catalogue
 * snapshot that can be up to 15 minutes stale (TTL), and the provider that
 * ultimately SERVES the pin at resolution time (a fallback window, a later
 * provider transition) is not guaranteed to still be `providerId`, so
 * verification is deferred to the route-resolution consumer rather than
 * asserted here.
 *
 * WRITE→ROUTE SEAM (Task H, CLOSED): this write is deliberately
 * unverified — the caller (`/model N` handler) awaits
 * {@link verifyModelPinAgainstCatalogue} immediately after this call and
 * BEFORE the D10 echo, so the row is durably verified (or dropped/deferred)
 * by the time the user sees any reply. `resolveRouteForTurn`'s sync hot
 * path then consumes the verified bit via `decideModelPinResolution` (the
 * F12 contract, config-surface.ts) to set `route.model`. Task G (separate,
 * not this task) additionally makes an ALREADY-LIVE session pick it up
 * immediately rather than on the next spawn.
 */
export function recordRouteModelPin(
  port: ModelPinPort,
  chatJid: string,
  chatKey: string,
  senderKey: string,
  providerId: string,
  model: string,
  effort: string | null = null,
): 'set' | 'refreshed' | 'sticky_kept' {
  const now = Date.now();
  const existing = getPreference(port.db, chatKey, senderKey, now);
  if (
    existing &&
    existing.intent === 'provider_specific' &&
    existing.requestedProvider === providerId &&
    existing.requestedModel === model &&
    // Slice 3: effort is part of the pin's dedup identity — re-pinning the
    // SAME model at a DIFFERENT effort is a genuine change (falls through to
    // a fresh 'set' + re-verify + recycle), never a no-op 'refreshed'.
    (existing.requestedEffort ?? null) === effort
  ) {
    if (existing.expiresAt !== null) {
      setPreference(port.db, { ...existing, updatedAt: now, expiresAt: now + PREFERENCE_TTL_MS });
      return 'refreshed';
    }
    return 'sticky_kept';
  }
  setPreference(port.db, {
    chatJid: chatKey,
    senderJid: senderKey,
    intent: 'provider_specific',
    requestedProvider: providerId,
    scope: 'this_thread',
    pinStrict: true,
    fallbackPermitted: false,
    updatedAt: now,
    expiresAt: now + PREFERENCE_TTL_MS,
    requestedModel: model,
    validatedProvider: providerId,
    modelPinVerified: false,
    requestedEffort: effort,
  });
  port.emitRouteEventChecked({
    event: 'model_preference_set',
    conversationKey: toConversationKey(chatJid),
    provider: providerId,
    modelRef: model,
    source: 'user',
    userVisible: true,
    reasonCode: 'user_model_pin_set',
  });
  return 'set';
}

/**
 * Task H — the ONE async catalogue fetch a model pin ever needs, done at
 * PIN TIME (awaited by the `/model N` handler before its echo) so the row
 * is already verified by the time `resolveRouteForTurn`'s SYNC hot path
 * (decideModelPinResolution, config-surface.ts — the SSOT) needs to
 * consume it. The catalogue probes are injectable
 * (modelCatalogueListFn/modelCatalogueAnthropicFn on AgentRuntimeOptions,
 * mirroring resolveModelCatalogue's own listFn/anthropicFn seam) so a test
 * never spawns the real binary or hits the real keychain.
 *
 * Acts on decideModelPinResolution's verdict against the just-written
 * (unverified) pin:
 *   - `use` (+ `revalidated`) — the model IS in the catalogue: persist
 *     `modelPinVerified: true` (re-reading the row rather than assuming
 *     its shape, in case it moved under us) and report 'verified'.
 *   - `drop`                  — the model is NOT in the catalogue: clear
 *     the whole chat pin (never leave an unverified orphan) and hand back
 *     the reason so the caller can disclose it instead of the normal D10
 *     echo.
 *   - `defer` (catalogue down) and the unreachable `none`/`needs-catalogue`
 *     shapes (a catalogue and a requestedModel are always supplied here) —
 *     leave the pin UNVERIFIED exactly as recordRouteModelPin wrote it; a
 *     deliberate fail-open, report 'deferred'.
 */
/**
 * The ONE provider-catalogue fetch preamble both the pin-time verify
 * ({@link verifyModelPinAgainstCatalogue}) and the drill Level-2 render
 * (`sendModelDrillModelLevel`) need: resolve the provider binary, then fetch
 * via the injectable listFn/anthropicFn seam (a test never spawns a binary or
 * hits the keychain). Callers diverge AFTER on the returned listing (verify
 * runs decideModelPinResolution; the drill renders it). Slice-3 forward-reuse.
 */
async function fetchProviderCatalogue(
  port: ModelPinPort,
  providerId: string,
): Promise<Awaited<ReturnType<typeof resolveModelCatalogue>>> {
  const binary = getProviderBinary(providerId) ?? providerId;
  return resolveModelCatalogue(providerId, binary, {
    nowMs: Date.now(),
    listFn: port.modelCatalogueListFn,
    anthropicFn: port.modelCatalogueAnthropicFn,
  });
}

export async function verifyModelPinAgainstCatalogue(
  port: ModelPinPort,
  chatKey: string,
  senderKey: string,
  providerId: string,
  model: string,
): Promise<'verified' | 'deferred' | { dropped: string }> {
  const listing = await fetchProviderCatalogue(port, providerId);
  const catalogue: CatalogueOutcome =
    listing.status === 'ok' ? { available: true, ids: listing.ids } : { available: false };
  const decision = decideModelPinResolution(
    { requestedModel: model, validatedProvider: providerId, modelPinVerified: false },
    providerId,
    catalogue,
  );
  if (decision.action === 'use') {
    const existing = getPreference(port.db, chatKey, senderKey);
    if (existing) {
      setPreference(port.db, { ...existing, modelPinVerified: true, validatedProvider: providerId, updatedAt: Date.now() });
    }
    return 'verified';
  }
  if (decision.action === 'drop') {
    clearChatPreference(port.db, chatKey);
    return { dropped: decision.reason };
  }
  return 'deferred';
}

/**
 * Task G (D14): make a successful /model or /reset route change take
 * effect on the user's NEXT message instead of the next /new — a running
 * SessionManager's model/provider are readonly (session.ts, set once at
 * construction; spawnSession() reuses the same manager), so a live
 * session keeps answering on the OLD route until it is REPLACED, not
 * reset in place.
 *
 * Diff-gated: resolves the just-written route (`resolveRouteForTurn`,
 * which now reflects the fresh pin) and compares it — BOTH provider and
 * model — against the live session's actual (provider, model). No live
 * session, or an unchanged route, is a no-op; recording a pin the route
 * resolver won't even honor (e.g. a blocked/ineligible provider) must
 * never tear down a perfectly good session.
 *
 * EAGER-when-idle + defer-when-busy: idle begins a fail-closed recycle NOW
 * (prove idle ownership, await process-tree shutdown, then retire and detach);
 * busy sets a pendingRecycle flag consumed at the next turn-idle boundary and
 * NEVER tears down mid-turn.
 */
export async function applyRouteChangeAndRecycle(
  port: ModelPinPort,
  chatJid: string,
  senderJid: string,
  perChatMapKey: string | undefined,
): Promise<RouteRecycleOutcome> {
  const lifecycle = routeRecycleLifecycle(port);
  const scopeKey = port.sessionScope === 'per_chat'
    ? (perChatMapKey ?? port.resolvePerChatMapKey(chatJid))
    : GLOBAL_TOOL_SCOPE_KEY;
  const session = port.sessionScope === 'per_chat'
    ? port.chatSessions.get(scopeKey)
    : port.session;
  // No live session — the next spawn already reads the fresh pin via
  // resolveRouteForTurn; nothing to recycle.
  if (!session) return 'noop';
  const next = port.resolveRouteForTurn(chatJid, senderJid);
  // Slice 3: effort is part of the recycle diff. Compare the live session's
  // EFFECTIVE spawned effort (getSpawnedEffort) against the effort the NEXT
  // spawn would carry — read from routeSessionProviderConfig, which already
  // folds the pin override over the static config via applyRouteEffort. This
  // is symmetric (effective vs effective): a same-model re-pin at a NEW effort
  // recycles so the new effort takes (E10); an unchanged effective effort
  // (e.g. a pin whose override equals the static config) stays a no-op (F3, no
  // over-recycle).
  //
  // Refs #2845: gated on providerHasNativeReasoningControl(next.provider),
  // mirroring getSpawnedEffort()'s own gate. applyRouteEffort deliberately
  // leaves a non-claude-cli route's base config UNTOUCHED (it only ever
  // STRIPS or overrides effort for a provider that natively supports it), so
  // routeSessionProviderConfig(next) can still carry an inherited static
  // `effort` key for a provider that never acts on it. Reading that key here
  // unconditionally would compare it against getSpawnedEffort()'s now-gated
  // `null` and force a recycle for every non-claude-cli session that merely
  // inherited the field — the exact spurious-recycle failure mode this slice
  // exists to prevent, just moved from one side of the comparison to the
  // other. Gating both sides on the same predicate keeps the comparison a
  // true reading of "does the EFFECTIVE, spawn-consumed effort differ",
  // never a raw config key neither side's provider can act on.
  const nextEffort = providerHasNativeReasoningControl(next.provider)
    ? providerConfigEffort(port.routeSessionProviderConfig(next))
    : null;
  if (
    session.getProviderId() === next.provider &&
    session.getModelRef() === next.model &&
    session.getSpawnedEffort() === nextEffort
  ) {
    return 'noop';
  }
  if (port.isTurnInFlight(scopeKey)) {
    lifecycle.pending.add(scopeKey);
    return 'deferred';
  }
  lifecycle.pending.add(scopeKey);
  try {
    await runOwnedRecycle(
      port,
      scopeKey,
      port.sessionScope === 'per_chat' ? scopeKey : undefined,
      session,
    );
  } catch (error) {
    // The original owner is already gone or terminal. Do not let a stale
    // retry flag recycle the replacement on the next inbound.
    if (error instanceof RouteRecycleOwnershipChangedError) {
      lifecycle.pending.delete(scopeKey);
    }
    throw error;
  }
  lifecycle.pending.delete(scopeKey);
  return 'recycled';
}

/**
 * Consumption hook for a deferred recycle (Task G busy branch). Called at
 * the inbound initialization boundary before any turn dispatch or "does a
 * session exist" check, so it can only fire between turns, never mid-turn:
 * it re-checks isTurnInFlight itself (a turn may still be draining, or a new
 * one may already be queued behind it) and leaves the flag set to try again
 * on a later message if so.
 */
export async function consumePendingRecycleIfIdle(
  port: ModelPinPort,
  scopeKey: string,
): Promise<void> {
  const lifecycle = routeRecycleLifecycle(port);
  const inProgress = lifecycle.promises.get(scopeKey);
  if (inProgress) {
    await inProgress;
    return;
  }
  if (!lifecycle.pending.has(scopeKey)) return;
  if (port.isTurnInFlight(scopeKey)) return;
  const session = port.sessionScope === 'per_chat'
    ? port.chatSessions.get(scopeKey)
    : port.session;
  if (!session) {
    lifecycle.pending.delete(scopeKey);
    lifecycle.failures.delete(scopeKey);
    return;
  }
  try {
    await runOwnedRecycle(
      port,
      scopeKey,
      port.sessionScope === 'per_chat' ? scopeKey : undefined,
      session,
    );
  } catch (error) {
    if (error instanceof RouteRecycleOwnershipChangedError) {
      lifecycle.pending.delete(scopeKey);
    }
    throw error;
  }
  lifecycle.pending.delete(scopeKey);
}

async function runOwnedRecycle(
  port: ModelPinPort,
  scopeKey: string,
  mapKey: string | undefined,
  session: SessionManager,
): Promise<void> {
  return routeRecycleLifecycle(port).runOwned(
    scopeKey,
    session,
    () => recycleLiveSession(port, mapKey, session),
    (error) => !(error instanceof RouteRecycleOwnershipChangedError),
  );
}

function routeRecycleLifecycle(port: ModelPinPort): RouteRecycleLifecycle<SessionManager> {
  return port.routeRecycleLifecycle ?? new RouteRecycleLifecycle({
    pending: port.pendingRecycle,
    promises: port.recyclePromises,
    owners: port.recycleOwners,
    failures: port.recycleFailures,
  });
}

/**
 * Detach the live session from every map/queue it is reachable through —
 * synchronously, so the caller's subsequent "does a session exist" check
 * (ensureSessionAndQueueSync, reached either immediately after an idle
 * recycle or on the next inbound after a deferred one) sees none and
 * respawns fresh. Per-chat teardown starts first and its promise is registered
 * with the actor-socket manager before detachment. The next spawn may be
 * requested immediately, but its provider-transition readiness remains blocked
 * until the old child proves stopped and the scoped turn queue terminalizes; a
 * rejected proof keeps the old ownership fail-closed.
 *
 * Per-chat teardown uses the same provider-transition barrier as idle eviction
 * and /kill-session, then aborts and terminalizes the runtime TurnQueue, drops
 * chatSessions/chatQueues, and clears generation state without releasing the
 * actor socket early. It does NOT use resetOwnedPerChatSession, which respawns
 * the SAME manager with its
 * cached readonly model and would never apply the switch. Single/shared
 * teardown mirrors /kill-session's else branch.
 */
export async function recycleLiveSession(
  port: ModelPinPort,
  mapKey: string | undefined,
  session: SessionManager,
): Promise<void> {
  if (port.sessionScope === 'per_chat') {
    const key = mapKey!;
    const childStopped = session.shutdown(false);
    port.chatQueues.get(key)?.abortTurn();
    const turnTerminalized =
      port.runtimeTurnCoordinator.terminalizePerChatTurnQueueForKill(key);
    const transitionSettled = Promise.all([childStopped, turnTerminalized])
      .then(() => undefined);
    port.retirePerChatProviderTransitionAfter(key, transitionSettled);
    port.deleteOwnedPerChatSession(key, session);
    port.chatQueues.delete(key);
    port.cleanupPerChatState(key, { preserveActorSocket: true });
    void turnTerminalized.catch(() => {
      log.error('route recycle: runtime turn queue teardown failed');
    });
    void childStopped.catch(() => {
      log.warn('route recycle: session shutdown failed');
    });
    return;
  }
  if (port.session !== session) {
    throw new RouteRecycleOwnershipChangedError(
      'Singleton/shared session ownership changed before route recycle',
    );
  }
  const activeQueue = port.getActiveQueue();
  const queue = port.queue;
  const activeChatJid = port.activeChatJid;
  const operationTracker = port.operationTracker;
  await session.shutdown(false);
  if (
    port.session !== session
    || port.getActiveQueue() !== activeQueue
    || port.queue !== queue
    || port.activeChatJid !== activeChatJid
    || port.operationTracker !== operationTracker
  ) {
    throw new RouteRecycleOwnershipChangedError(
      'Singleton/shared ownership changed during route recycle',
    );
  }
  activeQueue?.abortTurn({ preserveEvidence: true });
  operationTracker?.shutdown();
  port.operationTracker = null;
  port.cleanupGlobalAutoCompactState();
  port.session = null;
  port.queue = null;
  port.activeChatJid = null;
}

/**
 * Task G (D14): the /model pin echo now discloses what actually happens
 * to the live session, not just the store write — the C3/D10 "Pinned …
 * for 24h" shape is kept ONLY for a no-op (nothing to recycle); a genuine
 * switch says so, honestly distinguishing "now" from "next message".
 */
export function renderPinOutcomeEcho(
  port: ModelPinPort,
  chatJid: string,
  senderJid: string,
  label: string,
  outcome: RouteRecycleOutcome,
): string {
  return renderPinPreferenceOutcome(
    label,
    outcome,
    fallbackRouteForResolvedPreference(port, chatJid, senderJid),
  );
}

function fallbackRouteForResolvedPreference(
  port: ModelPinPort,
  chatJid: string,
  senderJid: string,
): string | null {
  return port.resolveRouteForTurn(chatJid, senderJid).reasonCode === 'fallback_window_active_model_pin'
    ? null
    : fallbackRouteLabel(port.effectiveFallbackEntry);
}

/**
 * Important-1 (final-review): a 'refreshed'/'sticky_kept' pin outcome means
 * THIS sender's own row didn't change shape — but under chat-scoped last-
 * writer-wins (D13) the write still bumps that row's updated_at, which can
 * flip the CHAT's winning preference out from under a DIFFERENT sender's
 * more-recent pin (group re-confirm interleaving: A pins, B pins, A
 * re-confirms — A's re-confirm now wins the chat again). The three pin
 * handlers used to `break` on refreshed/sticky_kept WITHOUT ever calling
 * applyRouteChangeAndRecycle, so the live session could keep serving B's
 * model while the pin and /model status both claimed A's — silently, until
 * /new. Routing every re-confirm through the SAME diff-gated recycle here
 * closes that: a genuine no-op (DM re-confirm, or a group re-confirm that
 * didn't move the winner) keeps the existing "Already set" echo; an actual
 * winner flip gets the honest recycle echo instead, matching what the live
 * session just did.
 */
export async function echoReconfirmOutcome(
  port: ModelPinPort,
  chatJid: string,
  senderJid: string,
  perChatMapKey: string | undefined,
  label: string,
  alreadySetText: string,
): Promise<string> {
  const fallbackOutcome = fallbackReconfirmationOutcome(
    label,
    alreadySetText,
    fallbackRouteForResolvedPreference(port, chatJid, senderJid),
  );
  if (fallbackOutcome) return fallbackOutcome;
  const recycleOutcome = await applyRouteChangeAndRecycle(port, chatJid, senderJid, perChatMapKey);
  if (recycleOutcome === 'noop') return alreadySetText;
  return renderPinOutcomeEcho(port, chatJid, senderJid, label, recycleOutcome);
}

/**
 * Slice 1 — the shared pin tail. Records a resolved (provider, model)
 * selection, verifies it against the catalogue at pin time (Task H), applies
 * the live-session recycle (Task G), and echoes the outcome. Factored out of
 * the `/model N` numbered-pick branch so the `/model <vendor/model>` direct
 * selector reuses the EXACT same sink — one verify seam, one echo vocabulary,
 * byte-identical pins — rather than a divergent copy that could drift.
 *
 * ROUTABILITY IS NOT VALIDATED HERE, and the (provider, model) is not even
 * always CONFIGURED. Three callers reach this sink with different resolution
 * sources: the `/model <id>` direct selector and the flat `/model N` numbered
 * pick both resolve against the CONFIGURED set (`configuredModelEntries` /
 * `sendDynamicModelCatalogueSection`, credential-UNFILTERED); the Slice-2 drill
 * LEAF resolves against the provider's FULL LIVE catalogue (a superset of the
 * configured set — the discovery surface). Gating varies too: the selector
 * gates at PROVIDER granularity (`routablePinTargets`), the drill LEAF inherits
 * only the Level-1 per-PROVIDER gate, and the numbered `/model N` pick does not
 * gate at all. NONE gates at MODEL granularity — a model whose provider is
 * routable via a credentialed SIBLING but which is itself uncredentialed can be
 * pinned here (widened by the drill from "configured models" to "the provider's
 * whole catalogue"; owner-accepted, see MODEL-STACK-OWED-DEBT). A model-level
 * gate for all paths is owed debt (needs a model-aware port accessor). A future
 * caller must therefore NOT assume this sink rejects an un-routable or
 * unconfigured pin.
 */
async function pinConfiguredModelEntry(
  port: ModelPinPort,
  ctx: {
    chatJid: string;
    senderJid: string;
    perChatMapKey: string | undefined;
    chatKey: string;
    senderKey: string;
  },
  providerId: string,
  modelId: string,
  effort: string | null = null,
): Promise<void> {
  const { chatJid, senderJid, perChatMapKey, chatKey, senderKey } = ctx;
  const outcome = recordRouteModelPin(port, chatJid, chatKey, senderKey, providerId, modelId, effort);
  if (outcome === 'refreshed') {
    port.sendDirect(chatJid, await echoReconfirmOutcome(
      port, chatJid, senderJid, perChatMapKey, modelId,
      '_Already set — extended for another 24h. /reset to go back to the default route._',
    ));
    return;
  }
  if (outcome === 'sticky_kept') {
    port.sendDirect(chatJid, await echoReconfirmOutcome(
      port, chatJid, senderJid, perChatMapKey, modelId,
      '_Already set (sticky). /reset to go back to the default route._',
    ));
    return;
  }
  // Task H: verify the fresh pin against the catalogue BEFORE the echo
  // (awaited — no fire-and-forget) so a subsequent read (this same reply,
  // /model status, a next-session spawn) never observes an unverified pin
  // the catalogue would have rejected.
  const verifyResult = await verifyModelPinAgainstCatalogue(port, chatKey, senderKey, providerId, modelId);
  if (typeof verifyResult === 'object') {
    port.sendDirect(
      chatJid,
      `_Couldn't pin ${modelId} — ${verifyResult.dropped}. Still on the default route; try /model list._`,
    );
    return;
  }
  // Task G: the recycle must run AFTER H's verify — resolveRouteForTurn needs
  // the now-VERIFIED pin, or a recycle here would respawn the session on the
  // provider default and defeat the switch. Still runs on a DEFERRED verify
  // too — a provider switch (if any) is real even though the model stays
  // unverified.
  const recycleOutcome = await applyRouteChangeAndRecycle(port, chatJid, senderJid, perChatMapKey);
  if (verifyResult === 'deferred') {
    port.sendDirect(
      chatJid,
      `_Pinned ${providerId} — ${modelId} pending a catalogue check; using ${providerId}'s default until then. /reset to undo._`,
    );
    return;
  }
  // Slice 3: an effort pin discloses the level in the receipt (charter #6 — the
  // receipt says what changed); a null effort (Default / no-rc model) echoes the
  // model alone, so the pre-Slice-3 receipt is byte-identical when no effort is set.
  const echoLabel = effort ? `${modelId} (${prettyEffortLabel(effort).toLowerCase()} reasoning)` : modelId;
  port.sendDirect(chatJid, renderPinOutcomeEcho(port, chatJid, senderJid, echoLabel, recycleOutcome));
}

/**
 * Slice 2 — Level-1 of the `/model` drill-down: the routable BRANDS (one per
 * brand, credentialed-provider-backed). Pure compute over the port; the
 * degrade path (routablePinTargets throws — a keychain blip) is fail-open
 * (R11): the caller writes an empty snapshot + honest copy rather than
 * throwing out of a read-only menu render. The current route's brand is marked
 * `(current)` so the user sees where they are without a status readout.
 */
function computeBrandLevel(
  port: ModelPinPort,
  chatJid: string,
  senderJid: string,
): { rendered: RenderedLevel } | { degraded: true } {
  // Guard the WHOLE body, not just routablePinTargets: resolveRouteForTurn
  // reads the preference store and can throw the same DB-blip class (the
  // pruneExpired call above is try/caught for exactly that reason). An escape
  // here would skip the empty-snapshot write below and leave a STALE FLAT slot
  // resolvable — the stale-pin this design exists to foreclose.
  try {
    const routable = port.routablePinTargets();
    const brands = listBrands(routable.map((id) => ({ id })));
    const currentBrand = brandOf(port.resolveRouteForTurn(chatJid, senderJid).provider);
    return { rendered: renderBrandLevel(brands, currentBrand) };
  } catch {
    return { degraded: true };
  }
}

/**
 * Send the drill Level-1 brand menu (bare `/model`, or a `/model N` re-render
 * when there is no live menu). Always writes the drill 'brand' snapshot BEFORE
 * sending so a following `/model N` resolves against exactly what was shown —
 * including on the degrade/empty paths (an empty snapshot makes a following
 * `/model N` MISS cleanly rather than resolve a stale flat list, since
 * putDrillSnapshot overwrites the shared latest slot).
 */
function sendModelDrillBrandLevel(port: ModelPinPort, chatJid: string, senderJid: string): void {
  const result = computeBrandLevel(port, chatJid, senderJid);
  if ('degraded' in result) {
    port.catalogueSnapshot.putDrillSnapshot(chatJid, senderJid, 'brand', []);
    port.sendDirect(chatJid, "_Couldn't read your configured providers right now — try again._");
    return;
  }
  const { rendered } = result;
  port.catalogueSnapshot.putDrillSnapshot(chatJid, senderJid, 'brand', rendered.entries);
  if (rendered.entries.length === 0) {
    port.sendDirect(chatJid, '_No providers are set up to pick from yet._');
    return;
  }
  port.sendDirect(chatJid, rendered.text);
}

/**
 * Send the drill Level-2 model menu for a brand the user picked at Level-1.
 * Fetches the provider's live catalogue via the SAME injectable resolver
 * seam the pin-time verify uses (modelCatalogueListFn/anthropicFn — a test
 * never spawns a binary). A fetch that is not `ok` degrades honestly and
 * leaves the Level-1 brand snapshot intact so the user can re-pick, rather
 * than stranding them. On success writes the drill 'model' snapshot (the leaf
 * entries) so `/model N` pins the model they saw.
 */
async function sendModelDrillModelLevel(
  port: ModelPinPort,
  chatJid: string,
  senderJid: string,
  brand: string,
  provider: string,
): Promise<void> {
  const listing = await fetchProviderCatalogue(port, provider);
  if (listing.status !== 'ok') {
    port.sendDirect(chatJid, `_Couldn't load ${brand} models right now — try again._`);
    return;
  }
  const route = port.resolveRouteForTurn(chatJid, senderJid);
  const currentModel = route.provider === provider ? route.model : null;
  // Bound the render the same way the flat menu does (MODEL_CATALOGUE_CAP): a
  // chatty provider's live catalogue is unbounded, and an uncapped numbered
  // list makes an unusable WhatsApp message. The snapshot stores exactly what
  // was SHOWN, so a number always resolves to a visible row.
  const shown = listing.ids.slice(0, MODEL_CATALOGUE_CAP);
  const rendered = renderModelLevel(brand, provider, shown, currentModel);
  port.catalogueSnapshot.putDrillSnapshot(chatJid, senderJid, 'model', rendered.entries);
  const text = shown.length < listing.ids.length
    ? `${rendered.text}\n_showing 1–${shown.length} of ${listing.ids.length}_`
    : rendered.text;
  port.sendDirect(chatJid, text);
}

/**
 * Slice 3 — send the drill Level-3 reasoning-effort menu for a model the user
 * picked at Level-2 whose (provider, model) has native reasoning control. No
 * fetch (the levels are static per provider), so no degrade path. Writes the
 * drill 'effort' snapshot so a following `/model N` pins the model AT the level
 * they saw; the live route's effort (only when this exact model is the current
 * route) marks the active row `(current)`.
 */
function sendModelDrillEffortLevel(
  port: ModelPinPort,
  chatJid: string,
  senderJid: string,
  provider: string,
  model: string,
  control: ReasoningControl,
): void {
  const route = port.resolveRouteForTurn(chatJid, senderJid);
  const currentEffort = route.provider === provider && route.model === model ? route.effort ?? null : null;
  const rendered = renderEffortLevel(model, provider, control, currentEffort);
  port.catalogueSnapshot.putDrillSnapshot(chatJid, senderJid, 'effort', rendered.entries);
  port.sendDirect(chatJid, rendered.text);
}

/**
 * Slice 2 — a `/model N` MISS (no live snapshot, expired, or out-of-range)
 * discloses "that list moved" and re-renders the CURRENT menu. Kind-aware so a
 * user who is on the flat `/model list` and types an out-of-range number sees
 * the flat list again (not a jarring bounce to the drill), while a true
 * snapshot-miss (no live menu, null) opens the drill Level-1 — the ratified
 * entry point. A live drill slot re-opens Level-1 too (its brand level is the
 * stable re-entry).
 */
function reRenderCurrentMenuOnMiss(port: ModelPinPort, chatJid: string, senderJid: string): void {
  port.sendDirect(chatJid, "_That list moved — here's the current one._");
  if (port.catalogueSnapshot.latestSnapshotKind(chatJid, senderJid) === 'flat') {
    sendModelCatalogue(port, chatJid, senderJid, null);
    return;
  }
  sendModelDrillBrandLevel(port, chatJid, senderJid);
}

/**
 * The `/model` alias handler body (NL-first routing alias, owner-approved
 * design). Records a chat-scoped REASONING preference and renders route
 * visibility — never tool, mutation, or authority changes (capability-
 * preserved routing). Reachable only when agentOptions.nlRouting is true (the
 * classifier gates on the same flag).
 *
 * `args` is the classified command argument (undefined for a bare `/model`,
 * which the status branch distinguishes for its extra affordance line).
 */
export async function handleModelCommand(
  port: ModelPinPort,
  params: {
    chatJid: string;
    senderJid: string;
    args: string | undefined;
    perChatMapKey: string | undefined;
  },
): Promise<void> {
  const { chatJid, senderJid, args, perChatMapKey } = params;
  const sub = (args ?? 'status').trim().toLowerCase();
  const { chatKey, senderKey } = preferenceKeys(port.db, chatJid, senderJid);
  // Opportunistic retention sweep on read (F13); also runs at init. Hoisted to
  // the top (Slice 2) so every /model path — incl. the bare-`/model` drill —
  // sweeps, not just status. Fail-open (R11): a store error must not throw out
  // of the handler.
  try {
    pruneExpired(port.db);
  } catch (err) {
    log.warn({ err, instance: port.instanceName }, 'pruneExpired failed during /model - continuing');
  }
  if (args === undefined) {
    // Slice 2: bare `/model` opens the Level-1 brand drill (owner-ratified) —
    // status moved to the explicit `/model status` below; the L1 `(current)`
    // brand marker is the at-a-glance substitute.
    sendModelDrillBrandLevel(port, chatJid, senderJid);
    return;
  }
  if (sub === '' || sub === 'status') {
    // Explicit `/model status` (or the defensive empty arg) → the route readout.
    port.sendDirect(chatJid, port.renderRouteStatus(chatJid, senderJid));
    return;
  }
  if (sub === 'list' || sub.startsWith('list ')) {
    // The config-derived pin/primary block renders synchronously and
    // unconditionally (Q 2b#1). The DYNAMIC per-harness available-models
    // section is appended by an async, fire-and-forget path so a slow or
    // failed harness probe never holds the turn (Q 2b#3); it degrades
    // independently to a reason-specific "unavailable" line.
    const rawArgs = (args ?? '').trim();
    const filter = sub === 'list'
      ? null
      : rawArgs.slice(rawArgs.toLowerCase().indexOf('list ') + 'list '.length).trim() || null;
    // The config-derived pin/primary block sends IMMEDIATELY so "what
    // am I on" never waits on — or is lost to — the catalogue probe
    // (Q 2b#1).
    sendModelCatalogue(port, chatJid, senderJid, filter);
    return;
  }
  // D6/D16: `/model N default` — resolve N against the snapshot the
  // user was shown, pin the PROVIDER default (no model). Checked
  // before the bare `/model N` form (below) since both are
  // digit-leading. `sub === 'default'` alone is unreachable — C2
  // dropped `default` from the grammar, so a bare `/model default`
  // now forwards to the agent before this handler ever sees it.
  const nDefaultMatch = /^(\d+)\s+default$/.exec(sub);
  if (nDefaultMatch) {
    const n = parseInt(nDefaultMatch[1]!, 10);
    // Flat-only: `/model N default` pins a PROVIDER default (no model), which a
    // drill has no leaf for. resolveCataloguePick is now recency-aware — it
    // returns null when a newer drill superseded the flat menu, so this never
    // pins a stale flat provider (the miss re-renders the current menu).
    const entry = port.catalogueSnapshot.resolveCataloguePick(chatJid, senderJid, n);
    if (!entry) {
      reRenderCurrentMenuOnMiss(port, chatJid, senderJid);
      return;
    }
    const outcome = port.recordRoutePreference(chatJid, chatKey, senderKey, 'provider_specific', entry.providerId);
    if (outcome === 'refreshed') {
      port.sendDirect(chatJid, await echoReconfirmOutcome(
        port, chatJid, senderJid, perChatMapKey, `\`${entry.providerId}\``,
        '_Already set — extended for another 24h. /reset to go back to the default route._',
      ));
      return;
    }
    if (outcome === 'sticky_kept') {
      port.sendDirect(chatJid, await echoReconfirmOutcome(
        port, chatJid, senderJid, perChatMapKey, `\`${entry.providerId}\``,
        '_Already set (sticky). /reset to go back to the default route._',
      ));
      return;
    }
    // Task G: apply the switch immediately (idle) or defer it to the
    // next message (busy) — the echo below discloses which.
    const recycleOutcome = await applyRouteChangeAndRecycle(port, chatJid, senderJid, perChatMapKey);
    port.sendDirect(chatJid, renderPinOutcomeEcho(port, chatJid, senderJid, `\`${entry.providerId}\``, recycleOutcome));
    return;
  }
  // D6/D10/D16 + Slice 2: `/model N` / `/model N<letter>` — resolve N against
  // whichever menu the user saw most recently (flat list OR drill level), the
  // ONE recency source. A flat entry pins in one step (Slice-1 behavior); a
  // drill BRAND entry drills into Level-2; a drill MODEL entry pins the leaf
  // through the same sink. The optional trailing letter (C1 grammar) is
  // tolerated and ignored.
  if (/^\d+[a-z]?$/i.test(sub)) {
    const n = parseInt(sub, 10);
    const pick = port.catalogueSnapshot.resolveLatestPick(chatJid, senderJid, n);
    if (!pick) {
      reRenderCurrentMenuOnMiss(port, chatJid, senderJid);
      return;
    }
    if (pick.kind === 'flat') {
      // The record→verify→recycle→echo tail is the shared pin sink (Slice 1) —
      // the `/model <vendor/model>` direct selector below reuses it verbatim.
      await pinConfiguredModelEntry(
        port,
        { chatJid, senderJid, perChatMapKey, chatKey, senderKey },
        pick.entry.providerId,
        pick.entry.id,
      );
      return;
    }
    if (pick.entry.kind === 'brand') {
      // Level-1 pick → open Level-2 for that brand's provider. (The union
      // narrows on `kind` — brand/provider are non-optional on this arm.)
      await sendModelDrillModelLevel(port, chatJid, senderJid, pick.entry.brand, pick.entry.provider);
      return;
    }
    if (pick.entry.kind === 'model') {
      // Slice 3: a model with native reasoning control (claude-cli today) opens
      // Level-3 to pick an effort instead of pinning immediately.
      const control = nativeReasoningControl(pick.entry.provider, pick.entry.model);
      if (control) {
        sendModelDrillEffortLevel(port, chatJid, senderJid, pick.entry.provider, pick.entry.model, control);
        return;
      }
    }
    // Both remaining arms pin through the SAME sink, differing only in effort: a
    // Level-2 model with no reasoning control pins the leaf at no effort (drill
    // leaf-pin, unchanged), and a Level-3 pick pins AT its effort (null = the
    // "Default (no override)" row, which clears any pin).
    await pinConfiguredModelEntry(
      port,
      { chatJid, senderJid, perChatMapKey, chatKey, senderKey },
      pick.entry.provider,
      pick.entry.model,
      pick.entry.kind === 'effort' ? pick.entry.effort : null,
    );
    return;
  }
  // Slice 1 — `/model <vendor/model>` direct selector (power-user path). The
  // classifier (commands.ts isStructuredModelArg) only routes an explicit
  // `vendor/model` id here; resolve it against the CONFIGURED (provider, model)
  // entries — the exact set /model list enumerates — then pin through the SAME
  // sink the numbered pick uses. rawArgs (case-PRESERVED, not the lowercased
  // `sub`) because model ids are case-sensitive.
  const directModelId = (args ?? '').trim();
  if (isExplicitModelId(directModelId)) {
    // F03: MODEL_ID_RE excludes the markdown-breaking chars (backtick, *, \n),
    // but admits `_` (breaks WhatsApp italics) and has NO length cap, so bound
    // the user-controlled id before echoing it into a possibly-group chat —
    // mirroring the provider-id reject path's sanitize+cap discipline.
    const shownId = directModelId.length > 64 ? `${directModelId.slice(0, 64)}…` : directModelId;
    const matches = configuredModelEntries(port).filter((entry) => entry.model === directModelId);
    if (matches.length === 0) {
      port.sendDirect(
        chatJid,
        `_${shownId} isn't configured on this instance. Use /model list to see configured models._`,
      );
      return;
    }
    if (matches.length > 1) {
      // Two configured routes share this model id (different providers) — a
      // silent array-order pick would be a coin flip. Make the user
      // disambiguate by number instead.
      port.sendDirect(
        chatJid,
        `_${shownId} matches more than one configured route. Use /model list and reply with its number._`,
      );
      return;
    }
    const target = matches[0]!;
    // F07 parity with `/model <provider>` (below): reject a non-routable target
    // at SET time so recording it can't force slice-2 resolution into a
    // hard-fail or silent fallback. NOTE the granularity: routablePinTargets is
    // PER-PROVIDER, so this rejects only when the whole PROVIDER is
    // un-routable. A model whose provider is routable via a credentialed
    // SIBLING model but which is itself uncredentialed still passes here — the
    // same (wider) gap the ungated `/model N` path has. A model-level gate for
    // both paths is owed debt (needs a model-aware port accessor).
    if (!port.routablePinTargets().includes(target.provider)) {
      port.sendDirect(
        chatJid,
        `_${shownId} isn't available on this instance right now. Use /model list to see what you can pick._`,
      );
      return;
    }
    await pinConfiguredModelEntry(
      port,
      { chatJid, senderJid, perChatMapKey, chatKey, senderKey },
      target.provider,
      target.model,
    );
    return;
  }
  const isIntent = sub === 'strongest' || sub === 'fastest';
  const isProvider = isProviderId(sub);
  if (isProvider) {
    const routable = port.routablePinTargets();
    if (!routable.includes(sub)) {
      // A pin this instance cannot honor must fail at SET time (F07):
      // recording it would force slice-2 resolution into either a
      // hard-fail or a silent fallback. No row is written.
      port.sendDirect(
        chatJid,
        `_${sub} isn't available on this instance. Available: ${routable.join(', ')}. /model status shows the current route._`,
      );
      return;
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
    port.sendDirect(
      chatJid,
      `_I do not recognize "${safeSub}". Use /model status to see available routes._`,
    );
    return;
  }
  const intent = isIntent ? (sub as 'strongest' | 'fastest') : 'provider_specific';
  const requestedProvider = isProvider ? sub : null;
  // D10: same plain, timing-neutral affordance shape as the numbered-
  // pick paths below — no "for you" (chat-scoped, D13a). Task G now
  // makes the switch take effect (recycled/deferred), so the old
  // blanket "applies from your next session" deferral never returns.
  // Computed before the outcome branch below so the refreshed/
  // sticky_kept re-confirm echo can reuse it too (Important-1).
  const what = isProvider ? `\`${sub}\`` : `my ${sub} model`;
  const outcome = port.recordRoutePreference(chatJid, chatKey, senderKey, intent, requestedProvider);
  if (outcome === 'refreshed') {
    port.sendDirect(chatJid, await echoReconfirmOutcome(
      port, chatJid, senderJid, perChatMapKey, what,
      '_Already set — extended for another 24h. /reset to go back to the default route._',
    ));
    return;
  }
  if (outcome === 'sticky_kept') {
    port.sendDirect(chatJid, await echoReconfirmOutcome(
      port, chatJid, senderJid, perChatMapKey, what,
      '_Already set (sticky). /reset to go back to the default route._',
    ));
    return;
  }
  const recycleOutcome = await applyRouteChangeAndRecycle(port, chatJid, senderJid, perChatMapKey);
  port.sendDirect(chatJid, renderPinOutcomeEcho(port, chatJid, senderJid, what, recycleOutcome));
}
