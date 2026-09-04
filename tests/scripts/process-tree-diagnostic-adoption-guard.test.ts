import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  scanProcessTreeDiagnosticAdoptionRepo,
  scanProcessTreeDiagnosticAdoptionSource,
} from '../../scripts/process-tree-diagnostic-adoption-guard.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts/process-tree-diagnostic-adoption-guard.ts');
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe('process-tree diagnostic adoption source scan', () => {
  it('rejects a production caller without captured root authority', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/missing-root-authority.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "void killSessionTree(42, 'SIGTERM', { generationMarker: 'g', diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    );

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_ROOT_AUTHORITY_MISSING',
      line: 2,
    }));
  });

  it('rejects hand-written inline root authority at a production call site', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/inline-root-authority.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "void killSessionTree(42, 'SIGTERM', { generationMarker: 'g', rootAuthority: { pid: 42, parentPid: 1, birthToken: 'guessed' }, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    );

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_ROOT_AUTHORITY_INVALID',
      line: 2,
    }));
  });

  it('detects missing diagnostics through a named import alias', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/alias.ts',
      [
        "import { killSessionTree as reap } from './runtimes/agent/process-tree.ts';",
        "void reap(42, 'SIGTERM', { generationMarker: 'g', rootAuthority, onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    );

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING', line: 2 }),
    ]);
  });

  it('rejects a source-tagged caller that omits either required observer', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/source-only.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "void killSessionTree(42, 'SIGTERM', { generationMarker: 'g', rootAuthority, diagnosticSource: 'session_shutdown' });",
      ].join('\n'),
    );

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PROCESS_TREE_OUTCOME_OBSERVER_MISSING', line: 2 }),
      expect.objectContaining({ kind: 'PROCESS_TREE_DIVERGENCE_OBSERVER_MISSING', line: 2 }),
    ]));
  });

  it('rejects observer properties whose values are not inline callables', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/non-callable-observers.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "void killSessionTree(42, 'SIGTERM', { generationMarker: 'g', rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: undefined, onCgroupDivergence: false });",
      ].join('\n'),
    );

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PROCESS_TREE_OUTCOME_OBSERVER_INVALID', line: 2 }),
      expect.objectContaining({ kind: 'PROCESS_TREE_DIVERGENCE_OBSERVER_INVALID', line: 2 }),
    ]));
  });

  it('detects an invalid source through a namespace import', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/namespace.ts',
      [
        "import * as tree from './runtimes/agent/process-tree.ts';",
        "void tree.killSessionTree(42, 'SIGTERM', { generationMarker: 'g', rootAuthority, diagnosticSource: 'invented', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    );

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_INVALID', line: 2 }),
    ]);
  });

  it.each([
    {
      name: 'named binding alias',
      source: [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        'const reap = killSessionTree;',
        "void reap(42, 'SIGTERM', { generationMarker: 'g', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    },
    {
      name: 'namespace property alias',
      source: [
        "import * as tree from './runtimes/agent/process-tree.ts';",
        'const reap = tree.killSessionTree;',
        "void reap(42, 'SIGTERM', { generationMarker: 'g', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    },
    {
      name: 'namespace destructuring alias',
      source: [
        "import * as tree from './runtimes/agent/process-tree.ts';",
        'const { killSessionTree: reap } = tree;',
        "void reap(42, 'SIGTERM', { generationMarker: 'g', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    },
  ])('detects missing diagnostics through a $name', ({ source }) => {
    const result = scanProcessTreeDiagnosticAdoptionSource('src/alias-chain.ts', source);
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
    }));
  });

  it.each([
    {
      name: 'bound function escape',
      source: [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        'const reap = killSessionTree.bind(null);',
        "void reap(42, 'SIGTERM', { generationMarker: 'g' });",
      ].join('\n'),
    },
    {
      name: 'object-holder destructuring escape',
      source: [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        'const holder = { reap: killSessionTree };',
        'const { reap: terminate } = holder;',
        "void terminate(42, 'SIGTERM', { generationMarker: 'g' });",
      ].join('\n'),
    },
    {
      name: 'computed object assignment escape',
      source: [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        'const holder: Record<string, unknown> = {};',
        "holder['reap'] = killSessionTree;",
        "void holder['reap'](42, 'SIGTERM', { generationMarker: 'g' });",
      ].join('\n'),
    },
    {
      name: 'Function.call escape',
      source: [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "void killSessionTree.call(null, 42, 'SIGTERM', { generationMarker: 'g' });",
      ].join('\n'),
    },
    {
      name: 'Function.apply escape',
      source: [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "void killSessionTree.apply(null, [42, 'SIGTERM', { generationMarker: 'g' }]);",
      ].join('\n'),
    },
  ])('detects missing diagnostics through a $name', ({ source }) => {
    const result = scanProcessTreeDiagnosticAdoptionSource('src/review-bypass.ts', source);
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
    }));
  });

  it.each([
    {
      name: 'Function.call invocation',
      invocation: "killSessionTree.call(null, 42, 'SIGTERM', { rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} })",
    },
    {
      name: 'Function.apply invocation',
      invocation: "killSessionTree.apply(null, [42, 'SIGTERM', { rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} }])",
    },
  ])('accepts a fully adopted $name', ({ invocation }) => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/reviewed-invocation.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        `void ${invocation};`,
      ].join('\n'),
    );
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('fails closed when Function.apply arguments cannot be resolved statically', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/dynamic-apply.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "const args = [42, 'SIGTERM', { rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} }] as const;",
        'void killSessionTree.apply(null, args);',
      ].join('\n'),
    );
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_OPTIONS_UNRESOLVED',
    }));
  });

  it.each([
    {
      name: 'partially bound invocation',
      declarations: [
        'const reap = killSessionTree.bind(null, 42);',
        "void reap('SIGTERM', { generationMarker: 'hidden' }, { rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ],
    },
    {
      name: 'spread-shifted Function.apply invocation',
      declarations: [
        "const hidden = ['SIGTERM', { generationMarker: 'hidden' }] as const;",
        "void killSessionTree.apply(null, [42, ...hidden, { rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} }]);",
      ],
    },
    {
      name: 'partially bound object-property invocation',
      declarations: [
        'const holder = { reap: killSessionTree.bind(null, 42) };',
        "void holder.reap('SIGTERM', { generationMarker: 'hidden' }, { rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ],
    },
  ])('fails closed for a $name', ({ declarations }) => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/shifted-invocation.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        ...declarations,
      ].join('\n'),
    );
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_OPTIONS_UNRESOLVED',
    }));
  });

  it.each([
    {
      name: 'spread-shifted direct invocation',
      declarations: [
        "const hidden = ['SIGTERM', { generationMarker: 'hidden' }] as const;",
        "void (killSessionTree as any)(42, ...hidden, { rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ],
    },
    {
      name: 'spread-shifted Function.call invocation',
      declarations: [
        "const hidden = ['SIGTERM', { generationMarker: 'hidden' }] as const;",
        "void (killSessionTree as any).call(null, 42, ...hidden, { rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ],
    },
    {
      name: 'spread-shifted Function.bind invocation',
      declarations: [
        'const hidden = [null, 42] as const;',
        'const reap = (killSessionTree as any).bind(...hidden);',
        "void reap('SIGTERM', { generationMarker: 'hidden' }, { rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ],
    },
  ])('fails closed for a $name', ({ declarations }) => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/spread-shifted-invocation.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        ...declarations,
      ].join('\n'),
    );
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_OPTIONS_UNRESOLVED',
    }));
  });

  it.each([
    {
      name: 'Reflect.apply escape',
      declarations: [
        "void Reflect.apply(killSessionTree, null, [42, 'SIGTERM', { generationMarker: 'hidden' }]);",
      ],
    },
    {
      name: 'array value escape',
      declarations: [
        'const holder = [killSessionTree];',
        "void holder[0]!(42, 'SIGTERM', { generationMarker: 'hidden' });",
      ],
    },
    {
      name: 'prototype-mediated call escape',
      declarations: [
        "void Function.prototype.call.call(killSessionTree, null, 42, 'SIGTERM', { generationMarker: 'hidden' });",
      ],
    },
    {
      name: 'computed assignment escape',
      declarations: [
        "const key = 'reap';",
        'const holder: Record<string, unknown> = {};',
        'holder[key] = killSessionTree;',
        "void (holder[key] as any)(42, 'SIGTERM', { generationMarker: 'hidden' });",
      ],
    },
  ])('rejects a canonical function $name', ({ declarations }) => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/canonical-reference-escape.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        ...declarations,
      ].join('\n'),
    );
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
    }));
  });

  it.each([
    {
      name: 'computed read from a tracked object',
      declarations: [
        'const holder = { reap: killSessionTree };',
        "const key: string = 'reap';",
        "void (holder[key] as any)(42, 'SIGTERM', { generationMarker: 'hidden' });",
      ],
    },
    {
      name: 'destructuring assignment from a tracked object',
      declarations: [
        'const holder = { reap: killSessionTree };',
        'let terminate: typeof killSessionTree;',
        '({ reap: terminate } = holder);',
        "void terminate(42, 'SIGTERM', { generationMarker: 'hidden' });",
      ],
    },
    {
      name: 'unknown call receiving a tracked object',
      declarations: [
        'const holder = { reap: killSessionTree };',
        'declare function consume(value: unknown): void;',
        'consume(holder);',
      ],
    },
  ])('rejects a canonical container $name', ({ declarations }) => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/canonical-container-escape.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        ...declarations,
      ].join('\n'),
    );
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
    }));
  });

  it.each([
    'export default killSessionTree;',
    'const reap = killSessionTree; export { reap };',
    'export const reap = killSessionTree;',
    'export const holder = { reap: killSessionTree };',
  ])('rejects an unresolved canonical export: %s', (declaration) => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/canonical-export-escape.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        declaration,
      ].join('\n'),
    );
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
    }));
  });

  it.each([
    [
      'parameter',
      'function invokeLocal(killSessionTree: () => void): void {',
      '  killSessionTree();',
      '}',
    ],
    [
      'block-local declaration',
      'function invokeLocal(): void {',
      '  const killSessionTree = (): void => {};',
      '  killSessionTree();',
      '}',
    ],
  ])('does not mistake a nested %s shadow for the imported canonical function', (
    _name,
    ...declarations
  ) => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/shadowed-import.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        ...declarations,
      ].join('\n'),
    );
    expect(result).toEqual({ callsExamined: 0, findings: [], callSites: [] });
  });

  it.each([
    {
      name: 'later direct assignment',
      source: [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        'let reap: typeof killSessionTree;',
        'reap = killSessionTree;',
        "void reap(42, 'SIGTERM', { generationMarker: 'g', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    },
    {
      name: 'dynamic namespace import',
      source: [
        "const tree = await import('./runtimes/agent/process-tree.ts');",
        "void tree.killSessionTree(42, 'SIGTERM', { generationMarker: 'g', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    },
    {
      name: 'object property escape',
      source: [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        'const holder = { reap: killSessionTree };',
        "void holder.reap(42, 'SIGTERM', { generationMarker: 'g', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    },
  ])('detects missing diagnostics through a $name', ({ source }) => {
    const result = scanProcessTreeDiagnosticAdoptionSource('src/escaped-alias.ts', source);
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
    }));
  });

  it('rejects async observers that can reject after the guarded call returns', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/async-observers.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "void killSessionTree(42, 'SIGTERM', { generationMarker: 'g', rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: async () => {}, onCgroupDivergence: async function () {} });",
      ].join('\n'),
    );

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PROCESS_TREE_OUTCOME_OBSERVER_INVALID' }),
      expect.objectContaining({ kind: 'PROCESS_TREE_DIVERGENCE_OBSERVER_INVALID' }),
    ]));
  });

  it('rejects a later object spread that can override reviewed options', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/spread-override.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "const override = { diagnosticSource: 'invented' };",
        "void killSessionTree(42, 'SIGTERM', { generationMarker: 'g', rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {}, ...override });",
      ].join('\n'),
    );
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_OPTIONS_UNRESOLVED',
    }));
  });

  it('accepts a spread only when every required property is fixed afterward', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/spread-before.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        'const defaults = { generationMarker: \'g\' };',
        "void killSessionTree(42, 'SIGTERM', { ...defaults, rootAuthority, diagnosticSource: 'session_shutdown', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    );
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('does not mistake an unrelated local function for the canonical declaration', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/unrelated.ts',
      "function killSessionTree() {}\nkillSessionTree();",
    );
    expect(result).toEqual({ callsExamined: 0, findings: [], callSites: [] });
  });

  it('does not mistake an unrelated module with the same basename for the canonical module', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/caller.ts',
      [
        "import { killSessionTree } from './support/process-tree.ts';",
        "void killSessionTree(42, 'SIGTERM', {});",
      ].join('\n'),
    );
    expect(result).toEqual({ callsExamined: 0, findings: [], callSites: [] });
  });
});

