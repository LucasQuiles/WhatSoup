import type { Collector } from '../collector/types.ts';
import type { Evaluator } from '../evaluator/types.ts';
import type { DeploymentRole } from '../policy/schema.ts';
import { BaselineIntegrityError, type BaselineStore } from '../store/baseline.ts';
import type { EventInput, EventStore } from '../store/events.ts';
import type { MuteStore } from '../store/mutes.ts';
import { ProbeDocSchema, type ProbeDoc } from '../types.ts';
import { matchMute } from './mute-match.ts';

export interface RunOneProbeArgs {
  collector: Collector;
  scopeId: string;
  baselines: BaselineStore;
  events: EventStore;
  mutes: MuteStore;
  evaluator: Evaluator;
  deploymentRoles?: Record<string, DeploymentRole> | undefined;
  additionalForbiddenMuteDomains?: readonly string[];
  now: () => Date;
}

export interface RunOneProbeResult {
  events: EventInput[];
}

export async function runOneProbe(args: RunOneProbeArgs): Promise<RunOneProbeResult> {
  const { collector, scopeId, baselines, events, mutes, evaluator, now } = args;
  const ts = now().toISOString();
  let observed: ProbeDoc;

  try {
    observed = await collector.run(scopeId);
  } catch (error) {
    const event: EventInput = {
      ts,
      kind: 'probe_error',
      scope_id: scopeId,
      probe_id: collector.id,
      payload: probeErrorPayload(error),
    };
    events.append(event);
    return { events: [event] };
  }

  let baseline: ProbeDoc | undefined;
  try {
    baseline = readBaselineDoc(baselines, collector.id, scopeId);
  } catch (error) {
    if (!(error instanceof BaselineIntegrityError)) {
      throw error;
    }
    const event: EventInput = {
      ts,
      kind: 'baseline_integrity_fail',
      domain: 'alerting',
      scope_id: scopeId,
      probe_id: collector.id,
      severity: 'crit',
      payload: { error: 'baseline integrity failed' },
    };
    events.append(event);
    return { events: [event] };
  }

  if (!baseline) {
    const event: EventInput = {
      ts,
      kind: 'probe_error',
      domain: 'alerting',
      scope_id: scopeId,
      probe_id: collector.id,
      severity: 'high',
      payload: { error: 'missing baseline' },
      alerted_to: 'none',
    };
    events.append(event);
    return { events: [event] };
  }

  const activeMutes = mutes.listActive(ts);
  const output: EventInput[] = [];

  for (const event of evaluator({ observed, baseline, deploymentRole: roleForObserved(observed, args.deploymentRoles) })) {
    const next = event.kind === 'drift' && event.domain
      ? applyMute(scopeId, ts, event, activeMutes, args.additionalForbiddenMuteDomains)
      : event;
    events.append(next);
    output.push(next);
  }

  return { events: output };
}

function roleForObserved(observed: ProbeDoc, deploymentRoles: Record<string, DeploymentRole> | undefined): DeploymentRole | undefined {
  const role = observed.fields.role;
  return typeof role === 'string' ? deploymentRoles?.[role] : undefined;
}

function readBaselineDoc(baselines: BaselineStore, probeId: string, scopeId: string): ProbeDoc | undefined {
  const row = baselines.get(probeId, scopeId);
  if (!row) return undefined;
  return ProbeDocSchema.parse({
    probe_id: row.probe_id,
    scope_id: row.scope_id,
    captured_at: row.captured_at,
    fields: JSON.parse(row.expected_doc) as Record<string, unknown>,
  });
}

function applyMute(
  scopeId: string,
  nowIso: string,
  event: EventInput,
  activeMutes: ReturnType<MuteStore['listActive']>,
  additionalForbiddenMuteDomains: readonly string[] = [],
): EventInput {
  const mute = matchMute({
    host: scopeId,
    domain: event.domain ?? 'exposure',
    isRemediation: false,
    now: nowIso,
  }, activeMutes, { additionalForbiddenDomains: additionalForbiddenMuteDomains });

  if (!mute.matched) {
    return event;
  }

  return {
    ...event,
    kind: 'drift_muted',
    payload: {
      ...event.payload,
      mute_id: mute.byMute?.id,
      mute_match_reason: mute.reason,
    },
    alerted_to: 'none',
  };
}

function probeErrorPayload(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof Error ? error.message : String(error),
    error_name: error instanceof Error ? error.name : 'unknown',
  };
}
