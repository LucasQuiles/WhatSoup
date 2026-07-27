import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';


import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ExactGitInputError,
  MAX_CHANGE_FACT_COUNT,
  MAX_EXACT_ADDED_LINE_BYTES,
  MAX_EXACT_ADDED_LINE_COUNT,
  MAX_EXACT_ADDED_LINE_PATCH_BYTES,
  MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT,
  MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES,
  MAX_EXACT_ADDED_LINE_CHANGE_COUNT,
  MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT,
  MAX_EXACT_ADDED_LINE_BUDGET_V1,
  MAX_EXACT_AGGREGATE_BLOB_BYTES,
  MAX_EXACT_BLOB_COUNT,
  MAX_EXACT_COMMIT_COUNT,
  MAX_EXACT_COMMIT_PARENT_EDGE_COUNT,
  MAX_EXACT_COMMIT_RANGE_BYTES,
  MAX_EXACT_AGGREGATE_COMMIT_METADATA_BYTES,
  MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES,
  MAX_EXACT_SINGLE_BLOB_BYTES,
  MAX_EXACT_AGGREGATE_TREE_BYTES,
  MAX_EXACT_SINGLE_TREE_BYTES,
  MAX_EXACT_TREE_ENTRY_COUNT,
  MAX_EXACT_TREE_ENTRY_PATH_BYTES,
  MAX_EXACT_TREE_ENTRY_PATH_COUNT,
  MAX_EXACT_TREE_ENTRY_PATH_SEGMENT_COUNT,
  type ExactAddedLineBudgetV1,
  type ExactTreeEntrySetV1,
  readExactChangeFacts,
  readExactAddedLines,
  readExactAddedLinesWithinBudget,
  readExactBlobs,
  readExactCommitRange,
  readExactCommitMetadata,
  readExactTreeEntries,
  readExactTreePaths,
  parseExactTreePathListing,
} from '../../scripts/lib/ci-control/git-input.ts';

import {
  cleanupTemporaryRoots,
  registerTemporaryRoot,
  gitEnvironment,
  git,
  gitWithInput,
  write,
  commit,
  fixture,
  expectCode,
  expectNoVisibleCause,
  hashBlob,
  blobOid,
  commitOid,
  treeOid,
  rawTreeBody,
  sortUtf8,
  rawCommitBody,
  commitMetadataResponses,
  extractModuleSpecifiers,
  GitShimResponse,
  responseKey,
  withGitShim,
  addedLineShimScenario,
  addedFactsShimScenario,
  modifiedFactsShimScenario,
  addedLineBudget,
  emptyRangeResponses,
  treeLookupResponses,
  GitInputModule,
  withMockedGitInput,
  paddedTreeBody,
  treeChain,
  repeatedRawTreeEntries,
} from './support/ci-control-git-input-fixtures.ts';

afterEach(cleanupTemporaryRoots);

