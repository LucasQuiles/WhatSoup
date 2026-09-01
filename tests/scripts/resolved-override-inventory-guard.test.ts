/**
 * #3435 rev-3438 follow-up — CI inventory guard for `ExecutingSessionContext.resolved`.
 *
 * `resolved: true` flips an all-undefined executing context from the UNRESOLVED
 * (fail-closed) state to `'resolved'`, which makes the scheduled-agent-job
 * forbidden-tool set reachable again. It has ZERO production callers; before the
 * guard the only thing keeping it that way was a docstring.
 *
 * This meta-test proves the guard actually detects each of the three shapes its
 * header claims, ignores the shapes its header disclaims, passes on the live tree
 * with the inventory pinned, BLOCKS an off-allowlist production site, and refuses
 * (exit 2 INCONCLUSIVE) a tree it never examined — including the case where the
 * allowlist, which doubles as the detector's positive control, stops matching.
 *
 * Fixtures are string literals on purpose: the guard blanks string contents before
 * matching, so this file cannot flag itself.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scanFileForResolvedOverrides,
  scanRepoResolvedOverridesCounted,
  RESOLVED_OVERRIDE_ALLOWLIST,
  EXIT_PASS,
  EXIT_BLOCK,
  EXIT_INCONCLUSIVE,
} from '../../scripts/resolved-override-inventory-guard.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts/resolved-override-inventory-guard.ts');

/** An executing-context literal that asserts resolution, as a production caller would write it. */
const PRODUCTION_OVERRIDE = [
  'export function build(session: SessionContext) {',
  '  return resolveIt(session, {',
  '    actorJid: undefined,',
  '    purpose: undefined,',
  '    conversationKey: undefined,',
  '    resolved: true,',
  '  });',
  '}',
].join('\n');

