import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildProposalIdentity,
  canonicalPathBlobRecords,
  contentFingerprintSha256,
  taskFingerprintSha256,
  type PathBlobRecord,
} from '../../scripts/lib/semantic-quality/fingerprint.ts';

interface FixtureArtifact {
  number: number;
  baseOid: string;
  headOid: string;
  patchIdStable: string;
  pathBlobSet: PathBlobRecord[];
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/boundary-core/history.json', import.meta.url)),
    'utf8',
  ),
) as { artifacts: FixtureArtifact[] };

function artifact(number: number): FixtureArtifact {
  const match = fixture.artifacts.find((item) => item.number === number);
  if (!match) throw new Error(`missing fixture artifact ${number}`);
  return match;
}

describe('semantic boundary content fingerprints', () => {
  it('gives the recreated proposals one canonical content identity', () => {
    const first = artifact(1838);
    const second = artifact(1848);

    expect(contentFingerprintSha256(first.pathBlobSet)).toBe(
      '1e27927ab1b22973ecca0d38f41b17293e1cf6a6e2303098f5fb8db9064b3479',
    );
    expect(contentFingerprintSha256(first.pathBlobSet)).toBe(
      contentFingerprintSha256(second.pathBlobSet),
    );

    const firstProposal = buildProposalIdentity({
      records: first.pathBlobSet,
      patchIdStable: first.patchIdStable,
      baseOid: first.baseOid,
      headOid: first.headOid,
    });
    const secondProposal = buildProposalIdentity({
      records: second.pathBlobSet,
      patchIdStable: second.patchIdStable,
      baseOid: second.baseOid,
      headOid: second.headOid,
    });

    expect(firstProposal.contentFingerprintSha256).toBe(
      secondProposal.contentFingerprintSha256,
    );
    expect(firstProposal.patchIdStable).toBe(secondProposal.patchIdStable);
    expect(firstProposal.proposalFingerprintSha256).not.toBe(
      secondProposal.proposalFingerprintSha256,
    );
  });

  it('normalizes paths and object ids without mutating caller records', () => {
    const records: PathBlobRecord[] = [
      {
        status: 'renamed',
        oldPath: './src//old.ts',
        path: './src///new.ts',
        blobOid: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      },
      {
        status: 'added',
        path: './src/z.ts',
        blobOid: '1234567890ABCDEF1234567890ABCDEF12345678',
      },
    ];
    const original = structuredClone(records);

    expect(canonicalPathBlobRecords(records)).toEqual([
      {
        status: 'added',
        oldPath: null,
        path: 'src/z.ts',
        blobOid: '1234567890abcdef1234567890abcdef12345678',
      },
      {
        status: 'renamed',
        oldPath: 'src/old.ts',
        path: 'src/new.ts',
        blobOid: 'abcdef0123456789abcdef0123456789abcdef01',
      },
    ]);
    expect(records).toEqual(original);
    expect(contentFingerprintSha256(records)).toBe(
      contentFingerprintSha256([...records].reverse()),
    );
  });

  it.each([
    ['path case', { path: 'src/Lib/echo-cache.ts' }],
    ['status', { status: 'modified' as const }],
    ['blob identity', { blobOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
  ])('changes the digest when %s changes', (_label, change) => {
    const original = artifact(1838).pathBlobSet;
    const changed = original.map((record, index) =>
      index === 0 ? { ...record, ...change } : record,
    );

    expect(contentFingerprintSha256(changed)).not.toBe(contentFingerprintSha256(original));
  });

  it('includes both paths in rename and copy identities', () => {
    const renamed: PathBlobRecord = {
      status: 'renamed',
      oldPath: 'src/old.ts',
      path: 'src/new.ts',
      blobOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };
    const copied: PathBlobRecord = {
      status: 'copied',
      oldPath: 'src/source.ts',
      path: 'src/copy.ts',
      blobOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    expect(contentFingerprintSha256([renamed])).not.toBe(
      contentFingerprintSha256([{ ...renamed, oldPath: 'src/other.ts' }]),
    );
    expect(contentFingerprintSha256([copied])).not.toBe(
      contentFingerprintSha256([{ ...copied, oldPath: 'src/other.ts' }]),
    );
  });

  it('uses the deleted blob identity to distinguish deletions', () => {
    const deleted: PathBlobRecord = {
      status: 'deleted',
      path: 'src/removed.ts',
      blobOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    expect(contentFingerprintSha256([deleted])).not.toBe(
      contentFingerprintSha256([{ ...deleted, status: 'added' }]),
    );
    expect(contentFingerprintSha256([deleted])).not.toBe(
      contentFingerprintSha256([
        { ...deleted, blobOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      ]),
    );
  });
});

describe('semantic boundary proposal and task fingerprints', () => {
  it('keeps stable patch evidence separate from content identity', () => {
    const proposal = artifact(1838);
    const identity = buildProposalIdentity({
      records: proposal.pathBlobSet,
      patchIdStable: proposal.patchIdStable.toUpperCase(),
      baseOid: proposal.baseOid,
      headOid: proposal.headOid,
    });

    expect(identity.patchIdStable).toBe(proposal.patchIdStable);
    expect(identity.contentFingerprintSha256).toBe(contentFingerprintSha256(proposal.pathBlobSet));
    expect(identity.proposalFingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes only task whitespace and line endings', () => {
    const normalized = taskFingerprintSha256({
      title: 'Fix duplicate boundary',
      body: 'Reuse the existing owner path.',
    });

    expect(
      taskFingerprintSha256({
        title: '  Fix   duplicate\r\n boundary  ',
        body: '\nReuse the   existing owner path.\r\n',
      }),
    ).toBe(normalized);
    expect(
      taskFingerprintSha256({
        title: 'Fix duplicate boundary',
        body: 'Replace the existing owner path.',
      }),
    ).not.toBe(normalized);
  });
});

describe('semantic boundary fingerprint validation', () => {
  const validOid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it.each([
    ['absolute path', { status: 'added', path: '/src/a.ts', blobOid: validOid }],
    ['parent traversal', { status: 'added', path: 'src/../a.ts', blobOid: validOid }],
    ['empty path', { status: 'added', path: '', blobOid: validOid }],
    ['non-POSIX path', { status: 'added', path: 'src\\a.ts', blobOid: validOid }],
    ['missing object id', { status: 'added', path: 'src/a.ts' }],
    ['malformed object id', { status: 'added', path: 'src/a.ts', blobOid: 'abc' }],
    ['rename without old path', { status: 'renamed', path: 'src/a.ts', blobOid: validOid }],
    ['copy without old path', { status: 'copied', path: 'src/a.ts', blobOid: validOid }],
  ])('rejects an invalid %s', (_label, record) => {
    expect(() => canonicalPathBlobRecords([record as PathBlobRecord])).toThrow(/invalid/i);
  });

  it('rejects duplicate canonical records', () => {
    expect(() =>
      canonicalPathBlobRecords([
        { status: 'added', path: './src//a.ts', blobOid: validOid },
        { status: 'added', path: 'src/a.ts', blobOid: validOid.toUpperCase() },
      ]),
    ).toThrow(/duplicate/i);
  });

  it.each([
    ['patch', { patchIdStable: 'not-an-oid' }],
    ['base', { baseOid: 'not-an-oid' }],
    ['head', { headOid: 'not-an-oid' }],
  ])('rejects a malformed %s identity', (_label, change) => {
    expect(() =>
      buildProposalIdentity({
        records: [{ status: 'added', path: 'src/a.ts', blobOid: validOid }],
        ...change,
      }),
    ).toThrow(/invalid/i);
  });
});
