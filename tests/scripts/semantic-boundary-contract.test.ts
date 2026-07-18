import { expect, it } from 'vitest';

import {
  BoundaryContractError,
  DEFAULT_BOUNDARY_BUDGETS,
  canonicalBoundaryFinding,
  canonicalBoundaryLimitations,
  canonicalBoundaryTarget,
  canonicalEnforcementMode,
} from '../../scripts/lib/semantic-quality/boundary-contract.ts';
import {
  buildBoundaryReceipt,
  parseBoundaryReceipt,
  renderSemanticReceipt,
  semanticExitCode,
} from '../../scripts/lib/semantic-quality/receipt.ts';
import { evidenceStateForRule } from '../../scripts/lib/semantic-quality/rule-guidance.ts';
import type {
  BoundaryAction,
  BoundaryFindingInput,
} from '../../scripts/lib/semantic-quality/boundary-types.ts';

const OID40 = 'a'.repeat(40);
const OID64 = 'b'.repeat(64);
const VALID_FINDING: BoundaryFindingInput = {
  ruleId: 'semantic.production-reachability',
  decision: 'block',
  action: 'push',
  evidenceState: evidenceStateForRule('semantic.production-reachability'),
  summary: 'A production module is unreachable from the runtime entry graph.',
  why: 'Unreachable production behavior cannot satisfy its claimed runtime contract.',
  observed: [{ label: 'module', value: 'src/example.ts' }],
  matchedArtifacts: [{
    kind: 'path', repository: 'LucasQuiles/WhatSoup', id: 'src/example.ts',
  }],
  limitations: [],
};

const target = (actionTarget: string, headOid: string | null = OID40) => ({
  repository: 'LucasQuiles/WhatSoup',
  actionTarget,
  headOid,
});

const unmet = (id: string): string => `BCF_EXPECTATION_UNMET:BCF03-${id}`;

