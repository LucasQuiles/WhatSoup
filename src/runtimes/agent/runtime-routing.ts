// src/runtimes/agent/runtime-routing.ts
// Routing + model-preference coordinator, extracted from AgentRuntime (#1977 D1).
//
// Owns per-turn route resolution (resolveRouteForTurn and its helpers), the
// preference read/write paths shared by the /model aliases and NL typed
// intents, the streaming route-marker scan, and the route-visibility renders
// (/model status, /status model line). All runtime state is reached through
// the RuntimeRoutingPort host — this module holds no shared runtime members
// of its own; the two conversation-keyed bookkeeping maps stay owned by
// AgentRuntime (torn down in cleanupPerChatState, LEAK-15) and pass through
// the port by reference.

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Database } from '../../core/database.ts';
import type { AgentFallbackEntry } from '../../core/fallback-chain.ts';
import {
  ProviderDataPolicyError,
  providerRoutePolicyKey,
  resolveProviderRoutePolicy,
  type ProviderBoundaryMode,
  type ProviderDataPolicy,
} from '../../core/provider-data-policy.ts';
import { toConversationKey } from '../../core/conversation-key.ts';
import { createChildLogger } from '../../logger.ts';
import {
  getPreference,
  setPreference,
  getLatestChatPreference,
  clearChatPreference,
  type ChatModelPreference,
  type PreferenceIntent,
} from './chat-preference-db.ts';
import { preferenceKeys } from './preference-keys.ts';
import { applyRouteEffort, isPinnedModelEligible, resolveRoute, type RouteDecision } from './route-resolution.ts';
import { decideModelPinResolution } from './config-surface.ts';
import { deriveChatScope, emitRouteEvent, type ModelRouteEvent } from './route-events.ts';
import { extractRouteIntents } from './route-intent.ts';
import {
  applyRouteChangeAndRecycle as applyRouteChangeAndRecycleForPort,
  PREFERENCE_TTL_MS,
  type ModelPinPort,
  type RouteRecycleOutcome,
} from './model-pin.ts';
import { fallbackProviderConfigFor } from './fallback-config.ts';
import { bulletedSection, savedPreferenceLine } from './owner-render-format.ts';
import type { SessionManager } from './session.ts';

const log = createChildLogger('agent-runtime');

/**
 * Host port for the routing coordinator — the same live-getter shape as
 * ChatTransportPort (runtime.ts createChatTransportHost): every data field is
 * a live getter on the runtime, never a value captured at construction,
 * because tests replace several of these (agentFallbacks, nlRoutingEnabled,
 * chatSessions) by direct field assignment on the runtime instance after
 * construction.
 */
export interface RuntimeRoutingPort {
  readonly db: Database;
  readonly instanceName: string;
  readonly sessionScope: 'single' | 'shared' | 'per_chat';
  readonly agentProvider: string;
  readonly agentProviderConfig: Record<string, unknown> | undefined;
  readonly model: string | undefined;
  readonly agentFallbacks: AgentFallbackEntry[];
  readonly nlRoutingEnabled: boolean;
  /** Composition-ring config reads, passed through the host so this module
   *  never imports src/config.ts (ring boundary). */
  readonly nlRouting: boolean;
  readonly nlRoutingTiers: { strongest?: string; fastest?: string } | null;
  readonly nlRoutingEventsDir: string | null;
  readonly agentDataPolicy: ProviderDataPolicy | null;
  readonly providerBoundaryMode: ProviderBoundaryMode;
  readonly chatSessions: Map<string, SessionManager>;
  readonly session: SessionManager | null;
  readonly effectiveFallbackEntry: AgentFallbackEntry | null;
  readonly effectiveModel: string | undefined;
  readonly isFallbackWindowActive: boolean;
  readonly modelPinHost: ModelPinPort;
  /** Last pin-block notice per conversation (one notice per transition). Owned by AgentRuntime; torn down in cleanupPerChatState (LEAK-15). */
  readonly lastPinBlockNotice: Map<string, string>;
  /** Last spawn provider per conversation — runtime_switched detection (slice 4). Owned by AgentRuntime; torn down in cleanupPerChatState (LEAK-15). */
  readonly lastSpawnRouteProvider: Map<string, string>;
  sessionProviderConfig(): Record<string, unknown> | undefined;
  resolvePerChatMapKey(chatJid: string): string;
  sendDirect(chatJid: string, text: string): void;
  /** Credential-probe pair — stays on AgentRuntime (shared with the fallback
   *  selector's eligibility loop, C4, and stubbed as an instance property by
   *  the routing/model-pin characterization suites). */
  routablePinTargets(): string[];
  isEntryCredentialed(entry: AgentFallbackEntry): boolean;
}

