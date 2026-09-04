import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  parseForensicHarnessSearchResult,
  parseForensicPackageSpec,
  scanJsonlHarnessSource,
  scanJsonlHarnessSources,
  scanOpenCodeSnapshot,
  verifyForensicPackage,
  writeForensicPackage,
  type ForensicHarnessSearchResult,
} from '../../scripts/lib/forensic-package.ts';
import { runForensicReconstruction } from '../../scripts/forensic-reconstruction.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('whatsoup-forensic-package-');

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

type MutableSearchSpec = {
  searches: Mutable<ForensicHarnessSearchResult>[];
};

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function manifestSha256(packageDirectory: string): string {
  return sha256(readFileSync(path.join(packageDirectory, 'manifest.json')));
}

function searchResult(
  family: 'claude' | 'codex' | 'opencode',
  pass: number,
  evidenceSuffix: string,
): ForensicHarnessSearchResult {
  const recordSha = sha256(`${family}-${evidenceSuffix}`);
  return {
    schema_version: 'forensic.harness-search.v1',
    family,
    pass,
    queries: [{ id: `Q-${pass}`, mode: 'substring' }],
    sources: [{
      source_alias: `${family}-source`,
      adapter: family === 'opencode' ? 'opencode-sqlite' : `${family}-jsonl`,
      identity: { bytes: 10, sha256: sha256(`${family}-source`) },
      records_examined: 1,
      matches_observed: 1,
      complete: true,
      findings: [],
      hits: [{
        evidence_id: `evidence-${recordSha}`,
        source_alias: `${family}-source`,
        locator: family === 'opencode'
          ? { kind: 'sqlite-row', table: 'message', row_hash: sha256('row-1') }
          : { kind: 'jsonl', line: 1, byte_start: 0, byte_end: 10 },
        record_sha256: recordSha,
        matched_query_ids: [`Q-${pass}`],
        envelope: { type: 'message', role: null },
      }],
    }],
    metrics: {
      sources_examined: 1,
      failed_sources: 0,
      candidates: 1,
      new_evidence: pass === 1 ? 1 : 0,
    },
  };
}

function validSpec(): unknown {
  const searches = (['claude', 'codex', 'opencode'] as const).flatMap((family) => [
    searchResult(family, 1, 'shared'),
    searchResult(family, 2, 'shared'),
  ]);
  const firstEvidence = searches[0]!.sources[0]!.hits[0]!.evidence_id;
  return {
    schema_version: 'forensic.package-spec.v1',
    observation_timestamp: '2026-09-04T08:00:00Z',
    searches,
    conclusions: [{
      id: 'C01',
      confidence: 'high',
      statement: 'The branch contains the expected change.',
      harness_evidence_ids: [firstEvidence],
      independent_sources: [{
        kind: 'git',
        reference: 'commit:0123456789abcdef0123456789abcdef01234567',
        sha256: sha256('git-commit-object'),
      }],
    }],
    narrative: [{
      id: 'N01',
      at: '2026-09-04T07:59:00Z',
      summary: 'A candidate claim was checked against the Git object.',
      evidence_ids: [firstEvidence],
    }],
    analysis: {
      source_assessments: (['claude', 'codex', 'opencode'] as const).map((family) => ({
        source_alias: `${family}-source`,
        family,
        authority: 'primary-record',
        freshness: 'frozen-at-observation',
        completeness: 'complete',
        mutability: 'hash-bound',
        provenance: family === 'opencode' ? 'snapshot' : 'raw',
        access: 'read',
      })),
      query_assessments: searches.map((search) => ({
        family: search.family,
        pass: search.pass,
        query_id: `Q-${search.pass}`,
        useful_evidence_ids: search.pass === 1
          ? [search.sources[0]!.hits[0]!.evidence_id]
          : [],
        false_positive_evidence_ids: [],
        pivot_query_ids: search.pass === 1 ? ['Q-2'] : [],
        confidence_change: search.pass === 1 ? 'increase' : 'unchanged',
        note: search.pass === 1
          ? 'The hit identified a source-backed branch reference.'
          : 'The second pass added no distinct evidence.',
      })),
      entity_aliases: [{ canonical: 'process-ownership-repair', aliases: ['sibling reap'] }],
      findings: {
        lifecycle_anomalies: [{
          id: 'A01',
          statement: 'A completion claim preceded the terminal local gate.',
          evidence_ids: [firstEvidence],
        }],
        contradictions: [{
          id: 'X01',
          statement: 'Hosted checks were green while local release proof remained inconclusive.',
          evidence_ids: [firstEvidence],
        }],
        negative_space: [{
          id: 'Z01',
          statement: 'No terminal release receipt was present at the observation time.',
          evidence_ids: [],
        }],
        copied_forward_claims: [{
          id: 'DUP01',
          statement: 'A summary was classified as derivative rather than independent evidence.',
          evidence_ids: [firstEvidence],
        }],
      },
      next_searches: [{ id: 'NEXT01', statement: 'Re-run the terminal local release gate.' }],
      recommendations: [{ id: 'REC01', statement: 'Keep raw session content outside the tracked package.' }],
    },
    state: {
      decisions: [{ id: 'D01', statement: 'Keep raw transcripts local.' }],
      unknowns: [{ id: 'U01', statement: 'One saturated source remains unproven.' }],
      falsified_hypotheses: [{ id: 'F01', statement: 'A copied summary was independent evidence.' }],
    },
  };
}

