import { describe, expect, it } from 'vitest';

import {
  collectHistory,
  type HistoryPage,
  type HistoryProvider,
} from '../../scripts/lib/semantic-quality/history-provider.ts';
import type { HistoryArtifactRecord } from '../../scripts/lib/semantic-quality/history-types.ts';

const REPOSITORY = 'LucasQuiles/WhatSoup';
const TASK_FINGERPRINT = 'a'.repeat(64);
const BLOB_OID = 'b'.repeat(40);

function artifact(
  number: number,
  overrides: Partial<HistoryArtifactRecord> = {},
): HistoryArtifactRecord {
  const kind = overrides.kind ?? 'pull-request';
  return {
    repository: REPOSITORY,
    kind,
    number,
    state: 'closed-unmerged',
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
    ...(kind === 'pull-request'
      ? {
          pathBlobSet: [
            {
              status: 'modified' as const,
              path: `src/history/${number}.ts`,
              blobOid: BLOB_OID,
            },
          ],
        }
      : {}),
    taskFingerprintSha256: TASK_FINGERPRINT,
    ...overrides,
  };
}

function page(
  items: HistoryArtifactRecord[],
  nextCursor: string | null,
  overrides: Partial<HistoryPage> = {},
): HistoryPage {
  return {
    repository: REPOSITORY,
    observedAt: '2026-07-16T05:00:00Z',
    items,
    nextCursor,
    ...overrides,
  };
}

function providerFor(pages: HistoryPage[]): {
  provider: HistoryProvider;
  cursors: Array<string | null>;
} {
  const remaining = [...pages];
  const cursors: Array<string | null> = [];
  return {
    cursors,
    provider: {
      async readPage(input) {
        cursors.push(input.cursor);
        const next = remaining.shift();
        if (!next) throw new Error('unexpected provider read');
        return next;
      },
    },
  };
}

function expectBoundedLimitations(limitations: string[]): void {
  expect(limitations.length).toBeGreaterThan(0);
  for (const limitation of limitations) {
    expect(limitation.length).toBeLessThanOrEqual(240);
    expect(limitation).not.toMatch(/[\r\n]/);
  }
}

