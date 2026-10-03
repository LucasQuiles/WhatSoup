import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveTrustedGit } from '../../scripts/lib/ci-control/trusted-git.ts';
import { readExactBlobs, readExactCommitMetadata } from '../../scripts/lib/ci-control/git-input.ts';

import {
  cleanupTemporaryRoots,
  expectCode,
  gitEnvironment,
  registerTemporaryRoot,
  withMockedGitInput,
} from './support/ci-control-git-input-fixtures.ts';

afterEach(cleanupTemporaryRoots);

const MISSING_OID = 'f'.repeat(40);

interface ObjectRepository {
  root: string;
  env: NodeJS.ProcessEnv;
  blobOids: string[];
  emptyTreeOid: string;
  /** Commits in creation order: each after the first has the previous one as parent. */
  chain: string[];
}

/** A real repository with an empty, a binary and a text blob, and three commits. */
function objectRepository(): ObjectRepository {
  const root = mkdtempSync(join(tmpdir(), 'ci-control-object-batch-'));
  registerTemporaryRoot(root);
  const env = {
    ...gitEnvironment(root),
    GIT_AUTHOR_DATE: '2023-11-14 22:13:20 +0000',
    GIT_COMMITTER_DATE: '2023-11-14 22:13:20 +0000',
  };
  const git = (args: string[]): string => execFileSync(resolveTrustedGit(), args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    killSignal: 'SIGKILL',
  }).trim();
  git(['init', '--quiet', '--object-format=sha1']);
  const blobs: [string, Buffer][] = [
    ['empty.bin', Buffer.alloc(0)],
    ['binary.bin', Buffer.from('\0binary\n0000 blob 3\nafter\0', 'latin1')],
    ['text.txt', Buffer.from('plain text\n', 'utf8')],
  ];
  const blobOids = blobs.map(([name, bytes]) => {
    writeFileSync(join(root, name), bytes);
    return git(['hash-object', '-w', '--', name]);
  });
  const emptyTreeOid = git(['hash-object', '-w', '-t', 'tree', '/dev/null']);
  const chain: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const parent = chain.at(-1);
    chain.push(git([
      'commit-tree', emptyTreeOid,
      ...(parent === undefined ? [] : ['-p', parent]),
      '-m', `c${index}`,
    ]));
  }
  return { root, env, blobOids, emptyTreeOid, chain };
}

/** The per-object oracle: one real `cat-file <type>` process for one object. */
function catFile(repository: ObjectRepository, type: 'blob' | 'commit', oid: string): Buffer {
  return execFileSync(resolveTrustedGit(), ['--no-replace-objects', 'cat-file', type, oid], {
    cwd: repository.root,
    env: repository.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('exact object reads through cat-file batches', () => {
  // The wrapper replaces `execFileSync` from `node:child_process` as git-input-core.ts
  // imports it; every per-object and batch read goes through that one function, and
  // the wrapper passes the product's own options through unchanged.
  it('reads a set of blobs through one check and one content process', async () => {
    const repository = objectRepository();
    let catFileSpawns = 0;
    const batchInputs: string[] = [];
    const blobs = await withMockedGitInput((file, args, options) => {
      if (args[1] === 'cat-file') {
        catFileSpawns += 1;
        if (options?.input !== undefined) batchInputs.push(String(options.input));
      }
      return execFileSync(file, args, options as never) as unknown as Buffer;
    }, (isolated) => isolated.readExactBlobs(repository.root, repository.blobOids));
    expect(catFileSpawns).toBe(2);
    const sortedInput = `${[...repository.blobOids].sort().join('\n')}\n`;
    expect(batchInputs).toEqual([sortedInput, sortedInput]);
    expect(blobs.map((blob) => blob.oid)).toEqual([...repository.blobOids].sort());
  }, 30_000);

  it('reads a set of commits through one check, one content and one re-read process', async () => {
    const repository = objectRepository();
    let catFileSpawns = 0;
    const metadata = await withMockedGitInput((file, args, options) => {
      if (args[1] === 'cat-file') catFileSpawns += 1;
      return execFileSync(file, args, options as never) as unknown as Buffer;
    }, (isolated) => isolated.readExactCommitMetadata(
      repository.root,
      [...repository.chain].sort(),
    ));
    expect(catFileSpawns).toBe(3);
    expect(metadata.map((item) => item.oid)).toEqual([...repository.chain].sort());
  }, 30_000);

  it('returns what per-object reads return for blobs, commits and missing objects', () => {
    const repository = objectRepository();
    const blobs = readExactBlobs(repository.root, repository.blobOids);
    expect(blobs.map((blob) => blob.oid)).toEqual([...repository.blobOids].sort());
    for (const blob of blobs) {
      const oracle = catFile(repository, 'blob', blob.oid);
      expect(Buffer.from(blob.bytes)).toEqual(oracle);
      expect(blob.byteLength).toBe(oracle.byteLength);
      expect(blob.contentSha256).toBe(sha256(oracle));
    }
    expect(blobs.map((blob) => blob.byteLength)).toContain(0);
    expectCode(() => readExactBlobs(repository.root, [MISSING_OID]), 'ci.input.blob-unavailable');
    expectCode(
      () => readExactBlobs(repository.root, [repository.chain[0]!]),
      'ci.input.blob-type-unsupported',
    );

    const metadata = readExactCommitMetadata(repository.root, [...repository.chain].sort());
    expect(metadata.map((item) => item.oid)).toEqual([...repository.chain].sort());
    for (const item of metadata) {
      const oracle = catFile(repository, 'commit', item.oid);
      const position = repository.chain.indexOf(item.oid);
      expect(item).toEqual({
        oid: item.oid,
        treeOid: repository.emptyTreeOid,
        parentOids: position === 0 ? [] : [repository.chain[position - 1]!],
        authorName: repository.env.GIT_AUTHOR_NAME,
        authorEmail: repository.env.GIT_AUTHOR_EMAIL,
        subject: `c${position + 1}`,
        message: `c${position + 1}\n`,
        byteLength: oracle.byteLength,
        contentSha256: sha256(oracle),
      });
    }
    expectCode(
      () => readExactCommitMetadata(repository.root, [MISSING_OID]),
      'ci.input.commit-metadata-unavailable',
    );
  }, 30_000);
});