const proveUnsafe = (id: string, assertion: () => void): void => {
  try {
    assertion();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${unmet(id)}: ${message}`, { cause: error });
  }
};

it('[BCF03-U01] canonicalizes a complete finding with catalog guidance', () => {
  proveUnsafe('01', () => {
    expect(canonicalBoundaryFinding(VALID_FINDING)).toMatchObject({
      ruleId: VALID_FINDING.ruleId,
      decision: 'block',
      ruleVersion: 1,
      evidenceState: 'observed',
      findingDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

it('[BCF03-U02] rejects invalid finding enums and blank identities', () => {
  proveUnsafe('02', () => {
    for (const overrides of [
      { decision: 'pass' },
      { decision: 'allow' },
      { action: 'deploy' },
      { ruleId: '   ' },
    ]) {
      expect(() => canonicalBoundaryFinding({ ...VALID_FINDING, ...overrides } as never))
        .toThrow(BoundaryContractError);
    }
  });
});

it('[BCF03-U03] rejects blank evidence and producer-owned guidance overrides', () => {
  proveUnsafe('03', () => {
    for (const overrides of [
      { observed: [{ label: ' ', value: 'unsafe' }] },
      { observed: [{ label: 'state', value: ' ' }] },
      { correction: ['fix it'] },
      { rerun: 'npm test' },
      { sourceRefs: ['x'] },
    ]) {
      expect(() => canonicalBoundaryFinding({ ...VALID_FINDING, ...overrides } as never))
        .toThrow(BoundaryContractError);
    }
  });
});

it('[BCF03-U04] accepts every exact public action-target grammar', () => {
  const cases: Array<[BoundaryAction, unknown]> = [
    ['commit', target(`commit:${OID40}`)],
    ['push', target('ref:refs/heads/main')],
    ['open-pr', target('pr-create:refs/heads/main..refs/heads/feature')],
    ['reopen-pr', target('pr:17')],
    ['update-pr', target('pr:18')],
    ['merge', target('pr:19')],
    ['open-issue', target(`task:${OID64}`)],
    ['tag', target('tag:refs/tags/v1.2.3')],
    ['release', target('release:refs/tags/v1.2.3')],
    ['config-write', target(`config:${OID64}`, null)],
  ];
  proveUnsafe('04', () => {
    for (const [action, input] of cases) {
      expect(() => canonicalBoundaryTarget(action, input)).not.toThrow();
    }
  });
});

it('[BCF03-U05] rejects malformed repositories, targets, refs, and candidate OIDs', () => {
  proveUnsafe('05', () => {
    for (const [action, input] of [
      ['push', { ...target('ref:refs/heads/main'), repository: 'foreign/repo' }],
      ['push', target('')],
      ['push', target('ref:main')],
      ['push', target('ref:refs/heads/bad..ref')],
      ['commit', target(`commit:${OID40.toUpperCase()}`)],
      ['commit', target(`commit:${'a'.repeat(39)}`)],
      ['open-pr', target('pr-create:refs/heads/main...refs/heads/feature')],
      ['reopen-pr', target('pr:0')],
      ['config-write', target(`config:${OID64}`, OID40)],
    ] as Array<[BoundaryAction, unknown]>) {
      expect(() => canonicalBoundaryTarget(action, input)).toThrow(BoundaryContractError);
    }
  });
});

it('[BCF03-U06] keeps mutation targets distinct from the same candidate head', () => {
  proveUnsafe('06', () => {
    const main = canonicalBoundaryTarget('push', target('ref:refs/heads/main'));
    const release = canonicalBoundaryTarget('push', target('ref:refs/heads/release'));
    expect(main.actionTarget).not.toBe(release.actionTarget);
    expect(main.headOid).toBe(release.headOid);
  });
});

it('[BCF03-U07] closes enforcement mode at runtime', () => {
  proveUnsafe('07', () => {
    expect(canonicalEnforcementMode('shadow')).toBe('shadow');
    expect(canonicalEnforcementMode('enforce')).toBe('enforce');
    expect(() => canonicalEnforcementMode('audit')).toThrow(BoundaryContractError);
    expect(() => canonicalEnforcementMode(null)).toThrow(BoundaryContractError);
  });
});

it('[BCF03-U08] replaces complete secret, URL-query, file, and local-path scalars', () => {
  proveUnsafe('08', () => {
    const built = canonicalBoundaryFinding({
      ...VALID_FINDING,
      summary: ['file:', '', '', 'Users', 'operator', 'private', 'report.txt'].join('/'),
      why: 'Inspect (/private/tmp/agent-output.log) before continuing.',
      observed: [
        { label: 'secret', value: 'API_TOKEN=abcdefghijklmnop' },
        { label: 'source', value: 'https://example.com/a?token=value' },
      ],
    });
    expect(built.summary).toBe('redacted-local-reference');
    expect(built.why).toBe('redacted-local-reference');
    expect(built.observed.find(({ label }) => label === 'secret')?.value)
      .toBe('redacted-sensitive-value');
    expect(built.observed.find(({ label }) => label === 'source')?.value)
      .toBe('redacted-credential-url');
  });
});

it('[BCF03-U09] makes finding limitations inconclusive and evidence-bound', () => {
  proveUnsafe('09', () => {
    const built = canonicalBoundaryFinding({
      ...VALID_FINDING,
      limitations: ['the comparison provider did not return a terminal page'],
    });
    expect(built.decision).toBe('inconclusive');
    expect(built.limitations).toHaveLength(1);
    expect(built.findingDigestSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

it('[BCF03-U10] enforces public text and limitation budgets before allocation', () => {
  proveUnsafe('10', () => {
    expect(() => canonicalBoundaryFinding({ ...VALID_FINDING, summary: 'x'.repeat(513) }))
      .toThrow(/boundary.evidence-volume-exceeded/);
    expect(() => canonicalBoundaryLimitations(
      Array.from({ length: 17 }, (_, index) => `limit-${index}`),
    )).toThrow(/boundary.evidence-volume-exceeded/);
  });
});

it('[BCF03-S01] exposes the compile-safe boundary contract placeholder', () => {
  expect(canonicalBoundaryFinding).toBeTypeOf('function');
});

it('[BCF03-N01] preserves the complete neighboring finding', () => {
  expect(canonicalBoundaryFinding(VALID_FINDING)).toMatchObject({ decision: 'block', ruleVersion: 1 });
});

it('[BCF03-N02] accepts lowercase 40- and 64-hex commit identities', () => {
  expect(canonicalBoundaryTarget('commit', target(`commit:${OID40}`)).headOid).toBe(OID40);
  expect(canonicalBoundaryTarget('commit', target(`commit:${OID64}`, OID64)).headOid).toBe(OID64);
});

it('[BCF03-N03] accepts two valid full push refs at one head', () => {
  expect(canonicalBoundaryTarget('push', target('ref:refs/heads/main')).actionTarget)
    .not.toBe(canonicalBoundaryTarget('push', target('ref:refs/heads/next')).actionTarget);
});

it('[BCF03-N04] accepts distinct pull-request creation ref pairs', () => {
  expect(canonicalBoundaryTarget('open-pr', target(
    'pr-create:refs/heads/main..refs/heads/feature-a',
  )).actionTarget).not.toBe(canonicalBoundaryTarget('open-pr', target(
    'pr-create:refs/heads/main..refs/heads/feature-b',
  )).actionTarget);
});

it('[BCF03-N05] accepts positive pull-request identities for existing-PR actions', () => {
  for (const action of ['reopen-pr', 'update-pr', 'merge'] as const) {
    expect(canonicalBoundaryTarget(action, target('pr:42')).actionTarget).toBe('pr:42');
  }
});

it('[BCF03-N06] accepts a task fingerprint for issue creation', () => {
  expect(canonicalBoundaryTarget('open-issue', target(`task:${OID64}`)).actionTarget)
    .toBe(`task:${OID64}`);
});

it('[BCF03-N07] accepts full tag and release refs', () => {
  expect(canonicalBoundaryTarget('tag', target('tag:refs/tags/v2.0.0')).actionTarget)
    .toBe('tag:refs/tags/v2.0.0');
  expect(canonicalBoundaryTarget('release', target('release:refs/tags/v2.0.0')).actionTarget)
    .toBe('release:refs/tags/v2.0.0');
});

it('[BCF03-N08] accepts a separately resolved config identity without a Git head', () => {
  expect(canonicalBoundaryTarget('config-write', target(`config:${OID64}`, null))).toEqual(
    target(`config:${OID64}`, null),
  );
});

it('[BCF03-N09] canonicalizes at-limit top-level limitations', () => {
  const values = Array.from({ length: DEFAULT_BOUNDARY_BUDGETS.maxTopLevelLimitations },
    (_, index) => `provider limitation ${index}`);
  expect(canonicalBoundaryLimitations(values)).toEqual(values);
});

it('[BCF03-N10] keeps finding identity stable across summary-only changes', () => {
  const baseline = canonicalBoundaryFinding(VALID_FINDING);
  const changed = canonicalBoundaryFinding({ ...VALID_FINDING, summary: 'Different public prose.' });
  expect(changed.findingDigestSha256).toBe(baseline.findingDigestSha256);
});

const RECEIPT_OBSERVED_AT = '2026-07-17T12:00:00.000Z';
const RECEIPT_INPUT = {
  invocation: 'boundary-history',
  action: 'push',
  target: target('ref:refs/heads/main'),
  observedAt: RECEIPT_OBSERVED_AT,
  validUntil: null,
  enforcementMode: 'enforce',
  base: {
    headOid: OID40,
    baseOid: OID40,
    mergeBaseOid: OID40,
    evidenceSource: 'git:boundary-contract-fixture',
  },
  fingerprints: {},
  findings: [VALID_FINDING],
  limitations: [],
};

const LEGACY_FINDING = {
  ruleId: 'semantic.production-reachability',
  decision: 'warn',
  action: 'push',
  summary: 'Legacy summary.',
  why: 'Legacy rationale.',
  observed: [{ label: 'path', value: 'src/legacy.ts' }],
  matchedArtifacts: [],
  correction: ['Connect the production owner.'],
  rerun: 'npm run verify:semantic',
  sourceRefs: ['git:legacy-fixture'],
} as const;

const buildReceipt = (overrides: Record<string, unknown> = {}) => buildBoundaryReceipt({
  ...RECEIPT_INPUT,
  ...overrides,
} as never);

const receiptField = (receipt: unknown, field: string): unknown =>
  (receipt as Record<string, unknown>)[field];

const proveReceiptUnsafe = (id: string, assertion: () => void): void => {
  try {
    assertion();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`BCF_EXPECTATION_UNMET:BCF04-${id}: ${message}`, { cause: error });
  }
};

it('[BCF04-U01] emits the exact schema-two evidence receipt', () => {
  proveReceiptUnsafe('01', () => {
    const built = buildReceipt();
    expect(built.schemaVersion).toBe(2);
    expect(receiptField(built, 'target')).toEqual(RECEIPT_INPUT.target);
    expect(receiptField(built, 'evidenceDigestSha256')).toMatch(/^[0-9a-f]{64}$/);
  });
});

it('[BCF04-U02] makes a warning plus collection limitation inconclusive', () => {
  proveReceiptUnsafe('02', () => {
    const built = buildReceipt({
      findings: [{ ...VALID_FINDING, decision: 'warn' }],
      limitations: ['history page two did not complete'],
    });
    expect(built.decision).toBe('inconclusive');
    expect(semanticExitCode(built)).toBe(2);
  });
});

it('[BCF04-U03] weakens a finding only when its own evidence is limited', () => {
  proveReceiptUnsafe('03', () => {
    const built = buildReceipt({
      findings: [{ ...VALID_FINDING, limitations: ['comparison unavailable'] }],
    });
    expect(built.findings[0]?.decision).toBe('inconclusive');
    expect(built.decision).toBe('inconclusive');
  });
});

it('[BCF04-U04] binds evidence changes but excludes summary prose from the digest', () => {
  proveReceiptUnsafe('04', () => {
    const baseline = buildReceipt();
    const changedEvidence = buildReceipt({ limitations: ['different limitation'] });
    const changedSummary = buildReceipt({
      findings: [{ ...VALID_FINDING, summary: 'Different public prose.' }],
    });
    expect(receiptField(changedEvidence, 'evidenceDigestSha256'))
      .not.toBe(receiptField(baseline, 'evidenceDigestSha256'));
    expect(receiptField(changedSummary, 'evidenceDigestSha256'))
      .toBe(receiptField(baseline, 'evidenceDigestSha256'));
  });
});

it('[BCF04-U05] rejects duplicate finding identities independent of input order', () => {
  proveReceiptUnsafe('05', () => {
    expect(() => buildReceipt({ findings: [VALID_FINDING, structuredClone(VALID_FINDING)] }))
      .toThrow(BoundaryContractError);
  });
});

it('[BCF04-U06] binds action target independently from the candidate head', () => {
  proveReceiptUnsafe('06', () => {
    const main = buildReceipt({ target: target('ref:refs/heads/main') });
    const release = buildReceipt({ target: target('ref:refs/heads/release') });
    expect(receiptField(main, 'evidenceDigestSha256'))
      .not.toBe(receiptField(release, 'evidenceDigestSha256'));
  });
});

it('[BCF04-U07] rejects producer-owned enforcement and overflow fields', () => {
  proveReceiptUnsafe('07', () => {
    expect(() => buildReceipt({ enforcementMode: 'audit' })).toThrow(BoundaryContractError);
    expect(() => buildReceipt({ overflow: { reason: 'caller-owned' } }))
      .toThrow(BoundaryContractError);
  });
});

it('[BCF04-U08] canonicalizes offset timestamps and rejects reverse validity', () => {
  proveReceiptUnsafe('08', () => {
    const built = buildReceipt({ observedAt: '2026-07-17T08:00:00-04:00' });
    expect(receiptField(built, 'observedAt')).toBe(RECEIPT_OBSERVED_AT);
    expect(() => buildReceipt({
      observedAt: RECEIPT_OBSERVED_AT,
      validUntil: '2026-07-17T11:59:59.000Z',
    })).toThrow(BoundaryContractError);
  });
});

it('[BCF04-U09] rejects unknown producer keys instead of storing a malicious receipt', () => {
  proveReceiptUnsafe('09', () => {
    expect(() => buildReceipt({ ruleCatalogDigestSha256: OID64 }))
      .toThrow(BoundaryContractError);
  });
});

it('[BCF04-S01] preserves the frozen schema-one renderer', () => {
  const legacy = {
    schemaVersion: 1,
    repository: 'LucasQuiles/WhatSoup',
    invocation: 'legacy-fixture',
    action: 'push',
    correlationIdSha256: OID64,
    enforcementMode: 'enforce',
    decision: 'warn',
    base: {
      headOid: OID40,
      baseOid: OID40,
      mergeBaseOid: OID40,
      evidenceSource: 'git:legacy-fixture',
    },
    fingerprints: {},
    findings: [LEGACY_FINDING],
    limitations: [],
  };
  const parsed = parseBoundaryReceipt(JSON.parse(JSON.stringify(legacy)) as unknown);
  expect(parsed).toEqual(legacy);
  const output = renderSemanticReceipt(parsed);
  expect(output).toContain('WARN [semantic.production-reachability] while push');
  expect(() => parseBoundaryReceipt({ ...legacy, deployment: 'production' }))
    .toThrow(BoundaryContractError);
});

it('[BCF04-N01] accepts a complete schema-two warning receipt', () => {
  const built = buildReceipt({ findings: [{ ...VALID_FINDING, decision: 'warn' }] });
  expect(built).toMatchObject({ schemaVersion: 2, decision: 'warn' });
  expect(parseBoundaryReceipt(JSON.parse(JSON.stringify(built)) as unknown)).toEqual(built);
  expect(() => parseBoundaryReceipt({ ...built, evidenceDigestSha256: OID64 }))
    .toThrow(BoundaryContractError);
  expect(() => parseBoundaryReceipt({ ...built, deployment: 'production' }))
    .toThrow(BoundaryContractError);
});

it('[BCF04-N02] preserves a complete block despite an unrelated collection limitation', () => {
  const built = buildReceipt({ limitations: ['history summary is incomplete'] });
  expect(built.decision).toBe('block');
});

it('[BCF04-N03] preserves evidence identity across summary-only changes', () => {
  const baseline = buildReceipt();
  const changed = buildReceipt({
    findings: [{ ...VALID_FINDING, summary: 'Different summary prose.' }],
  });
  expect(receiptField(changed, 'evidenceDigestSha256'))
    .toBe(receiptField(baseline, 'evidenceDigestSha256'));
});

it('[BCF04-N04] is byte-stable when distinct findings are reversed', () => {
  const second = {
    ...VALID_FINDING,
    ruleId: 'semantic.export-ownership',
    evidenceState: evidenceStateForRule('semantic.export-ownership'),
    summary: 'A runtime export has no production owner.',
  };
  expect(JSON.stringify(buildReceipt({ findings: [VALID_FINDING, second] })))
    .toBe(JSON.stringify(buildReceipt({ findings: [second, VALID_FINDING] })));
});

it('[BCF04-N05] accepts only both closed enforcement modes', () => {
  expect(canonicalEnforcementMode('shadow')).toBe('shadow');
  expect(canonicalEnforcementMode('enforce')).toBe('enforce');
});

it('[BCF04-N06] accepts and preserves a canonical UTC observation timestamp', () => {
  expect(receiptField(buildReceipt(), 'observedAt')).toBe(RECEIPT_OBSERVED_AT);
});

it('[BCF04-N07] canonicalizes a neighboring positive UTC offset', () => {
  expect(receiptField(
    buildReceipt({ observedAt: '2026-07-17T14:00:00+02:00' }),
    'observedAt',
  )).toBe(RECEIPT_OBSERVED_AT);
});

it('[BCF04-N08] accepts lowercase 40- and 64-hex commit candidate identities', () => {
  for (const oid of [OID40, OID64]) {
    const finding = { ...VALID_FINDING, action: 'commit' };
    const built = buildReceipt({
      action: 'commit',
      target: target(`commit:${oid}`, oid),
      base: { ...RECEIPT_INPUT.base, headOid: oid },
      findings: [finding],
    });
    expect(receiptField(receiptField(built, 'target'), 'headOid')).toBe(oid);
  }
});

it('[BCF04-N09] accepts a resolved config target without a Git candidate head', () => {
  const built = buildReceipt({
    action: 'config-write',
    target: target(`config:${OID64}`, null),
    base: { ...RECEIPT_INPUT.base, headOid: null },
    findings: [{ ...VALID_FINDING, action: 'config-write' }],
  });
  expect(receiptField(receiptField(built, 'target'), 'headOid')).toBeNull();
});
