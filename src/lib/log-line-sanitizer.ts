import {
  escapeNeutralView,
  PROTECTED_TEXT_WITHHELD_MARKER,
  protectedLinkRanges,
  replaceProtectedLinkRanges,
} from './protected-link-text.ts';

/**
 * Pino `hooks.streamWrite`: the protected-link scan over the final serialized
 * line, after every format argument (`%s`, `%j`, `%o`), object and error has
 * been rendered into it. The per-argument scan in log-sanitizer.ts cannot see
 * a link that only formatting assembles; this one sees the bytes the sink gets.
 * The line is JSON, so it is scanned through its escape-neutral view.
 */

// Past a scan bound the line is replaced by a fixed one that keeps only the
// numeric level and time Pino writes first, so readers still parse it.
function withheldLine(line: string): string {
  const prefix = /^\{"level":(\d{1,3}),"time":(\d{1,16})[,}]/.exec(line);
  const head = prefix ? `"level":${prefix[1]},"time":${prefix[2]},` : '';
  return `{${head}"msg":"${PROTECTED_TEXT_WITHHELD_MARKER}"}\n`;
}

/** Redact protected links from one serialized log line; never throws. */
export function sanitizingStreamWrite(line: string): string {
  // Every protected link has a `#`, and JSON never escapes it.
  if (!line.includes('#')) return line;
  const ranges = protectedLinkRanges(escapeNeutralView(line));
  if (ranges === null) return withheldLine(line);
  return replaceProtectedLinkRanges(line, ranges);
}
