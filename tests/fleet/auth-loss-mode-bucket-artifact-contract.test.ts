import { describe, expect, it } from 'vitest';

import { validateAuthLossModeProducerArtifact } from '../../src/fleet/auth-loss-mode-bucket-artifact-contract.ts';

function safeArtifact(): unknown {
  return {
    artifact: 'auth-loss-mode-bucket-producer-dry-run',
    schemaVersion: 1,
    generatedAt: '2026-06-30T11:30:00.000Z',
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
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('validateAuthLossModeProducerArtifact', () => {
  it('accepts safe producer artifacts and returns aggregate proof metadata', () => {
    expect(validateAuthLossModeProducerArtifact(safeArtifact())).toEqual({
      artifact: 'auth-loss-mode-bucket-artifact-contract-proof',
      schemaVersion: 1,
      sourceArtifact: 'auth-loss-mode-bucket-producer-dry-run',
      sampleCount: 3,
      emittedCount: 2,
      suppressedCount: 1,
      bucketCounts: {
        registration_blocked: 1,
        line_quarantined: 1,
      },
      redaction: {
        rawIdentifiersAllowed: false,
        evidenceCopied: false,
        forbiddenFieldScan: 'pass',
        unsafePatternScan: 'pass',
      },
    });
  });

  it('rejects forbidden evidence-like fields and runtime-assembled unsafe strings', () => {
    const rawGroupJid = ['120363', '999888777666', '@g.us'].join('');
    const rawUserJid = ['19998887777', '@s.whatsapp.net'].join('');
    const rawLid = ['abcdefghi', '@lid'].join('');
    const rawPhone = ['+1', '212', '867', '5309'].join('');
    const authPath = ['auth', 'creds.json'].join('/');
    const secretAssignment = ['API_', 'TOK', 'EN=', 'secret-material-', '1234567890'].join('');

    for (const [field, unsafeValue] of [
      ['evidence', { note: 'raw evidence is not allowed' }],
      ['raw', rawGroupJid],
      ['message', rawUserJid],
      ['text', rawLid],
      ['phone', rawPhone],
      ['auth', authPath],
      ['secret', secretAssignment],
    ] as const) {
      const artifact = clone(safeArtifact()) as Record<string, unknown>;
      const decisions = artifact.decisions as Array<Record<string, unknown>>;
      decisions[1][field] = unsafeValue;

      expect(() => validateAuthLossModeProducerArtifact(artifact)).toThrow(/unsafe|forbidden/i);
    }
  });

  it('rejects malformed accounting, duplicate ids, unsafe ids, and missing redaction guarantees', () => {
    const mismatchedCount = clone(safeArtifact()) as Record<string, unknown>;
    mismatchedCount.sampleCount = 99;
    expect(() => validateAuthLossModeProducerArtifact(mismatchedCount)).toThrow(/sampleCount/i);

    const duplicateIds = clone(safeArtifact()) as Record<string, unknown>;
    const duplicateDecisions = duplicateIds.decisions as Array<Record<string, unknown>>;
    duplicateDecisions[2].id = duplicateDecisions[1].id;
    expect(() => validateAuthLossModeProducerArtifact(duplicateIds)).toThrow(/duplicate/i);

    const unsafeId = clone(safeArtifact()) as Record<string, unknown>;
    const unsafeIdDecisions = unsafeId.decisions as Array<Record<string, unknown>>;
    unsafeIdDecisions[1].id = '../unsafe';
    expect(() => validateAuthLossModeProducerArtifact(unsafeId)).toThrow(/unsafe sample id/i);

    const copiedEvidence = clone(safeArtifact()) as Record<string, unknown>;
    copiedEvidence.redaction = { rawIdentifiersAllowed: false, evidenceCopied: true };
    expect(() => validateAuthLossModeProducerArtifact(copiedEvidence)).toThrow(/redaction/i);
  });

  it('rejects unknown enums and mode-1 relink close edges on non-relink buckets', () => {
    const unknownReason = clone(safeArtifact()) as Record<string, unknown>;
    const unknownReasonDecisions = unknownReason.decisions as Array<Record<string, unknown>>;
    unknownReasonDecisions[1].reason = 'surprise';
    expect(() => validateAuthLossModeProducerArtifact(unknownReason)).toThrow(/must be one of/i);

    const relinkRegistration = clone(safeArtifact()) as Record<string, unknown>;
    const relinkRegistrationDecision = ((relinkRegistration.decisions as Array<Record<string, unknown>>)[1].decision) as Record<string, unknown>;
    relinkRegistrationDecision.closeEdge = 'WA_AUTH_BOND_RELINK_VERIFIED';
    expect(() => validateAuthLossModeProducerArtifact(relinkRegistration)).toThrow(/registration_blocked/i);

    const relinkLine = clone(safeArtifact()) as Record<string, unknown>;
    const relinkLineDecision = ((relinkLine.decisions as Array<Record<string, unknown>>)[2].decision) as Record<string, unknown>;
    relinkLineDecision.closeEdge = 'WA_AUTH_BOND_RELINK_VERIFIED';
    expect(() => validateAuthLossModeProducerArtifact(relinkLine)).toThrow(/line_quarantined/i);
  });
});
