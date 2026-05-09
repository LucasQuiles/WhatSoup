import { detectHeartbeatSilence } from './heartbeat.ts';
import { detectTransportBroken } from './transport-health.ts';
import type { EventStore } from '../store/events.ts';
import { runChannelChain } from '../transport/chain.ts';
import type { DeliveryResult, Sink } from '../transport/types.ts';
import type { EventInput } from '../store/events.ts';

export interface WatchdogRunInput {
  events: EventStore;
  metaAlertSinks: Sink[];
  thresholdHours: number;
  nowIso: string;
}

export interface WatchdogRunResult {
  alerts: number;
  deliverySucceededCount: number;
  deliveryFailedCount: number;
}

const HOUR_MS = 60 * 60 * 1000;

export async function runWatchdog(input: WatchdogRunInput): Promise<WatchdogRunResult> {
  const nowMs = Date.parse(input.nowIso);
  if (!Number.isFinite(nowMs)) throw new Error('watchdog nowIso must be an ISO timestamp');
  const sinceIso = new Date(nowMs - input.thresholdHours * HOUR_MS).toISOString();
  const heartbeat = input.events.latestByKind('heartbeat');
  const heartbeatResult = detectHeartbeatSilence({
    now: nowMs,
    lastHeartbeatTs: heartbeat ? Date.parse(heartbeat.ts) : undefined,
    thresholdHours: input.thresholdHours,
  });
  const transportResult = detectTransportBroken({
    engineAlive: heartbeat !== undefined,
    deliveriesSucceeded: input.events.countByKindSince('alert_delivery_succeeded', sinceIso),
    deliveriesFailed: input.events.countByKindSince('alert_delivery_failed', sinceIso)
      + input.events.countByKindSince('alert_delivery_failed_all', sinceIso),
    driftEvents: input.events.countByKindSince('drift', sinceIso),
  });

  const result: WatchdogRunResult = {
    alerts: 0,
    deliverySucceededCount: 0,
    deliveryFailedCount: 0,
  };

  if (heartbeatResult.silent) {
    const detail = heartbeatResult.reason ?? 'silence threshold exceeded';
    const delivery = await dispatchMetaAlert(input, 'watchdog.heartbeat_silent', `heartbeat silent: ${detail}`);
    addDelivery(result, delivery);
  }

  if (transportResult.broken) {
    const detail = transportResult.reason ?? 'delivery failure threshold exceeded';
    const delivery = await dispatchMetaAlert(input, 'watchdog.transport_broken', `transport broken: ${detail}`);
    addDelivery(result, delivery);
  }

  return result;
}

interface MetaAlertDelivery {
  attempted: boolean;
  succeeded: number;
  failed: number;
}

async function dispatchMetaAlert(input: WatchdogRunInput, probeId: string, message: string): Promise<MetaAlertDelivery> {
  if (input.metaAlertSinks.length === 0) {
    input.events.append({
      ts: input.nowIso,
      kind: 'alert_delivery_failed_all',
      domain: 'alerting',
      severity: 'crit',
      scope_id: 'watchdog',
      probe_id: probeId,
      alerted_to: 'none',
      payload: {
        source_event_id: null,
        deliveries: [],
        action_result: 'meta_alert',
        reason: message,
        failure: 'no_meta_alert_sinks',
      },
    });
    return { attempted: true, succeeded: 0, failed: 1 };
  }

  const chain = await runChannelChain(input.metaAlertSinks, {
    body: `[crit] ${message}`,
  });
  let succeeded = 0;
  let failed = 0;

  for (const delivery of chain.deliveries) {
    input.events.append(deliveryEvent(input.nowIso, probeId, message, delivery));
    if (delivery.ok) succeeded += 1;
    else failed += 1;
  }

  if (chain.failedAll) {
    input.events.append({
      ts: input.nowIso,
      kind: 'alert_delivery_failed_all',
      domain: 'alerting',
      severity: 'crit',
      scope_id: 'watchdog',
      probe_id: probeId,
      alerted_to: 'none',
      payload: {
        source_event_id: null,
        deliveries: chain.deliveries,
        action_result: 'meta_alert',
        reason: message,
      },
    });
    failed += 1;
  }

  return { attempted: true, succeeded, failed };
}

function addDelivery(result: WatchdogRunResult, delivery: MetaAlertDelivery): void {
  if (delivery.attempted) result.alerts += 1;
  result.deliverySucceededCount += delivery.succeeded;
  result.deliveryFailedCount += delivery.failed;
}

function deliveryEvent(ts: string, probeId: string, message: string, delivery: DeliveryResult): EventInput {
  return {
    ts,
    kind: delivery.ok ? 'alert_delivery_succeeded' : 'alert_delivery_failed',
    domain: 'alerting',
    severity: 'crit',
    scope_id: 'watchdog',
    probe_id: probeId,
    alerted_to: alertedTo(delivery.channel),
    payload: {
      source_event_id: null,
      channel: delivery.channel,
      ok: delivery.ok,
      error: delivery.error ?? null,
      action_result: 'meta_alert',
      reason: message,
    },
  };
}

function alertedTo(channel: string): EventInput['alerted_to'] {
  if (channel === 'whatsoup') return 'whatsoup';
  if (channel === 'local-notify' || channel === 'local_notification') return 'local_notification';
  if (channel === 'local-log' || channel === 'local_log') return 'local_log';
  return 'external_push';
}
