import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import {
  inventorySourceFiles,
  type SourceInventoryFileSystem,
} from '../../scripts/lib/guard-core.ts';
import * as guardCoreModule from '../../scripts/lib/guard-core.ts';
import * as grantGuard from '../../scripts/grant-resolver-inventory-guard.ts';
import * as resolvedGuard from '../../scripts/resolved-override-inventory-guard.ts';
import * as durabilityGuard from '../../scripts/durability-writer-guard.ts';
import {
  evaluateDurabilityWriterInvariant,
  type DurabilityWriterRegistryInput,
  type SchemaSnapshot,
} from '../../scripts/durability-writer-guard.ts';
import { CURATED_TEST_PATHS } from '../../scripts/push-gate.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('source-inventory-');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function nativeFileSystem(
  overrides: Partial<SourceInventoryFileSystem> = {},
): SourceInventoryFileSystem {
  return {
    readdirSync: (directory, boundDirectory = directory) => readdirSync(boundDirectory),
    lstatSync: (entry, boundEntry = entry) => lstatSync(boundEntry),
    readFileSync: (file, _expectedStat, boundFile = file) => readFileSync(boundFile, 'utf8'),
    ...overrides,
  };
}

function codedError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function fixture(): string {
  const root = tmp.make('repo');
  mkdirSync(path.join(root, 'src/nested'), { recursive: true });
  writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'src/nested/b.ts'), 'export const b = 2;\n');
  return root;
}

function scan(
  repoRoot: string,
  fileSystem?: SourceInventoryFileSystem,
  issueLimit?: number,
) {
  return inventorySourceFiles({
    repoRoot,
    roots: ['src'],
    includeFile: (file) => file.endsWith('.ts'),
    excludeDirectory: (directory) => ['.git', 'dist', 'node_modules'].includes(path.basename(directory)),
    fileSystem,
    issueLimit,
  });
}

