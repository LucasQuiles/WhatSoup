import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.ts';
import type { Collector } from './collector/types.ts';
import { dedupSuppresses, type PreviousAlert } from './engine/dedup.ts';
import { changeRule } from './evaluator/change-rules.ts';
import type { Evaluator } from './evaluator/types.ts';
import { runOneProbe } from './engine/lifecycle.ts';
import { stormGuardSuppresses, type StormGuardLast } from './engine/storm-guard.ts';
import type { DeploymentRole } from './policy/schema.ts';
import { actionKeyForEvent, type RuntimePolicyConfig } from './policy/runtime.ts';
import type { BaselineStore } from './store/baseline.ts';
import type { AppendResult, EventInput, EventStore } from './store/events.ts';
import type { MuteStore } from './store/mutes.ts';
import type { RuntimeStateStore } from './store/state.ts';
import { checkSelfSecrets, type SelfSecretCheck } from './self/secret-hygiene.ts';
import { checkTokenAge } from './self/token-age.ts';
import type { Domain, Event, Severity } from './types.ts';
import { runChannelChain } from './transport/chain.ts';
import { resolveProposeFixFollowUp } from './transport/fix-commands.ts';
import { formatAlert } from './transport/format.ts';
import type { DeliveryResult, Sink } from './transport/types.ts';

export interface RunCycleArgs {
  collectors: Collector[];
  scopes: string[];
  baselines: BaselineStore;
  events: EventStore;
  mutes: MuteStore;
  runtimeState?: RuntimeStateStore;
  evaluatorFor: (collectorId: string) => Evaluator;
  changeProbeIds?: readonly string[];
  changeSeverity?: Severity;
  deploymentRoles?: Record<string, DeploymentRole> | undefined;
  runtimeConfig?: RuntimePolicyConfig;
  now: () => Date;
  sinks?: Sink[];
  metaAlertSinks?: Sink[];
  selfSecrets?: readonly SelfSecretCheck[];
  tokenAgeChecks?: readonly TokenAgeCheck[];
  appendHeartbeat?: boolean;
}

export interface RunCycleResult {
  driftCount: number;
  probeErrorCount: number;
  totalEventCount: number;
  deliverySucceededCount: number;
  deliveryFailedCount: number;
  dedupSuppressedCount: number;
  stormSuppressedCount: number;
  baselineIntegrityFailCount: number;
  selfSecretWidenedCount: number;
  tokenAgingCount: number;
  heartbeatCount: number;
}

export interface TokenAgeCheck {
  path: string;
  maxAgeDays: number;
}

