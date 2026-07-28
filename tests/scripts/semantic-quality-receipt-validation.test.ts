import { describe, expect, it } from 'vitest';

import {
  buildBoundaryReceipt,
  canonicalBoundaryReceiptBytes,
  parseBoundaryReceiptBytes,
  validateBoundaryReceipt,
} from '../../scripts/lib/semantic-quality/receipt.ts';
import { adaptSemanticQuality } from '../../scripts/lib/ci-control/native-adapter.ts';
import { sha256Bytes } from '../../scripts/lib/verification/boundary-run/shared.ts';

const OID = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function finding(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: 'semantic.synthetic',
    decision: 'block',
    action: 'push',
    summary: 'Synthetic semantic finding.',
    why: 'The unsafe fixture must remain blocked at the canonical receipt boundary.',
    observed: [{ label: 'fixture', value: 'unsafe' }],
    matchedArtifacts: [],
    correction: ['Repair the canonical semantic owner.'],
    rerun: 'npm run verify:semantic',
    sourceRefs: ['fixture:semantic-receipt-validation'],
    ...overrides,
  };
}

function receipt() {
  return buildBoundaryReceipt({
    invocation: 'semantic-quality',
    action: 'push',
    enforcementMode: 'enforce',
    base: {
      headOid: OID,
      baseOid: OID,
      mergeBaseOid: OID,
      evidenceSource: 'git-object',
    },
    findings: [finding() as never],
  });
}

function binding(bytes: Uint8Array) {
  return {
    detectorId: 'semantic-quality' as const,
    schemaVersion: 1 as const,
    evidenceDigest: `sha256:${sha256Bytes(bytes)}`,
    policyDigest: DIGEST,
    candidateOid: OID,
    baseOid: OID,
    mergeBaseOid: OID,
    producer: {
      appId: 'expected-app',
      workflowRef: 'owner/repo/.github/workflows/policy.yml@refs/heads/main',
      workflowSha: OID,
      runId: 'run-1',
      attempt: 1,
    },
    platform: { architecture: 'x64', os: 'linux' },
  };
}

describe('canonical semantic receipt validation', () => {
  it('admits exact canonical bytes and keeps the native adapter semantically thin', () => {
    const built = receipt();
    const bytes = canonicalBoundaryReceiptBytes(validateBoundaryReceipt(built));

    expect(parseBoundaryReceiptBytes(bytes)).toEqual(built);
    expect(adaptSemanticQuality(bytes, binding(bytes))).toMatchObject({
      outcome: 'block',
      code: 'ci.native.semantic-quality',
      nativeCauseCodes: ['semantic.synthetic'],
      nativeEvidence: {
        detectorId: 'semantic-quality',
        schemaVersion: 1,
        evidenceDigest: `sha256:${sha256Bytes(bytes)}`,
        nativeCauseCodes: ['semantic.synthetic'],
        policyDigest: DIGEST,
        producer: binding(bytes).producer,
        platform: binding(bytes).platform,
      },
    });
  });

  it('rejects invalid receipt and finding enums instead of collapsing them to pass', () => {
    expect(() => buildBoundaryReceipt({
      invocation: 'semantic-quality',
      action: 'deploy' as never,
      enforcementMode: 'enforce',
      base: { headOid: OID, baseOid: OID, mergeBaseOid: OID, evidenceSource: 'git-object' },
      findings: [finding({ action: 'deploy' }) as never],
    })).toThrow(/action/i);

    expect(() => buildBoundaryReceipt({
      invocation: 'semantic-quality',
      action: 'push',
      enforcementMode: 'enforce',
      base: { headOid: OID, baseOid: OID, mergeBaseOid: OID, evidenceSource: 'git-object' },
      findings: [finding({ decision: 'bogus' }) as never],
    })).toThrow(/decision/i);
  });

  it('rejects unknown nested keys before the adapter can authorize the receipt', () => {
    const built = receipt();
    const unsafe = {
      ...built,
      decision: 'pass',
      findings: [{ ...built.findings[0]!, decision: 'bogus', unexpected: true }],
    };

    expect(() => validateBoundaryReceipt(unsafe)).toThrow(/finding.*keys|keys.*finding/i);
    const bytes = Buffer.from(`${JSON.stringify(unsafe, null, 2)}\n`, 'utf8');
    expect(adaptSemanticQuality(bytes, binding(bytes))).toMatchObject({
      outcome: 'inconclusive',
      code: 'ci.native.receipt-unavailable',
    });
  });

  it('rejects valid semantic content transported with noncanonical bytes', () => {
    const built = receipt();
    const compact = Buffer.from(JSON.stringify(built), 'utf8');

    expect(() => parseBoundaryReceiptBytes(compact)).toThrow(/noncanonical/i);
    expect(adaptSemanticQuality(compact, binding(compact))).toMatchObject({
      outcome: 'inconclusive',
      code: 'ci.native.receipt-unavailable',
    });
  });
});