describe('shared source inventory — fail-closed traversal', () => {
  it('types a lost nested directory instead of silently dropping its subtree', () => {
    const root = fixture();
    const lost = path.join(root, 'src/nested');
    const result = scan(root, nativeFileSystem({
      readdirSync: (directory) => {
        if (directory === lost) throw codedError('EACCES', `private ${root} detail`);
        return readdirSync(directory);
      },
    }));

    expect(result.files.map(({ path: file }) => file)).toEqual(['src/a.ts']);
    expect(result.issues).toEqual([
      {
        code: 'guard.scan.directory-unreadable',
        operation: 'readdir',
        path: 'src/nested',
        systemCode: 'EACCES',
      },
    ]);
    expect(result.counts.issuesTotal).toBe(1);
  });

  it('types an entry inspection failure', () => {
    const root = fixture();
    const unreadable = path.join(root, 'src/a.ts');
    const result = scan(root, nativeFileSystem({
      lstatSync: (entry) => {
        if (entry === unreadable) throw codedError('EIO', 'raw disk detail');
        return lstatSync(entry);
      },
    }));

    expect(result.issues).toContainEqual({
      code: 'guard.scan.entry-unreadable',
      operation: 'lstat',
      path: 'src/a.ts',
      systemCode: 'EIO',
    });
  });

  it('propagates an unexpected programming error as the identical object', () => {
    const root = fixture();
    const programmingError = new RangeError('adapter bug');
    let caught: unknown;

    try {
      scan(root, nativeFileSystem({
        lstatSync: () => {
          throw programmingError;
        },
      }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(programmingError);
  });

  it('restores the caller working directory when an adapter throws after root entry', () => {
    const root = fixture();
    const sourceRoot = path.join(root, 'src');
    const callerCwd = process.cwd();
    const programmingError = new RangeError('adapter bug after root entry');
    let caught: unknown;

    try {
      scan(root, nativeFileSystem({
        readdirSync: (directory) => {
          if (directory === sourceRoot) throw programmingError;
          return readdirSync(directory);
        },
      }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(programmingError);
    expect(process.cwd()).toBe(callerCwd);
  });

  it('does not reclassify a code-bearing selector bug as a filesystem issue', () => {
    const root = fixture();
    const selectorError = Object.assign(new Error('selector bug'), { code: 'SYNTHETIC_SELECTOR' });
    let caught: unknown;

    try {
      inventorySourceFiles({
        repoRoot: root,
        roots: ['src'],
        includeFile: () => {
          throw selectorError;
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(selectorError);
  });

  it('sorts files identically even when enumeration order is permuted', () => {
    const root = fixture();
    writeFileSync(path.join(root, 'src/z.ts'), 'export const z = 3;\n');
    const forward = scan(root, nativeFileSystem({
      readdirSync: (directory) => [...readdirSync(directory)].sort(),
    }));
    const reverse = scan(root, nativeFileSystem({
      readdirSync: (directory) => [...readdirSync(directory)].sort().reverse(),
    }));

    expect(reverse.files).toEqual(forward.files);
    expect(reverse.issues).toEqual(forward.issues);
  });

  it('refuses a symlinked source directory without reading outside the repository', () => {
    const root = fixture();
    const outside = tmp.make('outside');
    writeFileSync(path.join(outside, 'escaped.ts'), 'SECRET_OUTSIDE_CONTENT\n');
    symlinkSync(outside, path.join(root, 'src/linked'), 'dir');
    const reads: string[] = [];
    const result = scan(root, nativeFileSystem({
      readFileSync: (file) => {
        reads.push(file);
        return readFileSync(file, 'utf8');
      },
    }));

    expect(result.issues).toContainEqual({
      code: 'guard.scan.symlink-refused',
      operation: 'lstat',
      path: 'src/linked',
    });
    expect(result.files.map(({ path: file }) => file)).not.toContain('src/linked/escaped.ts');
    expect(reads.every((file) => file.startsWith(`${root}${path.sep}`))).toBe(true);
    expect(reads.some((file) => file.includes('escaped.ts'))).toBe(false);
  });

  it('keeps operational diagnostics bounded and free of raw or absolute details', () => {
    const root = fixture();
    for (const name of ['c.ts', 'd.ts', 'e.ts']) {
      writeFileSync(path.join(root, 'src', name), `export const ${name[0]} = 1;\n`);
    }
    const result = scan(root, nativeFileSystem({
      lstatSync: (entry) => {
        if (/\/[cde]\.ts$/.test(entry)) {
          throw codedError('EACCES', `private ${root} raw detail with stack`);
        }
        return lstatSync(entry);
      },
    }), 2);
    const serialized = JSON.stringify(result);

    expect(result.issues.map(({ path: file }) => file)).toEqual(['src/c.ts', 'src/d.ts']);
    expect(result.counts.issuesTotal).toBe(3);
    expect(result.counts.issuesOmitted).toBe(1);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('raw detail');
    expect(serialized).not.toContain('stack');
  });

  it('omits an invalid adapter error code instead of inventing or publishing one', () => {
    const root = fixture();
    const privateCode = `EACCES:${root}:raw`;
    const result = scan(root, nativeFileSystem({
      lstatSync: (entry) => {
        if (entry === path.join(root, 'src/a.ts')) {
          throw codedError(privateCode, 'private adapter detail');
        }
        return lstatSync(entry);
      },
    }));

    const issue = result.issues.find(({ path: issuePath }) => issuePath === 'src/a.ts');
    expect(issue).toBeDefined();
    expect(issue).not.toHaveProperty('systemCode');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('UNKNOWN');
    expect(serialized).not.toContain(privateCode);
    expect(serialized).not.toContain(root);
  });

  it.each([
    { label: 'empty', value: '' },
    { label: 'lowercase', value: 'eacces' },
    { label: 'non-string', value: 13 },
  ])('classifies an error with an $label code while omitting that code', ({ value }) => {
    const root = fixture();
    const result = scan(root, nativeFileSystem({
      lstatSync: (entry) => {
        if (entry === path.join(root, 'src/a.ts')) {
          throw Object.assign(new Error('private adapter detail'), { code: value });
        }
        return lstatSync(entry);
      },
    }));

    const issue = result.issues.find(({ path: issuePath }) => issuePath === 'src/a.ts');
    expect(issue).toMatchObject({ code: 'guard.scan.entry-unreadable', operation: 'lstat' });
    expect(issue).not.toHaveProperty('systemCode');
  });

  it('accepts a 64-character system code and omits a 65-character code', () => {
    const root = fixture();
    const accepted = `E${'A'.repeat(63)}`;
    const omitted = `E${'A'.repeat(64)}`;
    const result = scan(root, nativeFileSystem({
      lstatSync: (entry) => {
        if (entry === path.join(root, 'src/a.ts')) throw codedError(accepted, 'bounded');
        if (entry === path.join(root, 'src/nested/b.ts')) throw codedError(omitted, 'private');
        return lstatSync(entry);
      },
    }));

    const acceptedIssue = result.issues.find(({ path: issuePath }) => issuePath === 'src/a.ts');
    const omittedIssue = result.issues.find(({ path: issuePath }) => issuePath === 'src/nested/b.ts');
    expect(acceptedIssue).toHaveProperty('systemCode', accepted);
    expect(omittedIssue).not.toHaveProperty('systemCode');
    expect(JSON.stringify(result)).not.toContain(omitted);
  });

  it('returns an inconclusive replacement issue and discards content changed during read', () => {
    const root = fixture();
    const replaced = path.join(root, 'src/a.ts');
    const result = scan(root, nativeFileSystem({
      readFileSync: (file) => {
        const content = readFileSync(file, 'utf8');
        if (file === replaced) {
          writeFileSync(file, 'export const replacement_has_different_size = true;\n');
        }
        return content;
      },
    }));

    expect(result.files.map(({ path: file }) => file)).not.toContain('src/a.ts');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'guard.scan.entry-replaced',
      path: 'src/a.ts',
    }));
  });

  it('discards a scan root replaced during enumeration', () => {
    const root = fixture();
    const sourceRoot = path.join(root, 'src');
    let replaced = false;
    const result = scan(root, nativeFileSystem({
      readdirSync: (directory) => {
        const entries = readdirSync(directory);
        if (directory === sourceRoot && !replaced) {
          replaced = true;
          renameSync(sourceRoot, path.join(root, 'src-before-replacement'));
          mkdirSync(sourceRoot);
          writeFileSync(path.join(sourceRoot, 'a.ts'), 'export const replacement = true;\n');
        }
        return entries;
      },
    }));

    expect(result.files).toEqual([]);
    expect(result.issues).toContainEqual({
      code: 'guard.scan.entry-replaced',
      operation: 'readdir',
      path: 'src',
    });
  });

  it('never retains outside bytes when a parent is swapped to a symlink and restored', () => {
    const root = fixture();
    const sourceRoot = path.join(root, 'src');
    const movedRoot = `${root}-before-swap`;
    const outside = tmp.make('outside-parent-swap');
    mkdirSync(path.join(outside, 'src'), { recursive: true });
    const canary = 'PRIVATE_OUTSIDE_PARENT_SWAP_CANARY';
    writeFileSync(path.join(outside, 'src/outside.ts'), `${canary}\n`);
    let swapped = false;
    let restored = false;

    const result = scan(root, nativeFileSystem({
      readdirSync: (directory, boundDirectory = directory) => {
        if (directory === sourceRoot && !swapped) {
          renameSync(root, movedRoot);
          symlinkSync(outside, root, 'dir');
          swapped = true;
        }
        return readdirSync(boundDirectory);
      },
      lstatSync: (entry) => {
        if (entry === sourceRoot && swapped && !restored) {
          unlinkSync(root);
          renameSync(movedRoot, root);
          restored = true;
        }
        return lstatSync(entry);
      },
    }));

    expect(swapped).toBe(true);
    expect(restored).toBe(true);
    expect(JSON.stringify(result.files)).not.toContain(canary);
  });

  it('stops before a second root when the repository ancestor remains replaced', () => {
    const root = fixture();
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(path.join(root, 'tests/original.test.ts'), 'export const original = true;\n');
    const movedRoot = `${root}-persistent-swap`;
    const outside = tmp.make('outside-second-root');
    mkdirSync(path.join(outside, 'tests'), { recursive: true });
    const canary = 'PRIVATE_SECOND_ROOT_CANARY';
    writeFileSync(path.join(outside, 'tests/escaped.test.ts'), `${canary}\n`);
    const sourceRoot = path.join(root, 'src');
    let swapped = false;
    let result: ReturnType<typeof inventorySourceFiles> | undefined;

    try {
      result = inventorySourceFiles({
        repoRoot: root,
        roots: ['src', 'tests'],
        includeFile: (file) => file.endsWith('.ts'),
        fileSystem: nativeFileSystem({
          readdirSync: (directory, boundDirectory = directory) => {
            if (directory === sourceRoot && !swapped) {
              renameSync(root, movedRoot);
              symlinkSync(outside, root, 'dir');
              swapped = true;
            }
            return readdirSync(boundDirectory);
          },
        }),
      });
    } finally {
      if (swapped) {
        unlinkSync(root);
        renameSync(movedRoot, root);
      }
    }

    expect(swapped).toBe(true);
    expect(result).toBeDefined();
    if (!result) throw new Error('expected inventory result');
    expect(result.files).toEqual([]);
    expect(result.issues).toContainEqual({
      code: 'guard.scan.entry-replaced',
      operation: 'readdir',
      path: 'src',
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('rejects evidence when an ancestor above the repository path remains replaced', () => {
    const holder = tmp.make('repository-holder');
    const root = path.join(holder, 'repo');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'tests'), { recursive: true });
    writeFileSync(path.join(root, 'src/original.ts'), 'export const original = true;\n');
    const movedHolder = `${holder}-persistent-swap`;
    const outside = tmp.make('outside-repository-holder');
    mkdirSync(path.join(outside, 'repo/src'), { recursive: true });
    mkdirSync(path.join(outside, 'repo/tests'), { recursive: true });
    const canary = 'PRIVATE_REPOSITORY_ANCESTOR_CANARY';
    writeFileSync(path.join(outside, 'repo/tests/escaped.test.ts'), `${canary}\n`);
    const sourceRoot = path.join(root, 'src');
    let swapped = false;
    let result: ReturnType<typeof inventorySourceFiles> | undefined;

    try {
      result = inventorySourceFiles({
        repoRoot: root,
        roots: ['src', 'tests'],
        includeFile: (file) => file.endsWith('.ts'),
        fileSystem: nativeFileSystem({
          readdirSync: (directory, boundDirectory = directory) => {
            if (directory === sourceRoot && !swapped) {
              renameSync(holder, movedHolder);
              symlinkSync(outside, holder, 'dir');
              swapped = true;
            }
            return readdirSync(boundDirectory);
          },
        }),
      });
    } finally {
      if (swapped) {
        unlinkSync(holder);
        renameSync(movedHolder, holder);
      }
    }

    expect(swapped).toBe(true);
    expect(result).toBeDefined();
    if (!result) throw new Error('expected inventory result');
    expect(result.files).toEqual([]);
    expect(result.issues).toContainEqual({
      code: 'guard.scan.entry-replaced',
      operation: 'readdir',
      path: 'src',
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('refuses symlinks at both a scan root and a candidate file', () => {
    const outside = tmp.make('outside-roots');
    writeFileSync(path.join(outside, 'outside.ts'), 'export const outside = true;\n');

    const rootLinkRepo = tmp.make('root-link-repo');
    symlinkSync(outside, path.join(rootLinkRepo, 'src'), 'dir');
    const rootLink = scan(rootLinkRepo);
    expect(rootLink.files).toEqual([]);
    expect(rootLink.issues).toContainEqual({
      code: 'guard.scan.symlink-refused',
      operation: 'lstat',
      path: 'src',
    });

    const intermediateLinkRepo = tmp.make('intermediate-root-link-repo');
    mkdirSync(path.join(outside, 'nested'), { recursive: true });
    symlinkSync(outside, path.join(intermediateLinkRepo, 'src'), 'dir');
    const intermediateLink = inventorySourceFiles({
      repoRoot: intermediateLinkRepo,
      roots: ['src/nested'],
      includeFile: (file) => file.endsWith('.ts'),
    });
    expect(intermediateLink.files).toEqual([]);
    expect(intermediateLink.issues).toContainEqual({
      code: 'guard.scan.symlink-refused',
      operation: 'lstat',
      path: 'src/nested',
    });

    const fileLinkRepo = fixture();
    symlinkSync(path.join(outside, 'outside.ts'), path.join(fileLinkRepo, 'src/link.ts'), 'file');
    const fileLink = scan(fileLinkRepo);
    expect(fileLink.files.map(({ path: file }) => file)).not.toContain('src/link.ts');
    expect(fileLink.issues).toContainEqual({
      code: 'guard.scan.symlink-refused',
      operation: 'lstat',
      path: 'src/link.ts',
    });
  });

  it('classifies a candidate read failure without returning partial content', () => {
    const root = fixture();
    const unreadable = path.join(root, 'src/a.ts');
    const result = scan(root, nativeFileSystem({
      readFileSync: (file) => {
        if (file === unreadable) throw codedError('EACCES', 'sensitive read detail');
        return readFileSync(file, 'utf8');
      },
    }));

    expect(result.files.map(({ path: file }) => file)).toEqual(['src/nested/b.ts']);
    expect(result.issues).toContainEqual({
      code: 'guard.scan.entry-unreadable',
      operation: 'read',
      path: 'src/a.ts',
      systemCode: 'EACCES',
    });
  });
});

describe('source guard evaluation seams', () => {
  it('exposes the exact evaluations used by both synchronous CLIs', () => {
    expect(
      (grantGuard as unknown as Record<string, unknown>).evaluateGrantResolverInventoryGuard,
    ).toBeTypeOf('function');
    expect(
      (resolvedGuard as unknown as Record<string, unknown>).evaluateResolvedOverrideInventoryGuard,
    ).toBeTypeOf('function');
  });

  it.each(['readdir', 'lstat', 'read'] as const)(
    'the grant guard exits 2 for an injected %s failure',
    (operation) => {
      const root = fixture();
      const nested = path.join(root, 'src/nested');
      const entry = path.join(root, 'src/a.ts');
      const fs = nativeFileSystem({
        readdirSync: (directory) => {
          if (operation === 'readdir' && directory === nested) throw codedError('EACCES', 'raw');
          return readdirSync(directory);
        },
        lstatSync: (candidate) => {
          if (operation === 'lstat' && candidate === entry) throw codedError('EIO', 'raw');
          return lstatSync(candidate);
        },
        readFileSync: (candidate) => {
          if (operation === 'read' && candidate === entry) throw codedError('EACCES', 'raw');
          return readFileSync(candidate, 'utf8');
        },
      });
      const evaluate = grantGuard.evaluateGrantResolverInventoryGuard as unknown as (
        cwd: string,
        fileSystem: SourceInventoryFileSystem,
      ) => { exitCode: number; scan: { scanIssues: Array<{ operation: string }> } };
      const result = evaluate(root, fs);

      expect(result.exitCode).toBe(2);
      expect(result.scan.scanIssues.some((issue) => issue.operation === operation)).toBe(true);
    },
  );

  it('the resolved guard exits 2 when a nested subtree is lost amid valid files', () => {
    const root = tmp.make('resolved');
    mkdirSync(path.join(root, 'src/nested'), { recursive: true });
    mkdirSync(path.join(root, 'tests/helpers'), { recursive: true });
    mkdirSync(path.join(root, 'tests/mcp'), { recursive: true });
    writeFileSync(path.join(root, 'src/ok.ts'), 'export const ok = 1;\n');
    writeFileSync(path.join(root, 'src/nested/lost.ts'), 'export const lost = 1;\n');
    const knownOverride = [
      'const value = {',
      '  actorJid: undefined,',
      '  purpose: undefined,',
      '  conversationKey: undefined,',
      '  resolved: true,',
      '};',
    ].join('\n');
    for (const entry of resolvedGuard.RESOLVED_OVERRIDE_ALLOWLIST) {
      mkdirSync(path.join(root, path.dirname(entry.file)), { recursive: true });
      writeFileSync(path.join(root, entry.file), knownOverride);
    }
    const lost = path.join(root, 'src/nested');
    const fs = nativeFileSystem({
      readdirSync: (directory) => {
        if (directory === lost) throw codedError('EIO', 'lost subtree');
        return readdirSync(directory);
      },
    });
    const evaluate = resolvedGuard.evaluateResolvedOverrideInventoryGuard as unknown as (
      cwd: string,
      fileSystem: SourceInventoryFileSystem,
    ) => { exitCode: number; scan: { scanIssues: Array<{ code: string; path: string }> } };
    const result = evaluate(root, fs);

    expect(result.exitCode).toBe(2);
    expect(result.scan.scanIssues).toContainEqual(expect.objectContaining({
      code: 'guard.scan.directory-unreadable',
      path: 'src/nested',
    }));
  });

  it.each(['readdir', 'lstat', 'read'] as const)(
    'the durability guard is inconclusive for an injected %s failure even when valid DDL remains',
    (operation) => {
      const root = tmp.make('durability');
      mkdirSync(path.join(root, 'src/nested'), { recursive: true });
      const fault = path.join(root, 'src/fault.ts');
      const nested = path.join(root, 'src/nested');
      writeFileSync(fault, 'export const candidate = 1;\n');
      writeFileSync(
        path.join(root, 'src/valid.ts'),
        "db.exec(`CREATE TABLE synthetic_clean (id INTEGER PRIMARY KEY)`);\n",
      );
      writeFileSync(path.join(nested, 'lost.ts'), 'export const lost = 1;\n');
      const fs = nativeFileSystem({
        readdirSync: (directory) => {
          if (operation === 'readdir' && directory === nested) throw codedError('EACCES', 'raw');
          return readdirSync(directory);
        },
        lstatSync: (candidate) => {
          if (operation === 'lstat' && candidate === fault) throw codedError('EIO', 'raw');
          return lstatSync(candidate);
        },
        readFileSync: (candidate) => {
          if (operation === 'read' && candidate === fault) throw codedError('EACCES', 'raw');
          return readFileSync(candidate, 'utf8');
        },
      });
      const snapshot: SchemaSnapshot = new Map([
        ['synthetic_clean', {
          createSql: 'CREATE TABLE synthetic_clean (id INTEGER PRIMARY KEY)',
          indexes: [],
        }],
      ]);
      const input = {
        registry: [],
        trackedReserved: [],
        trackedUnwiredTerminal: [],
        selfProvisioned: [],
        discoveryExclusions: [],
        knownStatusTables: new Set<string>(),
        nonStatusTables: new Set(['synthetic_clean']),
        reservedTables: new Set<string>(),
        nonStatusJustifications: {},
        sourceInventoryFileSystem: fs,
      } as unknown as DurabilityWriterRegistryInput;
      const outcome = evaluateDurabilityWriterInvariant(snapshot, root, input) as unknown as {
        status: string;
        result?: { scanIssues: Array<{ operation: string }> };
      };

      expect(outcome.status).toBe('inconclusive');
      expect(outcome.result?.scanIssues.some((issue) => issue.operation === operation)).toBe(true);
    },
  );

  it('the durability guard preserves an unexpected inventory programming error by identity', () => {
    const root = fixture();
    const programmingError = new RangeError('adapter bug');
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_clean', {
        createSql: 'CREATE TABLE synthetic_clean (id INTEGER PRIMARY KEY)',
        indexes: [],
      }],
    ]);
    const input = {
      sourceInventoryFileSystem: nativeFileSystem({
        lstatSync: () => {
          throw programmingError;
        },
      }),
    } as DurabilityWriterRegistryInput;
    let caught: unknown;

    try {
      evaluateDurabilityWriterInvariant(snapshot, root, input);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(programmingError);
  });

  it('preserves successful source counters when a zero-table snapshot is inconclusive', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'src/schema.ts'),
      "db.exec(`CREATE TABLE synthetic_clean (id INTEGER PRIMARY KEY)`);\n",
    );
    const outcome = evaluateDurabilityWriterInvariant(new Map(), root, {
      sourceInventoryFileSystem: nativeFileSystem(),
    }) as unknown as {
      status: string;
      result?: {
        discoveredTableCount: number;
        filesExamined: number;
        inventoryCounts: { rootsScanned: number; filesRead: number };
      };
    };

    expect(outcome.status).toBe('inconclusive');
    expect(outcome.result).toBeDefined();
    expect(outcome.result?.discoveredTableCount).toBe(1);
    expect(outcome.result?.filesExamined).toBeGreaterThan(0);
    expect(outcome.result?.inventoryCounts).toMatchObject({
      rootsScanned: 1,
      filesRead: outcome.result?.filesExamined,
    });
  });

  it('preserves successful source counters and a stable cause when zero DDL is discovered', () => {
    const root = fixture();
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_clean', {
        createSql: 'CREATE TABLE synthetic_clean (id INTEGER PRIMARY KEY)',
        indexes: [],
      }],
    ]);
    const outcome = evaluateDurabilityWriterInvariant(snapshot, root, {
      registry: [],
      trackedReserved: [],
      trackedUnwiredTerminal: [],
      selfProvisioned: [],
      discoveryExclusions: [],
      knownStatusTables: new Set(['synthetic_clean']),
      nonStatusTables: new Set<string>(),
      reservedTables: new Set<string>(),
      nonStatusJustifications: {},
      sourceInventoryFileSystem: nativeFileSystem(),
    });

    expect(outcome.status).toBe('inconclusive');
    if (outcome.status !== 'inconclusive') throw new Error('expected inconclusive');
    expect(outcome.reason).toBe('guard.durability.discovery-empty');
    expect(outcome.result?.filesExamined).toBeGreaterThan(0);
    expect(outcome.result?.inventoryCounts.rootsScanned).toBe(1);
    expect(outcome.result?.discoveredTableCount).toBe(0);
  });

  it('rejects a dot-segment writer path instead of reading outside the inventory', () => {
    const root = tmp.make('durability-path-root');
    const outside = tmp.make('durability-path-outside');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'src/schema.ts'),
      "db.exec(`CREATE TABLE synthetic_status (id INTEGER PRIMARY KEY, status TEXT)`);\n",
    );
    writeFileSync(path.join(outside, 'secret.ts'), "export const terminal = 'failed';\n");
    const escape = `src/../${path.relative(root, path.join(outside, 'secret.ts'))}`;
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_status', {
        createSql: 'CREATE TABLE synthetic_status (id INTEGER PRIMARY KEY, status TEXT)',
        indexes: [],
      }],
    ]);

    const outcome = evaluateDurabilityWriterInvariant(snapshot, root, {
      registry: [{
        table: 'synthetic_status',
        statusColumn: 'status',
        vocabulary: ['ok', 'failed'],
        vocabularySource: 'literal',
        terminalFailureValues: ['failed'],
        writerSites: [escape],
      }],
      trackedReserved: [],
      trackedUnwiredTerminal: [],
      selfProvisioned: [],
      discoveryExclusions: [],
      knownStatusTables: new Set(['synthetic_status']),
      nonStatusTables: new Set<string>(),
      reservedTables: new Set<string>(),
      nonStatusJustifications: {},
      sourceInventoryFileSystem: nativeFileSystem(),
    });

    expect(outcome.status).toBe('violation');
    if (outcome.status !== 'violation') throw new Error('expected violation');
    expect(outcome.result.findings).toContainEqual(expect.objectContaining({
      kind: 'writer-site-not-src',
      table: 'synthetic_status',
    }));
    let stderr = '';
    durabilityGuard.emitDurabilityWriterOutcome(outcome, 'human', {
      stdout: { write: () => true },
      stderr: { write: (chunk) => { stderr += chunk; return true; } },
    });
    expect(stderr).not.toContain(escape);
    expect(stderr).not.toContain(outside);
  });

  it('blocks an absolute self-provisioned module without echoing its spelling', () => {
    const root = fixture();
    writeFileSync(
      path.join(root, 'src/schema.ts'),
      'db.exec(`CREATE TABLE synthetic_external (id INTEGER PRIMARY KEY)`);\n',
    );
    const privateModule = '/PRIVATE/ABSOLUTE/PATH_CANARY.ts';
    const outcome = evaluateDurabilityWriterInvariant(new Map([
      ['synthetic_migrated', {
        createSql: 'CREATE TABLE synthetic_migrated (id INTEGER PRIMARY KEY)',
        indexes: [],
      }],
    ]), root, {
      registry: [],
      trackedReserved: [],
      trackedUnwiredTerminal: [],
      selfProvisioned: [{
        table: 'synthetic_external',
        module: privateModule,
        reason: 'synthetic path privacy control',
      }],
      discoveryExclusions: [],
      knownStatusTables: new Set<string>(),
      nonStatusTables: new Set(['synthetic_migrated']),
      reservedTables: new Set<string>(),
      nonStatusJustifications: {},
      sourceInventoryFileSystem: nativeFileSystem(),
    });

    expect(outcome.status).toBe('violation');
    if (outcome.status !== 'violation') throw new Error('expected violation');
    expect(outcome.result.findings).toContainEqual(expect.objectContaining({
      kind: 'self-provisioned-module-not-src',
      table: 'synthetic_external',
    }));
    expect(JSON.stringify(outcome)).not.toContain(privateModule);
    let stderr = '';
    durabilityGuard.emitDurabilityWriterOutcome(outcome, 'human', {
      stdout: { write: () => true },
      stderr: { write: (chunk) => { stderr += chunk; return true; } },
    });
    expect(stderr).not.toContain(privateModule);
  });

  it('binds each self-provisioned declaration to the file that supplied its DDL', () => {
    const root = tmp.make('durability-module-binding');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'src/schema.ts'),
      'db.exec(`CREATE TABLE synthetic_external (id INTEGER PRIMARY KEY)`);\n',
    );
    writeFileSync(path.join(root, 'src/unrelated.ts'), 'export const unrelated = true;\n');

    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_migrated', {
        createSql: 'CREATE TABLE synthetic_migrated (id INTEGER PRIMARY KEY)',
        indexes: [],
      }],
    ]);
    const outcome = evaluateDurabilityWriterInvariant(snapshot, root, {
      registry: [],
      trackedReserved: [],
      trackedUnwiredTerminal: [],
      selfProvisioned: [{
        table: 'synthetic_external',
        module: 'src/unrelated.ts',
        reason: 'synthetic mismatch control',
      }],
      discoveryExclusions: [],
      knownStatusTables: new Set<string>(),
      nonStatusTables: new Set(['synthetic_migrated']),
      reservedTables: new Set<string>(),
      nonStatusJustifications: {},
      sourceInventoryFileSystem: nativeFileSystem(),
    });

    expect(outcome.status).toBe('violation');
    if (outcome.status !== 'violation') throw new Error('expected violation');
    expect(outcome.result.findings).toContainEqual(expect.objectContaining({
      kind: 'self-provisioned-discovery-mismatch',
      table: 'synthetic_external',
    }));
  });

  it('does not include an absolute repository root in a missing-module finding', () => {
    const root = tmp.make('durability-private-root');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'src/schema.ts'),
      'db.exec(`CREATE TABLE synthetic_missing (id INTEGER PRIMARY KEY)`);\n',
    );
    const snapshot: SchemaSnapshot = new Map([
      ['synthetic_migrated', {
        createSql: 'CREATE TABLE synthetic_migrated (id INTEGER PRIMARY KEY)',
        indexes: [],
      }],
    ]);
    const outcome = evaluateDurabilityWriterInvariant(snapshot, root, {
      registry: [],
      trackedReserved: [],
      trackedUnwiredTerminal: [],
      selfProvisioned: [{
        table: 'synthetic_missing',
        module: 'src/missing.ts',
        reason: 'synthetic missing-module control',
      }],
      discoveryExclusions: [],
      knownStatusTables: new Set<string>(),
      nonStatusTables: new Set(['synthetic_migrated']),
      reservedTables: new Set<string>(),
      nonStatusJustifications: {},
      sourceInventoryFileSystem: nativeFileSystem(),
    });

    expect(outcome.status).toBe('violation');
    expect(JSON.stringify(outcome)).not.toContain(root);
  });
});

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runGuard(script: string, args: readonly string[], cwd = REPO_ROOT): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', script, ...args],
    { cwd, encoding: 'utf8', timeout: 180_000 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const GUARDS = [
  {
    tag: 'grant-resolver-inventory-guard',
    script: path.join(REPO_ROOT, 'scripts/grant-resolver-inventory-guard.ts'),
  },
  {
    tag: 'resolved-override-inventory-guard',
    script: path.join(REPO_ROOT, 'scripts/resolved-override-inventory-guard.ts'),
  },
  {
    tag: 'durability-writer-guard',
    script: path.join(REPO_ROOT, 'scripts/durability-writer-guard.ts'),
  },
] as const;

describe('source guard CLI contract', () => {
  it.each(GUARDS)('$tag keeps human, verbose, and JSON status/counts aligned', ({ tag, script }) => {
    const human = runGuard(script, []);
    const verbose = runGuard(script, ['--verbose']);
    const json = runGuard(script, ['--json']);

    expect(human.status, human.stderr || human.stdout).toBe(0);
    expect(verbose.status, verbose.stderr || verbose.stdout).toBe(human.status);
    expect(json.status, json.stderr || json.stdout).toBe(human.status);
    expect(human.stdout).toMatch(new RegExp(`^${tag}:`));
    expect(verbose.stdout).toContain('guard-report: status=pass exitCode=0');
    expect(json.stderr).toBe('');

    const receipt = JSON.parse(json.stdout) as {
      schemaVersion: number;
      guard: string;
      status: string;
      exitCode: number;
      counts: Record<string, number>;
      diagnostics: unknown[];
    };
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      guard: tag,
      status: 'pass',
      exitCode: 0,
      diagnostics: [],
    });
    expect(receipt.counts.filesExamined).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(receipt.counts)) {
      expect(verbose.stdout).toContain(`${key}=${value}`);
    }
  }, 180_000);

  it.each(GUARDS)('$tag rejects an unknown flag with the stable CLI code', ({ script }) => {
    const result = runGuard(script, ['--definitely-not-valid']);

    expect(result.status, result.stderr || result.stdout).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('guard.cli.unknown-option');
    expect(`${result.stdout}${result.stderr}`).not.toContain('--definitely-not-valid');
  }, 180_000);

  it.each([
    {
      expectedExit: 0,
      expectedStatus: 'pass',
      humanFragment: 'no ungated',
      name: 'pass',
      prepare: (root: string) => {
        mkdirSync(path.join(root, 'src'), { recursive: true });
        writeFileSync(path.join(root, 'src/clean.ts'), 'export const clean = true;\n');
      },
    },
    {
      expectedExit: 1,
      expectedStatus: 'block',
      humanFragment: 'ungated grant composition(s) detected',
      name: 'block',
      prepare: (root: string) => {
        mkdirSync(path.join(root, 'src'), { recursive: true });
        writeFileSync(
          path.join(root, 'src/unsafe.ts'),
          'export const unsafe = isAdminPhone(resolvePhoneFromJid(sender));\n',
        );
      },
    },
    {
      expectedExit: 2,
      expectedStatus: 'inconclusive',
      humanFragment: 'INCONCLUSIVE',
      name: 'inconclusive',
      prepare: (_root: string) => {},
    },
  ])('keeps grant-guard $name outcomes aligned across all output modes', ({
    expectedExit,
    expectedStatus,
    humanFragment,
    name: _name,
    prepare,
  }) => {
    const root = tmp.make(`cli-${expectedStatus}`);
    prepare(root);
    const script = path.join(REPO_ROOT, 'scripts/grant-resolver-inventory-guard.ts');
    const human = runGuard(script, [], root);
    const verbose = runGuard(script, ['--verbose'], root);
    const json = runGuard(script, ['--json'], root);

    expect(human.status, human.stderr || human.stdout).toBe(expectedExit);
    expect(verbose.status, verbose.stderr || verbose.stdout).toBe(expectedExit);
    expect(json.status, json.stderr || json.stdout).toBe(expectedExit);
    expect(`${human.stdout}${human.stderr}`).toContain(humanFragment);
    expect(`${verbose.stdout}${verbose.stderr}`).toContain(
      `guard-report: status=${expectedStatus} exitCode=${expectedExit}`,
    );
    expect(json.stderr).toBe('');

    const receipt = JSON.parse(json.stdout) as {
      status: string;
      exitCode: number;
      counts: Record<string, number>;
    };
    expect(receipt).toMatchObject({ status: expectedStatus, exitCode: expectedExit });
    for (const [key, value] of Object.entries(receipt.counts)) {
      expect(`${verbose.stdout}${verbose.stderr}`).toContain(`${key}=${value}`);
    }
  }, 180_000);

  it.each([
    { name: 'block', expectedExit: 1, expectedStatus: 'block' },
    { name: 'inconclusive', expectedExit: 2, expectedStatus: 'inconclusive' },
  ])('keeps resolved-override $name outcomes aligned across all output modes', ({
    name,
    expectedExit,
    expectedStatus,
  }) => {
    const root = tmp.make(`resolved-cli-${name}`);
    if (name === 'block') {
      mkdirSync(path.join(root, 'src'), { recursive: true });
      mkdirSync(path.join(root, 'tests'), { recursive: true });
      const override = [
        'export const context = {',
        '  actorJid: undefined,',
        '  purpose: undefined,',
        '  conversationKey: undefined,',
        '  resolved: true,',
        '};',
      ].join('\n');
      for (const entry of resolvedGuard.RESOLVED_OVERRIDE_ALLOWLIST) {
        mkdirSync(path.join(root, path.dirname(entry.file)), { recursive: true });
        writeFileSync(
          path.join(root, entry.file),
          Array.from({ length: entry.expectedMatches }, () => override).join('\n'),
        );
      }
      writeFileSync(path.join(root, 'src/unsafe.ts'), override);
    }
    const script = path.join(REPO_ROOT, 'scripts/resolved-override-inventory-guard.ts');
    const human = runGuard(script, [], root);
    const verbose = runGuard(script, ['--verbose'], root);
    const json = runGuard(script, ['--json'], root);

    expect(human.status, human.stderr || human.stdout).toBe(expectedExit);
    expect(verbose.status, verbose.stderr || verbose.stdout).toBe(expectedExit);
    expect(json.status, json.stderr || json.stdout).toBe(expectedExit);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain(
      name === 'block' ? 'resolved-override site(s)' : 'INCONCLUSIVE',
    );
    expect(verbose.stdout).toBe('');
    expect(verbose.stderr).toContain(
      name === 'block' ? 'resolved-override site(s)' : 'INCONCLUSIVE',
    );
    expect(`${verbose.stdout}${verbose.stderr}`).toContain(
      `guard-report: status=${expectedStatus} exitCode=${expectedExit}`,
    );
    expect(json.stderr).toBe('');
    const receipt = JSON.parse(json.stdout) as {
      status: string;
      exitCode: number;
      counts: Record<string, number>;
    };
    expect(receipt).toMatchObject({ status: expectedStatus, exitCode: expectedExit });
    for (const [key, value] of Object.entries(receipt.counts)) {
      expect(`${verbose.stdout}${verbose.stderr}`).toContain(`${key}=${value}`);
    }
  }, 180_000);

  it.each([
    {
      name: 'block',
      expectedExit: 1,
      expectedStatus: 'block',
      expectedHuman: 'FAIL',
      source: 'db.exec(`CREATE TABLE synthetic_block (id INTEGER PRIMARY KEY)`);\n',
      table: 'synthetic_block',
      classified: false,
    },
    {
      name: 'inconclusive',
      expectedExit: 2,
      expectedStatus: 'inconclusive',
      expectedHuman: 'INCONCLUSIVE',
      source: 'export const noDdl = true;\n',
      table: 'synthetic_clean',
      classified: true,
    },
  ] as const)('keeps durability $name outcomes aligned across all output modes', ({
    classified,
    expectedExit,
    expectedHuman,
    expectedStatus,
    name,
    source,
    table,
  }) => {
    const root = tmp.make(`durability-cli-${name}`);
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src/schema.ts'), source);
    const snapshot: SchemaSnapshot = new Map([[
      table,
      { createSql: `CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`, indexes: [] },
    ]]);
    const input: DurabilityWriterRegistryInput = {
      registry: [],
      trackedReserved: [],
      trackedUnwiredTerminal: [],
      selfProvisioned: [],
      discoveryExclusions: [],
      knownStatusTables: new Set<string>(),
      nonStatusTables: classified ? new Set([table]) : new Set<string>(),
      reservedTables: new Set<string>(),
      nonStatusJustifications: {},
      sourceInventoryFileSystem: nativeFileSystem(),
    };

    const invoke = (mode: 'human' | 'verbose' | 'json'): CliResult => {
      let stdout = '';
      let stderr = '';
      const args = mode === 'human' ? [] : [`--${mode}`];
      const status = durabilityGuard.runDurabilityWriterGuard(snapshot, root, args, input, {
        stdout: { write: (chunk) => { stdout += chunk; return true; } },
        stderr: { write: (chunk) => { stderr += chunk; return true; } },
      });
      return { status, stdout, stderr };
    };
    const human = invoke('human');
    const verbose = invoke('verbose');
    const json = invoke('json');

    expect(human.status).toBe(expectedExit);
    expect(verbose.status).toBe(expectedExit);
    expect(json.status).toBe(expectedExit);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain(`durability-writer-guard: ${expectedHuman}`);
    expect(verbose.stdout).toBe('');
    expect(verbose.stderr).toContain(`durability-writer-guard: ${expectedHuman}`);
    expect(`${verbose.stdout}${verbose.stderr}`).toContain(
      `guard-report: status=${expectedStatus} exitCode=${expectedExit}`,
    );
    expect(json.stderr).toBe('');
    const receipt = JSON.parse(json.stdout) as {
      status: string;
      exitCode: number;
      counts: Record<string, number>;
      diagnostics: Array<{ code: string }>;
    };
    expect(receipt).toMatchObject({ status: expectedStatus, exitCode: expectedExit });
    if (expectedStatus === 'inconclusive') {
      expect(receipt.diagnostics).toContainEqual({ code: 'guard.durability.discovery-empty' });
    } else {
      expect(receipt.diagnostics).toContainEqual({
        code: 'guard.durability.unclassified-table',
        subject: table,
      });
    }
    expect(receipt.counts.filesExamined).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(receipt.counts)) {
      expect(`${verbose.stdout}${verbose.stderr}`).toContain(`${key}=${value}`);
    }
  });

  it.each([
    { args: [] as const, mode: 'human' },
    { args: ['--json'] as const, mode: 'json' },
  ])(
    'sanitizes an unexpected CLI failure in $mode mode',
    ({ args, mode }) => {
      const boundary = (guardCoreModule as unknown as Record<string, unknown>)
        .runInventoryGuardCliBoundary;
      expect(boundary).toBeTypeOf('function');
      if (typeof boundary !== 'function') return;
      let stdout = '';
      let stderr = '';
      const status = (boundary as (
        guard: string,
        argv: readonly string[],
        action: () => number,
        streams: { stdout: { write(chunk: string): boolean }; stderr: { write(chunk: string): boolean } },
      ) => number)(
        'synthetic-source-guard',
        args,
        () => { throw new Error(`private ${REPO_ROOT} stack`); },
        {
          stdout: { write: (chunk) => { stdout += chunk; return true; } },
          stderr: { write: (chunk) => { stderr += chunk; return true; } },
        },
      );

      expect(status).toBe(2);
      expect(`${stdout}${stderr}`).toContain('guard.internal.unexpected');
      expect(`${stdout}${stderr}`).not.toContain(REPO_ROOT);
      expect(`${stdout}${stderr}`).not.toContain('stack');
      if (mode === 'json') {
        expect(stderr).toBe('');
        expect(JSON.parse(stdout)).toMatchObject({ status: 'inconclusive', exitCode: 2 });
      }
    },
  );
});