export class RuntimeRoutingCoordinator {
  private readonly host: RuntimeRoutingPort;

  constructor(host: RuntimeRoutingPort) {
    this.host = host;
  }

  /**
   * Per-spawn route resolution (slice-2 B2). Preferences are an INPUT to the
   * pure resolveRoute core, never an override of fallback/health state; the
   * decision applies to the session being spawned (provider/model stay
   * per-session and read-only).
   */
  resolveRouteForTurn(
    chatJid: string,
    actorJid?: string,
  ): RouteDecision & { pinnedProvider: string | null } {
    // Fail-open over the WHOLE resolution (R13): the preference read AND the
    // routablePinTargets credential probe both do I/O that can throw. A
    // resolution failure must degrade to the default route and NEVER drop a
    // turn — so the pin probe is inside this guard, not just the pref read.
    try {
      const pref = this.host.nlRoutingEnabled && actorJid
        ? this.loadSenderPreference(chatJid, actorJid)
        : null;
      const pinned = pref?.intent === 'provider_specific' ? pref.requestedProvider : null;
      // The tier provider this pref maps to (if any) is probed for routability
      // the same way a pin is — an ineligible tier degrades to the default
      // route (R5), never a keyless session. One probe, reused for both (C5).
      const tierProvider =
        pref?.intent === 'strongest' ? this.host.nlRoutingTiers?.strongest
        : pref?.intent === 'fastest' ? this.host.nlRoutingTiers?.fastest
        : undefined;
      const fallbackEntry = this.host.effectiveFallbackEntry;
      // Health-window fallback and unconfigured/NL-disabled routes do not need
      // a credential probe. Avoid making an unrelated probe a prerequisite for
      // selecting the already-known exact route.
      const routable = fallbackEntry === null && pref !== null
        ? this.host.routablePinTargets()
        : [this.host.agentProvider];
      let decision = resolveRoute({
        agentProvider: this.host.agentProvider,
        effectiveModel: this.host.effectiveModel,
        fallbackEntry,
        pref,
        pinnedProviderEligible: pinned !== null && routable.includes(pinned),
        pinnedModelEligible: isPinnedModelEligible(
          pref,
          this.host.agentFallbacks,
          (entry) => this.host.isEntryCredentialed(entry),
        ),
        tierMap: this.host.nlRoutingEnabled ? this.host.nlRoutingTiers : null,
        tierProviderEligible: tierProvider !== undefined && routable.includes(tierProvider),
        // Finding 2 fix: the same agentFallbacks entries that
        // routablePinTargets/isEntryCredentialed just read to prove a pin/tier
        // target eligible carry that target's validated config model — thread
        // it through so resolveRoute can supply it for credential-required
        // providers (opencode-cli et al.) instead of discarding it to
        // `undefined`. First entry wins per provider, matching
        // routablePinTargets' own dedup.
        configuredModelByProvider: this.configuredModelByProvider(),
        agentDataPolicy: this.host.agentDataPolicy,
        boundaryMode: this.host.providerBoundaryMode,
        configuredDataPolicyByRoute: this.configuredDataPolicyByRoute(),
      });
      // Task H — sync consumption of a verified model pin (decideModelPinResolution's
      // hot path: verified + same provider needs no catalogue, so this stays
      // pure-sync, no I/O beyond the pref already read above). A provider
      // change since verification (or an unverified/deferred pin) falls to
      // `needs-catalogue` with no catalogue supplied here — that is a
      // deliberate fail-open to the provider-level route already decided
      // above, not a bug: resolveRouteForTurn never fetches a catalogue or
      // persists (that is verifyModelPinAgainstCatalogue's job, at pin time).
      // Gated on decision.source === 'preference': the pure resolver already
      // handles the narrower active-fallback case by requiring an exact
      // configured, credentialed model on the health-selected provider.
      // Applying this broader provider-match rule to fallback or
      // pin_blocked_default decisions would bypass that stricter proof.
      if (pref?.requestedModel != null && decision.source === 'preference') {
        const modelPinDecision = decideModelPinResolution(
          { requestedModel: pref.requestedModel, validatedProvider: pref.validatedProvider, modelPinVerified: pref.modelPinVerified },
          decision.provider,
        );
        if (modelPinDecision.action === 'use') {
          decision = Object.freeze({ ...decision, model: modelPinDecision.modelId });
        }
      }
      return Object.freeze({ ...decision, pinnedProvider: pinned });
    } catch (err) {
      if (err instanceof ProviderDataPolicyError) throw err;
      log.warn({ err, instance: this.host.instanceName }, 'route resolution failed - routing on default');
      const policy = resolveProviderRoutePolicy({
        provider: this.host.agentProvider,
        model: this.host.model,
        dataPolicy: this.host.agentDataPolicy,
        boundaryMode: this.host.providerBoundaryMode,
      });
      return Object.freeze({
        ...policy,
        source: 'default',
        reasonCode: 'route_resolution_failed',
        pinnedProvider: null,
      });
    }
  }

