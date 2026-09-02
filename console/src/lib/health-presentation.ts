/**
 * health-presentation.ts — ONE canonical health-presentation registry (#2523).
 *
 * The fleet health plane already classifies every non-online line with a bounded
 * `statusReason` code, a `statusConfidence`, and structured evidence
 * (`src/fleet/health-poller.ts`). Before this module each console surface
 * re-derived what to show from `status` + `error`: the feed card discarded the
 * reason and confidence entirely, and the deployments card printed the raw code.
 * The result was that a classified condition became LESS informative after it
 * reached the operator, and a confirmed bounded cause copied as
 * "degraded — unknown".
 *
 * Every console surface that presents fleet health reads its text from here, and
 * only from here. The registry is the single source of truth for:
 *
 *   reason_code · reason_label · impact · observation_availability ·
 *   next_action_class · action proof requirements
 *
 * Rules this module enforces (the issue's presentation contract):
 *
 *  - Every registered reason code has a concise human label, an impact
 *    statement, and an operator-action disposition.
 *  - An unregistered code renders as an explicit unsupported-code state; the
 *    arbitrary string itself is never echoed as trusted prose.
 *  - Confidence and observation freshness are carried as TEXT, so they are not
 *    inferable from severity colour alone.
 *  - Observation/schema availability failures stay distinct from confirmed
 *    domain unhealthiness.
 *  - Raw exception text and raw evidence never enter this projection: no field
 *    of `HealthPresentation` is derived from `error` or `evidence`.
 *  - `unknown` appears only when the producer supplied no reason at all, never
 *    because a consumer discarded one.
 *
 * `next_action_class` and `NEXT_ACTION_POLICIES` are EXPLANATORY METADATA, not
 * mutation authority. Action eligibility and server-side mutation preconditions
 * are owned separately (#2524); nothing here enables a control.
 *
 * Drift against the producer vocabulary is enforced by
 * tests/console/health-presentation-registry-drift.test.ts, which scans the
 * poller's emission sites and fails when a code is emitted but not registered.
 */

import type { StatusConfidence } from '../types';
import { statusAlertMessage } from './status-severity';

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/**
 * Every `statusReason` value the fleet health poller can emit.
 *
 * Ordering mirrors the producer: snapshot classification first, then the
 * alert-source defaults, then the probe/poll observation failures.
 */
export const HEALTH_REASON_CODES = [
  // --- snapshot classification (classifyHealthSnapshot) ---------------------
  'health_body_ok',
  'health_body_unhealthy',
  'health_body_degraded',
  'health_body_type_error',
  'health_body_unrecognized',
  'health_body_incomplete',
  'whatsapp_auth_loss_with_disconnect_corroboration',
  'whatsapp_backoff_zero_attempts_with_disconnect_without_auth_loss_signal',
  'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
  'database_future_schema',
  'database_engine_recovery_required',
  // --- alert-source defaults (updateDegraded) ------------------------------
  'instance_degraded',
  'instance_logged_out',
  'self_health_callback',
  // --- probe / poll observation failures -----------------------------------
  'health_probe_auth_failed',
  'health_probe_timeout_under_proxy_load',
  'health_poll_failed_transient',
  'health_poll_failed_threshold',
] as const;

export type HealthReasonCode = (typeof HEALTH_REASON_CODES)[number];

/**
 * Whether the classification rests on a current, complete observation of the
 * line, or on an observation that itself failed or arrived unusable.
 *
 * `unavailable` is the load-bearing distinction the console previously lost:
 * a failed probe carries the LAST GOOD status and reason forward, so without
 * this dimension a stale carried-forward verdict reads as a fresh one.
 */
export type ObservationAvailability = 'observed' | 'incomplete' | 'unavailable';

/** Bounded operator disposition. Explanatory only — never mutation authority. */
export type NextActionClass =
  | 'none'
  | 'monitor'
  | 'investigate'
  | 'restart_line'
  | 'relink_session'
  | 'repair_database';

export interface HealthReasonEntry {
  /** Concise human label. Safe for any surface; contains no raw payload text. */
  readonly label: string;
  /** What the condition means for the operator. */
  readonly impact: string;
  /** Whether the underlying observation succeeded, was partial, or failed. */
  readonly availability: ObservationAvailability;
  /** Registered disposition for this cause. */
  readonly nextAction: NextActionClass;
}