describe('semantic history provider collection', () => {
  it('collects a complete bounded query and sorts artifacts by kind and number', async () => {
    const fixture = providerFor([
      page([artifact(1848)], 'page-2'),
      page(
        [
          artifact(31, {
            kind: 'issue',
            state: 'open',
            url: `https://github.com/${REPOSITORY}/issues/31`,
          }),
        ],
        'page-3',
        { observedAt: '2026-07-16T05:01:00-04:00' },
      ),
      page([artifact(1838)], null, { observedAt: '2026-07-16T05:02:00Z' }),
    ]);

    const result = await collectHistory({
      repository: REPOSITORY,
      provider: fixture.provider,
      maxPages: 3,
      maxArtifacts: 3,
    });

    expect(result).toEqual({
      repository: REPOSITORY,
      observedAt: ['2026-07-16T05:00:00Z', '2026-07-16T05:01:00-04:00', '2026-07-16T05:02:00Z'],
      artifacts: [
        expect.objectContaining({ kind: 'issue', number: 31 }),
        expect.objectContaining({ kind: 'pull-request', number: 1838 }),
        expect.objectContaining({ kind: 'pull-request', number: 1848 }),
      ],
      pageCount: 3,
      complete: true,
      limitations: [],
    });
    expect(fixture.cursors).toEqual([null, 'page-2', 'page-3']);
  });

  it('retains prior evidence but fails closed when the provider rejects', async () => {
    const syntheticSensitiveValue = ['token', 'abcdefghijklmnop'].join('=');
    const provider: HistoryProvider = {
      async readPage(input) {
        if (input.cursor === null) return page([artifact(1838)], 'page-2');
        throw new Error(`provider failed\n${syntheticSensitiveValue}${'x'.repeat(500)}`);
      },
    };

    const result = await collectHistory({ repository: REPOSITORY, provider });

    expect(result.complete).toBe(false);
    expect(result.pageCount).toBe(1);
    expect(result.artifacts.map((item) => item.number)).toEqual([1838]);
    expect(result.limitations[0]).toMatch(/^history\.provider-failed:/);
    expect(result.limitations.join(' ')).toContain('redacted');
    expect(result.limitations.join(' ')).not.toContain('abcdefghijklmnop');
    expectBoundedLimitations(result.limitations);
  });

  it('rejects a page repository mismatch before accepting its evidence', async () => {
    const fixture = providerFor([
      page([artifact(1838)], 'page-2'),
      page([artifact(1848)], null, { repository: 'Other/Repository' }),
    ]);

    const result = await collectHistory({ repository: REPOSITORY, provider: fixture.provider });

    expect(result.complete).toBe(false);
    expect(result.artifacts.map((item) => item.number)).toEqual([1838]);
    expect(result.observedAt).toEqual(['2026-07-16T05:00:00Z']);
    expect(result.limitations).toEqual([expect.stringMatching(/^history\.repository-mismatch:/)]);
  });

  it('detects a repeated cursor without issuing another provider read', async () => {
    const fixture = providerFor([
      page([artifact(1838)], 'page-2'),
      page([artifact(1848)], 'page-2'),
    ]);

    const result = await collectHistory({ repository: REPOSITORY, provider: fixture.provider });

    expect(result.complete).toBe(false);
    expect(result.pageCount).toBe(2);
    expect(fixture.cursors).toEqual([null, 'page-2']);
    expect(result.limitations).toEqual([expect.stringMatching(/^history\.cursor-cycle:/)]);
  });

  it('rejects an invalid observation time and retains only earlier pages', async () => {
    const fixture = providerFor([
      page([artifact(1838)], 'page-2'),
      page([artifact(1848)], null, { observedAt: '2026-02-30T05:00:00Z' }),
    ]);

    const result = await collectHistory({ repository: REPOSITORY, provider: fixture.provider });

    expect(result.complete).toBe(false);
    expect(result.artifacts.map((item) => item.number)).toEqual([1838]);
    expect(result.limitations).toEqual([expect.stringMatching(/^history\.invalid-observed-at:/)]);
  });

  it('rejects conflicting evidence for the same artifact identity', async () => {
    const fixture = providerFor([
      page([artifact(1838)], 'page-2'),
      page([artifact(1838, { state: 'merged' })], null),
    ]);

    const result = await collectHistory({ repository: REPOSITORY, provider: fixture.provider });

    expect(result.complete).toBe(false);
    expect(result.artifacts).toEqual([expect.objectContaining({ number: 1838 })]);
    expect(result.artifacts[0]?.state).toBe('closed-unmerged');
    expect(result.limitations).toEqual([expect.stringMatching(/^history\.conflicting-artifact:/)]);
  });

  it('deduplicates identical page-boundary evidence without reporting a conflict', async () => {
    const fixture = providerFor([page([artifact(1838)], 'page-2'), page([artifact(1838)], null)]);

    const result = await collectHistory({
      repository: REPOSITORY,
      provider: fixture.provider,
      maxArtifacts: 2,
    });

    expect(result.complete).toBe(true);
    expect(result.pageCount).toBe(2);
    expect(result.artifacts).toEqual([expect.objectContaining({ number: 1838 })]);
    expect(result.limitations).toEqual([]);
  });

  it.each([
    ['page', { maxPages: 1, maxArtifacts: 10 }, 'history.page-limit'],
    ['artifact', { maxPages: 10, maxArtifacts: 1 }, 'history.artifact-limit'],
  ])('fails closed when the %s bound leaves a next cursor', async (_label, bounds, code) => {
    const fixture = providerFor([page([artifact(1838)], 'page-2')]);

    const result = await collectHistory({
      repository: REPOSITORY,
      provider: fixture.provider,
      ...bounds,
    });

    expect(result.complete).toBe(false);
    expect(result.pageCount).toBe(1);
    expect(result.artifacts).toHaveLength(1);
    expect(fixture.cursors).toEqual([null]);
    expect(result.limitations).toEqual([expect.stringMatching(new RegExp(`^${code}:`))]);
  });

  it('does not call the provider when the request is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const provider: HistoryProvider = {
      async readPage() {
        calls += 1;
        return page([], null);
      },
    };

    const result = await collectHistory({
      repository: REPOSITORY,
      provider,
      signal: controller.signal,
    });

    expect(calls).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.limitations).toEqual([expect.stringMatching(/^history\.aborted:/)]);
  });

  it.each([
    [
      'path/blob set',
      {
        pathBlobSet: [{ status: 'added', path: 'src/a.ts', blobOid: 'not-an-oid' }],
      },
    ],
    ['stable patch', { patchIdStable: 'not-an-oid' }],
    ['task fingerprint', { taskFingerprintSha256: 'not-a-sha256' }],
  ])('fails closed for an artifact with an invalid advertised %s', async (_label, invalid) => {
    const malformed = artifact(1838, invalid as Partial<HistoryArtifactRecord>);
    const fixture = providerFor([page([malformed], null)]);

    const result = await collectHistory({ repository: REPOSITORY, provider: fixture.provider });

    expect(result.complete).toBe(false);
    expect(result.artifacts).toEqual([]);
    expect(result.limitations).toEqual([expect.stringMatching(/^history\.invalid-artifact:/)]);
    expectBoundedLimitations(result.limitations);
  });

  it.each([
    ['pull request content evidence', artifact(1838, { pathBlobSet: undefined })],
    [
      'issue task identity',
      artifact(31, {
        kind: 'issue',
        state: 'open',
        url: `https://github.com/${REPOSITORY}/issues/31`,
        taskFingerprintSha256: undefined,
      }),
    ],
  ])('fails closed when an artifact omits required %s', async (_label, incomplete) => {
    const fixture = providerFor([page([incomplete], null)]);

    const result = await collectHistory({ repository: REPOSITORY, provider: fixture.provider });

    expect(result.complete).toBe(false);
    expect(result.artifacts).toEqual([]);
    expect(result.limitations).toEqual([
      expect.stringMatching(/^history\.invalid-artifact:/),
    ]);
  });

  it.each([
    [
      'credential-bearing artifact URL',
      {
        url: [
          'https://agent:',
          'token=abcdefghijklmnop',
          '@',
          'github.com/LucasQuiles/WhatSoup/pull/1838',
        ].join(''),
      },
    ],
    ['wrong-repository artifact URL', { url: 'https://github.com/Other/Repository/pull/1838' }],
    [
      'secret-bearing disposition condition',
      {
        disposition: {
          category: 'production-unreachable',
          artifactRefs: [`https://github.com/${REPOSITORY}/pull/1838`],
          reentryConditions: ['supply token=abcdefghijklmnop'],
          recordedAt: '2026-07-16T05:00:00Z',
        },
      },
    ],
  ])('rejects a %s without retaining its sensitive value', async (_label, invalid) => {
    const fixture = providerFor([
      page([artifact(1838, invalid as Partial<HistoryArtifactRecord>)], null),
    ]);

    const result = await collectHistory({ repository: REPOSITORY, provider: fixture.provider });
    const resultText = JSON.stringify(result);

    expect(result.complete).toBe(false);
    expect(result.artifacts).toEqual([]);
    expect(result.limitations).toEqual([expect.stringMatching(/^history\.invalid-artifact:/)]);
    expect(resultText).not.toContain('abcdefghijklmnop');
    expect(resultText).not.toContain('Other/Repository');
    expectBoundedLimitations(result.limitations);
  });
});
