import {
  PROTECTED_TEXT_WITHHELD_MARKER,
  protectedLinkRanges,
  replaceProtectedLinkRanges,
} from './protected-link-text.ts';

/**
 * Pino `hooks.streamWrite`: the protected-link scan over the final serialized
 * line, after every format argument (`%s`, `%j`, `%o`), object and error has
 * been rendered into it. The per-argument scan in log-sanitizer.ts cannot see
 * a link that only formatting assembles; this one sees the bytes the sink gets.
 */

const BACKSLASH = 0x5c;

function isHexDigit(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

// JSON escapes `"`, `\` and control characters, so a link's boundary in the
// raw text can arrive as `\n` or `\u0001`, whose letters and hex digits read as
// host characters and would glue onto a bare host. Each backslash run and the
// escape letter (or `u` and four hex digits) after it becomes a space in a
// same-length view. JSON never escapes a host or fragment character, so a link
// never spans a replaced position and the view's ranges splice the original
// line without breaking an escape. Treating the letter after any backslash run
// as an escape also covers text encoded twice, such as a `%j` value.
function escapeNeutralView(line: string): string {
  let view = '';
  let cursor = 0;
  for (let index = line.indexOf('\\'); index !== -1; index = line.indexOf('\\', cursor)) {
    let end = index;
    while (line.charCodeAt(end) === BACKSLASH) end++;
    const letter = line[end];
    if (letter !== undefined && 'bfnrt"/'.includes(letter)) end++;
    else if (letter === 'u' && [1, 2, 3, 4].every((offset) => isHexDigit(line.charCodeAt(end + offset)))) end += 5;
    view += `${line.slice(cursor, index)}${' '.repeat(end - index)}`;
    cursor = end;
  }
  return cursor === 0 ? line : `${view}${line.slice(cursor)}`;
}

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
