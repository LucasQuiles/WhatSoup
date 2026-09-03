/**
 * Governed-environment drift comparison for generated launchd instance plists.
 *
 * Installed bot plists carry live credentials in EnvironmentVariables
 * (observed on the fleet), so their content is NEVER printed, diffed, or
 * embedded in a report. This comparator inspects the governed key set
 * (CLAUDE_CONFIG_DIR, PATH, WHATSOUP_PATH_PREPEND) and reports presence plus
 * SHA-256 value digests — enough to detect missing/extra/mismatched governed
 * keys without exposing a single environment value. Non-governed keys
 * contribute only their NAMES, and only when a re-render would drop them from
 * the job.
 *
 * The answer this reader owes for every input shape — refuse, empty or map —
 * is docs/runbooks/launchd-governed-env-reader-contract.md, and
 * deploy/scripts/bot-errors-health-check.py reads the same file to the same
 * contract. Both are held to one corpus at
 * tests/fixtures/launchd-env-plist-contract/. Change the contract before
 * changing either reader.
 */
import { createHash } from 'node:crypto';

export const GOVERNED_LAUNCHD_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'PATH', 'WHATSOUP_PATH_PREPEND'] as const;

export type GovernedLaunchdEnvKey = (typeof GOVERNED_LAUNCHD_ENV_KEYS)[number];

export type GovernedEnvDriftState = 'missing' | 'extra' | 'mismatch';

export interface GovernedEnvDriftEntry {
  key: GovernedLaunchdEnvKey;
  /**
   * missing — expected in the fresh render but absent from the installed
   * plist; extra — installed but not expected (e.g. a hand-added governed key
   * with no config source); mismatch — present on both sides with different
   * values.
   */
  state: GovernedEnvDriftState;
  /** SHA-256 hex of the expected (rendered) value; null when not expected. */
  expectedDigest: string | null;
  /** SHA-256 hex of the installed value; null when not installed. */
  observedDigest: string | null;
}

/**
 * PATH decomposed into the config-owned fact and the ambient fact. The
 * rendered PATH is `pathPrepend...:<rendering shell's PATH>`, so a differing
 * tail can mean either a hand-patched prefix with no config source or simply
 * a different rendering shell (npm run adds node_modules/.bin, the pinned-node
 * wrapper prepends its bin dir). Only an unsatisfied CONFIGURED prefix is
 * governed drift; a satisfied prefix with a different tail is reported here as
 * "config satisfied; tail differs", never as a governed mismatch.
 */
export interface GovernedPathPrefixReport {
  /** Whether a non-empty pathPrepend is configured. */
  configured: boolean;
  /** Installed PATH starts with the configured prepend entries (trivially true when none configured). */
  satisfied: boolean;
  /** Full PATH values differ once the prefix is accounted for. */
  ambientTailDiffers: boolean;
  expectedDigest: string;
  observedDigest: string;
}

export interface GovernedEnvComparison {
  /**
   * False whenever the reader cannot enumerate the installed
   * EnvironmentVariables dict — absent, declared more than once, or present and
   * unparseable — fail-closed, never "no drift".
   */
  comparable: boolean;
  reason?: 'environment-variables-unparseable';
  drift: GovernedEnvDriftEntry[];
  /**
   * Installed non-governed EnvironmentVariables key NAMES absent from the
   * fresh render — an apply deletes them from the job (credential keys live
   * here on the fleet). Sorted; names only, never values.
   */
  droppedNonGovernedKeys: string[];
  /** Present when PATH exists on both sides. */
  pathPrefix?: GovernedPathPrefixReport;
}

export interface CompareGovernedLaunchdEnvOptions {
  /** The configured pathPrepend the expected render was built from. */
  pathPrepend?: readonly string[];
}

/** Whole-entry prefix match: `/opt/bin` must not satisfy an installed `/opt/bin-other:...`. */
function pathStartsWithEntries(value: string, entries: readonly string[]): boolean {
  if (entries.length === 0) return true;
  const prefix = entries.join(':');
  return value === prefix || value.startsWith(`${prefix}:`);
}

/** Reverse of platform.ts escapeXml for values read back out of a plist. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

const ENV_KEY_MARKER = '<key>EnvironmentVariables</key>';
/**
 * The dict ELEMENT token, not one literal spelling of it. `<dict>`, `<dict >`,
 * `<dict\n>`, `<dict/>` and `<dict attr="x">` are the same element to any plist
 * reader, so matching the literal '<dict>' made the nested-dict guard below miss
 * every other spelling: the body still truncated at the first `</dict>` and a
 * governed key declared AFTER the nested dict read as absent rather than making
 * the comparison fail closed. The lookahead keeps a `<dictionary>` out.
 *
 * Held as SOURCE, not as a RegExp: a module-scope /g pattern carries lastIndex
 * between calls and one comparison parses two plists.
 */
