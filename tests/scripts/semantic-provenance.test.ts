import { describe, expect, it } from 'vitest';

import {
  evaluateProvenance,
  type ProvenanceObservation,
} from '../../scripts/lib/semantic-quality/provenance.ts';

const REPOSITORY = 'LucasQuiles/WhatSoup';
const REMOTE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MERGE_BASE = 'cccccccccccccccccccccccccccccccccccccccc';

function observation(overrides: Partial<ProvenanceObservation> = {}): ProvenanceObservation {
  return {
    repository: REPOSITORY,
    remoteTipOid: REMOTE,
    localTrackingOid: REMOTE,
    mergeBaseOid: REMOTE,
    headOid: REMOTE,
    aheadCount: 0,
    behindCount: 0,
    candidatePaths: [],
    upstreamPaths: [],
    highCouplingPaths: ['src/runtimes/agent/runtime.ts'],
    observedAt: '2026-07-16T06:00:00Z',
    evidenceSource: 'git:ls-remote:origin/main',
    complete: true,
    limitations: [],
    ...overrides,
  };
}

describe('upstream provenance evidence validation', () => {
  it('passes when remote, tracking, merge base, counts, and paths prove parity', () => {
    expect(evaluateProvenance({ action: 'push', observation: observation() })).toEqual([]);
  });

  it('returns a situational inconclusive finding when the remote read is unavailable', () => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation({
        remoteTipOid: null,
        complete: false,
        limitations: ['remote tip read timed out'],
      }),
    });

    expect(findings).toEqual([
      {
        ruleId: 'provenance.unavailable',
        decision: 'inconclusive',
        action: 'push',
        evidenceState: 'unavailable',
        summary: 'Upstream provenance could not be proven.',
        why: 'A clean boundary result requires a complete remote tip, tracking ref, merge base, revision count, and path observation.',
        observed: [{ label: 'limitation', value: 'remote tip read timed out' }],
        matchedArtifacts: [],
        limitations: ['remote tip read timed out'],
      },
    ]);
  });

  it('redacts secret-like limitations and credential-bearing source references', () => {
    const secret = ['token', 'abcdefghijklmnop'].join('=');
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation({
        remoteTipOid: null,
        complete: false,
        limitations: [`remote failed with ${secret}`],
        evidenceSource: `https://agent:${secret}@github.com/LucasQuiles/WhatSoup.git?auth=${secret}`,
      }),
    });
    const receiptText = JSON.stringify(findings);

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.unavailable',
        decision: 'inconclusive',
        evidenceState: 'unavailable',
        observed: [{ label: 'limitation', value: 'redacted-sensitive-value' }],
        limitations: ['redacted-sensitive-value'],
      }),
    ]);
    expect(receiptText).not.toContain('abcdefghijklmnop');
    expect(receiptText).not.toContain('?auth=');
  });

  it.each([
    ['candidate paths', { candidatePaths: null }],
    ['upstream paths', { upstreamPaths: null }],
  ])('is inconclusive when %s are incomplete', (_label, change) => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation(change),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.unavailable',
        decision: 'inconclusive',
        observed: [expect.objectContaining({ value: expect.stringMatching(/paths/i) })],
      }),
    ]);
  });

  it('is inconclusive when no merge base was proven', () => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation({ mergeBaseOid: null, aheadCount: null, behindCount: null }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.unavailable',
        decision: 'inconclusive',
        observed: [expect.objectContaining({ value: expect.stringMatching(/merge base/i) })],
      }),
    ]);
  });

  it.each([
    ['remote tip', { remoteTipOid: 'not-an-oid' }],
    ['tracking tip', { localTrackingOid: 'not-an-oid' }],
    ['merge base', { mergeBaseOid: 'not-an-oid' }],
    ['head', { headOid: 'not-an-oid' }],
  ])('is inconclusive for an invalid %s object identity', (_label, change) => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation(change),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.unavailable',
        decision: 'inconclusive',
        observed: [expect.objectContaining({ value: expect.stringMatching(/object identity/i) })],
      }),
    ]);
  });

  it.each([
    ['missing ahead count', { aheadCount: null }],
    ['negative behind count', { behindCount: -1 }],
    ['fractional ahead count', { aheadCount: 1.5 }],
  ])('is inconclusive for a %s', (_label, change) => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation(change),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.unavailable',
        decision: 'inconclusive',
        observed: [expect.objectContaining({ value: expect.stringMatching(/count/i) })],
      }),
    ]);
  });

  it.each([
    ['missing timestamp', { observedAt: null }],
    ['impossible timestamp', { observedAt: '2027-02-30T06:00:00Z' }],
    ['invalid offset', { observedAt: '2026-07-16T06:00:00+24:00' }],
  ])('is inconclusive for a %s', (_label, change) => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation(change),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.unavailable',
        decision: 'inconclusive',
        observed: [expect.objectContaining({ value: expect.stringMatching(/timestamp/i) })],
      }),
    ]);
  });
});

