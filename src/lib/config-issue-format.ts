/**
 * Config validation issue formatting.
 *
 * Formats validation issues for terminal, log, and diagnostic output. Two
 * concerns that belong together:
 *
 * 1. **Terminal safety** — config text is user-edited, so it can contain ANSI
 *    escape sequences that would corrupt output or inject control codes. All
 *    text is sanitized before formatting.
 * 2. **Bounded summaries** — a long list of issues is useless in a one-line
 *    status or a compact recovery diagnostic. `formatConfigIssueSummary`
 *   shows the first N and reports the hidden count.
 *
 * Path normalization: empty / null / blank paths become `<root>` so the output
 * is always a valid `- <path>: <message>` pair.
 */

/** A single config validation issue. */
export interface ConfigIssue {
  /** Dotted config path (e.g. `messages.timeout`). Empty = root. */
  path?: string | null;
  /** Human-readable description of the problem. */
  message: string;
  /** Valid values for enum-type fields, if applicable. */
  allowedValues?: readonly string[];
  /** Count of additional valid values hidden for brevity. */
  allowedValuesHiddenCount?: number;
}

const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]/g;
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Strip ANSI escape sequences and non-printable control characters from text.
 * Keeps tabs, newlines (`\n`), and carriage returns so multi-line messages
 * remain readable.
 */
export function sanitizeTerminalText(text: string): string {
  return text.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARS, '');
}

/** Normalize a missing or blank config path to the root marker. */
export function normalizeConfigIssuePath(path: string | null | undefined): string {
  if (typeof path !== 'string') {
    return '<root>';
  }
  const trimmed = path.trim();
  return trimmed || '<root>';
}

/** Options for line-level formatting. */
export interface IssueLineOptions {
  /** Bullet/marker prefix. Default `"-"`. Pass `""` for no prefix. */
  marker?: string;
  /** Normalize empty paths to `<root>`. Default `true`. */
  normalizeRoot?: boolean;
}

/** Format one config issue as a single terminal-safe line. */
export function formatConfigIssueLine(issue: ConfigIssue, options: IssueLineOptions = {}): string {
  const marker = options.marker ?? '-';
  const normalizeRoot = options.normalizeRoot ?? true;
  const prefix = marker ? `${marker} ` : '';
  const rawPath = normalizeRoot
    ? normalizeConfigIssuePath(issue.path)
    : typeof issue.path === 'string'
      ? issue.path
      : '';
  const path = sanitizeTerminalText(rawPath);
  const message = sanitizeTerminalText(issue.message);
  return `${prefix}${path}: ${message}`;
}

/** Format multiple issues as terminal-safe lines. */
export function formatConfigIssueLines(
  issues: readonly ConfigIssue[],
  options: IssueLineOptions = {},
): string[] {
  return issues.map((issue) => formatConfigIssueLine(issue, options));
}

/** Options for bounded summary formatting. */
export interface IssueSummaryOptions extends IssueLineOptions {
  /** Maximum issues to show before truncating. Default 5. Minimum 1. */
  maxIssues?: number;
  /** Join separator between visible issues. Default `"; "`. */
  separator?: string;
}

/**
 * Build a compact, terminal-safe, bounded summary of config issues.
 *
 * Shows the first `maxIssues` entries joined by `separator`, then appends
 * `"; and N more"` if there are hidden issues. Returns `null` for an empty
 * list so the caller can omit the line entirely.
 */
export function formatConfigIssueSummary(
  issues: readonly ConfigIssue[],
  options: IssueSummaryOptions = {},
): string | null {
  if (issues.length === 0) {
    return null;
  }
  const maxIssues = Math.max(1, Math.floor(options.maxIssues ?? 5));
  const separator = options.separator ?? '; ';
  const visible = issues.slice(0, maxIssues);
  const lines = visible.map((issue) =>
    formatConfigIssueLine(issue, { marker: '', normalizeRoot: options.normalizeRoot ?? true }),
  );
  const hidden = issues.length - visible.length;
  if (hidden <= 0) {
    return lines.join(separator);
  }
  return `${lines.join(separator)}${separator}and ${hidden} more`;
}

/**
 * Format the `allowedValues` of a single issue for inline display.
 * Returns `null` if the issue has no allowed values.
 */
export function formatAllowedValues(issue: ConfigIssue): string | null {
  if (!Array.isArray(issue.allowedValues) || issue.allowedValues.length === 0) {
    return null;
  }
  const values = issue.allowedValues.map((v) => sanitizeTerminalText(v)).join(', ');
  const hidden =
    typeof issue.allowedValuesHiddenCount === 'number' && issue.allowedValuesHiddenCount > 0
      ? ` (+${issue.allowedValuesHiddenCount} hidden)`
      : '';
  return `allowed: ${values}${hidden}`;
}
