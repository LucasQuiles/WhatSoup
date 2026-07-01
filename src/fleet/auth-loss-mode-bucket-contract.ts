type AuthFailureClass =
  | 'none'
  | 'pairing_required'
  | 'serverside_logout_irreversible'
  | 'local_corruption_restorable'
  | 'local_corruption_unrestorable'
  | 'auth_bond_at_risk'
  | 'registration_blocked'
  | 'line_quarantined';

type DisconnectClass =
  | 'none'
  | 'serverside_logout_irreversible'
  | 'duplicate_session_replaced'
  | 'multidevice_mismatch'
  | 'restart_required'
  | 'restart_required_flapping'
  | 'transient_reconnect'
  | 'unknown_reconnect'
  | 'registration_rejected'
  | 'pairing_code_rejected'
  | 'line_restricted';

type AuthLossModeBucket =
  | 'mode_1_manual_relink'
  | 'transient_flap'
  | 'session_contended'
  | 'local_corruption'
  | 'registration_blocked'
  | 'line_quarantined';

type AuthLossModeEventKind =
  | 'bond_restored'
  | 'relink_verified'
  | 'quiet_dwell_satisfied'
  | 'terminal_auth_followup'
  | 'local_auth_bond_recovered'
  | 'clean_restart_same_identity'
  | 'registration_recovered'
  | 'line_unquarantined_or_migrated';

export interface AuthLossModeEventInput {
  eventKind?: AuthLossModeEventKind;
  activeBucket?: AuthLossModeBucket;
  authFailureClass?: AuthFailureClass;
  disconnectClass?: DisconnectClass;
}

export type AuthLossModeDecision =
  | {
      action: 'open_outage';
      bucket: AuthLossModeBucket;
      closeEdge:
        | 'WA_AUTH_BOND_RELINK_VERIFIED'
        | 'per_instance_mode_bucketed_quiet_dwell'
        | 'reconnect_verified_bond_or_terminal_escalation'
        | 'local_auth_bond_recovery'
        | 'owner_verified_registration_recovered'
        | 'owner_verified_line_unquarantined_or_migrated';
      confidence: 'confirmed' | 'inferred';
    }
  | {
      action: 'record_intermediate';
      bucket: 'mode_1_manual_relink';
      timestampField: 'bond_restored_at';
      closesOutage: false;
    }
  | {
      action: 'no_close';
      bucket: 'mode_1_manual_relink';
      reason: 'mode_1_requires_relink_verified';
    }
  | {
      action: 'no_close';
      bucket: 'registration_blocked';
      reason: 'registration_blocked_requires_registration_recovery';
    }
  | {
      action: 'no_close';
      bucket: 'line_quarantined';
      reason: 'line_quarantined_requires_owner_unquarantine_or_migration';
    }
  | {
      action: 'close_outage';
      bucket: AuthLossModeBucket;
      closeEdge:
        | 'WA_AUTH_BOND_RELINK_VERIFIED'
        | 'per_instance_mode_bucketed_quiet_dwell'
        | 'local_auth_bond_recovery'
        | 'owner_verified_registration_recovered'
        | 'owner_verified_line_unquarantined_or_migrated';
    }
  | {
      action: 'escalate_outage';
      fromBucket: 'session_contended';
      toBucket: 'mode_1_manual_relink';
      closeEdge: 'WA_AUTH_BOND_RELINK_VERIFIED';
    }
  | {
      action: 'annotate';
      annotation: 'auth_bond_at_risk';
      opensOutage: false;
    }
  | {
      action: 'no_outage';
      reason: 'clean_restart_same_identity' | 'no_mode_bucket_match';
    };

