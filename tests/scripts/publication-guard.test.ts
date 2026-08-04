import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import {
  MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT,
  MAX_EXACT_AGGREGATE_BLOB_BYTES,
  MAX_EXACT_SINGLE_BLOB_BYTES,
} from '../../scripts/lib/ci-control/git-input.ts';
import { canonicalizeBoundaryRun } from '../../scripts/lib/verification/boundary-run/shared.ts';
import {
  canonicalPublicationPolicyProjection,
  canonicalPublicationToolProjection,
  createPublicationExactRangeArtifact,
  currentPublicationPolicyDigest,
  currentPublicationToolDigest,
  internalPublicationRoots,
  isInternalPublicationPath,
  MAX_PUBLICATION_BASELINE_BLOB_BYTES,
  MAX_PUBLICATION_PATH_TRANSITION_BLOB_BYTES,
  publicationPolicyProjectionCoverage,
  runPublicationGuard,
  scanTextForPrivateLiterals,
  validatePublicationExactRangeArtifact,
  parsePublicationAudit,
  validatePublicationAudit,
  writePublicationAudit,
} from '../../scripts/publication-guard.ts';
import { DEFAULT_RATIONALE, parsePublicationAuditEntries } from '../../scripts/lib/publication-audit-write.ts';

const internalDocPath = 'docs/sdlc/closed/example/state.md';

const tmp = trackTmpDirs('');

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
}

function gitOutput(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanGitEnv() }).trim();
}

/** Mirrors the guard's own payload digest shape so fixtures keep the `sha256:` prefix in their type. */
function payloadDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function makeExactRangeRepo(): { repo: string; baseOid: string } {
  const repo = tmp.make('publication-exact-range');
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'guard-test@users.noreply.github.com']);
  git(repo, ['config', 'user.name', 'Guard Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'note.txt'), 'public-safe\n');
  git(repo, ['add', 'note.txt']);
  git(repo, ['commit', '-m', 'base']);
  return { repo, baseOid: gitOutput(repo, ['rev-parse', 'HEAD']) };
}

function commitExactFile(repo: string, filePath: string, text: string | Uint8Array, message: string): string {
  mkdirSync(join(repo, filePath, '..'), { recursive: true });
  writeFileSync(join(repo, filePath), text);
  git(repo, ['add', filePath]);
  git(repo, ['commit', '-m', message]);
  return gitOutput(repo, ['rev-parse', 'HEAD']);
}

function validateBuiltExactRange(
  built: Extract<ReturnType<typeof createPublicationExactRangeArtifact>, { ok: true }>,
  lineage: { baseOid: string; remoteOid: string | null; localOid: string },
) {
  return validatePublicationExactRangeArtifact(built.artifact, {
    ...lineage,
    currentToolDigest: currentPublicationToolDigest(),
    currentPolicyDigest: currentPublicationPolicyDigest(),
    expectedPayloadByteLength: built.artifact.binding.payloadByteLength,
    expectedPayloadSha256: built.artifact.binding.payloadSha256,
  });
}

function reboundArtifact(
  built: Extract<ReturnType<typeof createPublicationExactRangeArtifact>, { ok: true }>,
  mutate: (payload: Record<string, unknown>) => void,
) {
  const payload = JSON.parse(Buffer.from(built.artifact.payloadBytes).toString('utf8')) as Record<string, unknown>;
  mutate(payload);
  const payloadBytes = Buffer.from(canonicalizeBoundaryRun(payload), 'utf8');
  const payloadSha256 = payloadDigest(payloadBytes);
  return {
    artifact: {
      payloadBytes: Uint8Array.from(payloadBytes),
      binding: {
        schemaVersion: 1 as const,
        detectorId: 'publication-guard' as const,
        payloadByteLength: payloadBytes.byteLength,
        payloadSha256,
      },
    },
    payloadByteLength: payloadBytes.byteLength,
    payloadSha256,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function installGitShowFailureShim(repo: string): void {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8', env: cleanGitEnv() }).trim();
  const binDir = join(repo, 'fake-bin');
  mkdirSync(binDir);
  const fakeGit = join(binDir, 'git');
  writeFileSync(fakeGit, `#!/usr/bin/env bash
if [[ "$1" == "show" && "$2" == ":0:docs/publication-audit.md" ]]; then
  echo "fatal: simulated object database read failure" >&2
  exit 128
fi
exec ${shellQuote(realGit)} "$@"
`);
  chmodSync(fakeGit, 0o755);
  vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRepo(docText: string, classification: 'PUBLIC' | 'PRIVATE-ARCHIVE'): string {
  const repo = tmp.make('publication-guard');

  mkdirSync(join(repo, 'docs/sdlc/closed/example'), { recursive: true });
  writeFileSync(join(repo, internalDocPath), docText);
  writeFileSync(join(repo, 'docs/publication-audit.md'), `# Publication Audit

**Total classification rows:** 1

| Classification | Count |
|---|---:|
| PUBLIC | ${classification === 'PUBLIC' ? 1 : 0} |
| PRIVATE-ARCHIVE | ${classification === 'PRIVATE-ARCHIVE' ? 1 : 0} |
| SANITIZE | 0 |
| DELETE | 0 |
| Total | 1 |

| Path | Classification | Rationale |
|---|---|---|
| \`${internalDocPath}\` | ${classification} | Fixture row. |
`);

  git(repo, ['init']);
  git(repo, ['add', 'docs/publication-audit.md', internalDocPath]);
  return repo;
}

/** A git repo with ZERO tracked files — the empty/wrong-tree scope the floor must refuse. */
function makeEmptyRepo(): string {
  const repo = tmp.make('publication-guard-empty');
  git(repo, ['init']);
  return repo;
}

describe('publication guard — refuses a whole-tree audit of zero tracked files', () => {
  it('--all is INCONCLUSIVE (exit 2), not a pass, when 0 files are tracked', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runPublicationGuard(['--all'], makeEmptyRepo())).toBe(2);
    expect(error.mock.calls.flat().join(' ')).toMatch(/INCONCLUSIVE/i);
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/passed/i);
  });

  it('--release is INCONCLUSIVE (exit 2) when 0 files are tracked', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runPublicationGuard(['--release'], makeEmptyRepo())).toBe(2);
  });

  it('--staged STILL PASSES (exit 0) on an empty index — diff-scope is exempt from the floor', () => {
    // The highest-risk line of the fix: staged mode scans the commit's ADDED lines, and an
    // empty staged set is a legitimate "nothing to check" (committing with nothing staged is
    // normal, and .husky/pre-commit runs guard:publication:staged). Flooring it would wrongly
    // block every clean commit. This pins that staged is NOT swept up by the whole-tree floor.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runPublicationGuard(['--staged'], makeEmptyRepo())).toBe(0);
    expect(log.mock.calls.flat().join(' ')).toMatch(/passed \(staged\)/i);
  });
});

describe('publication guard release mode', () => {
  it('passes when every tracked internal doc is PUBLIC and private-literal clean', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');

    expect(runPublicationGuard(['--release'], repo)).toBe(0);
  });

  it('fails when a tracked internal doc remains non-PUBLIC', () => {
    const repo = makeRepo('Internal release prep note.\n', 'PRIVATE-ARCHIVE');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--release'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('release-internal-doc-still-tracked');
  });

  it('fails when a PUBLIC row still contains private literals', () => {
    const privatePath = ['/Users', 'privateuser', 'LAB', 'WhatSoup'].join('/');
    const repo = makeRepo(`Operator path: ${privatePath}\n`, 'PUBLIC');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--release'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('local-home-path');
  });
});

describe('publication guard staged mode', () => {
  it('fails when staged internal docs are missing audit classification', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    const newInternalDoc = 'docs/sdlc/closed/example/new-state.md';
    writeFileSync(join(repo, newInternalDoc), 'Internal planning note.\n');
    git(repo, ['add', newInternalDoc]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('staged-internal-doc-unclassified');
  });

  it('fails when staged markdown adds broken docs references', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    const publicDoc = 'docs/readme.md';
    writeFileSync(join(repo, publicDoc), 'See `docs/missing-reference.md` for details.\n');
    git(repo, ['add', publicDoc]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('missing-doc-ref');
  });

  it('fails when staged public text adds private literals', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    const publicDoc = 'docs/public-note.md';
    const token = ['ghp_', 'abcdefghijklmnop'].join('');
    writeFileSync(join(repo, publicDoc), `token: ${token}\n`);
    git(repo, ['add', publicDoc]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('github-token');
  });

  it('reports staged audit read errors separately from missing audit rows', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    installGitShowFailureShim(repo);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('audit-read-failed');
  });

  it('allows shape-preserving synthetic LID fixtures in staged public text', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    const publicDoc = 'docs/public-note.md';
    writeFileSync(join(repo, publicDoc), 'fixture: 81536414179000@lid\n');
    git(repo, ['add', publicDoc]);

    expect(runPublicationGuard(['--staged'], repo)).toBe(0);
  });

  it('ignores inherited hook Git environment when checking synthetic repos', () => {
    const repo = makeRepo('Public-safe release note.\n', 'PUBLIC');
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: cleanGitEnv(),
    }).trim();
    vi.stubEnv('GIT_DIR', gitDir);
    vi.stubEnv('GIT_WORK_TREE', process.cwd());

    expect(runPublicationGuard(['--release'], repo)).toBe(0);
  });
});

