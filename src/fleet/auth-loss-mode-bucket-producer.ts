import type { AuthLossModeEventInput } from './auth-loss-mode-bucket-contract.ts';
import { isNonEmptyString } from '../lib/type-guards.ts';

type RegistrationFailureKind =
  | 'registration_rejected'
  | 'pairing_code_rejected';

type LineStatusAttestation =
  | 'line_restricted'
  | 'line_quarantined';

export type AuthLossModeProducerInput =
  | {
      source: 'connection_event';
      statusCode?: number;
      reason?: string;
    }
  | {
      source: 'registration_attempt';
      statusCode?: number;
      failureKind?: RegistrationFailureKind;
    }
  | {
      source: 'line_status_attestation';
      lineStatus?: LineStatusAttestation;
      verifiedBy?: string;
      evidenceNoteId?: string;
    }
  | {
      source: 'log_text';
      text?: string;
    };

export type AuthLossModeProducerSignal =
  | {
      emits: true;
      reason:
        | 'server_revoked_session'
        | 'pairing_code_rejected'
        | 'registration_rejected'
        | 'owner_attested_line_status';
      event: Pick<AuthLossModeEventInput, 'authFailureClass' | 'disconnectClass'>;
    }
  | {
      emits: false;
      reason:
        | 'restart_required_without_pairing_context'
        | 'registration_attempt_without_structured_rejection'
        | 'line_attestation_missing_proof'
        | 'unstructured_text_not_authoritative'
        | 'no_authoritative_mode_bucket_signal';
    };

export function deriveAuthLossModeProducerSignal(input: AuthLossModeProducerInput): AuthLossModeProducerSignal {
  if (input.source === 'connection_event') {
    if (input.statusCode === 401 || isLoggedOutReason(input.reason)) {
      return {
        emits: true,
        reason: 'server_revoked_session',
        event: { authFailureClass: 'serverside_logout_irreversible' },
      };
    }
    if (input.statusCode === 515) {
      return { emits: false, reason: 'restart_required_without_pairing_context' };
    }
    return { emits: false, reason: 'no_authoritative_mode_bucket_signal' };
  }

  if (input.source === 'registration_attempt') {
    if (input.statusCode === 515 && input.failureKind === 'pairing_code_rejected') {
      return {
        emits: true,
        reason: 'pairing_code_rejected',
        event: { disconnectClass: 'pairing_code_rejected' },
      };
    }
    if (input.statusCode === 405 && input.failureKind === 'registration_rejected') {
      return {
        emits: true,
        reason: 'registration_rejected',
        event: { disconnectClass: 'registration_rejected' },
      };
    }
    return { emits: false, reason: 'registration_attempt_without_structured_rejection' };
  }

  if (input.source === 'line_status_attestation') {
    if (!hasProof(input.verifiedBy) || !hasProof(input.evidenceNoteId)) {
      return { emits: false, reason: 'line_attestation_missing_proof' };
    }
    if (input.lineStatus === 'line_restricted') {
      return {
        emits: true,
        reason: 'owner_attested_line_status',
        event: { disconnectClass: 'line_restricted' },
      };
    }
    if (input.lineStatus === 'line_quarantined') {
      return {
        emits: true,
        reason: 'owner_attested_line_status',
        event: { authFailureClass: 'line_quarantined' },
      };
    }
    return { emits: false, reason: 'line_attestation_missing_proof' };
  }

  return { emits: false, reason: 'unstructured_text_not_authoritative' };
}

function isLoggedOutReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason === 'loggedOut' || reason.includes('device_removed');
}

function hasProof(value: string | undefined): boolean {
  return isNonEmptyString(value);
}
