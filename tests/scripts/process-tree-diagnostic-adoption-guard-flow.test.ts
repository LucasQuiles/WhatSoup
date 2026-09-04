import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  scanProcessTreeDiagnosticAdoptionRepo,
  scanProcessTreeDiagnosticAdoptionSource,
} from '../../scripts/process-tree-diagnostic-adoption-guard.ts';

const canonicalImport =
  "import { killSessionTree } from './runtimes/agent/process-tree.ts';";
const adoptedOptions = [
  'rootAuthority',
  "diagnosticSource: 'session_shutdown'",
  'onOutcome: () => {}',
  'onCgroupDivergence: () => {}',
].join(', ');
const incompleteOptions = "generationMarker: 'g', rootAuthority";

function scan(lines: readonly string[]) {
  return scanProcessTreeDiagnosticAdoptionSource('src/value-flow.ts', lines.join('\n'));
}

describe('process-tree diagnostic adoption closed value flow', () => {
  it.each([
    {
      name: 'promise callback namespace',
      lines: [
        "void import('./runtimes/agent/process-tree.ts').then((tree) =>",
        `  tree.killSessionTree(42, 'SIGTERM', { ${incompleteOptions} }),`,
        ');',
      ],
    },
    {
      name: 'promise callback destructuring',
      lines: [
        "void import('./runtimes/agent/process-tree.ts').then(({ killSessionTree }) =>",
        `  killSessionTree(42, 'SIGTERM', { ${incompleteOptions} }),`,
        ');',
      ],
    },
    {
      name: 'nonliteral computed access',
      lines: [
        "const member: string = 'killSessionTree';",
        `void (await import('./runtimes/agent/process-tree.ts'))[member](42, 'SIGTERM', { ${incompleteOptions} });`,
      ],
    },
    {
      name: 'Reflect.get access',
      lines: [
        "const reap = Reflect.get(await import('./runtimes/agent/process-tree.ts'), 'killSessionTree');",
        `void reap(42, 'SIGTERM', { ${incompleteOptions} });`,
      ],
    },
  ])('rejects an unmodeled canonical dynamic-import $name', ({ lines }) => {
    const result = scan(lines);

    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
    }));
  });

  it.each([
    {
      name: 'object rest',
      lines: [
        canonicalImport,
        'const holder = { reap: killSessionTree };',
        'const { ...rest } = holder;',
        `void rest.reap(42, 'SIGTERM', { ${incompleteOptions} });`,
      ],
    },
    {
      name: 'namespace rest',
      lines: [
        "import * as tree from './runtimes/agent/process-tree.ts';",
        'const { ...rest } = tree;',
        `void rest.killSessionTree(42, 'SIGTERM', { ${incompleteOptions} });`,
      ],
    },
    {
      name: 'static computed member',
      lines: [
        canonicalImport,
        'const holder = { reap: killSessionTree };',
        "const { ['reap']: terminate } = holder;",
        `void terminate(42, 'SIGTERM', { ${incompleteOptions} });`,
      ],
    },
  ])('tracks a canonical reference through $name destructuring', ({ lines }) => {
    const result = scan(lines);

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
    }));
  });

  it('rejects a dynamic computed destructuring member', () => {
    const result = scan([
      canonicalImport,
      'const holder = { reap: killSessionTree };',
      "const member: string = 'reap';",
      'const { [member]: terminate } = holder;',
      `void terminate(42, 'SIGTERM', { ${incompleteOptions} });`,
    ]);

    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
    }));
  });

  it('accepts rest only after every canonical member was extracted', () => {
    const result = scan([
      canonicalImport,
      'const holder = { reap: killSessionTree, metadata: 1 };',
      'const { reap, ...rest } = holder;',
      'void rest.metadata;',
      `void reap(42, 'SIGTERM', { ${adoptedOptions} });`,
    ]);

    expect(result).toEqual({
      callsExamined: 1,
      findings: [],
      callSites: [expect.objectContaining({ source: 'session_shutdown' })],
    });
  });

  it('tracks a function-scoped var alias declared in a nested block', () => {
    const result = scan([
      canonicalImport,
      'function invoke(): void {',
      '  { var reap = killSessionTree; }',
      `  void reap(42, 'SIGTERM', { ${incompleteOptions} });`,
      '}',
    ]);

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
    }));
  });

  it('does not mistake a nested function-scoped var shadow for the canonical import', () => {
    const result = scan([
      canonicalImport,
      'function invoke(): void {',
      '  { var killSessionTree = (): void => {}; }',
      '  killSessionTree();',
      '}',
    ]);

    expect(result).toEqual({ callsExamined: 0, findings: [], callSites: [] });
  });

  it('tracks a lexical alias declared in an unbraced switch clause', () => {
    const result = scan([
      canonicalImport,
      "declare const mode: 'reap';",
      'switch (mode) {',
      "  case 'reap':",
      '    const reap = killSessionTree;',
      `    void reap(42, 'SIGTERM', { ${incompleteOptions} });`,
      '}',
    ]);

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
    }));
  });

  it.each([
    {
      name: 'parenthesized specifier',
      declaration: "const tree = await import(('./runtimes/agent/process-tree.ts'));",
    },
    {
      name: 'cast specifier',
      declaration: "const tree = await import('./runtimes/agent/process-tree.ts' as string);",
    },
    {
      name: 'standard import options',
      declaration: "const tree = await import('./runtimes/agent/process-tree.ts', {});",
    },
    {
      name: 'constant specifier',
      declaration: [
        "const specifier = './runtimes/agent/process-tree.ts';",
        'const tree = await import(specifier);',
      ].join('\n'),
    },
    {
      name: 'literal concatenation',
      declaration: [
        "const specifier = './runtimes/agent/' + 'process-tree.ts';",
        'const tree = await import(specifier);',
      ].join('\n'),
    },
  ])('tracks a canonical dynamic import with a $name', ({ declaration }) => {
    const result = scan([
      declaration,
      `void tree.killSessionTree(42, 'SIGTERM', { ${incompleteOptions} });`,
    ]);

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
    }));
  });

  it('accepts a fully adopted awaited import with standard options', () => {
    const result = scan([
      "const tree = await import(('./runtimes/agent/process-tree.ts'), {});",
      `void tree.killSessionTree(42, 'SIGTERM', { ${adoptedOptions} });`,
    ]);

    expect(result).toEqual({
      callsExamined: 1,
      findings: [],
      callSites: [expect.objectContaining({ source: 'session_shutdown' })],
    });
  });

  it('rejects killSessionTree access from an unresolved dynamic-import namespace', () => {
    const result = scan([
      'declare const specifier: string;',
      'const tree = await import(specifier);',
      `void tree.killSessionTree(42, 'SIGTERM', { ${incompleteOptions} });`,
    ]);

    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
    }));
  });

  it.each([
    {
      name: 'identifier alias',
      lines: [
        'const tree = await import(specifier);',
        'const alias = tree;',
        `void alias.killSessionTree(42, 'SIGTERM', { ${incompleteOptions} });`,
      ],
    },
    {
      name: 'later destructuring',
      lines: [
        'const tree = await import(specifier);',
        'const { killSessionTree } = tree;',
        `void killSessionTree(42, 'SIGTERM', { ${incompleteOptions} });`,
      ],
    },
    {
      name: 'object container',
      lines: [
        'const tree = await import(specifier);',
        'const holder = { tree };',
        `void holder.tree.killSessionTree(42, 'SIGTERM', { ${incompleteOptions} });`,
      ],
    },
    {
      name: 'promise callback',
      lines: [
        'void import(specifier).then((tree) =>',
        `  tree.killSessionTree(42, 'SIGTERM', { ${incompleteOptions} }),`,
        ');',
      ],
    },
  ])('rejects an unresolved dynamic-import $name at its origin', ({ lines }) => {
    const result = scan(['declare const specifier: string;', ...lines]);

    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
    }));
  });

  it('accepts a statically noncanonical dynamic import', () => {
    const result = scan([
      "const tree = await import('./other-tool.ts');",
      'void tree.killSessionTree();',
    ]);

    expect(result).toEqual({ callsExamined: 0, findings: [], callSites: [] });
  });

  it('allows an unresolved dynamic import only when its awaited result is discarded', () => {
    const result = scan([
      'declare const specifier: string;',
      'await import(specifier);',
    ]);

    expect(result).toEqual({ callsExamined: 0, findings: [], callSites: [] });
  });

  it.each([
    { declaration: 'import tools = tree;', reference: 'tools' },
    { declaration: 'export import tools = tree;', reference: 'tools' },
    {
      declaration: 'namespace ProcessTools { export import tools = tree; }',
      reference: 'ProcessTools.tools',
    },
    {
      declaration: "import tools = require('./runtimes/agent/process-tree.ts');",
      reference: 'tools',
      standalone: true,
    },
  ])('rejects a canonical TypeScript import-equals alias: $declaration', ({
    declaration,
    reference,
    standalone = false,
  }) => {
    const result = scan([
      ...(standalone ? [] : ["import * as tree from './runtimes/agent/process-tree.ts';"]),
      declaration,
      `void ${reference}.killSessionTree(42, 'SIGTERM', { ${incompleteOptions} });`,
    ]);

    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
    }));
  });

  it.each([
    [
      'exported namespace member',
      'export namespace ProcessTools {',
      '  export const reap = killSessionTree;',
      '}',
    ],
    [
      'same-file namespace call',
      'namespace ProcessTools {',
      '  export const reap = killSessionTree;',
      '}',
      `void ProcessTools.reap(42, 'SIGTERM', { ${incompleteOptions} });`,
    ],
  ])('rejects an unmodeled canonical %s', (_name, ...namespaceLines) => {
    const result = scan([canonicalImport, ...namespaceLines]);

    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
    }));
  });

  it('follows default-import provenance through a later named re-export', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-default-chain-'));
    try {
      mkdirSync(path.join(root, 'src', 'runtimes', 'agent'), { recursive: true });
      writeFileSync(
        path.join(root, 'src', 'runtimes', 'agent', 'process-tree.ts'),
        'export function killSessionTree() {}\n',
      );
      writeFileSync(
        path.join(root, 'src', 'first.ts'),
        "export { killSessionTree as default } from './runtimes/agent/process-tree.ts';\n",
      );
      writeFileSync(
        path.join(root, 'src', 'second.ts'),
        "import reap from './first.ts';\nexport { reap as terminate };\n",
      );
      writeFileSync(
        path.join(root, 'src', 'caller.ts'),
        [
          "import { terminate } from './second.ts';",
          `void terminate(42, 'SIGTERM', { ${incompleteOptions} });`,
        ].join('\n'),
      );

      const result = scanProcessTreeDiagnosticAdoptionRepo(root);
      expect(result.callsExamined).toBe(1);
      expect(result.findings).toContainEqual(expect.objectContaining({
        kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
        file: 'src/caller.ts',
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shares local-barrel provenance across dynamic and import-equals forms', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-import-forms-'));
    try {
      mkdirSync(path.join(root, 'src', 'runtimes', 'agent'), { recursive: true });
      mkdirSync(path.join(root, 'src', 'nested'));
      writeFileSync(
        path.join(root, 'src', 'runtimes', 'agent', 'process-tree.ts'),
        'export function killSessionTree() {}\n',
      );
      writeFileSync(
        path.join(root, 'src', 'barrel.ts'),
        "export { killSessionTree } from './runtimes/agent/process-tree.ts';\n",
      );
      writeFileSync(
        path.join(root, 'src', 'dynamic-caller.ts'),
        [
          "const tree = await import('./nested/../barrel.ts');",
          `void tree.killSessionTree(42, 'SIGTERM', { ${incompleteOptions} });`,
        ].join('\n'),
      );
      writeFileSync(
        path.join(root, 'src', 'equals-caller.ts'),
        [
          "import tree = require('./nested/../barrel.ts');",
          `void tree.killSessionTree(42, 'SIGTERM', { ${incompleteOptions} });`,
        ].join('\n'),
      );

      const result = scanProcessTreeDiagnosticAdoptionRepo(root);
      expect(result.callsExamined).toBe(1);
      expect(result.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
          file: 'src/dynamic-caller.ts',
        }),
        expect.objectContaining({
          kind: 'PROCESS_TREE_CANONICAL_REFERENCE_UNSUPPORTED',
          file: 'src/equals-caller.ts',
        }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors TypeScript file precedence over a canonical index barrel', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-module-shadow-'));
    try {
      mkdirSync(path.join(root, 'src', 'runtimes', 'agent'), { recursive: true });
      mkdirSync(path.join(root, 'src', 'tool'));
      writeFileSync(
        path.join(root, 'src', 'runtimes', 'agent', 'process-tree.ts'),
        'export function killSessionTree() {}\n',
      );
      writeFileSync(
        path.join(root, 'src', 'tool.ts'),
        'export function killSessionTree() {}\n',
      );
      writeFileSync(
        path.join(root, 'src', 'tool', 'index.ts'),
        "export { killSessionTree } from '../runtimes/agent/process-tree.ts';\n",
      );
      writeFileSync(
        path.join(root, 'src', 'caller.ts'),
        [
          "const tree = await import('./tool');",
          `void tree.killSessionTree(42, 'SIGTERM', { ${incompleteOptions} });`,
        ].join('\n'),
      );

      const result = scanProcessTreeDiagnosticAdoptionRepo(root);
      expect(result.callsExamined).toBe(0);
      expect(result.findings).not.toContainEqual(expect.objectContaining({
        file: 'src/caller.ts',
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