describe('resolved-override-inventory-guard — the three rules it claims', () => {
  it('rule (a) FLAGS an executing-shaped literal that sets the override (marker keys)', () => {
    const findings = scanFileForResolvedOverrides('src/mcp/new-caller.ts', PRODUCTION_OVERRIDE);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('executing-literal');
    expect(findings[0].file).toBe('src/mcp/new-caller.ts');
    expect(findings[0].line).toBe(6);
  });

  it('rule (a) FLAGS the spread form, where the marker keys are inherited not written', () => {
    const src = 'const ctx = wrap({ ...executing, resolved: true });';
    const findings = scanFileForResolvedOverrides('src/runtimes/agent/wrapper.ts', src);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('executing-literal');
  });

  it('rule (b) FLAGS a marker-less literal in a file that names the executing-context machinery', () => {
    const src = [
      'import { resolveSessionContext } from "../mcp/types.ts";',
      'const ctx = resolveSessionContext(session, { resolved: true });',
    ].join('\n');
    const findings = scanFileForResolvedOverrides('src/mcp/bare.ts', src);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('machinery-file-literal');
    expect(findings[0].line).toBe(2);
  });

  it('rule (c) FLAGS a property assignment onto an existing context (plain and logical-assign)', () => {
    const plain = scanFileForResolvedOverrides('src/mcp/mutate.ts', 'ctx.resolved = true;');
    expect(plain).toHaveLength(1);
    expect(plain[0].rule).toBe('property-assignment');
    const logical = scanFileForResolvedOverrides('src/mcp/mutate.ts', "ctx['resolved'] ??= true;");
    expect(logical).toHaveLength(1);
    expect(logical[0].rule).toBe('property-assignment');
  });

  it('every finding carries a remediation detail, not just a location', () => {
    const findings = scanFileForResolvedOverrides('src/mcp/new-caller.ts', PRODUCTION_OVERRIDE);
    expect(findings[0].detail).toMatch(/executing-turn register entry/);
    expect(findings[0].detail).toMatch(/#3435/);
  });
});

describe('resolved-override-inventory-guard — what it deliberately does NOT flag', () => {
  it('ignores `resolved: false`, which never asserts resolution', () => {
    const src = 'const ctx = wrap({ actorJid: a, purpose: p, conversationKey: k, resolved: false });';
    expect(scanFileForResolvedOverrides('src/mcp/off.ts', src)).toHaveLength(0);
  });

  it('ignores the pattern inside comments (this repo documents it in prose)', () => {
    const src = [
      '/**',
      ' * Set `resolved: true` ONLY in the direct-registry test adapter.',
      ' */',
      '// legacy note: ctx.resolved = true',
      'const q = 1;',
    ].join('\n');
    expect(scanFileForResolvedOverrides('src/mcp/doc-only.ts', src)).toHaveLength(0);
  });

  it('ignores the pattern inside string and template literals (fixtures, error text)', () => {
    const src = 'const a = "resolved: true";\nconst b = `ctx.resolved = true`;';
    expect(scanFileForResolvedOverrides('src/mcp/strings.ts', src)).toHaveLength(0);
  });

  it('ignores a destructuring pattern, which READS the field rather than setting it', () => {
    const src = 'const { resolved: asserted, ...rest } = executing;';
    expect(scanFileForResolvedOverrides('src/mcp/types.ts', src)).toHaveLength(0);
  });

  it('ignores an interface/type member declaration of the same name', () => {
    const src = 'interface Ctx {\n  resolved?: boolean;\n}';
    expect(scanFileForResolvedOverrides('src/mcp/decl.ts', src)).toHaveLength(0);
  });

  it('ignores an unrelated `resolved` key in a file with no executing-context markers', () => {
    const src = 'return { sent: true, messageId, resolved: "last_inbound" };';
    expect(scanFileForResolvedOverrides('src/mcp/tools/messaging-like.ts', src)).toHaveLength(0);
  });

  it('ignores an equality comparison against the field', () => {
    expect(scanFileForResolvedOverrides('src/mcp/read.ts', 'if (ctx.resolved === true) go();')).toHaveLength(0);
  });

  it('flags real code even when a comment mentioning the shape precedes it (line = the CODE line)', () => {
    const src = ['// never write resolved: true in production', 'ctx.resolved = true;'].join('\n');
    const findings = scanFileForResolvedOverrides('src/mcp/mixed.ts', src);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });
});

describe('resolved-override-inventory-guard — live tree', () => {
  const scan = scanRepoResolvedOverridesCounted(REPO_ROOT);

  it('the live tree has ZERO override sites outside the test-only allowlist', () => {
    expect(scan.findings).toEqual([]);
  });

  it('the production tree stays at zero: every allowlisted site is under tests/', () => {
    for (const entry of RESOLVED_OVERRIDE_ALLOWLIST) {
      expect(entry.file.startsWith('tests/'), `${entry.file} is not a test-only site`).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it('every allowlist row still matches its pinned count (a stale row widens the blind spot)', () => {
    for (const { entry, matches } of scan.allowlisted) {
      const content = readFileSync(path.join(REPO_ROOT, entry.file), 'utf8');
      expect(scanFileForResolvedOverrides(entry.file, content)).toHaveLength(entry.expectedMatches);
      expect(matches, `${entry.file} pinned ${entry.expectedMatches}, scanned ${matches}`).toBe(entry.expectedMatches);
    }
  });

  it('both scan roots were examined over MANY files, so a pass is not vacuous', () => {
    expect(scan.filesExamined.src).toBeGreaterThan(100);
    expect(scan.filesExamined.tests).toBeGreaterThan(100);
    expect(scan.unreadable).toEqual([]);
  });
});

describe('resolved-override-inventory-guard — subprocess exits', () => {
  const temps: string[] = [];
  afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function runGuardIn(cwd: string): { status: number; output: string } {
    const r = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', GUARD],
      { cwd, encoding: 'utf8', timeout: 180_000 },
    );
    return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  /** A minimal tree whose allowlisted sites match, so the positive control is satisfied. */
  function fixtureRepo(label: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `resolved-override-${label}-`));
    temps.push(dir);
    mkdirSync(path.join(dir, 'src/mcp'), { recursive: true });
    mkdirSync(path.join(dir, 'tests/helpers'), { recursive: true });
    mkdirSync(path.join(dir, 'tests/mcp'), { recursive: true });
    writeFileSync(path.join(dir, 'src/mcp/types.ts'), 'export const ok = 1;\n');
    for (const entry of RESOLVED_OVERRIDE_ALLOWLIST) {
      mkdirSync(path.join(dir, path.dirname(entry.file)), { recursive: true });
      writeFileSync(path.join(dir, entry.file), PRODUCTION_OVERRIDE);
    }
    return dir;
  }

  it('exits 0 on the live repo with the inventory pinned', () => {
    const { status, output } = runGuardIn(REPO_ROOT);
    expect(status, output).toBe(EXIT_PASS);
    expect(output).toMatch(/no resolved-override sites outside the test-only allowlist/);
    expect(output).toMatch(/inventory pinned/);
  });

  it('exits 1 BLOCK when a PRODUCTION file sets the override off-allowlist', () => {
    const dir = fixtureRepo('block');
    writeFileSync(path.join(dir, 'src/mcp/new-caller.ts'), PRODUCTION_OVERRIDE);
    const { status, output } = runGuardIn(dir);
    expect(status, `expected ${EXIT_BLOCK} BLOCK, got ${status}:\n${output}`).toBe(EXIT_BLOCK);
    expect(output).toMatch(/src\/mcp\/new-caller\.ts:6 \[executing-literal\]/);
    expect(output).toMatch(/reopens the empty-context fail-open/);
  });

  it('exits 1 BLOCK when an allowlisted file grows an EXTRA site beyond its pinned count', () => {
    const dir = fixtureRepo('count');
    const grown = RESOLVED_OVERRIDE_ALLOWLIST[0]!.file;
    writeFileSync(path.join(dir, grown), `${PRODUCTION_OVERRIDE}\n${PRODUCTION_OVERRIDE}`);
    const { status, output } = runGuardIn(dir);
    expect(status, `expected ${EXIT_BLOCK} BLOCK, got ${status}:\n${output}`).toBe(EXIT_BLOCK);
    expect(output).toMatch(/has 2 resolved-override site\(s\) but the inventory pins 1/);
  });

  it('exits 2 INCONCLUSIVE — not 0 — on an empty tree (no scan roots at all)', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'resolved-override-empty-'));
    temps.push(empty);
    execFileSync('git', ['init', '-q'], { cwd: empty });
    const { status, output } = runGuardIn(empty);
    expect(status, `expected ${EXIT_INCONCLUSIVE} INCONCLUSIVE, got ${status}:\n${output}`).toBe(EXIT_INCONCLUSIVE);
    expect(output).toMatch(/INCONCLUSIVE/i);
    expect(output).not.toMatch(/no resolved-override sites/);
  });

  it('still exits 2 when src/ and tests/ EXIST but are empty (a location check is not a work check)', () => {
    const decoy = mkdtempSync(path.join(tmpdir(), 'resolved-override-decoy-'));
    temps.push(decoy);
    mkdirSync(path.join(decoy, 'src'), { recursive: true });
    mkdirSync(path.join(decoy, 'tests'), { recursive: true });
    writeFileSync(path.join(decoy, 'package.json'), '{"name":"decoy"}');
    const { status, output } = runGuardIn(decoy);
    expect(status, `expected ${EXIT_INCONCLUSIVE} on a decoy checkout, got ${status}:\n${output}`).toBe(EXIT_INCONCLUSIVE);
    expect(output).toMatch(/examined 0 source file/);
  });

  it('exits 2 when only ONE of the two scan roots yields files (partial scope is not scope)', () => {
    const half = mkdtempSync(path.join(tmpdir(), 'resolved-override-half-'));
    temps.push(half);
    mkdirSync(path.join(half, 'src/mcp'), { recursive: true });
    mkdirSync(path.join(half, 'tests'), { recursive: true });
    writeFileSync(path.join(half, 'src/mcp/types.ts'), 'export const ok = 1;\n');
    const { status, output } = runGuardIn(half);
    expect(status, `expected ${EXIT_INCONCLUSIVE}, got ${status}:\n${output}`).toBe(EXIT_INCONCLUSIVE);
    expect(output).toMatch(/tests/);
  });

  it('exits 2 when the allowlist stops matching — the detector lost its positive control', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'resolved-override-control-'));
    temps.push(dir);
    mkdirSync(path.join(dir, 'src/mcp'), { recursive: true });
    mkdirSync(path.join(dir, 'tests/mcp'), { recursive: true });
    writeFileSync(path.join(dir, 'src/mcp/types.ts'), 'export const ok = 1;\n');
    writeFileSync(path.join(dir, 'tests/mcp/unrelated.test.ts'), 'export const ok = 1;\n');
    const { status, output } = runGuardIn(dir);
    expect(status, `expected ${EXIT_INCONCLUSIVE}, got ${status}:\n${output}`).toBe(EXIT_INCONCLUSIVE);
    expect(output).toMatch(/produced 0 matches/);
    expect(output).toMatch(/positive control/);
  });
});
