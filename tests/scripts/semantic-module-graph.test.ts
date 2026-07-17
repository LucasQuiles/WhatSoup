import { describe, expect, it } from 'vitest';

import {
  analyzeExportOwnership,
  analyzeReachability,
  buildModuleGraph,
  type ModuleSource,
} from '../../scripts/lib/semantic-quality/module-graph.ts';

const ROOT = 'src/main.ts';
const FEATURE = 'src/lib/feature.ts';

function graphWithMain(mainText: string, featureText = 'export const feature = () => true;') {
  return buildModuleGraph([
    { path: ROOT, text: mainText },
    { path: FEATURE, text: featureText },
  ]);
}

function ownership(sources: ModuleSource[], roots = [ROOT]) {
  const graph = buildModuleGraph(sources);
  const reachability = analyzeReachability(graph, roots, []);
  return {
    graph,
    reachability,
    ownership: analyzeExportOwnership(sources, graph, reachability.reachable),
  };
}

describe('semantic runtime module graph', () => {
  it.each([
    ['runtime import', `import { feature } from './lib/feature.ts';\nfeature();`, []],
    ['side-effect import', `import './lib/feature.ts';`, []],
    ['literal dynamic import', `await import('./lib/feature.ts');`, []],
    ['type-only import', `import type { Feature } from './lib/feature.ts';`, [FEATURE]],
    ['type-only re-export', `export type { Feature } from './lib/feature.ts';`, [FEATURE]],
    ['comment', `// import './lib/feature.ts'`, [FEATURE]],
    ['string', `const note = "./lib/feature.ts";`, [FEATURE]],
    ['computed import', `const p = './lib/feature.ts'; await import(p);`, [FEATURE]],
  ])('%s has the expected production reachability', (_name, mainText, expected) => {
    const graph = graphWithMain(mainText);

    expect(analyzeReachability(graph, [ROOT], [FEATURE]).unreachableCandidates).toEqual(expected);
  });

  it('retains a runtime edge for a mixed type and value import', () => {
    const graph = graphWithMain(
      `import { type Feature, feature } from './lib/feature.ts';\nfeature();`,
      `export interface Feature { enabled: boolean }\nexport const feature = () => true;`,
    );

    expect(analyzeReachability(graph, [ROOT], [FEATURE]).unreachableCandidates).toEqual([]);
  });

  it.each([
    ['a JavaScript specifier to TypeScript source', `import { feature } from './lib/feature.js';`, FEATURE],
    ['an extensionless index module', `import { feature } from './lib/feature';`, 'src/lib/feature/index.ts'],
    ['a JavaScript specifier to TSX source', `import View from './view.js';`, 'src/view.tsx'],
  ])('resolves %s', (_name, mainText, featurePath) => {
    const graph = buildModuleGraph([
      { path: ROOT, text: mainText },
      { path: featurePath, text: 'export default function View() { return null; }\nexport const feature = true;' },
    ]);

    expect(analyzeReachability(graph, [ROOT], [featurePath]).unreachableCandidates).toEqual([]);
  });

  it('keeps a disconnected multi-module island unreachable', () => {
    const graph = buildModuleGraph([
      { path: ROOT, text: 'export const main = true;' },
      { path: 'src/island/a.ts', text: `import './b.ts';\nexport const a = true;` },
      { path: 'src/island/b.ts', text: 'export const b = true;' },
    ]);

    expect(
      analyzeReachability(graph, [ROOT], ['src/island/b.ts', 'src/island/a.ts'])
        .unreachableCandidates,
    ).toEqual(['src/island/a.ts', 'src/island/b.ts']);
  });

  it('makes a missing configured root observable without inventing reachability', () => {
    const graph = buildModuleGraph([{ path: FEATURE, text: 'export const feature = true;' }]);

    const result = analyzeReachability(graph, ['src/missing-root.ts'], [FEATURE]);

    expect(result.roots).toEqual(['src/missing-root.ts']);
    expect([...result.reachable]).toEqual([]);
    expect(result.unreachableCandidates).toEqual([FEATURE]);
  });

  it('reports unresolved relative runtime literals and ignores bare packages', () => {
    const graph = buildModuleGraph([
      {
        path: ROOT,
        text: `import './missing.ts';\nimport 'typescript';\nawait import('./also-missing.js');`,
      },
    ]);

    const result = analyzeReachability(graph, [ROOT], []);

    expect(result.unresolved).toEqual([
      { importer: ROOT, specifier: './also-missing.js' },
      { importer: ROOT, specifier: './missing.ts' },
    ]);
    expect(graph.unresolvedRuntimeSpecifiers.get(ROOT)).toEqual(
      new Set(['./also-missing.js', './missing.ts']),
    );
  });

  it('rejects parse diagnostics instead of returning a healthy partial graph', () => {
    expect(() =>
      buildModuleGraph([{ path: ROOT, text: `import { feature from './lib/feature.ts';` }]),
    ).toThrow(/could not parse src\/main\.ts/i);
  });
});