export const HEALTH_REASON_DETAILS = {
  health_body_ok: {
    label: 'health response reports ok',
    impact: 'the line answered its health probe and reports itself healthy',
    availability: 'observed',
    nextAction: 'none',
  },
  health_body_unhealthy: {
    label: 'health response reports unhealthy',
    impact: 'the line answered and declared its own runtime unhealthy',
    availability: 'observed',
    nextAction: 'restart_line',
  },
  health_body_degraded: {
    label: 'health response reports degraded',
    impact: 'the line is serving but reports reduced capability',
    availability: 'observed',
    nextAction: 'investigate',
  },
  health_body_type_error: {
    label: 'health response failed type validation',
    impact: 'the payload arrived but could not be trusted, so line state is unproven',
    availability: 'unavailable',
    nextAction: 'investigate',
  },
  health_body_unrecognized: {
    label: 'health response shape not recognised',
    impact: 'the payload arrived in an unknown shape, so line state is unproven',
    availability: 'unavailable',
    nextAction: 'investigate',
  },
  health_body_incomplete: {
    label: 'health response missing required fields',
    impact: 'part of the payload was observed; the missing fields leave state partly unproven',
    availability: 'incomplete',
    nextAction: 'investigate',
  },
  whatsapp_auth_loss_with_disconnect_corroboration: {
    // Transport-neutral copy: the console renders every transport through one
    // vocabulary (hygiene.no-whatsapp-copy-in-generic-ui).
    label: 'transport session de-linked',
    impact: 'the auth bond is gone and a disconnect corroborates it; the line cannot send or receive',
    availability: 'observed',
    nextAction: 'relink_session',
  },
  whatsapp_backoff_zero_attempts_with_disconnect_without_auth_loss_signal: {
    label: 'reconnect stalled after a disconnect, no auth-loss signal',
    impact: 'the transport is backing off without retrying; the cause is not yet distinguishable from a de-link',
    availability: 'observed',
    nextAction: 'monitor',
  },
  whatsapp_backoff_zero_attempts_without_disconnect_corroboration: {
    label: 'reconnect stalled with no corroborating disconnect',
    impact: 'the transport is backing off without retrying and nothing corroborates a real disconnect',
    availability: 'observed',
    nextAction: 'monitor',
  },
  database_future_schema: {
    label: 'database schema is newer than this build',
    impact: 'the line runs inspection-only until the build matches the schema',
    availability: 'observed',
    nextAction: 'repair_database',
  },
  database_engine_recovery_required: {
    label: 'database engine needs recovery',
    impact: 'the line runs inspection-only until the database is recovered',
    availability: 'observed',
    nextAction: 'repair_database',
  },
  instance_degraded: {
    label: 'line reported degraded',
    impact: 'the line is degraded without a more specific registered cause',
    availability: 'observed',
    nextAction: 'investigate',
  },
  instance_logged_out: {
    label: 'line reported logged out',
    impact: 'the line has no usable session; it cannot send or receive',
    availability: 'observed',
    nextAction: 'relink_session',
  },
  self_health_callback: {
    label: 'self-reported healthy',
    impact: 'the fleet server observed its own in-process line as healthy',
    availability: 'observed',
    nextAction: 'none',
  },
  health_probe_auth_failed: {
    label: 'health probe rejected the credentials',
    impact: 'the probe could not read the line, so the reported state is unproven',
    availability: 'unavailable',
    nextAction: 'investigate',
  },
  health_probe_timeout_under_proxy_load: {
    label: 'health probe timed out under proxy load',
    impact: 'no observation was taken this cycle; any status shown is carried forward',
    availability: 'unavailable',
    nextAction: 'monitor',
  },
  health_poll_failed_transient: {
    label: 'health poll failed (transient)',
    impact: 'a single poll failed; the status shown is carried forward, not re-observed',
    availability: 'unavailable',
    nextAction: 'monitor',
  },
  health_poll_failed_threshold: {
    label: 'health poll failed past the failure threshold',
    impact: 'repeated polls failed; the line is treated as unreachable',
    availability: 'unavailable',
    nextAction: 'restart_line',
  },
} satisfies Record<HealthReasonCode, HealthReasonEntry>;

// ---------------------------------------------------------------------------
// Action proof requirements (explanatory metadata — see the header)
// ---------------------------------------------------------------------------

