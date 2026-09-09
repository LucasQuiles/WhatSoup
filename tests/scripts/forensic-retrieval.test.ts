import { describe, expect, it } from 'vitest';

import {
  buildArtifactGraph,
  detectLifecycleAnomalies,
  detectNearDuplicates,
  extractEntities,
  fuzzySimilarity,
  normalizeRetrievalText,
  parseJsonLines,
  rankDocuments,
  sanitizeEvidenceText,
  summarizeAdaptivePasses,
  weightedNgramSimilarity,
  type ForensicDocument,
} from '../../scripts/lib/forensic-retrieval.ts';

describe('forensic retrieval normalization', () => {
  it('retains raw text while normalizing Unicode, identifiers, separators, and whitespace', () => {
    const result = normalizeRetrievalText('  SharedSafe\\Path—evaluateCandidate\u00a0shared_landline  ');

    expect(result.raw).toBe('  SharedSafe\\Path—evaluateCandidate\u00a0shared_landline  ');
    expect(result.normalized).toBe('shared safe / path evaluate candidate shared landline');
    expect(result.tokens).toEqual([
      'shared',
      'safe',
      'path',
      'evaluate',
      'candidate',
      'shared',
      'landline',
    ]);
  });
});

describe('forensic lexical and fuzzy ranking', () => {
  it('ranks exact symbols and rare error text above generic prose', () => {
    const documents: ForensicDocument[] = [
      {
        id: 'generic',
        title: 'Generic verification discussion',
        text: 'The agent should verify the result and fix the issue.',
        timestampMs: Date.UTC(2026, 8, 1),
        fields: {},
      },
      {
        id: 'symbol',
        title: 'Termination trace',
        text: 'killSessionTree emitted PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED during the teardown.',
        timestampMs: Date.UTC(2026, 8, 3),
        fields: {
          symbol: ['killSessionTree'],
          error: ['PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED'],
        },
      },
      {
        id: 'path',
        title: 'Source receipt',
        text: 'The change touched src/runtimes/agent/process-tree.ts.',
        timestampMs: Date.UTC(2026, 8, 2),
        fields: { path: ['src/runtimes/agent/process-tree.ts'] },
      },
    ];

    const ranked = rankDocuments(
      documents,
      'killSessionTree PROCESS_TREE_ROOT_IDENTITY_UNVERIFIED',
      { nowMs: Date.UTC(2026, 8, 3) },
    );

    expect(ranked.map((row) => row.id)).toEqual(['symbol', 'path', 'generic']);
    expect(ranked[0]?.scores.exactEntity).toBeGreaterThan(0);
    expect(ranked[0]?.scores.bm25).toBeGreaterThan(ranked[2]!.scores.bm25);
    expect(ranked[0]?.reasons).toContain('exact-symbol');
    expect(ranked[0]?.reasons).toContain('exact-error');
  });

  it('requires an explicit finite observation time for temporal ranking', () => {
    expect(() => rankDocuments([], 'query', {} as { nowMs: number })).toThrow(RangeError);
    expect(() => rankDocuments([], 'query', { nowMs: Number.NaN })).toThrow(RangeError);
  });

  it('uses weighted token and character n-grams as ranking signals, not identity proof', () => {
    const near = weightedNgramSimilarity(
      'disposition table',
      'dispostion-table',
      { unigram: 0.15, bigram: 0.25, trigram: 0.3, character: 0.3 },
    );
    const far = weightedNgramSimilarity(
      'disposition table',
      'browser confirmation receipt',
      { unigram: 0.15, bigram: 0.25, trigram: 0.3, character: 0.3 },
    );

    expect(near.score).toBeGreaterThan(far.score);
    expect(near.proof).toBe(false);
    expect(near.components.character).toBeGreaterThan(0.5);
  });

  it('rejects an individually negative n-gram weight even when the total stays positive', () => {
    expect(() => weightedNgramSimilarity('left', 'right', {
      unigram: -1,
      bigram: 1,
      trigram: 1,
      character: 1,
    })).toThrow(RangeError);
  });

  it('excludes unavailable token n-grams instead of treating two empty sets as a match', () => {
    const short = weightedNgramSimilarity('alpha', 'beta');
    const empty = weightedNgramSimilarity('', '');

    expect(short.components.bigram).toBeNull();
    expect(short.components.trigram).toBeNull();
    expect(short.score).toBe(0);
    expect(empty.score).toBe(0);
    expect(Object.values(empty.components).every((value) => value === null)).toBe(true);
  });

  it('combines Damerau-Levenshtein, Jaro-Winkler, token-sort, and token-set signals', () => {
    const typo = fuzzySimilarity('disposition table', 'dispostion-table');
    const reordered = fuzzySimilarity('table of dispositions', 'disposition table');
    const unrelated = fuzzySimilarity('disposition table', 'provider cgroup shutdown');

    expect(typo.combined).toBeGreaterThan(0.75);
    expect(reordered.tokenSet).toBeGreaterThan(unrelated.tokenSet);
    expect(typo.combined).toBeGreaterThan(unrelated.combined);
  });
});

