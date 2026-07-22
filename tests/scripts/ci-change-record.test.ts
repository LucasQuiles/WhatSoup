import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CODE_INVALID,
  CODE_MISMATCH,
  CODE_MISSING,
  CODE_PASS,
  CODE_INCONCLUSIVE,
  type ChangeRecordResolver,
  type ResolvedRecord,
  classifyChangeRecord,
  classifyChangeRecordSet,
  classifyTrailers,
  filesystemRecordResolver,
  gitTreeRecordResolver,
  loadChangeRecordSchema,
  main,
  parseChangeRecordTrailers,
  referencedRecordId,
  validateAgainstSchema,
} from '../../scripts/ci-change-record.ts';
import { reasonDefinition } from '../../scripts/lib/ci-control/reasons.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHANGES_DIR = join(REPO_ROOT, 'changes');
const SCHEMA = loadChangeRecordSchema();
const fsResolver = filesystemRecordResolver(CHANGES_DIR);

function commit(subject: string, trailers: readonly string[]): string {
  return `${subject}\n\nSome body describing the change.\n\n${trailers.join('\n')}\n`;
}

function mapResolver(map: Readonly<Record<string, ResolvedRecord>>): ChangeRecordResolver {
  return (id) => map[id] ?? { presence: 'absent', bytes: null };
}

function classify(message: string, resolver: ChangeRecordResolver = fsResolver) {
  return classifyChangeRecord(message, resolver, SCHEMA);
}

// ---------------------------------------------------------------------------
// Reuse proof: every code this control emits is a registered taxonomy reason with the expected
// outcome, and outcome is derived from the taxonomy (not from any author-declared trailer value).
// ---------------------------------------------------------------------------
describe('taxonomy reuse (no forked result type / reason taxonomy)', () => {
  it('emits only registered reason codes with the expected outcomes', () => {
    expect(reasonDefinition(CODE_MISSING)).toMatchObject({ defaultOutcome: 'block' });
    expect(reasonDefinition(CODE_INVALID)).toMatchObject({ defaultOutcome: 'block' });
    expect(reasonDefinition(CODE_MISMATCH)).toMatchObject({ defaultOutcome: 'block' });
    expect(reasonDefinition(CODE_PASS)).toMatchObject({ defaultOutcome: 'pass' });
    expect(reasonDefinition(CODE_INCONCLUSIVE)).toMatchObject({ defaultOutcome: 'inconclusive' });
  });

  it('maps outcome to the canonical exit code (block=1, inconclusive=2, pass=0)', () => {
    const missing = classify(commit('feat', []));
    expect(missing).toMatchObject({ outcome: 'block', exitCode: 1, code: CODE_MISSING });
    const valid = classify(commit('feat', ['Change-Record: CR-valid-feature']));
    expect(valid).toMatchObject({ outcome: 'pass', exitCode: 0, code: CODE_PASS });
    const undeterminable = classify(
      commit('feat', ['Change-Record: CR-valid-feature']),
      mapResolver({ 'CR-valid-feature': { presence: 'undeterminable', bytes: null } }),
    );
    expect(undeterminable).toMatchObject({ outcome: 'inconclusive', exitCode: 2 });
  });
});

// ---------------------------------------------------------------------------
// Pure trailer parsing / classification.
// ---------------------------------------------------------------------------
describe('trailer parsing', () => {
  it('extracts recognized trailers and ignores foreign trailers', () => {
    const parsed = parseChangeRecordTrailers(commit('feat', [
      'Signed-off-by: Someone <s@example.com>',
      'Change-Record: CR-valid-feature',
      'Change-Intent: feature',
      'Risk: low',
    ]));
    expect(parsed.changeRecord).toEqual(['CR-valid-feature']);
    expect(parsed.changeIntent).toEqual(['feature']);
    expect(parsed.unknownControlTrailers).toEqual([]);
    expect(parsed.malformedValues).toEqual([]);
  });

  it('flags an unknown change-control trailer', () => {
    const parsed = parseChangeRecordTrailers(commit('feat', ['Change-Reference: CR-x']));
    expect(parsed.unknownControlTrailers).toEqual(['Change-Reference']);
  });

  it('referencedRecordId returns the id only for structurally valid trailers', () => {
    expect(referencedRecordId(commit('feat', ['Change-Record: CR-valid-feature']))).toBe('CR-valid-feature');
    expect(referencedRecordId(commit('feat', []))).toBeNull();
    expect(referencedRecordId(commit('feat', ['Change-Record: CR-a', 'Change-Record: CR-b']))).toBeNull();
  });

  it('classifyTrailers requires exactly one Change-Record', () => {
    expect(classifyTrailers(parseChangeRecordTrailers(commit('f', [])))).toMatchObject({ ok: false, code: CODE_MISSING });
    expect(classifyTrailers(parseChangeRecordTrailers(commit('f', ['Change-Record: CR-a', 'Change-Record: CR-b'])))).toMatchObject({ ok: false, code: CODE_INVALID });
  });
});

