import { describe, expect, it } from 'vitest';

import {
  buildBoundaryReceipt,
  canonicalBoundaryReceiptBytes,
  parseBoundaryReceiptBytes,
  validateBoundaryReceipt,
} from '../../scripts/lib/semantic-quality/receipt.ts';

// Receipt-layer scope only: the adapter-side assertions (adaptSemanticQuality)
// require scripts/lib/ci-control/native-adapter.ts and land with that module.

const OID = '0123456789abcdef0123456789abcdef01234567';

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

describe('canonical semantic receipt validation', () => {
  it('admits exact canonical bytes and round-trips them losslessly', () => {
    const built = receipt();
    const bytes = canonicalBoundaryReceiptBytes(validateBoundaryReceipt(built));

    expect(parseBoundaryReceiptBytes(bytes)).toEqual(built);
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

  it('rejects unknown nested keys instead of authorizing the receipt', () => {
    const built = receipt();
    const unsafe = {
      ...built,
      decision: 'pass',
      findings: [{ ...built.findings[0]!, decision: 'bogus', unexpected: true }],
    };

    expect(() => validateBoundaryReceipt(unsafe)).toThrow(/finding.*keys|keys.*finding/i);
  });

  it('rejects valid semantic content transported with noncanonical bytes', () => {
    const built = receipt();
    const compact = Buffer.from(JSON.stringify(built), 'utf8');

    expect(() => parseBoundaryReceiptBytes(compact)).toThrow(/noncanonical/i);
  });
});
