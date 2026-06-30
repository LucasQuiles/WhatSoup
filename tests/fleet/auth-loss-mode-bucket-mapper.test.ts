import { describe, expect, it } from 'vitest';
import { mapClassifierEdgeToModeDecision } from '../../src/fleet/auth-loss-mode-bucket-mapper.ts';

function health(authFailureClass: string, disconnectClass = 'none') {
  return {
    whatsapp: {
      connection: {
        auth_failure_class: authFailureClass,
        disconnect_class: disconnectClass,
      },
    },
  };
}

describe('auth-loss mode bucket mapper', () => {
  it('maps terminal health fields to mode_1_manual_relink', () => {
    expect(mapClassifierEdgeToModeDecision({
      health: health('serverside_logout_irreversible', 'serverside_logout_irreversible'),
    })).toEqual({
      action: 'open_outage',
      bucket: 'mode_1_manual_relink',
      closeEdge: 'WA_AUTH_BOND_RELINK_VERIFIED',
      confidence: 'confirmed',
    });

    expect(mapClassifierEdgeToModeDecision({
      health: health('pairing_required'),
    })).toMatchObject({
      action: 'open_outage',
      bucket: 'mode_1_manual_relink',
    });
  });

  it('maps transient, contention, corruption, and at-risk fields to distinct decisions', () => {
    expect(mapClassifierEdgeToModeDecision({
      health: health('none', 'restart_required_flapping'),
    })).toMatchObject({
      action: 'open_outage',
      bucket: 'transient_flap',
    });

    expect(mapClassifierEdgeToModeDecision({
      health: health('none', 'duplicate_session_replaced'),
    })).toMatchObject({
      action: 'open_outage',
      bucket: 'session_contended',
    });

    expect(mapClassifierEdgeToModeDecision({
      health: health('local_corruption_restorable'),
    })).toMatchObject({
      action: 'open_outage',
      bucket: 'local_corruption',
    });

    expect(mapClassifierEdgeToModeDecision({
      health: health('auth_bond_at_risk'),
    })).toEqual({
      action: 'annotate',
      annotation: 'auth_bond_at_risk',
      opensOutage: false,
    });
  });

  it('maps verified relink, bond-restored, and quiet-dwell markers without weakening mode_1', () => {
    expect(mapClassifierEdgeToModeDecision({
      activeBucket: 'mode_1_manual_relink',
      clearCode: 'WA_AUTH_BOND_RELINK_VERIFIED',
    })).toEqual({
      action: 'close_outage',
      bucket: 'mode_1_manual_relink',
      closeEdge: 'WA_AUTH_BOND_RELINK_VERIFIED',
    });

    expect(mapClassifierEdgeToModeDecision({
      activeBucket: 'mode_1_manual_relink',
      marker: 'bond_restored',
    })).toEqual({
      action: 'record_intermediate',
      bucket: 'mode_1_manual_relink',
      timestampField: 'bond_restored_at',
      closesOutage: false,
    });

    expect(mapClassifierEdgeToModeDecision({
      activeBucket: 'mode_1_manual_relink',
      marker: 'quiet_dwell_satisfied',
    })).toEqual({
      action: 'no_close',
      bucket: 'mode_1_manual_relink',
      reason: 'mode_1_requires_relink_verified',
    });
  });

  it('maps transient quiet dwell, session terminal followup, local recovery, and clean restart markers', () => {
    expect(mapClassifierEdgeToModeDecision({
      activeBucket: 'transient_flap',
      marker: 'quiet_dwell_satisfied',
    })).toEqual({
      action: 'close_outage',
      bucket: 'transient_flap',
      closeEdge: 'per_instance_mode_bucketed_quiet_dwell',
    });

    expect(mapClassifierEdgeToModeDecision({
      activeBucket: 'session_contended',
      marker: 'terminal_auth_followup',
    })).toEqual({
      action: 'escalate_outage',
      fromBucket: 'session_contended',
      toBucket: 'mode_1_manual_relink',
      closeEdge: 'WA_AUTH_BOND_RELINK_VERIFIED',
    });

    expect(mapClassifierEdgeToModeDecision({
      activeBucket: 'local_corruption',
      marker: 'local_auth_bond_recovered',
    })).toEqual({
      action: 'close_outage',
      bucket: 'local_corruption',
      closeEdge: 'local_auth_bond_recovery',
    });

    expect(mapClassifierEdgeToModeDecision({
      marker: 'clean_restart_same_identity',
      health: health('none', 'restart_required'),
    })).toEqual({
      action: 'no_outage',
      reason: 'clean_restart_same_identity',
    });
  });

  it('maps registration and line restriction fields away from mode_1 relink', () => {
    expect(mapClassifierEdgeToModeDecision({
      health: health('registration_blocked'),
    })).toEqual({
      action: 'open_outage',
      bucket: 'registration_blocked',
      closeEdge: 'owner_verified_registration_recovered',
      confidence: 'confirmed',
    });

    expect(mapClassifierEdgeToModeDecision({
      health: health('none', 'pairing_code_rejected'),
    })).toMatchObject({
      action: 'open_outage',
      bucket: 'registration_blocked',
    });

    expect(mapClassifierEdgeToModeDecision({
      health: health('line_quarantined'),
    })).toEqual({
      action: 'open_outage',
      bucket: 'line_quarantined',
      closeEdge: 'owner_verified_line_unquarantined_or_migrated',
      confidence: 'confirmed',
    });

    expect(mapClassifierEdgeToModeDecision({
      health: health('none', 'line_restricted'),
    })).toMatchObject({
      action: 'open_outage',
      bucket: 'line_quarantined',
    });
  });
});
