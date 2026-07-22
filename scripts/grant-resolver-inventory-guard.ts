#!/usr/bin/env node
// scripts/grant-resolver-inventory-guard.ts
//
// CI inventory guard for QR-143 / B4. A phone-keyed admin/allow GRANT decision
// MUST resolve the sender's phone through `resolvePhoneFromJidForGrant` (which
// fails closed for non-WhatsApp-authenticated transports), NOT through the
// general-purpose `resolvePhoneFromJid`, which collapses a spoofable
// `<digits>@sms` JID to the SAME bare phone as a real WhatsApp admin.
//
// This guard fails the build when a NEW inline `isAdminPhone(resolvePhoneFromJid(...))`
// composition appears in `src/` outside an explicitly-justified allowlist, so a
// future ungated grant cannot ship unaudited.
//
// SCOPE / LIMITS (stated honestly, not overclaimed):
//   - The scan matches only the INLINE composed form
//     `isAdminPhone( ... resolvePhoneFromJid( ...` (newline/whitespace tolerant).
//   - It deliberately does NOT match `resolvePhoneFromJidForGrant(` — the token
//     boundary (`resolvePhoneFromJid` immediately followed by `ForGrant`, never
//     by `(`) distinguishes the primitive from the general resolver.
//   - It does NOT catch a DECOMPOSED grant
//     (`const p = resolvePhoneFromJid(jid, db); ... isAdminPhone(p)`), e.g.
//     `main.ts` (author-of-group auto-allow) or the migrated B1/B3 sites, which
//     resolve into a variable first. Those are reviewed in the QR-143 call-site
//     audit; this guard is a cheap tripwire for the most common re-introduction
//     shape, not a total proof.
//   - The audit's "(a) inside the primitive itself" clause is vacuous here: the
//     primitive composes `resolvePhoneFromJid`, never `isAdminPhone`, so it never
//     matches the pattern.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface GrantResolverFinding {
  file: string;
  line: number;
  detail: string;
}

/**
 * Allowlisted inline `isAdminPhone(resolvePhoneFromJid(...))` sites that are
 * intentionally NOT routed through the grant primitive. Each carries a
 * justification; a reviewer adding a row must explain why the site is
 * deny-side / display-side / warn-side rather than a grant.
 */
export const GRANT_RESOLVER_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'src/core/outbound-message-safety.ts',
    reason:
      'isOperatorDmPeer peerBearsAdminDigits — the GRANT decision is separately gated on isWhatsAppAuthenticatedJid(chatJid) before the elevation return; the phone match is ALSO needed on the UNauthenticated branch to select the never-silent spoof-attempt warn subset (NFR-3). Routing through resolvePhoneFromJidForGrant would null the phone on @sms and silence that warn.',
  },
];

// Newline/whitespace-tolerant: matches `isAdminPhone( ... resolvePhoneFromJid(`
// but NOT `resolvePhoneFromJidForGrant(` (the char after `resolvePhoneFromJid`
// there is `F`, which cannot satisfy `\s*\(`).
const GRANT_COMPOSITION_RE = /isAdminPhone\s*\(\s*resolvePhoneFromJid\s*\(/g;

const TS_EXT_RE = /\.ts$/;

/**
 * Blank out `//` line comments and block comments so prose that MENTIONS the
 * pattern (like this guard's own docs, or the primitive's doc block) is not
 * flagged — only real code is. Newlines are preserved so match line numbers
 * stay accurate. Not string-literal-aware, which is fine: a pattern embedded in
 * a string is not a live grant call.
 */
export function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function isAllowlisted(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join('/');
  return GRANT_RESOLVER_ALLOWLIST.some((entry) => entry.file === normalized);
}

/** Scan a single file's content for inline ungated grant compositions. */
export function scanFileForGrantResolvers(relPath: string, content: string): GrantResolverFinding[] {
  if (isAllowlisted(relPath)) return [];
  const scannable = stripComments(content);
  const findings: GrantResolverFinding[] = [];
  GRANT_COMPOSITION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GRANT_COMPOSITION_RE.exec(scannable)) !== null) {
    const line = content.slice(0, match.index).split('\n').length;
    findings.push({
      file: relPath.split(path.sep).join('/'),
      line,
      detail:
        'inline isAdminPhone(resolvePhoneFromJid(...)) grant composition — use resolvePhoneFromJidForGrant (fails closed for @sms), or add a justified allowlist row',
    });
  }
  return findings;
}