// ---------------------------------------------------------------------------
// Schema-subset validation (schema JSON is the single source of truth for the closed sets).
// ---------------------------------------------------------------------------
describe('schema-subset validation', () => {
  it('accepts a valid record and rejects out-of-enum / unknown / missing fields', () => {
    expect(validateAgainstSchema({ id: 'CR-x', intent: 'feature', declaredRisk: 'low', components: ['a'] }, SCHEMA)).toBeNull();
    expect(validateAgainstSchema({ id: 'CR-x', intent: 'hotfix', declaredRisk: 'low', components: ['a'] }, SCHEMA)).toMatch(/allowed set/);
    expect(validateAgainstSchema({ id: 'CR-x', intent: 'feature', declaredRisk: 'low', components: ['a'], surprise: 1 }, SCHEMA)).toMatch(/unknown property/);
    expect(validateAgainstSchema({ id: 'CR-x', intent: 'feature', declaredRisk: 'low' }, SCHEMA)).toMatch(/missing required/);
    expect(validateAgainstSchema({ id: 'CR-x', intent: 'feature', declaredRisk: 'low', components: [] }, SCHEMA)).toMatch(/too few/);
  });
});

// ---------------------------------------------------------------------------
// GREEN: valid trailer + record.
// ---------------------------------------------------------------------------
describe('valid records pass', () => {
  it('a valid feature commit + record returns PASS', () => {
    expect(classify(commit('feat', ['Change-Record: CR-valid-feature', 'Change-Intent: feature'])))
      .toMatchObject({ outcome: 'pass', code: CODE_PASS });
  });

  it('a valid bugfix commit with Regression-For + record returns PASS', () => {
    expect(classify(commit('fix', ['Change-Record: CR-valid-bugfix', 'Change-Intent: bugfix', 'Regression-For: #1234'])))
      .toMatchObject({ outcome: 'pass', code: CODE_PASS });
  });
});

// ---------------------------------------------------------------------------
// DEFECTS -> BLOCK (each proves the fail-closed classification).
// ---------------------------------------------------------------------------
describe('defects block', () => {
  it('missing Change-Record -> BLOCK evidence.change-record.missing', () => {
    expect(classify(commit('feat', []))).toMatchObject({ outcome: 'block', exitCode: 1, code: CODE_MISSING });
  });

  it('unknown change-control trailer -> BLOCK evidence.trailer.invalid', () => {
    expect(classify(commit('feat', ['Change-Record: CR-valid-feature', 'Change-Owner: nobody'])))
      .toMatchObject({ outcome: 'block', code: CODE_INVALID });
  });

  it('duplicate Change-Record -> BLOCK evidence.trailer.invalid', () => {
    expect(classify(commit('feat', ['Change-Record: CR-valid-feature', 'Change-Record: CR-valid-bugfix'])))
      .toMatchObject({ outcome: 'block', code: CODE_INVALID });
  });

  it('dangling record reference -> BLOCK evidence.change-record.missing', () => {
    expect(classify(commit('feat', ['Change-Record: CR-does-not-exist'])))
      .toMatchObject({ outcome: 'block', code: CODE_MISSING });
  });

  it('bugfix without Regression-For -> BLOCK evidence.trailer.invalid', () => {
    expect(classify(commit('fix', ['Change-Record: CR-valid-bugfix', 'Change-Intent: bugfix'])))
      .toMatchObject({ outcome: 'block', code: CODE_INVALID });
  });

  it('injection-bearing trailer value -> BLOCK evidence.trailer.invalid', () => {
    expect(classify(commit('feat', ['Change-Record: CR-../../etc/passwd'])))
      .toMatchObject({ outcome: 'block', code: CODE_INVALID });
  });

  it('record id mismatched with filename -> BLOCK evidence.trailer.record-mismatch', () => {
    expect(classify(commit('feat', ['Change-Record: CR-record-mismatch'])))
      .toMatchObject({ outcome: 'block', exitCode: 1, code: CODE_MISMATCH });
  });

  it('schema-invalid record -> BLOCK evidence.trailer.record-mismatch', () => {
    expect(classify(commit('feat', ['Change-Record: CR-bad-enum'])))
      .toMatchObject({ outcome: 'block', code: CODE_MISMATCH });
  });

  it('unparseable record -> BLOCK evidence.trailer.record-mismatch', () => {
    expect(classify(commit('feat', ['Change-Record: CR-malformed'])))
      .toMatchObject({ outcome: 'block', code: CODE_MISMATCH });
  });

  it('record intent inconsistent with Change-Intent trailer -> BLOCK evidence.trailer.record-mismatch', () => {
    // CR-valid-feature declares intent: feature; the trailer claims bugfix (with Regression-For so
    // the trailer set itself is valid) -> the pointer disagrees with the present record.
    expect(classify(commit('feat', ['Change-Record: CR-valid-feature', 'Change-Intent: bugfix', 'Regression-For: #9'])))
      .toMatchObject({ outcome: 'block', code: CODE_MISMATCH });
  });
});

