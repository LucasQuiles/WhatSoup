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
import { createChildLogger } from '../../logger.ts';
import { GLOBAL_CONVERSATION_KEY, toConversationKey } from '../../core/conversation-key.ts';
import type { fetchAnthropicModelIdsWithStatus } from '../../lib/model-advisor.ts';
import {
  getPreference,
  setPreference,
  pruneExpired,
  clearChatPreference,
  type PreferenceIntent,
} from './chat-preference-db.ts';
import { preferenceKeys } from './preference-keys.ts';
import { decideModelPinResolution, type CatalogueOutcome } from './config-surface.ts';
import { resolveModelCatalogue } from './model-catalogue-resolver.ts';
import type { ModelRouteEvent } from './route-events.ts';
import type { RouteDecision } from './route-resolution.ts';
import { isProviderId } from './providers/index.ts';
import type { listModelCatalog } from './providers/binary-preflight.ts';
import { getProviderBinary, type SessionManager } from './session.ts';
import type { IOutboundQueue } from './outbound-queue.ts';
import type { OperationTracker } from './operation-tracker.ts';
import {
  sendModelCatalogue,
  type ModelCatalogueRenderPort,
} from './model-catalogue-render.ts';
import {
  fallbackReconfirmationOutcome,
  fallbackRouteLabel,
  renderPinPreferenceOutcome,
} from './owner-render-format.ts';

// Same component name as AgentRuntime: the warnings below keep their existing
// `component: 'agent-runtime'` log binding (no observable change).
const log = createChildLogger('agent-runtime');

/** Scope key for the single/shared session (mirrors runtime.ts's GLOBAL_TOOL_SCOPE_KEY). */
const GLOBAL_TOOL_SCOPE_KEY = GLOBAL_CONVERSATION_KEY;

/** TTL for an ephemeral (non-sticky) route preference row. */
export const PREFERENCE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Task G (D14) — outcome of applyRouteChangeAndRecycle: 'recycled' (idle,
 * torn down now — the next inbound respawns on the new route), 'deferred'
 * (a turn was in flight — a pendingRecycle flag was set instead), or 'noop'
 * (no live session, or the resolved route already matched it).
 */
export type RouteRecycleOutcome = 'recycled' | 'deferred' | 'noop';

/**
 * The AgentRuntime surface the pin/recycle path reads and mutates. Declared
 * here rather than importing AgentRuntime so this module stays free of a cycle
 * back into runtime.ts; the runtime supplies it as a host object.
 */
