import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
      systemCode: null,
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

  it('replaces an unbounded adapter error code instead of publishing it', () => {
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

    expect(result.issues).toContainEqual(expect.objectContaining({
      path: 'src/a.ts',
      systemCode: 'UNKNOWN',
    }));
    expect(JSON.stringify(result)).not.toContain(privateCode);
    expect(JSON.stringify(result)).not.toContain(root);
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
});

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runGuard(script: string, args: readonly string[]): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', script, ...args],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000 },
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
});

interface AdoptionResult {
  sharedCalls: number;
  privateWalkers: string[];
  privateFsImports: string[];
}

function inspectAdoption(file: string, source: string): AdoptionResult {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sharedNames = new Set<string>();
  const privateWalkers: string[] = [];
  const privateFsImports: string[] = [];
  let sharedCalls = 0;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    if (statement.moduleSpecifier.text.endsWith('/lib/guard-core.ts')) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'inventorySourceFiles') {
          sharedNames.add(element.name.text);
        }
      }
    }
    if (statement.moduleSpecifier.text === 'node:fs') {
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (['readdirSync', 'lstatSync', 'statSync'].includes(imported)) {
          privateFsImports.push(imported);
        }
      }
    }
  }

  const calls = (node: ts.Node, names: Set<string>): Set<string> => {
    const found = new Set<string>();
    const visit = (child: ts.Node): void => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && names.has(child.expression.text)) {
        found.add(child.expression.text);
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && sharedNames.has(node.expression.text)) {
      sharedCalls += 1;
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const fsCalls = calls(node.body, new Set(['readdirSync', 'lstatSync', 'statSync']));
      if (fsCalls.has('readdirSync') && (fsCalls.has('lstatSync') || fsCalls.has('statSync'))) {
        privateWalkers.push(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { sharedCalls, privateWalkers, privateFsImports };
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
