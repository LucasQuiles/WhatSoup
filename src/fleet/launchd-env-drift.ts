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
  /** False when an EnvironmentVariables dict exists but cannot be parsed — fail-closed, never "no drift". */
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
const DICT_OPEN_TOKEN_SOURCE = '<dict(?=[\\s/>])';
/**
 * What this reader will PARSE is narrower than what it DETECTS: plain,
 * whitespace-padded and self-closing only. An attributed dict is refused rather
 * than consumed — consuming to the first '>' would end the token early on a
 * legal `<dict a="x>y">` and the rest of the opening tag would be read as body
 * pairs, injecting a governed key from inside a tag. plist(5) dicts carry no
 * attributes, so refusing costs nothing and fails closed.
 */
const DICT_OPEN_SOURCE = '<dict\\s*(/?)>';
const DICT_CLOSE_SOURCE = '</dict\\s*>';
const CDATA_OPEN = '<![CDATA[';

/**
 * Extract the EnvironmentVariables dict as a key -> value map. Returns an
 * empty map when the plist has no EnvironmentVariables key at all, and null
 * when the dict exists but cannot be parsed — the caller must treat null as
 * drift, never as "no drift". Tolerant of hand-patched whitespace: it matches
 * element structure, not the generator's exact formatting, because the whole
 * point is comparing against plists someone edited by hand.
 */
function parseEnvironmentVariables(plist: string): Map<string, string> | null {
  const marker = plist.indexOf(ENV_KEY_MARKER);
  if (marker === -1) return new Map();
  const afterMarker = marker + ENV_KEY_MARKER.length;
  const tokenPattern = new RegExp(DICT_OPEN_TOKEN_SOURCE, 'g');
  tokenPattern.lastIndex = afterMarker;
  const token = tokenPattern.exec(plist);
  if (token === null) return null;
  // Only whitespace may separate the key from its value element; anything else
  // means this dict belongs to a later key, not to EnvironmentVariables.
  if (plist.slice(afterMarker, token.index).trim() !== '') return null;
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

  const body = plist.slice(bodyStart, close.index);
  // Environment values are plain strings; a nested dict inside the body is a
  // shape this comparator does not understand, and the body already truncated at
  // that dict's close — fail closed. Searched over the BODY, so the outer
  // plist's own dicts are out of scope.
  const nestedPattern = new RegExp(DICT_OPEN_TOKEN_SOURCE, 'g');
  if (nestedPattern.exec(body) !== null) return null;
  // A CDATA section is a shape this comparator does not model, and the pair
  // pattern below cannot match across one because CDATA contains '<'. The key
  // would vanish from the map rather than read wrong, so a governed key present
  // on disk would compare as absent -- while the system parser accepts CDATA.
  // Refuse it, under the same fail-closed rule as a nested dict.
  if (body.includes(CDATA_OPEN)) return null;

  const env = new Map<string, string>();
  const pair = /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g;
  for (const match of body.matchAll(pair)) {
    env.set(unescapeXml(match[1] ?? ''), unescapeXml(match[2] ?? ''));
  }
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
