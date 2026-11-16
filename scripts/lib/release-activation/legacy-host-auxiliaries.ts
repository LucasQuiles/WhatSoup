/** Closed installed-argv contracts for legacy macOS host auxiliaries. */
import path from 'node:path';

export type LegacyPathRebaseLabel =
  | 'com.bot-errors.health'
  | 'com.whatsoup.harness-maintenance'
  | 'com.whatsoup.reply-guarantee';

const LEGACY_PATH_REBASE_LABELS = new Set<LegacyPathRebaseLabel>([
  'com.bot-errors.health',
  'com.whatsoup.harness-maintenance',
  'com.whatsoup.reply-guarantee',
]);
// The profile basename is spliced into a shell wrapper, so it is limited to a
// shell-inert grammar; which profiles exist is host inventory, not code.
const LEGACY_BOT_ERRORS_HEALTH_PROFILE = /^[a-z][a-z0-9]{0,31}\.json$/;

export function isLegacyPathRebaseLabel(label: string): label is LegacyPathRebaseLabel {
  return LEGACY_PATH_REBASE_LABELS.has(label as LegacyPathRebaseLabel);
}

function absolute(value: unknown): string | null {
  return typeof value === 'string' && path.isAbsolute(value) ? path.normalize(value).replace(/\/+$/, '') || '/' : null;
}

/**
 * The shell-token path grammar of docs/runbooks/release-deployment.md:625-627:
 * such a path is one inert word wherever a shell reads it.
 */
export const SHELL_TOKEN_PATH = /^\/[A-Za-z0-9._/-]+$/;