describe('forensic package source adapters', () => {
  it('scans JSONL with stable source identity and emits only hashed evidence locators', async () => {
    const root = tmp.make('jsonl');
    const source = path.join(root, 'session.jsonl');
    const bytes = Buffer.from([
      JSON.stringify({ type: 'message', role: 'assistant', text: 'killSessionTree completed' }),
      JSON.stringify({ type: 'message', role: 'user', text: 'unrelated text' }),
      '',
    ].join('\n'));
    writeFileSync(source, bytes);

    const result = await scanJsonlHarnessSource({
      family: 'codex',
      pass: 1,
      sourceAlias: 'codex-session-01',
      sourcePath: source,
      expectedSha256: sha256(bytes),
      queries: [{ id: 'Q01', mode: 'substring', text: 'killSessionTree' }],
      limits: { maxSourceBytes: 10_000, maxRecordBytes: 1_000, maxHits: 10 },
    });

    expect(result.metrics).toEqual({
      sources_examined: 1,
      failed_sources: 0,
      candidates: 1,
      new_evidence: 1,
    });
    expect(result.sources[0]?.hits[0]).toMatchObject({
      source_alias: 'codex-session-01',
      locator: { kind: 'jsonl', line: 1, byte_start: 0 },
      matched_query_ids: ['Q01'],
      envelope: { type: 'message', role: 'assistant' },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(source);
    expect(serialized).not.toContain('killSessionTree completed');
    expect(serialized).not.toContain('"text":"killSessionTree"');
  });

  it('fails closed for malformed input, identity mismatch, hit truncation, and symlink sources', async () => {
    const root = tmp.make('jsonl-negative');
    const malformed = path.join(root, 'malformed.jsonl');
    writeFileSync(malformed, '{bad json}\n{"text":"needle"}\n');
    const common = {
      family: 'claude' as const,
      pass: 1,
      sourceAlias: 'claude-session-01',
      sourcePath: malformed,
      queries: [{ id: 'Q01', mode: 'substring' as const, text: 'needle' }],
      limits: { maxSourceBytes: 10_000, maxRecordBytes: 1_000, maxHits: 0 },
    };

    const result = await scanJsonlHarnessSource({
      ...common,
      expectedSha256: sha256(readFileSync(malformed)),
    });
    expect(result.sources[0]?.complete).toBe(false);
    expect(result.sources[0]?.findings.map((finding) => finding.code)).toEqual([
      'FORENSIC_JSONL_MALFORMED_RECORD',
      'FORENSIC_HIT_LIMIT',
    ]);
    expect(result.metrics.failed_sources).toBe(1);

    await expect(scanJsonlHarnessSource({
      ...common,
      expectedSha256: '0'.repeat(64),
    })).rejects.toThrow('source identity mismatch');

    const link = path.join(root, 'linked.jsonl');
    symlinkSync(malformed, link);
    await expect(scanJsonlHarnessSource({
      ...common,
      sourcePath: link,
      expectedSha256: sha256(readFileSync(malformed)),
    })).rejects.toThrow('symlink');

    await expect(scanJsonlHarnessSource({
      ...common,
      limits: { ...common.limits, maxSourceBytes: 1 },
      expectedSha256: sha256(readFileSync(malformed)),
    })).rejects.toThrow('source exceeds maxSourceBytes before read');
  });

  it('counts distinct record hashes as new evidence across a multi-source pass', async () => {
    const root = tmp.make('jsonl-dedup');
    const first = path.join(root, 'first.jsonl');
    const second = path.join(root, 'second.jsonl');
    const bytes = Buffer.from(`${JSON.stringify({ type: 'message', text: 'shared needle' })}\n`);
    writeFileSync(first, bytes);
    writeFileSync(second, bytes);

    const result = await scanJsonlHarnessSources({
      family: 'codex',
      pass: 1,
      sources: [
        { alias: 'codex-session-01', path: first, expectedSha256: sha256(bytes) },
        { alias: 'codex-session-02', path: second, expectedSha256: sha256(bytes) },
      ],
      queries: [{ id: 'Q01', mode: 'substring', text: 'needle' }],
      limits: { maxSourceBytes: 10_000, maxRecordBytes: 1_000, maxHits: 10 },
    });

    expect(result.metrics).toMatchObject({ candidates: 2, new_evidence: 1 });
  });

  it('reads only the allowed OpenCode evidence tables from a frozen SQLite snapshot', () => {
    const root = tmp.make('opencode');
    const databasePath = path.join(root, 'opencode.db');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, data TEXT);
    `);
    database.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('s1', 'process tree teardown', 1, 2);
    database.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('m1', 's1', 2, 3, '{"text":"killSessionTree"}');
    database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('p1', 'm1', 's1', 3, 4, '{"text":"no match"}');
    database.prepare('INSERT INTO credential VALUES (?, ?)').run('secret', 'killSessionTree private credential');
    database.close();
    const expectedSha256 = sha256(readFileSync(databasePath));
    const before = statSync(databasePath, { bigint: true });

    const result = scanOpenCodeSnapshot({
      pass: 1,
      sourceAlias: 'opencode-snapshot-01',
      databasePath,
      expectedSha256,
      queries: [{ id: 'Q01', mode: 'substring', text: 'killSessionTree' }],
      limits: { maxSourceBytes: 10_000_000, maxRows: 100, maxHits: 10 },
    });

    expect(result.metrics).toEqual({
      sources_examined: 1,
      failed_sources: 0,
      candidates: 1,
      new_evidence: 1,
    });
    expect(result.sources[0]?.hits[0]?.locator).toMatchObject({
      kind: 'sqlite-row',
      table: 'message',
    });
    expect(JSON.stringify(result)).not.toContain('credential');
    expect(JSON.stringify(result)).not.toContain('killSessionTree');
    expect(readFileSync(databasePath)).toHaveLength(Number(result.sources[0]?.identity.bytes));
    const after = statSync(databasePath, { bigint: true });
    expect({ size: after.size, mtimeNs: after.mtimeNs, ino: after.ino }).toEqual({
      size: before.size,
      mtimeNs: before.mtimeNs,
      ino: before.ino,
    });
    expect(readdirSync(root).sort()).toEqual(['opencode.db']);
  });

  it('marks OpenCode scans incomplete when the schema or row bound prevents full observation', () => {
    const root = tmp.make('opencode-incomplete');
    const databasePath = path.join(root, 'opencode.db');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE session (title TEXT); CREATE TABLE message (data TEXT);');
    database.prepare('INSERT INTO session VALUES (?)').run('first');
    database.prepare('INSERT INTO message VALUES (?)').run('second');
    database.close();

    const result = scanOpenCodeSnapshot({
      pass: 1,
      sourceAlias: 'opencode-snapshot-01',
      databasePath,
      expectedSha256: sha256(readFileSync(databasePath)),
      queries: [{ id: 'Q01', mode: 'substring', text: 'first' }],
      limits: { maxSourceBytes: 10_000_000, maxRows: 1, maxHits: 10 },
    });

    expect(result.metrics.failed_sources).toBe(1);
    expect(result.sources[0]?.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'FORENSIC_SQLITE_REQUIRED_TABLE_MISSING:part',
      'FORENSIC_SQLITE_ROW_LIMIT',
    ]));
  });

  it('rejects an OpenCode source family above its byte budget before scanning', () => {
    const root = tmp.make('opencode-byte-bound');
    const databasePath = path.join(root, 'opencode.db');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE session (title TEXT); CREATE TABLE message (data TEXT); CREATE TABLE part (data TEXT);');
    database.close();
    const sourceBytes = statSync(databasePath).size;

    expect(() => scanOpenCodeSnapshot({
      pass: 1,
      sourceAlias: 'opencode-snapshot-01',
      databasePath,
      expectedSha256: sha256(readFileSync(databasePath)),
      queries: [{ id: 'Q01', mode: 'substring', text: 'needle' }],
      limits: { maxSourceBytes: sourceBytes - 1, maxRows: 100, maxHits: 10 },
    })).toThrow('SQLite source family exceeds maxSourceBytes before identity');
  });

  it('requires caller-bound member identities when a SQLite sidecar is present', () => {
    const root = tmp.make('opencode-sidecar-binding');
    const databasePath = path.join(root, 'opencode.db');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE session (title TEXT);
      CREATE TABLE message (data TEXT);
      CREATE TABLE part (data TEXT);
      INSERT INTO message VALUES ('needle');
    `);
    expect(existsSync(`${databasePath}-wal`)).toBe(true);

    expect(() => scanOpenCodeSnapshot({
      pass: 1,
      sourceAlias: 'opencode-snapshot-01',
      databasePath,
      expectedSha256: sha256(readFileSync(databasePath)),
      queries: [{ id: 'Q01', mode: 'substring', text: 'needle' }],
      limits: { maxSourceBytes: 10_000_000, maxRows: 100, maxHits: 10 },
    })).toThrow('expectedMembers is required when SQLite sidecars are present');

    const expectedMembers = [
      { name: 'database' as const, file: databasePath },
      { name: 'wal' as const, file: `${databasePath}-wal` },
      { name: 'shm' as const, file: `${databasePath}-shm` },
    ].filter(({ file }) => existsSync(file)).map(({ name, file }) => ({
      name,
      bytes: statSync(file).size,
      sha256: sha256(readFileSync(file)),
    }));
    const mismatchedMembers = expectedMembers.map((member) => member.name === 'wal'
      ? { ...member, sha256: '0'.repeat(64) }
      : member);
    expect(() => scanOpenCodeSnapshot({
      pass: 1,
      sourceAlias: 'opencode-snapshot-01',
      databasePath,
      expectedSha256: sha256(readFileSync(databasePath)),
      expectedMembers: mismatchedMembers,
      queries: [{ id: 'Q01', mode: 'substring', text: 'needle' }],
      limits: { maxSourceBytes: 10_000_000, maxRows: 100, maxHits: 10 },
    })).toThrow('SQLite snapshot family identity mismatch before read');

    const expectedSha256 = sha256(readFileSync(databasePath));
    const result = scanOpenCodeSnapshot({
      pass: 1,
      sourceAlias: 'opencode-snapshot-01',
      databasePath,
      expectedSha256,
      expectedMembers,
      queries: [{ id: 'Q01', mode: 'substring', text: 'needle' }],
      limits: { maxSourceBytes: 10_000_000, maxRows: 100, maxHits: 10 },
    });
    expect(result.sources[0]?.identity).toEqual({
      bytes: statSync(databasePath).size,
      sha256: expectedSha256,
      members: expectedMembers,
    });
    database.close();
  });
});