describe('forensic entity resolution and graph construction', () => {
  it('extracts canonical paths, commits, sessions, errors, symbols, flags, and URLs', () => {
    const entities = extractEntities(
      'Session 019d521c-aa32-7542-a050-67ed8fca5091 changed src/runtimes/agent/process-tree.ts at ' +
      '88d00a34691880cb17e4b742447f2175350e37c0. killSessionTree returned ' +
      'PROCESS_TREE_SOURCE_READ_FAILED with --format=json; see https://example.invalid/pr/3490.',
    );

    expect(entities.session).toContain('019d521c-aa32-7542-a050-67ed8fca5091');
    expect(entities.commit).toContain('88d00a34691880cb17e4b742447f2175350e37c0');
    expect(entities.path).toContain('src/runtimes/agent/process-tree.ts');
    expect(entities.symbol).toContain('killSessionTree');
    expect(entities.error).toContain('PROCESS_TREE_SOURCE_READ_FAILED');
    expect(entities.flag).toContain('--format=json');
    expect(entities.url).toContain('https://example.invalid/pr/3490');
  });

  it('builds deterministic document/entity edges and resolves aliases explicitly', () => {
    const graph = buildArtifactGraph(
      [
        {
          id: 'session-a',
          title: 'First investigation',
          text: 'fix/cgroup-sibling-reap references commit 88d00a34691880cb17e4b742447f2175350e37c0',
          timestampMs: 1,
          fields: {},
        },
        {
          id: 'session-b',
          title: 'Handoff',
          text: 'the cgroup sibling branch tested 88d00a34691880cb17e4b742447f2175350e37c0',
          timestampMs: 2,
          fields: {},
        },
      ],
      [{ canonical: 'branch:cgroup-sibling', aliases: ['fix/cgroup-sibling-reap', 'cgroup sibling branch'] }],
    );

    expect(graph.nodes.map((node) => node.id)).toEqual([
      'document:session-a',
      'document:session-b',
      'entity:branch:cgroup-sibling',
      'entity:commit:88d00a34691880cb17e4b742447f2175350e37c0',
    ]);
    expect(graph.edges.filter((edge) => edge.target === 'entity:branch:cgroup-sibling')).toHaveLength(2);
    expect(graph.edges.filter((edge) => edge.relation === 'references')).toHaveLength(4);
  });

  it('indexes every extracted entity kind and orders tied identifiers by code point', () => {
    const graph = buildArtifactGraph([
      {
        id: 'ä-document',
        title: 'Entity inventory',
        text: 'Session 019d521c-aa32-7542-a050-67ed8fca5091 touched src/core/health.ts with --format=json.',
        timestampMs: null,
        fields: {},
      },
      { id: 'z-document', title: '', text: '', timestampMs: null, fields: {} },
    ]);

    expect(graph.nodes.slice(0, 2).map((node) => node.id)).toEqual([
      'document:z-document',
      'document:ä-document',
    ]);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      { id: 'entity:path:src/core/health.ts', kind: 'entity' },
      { id: 'entity:filename:health.ts', kind: 'entity' },
      { id: 'entity:flag:--format=json.', kind: 'entity' },
      { id: 'entity:session:019d521c-aa32-7542-a050-67ed8fca5091', kind: 'entity' },
    ]));
  });
});

