import { describe, expect, it } from 'vitest';

import { decideAuthLossModeEvent } from '../../src/fleet/auth-loss-mode-bucket-contract.ts';
import { deriveAuthLossModeProducerSignal } from '../../src/fleet/auth-loss-mode-bucket-producer.ts';

function bucketFor(signal: ReturnType<typeof deriveAuthLossModeProducerSignal>): string | null {
  if (!signal.emits) return null;
  const decision = decideAuthLossModeEvent(signal.event);
  return decision.action === 'open_outage' ? decision.bucket : null;
}

describe('deriveAuthLossModeProducerSignal', () => {
  it('keeps stream-only 515 reconnect evidence out of pairing-code rejection', () => {
    const signal = deriveAuthLossModeProducerSignal({
      source: 'connection_event',
      statusCode: 515,
      reason: '_streamError',
    });

    expect(signal).toMatchObject({
      emits: false,
      reason: 'restart_required_without_pairing_context',
    });
    expect(bucketFor(signal)).toBeNull();
  });

  it('maps 515 to registration blockage only with structured pairing-code rejection context', () => {
    const signal = deriveAuthLossModeProducerSignal({
      source: 'registration_attempt',
      statusCode: 515,
      failureKind: 'pairing_code_rejected',
    });

    expect(signal).toMatchObject({
      emits: true,
      event: { disconnectClass: 'pairing_code_rejected' },
    });
    expect(bucketFor(signal)).toBe('registration_blocked');
  });

  it('maps 405 to registration blockage only with structured registration rejection context', () => {
    const signal = deriveAuthLossModeProducerSignal({
      source: 'registration_attempt',
      statusCode: 405,
      failureKind: 'registration_rejected',
    });

    expect(signal).toMatchObject({
      emits: true,
      event: { disconnectClass: 'registration_rejected' },
    });
    expect(bucketFor(signal)).toBe('registration_blocked');
  });

  it('does not open line quarantine from generic ban text', () => {
    const signal = deriveAuthLossModeProducerSignal({
      source: 'log_text',
      text: 'account appears banned or restricted',
    });

    expect(signal).toMatchObject({
      emits: false,
      reason: 'unstructured_text_not_authoritative',
    });
    expect(bucketFor(signal)).toBeNull();
  });

  it('opens line quarantine from owner-attested structured line restriction evidence', () => {
    const signal = deriveAuthLossModeProducerSignal({
      source: 'line_status_attestation',
      lineStatus: 'line_restricted',
      verifiedBy: 'owner',
      evidenceNoteId: 'LN-20260630-01',
    });

    expect(signal).toMatchObject({
      emits: true,
      event: { disconnectClass: 'line_restricted' },
    });
    expect(bucketFor(signal)).toBe('line_quarantined');
  });

  it('refuses line quarantine attestation without an evidence note id', () => {
    const signal = deriveAuthLossModeProducerSignal({
      source: 'line_status_attestation',
      lineStatus: 'line_restricted',
      verifiedBy: 'owner',
    });

    expect(signal).toMatchObject({
      emits: false,
      reason: 'line_attestation_missing_proof',
    });
    expect(bucketFor(signal)).toBeNull();
  });
});
