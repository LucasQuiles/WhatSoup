import { describe, expect, it } from 'vitest';
import { decideAuthLossModeEvent } from '../../src/fleet/auth-loss-mode-bucket-contract.ts';

describe('auth-loss mode bucket contract', () => {
  it('opens mode_1_manual_relink for terminal auth loss and closes only on verified relink', () => {
    expect(decideAuthLossModeEvent({
      authFailureClass: 'serverside_logout_irreversible',
      disconnectClass: 'serverside_logout_irreversible',
    })).toEqual({
      action: 'open_outage',
      bucket: 'mode_1_manual_relink',
      closeEdge: 'WA_AUTH_BOND_RELINK_VERIFIED',
      confidence: 'confirmed',
    });

    expect(decideAuthLossModeEvent({
      eventKind: 'bond_restored',
      activeBucket: 'mode_1_manual_relink',
    })).toEqual({
      action: 'record_intermediate',
      bucket: 'mode_1_manual_relink',
      timestampField: 'bond_restored_at',
      closesOutage: false,
    });

    expect(decideAuthLossModeEvent({
      eventKind: 'quiet_dwell_satisfied',
      activeBucket: 'mode_1_manual_relink',
    })).toEqual({
      action: 'no_close',
      bucket: 'mode_1_manual_relink',
      reason: 'mode_1_requires_relink_verified',
    });

    expect(decideAuthLossModeEvent({
      eventKind: 'relink_verified',
      activeBucket: 'mode_1_manual_relink',
    })).toEqual({
      action: 'close_outage',
      bucket: 'mode_1_manual_relink',
      closeEdge: 'WA_AUTH_BOND_RELINK_VERIFIED',
    });
  });

  it('keeps transient flap separate and closes it by per-instance quiet dwell', () => {
    expect(decideAuthLossModeEvent({
      disconnectClass: 'restart_required_flapping',
    })).toEqual({
      action: 'open_outage',
      bucket: 'transient_flap',
      closeEdge: 'per_instance_mode_bucketed_quiet_dwell',
      confidence: 'inferred',
    });

    expect(decideAuthLossModeEvent({
      eventKind: 'quiet_dwell_satisfied',
      activeBucket: 'transient_flap',
    })).toEqual({
      action: 'close_outage',
      bucket: 'transient_flap',
      closeEdge: 'per_instance_mode_bucketed_quiet_dwell',
    });
  });

  it('keeps session contention separate and escalates only after terminal auth loss follows', () => {
    expect(decideAuthLossModeEvent({
      disconnectClass: 'duplicate_session_replaced',
    })).toEqual({
      action: 'open_outage',
      bucket: 'session_contended',
      closeEdge: 'reconnect_verified_bond_or_terminal_escalation',
      confidence: 'inferred',
    });

    expect(decideAuthLossModeEvent({
      eventKind: 'terminal_auth_followup',
      activeBucket: 'session_contended',
    })).toEqual({
      action: 'escalate_outage',
      fromBucket: 'session_contended',
      toBucket: 'mode_1_manual_relink',
      closeEdge: 'WA_AUTH_BOND_RELINK_VERIFIED',
    });
  });

  it('separates local corruption from WhatsApp relink proof', () => {
    expect(decideAuthLossModeEvent({
      authFailureClass: 'local_corruption_restorable',
    })).toEqual({
      action: 'open_outage',
      bucket: 'local_corruption',
      closeEdge: 'local_auth_bond_recovery',
      confidence: 'confirmed',
    });

    expect(decideAuthLossModeEvent({
      eventKind: 'local_auth_bond_recovered',
      activeBucket: 'local_corruption',
    })).toEqual({
      action: 'close_outage',
      bucket: 'local_corruption',
      closeEdge: 'local_auth_bond_recovery',
    });
  });

  it('treats auth_bond_at_risk and clean restarts as non-mode-1 signals', () => {
    expect(decideAuthLossModeEvent({
      authFailureClass: 'auth_bond_at_risk',
    })).toEqual({
      action: 'annotate',
      annotation: 'auth_bond_at_risk',
      opensOutage: false,
    });

    expect(decideAuthLossModeEvent({
      eventKind: 'clean_restart_same_identity',
      disconnectClass: 'restart_required',
    })).toEqual({
      action: 'no_outage',
      reason: 'clean_restart_same_identity',
    });
  });

  it('keeps registration blockage out of mode_1 relink recovery', () => {
    expect(decideAuthLossModeEvent({
      authFailureClass: 'registration_blocked' as never,
    })).toEqual({
      action: 'open_outage',
      bucket: 'registration_blocked',
      closeEdge: 'owner_verified_registration_recovered',
      confidence: 'confirmed',
    });

    expect(decideAuthLossModeEvent({
      disconnectClass: 'pairing_code_rejected' as never,
    })).toEqual({
      action: 'open_outage',
      bucket: 'registration_blocked',
      closeEdge: 'owner_verified_registration_recovered',
      confidence: 'confirmed',
    });

    expect(decideAuthLossModeEvent({
      eventKind: 'relink_verified',
      activeBucket: 'registration_blocked' as never,
    })).toEqual({
      action: 'no_close',
      bucket: 'registration_blocked',
      reason: 'registration_blocked_requires_registration_recovery',
    });

    expect(decideAuthLossModeEvent({
      eventKind: 'registration_recovered' as never,
      activeBucket: 'registration_blocked' as never,
    })).toEqual({
      action: 'close_outage',
      bucket: 'registration_blocked',
      closeEdge: 'owner_verified_registration_recovered',
    });
  });

  it('keeps line quarantine out of mode_1 relink recovery', () => {
    expect(decideAuthLossModeEvent({
      authFailureClass: 'line_quarantined' as never,
    })).toEqual({
      action: 'open_outage',
      bucket: 'line_quarantined',
      closeEdge: 'owner_verified_line_unquarantined_or_migrated',
      confidence: 'confirmed',
    });

    expect(decideAuthLossModeEvent({
      disconnectClass: 'line_restricted' as never,
    })).toEqual({
      action: 'open_outage',
      bucket: 'line_quarantined',
      closeEdge: 'owner_verified_line_unquarantined_or_migrated',
      confidence: 'confirmed',
    });

    expect(decideAuthLossModeEvent({
      eventKind: 'relink_verified',
      activeBucket: 'line_quarantined' as never,
    })).toEqual({
      action: 'no_close',
      bucket: 'line_quarantined',
      reason: 'line_quarantined_requires_owner_unquarantine_or_migration',
    });

    expect(decideAuthLossModeEvent({
      eventKind: 'line_unquarantined_or_migrated' as never,
      activeBucket: 'line_quarantined' as never,
    })).toEqual({
      action: 'close_outage',
      bucket: 'line_quarantined',
      closeEdge: 'owner_verified_line_unquarantined_or_migrated',
    });
  });
});
