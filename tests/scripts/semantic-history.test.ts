import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { BoundaryAction } from '../../scripts/lib/semantic-quality/boundary-types.ts';
import {
  buildProposalIdentity,
  taskFingerprintSha256,
  type PathBlobRecord,
  type ProposalIdentity,
} from '../../scripts/lib/semantic-quality/fingerprint.ts';
import { evaluateHistory, type ReentryPacket } from '../../scripts/lib/semantic-quality/history.ts';
import type { HistoryCollection } from '../../scripts/lib/semantic-quality/history-provider.ts';
import type {
  DispositionRecord,
  HistoryArtifactRecord,
} from '../../scripts/lib/semantic-quality/history-types.ts';

const REPOSITORY = 'LucasQuiles/WhatSoup';
const NOW = new Date('2026-07-16T06:00:00Z');
const DEFAULT_BASE = '7777777777777777777777777777777777777777';
const DEFAULT_HEAD = '8888888888888888888888888888888888888888';

interface FixtureArtifact extends HistoryArtifactRecord {
  baseOid?: string;
  headOid?: string;
  reentry?: ReentryPacket;
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/boundary-core/history.json', import.meta.url)),
    'utf8',
  ),
) as { artifacts: FixtureArtifact[] };

function fixtureArtifact(number: number): FixtureArtifact {
  const match = fixture.artifacts.find((item) => item.number === number);
  if (!match) throw new Error(`missing fixture artifact ${number}`);
  return { ...structuredClone(match), repository: REPOSITORY };
}

function collection(
  artifacts: HistoryArtifactRecord[],
  overrides: Partial<HistoryCollection> = {},
): HistoryCollection {
  return {
    repository: REPOSITORY,
    observedAt: ['2026-07-16T05:00:00Z'],
    artifacts,
    pageCount: 1,
    complete: true,
    limitations: [],
    ...overrides,
  };
}

type Candidate = ProposalIdentity & { pathBlobSet: PathBlobRecord[] };

function candidate(input: {
  records: PathBlobRecord[];
  patchIdStable?: string | null;
  baseOid?: string;
  headOid?: string;
  task?: { title: string; body: string };
}): Candidate {
  return {
    ...buildProposalIdentity({
      records: input.records,
      patchIdStable: input.patchIdStable,
      baseOid: input.baseOid ?? DEFAULT_BASE,
      headOid: input.headOid ?? DEFAULT_HEAD,
      task: input.task,
    }),
    pathBlobSet: structuredClone(input.records),
  };
}

function candidateFromArtifact(artifact: FixtureArtifact): Candidate {
  if (!artifact.pathBlobSet) throw new Error(`fixture artifact ${artifact.number} has no path blobs`);
  return candidate({
    records: artifact.pathBlobSet,
    patchIdStable: artifact.patchIdStable,
    baseOid: artifact.baseOid,
    headOid: artifact.headOid,
  });
}

function evaluate(input: {
  action?: BoundaryAction;
  candidate: Candidate;
  artifacts: HistoryArtifactRecord[];
  reentry?: ReentryPacket | null;
  collectionOverrides?: Partial<HistoryCollection>;
}) {
  return evaluateHistory({
    action: input.action ?? 'open-pr',
    candidate: input.candidate,
    collection: collection(input.artifacts, input.collectionOverrides),
    reentry: input.reentry,
    now: NOW,
  });
}

function ruleIds(findings: ReturnType<typeof evaluate>): string[] {
  return findings.map((finding) => finding.ruleId);
}