export async function runCycle(args: RunCycleArgs): Promise<RunCycleResult> {
  let driftCount = 0;
  let probeErrorCount = 0;
  let totalEventCount = 0;
  let deliverySucceededCount = 0;
  let deliveryFailedCount = 0;
  let dedupSuppressedCount = 0;
  let stormSuppressedCount = 0;
  let baselineIntegrityFailCount = 0;
  let selfSecretWidenedCount = 0;
  let tokenAgingCount = 0;
  let heartbeatCount = 0;

  const muteExpiry = await recordMuteExpirations(args);
  totalEventCount += muteExpiry.totalEventCount;
  deliverySucceededCount += muteExpiry.deliverySucceededCount;
  deliveryFailedCount += muteExpiry.deliveryFailedCount;

  const selfProtection = runSelfProtectionChecks(args);
  selfSecretWidenedCount += selfProtection.selfSecretWidenedCount;
  tokenAgingCount += selfProtection.tokenAgingCount;
  totalEventCount += selfProtection.ledgered;
  for (const alert of selfProtection.alertableEvents) {
    const event = alert.event;
    if (!isAlertableEvent(event)) continue;
    const action = actionForEvent(args, event);
    if (action === 'observe') continue;
    assertSupportedPolicyAction(action);
    const delivery = await deliverAlert(args, event, action, sinksForAction(args, action), { source: alert.source });
    deliverySucceededCount += delivery.succeeded;
    deliveryFailedCount += delivery.failed;
    totalEventCount += delivery.ledgered;
  }
  if (selfSecretWidenedCount > 0) {
    totalEventCount += appendCycleRefused(args, selfSecretWidenedCount);
    return {
      driftCount,
      probeErrorCount,
      totalEventCount,
      deliverySucceededCount,
      deliveryFailedCount,
      dedupSuppressedCount,
      stormSuppressedCount,
      baselineIntegrityFailCount,
      selfSecretWidenedCount,
      tokenAgingCount,
      heartbeatCount,
    };
  }

  for (const collector of args.collectors) {
    for (const scopeId of args.scopes) {
      const result = await runOneProbe({
        collector,
        scopeId,
        baselines: args.baselines,
        events: args.events,
        mutes: args.mutes,
        evaluator: evaluatorForCollector(args, collector.id),
        deploymentRoles: args.deploymentRoles,
        ...(args.runtimeConfig ? { additionalForbiddenMuteDomains: args.runtimeConfig.forbiddenMuteDomains } : {}),
        now: args.now,
      });

      for (const event of result.events) {
        totalEventCount += 1;
        if (event.kind === 'drift') driftCount += 1;
        if (event.kind === 'probe_error') probeErrorCount += 1;
        if (event.kind === 'baseline_integrity_fail') baselineIntegrityFailCount += 1;
        if (isAlertableEvent(event)) {
          const action = actionForEvent(args, event);
          if (action === 'observe') continue;
          assertSupportedPolicyAction(action);
          const sinks = sinksForAction(args, action);
          if (sinks.length === 0) continue;
          if (event.kind !== 'drift') {
            const delivery = await deliverAlert(args, event, action, sinks);
            deliverySucceededCount += delivery.succeeded;
            deliveryFailedCount += delivery.failed;
            totalEventCount += delivery.ledgered;
            continue;
          }
          const suppression = suppressDrift(args, event);
          if (suppression.suppressed) {
            totalEventCount += appendSuppressionEvent(args, event, suppression);
            if (suppression.kind === 'dedup') dedupSuppressedCount += 1;
            if (suppression.kind === 'storm_guard') stormSuppressedCount += 1;
            continue;
          }
          const delivery = await deliverAlert(args, event, action, sinks);
          deliverySucceededCount += delivery.succeeded;
          deliveryFailedCount += delivery.failed;
          totalEventCount += delivery.ledgered;
        }
      }
    }
  }

  if (args.appendHeartbeat ?? true) {
    args.events.append({
      ts: args.now().toISOString(),
      kind: 'heartbeat',
      domain: 'alerting',
      severity: 'info',
      payload: {
        status: 'cycle_complete',
        drift_count: driftCount,
        probe_error_count: probeErrorCount,
        delivery_succeeded_count: deliverySucceededCount,
        delivery_failed_count: deliveryFailedCount,
        dedup_suppressed_count: dedupSuppressedCount,
        storm_suppressed_count: stormSuppressedCount,
        baseline_integrity_fail_count: baselineIntegrityFailCount,
        self_secret_widened_count: selfSecretWidenedCount,
        token_aging_count: tokenAgingCount,
      },
      alerted_to: 'none',
    });
    heartbeatCount += 1;
    totalEventCount += 1;
  }

  return {
    driftCount,
    probeErrorCount,
    totalEventCount,
    deliverySucceededCount,
    deliveryFailedCount,
    dedupSuppressedCount,
    stormSuppressedCount,
    baselineIntegrityFailCount,
    selfSecretWidenedCount,
    tokenAgingCount,
    heartbeatCount,
  };
}

function evaluatorForCollector(args: RunCycleArgs, collectorId: string): Evaluator {
  const base = args.evaluatorFor(collectorId);
  const evaluator: Evaluator = !args.changeProbeIds?.includes(collectorId)
    ? base
    : (ctx) => [
      ...base(ctx),
      ...changeRule({
        observed: ctx.observed,
        baseline: ctx.baseline,
        severity: args.changeSeverity ?? args.runtimeConfig?.domainSeverities.change ?? 'high',
      }),
    ];

  return (ctx) => evaluator(ctx).filter((event) => event.domain === undefined || isDomainEnabled(args, event.domain));
}

interface MuteExpiryAccounting {
  totalEventCount: number;
  deliverySucceededCount: number;
  deliveryFailedCount: number;
}