const DICT_OPEN_TOKEN_SOURCE = '<dict(?=[ \\t\\r\\n/>])';
/**
 * What this reader will PARSE is narrower than what it DETECTS: plain,
 * whitespace-padded and self-closing only. An attributed dict is refused rather
 * than consumed — consuming to the first '>' would end the token early on a
 * legal `<dict a="x>y">` and the rest of the opening tag would be read as body
 * pairs, injecting a governed key from inside a tag. plist(5) dicts carry no
 * attributes, so refusing costs nothing and fails closed.
 */
const DICT_OPEN_SOURCE = '<dict[ \\t\\r\\n]*(/?)>';
const DICT_CLOSE_SOURCE = '</dict[ \\t\\r\\n]*>';
/**
 * XML whitespace is exactly these four characters. \s and String.trim() also
 * accept \v, \f and the Unicode spaces, which the system plist parser rejects,
 * so a plist this comparator called well-formed could be one launchd refuses.
 */
const XML_SPACE_ONLY = /^[ \t\r\n]*$/;

/**
 * The XML region kinds this reader must never read as markup, as
 * (opener, closer) pairs. A comment, a CDATA section and a processing
 * instruction are all inert text to the system plist parser: an
 * EnvironmentVariables marker or a dict spelled inside one is not a marker and
 * not a dict, however legal the surrounding file is.
 *
 * Comments alone were covered before, and the other two were live text to the
 * indexOf below: a CDATA section or a processing instruction carrying a decoy
 * `<key>EnvironmentVariables</key><dict/>` ahead of the live dict won the
 * lookup, the empty decoy was read as the environment, and an apply then
 * deleted every non-governed key the installed plist carried while naming none.
 * Both spellings lint clean and `plutil -extract EnvironmentVariables json`
 * returns the REAL environment for them, so this reader was disagreeing with
 * the authoritative parser about a valid file.
 */
const INERT_XML_REGIONS: readonly (readonly [string, string])[] = [
  ['<!--', '-->'],
  ['<![CDATA[', ']]>'],
  ['<?', '?>'],
];

interface MaskedPlist {
  /** Same length as the input, every inert region replaced by a run of '-'. */
  masked: string;
  /** [start, end) of each region blanked, in ascending order. */
  inertSpans: readonly (readonly [number, number])[];
}

/**
 * Blank every inert XML region, PRESERVING LENGTH, or null if one is
 * unterminated — and REPORT where they were.
 *
 * MASKED, not deleted, and that is the whole design:
 *   - length is preserved, so every offset below still indexes the real file
 *     and the body slice stays byte-aligned with it. No offset map to keep
 *     honest, and a decoy dies because its CONTENT is masked, wherever it
 *     sits — not because it happened to precede the marker.
 *   - '-' is not XML whitespace, so an inert region in a whitespace-only GAP
 *     (between the marker and its dict, or between a key and its string) still
 *     fails the checks that require XML whitespace there.
 * '-' is also the one filler that carries no ambiguity: `--` cannot occur
 * inside a well-formed XML comment, so a masked run can never be mistaken for
 * planted content, and it starts no token this reader searches for.
 *
 * THE SPANS ARE RETURNED BECAUSE THE FILLER IS NOT ENOUGH ON ITS OWN, and that
 * is measured rather than reasoned. In a whitespace-only gap '-' is correctly
 * rejected, but in CHARACTER DATA it is perfectly legal: masking
 * `<string><![CDATA[/opt/bin]]></string>` yields `<string>--------------------
 * </string>`, whose value the pair pattern's `[^<]*` group matches happily. A
 * body that fails closed today — the literal `<` of `<![CDATA[` ends `[^<]*`,
 * the pair never matches, and the body is not fully consumed — would have
 * started parsing to a dash-valued key. The caller therefore refuses on span
 * INTERSECTION with the body, which keeps that cell closed by a rule instead of
 * by a filler character's side effect.
 *
 * The EARLIEST opener wins at each step, not the first kind in the list: a
 * processing instruction can carry `<!--` as literal text, and a comment can
 * carry `<?`.
 *
 * An unterminated opener is not well-formed XML at all. It used to be ignored
 * outright, so everything after it parsed as live markup; it is refused.
 *
 * A DOCTYPE internal subset is NOT masked here. plist(5) files carry an
 * external DOCTYPE with no internal subset, and inventing a fourth region kind
 * for a shape the generator never emits would widen this reader for nothing.
 */