describe('exact and related history classification', () => {
  it('blocks exact open content and routes the agent to the existing pull request', () => {
    const prior = fixtureArtifact(1838);
    prior.state = 'open';

    const findings = evaluate({ candidate: candidateFromArtifact(prior), artifacts: [prior] });

    expect(findings).toEqual([
      {
        ruleId: 'history.exact-open-pr',
        decision: 'block',
        action: 'open-pr',
        summary: 'Candidate content exactly matches 1 open pull request.',
        why: 'The canonical changed path/blob identity is identical, independent of branch or proposal identity.',
        observed: [
          {
            label: 'content_fingerprint_sha256',
            value: '1e27927ab1b22973ecca0d38f41b17293e1cf6a6e2303098f5fb8db9064b3479',
          },
          { label: 'match_count', value: '1' },
        ],
        matchedArtifacts: [
          {
            kind: 'pull-request',
            repository: REPOSITORY,
            id: '1838',
            url: prior.url,
            state: 'open',
            fingerprintSha256:
              '1e27927ab1b22973ecca0d38f41b17293e1cf6a6e2303098f5fb8db9064b3479',
          },
        ],
        correction: [
          'Continue through the existing open pull request instead of creating another artifact.',
          'If the work is materially different, change the implementation and rerun the boundary check.',
        ],
        rerun: 'npm run verify:boundary',
        sourceRefs: [prior.url],
      },
    ]);
  });

  it('groups recreated exact closed content deterministically and suppresses weaker overlap', () => {
    const first = fixtureArtifact(1838);
    const second = fixtureArtifact(1848);

    const findings = evaluate({
      candidate: candidateFromArtifact(first),
      artifacts: [second, first],
    });

    expect(ruleIds(findings)).toEqual(['history.exact-closed-pr']);
    expect(findings[0]).toMatchObject({
      decision: 'block',
      action: 'open-pr',
      matchedArtifacts: [{ id: '1838' }, { id: '1848' }],
      observed: expect.arrayContaining([{ label: 'match_count', value: '2' }]),
    });
  });

  it('cites the recorded disposition on exact closed content', () => {
    const prior = fixtureArtifact(1857);

    const findings = evaluate({ candidate: candidateFromArtifact(prior), artifacts: [prior] });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'history.exact-closed-pr',
      decision: 'block',
      observed: expect.arrayContaining([
        { label: 'prior_disposition_1857', value: 'duplicate-existing-mechanism' },
      ]),
      correction: expect.arrayContaining([
        expect.stringMatching(/recorded disposition.*material re-entry packet/i),
      ]),
    });
  });

  it('blocks a stable patch match after paths were renamed', () => {
    const prior = fixtureArtifact(1838);
    const renamed = candidate({
      records: prior.pathBlobSet!.map((record) => ({
        ...record,
        path: `recreated/${record.path}`,
      })),
      patchIdStable: prior.patchIdStable,
    });

    const findings = evaluate({ candidate: renamed, artifacts: [prior] });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'history.renamed-patch-closed-pr',
        decision: 'block',
        matchedArtifacts: [expect.objectContaining({ id: '1838' })],
      }),
    ]);
  });

  it('warns on exact merged content and requests current-main reachability proof', () => {
    const prior = fixtureArtifact(1900);

    const findings = evaluate({ candidate: candidateFromArtifact(prior), artifacts: [prior] });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'history.exact-merged-pr',
        decision: 'warn',
        correction: expect.arrayContaining([expect.stringMatching(/current main.*reachability/i)]),
      }),
    ]);
  });

  it('warns on candidate-subset and prior-subset blob reuse', () => {
    const one: PathBlobRecord = {
      status: 'modified',
      path: 'src/lib/shared.ts',
      blobOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const two: PathBlobRecord = {
      status: 'modified',
      path: 'src/lib/other.ts',
      blobOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const three: PathBlobRecord = {
      status: 'modified',
      path: 'src/lib/third.ts',
      blobOid: 'cccccccccccccccccccccccccccccccccccccccc',
    };
    const artifacts = [
      { ...fixtureArtifact(1838), number: 2001, pathBlobSet: [one] },
      { ...fixtureArtifact(1848), number: 2002, pathBlobSet: [one, two, three] },
    ];

    const findings = evaluate({ candidate: candidate({ records: [one, two] }), artifacts });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'history.blob-subset',
        decision: 'warn',
        matchedArtifacts: [expect.objectContaining({ id: '2001' }), expect.objectContaining({ id: '2002' })],
      }),
    ]);
  });

  it('warns on full-path overlap without treating a same filename as overlap', () => {
    const overlap = fixtureArtifact(1901);
    overlap.number = 1902;
    overlap.url = `https://github.com/${REPOSITORY}/pull/1902`;
    overlap.pathBlobSet = [
      {
        status: 'modified',
        path: 'src/lib/shared-refactor.ts',
        blobOid: '9999999999999999999999999999999999999999',
      },
    ];
    const sameFilename = fixtureArtifact(1901);

    const findings = evaluate({
      candidate: candidate({
        records: [
          {
            status: 'modified',
            path: 'src/lib/shared-refactor.ts',
            blobOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      }),
      artifacts: [sameFilename, overlap],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'history.path-overlap',
        decision: 'warn',
        matchedArtifacts: [expect.objectContaining({ id: String(overlap.number) })],
      }),
    ]);
  });

  it('does not block a shared branch label, same filename, or title-only similarity', () => {
    const sameFilename = fixtureArtifact(1901);
    const titleOnlyIssue: HistoryArtifactRecord = {
      repository: REPOSITORY,
      kind: 'issue',
      number: 2003,
      state: 'open',
      url: `https://github.com/${REPOSITORY}/issues/2003`,
      taskFingerprintSha256: taskFingerprintSha256({
        title: 'Prevent duplicate issue',
        body: 'A different acceptance criterion.',
      }),
    };
    const proposal = candidate({
      records: [
        {
          status: 'added',
          path: 'src/shared-refactor.ts',
          blobOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
      task: {
        title: 'Prevent duplicate issue',
        body: 'Reuse the existing issue owner.',
      },
    });

    expect(
      evaluate({ candidate: proposal, artifacts: [sameFilename, titleOnlyIssue] }),
    ).toEqual([]);
  });

  it.each([
    ['open-issue' as const, 'block'],
    ['open-pr' as const, 'warn'],
  ])('classifies exact issue identity as %s context for the requested action', (action, decision) => {
    const prior = fixtureArtifact(1783);
    const proposal = candidate({
      records: [
        {
          status: 'modified',
          path: 'docs/issue-context.md',
          blobOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
      task: {
        title: 'Prevent duplicate issue',
        body: 'Reuse the existing issue owner.',
      },
    });

    const findings = evaluate({ action, candidate: proposal, artifacts: [prior] });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'history.exact-issue',
        decision,
        action,
        matchedArtifacts: [expect.objectContaining({ id: '1783' })],
      }),
    ]);
  });

  it('returns one inconclusive finding before using partial provider evidence', () => {
    const prior = fixtureArtifact(1838);

    const findings = evaluate({
      candidate: candidateFromArtifact(prior),
      artifacts: [prior],
      collectionOverrides: {
        complete: false,
        limitations: ['history.page-limit: maxPages=20 reached while a cursor remains'],
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'history.evidence-incomplete',
        decision: 'inconclusive',
        observed: [
          {
            label: 'limitation',
            value: 'history.page-limit: maxPages=20 reached while a cursor remains',
          },
        ],
        matchedArtifacts: [],
      }),
    ]);
  });
});

