import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { describe, expect, it } from 'vitest';

import {
  canonicalRepoHygienePolicyProjection,
  currentRepoHygienePolicyDigest,
  currentRepoHygieneToolDigest,
  isAllowedPatternMatch,
  privateHostLabels,
  repoHygienePolicyProjectionCoverage,
} from '../../scripts/repo-hygiene-guard.ts';
import {
  isAllowedPatternMatch as internalIsAllowedPatternMatch,
  privateHostLabels as internalPrivateHostLabels,
} from '../../scripts/lib/repo-hygiene-policy.ts';

function framedToolBytes(guardBytes: Buffer, policyBytes: Buffer): Buffer {
  const sources = [
    { id: 'scripts/repo-hygiene-guard.ts', bytes: guardBytes },
    { id: 'scripts/lib/repo-hygiene-policy.ts', bytes: policyBytes },
  ];
  const chunks: Buffer[] = [Buffer.from('repo-hygiene-tool-v1\0', 'utf8')];
  for (const source of sources) {
    const id = Buffer.from(source.id, 'utf8');
    chunks.push(Buffer.from(`${id.byteLength}:${source.bytes.byteLength}:`, 'ascii'), id, source.bytes);
  }
  return Buffer.concat(chunks);
}

function sha256(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const LOADER_CAPABILITY_REFERENCE = '<loader-capability-reference>';

function staticImportSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile('repo-hygiene-policy.ts', source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const loaderCapabilities = new Set(['require', 'createRequire', 'getBuiltinModule']);
  const loaderRoots = new Set(['process', 'globalThis']);
  const addSpecifier = (specifier: ts.Expression | undefined): void => {
    specifiers.push(
      specifier !== undefined && ts.isStringLiteralLike(specifier)
        ? specifier.text
        : '<dynamic-module-reference>',
    );
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isIdentifier(node) &&
        (loaderCapabilities.has(node.text) || loaderRoots.has(node.text))) ||
      (ts.isStringLiteralLike(node) && loaderCapabilities.has(node.text))
    ) {
      specifiers.push(LOADER_CAPABILITY_REFERENCE);
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) addSpecifier(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addSpecifier(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isCommonJsLoader =
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'require' || node.expression.text === 'createRequire');
      if (isDynamicImport || isCommonJsLoader) addSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

describe('repository hygiene policy extraction', () => {
  it('binds the guard and extracted policy bytes through deterministic framing', () => {
    const guardBytes = readFileSync(join(process.cwd(), 'scripts/repo-hygiene-guard.ts'));
    const policyBytes = readFileSync(join(process.cwd(), 'scripts/lib/repo-hygiene-policy.ts'));
    const framed = framedToolBytes(guardBytes, policyBytes);
    expect(currentRepoHygieneToolDigest()).toBe(sha256(framed));

    const mutatedPolicy = Buffer.from(policyBytes);
    mutatedPolicy[mutatedPolicy.byteLength - 1] ^= 1;
    expect(sha256(framedToolBytes(guardBytes, mutatedPolicy))).not.toBe(currentRepoHygieneToolDigest());
  });

  it('keeps declared module references one-way, rejects loader roots, and preserves the facade', () => {
    const policySource = readFileSync(
      join(process.cwd(), 'scripts/lib/repo-hygiene-policy.ts'),
      'utf8',
    );
    const specifiers = staticImportSpecifiers(policySource);
    expect([...new Set(specifiers)]).toEqual(['./guard-core.ts']);
    expect(privateHostLabels).toBe(internalPrivateHostLabels);
    expect(isAllowedPatternMatch).toBe(internalIsAllowedPatternMatch);
  });

  it('detects a comment-obscured reverse side-effect import', () => {
    const policySource = readFileSync(
      join(process.cwd(), 'scripts/lib/repo-hygiene-policy.ts'),
      'utf8',
    );
    const mutated = `${policySource}\nimport/* deliberate comment */ "../repo-hygiene-guard.ts";\n`;
    expect(staticImportSpecifiers(mutated)).toContain('../repo-hygiene-guard.ts');
  });

  it('detects reverse re-exports, dynamic imports, and import-equals references', () => {
    const reversePath = '../repo-hygiene-guard.ts';
    expect(staticImportSpecifiers(`export * from "${reversePath}";`)).toContain(reversePath);
    expect(
      staticImportSpecifiers(`void import/* deliberate comment */("${reversePath}");`),
    ).toContain(reversePath);
    expect(staticImportSpecifiers(`import guard = require("${reversePath}");`)).toContain(
      reversePath,
    );
  });

  it('keeps the allowed guard-core module reference as the safe neighbor', () => {
    expect(staticImportSpecifiers('export { scan } from "./guard-core.ts";')).toEqual([
      './guard-core.ts',
    ]);
  });

  it('detects process.getBuiltinModule loader acquisition, aliasing, and computed access', () => {
    const mutated = `
      const moduleApi = process.getBuiltinModule('module');
      const load = moduleApi.createRequire(import.meta.url);
      load('../repo-hygiene-guard.ts');
    `;
    expect(staticImportSpecifiers(mutated)).toContain(LOADER_CAPABILITY_REFERENCE);

    const aliased = `
      const acquireLoader = process.getBuiltinModule;
      const moduleApi = acquireLoader('module');
    `;
    expect(staticImportSpecifiers(aliased)).toContain(LOADER_CAPABILITY_REFERENCE);

    const computed = `
      const acquireLoader = process['get' + 'BuiltinModule'];
      const moduleApi = acquireLoader('module');
      const createLoader = moduleApi['create' + 'Require'];
      const load = createLoader(import.meta.url);
      load('../repo-hygiene-guard.ts');
    `;
    expect(staticImportSpecifiers(computed)).toContain(LOADER_CAPABILITY_REFERENCE);

    const computedBinding = `
      const { ['getBuiltinModule']: acquireLoader } = process;
      const moduleApi = acquireLoader('module');
    `;
    expect(staticImportSpecifiers(computedBinding)).toContain(LOADER_CAPABILITY_REFERENCE);
  });

  it('preserves complete live policy-route coverage and registers its own policy source', () => {
    expect(currentRepoHygienePolicyDigest()).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(repoHygienePolicyProjectionCoverage()).toEqual([
      'base-line-sets',
      'child-process-shell-true',
      'dynamic-code-execution',
      'find-disallowed-match',
      'fixture-file-routing',
      'normalize-repo-path',
      'package-lock-resolved-url-exception',
      'pattern-allowlist-routing',
      'process-env-inheritance',
      'production-code-path-routing',
      'scan-added-lines',
      'scan-commit-authors',
      'scan-commit-message',
      'secret-history-subset',
      'source-console-routing',
      'suppression-comment-routing',
      'suppression-rationale-expiry',
      'tracked-sensitive-artifact-routing',
    ]);
    const projection = JSON.parse(canonicalRepoHygienePolicyProjection()) as {
      fixtureFiles: string[];
    };
    expect(projection.fixtureFiles).toContain('scripts/lib/repo-hygiene-policy.ts');

    const source = readFileSync(join(process.cwd(), 'scripts/repo-hygiene-guard.ts'), 'utf8');
    for (const marker of [
      'baseLineSets: baseLineSets.toString()',
      'childProcessShellTrue: isChildProcessShellTrue.toString()',
      'dynamicCodeExecution: isDynamicCodeExecution.toString()',
      'findDisallowedMatch: findDisallowedMatch.toString()',
      'fixtureFileRouting: isFixtureFile.toString()',
      'normalizeRepoPath: normalizeRepoPath.toString()',
      'packageLockResolvedUrlException: isPackageLockResolvedUrlLine.toString()',
      'patternAllowlistRouting: isAllowedPatternMatch.toString()',
      'processEnvInheritance: isProcessEnvInheritance.toString()',
      'productionCodePathRouting: isProductionCodePath.toString()',
      'scanAddedLines: scanAddedLines.toString()',
      'scanCommitAuthors: scanCommitAuthors.toString()',
      'scanCommitMessage: scanCommitMessage.toString()',
      'secretHistorySubset: secretCauses.toString()',
      'sourceConsoleRouting: isSourceConsoleCall.toString()',
      'suppressionCommentRouting: isSuppressionComment.toString()',
      'suppressionRationaleExpiry: hasSuppressionRationaleAndExpiry.toString()',
      'trackedSensitiveArtifactRouting: isTrackedSensitiveArtifact.toString()',
    ]) expect(source).toContain(marker);
    expect(source).toContain('appendExactRangeFinding');
    expect((source.match(/findings\.push\(/g) ?? []).length).toBe(1);
    expect(source).toContain('scanNetAddedLineFindingsIncrementally');
    expect(source).not.toContain('scanAddedLines(net.changes.flatMap');
    expect(source).toContain('appendHistoryLineCandidate');
    expect(source).toContain('appendHistoryArtifactCandidate');
    expect(source).toContain('appendRawFindingKey');
    expect((source.match(/historyLines\.push\(/g) ?? []).length).toBe(1);
    expect((source.match(/historyArtifacts\.push\(/g) ?? []).length).toBe(1);
    expect((source.match(/rawFindingKeys\.add\(/g) ?? []).length).toBe(1);
  });
});
