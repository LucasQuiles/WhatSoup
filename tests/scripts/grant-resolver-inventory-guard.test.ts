/**
 * B4 / QR-143 — CI inventory guard: a phone-keyed admin/allow GRANT must resolve
 * through resolvePhoneFromJidForGrant (fails closed for @sms), not the general
 * resolvePhoneFromJid. This meta-test proves the guard flags a new inline
 * ungated grant composition, honours the allowlist, and passes on the live tree.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scanFileForGrantResolvers,
  scanRepoGrantResolvers,
  scanRepoGrantResolversCounted,
  GRANT_RESOLVER_ALLOWLIST,
} from '../../scripts/grant-resolver-inventory-guard.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts/grant-resolver-inventory-guard.ts');

describe('grant-resolver-inventory-guard — scanFileForGrantResolvers', () => {
  it('FLAGS a new inline isAdminPhone(resolvePhoneFromJid(...)) grant composition', () => {
    const src = 'const ok = isAdminPhone(resolvePhoneFromJid(jid, db), adminPhones);';
    const findings = scanFileForGrantResolvers('src/core/new-grant.ts', src);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('src/core/new-grant.ts');
    expect(findings[0].line).toBe(1);
  });

  it('is newline/whitespace tolerant (multi-line composition still flagged)', () => {
    const src = [
      'const ok =',
      '  isAdminPhone(',
      '    resolvePhoneFromJid(jid, db),',
      '    adminPhones,',
      '  );',
    ].join('\n');
    const findings = scanFileForGrantResolvers('src/core/multiline.ts', src);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it('does NOT flag the grant primitive form isAdminPhone(resolvePhoneFromJidForGrant(...))', () => {
    const src = 'const ok = isAdminPhone(resolvePhoneFromJidForGrant(jid, db) ?? "", adminPhones);';
    expect(scanFileForGrantResolvers('src/core/migrated.ts', src)).toHaveLength(0);
  });

  it('does NOT flag a decomposed resolve-then-check (out of scope; documented limit)', () => {
    const src = 'const p = resolvePhoneFromJid(jid, db);\nconst ok = isAdminPhone(p, adminPhones);';
    expect(scanFileForGrantResolvers('src/core/decomposed.ts', src)).toHaveLength(0);
  });

  it('does NOT flag an allowlisted deny/warn-side site', () => {
    const src = 'const peerBearsAdminDigits = isAdminPhone(resolvePhoneFromJid(chatJid, db), adminPhones);';
    expect(scanFileForGrantResolvers('src/core/outbound-message-safety.ts', src)).toHaveLength(0);
  });

  it('does NOT flag the pattern when it appears only in a comment (docs mention it)', () => {
    const block = [
      '/**',
      ' * Never write isAdminPhone(resolvePhoneFromJid(...)) at a grant site.',
      ' */',
      'const ok = isAdminPhone(resolvePhoneFromJidForGrant(jid, db) ?? "", adminPhones);',
      '// legacy: isAdminPhone(resolvePhoneFromJid(jid, db))',
    ].join('\n');
    expect(scanFileForGrantResolvers('src/core/doc-only.ts', block)).toHaveLength(0);
  });

  it('flags real code even when a comment mentioning the pattern precedes it (line number is the CODE line)', () => {
    const src = [
      '// isAdminPhone(resolvePhoneFromJid(...)) is banned at grant sites',
      'const bad = isAdminPhone(resolvePhoneFromJid(jid, db), adminPhones);',
    ].join('\n');
    const findings = scanFileForGrantResolvers('src/core/mixed.ts', src);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });
});

describe('grant-resolver-inventory-guard — live tree', () => {
  it('the live src/ tree has ZERO ungated grant compositions (all migrated or allowlisted)', () => {
    const findings = scanRepoGrantResolvers(REPO_ROOT);
    expect(findings).toEqual([]);
  });

  it('every allowlist row names a real file that still contains the pattern (no stale allowlist)', () => {
    // A stale allowlist entry (file gone, or pattern removed) would silently
    // widen the guard's blind spot. Assert each allowlisted site still bears the
    // composition it is excusing.
    for (const entry of GRANT_RESOLVER_ALLOWLIST) {
      const content = readFileSync(path.join(REPO_ROOT, entry.file), 'utf8');
      expect(/isAdminPhone\s*\(\s*resolvePhoneFromJid\s*\(/.test(content)).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('grant-resolver-inventory-guard — refuses a tree it never examined', () => {
  const temps: string[] = [];
  afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function runGuardIn(cwd: string): { status: number; output: string } {
    const r = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', GUARD],
      { cwd, encoding: 'utf8', timeout: 120_000 },
    );
    return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  it('the real tree is examined over MANY files, so a pass is not vacuous', () => {
    // The count is the whole point: a clean result over hundreds of files is a real scan;
    // a clean result over zero files is the vacuity this floor exists to refuse.
    const { filesExamined, findings } = scanRepoGrantResolversCounted(REPO_ROOT);
    expect(findings).toEqual([]);
    expect(filesExamined).toBeGreaterThan(100);
  });

  it('exits 2 INCONCLUSIVE — not 0 — when src/ has no source files (empty tree)', () => {
    // Before the floor this exited 0 "no ungated grant compositions" having read nothing:
    // walkTsFiles(cwd/src) found no directory, 0 candidates, findings.length === 0 -> pass.
    const empty = mkdtempSync(path.join(tmpdir(), 'grant-empty-'));
    temps.push(empty);
    execFileSync('git', ['init', '-q'], { cwd: empty });
    const { status, output } = runGuardIn(empty);
    expect(status, `expected 2 INCONCLUSIVE, got ${status}:\n${output}`).toBe(2);
    expect(output).toMatch(/INCONCLUSIVE/i);
    expect(output).not.toMatch(/no ungated/i);
  });

  it('still exits 2 when src/ EXISTS but is empty (a location check is not a work check)', () => {
    const decoy = mkdtempSync(path.join(tmpdir(), 'grant-decoy-'));
    temps.push(decoy);
    mkdirSync(path.join(decoy, 'src'), { recursive: true });
    writeFileSync(path.join(decoy, 'package.json'), '{"name":"decoy"}');
    const { status, output } = runGuardIn(decoy);
    expect(status, `expected 2 on a decoy checkout, got ${status}:\n${output}`).toBe(2);
    expect(output).toMatch(/INCONCLUSIVE/i);
  });
});