describe('disposition-aware re-entry', () => {
  const prior = fixtureArtifact(1857);
  const disposition = prior.disposition as DispositionRecord;
  const priorUrl = prior.url;
  const materialCandidate = candidate({
    records: [
      ...prior.pathBlobSet!,
      {
        status: 'modified',
        path: 'src/runtimes/agent/runtime.ts',
        blobOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
  });

  function packet(overrides: Partial<ReentryPacket> = {}): ReentryPacket {
    return {
      priorArtifactRefs: [priorUrl],
      addressedConditions: [...disposition.reentryConditions],
      deltaKind: 'material',
      productionOwner: 'src/runtimes/agent/runtime.ts',
      ...overrides,
    };
  }

  function scopedOverride(overrides: Partial<NonNullable<ReentryPacket['override']>> = {}) {
    return {
      owner: 'repository-owner',
      ruleId: 'history.incomplete-reentry',
      fingerprintSha256: materialCandidate.proposalFingerprintSha256,
      reason: 'Reviewed exception for this exact proposal.',
      expiresAt: '2026-07-16T07:00:00Z',
      sourceRef: priorUrl,
      ...overrides,
    };
  }

  it('blocks cosmetic fixture-only re-entry after an architectural disposition', () => {
    const findings = evaluate({
      action: 'reopen-pr',
      candidate: candidateFromArtifact(prior),
      artifacts: [prior],
      reentry: prior.reentry,
    });

    expect(ruleIds(findings)).toEqual([
      'history.exact-closed-pr',
      'history.incomplete-reentry',
    ]);
    expect(findings[1]).toMatchObject({
      decision: 'block',
      observed: expect.arrayContaining([
        { label: 'delta_kind', value: 'fixture-hygiene' },
        { label: 'prior_disposition_1857', value: 'duplicate-existing-mechanism' },
      ]),
    });
  });

  it('blocks a material re-entry packet that omits a condition and production owner', () => {
    const findings = evaluate({
      action: 'reopen-pr',
      candidate: materialCandidate,
      artifacts: [prior],
      reentry: packet({
        addressedConditions: [disposition.reentryConditions[0]!],
        productionOwner: null,
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'history.blob-subset',
        decision: 'warn',
      }),
      expect.objectContaining({
        ruleId: 'history.incomplete-reentry',
        decision: 'block',
        observed: expect.arrayContaining([
          { label: 'missing_condition', value: disposition.reentryConditions[1] },
          { label: 'production_owner', value: 'missing' },
        ]),
      }),
    ]);
  });

  it('accepts material re-entry only when every condition, artifact, and owner is named', () => {
    const findings = evaluate({
      action: 'reopen-pr',
      candidate: materialCandidate,
      artifacts: [prior],
      reentry: packet(),
    });

    expect(ruleIds(findings)).not.toContain('history.incomplete-reentry');
    expect(findings).toEqual([expect.objectContaining({ ruleId: 'history.blob-subset' })]);
  });

  it('accepts a valid exact-scope owner override without granting an ambient bypass', () => {
    const findings = evaluate({
      action: 'reopen-pr',
      candidate: materialCandidate,
      artifacts: [prior],
      reentry: packet({
        addressedConditions: [],
        deltaKind: 'fixture-hygiene',
        productionOwner: null,
        override: scopedOverride(),
      }),
    });

    expect(ruleIds(findings)).not.toContain('history.incomplete-reentry');
  });

  it.each([
    ['expired', { expiresAt: '2026-07-16T06:00:00Z' }],
    ['dated with an impossible future day', { expiresAt: '2027-02-30T07:00:00Z' }],
    ['wrong rule', { ruleId: 'history.exact-closed-pr' }],
    ['wrong fingerprint', { fingerprintSha256: 'f'.repeat(64) }],
    ['ownerless', { owner: '' }],
    ['unreferenced', { sourceRef: 'https://github.com/LucasQuiles/WhatSoup/pull/9999' }],
  ])('blocks an otherwise scoped override when it is %s', (_label, overrideChange) => {
    const findings = evaluate({
      action: 'reopen-pr',
      candidate: materialCandidate,
      artifacts: [prior],
      reentry: packet({
        addressedConditions: [],
        deltaKind: 'fixture-hygiene',
        productionOwner: null,
        override: scopedOverride(overrideChange),
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'history.blob-subset',
      }),
      expect.objectContaining({
        ruleId: 'history.incomplete-reentry',
        decision: 'block',
      }),
    ]);
  });
});
