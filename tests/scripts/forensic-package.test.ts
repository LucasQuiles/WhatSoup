import { createHash } from 'node:crypto';
import fs from 'node:fs';
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
import { syncBuiltinESMExports } from 'node:module';
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

describe('forensic evidence failure boundaries', () => {
  it.each(['plain', 'unicode', 'private-path', 'private-term', 'object-key', 'key-context', 'duplicate-key', 'basic', 'escaped-basic', 'embedded-basic', 'embedded-unicode-basic', 'embedded-whitespace-basic', 'decode-budget'] as const)('rejects unsafe decoded content in re-manifested public metadata: %s', (encoding) => {
    const output = path.join(tmp.make('envelope-reverification'), 'package');
    writeForensicPackage(validSpec(), output);
    const member = path.join(output, 'evidence.json');
    const evidence = JSON.parse(readFileSync(member, 'utf8'));
    const syntheticToken = 'ghp_' + 'A'.repeat(24);
    const envelope = evidence.evidence[0].occurrences[0].envelope;
    envelope.type = encoding === 'private-path' ? '/home/testuser/private'
      : encoding === 'private-term' ? 'fixture-private-scope' : syntheticToken;
    if (encoding === 'object-key') {
      envelope.type = 'message';
      envelope[syntheticToken] = 'ordinary';
    }
    if (encoding === 'key-context') {
      envelope.type = 'message';
      envelope.token = 'fixturevalueabcdefghijklmnop';
    }
    if (encoding === 'duplicate-key') envelope.type = 'message';
    if (encoding === 'basic' || encoding === 'escaped-basic') {
      envelope.type = 'message';
      envelope.authorization = 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64');
    }
    if (encoding === 'embedded-basic') {
      envelope.type = JSON.stringify({ authorization: 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64') });
    }
    if (encoding === 'embedded-unicode-basic') {
      envelope.type = JSON.stringify({ authorization: 'Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64') })
        .replace('"authorization":', '"\\u0061uthorization":');
    }
    if (encoding === 'embedded-whitespace-basic') {
      envelope.type = ('{"authorization":\n"Basic ' + Buffer.from('fixture-user:fixture-password').toString('base64') + '"}')
        .replaceAll('"', '\\"').replaceAll('\n', '\\n');
    }
    if (encoding === 'decode-budget') envelope.type = '\\' + 'u005c'.repeat(16) + 'u0078';
    const serialized = JSON.stringify(evidence);
    const encoded = encoding === 'private-path' ? serialized.replaceAll('/', '\\/')
      : encoding === 'escaped-basic' ? serialized.replace('"authorization":', '"\\u0061uthorization":')
        : encoding === 'private-term' ? serialized.replace('fixture-private-scope', '\\u0066ixture-private-scope')
        : encoding === 'key-context' ? serialized.replace('"token":', '"\\u0074oken":')
          : encoding === 'duplicate-key' ? serialized.replace('"type":"message"', '"type":"\\u0067hp_' + 'A'.repeat(24) + '","type":"message"')
            : encoding === 'plain' ? serialized : serialized.replace('ghp_', '\\u0067hp_');
    expect(JSON.parse(encoded)).toEqual(evidence);
    const bytes = Buffer.from(encoded);
    writeFileSync(member, bytes);
    const manifestPath = path.join(output, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Array<{ path: string; bytes: number; sha256: string }> };
    const row = manifest.files.find((file) => file.path === 'evidence.json');
    expect(row).toBeDefined();
    row!.bytes = bytes.length;
    row!.sha256 = sha256(bytes);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(verifyForensicPackage(output, manifestSha256(output), { forbiddenTerms: ['fixture-private-scope'] })).toEqual({
      valid: false, findings: ['redaction-violation:evidence.json'],
    });
  });

  it('preserves a benign Basic label without authorization context', () => {
    const spec = validSpec() as MutableSearchSpec;
    spec.searches[0]!.sources[0]!.hits[0]!.envelope.type = 'Basic layout';
    const output = path.join(tmp.make('benign-basic-label'), 'package');
    writeForensicPackage(spec, output);
    expect(verifyForensicPackage(output, manifestSha256(output))).toEqual({ valid: true, findings: [] });
  });

  it('redacts quoted Basic authorization embedded in narrative text', () => {
    const spec = validSpec() as { narrative: Array<{ summary: string }> };
    const credential = Buffer.from('fixture-user:fixture-password').toString('base64');
    spec.narrative[0]!.summary = JSON.stringify({ authorization: 'Basic ' + credential });
    expect(spec.narrative[0]!.summary).toContain(credential);
    const output = path.join(tmp.make('basic-narrative'), 'package');
    writeForensicPackage(spec, output);
    const narrative = readFileSync(path.join(output, 'narrative.json'), 'utf8');
    expect(narrative).not.toContain(credential);
    expect(narrative).toContain('Basic [REDACTED]');
    expect(verifyForensicPackage(output, manifestSha256(output))).toEqual({ valid: true, findings: [] });
  });

  it.each(['unicode-key', 'escaped-whitespace'] as const)('refuses unredacted encoded authorization before publication: %s', (format) => {
    const spec = validSpec() as { narrative: Array<{ summary: string }> };
    const credential = Buffer.from('fixture-user:fixture-password').toString('base64');
    spec.narrative[0]!.summary = format === 'unicode-key'
      ? JSON.stringify({ authorization: 'Basic ' + credential }).replace('"authorization":', '"\\u0061uthorization":')
      : ('{"authorization":\n"Basic ' + credential + '"}').replaceAll('"', '\\"').replaceAll('\n', '\\n');
    expect(spec.narrative[0]!.summary).toContain(credential);
    const output = path.join(tmp.make('encoded-narrative'), 'package');
    expect(() => writeForensicPackage(spec, output)).toThrow(/redaction_violation/);
    expect(existsSync(output)).toBe(false);
  });

  it('preserves harmless nested JSON escapes within the decoding budget', () => {
    const spec = validSpec() as { narrative: Array<{ summary: string }> };
    spec.narrative[0]!.summary = '\\' + 'u005c'.repeat(3) + 'u0078';
    const output = path.join(tmp.make('benign-encoded-narrative'), 'package');
    writeForensicPackage(spec, output);
    expect(verifyForensicPackage(output, manifestSha256(output))).toEqual({ valid: true, findings: [] });
  });

  it.each([{ escapes: 6, accepted: true }, { escapes: 7, accepted: false }])('enforces the eight-pass publication boundary: $escapes escape links', ({ escapes, accepted }) => {
    const spec = validSpec() as { narrative: Array<{ summary: string }> };
    spec.narrative[0]!.summary = '\\' + 'u005c'.repeat(escapes) + 'u0078';
    const output = path.join(tmp.make('escape-budget-boundary'), 'package');
    if (accepted) {
      writeForensicPackage(spec, output);
      expect(verifyForensicPackage(output, manifestSha256(output))).toEqual({ valid: true, findings: [] });
    } else {
      expect(() => writeForensicPackage(spec, output)).toThrow(/redaction_violation: narrative\.json exceeds the public escape-decoding budget/);
      expect(existsSync(output)).toBe(false);
    }
  });

  it.each(['unicode', 'crlf', 'negative-zero'] as const)('accepts benign decoded content in re-manifested public metadata: %s', (format) => {
    const output = path.join(tmp.make('benign-escape'), 'package');
    writeForensicPackage(validSpec(), output);
    const member = path.join(output, 'evidence.json');
    const original = readFileSync(member, 'utf8');
    const encoded = format === 'unicode' ? original.replace('message', '\\u006dessage')
      : format === 'crlf' ? original.replaceAll('\n', '\r\n')
        : original.replace('"byte_start": 0', '"byte_start": -0');
    expect(encoded).not.toBe(original);
    expect(JSON.stringify(JSON.parse(encoded))).toBe(JSON.stringify(JSON.parse(original)));
    writeFileSync(member, encoded);
    const manifestPath = path.join(output, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Array<{ path: string; bytes: number; sha256: string }> };
    const row = manifest.files.find((file) => file.path === 'evidence.json');
    expect(row).toBeDefined();
    row!.bytes = Buffer.byteLength(encoded);
    row!.sha256 = sha256(encoded);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(verifyForensicPackage(output, manifestSha256(output))).toEqual({ valid: true, findings: [] });
  });

  it.each(['type', 'role'] as const)('redacts synthetic credentials in public envelope %s', (field) => {
    const spec = validSpec() as MutableSearchSpec;
    const syntheticToken = 'ghp_' + 'A'.repeat(24);
    spec.searches[0]!.sources[0]!.hits[0]!.envelope[field] = syntheticToken;
    const output = path.join(tmp.make('envelope'), 'package');
    writeForensicPackage(spec, output, { forbiddenTerms: ['unrelated-fixture-term'] });
    expect(readFileSync(path.join(output, 'evidence.json'), 'utf8')).not.toContain(syntheticToken);
    expect(verifyForensicPackage(output, manifestSha256(output))).toEqual({ valid: true, findings: [] });
  });

  it('rejects a normalized empty all_tokens query while preserving ordinary query behavior', async () => {
    const source = path.join(tmp.make('all-tokens'), 'source.jsonl');
    writeFileSync(source, '{"type":"message","text":"ordinary content"}\n');
    const scan = (text: string) => scanJsonlHarnessSource({
      family: 'codex', pass: 1, sourceAlias: 'query-fixture', sourcePath: source,
      expectedSha256: sha256(readFileSync(source)),
      queries: [{ id: 'Q01', mode: 'all_tokens', text }],
      limits: { maxSourceBytes: 10000, maxRecordBytes: 1000, maxHits: 10 },
    });
    expect((await scan('ordinary')).metrics.candidates).toBe(1);
    expect((await scan('absentword')).metrics.candidates).toBe(0);
    await expect(scan('---')).rejects.toThrow(/tokens/);
  });

  it.each([[12, 11], [5, 5], [0, 11]])('rejects impossible JSONL byte range %i..%i', (start, end) => {
    const receipt = searchResult('codex', 1, 'range') as Mutable<ForensicHarnessSearchResult>;
    receipt.sources[0]!.hits[0]!.locator = { kind: 'jsonl', line: 1, byte_start: start, byte_end: end };
    expect(() => parseForensicHarnessSearchResult(receipt)).toThrow(/locator.*range/);
  });

  it('refuses a complete receipt that omitted an observed match', () => {
    const receipt = searchResult('codex', 1, 'omitted') as Mutable<ForensicHarnessSearchResult>;
    receipt.sources[0]!.hits = [];
    receipt.metrics.candidates = 0;
    receipt.metrics.new_evidence = 0;
    expect(() => parseForensicHarnessSearchResult(receipt)).toThrow(/complete.*matches/);
    receipt.sources[0]!.complete = false;
    receipt.sources[0]!.findings = [{ code: 'FORENSIC_HIT_LIMIT' }];
    receipt.metrics.failed_sources = 1;
    expect(parseForensicHarnessSearchResult(receipt).sources[0]!.complete).toBe(false);
  });

  it.each(['claude', 'codex', 'opencode'] as const)('rejects duplicate physical locators within a %s source', (family) => {
    const spec = validSpec() as MutableSearchSpec;
    const search = spec.searches.find((entry) => entry.family === family && entry.pass === 1)!;
    const source = search.sources[0]!;
    source.identity.bytes = 20;
    source.records_examined = 2;
    source.matches_observed = 2;
    const second = structuredClone(source.hits[0]!);
    second.locator = family === 'opencode'
      ? { kind: 'sqlite-row', table: 'message', row_hash: sha256('row-2') }
      : { kind: 'jsonl', line: 2, byte_start: 10, byte_end: 20 };
    source.hits.push(second);
    search.metrics.candidates = 2;
    expect(parseForensicHarnessSearchResult(search).sources[0]!.hits).toHaveLength(2);
    expect(() => parseForensicPackageSpec(spec)).not.toThrow();
    source.hits[1] = structuredClone(source.hits[0]!);
    expect(() => parseForensicHarnessSearchResult(search)).toThrow(/locator.*unique/);
    expect(() => parseForensicPackageSpec(spec)).toThrow(/locator.*unique/);
  });

  it.each(['claude', 'codex'] as const)('rejects a changed line label over the same %s physical record', (family) => {
    const receipt = searchResult(family, 1, 'duplicate-offset') as Mutable<ForensicHarnessSearchResult>;
    const source = receipt.sources[0]!;
    const second = structuredClone(source.hits[0]!);
    expect(second.locator.kind).toBe('jsonl');
    second.locator = { kind: 'jsonl', line: 2, byte_start: 0, byte_end: 10 };
    source.hits.push(second);
    source.records_examined = 2;
    source.matches_observed = 2;
    receipt.metrics.candidates = 2;
    expect(() => parseForensicHarnessSearchResult(receipt)).toThrow(/locator.*unique/);
  });

  it.each([
    ['claude', 'duplicate'], ['codex', 'duplicate'],
    ['claude', 'reversed'], ['codex', 'reversed'],
  ] as const)('rejects contradictory %s line labels across distinct ranges: %s', (family, contradiction) => {
    const receipt = searchResult(family, 1, 'line-labels') as Mutable<ForensicHarnessSearchResult>;
    const source = receipt.sources[0]!;
    source.identity.bytes = 30;
    source.records_examined = 3;
    source.matches_observed = 2;
    const second = structuredClone(source.hits[0]!);
    second.locator = { kind: 'jsonl', line: 3, byte_start: 20, byte_end: 30 };
    source.hits.unshift(second);
    receipt.metrics.candidates = 2;
    expect(parseForensicHarnessSearchResult(receipt).sources[0]!.hits).toHaveLength(2);
    second.locator.line = contradiction === 'duplicate' ? 1 : 2;
    if (contradiction === 'reversed') source.hits[1]!.locator = { kind: 'jsonl', line: 3, byte_start: 0, byte_end: 10 };
    expect(() => parseForensicHarnessSearchResult(receipt)).toThrow(/locator.*line.*increas/);
  });

  it.each(['claude', 'codex'] as const)('rejects overlapping physical ranges within a %s source', (family) => {
    const receipt = searchResult(family, 1, 'overlap') as Mutable<ForensicHarnessSearchResult>;
    const source = receipt.sources[0]!;
    source.identity.bytes = 20;
    const second = structuredClone(source.hits[0]!);
    second.locator = { kind: 'jsonl', line: 2, byte_start: 10, byte_end: 20 };
    source.hits.unshift(second);
    source.records_examined = 2;
    source.matches_observed = 2;
    receipt.metrics.candidates = 2;
    expect(parseForensicHarnessSearchResult(receipt).sources[0]!.hits).toHaveLength(2);
    second.locator = { kind: 'jsonl', line: 2, byte_start: 1, byte_end: 10 };
    expect(() => parseForensicHarnessSearchResult(receipt)).toThrow(/locator.*overlap/);
  });

  it.each([false, true])('accounts for SQLite content when BLOB=%s', (blob) => {
    const databasePath = path.join(tmp.make('sqlite-content'), 'source.db');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE session (title TEXT); CREATE TABLE message (data TEXT); CREATE TABLE part (data TEXT)');
    database.prepare('INSERT INTO message VALUES (?)').run(blob ? Buffer.from('needle') : 'needle');
    database.close();
    const result = scanOpenCodeSnapshot({
      pass: 1, sourceAlias: 'sqlite-content', databasePath,
      expectedSha256: sha256(readFileSync(databasePath)),
      queries: [{ id: 'Q01', mode: 'substring', text: 'needle' }],
      limits: { maxSourceBytes: 1000000, maxRows: 100, maxHits: 10 },
    });
    expect(result.sources[0]!.findings).toEqual([]);
    expect(result.sources[0]!.complete).toBe(true);
    expect(result.metrics.candidates).toBe(1);
  });

  it('marks invalid UTF-8 SQLite content incomplete instead of silently dropping it', () => {
    const databasePath = path.join(tmp.make('sqlite-invalid-content'), 'source.db');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE session (title TEXT); CREATE TABLE message (data TEXT); CREATE TABLE part (data TEXT)');
    database.prepare('INSERT INTO message VALUES (?)').run(Buffer.from([0xff]));
    database.close();
    const result = scanOpenCodeSnapshot({
      pass: 1, sourceAlias: 'sqlite-content', databasePath,
      expectedSha256: sha256(readFileSync(databasePath)),
      queries: [{ id: 'Q01', mode: 'substring', text: 'needle' }],
      limits: { maxSourceBytes: 1000000, maxRows: 100, maxHits: 10 },
    });
    expect(result.sources[0]!.complete).toBe(false);
    expect(result.sources[0]!.findings).toEqual([{ code: 'FORENSIC_SQLITE_INVALID_UTF8:message:data' }]);
    expect(result.metrics.failed_sources).toBe(1);
  });

  it('refuses an oversized package member before allocating its content', () => {
    const output = path.join(tmp.make('oversized-member'), 'package');
    writeForensicPackage(validSpec(), output);
    const expected = manifestSha256(output);
    const member = path.join(output, 'analysis.json');
    const originalRead = fs.readFileSync;
    const originalOpen = fs.openSync;
    const reads: string[] = [];
    let rejectContentAccess = false;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === member) {
        reads.push('readFileSync');
        if (rejectContentAccess) throw new Error('synthetic-allocation-stop');
      }
      return Reflect.apply(originalRead, fs, args);
    });
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (args[0] === member) {
        reads.push('openSync');
        if (rejectContentAccess) throw new Error('synthetic-allocation-stop');
      }
      return Reflect.apply(originalOpen, fs, args);
    });
    syncBuiltinESMExports();
    try {
      expect(verifyForensicPackage(output, expected)).toEqual({ valid: true, findings: [] });
      expect(reads.length).toBeGreaterThan(0);
      fs.truncateSync(member, statSync(member).size + 1048576);
      reads.length = 0;
      rejectContentAccess = true;
      expect(verifyForensicPackage(output, expected)).toMatchObject({
        valid: false, findings: expect.arrayContaining(['size-mismatch:analysis.json']),
      });
      expect(reads).toEqual([]);
    } finally { spy.mockRestore(); openSpy.mockRestore(); syncBuiltinESMExports(); }
  });

  it('refuses a dangling member symlink listed by the pinned manifest', () => {
    const root = tmp.make('dangling-member');
    const output = path.join(root, 'package');
    writeForensicPackage(validSpec(), output);
    const expected = manifestSha256(output);
    const member = path.join(output, 'analysis.json');
    unlinkSync(member);
    symlinkSync(path.join(root, 'nonexistent.json'), member);
    expect(verifyForensicPackage(output, expected)).toEqual({
      valid: false, findings: ['file-not-regular:analysis.json'],
    });
  });

  it('refuses a member changed to a symlink after metadata inspection', () => {
    const root = tmp.make('member-replacement');
    const output = path.join(root, 'package');
    writeForensicPackage(validSpec(), output);
    const expected = manifestSha256(output);
    const member = path.join(output, 'analysis.json');
    const target = path.join(root, 'same-bytes.json');
    writeFileSync(target, readFileSync(member));
    const originalStat = fs.lstatSync;
    let replaced = false;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const result = Reflect.apply(originalStat, fs, args);
      if (args[0] === member && !replaced) {
        replaced = true;
        unlinkSync(member);
        symlinkSync(target, member);
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      const result = verifyForensicPackage(output, expected);
      expect(replaced).toBe(true);
      expect(result).toMatchObject({ valid: false });
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });
});

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