  /**
   * Canonical-keyed preference read with fail-open (C3): owns key derivation
   * (preferenceKeys) AND the fail-open contract, so every reader — the spawn
   * path and /model status — degrades identically on a store error (warn +
   * treat as no preference) instead of one path throwing out of a read-only
   * command. A preference read failure must never surface as an error or
   * drop a turn.
   *
   * D13/D13a (2026-07-20): chat-scoped, last-writer-wins — reads the LATEST
   * non-expired pin across every sender in the chat via
   * getLatestChatPreference, not just this senderJid's own row. WRITES stay
   * per-sender (setPreference/recordRoutePreference), so senderJid is still
   * needed here for canonicalization (preferenceKeys) even though the read
   * itself no longer filters by sender.
   */
  private loadSenderPreference(chatJid: string, senderJid: string): ChatModelPreference | null {
    try {
      const { chatKey } = preferenceKeys(this.host.db, chatJid, senderJid);
      return getLatestChatPreference(this.host.db, chatKey);
    } catch (err) {
      log.warn({ err, instance: this.host.instanceName }, 'preference read failed - routing on default');
      return null;
    }
  }

  /**
   * Provider config for a route-decided session: same inheritance rules as
   * the fallback path (fallbackProviderConfigFor), incl. the opencode strip of
   * primary baseUrl/apiKeyService when routing off-primary. Slice 3:
   * applyRouteEffort folds a claude-cli effort pin over the static effort.
   */
  routeSessionProviderConfig(route: RouteDecision): Record<string, unknown> | undefined {
    // Match the fallback path (effectiveProviderConfig): a provider with no
    // config of its own inherits the agent's providerConfig — including the
    // budget cap — instead of spawning with providerConfig=undefined (R2).
    const base = route.source !== 'preference' || route.provider === this.host.agentProvider
      ? this.host.sessionProviderConfig()
      : (fallbackProviderConfigFor(route.provider, this.host.agentProvider, this.host.agentProviderConfig) ?? this.host.agentProviderConfig);
    // ONE effort application point — a future third base branch cannot silently
    // skip the wrap (an effort pinned and echoed, then dropped before spawn).
    return applyRouteEffort(base, route);
  }