describe('publication guard root classification', () => {
  it('classifies docs/runbooks/ files as internal', () => {
    expect(isInternalPublicationPath('docs/runbooks/objective-tracking.md')).toBe(true);
    expect(isInternalPublicationPath('docs/runbooks/host-maintenance.md')).toBe(true);
  });

  it('classifies every docs/triage artifact as an internal publication surface', () => {
    expect(isInternalPublicationPath('docs/triage/README.md')).toBe(true);
    expect(isInternalPublicationPath('docs/triage/open-issue-registry.json')).toBe(true);
    expect(isInternalPublicationPath('docs/triage/plans/batch.json')).toBe(true);
  });

  it('fails staged mode when a docs/runbooks/ file is staged without audit classification', () => {
    const repo = tmp.make('publication-guard-rb');

    mkdirSync(join(repo, 'docs/runbooks'), { recursive: true });
    const runbookPath = 'docs/runbooks/example-runbook.md';
    writeFileSync(join(repo, runbookPath), 'Internal operator runbook.\n');
    writeFileSync(join(repo, 'docs/publication-audit.md'), `# Publication Audit

**Total classification rows:** 0

| Classification | Count |
|---|---:|
| PUBLIC | 0 |
| PRIVATE-ARCHIVE | 0 |
| SANITIZE | 0 |
| DELETE | 0 |
| Total | 0 |

| Path | Classification | Rationale |
|---|---|---|
`);

    git(repo, ['init']);
    git(repo, ['add', runbookPath]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('staged-internal-doc-unclassified');
  });

  it('fails when a new runbook is staged but its audit row is only in the working tree', () => {
    const repo = tmp.make('publication-guard-staged-audit');

    mkdirSync(join(repo, 'docs/runbooks'), { recursive: true });
    const existingRunbook = 'docs/runbooks/existing.md';
    const lines = ['# Publication Audit', '', '**Total classification rows:** 1', '', '| Classification | Count |', '|---|---:|', '| PUBLIC | 0 |', '| PRIVATE-ARCHIVE | 1 |', '| SANITIZE | 0 |', '| DELETE | 0 |', '| Total | 1 |', '', '| Path | Classification | Rationale |', '|---|---|---|', '| `' + existingRunbook + '` | PRIVATE-ARCHIVE | Existing runbook. |', ''];
    const initialAudit = lines.join('\n');

    writeFileSync(join(repo, existingRunbook), 'Existing runbook content.\n');
    writeFileSync(join(repo, 'docs/publication-audit.md'), initialAudit);
    git(repo, ['init']);
    // CI runners have no global git identity; the temp repo must provide one
    // for the baseline commit to succeed.
    git(repo, ['config', 'user.email', 'guard-test@users.noreply.github.com']);
    git(repo, ['config', 'user.name', 'Guard Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    git(repo, ['add', existingRunbook, 'docs/publication-audit.md']);
    git(repo, ['commit', '-m', 'initial']);

    const newRunbook = 'docs/runbooks/new-runbook.md';
    writeFileSync(join(repo, newRunbook), 'New internal runbook.\n');
    git(repo, ['add', newRunbook]);

    const updatedLines = ['# Publication Audit', '', '**Total classification rows:** 2', '', '| Classification | Count |', '|---|---:|', '| PUBLIC | 0 |', '| PRIVATE-ARCHIVE | 2 |', '| SANITIZE | 0 |', '| DELETE | 0 |', '| Total | 2 |', '', '| Path | Classification | Rationale |', '|---|---|---|', '| `' + existingRunbook + '` | PRIVATE-ARCHIVE | Existing runbook. |', '| `' + newRunbook + '` | PRIVATE-ARCHIVE | New runbook. |', ''];
    writeFileSync(join(repo, 'docs/publication-audit.md'), updatedLines.join('\n'));

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runPublicationGuard(['--staged'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('staged-internal-doc-unclassified');
  });
});

describe('publication audit root list drift pin', () => {
  it('docs/publication-audit.md prose root list has an exemplar for every internalPublicationRoots pattern', () => {
    const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
    const auditText = readFileSync(join(repoRoot, 'docs/publication-audit.md'), 'utf8');
    const proseLine =
      auditText.split('\n').find((line) => line.includes('Internal publication roots covered by the guard:')) ?? '';
    // Extract backtick-quoted tokens from the prose line using index-based split.
    // (Avoids backtick-inside-regex that confuses tree-sitter paren matching.)
    const proseTokens: string[] = proseLine.split('`').filter((_, i) => i % 2 === 1);

    // Build exemplar paths from each prose token.
    // For directory roots (ends with /): append an example file path.
    // For glob patterns (contains *): replace * with empty or a concrete value.
    // For exact file refs: use as-is.
    const exemplars: string[] = [];
    for (const token of proseTokens) {
      const baseExact = token.replace(/\*([^*]*)$/, '$1').replace(/\/$/, '');
      const baseFilled = token.replace(/\*([^*]*)$/, 'example$1').replace(/\/$/, '');
      exemplars.push(
        baseExact, baseExact + '/example.md', baseExact + '/sub/file.md', baseExact + '.md', baseExact + '.json',
        baseFilled, baseFilled + '/example.md', baseFilled + '/sub/file.md', baseFilled + '.md', baseFilled + '.json',
      );
    }

    const missingPatterns: string[] = [];
    for (const pattern of internalPublicationRoots) {
      let covered = false;
      for (const c of exemplars) {
        if (pattern.test(c)) {
          covered = true;
          break;
        }
      }
      if (!covered) missingPatterns.push(String(pattern));
    }

    expect(missingPatterns).toEqual([]);
  });
});

describe('publication guard tilde-relative home paths', () => {
  it('flags tilde-relative operator home paths the same way as absolute home paths', () => {
    // Compose literals via join so this test source carries no flaggable path
    // of its own (the commit runs the staged guard over these added lines).
    const labPath = ['~', 'LAB', 'WhatSoup'].join('/');
    expect(
      scanTextForPrivateLiterals('docs/public-note.md', `Operator checkout: ${labPath}`).map((issue) => issue.code),
    ).toEqual(['local-home-path']);

    // A workspace dir that is not a standard OS/XDG dot-dir also identifies.
    const docsPath = ['~', 'Projects', 'secret-thing'].join('/');
    expect(
      scanTextForPrivateLiterals('docs/public-note.md', `Repo: ${docsPath}`).map((issue) => issue.code),
    ).toEqual(['local-home-path']);
  });

  it('DROPS non-identifying tilde dot-dirs and ~/Library (precision — 2026-07-20)', () => {
    // Precision change (Q rounds 7-8): the standard XDG/OS dot-dirs and Library
    // identify nobody — `~` already hides the username — and were ~85% of the
    // sweep noise. A mostly-noise gate trains bypass, so these are dropped. This
    // is a reasoned blocklist exception: a hygiene signal, not a secrets gate.
    for (const seg of ['.config', '.local', '.claude', '.ssh', '.cache', 'Library']) {
      const dotPath = ['~', seg, 'whatsoup'].join('/');
      expect(
        scanTextForPrivateLiterals('docs/public-note.md', `Path: ${dotPath}`),
        `~/${seg}/... should not flag`,
      ).toEqual([]);
    }
  });

  it('allows tilde paths whose first segment is on the shared allowlist (symmetry with the absolute rule)', () => {
    const deployUserPath = ['~', 'whatsoup', 'instances'].join('/');
    expect(scanTextForPrivateLiterals('docs/public-note.md', `Deploy user path: ${deployUserPath}`)).toEqual([]);

    const runnerPath = ['~', 'runner', 'work'].join('/');
    expect(scanTextForPrivateLiterals('docs/public-note.md', `CI path: ${runnerPath}`)).toEqual([]);
  });

  it('does not match a bare tilde used as prose', () => {
    expect(scanTextForPrivateLiterals('docs/public-note.md', 'takes ~ 5 minutes to run')).toEqual([]);
  });

  it('flags absolute /Users/<name> and /home/<name> operator paths', () => {
    for (const root of ['Users', 'home']) {
      const p = ['', root, 'lucas', 'LAB'].join('/');
      expect(
        scanTextForPrivateLiterals('docs/public-note.md', `Checkout: ${p}`).map((i) => i.code),
        `/${root}/lucas should flag`,
      ).toEqual(['local-home-path']);
    }
  });

  it('prefix-leak: /home/runner is allowlisted but /home/runnerX flags (full-segment allowlist)', () => {
    // allowlist-inside-blocklist filters leak exactly here: a substring allow
    // for "runner" must not also whitelist "runnerX", a real operator path.
    const allow = ['', 'home', 'runner', 'work'].join('/');
    expect(scanTextForPrivateLiterals('docs/public-note.md', `CI: ${allow}`)).toEqual([]);

    const leak = ['', 'home', 'runnerX', 'work'].join('/');
    expect(
      scanTextForPrivateLiterals('docs/public-note.md', `Not CI: ${leak}`).map((i) => i.code),
    ).toEqual(['local-home-path']);
  });

  it('fails release mode when a PUBLIC doc contains a tilde-relative operator home path', () => {
    const tildePath = ['~', 'LAB', 'WhatSoup'].join('/');
    const repo = makeRepo(`Operator path: ${tildePath}\n`, 'PUBLIC');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(runPublicationGuard(['--release'], repo)).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('local-home-path');
  });
});

describe('publication guard operational allowlist', () => {
  it('allows the exact GitHub SSH transport principal without allowing a real mailbox', () => {
    const sshPrincipal = ['git', 'github.com'].join('@');
    expect(
      scanTextForPrivateLiterals(
        '.github/workflows/quality.yml',
        `git remote add origin ${sshPrincipal}:LucasQuiles/test-integrity.git`,
      ),
    ).toEqual([]);

    const githubMailbox = ['operator', 'github.com'].join('@');
    expect(
      scanTextForPrivateLiterals('.github/workflows/quality.yml', `contact ${githubMailbox}`),
    ).toMatchObject([{ code: 'personal-email' }]);

    const realAddress = ['operator', 'company.dev'].join('@');
    const mixedLine = scanTextForPrivateLiterals(
      '.github/workflows/quality.yml',
      `${sshPrincipal}:LucasQuiles/test-integrity.git contact ${githubMailbox}`,
    );
    expect(mixedLine.map((issue) => issue.code)).toEqual(['personal-email']);

    expect(
      scanTextForPrivateLiterals('.github/workflows/quality.yml', `contact ${realAddress}`),
    ).toMatchObject([{ code: 'personal-email' }]);
  });

  it('allows template-unit tokens only in operational fleet files, never alongside a real address', () => {
    // Composed so the test source itself carries no email-shaped literal.
    const personalUnit = ['whatsoup@personal', 'service'].join('.');
    expect(scanTextForPrivateLiterals('deploy/health-profiles/nucles.json', `"service": "${personalUnit}"`)).toEqual(
      [],
    );

    const flaggedElsewhere = scanTextForPrivateLiterals(
      'deploy/health-profiles/mini1.json',
      `"service": "${personalUnit}"`,
    );
    expect(flaggedElsewhere.map((issue) => issue.code)).toEqual(['personal-email']);

    const realAddress = ['operator', 'example.com'].join('@');
    const mixedLine = scanTextForPrivateLiterals(
      'deploy/health-profiles/nucles.json',
      `"service": "${personalUnit}" contact ${realAddress}`,
    );
    expect(mixedLine.map((issue) => issue.code)).toEqual(['personal-email']);
  });
});

// Subprocess-heavy fixture repos brush the global 10s budget under host load
// (observed as pure timeouts with every assertion green); 30s keeps the local
// push gate deterministic without weakening any check.
describe('publication guard exact-range native receipt', { timeout: 30_000 }, () => {
  it('scans the exact outgoing OID rather than a safe ambient HEAD and validates the external byte binding', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const token = ['ghp_', 'abcdefghijklmnop'].join('');
    writeFileSync(join(repo, 'note.txt'), `token: ${token}\n`);
    git(repo, ['add', 'note.txt']);
    git(repo, ['commit', '-m', 'unsafe outgoing']);
    const localOid = gitOutput(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '--detach', baseOid]);

    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const validated = validatePublicationExactRangeArtifact(built.artifact, {
      baseOid,
      remoteOid: null,
      localOid,
      currentToolDigest: currentPublicationToolDigest(),
      currentPolicyDigest: currentPublicationPolicyDigest(),
      expectedPayloadByteLength: built.artifact.binding.payloadByteLength,
      expectedPayloadSha256: built.artifact.binding.payloadSha256,
    });

    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.receipt.outcome).toBe('block');
    expect(validated.receipt.nativeCauses).toEqual(['github-token']);
    expect(validated.receipt.findings).toEqual([
      expect.objectContaining({
        cause: 'github-token',
        observationKind: 'net-added-line',
        commitOid: localOid,
        parentOid: baseOid,
        path: null,
        pathDisclosure: 'redacted',
      }),
    ]);
    expect(Buffer.from(built.artifact.payloadBytes).toString('utf8')).not.toContain(token);
    expect(canonicalPublicationToolProjection()).toContain('publication-guard.ts');
    expect(canonicalPublicationPolicyProjection()).toContain('github-token');
  });

  it('reports all nine canonical private-literal causes from one exact outgoing commit', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const rows = [
      ['operator', 'privatecorp.net'].join('@'),
      ['', 'Users', 'privateperson', 'project'].join('/'),
      ['120363123456', 'g.us'].join('@'),
      ['12345678', 's.whatsapp.net'].join('@'),
      ['ghp_', 'abcdefghijklmnop'].join(''),
      ['sk-', 'abcdefghijklmnop'].join(''),
      ['pcsk_', 'abcdefghijkl'].join(''),
      ['xoxb-', 'abcdefghijkl'].join(''),
      ['BEGIN ', 'PRIVATE KEY'].join(''),
    ];
    const localOid = commitExactFile(repo, 'private.txt', `${rows.join('\n')}\n`, 'all causes');
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const validated = validateBuiltExactRange(built, { baseOid, remoteOid: null, localOid });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.receipt.nativeCauses).toEqual([
      'github-token',
      'local-home-path',
      'openai-key',
      'personal-email',
      'pinecone-key',
      'private-key',
      'slack-token',
      'whatsapp-group-jid',
      'whatsapp-user-jid',
    ]);
    expect(validated.receipt.findings).toHaveLength(9);
  });

  it('finds a private literal added and removed within the outgoing history', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const token = ['sk-', 'abcdefghijklmnop'].join('');
    commitExactFile(repo, 'transient.txt', `${token}\n`, 'add transient value');
    const localOid = commitExactFile(repo, 'transient.txt', 'public-safe\n', 'remove transient value');
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const validated = validateBuiltExactRange(built, { baseOid, remoteOid: null, localOid });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.receipt.nativeCauses).toEqual(['openai-key']);
    expect(validated.receipt.findings[0]?.observationKind).toBe('history-added-line');
    expect(validated.receipt.budget.consumed.changeCount).toBeGreaterThan(1);
    for (const key of Object.keys(validated.receipt.budget.limit) as Array<keyof typeof validated.receipt.budget.limit>) {
      expect(validated.receipt.budget.consumed[key] + validated.receipt.budget.remaining[key]).toBe(
        validated.receipt.budget.limit[key],
      );
    }
  });

  it('suppresses only the same exact baseline path and text', () => {
    const { repo, baseOid: initialOid } = makeExactRangeRepo();
    const token = ['pcsk_', 'abcdefghijkl'].join('');
    const baseOid = commitExactFile(repo, 'baseline.txt', `${token}\n`, 'baseline contains value');
    commitExactFile(repo, 'baseline.txt', 'public-safe\n', 'remove baseline value');
    const samePathLocal = commitExactFile(repo, 'baseline.txt', `${token}\n`, 'restore baseline value');
    const samePath = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid: samePathLocal });
    expect(samePath.ok).toBe(true);
    if (samePath.ok) {
      const validated = validateBuiltExactRange(samePath, { baseOid, remoteOid: null, localOid: samePathLocal });
      expect(validated.ok && validated.receipt.outcome).toBe('pass');
    }

    git(repo, ['checkout', '--detach', baseOid]);
    commitExactFile(repo, 'other.txt', `${token}\n`, 'copy value to different path');
    const differentPathLocal = commitExactFile(repo, 'other.txt', 'public-safe\n', 'remove copied value');
    const differentPath = createPublicationExactRangeArtifact(repo, {
      baseOid,
      remoteOid: null,
      localOid: differentPathLocal,
    });
    expect(differentPath.ok).toBe(true);
    if (differentPath.ok) {
      const validated = validateBuiltExactRange(differentPath, {
        baseOid,
        remoteOid: null,
        localOid: differentPathLocal,
      });
      expect(validated.ok && validated.receipt.outcome).toBe('block');
      expect(validated.ok && validated.receipt.nativeCauses).toEqual(['pinecone-key']);
    }
    expect(initialOid).not.toBe(baseOid);
  });

  // This deliberately creates six isolated Git repositories; allow bounded
  // process-scheduling headroom when the full publication suite is concurrent.
  it('scans pure and modified copy/rename path transitions while preserving safe neighbors', () => {
    const token = ['sk-', 'abcdefghijklmnop'].join('');

    const copyRepo = makeExactRangeRepo();
    const copyBase = commitExactFile(copyRepo.repo, 'source.txt', `${token}\n`, 'copy baseline');
    writeFileSync(join(copyRepo.repo, 'copied.txt'), `${token}\n`);
    git(copyRepo.repo, ['add', 'copied.txt']);
    git(copyRepo.repo, ['commit', '-m', 'pure copy']);
    const copyLocal = gitOutput(copyRepo.repo, ['rev-parse', 'HEAD']);
    const copy = createPublicationExactRangeArtifact(copyRepo.repo, {
      baseOid: copyBase,
      remoteOid: null,
      localOid: copyLocal,
    });
    expect(copy.ok).toBe(true);
    if (copy.ok) {
      const validated = validateBuiltExactRange(copy, { baseOid: copyBase, remoteOid: null, localOid: copyLocal });
      expect(validated.ok && validated.receipt.outcome).toBe('block');
      expect(validated.ok && validated.receipt.nativeCauses).toEqual(['openai-key']);
    }

    const modifiedCopyRepo = makeExactRangeRepo();
    const modifiedCopyBase = commitExactFile(
      modifiedCopyRepo.repo,
      'copy-source.txt',
      `${token}\nold safe line\n`,
      'modified copy baseline',
    );
    writeFileSync(join(modifiedCopyRepo.repo, 'copy-target.txt'), `${token}\nnew safe line\n`);
    git(modifiedCopyRepo.repo, ['add', 'copy-target.txt']);
    git(modifiedCopyRepo.repo, ['commit', '-m', 'modified copy']);
    const modifiedCopyLocal = gitOutput(modifiedCopyRepo.repo, ['rev-parse', 'HEAD']);
    const modifiedCopy = createPublicationExactRangeArtifact(modifiedCopyRepo.repo, {
      baseOid: modifiedCopyBase,
      remoteOid: null,
      localOid: modifiedCopyLocal,
    });
    expect(modifiedCopy.ok).toBe(true);
    if (modifiedCopy.ok) {
      const validated = validateBuiltExactRange(modifiedCopy, {
        baseOid: modifiedCopyBase,
        remoteOid: null,
        localOid: modifiedCopyLocal,
      });
      expect(validated.ok && validated.receipt.outcome).toBe('block');
      expect(validated.ok && validated.receipt.nativeCauses).toEqual(['openai-key']);
    }

    const renameRepo = makeExactRangeRepo();
    const renameBase = commitExactFile(renameRepo.repo, 'old.txt', `${token}\n`, 'rename baseline');
    git(renameRepo.repo, ['mv', 'old.txt', 'renamed.txt']);
    git(renameRepo.repo, ['commit', '-m', 'pure rename']);
    const renameLocal = gitOutput(renameRepo.repo, ['rev-parse', 'HEAD']);
    const rename = createPublicationExactRangeArtifact(renameRepo.repo, {
      baseOid: renameBase,
      remoteOid: null,
      localOid: renameLocal,
    });
    expect(rename.ok).toBe(true);
    if (rename.ok) {
      const validated = validateBuiltExactRange(rename, {
        baseOid: renameBase,
        remoteOid: null,
        localOid: renameLocal,
      });
      expect(validated.ok && validated.receipt.outcome).toBe('block');
    }

    const modifiedRepo = makeExactRangeRepo();
    const modifiedBase = commitExactFile(modifiedRepo.repo, 'before.txt', `${token}\nold safe line\n`, 'modified baseline');
    git(modifiedRepo.repo, ['mv', 'before.txt', 'after.txt']);
    writeFileSync(join(modifiedRepo.repo, 'after.txt'), `${token}\nnew safe line\n`);
    git(modifiedRepo.repo, ['add', 'after.txt']);
    git(modifiedRepo.repo, ['commit', '-m', 'modified rename']);
    const modifiedLocal = gitOutput(modifiedRepo.repo, ['rev-parse', 'HEAD']);
    const modified = createPublicationExactRangeArtifact(modifiedRepo.repo, {
      baseOid: modifiedBase,
      remoteOid: null,
      localOid: modifiedLocal,
    });
    expect(modified.ok).toBe(true);
    if (modified.ok) {
      const validated = validateBuiltExactRange(modified, {
        baseOid: modifiedBase,
        remoteOid: null,
        localOid: modifiedLocal,
      });
      expect(validated.ok && validated.receipt.outcome).toBe('block');
      expect(validated.ok && validated.receipt.nativeCauses).toEqual(['openai-key']);
    }

    const safeRepo = makeExactRangeRepo();
    const safeBase = commitExactFile(safeRepo.repo, 'safe-old.txt', 'public-safe\n', 'safe rename baseline');
    git(safeRepo.repo, ['mv', 'safe-old.txt', 'safe-new.txt']);
    git(safeRepo.repo, ['commit', '-m', 'safe rename']);
    const safeLocal = gitOutput(safeRepo.repo, ['rev-parse', 'HEAD']);
    const safe = createPublicationExactRangeArtifact(safeRepo.repo, {
      baseOid: safeBase,
      remoteOid: null,
      localOid: safeLocal,
    });
    expect(safe.ok).toBe(true);
    if (safe.ok) {
      const validated = validateBuiltExactRange(safe, { baseOid: safeBase, remoteOid: null, localOid: safeLocal });
      expect(validated.ok && validated.receipt.outcome).toBe('pass');
    }

    const safeCopyRepo = makeExactRangeRepo();
    const safeCopyBase = commitExactFile(safeCopyRepo.repo, 'safe-source.txt', 'public-safe\n', 'safe copy baseline');
    writeFileSync(join(safeCopyRepo.repo, 'safe-copy.txt'), 'public-safe\n');
    git(safeCopyRepo.repo, ['add', 'safe-copy.txt']);
    git(safeCopyRepo.repo, ['commit', '-m', 'safe pure copy']);
    const safeCopyLocal = gitOutput(safeCopyRepo.repo, ['rev-parse', 'HEAD']);
    const safeCopy = createPublicationExactRangeArtifact(safeCopyRepo.repo, {
      baseOid: safeCopyBase,
      remoteOid: null,
      localOid: safeCopyLocal,
    });
    expect(safeCopy.ok).toBe(true);
    if (safeCopy.ok) {
      const validated = validateBuiltExactRange(safeCopy, {
        baseOid: safeCopyBase,
        remoteOid: null,
        localOid: safeCopyLocal,
      });
      expect(validated.ok && validated.receipt.outcome).toBe('pass');
      expect(validated.ok && validated.receipt.nativeCauses).toEqual([]);
    }
  }, 30_000);

  it('aligns the path-transition byte boundary with the shared exact blob reader', () => {
    expect(MAX_PUBLICATION_PATH_TRANSITION_BLOB_BYTES).toBe(MAX_EXACT_SINGLE_BLOB_BYTES);
    const token = ['sk-', 'abcdefghijklmnop'].join('');
    const makeTransition = (byteLength: number) => {
      const fixture = makeExactRangeRepo();
      const content = `${token}\n${'a'.repeat(byteLength - Buffer.byteLength(token, 'utf8') - 2)}\n`;
      expect(Buffer.byteLength(content, 'utf8')).toBe(byteLength);
      const baseOid = commitExactFile(fixture.repo, 'old.txt', content, 'transition bound baseline');
      git(fixture.repo, ['mv', 'old.txt', 'new.txt']);
      git(fixture.repo, ['commit', '-m', 'bounded transition']);
      return { repo: fixture.repo, baseOid, localOid: gitOutput(fixture.repo, ['rev-parse', 'HEAD']) };
    };

    const exact = makeTransition(MAX_PUBLICATION_PATH_TRANSITION_BLOB_BYTES);
    const exactBuilt = createPublicationExactRangeArtifact(exact.repo, {
      baseOid: exact.baseOid,
      remoteOid: null,
      localOid: exact.localOid,
    });
    expect(exactBuilt.ok).toBe(true);
    if (exactBuilt.ok) {
      const validated = validateBuiltExactRange(exactBuilt, {
        baseOid: exact.baseOid,
        remoteOid: null,
        localOid: exact.localOid,
      });
      expect(validated.ok && validated.receipt.outcome).toBe('block');
    }

    const over = makeTransition(MAX_PUBLICATION_PATH_TRANSITION_BLOB_BYTES + 1);
    const overBuilt = createPublicationExactRangeArtifact(over.repo, {
      baseOid: over.baseOid,
      remoteOid: null,
      localOid: over.localOid,
    });
    expect(overBuilt).toEqual({ ok: false, error: { code: 'publication.exact-range.budget' } });
    expect('artifact' in overBuilt).toBe(false);
  });

  it('aligns the baseline byte boundary with the shared exact blob reader', () => {
    expect(MAX_PUBLICATION_BASELINE_BLOB_BYTES).toBe(MAX_EXACT_SINGLE_BLOB_BYTES);
    const token = ['pcsk_', 'abcdefghijkl'].join('');
    const run = (byteLength: number) => {
      const fixture = makeExactRangeRepo();
      const prefix = `${token}\n`;
      const tailByteLength = byteLength - Buffer.byteLength(prefix, 'utf8');
      const boundedRow = `${'b'.repeat(255)}\n`;
      const tail = boundedRow.repeat(Math.floor(tailByteLength / 256)) + 'b'.repeat(tailByteLength % 256);
      const content = `${prefix}${tail}`;
      expect(Buffer.byteLength(content, 'utf8')).toBe(byteLength);
      const baseOid = commitExactFile(fixture.repo, 'baseline.txt', content, 'baseline bound');
      commitExactFile(fixture.repo, 'baseline.txt', `public-safe\n${tail}`, 'remove bounded baseline token');
      const localOid = commitExactFile(fixture.repo, 'baseline.txt', content, 'restore bounded baseline token');
      return {
        built: createPublicationExactRangeArtifact(fixture.repo, { baseOid, remoteOid: null, localOid }),
        baseOid,
        localOid,
      };
    };

    const exact = run(MAX_PUBLICATION_BASELINE_BLOB_BYTES);
    expect(exact.built).toMatchObject({ ok: true });
    if (exact.built.ok) {
      const validated = validateBuiltExactRange(exact.built, {
        baseOid: exact.baseOid,
        remoteOid: null,
        localOid: exact.localOid,
      });
      expect(validated.ok && validated.receipt.outcome).toBe('pass');
    }

    const over = run(MAX_PUBLICATION_BASELINE_BLOB_BYTES + 1);
    expect(over.built).toEqual({ ok: false, error: { code: 'publication.exact-range.budget' } });
    expect('artifact' in over.built).toBe(false);
  });

  it('reuses one bounded baseline value set when many paths share the same blob', () => {
    const { repo } = makeExactRangeRepo();
    const token = ['pcsk_', 'abcdefghijkl'].join('');
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(join(repo, `shared-${index}.txt`), `${token}\n`);
    }
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'shared blob baseline']);
    const baseOid = gitOutput(repo, ['rev-parse', 'HEAD']);
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(join(repo, `shared-${index}.txt`), 'public-safe\n');
    }
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'remove shared baseline values']);
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(join(repo, `shared-${index}.txt`), `${token}\n`);
    }
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'restore shared baseline values']);
    const localOid = gitOutput(repo, ['rev-parse', 'HEAD']);
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const validated = validateBuiltExactRange(built, { baseOid, remoteOid: null, localOid });
    expect(validated.ok && validated.receipt.outcome).toBe('pass');
  });

  it('uses remoteOid as the exact range start and does not rescan earlier history', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const token = ['xoxb-', 'abcdefghijkl'].join('');
    const remoteOid = commitExactFile(repo, 'prior.txt', `${token}\n`, 'prior remote value');
    const localOid = commitExactFile(repo, 'note.txt', 'later public-safe\n', 'later safe change');
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const validated = validateBuiltExactRange(built, { baseOid, remoteOid, localOid });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.receipt.rangeStartOid).toBe(remoteOid);
    expect(validated.receipt.outcome).toBe('pass');
  });

  it('keeps sensitive-artifact, audit, release-classification, and markdown-reference policy outside this receipt', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const localOid = commitExactFile(
      repo,
      '.env.fixture',
      'PUBLIC_EXAMPLE=value\nSee docs/missing-reference.md\n',
      'non-private scoped content',
    );
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const validated = validateBuiltExactRange(built, { baseOid, remoteOid: null, localOid });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.receipt.outcome).toBe('pass');
    expect(validated.receipt.claimedScope).toEqual({
      content: 'net-range-private-literal-additions',
      history: 'per-parent-private-literal-additions',
      paths: 'all-redacted',
    });
    expect(validated.receipt.limitations).toEqual([
      'aggregate-authorization-unavailable',
      'changed-content-only',
      'executor-platform-unavailable',
      'finding-fingerprint-unavailable',
      'markdown-reference-validation-unavailable',
      'precondition-receipt-unavailable',
      'producer-authentication-unavailable',
      'publication-audit-validation-unavailable',
      'release-classification-unavailable',
      'report-only',
      'terminal-attempt-process-group-unavailable',
      'workspace-ignored-document-observation-unavailable',
    ]);
    expect(validated.receipt.nativeCauses).toEqual([]);
    expect(validated.receipt.findings).toEqual([]);
  });

  it('redacts raw paths, matched values, and their unkeyed hashes from every public byte', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const rawPath = 'private/location/operator-note.txt';
    const token = ['ghp_', 'ponmlkjihgfedcba'].join('');
    const localOid = commitExactFile(repo, rawPath, `${token}\n`, 'redaction fixture');
    const rawBlobOid = gitOutput(repo, ['rev-parse', `${localOid}:${rawPath}`]);
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const publicBytes = Buffer.from(built.artifact.payloadBytes).toString('utf8');
    for (const forbidden of [
      rawPath,
      token,
      createHash('sha256').update(rawPath).digest('hex'),
      createHash('sha256').update(token).digest('hex'),
      rawBlobOid,
      createHash('sha256').update(rawBlobOid).digest('hex'),
    ]) expect(publicBytes).not.toContain(forbidden);
    const validated = validateBuiltExactRange(built, { baseOid, remoteOid: null, localOid });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.receipt.findings.every((finding) => finding.path === null)).toBe(true);
    expect(validated.receipt.findings.every((finding) => finding.blob === null)).toBe(true);
    expect(validated.receipt.findings.every((finding) => finding.blobDisclosure === 'redacted')).toBe(true);
    expect(validated.receipt.observedPathDisclosure).toBe('all-redacted');
    expect(validated.receipt.observedPathDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(validated.receipt.observedBlobDisclosure).toBe('all-redacted');
    expect(validated.receipt.observedBlobCount).toBeGreaterThan(0);
    expect(validated.receipt.observedBlobDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('binds independently reproducible tool and policy projections', () => {
    const independent = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
    expect(currentPublicationToolDigest()).toBe(independent(canonicalPublicationToolProjection()));
    expect(currentPublicationPolicyDigest()).toBe(independent(canonicalPublicationPolicyProjection()));
    const tools = JSON.parse(canonicalPublicationToolProjection()) as {
      sources: Array<{ id: string; byteLength: number; sha256: string }>;
    };
    expect(tools.sources.map((source) => source.id)).toEqual([
      'publication-guard.ts',
      'git-input-core.ts',
      'git-input.ts',
      'exact-range-provenance.ts',
      'guard-core.ts',
      'boundary-run/shared.ts',
      'boundary-run/schema.ts',
      'boundary-run/contracts.ts',
      'boundary-run/model.ts',
      'boundary-run/worktree.ts',
      'src/lib/git-env.ts',
      'src/lib/type-guards.ts',
    ]);
    const sourcePaths = new Map([
      ['publication-guard.ts', 'scripts/publication-guard.ts'],
      ['git-input-core.ts', 'scripts/lib/ci-control/git-input-core.ts'],
      ['git-input.ts', 'scripts/lib/ci-control/git-input.ts'],
      ['exact-range-provenance.ts', 'scripts/lib/ci-control/exact-range-provenance.ts'],
      ['guard-core.ts', 'scripts/lib/guard-core.ts'],
      ['boundary-run/shared.ts', 'scripts/lib/verification/boundary-run/shared.ts'],
      ['boundary-run/schema.ts', 'scripts/lib/verification/boundary-run/schema.ts'],
      ['boundary-run/contracts.ts', 'scripts/lib/verification/boundary-run/contracts.ts'],
      ['boundary-run/model.ts', 'scripts/lib/verification/boundary-run/model.ts'],
      ['boundary-run/worktree.ts', 'scripts/lib/verification/boundary-run/worktree.ts'],
      ['src/lib/git-env.ts', 'src/lib/git-env.ts'],
      ['src/lib/type-guards.ts', 'src/lib/type-guards.ts'],
    ]);
    for (const source of tools.sources) {
      const relativePath = sourcePaths.get(source.id);
      expect(relativePath).toBeDefined();
      const bytes = readFileSync(resolve(process.cwd(), relativePath!));
      expect(source).toEqual({
        id: source.id,
        byteLength: bytes.byteLength,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      });
    }
    const policy = JSON.parse(canonicalPublicationPolicyProjection()) as {
      guardCoreDigest: string;
      historyPolicy: { baselineSuppression: string };
      liveRouteCoverage: string[];
      materializationBudget: Record<string, number>;
      liveRouteImplementations: Record<string, string>;
    };
    const guardCoreBytes = readFileSync(resolve(process.cwd(), 'scripts/lib/guard-core.ts'));
    expect(policy.guardCoreDigest).toBe(`sha256:${createHash('sha256').update(guardCoreBytes).digest('hex')}`);
    expect(policy.historyPolicy.baselineSuppression).toBe('range-start-same-path-exact-text');
    expect(publicationPolicyProjectionCoverage()).toEqual([
      'baseline-materialization-budget',
      'baseline-same-path-exact-text',
      'documentation-email-exception-routing',
      'is-text-candidate-routing',
      'normalize-repo-path-routing',
      'operational-identifier-exception-routing',
      'path-transition-entire-new-blob',
      'private-pattern-catalog',
      'scan-text-for-private-literals',
    ]);
    expect(policy.liveRouteCoverage).toEqual(publicationPolicyProjectionCoverage());
    expect(policy.materializationBudget).toEqual({
      baselineAggregateBlobBytes: MAX_EXACT_AGGREGATE_BLOB_BYTES,
      baselineAggregateLines: 200_000,
      baselineSingleBlobBytes: MAX_EXACT_SINGLE_BLOB_BYTES,
      baselineSingleBlobLines: 100_000,
      pathTransitionSingleBlobBytes: MAX_EXACT_SINGLE_BLOB_BYTES,
      pathTransitionSingleBlobLines: 100_000,
    });
    expect(Object.keys(policy.liveRouteImplementations).sort()).toEqual([
      'baselineMaterialization',
      'blobLineCount',
      'blobTextByteCount',
      'documentationEmailException',
      'isTextCandidate',
      'normalizeRepoPath',
      'operationalIdentifierException',
      'pathTransitionRouting',
      'preflightBlob',
      'scanTextForPrivateLiterals',
    ]);
    const bodyFragments: Record<string, string[]> = {
      baselineMaterialization: ['publicationBaseLineSets', 'lineSetsByOid.set', 'result.set(entry.path, lines)'],
      blobLineCount: ['publicationBlobLineCount', 'bytes[bytes.byteLength - 1] === 10', 'for (const byte of bytes)'],
      blobTextByteCount: ['publicationBlobTextByteCount', 'bytes[index] === 13', 'bytes[index + 1] === 10'],
      documentationEmailException: ['isAllowedNonMailboxEmailLine', 'tokens.every', 'isDocumentationEmailFixture'],
      isTextCandidate: ['isTextCandidate', 'const baseName', 'baseName.startsWith', 'textExtensions.has'],
      normalizeRepoPath: ['normalizeRepoPath', 'filePath.split', '.join', '.replace'],
      operationalIdentifierException: ['isOperationalUnitLine', 'operationalReleaseHygieneFiles.has', 'isOperationalProtocolToken'],
      pathTransitionRouting: ['publicationPathTransitionLinesWithinBudget', 'primitiveLines.set', 'rows.map'],
      preflightBlob: ['preflightPublicationBlob', 'bytes.byteLength > maxBytes', 'publicationBlobLineCount(bytes)'],
      scanTextForPrivateLiterals: ['scanTextForPrivateLiterals', 'privatePatterns', 'issues.push'],
    };
    for (const [implementation, fragments] of Object.entries(bodyFragments)) {
      for (const fragment of fragments) {
        expect(policy.liveRouteImplementations[implementation], `${implementation}: ${fragment}`).toContain(fragment);
      }
    }
  });

  it('coalesces identical redacted public projections without losing raw-path accounting', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const token = ['ghp_', 'abcdefghijklmnoq'].join('');
    const content = `${token}\n`;
    writeFileSync(join(repo, 'first.txt'), content);
    writeFileSync(join(repo, 'second.txt'), content);
    git(repo, ['add', 'first.txt', 'second.txt']);
    git(repo, ['commit', '-m', 'same finding on two redacted paths']);
    const localOid = gitOutput(repo, ['rev-parse', 'HEAD']);
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const validated = validateBuiltExactRange(built, { baseOid, remoteOid: null, localOid });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.receipt.findings).toHaveLength(1);
    expect(validated.receipt.observedScope.observedPathCount).toBe(2);
    expect(validated.receipt.observedPathDigest).toBe(
      `sha256:${createHash('sha256').update(canonicalizeBoundaryRun({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: 2,
      })).digest('hex')}`,
    );
  });

  it('fails closed before accumulating more than 4096 raw private-literal candidates', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const token = ['ghp_', 'abcdefghijklmnop'].join('');
    for (let index = 0; index < 2_048; index += 1) {
      writeFileSync(join(repo, `same-${index}.txt`), `${token}\n${token}\n`);
    }
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'raw candidate overflow']);
    const localOid = gitOutput(repo, ['rev-parse', 'HEAD']);
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built).toEqual({ ok: false, error: { code: 'publication.exact-range.budget' } });
    expect('artifact' in built).toBe(false);
  });

  it('fails closed when net and parent edges fit separately but exceed the shared cumulative ledger', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const rows = (prefix: string) => Array.from({ length: 40_000 }, (_, index) => `${prefix}-${index}`).join('\n') + '\n';
    commitExactFile(repo, 'large.txt', rows('first'), 'first individually bounded edge');
    const localOid = commitExactFile(repo, 'large.txt', rows('second'), 'second individually bounded edge');
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built).toEqual({ ok: false, error: { code: 'publication.exact-range.budget' } });
    expect('artifact' in built).toBe(false);
  });

  it('fails closed when history baseline suppression would require more than 64 paths', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const token = ['pcsk_', 'abcdefghijkl'].join('');
    for (let index = 0; index < 65; index += 1) {
      writeFileSync(join(repo, `candidate-${index}.txt`), `${token}\n`);
    }
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'add many private candidates']);
    for (let index = 0; index < 65; index += 1) {
      writeFileSync(join(repo, `candidate-${index}.txt`), 'public-safe\n');
    }
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'remove many private candidates']);
    const localOid = gitOutput(repo, ['rev-parse', 'HEAD']);
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built).toEqual({ ok: false, error: { code: 'publication.exact-range.budget' } });
    expect('artifact' in built).toBe(false);
  });

  it('rejects a rebound payload after the original byte binding was frozen', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const localOid = commitExactFile(repo, 'note.txt', 'changed public-safe\n', 'safe change');
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const originalLength = built.artifact.binding.payloadByteLength;
    const originalSha = built.artifact.binding.payloadSha256;
    const rebound = reboundArtifact(built, (payload) => {
      payload.outcome = 'block';
    });
    const result = validatePublicationExactRangeArtifact(rebound.artifact, {
      baseOid,
      remoteOid: null,
      localOid,
      currentToolDigest: currentPublicationToolDigest(),
      currentPolicyDigest: currentPublicationPolicyDigest(),
      expectedPayloadByteLength: originalLength,
      expectedPayloadSha256: originalSha,
    });
    expect(result).toEqual({ ok: false, error: { code: 'publication.exact-range.receipt-binding-mismatch' } });
  });

  it('rejects an actual one-byte payload mutation against its frozen binding', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const localOid = commitExactFile(repo, 'note.txt', 'one-byte public-safe\n', 'one-byte fixture');
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const bytes = Uint8Array.from(built.artifact.payloadBytes);
    bytes[bytes.length - 1] = bytes[bytes.length - 1] === 0x7d ? 0x7c : 0x7d;
    const result = validatePublicationExactRangeArtifact({ ...built.artifact, payloadBytes: bytes }, {
      baseOid,
      remoteOid: null,
      localOid,
      currentToolDigest: currentPublicationToolDigest(),
      currentPolicyDigest: currentPublicationPolicyDigest(),
      expectedPayloadByteLength: built.artifact.binding.payloadByteLength,
      expectedPayloadSha256: built.artifact.binding.payloadSha256,
    });
    expect(result).toEqual({ ok: false, error: { code: 'publication.exact-range.receipt-invalid' } });
  });

  it('rejects colluding expected and receipt provenance against the current native owner', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const localOid = commitExactFile(repo, 'note.txt', 'provenance-safe\n', 'provenance fixture');
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const otherDigest = `sha256:${'0'.repeat(64)}`;

    for (const field of ['toolDigest', 'policyDigest'] as const) {
      const rebound = reboundArtifact(built, (payload) => { payload[field] = otherDigest; });
      const result = validatePublicationExactRangeArtifact(rebound.artifact, {
        baseOid,
        remoteOid: null,
        localOid,
        currentToolDigest: field === 'toolDigest' ? otherDigest : currentPublicationToolDigest(),
        currentPolicyDigest: field === 'policyDigest' ? otherDigest : currentPublicationPolicyDigest(),
        expectedPayloadByteLength: rebound.payloadByteLength,
        expectedPayloadSha256: rebound.payloadSha256,
      });
      expect(result).toEqual({
        ok: false,
        error: { code: `publication.exact-range.${field === 'toolDigest' ? 'tool' : 'policy'}-mismatch` },
      });
    }
  });

  it('rejects semantic cause, scope, budget, and lineage mutations under a newly frozen binding', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const token = ['sk-', 'ponmlkjihgfedcba'].join('');
    commitExactFile(repo, 'first.txt', 'first public-safe change\n', 'first semantic fixture commit');
    const localOid = commitExactFile(repo, 'note.txt', `${token}\n`, 'semantic mutation fixture');
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const mutations: Array<{ name: string; mutate: (payload: Record<string, unknown>) => void }> = [
      { name: 'native cause join', mutate: (payload) => { payload.nativeCauses = []; } },
      { name: 'closed cause join', mutate: (payload) => {
        payload.nativeCauses = ['unknown-private-cause'];
        ((payload.findings as unknown[])[0] as Record<string, unknown>).cause = 'unknown-private-cause';
      } },
      { name: 'outcome finding join', mutate: (payload) => { payload.outcome = 'pass'; payload.exitCode = 0; } },
      { name: 'claimed scope join', mutate: (payload) => { (payload.claimedScope as Record<string, unknown>).content = 'all-content'; } },
      { name: 'budget conservation join', mutate: (payload) => { ((payload.budget as Record<string, unknown>).consumed as Record<string, unknown>).changeCount = 0; } },
      { name: 'commit ordering join', mutate: (payload) => { (payload.commitBindings as unknown[]).reverse(); } },
      { name: 'tool binding join', mutate: (payload) => { payload.toolDigest = `sha256:${'0'.repeat(64)}`; } },
      { name: 'policy binding join', mutate: (payload) => { payload.policyDigest = `sha256:${'0'.repeat(64)}`; } },
      { name: 'path digest join', mutate: (payload) => { payload.observedPathDigest = `sha256:${'0'.repeat(64)}`; } },
      { name: 'path redaction join', mutate: (payload) => { ((payload.findings as unknown[])[0] as Record<string, unknown>).path = 'private.txt'; } },
    ];
    for (const { name, mutate } of mutations) {
      const rebound = reboundArtifact(built, mutate);
      const result = validatePublicationExactRangeArtifact(rebound.artifact, {
        baseOid,
        remoteOid: null,
        localOid,
        currentToolDigest: currentPublicationToolDigest(),
        currentPolicyDigest: currentPublicationPolicyDigest(),
        expectedPayloadByteLength: rebound.payloadByteLength,
        expectedPayloadSha256: rebound.payloadSha256,
      });
      expect(result.ok, name).toBe(false);
    }
  });

  it('rejects impossible empty-range and finding observation joins under newly frozen bindings', () => {
    const empty = makeExactRangeRepo();
    const emptyBuilt = createPublicationExactRangeArtifact(empty.repo, {
      baseOid: empty.baseOid,
      remoteOid: null,
      localOid: empty.baseOid,
    });
    expect(emptyBuilt.ok).toBe(true);
    if (!emptyBuilt.ok) return;
    const impossibleEmptyFinding = reboundArtifact(emptyBuilt, (payload) => {
      payload.outcome = 'block';
      payload.exitCode = 1;
      payload.nativeCauses = ['openai-key'];
      const scope = payload.observedScope as Record<string, unknown>;
      scope.changeCount = 1;
      scope.observedPathCount = 1;
      payload.observedPathDigest = `sha256:${createHash('sha256').update(canonicalizeBoundaryRun({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: 1,
      })).digest('hex')}`;
      payload.observedBlobCount = 1;
      payload.observedBlobDigest = `sha256:${createHash('sha256').update(canonicalizeBoundaryRun({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: 1,
      })).digest('hex')}`;
      const budget = payload.budget as Record<string, Record<string, number>>;
      budget.consumed.changeCount = 1;
      budget.remaining.changeCount = budget.limit.changeCount - 1;
      payload.findings = [{
        cause: 'openai-key',
        observationKind: 'net-added-line',
        commitOid: empty.baseOid,
        parentOid: empty.baseOid,
        path: null,
        pathDisclosure: 'redacted',
        line: 1,
        blob: null,
        blobDisclosure: 'redacted',
      }];
    });
    const emptyResult = validatePublicationExactRangeArtifact(impossibleEmptyFinding.artifact, {
      baseOid: empty.baseOid,
      remoteOid: null,
      localOid: empty.baseOid,
      currentToolDigest: currentPublicationToolDigest(),
      currentPolicyDigest: currentPublicationPolicyDigest(),
      expectedPayloadByteLength: impossibleEmptyFinding.payloadByteLength,
      expectedPayloadSha256: impossibleEmptyFinding.payloadSha256,
    });

    const observed = makeExactRangeRepo();
    const token = ['sk-', 'abcdefghijklmnop'].join('');
    const observedLocal = commitExactFile(observed.repo, 'private.txt', `${token}\n`, 'observed finding');
    const observedBuilt = createPublicationExactRangeArtifact(observed.repo, {
      baseOid: observed.baseOid,
      remoteOid: null,
      localOid: observedLocal,
    });
    expect(observedBuilt.ok).toBe(true);
    if (!observedBuilt.ok) return;
    const zeroObservation = reboundArtifact(observedBuilt, (payload) => {
      const scope = payload.observedScope as Record<string, unknown>;
      scope.observedPathCount = 0;
      payload.observedPathDigest = `sha256:${createHash('sha256').update(canonicalizeBoundaryRun({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: 0,
      })).digest('hex')}`;
      payload.observedBlobCount = 0;
      payload.observedBlobDigest = `sha256:${createHash('sha256').update(canonicalizeBoundaryRun({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: 0,
      })).digest('hex')}`;
    });
    const zeroObservationResult = validatePublicationExactRangeArtifact(zeroObservation.artifact, {
      baseOid: observed.baseOid,
      remoteOid: null,
      localOid: observedLocal,
      currentToolDigest: currentPublicationToolDigest(),
      currentPolicyDigest: currentPublicationPolicyDigest(),
      expectedPayloadByteLength: zeroObservation.payloadByteLength,
      expectedPayloadSha256: zeroObservation.payloadSha256,
    });
    const oversizedLine = reboundArtifact(observedBuilt, (payload) => {
      ((payload.findings as unknown[])[0] as Record<string, unknown>).line =
        MAX_EXACT_ADDED_LINE_SOURCE_LINE_COUNT + 1;
    });
    const oversizedLineResult = validatePublicationExactRangeArtifact(oversizedLine.artifact, {
      baseOid: observed.baseOid,
      remoteOid: null,
      localOid: observedLocal,
      currentToolDigest: currentPublicationToolDigest(),
      currentPolicyDigest: currentPublicationPolicyDigest(),
      expectedPayloadByteLength: oversizedLine.payloadByteLength,
      expectedPayloadSha256: oversizedLine.payloadSha256,
    });
    expect([
      emptyResult.ok,
      zeroObservationResult.ok,
      oversizedLineResult.ok,
    ]).toEqual([false, false, false]);
  });

  it('rejects zero and overlarge observation counts on a changed passing receipt', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const localOid = commitExactFile(repo, 'safe.txt', 'changed public-safe\n', 'safe observed change');
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const zeroCounts = reboundArtifact(built, (payload) => {
      const scope = payload.observedScope as Record<string, unknown>;
      scope.observedPathCount = 0;
      payload.observedPathDigest = `sha256:${createHash('sha256').update(canonicalizeBoundaryRun({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: 0,
      })).digest('hex')}`;
      payload.observedBlobCount = 0;
      payload.observedBlobDigest = `sha256:${createHash('sha256').update(canonicalizeBoundaryRun({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: 0,
      })).digest('hex')}`;
    });
    const zeroResult = validatePublicationExactRangeArtifact(zeroCounts.artifact, {
      baseOid,
      remoteOid: null,
      localOid,
      currentToolDigest: currentPublicationToolDigest(),
      currentPolicyDigest: currentPublicationPolicyDigest(),
      expectedPayloadByteLength: zeroCounts.payloadByteLength,
      expectedPayloadSha256: zeroCounts.payloadSha256,
    });
    const overCounts = reboundArtifact(built, (payload) => {
      const scope = payload.observedScope as Record<string, unknown>;
      const overCount = (scope.changeCount as number) * 2 + 1;
      scope.observedPathCount = overCount;
      payload.observedPathDigest = `sha256:${createHash('sha256').update(canonicalizeBoundaryRun({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: overCount,
      })).digest('hex')}`;
      payload.observedBlobCount = overCount;
      payload.observedBlobDigest = `sha256:${createHash('sha256').update(canonicalizeBoundaryRun({
        schemaVersion: 1,
        disclosure: 'all-redacted',
        count: overCount,
      })).digest('hex')}`;
    });
    const overResult = validatePublicationExactRangeArtifact(overCounts.artifact, {
      baseOid,
      remoteOid: null,
      localOid,
      currentToolDigest: currentPublicationToolDigest(),
      currentPolicyDigest: currentPublicationPolicyDigest(),
      expectedPayloadByteLength: overCounts.payloadByteLength,
      expectedPayloadSha256: overCounts.payloadSha256,
    });
    expect([zeroResult.ok, overResult.ok]).toEqual([false, false]);
  });

  it('rejects unknown keys and noncanonical JSON even when their new bytes are independently frozen', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    const localOid = commitExactFile(repo, 'note.txt', 'canonical public-safe\n', 'wire-shape fixture');
    const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const unknown = reboundArtifact(built, (payload) => { payload.unexpected = true; });
    expect(validatePublicationExactRangeArtifact(unknown.artifact, {
      baseOid,
      remoteOid: null,
      localOid,
      currentToolDigest: currentPublicationToolDigest(),
      currentPolicyDigest: currentPublicationPolicyDigest(),
      expectedPayloadByteLength: unknown.payloadByteLength,
      expectedPayloadSha256: unknown.payloadSha256,
    }).ok).toBe(false);

    const payload = JSON.parse(Buffer.from(built.artifact.payloadBytes).toString('utf8')) as Record<string, unknown>;
    const prettyBytes = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    const prettySha = payloadDigest(prettyBytes);
    expect(validatePublicationExactRangeArtifact({
      payloadBytes: Uint8Array.from(prettyBytes),
      binding: {
        schemaVersion: 1,
        detectorId: 'publication-guard',
        payloadByteLength: prettyBytes.byteLength,
        payloadSha256: prettySha,
      },
    }, {
      baseOid,
      remoteOid: null,
      localOid,
      currentToolDigest: currentPublicationToolDigest(),
      currentPolicyDigest: currentPublicationPolicyDigest(),
      expectedPayloadByteLength: prettyBytes.byteLength,
      expectedPayloadSha256: prettySha,
    }).ok).toBe(false);

    const canonicalText = Buffer.from(built.artifact.payloadBytes).toString('utf8');
    const duplicateBytes = Buffer.from(`{"authorization":"report-only",${canonicalText.slice(1)}`, 'utf8');
    const duplicateSha = payloadDigest(duplicateBytes);
    expect(validatePublicationExactRangeArtifact({
      payloadBytes: Uint8Array.from(duplicateBytes),
      binding: {
        schemaVersion: 1,
        detectorId: 'publication-guard',
        payloadByteLength: duplicateBytes.byteLength,
        payloadSha256: duplicateSha,
      },
    }, {
      baseOid,
      remoteOid: null,
      localOid,
      currentToolDigest: currentPublicationToolDigest(),
      currentPolicyDigest: currentPublicationPolicyDigest(),
      expectedPayloadByteLength: duplicateBytes.byteLength,
      expectedPayloadSha256: duplicateSha,
    }).ok).toBe(false);
  });

  it('fails without a payload for malformed, missing, binary, and gitlink exact evidence', () => {
    const { repo, baseOid } = makeExactRangeRepo();
    expect(createPublicationExactRangeArtifact(repo, {
      baseOid: baseOid.toUpperCase(),
      remoteOid: null,
      localOid: baseOid,
    })).toEqual({ ok: false, error: { code: 'publication.exact-range.input-malformed' } });
    const missing = createPublicationExactRangeArtifact(repo, {
      baseOid,
      remoteOid: null,
      localOid: '1'.repeat(40),
    });
    expect(missing).toEqual({ ok: false, error: { code: 'publication.exact-range.evidence-unavailable' } });
    expect('artifact' in missing).toBe(false);

    const binaryOid = commitExactFile(repo, 'binary.dat', Uint8Array.from([0, 1, 2, 3]), 'binary exact input');
    const binary = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid: binaryOid });
    expect(binary).toEqual({ ok: false, error: { code: 'publication.exact-range.evidence-unavailable' } });
    if (!binary.ok) expect('artifact' in binary).toBe(false);

    git(repo, ['checkout', '--detach', baseOid]);
    const invalidUtf8Oid = commitExactFile(repo, 'invalid.txt', Uint8Array.from([0xc3, 0x28]), 'invalid utf8 exact input');
    const invalidUtf8 = createPublicationExactRangeArtifact(repo, {
      baseOid,
      remoteOid: null,
      localOid: invalidUtf8Oid,
    });
    expect(invalidUtf8).toEqual({ ok: false, error: { code: 'publication.exact-range.evidence-unavailable' } });
    expect('artifact' in invalidUtf8).toBe(false);

    git(repo, ['checkout', '--detach', baseOid]);
    const child = tmp.make('publication-gitlink-child');
    git(child, ['init']);
    git(child, ['config', 'user.email', 'guard-test@users.noreply.github.com']);
    git(child, ['config', 'user.name', 'Guard Test']);
    git(child, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(child, 'child.txt'), 'child\n');
    git(child, ['add', 'child.txt']);
    git(child, ['commit', '-m', 'child']);
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'vendor/child'], {
      cwd: repo,
      stdio: 'ignore',
      env: cleanGitEnv(),
    });
    git(repo, ['commit', '-m', 'gitlink exact input']);
    const gitlinkOid = gitOutput(repo, ['rev-parse', 'HEAD']);
    const gitlink = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid: gitlinkOid });
    expect(gitlink).toEqual({ ok: false, error: { code: 'publication.exact-range.evidence-unavailable' } });
    if (!gitlink.ok) expect('artifact' in gitlink).toBe(false);
  });

  it('rejects receipts after the fixed five-minute validity window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'));
      const { repo, baseOid } = makeExactRangeRepo();
      const localOid = commitExactFile(repo, 'note.txt', 'later public-safe\n', 'freshness fixture');
      const built = createPublicationExactRangeArtifact(repo, { baseOid, remoteOid: null, localOid });
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      vi.setSystemTime(new Date('2026-07-21T12:05:00.001Z'));
      const validated = validateBuiltExactRange(built, { baseOid, remoteOid: null, localOid });
      expect(validated).toEqual({ ok: false, error: { code: 'publication.exact-range.receipt-stale' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps legacy argument modes closed and does not add an exact-range CLI mode', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runPublicationGuard(['--exact-range'], process.cwd())).toBe(1);
    expect(error.mock.calls.join('\n')).toContain('Unknown argument: --exact-range');
  });
});

