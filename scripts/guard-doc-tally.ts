#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readText } from './lib/guard-core.ts';

/**
 * Doc-tally split-brain guard.
 *
 * A doc that declares a count in a header (e.g. "12 items total") and then
 * enumerates that many rows/items in its body can silently drift when a merge
 * or edit changes one side but not the other (see WhatSoup campaign issue
 * #1524, where `docs/publication-audit.md`'s header row-count diverged from the
 * actual table during a merge). The existing `guard:publication` script already
 * enforces this invariant for the publication-audit doc, but it is welded to
 * that doc's classification-row schema and cannot be reused for other docs.
 *
 * This guard generalizes the same header-count-vs-actual-rows invariant to a
 * small, explicit registry of hand-maintained tally docs. It is deliberately
 * OPT-IN per doc (not a repo-wide scan) because prose is full of count-like
 * phrases ("8 agents", "31 files use c-btn") that are NOT tallies — a broad
 * scan would false-positive constantly. Only docs a human has verified as a
 * genuine "declared header count === countable body rows" tally belong here.
 *
 * publication-audit.md and work-index.md are intentionally NOT in this registry:
 * the former is fully covered by `guard:publication`, the latter is regenerated
 * and checked by `guard:work-index`. Re-guarding them here would be duplication.
 */

export interface TallyDoc {
  /** Repo-relative doc path. */
  docPath: string;
  /**
   * Regex whose first capture group is the declared count. Matched per-line
   * (multiline). Must match exactly one line in the doc.
   */
  headerCountPattern: RegExp;
  /**
   * Regex that matches one body row/item. Counted per-line (multiline). Its
   * total match count is the actual tally.
   */
  rowPattern: RegExp;
  /** Human-readable description of what the count represents. */
  label: string;
}

/**
 * Registry of hand-maintained tally docs. Each entry has been verified to be a
 * genuine declared-count-header-plus-countable-rows tally with an unambiguous
 * row pattern. Add a doc here only after confirming its declared count equals
 * its actual row count on a clean main.
 */
export const tallyDocs: TallyDoc[] = [
  {
    docPath: 'docs/work-index-repair-matrix.md',
    // Prose: "**Source:** `docs/work-index.json.inconsistencies` ... (12 items total)."
    headerCountPattern: /\((\d+) items total\)/,
    // Body: numbered disposition table rows "| 6 | `...` | ... |".
    rowPattern: /^\| \d+ \| /,
    label: 'work-index inconsistency disposition rows',
  },
];

export type TallyIssueCode =
  | 'doc-missing'
  | 'header-count-missing'
  | 'header-count-ambiguous'
  | 'row-count-zero'
  | 'count-mismatch';

export interface TallyIssue {
  docPath: string;
  code: TallyIssueCode;
  message: string;
}

interface CountResult {
  declared?: number;
  declaredMatches: number;
  actual: number;
}

/**
 * Pure counting core. Returns the declared header count, how many header lines
 * matched (to detect ambiguity), and the actual body row count.
 */
export function countTally(content: string, doc: TallyDoc): CountResult {
  const lines = content.split(/\r?\n/);
  let declared: number | undefined;
  let declaredMatches = 0;
  let actual = 0;

  for (const line of lines) {
    const headerMatch = line.match(doc.headerCountPattern);
    if (headerMatch) {
      declaredMatches += 1;
      if (declared === undefined) declared = Number(headerMatch[1]);
    }
    if (doc.rowPattern.test(line)) actual += 1;
  }

  return { declared, declaredMatches, actual };
}

/** Validate a single doc's content against its tally spec. Pure. */
export function validateTallyDoc(content: string | null, doc: TallyDoc): TallyIssue[] {
  if (content === null) {
    return [
      {
        docPath: doc.docPath,
        code: 'doc-missing',
        message: `${doc.docPath} is registered as a tally doc but was not found.`,
      },
    ];
  }

  const { declared, declaredMatches, actual } = countTally(content, doc);

  if (declaredMatches === 0 || declared === undefined) {
    return [
      {
        docPath: doc.docPath,
        code: 'header-count-missing',
        message: `${doc.docPath} declares no ${doc.label} count matching ${doc.headerCountPattern}.`,
      },
    ];
  }

  if (declaredMatches > 1) {
    return [
      {
        docPath: doc.docPath,
        code: 'header-count-ambiguous',
        message: `${doc.docPath} has ${declaredMatches} lines matching the declared-count pattern ${doc.headerCountPattern}; expected exactly one.`,
      },
    ];
  }

  if (actual === 0) {
    return [
      {
        docPath: doc.docPath,
        code: 'row-count-zero',
        message: `${doc.docPath} matched zero rows for ${doc.rowPattern}; the row pattern may be stale.`,
      },
    ];
  }

  if (declared !== actual) {
    return [
      {
        docPath: doc.docPath,
        code: 'count-mismatch',
        message: `${doc.docPath} declares ${declared} ${doc.label}, but the body has ${actual}.`,
      },
    ];
  }

  return [];
}

export function validateDocTally(cwd: string, docs: TallyDoc[] = tallyDocs): TallyIssue[] {
  const issues: TallyIssue[] = [];
  for (const doc of docs) {
    issues.push(...validateTallyDoc(readText(cwd, doc.docPath), doc));
  }
  return issues;
}

function printHelp(): void {
  console.log(`Usage: npm run guard:doc-tally

Verifies that each hand-maintained tally doc's declared header count matches its
actual body row count (doc-tally split-brain guard, campaign issue #1524 class).
The set of guarded docs is an explicit opt-in registry inside
scripts/guard-doc-tally.ts.`);
}

export function runDocTallyGuard(argv = process.argv.slice(2), cwd = process.cwd()): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }

  const issues = validateDocTally(cwd);

  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(`${issue.docPath} error ${issue.code}: ${issue.message}`);
    }
    console.error(`guard:doc-tally failed: ${issues.length} error(s)`);
    return 1;
  }

  console.log(`guard:doc-tally passed: ${tallyDocs.length} tally doc(s) consistent`);
  return 0;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = runDocTallyGuard();
}
