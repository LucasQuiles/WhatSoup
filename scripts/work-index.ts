import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanGitEnv, normalizeRepoPath } from './lib/guard-core.ts';

export type WorkIndexStatus =
  | 'active'
  | 'pending'
  | 'completed'
  | 'closed'
  | 'deferred'
  | 'unknown';

export type WorkIndexStatusSource =
  | 'bead-manifest'
  | 'body-marker'
  | 'state-md-status'
  | 'phase-log'
  | 'directory'
  | 'fallback';

export type WorkIndexKind = 'bead' | 'state' | 'doc' | 'plan' | 'spec' | 'handoff' | 'review';

export interface WorkIndexRow {
  path: string;
  kind: WorkIndexKind;
  topic_raw: string;
  topic: string;
  status: WorkIndexStatus;
  status_source: WorkIndexStatusSource;
  canonical_parent: string;
  supersedes_hint: string | null;
  last_modified: string;
  size_bytes: number;
}

export interface WorkIndexInconsistency {
  kind: 'missing-index-entry' | 'stale-index-entry';
  path: string;
}

export interface WorkIndexData {
  generated_at: string;
  repo: string;
  git_head: string;
  git_head_note: string;
  total: number;
  schema_version: number;
  rows: WorkIndexRow[];
  cross_tree_topics: Record<string, string[]>;
  inconsistencies: WorkIndexInconsistency[];
}

export interface WorkIndexCoverageIssue {
  missing: string[];
  stale: string[];
}

export interface WorkIndexDriftIssue {
  path: string;
  reason: string;
}

export interface WorkIndexCheckIssue extends WorkIndexCoverageIssue {
  drift: WorkIndexDriftIssue[];
  /**
   * Markdown present but gitignored under a canonical doc root (a root that
   * already holds at least one tracked .md). These are invisible to the
   * scanner (`git ls-files --exclude-standard` drops them), so without this
   * they would be silently omitted from the index (#640). Warn-class: the
   * operator should `git add -f` to track them, or confirm they are
   * intentionally local. Empty in a clean checkout / CI.
   */
  ignoredCanonical: string[];
}

const SCOPED_ROOTS = ['docs/sdlc', 'docs/superpowers', 'docs/plans'];
const WINDOW_LINES = 16;

const GIT_HEAD_NOTE =
  'git_head is captured at scan time, so it reflects the branch HEAD at the moment `build-work-index` ran \u2014 NOT the commit that carries this index. Expect divergence in two cases: (1) intra-branch, when the regenerated index is committed after further content changes are staged; (2) post-squash-merge, when the landed main SHA differs from the pre-merge branch SHA. The row data and inconsistency detection remain accurate regardless of git_head freshness.';

interface StateEpicInfo {
  status: WorkIndexStatus | null;
  statusSource: WorkIndexStatusSource | null;
  phaseLogStatus: WorkIndexStatus | null;
  beadStatusByName: Map<string, WorkIndexStatus>;
}

function repoRelative(cwd: string, absolutePath: string): string {
  return normalizeRepoPath(path.relative(cwd, absolutePath));
}

function walkMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(absolutePath);
    }
  }

  return results;
}

