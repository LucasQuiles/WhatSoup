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

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  emitInventoryGuardReport,
  inventoryGuardCliFailure,
  inventorySourceFiles,
  parseInventoryGuardArgs,
  sourceInventoryDiagnostics,
  type InventoryGuardReport,
  type SourceInventoryCounts,
  type SourceInventoryFileSystem,
  type SourceInventoryIssue,
} from './lib/guard-core.ts';

export interface GrantResolverFinding {
  file: string;
  line: number;
  detail: string;
}

/**
 * A scan result that carries HOW MANY files were examined, not just what was found.
 * Zero findings over zero files is "I never looked at src/", which must not read as clean —
 * the same non-vacuity discipline as check-insecure-tempfile / no-destructive-git (#2102).
 */
export interface GrantResolverScan {
  findings: GrantResolverFinding[];
  filesExamined: number;
  scanIssues: SourceInventoryIssue[];
  scanIssueCount: number;
  scanIssuesOmitted: number;
  inventoryCounts: SourceInventoryCounts;
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

/**
 * Scan every non-test `.ts` file under `src/`, reporting BOTH the findings and how many
 * files were examined. The count is what lets `main` tell "scanned src/ and found nothing"
 * apart from "src/ was empty or absent, so nothing was scanned".
 */
export function scanRepoGrantResolversCounted(
  cwd: string,
  fileSystem?: SourceInventoryFileSystem,
): GrantResolverScan {
  const inventory = inventorySourceFiles({
    repoRoot: cwd,
    roots: ['src'],
    includeFile: (file) => TS_EXT_RE.test(file) && !file.endsWith('.test.ts'),
    excludeDirectory: (directory) => ['node_modules', '.git', 'dist'].includes(path.basename(directory)),
    fileSystem,
  });
  const findings: GrantResolverFinding[] = [];
  for (const file of inventory.files) {
    findings.push(...scanFileForGrantResolvers(file.path, file.content));
  }
  return {
    findings,
    filesExamined: inventory.counts.filesRead,
    scanIssues: inventory.issues,
    scanIssueCount: inventory.counts.issuesTotal,
    scanIssuesOmitted: inventory.counts.issuesOmitted,
    inventoryCounts: inventory.counts,
  };
}

export interface GrantResolverGuardEvaluation {
  status: 'pass' | 'block' | 'inconclusive';
  exitCode: 0 | 1 | 2;
  scan: GrantResolverScan;
}

export function evaluateGrantResolverInventoryGuard(
  cwd: string,
  fileSystem?: SourceInventoryFileSystem,
): GrantResolverGuardEvaluation {
  const scan = scanRepoGrantResolversCounted(cwd, fileSystem);
  if (scan.scanIssueCount > 0 || scan.filesExamined === 0) {
    return { status: 'inconclusive', exitCode: 2, scan };
  }
  if (scan.findings.length > 0) return { status: 'block', exitCode: 1, scan };
  return { status: 'pass', exitCode: 0, scan };
}

const TAG = 'grant-resolver-inventory-guard';

function reportFor(evaluation: GrantResolverGuardEvaluation): InventoryGuardReport {
  const { scan } = evaluation;
  return {
    schemaVersion: 1,
    guard: TAG,
    status: evaluation.status,
    exitCode: evaluation.exitCode,
    counts: {
      filesExamined: scan.filesExamined,
      findings: scan.findings.length,
      scanIssues: scan.scanIssueCount,
      scanIssuesOmitted: scan.scanIssuesOmitted,
      rootsScanned: scan.inventoryCounts.rootsScanned,
      directoriesScanned: scan.inventoryCounts.directoriesScanned,
      entriesInspected: scan.inventoryCounts.entriesInspected,
      candidatesFound: scan.inventoryCounts.candidatesFound,
    },
    diagnostics: [
      ...sourceInventoryDiagnostics({ issues: scan.scanIssues }),
      ...scan.findings.map((finding) => ({
        code: 'invariant.qr143-grant-primitive',
        path: finding.file,
        line: finding.line,
      })),
    ],
  };
}

function humanLines(evaluation: GrantResolverGuardEvaluation): string[] {
  const { findings, filesExamined } = evaluation.scan;
  if (evaluation.scan.scanIssueCount > 0) {
    return [
      `${TAG}: INCONCLUSIVE — ${evaluation.scan.scanIssueCount} source inventory issue(s); ` +
        'use --verbose or --json for bounded diagnostics.',
    ];
  }
  if (filesExamined === 0) {
    return [
      `${TAG}: INCONCLUSIVE — examined 0 source file(s) under src/. ` +
        'A scan that read zero files cannot certify the grant-composition invariant, which is not a pass.',
    ];
  }
  if (findings.length === 0) {
    return [
      `${TAG}: no ungated isAdminPhone(resolvePhoneFromJid(...)) grant compositions ` +
        `across ${filesExamined} source file(s) (invariant.qr143-grant-primitive)`,
    ];
  }
  const lines = [
    `${TAG}: ungated grant composition(s) detected — route through resolvePhoneFromJidForGrant or allowlist with justification (invariant.qr143-grant-primitive):`,
  ];
  for (const f of findings) {
    lines.push(`  ${f.file}:${f.line} ${f.detail}`);
  }
  return lines;
}

function main(argv: readonly string[] = process.argv.slice(2)): number {
  const parsed = parseInventoryGuardArgs(argv);
  if (!parsed.ok) {
    const report = inventoryGuardCliFailure(TAG, parsed.code);
    return emitInventoryGuardReport(report, parsed.mode, [`${TAG}: INCONCLUSIVE — ${parsed.code}`]);
  }
  const evaluation = evaluateGrantResolverInventoryGuard(process.cwd());
  return emitInventoryGuardReport(reportFor(evaluation), parsed.mode, humanLines(evaluation));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
