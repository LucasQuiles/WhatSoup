import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
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
import * as grantGuard from '../../scripts/grant-resolver-inventory-guard.ts';
import * as resolvedGuard from '../../scripts/resolved-override-inventory-guard.ts';
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
    readdirSync: (directory) => readdirSync(directory),
    lstatSync: (entry) => lstatSync(entry),
    readFileSync: (file) => readFileSync(file, 'utf8'),
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
});

interface AdoptionResult {
  sharedCalls: number;
  privateWalkers: string[];
  privateFsImports: string[];
}

function inspectAdoption(file: string, source: string): AdoptionResult {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sharedNames = new Set<string>();
  const sharedNamespaces = new Set<string>();
  const fsNames = new Map<string, string>();
  const fsNamespaces = new Set<string>();
  const privateWalkers: string[] = [];
  const privateFsImports = new Set<string>();
  let sharedCalls = 0;

  const guardedFsOperation = (name: string): string | null =>
    ['readdirSync', 'lstatSync', 'statSync'].includes(name) ? name : null;

  const accessedProperty = (expression: ts.Expression): { owner: ts.Expression; name: string } | null => {
    if (ts.isPropertyAccessExpression(expression)) {
      return { owner: expression.expression, name: expression.name.text };
    }
    if (
      ts.isElementAccessExpression(expression)
      && expression.argumentExpression
      && ts.isStringLiteral(expression.argumentExpression)
    ) {
      return { owner: expression.expression, name: expression.argumentExpression.text };
    }
    return null;
  };

  const isSharedInventoryExpression = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) return sharedNames.has(expression.text);
    const accessed = accessedProperty(expression);
    return accessed !== null
      && ts.isIdentifier(accessed.owner)
      && sharedNamespaces.has(accessed.owner.text)
      && accessed.name === 'inventorySourceFiles';
  };

  const fsOperationForExpression = (expression: ts.Expression): string | null => {
    if (ts.isIdentifier(expression)) return fsNames.get(expression.text) ?? null;
    const accessed = accessedProperty(expression);
    if (
      accessed !== null
      && ts.isIdentifier(accessed.owner)
      && fsNamespaces.has(accessed.owner.text)
    ) {
      return guardedFsOperation(accessed.name);
    }
    return null;
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (statement.moduleSpecifier.text.endsWith('/lib/guard-core.ts')) {
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === 'inventorySourceFiles') {
            sharedNames.add(element.name.text);
          }
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        sharedNamespaces.add(bindings.name.text);
      }
    }
    if (statement.moduleSpecifier.text === 'node:fs') {
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = guardedFsOperation((element.propertyName ?? element.name).text);
          if (imported !== null) {
            fsNames.set(element.name.text, imported);
            privateFsImports.add(imported);
          }
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        fsNamespaces.add(bindings.name.text);
      }
    }
  }

  const declarations: ts.VariableDeclaration[] = [];
  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const initializer = declaration.initializer;
      if (!initializer) continue;
      if (ts.isIdentifier(declaration.name)) {
        const local = declaration.name.text;
        if (isSharedInventoryExpression(initializer) && !sharedNames.has(local)) {
          sharedNames.add(local);
          changed = true;
        }
        const operation = fsOperationForExpression(initializer);
        if (operation !== null && fsNames.get(local) !== operation) {
          fsNames.set(local, operation);
          privateFsImports.add(operation);
          changed = true;
        }
        if (ts.isIdentifier(initializer) && sharedNamespaces.has(initializer.text) && !sharedNamespaces.has(local)) {
          sharedNamespaces.add(local);
          changed = true;
        }
        if (ts.isIdentifier(initializer) && fsNamespaces.has(initializer.text) && !fsNamespaces.has(local)) {
          fsNamespaces.add(local);
          changed = true;
        }
      } else if (ts.isObjectBindingPattern(declaration.name) && ts.isIdentifier(initializer)) {
        for (const element of declaration.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const imported = (element.propertyName ?? element.name).getText(sourceFile);
          if (
            sharedNamespaces.has(initializer.text)
            && imported === 'inventorySourceFiles'
            && !sharedNames.has(element.name.text)
          ) {
            sharedNames.add(element.name.text);
            changed = true;
          }
          if (fsNamespaces.has(initializer.text)) {
            const operation = guardedFsOperation(imported);
            if (operation !== null && fsNames.get(element.name.text) !== operation) {
              fsNames.set(element.name.text, operation);
              privateFsImports.add(operation);
              changed = true;
            }
          }
        }
      }
    }
  }

  const fsCallsWithin = (node: ts.Node): Set<string> => {
    const found = new Set<string>();
    const visitCall = (child: ts.Node): void => {
      if (ts.isCallExpression(child)) {
        const operation = fsOperationForExpression(child.expression);
        if (operation !== null) {
          found.add(operation);
          privateFsImports.add(operation);
        }
      }
      ts.forEachChild(child, visitCall);
    };
    visitCall(node);
    return found;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isSharedInventoryExpression(node.expression)) {
      sharedCalls += 1;
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
    }
    if (functionCandidate !== null) {
      const fsCalls = fsCallsWithin(functionCandidate.body);
      if (fsCalls.has('readdirSync') && (fsCalls.has('lstatSync') || fsCalls.has('statSync'))) {
        privateWalkers.push(functionCandidate.name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    sharedCalls,
    privateWalkers: [...privateWalkers].sort(),
    privateFsImports: [...privateFsImports].sort(),
  };
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
  ])('recognizes $label', ({ source, expected }) => {
    expect(inspectAdoption('planted.ts', source)).toEqual(expected);
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