describe('forensic package contract', () => {
  it('rejects search receipts that searched no query or no source', () => {
    const noQueries = searchResult('claude', 1, 'no-queries') as Mutable<ForensicHarnessSearchResult>;
    noQueries.queries = [];
    noQueries.sources[0]!.matches_observed = 0;
    noQueries.sources[0]!.hits = [];
    noQueries.metrics.candidates = 0;
    noQueries.metrics.new_evidence = 0;
    expect(() => parseForensicHarnessSearchResult(noQueries)).toThrow('queries must not be empty');

    const noSources = searchResult('claude', 1, 'no-sources') as Mutable<ForensicHarnessSearchResult>;
    noSources.sources = [];
    noSources.metrics.sources_examined = 0;
    noSources.metrics.candidates = 0;
    noSources.metrics.new_evidence = 0;
    expect(() => parseForensicHarnessSearchResult(noSources)).toThrow('sources must not be empty');
  });

  it('rejects unknown schema keys and missing two-pass coverage for every harness family', () => {
    const extra = validSpec() as Record<string, unknown>;
    extra.unreviewed = true;
    expect(() => parseForensicPackageSpec(extra)).toThrow('unknown key');

    const missing = validSpec() as { searches: ForensicHarnessSearchResult[] };
    missing.searches = missing.searches.filter((row) => !(row.family === 'opencode' && row.pass === 2));
    expect(() => parseForensicPackageSpec(missing)).toThrow('at least two passes for opencode');
  });

  it('requires complete source and query adjudication and binds analysis evidence', () => {
    const missingSource = validSpec() as {
      analysis: { source_assessments: unknown[] };
    };
    missingSource.analysis.source_assessments.pop();
    expect(() => parseForensicPackageSpec(missingSource)).toThrow('source assessment');

    const missingQuery = validSpec() as {
      analysis: { query_assessments: unknown[] };
    };
    missingQuery.analysis.query_assessments.pop();
    expect(() => parseForensicPackageSpec(missingQuery)).toThrow('query assessment');

    const wrongEvidence = validSpec() as {
      analysis: {
        query_assessments: Array<{ useful_evidence_ids: string[] }>;
      };
    };
    wrongEvidence.analysis.query_assessments[0]!.useful_evidence_ids = [
      wrongEvidence.analysis.query_assessments[2]!.useful_evidence_ids[0]!,
    ];
    expect(() => parseForensicPackageSpec(wrongEvidence)).toThrow('does not match assessed query');

    const overlap = validSpec() as {
      analysis: {
        query_assessments: Array<{
          useful_evidence_ids: string[];
          false_positive_evidence_ids: string[];
        }>;
      };
    };
    overlap.analysis.query_assessments[0]!.false_positive_evidence_ids = [
      overlap.analysis.query_assessments[0]!.useful_evidence_ids[0]!,
    ];
    expect(() => parseForensicPackageSpec(overlap)).toThrow('both useful and false positive');
  });

  it('requires every high-confidence conclusion to cite harness evidence and an independent source', () => {
    const noIndependent = validSpec() as {
      conclusions: Array<Record<string, unknown>>;
    };
    noIndependent.conclusions[0]!.independent_sources = [];
    expect(() => parseForensicPackageSpec(noIndependent)).toThrow('independent source');

    const copiedSummary = validSpec() as {
      conclusions: Array<Record<string, unknown>>;
    };
    copiedSummary.conclusions[0]!.independent_sources = [{
      kind: 'harness-summary',
      reference: 'summary:N01',
      sha256: null,
    }];
    expect(() => parseForensicPackageSpec(copiedSummary)).toThrow('independent_sources');

    const unboundSource = validSpec() as {
      conclusions: Array<{ independent_sources: Array<{ sha256: string | null }> }>;
    };
    unboundSource.conclusions[0]!.independent_sources[0]!.sha256 = null;
    expect(() => parseForensicPackageSpec(unboundSource)).toThrow('content-bound independent source');

    const unreviewedEvidence = validSpec() as {
      analysis: { query_assessments: Array<{ useful_evidence_ids: string[] }> };
    };
    unreviewedEvidence.analysis.query_assessments[0]!.useful_evidence_ids = [];
    expect(() => parseForensicPackageSpec(unreviewedEvidence)).toThrow('not adjudicated useful');

    const falsePositiveEvidence = validSpec() as {
      analysis: {
        query_assessments: Array<{
          useful_evidence_ids: string[];
          false_positive_evidence_ids: string[];
        }>;
      };
    };
    const citedEvidence = falsePositiveEvidence.analysis.query_assessments[0]!.useful_evidence_ids[0]!;
    falsePositiveEvidence.analysis.query_assessments[0]!.useful_evidence_ids = [];
    falsePositiveEvidence.analysis.query_assessments[0]!.false_positive_evidence_ids = [citedEvidence];
    expect(() => parseForensicPackageSpec(falsePositiveEvidence)).toThrow('adjudicated false positive');

    const crossQueryContradiction = validSpec() as {
      analysis: {
        query_assessments: Array<{
          useful_evidence_ids: string[];
          false_positive_evidence_ids: string[];
        }>;
      };
    };
    const usefulInFirstPass = crossQueryContradiction.analysis.query_assessments[0]!.useful_evidence_ids[0]!;
    crossQueryContradiction.analysis.query_assessments[1]!.false_positive_evidence_ids = [usefulInFirstPass];
    expect(() => parseForensicPackageSpec(crossQueryContradiction)).toThrow('adjudicated false positive');
  });

  it('binds evidence IDs, source aliases, query IDs, and completeness to their measured rows', () => {
    const mismatchedId = validSpec() as MutableSearchSpec;
    const idHit = mismatchedId.searches[0]!.sources[0]!.hits[0]!;
    idHit.evidence_id = 'evidence-not-the-record-hash';
    expect(() => parseForensicPackageSpec(mismatchedId)).toThrow('does not match record_sha256');

    const mismatchedAlias = validSpec() as MutableSearchSpec;
    const aliasHit = mismatchedAlias.searches[0]!.sources[0]!.hits[0]!;
    aliasHit.source_alias = 'different-source';
    expect(() => parseForensicPackageSpec(mismatchedAlias)).toThrow('source_alias mismatch');

    const unknownQuery = validSpec() as MutableSearchSpec;
    const queryHit = unknownQuery.searches[0]!.sources[0]!.hits[0]!;
    queryHit.matched_query_ids = ['unknown-query'];
    expect(() => parseForensicPackageSpec(unknownQuery)).toThrow('unknown matched query');

    const falseComplete = validSpec() as MutableSearchSpec;
    const source = falseComplete.searches[0]!.sources[0]!;
    source.findings = [{ code: 'FORENSIC_HIT_LIMIT' }];
    expect(() => parseForensicPackageSpec(falseComplete)).toThrow('complete source has findings');

    const falseYield = validSpec() as MutableSearchSpec;
    const secondPass = falseYield.searches.find((row) => row.family === 'claude' && row.pass === 2);
    if (!secondPass) throw new Error('missing fixture pass');
    secondPass.metrics.new_evidence = 1;
    expect(() => parseForensicPackageSpec(falseYield)).toThrow('new_evidence mismatch');
  });

  it('binds source aliases and adapters to their harness family', () => {
    const wrongAdapter = validSpec() as MutableSearchSpec;
    wrongAdapter.searches[0]!.sources[0] = {
      ...wrongAdapter.searches[0]!.sources[0]!,
      adapter: 'codex-jsonl',
    };
    expect(() => parseForensicPackageSpec(wrongAdapter)).toThrow('adapter mismatch');

    const wrongLocator = validSpec() as MutableSearchSpec;
    wrongLocator.searches[0]!.sources[0]!.hits[0] = {
      ...wrongLocator.searches[0]!.sources[0]!.hits[0]!,
      locator: { kind: 'sqlite-row', table: 'message', row_hash: sha256('wrong-family') },
    };
    expect(() => parseForensicPackageSpec(wrongLocator)).toThrow('locator mismatch');

    const reusedAlias = validSpec() as MutableSearchSpec;
    for (const search of reusedAlias.searches.filter((row) => row.family === 'opencode')) {
      search.sources[0] = { ...search.sources[0]!, source_alias: 'claude-source' };
      search.sources[0]!.hits[0] = {
        ...search.sources[0]!.hits[0]!,
        source_alias: 'claude-source',
      };
    }
    expect(() => parseForensicPackageSpec(reusedAlias)).toThrow('reused across harness families');
  });

  it('writes deterministic separated planes, redacts private text, and deduplicates copied evidence', () => {
    const root = tmp.make('package');
    const first = path.join(root, 'package-a');
    const second = path.join(root, 'package-b');
    const spec = validSpec() as {
      conclusions: Array<{ statement: string }>;
      narrative: Array<{ summary: string }>;
    };
    const privateHome = ['', 'Users', 'private', 'LAB', 'tree'].join('/');
    const privateEmail = ['person', 'example.com'].join('@');
    const privateBearer = ['Bearer', 'abcdefghijklmnopqrstuvwxyz'].join(' ');
    spec.conclusions[0]!.statement = `Verified in ${privateHome} by ${privateEmail}.`;
    spec.narrative[0]!.summary = `${privateBearer} was copied forward.`;

    writeForensicPackage(spec, first);
    writeForensicPackage(spec, second);

    const expectedFiles = [
      'analysis.json',
      'evidence.json',
      'manifest.json',
      'narrative.json',
      'query-journal.json',
      'report.md',
      'source-inventory.json',
      'state.json',
    ];
    const firstManifest = JSON.parse(readFileSync(path.join(first, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
    };
    expect(firstManifest.files.map((row) => row.path)).toEqual(expectedFiles.filter((name) => name !== 'manifest.json'));
    for (const name of expectedFiles) {
      expect(readFileSync(path.join(first, name))).toEqual(readFileSync(path.join(second, name)));
    }
    const allText = expectedFiles.map((name) => readFileSync(path.join(first, name), 'utf8')).join('\n');
    expect(allText).not.toContain(privateHome);
    expect(allText).not.toContain(privateEmail);
    expect(allText).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(allText).toContain('$HOME/LAB/tree');
    const report = readFileSync(path.join(first, 'report.md'), 'utf8');
    expect(report).toContain('## Reproduction');
    expect(report).toContain('forensic:reconstruct -- verify');
    expect(report.endsWith('\n')).toBe(true);
    expect(report.endsWith('\n\n')).toBe(false);

    const evidence = JSON.parse(readFileSync(path.join(first, 'evidence.json'), 'utf8')) as {
      evidence: unknown[];
    };
    expect(evidence.evidence).toHaveLength(3);
    const analysis = JSON.parse(readFileSync(path.join(first, 'analysis.json'), 'utf8')) as {
      method_configuration: { applied_search_modes: string[]; candidate_ranking_applied: boolean };
      entity_graph: { nodes: unknown[]; edges: unknown[] };
      findings: { contradictions: unknown[]; negative_space: unknown[] };
    };
    expect(analysis.method_configuration).toMatchObject({
      applied_search_modes: ['substring'],
      candidate_ranking_applied: false,
    });
    expect(analysis.entity_graph.nodes.length).toBeGreaterThan(0);
    expect(analysis.findings.contradictions).toHaveLength(1);
    expect(analysis.findings.negative_space).toHaveLength(1);
    expect(verifyForensicPackage(first, manifestSha256(first))).toEqual({ valid: true, findings: [] });
  });

  it('fails closed when sanitized package text contains a configured private term', () => {
    const root = tmp.make('package-private-term');
    const blocked = path.join(root, 'blocked-package');
    const allowed = path.join(root, 'allowed-package');
    const spec = validSpec() as {
      narrative: Array<{ summary: string }>;
    };
    spec.narrative[0]!.summary = 'Observed on Private-Node-Canary during reconstruction.';

    expect(() => writeForensicPackage(spec, blocked, {
      forbiddenTerms: ['private-node-canary'],
    })).toThrow('configured forbidden term');
    expect(existsSync(blocked)).toBe(false);

    writeForensicPackage(validSpec(), allowed, {
      forbiddenTerms: ['private-node-canary'],
    });
    expect(verifyForensicPackage(allowed, manifestSha256(allowed))).toEqual({ valid: true, findings: [] });
  });

  it('preserves large byte counts without publishing phone-shaped digit runs', () => {
    const root = tmp.make('package-large-byte-count');
    const output = path.join(root, 'package');
    const spec = validSpec() as {
      searches: Array<{
        family: string;
        sources: Array<{
          identity: {
            bytes: number;
            sha256: string;
            members?: Array<{ name: string; bytes: number; sha256: string }>;
          };
        }>;
      }>;
    };
    for (const search of spec.searches.filter((row) => row.family === 'opencode')) {
      search.sources[0]!.identity = {
        bytes: 10_813_071_360,
        sha256: sha256('large-database'),
        members: [{ name: 'database', bytes: 10_813_071_360, sha256: sha256('large-database') }],
      };
    }

    writeForensicPackage(spec, output);
    const inventoryText = readFileSync(path.join(output, 'source-inventory.json'), 'utf8');
    const inventory = JSON.parse(inventoryText) as {
      integer_encoding: string;
      sources: Array<{ identity?: { bytes: number | string; members?: Array<{ bytes: number | string }> } }>;
    };
    const openCode = inventory.sources.find((row) => row.identity?.members !== undefined);
    expect(inventory.integer_encoding).toBe('number-or-underscore-grouped-decimal-string');
    expect(openCode?.identity?.bytes).toBe('10_813_071_360');
    expect(openCode?.identity?.members?.[0]?.bytes).toBe('10_813_071_360');
    expect(inventoryText).not.toContain('10813071360');
    expect(verifyForensicPackage(output, manifestSha256(output))).toEqual({ valid: true, findings: [] });
  });

  it('publishes only adjudication-referenced evidence instead of the full candidate corpus', () => {
    const root = tmp.make('package-selection');
    const output = path.join(root, 'package');
    const spec = validSpec() as {
      searches: ForensicHarnessSearchResult[];
      analysis: { query_assessments: Array<{ family: string; pass: number; useful_evidence_ids: string[] }> };
    };
    const replacement = searchResult('claude', 2, 'unreviewed-only');
    (replacement.metrics as { new_evidence: number }).new_evidence = 1;
    const searchIndex = spec.searches.findIndex((row) => row.family === 'claude' && row.pass === 2);
    spec.searches[searchIndex] = replacement;
    const assessment = spec.analysis.query_assessments.find((row) => row.family === 'claude' && row.pass === 2);
    if (!assessment) throw new Error('missing query assessment fixture');
    assessment.useful_evidence_ids = [];

    writeForensicPackage(spec, output);
    const evidence = JSON.parse(readFileSync(path.join(output, 'evidence.json'), 'utf8')) as {
      selection: { retained: number; observed_candidates: number; rule: string };
      evidence: unknown[];
    };
    expect(evidence.selection).toEqual({
      retained: 3,
      observed_candidates: 4,
      rule: 'referenced-by-adjudication',
    });
    expect(evidence.evidence).toHaveLength(3);
  });

  it('refuses overwrite and verification detects tampering or unmanifested files', () => {
    const root = tmp.make('verify');
    const output = path.join(root, 'package');
    writeForensicPackage(validSpec(), output);
    const expectedManifestSha256 = sha256(readFileSync(path.join(output, 'manifest.json')));

    expect(() => writeForensicPackage(validSpec(), output)).toThrow('already exists');
    writeFileSync(path.join(output, 'state.json'), '{}\n');
    expect(verifyForensicPackage(output, expectedManifestSha256)).toMatchObject({
      valid: false,
      findings: expect.arrayContaining(['hash-mismatch:state.json']),
    });
    writeFileSync(path.join(output, 'unexpected.txt'), 'not manifest-bound\n');
    expect(verifyForensicPackage(output, expectedManifestSha256)).toMatchObject({
      valid: false,
      findings: expect.arrayContaining(['unexpected-file:unexpected.txt']),
    });
    const forgedManifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; bytes: number; sha256: string }>;
    };
    const stateRow = forgedManifest.files.find((row) => row.path === 'state.json');
    if (!stateRow) throw new Error('missing state manifest row');
    stateRow.bytes = 3;
    stateRow.sha256 = sha256('{}\n');
    writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(forgedManifest, null, 2)}\n`);
    expect(verifyForensicPackage(output, expectedManifestSha256)).toMatchObject({
      valid: false,
      findings: expect.arrayContaining(['manifest-hash-mismatch']),
    });
    expect(existsSync(output)).toBe(true);
  });

  it('verification refuses a symlinked manifest even when its target bytes match the expected digest', () => {
    const root = tmp.make('verify-manifest-symlink');
    const output = path.join(root, 'package');
    const externalManifest = path.join(root, 'external-manifest.json');
    writeForensicPackage(validSpec(), output);
    const manifest = path.join(output, 'manifest.json');
    const manifestContent = readFileSync(manifest);
    const expectedManifestSha256 = sha256(manifestContent);
    writeFileSync(externalManifest, manifestContent);
    unlinkSync(manifest);
    symlinkSync(externalManifest, manifest);

    expect(verifyForensicPackage(output, expectedManifestSha256)).toEqual({
      valid: false,
      findings: ['manifest-invalid'],
    });
  });

  // @skip-env Windows does not expose the POSIX directory mode used to force this write failure.
  it.skipIf(process.platform === 'win32')(
    'retains a manifest-incomplete claimed directory after a post-claim write failure',
    () => {
      const root = tmp.make('failed-package-publication');
      const output = path.join(root, 'package');
      const previousUmask = process.umask(0o777);
      try {
        expect(() => writeForensicPackage(validSpec(), output)).toThrow();
      } finally {
        process.umask(previousUmask);
      }
      expect(existsSync(output)).toBe(true);
      expect(existsSync(path.join(output, 'manifest.json'))).toBe(false);
      chmodSync(output, 0o700);
    },
  );

  it('rechecks publication policy even when a changed file is re-manifested', () => {
    const root = tmp.make('verify-publication-policy');
    const output = path.join(root, 'package');
    writeForensicPackage(validSpec(), output);
    const unsafeReport = 'Bearer abcdefghijklmnopqrstuvwxyz\nprivate-node-canary\n';
    writeFileSync(path.join(output, 'report.md'), unsafeReport);
    const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; bytes: number; sha256: string }>;
    };
    const reportRow = manifest.files.find((row) => row.path === 'report.md');
    if (!reportRow) throw new Error('missing report manifest row');
    reportRow.bytes = Buffer.byteLength(unsafeReport);
    reportRow.sha256 = sha256(unsafeReport);
    writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    expect(verifyForensicPackage(output, manifestSha256(output), {
      forbiddenTerms: ['private-node-canary'],
    })).toEqual({
      valid: false,
      findings: ['redaction-violation:report.md'],
    });
  });
});

describe('forensic reconstruction CLI', () => {
  it('exposes a closed command schema and rejects unknown flags', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runForensicReconstruction(['schema'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('forensic.reconstruction-cli.v1'));
    const schemaOutput = log.mock.calls[0]?.[0];
    expect(typeof schemaOutput).toBe('string');
    const schema = JSON.parse(String(schemaOutput)) as {
      commands: Record<string, { required: string[] }>;
      exit_codes: Record<string, string>;
    };
    expect(Object.keys(schema.exit_codes)).toEqual(['0', '2']);
    expect(schema.commands.build?.required).toContain('forbidden-terms');
    expect(schema.commands.verify?.required).toEqual(expect.arrayContaining([
      'expected-manifest-sha256',
      'forbidden-terms',
    ]));
    expect(await runForensicReconstruction(['schema', '--surprise'])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('does not accept arguments'));
    log.mockRestore();
    error.mockRestore();
  });

  it('writes a no-clobber JSONL search receipt and returns 2 for incomplete evidence', async () => {
    const root = tmp.make('cli-search');
    const source = path.join(root, 'session.jsonl');
    const queries = path.join(root, 'queries.json');
    const output = path.join(root, 'search.json');
    writeFileSync(source, '{bad json}\n{"text":"needle"}\n');
    writeFileSync(queries, `${JSON.stringify({
      schema_version: 'forensic.session-query.v1',
      queries: [{ id: 'Q01', mode: 'substring', text: 'needle' }],
    })}\n`);

    const args = [
      'scan-jsonl',
      '--family', 'claude',
      '--pass', '1',
      '--source-alias', 'claude-session-01',
      '--source', source,
      '--expected-sha256', sha256(readFileSync(source)),
      '--queries', queries,
      '--output', output,
      '--max-source-bytes', '10000',
      '--max-record-bytes', '1000',
      '--max-hits', '10',
    ];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runForensicReconstruction(args, root)).toBe(2);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      schema_version: 'forensic.harness-search.v1',
      metrics: { failed_sources: 1 },
    });
    expect(await runForensicReconstruction(args, root)).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    error.mockRestore();
  });

  it('scans a closed multi-source JSONL family spec into one pass receipt', async () => {
    const root = tmp.make('cli-source-set');
    const first = path.join(root, 'first.jsonl');
    const second = path.join(root, 'second.jsonl');
    const queries = path.join(root, 'queries.json');
    const sources = path.join(root, 'sources.json');
    const output = path.join(root, 'search.json');
    writeFileSync(first, '{"type":"message","text":"needle one"}\n');
    writeFileSync(second, '{"type":"message","text":"needle two"}\n');
    writeFileSync(queries, `${JSON.stringify({
      schema_version: 'forensic.session-query.v1',
      queries: [{ id: 'Q01', mode: 'substring', text: 'needle' }],
    })}\n`);
    writeFileSync(sources, `${JSON.stringify({
      schema_version: 'forensic.jsonl-source-set.v1',
      family: 'codex',
      sources: [
        { alias: 'codex-session-01', path: 'first.jsonl', sha256: sha256(readFileSync(first)) },
        { alias: 'codex-session-02', path: 'second.jsonl', sha256: sha256(readFileSync(second)) },
      ],
    })}\n`);

    expect(await runForensicReconstruction([
      'scan-jsonl-set',
      '--pass', '1',
      '--sources', sources,
      '--queries', queries,
      '--output', output,
    ], root)).toBe(0);
    const result = JSON.parse(readFileSync(output, 'utf8')) as ForensicHarnessSearchResult;
    expect(result.family).toBe('codex');
    expect(result.sources.map((source) => source.source_alias)).toEqual([
      'codex-session-01',
      'codex-session-02',
    ]);
    expect(result.metrics).toEqual({
      sources_examined: 2,
      failed_sources: 0,
      candidates: 2,
      new_evidence: 2,
    });
    expect(JSON.stringify(result)).not.toContain(first);
    expect(JSON.stringify(result)).not.toContain(second);
  });

  it('builds and verifies a package through the CLI without leaking the private spec path', async () => {
    const root = tmp.make('cli-build');
    const spec = path.join(root, 'private-spec.json');
    const forbiddenTerms = path.join(root, 'forbidden-terms.json');
    const output = path.join(root, 'public-package');
    writeFileSync(spec, `${JSON.stringify(validSpec(), null, 2)}\n`, { mode: 0o600 });
    writeFileSync(forbiddenTerms, `${JSON.stringify({
      schema_version: 'forensic.forbidden-terms.v1',
      terms: ['private-node-canary'],
    }, null, 2)}\n`, { mode: 0o600 });

    expect(await runForensicReconstruction([
      'build', '--spec', spec, '--output', output, '--forbidden-terms', forbiddenTerms,
    ], root)).toBe(0);
    expect(await runForensicReconstruction([
      'verify', '--package', output,
    ], root)).toBe(2);
    const expectedManifestSha256 = sha256(readFileSync(path.join(output, 'manifest.json')));
    expect(await runForensicReconstruction([
      'verify', '--package', output,
      '--expected-manifest-sha256', expectedManifestSha256,
      '--forbidden-terms', forbiddenTerms,
    ], root)).toBe(0);
    expect(readFileSync(path.join(output, 'report.md'), 'utf8')).not.toContain(spec);
  });

  it('fails closed on a forbidden term without echoing the private value', async () => {
    const root = tmp.make('cli-private-term');
    const specFile = path.join(root, 'private-spec.json');
    const forbiddenTerms = path.join(root, 'forbidden-terms.json');
    const output = path.join(root, 'public-package');
    const spec = validSpec() as { narrative: Array<{ summary: string }> };
    spec.narrative[0]!.summary = 'Observed on private-node-canary.';
    writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(forbiddenTerms, `${JSON.stringify({
      schema_version: 'forensic.forbidden-terms.v1',
      terms: ['private-node-canary'],
    }, null, 2)}\n`, { mode: 0o600 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runForensicReconstruction([
      'build', '--spec', specFile, '--output', output, '--forbidden-terms', forbiddenTerms,
    ], root)).toBe(2);
    expect(existsSync(output)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('configured forbidden term'));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('private-node-canary'));
    error.mockRestore();
  });

  it('rejects an empty private forbidden-term policy', async () => {
    const root = tmp.make('cli-empty-private-policy');
    const specFile = path.join(root, 'private-spec.json');
    const forbiddenTerms = path.join(root, 'forbidden-terms.json');
    const output = path.join(root, 'public-package');
    writeFileSync(specFile, `${JSON.stringify(validSpec(), null, 2)}\n`, { mode: 0o600 });
    writeFileSync(forbiddenTerms, `${JSON.stringify({
      schema_version: 'forensic.forbidden-terms.v1',
      terms: [],
    }, null, 2)}\n`, { mode: 0o600 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runForensicReconstruction([
      'build', '--spec', specFile, '--output', output, '--forbidden-terms', forbiddenTerms,
    ], root)).toBe(2);
    expect(existsSync(output)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(
      'forbidden terms file must contain at least one private term',
    ));
    error.mockRestore();
  });

  it('refuses a symlinked private forbidden-term policy without revealing its target', async () => {
    const root = tmp.make('cli-symlinked-private-policy');
    const specFile = path.join(root, 'private-spec.json');
    const privateTarget = path.join(root, 'private-policy-target.json');
    const forbiddenTerms = path.join(root, 'forbidden-terms.json');
    const output = path.join(root, 'public-package');
    writeFileSync(specFile, `${JSON.stringify(validSpec(), null, 2)}\n`, { mode: 0o600 });
    writeFileSync(privateTarget, `${JSON.stringify({
      schema_version: 'forensic.forbidden-terms.v1',
      terms: ['private-node-canary'],
    }, null, 2)}\n`, { mode: 0o600 });
    symlinkSync(privateTarget, forbiddenTerms);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await runForensicReconstruction([
      'build', '--spec', specFile, '--output', output, '--forbidden-terms', forbiddenTerms,
    ], root)).toBe(2);
    expect(existsSync(output)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(
      'forbidden terms file could not be read as bounded regular JSON',
    ));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining(privateTarget));
    error.mockRestore();
  });

  // @skip-env Windows does not enforce the POSIX group-read permission this policy rejects.
  it.skipIf(process.platform === 'win32')(
    'refuses a group-readable private forbidden-term policy',
    async () => {
      const root = tmp.make('cli-readable-private-policy');
      const specFile = path.join(root, 'private-spec.json');
      const forbiddenTerms = path.join(root, 'forbidden-terms.json');
      const output = path.join(root, 'public-package');
      writeFileSync(specFile, `${JSON.stringify(validSpec(), null, 2)}\n`, { mode: 0o600 });
      writeFileSync(forbiddenTerms, `${JSON.stringify({
        schema_version: 'forensic.forbidden-terms.v1',
        terms: ['private-node-canary'],
      }, null, 2)}\n`, { mode: 0o640 });
      chmodSync(forbiddenTerms, 0o640);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(await runForensicReconstruction([
        'build', '--spec', specFile, '--output', output, '--forbidden-terms', forbiddenTerms,
      ], root)).toBe(2);
      expect(existsSync(output)).toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(
        'forbidden terms file could not be read as bounded regular JSON',
      ));
      error.mockRestore();
    },
  );
});
