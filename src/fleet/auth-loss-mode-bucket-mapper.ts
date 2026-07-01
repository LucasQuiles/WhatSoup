import {
  decideAuthLossModeEvent,
  type AuthLossModeDecision,
  type AuthLossModeEventInput,
} from './auth-loss-mode-bucket-contract.ts';

type ClassifierEdgeMarker =
  | 'bond_restored'
  | 'quiet_dwell_satisfied'
  | 'terminal_auth_followup'
  | 'local_auth_bond_recovered'
  | 'clean_restart_same_identity';

type ActiveBucket = NonNullable<AuthLossModeEventInput['activeBucket']>;

export interface ClassifierEdgeModeInput {
  health?: Record<string, unknown>;
  activeBucket?: ActiveBucket;
  marker?: ClassifierEdgeMarker;
  clearCode?: string;
}

export function mapClassifierEdgeToModeDecision(input: ClassifierEdgeModeInput): AuthLossModeDecision {
  return decideAuthLossModeEvent({
    eventKind: eventKindFor(input),
    activeBucket: input.activeBucket,
    authFailureClass: authFailureClassFrom(input.health),
    disconnectClass: disconnectClassFrom(input.health),
  });
}

function eventKindFor(input: ClassifierEdgeModeInput): AuthLossModeEventInput['eventKind'] {
  if (input.clearCode === 'WA_AUTH_BOND_RELINK_VERIFIED') {
    return 'relink_verified';
  }
  return input.marker;
}

function authFailureClassFrom(health: Record<string, unknown> | undefined): AuthLossModeEventInput['authFailureClass'] {
  const value = stringAt(health, ['whatsapp', 'connection', 'auth_failure_class']);
  if (
    value === 'none'
    || value === 'pairing_required'
    || value === 'serverside_logout_irreversible'
    || value === 'local_corruption_restorable'
    || value === 'local_corruption_unrestorable'
    || value === 'auth_bond_at_risk'
    || value === 'registration_blocked'
    || value === 'line_quarantined'
  ) {
    return value;
  }
  return undefined;
}

function disconnectClassFrom(health: Record<string, unknown> | undefined): AuthLossModeEventInput['disconnectClass'] {
  const value = stringAt(health, ['whatsapp', 'connection', 'disconnect_class']);
  if (
    value === 'none'
    || value === 'serverside_logout_irreversible'
    || value === 'duplicate_session_replaced'
    || value === 'multidevice_mismatch'
    || value === 'restart_required'
    || value === 'restart_required_flapping'
    || value === 'transient_reconnect'
    || value === 'unknown_reconnect'
    || value === 'registration_rejected'
    || value === 'pairing_code_rejected'
    || value === 'line_restricted'
  ) {
    return value;
  }
  return undefined;
}

function stringAt(root: Record<string, unknown> | undefined, path: string[]): string | undefined {
  let current: unknown = root;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}