async function recordMuteExpirations(args: RunCycleArgs): Promise<MuteExpiryAccounting> {
  if (!args.runtimeState) return { totalEventCount: 0, deliverySucceededCount: 0, deliveryFailedCount: 0 };
  const nowIso = args.now().toISOString();
  const prevIso = args.runtimeState.get('prev_cycle_iso') ?? nowIso;
  const expired = args.mutes.recordExpirations(prevIso, nowIso, args.events);
  args.runtimeState.set('prev_cycle_iso', nowIso);

  let totalEventCount = expired.length;
  let deliverySucceededCount = 0;
  let deliveryFailedCount = 0;

  for (const mute of expired) {
    const persisted = findPersistedMuteExpire(args.events, mute.id);
    if (!persisted || !isAlertableEvent(persisted)) continue;
    const action = actionForEvent(args, persisted);
    if (action === 'observe') continue;
    assertSupportedPolicyAction(action);
    const correlationId = correlationForExpiredMute(args.events, mute.id) ?? persisted.correlation_id;
    const delivery = await deliverAlert(args, persisted, action, sinksForAction(args, action), {
      source: { id: persisted.id, ...(correlationId !== undefined ? { correlation_id: correlationId } : {}) },
    });
    deliverySucceededCount += delivery.succeeded;
    deliveryFailedCount += delivery.failed;
    totalEventCount += delivery.ledgered;
  }

  return { totalEventCount, deliverySucceededCount, deliveryFailedCount };
}

/**
 * The mute that just expired may have been actively suppressing a drift, ledgered as
 * `drift_muted` with `payload.mute_id` set to this mute's id (engine/lifecycle.ts `applyMute`).
 * When one exists, the expiry alert inherits its correlation id so operators see the expiry
 * grouped with the condition it was silencing rather than as an unrelated one-off notice.
 */
function correlationForExpiredMute(events: EventStore, muteId: number): string | undefined {
  return events.queryByKind('drift_muted')
    .filter((event) => readMuteId(event.payload) === muteId)
    .at(-1)?.correlation_id;
}

function findPersistedMuteExpire(events: EventStore, muteId: number): Event | undefined {
  return events.queryByKind('mute_expire')
    .filter((event) => readMuteId(event.payload) === muteId)
    .at(-1);
}

function readMuteId(payload: Record<string, unknown>): number | undefined {
  return typeof payload.mute_id === 'number' ? payload.mute_id : undefined;
}

interface DeliveryAccounting {
  succeeded: number;
  failed: number;
  ledgered: number;
}

interface PersistedAlertSource {
  id: number;
  correlation_id?: string;
}

interface AlertDispatch {
  event: EventInput;
  source: AppendResult;
}

interface SelfProtectionAccounting {
  selfSecretWidenedCount: number;
  tokenAgingCount: number;
  ledgered: number;
  alertableEvents: AlertDispatch[];
}

function runSelfProtectionChecks(args: RunCycleArgs): SelfProtectionAccounting {
  let selfSecretWidenedCount = 0;
  let tokenAgingCount = 0;
  let ledgered = 0;
  const alertableEvents: AlertDispatch[] = [];
  const ts = args.now().toISOString();

  for (const issue of checkSelfSecrets([...(args.selfSecrets ?? [])]).widened) {
    const event: EventInput = {
      ts,
      kind: 'self_secret_widened',
      domain: 'credential',
      severity: 'crit',
      scope_id: 'guard',
      probe_id: 'self_secret_widened',
      payload: {
        path: issue.path,
        expected_mode: issue.expectedMode,
        actual_mode: issue.actualMode,
      },
      alerted_to: 'none',
    };
    const source = args.events.append(event);
    alertableEvents.push({ event, source });
    selfSecretWidenedCount += 1;
    ledgered += 1;
  }

  if (isDomainEnabled(args, 'credential')) {
    for (const check of args.tokenAgeChecks ?? []) {
      const result = checkTokenAge(check.path, check.maxAgeDays, args.now().getTime());
      if (!result.aging) continue;
      const event: EventInput = {
        ts,
        kind: 'alert_token_aging',
        domain: 'credential',
        severity: 'high',
        payload: {
          path: check.path,
          max_age_days: check.maxAgeDays,
          age_days: Number.isFinite(result.ageDays) ? result.ageDays : null,
          reason: result.reason ?? null,
        },
        alerted_to: 'none',
      };
      const source = args.events.append(event);
      alertableEvents.push({ event, source });
      tokenAgingCount += 1;
      ledgered += 1;
    }
  }

  return { selfSecretWidenedCount, tokenAgingCount, ledgered, alertableEvents };
}