interface AdoptionResult { sharedCalls: number; privateWalkers: string[]; privateFsImports: string[] }
function inspectAdoption(file: string, source: string): AdoptionResult {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sharedNames = new Set<string>(), sharedNamespaces = new Set<string>();
  const fsNames = new Map<string, string>();
  const fsNamespaces = new Set<string>(), moduleLoaderNames = new Set<string>();
  const moduleLoaderFactoryNames = new Set<string>(), moduleNamespaces = new Set<string>();
  const processNamespaces = new Set(['process']), commonJsModuleNamespaces = new Set(['module']);
  const hostGlobalNamespaces = new Set(['global', 'globalThis']);
  const reservedLoaderBindings = new Set([...hostGlobalNamespaces, 'module', 'process', 'require']);
  const addName = (names: Set<string>, name: string): boolean => {
    const size = names.size;
    names.add(name);
    return names.size !== size;
  };
  const boundLoaderArguments = new Map<string, readonly ts.Expression[]>();
  const privateWalkers = new Set<string>();
  const privateFsImports = new Set<string>();
  let sharedCalls = 0, fsModuleLoadSeen = false;
  const guardedFsOperations = new Set(['createReadStream', 'glob', 'globSync', 'lstat', 'lstatSync', 'open', 'openSync', 'opendir', 'opendirSync', 'read', 'readFile', 'readFileSync', 'readSync', 'readdir', 'readdirSync', 'stat', 'statSync']);
  const guardedFsOperation = (name: string): string | null => guardedFsOperations.has(name) ? name : null;
  const enumerationOperations = new Set(['glob', 'globSync', 'opendir', 'opendirSync', 'readdir', 'readdirSync']);
  const isFsModuleSpecifier = (value: string): boolean => ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'].includes(value);
  const isModuleModuleSpecifier = (value: string): boolean => ['module', 'node:module'].includes(value);
  const isProcessModuleSpecifier = (value: string): boolean => ['process', 'node:process'].includes(value);
  const unwrapTransparentExpression = (input: ts.Expression): ts.Expression => {
    let expression = input;
    for (;;) {
      if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)
        || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
        || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
        expression = expression.expression;
      } else if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        expression = expression.right;
      } else return expression;
    }
  };
  const accessedProperty = (expression: ts.Expression): { owner: ts.Expression; name: string } | null => {
    const candidate = unwrapTransparentExpression(expression);
    if (ts.isPropertyAccessExpression(candidate)) return { owner: candidate.expression, name: candidate.name.text };
    if (ts.isElementAccessExpression(candidate) && candidate.argumentExpression && ts.isStringLiteralLike(candidate.argumentExpression)) return { owner: candidate.expression, name: candidate.argumentExpression.text };
    return null;
  };
  const isSharedInventoryExpression = (expression: ts.Expression): boolean => {
    const candidate = unwrapTransparentExpression(expression);
    if (ts.isIdentifier(candidate)) return sharedNames.has(candidate.text);
    const accessed = accessedProperty(candidate);
    return accessed !== null && ts.isIdentifier(accessed.owner)
      && sharedNamespaces.has(accessed.owner.text) && accessed.name === 'inventorySourceFiles';
  };
  const isSharedNamespaceExpression = (expression: ts.Expression): boolean => {
    const candidate = unwrapTransparentExpression(expression);
    return ts.isIdentifier(candidate) && sharedNamespaces.has(candidate.text);
  };
  const isFsSpecifierExpression = (expression: ts.Expression): boolean => {
    const candidate = unwrapTransparentExpression(expression);
    return ts.isStringLiteralLike(candidate) && isFsModuleSpecifier(candidate.text);
  };
  type Invocation = { target: ts.Expression; arguments: readonly ts.Expression[]; kind: 'apply' | 'bind' | 'call' | 'direct' };
  const withBoundArguments = (invocation: Invocation): Invocation => {
    const target = unwrapTransparentExpression(invocation.target);
    const bound = ts.isIdentifier(target) ? boundLoaderArguments.get(target.text) : undefined;
    return bound ? { ...invocation, arguments: [...bound, ...invocation.arguments] } : invocation;
  };
  const normalizeInvocation = (call: ts.CallExpression): Invocation | null => {
    const invoked = accessedProperty(call.expression);
    if (invoked === null || !['apply', 'bind', 'call'].includes(invoked.name)) return withBoundArguments({ target: call.expression, arguments: call.arguments, kind: 'direct' });
    if (invoked.name === 'bind' || invoked.name === 'call') {
      return withBoundArguments({ target: invoked.owner, arguments: call.arguments.slice(1), kind: invoked.name });
    }
    if (call.arguments.length < 2) return null;
    const applied = unwrapTransparentExpression(call.arguments[1]);
    return ts.isArrayLiteralExpression(applied)
      ? withBoundArguments({ target: invoked.owner, arguments: applied.elements, kind: 'apply' })
      : null;
  };
  const isNamespace = (expression: ts.Expression, names: Set<string>): boolean => {
    const candidate = unwrapTransparentExpression(expression);
    return ts.isIdentifier(candidate) && names.has(candidate.text);
  };
  const isKnownLoaderProperty = (owner: ts.Expression, name: string): boolean =>
    (name === 'require' && isNamespace(owner, commonJsModuleNamespaces))
    || (name === 'getBuiltinModule' && isProcessNamespaceExpression(owner));
  const isCertainLoaderReference = (expression: ts.Expression): boolean => {
    const candidate = unwrapTransparentExpression(expression);
    if (ts.isIdentifier(candidate)) return moduleLoaderNames.has(candidate.text);
    const accessed = accessedProperty(candidate);
    if (accessed !== null && isKnownLoaderProperty(accessed.owner, accessed.name)) return true;
    if (!ts.isCallExpression(candidate)) return false;
    const binding = accessedProperty(candidate.expression);
    return binding !== null && binding.name === 'bind' && isCertainLoaderReference(binding.owner);
  };
  // Boundary: exact same-file literals only; computed/reflection and inter-file aliases are not inferred.
  const isLoadedNamespaceExpression = (expression: ts.Expression, names: Set<string>, isSpecifier: (value: string) => boolean): boolean => {
    const candidate = unwrapTransparentExpression(expression);
    if (ts.isIdentifier(candidate)) return names.has(candidate.text);
    const accessed = accessedProperty(candidate);
    if (accessed !== null && accessed.name === 'default') return isLoadedNamespaceExpression(accessed.owner, names, isSpecifier);
    if (!ts.isCallExpression(candidate)) return false;
    const invocation = normalizeInvocation(candidate);
    if (invocation === null || invocation.kind === 'bind' || invocation.arguments.length < 1) return false;
    const moduleArgument = unwrapTransparentExpression(invocation.arguments[0]);
    if (!ts.isStringLiteralLike(moduleArgument) || !isSpecifier(moduleArgument.text)) return false;
    const loader = unwrapTransparentExpression(invocation.target);
    return loader.kind === ts.SyntaxKind.ImportKeyword || isCertainLoaderReference(loader);
  };
  const isModuleNamespaceExpression = (expression: ts.Expression): boolean =>
    isLoadedNamespaceExpression(expression, moduleNamespaces, isModuleModuleSpecifier);
  const isProcessNamespaceExpression = (expression: ts.Expression): boolean => {
    const accessed = accessedProperty(expression);
    return (accessed !== null && accessed.name === 'process' && isNamespace(accessed.owner, hostGlobalNamespaces))
      || isLoadedNamespaceExpression(expression, processNamespaces, isProcessModuleSpecifier);
  };
  const isLoaderFactoryExpression = (expression: ts.Expression): boolean => {
    const candidate = unwrapTransparentExpression(expression);
    if (ts.isIdentifier(candidate)) return moduleLoaderFactoryNames.has(candidate.text);
    const accessed = accessedProperty(candidate);
    if (accessed !== null) return accessed.name === 'createRequire' && isModuleNamespaceExpression(accessed.owner);
    if (!ts.isCallExpression(candidate)) return false;
    const invocation = normalizeInvocation(candidate);
    return invocation?.kind === 'bind' && isLoaderFactoryExpression(invocation.target);
  };
  const isCertainModuleLoaderExpression = (expression: ts.Expression): boolean => {
    const candidate = unwrapTransparentExpression(expression);
    if (isCertainLoaderReference(candidate)) return true;
    if (ts.isCallExpression(candidate)) {
      const invocation = normalizeInvocation(candidate);
      if (invocation === null) return false;
      if (invocation.kind !== 'bind' && isLoaderFactoryExpression(invocation.target)) return true;
      return invocation.kind === 'bind' && isCertainModuleLoaderExpression(invocation.target);
    }
    const accessed = accessedProperty(candidate);
    return accessed !== null && isKnownLoaderProperty(accessed.owner, accessed.name);
  };
  const isCertainFsModuleLoadExpression = (expression: ts.Expression): boolean => {
    const candidate = unwrapTransparentExpression(expression);
    if (!ts.isCallExpression(candidate)) return false;
    const invocation = normalizeInvocation(candidate);
    return invocation !== null && invocation.arguments.length > 0 && isFsSpecifierExpression(invocation.arguments[0])
      && (invocation.target.kind === ts.SyntaxKind.ImportKeyword || isCertainModuleLoaderExpression(invocation.target));
  };
  const isFsNamespaceExpression = (expression: ts.Expression): boolean => {
    const candidate = unwrapTransparentExpression(expression);
    if (ts.isIdentifier(candidate)) return fsNamespaces.has(candidate.text);
    if (isCertainFsModuleLoadExpression(candidate)) return true;
    const accessed = accessedProperty(candidate);
    return accessed !== null && ['default', 'promises'].includes(accessed.name) && isFsNamespaceExpression(accessed.owner);
  };
  const fsOperationForExpression = (expression: ts.Expression): string | null => {
    const candidate = unwrapTransparentExpression(expression);
    if (ts.isIdentifier(candidate)) return fsNames.get(candidate.text) ?? null;
    const accessed = accessedProperty(candidate);
    if (accessed !== null && isFsNamespaceExpression(accessed.owner)) return guardedFsOperation(accessed.name);
    return null;
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const importClause = statement.importClause;
    const bindings = importClause?.namedBindings;
    if (statement.moduleSpecifier.text.endsWith('/lib/guard-core.ts')) {
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === 'inventorySourceFiles') sharedNames.add(element.name.text);
      } else if (bindings && ts.isNamespaceImport(bindings)) sharedNamespaces.add(bindings.name.text);
    }
    if (['module', 'node:module'].includes(statement.moduleSpecifier.text)) {
      if (importClause?.name) moduleNamespaces.add(importClause.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === 'createRequire') moduleLoaderFactoryNames.add(element.name.text);
      } else if (bindings && ts.isNamespaceImport(bindings)) moduleNamespaces.add(bindings.name.text);
    }
    if (['process', 'node:process'].includes(statement.moduleSpecifier.text)) {
      if (importClause?.name) processNamespaces.add(importClause.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (imported === 'default') processNamespaces.add(element.name.text);
          if (imported === 'getBuiltinModule') moduleLoaderNames.add(element.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) processNamespaces.add(bindings.name.text);
    }
    if (isFsModuleSpecifier(statement.moduleSpecifier.text)) {
      fsModuleLoadSeen = true;
      if (importClause?.name) fsNamespaces.add(importClause.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = guardedFsOperation((element.propertyName ?? element.name).text);
          if (imported !== null) { fsNames.set(element.name.text, imported); privateFsImports.add(imported); }
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) fsNamespaces.add(bindings.name.text);
    }
  }
  const declarations: ts.VariableDeclaration[] = [];
  const assignments: Array<{ target: ts.Expression; expression: ts.Expression }> = [];
  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    const binding = (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
      || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isEnumDeclaration(node)
      || ts.isImportClause(node) || ts.isImportSpecifier(node) || ts.isNamespaceImport(node)
      || ts.isImportEqualsDeclaration(node)) ? node.name : undefined;
    if (binding && ts.isIdentifier(binding) && reservedLoaderBindings.has(binding.text)) privateFsImports.add('loader-shadow');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      assignments.push({ target: node.left, expression: node.right });
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(sourceFile);
  moduleLoaderNames.add('require');
  type Alias = { name: string; expression: ts.Expression };
  const projectProperty = (expression: ts.Expression, property: ts.PropertyName): ts.Expression | null => {
    if (!ts.isIdentifier(property) && !ts.isStringLiteralLike(property)) return null;
    return ts.factory.createElementAccessExpression(expression, ts.factory.createStringLiteral(property.text));
  };
  const flattenAliases = (name: ts.BindingName, expression: ts.Expression): Alias[] => {
    if (ts.isIdentifier(name)) return [{ name: name.text, expression }];
    if (!ts.isObjectBindingPattern(name)) return [];
    return name.elements.flatMap((element) => {
      if (element.dotDotDotToken) return [];
      const property = element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined);
      const projected = property ? projectProperty(expression, property) : null;
      return projected ? flattenAliases(element.name, projected) : [];
    });
  };
  const flattenAssignmentAliases = (target: ts.Expression, expression: ts.Expression): Alias[] => {
    const candidate = unwrapTransparentExpression(target);
    if (ts.isIdentifier(candidate)) return [{ name: candidate.text, expression }];
    if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return flattenAssignmentAliases(candidate.left, expression);
    }
    if (!ts.isObjectLiteralExpression(candidate)) return [];
    return candidate.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
      const projected = projectProperty(expression, property.name);
      const nested = ts.isPropertyAssignment(property) ? property.initializer : property.name;
      return projected ? flattenAssignmentAliases(nested, projected) : [];
    });
  };
  let changed = true;
  while (changed) {
    changed = false;
    const identifierAliases = [
      ...declarations.flatMap((declaration) => declaration.initializer
        ? flattenAliases(declaration.name, declaration.initializer) : []),
      ...assignments.flatMap((assignment) => flattenAssignmentAliases(assignment.target, assignment.expression)),
    ];
    for (const alias of identifierAliases) {
      const aliasExpression = unwrapTransparentExpression(alias.expression);
      const inheritedBound = ts.isIdentifier(aliasExpression) ? boundLoaderArguments.get(aliasExpression.text) : undefined;
      const invocation = ts.isCallExpression(aliasExpression) ? normalizeInvocation(aliasExpression) : null;
      const newlyBound = invocation?.kind === 'bind' && isCertainModuleLoaderExpression(invocation.target)
        ? invocation.arguments : inheritedBound;
      if (newlyBound && newlyBound.length > 0 && !boundLoaderArguments.has(alias.name)) {
        boundLoaderArguments.set(alias.name, newlyBound); changed = true;
      }
      if (isModuleNamespaceExpression(alias.expression) && addName(moduleNamespaces, alias.name)) changed = true;
      if (isProcessNamespaceExpression(alias.expression) && addName(processNamespaces, alias.name)) changed = true;
      if (isNamespace(alias.expression, commonJsModuleNamespaces) && addName(commonJsModuleNamespaces, alias.name)) changed = true;
      if (isNamespace(alias.expression, hostGlobalNamespaces) && addName(hostGlobalNamespaces, alias.name)) changed = true;
      if (isLoaderFactoryExpression(alias.expression) && addName(moduleLoaderFactoryNames, alias.name)) changed = true;
      if (isCertainModuleLoaderExpression(alias.expression) && addName(moduleLoaderNames, alias.name)) changed = true;
      if (isSharedInventoryExpression(alias.expression) && addName(sharedNames, alias.name)) changed = true;
      const operation = fsOperationForExpression(alias.expression);
      if (operation !== null && fsNames.get(alias.name) !== operation) {
        fsNames.set(alias.name, operation);
        privateFsImports.add(operation);
        changed = true;
      }
      if (isSharedNamespaceExpression(alias.expression) && addName(sharedNamespaces, alias.name)) changed = true;
      if (isFsNamespaceExpression(alias.expression) && addName(fsNamespaces, alias.name)) changed = true;
    }
  }
  const fsCallsWithin = (node: ts.Node): Set<string> => {
    const found = new Set<string>();
    const visitCall = (child: ts.Node): void => {
      if (ts.isCallExpression(child)) {
        const operation = fsOperationForExpression(child.expression);
        if (operation !== null) { found.add(operation); privateFsImports.add(operation); }
      }
      ts.forEachChild(child, visitCall);
    };
    visitCall(node);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isCertainFsModuleLoadExpression(node)) fsModuleLoadSeen = true;
      if (isSharedInventoryExpression(node.expression)) sharedCalls += 1;
      const operation = fsOperationForExpression(node.expression);
      if (operation !== null) privateFsImports.add(operation);
    }
    let functionCandidate: { body: ts.Node; name: string } | null = null;
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      functionCandidate = { body: node.body, name: node.name.text };
    } else if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      functionCandidate = { body: node.initializer.body, name: node.name.text };
    } else if (ts.isMethodDeclaration(node) && node.body) {
      const methodName = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
        ? node.name.text
        : node.name.getText(sourceFile);
      const owner = ts.isClassDeclaration(node.parent) && node.parent.name
        ? node.parent.name.text
        : '(class)';
      functionCandidate = { body: node.body, name: `${owner}.${methodName}` };
    }
    if (functionCandidate !== null) {
      const fsCalls = fsCallsWithin(functionCandidate.body);
      if ([...fsCalls].some((operation) => enumerationOperations.has(operation))) {
        privateWalkers.add(functionCandidate.name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (fsModuleLoadSeen && privateFsImports.size === 0) privateFsImports.add('fs-module-load');
  return { sharedCalls, privateWalkers: [...privateWalkers].sort(), privateFsImports: [...privateFsImports].sort() };
}

describe('shared source inventory AST adoption ratchet', () => {
  it('rejects a planted private recursive walker twin', () => {
    const planted = [
      "import { readdirSync, statSync } from 'node:fs';",
      'function walkTwin(dir: string): void {',
      '  for (const name of readdirSync(dir)) {',
      '    if (statSync(name).isDirectory()) walkTwin(name);',
      '  }',
      '}',
    ].join('\n');

    expect(inspectAdoption('planted.ts', planted)).toMatchObject({
      sharedCalls: 0,
      privateWalkers: ['walkTwin'],
      privateFsImports: ['readdirSync', 'statSync'],
    });
  });

  const expectedSharedRead = (operation = 'readFileSync'): AdoptionResult => ({ sharedCalls: 1, privateWalkers: [], privateFsImports: [operation] });

  it.each([
    {
      label: 'a namespace import of the shared inventory',
      source: [
        "import * as guardCore from './lib/guard-core.ts';",
        "guardCore.inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
      ].join('\n'),
      expected: { sharedCalls: 1, privateWalkers: [], privateFsImports: [] },
    },
    {
      label: 'aliased named filesystem imports',
      source: [
        "import { readdirSync as list, lstatSync as inspect } from 'node:fs';",
        'function walkAlias(dir: string): void {',
        '  for (const name of list(dir)) {',
        '    if (inspect(name).isDirectory()) walkAlias(name);',
        '  }',
        '}',
      ].join('\n'),
      expected: {
        sharedCalls: 0,
        privateWalkers: ['walkAlias'],
        privateFsImports: ['lstatSync', 'readdirSync'],
      },
    },
    {
      label: 'filesystem namespace property access',
      source: [
        "import * as fs from 'node:fs';",
        'function walkNamespace(dir: string): void {',
        '  for (const name of fs.readdirSync(dir)) {',
        '    if (fs.lstatSync(name).isDirectory()) walkNamespace(name);',
        '  }',
        '}',
      ].join('\n'),
      expected: {
        sharedCalls: 0,
        privateWalkers: ['walkNamespace'],
        privateFsImports: ['lstatSync', 'readdirSync'],
      },
    },
    {
      label: 'an arrow walker through namespace aliases and bracket property access',
      source: [
        "import * as nodeFs from 'node:fs';",
        'const fsAlias = nodeFs;',
        "const list = fsAlias['readdirSync'];",
        'const inspect = fsAlias.lstatSync;',
        'const walkArrow = (dir: string): void => {',
        '  for (const name of list(dir)) {',
        '    if (inspect(name).isDirectory()) walkArrow(name);',
        '  }',
        '};',
      ].join('\n'),
      expected: {
        sharedCalls: 0,
        privateWalkers: ['walkArrow'],
        privateFsImports: ['lstatSync', 'readdirSync'],
      },
    },
    {
      label: 'a default node:fs import',
      source: [
        "import fs from 'node:fs';",
        'function walkDefault(dir: string): void {',
        '  for (const name of fs.readdirSync(dir)) {',
        '    if (fs.lstatSync(name).isDirectory()) walkDefault(name);',
        '  }',
        '}',
      ].join('\n'),
      expected: {
        sharedCalls: 0,
        privateWalkers: ['walkDefault'],
        privateFsImports: ['lstatSync', 'readdirSync'],
      },
    },
    {
      label: 'node:fs/promises enumeration inside a class method',
      source: [
        "import fsp from 'node:fs/promises';",
        'class Walker {',
        '  async walk(): Promise<void> {',
        "    await fsp.readdir('.', { withFileTypes: true });",
        "    await fsp.opendir('.');",
        '  }',
        '}',
      ].join('\n'),
      expected: {
        sharedCalls: 0,
        privateWalkers: ['Walker.walk'],
        privateFsImports: ['opendir', 'readdir'],
      },
    },
    {
      label: 'a later assignment alias of an enumeration function',
      source: [
        "import * as fs from 'node:fs';",
        'let list;',
        'list = fs.readdirSync;',
        'function listOnly(dir: string): void {',
        '  list(dir);',
        '}',
      ].join('\n'),
      expected: {
        sharedCalls: 0,
        privateWalkers: ['listOnly'],
        privateFsImports: ['readdirSync'],
      },
    },
    {
      label: 'the promises property on a default node:fs binding',
      source: [
        "import fs from 'node:fs';",
        'const openDirectory = fs.promises.opendir;',
        'const walkPromised = async (): Promise<void> => {',
        "  await openDirectory('.');",
        '};',
      ].join('\n'),
      expected: {
        sharedCalls: 0,
        privateWalkers: ['walkPromised'],
        privateFsImports: ['opendir'],
      },
    },
    {
      label: 'a private read added after a legitimate shared inventory call',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        "import { readFileSync } from 'node:fs';",
        'function scanThenReread(): void {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'a dynamic node:fs import after a legitimate shared inventory call',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        'async function scanThenReread(): Promise<void> {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  const fs = await import('node:fs');",
        "  fs.readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'a CommonJS node:fs load after a legitimate shared inventory call',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        'function scanThenReread(): void {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  const { readFileSync: reread } = require('node:fs');",
        "  reread('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'a template-literal dynamic node:fs import',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        'async function scanThenReread(): Promise<void> {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        '  const fs = await import(`node:fs`);',
        "  fs.readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'a dynamic node:fs import with import attributes',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        'async function scanThenReread(): Promise<void> {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  const fs = await import('node:fs', { with: {} });",
        "  fs.readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'a destructured promises namespace from a CommonJS load',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        "const { promises: fsp } = require('node:fs');",
        'async function scanThenReread(): Promise<void> {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  await fsp.readFile('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead('readFile'),
    },
    {
      label: 'a destructured default namespace from a dynamic import',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        'async function scanThenReread(): Promise<void> {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  const { default: fs } = await import('node:fs');",
        "  fs.readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'an aliased CommonJS loader',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        'const load = require;',
        'function scanThenReread(): void {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  const fs = load('node:fs');",
        "  fs.readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'module.require loading node:fs',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        'function scanThenReread(): void {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  const fs = module.require('node:fs');",
        "  fs.readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'process.getBuiltinModule loading fs',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        'function scanThenReread(): void {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  const fs = process.getBuiltinModule('fs');",
        "  fs.readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'a destructured process builtin loader',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        'const { getBuiltinModule: load } = process;',
        'function scanThenReread(): void {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  const fs = load('node:fs');",
        "  fs.readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'a destructured module CommonJS loader',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        'const { require: load } = module;',
        'function scanThenReread(): void {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  const fs = load('node:fs');",
        "  fs.readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'template-literal element access for a builtin loader and file read',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        'function scanThenReread(): void {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        '  const fs = process[`getBuiltinModule`](`fs`);',
        "  fs[`readFileSync`]('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'an aliased createRequire loader',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        "import { createRequire as makeRequire } from 'node:module';",
        'const load = makeRequire(import.meta.url);',
        'function scanThenReread(): void {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  const fs = load('node:fs');",
        "  fs.readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'an immediate createRequire loader',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        "import { createRequire } from 'node:module';",
        'function scanThenReread(): void {',
        "  inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "  createRequire(import.meta.url)('node:fs').readFileSync('src/private.ts', 'utf8');",
        '}',
      ].join('\n'),
      expected: expectedSharedRead(),
    },
    {
      label: 'Node 24 glob enumeration',
      source: [
        "import fs from 'node:fs';",
        'function globWalker(): void {',
        "  fs.globSync('src/**/*.ts');",
        '}',
      ].join('\n'),
      expected: {
        sharedCalls: 0,
        privateWalkers: ['globWalker'],
        privateFsImports: ['globSync'],
      },
    },
    {
      label: 'a top-level namespace file read',
      source: [
        "import { inventorySourceFiles } from './lib/guard-core.ts';",
        "import * as fs from 'node:fs';",
        "inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true });",
        "fs.readFileSync('src/private.ts', 'utf8');",
      ].join('\n'),
      expected: expectedSharedRead(),
    },
  ])('recognizes $label', ({ source, expected }) => {
    expect(inspectAdoption('planted.ts', source)).toEqual(expected);
  });
  it.each([
    ['a named promises import', "import { inventorySourceFiles } from './lib/guard-core.ts'; import { promises as fsp } from 'node:fs'; inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true }); void fsp.constants;"],
    ['a typed loader result', "import { inventorySourceFiles } from './lib/guard-core.ts'; inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true }); const fs = process.getBuiltinModule('node:fs')! as typeof import('node:fs'); void fs.constants;"],
    ['a nested destructuring load', "import { inventorySourceFiles } from './lib/guard-core.ts'; inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true }); const { promises: { constants } } = require('node:fs'); void constants;"],
    ['a wrapped literal module argument', "import { inventorySourceFiles } from './lib/guard-core.ts'; inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true }); const fs = require(('node:fs' as string)); void fs.constants;"],
    ['an aliased loader with operation-call indirection', "import { inventorySourceFiles } from './lib/guard-core.ts'; inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true }); const load = require; load('node:fs').readFileSync.call(undefined, 'src/private.ts', 'utf8');"],
    ['an aliased loader with an opaque result wrapper', "import { inventorySourceFiles } from './lib/guard-core.ts'; inventorySourceFiles({ repoRoot: '.', roots: ['src'], includeFile: () => true }); const load = require; const fs = load('node:fs').default ?? load('node:fs'); void fs.constants;"],
    ['a loader invoked through call', "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load.call(undefined, 'node:fs').readFileSync('src/private.ts', 'utf8');"],
    ['a loader invoked through apply', "process.getBuiltinModule.apply(process, ['fs']).readFileSync('src/private.ts', 'utf8');"],
    ['a loader bound to an fs specifier', "const load = require.bind(undefined, 'node:fs'); load().readFileSync('src/private.ts', 'utf8');"],
    ['an aliased loader acquiring createRequire', "const get = require; const make = get('node:module').createRequire; const load = make(import.meta.url); const fs = load('node:fs'); void fs.constants;"],
    ['a call-invoked loader acquiring createRequire', "const mod = require.call(undefined, 'node:module'); const load = mod.createRequire(import.meta.url); const fs = load('node:fs'); void fs.constants;"],
    ['an apply-invoked builtin loader acquiring createRequire', "const mod = process.getBuiltinModule.apply(process, ['node:module']); const load = mod.createRequire(import.meta.url); const fs = load('node:fs'); void fs.constants;"],
    ['a call-invoked imported createRequire factory', "import { createRequire as make } from 'node:module'; const load = make.call(undefined, import.meta.url); const fs = load('node:fs'); void fs.constants;"],
    ['a bound CommonJS loader acquiring createRequire', "const getModule = require.bind(undefined, 'node:module'); const mod = getModule(); const load = mod.createRequire(import.meta.url); const fs = load('node:fs'); void fs.constants;"],
    ['a bound builtin loader acquiring createRequire', "const getModule = process.getBuiltinModule.bind(process, 'node:module'); const mod = getModule(); const load = mod.createRequire(import.meta.url); const fs = load('node:fs'); void fs.constants;"],
    ['an aliased process namespace', "const proc = process; const fs = proc.getBuiltinModule('node:fs'); void fs.constants;"],
    ['an aliased CommonJS module namespace', "const mod = module; const fs = mod.require('node:fs'); void fs.constants;"],
    ['a parenthesized process namespace', "const fs = (process).getBuiltinModule('node:fs'); void fs.constants;"],
    ['a default node:process import', "import proc from 'node:process'; const fs = proc.getBuiltinModule('node:fs'); void fs.constants;"],
    ['a namespace node:process import', "import * as proc from 'node:process'; const fs = proc.getBuiltinModule('node:fs'); void fs.constants;"],
    ['a named node:process loader import', "import { getBuiltinModule as get } from 'node:process'; const fs = get('node:fs'); void fs.constants;"],
    ['a CommonJS-loaded node:process namespace', "const proc = require('node:process'); const fs = proc.getBuiltinModule('node:fs'); void fs.constants;"],
    ['a dynamically imported node:process namespace', "const proc = await import('node:process'); const fs = proc.getBuiltinModule('node:fs'); void fs.constants;"],
    ['a destructured loader from node:process', "const { getBuiltinModule: get } = require('node:process'); const fs = get('node:fs'); void fs.constants;"],
    ['the globalThis process namespace', "const fs = globalThis.process.getBuiltinModule('node:fs'); void fs.constants;"],
    ['the global process namespace', "const fs = global.process.getBuiltinModule('node:fs'); void fs.constants;"],
    ['an aliased host-global process namespace', "const host = globalThis; const fs = host.process.getBuiltinModule('node:fs'); void fs.constants;"],
    ['a destructured host-global process namespace', "const { process: proc } = globalThis; const fs = proc.getBuiltinModule('node:fs'); void fs.constants;"],
    ['a comma-wrapped CommonJS loader', "const fs = (0, require)('node:fs'); void fs.constants;"],
    ['a comma-wrapped process namespace', "const fs = (0, process).getBuiltinModule('node:fs'); void fs.constants;"],
    ['a comma-wrapped createRequire factory', "import { createRequire } from 'node:module'; const load = (0, createRequire)(import.meta.url); const fs = load('node:fs'); void fs.constants;"],
    ['a dynamic node:module default projection', "const mod = (await import('node:module')).default; const load = mod.createRequire(import.meta.url); const fs = load('node:fs'); void fs.constants;"],
    ['a dynamic node:process default projection', "const proc = (await import('node:process')).default; const fs = proc.getBuiltinModule('node:fs'); void fs.constants;"],
    ['a nested host-global loader destructure', "const { process: { getBuiltinModule: get } } = globalThis; const fs = get('node:fs'); void fs.constants;"],
    ['a destructuring assignment of a process loader', "let get; ({ getBuiltinModule: get } = process); const fs = get('node:fs'); void fs.constants;"],
  ])('blocks %s even when operation tracing is opaque', (_label, source) => {
    expect(inspectAdoption('planted.ts', source).privateFsImports).not.toEqual([]);
  });
  it('does not classify ordinary fs-shaped strings as Node loaders', () => {
    const source = "const labels = new Set<string>(); console.log('fs'); labels.add('node:fs');";
    expect(inspectAdoption('planted.ts', source).privateFsImports).toEqual([]);
  });

  it.each([
    ['a locally declared require', "function require(name: string) { return { constants: name }; } void require('node:fs').constants;"],
    ['a nested require parameter', "function nested(require: unknown) { void require; } const fs = require('node:fs'); void fs.constants;"],
    ['a locally declared process', "const process = { getBuiltinModule: () => ({ constants: 1 }) }; void process.getBuiltinModule('node:fs').constants;"],
    ['a locally declared module', "const module = { require: () => ({ constants: 1 }) }; void module.require('node:fs').constants;"],
  ])('blocks ambiguous loader shadowing by %s', (_label, source) => {
    expect(inspectAdoption('planted.ts', source).privateFsImports).toContain('loader-shadow');
  });

  it.each(GUARDS)('$tag uses the shared primitive and owns no private walker', ({ script }) => {
    const source = readFileSync(script, 'utf8');
    const adoption = inspectAdoption(script, source);

    expect(adoption.sharedCalls).toBeGreaterThan(0);
    expect(adoption.privateWalkers).toEqual([]);
    expect(adoption.privateFsImports).toEqual([]);
  });

  it('is wired into the curated branch gate so adoption cannot silently regress', () => {
    expect(CURATED_TEST_PATHS).toContain('tests/scripts/source-inventory-enforcement.test.ts');
  });
});
