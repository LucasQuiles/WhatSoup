import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveTrustedGit } from '../../scripts/lib/ci-control/trusted-git.ts';
import { readExactBlobs, readExactCommitMetadata } from '../../scripts/lib/ci-control/git-input.ts';
import {
  __setTestGitPath,
  type CatFileBatchRow,
  type EvidenceGitErrorCodes,
  parseCatFileBatch,
  readObjectBatch,
} from '../../scripts/lib/ci-control/git-input-core.ts';

import {
  blobOid,
  cleanupTemporaryRoots,
  commitMetadataResponses,
  commitOid,
  expectCode,
  gitEnvironment,
  type GitInputModule,
  type GitShimResponse,
  rawCommitBody,
  registerTemporaryRoot,
  resolveShimResponse,
  responseKey,
  withGitShim,
  withMockedGitInput,
} from './support/ci-control-git-input-fixtures.ts';

let shimPid: number | undefined;

afterEach(() => {
  // Only a test that failed before it saw its shim gone leaves a pid here.
  if (shimPid !== undefined) {
    const pid = shimPid;
    shimPid = undefined;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  cleanupTemporaryRoots();
});

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

const CHECK_ARGS = ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'];
const CONTENT_ARGS = ['cat-file', '--batch'];
const CODES: EvidenceGitErrorCodes = {
  unavailable: 'ci.input.blob-unavailable',
  timeout: 'ci.input.git-execution-timeout',
  budget: 'ci.input.blob-set-budget',
};
const MALFORMED = 'ci.input.blob-set-malformed';
const OID = 'a'.repeat(40);
const OTHER_OID = 'b'.repeat(40);

/** One `--batch` row framed with the body's true length. */
function contentFrame(oid: string, type: string, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${oid} ${type} ${body.byteLength}\n`, 'latin1'),
    body,
    Buffer.from('\n'),
  ]);
}

function contentRow(oid: string, type: string, body: Buffer): GitShimResponse {
  return { stdoutBase64: contentFrame(oid, type, body).toString('base64') };
}

function shimBatch(
  responses: Record<string, GitShimResponse>,
  oids: readonly string[],
  mode: 'check' | 'content',
): CatFileBatchRow[] {
  return withGitShim(responses, (cwd) => readObjectBatch(cwd, oids, mode, CODES, MALFORMED, 4_096));
}

type CoreModule = typeof import('../../scripts/lib/ci-control/git-input-core.ts');

/** Run against a fresh git-input-core.ts whose every `execFileSync` call is counted. */
async function withCountedSpawns(
  run: (core: CoreModule) => unknown,
): Promise<{ outcome: unknown; spawns: string[][] }> {
  const spawns: string[][] = [];
  vi.resetModules();
  vi.doMock('node:child_process', () => ({
    execFileSync: (file: string, args: string[], options: Parameters<typeof execFileSync>[2]) => {
      spawns.push(args);
      return execFileSync(file, args, options as never);
    },
  }));
  try {
    const core = await import('../../scripts/lib/ci-control/git-input-core.ts');
    let outcome: unknown;
    try {
      outcome = run(core);
    } catch (error) {
      outcome = error;
    }
    return { outcome, spawns };
  } finally {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  }
}

/**
 * Read commits through fixed batch output: the object format, one check batch, then each
 * content batch in call order. Returns the error the reader throws, or its result.
 */
async function readCommitsThroughBatches(
  oids: readonly string[],
  check: string,
  contents: readonly Buffer[],
): Promise<{ outcome: unknown; contentReads: number }> {
  const formatCall = JSON.stringify(['rev-parse', '--show-object-format']);
  let contentReads = 0;
  const outcome = await withMockedGitInput<unknown>((_file, args) => {
    const call = JSON.stringify(args.slice(1));
    if (call === formatCall) return Buffer.from('sha1\n');
    if (call === JSON.stringify(CHECK_ARGS)) return Buffer.from(check);
    if (call === JSON.stringify(CONTENT_ARGS) && contentReads < contents.length) {
      contentReads += 1;
      return contents[contentReads - 1]!;
    }
    throw new Error(`unexpected synthetic command: ${call}`);
  }, (isolated) => {
    try {
      return isolated.readExactCommitMetadata('/isolated-fixture', oids);
    } catch (error) {
      return error;
    }
  });
  return { outcome, contentReads };
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

describe('readObjectBatch and parseCatFileBatch', () => {
  it('returns a missing object as a row and does not throw', () => {
    expect(shimBatch({ [responseKey(CHECK_ARGS)]: { stdout: `${OID} missing\n` } }, [OID], 'check'))
      .toEqual([{ oid: OID, kind: 'missing' }]);
  });

  it('throws the unavailable code when the batch process fails', () => {
    expectCode(() => shimBatch({
      [responseKey(CHECK_ARGS)]: { stderr: 'private batch failure', exit: 128 },
    }, [OID], 'check'), CODES.unavailable);
  });

  it('rejects a row that echoes a different object id', () => {
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OTHER_OID} blob 3\n`), [OID], 'check', MALFORMED),
      MALFORMED,
    );
  });

  it('rejects bytes after the last row', () => {
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID} blob 3\nextra`), [OID], 'check', MALFORMED),
      MALFORMED,
    );
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID} blob 3\nabc\n\n`), [OID], 'content', MALFORMED),
      MALFORMED,
    );
  });

  it('rejects a content row without its terminating LF', () => {
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID} blob 3\nabc`), [OID], 'content', MALFORMED),
      MALFORMED,
    );
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID} blob 3\nabcX`), [OID], 'content', MALFORMED),
      MALFORMED,
    );
  });

  it('rejects every size that is not a canonical decimal', () => {
    for (const size of ['1e3', ' 12', '-1', '012']) {
      expectCode(
        () => parseCatFileBatch(Buffer.from(`${OID} blob ${size}\n`), [OID], 'check', MALFORMED),
        MALFORMED,
      );
    }
  });

  it('rejects truncated output', () => {
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID} blob 3\n`), [OID, OTHER_OID], 'check', MALFORMED),
      MALFORMED,
    );
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID} blob 10\nabc\n`), [OID], 'content', MALFORMED),
      MALFORMED,
    );
  });

  it('rejects a canonical size above the largest safe integer', () => {
    const unsafeSize = (2n ** 53n + 1n).toString();
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID} blob ${unsafeSize}\n`), [OID], 'check', MALFORMED),
      MALFORMED,
    );
  });

  it('rejects an ambiguous or short echoed id', () => {
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID} ambiguous\n`), [OID], 'check', MALFORMED),
      MALFORMED,
    );
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID.slice(0, 7)} blob 3\n`), [OID], 'check', MALFORMED),
      MALFORMED,
    );
  });

  it('rejects an unknown type token', () => {
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID} note 3\n`), [OID], 'check', MALFORMED),
      MALFORMED,
    );
  });

  it('reads a missing row in content mode without consuming a body', () => {
    expect(parseCatFileBatch(
      Buffer.from(`${OID} missing\n${OTHER_OID} blob 3\nabc\n`),
      [OID, OTHER_OID],
      'content',
      MALFORMED,
    )).toEqual([
      { oid: OID, kind: 'missing' },
      { oid: OTHER_OID, kind: 'present', type: 'blob', size: 3, bytes: Buffer.from('abc') },
    ]);
  });

  it('rejects a CR in the header line', () => {
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID} blob 3\r\n`), [OID], 'check', MALFORMED),
      MALFORMED,
    );
    expectCode(
      () => parseCatFileBatch(Buffer.from(`${OID} blob 3\r\nabc\n`), [OID], 'content', MALFORMED),
      MALFORMED,
    );
  });

  it('refuses an id that is not 40 lowercase hex digits before starting any process', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ci-control-batch-input-'));
    registerTemporaryRoot(cwd);
    for (const oid of ['abc', 'A'.repeat(40), `${OID}\n`, `${OID}\n${OTHER_OID}`]) {
      const { outcome, spawns } = await withCountedSpawns(
        (core) => core.readObjectBatch(cwd, [OID, oid], 'check', CODES, MALFORMED, 4_096),
      );
      expect(outcome).toMatchObject({ code: MALFORMED });
      expect(spawns).toEqual([]);
    }
  });

  it('reads nothing for an empty set; the readers still read the object format', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ci-control-batch-input-'));
    registerTemporaryRoot(cwd);
    for (const mode of ['check', 'content'] as const) {
      const { outcome, spawns } = await withCountedSpawns(
        (core) => core.readObjectBatch(cwd, [], mode, CODES, MALFORMED, 4_096),
      );
      expect(outcome).toEqual([]);
      expect(spawns).toEqual([]);
    }

    const repository = objectRepository();
    for (const read of [
      (isolated: GitInputModule) => isolated.readExactCommitMetadata(repository.root, []),
      (isolated: GitInputModule) => isolated.readExactBlobs(repository.root, []),
    ]) {
      const spawns: string[][] = [];
      const outcome = await withMockedGitInput<readonly unknown[]>((file, args, options) => {
        spawns.push(args);
        return execFileSync(file, args, options as never) as unknown as Buffer;
      }, read);
      expect(outcome).toEqual([]);
      expect(spawns).toEqual([['--no-replace-objects', 'rev-parse', '--show-object-format']]);
    }
  }, 30_000);

  it('derives check and content rows for a commit and a blob from one record', () => {
    const commitBody = rawCommitBody({ message: 'pin\n' });
    const commitId = commitOid(commitBody);
    const blobBytes = Buffer.from('blob body\n');
    const blobId = blobOid(blobBytes);
    const record = {
      ...commitMetadataResponses([{ oid: commitId, body: commitBody }]),
      [responseKey(['cat-file', '-t', '--', blobId])]: { stdout: 'blob\n' },
      [responseKey(['cat-file', '-s', '--', blobId])]: { stdout: `${blobBytes.byteLength}\n` },
      [responseKey(['cat-file', 'blob', '--', blobId])]: { stdoutBase64: blobBytes.toString('base64') },
    };
    const expected: CatFileBatchRow[][] = [
      [{ oid: commitId, kind: 'present', type: 'commit', size: commitBody.byteLength, bytes: null }],
      [{ oid: blobId, kind: 'present', type: 'blob', size: blobBytes.byteLength, bytes: null }],
      [{ oid: commitId, kind: 'present', type: 'commit', size: commitBody.byteLength, bytes: commitBody }],
      [{ oid: blobId, kind: 'present', type: 'blob', size: blobBytes.byteLength, bytes: blobBytes }],
    ];
    expect(withGitShim(record, (cwd) => [
      readObjectBatch(cwd, [commitId], 'check', CODES, MALFORMED, 4_096),
      readObjectBatch(cwd, [blobId], 'check', CODES, MALFORMED, 4_096),
      readObjectBatch(cwd, [commitId], 'content', CODES, MALFORMED, 4_096),
      readObjectBatch(cwd, [blobId], 'content', CODES, MALFORMED, 4_096),
    ])).toEqual(expected);
  });

  it('refuses a requested object that has no keys', () => {
    expectCode(() => shimBatch({}, [OID], 'check'), CODES.unavailable);
  });

  it('answers from an explicit argv key before deriving a batch', () => {
    expect(shimBatch({
      [responseKey(['cat-file', '-t', '--', OID])]: { stdout: 'blob\n' },
      [responseKey(['cat-file', '-s', '--', OID])]: { stdout: '3\n' },
      [responseKey(CHECK_ARGS)]: { stdout: `${OID} missing\n` },
    }, [OID], 'check')).toEqual([{ oid: OID, kind: 'missing' }]);
  });

  it('answers from an argv and stdin key before the argv key and derivation', () => {
    expect(shimBatch({
      [responseKey(['cat-file', '-t', '--', OID])]: { stdout: 'blob\n' },
      [responseKey(['cat-file', '-s', '--', OID])]: { stdout: '3\n' },
      [responseKey(CHECK_ARGS)]: { stdout: `${OID} missing\n` },
      [responseKey(CHECK_ARGS, `${OID}\n`)]: { stdout: `${OID} tree 7\n` },
    }, [OID], 'check')).toEqual([{ oid: OID, kind: 'present', type: 'tree', size: 7, bytes: null }]);
  });

  it('answers a failed per-object type read with that response in one walk', () => {
    const typeKey = responseKey(['cat-file', '-t', '--', OID]);
    const record: Record<string, GitShimResponse> = {
      [typeKey]: { stderr: 'private type failure', exit: 1 },
    };
    expect(resolveShimResponse(record, CHECK_ARGS, `${OID}\n`)).toBe(record[typeKey]);
  });

  it('answers a non-canonical per-object type with a frame the parser rejects', () => {
    expectCode(() => shimBatch({
      [responseKey(['cat-file', '-t', '--', OID])]: { stdout: 'blob' },
    }, [OID], 'check'), MALFORMED);
  });

  it('maps a content row of another type to the per-object unavailable codes', () => {
    const bytes = Buffer.from('blob body\n');
    const blobId = blobOid(bytes);
    expectCode(() => withGitShim({
      [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
      [responseKey(['cat-file', '-t', '--', blobId])]: { stdout: 'blob\n' },
      [responseKey(['cat-file', '-s', '--', blobId])]: { stdout: `${bytes.byteLength}\n` },
      [responseKey(['cat-file', 'blob', '--', blobId])]: { stdoutBase64: bytes.toString('base64') },
      [responseKey(CONTENT_ARGS, `${blobId}\n`)]: contentRow(blobId, 'commit', bytes),
    }, (cwd) => readExactBlobs(cwd, [blobId])), 'ci.input.blob-unavailable');

    const body = rawCommitBody({ message: 'typed\n' });
    const commitId = commitOid(body);
    expectCode(() => withGitShim({
      ...commitMetadataResponses([{ oid: commitId, body }]),
      [responseKey(CONTENT_ARGS, `${commitId}\n`)]: contentRow(commitId, 'blob', body),
    }, (cwd) => readExactCommitMetadata(cwd, [commitId])), 'ci.input.commit-metadata-unavailable');
  });
});

describe('error order in batched commit reads', () => {
  // A batch returns every row at once. Each row is still checked, then identity-checked
  // and parsed or compared, before the next row, as the per-object reads did.
  it('reports an earlier commit error before a later unavailable row in the content read', async () => {
    const malformed = Buffer.from('not a commit\n');
    const valid = rawCommitBody({ message: 'valid\n' });
    // Same length, one byte different: the identity check fails.
    const changed = Buffer.from(valid);
    changed[0] = 0x54;
    const later = { missing: `${MISSING_OID} missing\n`, blob: `${MISSING_OID} blob 3\nabc\n` };
    for (const { earlierOid, earlierBody, laterRow, code } of [
      { earlierOid: commitOid(malformed), earlierBody: malformed, laterRow: later.missing,
        code: 'ci.input.commit-metadata-malformed' },
      { earlierOid: commitOid(valid), earlierBody: changed, laterRow: later.missing,
        code: 'ci.input.commit-metadata-identity-mismatch' },
      { earlierOid: commitOid(malformed), earlierBody: malformed, laterRow: later.blob,
        code: 'ci.input.commit-metadata-malformed' },
    ]) {
      const { outcome } = await readCommitsThroughBatches(
        [earlierOid, MISSING_OID],
        `${earlierOid} commit ${earlierBody.byteLength}\n${MISSING_OID} commit 3\n`,
        [Buffer.concat([contentFrame(earlierOid, 'commit', earlierBody), Buffer.from(laterRow)])],
      );
      expect(outcome).toMatchObject({ code });
    }
  });

  it('reports an earlier changed re-read before a later missing row in the re-read', async () => {
    const commits = [rawCommitBody({ message: 'first\n' }), rawCommitBody({ message: 'second\n' })]
      .map((body) => ({ oid: commitOid(body), body }))
      .sort((left, right) => (left.oid < right.oid ? -1 : 1));
    const earlier = commits[0]!;
    const later = commits[1]!;
    // Same length, one byte different: only the byte comparison can reject it.
    const changed = Buffer.from(earlier.body);
    changed[0] = 0x54;
    const { outcome, contentReads } = await readCommitsThroughBatches(
      [earlier.oid, later.oid],
      `${earlier.oid} commit ${earlier.body.byteLength}\n${later.oid} commit ${later.body.byteLength}\n`,
      [
        Buffer.concat([
          contentFrame(earlier.oid, 'commit', earlier.body),
          contentFrame(later.oid, 'commit', later.body),
        ]),
        Buffer.concat([
          contentFrame(earlier.oid, 'commit', changed),
          Buffer.from(`${later.oid} missing\n`),
        ]),
      ],
    );
    expect(outcome).toMatchObject({ code: 'ci.input.commit-metadata-identity-mismatch' });
    expect(contentReads).toBe(2);
  });
});

describe('batch process cleanup', () => {
  it('kills a batch process that ignores SIGTERM when the call times out', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-control-batch-kill-'));
    registerTemporaryRoot(root);
    const shimPath = join(root, 'git');
    // A constant script: no path or environment value is written into it. It ignores
    // SIGTERM before anything else, writes its pid relative to its working directory,
    // and `exec` keeps that one pid with no grandchild.
    writeFileSync(shimPath, [
      '#!/bin/sh',
      "trap '' TERM",
      'echo $$ > batch-kill.pid',
      'exec /bin/sleep 5',
      '',
    ].join('\n'), 'utf8');
    chmodSync(shimPath, 0o755);
    const priorGitPath = __setTestGitPath(shimPath);
    let thrown: unknown;
    const start = performance.now();
    try {
      readObjectBatch(root, [OID], 'check', CODES, MALFORMED, 4_096, 1_000);
    } catch (error) {
      thrown = error;
    } finally {
      __setTestGitPath(priorGitPath);
    }
    const elapsed = performance.now() - start;
    // A shell that starts slower than the timeout never writes its pid: fail plainly.
    const pidFile = join(root, 'batch-kill.pid');
    expect(existsSync(pidFile), 'the batch process wrote no pid before the timeout').toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isSafeInteger(pid) && pid > 1, `pid file held ${pid}`).toBe(true);
    shimPid = pid;
    expect(thrown).toMatchObject({ code: CODES.timeout });
    expect(elapsed).toBeLessThan(3_000);
    let probe: unknown;
    try {
      process.kill(pid, 0);
    } catch (error) {
      probe = error;
    }
    expect(probe).toMatchObject({ code: 'ESRCH' });
    shimPid = undefined;
  }, 15_000);
});