function isDomainEnabled(args: RunCycleArgs, domain: Domain): boolean {
  if (domain === 'alerting') return true;
  return args.runtimeConfig?.enabledDomains[domain] ?? true;
}

function appendCycleRefused(args: RunCycleArgs, selfSecretWidenedCount: number): number {
  args.events.append({
    ts: args.now().toISOString(),
    kind: 'cycle_refused',
    domain: 'alerting',
    severity: 'crit',
    payload: {
      reason: 'self_secret_widened',
      count: selfSecretWidenedCount,
    },
    alerted_to: 'none',
  });
  return 1;
}

interface SuppressionDecision {
  suppressed: boolean;
  kind?: 'dedup' | 'storm_guard';
  reason?: string | undefined;
}

function suppressDrift(args: RunCycleArgs, event: EventInput): SuppressionDecision {
  if (!isAlertableDrift(event)) return { suppressed: false };

  const now = args.now().getTime();
  const previousAlert = latestPreviousAlert(args.events, event);
  const dedup = dedupSuppresses({
    now,
    severity: event.severity,
    fingerprint: event.fingerprint,
    previousAlert,
  });
  if (dedup.suppress) {
    return { suppressed: true, kind: 'dedup', reason: dedup.reason };
  }

  if (event.severity !== 'crit') {
    return { suppressed: false };
  }

  const storm = stormGuardSuppresses({
    now,
    lastAlert: latestStormGuardAlert(args.events, event),
    payloadHash: event.fingerprint,
    actionResult: readActionLabel(event),
  });
  if (storm.suppress) {
    return { suppressed: true, kind: 'storm_guard', reason: storm.reason };
  }

  return { suppressed: false };
}

function appendSuppressionEvent(args: RunCycleArgs, event: EventInput, suppression: SuppressionDecision): number {
  if (!isAlertableDrift(event) || !suppression.kind) return 0;
  const persisted = findPersistedDrift(args.events, event);
  args.events.append({
    ts: args.now().toISOString(),
    kind: 'drift_dedup',
    domain: event.domain,
    severity: event.severity,
    scope_id: event.scope_id,
    probe_id: event.probe_id,
    fingerprint: event.fingerprint,
    correlation_id: persisted?.correlation_id ?? event.correlation_id,
    alerted_to: 'none',
    payload: {
      source_event_id: persisted?.id ?? null,
      suppression: suppression.kind,
      reason: suppression.reason ?? null,
    },
  });
  return 1;
}

