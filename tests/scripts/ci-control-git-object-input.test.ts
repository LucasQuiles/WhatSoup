import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
  addedLineShimResponses,
  addedFactsShimResponses,
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

describe('exact candidate tree entries', () => {
  const listingRow = (path: string): Buffer => Buffer.from(
    `100644 blob ${'a'.repeat(40)}\t${path}\0`,
    'utf8',
  );

  it('bounds and validates full-tree listing bytes before accepting paths', () => {
    const exactPath = 'a'.repeat(MAX_EXACT_TREE_ENTRY_PATH_BYTES);
    expect(parseExactTreePathListing(listingRow(exactPath))).toEqual([exactPath]);
    expectCode(
      () => parseExactTreePathListing(listingRow(`${exactPath}a`)),
      'ci.input.tree-entry-budget',
    );
    expectCode(
      () => parseExactTreePathListing(listingRow('safe').subarray(0, -1)),
      'ci.input.tree-entry-malformed',
    );
    const invalidUtf8 = Buffer.concat([
      Buffer.from(`100644 blob ${'a'.repeat(40)}\t`, 'ascii'),
      Buffer.from([0xff, 0]),
    ]);
    expectCode(
      () => parseExactTreePathListing(invalidUtf8),
      'ci.input.tree-entry-malformed',
    );
    const hostile = new Proxy(new Uint8Array(), { get: () => { throw new Error('hostile accessor'); } });
    expectCode(
      () => parseExactTreePathListing(hostile),
      'ci.input.tree-entry-malformed',
    );
  });

  it('accepts the exact full-tree entry-count boundary and rejects one extra row', () => {
    const exact = Buffer.concat(Array.from(
      { length: MAX_EXACT_TREE_ENTRY_COUNT },
      (_, index) => listingRow(`p${index.toString().padStart(5, '0')}`),
    ));
    expect(parseExactTreePathListing(exact)).toHaveLength(MAX_EXACT_TREE_ENTRY_COUNT);
    expectCode(
      () => parseExactTreePathListing(Buffer.concat([exact, listingRow('z-extra')])),
      'ci.input.tree-entry-budget',
    );
  });

  it('enumerates one exact commit tree without reading later ambient state', () => {
    const { root } = fixture();
    write(root, 'docs/exact.md', 'exact\n');
    const candidateOid = commit(root, 'exact tree');
    const candidateTreeOid = git(root, ['rev-parse', `${candidateOid}^{tree}`]);
    write(root, 'ambient-only.txt', 'ambient\n');
    commit(root, 'later ambient tree');

    const result = readExactTreePaths(root, candidateOid);
    expect(result).toMatchObject({ candidateOid, treeOid: candidateTreeOid });
    expect(result.listingDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.paths).toContain('docs/exact.md');
    expect(result.paths).not.toContain('ambient-only.txt');
    expect(() => readExactTreePaths(root, 'HEAD')).toThrow(/ci\.input\.tree-entry-malformed/);
  });

  it('reads the explicit candidate with all supported modes, absence, Unicode, and literal glob paths', () => {
    const { root, baseOid } = fixture();
    write(root, 'regular.txt', 'candidate regular\n');
    write(root, 'executable.sh', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'executable.sh'), 0o755);
    write(root, 'nested/leaf.txt', 'nested leaf\n');
    write(root, 'docs/café.txt', 'unicode path\n');
    write(root, 'literal[*?].txt', 'literal glob path\n');
    symlinkSync('regular.txt', join(root, 'regular-link'));
    git(root, ['add', '-A']);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},vendor/component`]);
    git(root, ['commit', '--quiet', '-m', 'tree candidate']);
    const candidateOid = git(root, ['rev-parse', 'HEAD']);
    const candidateTreeOid = git(root, ['rev-parse', `${candidateOid}^{tree}`]);

    write(root, 'regular.txt', 'later ambient head\n');
    write(root, 'ambient-only.txt', 'not in candidate\n');
    commit(root, 'later ambient head');
    write(root, 'index-only.txt', 'index only\n');
    git(root, ['add', 'index-only.txt']);
    write(root, 'worktree-only.txt', 'worktree only\n');

    const paths = sortUtf8([
      'README.md',
      'docs/café.txt',
      'executable.sh',
      'literal[*?].txt',
      'missing.txt',
      'nested',
      'nested/leaf.txt',
      'regular-link',
      'regular-link/child',
      'regular.txt',
      'regular.txt/child',
      'vendor/component',
      'vendor/component/child',
    ]);
    const result = readExactTreeEntries(root, { candidateOid, paths });

    expect(result.candidateOid).toBe(candidateOid);
    expect(result.treeOid).toBe(candidateTreeOid);
    expect(result.entries.map(({ path }) => path)).toEqual(paths);
    expect(result.entries).toEqual([
      {
        path: 'README.md', presence: 'present', mode: '100644', objectType: 'blob',
        objectOid: git(root, ['rev-parse', `${candidateOid}:README.md`]),
      },
      {
        path: 'docs/café.txt', presence: 'present', mode: '100644', objectType: 'blob',
        objectOid: git(root, ['rev-parse', `${candidateOid}:docs/café.txt`]),
      },
      {
        path: 'executable.sh', presence: 'present', mode: '100755', objectType: 'executable',
        objectOid: git(root, ['rev-parse', `${candidateOid}:executable.sh`]),
      },
      {
        path: 'literal[*?].txt', presence: 'present', mode: '100644', objectType: 'blob',
        objectOid: git(root, ['rev-parse', `${candidateOid}:literal[*?].txt`]),
      },
      { path: 'missing.txt', presence: 'absent', mode: null, objectType: null, objectOid: null },
      {
        path: 'nested', presence: 'present', mode: '040000', objectType: 'tree',
        objectOid: git(root, ['rev-parse', `${candidateOid}:nested`]),
      },
      {
        path: 'nested/leaf.txt', presence: 'present', mode: '100644', objectType: 'blob',
        objectOid: git(root, ['rev-parse', `${candidateOid}:nested/leaf.txt`]),
      },
      {
        path: 'regular-link', presence: 'present', mode: '120000', objectType: 'symlink',
        objectOid: git(root, ['rev-parse', `${candidateOid}:regular-link`]),
      },
      { path: 'regular-link/child', presence: 'absent', mode: null, objectType: null, objectOid: null },
      {
        path: 'regular.txt', presence: 'present', mode: '100644', objectType: 'blob',
        objectOid: git(root, ['rev-parse', `${candidateOid}:regular.txt`]),
      },
      { path: 'regular.txt/child', presence: 'absent', mode: null, objectType: null, objectOid: null },
      {
        path: 'vendor/component', presence: 'present', mode: '160000', objectType: 'gitlink',
        objectOid: baseOid,
      },
      { path: 'vendor/component/child', presence: 'absent', mode: null, objectType: null, objectOid: null },
    ]);
    expect(result.entries.map(({ path }) => path)).not.toContain('ambient-only.txt');
  });

  it('allows an empty path set while still proving the exact commit and root tree', () => {
    const { root, baseOid } = fixture();
    const result = readExactTreeEntries(root, { candidateOid: baseOid, paths: [] });
    expect(result).toEqual({
      candidateOid: baseOid,
      treeOid: git(root, ['rev-parse', `${baseOid}^{tree}`]),
      entries: [],
    });
  });

  it('rejects hostile input and path arrays before accessors or Git', () => {
    const oid = 'a'.repeat(40);
    let getterCalls = 0;
    const accessorPaths: string[] = [];
    Object.defineProperty(accessorPaths, '0', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'safe.txt';
      },
    });
    Object.defineProperty(accessorPaths, 'length', { value: 1 });
    const nonEnumerable = ['safe.txt'];
    Object.defineProperty(nonEnumerable, '0', { value: 'safe.txt', enumerable: false });
    const extraString = ['safe.txt'];
    Object.defineProperty(extraString, 'extra', { value: true, enumerable: true });
    const extraSymbol = ['safe.txt'];
    Object.defineProperty(extraSymbol, Symbol('extra'), { value: true, enumerable: true });
    const customPrototype = ['safe.txt'];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
    const sparse = new Array<string>(1);
    const revoked = Proxy.revocable(['safe.txt'], {});
    revoked.revoke();
    const hostilePaths: unknown[] = [
      null, {}, sparse, accessorPaths, nonEnumerable, extraString, extraSymbol,
      customPrototype, new Proxy(['safe.txt'], {}), revoked.proxy,
    ];
    for (const paths of hostilePaths) {
      expectCode(() => readExactTreeEntries('/not-a-repository', {
        candidateOid: oid,
        paths: paths as readonly string[],
      }), 'ci.input.tree-entry-malformed');
    }

    const accessorInput: Record<string, unknown> = { paths: ['safe.txt'] };
    Object.defineProperty(accessorInput, 'candidateOid', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return oid;
      },
    });
    const hostileInputs: unknown[] = [
      null, [], {}, { candidateOid: oid, paths: [], extra: true },
      Object.create({ candidateOid: oid, paths: [] }),
      new Proxy({ candidateOid: oid, paths: [] }, {}), accessorInput,
    ];
    for (const input of hostileInputs) {
      expectCode(() => readExactTreeEntries('/not-a-repository', input as never),
        'ci.input.tree-entry-malformed');
    }
    expect(getterCalls).toBe(0);
  });

  it('validates canonical sorted UTF-8 paths and every static path budget before Git', () => {
    const oid = 'a'.repeat(40);
    const malformedPaths: readonly string[][] = [
      [''], ['/absolute'], ['back\\slash'], ['control\npath'], ['double//segment'],
      ['./dot'], ['parent/../escape'], ['trailing/'], ['\ud800'], ['z.txt', 'a.txt'],
      ['same.txt', 'same.txt'],
    ];
    for (const paths of malformedPaths) {
      expectCode(() => readExactTreeEntries('/not-a-repository', { candidateOid: oid, paths }),
        'ci.input.tree-entry-malformed');
    }

    expect(MAX_EXACT_TREE_ENTRY_PATH_COUNT).toBe(64);
    expect(MAX_EXACT_TREE_ENTRY_PATH_BYTES).toBe(1_024);
    expect(MAX_EXACT_TREE_ENTRY_PATH_SEGMENT_COUNT).toBe(1_023);
    expect(MAX_EXACT_SINGLE_TREE_BYTES).toBe(4 * 1_024 * 1_024);
    expect(MAX_EXACT_AGGREGATE_TREE_BYTES).toBe(16 * 1_024 * 1_024);
    expect(MAX_EXACT_TREE_ENTRY_COUNT).toBe(50_000);

    const exactCountAndBytes = Array.from({ length: MAX_EXACT_TREE_ENTRY_PATH_COUNT },
      (_, index) => `${index.toString(16).padStart(2, '0')}${'a'.repeat(MAX_EXACT_TREE_ENTRY_PATH_BYTES - 2)}`);
    expect(exactCountAndBytes.reduce((total, path) => total + Buffer.byteLength(path), 0))
      .toBe(MAX_EXACT_TREE_ENTRY_PATH_COUNT * MAX_EXACT_TREE_ENTRY_PATH_BYTES);
    expectCode(() => readExactTreeEntries('/not-a-repository', {
      candidateOid: oid,
      paths: exactCountAndBytes,
    }), 'ci.input.tree-entry-unavailable');
    expectCode(() => readExactTreeEntries('/not-a-repository', {
      candidateOid: oid,
      paths: [...exactCountAndBytes, `${'z'.repeat(MAX_EXACT_TREE_ENTRY_PATH_BYTES)}`],
    }), 'ci.input.tree-entry-budget');
    expectCode(() => readExactTreeEntries('/not-a-repository', {
      candidateOid: oid,
      paths: ['a'.repeat(MAX_EXACT_TREE_ENTRY_PATH_BYTES + 1)],
    }), 'ci.input.tree-entry-budget');

    const exactSegments = [
      Array.from({ length: 512 }, () => 'a').join('/'),
      Array.from({ length: 511 }, () => 'b').join('/'),
    ];
    expectCode(() => readExactTreeEntries('/not-a-repository', {
      candidateOid: oid,
      paths: exactSegments,
    }), 'ci.input.tree-entry-unavailable');
    expectCode(() => readExactTreeEntries('/not-a-repository', {
      candidateOid: oid,
      paths: [exactSegments[0]!, `${exactSegments[1]!}/b`],
    }), 'ci.input.tree-entry-budget');
  });

  it('fails closed for malformed, duplicate, unavailable, and type-mismatched tree evidence', () => {
    const leafOid = blobOid(Buffer.from('leaf\n'));
    const malformedBodies = [
      Buffer.from('100644 missing-nul', 'utf8'),
      rawTreeBody([{ mode: '100600', name: 'leaf.txt', oid: leafOid }]),
      rawTreeBody([
        { mode: '100644', name: 'leaf.txt', oid: leafOid },
        { mode: '100644', name: 'leaf.txt', oid: leafOid },
      ]),
      Buffer.concat([Buffer.from('100644 leaf.txt\0'), Buffer.alloc(19)]),
      rawTreeBody([{ mode: '100644', name: 'leaf.txt', oid: '0'.repeat(40) }]),
    ];
    for (const rootBody of malformedBodies) {
      const rootOid = treeOid(rootBody);
      const commitBody = rawCommitBody({ treeOid: rootOid });
      const candidateOid = commitOid(commitBody);
      expectCode(() => withGitShim(treeLookupResponses({
        candidateOid,
        commitBody,
        trees: new Map([[rootOid, rootBody]]),
      }), (cwd) => readExactTreeEntries(cwd, { candidateOid, paths: ['leaf.txt'] })),
      'ci.input.tree-entry-malformed');
    }

    const childTreeBody = rawTreeBody([]);
    const childTreeOid = treeOid(childTreeBody);
    const rootBody = rawTreeBody([{ mode: '100644', name: 'leaf.txt', oid: childTreeOid }]);
    const rootOid = treeOid(rootBody);
    const commitBody = rawCommitBody({ treeOid: rootOid });
    const candidateOid = commitOid(commitBody);
    expectCode(() => withGitShim(treeLookupResponses({
      candidateOid,
      commitBody,
      trees: new Map([[rootOid, rootBody], [childTreeOid, childTreeBody]]),
    }), (cwd) => readExactTreeEntries(cwd, { candidateOid, paths: ['leaf.txt'] })),
    'ci.input.tree-entry-identity-mismatch');

    const unavailableResponses = treeLookupResponses({
      candidateOid,
      commitBody,
      trees: new Map([[rootOid, rootBody]]),
    });
    unavailableResponses[responseKey(['cat-file', '-t', '--', childTreeOid])] = {
      stderr: 'private missing object detail', exit: 1,
    };
    let thrown: unknown;
    try {
      withGitShim(unavailableResponses,
        (cwd) => readExactTreeEntries(cwd, { candidateOid, paths: ['leaf.txt'] }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'ci.input.tree-entry-unavailable' });
    expect(String(thrown)).not.toContain('private missing object detail');
    expectNoVisibleCause(thrown);
  });

  it('enforces raw tree single, aggregate, and entry budgets at exact and one-over boundaries', async () => {
    const runSynthetic = async (
      rootOid: string,
      trees: ReadonlyMap<string, Buffer>,
      path: string | null,
      declaredSizes: ReadonlyMap<string, number> = new Map(),
    ): Promise<{ result?: ExactTreeEntrySetV1; error?: unknown; bodyReads: ReadonlyMap<string, number> }> => {
      const commitBody = rawCommitBody({ treeOid: rootOid });
      const candidateOid = commitOid(commitBody);
      const bodyReads = new Map<string, number>();
      const responses = commitMetadataResponses([{ oid: candidateOid, body: commitBody }]);
      for (const [oid, body] of trees) {
        responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'tree\n' };
        responses[responseKey(['cat-file', '-s', '--', oid])] = {
          stdout: `${declaredSizes.get(oid) ?? body.byteLength}\n`,
        };
        responses[responseKey(['cat-file', 'tree', '--', oid])] = {
          stdoutBase64: body.toString('base64'),
        };
      }
      return withMockedGitInput((_file, args) => {
        const key = responseKey(args.slice(1));
        const response = responses[key];
        if (response === undefined) throw new Error(`unexpected synthetic command: ${key}`);
        const treeMatch = key.match(/^\["cat-file","tree","--","([0-9a-f]{40})"\]$/u);
        if (treeMatch !== null) {
          const oid = treeMatch[1]!;
          bodyReads.set(oid, (bodyReads.get(oid) ?? 0) + 1);
        }
        return response.stdoutBase64 === undefined
          ? Buffer.from(response.stdout ?? '', 'utf8')
          : Buffer.from(response.stdoutBase64, 'base64');
      }, (isolated) => {
        try {
          return {
            result: isolated.readExactTreeEntries('/isolated-fixture', {
              candidateOid,
              paths: path === null ? [] : [path],
            }),
            bodyReads,
          };
        } catch (error) {
          return { error, bodyReads };
        }
      });
    };

    const shortBody = rawTreeBody([]);
    const shortOid = treeOid(shortBody);
    const exactSingle = await runSynthetic(shortOid, new Map([[shortOid, shortBody]]), null,
      new Map([[shortOid, MAX_EXACT_SINGLE_TREE_BYTES]]));
    expect(exactSingle.error).toMatchObject({ code: 'ci.input.tree-entry-identity-mismatch' });
    expect(exactSingle.bodyReads.get(shortOid)).toBe(1);
    const overSingle = await runSynthetic(shortOid, new Map([[shortOid, shortBody]]), null,
      new Map([[shortOid, MAX_EXACT_SINGLE_TREE_BYTES + 1]]));
    expect(overSingle.error).toMatchObject({ code: 'ci.input.tree-entry-budget' });
    expect(overSingle.bodyReads.get(shortOid)).toBeUndefined();

    const exactChain = treeChain([
      4 * 1_024 * 1_024,
      4 * 1_024 * 1_024,
      4 * 1_024 * 1_024,
      2 * 1_024 * 1_024,
      2 * 1_024 * 1_024,
    ]);
    const exactAggregate = await runSynthetic(
      exactChain.rootOid, exactChain.trees, exactChain.path,
    );
    expect(exactAggregate.error).toBeUndefined();
    expect(exactAggregate.result?.entries).toMatchObject([
      { path: exactChain.path, presence: 'present', mode: '040000', objectType: 'tree' },
    ]);

    const overChain = treeChain([
      4 * 1_024 * 1_024,
      4 * 1_024 * 1_024,
      4 * 1_024 * 1_024,
      2 * 1_024 * 1_024,
      2 * 1_024 * 1_024 + 1,
    ]);
    const overAggregate = await runSynthetic(overChain.rootOid, overChain.trees, overChain.path);
    expect(overAggregate.error).toMatchObject({ code: 'ci.input.tree-entry-budget' });
    const overLeafOid = [...overChain.trees.keys()][0]!;
    expect(overAggregate.bodyReads.get(overLeafOid)).toBeUndefined();

    const exactEntriesBody = repeatedRawTreeEntries(MAX_EXACT_TREE_ENTRY_COUNT);
    const exactEntriesOid = treeOid(exactEntriesBody);
    const exactEntries = await runSynthetic(
      exactEntriesOid, new Map([[exactEntriesOid, exactEntriesBody]]), null,
    );
    expect(exactEntries.error).toBeUndefined();
    const overEntriesBody = repeatedRawTreeEntries(MAX_EXACT_TREE_ENTRY_COUNT + 1, true);
    const overEntriesOid = treeOid(overEntriesBody);
    const overEntries = await runSynthetic(
      overEntriesOid, new Map([[overEntriesOid, overEntriesBody]]), null,
    );
    expect(overEntries.error).toMatchObject({ code: 'ci.input.tree-entry-budget' });
  }, 120_000);

  it('carries the aggregate entry allowance across separately loaded trees', async () => {
    const rootNonChildCount = 24_999;
    const childExactCount = MAX_EXACT_TREE_ENTRY_COUNT - rootNonChildCount - 1;
    const runCase = async (childCount: number, trailingMalformed: boolean) => {
      const childBody = repeatedRawTreeEntries(childCount, trailingMalformed);
      const childOid = treeOid(childBody);
      const rootBody = Buffer.concat([
        rawTreeBody([{ mode: '40000', name: 'child', oid: childOid }]),
        repeatedRawTreeEntries(rootNonChildCount),
      ]);
      expect(rootNonChildCount + 1 + childExactCount).toBe(MAX_EXACT_TREE_ENTRY_COUNT);
      expect(rootBody.byteLength).toBeLessThan(MAX_EXACT_SINGLE_TREE_BYTES);
      expect(childBody.byteLength).toBeLessThan(MAX_EXACT_SINGLE_TREE_BYTES);
      expect(rootBody.byteLength + childBody.byteLength)
        .toBeLessThan(MAX_EXACT_AGGREGATE_TREE_BYTES);

      const rootOid = treeOid(rootBody);
      const commitBody = rawCommitBody({ treeOid: rootOid });
      const candidateOid = commitOid(commitBody);
      const responses = treeLookupResponses({
        candidateOid,
        commitBody,
        trees: new Map([[rootOid, rootBody], [childOid, childBody]]),
        objectTypes: new Map([['2'.repeat(40), 'blob']]),
      });
      return withMockedGitInput((_file, args) => {
        const key = responseKey(args.slice(1));
        const response = responses[key];
        if (response === undefined) throw new Error(`unexpected synthetic command: ${key}`);
        return response.stdoutBase64 === undefined
          ? Buffer.from(response.stdout ?? '', 'utf8')
          : Buffer.from(response.stdoutBase64, 'base64');
      }, (isolated) => {
        try {
          return {
            result: isolated.readExactTreeEntries('/isolated-fixture', {
              candidateOid,
              paths: ['child/00000'],
            }),
          };
        } catch (error) {
          return { error };
        }
      });
    };

    const exact = await runCase(childExactCount, false);
    expect(exact.error).toBeUndefined();
    expect(exact.result?.entries).toEqual([{
      path: 'child/00000',
      presence: 'present',
      mode: '100644',
      objectType: 'blob',
      objectOid: '2'.repeat(40),
    }]);

    const over = await runCase(childExactCount + 1, true);
    expect(over.error).toMatchObject({ code: 'ci.input.tree-entry-budget' });
  }, 120_000);

  it('rejects every tree-mode/object-type table mismatch without looking up gitlinks', () => {
    const candidateModes = [
      { mode: '40000', observed: 'blob' },
      { mode: '100644', observed: 'tree' },
      { mode: '100755', observed: 'commit' },
      { mode: '120000', observed: 'tag' },
    ] as const;
    for (const { mode, observed } of candidateModes) {
      const targetOid = '3'.repeat(40);
      const rootBody = rawTreeBody([{ mode, name: 'target', oid: targetOid }]);
      const rootOid = treeOid(rootBody);
      const commitBody = rawCommitBody({ treeOid: rootOid });
      const candidateOid = commitOid(commitBody);
      expectCode(() => withGitShim(treeLookupResponses({
        candidateOid,
        commitBody,
        trees: new Map([[rootOid, rootBody]]),
        objectTypes: new Map([[targetOid, observed]]),
      }), (cwd) => readExactTreeEntries(cwd, { candidateOid, paths: ['target'] })),
      'ci.input.tree-entry-identity-mismatch');
    }

    const gitlinkOid = '4'.repeat(40);
    const rootBody = rawTreeBody([{ mode: '160000', name: 'target', oid: gitlinkOid }]);
    const rootOid = treeOid(rootBody);
    const commitBody = rawCommitBody({ treeOid: rootOid });
    const candidateOid = commitOid(commitBody);
    const result = withGitShim(treeLookupResponses({
      candidateOid,
      commitBody,
      trees: new Map([[rootOid, rootBody]]),
    }), (cwd) => readExactTreeEntries(cwd, { candidateOid, paths: ['target'] }));
    expect(result.entries).toEqual([{
      path: 'target', presence: 'present', mode: '160000', objectType: 'gitlink',
      objectOid: gitlinkOid,
    }]);
  });

  it('rejects terminal substitution of a nested child tree after stable root reread', async () => {
    const leafOid = blobOid(Buffer.from('leaf\n'));
    const childFirst = rawTreeBody([{ mode: '100644', name: 'leaf.txt', oid: leafOid }]);
    const childSecond = rawTreeBody([{ mode: '100644', name: 'evil.txt', oid: leafOid }]);
    expect(childSecond.byteLength).toBe(childFirst.byteLength);
    const childOid = treeOid(childFirst);
    const rootBody = rawTreeBody([{ mode: '40000', name: 'nested', oid: childOid }]);
    const rootOid = treeOid(rootBody);
    const commitBody = rawCommitBody({ treeOid: rootOid });
    const candidateOid = commitOid(commitBody);
    const responses = treeLookupResponses({
      candidateOid,
      commitBody,
      trees: new Map([[rootOid, rootBody], [childOid, childFirst]]),
      objectTypes: new Map([[leafOid, 'blob']]),
    });
    const reads = new Map<string, number>();
    await withMockedGitInput((_file, args) => {
      const key = responseKey(args.slice(1));
      if (key === responseKey(['cat-file', 'tree', '--', childOid])) {
        const count = (reads.get(childOid) ?? 0) + 1;
        reads.set(childOid, count);
        return count === 1 ? childFirst : childSecond;
      }
      if (key === responseKey(['cat-file', 'tree', '--', rootOid])) {
        reads.set(rootOid, (reads.get(rootOid) ?? 0) + 1);
      }
      const response = responses[key];
      if (response === undefined) throw new Error(`unexpected synthetic command: ${key}`);
      return response.stdoutBase64 === undefined
        ? Buffer.from(response.stdout ?? '', 'utf8')
        : Buffer.from(response.stdoutBase64, 'base64');
    }, (isolated) => {
      let thrown: unknown;
      try {
        isolated.readExactTreeEntries('/isolated-fixture', {
          candidateOid,
          paths: ['nested/leaf.txt'],
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.tree-entry-identity-mismatch' });
      expect(String(thrown)).toContain('ci.input.tree-entry-identity-mismatch');
    });
    expect(reads).toEqual(new Map([[rootOid, 2], [childOid, 2]]));
  });

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

  it('maps only proven timeout and output-budget child failures to their specific codes', async () => {
    const verify = async (
      failure: NodeJS.ErrnoException & { signal?: string },
      code: string,
    ): Promise<void> => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({ execFileSync: () => { throw failure; } }));
      try {
        const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
        let thrown: unknown;
        try {
          isolated.readExactTreeEntries('/isolated-fixture', {
            candidateOid: 'a'.repeat(40), paths: [],
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code });
        expect(String(thrown)).not.toContain(failure.message);
        expectNoVisibleCause(thrown);
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    };
    await verify(Object.assign(new Error('private timeout'), { code: 'ETIMEDOUT' }),
      'ci.input.tree-entry-timeout');
    await verify(Object.assign(new Error('private budget'), { code: 'ENOBUFS' }),
      'ci.input.tree-entry-budget');
    await verify(Object.assign(new Error('private signal'), { signal: 'SIGKILL' }),
      'ci.input.tree-entry-unavailable');
  });
});

function rangeResponses(
  baseOid: string,
  localOid: string,
  countOutput: string,
  rows: Uint8Array,
  rowExit = 0,
): Record<string, GitShimResponse> {
  return {
    [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
    [responseKey(['cat-file', '-t', '--', baseOid])]: { stdout: 'commit\n' },
    [responseKey(['cat-file', '-t', '--', localOid])]: { stdout: 'commit\n' },
    [responseKey(['merge-base', '--all', baseOid, localOid])]: { stdout: `${baseOid}\n` },
    [responseKey(['rev-list', '--count', `${baseOid}..${localOid}`, '--'])]: { stdout: countOutput },
    [responseKey(['rev-list', '--parents', `${baseOid}..${localOid}`, '--'])]: {
      stdoutBase64: Buffer.from(rows).toString('base64'),
      exit: rowExit,
    },
  };
}

describe('exact commit range', () => {
  it('rejects legacy graft metadata before interpreting ancestry', () => {
    const { root, baseOid } = fixture();
    write(root, 'one.txt', 'one\n');
    const localOid = commit(root, 'candidate');
    mkdirSync(join(root, '.git/info'), { recursive: true });
    writeFileSync(join(root, '.git/info/grafts'), `${localOid} ${baseOid}\n`);

    expectCode(() => readExactCommitRange(root, {
      baseOid,
      remoteOid: null,
      localOid,
    }), 'ci.input.history-graft-present');
  });

  it('rejects graft metadata behind a CRLF-terminated gitfile control path', () => {
    const { root, baseOid } = fixture();
    write(root, 'one.txt', 'one\n');
    const localOid = commit(root, 'candidate');
    renameSync(join(root, '.git'), join(root, '.git-real'));
    writeFileSync(join(root, '.git'), 'gitdir: .git-real\r\n', 'utf8');
    mkdirSync(join(root, '.git-real/info'), { recursive: true });
    writeFileSync(join(root, '.git-real/info/grafts'), `${localOid} ${baseOid}\n`, 'utf8');

    expectCode(() => readExactCommitRange(root, {
      baseOid,
      remoteOid: null,
      localOid,
    }), 'ci.input.history-graft-present');
  });

  it('rejects malformed repository control metadata with a sanitized unavailable result', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-control-malformed-gitdir-'));
    registerTemporaryRoot(root);
    writeFileSync(join(root, '.git'), 'gitdir: missing-terminal-newline', 'utf8');

    let thrown: unknown;
    try {
      readExactCommitRange(root, {
        baseOid: 'a'.repeat(40),
        remoteOid: null,
        localOid: 'b'.repeat(40),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'ci.input.git-control-unavailable' });
    expect(String(thrown)).not.toContain(root);
    expectNoVisibleCause(thrown);
  });

  it('does not retain raw child-process stderr in exact-range errors', () => {
    const privateFixture = 'private-repository-path-to-stderr';
    let thrown: unknown;
    try {
      withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: {
          stderr: privateFixture,
          exit: 23,
        },
      }, (cwd) => readExactCommitRange(cwd, {
        baseOid: 'a'.repeat(40),
        remoteOid: null,
        localOid: 'b'.repeat(40),
      }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'ci.input.commit-range-unavailable' });
    expect(String(thrown)).not.toContain(privateFixture);
    expectNoVisibleCause(thrown);
  });

  it('accepts a valid linked-worktree control path as a safe neighbor', () => {
    const { root, baseOid } = fixture();
    write(root, 'candidate.txt', 'candidate\n');
    const localOid = commit(root, 'candidate');
    const container = mkdtempSync(join(tmpdir(), 'ci-control-linked-worktree-'));
    registerTemporaryRoot(container);
    const linked = join(container, 'linked');
    git(root, ['worktree', 'add', '--quiet', '--detach', linked, localOid]);

    expect(readExactCommitRange(linked, {
      baseOid,
      remoteOid: null,
      localOid,
    })).toMatchObject({ baseOid, localOid });
  });

  it('rejects malformed runtime records before Git or accessor evaluation', () => {
    const oid = 'a'.repeat(40);
    const malformed: unknown[] = [
      null,
      [],
      {},
      { baseOid: oid, remoteOid: null },
      { baseOid: oid, remoteOid: null, localOid: oid, extra: true },
      { baseOid: 7, remoteOid: null, localOid: oid },
      { baseOid: oid.toUpperCase(), remoteOid: null, localOid: oid },
      { baseOid: oid, remoteOid: '', localOid: oid },
      { baseOid: oid, remoteOid: 7, localOid: oid },
      { baseOid: oid, remoteOid: null, localOid: 'g'.repeat(40) },
    ];
    for (const value of malformed) {
      expectCode(() => readExactCommitRange(
        '/not-a-repository',
        value as never,
      ), 'ci.input.commit-range-malformed');
    }

    let getterCalls = 0;
    const accessor: Record<string, unknown> = { remoteOid: null, localOid: oid };
    Object.defineProperty(accessor, 'baseOid', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return oid;
      },
    });
    expectCode(() => readExactCommitRange('/not-a-repository', accessor as never),
      'ci.input.commit-range-malformed');
    expect(getterCalls).toBe(0);
  });

  it('requires canonical scalar framing for object format and commit type', () => {
    const oid = 'a'.repeat(40);
    const malformedScalars = [' sha1\n', 'sha1 \n', 'sha1\n\n', 'sha1', 'sha1\r\n', 'shá1\n'];
    for (const scalar of malformedScalars) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: scalar },
      }, (cwd) => readExactCommitRange(cwd, {
        baseOid: oid, remoteOid: null, localOid: oid,
      })), 'ci.input.commit-range-malformed');
    }

    for (const scalar of [' commit\n', 'commit \n', 'commit\n\n', 'commit', 'commit\r\n', 'commít\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
        [responseKey(['cat-file', '-t', '--', oid])]: { stdout: scalar },
      }, (cwd) => readExactCommitRange(cwd, {
        baseOid: oid, remoteOid: null, localOid: oid,
      })), 'ci.input.commit-range-malformed');
    }
  });

  it('distinguishes malformed merge-base framing from a well-formed unavailable relation', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'b'.repeat(40);
    const validRows = Buffer.from(`${localOid} ${baseOid}\n`);
    for (const scalar of [
      ` ${baseOid}\n`, `${baseOid} \n`, `${baseOid}\n\n`, baseOid, `${baseOid}\r\n`, `é${baseOid.slice(1)}\n`,
    ]) {
      const responses = rangeResponses(baseOid, localOid, '1\n', validRows);
      responses[responseKey(['merge-base', '--all', baseOid, localOid])] = { stdout: scalar };
      expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
        baseOid, remoteOid: null, localOid,
      })), 'ci.input.commit-range-malformed');
    }

    const otherOid = 'c'.repeat(40);
    const responses = rangeResponses(baseOid, localOid, '1\n', validRows);
    responses[responseKey(['merge-base', '--all', baseOid, localOid])] = { stdout: `${otherOid}\n` };
    expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
      baseOid, remoteOid: null, localOid,
    })), 'ci.input.commit-range-unavailable');
  });

  it('requires canonical decimal framing for the commit count', () => {
    const oid = 'a'.repeat(40);
    for (const scalar of [' 0\n', '0 \n', '0\n\n', '0', '0\r\n', '０\n']) {
      const responses = emptyRangeResponses(oid);
      responses[responseKey(['rev-list', '--count', `${oid}..${oid}`, '--'])] = { stdout: scalar };
      expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
        baseOid: oid, remoteOid: null, localOid: oid,
      })), 'ci.input.commit-range-malformed');
    }
  });

  it('uses remoteOid when present and baseOid otherwise', () => {
    const { root, baseOid } = fixture();
    write(root, 'one.txt', 'one\n');
    const firstOid = commit(root, 'first');
    write(root, 'two.txt', 'two\n');
    const secondOid = commit(root, 'second');

    expect(readExactCommitRange(root, {
      baseOid,
      remoteOid: null,
      localOid: secondOid,
    })).toMatchObject({
      baseOid,
      remoteOid: null,
      rangeStartOid: baseOid,
      localOid: secondOid,
      commits: [{ oid: firstOid }, { oid: secondOid }],
    });

    expect(readExactCommitRange(root, {
      baseOid,
      remoteOid: firstOid,
      localOid: secondOid,
    })).toMatchObject({
      baseOid,
      remoteOid: firstOid,
      rangeStartOid: firstOid,
      localOid: secondOid,
      commits: [{ oid: secondOid }],
    });
  });

  it('rejects malformed, missing, non-commit, unsupported-format, and non-ancestor inputs', () => {
    const { root, baseOid } = fixture();
    write(root, 'candidate.txt', 'candidate\n');
    const localOid = commit(root, 'candidate');
    const blobOid = git(root, ['rev-parse', `${localOid}:candidate.txt`]);

    expectCode(() => readExactCommitRange(root, {
      baseOid: baseOid.toUpperCase(), remoteOid: null, localOid,
    }), 'ci.input.commit-range-malformed');
    expectCode(() => readExactCommitRange(root, {
      baseOid, remoteOid: null, localOid: 'f'.repeat(40),
    }), 'ci.input.commit-range-unavailable');
    expectCode(() => readExactCommitRange(root, {
      baseOid, remoteOid: null, localOid: blobOid,
    }), 'ci.input.commit-range-malformed');

    git(root, ['checkout', '--quiet', '--detach', baseOid]);
    write(root, 'other.txt', 'other\n');
    const unrelatedOid = commit(root, 'unrelated');
    expectCode(() => readExactCommitRange(root, {
      baseOid: localOid, remoteOid: null, localOid: unrelatedOid,
    }), 'ci.input.commit-range-unavailable');

    const sha256Root = mkdtempSync(join(tmpdir(), 'ci-control-git-input-sha256-'));
    registerTemporaryRoot(sha256Root);
    git(sha256Root, ['init', '--quiet', '--object-format=sha256']);
    expectCode(() => readExactCommitRange(sha256Root, {
      baseOid: 'a'.repeat(40), remoteOid: null, localOid: 'b'.repeat(40),
    }), 'ci.input.commit-range-malformed');
  });

  it('enumerates transient commits by exact OID while ignoring ambient HEAD, index, and worktree', () => {
    const { root, baseOid } = fixture();
    write(root, 'transient.txt', 'introduced\n');
    const addOid = commit(root, 'add transient');
    rmSync(join(root, 'transient.txt'));
    const removeOid = commit(root, 'remove transient');

    write(root, 'ambient-head.txt', 'outside exact range\n');
    commit(root, 'ambient head');
    write(root, 'ambient-index.txt', 'index only\n');
    git(root, ['add', 'ambient-index.txt']);
    write(root, 'ambient-worktree.txt', 'worktree only\n');

    const result = readExactCommitRange(root, {
      baseOid,
      remoteOid: null,
      localOid: removeOid,
    });
    expect(result.commits.map(({ oid }) => oid)).toEqual([addOid, removeOid]);
    expect(result.commits[0]).toEqual({
      oid: addOid,
      parentOids: [baseOid],
      firstParentOid: baseOid,
    });
    expect(result.commits[1]).toEqual({
      oid: removeOid,
      parentOids: [addOid],
      firstParentOid: addOid,
    });

    const facts = result.commits.flatMap(({ firstParentOid, oid }) =>
      readExactChangeFacts(root, firstParentOid, oid));
    expect(facts.map(({ status, path, oldMode, newMode, oldType, newType }) => ({
      status, path, oldMode, newMode, oldType, newType,
    }))).toEqual([
      {
        status: 'added', path: 'transient.txt', oldMode: '000000', newMode: '100644',
        oldType: 'absent', newType: 'blob',
      },
      {
        status: 'deleted', path: 'transient.txt', oldMode: '100644', newMode: '000000',
        oldType: 'blob', newType: 'absent',
      },
    ]);
    const introducedBlobOids = facts
      .filter(({ newType }) => newType === 'blob' || newType === 'executable' || newType === 'symlink')
      .map(({ newOid }) => newOid);
    const [introduced] = readExactBlobs(root, introducedBlobOids);
    expect(Buffer.from(introduced!.bytes).toString('utf8')).toBe('introduced\n');
  });

  it('uses deterministic parent-before-child ordering with ready siblings sorted by OID', () => {
    const { root, baseOid } = fixture();
    git(root, ['checkout', '--quiet', '-b', 'left']);
    write(root, 'left.txt', 'left\n');
    const leftOid = commit(root, 'left');

    git(root, ['checkout', '--quiet', '-b', 'right', baseOid]);
    write(root, 'right.txt', 'right\n');
    const rightOid = commit(root, 'right');
    git(root, ['merge', '--quiet', '--no-ff', 'left', '-m', 'merge diamond']);
    const mergeOid = git(root, ['rev-parse', 'HEAD']);

    const result = readExactCommitRange(root, {
      baseOid,
      remoteOid: null,
      localOid: mergeOid,
    });
    expect(result.commits.map(({ oid }) => oid)).toEqual([
      ...[leftOid, rightOid].sort(),
      mergeOid,
    ]);
    expect(result.commits.at(-1)).toEqual({
      oid: mergeOid,
      parentOids: [rightOid, leftOid],
      firstParentOid: rightOid,
    });
  });

  it('publishes fixed inclusive range budgets', () => {
    expect(MAX_EXACT_COMMIT_COUNT).toBe(4_096);
    expect(MAX_EXACT_COMMIT_PARENT_EDGE_COUNT).toBe(8_192);
    expect(MAX_EXACT_COMMIT_RANGE_BYTES).toBe(1 * 1_024 * 1_024);
  });

  it('accepts the exact parent-edge bound and rejects one over before row parsing', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'b'.repeat(40);
    const exactParents = Array.from(
      { length: MAX_EXACT_COMMIT_PARENT_EDGE_COUNT },
      (_, index) => (index + 1).toString(16).padStart(40, '0'),
    );
    const exactRows = Buffer.from(
      `${localOid} ${exactParents.join(' ')}\n`,
      'ascii',
    );
    const exact = withGitShim(
      rangeResponses(baseOid, localOid, '1\n', exactRows),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    );
    expect(exact.commits[0]?.parentOids).toHaveLength(MAX_EXACT_COMMIT_PARENT_EDGE_COUNT);

    const oneOverRows = Buffer.concat([
      Buffer.from(
        `${localOid} ${[...exactParents, 'c'.repeat(40)].join(' ')}`,
        'ascii',
      ),
      // If row decoding/materialization runs, this byte is malformed. The edge budget
      // must win before that later work.
      Buffer.from([0xff, 0x0a]),
    ]);
    expectCode(() => withGitShim(
      rangeResponses(baseOid, localOid, '1\n', oneOverRows),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    ), 'ci.input.commit-range-budget');
  });

  it('rejects duplicate parent identities within one commit row', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'b'.repeat(40);
    const rows = Buffer.from(`${localOid} ${baseOid} ${baseOid}\n`, 'ascii');
    expectCode(() => withGitShim(
      rangeResponses(baseOid, localOid, '1\n', rows),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    ), 'ci.input.commit-range-malformed');
  });

  it('rejects nonempty output for an empty range and blank normalized rows', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'c'.repeat(40);
    const firstOid = 'b'.repeat(40);
    const validRows = `${firstOid} ${baseOid}\n${localOid} ${firstOid}\n`;
    const cases = [
      {
        base: baseOid,
        local: baseOid,
        count: '0\n',
        rows: Buffer.from('\n'),
        responses: { ...emptyRangeResponses(baseOid) },
      },
      {
        base: baseOid,
        local: localOid,
        count: '2\n',
        rows: Buffer.from(`${firstOid} ${baseOid}\n\n${localOid} ${firstOid}\n`),
      },
      {
        base: baseOid,
        local: localOid,
        count: '2\n',
        rows: Buffer.from(`${validRows}\n`),
      },
    ];

    for (const entry of cases) {
      const responses = rangeResponses(entry.base, entry.local, entry.count, entry.rows);
      expectCode(() => withGitShim(responses, (cwd) => readExactCommitRange(cwd, {
        baseOid: entry.base,
        remoteOid: null,
        localOid: entry.local,
      })), 'ci.input.commit-range-malformed');
    }
  });

  it('rejects missing LF, row-count mismatch, duplicate rows, cycles, and discarded partial output', () => {
    const baseOid = 'a'.repeat(40);
    const firstOid = 'b'.repeat(40);
    const localOid = 'c'.repeat(40);
    const malformed = [
      { count: '1\n', rows: Buffer.from(`${localOid} ${baseOid}`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '2\n', rows: Buffer.from(`${localOid} ${baseOid}\n`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '2\n', rows: Buffer.from(`${localOid} ${baseOid}\n${localOid} ${baseOid}\n`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '2\n', rows: Buffer.from(`${firstOid} ${localOid}\n${localOid} ${firstOid}\n`), exit: 0, code: 'ci.input.commit-range-malformed' },
      { count: '1\n', rows: Buffer.from(`${localOid} ${baseOid}\n`), exit: 1, code: 'ci.input.commit-range-unavailable' },
    ];
    for (const entry of malformed) {
      expectCode(() => withGitShim(
        rangeResponses(baseOid, localOid, entry.count, entry.rows, entry.exit),
        (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
      ), entry.code);
    }
  });

  it('accepts the exact commit-count bound and rejects one over before reading metadata', () => {
    const baseOid = 'a'.repeat(40);
    const commitOids = Array.from(
      { length: MAX_EXACT_COMMIT_COUNT },
      (_, index) => (index + 1).toString(16).padStart(40, '0'),
    );
    const localOid = commitOids.at(-1)!;
    const rows = Buffer.from(commitOids.map((oid, index) =>
      `${oid} ${index === 0 ? baseOid : commitOids[index - 1]}\n`).join(''));
    const exact = withGitShim(
      rangeResponses(baseOid, localOid, `${MAX_EXACT_COMMIT_COUNT}\n`, rows),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    );
    expect(exact.commits).toHaveLength(MAX_EXACT_COMMIT_COUNT);
    expect(exact.commits[0]?.firstParentOid).toBe(baseOid);
    expect(exact.commits.at(-1)?.oid).toBe(localOid);

    const oneOverResponses = rangeResponses(
      baseOid,
      localOid,
      `${MAX_EXACT_COMMIT_COUNT + 1}\n`,
      Buffer.alloc(0),
    );
    delete oneOverResponses[responseKey(['rev-list', '--parents', `${baseOid}..${localOid}`, '--'])];
    expectCode(() => withGitShim(oneOverResponses, (cwd) => readExactCommitRange(cwd, {
      baseOid, remoteOid: null, localOid,
    })), 'ci.input.commit-range-budget');
  });

  it('admits exactly the raw range-output byte limit before malformed parsing', () => {
    const baseOid = 'a'.repeat(40);
    const localOid = 'b'.repeat(40);
    const exact = Buffer.alloc(MAX_EXACT_COMMIT_RANGE_BYTES, 0x61);
    expectCode(() => withGitShim(
      rangeResponses(baseOid, localOid, '1\n', exact),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    ), 'ci.input.commit-range-malformed');

    const over = Buffer.alloc(MAX_EXACT_COMMIT_RANGE_BYTES + 1, 0x61);
    expectCode(() => withGitShim(
      rangeResponses(baseOid, localOid, '1\n', over),
      (cwd) => readExactCommitRange(cwd, { baseOid, remoteOid: null, localOid }),
    ), 'ci.input.commit-range-budget');
  });

  it('uses bounded explicit Git calls with sanitized environment state', () => {
    const oid = 'a'.repeat(40);
    expect(withGitShim(emptyRangeResponses(oid), (cwd) => readExactCommitRange(cwd, {
      baseOid: oid,
      remoteOid: null,
      localOid: oid,
    }))).toEqual({
      baseOid: oid,
      remoteOid: null,
      rangeStartOid: oid,
      localOid: oid,
      commits: [],
    });
  });
});

describe('exact commit metadata', () => {
  it('uses only the closed policy-neutral static import surface', () => {
    const assertImportSurface = (path: string, expected: string[]): void => {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      const specifiers = extractModuleSpecifiers(source);
      expect([...new Set(specifiers)].sort(), path).toEqual(expected);
      expect(source, path).not.toMatch(/\bimport\s*\(/u);
      expect(source, path).not.toMatch(/\b(?:require|createRequire)\s*\(/u);
    };

    assertImportSurface('scripts/lib/ci-control/git-input.ts', [
        './git-input-core.ts',
        'node:child_process',
        'node:util',
    ]);
    assertImportSurface('scripts/lib/ci-control/git-input-core.ts', [
        '../../../src/lib/git-env.ts',
        'node:child_process',
        'node:crypto',
        'node:fs',
        'node:path',
        'node:util',
    ]);
  });

  it('reads the requested exact commit rather than a later safe ambient HEAD', () => {
    const { root } = fixture();
    write(root, 'unsafe.txt', 'unsafe commit fixture\n');
    git(root, ['add', '-A']);
    execFileSync('git', [
      'commit', '--quiet', '-m', 'unsafe subject',
      '-m', 'Co-Authored-By: Fixture <fixture@example.invalid>',
    ], {
      cwd: root,
      env: {
        ...gitEnvironment(root),
        GIT_AUTHOR_NAME: 'Retired Worker',
        GIT_AUTHOR_EMAIL: 'worker@invalid.example',
        GIT_COMMITTER_NAME: 'Retired Worker',
        GIT_COMMITTER_EMAIL: 'worker@invalid.example',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const unsafeOid = git(root, ['rev-parse', 'HEAD']);
    write(root, 'safe.txt', 'safe ambient head\n');
    commit(root, 'safe ambient head');

    const [metadata] = readExactCommitMetadata(root, [unsafeOid]);
    expect(metadata).toMatchObject({
      oid: unsafeOid,
      authorName: 'Retired Worker',
      authorEmail: 'worker@invalid.example',
      subject: 'unsafe subject',
      byteLength: expect.any(Number),
      contentSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(metadata?.message).toContain('Co-Authored-By: Fixture');
    expect(metadata?.parentOids).toHaveLength(1);
    expect(metadata?.treeOid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('preserves sorted input order, tree, parents, multiline messages, and signed headers', () => {
    const parentA = '2'.repeat(40);
    const parentB = '3'.repeat(40);
    const firstBody = rawCommitBody({
      parentOids: [parentA, parentB],
      optionalHeaders: [
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' continuation-line',
        ' ',
        ' -----END PGP SIGNATURE-----',
        'mergetag object deadbeef',
        ' continuation-two',
      ],
      message: 'first subject\n\nfirst body\nsecond body\n',
    });
    const secondBody = rawCommitBody({ message: '' });
    const entries = [firstBody, secondBody]
      .map((body) => ({ oid: commitOid(body), body }))
      .sort((left, right) => left.oid.localeCompare(right.oid));

    const metadata = withGitShim(commitMetadataResponses(entries), (cwd) =>
      readExactCommitMetadata(cwd, entries.map(({ oid }) => oid)));
    expect(metadata.map(({ oid }) => oid)).toEqual(entries.map(({ oid }) => oid));
    const signed = metadata.find(({ parentOids }) => parentOids.length === 2)!;
    expect(signed).toMatchObject({
      treeOid: '1'.repeat(40),
      parentOids: [parentA, parentB],
      subject: 'first subject',
      message: 'first subject\n\nfirst body\nsecond body\n',
      byteLength: firstBody.byteLength,
      contentSha256: `sha256:${createHash('sha256').update(firstBody).digest('hex')}`,
    });
    expect(metadata.find(({ parentOids }) => parentOids.length === 0)?.message).toBe('');
  });

  it('rejects non-arrays, sparse/accessor/proxy inputs, malformed OIDs, duplicates, and unsorted OIDs before Git', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const sparse = new Array<string>(1);
    const accessor: string[] = [];
    let getterCalls = 0;
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return a;
      },
    });
    Object.defineProperty(accessor, 'length', { value: 1 });
    const trapped = new Proxy([a], {
      getOwnPropertyDescriptor: () => {
        throw new Error('private trap text');
      },
    });
    const transparentProxy = new Proxy([a], {});
    const nonEnumerableIndex = [a];
    Object.defineProperty(nonEnumerableIndex, '0', {
      configurable: true,
      enumerable: false,
      value: a,
      writable: true,
    });
    const extraStringKey = [a];
    Object.defineProperty(extraStringKey, 'extra', { enumerable: true, value: a });
    const symbolKey = [a];
    Object.defineProperty(symbolKey, Symbol('extra'), { enumerable: true, value: a });
    const customPrototype = [a];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
    const malformed: unknown[] = [
      null, {}, new Set([a]), sparse, accessor, trapped, transparentProxy, nonEnumerableIndex,
      extraStringKey,
      symbolKey, customPrototype, [a.toUpperCase()], ['g'.repeat(40)],
      [a, a], [b, a],
    ];
    for (const value of malformed) {
      expectCode(() => readExactCommitMetadata(
        '/not-a-repository', value as readonly string[],
      ), 'ci.input.commit-metadata-malformed');
    }
    expect(getterCalls).toBe(0);
  });

  it('rejects malformed commit bodies, NUL, invalid UTF-8, and unsupported encoding', () => {
    const valid = rawCommitBody({ message: 'subject\n' });
    const malformedBodies = [
      Buffer.from(valid.toString('utf8').replace(/^tree /, 'parent ')),
      Buffer.from(valid.toString('utf8').replace('\nauthor ', '\ntree ')),
      Buffer.from(valid.toString('utf8').replace('\ncommitter ', '\nauthor ')),
      Buffer.from(valid.toString('utf8').replace('\n\nsubject', '\n continuation\n\nsubject')),
      rawCommitBody({ optionalHeaders: ['encoding ISO-8859-1'], message: 'subject\n' }),
      Buffer.from(valid.toString('utf8').replace('\nauthor ', '\r\nauthor ')),
      Buffer.concat([valid, Buffer.from([0])]),
    ];
    for (const body of malformedBodies) {
      const oid = commitOid(body);
      expectCode(() => withGitShim(
        commitMetadataResponses([{ oid, body }]),
        (cwd) => readExactCommitMetadata(cwd, [oid]),
      ), 'ci.input.commit-metadata-malformed');
    }

    const invalidUtf8 = Buffer.concat([
      rawCommitBody({ message: '' }),
      Buffer.from([0xff]),
    ]);
    const invalidOid = commitOid(invalidUtf8);
    expectCode(() => withGitShim(
      commitMetadataResponses([{ oid: invalidOid, body: invalidUtf8 }]),
      (cwd) => readExactCommitMetadata(cwd, [invalidOid]),
    ), 'ci.input.commit-metadata-invalid-utf8');
  });

  it('rejects author and committer name angle brackets and controls while preserving ordinary Unicode names', () => {
    for (const authorName of ['Bad<Name', 'Bad>Name', 'Bad\tName', `Bad${String.fromCharCode(1)}Name`]) {
      const body = rawCommitBody({
        author: `${authorName} <fixture@example.invalid> 1700000000 +0000`,
      });
      const oid = commitOid(body);
      expectCode(() => withGitShim(
        commitMetadataResponses([{ oid, body }]),
        (cwd) => readExactCommitMetadata(cwd, [oid]),
      ), 'ci.input.commit-metadata-malformed');
    }

    for (const committerName of ['Bad<Committer', 'Bad>Committer', 'Bad\tCommitter', `Bad${String.fromCharCode(1)}Committer`]) {
      const body = rawCommitBody({
        author: 'Safe Author <fixture@example.invalid> 1700000000 +0000',
        committer: `${committerName} <fixture@example.invalid> 1700000000 +0000`,
      });
      const oid = commitOid(body);
      expectCode(() => withGitShim(
        commitMetadataResponses([{ oid, body }]),
        (cwd) => readExactCommitMetadata(cwd, [oid]),
      ), 'ci.input.commit-metadata-malformed');
    }

    const safeBody = rawCommitBody({
      author: 'Zoë 李 <fixture@example.invalid> 1700000000 +0000',
      message: 'Unicode author\n',
    });
    const safeOid = commitOid(safeBody);
    expect(withGitShim(
      commitMetadataResponses([{ oid: safeOid, body: safeBody }]),
      (cwd) => readExactCommitMetadata(cwd, [safeOid]),
    )[0]?.authorName).toBe('Zoë 李');
  });

  it('rejects missing, non-commit, SHA-256, partial, and identity-mismatched evidence with sanitized errors', () => {
    const privateFixture = 'private-author-value@example.invalid';
    const body = rawCommitBody({
      author: `Private Fixture <${privateFixture}> 1700000000 +0000`,
    });
    const oid = commitOid(body);
    const wrongOid = 'f'.repeat(40);
    const cases: Array<{ responses: Record<string, GitShimResponse>; code: string }> = [
      {
        responses: {
          [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
          [responseKey(['cat-file', '-t', '--', oid])]: { stderr: privateFixture, exit: 1 },
        },
        code: 'ci.input.commit-metadata-unavailable',
      },
      {
        responses: {
          [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
          [responseKey(['cat-file', '-t', '--', oid])]: {
            stdout: 'commit\n', stderr: privateFixture, exit: 1,
          },
        },
        code: 'ci.input.commit-metadata-unavailable',
      },
      {
        responses: commitMetadataResponses([{ oid, body, type: 'blob\n' }]),
        code: 'ci.input.commit-metadata-malformed',
      },
      {
        responses: commitMetadataResponses([{ oid, body }], 'sha256\n'),
        code: 'ci.input.commit-metadata-malformed',
      },
      {
        responses: commitMetadataResponses([{ oid, body, size: `${body.byteLength + 1}\n` }]),
        code: 'ci.input.commit-metadata-identity-mismatch',
      },
      {
        responses: commitMetadataResponses([{ oid: wrongOid, body }]),
        code: 'ci.input.commit-metadata-identity-mismatch',
      },
    ];
    for (const entry of cases) {
      let thrown: unknown;
      try {
        withGitShim(entry.responses, (cwd) => readExactCommitMetadata(cwd, [
          entry.responses === cases.at(-1)?.responses ? wrongOid : oid,
        ]));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: entry.code });
      expect(String(thrown)).not.toContain(privateFixture);
      expectNoVisibleCause(thrown);
    }
  });

  it('rejects terminal commit-body substitution without exposing either body', async () => {
    const firstBody = rawCommitBody({ message: 'private first body\n' });
    const secondBody = rawCommitBody({ message: 'private other body\n' });
    expect(secondBody.byteLength).toBe(firstBody.byteLength);
    const oid = commitOid(firstBody);
    let bodyReads = 0;
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: (_file: string, rawArgs: string[]) => {
        const args = rawArgs.slice(1);
        if (responseKey(args) === responseKey(['rev-parse', '--show-object-format'])) {
          return Buffer.from('sha1\n');
        }
        if (responseKey(args) === responseKey(['cat-file', '-t', '--', oid])) {
          return Buffer.from('commit\n');
        }
        if (responseKey(args) === responseKey(['cat-file', '-s', '--', oid])) {
          return Buffer.from(`${firstBody.byteLength}\n`);
        }
        if (responseKey(args) === responseKey(['cat-file', 'commit', '--', oid])) {
          bodyReads += 1;
          return bodyReads === 1 ? firstBody : secondBody;
        }
        throw new Error('unexpected synthetic command');
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      let thrown: unknown;
      try {
        isolated.readExactCommitMetadata('/isolated-fixture', [oid]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.commit-metadata-identity-mismatch' });
      expect(String(thrown)).not.toContain('private first body');
      expect(String(thrown)).not.toContain('private other body');
      expect(bodyReads).toBe(2);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('maps only ETIMEDOUT to timeout, ENOBUFS to budget, and bare SIGKILL to unavailable', async () => {
    const verify = async (
      failure: NodeJS.ErrnoException & { signal?: string },
      code: string,
    ): Promise<void> => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({ execFileSync: () => { throw failure; } }));
      try {
        const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
        let thrown: unknown;
        try {
          isolated.readExactCommitMetadata('/isolated-fixture', []);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code });
        expect(String(thrown)).not.toContain(failure.message);
        expectNoVisibleCause(thrown);
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    };
    await verify(Object.assign(new Error('private timeout'), { code: 'ETIMEDOUT' }), 'ci.input.commit-metadata-timeout');
    await verify(Object.assign(new Error('private budget'), { code: 'ENOBUFS' }), 'ci.input.commit-metadata-budget');
    await verify(Object.assign(new Error('private signal'), { signal: 'SIGKILL' }), 'ci.input.commit-metadata-unavailable');
  });

  it('publishes fixed inclusive metadata budgets and rejects one-over count before Git', () => {
    expect(MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES).toBe(1 * 1_024 * 1_024);
    expect(MAX_EXACT_AGGREGATE_COMMIT_METADATA_BYTES).toBe(16 * 1_024 * 1_024);
    const exactCount = Array.from({ length: MAX_EXACT_COMMIT_COUNT }, (_, index) =>
      index.toString(16).padStart(40, '0'));
    expectCode(() => readExactCommitMetadata(
      '/not-a-repository', exactCount,
    ), 'ci.input.commit-metadata-unavailable');
    expectCode(() => readExactCommitMetadata(
      '/not-a-repository',
      Array.from({ length: MAX_EXACT_COMMIT_COUNT + 1 }, (_, index) =>
        index.toString(16).padStart(40, '0')),
    ), 'ci.input.commit-metadata-budget');
  });

  it('admits exact single and aggregate preflight bounds and rejects one over before loading bodies', () => {
    const oid = 'a'.repeat(40);
    const exactSingle = commitMetadataResponses([{
      oid,
      body: Buffer.alloc(0),
      size: `${MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES}\n`,
    }]);
    delete exactSingle[responseKey(['cat-file', 'commit', '--', oid])];
    expectCode(() => withGitShim(exactSingle, (cwd) => readExactCommitMetadata(cwd, [oid])),
      'ci.input.commit-metadata-unavailable');

    const oversized = commitMetadataResponses([{
      oid,
      body: Buffer.alloc(0),
      size: `${MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES + 1}\n`,
    }]);
    delete oversized[responseKey(['cat-file', 'commit', '--', oid])];
    expectCode(() => withGitShim(oversized, (cwd) => readExactCommitMetadata(cwd, [oid])),
      'ci.input.commit-metadata-budget');

    const exactAggregateOids = Array.from({ length: 16 }, (_, index) =>
      (index + 1).toString(16).padStart(40, '0'));
    const exactAggregate = commitMetadataResponses(exactAggregateOids.map((entryOid) => ({
      oid: entryOid,
      body: Buffer.alloc(0),
      size: `${MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES}\n`,
    })));
    for (const entryOid of exactAggregateOids) {
      delete exactAggregate[responseKey(['cat-file', 'commit', '--', entryOid])];
    }
    expectCode(() => withGitShim(
      exactAggregate,
      (cwd) => readExactCommitMetadata(cwd, exactAggregateOids),
    ), 'ci.input.commit-metadata-unavailable');

    const oids = [...exactAggregateOids, 'f'.repeat(40)];
    const responses = commitMetadataResponses(oids.map((entryOid, index) => ({
      oid: entryOid,
      body: Buffer.alloc(0),
      size: `${index === 16 ? 1 : MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES}\n`,
    })));
    for (const entryOid of oids) delete responses[responseKey(['cat-file', 'commit', '--', entryOid])];
    expectCode(() => withGitShim(responses, (cwd) => readExactCommitMetadata(cwd, oids)),
      'ci.input.commit-metadata-budget');
  });

  it('preflights every object before loading any body', () => {
    const firstBody = rawCommitBody({ message: 'first\n' });
    const firstOid = commitOid(firstBody);
    const secondOid = 'f'.repeat(40);
    const oids = [firstOid, secondOid].sort();
    const responses = commitMetadataResponses([{ oid: firstOid, body: firstBody }]);
    responses[responseKey(['cat-file', '-t', '--', secondOid])] = { stdout: 'commit\n' };
    responses[responseKey(['cat-file', '-s', '--', secondOid])] = {
      stdout: `${MAX_EXACT_SINGLE_COMMIT_METADATA_BYTES + 1}\n`,
    };
    delete responses[responseKey(['cat-file', 'commit', '--', firstOid])];
    expectCode(() => withGitShim(responses, (cwd) => readExactCommitMetadata(cwd, oids)),
      'ci.input.commit-metadata-budget');
  });
});

describe('exact blob set', () => {
  it('validates every member before Git access', () => {
    const oid = 'a'.repeat(40);
    for (const invalid of ['', oid.toUpperCase(), 'g'.repeat(40), 7, null]) {
      expectCode(() => readExactBlobs(
        '/not-a-repository',
        [oid, invalid] as unknown as readonly string[],
      ), 'ci.input.blob-set-malformed');
    }

    let getterCalls = 0;
    const accessor: string[] = [];
    Object.defineProperty(accessor, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return oid;
      },
    });
    Object.defineProperty(accessor, 'length', { value: 1 });
    expectCode(() => readExactBlobs('/not-a-repository', accessor),
      'ci.input.blob-set-malformed');
    expect(getterCalls).toBe(0);
  });

  it('requires canonical scalar framing for object format, blob type, and blob size', () => {
    const oid = 'a'.repeat(40);
    for (const scalar of [' sha1\n', 'sha1 \n', 'sha1\n\n', 'sha1', 'sha1\r\n', 'shá1\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: scalar },
      }, (cwd) => readExactBlobs(cwd, [oid])), 'ci.input.blob-set-malformed');
    }

    for (const scalar of [' blob\n', 'blob \n', 'blob\n\n', 'blob', 'blob\r\n', 'blób\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
        [responseKey(['cat-file', '-t', '--', oid])]: { stdout: scalar },
      }, (cwd) => readExactBlobs(cwd, [oid])), 'ci.input.blob-set-malformed');
    }

    for (const scalar of [' 0\n', '0 \n', '0\n\n', '0', '0\r\n', '０\n']) {
      expectCode(() => withGitShim({
        [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
        [responseKey(['cat-file', '-t', '--', oid])]: { stdout: 'blob\n' },
        [responseKey(['cat-file', '-s', '--', oid])]: { stdout: scalar },
      }, (cwd) => readExactBlobs(cwd, [oid])), 'ci.input.blob-set-malformed');
    }
  });

  it('reads blob identities selected from regular, executable, and symlink tree entries', () => {
    const { root } = fixture();
    write(root, 'regular.txt', 'regular\n');
    write(root, 'executable.sh', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'executable.sh'), 0o755);
    symlinkSync('regular.txt', join(root, 'regular-link'));
    const commitOid = commit(root, 'blob modes');
    const oids = [
      git(root, ['rev-parse', `${commitOid}:regular.txt`]),
      git(root, ['rev-parse', `${commitOid}:executable.sh`]),
      git(root, ['rev-parse', `${commitOid}:regular-link`]),
    ];

    const blobs = readExactBlobs(root, [oids[2]!, oids[0]!, oids[1]!, oids[0]!]);
    expect(blobs.map(({ oid }) => oid)).toEqual([...oids].sort());
    for (const blob of blobs) {
      expect(blob.byteLength).toBe(blob.bytes.byteLength);
      expect(blob.contentSha256).toBe(`sha256:${createHash('sha256').update(blob.bytes).digest('hex')}`);
      expect(gitWithInput(root, ['hash-object', '--stdin'], blob.bytes)).toBe(blob.oid);
    }
    expect(blobs.map(({ bytes }) => Buffer.from(bytes).toString('utf8')).sort()).toEqual([
      '#!/bin/sh\nexit 0\n',
      'regular\n',
      'regular.txt',
    ].sort());
  });

  it('rejects malformed, missing, and non-blob identities without returning partial results', () => {
    const { root, baseOid } = fixture();
    const validBlob = git(root, ['rev-parse', `${baseOid}:README.md`]);

    expectCode(() => readExactBlobs(root, [validBlob, 'A'.repeat(40)]), 'ci.input.blob-set-malformed');
    expectCode(() => readExactBlobs(root, [validBlob, 'f'.repeat(40)]), 'ci.input.blob-unavailable');
    expectCode(() => readExactBlobs(root, [validBlob, baseOid]), 'ci.input.blob-type-unsupported');
  });

  it('ignores replacement objects and verifies the requested Git blob identity', () => {
    const { root } = fixture();
    const original = hashBlob(root, Buffer.from('original\n'));
    const replacement = hashBlob(root, Buffer.from('replacement\n'));
    git(root, ['replace', original, replacement]);

    const [blob] = readExactBlobs(root, [original]);
    expect(blob?.oid).toBe(original);
    expect(Buffer.from(blob!.bytes).toString('utf8')).toBe('original\n');
  });

  it('rejects a blob over the single-object budget before returning content', () => {
    const { root } = fixture();
    const oversized = hashBlob(root, Buffer.alloc(MAX_EXACT_SINGLE_BLOB_BYTES + 1, 0x61));
    expectCode(() => readExactBlobs(root, [oversized]), 'ci.input.blob-set-budget');
  });

  it('checks the deduplicated count budget before resolving object types', () => {
    const { root } = fixture();
    const tooMany = Array.from(
      { length: MAX_EXACT_BLOB_COUNT + 1 },
      (_, index) => index.toString(16).padStart(40, '0'),
    );
    expectCode(() => readExactBlobs(root, tooMany), 'ci.input.blob-set-budget');
  });

  it('checks raw array shape and count before Git access or deduplication', () => {
    const oid = 'a'.repeat(40);
    expectCode(() => readExactBlobs('/not-a-repository', null as unknown as readonly string[]),
      'ci.input.blob-set-malformed');
    expectCode(() => readExactBlobs(
      '/not-a-repository',
      Array.from({ length: MAX_EXACT_BLOB_COUNT + 1 }, () => oid),
    ), 'ci.input.blob-set-budget');
    expectCode(() => readExactBlobs(
      '/not-a-repository',
      Array.from({ length: MAX_EXACT_BLOB_COUNT }, () => oid),
    ), 'ci.input.blob-unavailable');
  });

  it('accepts the inclusive single and aggregate byte limits and rejects aggregate one over', () => {
    const { root } = fixture();
    const exactOids = Array.from({ length: 4 }, (_, index) => {
      const content = Buffer.alloc(MAX_EXACT_SINGLE_BLOB_BYTES, 0x61 + index);
      return hashBlob(root, content);
    });
    const exact = readExactBlobs(root, exactOids);
    expect(exact).toHaveLength(4);
    expect(exact.reduce((sum, blob) => sum + blob.byteLength, 0))
      .toBe(MAX_EXACT_AGGREGATE_BLOB_BYTES);
    expect(exact.every(({ byteLength }) => byteLength === MAX_EXACT_SINGLE_BLOB_BYTES)).toBe(true);

    const oneByteOid = hashBlob(root, Buffer.from('x'));
    expectCode(() => readExactBlobs(root, [...exactOids, oneByteOid]),
      'ci.input.blob-set-budget');
  });

  it('rejects preflight single and aggregate sizes before requesting blob content', () => {
    const singleOid = 'a'.repeat(40);
    expectCode(() => withGitShim({
      [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
      [responseKey(['cat-file', '-t', '--', singleOid])]: { stdout: 'blob\n' },
      [responseKey(['cat-file', '-s', '--', singleOid])]: {
        stdout: `${MAX_EXACT_SINGLE_BLOB_BYTES + 1}\n`,
      },
    }, (cwd) => readExactBlobs(cwd, [singleOid])), 'ci.input.blob-set-budget');

    const oids = ['a', 'b', 'c', 'd', 'e'].map((prefix) => prefix.repeat(40));
    const responses: Record<string, GitShimResponse> = {
      [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
    };
    for (const [index, oid] of oids.entries()) {
      responses[responseKey(['cat-file', '-t', '--', oid])] = { stdout: 'blob\n' };
      responses[responseKey(['cat-file', '-s', '--', oid])] = {
        stdout: `${index === oids.length - 1 ? 1 : MAX_EXACT_SINGLE_BLOB_BYTES}\n`,
      };
    }
    expectCode(() => withGitShim(responses, (cwd) => readExactBlobs(cwd, oids)),
      'ci.input.blob-set-budget');
  });

  it('composes exact change facts and blob bytes for all supported Git entry modes', () => {
    const { root, baseOid } = fixture();
    write(root, 'regular.txt', 'regular mode\n');
    write(root, 'executable.sh', '#!/bin/sh\nexit 0\n');
    chmodSync(join(root, 'executable.sh'), 0o755);
    symlinkSync('regular.txt', join(root, 'regular-link'));
    git(root, ['add', '-A']);
    const multibyteBytes = Buffer.from('multibyte path\n');
    const multibyteOid = hashBlob(root, multibyteBytes);
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${multibyteOid},docs/café.txt`]);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},vendor/component`]);
    git(root, ['commit', '--quiet', '-m', 'all entry modes']);
    const localOid = git(root, ['rev-parse', 'HEAD']);

    const range = readExactCommitRange(root, { baseOid, remoteOid: null, localOid });
    expect(range.commits).toHaveLength(1);
    const facts = range.commits.flatMap(({ firstParentOid, oid }) =>
      readExactChangeFacts(root, firstParentOid, oid));
    expect(facts.map(({ path, newMode, newType }) => ({ path, newMode, newType }))).toEqual([
      { path: 'docs/café.txt', newMode: '100644', newType: 'blob' },
      { path: 'executable.sh', newMode: '100755', newType: 'executable' },
      { path: 'regular-link', newMode: '120000', newType: 'symlink' },
      { path: 'regular.txt', newMode: '100644', newType: 'blob' },
      { path: 'vendor/component', newMode: '160000', newType: 'gitlink' },
    ]);
    const eligibleFacts = facts.filter(({ newType }) =>
      newType === 'blob' || newType === 'executable' || newType === 'symlink');
    expect(eligibleFacts.map(({ path }) => path)).not.toContain('vendor/component');
    const blobs = readExactBlobs(root, eligibleFacts.map(({ newOid }) => newOid));
    const bytesByOid = new Map(blobs.map((blob) => [blob.oid, Buffer.from(blob.bytes).toString('utf8')]));
    expect(bytesByOid.get(multibyteOid)).toBe('multibyte path\n');
    expect([...bytesByOid.values()].sort()).toEqual([
      '#!/bin/sh\nexit 0\n',
      'multibyte path\n',
      'regular mode\n',
      'regular.txt',
    ].sort());
    expectCode(() => readExactBlobs(root, [baseOid]), 'ci.input.blob-type-unsupported');
  });

  it('rejects bytes that do not rehash to the requested blob identity', () => {
    const oid = 'a'.repeat(40);
    const wrong = Buffer.from('different bytes');
    const responses: Record<string, GitShimResponse> = {
      [responseKey(['rev-parse', '--show-object-format'])]: { stdout: 'sha1\n' },
      [responseKey(['cat-file', '-t', '--', oid])]: { stdout: 'blob\n' },
      [responseKey(['cat-file', '-s', '--', oid])]: { stdout: `${wrong.byteLength}\n` },
      [responseKey(['cat-file', 'blob', '--', oid])]: {
        stdoutBase64: wrong.toString('base64'),
      },
    };
    expectCode(() => withGitShim(responses, (cwd) => readExactBlobs(cwd, [oid])),
      'ci.input.blob-identity-mismatch');
  });

  it('does not send gitlink commit identities to blob reads during change-fact composition', () => {
    const { root, baseOid } = fixture();
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},vendor/component`]);
    git(root, ['commit', '--quiet', '-m', 'gitlink']);
    const localOid = git(root, ['rev-parse', 'HEAD']);
    const facts = readExactChangeFacts(root, baseOid, localOid);
    expect(facts).toMatchObject([{ path: 'vendor/component', newType: 'gitlink', newOid: baseOid }]);
    const eligible = facts
      .filter(({ newType }) => newType === 'blob' || newType === 'executable' || newType === 'symlink')
      .map(({ newOid }) => newOid);
    expect(eligible).toEqual([]);
    expectCode(() => readExactBlobs(root, [baseOid]), 'ci.input.blob-type-unsupported');
  });

  it('does not classify a SIGKILL-only child failure as a timeout', () => {
    const responses: Record<string, GitShimResponse> = {
      [responseKey(['rev-parse', '--show-object-format'])]: { signal: 'SIGKILL' },
    };
    expectCode(() => withGitShim(responses, (cwd) => readExactBlobs(cwd, [])),
      'ci.input.blob-unavailable');
  });

  it('maps only a proven ETIMEDOUT child-process error to the timeout code', async () => {
    const verifyIsolatedFailure = async (
      failure: NodeJS.ErrnoException & { signal?: string },
      code: string,
    ): Promise<void> => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        execFileSync: () => {
          throw failure;
        },
      }));
      try {
        const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
        let thrown: unknown;
        try {
          isolated.readExactBlobs('/isolated-fixture', []);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code });
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    };

    await verifyIsolatedFailure(
      Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT', signal: 'SIGKILL' }),
      'ci.input.git-execution-timeout',
    );
    await verifyIsolatedFailure(
      Object.assign(new Error('synthetic signal'), { signal: 'SIGKILL' }),
      'ci.input.blob-unavailable',
    );
  });

  it('publishes fixed inclusive blob budgets', () => {
    expect(MAX_EXACT_BLOB_COUNT).toBe(50_000);
    expect(MAX_EXACT_SINGLE_BLOB_BYTES).toBe(4 * 1_024 * 1_024);
    expect(MAX_EXACT_AGGREGATE_BLOB_BYTES).toBe(16 * 1_024 * 1_024);
  });
});