export interface ModelPinPort extends ModelCatalogueRenderPort {
  readonly db: Database;
  readonly sessionScope: 'single' | 'shared' | 'per_chat';
  readonly pendingRecycle: Set<string>;
  readonly chatSessions: Map<string, SessionManager>;
  readonly chatQueues: Map<string, IOutboundQueue>;
  readonly runtimeTurnCoordinator: {
    terminalizePerChatTurnQueueForKill(mapKey: string): Promise<void>;
  };
  readonly modelCatalogueListFn: typeof listModelCatalog | undefined;
  readonly modelCatalogueAnthropicFn: typeof fetchAnthropicModelIdsWithStatus | undefined;
  readonly effectiveFallbackEntry: AgentFallbackEntry | null;
  session: SessionManager | null;
  queue: IOutboundQueue | null;
  activeChatJid: string | null;
  operationTracker: OperationTracker | null;
  resolveRouteForTurn(chatJid: string, actorJid?: string): RouteDecision & { pinnedProvider: string | null };
  resolvePerChatMapKey(chatJid: string): string;
  isTurnInFlight(scopeKey: string): boolean;
  getActiveQueue(): IOutboundQueue | null;
  deleteOwnedPerChatSession(mapKey: string, expected?: SessionManager): boolean;
  cleanupPerChatState(
    mapKey: string,
    options?: { preserveCrashHistory?: boolean; preserveProviderTurnOwnership?: boolean },
  ): void;
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
): 'set' | 'refreshed' | 'sticky_kept' {
  const now = Date.now();
  const existing = getPreference(port.db, chatKey, senderKey, now);
  if (
    existing &&
    existing.intent === 'provider_specific' &&
    existing.requestedProvider === providerId &&
    existing.requestedModel === model
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
export async function verifyModelPinAgainstCatalogue(
  port: ModelPinPort,
  chatKey: string,
  senderKey: string,
  providerId: string,
  model: string,
): Promise<'verified' | 'deferred' | { dropped: string }> {
  const binary = getProviderBinary(providerId) ?? providerId;
  const listing = await resolveModelCatalogue(providerId, binary, {
    nowMs: Date.now(),
    listFn: port.modelCatalogueListFn,
    anthropicFn: port.modelCatalogueAnthropicFn,
  });
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
 * EAGER-when-idle + defer-when-busy: idle recycles NOW (detach + fire-
 * and-forget shutdown, mirroring /kill-session's teardown so the next
 * inbound finds no session and respawns via createSessionManager — the
 * sole route.model chokepoint); busy sets a pendingRecycle flag consumed
 * at the next turn-idle boundary (consumePendingRecycleIfIdle) and NEVER
 * tears down mid-turn.
 */
export function applyRouteChangeAndRecycle(
  port: ModelPinPort,
  chatJid: string,
  senderJid: string,
  perChatMapKey: string | undefined,
): RouteRecycleOutcome {
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
  if (session.getProviderId() === next.provider && session.getModelRef() === next.model) {
    return 'noop';
  }
  if (port.isTurnInFlight(scopeKey)) {
    port.pendingRecycle.add(scopeKey);
    return 'deferred';
  }
  recycleLiveSession(port, port.sessionScope === 'per_chat' ? scopeKey : undefined, session);
  port.pendingRecycle.delete(scopeKey);
  return 'recycled';
}

/**
 * Consumption hook for a deferred recycle (Task G busy branch). Called at
 * the top of ensureSessionAndQueueSync — the point every inbound message
 * reaches BEFORE any turn dispatch or "does a session exist" check — so
 * this can only ever fire between turns, never mid-turn: it re-checks
 * isTurnInFlight itself (a turn may still be draining, or a new one may
 * already be queued behind it) and leaves the flag set to try again on a
 * later message if so.
 */
export function consumePendingRecycleIfIdle(port: ModelPinPort, scopeKey: string): void {
  if (!port.pendingRecycle.has(scopeKey)) return;
  if (port.isTurnInFlight(scopeKey)) return;
  port.pendingRecycle.delete(scopeKey);
  const session = port.sessionScope === 'per_chat'
    ? port.chatSessions.get(scopeKey)
    : port.session;
  if (!session) return;
  recycleLiveSession(port, port.sessionScope === 'per_chat' ? scopeKey : undefined, session);
}

/**
 * Detach the live session from every map/queue it is reachable through —
 * synchronously, so the caller's subsequent "does a session exist" check
 * (ensureSessionAndQueueSync, reached either immediately after an idle
 * recycle or on the next inbound after a deferred one) sees none and
 * respawns fresh. The actual process teardown is fire-and-forget past
 * that point (mirrors the existing idle-eviction precedent,
 * evictIdleSession) — detachment, not the kill finishing, is what next
 * inbound's respawn correctness depends on.
 *
 * Per-chat teardown mirrors /kill-session's per-chat branch exactly
 * (abort queue, terminalize the runtime TurnQueue, drop from
 * chatSessions/chatQueues, cleanupPerChatState, shutdown(false)) — NOT
 * resetOwnedPerChatSession, which respawns the SAME manager with its
 * cached readonly model and would never apply the switch. Single/shared
 * teardown mirrors /kill-session's else branch.
 */
export function recycleLiveSession(
  port: ModelPinPort,
  mapKey: string | undefined,
  session: SessionManager,
): void {
  if (port.sessionScope === 'per_chat') {
    const key = mapKey!;
    port.chatQueues.get(key)?.abortTurn();
    port.deleteOwnedPerChatSession(key, session);
    port.chatQueues.delete(key);
    port.cleanupPerChatState(key);
    void port.runtimeTurnCoordinator.terminalizePerChatTurnQueueForKill(key)
      .catch((err) => {
        log.error({ err, mapKey: key }, 'route recycle: runtime turn queue teardown failed');
      })
      .finally(() => {
        void session.shutdown(false).catch((err) => {
          log.warn({ err, mapKey: key }, 'route recycle: session shutdown failed');
        });
      });
    return;
  }
  port.getActiveQueue()?.abortTurn();
  port.operationTracker?.shutdown();
  port.operationTracker = null;
  port.cleanupGlobalAutoCompactState();
  port.session = null;
  port.queue = null;
  port.activeChatJid = null;
  void session.shutdown(false).catch((err) => {
    log.warn({ err }, 'route recycle: session shutdown failed');
  });
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
export function echoReconfirmOutcome(
  port: ModelPinPort,
  chatJid: string,
  senderJid: string,
  perChatMapKey: string | undefined,
  label: string,
  alreadySetText: string,
): string {
  const fallbackOutcome = fallbackReconfirmationOutcome(
    label,
    alreadySetText,
    fallbackRouteForResolvedPreference(port, chatJid, senderJid),
  );
  if (fallbackOutcome) return fallbackOutcome;
  const recycleOutcome = applyRouteChangeAndRecycle(port, chatJid, senderJid, perChatMapKey);
  if (recycleOutcome === 'noop') return alreadySetText;
  return renderPinOutcomeEcho(port, chatJid, senderJid, label, recycleOutcome);
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
  if (sub === '' || sub === 'status') {
    // Opportunistic retention sweep on read (F13); also runs at init.
    // Fail-open (R11): a store error on the sweep must not throw out of
    // this read-only handler — status still renders on the default route.
    try {
      pruneExpired(port.db);
    } catch (err) {
      log.warn({ err, instance: port.instanceName }, 'pruneExpired failed during /model status - continuing');
    }
    // B26: bare /model gets ONE discoverability affordance line for
    // the catalogue; an explicit /model status stays as-is.
    const routeStatus = port.renderRouteStatus(chatJid, senderJid);
    port.sendDirect(
      chatJid,
      args === undefined
        ? `${routeStatus}\n_/model list — see what you can pick_`
        : routeStatus,
    );
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
    const entry = port.catalogueSnapshot.resolveCataloguePick(chatJid, senderJid, n);
    if (!entry) {
      port.sendDirect(chatJid, "_That list moved — here's the current one._");
      sendModelCatalogue(port, chatJid, senderJid, null);
      return;
    }
    const outcome = port.recordRoutePreference(chatJid, chatKey, senderKey, 'provider_specific', entry.providerId);
    if (outcome === 'refreshed') {
      port.sendDirect(chatJid, echoReconfirmOutcome(
        port, chatJid, senderJid, perChatMapKey, `\`${entry.providerId}\``,
        '_Already set — extended for another 24h. /reset to go back to the default route._',
      ));
      return;
    }
    if (outcome === 'sticky_kept') {
      port.sendDirect(chatJid, echoReconfirmOutcome(
        port, chatJid, senderJid, perChatMapKey, `\`${entry.providerId}\``,
        '_Already set (sticky). /reset to go back to the default route._',
      ));
      return;
    }
    // Task G: apply the switch immediately (idle) or defer it to the
    // next message (busy) — the echo below discloses which.
    const recycleOutcome = applyRouteChangeAndRecycle(port, chatJid, senderJid, perChatMapKey);
    port.sendDirect(chatJid, renderPinOutcomeEcho(port, chatJid, senderJid, `\`${entry.providerId}\``, recycleOutcome));
    return;
  }
  // D6/D10/D16: `/model N` / `/model N<letter>` — a named-model pin
  // in ONE step. The optional trailing letter (C1's structured
  // grammar) is tolerated and ignored; the snapshot is a flat list.
  if (/^\d+[a-z]?$/i.test(sub)) {
    const n = parseInt(sub, 10);
    const entry = port.catalogueSnapshot.resolveCataloguePick(chatJid, senderJid, n);
    if (!entry) {
      port.sendDirect(chatJid, "_That list moved — here's the current one._");
      sendModelCatalogue(port, chatJid, senderJid, null);
      return;
    }
    const outcome = recordRouteModelPin(port, chatJid, chatKey, senderKey, entry.providerId, entry.id);
    if (outcome === 'refreshed') {
      port.sendDirect(chatJid, echoReconfirmOutcome(
        port, chatJid, senderJid, perChatMapKey, entry.id,
        '_Already set — extended for another 24h. /reset to go back to the default route._',
      ));
      return;
    }
    if (outcome === 'sticky_kept') {
      port.sendDirect(chatJid, echoReconfirmOutcome(
        port, chatJid, senderJid, perChatMapKey, entry.id,
        '_Already set (sticky). /reset to go back to the default route._',
      ));
      return;
    }
    // Task H: verify the fresh pin against the catalogue BEFORE the
    // echo (awaited — no fire-and-forget) so a subsequent read
    // (this same reply, /model status, a next-session spawn) never
    // observes an unverified pin the catalogue would have rejected.
    const verifyResult = await verifyModelPinAgainstCatalogue(port, chatKey, senderKey, entry.providerId, entry.id);
    if (typeof verifyResult === 'object') {
      port.sendDirect(
        chatJid,
        `_Couldn't pin ${entry.id} — ${verifyResult.dropped}. Still on the default route; try /model list._`,
      );
      return;
    }
    // Task G: the recycle must run AFTER H's verify — resolveRouteForTurn
    // needs the now-VERIFIED pin, or a recycle here would respawn the
    // session on the provider default and defeat the switch. Still
    // runs on a DEFERRED verify too — a provider switch (if any) is
    // real even though the model itself stays unverified.
    const recycleOutcome = applyRouteChangeAndRecycle(port, chatJid, senderJid, perChatMapKey);
    if (verifyResult === 'deferred') {
      // MINOR 3 (final-review): decideModelPinResolution's
      // needs-catalogue fail-open means an unverified pin never
      // sets route.model — only a provider switch (if the pin's
      // provider is eligible) actually takes effect. The old D10
      // echo claimed the specific model was pinned/serving
      // regardless; say what actually happens instead.
      port.sendDirect(
        chatJid,
        `_Pinned ${entry.providerId} — ${entry.id} pending a catalogue check; using ${entry.providerId}'s default until then. /reset to undo._`,
      );
      return;
    }
    port.sendDirect(chatJid, renderPinOutcomeEcho(port, chatJid, senderJid, entry.id, recycleOutcome));
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
    port.sendDirect(chatJid, echoReconfirmOutcome(
      port, chatJid, senderJid, perChatMapKey, what,
      '_Already set — extended for another 24h. /reset to go back to the default route._',
    ));
    return;
  }
  if (outcome === 'sticky_kept') {
    port.sendDirect(chatJid, echoReconfirmOutcome(
      port, chatJid, senderJid, perChatMapKey, what,
      '_Already set (sticky). /reset to go back to the default route._',
    ));
    return;
  }
  const recycleOutcome = applyRouteChangeAndRecycle(port, chatJid, senderJid, perChatMapKey);
  port.sendDirect(chatJid, renderPinOutcomeEcho(port, chatJid, senderJid, what, recycleOutcome));
}