async function deliverAlert(
  args: RunCycleArgs,
  event: EventInput,
  actionLabel: string,
  sinks: Sink[],
  options: { source?: PersistedAlertSource; routeFailedAll?: boolean } = {},
): Promise<DeliveryAccounting> {
  if (sinks.length === 0 || !isAlertableEvent(event)) {
    return { succeeded: 0, failed: 0, ledgered: 0 };
  }

  const persisted = options.source ?? findPersistedAlertSource(args.events, event);
  const scopeId = alertScopeId(event);
  const probeId = alertProbeId(event);
  const fingerprint = alertFingerprint(event);
  const followUp = actionLabel === 'propose_fix'
    ? resolveProposeFixFollowUp(actionKeyForEvent(event), event.payload)
    : undefined;
  const chain = await runChannelChain(sinks, {
    body: formatAlert({
      eventId: persisted?.id ?? 0,
      severity: event.severity,
      scopeId,
      probeId,
      domain: event.domain,
      ts: event.ts,
      diff: readDiff(event),
      actionLabel,
      ...(followUp?.fixCommand !== undefined ? { fixCommand: followUp.fixCommand } : {}),
      ...(followUp?.remediationHint !== undefined ? { remediationHint: followUp.remediationHint } : {}),
      fingerprint,
    }),
    severity: event.severity,
  });

  let ledgered = 0;
  let succeeded = 0;
  let failed = 0;
  const correlationId = persisted?.correlation_id ?? event.correlation_id;

  for (const delivery of chain.deliveries) {
    args.events.append(deliveryEvent(event, delivery, correlationId, persisted?.id, actionLabel));
    ledgered += 1;
    if (delivery.ok) succeeded += 1;
    else failed += 1;
  }

  if (chain.failedAll && (options.routeFailedAll ?? true)) {
    const failedAllEvent: EventInput = {
      ts: args.now().toISOString(),
      kind: 'alert_delivery_failed_all',
      domain: 'alerting',
      severity: event.severity,
      scope_id: scopeId,
      probe_id: probeId,
      fingerprint,
      correlation_id: correlationId,
      alerted_to: 'none',
      payload: {
        source_event_id: persisted?.id ?? null,
        deliveries: chain.deliveries,
      },
    };
    const failedAllSource = args.events.append(failedAllEvent);
    ledgered += 1;
    failed += 1;
    if (options.routeFailedAll ?? true) {
      const transportDelivery = await routeTransportFailureAlert(args, failedAllEvent, failedAllSource);
      succeeded += transportDelivery.succeeded;
      failed += transportDelivery.failed;
      ledgered += transportDelivery.ledgered;
    }
  }

  return { succeeded, failed, ledgered };
}

async function routeTransportFailureAlert(
  args: RunCycleArgs,
  event: EventInput,
  source: AppendResult,
): Promise<DeliveryAccounting> {
  if (!isAlertableEvent(event)) return { succeeded: 0, failed: 0, ledgered: 0 };
  const actionKey = actionKeyForEvent(event);
  const action = actionKey ? args.runtimeConfig?.actions[actionKey] : undefined;
  if (!action) return { succeeded: 0, failed: 0, ledgered: 0 };
  if (action === 'observe') return { succeeded: 0, failed: 0, ledgered: 0 };
  assertSupportedPolicyAction(action);
  const sinks = sinksForAction(args, action);
  if (sinks.length === 0) return { succeeded: 0, failed: 0, ledgered: 0 };
  return deliverAlert(args, event, action, sinks, { source, routeFailedAll: false });
}

function deliveryEvent(
  event: AlertableEvent,
  delivery: DeliveryResult,
  correlationId: string | undefined,
  sourceEventId: number | undefined,
  actionLabel: string,
): EventInput {
  return {
    ts: event.ts,
    kind: delivery.ok ? 'alert_delivery_succeeded' : 'alert_delivery_failed',
    domain: 'alerting',
    severity: event.severity,
    scope_id: alertScopeId(event),
    probe_id: alertProbeId(event),
    fingerprint: alertFingerprint(event),
    correlation_id: correlationId,
    alerted_to: alertedTo(delivery.channel),
    payload: {
      source_event_id: sourceEventId ?? null,
      channel: delivery.channel,
      ok: delivery.ok,
      error: delivery.error ?? null,
      payload_hash: alertFingerprint(event),
      action_result: actionLabel,
    },
  };
}

interface AlertableEvent extends EventInput {
  kind: 'drift' | 'self_secret_widened' | 'baseline_integrity_fail' | 'alert_token_aging' | 'alert_delivery_failed_all' | 'mute_expire';
  domain: Domain;
  severity: Severity;
}

interface AlertableDriftEvent extends AlertableEvent {
  kind: 'drift';
  scope_id: string;
  probe_id: string;
  fingerprint: string;
}

function isAlertableEvent(event: EventInput): event is AlertableEvent {
  return (event.kind === 'drift'
      || event.kind === 'self_secret_widened'
      || event.kind === 'baseline_integrity_fail'
      || event.kind === 'alert_token_aging'
      || event.kind === 'alert_delivery_failed_all'
      || event.kind === 'mute_expire')
    && event.domain !== undefined
    && event.severity !== undefined;
}

function isAlertableDrift(event: EventInput): event is AlertableDriftEvent {
  return event.kind === 'drift'
    && event.domain !== undefined
    && event.severity !== undefined
    && event.scope_id !== undefined
    && event.probe_id !== undefined
    && event.fingerprint !== undefined;
}