export function decideAuthLossModeEvent(input: AuthLossModeEventInput): AuthLossModeDecision {
  if (input.eventKind === 'clean_restart_same_identity') {
    return { action: 'no_outage', reason: 'clean_restart_same_identity' };
  }

  if (input.eventKind === 'bond_restored' && input.activeBucket === 'mode_1_manual_relink') {
    return {
      action: 'record_intermediate',
      bucket: 'mode_1_manual_relink',
      timestampField: 'bond_restored_at',
      closesOutage: false,
    };
  }

  if (input.eventKind === 'quiet_dwell_satisfied' && input.activeBucket === 'mode_1_manual_relink') {
    return {
      action: 'no_close',
      bucket: 'mode_1_manual_relink',
      reason: 'mode_1_requires_relink_verified',
    };
  }

  if (input.eventKind === 'relink_verified' && input.activeBucket === 'mode_1_manual_relink') {
    return {
      action: 'close_outage',
      bucket: 'mode_1_manual_relink',
      closeEdge: 'WA_AUTH_BOND_RELINK_VERIFIED',
    };
  }

  if (input.eventKind === 'relink_verified' && input.activeBucket === 'registration_blocked') {
    return {
      action: 'no_close',
      bucket: 'registration_blocked',
      reason: 'registration_blocked_requires_registration_recovery',
    };
  }

  if (input.eventKind === 'registration_recovered' && input.activeBucket === 'registration_blocked') {
    return {
      action: 'close_outage',
      bucket: 'registration_blocked',
      closeEdge: 'owner_verified_registration_recovered',
    };
  }

  if (input.eventKind === 'relink_verified' && input.activeBucket === 'line_quarantined') {
    return {
      action: 'no_close',
      bucket: 'line_quarantined',
      reason: 'line_quarantined_requires_owner_unquarantine_or_migration',
    };
  }

  if (input.eventKind === 'line_unquarantined_or_migrated' && input.activeBucket === 'line_quarantined') {
    return {
      action: 'close_outage',
      bucket: 'line_quarantined',
      closeEdge: 'owner_verified_line_unquarantined_or_migrated',
    };
  }

  if (input.eventKind === 'quiet_dwell_satisfied' && input.activeBucket === 'transient_flap') {
    return {
      action: 'close_outage',
      bucket: 'transient_flap',
      closeEdge: 'per_instance_mode_bucketed_quiet_dwell',
    };
  }

  if (input.eventKind === 'terminal_auth_followup' && input.activeBucket === 'session_contended') {
    return {
      action: 'escalate_outage',
      fromBucket: 'session_contended',
      toBucket: 'mode_1_manual_relink',
      closeEdge: 'WA_AUTH_BOND_RELINK_VERIFIED',
    };
  }

  if (input.eventKind === 'local_auth_bond_recovered' && input.activeBucket === 'local_corruption') {
    return {
      action: 'close_outage',
      bucket: 'local_corruption',
      closeEdge: 'local_auth_bond_recovery',
    };
  }

  if (input.authFailureClass === 'auth_bond_at_risk') {
    return { action: 'annotate', annotation: 'auth_bond_at_risk', opensOutage: false };
  }

  if (
    input.authFailureClass === 'pairing_required'
    || input.authFailureClass === 'serverside_logout_irreversible'
    || input.disconnectClass === 'serverside_logout_irreversible'
  ) {
    return {
      action: 'open_outage',
      bucket: 'mode_1_manual_relink',
      closeEdge: 'WA_AUTH_BOND_RELINK_VERIFIED',
      confidence: 'confirmed',
    };
  }

  if (
    input.authFailureClass === 'registration_blocked'
    || input.disconnectClass === 'registration_rejected'
    || input.disconnectClass === 'pairing_code_rejected'
  ) {
    return {
      action: 'open_outage',
      bucket: 'registration_blocked',
      closeEdge: 'owner_verified_registration_recovered',
      confidence: 'confirmed',
    };
  }

  if (
    input.authFailureClass === 'line_quarantined'
    || input.disconnectClass === 'line_restricted'
  ) {
    return {
      action: 'open_outage',
      bucket: 'line_quarantined',
      closeEdge: 'owner_verified_line_unquarantined_or_migrated',
      confidence: 'confirmed',
    };
  }

  if (
    input.authFailureClass === 'local_corruption_restorable'
    || input.authFailureClass === 'local_corruption_unrestorable'
  ) {
    return {
      action: 'open_outage',
      bucket: 'local_corruption',
      closeEdge: 'local_auth_bond_recovery',
      confidence: 'confirmed',
    };
  }

  if (
    input.disconnectClass === 'duplicate_session_replaced'
    || input.disconnectClass === 'multidevice_mismatch'
  ) {
    return {
      action: 'open_outage',
      bucket: 'session_contended',
      closeEdge: 'reconnect_verified_bond_or_terminal_escalation',
      confidence: 'inferred',
    };
  }

  if (
    input.disconnectClass === 'restart_required'
    || input.disconnectClass === 'restart_required_flapping'
    || input.disconnectClass === 'transient_reconnect'
  ) {
    return {
      action: 'open_outage',
      bucket: 'transient_flap',
      closeEdge: 'per_instance_mode_bucketed_quiet_dwell',
      confidence: 'inferred',
    };
  }

  return { action: 'no_outage', reason: 'no_mode_bucket_match' };
}