describe('forensic source parsing and privacy', () => {
  it('preserves byte offsets and reports malformed or truncated JSONL without hiding valid rows', () => {
    const input = Buffer.from(
      '{"type":"session_meta","id":"a"}\n' +
      '{bad json}\n' +
      '{"type":"message","text":"ok"}\n' +
      '{"type":"partial"',
    );

    const parsed = parseJsonLines(input, { sourceId: 'fixture', complete: false });

    expect(parsed.records).toHaveLength(2);
    expect(parsed.records.map((row) => row.line)).toEqual([1, 3]);
    expect(parsed.records[1]?.byteStart).toBe(Buffer.byteLength('{"type":"session_meta","id":"a"}\n{bad json}\n'));
    expect(parsed.findings.map((finding) => finding.code)).toEqual([
      'FORENSIC_JSONL_MALFORMED_RECORD',
      'FORENSIC_JSONL_TRUNCATED_TAIL',
    ]);
    expect(parsed.complete).toBe(false);
  });

  it('fails visible when a byte cap truncates the source', () => {
    const input = Buffer.from('{"text":"one"}\n{"text":"two"}\n');
    const parsed = parseJsonLines(input, { sourceId: 'fixture', maxBytes: 17, complete: true });

    expect(parsed.complete).toBe(false);
    expect(parsed.findings.some((finding) => finding.code === 'FORENSIC_SOURCE_BYTE_LIMIT')).toBe(true);
  });

  it('rejects invalid UTF-8 without manufacturing replacement-character JSON', () => {
    const input = Buffer.concat([
      Buffer.from('{"text":"'),
      Buffer.from([0xff]),
      Buffer.from('"}\n{"text":"valid"}\n'),
    ]);
    const parsed = parseJsonLines(input, { sourceId: 'fixture', complete: true });

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.line).toBe(2);
    expect(parsed.findings).toContainEqual(expect.objectContaining({
      code: 'FORENSIC_JSONL_INVALID_UTF8',
      line: 1,
    }));
    expect(parsed.complete).toBe(false);
  });

  it('reports an oversized record and continues at the next physical line', () => {
    const input = Buffer.from('{"text":"oversized"}\n{"type":"message"}\n');
    const parsed = parseJsonLines(input, {
      sourceId: 'fixture',
      complete: true,
      maxRecordBytes: 18,
    });

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.line).toBe(2);
    expect(parsed.findings).toContainEqual(expect.objectContaining({
      code: 'FORENSIC_JSONL_RECORD_BYTE_LIMIT',
      line: 1,
    }));
    expect(parsed.complete).toBe(false);
  });

  it('makes an unsupported parsed record shape visible through an adapter validator', () => {
    const input = Buffer.from('{"unknown":true}\n{"type":"message"}\n');
    const parsed = parseJsonLines(input, {
      sourceId: 'fixture',
      complete: true,
      acceptRecord: (value) => typeof value === 'object' && value !== null && 'type' in value,
    });

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.line).toBe(2);
    expect(parsed.findings).toContainEqual(expect.objectContaining({
      code: 'FORENSIC_JSONL_UNSUPPORTED_RECORD',
      line: 1,
    }));
    expect(parsed.complete).toBe(false);
  });

  it('propagates an adapter validator programming error by identity', () => {
    const programmingError = new RangeError('adapter validator bug');
    let caught: unknown;
    try {
      parseJsonLines(Buffer.from('{"type":"message"}\n'), {
        sourceId: 'fixture',
        complete: true,
        acceptRecord: () => {
          throw programmingError;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(programmingError);
  });

  it('redacts private paths, email, phone, credentials, session IDs, and host names', () => {
    const raw = [
      ['', 'Users', 'example', 'LAB', 'private', 'file.ts'].join('/'),
      ['', 'home', 'example', 'project', 'file.ts'].join('/'),
      'person@example.com',
      '+1 (555) 555-0182',
      'Authorization: Bearer secret-token-value',
      `${['api', 'key'].join('_')}=${'abcdefghijklmnopqrstuvwxyz0123456789'}`,
      '12345678-1234-4234-9234-123456789abc',
      'synthetic-private-canary-host.local',
      '/private/tmp/private-canary/artifact.json',
    ].join(' ');
    const sanitized = sanitizeEvidenceText(raw);

    expect(sanitized.text).not.toContain('example');
    expect(sanitized.text).not.toContain('555');
    expect(sanitized.text).not.toContain('secret-token-value');
    expect(sanitized.text).not.toContain('12345678-1234-4234-9234-123456789abc');
    expect(sanitized.text).not.toContain('synthetic-private-canary-host.local');
    expect(sanitized.text).not.toContain('/private/tmp/private-canary');
    expect(sanitized.categories).toEqual([
      'credential',
      'email',
      'home_path',
      'host',
      'local_path',
      'opaque_secret',
      'phone',
      'session',
    ]);
  });
});

describe('forensic reconstruction signals', () => {
  it('detects copied-forward passages but keeps them as candidates', () => {
    const goldPairs = [
      {
        id: 'approval-reorder',
        source: 'The application is staged and the four answers were approved exactly.',
        copy: 'Application staged; all four answers were exactly approved.',
      },
      {
        id: 'verification-reorder',
        source: 'The deployment verification passed on the exact revision after the final retry.',
        copy: 'After the final retry, verification of the exact deployment revision passed.',
      },
      {
        id: 'parser-reorder',
        source: 'The parser stopped after a malformed source record and reported incomplete evidence.',
        copy: 'Incomplete evidence was reported after a malformed source record stopped the parser.',
      },
    ] as const;

    for (const pair of goldPairs) {
      const candidates = detectNearDuplicates([
        { id: `${pair.id}-source`, text: pair.source },
        { id: `${pair.id}-copy`, text: pair.copy },
      ], { threshold: 0.58 });

      expect(candidates, pair.id).toHaveLength(1);
      expect(candidates[0]?.proof, pair.id).toBe(false);
    }

    expect(detectNearDuplicates([
      { id: 'source', text: goldPairs[0].source },
      { id: 'copied-forward', text: goldPairs[0].copy },
    ], { threshold: 0.58 })).toEqual([{
      leftId: 'source',
      rightId: 'copied-forward',
      score: 0.690048,
      components: {
        unigram: 0.636364,
        character: 0.57258,
        tokenSort: 0.808824,
        tokenSet: 0.742424,
      },
      proof: false,
    }]);

    const adversarialNegatives = [
      ['routine-review', 'The application is ready for review after routine checks completed.'],
      ['pending-state', 'The staged application is still pending review.'],
      ['same-entities', 'The application archived four answers before staging began.'],
      ['unrelated', 'The process tree census could not read the root.'],
    ] as const;
    for (const [id, text] of adversarialNegatives) {
      expect(detectNearDuplicates([
        { id: 'source', text: goldPairs[0].source },
        { id, text },
      ], { threshold: 0.58 }), id).toEqual([]);
    }
  });

  it('excludes unavailable similarity components instead of inflating empty matches', () => {
    const short = detectNearDuplicates([
      { id: 'short-left', text: 'x' },
      { id: 'short-right', text: 'x' },
    ], { threshold: 0 });
    const empty = detectNearDuplicates([
      { id: 'empty-left', text: '' },
      { id: 'empty-right', text: '' },
    ], { threshold: 0 });

    expect(short).toEqual([{
      leftId: 'short-left',
      rightId: 'short-right',
      score: 1,
      components: {
        unigram: 1,
        character: null,
        tokenSort: 1,
        tokenSet: 1,
      },
      proof: false,
    }]);
    expect(empty).toEqual([{
      leftId: 'empty-left',
      rightId: 'empty-right',
      score: 0,
      components: {
        unigram: null,
        character: null,
        tokenSort: null,
        tokenSet: null,
      },
      proof: false,
    }]);
  });

  it('renormalizes configured weights across the available similarity components', () => {
    const documents = [
      { id: 'source', text: 'The application is staged and the four answers were approved exactly.' },
      { id: 'copy', text: 'Application staged; all four answers were exactly approved.' },
    ] as const;
    const detectWithWeights = (
      rows: readonly { readonly id: string; readonly text: string }[],
      weights: { unigram: number; character: number; tokenSort: number; tokenSet: number },
    ) => detectNearDuplicates(rows, { threshold: 0, weights } as Parameters<typeof detectNearDuplicates>[1]);

    expect(detectWithWeights(documents, {
      unigram: 2,
      character: 0,
      tokenSort: 0,
      tokenSet: 0,
    })[0]?.score).toBe(0.636364);
    expect(detectWithWeights([
      { id: 'short-left', text: 'x' },
      { id: 'short-right', text: 'x' },
    ], {
      unigram: 1,
      character: 99,
      tokenSort: 0,
      tokenSet: 0,
    })[0]?.score).toBe(1);
    expect(detectWithWeights(documents, {
      unigram: 0,
      character: 0,
      tokenSort: 0,
      tokenSet: 0,
    })[0]?.score).toBe(0);
  });

  it('rejects negative or non-finite similarity weights', () => {
    const documents = [
      { id: 'left', text: 'copied text' },
      { id: 'right', text: 'copied text' },
    ] as const;

    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => detectNearDuplicates(documents, {
        threshold: 0,
        weights: {
          unigram: invalid,
          character: 1,
          tokenSort: 1,
          tokenSet: 1,
        },
      } as Parameters<typeof detectNearDuplicates>[1]), String(invalid)).toThrow(RangeError);
    }
  });

  it('flags missing lifecycle evidence and post-success rediscovery', () => {
    const findings = detectLifecycleAnomalies([
      { workstream: 'a', kind: 'edit', atMs: 1 },
      { workstream: 'a', kind: 'commit', atMs: 2 },
      { workstream: 'b', kind: 'claim_fixed', atMs: 3 },
      { workstream: 'b', kind: 'rediscovered', atMs: 4 },
      { workstream: 'c', kind: 'test_failed', atMs: 5 },
      { workstream: 'c', kind: 'test_changed', atMs: 6 },
      { workstream: 'c', kind: 'test_passed', atMs: 7 },
    ]);

    expect(findings.map((finding) => finding.code)).toEqual([
      'FORENSIC_COMMIT_WITHOUT_VERIFICATION',
      'FORENSIC_POST_FIX_REDISCOVERY',
      'FORENSIC_TEST_CHANGED_AFTER_FAILURE',
    ]);
  });

  it('analyzes every lifecycle cycle instead of stopping at the first verified cycle', () => {
    const findings = detectLifecycleAnomalies([
      { workstream: 'repeated', kind: 'verification', atMs: 1 },
      { workstream: 'repeated', kind: 'commit', atMs: 2 },
      { workstream: 'repeated', kind: 'edit', atMs: 3 },
      { workstream: 'repeated', kind: 'commit', atMs: 4 },
      { workstream: 'repeated', kind: 'verification', atMs: 5 },
      { workstream: 'repeated', kind: 'commit', atMs: 6 },
      { workstream: 'repeated', kind: 'test_failed', atMs: 7 },
      { workstream: 'repeated', kind: 'test_changed', atMs: 8 },
      { workstream: 'repeated', kind: 'test_passed', atMs: 9 },
      { workstream: 'repeated', kind: 'test_failed', atMs: 10 },
      { workstream: 'repeated', kind: 'test_changed', atMs: 11 },
      { workstream: 'repeated', kind: 'test_passed', atMs: 12 },
    ]);

    expect(findings).toEqual([
      {
        code: 'FORENSIC_COMMIT_WITHOUT_VERIFICATION',
        workstream: 'repeated',
        atMs: 4,
      },
      {
        code: 'FORENSIC_TEST_CHANGED_AFTER_FAILURE',
        workstream: 'repeated',
        atMs: 8,
      },
      {
        code: 'FORENSIC_TEST_CHANGED_AFTER_FAILURE',
        workstream: 'repeated',
        atMs: 11,
      },
    ]);
  });

  it('quantifies diminishing returns and refuses a saturation claim when a pass failed', () => {
    const summary = summarizeAdaptivePasses([
      { pass: 1, candidates: 100, newEvidence: 30, failedSources: 0 },
      { pass: 2, candidates: 44, newEvidence: 7, failedSources: 0 },
      { pass: 3, candidates: 21, newEvidence: 1, failedSources: 0 },
    ]);
    const inconclusive = summarizeAdaptivePasses([
      { pass: 1, candidates: 100, newEvidence: 30, failedSources: 0 },
      { pass: 2, candidates: 0, newEvidence: 0, failedSources: 1 },
    ]);

    expect(summary.saturated).toBe(true);
    expect(summary.marginalYield).toEqual([0.3, 0.159091, 0.047619]);
    expect(inconclusive.saturated).toBe(false);
    expect(inconclusive.reason).toBe('failed-source');
  });

  it('rejects unordered, duplicated, or invalid adaptive-pass observations', () => {
    const invalid = [
      [
        { pass: 2, candidates: 1, newEvidence: 0, failedSources: 0 },
        { pass: 1, candidates: 1, newEvidence: 0, failedSources: 0 },
      ],
      [
        { pass: 1, candidates: 1, newEvidence: 0, failedSources: 0 },
        { pass: 1, candidates: 1, newEvidence: 0, failedSources: 0 },
      ],
      [{ pass: 1.5, candidates: 1, newEvidence: 0, failedSources: 0 }],
      [{ pass: 1, candidates: -1, newEvidence: 0, failedSources: 0 }],
      [{ pass: 1, candidates: 0, newEvidence: 1, failedSources: 0 }],
      [{ pass: 1, candidates: 1, newEvidence: 0, failedSources: Number.NaN }],
    ] as const;

    for (const passes of invalid) {
      expect(() => summarizeAdaptivePasses(passes)).toThrow(RangeError);
    }
  });
});