describe('semantic runtime export ownership', () => {
  it('owns a named export imported and called by a reachable module', () => {
    const { ownership: result } = ownership([
      { path: ROOT, text: `import { feature } from './lib/feature.ts';\nfeature();` },
      { path: FEATURE, text: 'export function feature() { return true; }' },
    ]);

    expect(result.unowned).toEqual([]);
    expect(result.owned).toEqual([{ path: FEATURE, name: 'feature', owners: [ROOT] }]);
  });

  it('counts a same-module runtime reference as ownership', () => {
    const { ownership: result } = ownership(
      [{ path: FEATURE, text: 'export function feature() { return true; }\nfeature();' }],
      [FEATURE],
    );

    expect(result.unowned).toEqual([]);
    expect(result.owned).toEqual([{ path: FEATURE, name: 'feature', owners: [FEATURE] }]);
  });

  it('enumerates runtime exports while excluding type-only declarations and exports', () => {
    const { graph, ownership: result } = ownership(
      [
        {
          path: FEATURE,
          text: [
            'export interface Feature { enabled: boolean }',
            'export type FeatureName = string;',
            'type Hidden = string;',
            'export type { Hidden };',
            'export const isolated = true;',
          ].join('\n'),
        },
      ],
      [FEATURE],
    );

    expect(graph.runtimeExports.get(FEATURE)).toEqual(new Set(['isolated']));
    expect(result.owned).toEqual([]);
    expect(result.unowned).toEqual([{ path: FEATURE, name: 'isolated' }]);
  });

  it('does not treat a test-only import as a production owner', () => {
    const { ownership: result } = ownership([
      { path: ROOT, text: `import './lib/feature.ts';` },
      { path: FEATURE, text: 'export const feature = () => true;' },
      {
        path: 'tests/feature.test.ts',
        text: `import { feature } from '../src/lib/feature.ts';\nfeature();`,
      },
    ]);

    expect(result.owned).toEqual([]);
    expect(result.unowned).toEqual([{ path: FEATURE, name: 'feature' }]);
  });

  it('does not count comments, strings, or the export declaration as runtime ownership', () => {
    const { ownership: result } = ownership([
      {
        path: ROOT,
        text: `import './lib/feature.ts';\n// feature();\nconst note = 'feature';`,
      },
      { path: FEATURE, text: 'export const feature = () => true;' },
    ]);

    expect(result.owned).toEqual([]);
    expect(result.unowned).toEqual([{ path: FEATURE, name: 'feature' }]);
  });

  it('resolves namespace-property use to the exported member', () => {
    const { ownership: result } = ownership([
      { path: ROOT, text: `import * as featureModule from './lib/feature.ts';\nfeatureModule.feature();` },
      { path: FEATURE, text: 'export function feature() { return true; }' },
    ]);

    expect(result.unowned).toEqual([]);
    expect(result.owned).toEqual([{ path: FEATURE, name: 'feature', owners: [ROOT] }]);
  });

  it('tracks a default export without inventing a declaration name', () => {
    const { graph, ownership: result } = ownership([
      { path: ROOT, text: `import run from './lib/feature.ts';\nrun();` },
      { path: FEATURE, text: 'export default function () { return true; }' },
    ]);

    expect(graph.runtimeExports.get(FEATURE)).toEqual(new Set(['default']));
    expect(result.unowned).toEqual([]);
    expect(result.owned).toEqual([{ path: FEATURE, name: 'default', owners: [ROOT] }]);
  });

  it('counts a reachable runtime re-export as ownership of its source export', () => {
    const { ownership: result } = ownership([
      { path: ROOT, text: `import { feature } from './barrel.ts';\nfeature();` },
      { path: 'src/barrel.ts', text: `export { feature } from './lib/feature.ts';` },
      { path: FEATURE, text: 'export function feature() { return true; }' },
    ]);

    expect(result.owned).toContainEqual({
      path: FEATURE,
      name: 'feature',
      owners: ['src/barrel.ts'],
    });
  });

  it('resolves aliased imports to their source export', () => {
    const { ownership: result } = ownership([
      { path: ROOT, text: `import { feature as run } from './lib/feature.ts';\nrun();` },
      { path: FEATURE, text: 'export function feature() { return true; }' },
    ]);

    expect(result.owned).toEqual([{ path: FEATURE, name: 'feature', owners: [ROOT] }]);
  });
});