function maskInertXmlRegions(plist: string): MaskedPlist | null {
  let out = '';
  let cursor = 0;
  const inertSpans: (readonly [number, number])[] = [];
  for (;;) {
    let open = -1;
    let openerLength = 0;
    let closer = '';
    for (const [opener, regionCloser] of INERT_XML_REGIONS) {
      const at = plist.indexOf(opener, cursor);
      if (at === -1) continue;
      if (open === -1 || at < open) {
        open = at;
        openerLength = opener.length;
        closer = regionCloser;
      }
    }
    if (open === -1) return { masked: out + plist.slice(cursor), inertSpans };
    const close = plist.indexOf(closer, open + openerLength);
    if (close === -1) return null;
    const end = close + closer.length;
    out += plist.slice(cursor, open) + '-'.repeat(end - open);
    inertSpans.push([open, end]);
    cursor = end;
  }
}

/** True when [start, end) overlaps any masked region by at least one byte. */
function intersectsInertRegion(
  spans: readonly (readonly [number, number])[],
  start: number,
  end: number,
): boolean {
  return spans.some(([spanStart, spanEnd]) => spanStart < end && start < spanEnd);
}

/**
 * Extract the EnvironmentVariables dict as a key -> value map, or null when the
 * reader cannot enumerate it — the caller must treat null as drift, never as
 * "no drift". `<dict/>` is the one shape that yields an EMPTY map: the element
 * is there and it genuinely holds nothing. Tolerant of hand-patched whitespace:
 * it matches element structure, not the generator's exact formatting, because
 * the whole point is comparing against plists someone edited by hand.
 */
function parseEnvironmentVariables(source: string): Map<string, string> | null {
  // Masked FIRST, so no search below can match text inside an inert region.
  const maskedPlist = maskInertXmlRegions(source);
  if (maskedPlist === null) return null;
  const { masked: plist, inertSpans } = maskedPlist;
  const marker = plist.indexOf(ENV_KEY_MARKER);
  // AN ABSENT MARKER IS NOT AN EMPTY ENVIRONMENT. `new Map()` here claimed
  // "there are genuinely no keys", which is a claim this reader cannot make
  // about an element it never found: on the apply surface that claim empties
  // droppedNonGovernedKeys, the gate sees nothing to drop, and the re-render
  // erases every non-governed key the installed plist carried without naming
  // one. It also covers a legal-but-unusual spelling of the key element
  // (`<key >EnvironmentVariables</key >`), which this reader deliberately does
  // not parse — refusing is the fail-closed answer and it is the answer the
  // Python reader already gives (`if marker < 0: return None`).
  if (marker === -1) return null;
  // "Exactly one top-level EnvironmentVariables dictionary." A second surviving
  // marker means the file declares the element twice. The system parser has its
  // own precedence for that; this reader must not invent a different one and
  // then compare a map the loaded job does not have.
  if (plist.indexOf(ENV_KEY_MARKER, marker + ENV_KEY_MARKER.length) !== -1) return null;
  const afterMarker = marker + ENV_KEY_MARKER.length;
  const tokenPattern = new RegExp(DICT_OPEN_TOKEN_SOURCE, 'g');
  tokenPattern.lastIndex = afterMarker;
  const token = tokenPattern.exec(plist);
  if (token === null) return null;
  // Only whitespace may separate the key from its value element; anything else
  // means this dict belongs to a later key, not to EnvironmentVariables.
  //
  // XML_SPACE_ONLY, not String.trim(). trim() also removes U+00A0, form feed
  // and vertical tab, which the system plist parser rejects -- so this gap was
  // the one place left where this comparator could call a plist well-formed
  // that launchd refuses to load. The body-consumption checks below already
  // used the XML set; this makes the whole reader agree with itself.
  if (!XML_SPACE_ONLY.test(plist.slice(afterMarker, token.index))) return null;
  // Sticky: the narrow form must match EXACTLY where the token was found, so an
  // attributed dict is refused here rather than skipped over for a later one.
  const openPattern = new RegExp(DICT_OPEN_SOURCE, 'y');
  openPattern.lastIndex = token.index;
  const open = openPattern.exec(plist);
  if (open === null) return null;
  // `<dict/>` is a well-formed EMPTY environment, not an unparseable one: every
  // governed key is then genuinely missing, which the drift rows report.
  if (open[1] === '/') return new Map();
  const bodyStart = open.index + open[0].length;

  const closePattern = new RegExp(DICT_CLOSE_SOURCE, 'g');
  closePattern.lastIndex = bodyStart;
  const close = closePattern.exec(plist);
  if (close === null) return null;

  // AN INERT REGION INSIDE THE BODY IS NOT CONTENT THIS READER MAY CONSUME.
  // The mask blanks it to '-', and '-' is legal character data, so a masked
  // CDATA value satisfies the pair pattern's `[^<]*` group and a body that fails
  // closed today would parse to a dash-valued key. Measured on the cdata_value
  // and cdata_key_name cells. The whitespace checks below still catch a region
  // in a gap; this catches one in character data, which they cannot.
  if (intersectsInertRegion(inertSpans, bodyStart, close.index)) return null;
  const body = plist.slice(bodyStart, close.index);
  // Environment values are plain strings; a nested dict inside the body is a
  // shape this comparator does not understand, and the body already truncated at
  // that dict's close — fail closed. Searched over the BODY, so the outer
  // plist's own dicts are out of scope.
  const nestedPattern = new RegExp(DICT_OPEN_TOKEN_SOURCE, 'g');
  if (nestedPattern.exec(body) !== null) return null;
  // THE BODY MUST BE FULLY CONSUMED BY THE PAIRS.
  //
  // Extracting adjacent key/string pairs and ignoring the rest is what made a
  // governed key vanish: any token interposed between a key and its string, or
  // any entry this pattern does not model, left the pair unmatched and the key
  // absent from the map. Here that also emptied droppedNonGovernedKeys, so an
  // apply proceeded as though the installed plist had no non-governed keys to
  // drop and deleted them. Every byte of the body is therefore accounted for:
  // whatever is not a matched pair and not XML whitespace fails closed.
  const env = new Map<string, string>();
  const pair = /<key>([^<]*)<\/key>[ \t\r\n]*<string>([^<]*)<\/string>/g;
  let consumed = 0;
  for (const match of body.matchAll(pair)) {
    const start = match.index ?? 0;
    if (!XML_SPACE_ONLY.test(body.slice(consumed, start))) return null;
    const key = unescapeXml(match[1] ?? '');
    // A duplicate key is refused, not resolved. This comparator took the LAST
    // occurrence and the Python reader took the FIRST, so the two disagreed
    // about the same file. Refusing settles it on both sides.
    if (env.has(key)) return null;
    env.set(key, unescapeXml(match[2] ?? ''));
    consumed = start + match[0].length;
  }
  if (!XML_SPACE_ONLY.test(body.slice(consumed))) return null;
  return env;
}

