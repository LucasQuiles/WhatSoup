/**
 * Governed-environment drift comparison for generated launchd instance plists.
 *
 * Installed bot plists carry live credentials in EnvironmentVariables
 * (observed on the fleet), so their content is NEVER printed, diffed, or
 * embedded in a report. This comparator inspects only the governed key set
 * (CLAUDE_CONFIG_DIR, PATH) and reports presence plus SHA-256 value digests —
 * enough to detect missing/extra/mismatched governed keys without exposing a
 * single environment value. Non-governed keys are ignored entirely.
 */
import { createHash } from 'node:crypto';

export const GOVERNED_LAUNCHD_ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'PATH'] as const;

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

export interface GovernedEnvComparison {
  /** False when an EnvironmentVariables dict exists but cannot be parsed — fail-closed, never "no drift". */
  comparable: boolean;
  reason?: 'environment-variables-unparseable';
  drift: GovernedEnvDriftEntry[];
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
const DICT_OPEN = '<dict>';
const DICT_CLOSE = '</dict>';

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
  const dictOpen = plist.indexOf(DICT_OPEN, marker);
  if (dictOpen === -1) return null;
  if (plist.slice(marker + ENV_KEY_MARKER.length, dictOpen).trim() !== '') return null;
  // Environment values are plain strings; a nested dict inside the block is a
  // shape this comparator does not understand — fail closed.
  const dictClose = plist.indexOf(DICT_CLOSE, dictOpen);
  if (dictClose === -1) return null;
  const nestedOpen = plist.indexOf(DICT_OPEN, dictOpen + DICT_OPEN.length);
  if (nestedOpen !== -1 && nestedOpen < dictClose) return null;

  const body = plist.slice(dictOpen + DICT_OPEN.length, dictClose);
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
): GovernedEnvComparison {
  const expected = parseEnvironmentVariables(expectedPlist);
  const observed = parseEnvironmentVariables(observedPlist);
  if (expected === null || observed === null) {
    return { comparable: false, reason: 'environment-variables-unparseable', drift: [] };
  }

  const drift: GovernedEnvDriftEntry[] = [];
  for (const key of GOVERNED_LAUNCHD_ENV_KEYS) {
    const expectedValue = expected.get(key);
    const observedValue = observed.get(key);
    if (expectedValue === observedValue) continue;
    if (expectedValue === undefined && observedValue === undefined) continue;
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
  return { comparable: true, drift };
}
