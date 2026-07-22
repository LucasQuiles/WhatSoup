import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  it('keeps one-way imports and the established parent facade', () => {
    const policySource = readFileSync(
      join(process.cwd(), 'scripts/lib/repo-hygiene-policy.ts'),
      'utf8',
    );
    const specifiers = [...policySource.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)]
      .map((match) => match[1]);
    expect([...new Set(specifiers)]).toEqual(['./guard-core.ts']);
    expect(policySource).not.toMatch(/\bimport\s*\(/u);
    expect(policySource).not.toMatch(/\b(?:require|createRequire)\s*\(/u);
    expect(privateHostLabels).toBe(internalPrivateHostLabels);
    expect(isAllowedPatternMatch).toBe(internalIsAllowedPatternMatch);
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
