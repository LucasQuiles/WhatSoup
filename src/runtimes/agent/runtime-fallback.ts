// src/runtimes/agent/runtime-fallback.ts
// Provider-fallback core, extracted from AgentRuntime (#1977 D2).
//
// Owns fallback-window selection/arming/deactivation, chain advancement,
// empty-output and unknown-terminal arming, persistence restore, the primary
// recovery/usability probe scheduling, and the /health fallback state render.
// All runtime state stays owned by AgentRuntime and is reached through the
// RuntimeFallbackPort host: the fallback state fields are test-seam-bound on
// the runtime instance (see the port docs), and deactivateProviderFallback is
// invoked through the host so the runtime's named spy seam observes in-cluster
// calls. This module holds no state of its own.

import { join, resolve } from 'node:path';
import type { Database } from '../../core/database.ts';
import type { AgentFallbackDiscoveryConfig, AgentFallbackEntry } from '../../core/fallback-chain.ts';
import { sleep } from '../../core/retry.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../../lib/emit-alert.ts';
import { errorMessage } from '../../lib/error-message.ts';
import { lookupCredential, resolveProviderKeyService } from '../../lib/keyring.ts';
import { MS_PER_MINUTE } from '../../lib/time-units.ts';
import { createChildLogger } from '../../logger.ts';
import { systemClock } from '../../lib/clock.ts';
import { classifyProviderFailure } from './failure-taxonomy.ts';
import {
  fallbackKeyPresent as fallbackKeyPresentFor,
  fallbackProviderConfigFor,
  fallbackRequiresIndependentProbe,
} from './fallback-config.ts';
import { makeIdleEligibilityResolver } from './fallback-eligibility-cache.ts';
import {
  formatFallbackRecoveryReceiptEvidence,
  resolveFallbackRecoveryDecision,
  stallAlertPlan,
  type FallbackRecoveryDecision,
  type FallbackRecoveryEvidence,
  type FallbackRecoveryReceipt,
} from './fallback-recovery-transaction.ts';
import { failedKeysToPersistedKeys, restorePersistedFallbackWindowState } from './fallback-restore.ts';
import {
  PERSISTED_FALLBACK_STATE_VERSION,
  clearFallbackState,
  getFallbackState,
  saveFallbackState,
} from './fallback-state-db.ts';
import { handoffContextEnabled, handoffDistillModel, handoffDistillerEnabled } from './handoff-distill-config.ts';
import { CHAIN_CANARY_PROMPT, resolveFallbackCanaryConfig, type FallbackCanaryConfig } from './fallback-canary-config.ts';
import {
  probeChainEntryCompletion,
  type ChainEntryCanaryFailureClass,
  type ChainEntryCanaryResult,
} from './providers/chain-entry-canary.ts';
import { buildOpenCodeRunArgs } from './providers/opencode-execution-profile.ts';
import type { IOutboundQueue } from './outbound-queue.ts';
import {
  buildPrimaryProbeAdapterDeps,
  calculatePeriodicProbeBackoff,
  calculatePeriodicProbeDelay,
  formatPrimaryModelUsabilityEvidence,
} from './primary-readiness-probe.ts';
import {
  listModelCatalog,
  probeFallbackBinary,
  probeModelCatalog,
  type ModelCatalogCaptureMode,
  type ModelCatalogUnavailableReason,
} from './providers/binary-preflight.ts';
import {
  deriveFallbackChainFromCatalog,
  type CandidateEvidence,
  type DiscoveredCandidate,
} from './fallback-discovery.ts';
import { verifyFallbackCredential } from './providers/credential-verify.ts';
import type { OpencodeProviderConfig } from './providers/mcp-bridge.ts';
import { createPrimaryModelProbeAdapters } from './providers/primary-model-usability-adapters.ts';
import {
  primaryModelUsabilityRequiresAlert,
  probePrimaryModelUsability,
  type PrimaryModelUsabilityResult,
} from './providers/primary-model-usability.ts';
import { fallbackRequiresPrimaryProbe, isProviderFallbackReason } from './runtime-presentation.ts';
import {
  DEFAULT_FALLBACK_WINDOW_MS,
  MAX_FALLBACK_WINDOW_MS,
  MIN_FALLBACK_WINDOW_MS,
} from './runtime-tunables.ts';
import type { ProviderFallbackActivation, ProviderFallbackReason } from './runtime-turn-result-handler.ts';
import type { ModelRouteEvent } from './route-events.ts';
import { SessionManager, buildChildEnv, getProviderBinary } from './session.ts';
import { alertEvidenceValue } from './tool-update.ts';
import type { FallbackWindowState } from './fallback-window-state.ts';
import type { FallbackWindowMetrics } from './fallback-window-metrics.ts';
import type { FallbackChain } from './fallback-chain-state.ts';
import type { FallbackEmptyAdvance } from './fallback-empty-advance.ts';
import type { TurnCapabilityTracker } from './turn-capability-tracker.ts';
import type { EgressProxy } from './egress-proxy.ts';
import type { ProviderExecutionGate } from './provider-execution-gate.ts';
import type { RuntimePrimaryModelUsability, RuntimeTurnCapability } from './runtime.ts';

const log = createChildLogger('agent-runtime');

/**
 * Which provider tier produced the failure driving a (re-)activation. The
 * reason taxonomy (ProviderFallbackReason) encodes WHY the primary was left,
 * never WHICH TIER just failed — so the tier is derived, in ONE place, from
 * route-identity attribution (failureTierForSession). A fallback-tier
 * failure carries no evidence about the PRIMARY: it must advance the chain
 * without extending the window, overwriting the stored resetAt, or
 * restarting the primary recovery clocks (live ph-bot 2026-08-26: a dead
 * fallback tier plus user traffic postponed primary recovery indefinitely).
 */
