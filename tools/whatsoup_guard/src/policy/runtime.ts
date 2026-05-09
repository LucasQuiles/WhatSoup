import type { Action, Policy } from './schema.ts';
import type { Domain, Severity } from '../types.ts';
import type { EventInput } from '../store/events.ts';

export interface RuntimePolicyConfig {
  actions: Record<string, Action>;
  forbiddenMuteDomains: string[];
  metaAlertEnabled: boolean;
  domainSeverities: Partial<Record<Domain, Severity>>;
  enabledDomains: Partial<Record<Domain, boolean>>;
}

export type PolicyActionKey =
  | 'exposure.unauthenticated_mutation'
  | 'exposure.public_funnel_internal'
  | 'exposure.firewall_disabled'
  | 'capability.role_violation'
  | 'credential.file_mode_widened'
  | 'credential.token_aging'
  | 'change.new_persistence_unit'
  | 'change.new_application_route'
  | 'alerting.self_secret_widened'
  | 'alerting.baseline_integrity_fail'
  | 'alerting.transport_failed'
  | (string & {});

const EVENT_ACTION_KEYS: Partial<Record<EventInput['kind'], PolicyActionKey>> = {
  alert_token_aging: 'credential.token_aging',
  self_secret_widened: 'alerting.self_secret_widened',
  baseline_integrity_fail: 'alerting.baseline_integrity_fail',
  alert_delivery_failed_all: 'alerting.transport_failed',
};

export function buildRuntimeConfig(policy: Policy): RuntimePolicyConfig {
  rejectDisabledAlerting(policy);
  rejectUnsupportedActions(policy.actions);
  return {
    actions: { ...policy.actions },
    forbiddenMuteDomains: [...policy.mute_constraints.forbidden_domains],
    metaAlertEnabled: policy.transport.meta_alert?.enabled ?? false,
    domainSeverities: domainSeverities(policy),
    enabledDomains: enabledDomains(policy),
  };
}

function rejectDisabledAlerting(policy: Policy): void {
  if (policy.domains.alerting?.enabled === false) {
    throw new Error('domains.alerting.enabled false is not supported because alerting self-protection must fail closed');
  }
}

function rejectUnsupportedActions(actions: Record<string, Action>): void {
  for (const [key, action] of Object.entries(actions)) {
    if (action === 'remediate' || action === 'block') {
      throw new Error(`unsupported policy action "${action}" for key "${key}"`);
    }
  }
}

function domainSeverities(policy: Policy): Partial<Record<Domain, Severity>> {
  return Object.fromEntries(
    Object.entries(policy.domains)
      .filter((entry): entry is [Domain, { severity: Severity }] => entry[1].severity !== undefined)
      .map(([domain, config]) => [domain, config.severity]),
  );
}

function enabledDomains(policy: Policy): Partial<Record<Domain, boolean>> {
  return Object.fromEntries(
    Object.entries(policy.domains)
      .filter((entry): entry is [Domain, { enabled: boolean }] => entry[1].enabled !== undefined)
      .map(([domain, config]) => [domain, config.enabled]),
  );
}

export function actionKeyForEvent(event: EventInput): PolicyActionKey | undefined {
  const reasonCode = readString(event.payload.reason_code);
  if (reasonCode) return reasonCode as PolicyActionKey;
  return EVENT_ACTION_KEYS[event.kind];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
