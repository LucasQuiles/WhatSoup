/**
 * Drift guard: the console provider catalog and the server provider registry
 * must agree exactly.
 *
 * The fleet PATCH endpoint validates provider IDs against the server-side
 * PROVIDER_IDS registry (src/runtimes/agent/providers/index.ts). The console
 * also imports that registry for display metadata and non-picker rendering.
 * Interactive pickers use GET /api/providers, but a split registry could still
 * make those secondary surfaces disagree with the server. This test pins the
 * shared identifiers while component tests prove that selectable options come
 * only from the current server response.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import {
  PROVIDER_IDS,
  DEFAULT_PROVIDER_ID,
} from '../../src/runtimes/agent/providers/index.ts';
import {
  PROVIDERS,
  DEFAULT_PROVIDER_ID as CONSOLE_DEFAULT_PROVIDER_ID,
} from '../../console/src/lib/providers.ts';

const CONSOLE_SOURCE_ROOT = resolve(process.cwd(), 'console/src');
const MODEL_LITERAL_EXCEPTIONS = new Set([
  // Demo records and log fixtures model already persisted runtime data; they
  // are not selectable options or defaults.
  resolve(CONSOLE_SOURCE_ROOT, 'mock-data.ts'),
]);

export function looksLikeModelId(value: string): boolean {
  return (
    /^(?:claude-(?:opus|sonnet|haiku)|gpt-|gemini-)[a-z0-9._:-]*\d[a-z0-9._:-]*$/i.test(value)
    || /^[a-z][a-z0-9.-]*\/(?=[a-z0-9._:-]*\d)[a-z0-9][a-z0-9._:-]*$/i.test(value)
  );
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !MODEL_LITERAL_EXCEPTIONS.has(path) ? [path] : [];
  });
}

export function hardcodedModelLiteralsInSource(
  source: string,
  path: string,
): Array<{ value: string; line: number }> {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: Array<{ value: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && looksLikeModelId(node.text)) {
      findings.push({
        value: node.text,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function hardcodedModelLiterals(path: string): Array<{ value: string; line: number }> {
  return hardcodedModelLiteralsInSource(readFileSync(path, 'utf8'), path);
}

describe('provider catalog drift guard (console vs server)', () => {
  it('console provider IDs match the server registry exactly, in order', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual([...PROVIDER_IDS]);
  });

  it('console default provider matches the server default', () => {
    expect(CONSOLE_DEFAULT_PROVIDER_ID).toBe(DEFAULT_PROVIDER_ID);
  });

  it('console catalog has no duplicate IDs', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('recognizes model-shaped literals without treating generic runtime-default copy as a model', () => {
    expect(looksLikeModelId('new-provider/frontier-1')).toBe(true);
    expect(looksLikeModelId('Runtime default, or type a model ID')).toBe(false);
    expect(looksLikeModelId('application/json')).toBe(false);
  });

  it('detects an invalid production literal through the same AST traversal used by the guard', () => {
    const source = [
      "const options = ['new-provider/frontier-1'];",
      "const helper = 'Runtime default, or type a model ID';",
    ].join('\n');

    expect(hardcodedModelLiteralsInSource(source, 'synthetic-console-source.ts')).toEqual([
      { value: 'new-provider/frontier-1', line: 1 },
    ]);
  });

  it('keeps selectable production-console model IDs sourced from runtime catalogues', () => {
    const findings = sourceFiles(CONSOLE_SOURCE_ROOT).flatMap((path) => (
      hardcodedModelLiterals(path).map((finding) => ({
        path: relative(process.cwd(), path),
        ...finding,
      }))
    ));

    expect(findings).toEqual([]);
  });
});