function walkTsFiles(root: string, dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTsFiles(root, full, acc);
    } else if (TS_EXT_RE.test(entry) && !entry.endsWith('.test.ts')) {
      acc.push(path.relative(root, full));
    }
  }
}

/** Scan every non-test `.ts` file under `src/` for ungated grant compositions. */
export function scanRepoGrantResolvers(cwd: string): GrantResolverFinding[] {
  return scanRepoGrantResolversDetailed(cwd).findings;
}

export interface GrantResolverScanResult {
  findings: GrantResolverFinding[];
  /** How many files were actually read. Zero means the verdict is meaningless. */
  scannedFiles: number;
}

/**
 * Same scan, but reports what it examined.
 *
 * `walkTsFiles` swallows a `readdirSync` failure and returns, which is right for a
 * permission-denied subdirectory and wrong for a missing `src/`: both produce zero
 * candidates, and zero candidates produced a confident "no ungated grant compositions".
 * The caller cannot tell a clean tree from an unexamined one without this count.
 */
export function scanRepoGrantResolversDetailed(cwd: string): GrantResolverScanResult {
  const candidates: string[] = [];
  walkTsFiles(cwd, path.join(cwd, 'src'), candidates);
  const findings: GrantResolverFinding[] = [];
  let scannedFiles = 0;
  for (const rel of candidates) {
    let content: string;
    try {
      content = readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      continue;
    }
    scannedFiles += 1;
    findings.push(...scanFileForGrantResolvers(rel, content));
  }
  return { findings, scannedFiles };
}

/**
 * Exit 2 means INCONCLUSIVE — distinct from 1 (examined it, found a violation) and 0
 * (examined it, it is clean). Collapsing "could not examine" into either one sends an
 * operator hunting for a violation that does not exist, or ships a false green.
 *
 * This guard is a named step in quality.yml, so a "clean" verdict from a tree it never
 * read is a false green in CI, not merely on a developer's laptop.
 */
function main(): number {
  const cwd = process.cwd();
  try {
    statSync(path.join(cwd, 'src'));
  } catch {
    console.error(
      // Deliberately does NOT quote the clean-verdict phrase. An earlier draft did, and the
      // empty-scope suite's "must not print a clean verdict" assertion matched the REFUSAL
      // itself — a text scanner cannot tell using a phrase from naming it.
      `grant-resolver-inventory-guard: INCONCLUSIVE — no src/ under ${cwd}, so this is not a ` +
        'repo checkout; refusing to report a clean verdict for a tree that was never examined',
    );
    return 2;
  }

  let result: GrantResolverScanResult;
  try {
    result = scanRepoGrantResolversDetailed(cwd);
  } catch (err) {
    console.error(`grant-resolver-inventory-guard: FATAL ${(err as Error).message}`); // fail-closed
    return 2;
  }

  if (result.scannedFiles === 0) {
    console.error(
      `grant-resolver-inventory-guard: INCONCLUSIVE — examined 0 non-test .ts files under ` +
        `${path.join(cwd, 'src')}; a wrong cwd, a stripped checkout, or an unreadable tree ` +
        'looks exactly like a clean one, so no verdict is reported',
    );
    return 2;
  }

  if (result.findings.length === 0) {
    console.log(
      `grant-resolver-inventory-guard: no ungated isAdminPhone(resolvePhoneFromJid(...)) grant compositions ` +
        `in ${result.scannedFiles} files (invariant.qr143-grant-primitive)`,
    );
    return 0;
  }
  console.error('grant-resolver-inventory-guard: ungated grant composition(s) detected — route through resolvePhoneFromJidForGrant or allowlist with justification (invariant.qr143-grant-primitive):');
  for (const f of result.findings) {
    console.error(`  ${f.file}:${f.line} ${f.detail}`);
  }
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