describe('process-tree diagnostic adoption live-tree ratchet', () => {
  it('keeps the guard on Node, TypeScript, and script-layer dependencies only', () => {
    const guardText = readFileSync(GUARD, 'utf8');
    const imports = [...guardText.matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((match) => match[1]);
    expect(imports.every((specifier) =>
      specifier.startsWith('node:')
      || specifier === 'typescript'
      || specifier.startsWith('./lib/'),
    )).toBe(true);
    expect(guardText).not.toMatch(/from\s+['"]\.\.\/src\//);

    const contractText = readFileSync(
      path.join(REPO_ROOT, 'src', 'runtimes', 'agent', 'process-tree-contract.ts'),
      'utf8',
    );
    expect(contractText).not.toMatch(/^\s*import\s/m);
  });

  it('follows a renamed re-export through a local barrel', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-barrel-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'src', 'runtimes', 'agent'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'runtimes', 'agent', 'process-tree.ts'),
      'export function killSessionTree() {}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'barrel.ts'),
      "export { killSessionTree as reap } from './runtimes/agent/process-tree.ts';\n",
    );
    writeFileSync(
      path.join(root, 'src', 'caller.ts'),
      [
        "import { reap } from './barrel.ts';",
        "void reap(42, 'SIGTERM', { generationMarker: 'g', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    );

    const result = scanProcessTreeDiagnosticAdoptionRepo(root);
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
      file: 'src/caller.ts',
    }));
  });

  it('follows an export-star barrel through a namespace import', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-star-barrel-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'src', 'runtimes', 'agent'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'runtimes', 'agent', 'process-tree.ts'),
      'export function killSessionTree() {}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'barrel.ts'),
      "export * from './runtimes/agent/process-tree.ts';\n",
    );
    writeFileSync(
      path.join(root, 'src', 'caller.ts'),
      [
        "import * as tree from './barrel.ts';",
        "void tree.killSessionTree(42, 'SIGTERM', { generationMarker: 'g', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    );

    const result = scanProcessTreeDiagnosticAdoptionRepo(root);
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
      file: 'src/caller.ts',
    }));
  });

  it('blocks a namespace barrel shape the resolver cannot preserve safely', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-namespace-barrel-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'src', 'runtimes', 'agent'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'runtimes', 'agent', 'process-tree.ts'),
      'export function killSessionTree() {}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'barrel.ts'),
      "export * as tree from './runtimes/agent/process-tree.ts';\n",
    );
    writeFileSync(
      path.join(root, 'src', 'caller.ts'),
      [
        "import { tree } from './barrel.ts';",
        "void tree.killSessionTree(42, 'SIGTERM', { generationMarker: 'hidden' });",
      ].join('\n'),
    );

    const result = scanProcessTreeDiagnosticAdoptionRepo(root);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
      file: 'src/barrel.ts',
    }));
  });

  it('follows a canonical function re-exported through a default barrel binding', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-default-barrel-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'src', 'runtimes', 'agent'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'runtimes', 'agent', 'process-tree.ts'),
      'export function killSessionTree() {}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'barrel.ts'),
      "export { killSessionTree as default } from './runtimes/agent/process-tree.ts';\n",
    );
    writeFileSync(
      path.join(root, 'src', 'caller.ts'),
      [
        "import reap from './barrel.ts';",
        "void reap(42, 'SIGTERM', { generationMarker: 'g', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    );

    const result = scanProcessTreeDiagnosticAdoptionRepo(root);
    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
      file: 'src/caller.ts',
    }));
  });

  it('blocks an unresolved default export before a consumer can bypass adoption checks', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-default-escape-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'src', 'runtimes', 'agent'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'runtimes', 'agent', 'process-tree.ts'),
      'export function killSessionTree() {}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'exporter.ts'),
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        'export default killSessionTree;',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'src', 'caller.ts'),
      [
        "import reap from './exporter.ts';",
        "void reap(42, 'SIGTERM', { generationMarker: 'hidden' });",
      ].join('\n'),
    );

    const result = scanProcessTreeDiagnosticAdoptionRepo(root);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
      file: 'src/exporter.ts',
    }));
  });

  it('covers exactly the three production callers with their canonical sources', () => {
    const result = scanProcessTreeDiagnosticAdoptionRepo(REPO_ROOT);
    expect(result.filesExamined).toBeGreaterThan(100);
    expect(result.callsExamined).toBe(3);
    expect(result.findings).toEqual([]);
    expect(result.sourceCounts).toEqual({
      ownership_loss_cleanup: 1,
      session_shutdown: 1,
      stale_session_sweep: 1,
    });
    // This non-vacuous live-tree scan takes about 7s in isolation and 39.5s in
    // the four-worker hosted full suite. A finite 120s local bound keeps a hang
    // detector with measured contention headroom; assertions remain unchanged.
  }, 120_000);

  it('emits one schema-valid JSON document with effect metadata in verbose mode', () => {
    const output = execFileSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', GUARD, '--format', 'json', '--verbose'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      schema_version: 'process-tree-diagnostic-adoption.v1',
      status: 'pass',
      effect: {
        read_only: true,
        destructive: false,
        idempotent: true,
        open_world: false,
        supports_dry_run: false,
      },
      calls_examined: 3,
    });
  });

  it('advertises every observer and traversal failure kind in its schema', () => {
    const output = execFileSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', GUARD, '--schema', '--format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const parsed = JSON.parse(output) as { error_kinds: string[] };
    expect(parsed.error_kinds).toEqual(expect.arrayContaining([
      'PROCESS_TREE_OUTCOME_OBSERVER_INVALID',
      'PROCESS_TREE_DIVERGENCE_OBSERVER_INVALID',
      'PROCESS_TREE_DIRECTORY_READ_FAILED',
      'PROCESS_TREE_SOURCE_ENTRY_UNSUPPORTED',
    ]));
  });

  it('is inconclusive when any nested source directory cannot be enumerated', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-unreadable-'));
    temporaryRoots.push(root);
    const blocked = path.join(root, 'src', 'blocked');
    mkdirSync(blocked, { recursive: true });

    const result = scanProcessTreeDiagnosticAdoptionRepo(root, {
      readdir: (directory) => {
        if (directory === blocked) throw new Error('injected directory read failure');
        return readdirSync(directory, { withFileTypes: true });
      },
    });

    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIRECTORY_READ_FAILED',
      file: 'src/blocked',
      retryable: true,
    }));
  });

  it('turns a throwing directory entry into a stable inconclusive finding', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-entry-failure-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'src'), { recursive: true });
    const privateCanary = 'private-entry-detail-must-not-escape';

    const result = scanProcessTreeDiagnosticAdoptionRepo(root, {
      readdir: () => [{
        name: 'candidate.ts',
        isDirectory: () => {
          throw new Error(privateCanary);
        },
        isFile: () => true,
      } as never],
    });

    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIRECTORY_READ_FAILED',
      retryable: true,
    }));
    expect(JSON.stringify(result)).not.toContain(privateCanary);
  });

  it('fails the source inventory closed on a symlinked source entry', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-symlink-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'target.ts'), 'export {};\n');
    symlinkSync(path.join(root, 'target.ts'), path.join(root, 'src', 'linked.ts'));

    const result = scanProcessTreeDiagnosticAdoptionRepo(root);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_SOURCE_ENTRY_UNSUPPORTED',
      file: 'src/linked.ts',
      retryable: true,
    }));
  });

  it('fails the source inventory closed when the source root is a symlink', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-root-symlink-'));
    temporaryRoots.push(root);
    const target = path.join(root, 'target-src');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'caller.ts'), 'export {};\n');
    symlinkSync(target, path.join(root, 'src'));

    const result = scanProcessTreeDiagnosticAdoptionRepo(root);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_SOURCE_ENTRY_UNSUPPORTED',
      file: 'src',
      retryable: true,
    }));
  });

  it('fails the source inventory closed on a special source entry', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-special-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'src'), { recursive: true });

    const result = scanProcessTreeDiagnosticAdoptionRepo(root, {
      readdir: () => [{
        name: 'candidate.ts',
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => false,
      } as never],
    });
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_SOURCE_ENTRY_UNSUPPORTED',
      file: 'src/candidate.ts',
      retryable: true,
    }));
  });

  it('does not copy a source-read exception into public guard output', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-private-error-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'caller.ts'), 'export {};\n');
    const privateCanary = 'private-source-path-and-message';

    const result = scanProcessTreeDiagnosticAdoptionRepo(root, {
      readText: () => {
        throw new Error(privateCanary);
      },
    });
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_SOURCE_READ_FAILED',
      retryable: true,
    }));
    expect(JSON.stringify(result)).not.toContain(privateCanary);
  });

  it('uses the inconclusive exit when the source inventory cannot be enumerated', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-missing-source-'));
    temporaryRoots.push(root);

    const result = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', GUARD, '--format', 'json', '--root', root],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema_version: 'process-tree-diagnostic-adoption.v1',
      status: 'inconclusive',
    });
  });

  it('fails closed with a stable error kind and remediation hint', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'caller.ts'),
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "void killSessionTree(42, 'SIGTERM', { generationMarker: 'g', rootAuthority });",
      ].join('\n'),
    );

    const result = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', GUARD, '--format', 'json', '--root', root],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      errors: Array<{ kind: string; retryable: boolean; hint: string }>;
    };
    expect(parsed.status).toBe('fail');
    expect(parsed.errors[0]).toMatchObject({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
      retryable: false,
    });
    expect(parsed.errors[0]?.hint).toContain('diagnosticSource');
  });
});
