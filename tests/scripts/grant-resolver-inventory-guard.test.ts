/**
 * B4 / QR-143 — CI inventory guard: a phone-keyed admin/allow GRANT must resolve
 * through resolvePhoneFromJidForGrant (fails closed for @sms), not the general
 * resolvePhoneFromJid. This meta-test proves the guard flags a new inline
 * ungated grant composition, honours the allowlist, and passes on the live tree.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scanFileForGrantResolvers,
  scanRepoGrantResolvers,
  GRANT_RESOLVER_ALLOWLIST,
} from '../../scripts/grant-resolver-inventory-guard.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