  /** Spawn-time route bookkeeping: pin-blocked notice (once per transition) + route events. */
  noteRouteAtSpawn(
    chatJid: string,
    conversationKey: string,
    route: RouteDecision & { pinnedProvider: string | null },
  ): void {
    // Route-transition tracking (slice 4): a spawn whose provider differs
    // from this conversation's previous spawn is a SWITCH, recorded exactly
    // once whatever moved it (preference, fallback, or back to default).
    const previousProvider = this.host.lastSpawnRouteProvider.get(conversationKey);
    this.host.lastSpawnRouteProvider.set(conversationKey, route.provider);
    const switched = previousProvider !== undefined && previousProvider !== route.provider;
    if (route.source === 'pin_blocked_default' && route.pinnedProvider) {
      let noticeSent = false;
      if (this.host.lastPinBlockNotice.get(conversationKey) !== route.pinnedProvider) {
        this.host.lastPinBlockNotice.set(conversationKey, route.pinnedProvider);
        noticeSent = true;
        // Strict pins never silently fall back: the block is VISIBLE and the
        // pin survives (the user clears it, we never do).
        this.host.sendDirect(
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
    this.host.lastPinBlockNotice.delete(conversationKey);
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

  emitRouteEventChecked(ev: Omit<ModelRouteEvent, 'ts' | 'instance' | 'chatScope' | 'authority'>): void {
    if (!this.host.nlRouting) return;
    const dir =
      this.host.nlRoutingEventsDir ?? join(homedir(), '.config', 'whatsoup', 'instances', this.host.instanceName);
    emitRouteEvent(
      dir,
      {
        ts: Date.now(),
        instance: this.host.instanceName,
        chatScope: deriveChatScope(ev.conversationKey),
        authority: 'advisory_only',
        ...ev,
      },
      (m) => log.warn({ instance: this.host.instanceName }, m),
    );
  }

  /**
   * Provider id → validated config model, derived from `agentFallbacks`
   * (first entry wins per provider — same dedup `routablePinTargets` applies
   * when it walks this same array). Feeds `resolveRoute`'s
   * `configuredModelByProvider` input (EXECPROFILE-CI-FIX Finding 2): the
   * pin/tier eligibility probe already reads each entry's own model to prove
   * that provider routable, so this is the same data, just keyed for lookup
   * instead of iterated for a credential check.
   */
  private configuredModelByProvider(): Record<string, string | undefined> {
    const models: Record<string, string | undefined> = {};
    for (const entry of this.host.agentFallbacks) {
      if (entry.provider in models) continue;
      models[entry.provider] = entry.model;
    }
    return models;
  }

  private configuredDataPolicyByRoute(): Record<string, ProviderDataPolicy | undefined> {
    const policies: Record<string, ProviderDataPolicy | undefined> = {};
    for (const entry of this.host.agentFallbacks) {
      const key = providerRoutePolicyKey(entry.provider, entry.model);
      if (key in policies) continue;
      policies[key] = entry.dataPolicy;
    }
    return policies;
  }

  /** Clear a sender's route preference — shared by `/model default` and `/reset`. */
  clearRoutePreference(chatJid: string, chatKey: string, senderKey: string): void {
    this.clearRoutePreferenceSilent(chatJid, chatKey, senderKey);
    this.host.sendDirect(chatJid, '_Back to the default route._');
  }

  /** Store clear + route event without the reply echo. The NL typed-intent
   *  path acknowledges through the agent's own reply (prompt contract), so
   *  a runtime echo on top would double-message.
   *
   *  D13: chat-scoped clear — pairs with the chat-scoped read, so /reset
   *  removes every sender's row for the chat, not just the caller's own.
   *  senderKey is unused here now (kept in the signature — callers still
   *  derive it via preferenceKeys for the write paths they share it with). */
  private clearRoutePreferenceSilent(chatJid: string, chatKey: string, senderKey: string): void {
    void senderKey;
    clearChatPreference(this.host.db, chatKey);
    this.emitRouteEventChecked({
      event: 'model_preference_cleared',
      conversationKey: toConversationKey(chatJid),
      provider: this.host.agentProvider,
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
  recordRoutePreference(
    chatJid: string,
    chatKey: string,
    senderKey: string,
    intent: PreferenceIntent,
    requestedProvider: string | null,
  ): 'set' | 'refreshed' | 'sticky_kept' {
    const now = Date.now();
    const existing = getPreference(this.host.db, chatKey, senderKey, now);
    // D6/D10: `existing.requestedModel === null` is part of the dedup guard —
    // this write path always carries NO model (see below), so a re-confirm
    // must only "refresh" a row that ALSO carries no model. Without this, a
    // prior model-level pin (recordRouteModelPin) on the same provider would
    // dedup-match on intent+provider alone and the refresh branch's `{
    // ...existing, ... }` spread would silently PRESERVE the stale
    // requestedModel/validatedProvider/modelPinVerified fields — so `/model N
    // default` after `/model N` would say "Already set" and leave the model
    // pin in place instead of clearing it to a provider-only default. Forcing
    // the full-overwrite ("set") branch here correctly drops the model dimension.
    if (existing && existing.intent === intent && existing.requestedProvider === requestedProvider && existing.requestedModel === null) {
      // Re-confirmation refreshes the TTL (F08) — "already set" must stay
      // true for a full window after the user re-asserts it. Sticky rows
      // (expiresAt null) are never demoted to ephemeral by a repeat.
      if (existing.expiresAt !== null) {
        setPreference(this.host.db, { ...existing, updatedAt: now, expiresAt: now + PREFERENCE_TTL_MS });
        return 'refreshed';
      }
      return 'sticky_kept';
    }
    setPreference(this.host.db, {
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
      // Provider-pin path — carries no MODEL pin (that is recordRouteModelPin,
      // the /model <N> write path, below).
      requestedModel: null,
      validatedProvider: null,
      modelPinVerified: null,
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
   * Task G (D14) route recycle — thin delegator to model-pin.ts. Kept as a
   * private method (rather than inlining the port call at each site) because
   * /reset and the recycle characterization suite both reach it by name.
   */
  async applyRouteChangeAndRecycle(
    chatJid: string,
    senderJid: string,
    perChatMapKey: string | undefined,
  ): Promise<RouteRecycleOutcome> {
    return applyRouteChangeAndRecycleForPort(this.host.modelPinHost, chatJid, senderJid, perChatMapKey);
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
          const { chatKey, senderKey } = preferenceKeys(this.host.db, chatJid, actorJid);
          if (intent === 'reset') {
            this.clearRoutePreferenceSilent(chatJid, chatKey, senderKey);
          } else {
            this.recordRoutePreference(chatJid, chatKey, senderKey, intent, null);
          }
        } catch (err) {
          log.warn({ err, intent, instance: this.host.instanceName }, 'route-intent apply failed - reply delivered without state change');
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
  scanRouteMarkerDelta(
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
  flushRouteMarker(
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
    const session = this.host.sessionScope === 'per_chat'
      ? this.host.chatSessions.get(this.host.resolvePerChatMapKey(chatJid))
      : this.host.session;
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
  loadRouteView(chatJid: string, senderJid: string): {
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
   * B26 honest model label, shared by /model status and /status. The served
   * model weight is UNOBSERVABLE (the stream is never parsed for a model
   * field; a prior incident had an agent fabricate one) — so this renders
   * only config-derived values, explicitly labeled:
   *  - a route model equal to the configured primary → 'model (configured)'
   *  - any other route model (a config fallback-entry value) → bare
   *  - no route model but a configured primary on the primary provider →
   *    'model (configured)'
   *  - genuinely nothing configured (or a non-primary provider with no
   *    entry model) → 'provider default (not configured)'
   */
  describeRouteModel(routeModel: string | undefined, routeProvider: string): string {
    if (routeModel !== undefined) {
      return routeModel === this.host.model ? `${routeModel} (configured)` : routeModel;
    }
    if (this.host.model !== undefined && routeProvider === this.host.agentProvider) {
      return `${this.host.model} (configured)`;
    }
    return 'provider default (not configured)';
  }

  /**
   * End-user route status (/model status). Visibility policy (capability-
   * preserved routing): provider, model route, preference, and fallback state
   * only — never tool names, socket paths, pids, account JIDs, or
   * cross-conversation metadata. (b28 r2b removed the Delegation/Authority
   * DISPLAY lines; the invariant they described lives in the agent system
   * prompt + security layer. D11/D12: /why is removed — its "no delegation"
   * reassurance is folded into the trailing line of this render below rather
   * than lost.)
   */
  renderRouteStatus(chatJid: string, senderJid: string): string {
    const { live, pref, next } = this.loadRouteView(chatJid, senderJid);
    // Next-session provider/model come from resolveRouteForTurn (R7), so an
    // eligible pin or tier is reflected here — not the fallback-only
    // effectiveProvider, which contradicted the "steers new sessions" line.
    const nextProvider = next.provider || 'unknown-provider';
    const provider = live?.provider ?? nextProvider;
    // B26 HONESTY RULE (load-bearing): the SERVED model weight is
    // unobservable — the provider stream is never parsed for a model field —
    // so every value on this line is config-derived and says so. The route
    // model (live session's spawn ref, or the resolved next-session model)
    // comes from config/fallback entries; when it IS the configured primary
    // it carries the '(configured)' label, a fallback-entry model stays bare
    // (existing behavior). When the route carries NO model, fall back to the
    // configured primary explicitly — the pre-B26 render read ONLY the
    // live/next route model and showed 'provider default' even when
    // agentOptions.model was set (live canary exhibit). Only a genuinely
    // absent config renders 'provider default (not configured)'. Never
    // present a value as the served weight; never invent one.
    const model = this.describeRouteModel(
      live ? live.model : next.model,
      live ? live.provider : nextProvider,
    );
    // Copy fix: the read is chat-scoped, last-writer-wins (D13/D13a) — "for
    // you" mis-implies per-user ownership even when a DIFFERENT sender set
    // it. "Saved preference" is accurate in both a DM and a group without
    // claiming a fallback or older live session is serving it, and never
    // names the setter (that would reintroduce the internal-concept leak the
    // plain-language rule bans). A model pin shows the model ONLY once
    // verified (Task H honesty rule) — an unverified/deferred model pin
    // would otherwise claim to be serving a model that was never confirmed
    // to exist; it falls back to the provider/intent, same as before.
    const prefLine = savedPreferenceLine(
      pref,
      this.host.isFallbackWindowActive,
      next.reasonCode === 'fallback_window_active_model_pin',
    );
    // B25 F8: the active-window and Next lines were model-blind — a
    // same-provider window pinning a DIFFERENT model rendered without the
    // model and suppressed the Next line entirely. Render "provider (model)"
    // and compare provider AND model in the suppress guard.
    const nextRouteLabel = next.model ? `${nextProvider} (${next.model})` : nextProvider;
    const fallbackLine = this.host.isFallbackWindowActive
      ? `Fallback: active — new sessions route via ${nextRouteLabel}`
      : this.host.agentFallbacks.length > 0
        // B23: entries may share a provider and differ only by model — render
        // "provider (model)" when a model is pinned so distinct configured
        // entries never collapse to indistinguishable labels. b28 r2a: the
        // chain renders one `• ` bullet per entry (WhatsApp narrow column),
        // never a long ` → `-joined single line.
        ? bulletedSection(
            'Fallback chain (configured):',
            this.host.agentFallbacks.map((e) => (e.model ? `${e.provider} (${e.model})` : e.provider)),
          )
        : 'Fallback: none configured';
    const nextLine =
      live && (live.provider !== nextProvider || (live.model ?? null) !== (next.model ?? null))
        ? `\nNext session: ${nextRouteLabel}`
        : '';
    // b28 r2b: the Delegation + Authority DISPLAY lines are removed from this
    // render (owner ruling: not about model/route status). D11/D12: the
    // underlying invariant is not lost — the former /why receipt's
    // reassurance is folded into the trailing italic line below now that
    // /why itself is gone.
    return (
      `*Current route:* ${provider}${live ? '' : ' (no live session — next session route)'}\n` +
      `Model: ${model}\n` +
      `${prefLine}\n` +
      `${fallbackLine}${nextLine}\n` +
      '_No delegation; routing never changes what I am allowed to do._'
    );
  }
}