function normalizeStatus(raw: string): WorkIndexStatus {
  const value = raw.trim().toLowerCase();
  if (!value) return 'unknown';
  const leadingStatus = value.match(/^(in[_ -]?progress|active|pending|merged|completed?|complete|deferred|shelved|closed|unknown)\b/);
  if (leadingStatus) {
    const [, status] = leadingStatus;
    if (/^in[_ -]?progress$/.test(status) || status === 'active') return 'active';
    if (status === 'pending') return 'pending';
    if (status === 'merged' || status === 'complete' || status === 'completed') return 'completed';
    if (status === 'deferred' || status === 'shelved') return 'deferred';
    if (status === 'closed') return 'closed';
    return 'unknown';
  }
  if (/\bin[_-]?progress\b/.test(value) || /\bactive\b/.test(value)) return 'active';
  if (/\bpending\b/.test(value)) return 'pending';
  if (/\bmerged\b|\bcompleted?\b|\bcomplete\b/.test(value)) return 'completed';
  if (/\bdeferred\b|\bshelved\b/.test(value)) return 'deferred';
  if (/\bclosed\b/.test(value)) return 'closed';
  if (/\bunknown\b/.test(value)) return 'unknown';
  return 'unknown';
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function formatGeneratedAt(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function readText(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function firstWindow(text: string): string[] {
  return text.split(/\r?\n/).slice(0, WINDOW_LINES);
}

function parseInlineStatus(text: string): WorkIndexStatus | null {
  const window = firstWindow(text);
  for (const line of window) {
    const match = line.match(/^\s*(?:>\s*)?(?:\*\*)?Status:(?:\*\*)?\s*(.+?)\s*$/i)
      ?? line.match(/^\s*\|\s*\*?\*?Status\*?\*?\s*\|\s*(.+?)\s*\|?\s*$/i);
    if (match?.[1]) return normalizeStatus(match[1]);
  }
  return null;
}

function parseSupersedesHint(text: string): string | null {
  const window = firstWindow(text);
  for (const line of window) {
    const match = line.match(/^\s*(?:>\s*)?(?:\*\*)?Supersedes:(?:\*\*)?\s*(.+?)\s*$/i)
      ?? line.match(/^\s*(?:>\s*)?(?:\*\*)?Superseded by:(?:\*\*)?\s*(.+?)\s*$/i)
      ?? line.match(/^\s*(?:>\s*)?\[SUPERSEDED by\s+([^\]]+)\]\s*$/i);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function topicFromSdlcFolder(folder: string): string {
  return folder
    .replace(/-\d{8}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function topicFromSuperpowersStem(stem: string): string {
  return stem.replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

function kindFromPath(relativePath: string): WorkIndexKind | null {
  if (relativePath.startsWith('docs/sdlc/')) {
    if (relativePath.endsWith('/state.md')) return 'state';
    if (relativePath.includes('/beads/')) return 'bead';
    return 'doc';
  }

  if (relativePath.startsWith('docs/superpowers/plans/')) return 'plan';
  if (relativePath.startsWith('docs/superpowers/specs/')) return 'spec';
  if (relativePath.startsWith('docs/superpowers/handoffs/')) return 'handoff';
  if (relativePath.startsWith('docs/superpowers/reviews/')) return 'review';
  if (relativePath.startsWith('docs/plans/')) return 'plan';
  return null;
}

function canonicalParentFromPath(relativePath: string): string {
  if (relativePath.startsWith('docs/sdlc/')) {
    const parentDir = path.dirname(relativePath);
    return relativePath.includes('/beads/')
      ? path.dirname(parentDir).split(path.sep).join('/')
      : parentDir.split(path.sep).join('/');
  }
  if (relativePath.startsWith('docs/superpowers/')) return path.dirname(relativePath).split(path.sep).join('/');
  if (relativePath.startsWith('docs/plans/')) return 'docs/plans';
  return path.dirname(relativePath).split(path.sep).join('/');
}

function topicInfo(relativePath: string): { topicRaw: string; topic: string } {
  if (relativePath.startsWith('docs/sdlc/')) {
    const parentDir = path.dirname(relativePath);
    const epicFolder = path.basename(relativePath.includes('/beads/') ? path.dirname(parentDir) : parentDir);
    return { topicRaw: epicFolder, topic: topicFromSdlcFolder(epicFolder) };
  }

  const stem = path.basename(relativePath, '.md');
  return { topicRaw: stem, topic: topicFromSuperpowersStem(stem) };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitList(cwd: string, args: string[]): string[] {
  const output = git(cwd, args);
  return output ? output.split(/\r?\n/).map(normalizeRepoPath).filter(Boolean) : [];
}

function gitHead(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']);
}

function gitLastModified(cwd: string, relativePath: string, fallback: Date): string {
  try {
    const value = git(cwd, ['log', '-1', '--format=%cs', '--', relativePath]);
    return value || formatDate(fallback);
  } catch {
    return formatDate(fallback);
  }
}

function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

function extractPhaseLogStatus(text: string): WorkIndexStatus | null {
  const lines = text.split(/\r?\n/);
  const phaseIndex = lines.findIndex((line) => /^##+\s+Phase Log\b/i.test(line));
  if (phaseIndex < 0) return null;

  let headerLine = -1;
  for (let index = phaseIndex + 1; index < lines.length; index += 1) {
    if (/^##+\s+/.test(lines[index])) break;
    const cells = lines[index]
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length >= 2 && cells.some((cell) => /status/i.test(cell))) {
      headerLine = index;
      break;
    }
  }

  if (headerLine < 0) return null;
  const headers = lines[headerLine]
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  const statusColumn = headers.findIndex((cell) => /status/i.test(cell));
  if (statusColumn < 0) return null;

  const statuses: WorkIndexStatus[] = [];
  for (let index = headerLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##+\s+/.test(line)) break;
    if (!/^\|/.test(line)) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const values = cells.filter((cell) => cell.length > 0);
    if (values.length <= statusColumn) continue;
    const rawStatus = values[statusColumn];
    if (!rawStatus || /^-+$/.test(rawStatus)) continue;
    statuses.push(normalizeStatus(rawStatus));
  }

  if (statuses.some((status) => status === 'active' || status === 'pending')) return 'active';
  if (statuses.some((status) => status === 'completed')) return 'completed';
  if (statuses.some((status) => status === 'deferred')) return 'deferred';
  if (statuses.some((status) => status === 'closed')) return 'closed';
  return null;
}

function extractBeadManifest(text: string): Map<string, WorkIndexStatus> {
  const lines = text.split(/\r?\n/);
  const manifestIndex = lines.findIndex((line) => /^##+\s+Bead Manifest\b/i.test(line));
  const beadStatusByName = new Map<string, WorkIndexStatus>();
  if (manifestIndex < 0) return beadStatusByName;

  let headerLine = -1;
  for (let index = manifestIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break;
    if (/^\|/.test(lines[index]) && /status/i.test(lines[index])) {
      headerLine = index;
      break;
    }
  }

  if (headerLine < 0) return beadStatusByName;
  const headers = lines[headerLine]
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  const statusColumn = headers.findIndex((cell) => /status/i.test(cell));
  if (statusColumn < 0) return beadStatusByName;

  for (let index = headerLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line)) break;
    if (!/^\|/.test(line)) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const values = cells.filter((cell) => cell.length > 0);
    if (values.length <= statusColumn) continue;
    const beadName = values[0];
    const rawStatus = values[statusColumn];
    if (!beadName || /^-+$/.test(beadName) || !rawStatus || /^-+$/.test(rawStatus)) continue;
    beadStatusByName.set(beadName.replace(/\.md$/, ''), normalizeStatus(rawStatus));
  }

  return beadStatusByName;
}

function extractStateInfo(filePath: string): StateEpicInfo {
  const text = readText(filePath);
  const status = parseInlineStatus(text);
  const phaseLogStatus = status ? null : extractPhaseLogStatus(text);
  const beadStatusByName = extractBeadManifest(text);
  return {
    status,
    statusSource: status ? 'state-md-status' : phaseLogStatus ? 'phase-log' : null,
    phaseLogStatus,
    beadStatusByName,
  };
}

function resolveSdlcStatus(
  relativePath: string,
  stateInfo: StateEpicInfo | null,
  text: string,
): { status: WorkIndexStatus; statusSource: WorkIndexStatusSource } {
  if (path.basename(relativePath) === 'state.md') {
    if (stateInfo?.status) return { status: stateInfo.status, statusSource: 'state-md-status' };
    if (stateInfo?.phaseLogStatus) return { status: stateInfo.phaseLogStatus, statusSource: 'phase-log' };
    const bucket = relativePath.split('/')[2];
    if (bucket === 'active') return { status: 'active', statusSource: 'directory' };
    if (bucket === 'closed') return { status: 'closed', statusSource: 'directory' };
    if (bucket === 'completed') return { status: 'completed', statusSource: 'directory' };
    return { status: 'unknown', statusSource: 'fallback' };
  }

  const explicitBodyStatus = parseInlineStatus(text);
  if (explicitBodyStatus) return { status: explicitBodyStatus, statusSource: 'body-marker' };

  if (stateInfo) {
    const beadName = path.basename(relativePath, '.md');
    const beadStatus = stateInfo.beadStatusByName.get(beadName);
    if (beadStatus) return { status: beadStatus, statusSource: 'bead-manifest' };
  }

  if (stateInfo?.status) return { status: stateInfo.status, statusSource: 'state-md-status' };
  if (stateInfo?.phaseLogStatus) return { status: stateInfo.phaseLogStatus, statusSource: 'phase-log' };

  const bucket = relativePath.split('/')[2];
  if (bucket === 'active') return { status: 'active', statusSource: 'directory' };
  if (bucket === 'closed') return { status: 'closed', statusSource: 'directory' };
  if (bucket === 'completed') return { status: 'completed', statusSource: 'directory' };
  return { status: 'unknown', statusSource: 'fallback' };
}

function resolveSuperpowersStatus(text: string): { status: WorkIndexStatus; statusSource: WorkIndexStatusSource } {
  const explicitBodyStatus = parseInlineStatus(text);
  if (explicitBodyStatus) return { status: explicitBodyStatus, statusSource: 'body-marker' };
  return { status: 'unknown', statusSource: 'fallback' };
}

function resolveStatus(
  relativePath: string,
  stateInfoByEpic: Map<string, StateEpicInfo>,
  text: string,
): { status: WorkIndexStatus; statusSource: WorkIndexStatusSource } {
  if (relativePath.startsWith('docs/sdlc/')) {
    const parentDir = path.dirname(relativePath);
    const epicPath = relativePath.includes('/beads/') ? path.dirname(parentDir) : parentDir;
    const stateInfo = stateInfoByEpic.get(epicPath) ?? null;
    return resolveSdlcStatus(relativePath, stateInfo, text);
  }

  if (relativePath.startsWith('docs/superpowers/') || relativePath.startsWith('docs/plans/')) {
    return resolveSuperpowersStatus(text);
  }

  return { status: 'unknown', statusSource: 'fallback' };
}

function sdlcEpicsFromFiles(cwd: string, files: string[]): Map<string, StateEpicInfo> {
  const stateInfoByEpic = new Map<string, StateEpicInfo>();
  for (const filePath of files) {
    const relativePath = repoRelative(cwd, filePath);
    if (!relativePath.startsWith('docs/sdlc/') || !relativePath.endsWith('/state.md')) continue;
    stateInfoByEpic.set(path.dirname(relativePath), extractStateInfo(filePath));
  }
  return stateInfoByEpic;
}

export function compareWorkIndexCoverage(cwd: string, indexedPaths: Set<string>): WorkIndexCoverageIssue {
  const actual = listCandidateMarkdownFiles(cwd).map((absolutePath) => repoRelative(cwd, absolutePath)).sort();
  const missing = actual.filter((filePath) => !indexedPaths.has(filePath));
  const stale = [...indexedPaths].filter((filePath) => SCOPED_ROOTS.some((root) => filePath.startsWith(`${root}/`)) && !actual.includes(filePath)).sort();
  return { missing, stale };
}

function indexedPaths(rows: WorkIndexRow[]): Set<string> {
  return new Set(rows.map((row) => row.path));
}

// Doc roots that may legitimately mix tracked canonical docs with local-only
// scratch. A root is treated as canonical only when it currently holds at
// least one tracked .md (derived from repo state — no hardcoded policy), so a
// purely-local root like docs/plans is never flagged.
const CANONICAL_DOC_ROOT_CANDIDATES = ['docs/specs', 'docs/superpowers/plans', 'docs/superpowers', 'docs/sdlc', 'docs/plans'];

/**
 * Markdown that is present on disk but gitignored under a canonical doc root.
 * Returns repo-relative paths, sorted. Empty when git is unavailable or no
 * such files exist (e.g. a clean checkout). See WorkIndexCheckIssue.ignoredCanonical.
 */
export function findIgnoredCanonicalDocs(cwd = process.cwd()): string[] {
  const root = repoRoot(cwd);
  const found = new Set<string>();
  for (const docRoot of CANONICAL_DOC_ROOT_CANDIDATES) {
    let tracked: string[];
    let ignored: string[];
    try {
      tracked = gitList(root, ['ls-files', '--', docRoot]).filter((p) => p.endsWith('.md'));
      if (tracked.length === 0) continue; // not a canonical root — skip (local-only)
      ignored = gitList(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', docRoot])
        .filter((p) => p.endsWith('.md'));
    } catch {
      continue;
    }
    for (const p of ignored) found.add(p);
  }
  return [...found].sort();
}

function parseRows(cwd: string, files: string[]): WorkIndexRow[] {
  const stateInfoByEpic = sdlcEpicsFromFiles(cwd, files);
  const rows: WorkIndexRow[] = [];

  for (const absolutePath of files) {
    const relativePath = repoRelative(cwd, absolutePath);
    const kind = kindFromPath(relativePath);
    if (!kind) continue;

    const text = readText(absolutePath);
    const stat = statSync(absolutePath);
    const { topicRaw, topic } = topicInfo(relativePath);
    const { status, statusSource } = resolveStatus(relativePath, stateInfoByEpic, text);

    rows.push({
      path: relativePath,
      kind,
      topic_raw: topicRaw,
      topic,
      status,
      status_source: statusSource,
      canonical_parent: canonicalParentFromPath(relativePath),
      supersedes_hint: parseSupersedesHint(text),
      last_modified: gitLastModified(cwd, relativePath, stat.mtime),
      size_bytes: stat.size,
    });
  }

  rows.sort((left, right) => left.path.localeCompare(right.path));
  return rows;
}

function groupCrossTreeTopics(rows: WorkIndexRow[]): Record<string, string[]> {
  const topics = new Map<string, Set<string>>();
  for (const row of rows) {
    const parents = topics.get(row.topic) ?? new Set<string>();
    parents.add(row.canonical_parent);
    topics.set(row.topic, parents);
  }

  const grouped: Record<string, string[]> = {};
  for (const [topic, parents] of [...topics.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (parents.size < 2) continue;
    grouped[topic] = rows
      .filter((row) => row.topic === topic)
      .map((row) => row.path)
      .sort();
  }

  return grouped;
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function buildMarkdown(data: WorkIndexData): string {
  const kindCounts = countBy(data.rows.map((row) => row.kind));
  const statusCounts = countBy(data.rows.map((row) => row.status));
  const sourceCounts = countBy(data.rows.map((row) => row.status_source));
  const activeRows = data.rows.filter((row) => row.status === 'active');
  const unknownRows = data.rows.filter((row) => row.status === 'unknown');
  const crossTreeTopics = Object.entries(data.cross_tree_topics).sort(([left], [right]) => left.localeCompare(right));

  const lines: string[] = [];
  lines.push('# Work Index — crosswalk across docs/plans, docs/sdlc, docs/superpowers');
  lines.push('');
  lines.push(`> Generated by \`scripts/work-index.ts\` — first-pass metadata layer, **no file moves**. This file is generated; hand-edits will be overwritten on the next regeneration.`);
  lines.push('');
  lines.push('**Canonical status policy:** [`docs/canonical-status-policy.md`](canonical-status-policy.md)');
  lines.push('defines the authoring rules, epic-level vs child-artifact precedence, and known exceptions.');
  lines.push('The scanner implements those rules.');
  lines.push('');
  lines.push('**Row-level `status_source` labels** in this index:');
  lines.push('- `bead-manifest` — entry in the epic\'s `state.md` Bead Manifest table');
  lines.push('- `body-marker` — `Status:` marker in the file itself');
  lines.push('- `state-md-status` — epic-level `**Status:**` field in `state.md`');
  lines.push('- `phase-log` — derived from the `state.md` Phase Log status cell');
  lines.push('- `directory` — fallback based on `sdlc/active/` etc. placement (per policy, fallback only)');
  lines.push('- `fallback` — no authored marker; unresolved planning surface');
  lines.push('');
  lines.push('The **Inconsistencies** section lists missing or stale index entries compared with the');
  lines.push('scoped markdown files currently on disk.');
  lines.push('');
  lines.push(`**Repo:** \`${data.repo}\``);
  lines.push(`**Total entries:** ${data.total}`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push('| Dimension | Breakdown |');
  lines.push('|---|---|');
  lines.push(`| Kind | ${Object.entries(kindCounts).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(', ')} |`);
  lines.push(`| Status | ${Object.entries(statusCounts).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(', ')} |`);
  lines.push(`| Status source | ${Object.entries(sourceCounts).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join(', ')} |`);
  lines.push('');
  lines.push('## Inconsistencies');
  lines.push('');
  lines.push(`${data.inconsistencies.length} detected.`);
  lines.push('');

  if (activeRows.length > 0) {
    lines.push(`## Synthesis`);
    lines.push('');
    lines.push(`### Active (${activeRows.length})`);
    lines.push('');
    lines.push('| Path | Kind | Topic | Status source |');
    lines.push('|------|------|-------|---------------|');
    for (const row of activeRows) {
      lines.push(`| \`${row.path}\` | ${row.kind} | ${row.topic} | ${row.status_source} |`);
    }
    lines.push('');
  }

  if (unknownRows.length > 0) {
    if (!lines.includes('## Synthesis')) {
      lines.push('## Synthesis');
      lines.push('');
    }
    lines.push(`### Unknown-status — triage needed (${unknownRows.length})`);
    lines.push('');
    lines.push('| Path | Kind | Topic | Last Mod |');
    lines.push('|------|------|-------|----------|');
    for (const row of unknownRows) {
      lines.push(`| \`${row.path}\` | ${row.kind} | ${row.topic} | ${row.last_modified} |`);
    }
    lines.push('');
  }

  if (crossTreeTopics.length > 0) {
    if (!lines.includes('## Synthesis')) {
      lines.push('## Synthesis');
      lines.push('');
    }
    lines.push(`### Cross-tree topic clusters (${crossTreeTopics.length})`);
    lines.push('');
    lines.push('_Topics with entries in multiple canonical trees — candidates for canonical-home consolidation._');
    lines.push('');
    for (const [topic, paths] of crossTreeTopics) {
      const parents = new Set(data.rows.filter((row) => row.topic === topic).map((row) => row.canonical_parent));
      lines.push(`#### \`${topic}\`  —  ${paths.length} entries across ${parents.size} locations`);
      lines.push('');
      lines.push('| Path |');
      lines.push('|------|');
      for (const rowPath of paths) {
        lines.push(`| \`${rowPath}\` |`);
      }
      lines.push('');
    }
  }

  lines.push('## Full listing by canonical parent');
  lines.push('');

  const rowsByParent = new Map<string, WorkIndexRow[]>();
  for (const row of data.rows) {
    const group = rowsByParent.get(row.canonical_parent) ?? [];
    group.push(row);
    rowsByParent.set(row.canonical_parent, group);
  }

  for (const [parent, parentRows] of [...rowsByParent.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### ${parent}  _(${parentRows.length} entries)_`);
    lines.push('');
    lines.push('| Path | Kind | Status | Source | Topic | Last Mod | Supersedes |');
    lines.push('|------|------|--------|--------|-------|----------|------------|');
    for (const row of parentRows.sort((left, right) => left.path.localeCompare(right.path))) {
      lines.push(`| \`${row.path}\` | ${row.kind} | ${row.status} | ${row.status_source} | ${row.topic} | ${row.last_modified} | ${row.supersedes_hint ?? ''} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('- Derived from `docs/work-index.json`');
  lines.push(`- Generated at ${data.generated_at} from commit \`${data.git_head}\``);

  return lines.join('\n');
}

export function buildWorkIndex(cwd = process.cwd()): WorkIndexData {
  const root = repoRoot(cwd);
  const files = listCandidateMarkdownFiles(root);
  const rows = parseRows(root, files);
  const coverage = compareWorkIndexCoverage(root, indexedPaths(rows));

  return {
    generated_at: formatGeneratedAt(new Date()),
    repo: 'WhatSoup',
    git_head: gitHead(root),
    git_head_note: GIT_HEAD_NOTE,
    total: rows.length,
    schema_version: 5,
    rows,
    cross_tree_topics: groupCrossTreeTopics(rows),
    inconsistencies: [
      ...coverage.missing.map((filePath) => ({ kind: 'missing-index-entry' as const, path: filePath })),
      ...coverage.stale.map((filePath) => ({ kind: 'stale-index-entry' as const, path: filePath })),
    ],
  };
}

function listCandidateMarkdownFiles(cwd: string): string[] {
  try {
    return gitList(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SCOPED_ROOTS])
      .filter((filePath) => filePath.endsWith('.md'))
      .map((filePath) => path.join(cwd, filePath));
  } catch {
    return SCOPED_ROOTS.flatMap((scopeRoot) => walkMarkdownFiles(path.join(cwd, scopeRoot)));
  }
}

export function writeWorkIndex(cwd = process.cwd()): WorkIndexData {
  const data = buildWorkIndex(cwd);
  const root = repoRoot(cwd);
  const jsonPath = path.join(root, 'docs/work-index.json');
  const mdPath = path.join(root, 'docs/work-index.md');
  writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, `${buildMarkdown(data)}\n`, 'utf8');
  return data;
}

export function readWorkIndex(cwd = process.cwd()): WorkIndexData {
  const root = repoRoot(cwd);
  return JSON.parse(readFileSync(path.join(root, 'docs/work-index.json'), 'utf8')) as WorkIndexData;
}

export function findWorkIndexCoverageIssues(cwd = process.cwd()): WorkIndexCoverageIssue {
  const root = repoRoot(cwd);
  const data = readWorkIndex(root);
  return compareWorkIndexCoverage(root, indexedPaths(data.rows));
}

function normalizeVolatileMetadata(expected: WorkIndexData, actual: WorkIndexData): WorkIndexData {
  // `last_modified` is a commit date, not content: a squash-merge re-commits
  // byte-identical files under the merge date, so `%cs` moves whenever a PR is
  // authored on one UTC day and landed on the next. Comparing it would make a
  // correctly regenerated artifact stale the instant it lands — main went red
  // exactly this way after #2352. The field is display-only (rendered into the
  // Markdown tables, read by nothing), and `writeWorkIndex` still emits current
  // values, so every regeneration refreshes it.
  const committedLastModified = new Map(actual.rows.map((row) => [row.path, row.last_modified]));
  return {
    ...expected,
    generated_at: actual.generated_at,
    git_head: actual.git_head,
    rows: expected.rows.map((row) => {
      const committed = committedLastModified.get(row.path);
      return committed === undefined ? row : { ...row, last_modified: committed };
    }),
  };
}

export function findWorkIndexCheckIssues(cwd = process.cwd()): WorkIndexCheckIssue {
  const root = repoRoot(cwd);
  const actual = readWorkIndex(root);
  const expected = normalizeVolatileMetadata(buildWorkIndex(root), actual);
  const drift: WorkIndexDriftIssue[] = [];
  const jsonPath = path.join(root, 'docs/work-index.json');
  const mdPath = path.join(root, 'docs/work-index.md');
  const expectedJson = `${JSON.stringify(expected, null, 2)}\n`;
  const expectedMarkdown = `${buildMarkdown(expected)}\n`;

  if (readFileSync(jsonPath, 'utf8') !== expectedJson) {
    drift.push({ path: 'docs/work-index.json', reason: 'generated JSON differs from scanner output' });
  }
  if (readFileSync(mdPath, 'utf8') !== expectedMarkdown) {
    drift.push({ path: 'docs/work-index.md', reason: 'generated Markdown differs from scanner output' });
  }

  return {
    ...compareWorkIndexCoverage(root, indexedPaths(actual.rows)),
    drift,
    ignoredCanonical: findIgnoredCanonicalDocs(root),
  };
}

export function run(argv: string[], cwd = process.cwd()): WorkIndexData | WorkIndexCheckIssue {
  const args = new Set(argv);
  if (args.has('--check')) return findWorkIndexCheckIssues(cwd);
  return writeWorkIndex(cwd);
}

export function workIndexCheckSummary(result: WorkIndexCheckIssue): string {
  if (result.ignoredCanonical.length > 0) {
    return `work-index indexed artifacts clean; ignored canonical warnings=${result.ignoredCanonical.length}`;
  }
  return 'work-index clean';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = run(process.argv.slice(2));
    if ('missing' in result && 'stale' in result && 'drift' in result) {
      // Warn-class (#640): ignored markdown under a canonical doc root is
      // surfaced but never fails the gate. The summary names warning-bearing
      // states explicitly so the CLI does not imply a fully clean tree.
      for (const filePath of result.ignoredCanonical) {
        console.warn(`warning: ignored markdown under canonical doc root (not indexed — \`git add -f\` to track, or confirm it is intentionally local): ${filePath}`);
      }
      if (result.missing.length === 0 && result.stale.length === 0 && result.drift.length === 0) {
        console.log(workIndexCheckSummary(result));
      } else {
        for (const filePath of result.missing) console.error(`missing work-index entry: ${filePath}`);
        for (const filePath of result.stale) console.error(`stale work-index entry: ${filePath}`);
        for (const issue of result.drift) console.error(`stale generated work-index artifact: ${issue.path} (${issue.reason})`);
        process.exitCode = 1;
      }
    } else {
      console.log(`work-index regenerated: ${result.total} rows`);
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
