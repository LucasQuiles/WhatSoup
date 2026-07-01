import { describe, expect, it } from 'vitest';

import { buildAuthLossModeProducerArtifact } from '../../src/fleet/auth-loss-mode-bucket-producer-artifact.ts';

describe('buildAuthLossModeProducerArtifact', () => {
  it('emits redaction-safe decision metadata without copying input evidence', () => {
    const artifact = buildAuthLossModeProducerArtifact({
      generatedAt: '2026-06-30T10:55:00.000Z',
      samples: [
        {
          id: 'stream-515',
          evidence: { source: 'connection_event', statusCode: 515, reason: '_streamError' },
        },
        {
          id: 'pairing-code-rejected',
          evidence: { source: 'registration_attempt', statusCode: 515, failureKind: 'pairing_code_rejected' },
        },
        {
          id: 'owner-line-restricted',
          evidence: {
            source: 'line_status_attestation',
            lineStatus: 'line_restricted',
            verifiedBy: 'owner',
            evidenceNoteId: 'LN-20260630-01',
          },
        },
      ],
    });

    expect(artifact).toEqual({
      artifact: 'auth-loss-mode-bucket-producer-dry-run',
      schemaVersion: 1,
      generatedAt: '2026-06-30T10:55:00.000Z',
      sampleCount: 3,
      redaction: { rawIdentifiersAllowed: false, evidenceCopied: false },
      decisions: [
        {
          id: 'stream-515',
          emits: false,
          reason: 'restart_required_without_pairing_context',
        },
        {
          id: 'pairing-code-rejected',
          emits: true,
          reason: 'pairing_code_rejected',
          event: { disconnectClass: 'pairing_code_rejected' },
          decision: {
            action: 'open_outage',
            bucket: 'registration_blocked',
            closeEdge: 'owner_verified_registration_recovered',
            confidence: 'confirmed',
          },
        },
        {
          id: 'owner-line-restricted',
          emits: true,
          reason: 'owner_attested_line_status',
          event: { disconnectClass: 'line_restricted' },
          decision: {
            action: 'open_outage',
            bucket: 'line_quarantined',
            closeEdge: 'owner_verified_line_unquarantined_or_migrated',
            confidence: 'confirmed',
          },
        },
      ],
    });
    expect(JSON.stringify(artifact)).not.toContain('"evidence":');
    expect(JSON.stringify(artifact)).not.toContain('_streamError');
    expect(JSON.stringify(artifact)).not.toContain('LN-20260630-01');
  });

  it('rejects duplicate sample ids', () => {
    expect(() => buildAuthLossModeProducerArtifact({
      generatedAt: '2026-06-30T10:55:00.000Z',
      samples: [
        { id: 'same-id', evidence: { source: 'connection_event', statusCode: 515 } },
        { id: 'same-id', evidence: { source: 'connection_event', statusCode: 401 } },
      ],
    })).toThrow(/duplicate sample id/i);
  });

  it('rejects raw identifier and auth-path shaped fixture values before emitting an artifact', () => {
    const rawGroupJid = ['120363', '999888777666', '@g.us'].join('');
    const rawUserJid = ['19998887777', '@s.whatsapp.net'].join('');
    const rawPhone = ['+1', '212', '867', '5309'].join('');
    const authPath = ['auth', 'creds.json'].join('/');

    for (const unsafeValue of [rawGroupJid, rawUserJid, rawPhone, authPath]) {
      expect(() => buildAuthLossModeProducerArtifact({
        generatedAt: '2026-06-30T10:55:00.000Z',
        samples: [
          {
            id: 'unsafe-fixture',
            evidence: { source: 'log_text', text: `unsafe ${unsafeValue}` },
          },
        ],
      })).toThrow(/unsafe producer artifact input/i);
    }
  });

  it('rejects unsafe sample ids', () => {
    expect(() => buildAuthLossModeProducerArtifact({
      generatedAt: '2026-06-30T10:55:00.000Z',
      samples: [
        { id: '../unsafe', evidence: { source: 'connection_event', statusCode: 401 } },
      ],
    })).toThrow(/unsafe sample id/i);
  });
});