function safeShellAbsolutePath(value: string): string | null {
  const normalized = absolute(value);
  return normalized === value && SHELL_TOKEN_PATH.test(value) ? value : null;
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function countOccurrences(value: string, needle: string): number {
  return needle.length === 0 ? 0 : value.split(needle).length - 1;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function rebaseBotErrorsHealthProfileDefault(installed: string, args: readonly string[], expectCurrent: string, release: string): string | null {
  const runner = `${expectCurrent}/deploy/scripts/bot-errors-runner.py`;
  const health = `${expectCurrent}/deploy/scripts/bot-errors-health-check.py`;
  const shell = args[2];
  const envPrefix = 'BOT_ERRORS_ENV_FILE=';
  const envSuffix = '; export BOT_ERRORS_ENV_FILE;';
  if (shell === undefined || !shell.startsWith(envPrefix)) return null;
  const envEnd = shell.indexOf(envSuffix, envPrefix.length);
  if (envEnd < 0) return null;
  const envFile = safeShellAbsolutePath(shell.slice(envPrefix.length, envEnd));
  const configSuffix = '/.config/whatsoup/bot-errors.env';
  if (envFile === null || !envFile.endsWith(configSuffix)) return null;
  const home = safeShellAbsolutePath(envFile.slice(0, -configSuffix.length));
  if (home === null || envFile !== `${home}${configSuffix}`) return null;
  const stateDir = `${home}/.local/state/bot-errors`;
  if (args.length !== 20 || args[0] !== '/bin/bash' || args[1] !== '-c' || args[3] !== 'bot-errors-health'
    || args[4] !== '/usr/bin/python3' || args[5] !== runner || args[6] !== '--instance' || args[7] !== 'bot-errors-health'
    || args[8] !== '--source' || args[9] !== 'service-exit' || args[10] !== '--summary' || args[11] !== 'BOT ERRORS daily health command failed'
    || args[12] !== '--log-hint' || args[13] !== `${stateDir}/logs/health.err.log` || args[14] !== '--diagnostic'
    || args[15] !== 'launchd_label=com.bot-errors.health' || args[16] !== '--' || args[17] !== '/usr/bin/python3'
    || args[18] !== health || args[19] !== '--daily') return null;
  const profilePrefix = `if [[ -z "\${BOT_ERRORS_HEALTH_PROFILE:-}" ]]; then export BOT_ERRORS_HEALTH_PROFILE=${expectCurrent}/deploy/health-profiles/`;
  const profileStart = shell.indexOf(profilePrefix);
  const profileEnd = profileStart < 0 ? -1 : shell.indexOf('; fi;', profileStart + profilePrefix.length);
  const profileBasename = profileEnd < 0 ? null : shell.slice(profileStart + profilePrefix.length, profileEnd);
  if (profileBasename === null || !LEGACY_BOT_ERRORS_HEALTH_PROFILE.test(profileBasename)) return null;
  const oldDefault = `${profilePrefix}${profileBasename}; fi;`;
  const expectedShell = [
    `${envPrefix}${envFile}${envSuffix} `,
    'if [[ ! -r "$BOT_ERRORS_ENV_FILE" ]]; then printf "%s\\n" "missing BOT_ERRORS_ENV_FILE=$BOT_ERRORS_ENV_FILE" >/dev/stderr; exit 64; fi; ',
    'set -a; source "$BOT_ERRORS_ENV_FILE"; set +a; ',
    'if [[ -z "${BOT_ERRORS_JID:-}" ]]; then printf "%s\\n" "missing BOT_ERRORS_JID in $BOT_ERRORS_ENV_FILE" >/dev/stderr; exit 65; fi; ',
    'if [[ -z "${BOT_ERRORS_EXPECTED_JID:-}" ]]; then printf "%s\\n" "missing BOT_ERRORS_EXPECTED_JID in $BOT_ERRORS_ENV_FILE" >/dev/stderr; exit 65; fi; ',
    'if [[ "$BOT_ERRORS_JID" != *@g.us ]]; then printf "%s\\n" "BOT_ERRORS_JID must be a WhatsApp group JID" >/dev/stderr; exit 65; fi; ',
    'if [[ "$BOT_ERRORS_JID" != "$BOT_ERRORS_EXPECTED_JID" ]]; then printf "%s\\n" "BOT_ERRORS_JID does not match BOT_ERRORS_EXPECTED_JID" >/dev/stderr; exit 65; fi; ',
    `if [[ -z "\${BOT_ERRORS_STATE_DIR:-}" ]]; then export BOT_ERRORS_STATE_DIR=${stateDir}; fi; `,
    oldDefault, '  exec "$@"',
  ].join('');
  if (shell !== expectedShell) return null;
  const newDefault = `if [[ -z "\${BOT_ERRORS_HEALTH_PROFILE:-}" ]]; then export BOT_ERRORS_HEALTH_PROFILE=${release}/deploy/health-profiles/${profileBasename}; fi;`;
  const spellings = [oldDefault, escapeXml(oldDefault)].filter((spelling, index, values) => values.indexOf(spelling) === index);
  const found = spellings.filter((spelling) => countOccurrences(installed, spelling) === 1);
  if (found.length !== 1 || spellings.reduce((total, spelling) => total + countOccurrences(installed, spelling), 0) !== 1) return null;
  const serializedOld = found[0]!;
  const serializedNew = serializedOld === oldDefault ? newDefault : escapeXml(newDefault);
  return installed.replace(serializedOld, serializedNew);
}

function hasPinnedNodeUnderHome(node: string, home: string): boolean {
  const prefix = `${home}/.nvm/versions/node/v`;
  const suffix = '/bin/node';
  if (safeShellAbsolutePath(node) !== node || !node.startsWith(prefix) || !node.endsWith(suffix)) return false;
  const version = node.slice(prefix.length, -suffix.length);
  return /^\d+\.\d+\.\d+$/.test(version) && node === `${prefix}${version}${suffix}`;
}

/**
 * Validates only observed legacy argv contracts. This module never resolves,
 * executes, or selects an executable; callers retain ordinary plist staging.
 */
export function rebaseLegacyHostAuxiliaryForPathRebase(
  installed: string,
  programArguments: readonly string[],
  label: LegacyPathRebaseLabel,
  expectCurrent: string,
  release: string,
  home: string,
): string | null {
  if (safeShellAbsolutePath(expectCurrent) !== expectCurrent || safeShellAbsolutePath(release) !== release) return null;
  if (label === 'com.bot-errors.health') return rebaseBotErrorsHealthProfileDefault(installed, programArguments, expectCurrent, release);
  if (safeShellAbsolutePath(home) !== home) return null;
  if (label === 'com.whatsoup.harness-maintenance') {
    return sameArgs(programArguments, [
      '/bin/bash', `${home}/.local/libexec/fleet-reauth/maint-ccd-guard.sh`, '/bin/bash', `${expectCurrent}/deploy/scripts/harness-maintenance.sh`,
    ]) ? installed : null;
  }
  const reply = [`${expectCurrent}/deploy/hooks/drain-stuck-replies.mjs`];
  if (!hasPinnedNodeUnderHome(programArguments[0] ?? '', home) || programArguments[1] !== reply[0]) return null;
  return (programArguments.length === 2 || (programArguments.length === 3 && programArguments[2] === '--once')) ? installed : null;
}