describe('ordered upstream provenance classification', () => {
  const stale = {
    mergeBaseOid: MERGE_BASE,
    headOid: HEAD,
    aheadCount: 2,
    behindCount: 3,
  } satisfies Partial<ProvenanceObservation>;

  it('blocks a stale tracking ref before considering a disjoint path result', () => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation({
        ...stale,
        localTrackingOid: 'dddddddddddddddddddddddddddddddddddddddd',
        candidatePaths: ['src/local.ts'],
        upstreamPaths: ['src/upstream.ts'],
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.stale-tracking-ref',
        decision: 'block',
        observed: expect.arrayContaining([
          { label: 'remote_tip_oid', value: REMOTE },
          {
            label: 'local_tracking_oid',
            value: 'dddddddddddddddddddddddddddddddddddddddd',
          },
        ]),
      }),
    ]);
  });

  it('blocks a stale tracking ref before validating downstream path evidence', () => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation({
        ...stale,
        localTrackingOid: 'dddddddddddddddddddddddddddddddddddddddd',
        candidatePaths: ['src/../outside.ts'],
        upstreamPaths: null,
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.stale-tracking-ref',
        decision: 'block',
      }),
    ]);
  });

  it.each([
    [
      'positive behind count with the remote tip as merge base',
      { mergeBaseOid: REMOTE, headOid: HEAD, aheadCount: 2, behindCount: 3 },
    ],
    [
      'positive ahead count with the head as merge base',
      { mergeBaseOid: HEAD, headOid: HEAD, aheadCount: 2, behindCount: 3 },
    ],
  ])('is inconclusive for inconsistent revision evidence: %s', (_label, change) => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation({
        ...change,
        candidatePaths: ['src/local.ts'],
        upstreamPaths: ['src/upstream.ts'],
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.unavailable',
        decision: 'inconclusive',
        observed: [expect.objectContaining({ value: expect.stringMatching(/count|merge base/i) })],
      }),
    ]);
  });

  it('warns when an older base has a proven disjoint upstream delta', () => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation({
        ...stale,
        candidatePaths: ['src/local/shared.ts'],
        upstreamPaths: ['examples/shared.ts'],
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.stale-disjoint',
        decision: 'warn',
        observed: expect.arrayContaining([
          { label: 'behind_count', value: '3' },
          { label: 'path_overlap', value: 'false' },
        ]),
      }),
    ]);
  });

  it('normalizes paths and blocks a direct upstream overlap', () => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation({
        ...stale,
        candidatePaths: ['./src//transport/outbound-governor.ts'],
        upstreamPaths: ['src/transport/outbound-governor.ts'],
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.stale-overlap',
        decision: 'block',
        observed: expect.arrayContaining([
          {
            label: 'overlap_path',
            value: 'src/transport/outbound-governor.ts',
          },
        ]),
        matchedArtifacts: [
          expect.objectContaining({
            kind: 'path',
            id: 'src/transport/outbound-governor.ts',
          }),
        ],
      }),
    ]);
  });

  it('blocks and names an upstream change on a declared high-coupling surface', () => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation({
        ...stale,
        candidatePaths: ['src/local.ts'],
        upstreamPaths: ['src/runtimes/agent/runtime.ts'],
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.stale-overlap',
        decision: 'block',
        observed: expect.arrayContaining([
          {
            label: 'high_coupling_path',
            value: 'src/runtimes/agent/runtime.ts',
          },
        ]),
      }),
    ]);
  });

  it('passes when the tracking ref is current and the branch is only ahead', () => {
    expect(
      evaluateProvenance({
        action: 'push',
        observation: observation({
          mergeBaseOid: REMOTE,
          headOid: HEAD,
          aheadCount: 2,
          behindCount: 0,
          candidatePaths: ['src/local.ts'],
          upstreamPaths: [],
        }),
      }),
    ).toEqual([]);
  });

  it('is inconclusive when a path cannot be canonicalized safely', () => {
    const findings = evaluateProvenance({
      action: 'push',
      observation: observation({
        ...stale,
        candidatePaths: ['src/../outside.ts'],
        upstreamPaths: ['src/upstream.ts'],
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: 'provenance.unavailable',
        decision: 'inconclusive',
        observed: [expect.objectContaining({ value: expect.stringMatching(/path/i) })],
      }),
    ]);
  });
});