/**
 * `--write` canonicalization (publication-audit churn fix).
 *
 * Context: docs/publication-audit.md is edited by every doc-bearing PR, so each
 * landing re-conflicts every other open PR. work-index has a regenerator; this
 * file had none, which is why its conflicts had to be hand-merged every time.
 */
describe('publication audit --write canonicalization', () => {
  /** Repo with two internal docs, an audit missing one of them, and a duplicated header. */
  function makeWriteRepo(auditBody: string, extraDocs: string[] = []): string {
    const repo = tmp.make('publication-guard-write');
    mkdirSync(join(repo, 'docs/sdlc/closed/example'), { recursive: true });
    writeFileSync(join(repo, internalDocPath), '# clean fixture doc\n');
    for (const doc of extraDocs) {
      mkdirSync(join(repo, doc.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(repo, doc), '# clean fixture doc\n');
    }
    writeFileSync(join(repo, 'docs/publication-audit.md'), auditBody);
    git(repo, ['init']);
    git(repo, ['add', 'docs/publication-audit.md', internalDocPath, ...extraDocs]);
    return repo;
  }

  const auditWith = (rows: string, total: number, pub: number, priv: number) => `# Publication Audit

Preamble prose that must survive verbatim.

**Total classification rows:** ${total}

| Classification | Count |
|---|---:|
| PUBLIC | ${pub} |
| PRIVATE-ARCHIVE | ${priv} |
| SANITIZE | 0 |
| DELETE | 0 |
| Total | ${total} |

| Path | Classification | Rationale |
|---|---|---|
${rows}
`;

  it('is a fixed point: a second write changes nothing', () => {
    const repo = makeWriteRepo(auditWith(`| \`${internalDocPath}\` | PRIVATE-ARCHIVE | Curated rationale. |`, 1, 0, 1));
    const first = writePublicationAudit(repo);
    const afterFirst = readFileSync(join(repo, 'docs/publication-audit.md'), 'utf8');
    const second = writePublicationAudit(repo);
    const afterSecond = readFileSync(join(repo, 'docs/publication-audit.md'), 'utf8');

    expect(second.changed).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    expect(first.rows).toBe(1);
  });

  it('preserves hand-authored rationales verbatim rather than replacing them with the default', () => {
    const curated = 'Sanitized provider schema/correlation evidence; retained for internal conformance review.';
    const repo = makeWriteRepo(auditWith(`| \`${internalDocPath}\` | PUBLIC | ${curated} |`, 1, 1, 0));

    writePublicationAudit(repo);
    const { entries } = parsePublicationAuditEntries(readFileSync(join(repo, 'docs/publication-audit.md'), 'utf8'));

    // Both fields survive: losing either would silently overwrite curated prose.
    expect(entries.get(internalDocPath)?.rationale).toBe(curated);
    expect(entries.get(internalDocPath)?.classification).toBe('PUBLIC');
  });

  it('adds a row for a newly tracked doc, defaulting to PRIVATE-ARCHIVE (never auto-publishes)', () => {
    const extra = 'docs/sdlc/closed/example/added.md';
    const repo = makeWriteRepo(auditWith(`| \`${internalDocPath}\` | PRIVATE-ARCHIVE | Curated rationale. |`, 1, 0, 1), [extra]);

    const result = writePublicationAudit(repo);
    const { entries } = parsePublicationAuditEntries(readFileSync(join(repo, 'docs/publication-audit.md'), 'utf8'));

    expect(result.added).toEqual([extra]);
    expect(entries.get(extra)).toEqual({ classification: 'PRIVATE-ARCHIVE', rationale: DEFAULT_RATIONALE });
    // The pre-existing row is untouched by the insertion.
    expect(entries.get(internalDocPath)?.rationale).toBe('Curated rationale.');
  });

  it('drops rows for files git no longer tracks', () => {
    const stale = 'docs/sdlc/closed/example/deleted.md';
    const repo = makeWriteRepo(
      auditWith(
        `| \`${internalDocPath}\` | PRIVATE-ARCHIVE | Curated rationale. |\n| \`${stale}\` | PRIVATE-ARCHIVE | Row for a file that is gone. |`,
        2,
        0,
        2,
      ),
    );

    const result = writePublicationAudit(repo);
    expect(result.removed).toEqual([stale]);
    expect(readFileSync(join(repo, 'docs/publication-audit.md'), 'utf8')).not.toContain(stale);
  });

  it('produces output that passes --all, so writing cannot create an invalid document', () => {
    const extra = 'docs/sdlc/closed/example/added.md';
    const repo = makeWriteRepo(auditWith(`| \`${internalDocPath}\` | PRIVATE-ARCHIVE | Curated rationale. |`, 1, 0, 1), [extra]);

    writePublicationAudit(repo);
    expect(runPublicationGuard(['--all'], repo)).toBe(0);
  });
});

describe('publication audit duplicate declared-count line', () => {
  const dupAudit = (firstTotal: number, lastTotal: number) => `# Publication Audit

**Total classification rows:** ${firstTotal}
**Total classification rows:** ${lastTotal}

| Classification | Count |
|---|---:|
| PUBLIC | 0 |
| PRIVATE-ARCHIVE | 1 |
| SANITIZE | 0 |
| DELETE | 0 |
| Total | ${lastTotal} |

| Path | Classification | Rationale |
|---|---|---|
| \`${internalDocPath}\` | PRIVATE-ARCHIVE | Fixture row. |
`;

  it('counts every declared-total line, not just the last', () => {
    expect(parsePublicationAudit(dupAudit(1, 1)).declaredTotalLines).toBe(2);
  });

  it('flags a stale-first/correct-last skew that every other check reads as clean', () => {
    // The load-bearing case: declaredTotal is assigned on each match, so the
    // guard validates only the LAST line (1, correct). The FIRST line renders
    // 999 to a human reader and, without this check, nothing objects.
    const parsed = parsePublicationAudit(dupAudit(999, 1));
    expect(parsed.declaredTotal).toBe(1);

    const issues = validatePublicationAudit(parsed, [internalDocPath], () => 'clean');
    const codes = issues.map((issue) => issue.code);

    expect(codes).toContain('publication-audit-duplicate-total-line');
    // Proof this is the ONLY thing that objects: no count/total/tracked check
    // fires, which is exactly why the skew was previously invisible.
    expect(codes.filter((code) => code !== 'publication-audit-duplicate-total-line')).toEqual([]);
  });

  it('stays silent when the document declares its total exactly once', () => {
    const single = dupAudit(1, 1).replace('**Total classification rows:** 1\n**Total classification rows:** 1', '**Total classification rows:** 1');
    const issues = validatePublicationAudit(parsePublicationAudit(single), [internalDocPath], () => 'clean');
    expect(issues.map((issue) => issue.code)).toEqual([]);
  });
});