/**
 * What an action-capable disposition REQUIRES before anyone may act on it.
 *
 * Declaring the requirement is this module's job. Proving it holds right now,
 * and gating the control, is #2524's job. A surface must never read a populated
 * policy as permission.
 */
export interface ActionProofRequirement {
  /** The action needs a current observation, never a carried-forward one. */
  readonly requiresFreshObservation: boolean;
  /** The weakest confidence the action may be offered on. */
  readonly minimumConfidence: StatusConfidence;
  /** The authorization the operator must hold. */
  readonly authorization: string;
  /** The observation that proves the action worked. */
  readonly recoveryProof: string;
}

/** The dispositions that can ever drive a mutation. */
export const ACTION_CAPABLE_CLASSES = [
  'restart_line',
  'relink_session',
  'repair_database',
] as const;

export type ActionCapableClass = (typeof ACTION_CAPABLE_CLASSES)[number];

export const NEXT_ACTION_POLICIES = {
  none: null,
  monitor: null,
  investigate: null,
  restart_line: {
    requiresFreshObservation: true,
    minimumConfidence: 'confirmed',
    authorization: 'fleet:line:restart',
    recoveryProof: 'the line reports online on a later observed health poll',
  },
  relink_session: {
    requiresFreshObservation: true,
    minimumConfidence: 'confirmed',
    authorization: 'fleet:line:relink',
    recoveryProof: 'a new auth bond is observed for the line',
  },
  repair_database: {
    requiresFreshObservation: true,
    minimumConfidence: 'confirmed',
    authorization: 'fleet:host:database-repair',
    recoveryProof: 'the database opens read-write on the next start',
  },
} satisfies Record<NextActionClass, ActionProofRequirement | null>;

// ---------------------------------------------------------------------------
// Connection reason labels — the same registry law, one module (#2523 AC9)
// ---------------------------------------------------------------------------

/**
 * Transport disconnect reasons. These live here rather than in a per-component
 * map so connection and health labels cannot drift apart; an unregistered
 * connection reason keeps its raw code because the transport vocabulary is open
 * (Baileys emits vendor strings), whereas the health vocabulary is closed and
 * therefore fails closed.
 */
export const CONNECTION_REASON_LABELS: Readonly<Record<string, string>> = {
  unavailableService: 'channel unavailable',
  connectionClosed: 'connection closed',
  connectionLost: 'connection lost',
  connectionReplaced: 'replaced by another session',
  timedOut: 'timed out',
  loggedOut: 'logged out',
  Unknown: 'disconnected',
};

