// src/core/inbound-observation.ts
// Observed local non-admission of inbound messages.
//
// A transport or ingest exit that ends an inbound message's local path without
// storing or dispatching it is counted here under a closed reason label. A
// count is an observed attempt in this process, not a unique lost message and
// not a claim about delivery upstream. Transport observations happen before
// storage, so a redelivered message can be counted again; a delivery the
// database recognises as a duplicate is never counted. Recording never changes
// admission, dispatch or recovery; a logger or alert failure is counted and
// swallowed, and neither can prevent the other.
//
// Two reasons are certain local non-retention or non-dispatch and raise a
// warning alert under a fixed source each, so the reason survives alert
// confinement. An accepted emission starts a per-reason window; a failed or
// thrown emission does not, so the next observation retries (the #2434
// pattern in emit-alert.ts). The rest are advisory. Queue displacement keeps
// its own count and alert in ingest.ts and is not recorded here.

import { createChildLogger } from '../logger.ts';
import { MS_PER_MINUTE } from '../lib/time-units.ts';
import { emitAlert, type AlertEmissionStatus } from '../lib/emit-alert.ts';
import { systemClock } from '../lib/clock.ts';

const log = createChildLogger('inbound-observation');

export const INBOUND_OBSERVATION_REASONS = [
  'transport.no_consumer',
  'transport.stale_socket',
  'transport.unsupported_upsert_type',
  'transport.parser_refused',
  'ingest.store_failed',
  'ingest.stored_not_admitted',
] as const;

export type InboundObservationReason = typeof INBOUND_OBSERVATION_REASONS[number];

type AlertingReason = 'transport.no_consumer' | 'ingest.store_failed';

const ALERT_SUMMARIES: Record<AlertingReason, string> = {
  'transport.no_consumer': 'inbound message reached no ingest consumer',
  'ingest.store_failed': 'inbound message could not be stored',
};

export const INBOUND_OBSERVATION_ALERT_WINDOW_MS = 15 * MS_PER_MINUTE;

type AlertOutcome = AlertEmissionStatus | 'rate_limited';

export interface InboundObservationHealth {
  /** Observed attempts per reason since process start. */
  counts: Record<InboundObservationReason, number>;
  /**
   * Alert attempts for the alerting reasons: each emitAlert status as returned,
   * plus `rate_limited` for observations inside an accepted emission's window.
   * A thrown emission is not here; it is a recorder failure.
   */
  alerts: Record<AlertOutcome, number>;
  /** Alert or log steps that threw; the observation count still moved. */
  recorder_failures: number;
}

function zeroCounts(): Record<InboundObservationReason, number> {
  return Object.fromEntries(INBOUND_OBSERVATION_REASONS.map((reason) => [reason, 0])) as Record<InboundObservationReason, number>;
}

function zeroAlerts(): Record<AlertOutcome, number> {
  return { durably_queued: 0, captured: 0, legacy_accepted_unconfirmed: 0, failed: 0, rate_limited: 0 };
}

let counts = zeroCounts();
let alerts = zeroAlerts();
let recorderFailures = 0;
const nextAlertAt = new Map<AlertingReason, number>();

function isAlerting(reason: InboundObservationReason): reason is AlertingReason {
  return reason === 'transport.no_consumer' || reason === 'ingest.store_failed';
}

interface LocalLossAlertResult {
  accepted: boolean;
  status: AlertEmissionStatus;
}

// One literal source per call site, so the source survives confinement and the
// fault-taxonomy coverage guard resolves it statically.
function emitNoConsumerAlert(instance: string): LocalLossAlertResult {
  const result = emitAlert(instance, 'inbound_no_consumer', ALERT_SUMMARIES['transport.no_consumer'], '', 'warning');
  return { accepted: result.status === 'durably_queued', status: result.status };
}

function emitStoreFailedAlert(instance: string): LocalLossAlertResult {
  const result = emitAlert(instance, 'inbound_store_failed', ALERT_SUMMARIES['ingest.store_failed'], '', 'warning');
  return { accepted: result.status === 'durably_queued', status: result.status };
}

function emitLocalLossAlert(instance: string, reason: AlertingReason): { accepted: boolean; status: AlertOutcome } {
  // Check the window without recording it; only an accepted emission records.
  if (systemClock.now() < (nextAlertAt.get(reason) ?? 0)) return { accepted: false, status: 'rate_limited' };
  const result = reason === 'transport.no_consumer' ? emitNoConsumerAlert(instance) : emitStoreFailedAlert(instance);
  if (result.status !== 'failed') nextAlertAt.set(reason, systemClock.now() + INBOUND_OBSERVATION_ALERT_WINDOW_MS);
  return result;
}

/**
 * Record `attempts` observations of `reason` for the named instance (the alert
 * instance label). Never throws. Carries only the closed label and a count: no
 * message content, identifiers or error detail.
 */
export function observeInbound(instance: string, reason: InboundObservationReason, attempts = 1): void {
  if (!Number.isInteger(attempts) || attempts <= 0) return;
  counts[reason] += attempts;
  let alertAccepted = false;
  let alertStatus: AlertOutcome | 'threw' | undefined;
  if (isAlerting(reason)) {
    try {
      const alert = emitLocalLossAlert(instance, reason);
      alerts[alert.status] += 1;
      alertAccepted = alert.accepted;
      alertStatus = alert.status;
    } catch {
      recorderFailures += 1;
      alertStatus = 'threw';
    }
  }
  try {
    if (alertStatus !== undefined) {
      log.warn({ reason, attempts, alertAccepted, alertStatus }, 'inbound message not admitted locally');
    } else if (reason === 'ingest.stored_not_admitted') {
      log.warn({ reason, attempts }, 'stored inbound message not admitted');
    } else {
      log.debug({ reason, attempts }, 'inbound message not forwarded (advisory)');
    }
  } catch {
    recorderFailures += 1;
  }
}

/** Advisory projection for /health. Never feeds status or degradation causes. */
export function getInboundObservationHealth(): InboundObservationHealth {
  return { counts: { ...counts }, alerts: { ...alerts }, recorder_failures: recorderFailures };
}

/** Test seam: reset counters and the alert window. */
export function resetInboundObservations(): void {
  counts = zeroCounts();
  alerts = zeroAlerts();
  recorderFailures = 0;
  nextAlertAt.clear();
}