// ---------------------------------------------------------------------------
// Fail-closed: undeterminable / unreadable evidence and crashes are INCONCLUSIVE, never PASS.
// ---------------------------------------------------------------------------
describe('fail-closed inconclusive (never pass)', () => {
  it('present but unreadable record -> INCONCLUSIVE', () => {
    const obs = classify(
      commit('feat', ['Change-Record: CR-valid-feature']),
      mapResolver({ 'CR-valid-feature': { presence: 'present', bytes: null } }),
    );
    expect(obs).toMatchObject({ outcome: 'inconclusive', exitCode: 2 });
    expect(obs.outcome).not.toBe('pass');
  });

  it('undeterminable presence -> INCONCLUSIVE', () => {
    const obs = classify(
      commit('feat', ['Change-Record: CR-valid-feature']),
      mapResolver({ 'CR-valid-feature': { presence: 'undeterminable', bytes: null } }),
    );
    expect(obs).toMatchObject({ outcome: 'inconclusive', exitCode: 2 });
  });

  it('a resolver that throws -> INCONCLUSIVE (crash never yields a clean pass)', () => {
    const throwing: ChangeRecordResolver = () => { throw new Error('boom'); };
    const obs = classify(commit('feat', ['Change-Record: CR-valid-feature']), throwing);
    expect(obs).toMatchObject({ outcome: 'inconclusive', exitCode: 2 });
    expect(obs.outcome).not.toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Author-declared values may only INCREASE work — a Risk/declaredRisk value never reduces a control.
// ---------------------------------------------------------------------------
describe('author-declared risk cannot reduce a control', () => {
  it('a Risk: low trailer does not turn a BLOCK into a PASS', () => {
    const withoutRisk = classify(commit('feat', []));
    const withRisk = classify(commit('feat', ['Risk: low']));
    expect(withoutRisk).toMatchObject({ outcome: 'block', code: CODE_MISSING });
    expect(withRisk).toMatchObject({ outcome: 'block', code: CODE_MISSING });
  });

  it('a Risk: low trailer does not change a PASS either', () => {
    const withRisk = classify(commit('feat', ['Change-Record: CR-valid-feature', 'Risk: low']));
    expect(withRisk).toMatchObject({ outcome: 'pass', code: CODE_PASS });
  });

  it('a low declaredRisk record does not excuse the bugfix Regression-For obligation', () => {
    // CR-valid-bugfix declares declaredRisk: low, but a bugfix commit still must carry Regression-For.
    expect(classify(commit('fix', ['Change-Record: CR-valid-bugfix', 'Change-Intent: bugfix'])))
      .toMatchObject({ outcome: 'block', code: CODE_INVALID });
  });
});

// ---------------------------------------------------------------------------
// PR-level: all commits must reference the same/allowed record set.
// ---------------------------------------------------------------------------
describe('change-record set (PR level)', () => {
  const allowed = ['CR-valid-feature', 'CR-valid-bugfix'];

  it('all commits in the allowed set -> PASS', () => {
    const obs = classifyChangeRecordSet(
      [
        commit('feat', ['Change-Record: CR-valid-feature']),
        commit('fix', ['Change-Record: CR-valid-bugfix', 'Change-Intent: bugfix', 'Regression-For: #1']),
      ],
      fsResolver,
      { allowedRecordIds: allowed, schema: SCHEMA },
    );
    expect(obs).toMatchObject({ outcome: 'pass', code: CODE_PASS });
  });

  it('a commit referencing a record outside the allowed set -> BLOCK record-mismatch', () => {
    const obs = classifyChangeRecordSet(
      [
        commit('feat', ['Change-Record: CR-valid-feature']),
        commit('feat', ['Change-Record: CR-valid-bugfix']),
      ],
      fsResolver,
      { allowedRecordIds: ['CR-valid-feature'], schema: SCHEMA },
    );
    expect(obs).toMatchObject({ outcome: 'block', code: CODE_MISMATCH });
  });

  it('a per-commit BLOCK dominates the aggregate', () => {
    const obs = classifyChangeRecordSet(
      [
        commit('feat', ['Change-Record: CR-valid-feature']),
        commit('feat', []),
      ],
      fsResolver,
      { allowedRecordIds: allowed, schema: SCHEMA },
    );
    expect(obs).toMatchObject({ outcome: 'block' });
  });

  it('an empty commit set is INCONCLUSIVE, not a vacuous pass', () => {
    const obs = classifyChangeRecordSet([], fsResolver, { allowedRecordIds: allowed, schema: SCHEMA });
    expect(obs).toMatchObject({ outcome: 'inconclusive' });
  });
});

// ---------------------------------------------------------------------------
// git-tree resolver reuse of git-input (real temp git repo).
// ---------------------------------------------------------------------------
describe('gitTreeRecordResolver (git-input reuse)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function initRepo(): { cwd: string; head: string } {
    const cwd = mkdtempSync(join(tmpdir(), 'ci-change-record-git-'));
    dirs.push(cwd);
    const git = (args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    mkdirSync(join(cwd, 'changes'), { recursive: true });
    writeFileSync(join(cwd, 'changes', 'CR-tree.yaml'), 'id: CR-tree\nintent: feature\ndeclaredRisk: low\ncomponents:\n  - a\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed']);
    return { cwd, head: git(['rev-parse', 'HEAD']) };
  }

  it('resolves a present record from the git tree and passes', () => {
    const { cwd, head } = initRepo();
    const resolver = gitTreeRecordResolver(cwd, head);
    expect(classifyChangeRecord(commit('feat', ['Change-Record: CR-tree']), resolver, SCHEMA))
      .toMatchObject({ outcome: 'pass', code: CODE_PASS });
  });

  it('reports an absent record from the git tree as missing', () => {
    const { cwd, head } = initRepo();
    const resolver = gitTreeRecordResolver(cwd, head);
    expect(classifyChangeRecord(commit('feat', ['Change-Record: CR-absent']), resolver, SCHEMA))
      .toMatchObject({ outcome: 'block', code: CODE_MISSING });
  });
});

// ---------------------------------------------------------------------------
// main() sets the fail-closed process exit code.
// ---------------------------------------------------------------------------
describe('main() exit codes', () => {
  const dirs: string[] = [];
  const original = process.cwd();
  afterEach(() => {
    process.chdir(original);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function workspace(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'ci-change-record-main-'));
    dirs.push(cwd);
    mkdirSync(join(cwd, 'changes'), { recursive: true });
    writeFileSync(join(cwd, 'changes', 'CR-main.yaml'), 'id: CR-main\nintent: feature\ndeclaredRisk: low\ncomponents:\n  - a\n');
    return cwd;
  }

  it('exits 0 on a valid commit and 1 on a missing record', () => {
    const cwd = workspace();
    process.chdir(cwd);
    const passMsg = join(cwd, 'PASS_MSG');
    writeFileSync(passMsg, commit('feat', ['Change-Record: CR-main']));
    expect(main(['node', 'ci-change-record.ts', passMsg])).toBe(0);
    const blockMsg = join(cwd, 'BLOCK_MSG');
    writeFileSync(blockMsg, commit('feat', []));
    expect(main(['node', 'ci-change-record.ts', blockMsg])).toBe(1);
  });

  it('exits 2 (inconclusive) when the message cannot be read', () => {
    const cwd = workspace();
    process.chdir(cwd);
    expect(main(['node', 'ci-change-record.ts', join(cwd, 'no-such-file')])).toBe(2);
  });
});