export function connectionReasonLabel(reason: string): string {
  return CONNECTION_REASON_LABELS[reason] ?? reason;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** Text shown when the producer supplied no reason at all. */
export const UNKNOWN_REASON_LABEL = 'unknown';
/** Text shown when the producer supplied a reason this build does not register. */
export const UNSUPPORTED_REASON_LABEL = 'unsupported reason code';

const AVAILABILITY_LABELS: Readonly<Record<ObservationAvailability, string | null>> = {
  observed: null,
  incomplete: 'observation incomplete',
  unavailable: 'observation unavailable',
};

/** Text marking data that is retained from an earlier observation. */
export const STALE_OBSERVATION_LABEL = 'stale observation';

/**
 * The inputs a surface may hand this module.
 *
 * Deliberately NOT accepted: `error` and `evidence`. Raw producer text has no
 * path into the projection, so it cannot reach a label, a tooltip, an
 * accessible name, or the clipboard.
 */
export interface HealthObservation {
  /** Line status (`online` | `degraded` | `unreachable` | `logged_out` | ...). */
  readonly status?: string | null;
  /** The producer's bounded reason code, when it supplied one. */
  readonly reason?: string | null;
  /** The producer's confidence in the classification. */
  readonly confidence?: StatusConfidence | null;
  /**
   * Whether the visible data is retained rather than freshly observed. Only
   * surfaces carrying a server-stamped freshness contract
   * (`LineInstance.stale`) can supply this; the feed's health detail has no
   * freshness field, so it is absent there.
   */
  readonly stale?: boolean | null;
}

export interface HealthPresentation {
  /** The registered code, or null when absent or unregistered. */
  readonly code: HealthReasonCode | null;
  /** The safe human label. */
  readonly label: string;
  /** False when the producer supplied a reason this build does not register. */
  readonly supported: boolean;
  readonly confidence: StatusConfidence | null;
  readonly availability: ObservationAvailability;
  readonly impact: string | null;
  readonly nextAction: NextActionClass;
  readonly stale: boolean;
  /** The action proof this disposition requires, or null when not action-capable. */
  readonly actionProof: ActionProofRequirement | null;
  /** Ordered, already-safe classification chips. */
  readonly chips: readonly string[];
  /** The one-line classification: the card context AND the clipboard tail. */
  readonly summary: string | undefined;
  /** The status headline shared by the card and the clipboard. */
  readonly headline: string;
  /** The full safe projection: what the card presents and the clipboard copies. */
  readonly clipboardText: string;
}

function isRegistered(reason: string): reason is HealthReasonCode {
  return Object.prototype.hasOwnProperty.call(HEALTH_REASON_DETAILS, reason);
}

/**
 * The status headline. `online` reads as a transition because health events are
 * emitted on change; every other status uses the canonical severity message.
 */
export function healthHeadline(status?: string | null): string {
  return status === 'online' ? 'came online' : statusAlertMessage(status);
}

/**
 * True when the headline is the generic severity bucket rather than a specific
 * classification. Such a headline carries no cause, so the reason slot is always
 * rendered — as `unknown` when the producer genuinely supplied nothing.
 */
function headlineIsGenericBucket(status?: string | null): boolean {
  return statusAlertMessage(status) === 'degraded';
}

export function healthPresentation(observation: HealthObservation): HealthPresentation {
  const rawReason = typeof observation.reason === 'string' ? observation.reason.trim() : '';
  const code = rawReason !== '' && isRegistered(rawReason) ? rawReason : null;
  const supported = rawReason === '' || code !== null;
  const entry = code !== null ? HEALTH_REASON_DETAILS[code] : null;

  const label = entry !== null
    ? entry.label
    : supported
      ? UNKNOWN_REASON_LABEL
      : UNSUPPORTED_REASON_LABEL;

  const confidence = observation.confidence ?? null;
  // A reason we cannot resolve is an unproven observation, not a clean one.
  const availability: ObservationAvailability = entry !== null
    ? entry.availability
    : supported
      ? 'observed'
      : 'unavailable';
  const nextAction: NextActionClass = entry !== null ? entry.nextAction : 'investigate';
  const stale = observation.stale === true;

  const chips: string[] = [];
  if (entry !== null && code !== null) {
    chips.push(`${label} (${code})`);
  } else if (!supported) {
    chips.push(label);
  }
  if (confidence !== null) chips.push(`confidence ${confidence}`);
  const availabilityLabel = AVAILABILITY_LABELS[availability];
  if (availabilityLabel !== null) chips.push(availabilityLabel);
  if (stale) chips.push(STALE_OBSERVATION_LABEL);
  if (chips.length === 0 && headlineIsGenericBucket(observation.status)) {
    chips.push(UNKNOWN_REASON_LABEL);
  }

  const summary = chips.length > 0 ? chips.join(' · ') : undefined;
  const headline = healthHeadline(observation.status);

  return {
    code,
    label,
    supported,
    confidence,
    availability,
    impact: entry !== null ? entry.impact : null,
    nextAction,
    stale,
    actionProof: NEXT_ACTION_POLICIES[nextAction],
    chips,
    summary,
    headline,
    clipboardText: summary !== undefined ? `${headline} \u2014 ${summary}` : headline,
  };
}

/**
 * Compact one-line label for space-constrained surfaces (the deployments card's
 * issue list). Shortens the label by dropping the code, and keeps the
 * availability and freshness verdicts, which are the parts an operator cannot
 * re-derive from severity.
 */
export function healthPresentationShortText(presentation: HealthPresentation): string {
  // With no reason at all there is no label to shorten, so the severity
  // headline stands in — a human message, never the raw state code.
  const lead = presentation.code !== null || !presentation.supported
    ? presentation.label
    : presentation.headline;
  const parts: string[] = [lead];
  const availabilityLabel = AVAILABILITY_LABELS[presentation.availability];
  if (availabilityLabel !== null) parts.push(availabilityLabel);
  if (presentation.stale) parts.push(STALE_OBSERVATION_LABEL);
  return parts.join(' · ');
}
