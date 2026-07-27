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

describe('exact added lines', () => {
  it('remains policy-neutral and does not import result, policy, or receipt modules', () => {
    const forbiddenFamilies = new Set(['policy', 'result', 'receipt']);
    for (const path of [
      'scripts/lib/ci-control/git-input.ts',
      'scripts/lib/ci-control/git-input-core.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), path), 'utf8');
      const specifiers = extractModuleSpecifiers(source);
      expect(specifiers, path).not.toEqual([]);
      for (const specifier of specifiers) {
        const basename = specifier.split('/').at(-1)!.replace(/\.(?:[cm]?js|ts)$/u, '');
        const segments = basename.split('-');
        expect(
          segments.some((segment) => forbiddenFamilies.has(segment)),
          `${path} imports prohibited family through ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it('rejects unsupported repository object formats before accepting abbreviated identities', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-control-git-input-sha256-'));
    registerTemporaryRoot(root);
    git(root, ['init', '--quiet', '--object-format=sha256']);
    git(root, ['config', 'user.email', 'fixture@example.invalid']);
    git(root, ['config', 'user.name', 'Fixture Author']);
    write(root, 'base.txt', 'base\n');
    const baseOid = commit(root, 'base').slice(0, 40);
    write(root, 'candidate.txt', 'candidate\n');
    const candidateOid = commit(root, 'candidate').slice(0, 40);

    expectCode(
      () => readExactChangeFacts(root, baseOid, candidateOid),
      'ci.input.revision-unavailable',
    );
  });

  it('requires canonical scalar framing before accepting change facts', () => {
    const bytes = Buffer.from('added\n');
    const cases = [
      {
        key: () => responseKey(['rev-parse', '--show-object-format']),
        output: 'sha1\r\n',
        code: 'ci.input.revision-unavailable',
      },
      {
        key: (baseOid: string) => responseKey(['cat-file', '-t', '--', baseOid]),
        output: 'commit\r\n',
        code: 'ci.input.revision-unavailable',
      },
      {
        key: (baseOid: string, candidateOid: string) =>
          responseKey(['merge-base', '--all', baseOid, candidateOid]),
        output: null,
        code: 'ci.classification.merge-base-unavailable',
      },
    ] as const;
    for (const item of cases) {
      const scenario = addedFactsShimScenario([{ path: 'safe.txt', bytes }]);
      scenario.responses[item.key(scenario.baseOid, scenario.candidateOid)] = {
        stdout: item.output ?? `${scenario.baseOid}\r\n`,
      };
      expectCode(
        () => withGitShim(
          scenario.responses,
          (cwd) => readExactChangeFacts(cwd, scenario.baseOid, scenario.candidateOid),
        ),
        item.code,
      );
    }
  });

  it('rejects malformed change-fact identities before invoking Git', async () => {
    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const hostileOid = {
      [Symbol.toPrimitive]: () => {
        throw new Error('private revision trap');
      },
    };
    let gitCalls = 0;
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: () => {
        gitCalls += 1;
        throw new Error('private Git invocation');
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      for (const [base, candidate] of [
        ['HEAD', candidateOid],
        [baseOid, 'HEAD'],
        [hostileOid, candidateOid],
      ] as const) {
        let thrown: unknown;
        try {
          isolated.readExactChangeFacts(
            '/isolated-fixture',
            base as never,
            candidate,
          );
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: 'ci.input.revision-unavailable' });
        expect(String(thrown)).not.toContain('private Git invocation');
        expect(String(thrown)).not.toContain('private revision trap');
        expectNoVisibleCause(thrown);
      }
      expect(gitCalls).toBe(0);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('maps only proven timeout and output-budget failures to their specific change-fact codes', async () => {
    const { root, baseOid } = fixture();
    write(root, 'candidate.txt', 'candidate\n');
    const candidateOid = commit(root, 'candidate');
    const detectedKey = responseKey([
      '-c', `diff.renameLimit=${MAX_CHANGE_FACT_COUNT}`, 'diff-tree', '--raw', '-z',
      '--no-commit-id', '-r', '--abbrev=40', '--no-ext-diff', '--no-textconv',
      '--ignore-submodules=none', '--find-renames', '--find-copies',
      '--find-copies-harder', baseOid, candidateOid, '--',
    ]);
    const verify = async (
      failure: NodeJS.ErrnoException & { signal?: string },
      expectedCode: string,
    ): Promise<void> => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        execFileSync: (
          file: string,
          args: string[],
          options: Parameters<typeof execFileSync>[2],
        ) => {
          const key = responseKey(args.slice(1));
          if (key === detectedKey) throw failure;
          return execFileSync(file, args, options as never);
        },
      }));
      try {
        const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
        let thrown: unknown;
        try {
          isolated.readExactChangeFacts(root, baseOid, candidateOid);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: expectedCode });
        expect(String(thrown)).not.toContain(failure.message);
        expectNoVisibleCause(thrown);
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    };

    await verify(
      Object.assign(new Error('private timeout'), { code: 'ETIMEDOUT', signal: 'SIGKILL' }),
      'ci.classification.execution-timeout',
    );
    await verify(
      Object.assign(new Error('private bare signal'), { signal: 'SIGKILL' }),
      'ci.classification.change-set-malformed',
    );
    await verify(
      Object.assign(new Error('private output budget'), { code: 'ENOBUFS' }),
      'ci.classification.change-set-budget',
    );
    await verify(
      Object.assign(new Error('private ordinary failure'), { code: 'EIO' }),
      'ci.classification.change-set-malformed',
    );
  });

  it('returns canonical rows for added, modified, deleted, repeated, CRLF, and unterminated lines', () => {
    const { root, baseOid } = fixture();
    write(root, 'modified.txt', 'alpha\nrepeat\nrepeat\nomega\n');
    write(root, 'deleted.txt', 'remove me\n');
    write(root, 'crlf.txt', 'alpha\r\nomega\r\n');
    commit(root, 'content base');
    const contentBaseOid = git(root, ['rev-parse', 'HEAD']);

    write(root, 'added.txt', 'first\nsecond');
    write(root, 'modified.txt', 'alpha\nrepeat\ninserted\nrepeat\nomega\n');
    rmSync(join(root, 'deleted.txt'));
    write(root, 'crlf.txt', 'alpha\r\ninserted-crlf\r\nomega\r\n');
    const candidateOid = commit(root, 'content candidate');

    const result = readExactAddedLines(root, {
      baseOid: contentBaseOid,
      candidateOid,
    });
    const rows = result.changes;

    expect(result).toMatchObject({ baseOid: contentBaseOid, candidateOid });
    expect(rows.map(({ path, status, addedLines }) => ({ path, status, addedLines }))).toEqual([
      {
        path: 'added.txt',
        status: 'added',
        addedLines: [
          { path: 'added.txt', newBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/), newLineNumber: 1, text: 'first' },
          { path: 'added.txt', newBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/), newLineNumber: 2, text: 'second' },
        ],
      },
      {
        path: 'crlf.txt',
        status: 'modified',
        addedLines: [
          { path: 'crlf.txt', newBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/), newLineNumber: 2, text: 'inserted-crlf' },
        ],
      },
      { path: 'deleted.txt', status: 'deleted', addedLines: [] },
      {
        path: 'modified.txt',
        status: 'modified',
        addedLines: [
          { path: 'modified.txt', newBlobOid: expect.stringMatching(/^[0-9a-f]{40}$/), newLineNumber: 3, text: 'inserted' },
        ],
      },
    ]);
    expect(rows.every(({ addedLines, newOid }) =>
      addedLines.every(({ newBlobOid }) => newBlobOid === newOid))).toBe(true);
    expect(baseOid).not.toBe(contentBaseOid);
  });

  it('reads only the exact commit pair rather than ambient HEAD, index, or worktree', () => {
    const { root, baseOid } = fixture();
    write(root, 'target.txt', 'candidate\n');
    const candidateOid = commit(root, 'candidate');
    write(root, 'ambient.txt', 'head only\n');
    commit(root, 'ambient head');
    write(root, 'index.txt', 'index only\n');
    git(root, ['add', 'index.txt']);
    write(root, 'worktree.txt', 'worktree only\n');

    const rows = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(rows.map(({ path }) => path)).toEqual(['target.txt']);
    expect(rows[0]?.addedLines.map(({ text }) => text)).toEqual(['candidate']);
  });

  it('preserves pure rename/copy facts and returns no lines for equal blobs or mode-only changes', () => {
    const { root } = fixture();
    write(root, 'rename-old.txt', 'renamed content\n');
    write(root, 'copy-source.txt', 'copied content\n');
    write(root, 'mode-only.sh', '#!/bin/sh\nexit 0\n');
    const baseOid = commit(root, 'rename base');

    git(root, ['mv', 'rename-old.txt', 'rename-new.txt']);
    write(root, 'copy-target.txt', 'copied content\n');
    chmodSync(join(root, 'mode-only.sh'), 0o755);
    const candidateOid = commit(root, 'rename candidate');

    const rows = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(rows.map(({ status, path, oldPath }) => ({ status, path, oldPath }))).toEqual([
      { status: 'copied', path: 'copy-target.txt', oldPath: 'copy-source.txt' },
      { status: 'modified', path: 'mode-only.sh', oldPath: null },
      { status: 'renamed', path: 'rename-new.txt', oldPath: 'rename-old.txt' },
    ]);
    expect(rows.find(({ path }) => path === 'copy-target.txt')?.addedLines).toEqual([]);
    expect(rows.find(({ path }) => path === 'rename-new.txt')?.addedLines).toEqual([]);
    expect(rows.find(({ path }) => path === 'mode-only.sh')?.addedLines).toEqual([]);
  });

  it('preserves modified rename/copy labels while scanning every destination line', () => {
    const { root } = fixture();
    write(root, 'rename-old.txt', `${'rename base\n'.repeat(20)}`);
    write(root, 'copy-source.txt', `${'copy base\n'.repeat(20)}`);
    const baseOid = commit(root, 'similarity base');
    git(root, ['mv', 'rename-old.txt', 'rename-new.txt']);
    write(root, 'rename-new.txt', `${'rename base\n'.repeat(20)}rename addition\n`);
    write(root, 'copy-target.txt', `${'copy base\n'.repeat(20)}copy addition\n`);
    const candidateOid = commit(root, 'similarity candidate');

    const changes = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(changes.map(({ status, path, oldPath, addedLines }) => ({
      status,
      path,
      oldPath,
      texts: addedLines.map(({ text }) => text),
    }))).toEqual([
      {
        status: 'copied',
        path: 'copy-target.txt',
        oldPath: 'copy-source.txt',
        texts: [...Array.from({ length: 20 }, () => 'copy base'), 'copy addition'],
      },
      {
        status: 'renamed',
        path: 'rename-new.txt',
        oldPath: 'rename-old.txt',
        texts: [...Array.from({ length: 20 }, () => 'rename base'), 'rename addition'],
      },
    ]);
    expect(changes.every(({ similarity }) => similarity !== null)).toBe(true);
  });

  it('derives file-to-directory and directory-to-file changes from verified trees', () => {
    const { root } = fixture();
    write(root, 'file-to-directory', 'old standalone file\n');
    write(root, 'directory-to-file/old-child.txt', 'old nested file\n');
    const baseOid = commit(root, 'shape base');

    rmSync(join(root, 'file-to-directory'));
    write(root, 'file-to-directory/new-child.txt', 'new nested file\n');
    rmSync(join(root, 'directory-to-file'), { recursive: true });
    write(root, 'directory-to-file', 'new standalone file\n');
    const candidateOid = commit(root, 'shape candidate');

    expect(readExactChangeFacts(root, baseOid, candidateOid).map((fact) => ({
      status: fact.status,
      path: fact.path,
    }))).toEqual([
      { status: 'added', path: 'directory-to-file' },
      { status: 'deleted', path: 'directory-to-file/old-child.txt' },
      { status: 'deleted', path: 'file-to-directory' },
      { status: 'added', path: 'file-to-directory/new-child.txt' },
    ]);
  });

  it('handles repeated additions and patch-marker content without trusting patch text as identity', () => {
    const { root } = fixture();
    write(root, 'repeated.txt', 'same\nsame\nend\n');
    write(root, 'markers.txt', 'start\nend\n');
    const baseOid = commit(root, 'marker base');
    write(root, 'repeated.txt', 'same\nsame\nsame\nend\n');
    write(root, 'markers.txt', 'start\n+++ marker\n@@ marker\ndiff --git marker\nend\n');
    const candidateOid = commit(root, 'marker candidate');

    const changes = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(changes.find(({ path }) => path === 'repeated.txt')?.addedLines).toMatchObject([
      { newLineNumber: 3, text: 'same' },
    ]);
    expect(changes.find(({ path }) => path === 'markers.txt')?.addedLines.map(({ text }) => text))
      .toEqual(['+++ marker', '@@ marker', 'diff --git marker']);
  });

  it('handles modified-file terminated and unterminated newline transitions', () => {
    const { root } = fixture();
    write(root, 'terminated-to-unterminated.txt', 'old\n');
    write(root, 'unterminated-to-terminated.txt', 'old');
    write(root, 'unterminated-replacement.txt', 'anchor\nold');
    const baseOid = commit(root, 'newline base');
    write(root, 'terminated-to-unterminated.txt', 'new');
    write(root, 'unterminated-to-terminated.txt', 'new\n');
    write(root, 'unterminated-replacement.txt', 'anchor\nnew');
    const candidateOid = commit(root, 'newline candidate');

    const changes = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(changes.map(({ path, addedLines }) => ({
      path,
      additions: addedLines.map(({ newLineNumber, text }) => ({ newLineNumber, text })),
    }))).toEqual([
      {
        path: 'terminated-to-unterminated.txt',
        additions: [{ newLineNumber: 1, text: 'new' }],
      },
      {
        path: 'unterminated-replacement.txt',
        additions: [{ newLineNumber: 2, text: 'new' }],
      },
      {
        path: 'unterminated-to-terminated.txt',
        additions: [{ newLineNumber: 1, text: 'new' }],
      },
    ]);
  });

  it('supports symlinks, multibyte paths/content, and a cached pair mapped to two paths', () => {
    const { root } = fixture();
    write(root, 'first.txt', 'old\n');
    write(root, 'second.txt', 'old\n');
    const baseOid = commit(root, 'pair base');
    write(root, 'first.txt', 'new café\n');
    write(root, 'second.txt', 'new café\n');
    write(root, 'docs/café.txt', 'olá\n');
    symlinkSync('docs/café.txt', join(root, 'café-link'));
    const candidateOid = commit(root, 'pair candidate');

    const changes = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(changes.find(({ path }) => path === 'café-link')?.addedLines.map(({ text }) => text))
      .toEqual(['docs/café.txt']);
    expect(changes.find(({ path }) => path === 'docs/café.txt')?.addedLines.map(({ text }) => text))
      .toEqual(['olá']);
    for (const path of ['first.txt', 'second.txt']) {
      expect(changes.find((change) => change.path === path)?.addedLines).toMatchObject([
        { path, newLineNumber: 1, text: 'new café' },
      ]);
    }
  });

  it('executes one Git diff for a shared blob pair and remaps cached lines to each path', async () => {
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const { baseOid, candidateOid, responses } = addedLineShimScenario(
      ['first.txt', 'second.txt'], oldBytes, newBytes, patch,
    );
    const diffKey = responseKey([
      '-c', 'diff.algorithm=myers', 'diff', '--patch', '--unified=0',
      '--no-indent-heuristic', '--text', '--full-index', '--no-prefix',
      '--no-color', '--no-ext-diff', '--no-textconv', oldOid, newOid, '--',
    ]);
    let diffExecutions = 0;
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: (_file: string, args: string[]) => {
        const key = responseKey(args.slice(1));
        if (key === diffKey) diffExecutions += 1;
        const response = responses[key];
        if (response === undefined) throw new Error('unexpected synthetic command');
        if (response.stdoutBase64 !== undefined) return Buffer.from(response.stdoutBase64, 'base64');
        return Buffer.from(response.stdout ?? '', 'utf8');
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      const changes = isolated.readExactAddedLines(
        '/isolated-fixture', { baseOid, candidateOid },
      ).changes;
      expect(diffExecutions).toBe(1);
      expect(changes.map(({ path, addedLines }) => ({ path, linePath: addedLines[0]?.path })))
        .toEqual([
          { path: 'first.txt', linePath: 'first.txt' },
          { path: 'second.txt', linePath: 'second.txt' },
        ]);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('rejects malformed exact-key input without invoking accessors or Git', () => {
    const oid = 'a'.repeat(40);
    for (const value of [
      null,
      [],
      {},
      { baseOid: oid },
      { baseOid: oid, candidateOid: oid, extra: true },
      { baseOid: oid.toUpperCase(), candidateOid: oid },
      { baseOid: oid, candidateOid: 7 },
    ]) {
      expectCode(() => readExactAddedLines('/not-a-repository', value as never),
        'ci.input.added-lines.input-malformed');
    }
    let getterCalls = 0;
    const accessor = { baseOid: oid } as Record<string, unknown>;
    Object.defineProperty(accessor, 'candidateOid', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return oid;
      },
    });
    expectCode(() => readExactAddedLines('/not-a-repository', accessor as never),
      'ci.input.added-lines.input-malformed');
    expect(getterCalls).toBe(0);

    expectCode(
      () => readExactAddedLines(
        '/not-a-repository',
        new Proxy({ baseOid: oid, candidateOid: oid }, {}),
      ),
      'ci.input.added-lines.input-malformed',
    );

    for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'] as const) {
      let trapCalls = 0;
      const hostile = new Proxy({ baseOid: oid, candidateOid: oid }, {
        [trap]: () => {
          trapCalls += 1;
          throw new Error(`hostile ${trap}`);
        },
      });
      let thrown: unknown;
      try {
        readExactAddedLines('/not-a-repository', hostile);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.added-lines.input-malformed' });
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(trapCalls).toBe(0);
    }
  });

  it('rejects binary, invalid UTF-8, and changed gitlink content with closed codes', () => {
    for (const [name, bytes, code] of [
      ['binary.bin', Buffer.from([0x61, 0x00, 0x62]), 'ci.input.added-lines.binary'],
      ['invalid.txt', Buffer.from([0x61, 0xff, 0x62]), 'ci.input.added-lines.invalid-utf8'],
    ] as const) {
      const { root, baseOid } = fixture();
      writeFileSync(join(root, name), bytes);
      const candidateOid = commit(root, name);
      expectCode(() => readExactAddedLines(root, { baseOid, candidateOid }), code);
    }

    for (const [name, bytes, code] of [
      ['modified-binary.bin', Buffer.from([0x61, 0x00, 0x62]), 'ci.input.added-lines.binary'],
      ['modified-invalid.txt', Buffer.from([0x61, 0xff, 0x62]), 'ci.input.added-lines.invalid-utf8'],
    ] as const) {
      const { root } = fixture();
      write(root, name, 'safe\n');
      const baseOid = commit(root, 'modified binary base');
      writeFileSync(join(root, name), bytes);
      const candidateOid = commit(root, 'modified binary candidate');
      expectCode(() => readExactAddedLines(root, { baseOid, candidateOid }), code);
    }

    const { root, baseOid } = fixture();
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${baseOid},vendor/component`]);
    git(root, ['commit', '--quiet', '-m', 'gitlink']);
    const candidateOid = git(root, ['rev-parse', 'HEAD']);
    expectCode(() => readExactAddedLines(root, { baseOid, candidateOid }),
      'ci.input.added-lines.gitlink');
  });

  it('does not decode deleted or equal-OID mode-only binary and invalid UTF-8 blobs', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'deleted-nul.bin'), Buffer.from([0x61, 0x00, 0x62]));
    writeFileSync(join(root, 'deleted-invalid.bin'), Buffer.from([0x61, 0xff, 0x62]));
    writeFileSync(join(root, 'mode-only.bin'), Buffer.from([0x61, 0x00, 0xff]));
    const baseOid = commit(root, 'binary base');
    rmSync(join(root, 'deleted-nul.bin'));
    rmSync(join(root, 'deleted-invalid.bin'));
    chmodSync(join(root, 'mode-only.bin'), 0o755);
    const candidateOid = commit(root, 'binary metadata only');

    const changes = readExactAddedLines(root, { baseOid, candidateOid }).changes;
    expect(changes.map(({ path, addedLines }) => ({ path, addedLines }))).toEqual([
      { path: 'deleted-invalid.bin', addedLines: [] },
      { path: 'deleted-nul.bin', addedLines: [] },
      { path: 'mode-only.bin', addedLines: [] },
    ]);
  });

  it('rejects malformed, truncated, and wrong-OID blob-pair patches without retaining raw evidence', () => {
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const validPrefix = `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n--- ${oldOid}\n+++ ${newOid}\n`;
    const cases = [
      Buffer.from(`${validPrefix}@@ -1 +1 @@\n-old\n`),
      Buffer.from(`${validPrefix}@@ -1 +1 @@\n-old\n+new\nextra\n`),
      Buffer.from(`diff --git ${oldOid} ${newOid}\nindex ${'c'.repeat(40)}..${newOid} 100644\n--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`),
    ];
    for (const patch of cases) {
      const scenario = addedLineShimScenario('safe.txt', oldBytes, newBytes, patch);
      let thrown: unknown;
      try {
        withGitShim(scenario.responses, (cwd) => readExactAddedLines(cwd, {
          baseOid: scenario.baseOid,
          candidateOid: scenario.candidateOid,
        }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ExactGitInputError);
      expect(thrown).toMatchObject({ code: 'ci.input.added-lines.patch-malformed' });
      expect(String(thrown)).not.toContain('old');
      expect(String(thrown)).not.toContain('new');
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    }

    const oldWithTail = Buffer.from('old\ntail\n');
    const omittedNew = Buffer.from('new\n');
    const omittedOldOid = blobOid(oldWithTail);
    const omittedNewOid = blobOid(omittedNew);
    const omittedPatch = Buffer.from(
      `diff --git ${omittedOldOid} ${omittedNewOid}\n`
      + `index ${omittedOldOid}..${omittedNewOid} 100644\n`
      + `--- ${omittedOldOid}\n+++ ${omittedNewOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const omitted = addedLineShimScenario(
      'safe.txt', oldWithTail, omittedNew, omittedPatch,
    );
    expectCode(() => withGitShim(
      omitted.responses,
      (cwd) => readExactAddedLines(cwd, {
        baseOid: omitted.baseOid,
        candidateOid: omitted.candidateOid,
      }),
    ), 'ci.input.added-lines.patch-malformed');
  });

  it('rejects partial child output when the producer exits unsuccessfully', () => {
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const { baseOid, candidateOid, responses } = addedLineShimScenario(
      'safe.txt', oldBytes, newBytes, patch,
    );
    const diffKey = responseKey([
      '-c', 'diff.algorithm=myers', 'diff', '--patch', '--unified=0',
      '--no-indent-heuristic', '--text', '--full-index', '--no-prefix',
      '--no-color', '--no-ext-diff', '--no-textconv', oldOid, newOid, '--',
    ]);
    responses[diffKey] = {
      stdoutBase64: patch.toString('base64'),
      stderr: 'private partial child detail',
      exit: 23,
    };
    let thrown: unknown;
    try {
      withGitShim(responses, (cwd) => readExactAddedLines(cwd, { baseOid, candidateOid }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'ci.input.added-lines.unavailable' });
    expect(String(thrown)).not.toContain('private partial child detail');
    expectNoVisibleCause(thrown);
  });

  it('distinguishes timeout, signal, and output-budget failures at exact bounded boundaries', async () => {
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const { baseOid, candidateOid, responses } = addedLineShimScenario(
      'safe.txt', oldBytes, newBytes, patch,
    );
    const diffKey = responseKey([
      '-c', 'diff.algorithm=myers', 'diff', '--patch', '--unified=0',
      '--no-indent-heuristic', '--text', '--full-index', '--no-prefix',
      '--no-color', '--no-ext-diff', '--no-textconv', oldOid, newOid, '--',
    ]);
    const verifyDirectFailure = async (
      failure: NodeJS.ErrnoException & { signal?: string },
      expectedCode: string,
    ): Promise<void> => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        execFileSync: (_file: string, args: string[]) => {
          const key = responseKey(args.slice(1));
          if (key === diffKey) throw failure;
          const response = responses[key];
          if (response === undefined) throw new Error('unexpected synthetic command');
          if (response.stdoutBase64 !== undefined) return Buffer.from(response.stdoutBase64, 'base64');
          return Buffer.from(response.stdout ?? '', 'utf8');
        },
      }));
      try {
        const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
        let thrown: unknown;
        try {
          isolated.readExactAddedLines('/isolated-fixture', { baseOid, candidateOid });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: expectedCode });
        expect(String(thrown)).not.toContain(failure.message);
        expectNoVisibleCause(thrown);
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    };

    await verifyDirectFailure(
      Object.assign(new Error('synthetic direct timeout'), { code: 'ETIMEDOUT' }),
      'ci.input.added-lines.timeout',
    );
    await verifyDirectFailure(
      Object.assign(new Error('synthetic bare signal'), { signal: 'SIGKILL' }),
      'ci.input.added-lines.unavailable',
    );
    await verifyDirectFailure(
      Object.assign(new Error('synthetic output cap'), { code: 'ENOBUFS' }),
      'ci.input.added-lines.budget',
    );

    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: () => {
        throw Object.assign(new Error('exact boundary timeout'), { code: 'ETIMEDOUT' });
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      let thrown: unknown;
      try {
        isolated.readExactAddedLines('/isolated-fixture', { baseOid, candidateOid });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.added-lines.timeout' });
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('rejects a blob whose exact bytes change during terminal revalidation', async () => {
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const { baseOid, candidateOid, responses } = addedLineShimScenario(
      'safe.txt', oldBytes, newBytes, patch,
    );
    const changedKey = responseKey(['cat-file', 'blob', '--', newOid]);
    let changedReads = 0;
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: (_file: string, args: string[]) => {
        const key = responseKey(args.slice(1));
        if (key === changedKey) {
          changedReads += 1;
          return changedReads === 1 ? newBytes : Buffer.from('bad\n');
        }
        const response = responses[key];
        if (response === undefined) throw new Error('unexpected synthetic command');
        if (response.stdoutBase64 !== undefined) return Buffer.from(response.stdoutBase64, 'base64');
        return Buffer.from(response.stdout ?? '', 'utf8');
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      let thrown: unknown;
      try {
        isolated.readExactAddedLines('/isolated-fixture', { baseOid, candidateOid });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.added-lines.identity-mismatch' });
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('rejects a verified change tree whose bytes change during terminal revalidation', async () => {
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const { baseOid, candidateOid, responses } = addedLineShimScenario(
      'safe.txt', oldBytes, newBytes, patch,
    );
    const candidateTree = Object.entries(responses).find(([key, response]) => {
      const args = JSON.parse(key) as string[];
      if (
        args[0] !== 'cat-file'
        || args[1] !== 'tree'
        || response.stdoutBase64 === undefined
      ) {
        return false;
      }
      return Buffer.from(response.stdoutBase64, 'base64').includes(Buffer.from(newOid, 'hex'));
    });
    expect(candidateTree).toBeDefined();
    const [candidateTreeKey, candidateTreeResponse] = candidateTree!;
    const originalTree = Buffer.from(candidateTreeResponse.stdoutBase64!, 'base64');
    const substitutedTree = Buffer.from(originalTree);
    const pathOffset = substitutedTree.indexOf(Buffer.from('safe.txt', 'utf8'));
    expect(pathOffset).toBeGreaterThanOrEqual(0);
    substitutedTree.set(Buffer.from('evil.txt', 'utf8'), pathOffset);
    expect(substitutedTree.byteLength).toBe(originalTree.byteLength);

    let treeReads = 0;
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: (_file: string, args: string[]) => {
        const key = responseKey(args.slice(1));
        if (key === candidateTreeKey) {
          treeReads += 1;
          return treeReads === 1 ? originalTree : substitutedTree;
        }
        const response = responses[key];
        if (response === undefined) throw new Error('unexpected synthetic command');
        if (response.stdoutBase64 !== undefined) return Buffer.from(response.stdoutBase64, 'base64');
        return Buffer.from(response.stdout ?? '', 'utf8');
      },
    }));
    try {
      const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
      let thrown: unknown;
      try {
        isolated.readExactAddedLines('/isolated-fixture', { baseOid, candidateOid });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'ci.input.added-lines.identity-mismatch' });
      expect(treeReads).toBe(2);
      expectNoVisibleCause(thrown);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('accepts the change-count boundary and rejects one additional fact before blob reads', () => {
    const bytes = Buffer.from('added\n');
    const scenarioForCount = (count: number) => addedFactsShimScenario(
      Array.from({ length: count }, (_, index) => ({
        path: `file-${String(index).padStart(4, '0')}.txt`,
        bytes,
      })),
    );
    const exact = scenarioForCount(MAX_EXACT_ADDED_LINE_CHANGE_COUNT);
    expect(withGitShim(
      exact.responses,
      (cwd) => readExactAddedLines(cwd, {
        baseOid: exact.baseOid,
        candidateOid: exact.candidateOid,
      }),
    ).changes).toHaveLength(MAX_EXACT_ADDED_LINE_CHANGE_COUNT);
    const over = scenarioForCount(MAX_EXACT_ADDED_LINE_CHANGE_COUNT + 1);
    const objectOid = blobOid(bytes);
    delete over.responses[responseKey(['cat-file', '-t', '--', objectOid])];
    delete over.responses[responseKey(['cat-file', '-s', '--', objectOid])];
    delete over.responses[responseKey(['cat-file', 'blob', '--', objectOid])];
    expectCode(() => withGitShim(
      over.responses,
      (cwd) => readExactAddedLines(cwd, {
        baseOid: over.baseOid,
        candidateOid: over.candidateOid,
      }),
    ), 'ci.input.added-lines.budget');
  });

  it('publishes inclusive fixed budgets and rejects returned-line count one over', () => {
    expect(MAX_EXACT_ADDED_LINE_CHANGE_COUNT).toBe(4_096);
    expect(MAX_EXACT_ADDED_LINE_COUNT).toBe(100_000);
    expect(MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT).toBe(200_000);
    expect(MAX_EXACT_ADDED_LINE_PATCH_BYTES).toBe(4 * 1_024 * 1_024);
    expect(MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT).toBe(400_000);
    expect(MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES).toBe(16 * 1_024 * 1_024);
    expect(MAX_EXACT_ADDED_LINE_BYTES).toBe(16 * 1_024 * 1_024);

    const shared = Buffer.from(`${'x\n'.repeat(MAX_EXACT_ADDED_LINE_COUNT / 2 - 1)}x`);
    const exactFacts = [
      { path: 'first.txt', bytes: shared },
      { path: 'second.txt', bytes: shared },
    ];
    const exact = addedFactsShimScenario(exactFacts);
    expect(withGitShim(
      exact.responses,
      (cwd) => readExactAddedLines(cwd, {
        baseOid: exact.baseOid,
        candidateOid: exact.candidateOid,
      }),
    ).changes.flatMap(({ addedLines }) => addedLines)).toHaveLength(MAX_EXACT_ADDED_LINE_COUNT);

    const oneLine = Buffer.from('one');
    const over = addedFactsShimScenario([
      ...exactFacts,
      { path: 'third.txt', bytes: oneLine },
    ]);
    expectCode(() => withGitShim(
      over.responses,
      (cwd) => readExactAddedLines(cwd, {
        baseOid: over.baseOid,
        candidateOid: over.candidateOid,
      }),
    ), 'ci.input.added-lines.budget');
  });

  it('accepts the source-line processing boundary with one returned addition and rejects one over', () => {
    const half = MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT / 2;
    const oldBytes = Buffer.from('x\n'.repeat(half));
    const exactNewBytes = Buffer.from(
      `${'x\n'.repeat(half / 2)}one replacement\n${'x\n'.repeat(half / 2 - 1)}`,
    );
    const oldOid = blobOid(oldBytes);
    const exactNewOid = blobOid(exactNewBytes);
    const exactPatch = Buffer.from(
      `diff --git ${oldOid} ${exactNewOid}\nindex ${oldOid}..${exactNewOid} 100644\n`
      + `--- ${oldOid}\n+++ ${exactNewOid}\n`
      + `@@ -${half / 2 + 1} +${half / 2 + 1} @@\n-x\n+one replacement\n`,
    );
    const exact = addedLineShimScenario(
      'source-lines.txt', oldBytes, exactNewBytes, exactPatch,
    );
    expect(withGitShim(
      exact.responses,
      (cwd) => readExactAddedLines(cwd, {
        baseOid: exact.baseOid,
        candidateOid: exact.candidateOid,
      }),
    ).changes[0]?.addedLines).toMatchObject([
      { newLineNumber: half / 2 + 1, text: 'one replacement' },
    ]);

    const overNewBytes = Buffer.from(`${'x\n'.repeat(half)}one addition\n`);
    const overNewOid = blobOid(overNewBytes);
    const overPatch = Buffer.from(
      `diff --git ${oldOid} ${overNewOid}\nindex ${oldOid}..${overNewOid} 100644\n`
      + `--- ${oldOid}\n+++ ${overNewOid}\n@@ -${half},0 +${half + 1} @@\n+one addition\n`,
    );
    const over = addedLineShimScenario(
      'source-lines.txt', oldBytes, overNewBytes, overPatch,
    );
    expectCode(() => withGitShim(
      over.responses,
      (cwd) => readExactAddedLines(cwd, {
        baseOid: over.baseOid,
        candidateOid: over.candidateOid,
      }),
    ), 'ci.input.added-lines.budget');
  });

  it('checks the raw patch-row boundary before decoding or splitting', () => {
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    for (const [rowCount, code] of [
      [MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT, 'ci.input.added-lines.patch-malformed'],
      [MAX_EXACT_ADDED_LINE_PATCH_ROW_COUNT + 1, 'ci.input.added-lines.budget'],
    ] as const) {
      const patch = Buffer.from('x\n'.repeat(rowCount));
      const scenario = addedLineShimScenario('safe.txt', oldBytes, newBytes, patch);
      expectCode(() => withGitShim(
        scenario.responses,
        (cwd) => readExactAddedLines(cwd, {
          baseOid: scenario.baseOid,
          candidateOid: scenario.candidateOid,
        }),
      ), code);
    }
  });

  it('accepts the aggregate added-text byte boundary and rejects one byte over', () => {
    const shared = Buffer.alloc(MAX_EXACT_ADDED_LINE_BYTES / 4, 0x61);
    const exactFacts = Array.from({ length: 4 }, (_, index) => ({
      path: `exact-${index}.txt`,
      bytes: shared,
    }));
    const exactScenario = addedFactsShimScenario(exactFacts);
    const exact = withGitShim(
      exactScenario.responses,
      (cwd) => readExactAddedLines(cwd, {
        baseOid: exactScenario.baseOid,
        candidateOid: exactScenario.candidateOid,
      }),
    );
    expect(exact.changes.flatMap(({ addedLines }) => addedLines)
      .reduce((total, { text }) => total + Buffer.byteLength(text, 'utf8'), 0))
      .toBe(MAX_EXACT_ADDED_LINE_BYTES);

    const overScenario = addedFactsShimScenario([
      ...exactFacts,
      { path: 'over-extra.txt', bytes: Buffer.from('x') },
    ]);
    expectCode(() => withGitShim(
      overScenario.responses,
      (cwd) => readExactAddedLines(cwd, {
        baseOid: overScenario.baseOid,
        candidateOid: overScenario.candidateOid,
      }),
    ), 'ci.input.added-lines.budget');
  });

  it('accepts exact single/aggregate patch byte limits and rejects one byte over', async () => {
    const runScenario = async (patchSizes: number[], expectedCode?: string): Promise<void> => {
      const facts = patchSizes.map((patchSize, index) => {
        const placeholder = '0'.repeat(40);
        const fixed = Buffer.byteLength(
          `diff --git ${placeholder} ${placeholder}\nindex ${placeholder}..${placeholder} 100644\n`
          + `--- ${placeholder}\n+++ ${placeholder}\n@@ -1 +1 @@\n-\n+\n`,
        );
        const payloadBytes = patchSize - fixed;
        expect(payloadBytes).toBeGreaterThanOrEqual(2);
        const oldText = String.fromCharCode(0x61 + index * 2)
          .repeat(Math.floor(payloadBytes / 2));
        const newText = String.fromCharCode(0x62 + index * 2)
          .repeat(payloadBytes - oldText.length);
        const oldBytes = Buffer.from(`${oldText}\n`);
        const newBytes = Buffer.from(`${newText}\n`);
        const oldOid = blobOid(oldBytes);
        const newOid = blobOid(newBytes);
        const patchBytes = Buffer.from(
          `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
          + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-${oldText}\n+${newText}\n`,
        );
        expect(patchBytes).toHaveLength(patchSize);
        return {
          path: `patch-${index}.txt`,
          oldBytes,
          newBytes,
          patch: patchBytes,
        };
      });
      const scenario = modifiedFactsShimScenario(facts);

      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        execFileSync: (_file: string, args: string[], options: { maxBuffer: number }) => {
          const response = scenario.responses[responseKey(args.slice(1))];
          if (response === undefined) throw new Error('unexpected synthetic command');
          const output = response.stdoutBase64 !== undefined
            ? Buffer.from(response.stdoutBase64, 'base64')
            : Buffer.from(response.stdout ?? '', 'utf8');
          if (output.byteLength > options.maxBuffer) {
            throw Object.assign(new Error('synthetic output cap'), { code: 'ENOBUFS' });
          }
          return output;
        },
      }));
      try {
        const isolated = await import('../../scripts/lib/ci-control/git-input.ts');
        if (expectedCode === undefined) {
          expect(isolated.readExactAddedLines(
            '/isolated-fixture', {
              baseOid: scenario.baseOid,
              candidateOid: scenario.candidateOid,
            },
          ).changes).toHaveLength(patchSizes.length);
        } else {
          let thrown: unknown;
          try {
            isolated.readExactAddedLines('/isolated-fixture', {
              baseOid: scenario.baseOid,
              candidateOid: scenario.candidateOid,
            });
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toMatchObject({ code: expectedCode });
        }
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    };

    await runScenario([MAX_EXACT_ADDED_LINE_PATCH_BYTES]);
    await runScenario(
      [MAX_EXACT_ADDED_LINE_PATCH_BYTES + 1],
      'ci.input.added-lines.budget',
    );
    const exactAggregate = Array.from({ length: 5 }, (_, index) =>
      Math.floor(MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES / 5)
      + (index < MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES % 5 ? 1 : 0));
    await runScenario(exactAggregate);
    await runScenario(
      exactAggregate.map((size, index) => size + (index === 4 ? 1 : 0)),
      'ci.input.added-lines.budget',
    );
  });

  it('publishes the six immutable exact-added-line budget ceilings and preserves the legacy shape', () => {
    expect(Object.keys(MAX_EXACT_ADDED_LINE_BUDGET_V1).sort()).toEqual([
      'addedLineCount',
      'addedTextBytes',
      'changeCount',
      'patchBytes',
      'sourceBlobBytes',
      'sourceLineCount',
    ]);
    expect(MAX_EXACT_ADDED_LINE_BUDGET_V1).toEqual({
      changeCount: MAX_EXACT_ADDED_LINE_CHANGE_COUNT,
      sourceBlobBytes: MAX_EXACT_AGGREGATE_BLOB_BYTES,
      sourceLineCount: MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT,
      patchBytes: MAX_EXACT_ADDED_LINE_PATCH_TOTAL_BYTES,
      addedLineCount: MAX_EXACT_ADDED_LINE_COUNT,
      addedTextBytes: MAX_EXACT_ADDED_LINE_BYTES,
    });
    expect(Object.isFrozen(MAX_EXACT_ADDED_LINE_BUDGET_V1)).toBe(true);

    const { root, baseOid } = fixture();
    const candidateOid = baseOid;
    expect(readExactAddedLines(root, { baseOid, candidateOid })).toEqual({
      baseOid,
      candidateOid,
      changes: [],
    });
    const budgeted = readExactAddedLinesWithinBudget(root, {
      baseOid,
      candidateOid,
      budget: {
        changeCount: 0,
        sourceBlobBytes: 0,
        sourceLineCount: 0,
        patchBytes: 0,
        addedLineCount: 0,
        addedTextBytes: 0,
      },
    });
    expect(budgeted).toEqual({
      baseOid,
      candidateOid,
      changes: [],
      accounting: {
        limit: {
          changeCount: 0,
          sourceBlobBytes: 0,
          sourceLineCount: 0,
          patchBytes: 0,
          addedLineCount: 0,
          addedTextBytes: 0,
        },
        consumed: {
          changeCount: 0,
          sourceBlobBytes: 0,
          sourceLineCount: 0,
          patchBytes: 0,
          addedLineCount: 0,
          addedTextBytes: 0,
        },
        remaining: {
          changeCount: 0,
          sourceBlobBytes: 0,
          sourceLineCount: 0,
          patchBytes: 0,
          addedLineCount: 0,
          addedTextBytes: 0,
        },
      },
    });
  });

  it('rejects widening and hostile budget records before Git without mutating frozen input', () => {
    const oid = 'a'.repeat(40);
    const valid = addedLineBudget();
    expectCode(() => readExactAddedLinesWithinBudget('/not-a-repository', {
      baseOid: oid,
      candidateOid: oid,
      budget: valid,
    }), 'ci.input.added-lines.unavailable');

    for (const key of Object.keys(valid) as (keyof ExactAddedLineBudgetV1)[]) {
      expectCode(() => readExactAddedLinesWithinBudget('/not-a-repository', {
        baseOid: oid,
        candidateOid: oid,
        budget: { ...valid, [key]: valid[key] + 1 },
      }), 'ci.input.added-lines.input-malformed');
    }
    for (const invalid of [-0, -1, 0.5, NaN, Infinity, '1', 1n]) {
      expectCode(() => readExactAddedLinesWithinBudget('/not-a-repository', {
        baseOid: oid,
        candidateOid: oid,
        budget: { ...valid, changeCount: invalid } as never,
      }), 'ci.input.added-lines.input-malformed');
    }

    let getterCalls = 0;
    const accessorBudget = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessorBudget, 'changeCount', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 0;
      },
    });
    const revoked = Proxy.revocable({ ...valid }, {});
    revoked.revoke();
    const hostileBudgets: unknown[] = [
      null,
      [],
      { ...valid, extra: 0 },
      Object.assign(Object.create({}), valid),
      new Proxy({ ...valid }, {}),
      revoked.proxy,
      accessorBudget,
    ];
    const symbolBudget = { ...valid } as Record<PropertyKey, unknown>;
    symbolBudget[Symbol('extra')] = 0;
    hostileBudgets.push(symbolBudget);
    const nonEnumerableBudget = { ...valid };
    Object.defineProperty(nonEnumerableBudget, 'changeCount', {
      value: valid.changeCount,
      enumerable: false,
    });
    hostileBudgets.push(nonEnumerableBudget);
    for (const budget of hostileBudgets) {
      expectCode(() => readExactAddedLinesWithinBudget('/not-a-repository', {
        baseOid: oid,
        candidateOid: oid,
        budget: budget as ExactAddedLineBudgetV1,
      }), 'ci.input.added-lines.input-malformed');
    }
    expect(getterCalls).toBe(0);

    const revokedInput = Proxy.revocable({ baseOid: oid, candidateOid: oid, budget: valid }, {});
    revokedInput.revoke();
    const inputAccessor = { baseOid: oid, candidateOid: oid } as Record<string, unknown>;
    Object.defineProperty(inputAccessor, 'budget', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return valid;
      },
    });
    for (const input of [
      new Proxy({ baseOid: oid, candidateOid: oid, budget: valid }, {}),
      revokedInput.proxy,
      inputAccessor,
      { baseOid: oid, candidateOid: oid, budget: valid, extra: 0 },
    ]) {
      expectCode(() => readExactAddedLinesWithinBudget('/not-a-repository', input as never),
        'ci.input.added-lines.input-malformed');
    }
    expect(getterCalls).toBe(0);

    const frozenBudget = Object.freeze(addedLineBudget({
      changeCount: 0,
      sourceBlobBytes: 0,
      sourceLineCount: 0,
      patchBytes: 0,
      addedLineCount: 0,
      addedTextBytes: 0,
    }));
    const frozenInput = Object.freeze({ baseOid: oid, candidateOid: oid, budget: frozenBudget });
    const before = JSON.stringify(frozenInput);
    expectCode(() => readExactAddedLinesWithinBudget('/not-a-repository', frozenInput),
      'ci.input.added-lines.unavailable');
    expect(JSON.stringify(frozenInput)).toBe(before);
  });

  it('charges exact logical evidence and returns deeply frozen copy-isolated accounting', () => {
    const { root, baseOid } = fixture();
    write(root, 'first.txt', 'é\n');
    write(root, 'second.txt', 'é\n');
    const candidateOid = commit(root, 'shared addition');
    const sourceBytes = Buffer.byteLength('é\n');
    const callerBudget = addedLineBudget({
      changeCount: 2,
      sourceBlobBytes: sourceBytes,
      sourceLineCount: 1,
      patchBytes: 0,
      addedLineCount: 2,
      addedTextBytes: 4,
    });
    const result = readExactAddedLinesWithinBudget(root, {
      baseOid,
      candidateOid,
      budget: callerBudget,
    });
    expect(result.accounting).toEqual({
      limit: {
        changeCount: 2,
        sourceBlobBytes: sourceBytes,
        sourceLineCount: 1,
        patchBytes: 0,
        addedLineCount: 2,
        addedTextBytes: 4,
      },
      consumed: {
        changeCount: 2,
        sourceBlobBytes: sourceBytes,
        sourceLineCount: 1,
        patchBytes: 0,
        addedLineCount: 2,
        addedTextBytes: 4,
      },
      remaining: {
        changeCount: 0,
        sourceBlobBytes: 0,
        sourceLineCount: 0,
        patchBytes: 0,
        addedLineCount: 0,
        addedTextBytes: 0,
      },
    });
    expect(result.changes.flatMap(({ addedLines }) => addedLines)).toHaveLength(2);
    expect(Object.isFrozen(result.accounting)).toBe(true);
    expect(Object.isFrozen(result.accounting.limit)).toBe(true);
    expect(Object.isFrozen(result.accounting.consumed)).toBe(true);
    expect(Object.isFrozen(result.accounting.remaining)).toBe(true);
    callerBudget.changeCount = 1;
    expect(result.accounting.limit.changeCount).toBe(2);
  });

  it('enforces each narrowed materialization pool at its real boundary', () => {
    const addedCase = (content: string, overrides: Partial<ExactAddedLineBudgetV1>) => {
      const { root, baseOid } = fixture();
      write(root, 'added.txt', content);
      const candidateOid = commit(root, 'added budget fixture');
      return () => readExactAddedLinesWithinBudget(root, {
        baseOid,
        candidateOid,
        budget: addedLineBudget(overrides),
      });
    };

    expectCode(addedCase('x', { changeCount: 0 }), 'ci.input.added-lines.budget');
    expectCode(addedCase('long-line', { sourceBlobBytes: Buffer.byteLength('long-line') - 1 }),
      'ci.input.added-lines.budget');
    expectCode(addedCase('\n\n', { sourceLineCount: 1 }), 'ci.input.added-lines.budget');
    expectCode(addedCase('\n', { addedLineCount: 0 }), 'ci.input.added-lines.budget');
    expectCode(addedCase('é', { addedTextBytes: 1 }), 'ci.input.added-lines.budget');

    const baseOid = 'a'.repeat(40);
    const candidateOid = 'b'.repeat(40);
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const scenario = addedLineShimScenario('safe.txt', oldBytes, newBytes, patch);
    expectCode(() => withGitShim(
      scenario.responses,
      (cwd) => readExactAddedLinesWithinBudget(cwd, {
        baseOid: scenario.baseOid,
        candidateOid: scenario.candidateOid,
        budget: addedLineBudget({ patchBytes: patch.byteLength - 1 }),
      }),
    ), 'ci.input.added-lines.budget');
  });

  it('applies narrowed change and fixed per-item blob bounds before blob materialization', () => {
    const bytes = Buffer.from('candidate');
    const scenario = addedFactsShimScenario([
      { path: 'candidate.txt', bytes },
    ]);
    const { baseOid, candidateOid, responses } = scenario;
    delete responses[responseKey(['cat-file', '-t', '--', blobOid(bytes)])];
    delete responses[responseKey(['cat-file', '-s', '--', blobOid(bytes)])];
    delete responses[responseKey(['cat-file', 'blob', '--', blobOid(bytes)])];
    expectCode(() => withGitShim(responses,
      (cwd) => readExactAddedLinesWithinBudget(cwd, {
        baseOid,
        candidateOid,
        budget: addedLineBudget({ changeCount: 0 }),
      })), 'ci.input.added-lines.budget');

    const oversizedScenario = addedFactsShimScenario([
      { path: 'candidate.txt', bytes },
    ]);
    const oversized = oversizedScenario.responses;
    oversized[responseKey(['cat-file', '-s', '--', blobOid(bytes)])] = {
      stdout: `${MAX_EXACT_SINGLE_BLOB_BYTES + 1}\n`,
    };
    delete oversized[responseKey(['cat-file', 'blob', '--', blobOid(bytes)])];
    expectCode(() => withGitShim(oversized,
      (cwd) => readExactAddedLinesWithinBudget(cwd, {
        baseOid: oversizedScenario.baseOid,
        candidateOid: oversizedScenario.candidateOid,
        budget: addedLineBudget(),
      })), 'ci.input.added-lines.budget');
  });

  it('stops a zero change budget from verified trees and admits one real rename', () => {
    const added = fixture();
    write(added.root, 'one.txt', 'one\n');
    const addedCandidate = commit(added.root, 'one addition');
    expectCode(() => readExactAddedLinesWithinBudget(added.root, {
      baseOid: added.baseOid,
      candidateOid: addedCandidate,
      budget: addedLineBudget({ changeCount: 0 }),
    }), 'ci.input.added-lines.budget');

    const renamedFixture = fixture();
    write(renamedFixture.root, 'old.txt', '');
    const renameBase = commit(renamedFixture.root, 'rename base');
    git(renamedFixture.root, ['mv', 'old.txt', 'new.txt']);
    const renameCandidate = commit(renamedFixture.root, 'rename candidate');
    const renamed = readExactAddedLinesWithinBudget(renamedFixture.root, {
      baseOid: renameBase,
      candidateOid: renameCandidate,
      budget: {
        changeCount: 1,
        sourceBlobBytes: 0,
        sourceLineCount: 0,
        patchBytes: 0,
        addedLineCount: 0,
        addedTextBytes: 0,
      },
    });
    expect(renamed.changes).toMatchObject([
      { status: 'renamed', oldPath: 'old.txt', path: 'new.txt', addedLines: [] },
    ]);
    expect(renamed.accounting.consumed.changeCount).toBe(1);
  });

  it('rejects narrowed aggregate blob bytes from size preflight before any body read', () => {
    const oldBytes = Buffer.from('old source\n');
    const newBytes = Buffer.from('new source\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old source\n+new source\n`,
    );
    const { baseOid, candidateOid, responses } = addedLineShimScenario(
      'source.txt', oldBytes, newBytes, patch,
    );
    delete responses[responseKey(['cat-file', 'blob', '--', oldOid])];
    delete responses[responseKey(['cat-file', 'blob', '--', newOid])];
    expectCode(() => withGitShim(responses,
      (cwd) => readExactAddedLinesWithinBudget(cwd, {
        baseOid,
        candidateOid,
        budget: addedLineBudget({
          sourceBlobBytes: oldBytes.byteLength + newBytes.byteLength - 1,
        }),
      })), 'ci.input.added-lines.budget');
  });

  it('allows deletion and an empty added blob with zero non-change pools', () => {
    const { root, baseOid } = fixture();
    rmSync(join(root, 'README.md'));
    write(root, 'empty.txt', '');
    const candidateOid = commit(root, 'empty and deleted');
    const result = readExactAddedLinesWithinBudget(root, {
      baseOid,
      candidateOid,
      budget: {
        changeCount: 2,
        sourceBlobBytes: 0,
        sourceLineCount: 0,
        patchBytes: 0,
        addedLineCount: 0,
        addedTextBytes: 0,
      },
    });
    expect(result.changes.map(({ path, status, addedLines }) => ({ path, status, addedLines })))
      .toEqual([
        { path: 'README.md', status: 'deleted', addedLines: [] },
        { path: 'empty.txt', status: 'added', addedLines: [] },
      ]);
    expect(result.accounting.consumed).toEqual({
      changeCount: 2,
      sourceBlobBytes: 0,
      sourceLineCount: 0,
      patchBytes: 0,
      addedLineCount: 0,
      addedTextBytes: 0,
    });
  });

  it('charges a shared patch once while charging cached output once per path', () => {
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const { baseOid, candidateOid, responses } = addedLineShimScenario(
      ['first.txt', 'second.txt'], oldBytes, newBytes, patch,
    );
    const result = withGitShim(responses, (cwd) => readExactAddedLinesWithinBudget(cwd, {
      baseOid,
      candidateOid,
      budget: addedLineBudget({
        changeCount: 2,
        sourceBlobBytes: oldBytes.byteLength + newBytes.byteLength,
        sourceLineCount: 2,
        patchBytes: patch.byteLength,
        addedLineCount: 2,
        addedTextBytes: 6,
      }),
    }));
    expect(result.accounting.consumed).toEqual({
      changeCount: 2,
      sourceBlobBytes: oldBytes.byteLength + newBytes.byteLength,
      sourceLineCount: 2,
      patchBytes: patch.byteLength,
      addedLineCount: 2,
      addedTextBytes: 6,
    });
    expect(result.changes.map(({ addedLines }) => addedLines[0]?.path))
      .toEqual(['first.txt', 'second.txt']);
  });

  it('publishes accounting only after terminal reread and does not double-charge physical reads', async () => {
    const oldBytes = Buffer.from('old\n');
    const newBytes = Buffer.from('new\n');
    const oldOid = blobOid(oldBytes);
    const newOid = blobOid(newBytes);
    const patch = Buffer.from(
      `diff --git ${oldOid} ${newOid}\nindex ${oldOid}..${newOid} 100644\n`
      + `--- ${oldOid}\n+++ ${newOid}\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    const { baseOid, candidateOid, responses } = addedLineShimScenario(
      'safe.txt', oldBytes, newBytes, patch,
    );
    const bodyReads = new Map<string, number>();
    const run = (substituteTerminal: boolean) => withMockedGitInput((_file, args) => {
      const key = responseKey(args.slice(1));
      const bodyOid = key === responseKey(['cat-file', 'blob', '--', oldOid])
        ? oldOid
        : key === responseKey(['cat-file', 'blob', '--', newOid]) ? newOid : null;
      if (bodyOid !== null) {
        const count = (bodyReads.get(bodyOid) ?? 0) + 1;
        bodyReads.set(bodyOid, count);
        if (substituteTerminal && bodyOid === newOid && count === 2) return Buffer.from('bad\n');
      }
      const response = responses[key];
      if (response === undefined) throw new Error(`unexpected synthetic command: ${key}`);
      return response.stdoutBase64 === undefined
        ? Buffer.from(response.stdout ?? '', 'utf8')
        : Buffer.from(response.stdoutBase64, 'base64');
    }, (isolated) => isolated.readExactAddedLinesWithinBudget('/isolated-fixture', {
      baseOid,
      candidateOid,
      budget: addedLineBudget(),
    }));

    const success = await run(false);
    expect(bodyReads).toEqual(new Map([[oldOid, 2], [newOid, 2]]));
    expect(success.accounting.consumed.sourceBlobBytes)
      .toBe(oldBytes.byteLength + newBytes.byteLength);

    bodyReads.clear();
    let thrown: unknown;
    try {
      await run(true);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'ci.input.added-lines.identity-mismatch' });
    expect(Object.prototype.hasOwnProperty.call(thrown, 'accounting')).toBe(false);
    expectNoVisibleCause(thrown);
  });

  it('supports manual exact remainder carry between calls and fails one unit over', () => {
    const { root, baseOid } = fixture();
    write(root, 'first.txt', 'a');
    const firstOid = commit(root, 'first edge');
    write(root, 'second.txt', 'b');
    const secondOid = commit(root, 'second edge');
    const initial = addedLineBudget({
      changeCount: 2,
      sourceBlobBytes: 2,
      sourceLineCount: 2,
      patchBytes: 0,
      addedLineCount: 2,
      addedTextBytes: 2,
    });
    const first = readExactAddedLinesWithinBudget(root, {
      baseOid,
      candidateOid: firstOid,
      budget: initial,
    });
    for (const key of Object.keys(initial) as (keyof ExactAddedLineBudgetV1)[]) {
      expect(first.accounting.consumed[key] + first.accounting.remaining[key])
        .toBe(first.accounting.limit[key]);
    }
    const second = readExactAddedLinesWithinBudget(root, {
      baseOid: firstOid,
      candidateOid: secondOid,
      budget: first.accounting.remaining,
    });
    expect(second.accounting.remaining).toEqual({
      changeCount: 0,
      sourceBlobBytes: 0,
      sourceLineCount: 0,
      patchBytes: 0,
      addedLineCount: 0,
      addedTextBytes: 0,
    });
    expectCode(() => readExactAddedLinesWithinBudget(root, {
      baseOid: firstOid,
      candidateOid: secondOid,
      budget: { ...first.accounting.remaining, addedTextBytes: 0 },
    }), 'ci.input.added-lines.budget');
  });

  it('carries positive patch-byte remainder exactly across two modified-file edges', () => {
    const { root } = fixture();
    write(root, 'target.txt', 'zero\n');
    const baseOid = commit(root, 'patch carry base');
    write(root, 'target.txt', 'one\n');
    const firstOid = commit(root, 'patch carry first');
    write(root, 'target.txt', 'two\n');
    const secondOid = commit(root, 'patch carry second');

    const observedFirst = readExactAddedLinesWithinBudget(root, {
      baseOid,
      candidateOid: firstOid,
      budget: addedLineBudget(),
    });
    const observedSecond = readExactAddedLinesWithinBudget(root, {
      baseOid: firstOid,
      candidateOid: secondOid,
      budget: addedLineBudget(),
    });
    expect(observedFirst.accounting.consumed.patchBytes).toBeGreaterThan(0);
    expect(observedSecond.accounting.consumed.patchBytes).toBeGreaterThan(0);

    const total = {} as ExactAddedLineBudgetV1;
    for (const key of Object.keys(MAX_EXACT_ADDED_LINE_BUDGET_V1) as
      (keyof ExactAddedLineBudgetV1)[]) {
      total[key] = observedFirst.accounting.consumed[key]
        + observedSecond.accounting.consumed[key];
      expect(total[key]).toBeLessThanOrEqual(MAX_EXACT_ADDED_LINE_BUDGET_V1[key]);
    }
    const first = readExactAddedLinesWithinBudget(root, {
      baseOid,
      candidateOid: firstOid,
      budget: total,
    });
    expect(first.accounting.remaining.patchBytes).toBeGreaterThan(0);
    for (const key of Object.keys(total) as (keyof ExactAddedLineBudgetV1)[]) {
      expect(first.accounting.consumed[key] + first.accounting.remaining[key])
        .toBe(first.accounting.limit[key]);
    }
    const second = readExactAddedLinesWithinBudget(root, {
      baseOid: firstOid,
      candidateOid: secondOid,
      budget: first.accounting.remaining,
    });
    expect(second.accounting.remaining).toEqual({
      changeCount: 0,
      sourceBlobBytes: 0,
      sourceLineCount: 0,
      patchBytes: 0,
      addedLineCount: 0,
      addedTextBytes: 0,
    });
    expectCode(() => readExactAddedLinesWithinBudget(root, {
      baseOid: firstOid,
      candidateOid: secondOid,
      budget: {
        ...first.accounting.remaining,
        patchBytes: first.accounting.remaining.patchBytes - 1,
      },
    }), 'ci.input.added-lines.budget');
  });

  it('keeps the non-empty legacy runtime result to exactly three keys without accounting', () => {
    const { root, baseOid } = fixture();
    write(root, 'non-empty.txt', 'content\n');
    const candidateOid = commit(root, 'non-empty legacy shape');
    const result = readExactAddedLines(root, { baseOid, candidateOid });
    expect(Object.keys(result).sort()).toEqual(['baseOid', 'candidateOid', 'changes']);
    expect(result.changes).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(result, 'accounting')).toBe(false);
  });
});