function findPersistedAlertSource(events: EventStore, event: AlertableEvent): Event | undefined {
  if (isAlertableDrift(event)) return findPersistedDrift(events, event);
  return events.queryByKind(event.kind).at(-1);
}

function findPersistedDrift(events: EventStore, event: AlertableDriftEvent): Event | undefined {
  return events
    .queryByFingerprintSince(event.fingerprint, event.ts)
    .filter((candidate) => candidate.kind === 'drift'
      && candidate.scope_id === event.scope_id
      && candidate.probe_id === event.probe_id)
    .at(-1);
}

function latestPreviousAlert(events: EventStore, event: AlertableDriftEvent): PreviousAlert | undefined {
  return events
    .queryByFingerprintSince(event.fingerprint, '1970-01-01T00:00:00.000Z')
    .filter((candidate) => candidate.kind === 'alert_delivery_succeeded'
      && candidate.severity !== undefined
      && candidate.fingerprint === event.fingerprint)
    .map((candidate) => ({
      ts: Date.parse(candidate.ts),
      severity: candidate.severity!,
      fingerprint: candidate.fingerprint!,
    }))
    .filter((candidate) => Number.isFinite(candidate.ts))
    .at(-1);
}

function latestStormGuardAlert(events: EventStore, event: AlertableDriftEvent): StormGuardLast | undefined {
  return events
    .queryByFingerprintSince(event.fingerprint, '1970-01-01T00:00:00.000Z')
    .filter((candidate) => candidate.kind === 'alert_delivery_succeeded'
      && candidate.severity === 'crit'
      && candidate.fingerprint === event.fingerprint)
    .map((candidate) => ({
      ts: Date.parse(candidate.ts),
      payloadHash: readString(candidate.payload.payload_hash) ?? candidate.fingerprint!,
      actionResult: readString(candidate.payload.action_result) ?? 'alert',
    }))
    .filter((candidate) => Number.isFinite(candidate.ts))
    .at(-1);
}

function readDiff(event: EventInput): { added: unknown; removed: unknown; changed: unknown } {
  const diff = event.payload.diff;
  if (isDiff(diff)) return diff;
  return { added: {}, removed: {}, changed: {} };
}

function isDiff(value: unknown): value is { added: unknown; removed: unknown; changed: unknown } {
  return typeof value === 'object'
    && value !== null
    && 'added' in value
    && 'removed' in value
    && 'changed' in value;
}

function readActionLabel(event: EventInput): string {
  const action = event.payload.action;
  return typeof action === 'string' && action.length > 0 ? action : 'alert';
}

function alertScopeId(event: AlertableEvent): string {
  return event.scope_id ?? 'guard';
}

function alertProbeId(event: AlertableEvent): string {
  return event.probe_id ?? event.kind;
}

function actionForEvent(args: RunCycleArgs, event: AlertableEvent): string {
  const actionKey = actionKeyForEvent(event);
  if (actionKey) {
    const configured = args.runtimeConfig?.actions[actionKey];
    if (configured) return configured;
  }
  return event.kind === 'drift' ? readActionLabel(event) : 'alert';
}

function assertSupportedPolicyAction(action: string): void {
  if (action === 'remediate' || action === 'block') {
    throw new Error(`policy action ${action} is not yet supported`);
  }
}

function sinksForAction(args: RunCycleArgs, action: string): Sink[] {
  if (action === 'meta_alert') return [...(args.metaAlertSinks ?? [])];
  return [...(args.sinks ?? [])];
}

function alertFingerprint(event: AlertableEvent): string {
  if (event.fingerprint) return event.fingerprint;
  return createHash('sha256')
    .update(canonicalize({
      kind: event.kind,
      domain: event.domain,
      scope_id: alertScopeId(event),
      probe_id: alertProbeId(event),
      payload: event.payload,
    }))
    .digest('hex');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function alertedTo(channel: string): EventInput['alerted_to'] {
  if (channel === 'whatsoup') return 'whatsoup';
  if (channel === 'local-notify' || channel === 'local_notification') return 'local_notification';
  if (channel === 'local-log' || channel === 'local_log') return 'local_log';
  return 'external_push';
}