type FallbackFailureTier = 'primary' | 'fallback';

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
 * The gateway provider discovery derives chains through — the one whose
 * credential-aware `<binary> models` catalogue is the discovery source (v1
 * scope, matching the canary's opencode-only probe scope).
 */
const DISCOVERY_GATEWAY_PROVIDER = 'opencode-cli';

/**
 * A discovery snapshot older than this is re-derived (fire-and-forget) when a
 * fallback window arms — the moment the chain is about to matter is exactly
 * when a rotted catalogue read must not steer it.
 */
const DISCOVERY_STALE_MS = 60 * MS_PER_MINUTE;

/**
 * Canary probe cap per sweep over the discovered candidate basis (design
 * bound: ≤5 one-token completions per sweep). Candidates past the cap keep
 * their prior evidence until a later sweep reaches them.
 */
const CHAIN_CANARY_DISCOVERY_SWEEP_CAP = 5;

/**
 * Consecutive unclassified-terminal PRIMARY user turns that force a provider
 * fallback. An UNKNOWN terminal provider error (is_error result whose text
 * classifyProviderFailure() cannot place in any known class) has historically
 * only surfaced a generic notice + ops alert and armed NO fallback, so a broken
 * primary throwing them turn after turn stalled on the primary while an eligible
 * fallback sat idle. A single one is treated as transient (keep the session); a
 * bounded run fails over. Dedicated constant — it intentionally tracks the value
 * of {@link EMPTY_OUTPUT_FALLBACK_THRESHOLD} today, but is kept separate so tuning
 * the empty-output threshold cannot silently move the unknown-terminal one. See
 * {@link AgentRuntime.maybeArmFallbackAfterUnknownTerminal}.
 */
const UNKNOWN_TERMINAL_FALLBACK_THRESHOLD = 2;

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
const EMPTY_OUTPUT_ARM_STARTUP_GRACE_MS = MS_PER_MINUTE;

/**
 * Host port for the fallback coordinator — the same live-getter shape as
 * RuntimeRoutingPort (#1977 D1): every data field is a live getter/setter on
 * the runtime, never a value captured at construction. ALL fallback state
 * stays owned by AgentRuntime because the characterization suites bind it on
 * the runtime instance (fallbackWindow 94 bindings, fallbackProbeAttempts 30,
 * primaryModelUsability assigned directly, fallbackMetrics written, ...).
 * probePrimaryProviderRecovered and deactivateProviderFallback are reached
 * through the host so their instance-property stub / spy seams keep observing
 * every call, including in-cluster ones.
 */
/**
 * Provider-fallback tunables resolved by config (#2192 s4b) — instance-config
 * first, env fallback, clamps applied at config load. Grouped as one object
 * to keep the port surface flat.
 */
export interface RuntimeFallbackTunables {
  readonly noticeDedupMs: number;
  readonly primaryRecheckMs: number;
  readonly probeStallThreshold: number;
  readonly probeStallCeilingMultiple: number;
}

export interface RuntimeFallbackPort {
  readonly db: Database;
  readonly instanceName: string;
  readonly fallbackTunables: RuntimeFallbackTunables;
  readonly cwd: string | undefined;
  readonly model: string | undefined;
  readonly agentProvider: string;
  readonly agentProviderConfig: Record<string, unknown> | undefined;
  readonly agentFallbacks: AgentFallbackEntry[];
  readonly agentFallbackDiscovery: AgentFallbackDiscoveryConfig | null;
  readonly modelCatalogueListFn: typeof listModelCatalog | undefined;
  readonly allowM365Mutations: boolean | undefined;
  readonly runtimeBootPerfMs: number;
  readonly globalMcpSocketPath: string | null;
  readonly egressProxy: EgressProxy | undefined;
  readonly providerExecutionGate: ProviderExecutionGate;
  readonly controlSession: SessionManager | null;
  readonly fallbackWindow: FallbackWindowState;
  readonly fallbackMetrics: FallbackWindowMetrics;
  readonly fallbackChain: FallbackChain;
  readonly fallbackEmptyAdvance: FallbackEmptyAdvance;
  readonly turnCapabilityTracker: TurnCapabilityTracker;
  readonly recentNoFallbackReauthNotices: Map<string, number>;
  readonly recentFallbackEmptyTurnAlerts: Map<string, number>;
  revertTimer: ReturnType<typeof setTimeout> | null;
  fallbackPrimaryProbeTimer: ReturnType<typeof setTimeout> | null;
  periodicUsabilityProbeTimer: ReturnType<typeof setTimeout> | null;
  periodicUsabilityProbeBackoff: number;
  periodicUsabilityProbeDueAt: number | null;
  readonly shutdownRequested: boolean;
  fallbackProbeAttempts: number;
  fallbackLastProbeAt: number | null;
  fallbackWindowRestored: boolean;
  pendingPostRevertConfirmation: boolean;
  primaryModelUsability: RuntimePrimaryModelUsability | null;
  primaryModelUsabilityAlertActive: boolean;
  consecutivePrimaryEmptyTurns: number;
  consecutiveUnknownTerminalTurns: number;
  idleFallbackEligibilityResolver: ((entry: AgentFallbackEntry) => boolean | null) | undefined;
  readonly effectiveProvider: string;
  readonly effectiveFallbackEntry: AgentFallbackEntry | null;
  readonly isFallbackWindowActive: boolean;
  isEntryCredentialed(entry: AgentFallbackEntry): boolean;
  emitRouteEventChecked(ev: Omit<ModelRouteEvent, 'ts' | 'instance' | 'chatScope' | 'authority'>): void;
  capDedupeMap(map: Map<string, unknown>, max?: number): void;
  getTurnCapability(): RuntimeTurnCapability;
  /** task-21: verify the ratified account identity after a usability probe
   *  settles (startup / periodic / manual). Optional so hand-built hosts in
   *  older suites keep compiling; the runtime always supplies it. */
  verifyAccountIdentity?(trigger: 'startup' | 'manual' | 'periodic'): void;
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
  probePrimaryProviderRecovered(
    onEvidence?: (evidence: FallbackRecoveryEvidence) => void,
    signal?: AbortSignal,
  ): Promise<boolean>;
  deactivateProviderFallback(reason: string, receipt?: FallbackRecoveryReceipt | null): void;
  /** Pend deferred route recycles for live managers left stale by a window transition. */
  schedulePostTransitionRouteRecycles(): void;
}

export class RuntimeFallbackCoordinator {
  private readonly host: RuntimeFallbackPort;

  constructor(host: RuntimeFallbackPort) {
    this.host = host;
  }

  private selectFallbackEntryForWindow(reason?: string): { entry: AgentFallbackEntry; selectedHadMissingCredential: boolean } | null {
    if (this.host.agentFallbacks.length === 0) {
      this.host.fallbackChain.chainState = [];
      return null;
    }

    const requireIndependentProvider = fallbackRequiresIndependentProbe(reason);
    // Canary consult (fail-open): skip entries with FRESH real-completion
    // failure evidence — but only when at least one otherwise-viable candidate
    // has no such evidence. If every candidate looks canary-dead the evidence
    // is disregarded entirely, so a stale or wrong sweep can never strand the
    // chain below its pre-canary floor.
    const applyCanary = this.host.agentFallbacks.some((candidate) => {
      if (requireIndependentProvider && candidate.provider === this.host.agentProvider) return false;
      const candidateKey = this.host.fallbackChain.entryKey(candidate);
      if (this.host.fallbackChain.failedKeys.has(candidateKey)) return false;
      return !this.chainCanaryDead(candidateKey);
    });
    let firstEligibleIndex = -1;
    let firstIndependentIndex = -1;
    const state: Array<AgentFallbackEntry & { eligible: boolean }> = [];
    for (let i = 0; i < this.host.agentFallbacks.length; i++) {
      const entry = this.host.agentFallbacks[i]!;
      if (requireIndependentProvider && entry.provider === this.host.agentProvider) {
        state.push({ ...entry, eligible: false });
        continue;
      }
      if (this.host.fallbackChain.failedKeys.has(this.host.fallbackChain.entryKey(entry))) {
        state.push({ ...entry, eligible: false });
        continue;
      }
      if (applyCanary && this.chainCanaryDead(this.host.fallbackChain.entryKey(entry))) {
        // Fresh evidence this entry cannot serve a completion — pass over it
        // exactly like a failed key. No credential alert churn for a skip.
        state.push({ ...entry, eligible: false });
        continue;
      }
      if (entry.provider !== this.host.agentProvider && firstIndependentIndex === -1) {
        firstIndependentIndex = i;
      }
      // Eligibility DECISION comes from the shared predicate (C4) so it can
      // never desync from pin eligibility; `service` is recomputed only for
      // the credential-missing alert below (the selector's own concern).
      const eligible = this.host.isEntryCredentialed(entry);
      const service = resolveProviderKeyService(
        entry.provider,
        entry.model,
        fallbackProviderConfigFor(entry.provider, this.host.agentProvider, this.host.agentProviderConfig),
      );
      state.push({ ...entry, eligible });
      if (eligible && firstEligibleIndex === -1) {
        firstEligibleIndex = i;
      }
      if (!eligible) {
        emitAlertChecked(
          this.host.instanceName,
          'fallback_credential_missing',
          'Fallback provider key not found in keyring',
          `entry=${i} service=${service} provider=${entry.provider} model=${entry.model ?? ''}`,
        );
      } else {
        // #2399: prerequisite now satisfied — emit recovery clear so the
        // incident does not remain open until stale timeout.
        clearAlertSourceChecked(
          this.host.instanceName,
          'fallback_credential_missing',
          `recoveryProof=credential_valid entry=${i} provider=${entry.provider}`,
        );
      }
    }
    this.host.fallbackChain.chainState = state;
    if (requireIndependentProvider && firstEligibleIndex === -1 && firstIndependentIndex === -1) {
      emitAlertChecked(
        this.host.instanceName,
        'fallback_no_independent_provider',
        'Fallback requires an independent provider target',
        `primaryProvider=${this.host.agentProvider} reason=${reason}`,
      );
      return null;
    }
    const selectedIndex = firstEligibleIndex === -1
      ? (requireIndependentProvider ? firstIndependentIndex : 0)
      : firstEligibleIndex;
    return {
      entry: this.host.agentFallbacks[selectedIndex]!,
      selectedHadMissingCredential: state[selectedIndex]?.eligible === false,
    };
  }

  /**
   * Pure attribution predicate: does `session` serve the ACTIVE fallback
   * entry? The SINGLE identity mechanism behind both failed-entry marking
   * (markActiveFallbackFailed) and failure-tier derivation — a session is
   * fallback-tier evidence exactly when this holds, so the two can never
   * disagree. No side effects.
   */
  private sessionServesActiveFallbackEntry(session: SessionManager | null): boolean {
    if (!this.host.isFallbackWindowActive || !this.host.fallbackWindow.activeEntry || !session) return false;
    const sessionProvider = typeof session.getProviderId === 'function' ? session.getProviderId() : null;
    if (sessionProvider !== null) {
      if (sessionProvider !== this.host.fallbackWindow.activeEntry.provider) return false;
      // Chain entries can share one provider and differ only by model. A
      // session spawned under a PRIOR entry can still be running when the
      // chain advances (another chat's in-flight turn); its later failure is
      // evidence against ITS OWN model, not the current entry. Null model ref
      // stays attributable — never block on a guess.
      const entryModel = this.host.fallbackWindow.activeEntry.model;
      const sessionModel = typeof session.getModelRef === 'function' ? session.getModelRef() : null;
      if (entryModel !== undefined && sessionModel !== null && sessionModel !== entryModel) return false;
      return true;
    }
    const sessionId = session.getStatus().sessionId;
    return sessionId?.startsWith(`${this.host.fallbackWindow.activeEntry.provider}-`) ?? false;
  }

  /**
   * Window STATE exists (activeUntil set) — deliberately BROADER than
   * {@link RuntimeFallbackPort.isFallbackWindowActive}: it also holds in the
   * in-flight revert-probe gap, where the deadline is past but the window's
   * state (activeEntry, resetAt, activatedAt, the probe's own pending
   * decision) is still live. Clock/window state worth protecting exists
   * exactly when this holds — the tier fail-closed scope and the no-arm scope
   * both key on it, and MUST stay on the same predicate.
   */
  private fallbackWindowStateExists(): boolean {
    return this.host.fallbackWindow.activeUntil !== null;
  }

  /**
   * Failure-tier derivation by ROUTE identity — a different question from the
   * marking predicate above. Marking asks "does this session serve the ACTIVE
   * entry?" (evidence against that entry). The tier asks "is this session NOT
   * the primary?" — a session attributable to ANY configured fallback entry,
   * active or a PRIOR entry still running across a chain advance, is
   * fallback-tier evidence and must not move the window clocks.
   *
   * Attribution mirrors the route-currency compare (sessionMatchesCurrentRoute):
   * the primary compare is provider-only (isCrossProviderSession's inverse) —
   * disambiguation comes from the model-aware fallback-entry side, because a
   * same-provider chain differs from the primary only by model, plus one
   * tiebreak: a session whose model exactly equals the EXPLICITLY configured
   * primary model is the primary even when a wildcard (model-undefined)
   * same-provider entry also matches it. When positive attribution is
   * impossible (ambiguous same-provider session with a null model ref, a
   * provider-default primary beside a wildcard same-provider entry, or a
   * foreign provider), fail CLOSED for CLOCKS: with window state present the
   * failure must not be able to move it; with no window at all there are no
   * clocks to protect, and refusing to arm would break primary failover — so
   * the legacy primary tier applies there.
   */
  private failureTierForSession(session: SessionManager | null): FallbackFailureTier {
    if (!session) return 'primary';
    const failClosedTier: FallbackFailureTier =
      this.fallbackWindowStateExists() ? 'fallback' : 'primary';
    const provider = typeof session.getProviderId === 'function' ? session.getProviderId() : null;
    if (provider === null) {
      // Last-resort sessionId-prefix attribution, mirroring the marking
      // predicate's fallback identity read.
      const sessionId = session.getStatus().sessionId;
      if (!sessionId) return 'primary'; // unattributable — never block on a guess
      const prefixFallback = this.host.agentFallbacks.some((e) => sessionId.startsWith(`${e.provider}-`));
      const prefixPrimary = sessionId.startsWith(`${this.host.agentProvider}-`);
      if (prefixFallback && !prefixPrimary) return 'fallback';
      if (prefixPrimary && !prefixFallback) return 'primary';
      return failClosedTier;
    }
    // getModelRef() returns `string | undefined` — a provider-default spawn
    // returns UNDEFINED (the common real case). Normalize at the read: a
    // missing model is match-ELIGIBLE, exactly as the entry.model===undefined
    // arm below already treats the entry side.
    const model = (typeof session.getModelRef === 'function' ? session.getModelRef() : null) ?? null;
    const matchesFallback = this.host.agentFallbacks.some((entry) => {
      if (provider !== entry.provider) return false;
      if (entry.model === undefined) return true;
      return model === null || model === entry.model;
    });
    const matchesPrimary = provider === this.host.agentProvider;
    if (matchesFallback && !matchesPrimary) return 'fallback';
    if (matchesPrimary && !matchesFallback) return 'primary';
    // Exact-primary disambiguation (review 2): a wildcard (model-undefined)
    // fallback entry matches ANY session on its provider, which used to drop
    // a failing PRIMARY session into the ambiguous bucket and discard its
    // resetAt evidence under a legal config. When the primary route carries
    // an EXPLICITLY configured model and the session's model equals it, the
    // session IS the primary — the exact match beats the wildcard. The
    // remainder stays fail-closed: a null session model on a same-provider
    // chain, or a provider-default primary (host.model undefined) beside a
    // wildcard same-provider entry, cannot be positively attributed.
    if (matchesPrimary && matchesFallback && this.host.model !== undefined && model === this.host.model) {
      return 'primary';
    }
    return failClosedTier;
  }

  private markActiveFallbackFailed(
    session: SessionManager | null,
    reason: ProviderFallbackReason,
    evidenceText?: string,
  ): string | null {
    const activeEntry = this.host.fallbackWindow.activeEntry;
    if (!activeEntry || !this.sessionServesActiveFallbackEntry(session)) return null;

    const key = this.host.fallbackChain.entryKey(activeEntry);
    if (!this.host.fallbackChain.failedKeys.has(key)) {
      this.host.fallbackChain.failedKeys.add(key);
      emitAlertChecked(
        this.host.instanceName,
        'fallback_provider_failed',
        'Active fallback provider failed during fallback window',
        `provider=${activeEntry.provider} model=${activeEntry.model ?? 'default'}`
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
  maybeArmFallbackAfterEmptyPrimaryTurn(
    queue: IOutboundQueue,
    session: SessionManager | null,
    turnHadToolWork: boolean,
    mapKey: string | undefined,
  ): boolean {
    if (this.host.isFallbackWindowActive) return false;
    if (this.host.agentFallbacks.length === 0) return false;
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
    // turns pass session=null here, and this.host.controlSession also defaults to
    // null, so a bare session===this.host.controlSession would match every turn.
    if ((this.host.controlSession !== null && session === this.host.controlSession) || mapKey === 'control@heal.internal') {
      return false;
    }

    this.host.consecutivePrimaryEmptyTurns += 1;
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
    const probeFlagsUnusable = this.host.primaryModelUsability && !this.host.primaryModelUsability.probeInFlight
      ? primaryModelUsabilityRequiresAlert(this.host.primaryModelUsability)
      : false;
    const reachedThreshold =
      this.host.consecutivePrimaryEmptyTurns >= EMPTY_OUTPUT_FALLBACK_THRESHOLD;

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
      this.host.turnCapabilityTracker.lastSuccessfulTurnAt === null &&
      performance.now() - this.host.runtimeBootPerfMs < EMPTY_OUTPUT_ARM_STARTUP_GRACE_MS;
    const armViaProbe = probeFlagsUnusable && !inStartupGrace;
    if (!armViaProbe && !reachedThreshold) return false;

    log.warn(
      {
        instanceName: this.host.instanceName,
        primaryProvider: this.host.agentProvider,
        consecutivePrimaryEmptyTurns: this.host.consecutivePrimaryEmptyTurns,
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

    const replayScheduled = this.host.scheduleFallbackReplay({
      activation,
      chatJid: queue.targetChatJid,
      mapKey,
      oldSession: session,
      hadToolActivity: turnHadToolWork,
    });
    this.host.notifyProviderFallbackActivated(queue, activation, {
      replayScheduled,
      blockedByToolActivity: turnHadToolWork,
    });
    this.host.consecutivePrimaryEmptyTurns = 0;
    return true;
  }

  /**
   * Arm provider fallback when the PRIMARY provider returns REPEATED unclassified
   * terminal errors — the default-deny "unknown-terminal" case (an is_error result
   * whose text {@link classifyProviderFailure} cannot place in any known class).
   * Such a turn produces no arming provider-failure MESSAGE, so the text-driven
   * ladders never fire and (unlike empty output) the failure is masked behind a
   * generic notice; a broken primary throwing them stalled turn after turn while
   * an eligible fallback sat idle.
   *
   * A single unknown-terminal is transient (the caller keeps the session and
   * surfaces the generic notice). After {@link UNKNOWN_TERMINAL_FALLBACK_THRESHOLD}
   * consecutive occurrences on REAL user turns this fails over exactly like the
   * sibling terminal classes: activate + replay + notify, with reason
   * 'unknown-terminal-repeated'. Selection does NOT force an independent provider
   * (unknown-terminal-repeated is absent from fallbackRequiresIndependentProbe),
   * so an operator-configured same-provider downgrade rung stays eligible; the
   * revert is still gated on a fresh primary probe (fallbackRequiresPrimaryProbe)
   * because there is no parseable reset estimate.
   *
   * Gated exactly like {@link maybeArmFallbackAfterEmptyPrimaryTurn}: only real
   * user turns count (isUserTurnResult), never while a window is already active,
   * never without a configured fallback, and never for the synthetic
   * control/repair session (control@heal.internal) — whose emptiness/errors must
   * not cross-contaminate the real-chat counter. Returns true only when it armed
   * a window this call; the counter resets on activation and on any successful turn.
   */
  maybeArmFallbackAfterUnknownTerminal(
    queue: IOutboundQueue,
    session: SessionManager | null,
    turnHadToolWork: boolean,
    mapKey: string | undefined,
    isUserTurnResult: boolean,
    evidenceText: string,
  ): boolean {
    // System/heal/synthetic turns must never advance or trip the consecutive
    // threshold. Unlike the empty-output arming call-site (already inside the
    // is-user-turn guard), this branch runs in the result.text path regardless of
    // isSystemResult, so the guard is explicit here.
    if (!isUserTurnResult) return false;
    if (this.host.isFallbackWindowActive) return false;
    if (this.host.agentFallbacks.length === 0) return false;
    // control@heal.internal repair-probe exclusion — mirrors
    // maybeArmFallbackAfterEmptyPrimaryTurn (ml-bot false-failover class): the
    // controlSession !== null guard avoids the null===null trap (per-chat turns
    // pass session=null, and controlSession also defaults to null).
    if ((this.host.controlSession !== null && session === this.host.controlSession) || mapKey === 'control@heal.internal') {
      return false;
    }

    this.host.consecutiveUnknownTerminalTurns += 1;
    if (this.host.consecutiveUnknownTerminalTurns < UNKNOWN_TERMINAL_FALLBACK_THRESHOLD) return false;

    log.warn(
      {
        instanceName: this.host.instanceName,
        primaryProvider: this.host.agentProvider,
        consecutiveUnknownTerminalTurns: this.host.consecutiveUnknownTerminalTurns,
      },
      'primary provider returned repeated unclassified terminal errors — arming provider fallback',
    );

    const activation = this.activateProviderFallbackAfterTerminalResult(
      null,
      'unknown-terminal-repeated',
      session,
      evidenceText,
    );
    if (!activation) return false;

    const replayScheduled = this.host.scheduleFallbackReplay({
      activation,
      chatJid: queue.targetChatJid,
      mapKey,
      oldSession: session,
      hadToolActivity: turnHadToolWork,
    });
    this.host.notifyProviderFallbackActivated(queue, activation, {
      replayScheduled,
      blockedByToolActivity: turnHadToolWork,
    });
    // No replay took over (tool activity already started, or nothing to replay):
    // the primary session actually errored, so tear it down like the sibling
    // terminal branches — the active window routes the next turn to the fallback.
    if (!replayScheduled) session?.shutdown();
    this.host.consecutiveUnknownTerminalTurns = 0;
    return true;
  }

  activateProviderFallbackAfterTerminalResult(
    resetAt: Date | null,
    reason: ProviderFallbackReason,
    session: SessionManager | null,
    evidenceText?: string,
  ): ProviderFallbackActivation | null {
    const failedKey = this.markActiveFallbackFailed(session, reason, evidenceText);
    // SINGLE tier source: route-identity attribution (failureTierForSession).
    // Deliberately NOT derived from failedKey — marking answers "serves the
    // ACTIVE entry" while the tier must answer "is NOT the primary": a stale
    // PRIOR-entry session left running across a chain advance is unmarked
    // (correctly) yet still fallback-tier. Callers never pass a tier, so no
    // call site can disagree with the attribution and every future call site
    // is clock-safe by construction.
    const tier = this.failureTierForSession(session);
    const activation = this.activateProviderFallback(resetAt, reason, tier);
    if (activation || !failedKey) return activation;

    // Preserve previous single-fallback behavior when no alternate exists:
    // keep the current fallback window instead of reverting to a known-bad primary.
    this.host.fallbackChain.failedKeys.delete(failedKey);
    return this.activateProviderFallback(resetAt, reason, tier);
  }

  /**
   * Tier-aware variant of {@link activateProviderFallback} for call sites
   * whose workflow must NOT mark the active entry failed — the
   * model-unavailable split (response-registry: markActiveEntryFailedOnTrigger
   * false, direct activation). Derives the failure tier from the same
   * route-identity attribution the marking path's sibling uses
   * (failureTierForSession), so a FALLBACK session's classified failure still
   * cannot move the window clocks while the non-marking semantics (no
   * failed-entry marking, no chain advance) are preserved.
   */
  activateProviderFallbackForSession(
    resetAt: Date | null,
    reason: ProviderFallbackReason,
    session: SessionManager | null,
  ): ProviderFallbackActivation | null {
    return this.activateProviderFallback(resetAt, reason, this.failureTierForSession(session));
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
    fallbackChain: Array<AgentFallbackEntry & {
      eligible: boolean | null;
      canary?: { status: string; checkedAt: number; failureClass: ChainEntryCanaryFailureClass | null } | null;
    }>;
    fallbackChainExhausted: boolean;
    failedEntryCount: number;
    fallbackRestoredFromPersist: boolean;
    turnErrorCounts: Record<string, number>;
    handoffDistiller: { enabled: boolean; contextInjection: boolean; model: string | null };
    fallbackDiscovery: {
      mode: 'auto';
      lastDerivedAt: number | null;
      catalogueSize: number | null;
      captureMode: ModelCatalogCaptureMode | null;
      refreshFailure: ModelCatalogUnavailableReason | null;
      candidates: Array<{
        model: string;
        evidence: CandidateEvidence;
        catalogStatus: string | null;
        releaseDate: string | null;
        zeroCost: boolean | null;
        eligibilityBasis: DiscoveredCandidate['eligibilityBasis'];
        freeTier: boolean;
        selected: boolean;
      }>;
    } | null;
  } {
    const active = this.host.isFallbackWindowActive;
    const fallbackEntry = active ? this.host.effectiveFallbackEntry : null;
    this.host.idleFallbackEligibilityResolver ??= makeIdleEligibilityResolver(
      (entry) => this.fallbackKeyPresent(entry.provider, entry.model),
      Date.now,
    );
    return {
      effectiveProvider: this.host.effectiveProvider,
      fallbackActiveUntil: active ? this.host.fallbackWindow.activeUntil : null,
      fallbackReason: active ? this.host.fallbackWindow.armReason : null,
      fallbackModel: fallbackEntry?.model ?? null,
      fallbackResetAt: active ? this.host.fallbackWindow.resetAt : null,
      fallbackRecoveryProbeRequired: active ? this.host.fallbackWindow.recoveryProbeRequired : false,
      fallbackTurnsServed: this.host.fallbackMetrics.turnsServed,
      fallbackTurnsEmpty: this.host.fallbackMetrics.turnsEmpty,
      lastFallbackTurnAt: this.host.fallbackMetrics.lastTurnAt,
      probeAttempts: this.host.fallbackProbeAttempts,
      lastProbeAt: this.host.fallbackLastProbeAt,
      fallbackActivations: this.host.fallbackMetrics.activations,
      fallbackReverts: this.host.fallbackMetrics.reverts,
      fallbackReplays: this.host.fallbackMetrics.replays,
      fallbackWindowCostUsd: this.host.fallbackMetrics.windowCostUsd,
      primaryModelUsability: this.host.primaryModelUsability ? { ...this.host.primaryModelUsability } : null,
      turnCapability: this.host.getTurnCapability(),
      activeFallbackEntry: fallbackEntry ? { ...fallbackEntry } : null,
      fallbackChain: this.host.fallbackChain.snapshot(this.host.agentFallbacks, this.host.idleFallbackEligibilityResolver)
        .map((entry) => {
          // Additive-only: entries without canary evidence keep their exact
          // pre-canary shape so existing snapshot assertions stay byte-stable.
          const record = this.chainCanary.get(this.host.fallbackChain.entryKey(entry));
          // `failureClass` is a CLOSED set; the raw provider tail stays in
          // debug logs (it carries unbounded third-party prose — request ids,
          // JSON bodies, account status). /health must stay content-free.
          return record
            ? { ...entry, canary: { status: record.status, checkedAt: record.checkedAt, failureClass: record.failureClass ?? null } }
            : entry;
        }),
      fallbackChainExhausted: this.host.fallbackChain.isExhausted(this.host.agentFallbacks),
      failedEntryCount: this.host.fallbackChain.failedKeys.size,
      fallbackRestoredFromPersist: this.host.fallbackWindowRestored,
      turnErrorCounts: Object.fromEntries(this.host.turnCapabilityTracker.errorCounts),
      handoffDistiller: {
        enabled: handoffDistillerEnabled(),
        contextInjection: handoffContextEnabled(),
        model: handoffDistillModel(),
      },
      fallbackDiscovery: this.host.agentFallbackDiscovery
        ? {
            mode: 'auto' as const,
            lastDerivedAt: this.lastDiscovery?.at ?? null,
            catalogueSize: this.lastDiscovery?.catalogueSize ?? null,
            captureMode: this.lastDiscovery?.captureMode ?? null,
            refreshFailure: this.lastDiscovery?.refreshFailure ?? null,
            candidates: (this.lastDiscovery?.basis ?? []).map((c) => ({
              model: c.model,
              evidence: c.evidence,
              catalogStatus: c.catalogStatus,
              releaseDate: c.releaseDate,
              zeroCost: c.zeroCost,
              eligibilityBasis: c.eligibilityBasis,
              freeTier: c.freeTier,
              selected: c.selected,
            })),
          }
        : null,
    };
  }

  // #1753 rem-2: delegates to the ToolRegistry every socket server (global and per-chat) shares — the single choke point every MCP tool call flows through, so this reflects in-flight calls across the whole instance.

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
    if (this.host.agentFallbacks.length === 0) {
      return { ok: false, reason: 'no fallback provider or chain configured for this instance' };
    }
    const requested = durationMs ?? DEFAULT_FALLBACK_WINDOW_MS;
    const dur = Math.min(MAX_FALLBACK_WINDOW_MS, Math.max(MIN_FALLBACK_WINDOW_MS, requested));
    const until = Date.now() + dur;
    // Reset reason so armFallbackWindow stores 'admin-forced' as the new
    // original cause, replacing any prior reason (e.g. 'usage-limit').
    this.host.fallbackWindow.armReason = null;
    this.host.fallbackChain.failedKeys.clear();
    this.host.fallbackEmptyAdvance.reset();
    this.armFallbackWindow(until, 'admin-forced');
    log.info({ activeUntil: new Date(until).toISOString() }, 'fallback window forced by admin');
    return { ok: true, activeUntil: until, clamped: dur !== requested };
  }

  /** Admin override (FALLBACK OFF): end any active fallback window now. Idempotent. */
  disableFallback(): { ok: true } {
    this.host.deactivateProviderFallback('admin-disabled');
    return { ok: true };
  }

  /** Provider config paired with {@link effectiveProvider}. */
  get effectiveProviderConfig(): Record<string, unknown> | undefined {
    const fallbackEntry = this.host.effectiveFallbackEntry;
    if (!fallbackEntry) return this.host.agentProviderConfig;
    return fallbackProviderConfigFor(fallbackEntry.provider, this.host.agentProvider, this.host.agentProviderConfig) ?? this.host.agentProviderConfig;
  }

  primaryOpencodeProviderConfig(): OpencodeProviderConfig | undefined {
    if (this.host.agentProvider !== 'opencode-cli' || !this.host.agentProviderConfig) return undefined;

    const providerConfig: OpencodeProviderConfig = {};
    const baseUrl = this.host.agentProviderConfig['baseUrl'];
    if (typeof baseUrl === 'string') {
      providerConfig.baseUrl = baseUrl;
    }
    if (this.host.model) {
      providerConfig.model = this.host.model;
    }
    const apiKeyService = this.host.agentProviderConfig['apiKeyService'];
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
  fallbackKeyPresent(provider: string | undefined, model: string | undefined): boolean | null {
    return fallbackKeyPresentFor(provider, model, this.host.agentProvider, this.host.agentProviderConfig);
  }

  /**
   * User-facing notice for a usage-limit teardown when no fallback replay can
   * run. A per-model-tier usage cap is NOT cleared by waiting — the remedy is
   * operator action (add credits or switch the model), so the copy names that
   * call to action rather than telling the user to "try again after the limit
   * resets". No ops alert fires on either branch, so the copy does not claim an
   * operator was already notified. Pure factory (single source of copy);
   * redaction-safe (no provider text, no PII).
   */
  usageLimitNotice(): string {
    return this.host.agentFallbacks.length > 0
      ? "_I've reached a model usage limit and the backup couldn't continue this turn. An operator needs to add credits or switch my model._"
      : "_I've reached a model usage limit and couldn't switch automatically. An operator needs to add credits or switch my model._";
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
   * prune→check→set→capDedupeMap idiom, reusing this.host.fallbackTunables.noticeDedupMs.
   */
  emitNoFallbackReauthNotice(queue: IOutboundQueue): void {
    const now = Date.now();
    for (const [key, recordedAt] of this.host.recentNoFallbackReauthNotices) {
      if (now - recordedAt > this.host.fallbackTunables.noticeDedupMs) {
        this.host.recentNoFallbackReauthNotices.delete(key);
      }
    }
    const noticeKey = [queue.targetChatJid, 'auth-required'].join(':');
    if (this.host.recentNoFallbackReauthNotices.has(noticeKey)) return;
    queue.enqueueText('_The agent needs re-authentication before it can reply here. An operator has been notified._');
    // Dedup is recorded only AFTER a successful enqueue: recording first meant a
    // teardown-race throw suppressed both the notice and the alert for the full
    // dedup window with no retry.
    this.host.recentNoFallbackReauthNotices.set(noticeKey, now);
    this.host.capDedupeMap(this.host.recentNoFallbackReauthNotices);
    // Back the "operator has been notified" claim: no result-path alert fires on
    // the no-fallback auth-required teardown (fallback alerts fire only when a
    // fallback activates), so without this the notice claim would be unbacked.
    // Fires at notice cadence — the dedup early-return above gates both.
    emitAlertChecked(
      this.host.instanceName,
      'provider_auth_required_no_fallback',
      'Agent needs re-authentication and no fallback is available',
      `chat=${queue.targetChatJid}`,
    );
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
  recordFallbackTurnOutcome(
    queue: IOutboundQueue,
    hadVisibleOutput: boolean,
    hadToolWork: boolean = false,
    session: SessionManager | null = null,
    wasUnclassifiedError: boolean = false,
  ): void {
    if (!this.host.isFallbackWindowActive) return;
    this.host.fallbackMetrics.recordServedTurn();
    // An UNCLASSIFIED terminal error from the active fallback ENTRY carries
    // non-empty raw error text (suppressed from the user, replaced by a notice),
    // so hadVisibleOutput is true even though the turn produced no usable reply.
    // Treat it as unproductive like a structurally-empty turn — otherwise the
    // reset below wipes the advance run every turn and the bot pins forever on a
    // dead entry while a working entry waits behind it in the chain.
    if ((hadVisibleOutput || hadToolWork) && !wasUnclassifiedError) {
      // The active entry produced a real reply — it is healthy. Clear the
      // empty-advance accounting so a later isolated empty turn starts fresh.
      this.host.fallbackEmptyAdvance.reset();
      return;
    }
    this.host.fallbackMetrics.recordEmptyTurn();
    this.host.fallbackEmptyAdvance.recordEmpty();
    const entry = this.host.fallbackWindow.activeEntry ?? this.host.agentFallbacks[0] ?? null;
    log.warn({
      chatJid: queue.targetChatJid,
      fallbackProvider: entry?.provider,
      fallbackModel: entry?.model,
      served: this.host.fallbackMetrics.turnsServed,
      empty: this.host.fallbackMetrics.turnsEmpty,
    }, 'fallback turn completed with zero visible output');
    // Per-chat dedup: reuse this.host.fallbackTunables.noticeDedupMs window to avoid
    // one alert per empty turn in a sustained silent-bot episode.
    const emptyAlertNow = Date.now();
    for (const [k, ts] of this.host.recentFallbackEmptyTurnAlerts) {
      if (emptyAlertNow - ts > this.host.fallbackTunables.noticeDedupMs) this.host.recentFallbackEmptyTurnAlerts.delete(k);
    }
    if (!this.host.recentFallbackEmptyTurnAlerts.has(queue.targetChatJid)) {
      this.host.recentFallbackEmptyTurnAlerts.set(queue.targetChatJid, emptyAlertNow);
      this.host.capDedupeMap(this.host.recentFallbackEmptyTurnAlerts);
      emitAlertChecked(
        this.host.instanceName,
        'fallback_empty_turn',
        'Fallback turn produced no visible output',
        `provider=${entry?.provider} model=${entry?.model} served=${this.host.fallbackMetrics.turnsServed} empty=${this.host.fallbackMetrics.turnsEmpty} chat=${queue.targetChatJid}`,
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
    const entryKey = entry ? this.host.fallbackChain.entryKey(entry) : null;
    if (
      session !== null &&
      entryKey !== null &&
      this.host.fallbackEmptyAdvance.shouldAttemptAdvance(entryKey, EMPTY_OUTPUT_FALLBACK_THRESHOLD)
    ) {
      const advanceReason = isProviderFallbackReason(this.host.fallbackWindow.armReason)
        ? this.host.fallbackWindow.armReason
        : 'auth-required';
      const resetAt = this.host.fallbackWindow.resetAt !== null ? new Date(this.host.fallbackWindow.resetAt) : null;
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
        this.host.fallbackEmptyAdvance.clearConsecutive();
        log.warn({
          chatJid: queue.targetChatJid,
          deadProvider: entry?.provider,
          deadModel: entry?.model,
          advancedTo: this.host.fallbackWindow.activeEntry?.provider,
          advancedModel: this.host.fallbackWindow.activeEntry?.model,
        }, 'advanced fallback chain past structurally-empty entry');
      }
    }
  }

  /**
   * Advance the chain when the ACTIVE fallback entry's turn PROCESS fails
   * (non-zero exit or fatal spawn). Fleet incident 2026-08-15: a
   * billing-suspended provider account CONNECTS and then exits 1 on every
   * turn WITHOUT emitting a terminal result — the spawn-per-turn exit handler
   * discards the buffered result on a non-zero exit, so neither the
   * text-classified advance path nor the empty-output advance path
   * (recordFallbackTurnOutcome) ever runs, and the window pins forever on a
   * dead entry while healthy entries wait behind it in the chain. Metadata
   * preflights cannot catch this class of failure (the suspended account's
   * models endpoint still returns 200), so the only reliable evidence is the
   * turn outcome itself.
   *
   * A process failure is decisive evidence against the entry, so advance on
   * the FIRST failure: failedKeys stops this window re-selecting the dead
   * entry, and the terminal path's single-fallback preservation keeps the
   * current entry when no alternate exists.
   *
   * Returns null when the crash is not attributable to the active fallback
   * entry (no window, primary-provider session, provider mismatch) so the
   * caller runs the ordinary crash machinery unchanged.
   */
  recordFallbackTurnProcessFailure(
    session: SessionManager | null,
    evidence: string,
  ): {
    advanced: boolean;
    activation: ProviderFallbackActivation | null;
    fromProvider: string;
    fromModel: string | null;
  } | null {
    if (!this.host.isFallbackWindowActive || !this.host.fallbackWindow.activeEntry) return null;
    const from = this.host.fallbackWindow.activeEntry;
    const fromKey = this.host.fallbackChain.entryKey(from);
    const advanceReason = isProviderFallbackReason(this.host.fallbackWindow.armReason)
      ? this.host.fallbackWindow.armReason
      : 'auth-required';
    const resetAt = this.host.fallbackWindow.resetAt !== null
      ? new Date(this.host.fallbackWindow.resetAt)
      : null;
    // Attribution gate: markActiveFallbackFailed only matches a session that is
    // actually serving the active entry's provider — a PRIMARY session crashing
    // during a window returns null here and takes the normal crash path. The
    // duplicate call inside activateProviderFallbackAfterTerminalResult below
    // is idempotent (failedKeys.has guard) and returns the same key.
    if (this.markActiveFallbackFailed(session, advanceReason, evidence) === null) return null;
    const activation = this.activateProviderFallbackAfterTerminalResult(
      resetAt,
      advanceReason,
      session,
      evidence,
    );
    const to = this.host.fallbackWindow.activeEntry;
    const advanced = activation !== null
      && to !== null
      && this.host.fallbackChain.entryKey(to) !== fromKey;
    if (advanced) {
      log.warn({
        deadProvider: from.provider,
        deadModel: from.model,
        advancedTo: to?.provider,
        advancedModel: to?.model,
        evidence: evidence.slice(0, 160),
      }, 'advanced fallback chain past process-failing entry');
    }
    return { advanced, activation, fromProvider: from.provider, fromModel: from.model ?? null };
  }

  // ── Chain canary (R4-shape out-of-band probes; fleet incident 2026-08-15) ──
  // Metadata preflights cannot see account-level death (a billing-suspended
  // account's models endpoint returns 200); only a real completion can. The
  // canary issues a tiny completion per configured opencode-cli entry on an
  // interval, records per-entry evidence, alerts on health transitions, and
  // lets window selection skip entries with FRESH failure evidence (fail-open:
  // if every candidate has failure evidence, the canary is disregarded so a
  // stale sweep can never strand the chain).

  private readonly chainCanaryConfig: FallbackCanaryConfig = resolveFallbackCanaryConfig();
  private readonly chainCanary = new Map<string, ChainEntryCanaryResult & { checkedAt: number }>();
  private chainCanaryTimer: ReturnType<typeof setInterval> | null = null;
  private chainCanarySweepInFlight = false;

  /** Arm the periodic canary. No-op unless WHATSOUP_FALLBACK_CANARY_MS > 0. */
  startChainCanary(): void {
    if (this.chainCanaryConfig.intervalMs <= 0 || this.chainCanaryTimer) return;
    this.chainCanaryTimer = setInterval(() => {
      void this.runChainCanarySweep('scheduled');
    }, this.chainCanaryConfig.intervalMs);
    this.chainCanaryTimer.unref?.();
    // First sweep shortly after boot so /health has evidence without waiting a
    // full interval; delayed so startup work settles first.
    setTimeout(() => { void this.runChainCanarySweep('startup'); }, 30_000).unref?.();
    log.info({ intervalMs: this.chainCanaryConfig.intervalMs }, 'fallback chain canary armed');
  }

  stopChainCanary(): void {
    if (this.chainCanaryTimer) {
      clearInterval(this.chainCanaryTimer);
      this.chainCanaryTimer = null;
    }
  }

  /** Probe every canary-capable chain entry sequentially; record + alert transitions. */
  async runChainCanarySweep(trigger: string): Promise<void> {
    if (this.chainCanarySweepInFlight) return;
    this.chainCanarySweepInFlight = true;
    try {
      for (const entry of this.chainCanarySweepEntries()) {
        const key = this.host.fallbackChain.entryKey(entry);
        if (entry.provider !== 'opencode-cli') {
          // v1 scope: only the CLI transport the estate's chains use. Recorded
          // as unknown so /health distinguishes "not probed" from "healthy".
          if (!this.chainCanary.has(key)) {
            this.chainCanary.set(key, { status: 'unknown', evidence: null, failureClass: null, durationMs: 0, checkedAt: systemClock.now() });
          }
          continue;
        }
        const binary = getProviderBinary(entry.provider);
        if (!binary) continue;
        const providerConfig = fallbackProviderConfigFor(entry.provider, this.host.agentProvider, this.host.agentProviderConfig);
        let env: NodeJS.ProcessEnv;
        try {
          env = buildChildEnv(
            entry.provider,
            {
              allowM365Mutations: this.host.allowM365Mutations,
              whatsoupInstance: this.host.instanceName,
              whatsoupMcpSocket: this.host.globalMcpSocketPath ?? undefined,
            },
            entry.model,
            providerConfig,
          );
        } catch (err) {
          log.warn({ err: errorMessage(err), provider: entry.provider, model: entry.model }, 'chain canary env build failed — entry skipped');
          continue;
        }
        const args = buildOpenCodeRunArgs({ providerConfig, model: entry.model });
        const previous = this.chainCanary.get(key);
        const result = await probeChainEntryCompletion(
          binary,
          args,
          CHAIN_CANARY_PROMPT,
          env,
          this.chainCanaryConfig.timeoutMs,
        );
        this.chainCanary.set(key, { ...result, checkedAt: systemClock.now() });
        const wasHealthy = previous === undefined || previous.status === 'ok' || previous.status === 'unknown';
        if (result.status !== 'ok' && wasHealthy) {
          emitAlertChecked(
            this.host.instanceName,
            'fallback_chain_entry_unhealthy',
            'Fallback chain entry failed its real-completion canary',
            `provider=${entry.provider} model=${entry.model ?? 'default'} status=${result.status}`
              + ` trigger=${trigger}${result.failureClass ? ` failureClass=${result.failureClass}` : ''}`,
          );
          log.warn({ provider: entry.provider, model: entry.model, status: result.status, failureClass: result.failureClass }, 'fallback chain entry canary failed');
          log.debug({ provider: entry.provider, model: entry.model, evidence: result.evidence }, 'fallback chain entry canary raw failure tail');
        } else if (result.status === 'ok' && previous !== undefined && previous.status !== 'ok' && previous.status !== 'unknown') {
          clearAlertSourceChecked(
            this.host.instanceName,
            'fallback_chain_entry_unhealthy',
            `recoveryProof=canary_completion provider=${entry.provider} model=${entry.model ?? 'default'}`,
          );
          log.info({ provider: entry.provider, model: entry.model }, 'fallback chain entry canary recovered');
        }
      }
      // Discovery mode: sweep evidence just changed — re-rank the chain on it
      // (mid-window this re-orders only the not-yet-tried remainder).
      if (this.host.agentFallbackDiscovery) {
        await this.refreshDiscoveredFallbackChain('canary-sweep');
      }
    } finally {
      this.chainCanarySweepInFlight = false;
    }
  }

  /**
   * Canary evidence for `key` projected onto the discovery evidence axis,
   * honoring the trust TTL in BOTH directions: stale results (ok or failed)
   * decay to 'unknown' so neither a lapsed success nor a lapsed failure keeps
   * steering selection/derivation.
   */
  private chainCanaryEvidence(key: string): CandidateEvidence {
    const record = this.chainCanary.get(key);
    if (record === undefined) return 'unknown';
    if (systemClock.now() - record.checkedAt > this.chainCanaryConfig.trustMs) return 'unknown';
    if (record.status === 'ok') return 'ok';
    if (record.status === 'failed' || record.status === 'timeout') return 'dead';
    return 'unknown';
  }

  /** Fresh failure evidence for `key`, honoring the trust TTL. */
  private chainCanaryDead(key: string): boolean {
    return this.chainCanaryEvidence(key) === 'dead';
  }

  // ── Discovery-mode chain derivation (R6, owner directive 2026-08-15) ──
  // The chain is DERIVED per host/user/deployment from the gateway's
  // credential-aware model catalogue (`<binary> models`) instead of a
  // hardcoded list. The derivation is pure (fallback-discovery.ts); this
  // block owns the runtime lifecycle: boot derivation, staleness refresh at
  // window arm, evidence-driven re-rank after each canary sweep, and the
  // in-place mutation of host.agentFallbacks that every downstream consumer
  // (selection, canary, exhaustion, restore membership, /health) reads live.

  private lastDiscovery: {
    at: number;
    catalogueSize: number;
    captureMode: ModelCatalogCaptureMode;
    refreshFailure: ModelCatalogUnavailableReason | null;
    basis: DiscoveredCandidate[];
  } | null = null;
  private discoveryRefreshInFlight = false;

  /**
   * Re-derive the discovered fallback chain from the live model catalogue.
   * No-op unless discovery mode is configured. Honest degrade: an unavailable
   * catalogue NEVER wipes a previously derived (or restored) chain — the
   * current chain stands until the catalogue can be read again; the
   * `fallback_discovery_empty` alert fires only when the instance is actually
   * left without a ladder.
   */
  async refreshDiscoveredFallbackChain(trigger: 'boot' | 'window-arm' | 'canary-sweep'): Promise<void> {
    const discovery = this.host.agentFallbackDiscovery;
    if (!discovery) return;
    if (this.discoveryRefreshInFlight) return;
    this.discoveryRefreshInFlight = true;
    try {
      const binary = getProviderBinary(DISCOVERY_GATEWAY_PROVIDER);
      const listing = binary
        ? await (this.host.modelCatalogueListFn ?? listModelCatalog)(binary)
        : ({ status: 'unavailable', reason: 'spawn-error' } as const);
      if (listing.status !== 'ok') {
        log.warn({ trigger, reason: listing.reason }, 'fallback discovery: model catalogue unavailable — keeping current chain');
        if (this.host.agentFallbacks.length === 0) {
          emitAlertChecked(
            this.host.instanceName,
            'fallback_discovery_empty',
            'Fallback discovery has no chain',
            `trigger=${trigger} catalogue=${listing.reason} entries=0`,
          );
        }
        return;
      }
      const derived = deriveFallbackChainFromCatalog({
        catalogIds: listing.ids,
        ...(listing.metadata ? { catalogMetadata: listing.metadata } : {}),
        gatewayProvider: DISCOVERY_GATEWAY_PROVIDER,
        primary: { provider: this.host.agentProvider, model: this.host.model ?? null },
        policy: {
          ...(discovery.maxEntries !== undefined ? { maxEntries: discovery.maxEntries } : {}),
          ...(discovery.preferModels !== undefined ? { preferModels: discovery.preferModels } : {}),
          ...(discovery.excludeProviders !== undefined ? { excludeProviders: discovery.excludeProviders } : {}),
          ...(discovery.includeFreeTier !== undefined ? { includeFreeTier: discovery.includeFreeTier } : {}),
        },
        evidenceFor: (modelId) => this.discoveredCandidateEvidence(modelId),
      });
      this.applyDiscoveredChain(derived.entries);
      const captureMode = listing.captureMode ?? 'legacy';
      const refreshFailure = listing.refreshFailure ?? null;
      this.lastDiscovery = {
        at: systemClock.now(),
        catalogueSize: listing.ids.length,
        captureMode,
        refreshFailure,
        basis: derived.basis,
      };
      log.info({
        trigger,
        catalogueSize: listing.ids.length,
        captureMode,
        refreshFailure,
        chain: this.host.agentFallbacks.map((entry) => `${entry.provider}:${entry.model ?? 'default'}`),
        basis: derived.basis.map((c) => ({
          model: c.model,
          evidence: c.evidence,
          catalogStatus: c.catalogStatus,
          releaseDate: c.releaseDate,
          zeroCost: c.zeroCost,
          eligibilityBasis: c.eligibilityBasis,
          freeTier: c.freeTier,
          selected: c.selected,
        })),
      }, 'fallback chain discovered');
      if (this.host.agentFallbacks.length === 0) {
        emitAlertChecked(
          this.host.instanceName,
          'fallback_discovery_empty',
          'Fallback discovery derived an empty chain',
          `trigger=${trigger} catalogueSize=${listing.ids.length} candidates=${derived.basis.length}`,
        );
      } else {
        clearAlertSourceChecked(
          this.host.instanceName,
          'fallback_discovery_empty',
          `recoveryProof=chain_derived entries=${this.host.agentFallbacks.length}`,
        );
      }
    } finally {
      this.discoveryRefreshInFlight = false;
    }
  }

  /**
   * Install a derived chain into host.agentFallbacks IN PLACE (ports hold the
   * array by reference). Mid-window the re-derivation NEVER swaps the ACTIVE
   * entry and never drops entries already tried this window — their failed
   * keys drive exhaustion — so only the not-yet-tried remainder is re-ranked;
   * window semantics are unchanged.
   */
  private applyDiscoveredChain(derived: { provider: string; model: string }[]): void {
    const chain = this.host.fallbackChain;
    const active = this.host.isFallbackWindowActive ? this.host.fallbackWindow.activeEntry : null;
    const keep: AgentFallbackEntry[] = [];
    const keepKeys = new Set<string>();
    if (active) {
      for (const entry of this.host.agentFallbacks) {
        const key = chain.entryKey(entry);
        if (keepKeys.has(key)) continue;
        if (key === chain.entryKey(active) || chain.failedKeys.has(key)) {
          keep.push(entry);
          keepKeys.add(key);
        }
      }
      const activeKey = chain.entryKey(active);
      if (!keepKeys.has(activeKey)) {
        keep.unshift({ ...active });
        keepKeys.add(activeKey);
      }
    }
    const next = derived.filter((entry) => !keepKeys.has(chain.entryKey(entry)));
    this.host.agentFallbacks.splice(0, this.host.agentFallbacks.length, ...keep, ...next);
  }

  /**
   * Evidence oracle for the derivation: window-scoped failure records first
   * (an entry that already failed THIS window is dead for re-ranking purposes),
   * then fresh canary evidence.
   */
  private discoveredCandidateEvidence(modelId: string): CandidateEvidence {
    const key = this.host.fallbackChain.entryKey({ provider: DISCOVERY_GATEWAY_PROVIDER, model: modelId });
    if (this.host.isFallbackWindowActive && this.host.fallbackChain.failedKeys.has(key)) return 'dead';
    return this.chainCanaryEvidence(key);
  }

  /**
   * The entry set a canary sweep probes. Static chains sweep the configured
   * entries. Discovery mode sweeps the last derivation's provider-candidate
   * basis (capped), not just the selected chain. This preserves one recovery
   * probe for a provider whose representative is dead. A dead model replaced
   * by a live sibling is deliberately absent until its failure evidence lapses;
   * sweeping every sibling would violate the bounded-probe contract.
   */
  private chainCanarySweepEntries(): AgentFallbackEntry[] {
    if (!this.host.agentFallbackDiscovery || this.lastDiscovery === null) {
      return this.host.agentFallbacks;
    }
    return this.lastDiscovery.basis
      .slice(0, CHAIN_CANARY_DISCOVERY_SWEEP_CAP)
      .map((candidate) => ({ provider: DISCOVERY_GATEWAY_PROVIDER, model: candidate.model }));
  }

  /** Arm (or move) the fallback window to `until`, schedule the revert timer,
   *  and persist best-effort so a restart mid-window resumes on fallback.
   *  Pass `activatedAt` explicitly when restoring to preserve the original
   *  time, and `opts.restored` so a resumed window is not re-counted. */
  /**
   * Discovery mode: re-derive a stale (or never-completed) catalogue snapshot
   * fire-and-forget — the caller proceeds on the current chain (never blocks
   * on a spawn); the refresh re-ranks the untried remainder.
   */
  private kickStaleDiscoveryRefresh(trigger: 'window-arm'): void {
    if (
      this.host.agentFallbackDiscovery
      && (this.lastDiscovery === null || systemClock.now() - this.lastDiscovery.at > DISCOVERY_STALE_MS)
    ) {
      void this.refreshDiscoveredFallbackChain(trigger);
    }
  }

  armFallbackWindow(until: number, reason: string, activatedAt: number = Date.now(), opts?: { restored?: boolean; preserveClocks?: boolean }): boolean {
    this.kickStaleDiscoveryRefresh('window-arm');
    const selection = this.selectFallbackEntryForWindow(reason);
    if (!selection) return false;
    const fallbackEntry = selection.entry;
    this.host.fallbackWindow.activeEntry = fallbackEntry;
    this.host.fallbackWindow.activeUntil = until;
    this.host.fallbackWindow.activatedAt = activatedAt;
    // First-arm discriminator, captured before the guard below consumes it:
    // null means this call is the window's first arm in this process (a fresh
    // activation or a post-restart restore), non-null means an extension of
    // the already-armed window. Pre-flight runs only on first arms — an
    // extension re-arm re-spawning the credential/binary/catalog probes and
    // re-firing their alerts on every per-turn usage-limit is an unthrottled
    // storm, and nothing about the target entry's environment changed.
    const firstArm = this.host.fallbackWindow.armReason === null;
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
      this.host.emitRouteEventChecked({
        event: 'auto_fallback_started',
        conversationKey: null,
        provider: fallbackEntry.provider,
        modelRef: fallbackEntry.model ?? null,
        source: 'auto_fallback',
        userVisible: !opts?.restored,
        reasonCode: opts?.restored ? `${reason} (restored)` : reason,
      });
      this.host.fallbackWindow.armReason = reason;
      // Snapshot the lifetime turn counters at the first arm of every window
      // (the null-guard skips extensions; restores hit it too because the
      // guard is per-process, which is correct — the counters are also
      // per-process, so a restored window counts from this process's zero).
      this.host.fallbackMetrics.snapshotAtArm();
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
          this.host.instanceName,
          'provider_fallback_restored',
          'Provider fallback window restored after restart',
          `reason=${reason} provider=${fallbackEntry.provider} model=${fallbackEntry.model ?? 'default'}`
            + ` until=${new Date(until).toISOString()} probeAttempts=${this.host.fallbackProbeAttempts}`,
          'info',
        );
      } else {
        this.host.fallbackMetrics.recordActivation();
        emitAlertChecked(
          this.host.instanceName,
          'provider_fallback_activated',
          'Provider fallback window activated',
          `reason=${reason} provider=${fallbackEntry.provider} model=${fallbackEntry.model ?? 'default'} until=${new Date(until).toISOString()}`,
        );
      }
    }
    // A clock-preserving arm (fallback-tier chain advance, `until` unchanged)
    // keeps the already-armed revert timer: its deadline is the same, and
    // re-setting it would be the disallowed re-arm the moment a caller ever
    // passed a moved `until`. The revert timer is only ever null while no
    // window is active, so the preserve branch (active window by definition)
    // still re-arms defensively if the handle is somehow missing.
    if (!opts?.preserveClocks || this.host.revertTimer === null) {
      if (this.host.revertTimer) {
        clearTimeout(this.host.revertTimer);
        this.host.revertTimer = null;
      }
      this.host.revertTimer = setTimeout(() => {
        this.handleFallbackRevertTimer();
      }, Math.max(0, until - Date.now()));
      // Do not let the revert timer keep the process alive at shutdown.
      this.host.revertTimer.unref?.();
    }
    // Belt-and-suspenders: persist the memory-authoritative reason (fallbackArmReason
    // after the set-when-null guard above) so the DB can never diverge from the
    // in-memory value even if a caller passes an incorrect reason directly.
    const persistReason = this.host.fallbackWindow.armReason ?? reason;
    this.host.fallbackWindow.recoveryProbeRequired = fallbackRequiresPrimaryProbe(persistReason as ProviderFallbackReason);
    // The standing primary probe's countdown must survive a clock-preserving
    // arm: scheduleFallbackPrimaryProbe clears and restarts it, which under
    // per-turn fallback failures kept pushing the probe out forever.
    if (!opts?.preserveClocks) this.scheduleFallbackPrimaryProbe();
    try {
      saveFallbackState(this.host.db, {
        activeUntil: until,
        activatedAt,
        reason: persistReason,
        probeAttempts: this.host.fallbackProbeAttempts,
        version: PERSISTED_FALLBACK_STATE_VERSION,
        activeEntryProvider: fallbackEntry.provider,
        activeEntryModel: fallbackEntry.model ?? null,
        failedKeys: failedKeysToPersistedKeys(this.host.fallbackChain.failedKeys),
      });
    } catch (err) {
      log.warn({ err }, 'failed to persist fallback window — continuing in-memory');
      emitAlertChecked(
        this.host.instanceName,
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
    // Route currency: an arm (fresh, extension after advance, or restore) can
    // change the route NEW sessions resolve — any live manager still frozen on
    // the previous route (the primary, or a dead chain entry after an advance)
    // must be recycled at its next idle boundary or it keeps serving the old
    // provider indefinitely (live-proven 2026-08-15, see
    // schedulePostTransitionRouteRecycles).
    this.host.schedulePostTransitionRouteRecycles();
    if (!firstArm) return true;
    // Pre-flight: check key presence and probe validity; never blocks or reverts
    // the window — fail-open on anything except a definitive 401/403.
    const fallbackProviderConfig = fallbackProviderConfigFor(
      fallbackEntry.provider,
      this.host.agentProvider,
      this.host.agentProviderConfig,
    );
    const fallbackBinary = getProviderBinary(fallbackEntry.provider);
    let fallbackProbeEnv: NodeJS.ProcessEnv | null = null;
    if (fallbackBinary) {
      try {
        fallbackProbeEnv = buildChildEnv(
          fallbackEntry.provider,
          {
            allowM365Mutations: this.host.allowM365Mutations,
            whatsoupInstance: this.host.instanceName,
            whatsoupMcpSocket: this.host.globalMcpSocketPath ?? undefined,
          },
          fallbackEntry.model,
          fallbackProviderConfig,
        );
      } catch (err) {
        const detail = errorMessage(err);
        log.error({
          err: detail,
          fallbackProvider: fallbackEntry.provider,
          fallbackModel: fallbackEntry.model,
        }, 'fallback preflight child environment configuration failed');
        emitAlertChecked(
          this.host.instanceName,
          'fallback_preflight_config_error',
          'Fallback provider preflight configuration error',
          `provider=${alertEvidenceValue(fallbackEntry.provider)}`
            + ` model=${alertEvidenceValue(fallbackEntry.model)}`
            + ` detail=${alertEvidenceValue(detail)}`,
        );
        return true;
      }
    }

    const service = resolveProviderKeyService(
      fallbackEntry.provider,
      fallbackEntry.model,
      fallbackProviderConfig,
    );
    if (service) {
      const key = lookupCredential(service);
      if (!key) {
        log.warn({
          instanceName: this.host.instanceName,
          fallbackProvider: fallbackEntry.provider,
          fallbackModel: fallbackEntry.model,
        }, 'fallback provider key not found in keyring — opencode sessions will fail auth');
        if (!selection.selectedHadMissingCredential) {
          emitAlertChecked(
            this.host.instanceName,
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
            this.host.instanceName,
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
    if (fallbackBinary && fallbackProbeEnv) {
      void probeFallbackBinary(fallbackBinary, fallbackProbeEnv).then((r) => {
        if (r.status === 'missing') {
          log.error(
            { fallbackProvider: fallbackEntry.provider, binary: fallbackBinary },
            'fallback provider binary not found on this host',
          );
          emitAlertChecked(
            this.host.instanceName,
            'fallback_binary_missing',
            'Fallback provider binary not found on this host',
            `binary=${fallbackBinary} provider=${fallbackEntry.provider} model=${fallbackEntry.model}`,
          );
        } else if (r.status === 'incompatible') {
          log.error(
            { fallbackProvider: fallbackEntry.provider, binary: fallbackBinary },
            'fallback provider binary has wrong architecture for this host',
          );
          emitAlertChecked(
            this.host.instanceName,
            'fallback_binary_incompatible',
            'Fallback provider binary wrong architecture',
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
            void probeModelCatalog(fallbackBinary, fallbackModel, fallbackProbeEnv).then((catalog) => {
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
                this.host.instanceName,
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
   * Re-arm a persisted fallback window after a process restart. Never throws.
   * #3019: restore/reconciliation logic extracted into fallback-restore.ts.
   */
  restorePersistedFallbackWindow(): void {
    const r = restorePersistedFallbackWindowState(
      { db: this.host.db, agentFallbacks: this.host.agentFallbacks,
        resetFailedKeys: () => this.host.fallbackChain.failedKeys.clear(),
        addFailedKey: (k) => this.host.fallbackChain.failedKeys.add(k),
        entryKeyFor: (p, m) => this.host.fallbackChain.entryKey({ provider: p, model: m ?? undefined }) },
      MAX_FALLBACK_WINDOW_MS, Date.now);
    if (r.outcome !== 'armed') { this.host.fallbackWindowRestored = false; return; }
    this.host.fallbackProbeAttempts = r.persistedProbeAttempts;
    const ok = this.armFallbackWindow(r.clampedUntil, r.persistedReason, r.persistedActivatedAt, { restored: true });
    if (!ok) { clearFallbackState(this.host.db); this.host.fallbackWindowRestored = false; return; }
    this.host.fallbackWindowRestored = true;
    log.info({ activeUntil: new Date(r.clampedUntil).toISOString(),
      ...(r.clampedUntil < r.persistedUntil ? { persistedUntil: new Date(r.persistedUntil).toISOString() } : {}),
      originalReason: r.persistedReason, restoredFailedKeys: r.restoredFailedKeys },
      'restored provider-fallback window from persisted state');
  }

  /**
   * Activate provider fallback after the primary provider cannot serve a turn.
   *
   * No-op unless a fallback provider is configured. The window ends at the
   * parsed `resetAt` when available, else `DEFAULT_FALLBACK_WINDOW_MS` from now,
   * clamped to [MIN_FALLBACK_WINDOW_MS, MAX_FALLBACK_WINDOW_MS]. Idempotent: a
   * second activation while already active extends the window to the later of
   * the two — except a fallback-tier re-activation (a FALLBACK entry's own
   * failure), which keeps the window end, the stored resetAt, and the primary
   * recovery clocks untouched regardless of any parsed reset time: a fallback
   * entry's reset estimate describes the fallback provider, not the primary.
   * Schedules an auto-revert timer (unref'd so it never keeps the process
   * alive).
   */
  activateProviderFallback(
    resetAt: Date | null,
    reason: ProviderFallbackReason = 'usage-limit',
    failureTier: FallbackFailureTier = 'primary',
  ): ProviderFallbackActivation | null {
    // Discovery mode: kick a stale/absent snapshot BEFORE the empty-chain
    // guard below — a failed boot derivation leaves the chain empty, and this
    // activation attempt is the signal that a ladder is needed NOW. The kick
    // is fire-and-forget: this activation honestly reports the current chain
    // (possibly none); the refreshed chain serves the next attempt.
    this.kickStaleDiscoveryRefresh('window-arm');
    if (this.host.agentFallbacks.length === 0) return null;

    // The no-arm rule is scoped to EXISTING window state: while window state
    // exists but the deadline is past (the ≤5s in-flight revert-probe gap), a
    // fallback-tier arm would move activeUntil and the probe resolution's
    // stale-window guard would then discard the probe's OWN decision — even a
    // successful recovery — so such activations touch nothing. With NO window
    // state at all there are no clocks or pending decisions to protect, and
    // refusing to arm silently drops the user's turn (a /model-pinned chat on
    // a chain-listed provider previously armed AND replayed): the full arm
    // path applies. That deliberately keeps the pre-existing failover-policy
    // residual that a stale post-revert fallback session's failure can arm a
    // fresh window — a policy question beyond clock preservation.
    if (failureTier === 'fallback' && this.fallbackWindowStateExists() && !this.host.isFallbackWindowActive) {
      return null;
    }

    const wasActive = this.fallbackWindowStateExists();
    // With window state present, a fallback-tier failure must not move its
    // clocks: the default-window extension below would push activeUntil out
    // by up to DEFAULT_FALLBACK_WINDOW_MS per failed fallback turn, and the
    // re-arm would restart the standing primary recovery probe — together
    // postponing primary recovery indefinitely while a dead fallback takes
    // live traffic. This holds for ANY resetAt: a non-null one here is either
    // the window's own stored value forwarded by an advance path (re-arming
    // the probe on it per-turn suppresses early recovery for the whole
    // window) or the FALLBACK entry's own parsed reset estimate, which
    // describes the fallback provider's quota, never the primary's.
    const preserveWindowClocks = failureTier === 'fallback' && this.fallbackWindowStateExists();

    const now = Date.now();
    const rawUntil = resetAt ? resetAt.getTime() : now + DEFAULT_FALLBACK_WINDOW_MS;
    const clampedUntil = Math.min(
      now + MAX_FALLBACK_WINDOW_MS,
      Math.max(now + MIN_FALLBACK_WINDOW_MS, rawUntil),
    );
    // Extend rather than shorten an already-active window — unless this is a
    // clock-preserving fallback-tier advance, which keeps the end unchanged.
    const until = preserveWindowClocks
      ? this.host.fallbackWindow.activeUntil!
      : this.host.fallbackWindow.activeUntil
        ? Math.max(this.host.fallbackWindow.activeUntil, clampedUntil)
        : clampedUntil;
    // Preserve the original first-engagement time across extensions so the
    // persisted record always reflects when the fallback was first triggered,
    // not when it was last extended.
    const activatedAt = wasActive && this.host.fallbackWindow.activatedAt !== null
      ? this.host.fallbackWindow.activatedAt
      : now;
    // Pass the original cause on extension so the root cause is preserved;
    // on first activation fallbackArmReason is null so armFallbackWindow
    // stores 'usage-limit' as the original cause.
    const persistedReason = wasActive && this.host.fallbackWindow.armReason !== null ? this.host.fallbackWindow.armReason : reason;
    // The stored resetAt is PRIMARY recovery state (when the primary's own
    // limit lifts). A fallback-tier re-activation must never overwrite it —
    // a fallback entry's parsed reset would masquerade as the primary's.
    if (!preserveWindowClocks) this.host.fallbackWindow.resetAt = resetAt?.getTime() ?? null;
    const armed = this.armFallbackWindow(until, persistedReason, activatedAt, preserveWindowClocks ? { preserveClocks: true } : undefined);
    if (!armed) return null;
    const fallbackEntry = this.host.fallbackWindow.activeEntry;
    if (!fallbackEntry) return null;
    const keyPresent = this.fallbackKeyPresent(fallbackEntry.provider, fallbackEntry.model);

    log.info({
      instanceName: this.host.instanceName,
      primaryProvider: this.host.agentProvider,
      fallbackProvider: fallbackEntry.provider,
      fallbackModel: fallbackEntry.model,
      fallbackChain: this.host.fallbackChain.snapshot(this.host.agentFallbacks),
      resetAt: resetAt ? resetAt.toISOString() : null,
      activeUntil: new Date(until).toISOString(),
      extended: wasActive,
      keyPresent,
      recoveryProbeRequired: this.host.fallbackWindow.recoveryProbeRequired,
      reason,
    }, 'activating provider fallback after primary provider failure');

    return {
      primaryProvider: this.host.agentProvider,
      fallbackProvider: fallbackEntry.provider,
      fallbackModel: fallbackEntry.model,
      reason,
      resetAt,
      activeUntil: until,
      extended: wasActive,
      keyPresent,
      recoveryProbeRequired: this.host.fallbackWindow.recoveryProbeRequired,
    };
  }

  /** Clear the fallback window + timer, reverting new sessions to the primary provider. `receipt` (DUR-02, probe-confirmed only) drives the dual clear below; every durable emission fires BEFORE the counter reset and the DB clear, so a crash mid-transition replays idempotently instead of stranding an open incident. */
  deactivateProviderFallback(reason: string, receipt: FallbackRecoveryReceipt | null = null): void {
    if (this.host.revertTimer) {
      clearTimeout(this.host.revertTimer);
      this.host.revertTimer = null;
    }
    if (this.host.fallbackPrimaryProbeTimer) {
      clearTimeout(this.host.fallbackPrimaryProbeTimer);
      this.host.fallbackPrimaryProbeTimer = null;
    }
    if (this.host.fallbackWindow.activeUntil === null) return;
    // Capture before clearing: the revert alert reports how long the window
    // ran. The idempotency guard above means this fires once per window.
    const windowMs = this.host.fallbackWindow.activatedAt !== null ? Date.now() - this.host.fallbackWindow.activatedAt : null;
    // Per-window deltas against the arm-time snapshots — the lifetime counters
    // are NOT reset here (getFallbackState keeps reporting process totals).
    const { served: windowTurnsServed, empty: windowTurnsEmpty } = this.host.fallbackMetrics.windowDeltas();
    // Slice-4 observability: one auto_fallback_cleared per window. Recovery
    // restores QUIETLY — the record is /why-retrievable, not a user notice
    // (UH-003).
    this.host.emitRouteEventChecked({
      event: 'auto_fallback_cleared',
      conversationKey: null,
      provider: this.host.fallbackWindow.activeEntry?.provider ?? this.host.agentProvider,
      modelRef: this.host.fallbackWindow.activeEntry?.model ?? null,
      source: 'auto_fallback',
      userVisible: false,
      reasonCode: reason,
    });
    // A revert is a RECOVERY, not a fault: the window ran its course (or was
    // manually disabled) and new sessions are back on the primary provider.
    // It carries useful per-window telemetry (turns served/empty, duration) so
    // it stays an emitted source rather than a bare clear — but at `info`, not
    // the emitAlertChecked `critical` default. Paging an operator to
    // "investigate/remediate" a healthy revert is pure noise (it was firing
    // critical for clean window-elapsed cycles). The matching FAULT alert —
    // provider_fallback_activated — keeps its critical default. A
    // probe-confirmed recovery appends the receipt (allowlisted fields only).
    const receiptEvidence = receipt ? formatFallbackRecoveryReceiptEvidence(receipt) : null;
    emitAlertChecked(this.host.instanceName, 'provider_fallback_reverted', 'Provider fallback window ended — reverted to primary provider', `reason=${reason} turnsServed=${windowTurnsServed} turnsEmpty=${windowTurnsEmpty} windowMs=${windowMs ?? 'unknown'}${receiptEvidence ? ` ${receiptEvidence}` : ''}`, 'info');
    // A2: real traffic isn't proven yet — the FIRST post-revert turn succeeding is (recordTurnCapabilitySuccess); a non-probe-confirmed deactivation makes no recovery claim, so it clears now.
    if (receipt) this.host.pendingPostRevertConfirmation = true;
    else clearAlertSourceChecked(this.host.instanceName, 'provider_fallback_activated', `reason=${reason} windowMs=${windowMs ?? 'unknown'}`);
    // H5: stall-incident open/closed = attempts>=threshold NOW, true for ANY reason — fixes admin-disable-mid-stall re-stranding it forever.
    if (this.host.fallbackProbeAttempts >= this.host.fallbackTunables.probeStallThreshold) clearAlertSourceChecked(this.host.instanceName, 'fallback_recovery_stalled', receiptEvidence ?? `reason=${reason} attempts=${this.host.fallbackProbeAttempts} recovery=unconfirmed episode=abandoned`);
    this.host.fallbackWindow.activeUntil = null;
    this.host.fallbackWindow.activatedAt = null;
    this.host.fallbackWindow.armReason = null;
    this.host.fallbackWindow.activeEntry = null;
    this.host.fallbackChain.failedKeys.clear();
    this.host.fallbackEmptyAdvance.reset();
    this.host.fallbackWindow.resetAt = null;
    this.host.fallbackWindow.recoveryProbeRequired = false;
    this.host.fallbackWindowRestored = false;
    // End of the stall episode (covers both successful-probe reverts and
    // manual/elapsed deactivations) — the next episode counts from zero and
    // may alert again at the threshold. fallbackLastProbeAt is kept as
    // historical observability, mirroring lastFallbackTurnAt.
    this.host.fallbackProbeAttempts = 0;
    try {
      clearFallbackState(this.host.db);
    } catch (err) {
      log.warn({ err }, 'failed to clear persisted fallback state');
    }
    log.info({
      instanceName: this.host.instanceName,
      primaryProvider: this.host.agentProvider,
      reason,
    }, 'reverting to primary provider');
    // Route currency: the revert changes the route NEW sessions resolve, but a
    // live manager frozen on the fallback provider keeps serving it — /new
    // resets INSIDE the same manager and auto-respawn re-spawns the same
    // object, so without this recycle the dead fallback kept receiving turns
    // for 7+ minutes after this very log line on 2026-08-15.
    this.host.schedulePostTransitionRouteRecycles();
    this.host.fallbackMetrics.recordRevert();
  }

  private handleFallbackRevertTimer(): void {
    if (this.host.fallbackWindow.activeUntil === null) return;
    if (!this.host.fallbackWindow.recoveryProbeRequired) {
      this.host.deactivateProviderFallback('window-elapsed');
      return;
    }
    this.host.fallbackLastProbeAt = Date.now();
    // The probe spawns a child process; fire-and-forget with the result
    // driving deactivate-or-extend in the resolution. While the probe is in
    // flight (≤5 s) the window shows expired — acceptable: the previous
    // spawnSync froze the WHOLE event loop for the same duration, forever on
    // a dead auth primary.
    const windowAtProbe = this.host.fallbackWindow.activeUntil;
    void this.probeAndEvaluateFallbackRecovery().then((decision) => {
      if (this.host.fallbackWindow.activeUntil === null || this.host.fallbackWindow.activeUntil !== windowAtProbe) return; // stale: window deactivated/re-armed mid-flight
      if (decision.commit) {
        this.host.deactivateProviderFallback('primary-probe-ok', decision.receipt);
        return;
      }
      this.host.fallbackProbeAttempts += 1;
      const now = Date.now();
      const until = now + this.host.fallbackTunables.primaryRecheckMs;
      this.host.fallbackWindow.activeUntil = until;
      this.host.revertTimer = setTimeout(() => {
        this.handleFallbackRevertTimer();
      }, this.host.fallbackTunables.primaryRecheckMs);
      this.host.revertTimer.unref?.();
      try {
        saveFallbackState(this.host.db, {
          activeUntil: until,
          activatedAt: this.host.fallbackWindow.activatedAt ?? now,
          reason: this.host.fallbackWindow.armReason ?? 'auth-required',
          // Persist the stall clock with the window so a restart mid-stall
          // resumes the count instead of resetting it.
          probeAttempts: this.host.fallbackProbeAttempts,
          version: PERSISTED_FALLBACK_STATE_VERSION,
          activeEntryProvider: this.host.fallbackWindow.activeEntry?.provider ?? null,
          activeEntryModel: this.host.fallbackWindow.activeEntry?.model ?? null,
          failedKeys: failedKeysToPersistedKeys(this.host.fallbackChain.failedKeys),
        });
      } catch (err) {
        log.warn({ err }, 'failed to extend persisted fallback window after failed recovery probe');
      }
      // Stall alert at T, 2T, 3T ... up to the DUR-02 escalation ceiling, then no repeats (see stallAlertPlan) — counter resets only on deactivation, window keeps extending.
      const atts = this.host.fallbackProbeAttempts;
      const plan = stallAlertPlan(atts, this.host.fallbackTunables.probeStallThreshold, this.host.fallbackTunables.probeStallCeilingMultiple);
      if (plan.emit) {
        emitAlertChecked(this.host.instanceName, 'fallback_recovery_stalled', 'Primary provider recovery probe is stalled — fallback window extending indefinitely', `reason=${this.host.fallbackWindow.armReason ?? 'auth-required'} attempts=${atts} windowEnd=${new Date(until).toISOString()} primaryProvider=${this.host.agentProvider}${plan.ceiling ? ' ceiling=true' : ''}`);
      }
      // No scheduleFallbackPrimaryProbe() here: the extension window equals the
      // recheck cadence, so this timer IS the probe cadence. Re-arming the
      // standing probe alongside it produced a double-probe (two probes per
      // cadence); the standing probe's guard makes it a no-op in this state.
      log.warn({
        instanceName: this.host.instanceName,
        primaryProvider: this.host.agentProvider,
        fallbackProvider: this.host.fallbackWindow.activeEntry?.provider,
        reason: this.host.fallbackWindow.armReason,
        probeAttempts: this.host.fallbackProbeAttempts,
      }, 'primary provider recovery probe still failing; keeping fallback armed');
    });
  }

  /** DUR-02: thin delegator — see resolveFallbackRecoveryDecision (fallback-recovery-transaction.ts) for the shared probe/evaluate core. A3: a commit feeds its fresh evidence straight into recordPrimaryModelUsability so /health refreshes immediately, not transitively on the first post-revert turn. */
  private probeAndEvaluateFallbackRecovery(): Promise<FallbackRecoveryDecision> {
    return resolveFallbackRecoveryDecision(
      (onEvidence) => this.host.probePrimaryProviderRecovered(onEvidence),
      {
        instanceName: this.host.instanceName, primaryProvider: this.host.agentProvider, primaryModel: this.host.model ?? null,
        fallbackProvider: this.host.fallbackWindow.activeEntry?.provider ?? this.host.agentProvider, fallbackModel: this.host.fallbackWindow.activeEntry?.model ?? null,
        probeAttemptsAtTransition: this.host.fallbackProbeAttempts,
      },
      (err) => log.warn({ err }, 'primary provider recovery probe threw — treating as failed'),
    ).then((decision) => { if (decision.commit) this.recordPrimaryModelUsability(decision.receipt.evidence, 'manual'); return decision; });
  }

  /**
   * Standing early-recovery probe. Its only purpose is to revert BEFORE a long
   * window (e.g. the 5h usage-limit default) elapses; once the remaining window
   * is within one recheck cadence the revert timer itself probes on the same
   * cadence, so arming this timer too would double-probe — the guard below
   * makes it a no-op in that state (the revert-timer path is authoritative).
   */
  private scheduleFallbackPrimaryProbe(): void {
    if (this.host.fallbackPrimaryProbeTimer) {
      clearTimeout(this.host.fallbackPrimaryProbeTimer);
      this.host.fallbackPrimaryProbeTimer = null;
    }
    if (!this.host.fallbackWindow.recoveryProbeRequired) return;
    if (
      this.host.fallbackWindow.activeUntil === null
      || this.host.fallbackWindow.activeUntil - Date.now() <= this.host.fallbackTunables.primaryRecheckMs
    ) {
      return;
    }
    this.host.fallbackPrimaryProbeTimer = setTimeout(() => {
      this.host.fallbackPrimaryProbeTimer = null;
      if (this.host.fallbackWindow.activeUntil === null || !this.host.fallbackWindow.recoveryProbeRequired) return;
      this.host.fallbackLastProbeAt = Date.now();
      const windowAtProbe = this.host.fallbackWindow.activeUntil;
      void this.probeAndEvaluateFallbackRecovery().then((decision) => {
        if (
          this.host.fallbackWindow.activeUntil === null ||
          !this.host.fallbackWindow.recoveryProbeRequired ||
          this.host.fallbackWindow.activeUntil !== windowAtProbe
        ) return;
        if (decision.commit) {
          this.host.deactivateProviderFallback('primary-probe-ok', decision.receipt);
          return;
        }
        this.scheduleFallbackPrimaryProbe();
      });
    }, this.host.fallbackTunables.primaryRecheckMs);
    this.host.fallbackPrimaryProbeTimer.unref?.();
  }

  schedulePrimaryModelUsabilityProbe(trigger: 'startup' | 'manual' | 'periodic'): void {
    const target = {
      provider: this.host.agentProvider,
      model: this.host.model ?? null,
    };
    this.host.primaryModelUsability = {
      status: 'unknown',
      provider: target.provider,
      model: target.model,
      reason: 'probe-in-flight',
      checkedAt: this.host.primaryModelUsability?.checkedAt ?? null,
      probeInFlight: true,
    };

    const adapters = createPrimaryModelProbeAdapters(this.host.agentProviderConfig, buildPrimaryProbeAdapterDeps(this.host.agentProvider, this.host.model, this.host.cwd, this.host.egressProxy?.port, this.host.providerExecutionGate));
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
      })
      // task-21: the identity check rides this seam (no poller of its own) and
      // runs after the usability result is recorded, whichever way it went —
      // the verifier owns its own shutdown drop and never rejects.
      .then(() => { this.host.verifyAccountIdentity?.(trigger); });
  }

  scheduleNextPeriodicUsabilityProbe(): void {
    // Never arm after shutdown began: a probe that resolves post-shutdown must
    // not resurrect the periodic loop (round-3 finding 1).
    if (this.host.shutdownRequested) return;
    if (this.host.periodicUsabilityProbeTimer) clearTimeout(this.host.periodicUsabilityProbeTimer);
    const now = Date.now();
    const delay = calculatePeriodicProbeDelay(this.host.periodicUsabilityProbeBackoff, this.host.primaryModelUsability?.checkedAt ?? null, now);
    // The due instant is the source of truth for the evidence freshness window
    // (runtime.modelUsabilityFreshnessMs): set it together with the timer so
    // cadence and window can never diverge.
    this.host.periodicUsabilityProbeDueAt = now + delay;
    this.host.periodicUsabilityProbeTimer = setTimeout(() => { this.host.periodicUsabilityProbeTimer = null; if (this.host.primaryModelUsability?.probeInFlight) return void this.scheduleNextPeriodicUsabilityProbe(); this.schedulePrimaryModelUsabilityProbe('periodic'); }, delay);
    this.host.periodicUsabilityProbeTimer.unref?.();
  }

  recordPrimaryModelUsability(
    result: PrimaryModelUsabilityResult,
    trigger: 'startup' | 'manual' | 'periodic',
  ): void {
    if (this.host.shutdownRequested) {
      // A probe started before shutdown resolved after it. Drop the result
      // whole: no evidence mutation, no alert emission or clear, no timer —
      // shutdown() already cleared the periodic loop and health is torn down.
      log.debug({ trigger, status: result.status }, 'primary model usability result dropped after shutdown');
      return;
    }
    this.host.primaryModelUsability = {
      ...result,
      checkedAt: Date.now(),
      probeInFlight: false,
    };
    const previousBackoff = this.host.periodicUsabilityProbeBackoff;
    this.host.periodicUsabilityProbeBackoff = calculatePeriodicProbeBackoff(previousBackoff, result.status === 'usable');
    // A periodic result always re-arms. A manual/startup result re-arms only
    // when it CHANGED the backoff while a periodic timer is armed: the old timer
    // was scheduled for the old cadence, and leaving it would let the health
    // window (derived from the due instant / backoff) diverge from the actual
    // fire time. An unchanged backoff keeps the pending timer and its due instant.
    const backoffChanged = this.host.periodicUsabilityProbeBackoff !== previousBackoff;
    if (trigger === 'periodic' || (backoffChanged && this.host.periodicUsabilityProbeTimer !== null)) {
      this.scheduleNextPeriodicUsabilityProbe();
    }

    if (result.status === 'usable') {
      // Always emit an idempotent clear on usable result.  If the prior process
      // emitted `primary_model_unusable` before dying, this new process lacks
      // the local flag but the clear is still required (#2394).  `clearAlert-`
      // is idempotent when no incident exists, so there is no double-clear risk.
      clearAlertSourceChecked(
        this.host.instanceName,
        'primary_model_unusable',
        `provider=${alertEvidenceValue(result.provider)} model=${alertEvidenceValue(result.model)}`,
      );
      this.host.primaryModelUsabilityAlertActive = false;
      return;
    }

    if (!primaryModelUsabilityRequiresAlert(result)) return;

    this.host.primaryModelUsabilityAlertActive = true;
    emitAlertChecked(
      this.host.instanceName,
      'primary_model_unusable',
      'Primary model usability probe failed',
      this.primaryModelUsabilityEvidence(result, trigger),
      'warning',
    );
  }

  private primaryModelUsabilityEvidence(result: PrimaryModelUsabilityResult, trigger: 'startup' | 'manual' | 'periodic'): string {
    return formatPrimaryModelUsabilityEvidence(result, trigger, alertEvidenceValue);
  }
}
