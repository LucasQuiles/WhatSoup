#!/usr/bin/env node
// scripts/grant-resolver-inventory-guard.ts
//
// CI inventory guard for QR-143 / B4. An admin/allow GRANT decision MUST
// resolve the sender through `resolvePhoneFromJidForGrant`, which requires a
// canonical sender identity in the namespace bound to the configured
// transport. The general resolver is intentionally transport-agnostic.
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
//     a grant site that resolves into a variable first. Those are reviewed in
//     the QR-143 call-site
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
      'isOperatorDmPeer peerBearsAdminIdentity — the GRANT decision is separately gated on isAuthenticatedSenderForTransport(chatJid, transport) before the elevation return; the identity match is ALSO needed on the untrusted branch to select the never-silent spoof-attempt warn subset (NFR-3). Routing through resolvePhoneFromJidForGrant would null the identity and silence that warn.',
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
        'inline isAdminPhone(resolvePhoneFromJid(...)) grant composition — use resolvePhoneFromJidForGrant (canonical and transport-bound), or add a justified allowlist row',
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
  const candidates: string[] = [];
  walkTsFiles(cwd, path.join(cwd, 'src'), candidates);
  const findings: GrantResolverFinding[] = [];
  for (const rel of candidates) {
    let content: string;
    try {
      content = readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      continue;
    }
    findings.push(...scanFileForGrantResolvers(rel, content));
  }
  return findings;
}

function main(): void {
  const cwd = process.cwd();
  const findings = scanRepoGrantResolvers(cwd);
  if (findings.length === 0) {
    console.log('grant-resolver-inventory-guard: no ungated isAdminPhone(resolvePhoneFromJid(...)) grant compositions (invariant.qr143-grant-primitive)');
    return;
  }
  console.error('grant-resolver-inventory-guard: ungated grant composition(s) detected — route through resolvePhoneFromJidForGrant or allowlist with justification (invariant.qr143-grant-primitive):');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} ${f.detail}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
