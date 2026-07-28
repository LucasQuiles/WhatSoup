/**
 * Canonical form for `docs/publication-audit.md`.
 *
 * Split out of `scripts/publication-guard.ts` so the guard stays under the
 * `arch.file-size` 2000-line warning threshold rather than joining the
 * grandfathered warning set — the same move `lib/repo-hygiene-policy.ts` made
 * for that guard. Everything here is PURE: parse markdown, render markdown.
 * All filesystem and git access stays in the guard, which keeps this module
 * trivially testable and keeps the write path's I/O in one place.
 */
import { normalizeRepoPath } from './guard-core.ts';
// Type-only back-edge: `PublicationClass` stays defined once, in the guard that
// owns the vocabulary. `import type` erases at runtime, so this creates no
// module cycle (guard:import-cycle excludes type-only edges) and no second
// source of truth for the classification set.
import type { PublicationClass } from '../publication-guard.ts';

export interface AuditEntry {
  classification: PublicationClass;
  rationale: string;
}

/**
 * Default rationale for a newly discovered internal doc. Deliberately the
 * most common existing wording so a generated row is indistinguishable from a
 * hand-written one; authors are expected to refine it when the doc warrants.
 */
export const DEFAULT_RATIONALE =
  'Internal planning or operational documentation; retained in the repository but excluded from public publication by default.';

/**
 * Rationale-preserving parse, used only by `--write`.
 *
 * `parsePublicationAudit` deliberately captures only path + classification —
 * that is all validation needs. Regenerating the document, however, must carry
 * 137 hand-authored rationales across verbatim; dropping them would replace
 * curated prose with boilerplate, a far worse defect than the merge churn this
 * exists to remove. Everything above the first `**Total classification rows:**`
 * line is preserved byte-for-byte as the preamble.
 */
export function parsePublicationAuditEntries(markdown: string): {
  preamble: string[];
  entries: Map<string, AuditEntry>;
} {
  const lines = markdown.split(/\r?\n/);
  const entries = new Map<string, AuditEntry>();
  const preamble: string[] = [];
  let seenTotal = false;

  for (const line of lines) {
    if (!seenTotal && /^\*\*Total classification rows:\*\*\s+\d+\s*$/.test(line)) {
      seenTotal = true;
      continue;
    }
    if (!seenTotal) {
      preamble.push(line);
      continue;
    }
    const row = line.match(/^\| `([^`]+)` \| (PUBLIC|PRIVATE-ARCHIVE|SANITIZE|DELETE) \| (.*?) \|\s*$/);
    if (row) {
      const filePath = normalizeRepoPath(row[1]);
      // First occurrence wins: if a bad merge duplicated a row, the earlier one
      // is the one a human reading top-down sees.
      if (!entries.has(filePath)) {
        entries.set(filePath, { classification: row[2] as PublicationClass, rationale: row[3] });
      }
    }
  }

  // Trim trailing blank lines so the renderer controls spacing exactly.
  while (preamble.length > 0 && preamble[preamble.length - 1].trim() === '') preamble.pop();
  return { preamble, entries };
}

/**
 * Render the canonical form: preserved preamble, exactly ONE declared-count
 * line, exactly ONE summary block, and rows sorted by byte order.
 *
 * Sorting is imposed rather than preserved on purpose. The checked-in document
 * is not sorted under any single collation (it has drifted through hand edits),
 * and a generator that preserves an arbitrary order cannot be a fixed point.
 * The idempotence property this buys is: render(parse(render(x))) === render(x).
 */
export function renderPublicationAudit(preamble: string[], entries: Map<string, AuditEntry>): string {
  const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const counts: Record<PublicationClass, number> = { PUBLIC: 0, 'PRIVATE-ARCHIVE': 0, SANITIZE: 0, DELETE: 0 };
  for (const [, entry] of sorted) counts[entry.classification] += 1;

  const out: string[] = [...preamble, ''];
  out.push(`**Total classification rows:** ${sorted.length}`, '');
  out.push('| Classification | Count |', '|---|---:|');
  out.push(`| PUBLIC | ${counts.PUBLIC} |`);
  out.push(`| PRIVATE-ARCHIVE | ${counts['PRIVATE-ARCHIVE']} |`);
  out.push(`| SANITIZE | ${counts.SANITIZE} |`);
  out.push(`| DELETE | ${counts.DELETE} |`);
  out.push(`| Total | ${sorted.length} |`, '');
  out.push('| Path | Classification | Rationale |', '|---|---|---|');
  for (const [filePath, entry] of sorted) {
    out.push(`| \`${filePath}\` | ${entry.classification} | ${entry.rationale} |`);
  }
  return `${out.join('\n')}\n`;
}


/**
 * Build the canonical document from the previous text plus the set of tracked
 * internal docs. Pure — the caller supplies `tracked` (from git) and performs
 * the write. Returns the rendered text and what changed, so a caller can report
 * a no-op honestly instead of implying work happened.
 */
export function buildCanonicalAudit(
  before: string,
  tracked: string[],
): { text: string; rows: number; added: string[]; removed: string[] } {
  const { preamble, entries } = parsePublicationAuditEntries(before);
  const next = new Map<string, AuditEntry>();
  const added: string[] = [];

  for (const filePath of tracked.map(normalizeRepoPath)) {
    const existing = entries.get(filePath);
    if (existing) next.set(filePath, existing);
    else {
      next.set(filePath, { classification: 'PRIVATE-ARCHIVE', rationale: DEFAULT_RATIONALE });
      added.push(filePath);
    }
  }
  const removed = [...entries.keys()].filter((p) => !next.has(p));

  return { text: renderPublicationAudit(preamble, next), rows: next.size, added, removed };
}