/**
 * Compare the governed environment keys of a freshly rendered plist against
 * the installed plist contents.
 */
export function compareGovernedLaunchdEnv(
  expectedPlist: string,
  observedPlist: string,
  options: CompareGovernedLaunchdEnvOptions = {},
): GovernedEnvComparison {
  const expected = parseEnvironmentVariables(expectedPlist);
  const observed = parseEnvironmentVariables(observedPlist);
  if (expected === null || observed === null) {
    return {
      comparable: false,
      reason: 'environment-variables-unparseable',
      drift: [],
      droppedNonGovernedKeys: [],
    };
  }

  const governed: ReadonlySet<string> = new Set(GOVERNED_LAUNCHD_ENV_KEYS);
  const pathPrepend = options.pathPrepend ?? [];
  const drift: GovernedEnvDriftEntry[] = [];
  let pathPrefix: GovernedPathPrefixReport | undefined;

  for (const key of GOVERNED_LAUNCHD_ENV_KEYS) {
    const expectedValue = expected.get(key);
    const observedValue = observed.get(key);
    if (expectedValue === undefined && observedValue === undefined) continue;

    if (key === 'PATH' && expectedValue !== undefined && observedValue !== undefined) {
      const satisfied = pathStartsWithEntries(observedValue, pathPrepend);
      pathPrefix = {
        configured: pathPrepend.length > 0,
        satisfied,
        ambientTailDiffers: expectedValue !== observedValue,
        expectedDigest: sha256Hex(expectedValue),
        observedDigest: sha256Hex(observedValue),
      };
      if (satisfied) continue;
    }

    if (expectedValue === observedValue) continue;
    drift.push({
      key,
      state: expectedValue === undefined
        ? 'extra'
        : observedValue === undefined
          ? 'missing'
          : 'mismatch',
      expectedDigest: expectedValue === undefined ? null : sha256Hex(expectedValue),
      observedDigest: observedValue === undefined ? null : sha256Hex(observedValue),
    });
  }

  const droppedNonGovernedKeys = [...observed.keys()]
    .filter((key) => !governed.has(key) && !expected.has(key))
    .sort();

  return {
    comparable: true,
    drift,
    droppedNonGovernedKeys,
    ...(pathPrefix ? { pathPrefix } : {}),
  };
}