describe('hostile exact-object inputs', () => {
  const oid = 'a'.repeat(40);

  it('rejects well-formed change facts that are not bound to the requested commit trees', async () => {
    const { root, baseOid } = fixture();
    write(root, 'actual.txt', 'actual\n');
    const candidateOid = commit(root, 'candidate');
    const substitutedBytes = Buffer.from('substituted\n');
    const substitutedOid = hashBlob(root, substitutedBytes);
    const substitutedRaw = Buffer.from(
      `:000000 100644 ${'0'.repeat(40)} ${substitutedOid} A\0substituted.txt\0`,
      'ascii',
    );

    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: (
        file: string,
        args: string[],
        options: Parameters<typeof execFileSync>[2],
      ) => {
        if (args.includes('diff-tree')) return substitutedRaw;
        return execFileSync(file, args, options as never);
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      let thrown: unknown;
      try {
        isolated.readExactAddedLines(root, { baseOid, candidateOid });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.added-lines.identity-mismatch' });
      expectNoVisibleCause(thrown);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('bounds expanded repeated-subtree occurrences while deriving primitive changes', () => {
    const emptyTreeBody = Buffer.alloc(0);
    const emptyTreeOid = treeOid(emptyTreeBody);
    const oldBottomBody = rawTreeBody([
      { mode: '40000', name: 'old-empty', oid: emptyTreeOid },
    ]);
    const newBottomBody = rawTreeBody([
      { mode: '40000', name: 'new-empty', oid: emptyTreeOid },
    ]);
    const trees = new Map<string, Buffer>([
      [emptyTreeOid, emptyTreeBody],
      [treeOid(oldBottomBody), oldBottomBody],
      [treeOid(newBottomBody), newBottomBody],
    ]);
    let oldTreeOid = treeOid(oldBottomBody);
    let newTreeOid = treeOid(newBottomBody);
    for (let depth = 0; depth < 16; depth += 1) {
      const oldBody = rawTreeBody([
        { mode: '40000', name: 'a', oid: oldTreeOid },
        { mode: '40000', name: 'b', oid: oldTreeOid },
      ]);
      const newBody = rawTreeBody([
        { mode: '40000', name: 'a', oid: newTreeOid },
        { mode: '40000', name: 'b', oid: newTreeOid },
      ]);
      oldTreeOid = treeOid(oldBody);
      newTreeOid = treeOid(newBody);
      trees.set(oldTreeOid, oldBody);
      trees.set(newTreeOid, newBody);
    }
    const baseBody = rawCommitBody({ treeOid: oldTreeOid, message: 'base\n' });
    const baseOid = commitOid(baseBody);
    const candidateBody = rawCommitBody({
      treeOid: newTreeOid,
      parentOids: [baseOid],
      message: 'candidate\n',
    });
    const candidateOid = commitOid(candidateBody);
    const responses = commitMetadataResponses([
      { oid: baseOid, body: baseBody },
      { oid: candidateOid, body: candidateBody },
    ]);
    for (const [oid, body] of trees) {
      responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'tree\n' };
      responses[responseKey(['cat-file', '-s', '--', oid])] = {
        stdout: `${body.byteLength}\n`,
      };
      responses[responseKey(['cat-file', 'tree', '--', oid])] = {
        stdoutBase64: body.toString('base64'),
      };
    }
    responses[responseKey(['merge-base', '--all', baseOid, candidateOid])] = {
      stdout: `${baseOid}\n`,
    };
    responses[responseKey([
      '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
      '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', '--find-renames', '--find-copies',
      '--find-copies-harder', baseOid, candidateOid, '--',
    ])] = { stdout: '' };

    expectCode(
      () => withGitShim(
        responses,
        (cwd) => readExactChangeFacts(cwd, baseOid, candidateOid),
      ),
      'ci.classification.change-set-budget',
    );
  });

  it('batch-validates distinct changed blob types with bounded process count', async () => {
    const { root } = fixture();
    const baseOid = git(root, ['rev-parse', 'HEAD']);
    for (let index = 0; index < 20; index += 1) {
      write(root, `file-${index}.txt`, `distinct-${index}\n`);
    }
    const candidateOid = commit(root, 'distinct blobs');
    const blobOids = new Set(Array.from({ length: 20 }, (_, index) =>
      git(root, ['rev-parse', `${candidateOid}:file-${index}.txt`])));
    let individualTypeCalls = 0;
    let batchTypeCalls = 0;
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: (
        file: string,
        args: string[],
        options: Parameters<typeof execFileSync>[2],
      ) => {
        if (
          args[1] === 'cat-file'
          && args[2] === '-t'
          && blobOids.has(args[4]!)
        ) {
          individualTypeCalls += 1;
        }
        if (args[1] === 'cat-file' && args[2]?.startsWith('--batch-check')) {
          batchTypeCalls += 1;
        }
        return execFileSync(file, args, options as never);
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      expect(isolated.readExactChangeFacts(root, baseOid, candidateOid)).toHaveLength(20);
      expect(individualTypeCalls).toBe(0);
      expect(batchTypeCalls).toBe(2);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('admits a near-ceiling tree graph and rejects one additional level', async () => {
    const run = async (depth: number): Promise<unknown> => {
      const emptyBody = Buffer.alloc(0);
      const emptyOid = treeOid(emptyBody);
      const oldBottom = rawTreeBody([
        { mode: '40000', name: 'old-empty', oid: emptyOid },
      ]);
      const newBottom = rawTreeBody([
        { mode: '40000', name: 'new-empty', oid: emptyOid },
      ]);
      let oldTreeOid = treeOid(oldBottom);
      let newTreeOid = treeOid(newBottom);
      const trees = new Map<string, Buffer>([
        [emptyOid, emptyBody],
        [oldTreeOid, oldBottom],
        [newTreeOid, newBottom],
      ]);
      for (let index = 0; index < depth; index += 1) {
        const oldBody = rawTreeBody([{ mode: '40000', name: 'a', oid: oldTreeOid }]);
        const newBody = rawTreeBody([{ mode: '40000', name: 'a', oid: newTreeOid }]);
        oldTreeOid = treeOid(oldBody);
        newTreeOid = treeOid(newBody);
        trees.set(oldTreeOid, oldBody);
        trees.set(newTreeOid, newBody);
      }
      const baseBody = rawCommitBody({ treeOid: oldTreeOid, message: 'base\n' });
      const baseOid = commitOid(baseBody);
      const candidateBody = rawCommitBody({
        treeOid: newTreeOid,
        parentOids: [baseOid],
        message: 'candidate\n',
      });
      const candidateOid = commitOid(candidateBody);
      const responses = commitMetadataResponses([
        { oid: baseOid, body: baseBody },
        { oid: candidateOid, body: candidateBody },
      ]);
      for (const [oid, body] of trees) {
        responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'tree\n' };
        responses[responseKey(['cat-file', '-s', '--', oid])] = {
          stdout: `${body.byteLength}\n`,
        };
        responses[responseKey(['cat-file', 'tree', '--', oid])] = {
          stdoutBase64: body.toString('base64'),
        };
      }
      responses[responseKey(['merge-base', '--all', baseOid, candidateOid])] = {
        stdout: `${baseOid}\n`,
      };
      responses[responseKey([
        '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
        '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
        '--ignore-submodules=none', '--find-renames', '--find-copies',
        '--find-copies-harder', baseOid, candidateOid, '--',
      ])] = { stdout: '' };
      return withMockedGitInput((_file, args) => {
        const response = responses[responseKey(args.slice(1))];
        if (response === undefined) throw new Error('unexpected synthetic command');
        return response.stdoutBase64 === undefined
          ? Buffer.from(response.stdout ?? '', 'utf8')
          : Buffer.from(response.stdoutBase64, 'base64');
      }, (isolated) => {
        try {
          return isolated.readExactChangeFacts(
            '/isolated-fixture',
            baseOid,
            candidateOid,
          );
        } catch (error) {
          return error;
        }
      });
    };

    expect(await run(498)).toEqual([]);
    expect(await run(499)).toMatchObject({
      code: 'ci.classification.change-set-budget',
    });
  });

  it('scans every changed copy destination line despite untrusted advisory pairing', async () => {
    const { root } = fixture();
    const oldBytes = Buffer.from(
      `${Array.from({ length: 100 }, (_, index) => `old-${index}`).join('\n')}\nBLOCKED_TOKEN\n`,
    );
    const newBytes = Buffer.from(
      `${Array.from({ length: 100 }, (_, index) => `new-${index}`).join('\n')}\nBLOCKED_TOKEN\n`,
    );
    writeFileSync(join(root, 'source.txt'), oldBytes);
    const baseOid = commit(root, 'copy base');
    writeFileSync(join(root, 'new.txt'), newBytes);
    const candidateOid = commit(root, 'copy candidate');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    expect(readExactChangeFacts(root, baseOid, candidateOid)).toMatchObject([{
      status: 'added',
      oldPath: null,
      path: 'new.txt',
    }]);
    const forgedCopy = Buffer.from(
      `:100644 100644 ${oldOid} ${newOid} C001\0source.txt\0new.txt\0`,
      'utf8',
    );
    const detectedKey = responseKey([
      '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
      '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', '--find-renames', '--find-copies',
      '--find-copies-harder', baseOid, candidateOid, '--',
    ]);
    await withMockedGitInput((file, args, options) => {
      if (responseKey(args.slice(1)) === detectedKey) return forgedCopy;
      return execFileSync(file, args, options as never) as unknown as Buffer;
    }, (isolated) => {
      const changes = isolated.readExactAddedLines(root, { baseOid, candidateOid }).changes;
      expect(changes).toMatchObject([{
        status: 'copied',
        oldPath: 'source.txt',
        path: 'new.txt',
      }]);
      expect(changes[0]!.addedLines).toHaveLength(101);
      expect(changes[0]!.addedLines[0]).toMatchObject({ text: 'new-0', newLineNumber: 1 });
      expect(changes[0]!.addedLines.at(-1)).toMatchObject({
        text: 'BLOCKED_TOKEN',
        newLineNumber: 101,
      });
    });
  });

  it('maps a bounded nested copy-source lookup timeout through each public taxonomy', async () => {
    const { root } = fixture();
    write(root, 'nested/source.txt', 'copy source\n');
    const baseOid = commit(root, 'nested copy base');
    write(root, 'target.txt', 'copy source\n');
    const candidateOid = commit(root, 'nested copy candidate');
    const sourceOid = git(root, ['rev-parse', `${baseOid}:nested/source.txt`]);
    const nestedTreeOid = git(root, ['rev-parse', `${baseOid}:nested`]);
    const forgedCopy = Buffer.from(
      `:100644 100644 ${sourceOid} ${sourceOid} C100\0nested/source.txt\0target.txt\0`,
      'utf8',
    );
    const detectedKey = responseKey([
      '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
      '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', '--find-renames', '--find-copies',
      '--find-copies-harder', baseOid, candidateOid, '--',
    ]);
    const nestedTypeKey = responseKey(['cat-file', '-t', '--', nestedTreeOid]);
    const verify = async (
      run: (isolated: GitInputModule) => unknown,
      code: string,
    ): Promise<void> => {
      await withMockedGitInput((file, args, options) => {
        const key = responseKey(args.slice(1));
        if (key === detectedKey) return forgedCopy;
        if (key === nestedTypeKey) {
          throw Object.assign(new Error('private nested timeout'), { code: 'ETIMEDOUT' });
        }
        return execFileSync(file, args, options as never) as unknown as Buffer;
      }, (isolated) => {
        let thrown: unknown;
        try {
          run(isolated);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code });
        expect(String(thrown)).not.toContain('private nested timeout');
        expectNoVisibleCause(thrown);
      });
    };
    await verify(
      (isolated) => isolated.readExactChangeFacts(root, baseOid, candidateOid),
      'ci.classification.execution-timeout',
    );
    await verify(
      (isolated) => isolated.readExactAddedLines(root, { baseOid, candidateOid }),
      'ci.input.added-lines.timeout',
    );
  });

  it('maps an exact missing batch object row through each public taxonomy', async () => {
    const { root, baseOid } = fixture();
    write(root, 'added.txt', 'added\n');
    const candidateOid = commit(root, 'missing batch row');
    const addedOid = git(root, ['rev-parse', `${candidateOid}:added.txt`]);
    const verify = async (
      run: (isolated: GitInputModule) => unknown,
      code: string,
    ): Promise<void> => {
      await withMockedGitInput((file, args, options) => {
        if (args[1] === 'cat-file' && args[2]?.startsWith('--batch-check')) {
          return Buffer.from(`${addedOid} missing\n`, 'ascii');
        }
        return execFileSync(file, args, options as never) as unknown as Buffer;
      }, (isolated) => {
        let thrown: unknown;
        try {
          run(isolated);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code });
        expectNoVisibleCause(thrown);
      });
    };
    await verify(
      (isolated) => isolated.readExactChangeFacts(root, baseOid, candidateOid),
      'ci.input.revision-unavailable',
    );
    await verify(
      (isolated) => isolated.readExactAddedLines(root, { baseOid, candidateOid }),
      'ci.input.added-lines.unavailable',
    );
  });

  it('sanitizes invalid UTF-8 change paths while preserving valid Unicode paths', () => {
    const safePath = 'docs/café-李.txt';
    const safeBytes = Buffer.from('safe\n');
    const { baseOid, candidateOid, responses } = addedFactsShimScenario([
      { path: safePath, bytes: safeBytes },
    ]);
    const safeRaw = Buffer.concat([
      Buffer.from(
        `:000000 100644 ${'0'.repeat(40)} ${blobOid(safeBytes)} A\0`,
        'ascii',
      ),
      Buffer.from(`${safePath}\0`, 'utf8'),
    ]);
    for (const key of Object.keys(responses)) {
      if (key.includes('"diff-tree"')) {
        responses[key] = { stdoutBase64: safeRaw.toString('base64') };
      }
    }
    expect(withGitShim(
      responses,
      (cwd) => readExactChangeFacts(cwd, baseOid, candidateOid),
    )).toMatchObject([{ path: safePath }]);

    const invalidRaw = Buffer.concat([
      Buffer.from(
        `:000000 100644 ${'0'.repeat(40)} ${'1'.repeat(40)} A\0`,
        'ascii',
      ),
      Buffer.from([0xff, 0]),
    ]);
    for (const key of Object.keys(responses)) {
      if (key.includes('"diff-tree"')) {
        responses[key] = { stdoutBase64: invalidRaw.toString('base64') };
      }
    }
    let thrown: unknown;
    try {
      withGitShim(
        responses,
        (cwd) => readExactChangeFacts(cwd, baseOid, candidateOid),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'ci.classification.change-set-malformed' });
    expect(String(thrown)).not.toContain('encoded data');
    expectNoVisibleCause(thrown);
  });

  it('rejects a full-tree path listing that disagrees with verified tree bytes', () => {
    const leafOid = '1'.repeat(40);
    const treeBody = rawTreeBody([{ mode: '100644', name: 'safe.txt', oid: leafOid }]);
    const rootTreeOid = treeOid(treeBody);
    const commitBody = rawCommitBody({ treeOid: rootTreeOid });
    const candidateOid = commitOid(commitBody);
    const listingKey = responseKey(['ls-tree', '-rz', '--full-tree', rootTreeOid]);
    const responses = treeLookupResponses({
      candidateOid,
      commitBody,
      trees: new Map([[rootTreeOid, treeBody]]),
    });
    const listing = (path: string): GitShimResponse => ({
      stdoutBase64: Buffer.from(
        `100644 blob ${leafOid}\t${path}\0`,
        'utf8',
      ).toString('base64'),
    });

    expect(withGitShim(
      { ...responses, [listingKey]: listing('safe.txt') },
      (cwd) => readExactTreePaths(cwd, candidateOid),
    )).toMatchObject({ paths: ['safe.txt'] });
    expectCode(
      () => withGitShim(
        { ...responses, [listingKey]: listing('substitute.txt') },
        (cwd) => readExactTreePaths(cwd, candidateOid),
      ),
      'ci.input.tree-entry-identity-mismatch',
    );
  });

  it('bounds expanded entry occurrences in repeated-subtree graphs', () => {
    let treeBody = rawTreeBody([]);
    let rootTreeOid = treeOid(treeBody);
    const trees = new Map<string, Buffer>([[rootTreeOid, treeBody]]);
    for (let depth = 0; depth < 16; depth += 1) {
      treeBody = rawTreeBody([
        { mode: '40000', name: 'a', oid: rootTreeOid },
        { mode: '40000', name: 'b', oid: rootTreeOid },
      ]);
      rootTreeOid = treeOid(treeBody);
      trees.set(rootTreeOid, treeBody);
    }
    const commitBody = rawCommitBody({ treeOid: rootTreeOid });
    const candidateOid = commitOid(commitBody);
    const responses = treeLookupResponses({ candidateOid, commitBody, trees });
    responses[responseKey(['ls-tree', '-rz', '--full-tree', rootTreeOid])] = { stdout: '' };

    expectCode(
      () => withGitShim(
        responses,
        (cwd) => readExactTreePaths(cwd, candidateOid),
      ),
      'ci.input.tree-entry-budget',
    );
  });

  it('checks the aggregate tree-listing byte budget before copying input', () => {
    const exact = new Uint8Array(MAX_EXACT_AGGREGATE_TREE_BYTES);
    exact[exact.byteLength - 1] = 1;
    const oneOver = new Uint8Array(MAX_EXACT_AGGREGATE_TREE_BYTES + 1);
    const from = vi.spyOn(Buffer, 'from');
    let exactCalls: number;
    let overCalls: number;
    try {
      expectCode(
        () => parseExactTreePathListing(exact),
        'ci.input.tree-entry-malformed',
      );
      exactCalls = from.mock.calls.length;
      from.mockClear();
      expectCode(
        () => parseExactTreePathListing(oneOver),
        'ci.input.tree-entry-budget',
      );
      overCalls = from.mock.calls.length;
    } finally {
      from.mockRestore();
    }
    expect(exactCalls!).toBeGreaterThan(0);
    expect(overCalls!).toBe(0);
  });

  it('copies a genuine tree listing without invoking shadowed typed-array accessors', () => {
    const listing = Uint8Array.from(Buffer.from(
      `100644 blob ${'1'.repeat(40)}\tsafe.txt\0`,
      'utf8',
    ));
    let accessorCalls = 0;
    for (const property of ['byteLength', 'byteOffset', 'buffer', 'length'] as const) {
      Object.defineProperty(listing, property, {
        configurable: true,
        get: () => {
          accessorCalls += 1;
          throw new Error(`hostile ${property} accessor`);
        },
      });
    }
    expect(parseExactTreePathListing(listing)).toEqual(['safe.txt']);
    expect(accessorCalls).toBe(0);
  });

  it('sanitizes hostile candidate identities before tree Git access', () => {
    const hostileOid = {
      [Symbol.toPrimitive]: () => {
        throw new Error('private tree-path trap');
      },
    };
    let thrown: unknown;
    try {
      readExactTreePaths('/not-a-repository', hostileOid as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'ci.input.tree-entry-malformed' });
    expect(String(thrown)).not.toContain('private tree-path trap');
    expectNoVisibleCause(thrown);
  });

  it('sanitizes commit-range proxies before Git access', () => {
    const valid = { baseOid: oid, remoteOid: null, localOid: oid };
    const trapped = new Proxy(valid, {
      getPrototypeOf: () => { throw new Error('private commit-range trap'); },
    });
    const revoked = Proxy.revocable(valid, {});
    revoked.revoke();
    for (const value of [new Proxy(valid, {}), trapped, revoked.proxy]) {
      let thrown: unknown;
      try {
        readExactCommitRange('/not-a-repository', value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.commit-range-malformed' });
      expect(String(thrown)).not.toContain('private commit-range trap');
      expectNoVisibleCause(thrown);
    }
  });

  it('sanitizes proxy and malformed blob arrays before Git access', () => {
    const trapped = new Proxy([oid], {
      getOwnPropertyDescriptor: () => { throw new Error('private blob-set trap'); },
    });
    const revoked = Proxy.revocable([oid], {});
    revoked.revoke();
    const sparse = new Array<string>(1);
    const extraKey = [oid];
    Object.defineProperty(extraKey, 'extra', { enumerable: true, value: oid });
    const customPrototype = [oid];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
    for (const value of [
      new Proxy([oid], {}), trapped, revoked.proxy, sparse, extraKey, customPrototype,
    ]) {
      let thrown: unknown;
      try {
        readExactBlobs('/not-a-repository', value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.blob-set-malformed' });
      expect(String(thrown)).not.toContain('private blob-set trap');
      expectNoVisibleCause(thrown);
    }
  });
});

describe('exact raw tree identity evidence', () => {
  it('rejects wrong raw tree identity, partial nonzero output, terminal substitution, and SHA-256', async () => {
    const leafOid = blobOid(Buffer.from('leaf\n'));
    const firstBody = rawTreeBody([{ mode: '100644', name: 'one.txt', oid: leafOid }]);
    const secondBody = rawTreeBody([{ mode: '100644', name: 'two.txt', oid: leafOid }]);
    expect(secondBody.byteLength).toBe(firstBody.byteLength);
    const rootOid = treeOid(firstBody);
    const commitBody = rawCommitBody({ treeOid: rootOid });
    const candidateOid = commitOid(commitBody);

    const wrongIdentity = treeLookupResponses({
      candidateOid, commitBody, trees: new Map([[rootOid, secondBody]]),
    });
    expectCode(() => withGitShim(wrongIdentity,
      (cwd) => readExactTreeEntries(cwd, { candidateOid, paths: ['one.txt'] })),
    'ci.input.tree-entry-identity-mismatch');

    const partial = treeLookupResponses({
      candidateOid, commitBody, trees: new Map([[rootOid, firstBody]]),
      objectTypes: new Map([[leafOid, 'blob']]),
    });
    partial[responseKey(['cat-file', 'tree', '--', rootOid])] = {
      stdoutBase64: firstBody.toString('base64'), stderr: 'private partial tree', exit: 23,
    };
    let partialError: unknown;
    try {
      withGitShim(partial,
        (cwd) => readExactTreeEntries(cwd, { candidateOid, paths: ['one.txt'] }));
    } catch (error) {
      partialError = error;
    }
    expect(partialError).toMatchObject({ code: 'ci.input.tree-entry-unavailable' });
    expect(String(partialError)).not.toContain('private partial tree');
    expectNoVisibleCause(partialError);

    const responses = treeLookupResponses({
      candidateOid, commitBody, trees: new Map([[rootOid, firstBody]]),
      objectTypes: new Map([[leafOid, 'blob']]),
    });
    let treeReads = 0;
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: (_file: string, args: string[]) => {
        const key = responseKey(args.slice(1));
        if (key === responseKey(['cat-file', 'tree', '--', rootOid])) {
          treeReads += 1;
          return treeReads === 1 ? firstBody : secondBody;
        }
        const response = responses[key];
        if (response === undefined) throw new Error('unexpected synthetic command');
        if (response.stdoutBase64 !== undefined) return Buffer.from(response.stdoutBase64, 'base64');
        return Buffer.from(response.stdout ?? '', 'utf8');
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      let terminalError: unknown;
      try {
        isolated.readExactTreeEntries('/isolated-fixture', { candidateOid, paths: ['one.txt'] });
      } catch (error) {
        terminalError = error;
      }
      expect(terminalError).toMatchObject({ code: 'ci.input.tree-entry-identity-mismatch' });
      expect(treeReads).toBe(2);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }

    expectCode(() => withGitShim(treeLookupResponses({
      candidateOid,
      commitBody,
      trees: new Map([[rootOid, firstBody]]),
      objectFormat: 'sha256\n',
    }), (cwd) => readExactTreeEntries(cwd, { candidateOid, paths: [] })),
    'ci.input.tree-entry-malformed');
  });
});
