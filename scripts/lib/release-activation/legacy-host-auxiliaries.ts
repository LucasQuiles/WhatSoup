/** Closed installed-argv contracts for legacy macOS host auxiliaries. */
import path from 'node:path';
import { parseHealthRunnerSuffix } from './plan.ts';
import { ROOT_HELPER_PYTHON } from './root-helper-interpreter.ts';
import { readStrictPlist, strictStringArray, strictStringDict, type StrictPlistDict } from './strict-plist.ts';

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
// launchd starts Program or BundleProgram in place of ProgramArguments[0], and other root keys (UserName,
// EnableGlobbing, ...) change what runs or as whom. No contract below pins them, so a path-rebase plist may set only these.
const PATH_REBASE_ROOT_KEYS: ReadonlySet<string> = new Set([
  'Label', 'ProgramArguments', 'EnvironmentVariables', 'WorkingDirectory', 'RunAtLoad', 'KeepAlive',
  'StartCalendarInterval', 'StartInterval', 'StandardOutPath', 'StandardErrorPath',
]);
// Per job, the environment key names that a committed version of its repository writer set; values differ by host
// and are not proven. The two BOT ERRORS installers wrote the nine health keys. deploy/setup.sh renders the timers
// through scripts/launchd-claude-config-env.ts, which adds the agent CLI's config and credential-store selectors.
const PATH_REBASE_ENVIRONMENT_KEYS: Readonly<Record<LegacyPathRebaseLabel, ReadonlySet<string>>> = {
  'com.bot-errors.health': new Set([
    'PATH', 'BOT_ERRORS_STATE_DIR', 'BOT_ERRORS_JID', 'BOT_ERRORS_EXPECTED_JID', 'BOT_ERRORS_SOCKET_PATH',
    'BOT_ERRORS_SOCKET', 'BOT_ERRORS_DB', 'BOT_ERRORS_HEALTH_PROFILE', 'BOT_ERRORS_DISPATCHER_SERVICE',
  ]),
  'com.whatsoup.harness-maintenance': new Set(['PATH', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']),
  'com.whatsoup.reply-guarantee': new Set(['PATH', 'CLAUDE_CONFIG_DIR']),
};
const BOT_ERRORS_HEALTH_SHAPE = 'bot-errors health job is neither the installer form nor the legacy wrapper; '
  + 'reinstall it with deploy/scripts/install-bot-errors-health-launchd.sh or deploy/scripts/install-bot-errors-launchd.sh';
const LEGACY_TIMER_SHAPE = 'legacy host auxiliary does not match reviewed path-rebase contract';

export function isLegacyPathRebaseLabel(label: string): label is LegacyPathRebaseLabel {
  return LEGACY_PATH_REBASE_LABELS.has(label as LegacyPathRebaseLabel);
}

function absolute(value: unknown): string | null {
  return typeof value === 'string' && path.isAbsolute(value) ? path.normalize(value).replace(/\/+$/, '') || '/' : null;
}

/**
 * The shell-token path grammar of the path-rebase section of docs/runbooks/release-deployment.md:
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
 * The 16-element form both BOT ERRORS installers write, read with plan.ts's runner grammar so host and single-member
 * activation share it (the grammar checks the interpreter file through isTrustedHealthPython). Both interpreter
 * positions must be /usr/bin/python3. The runner names the root, so a case variant would match its own expected
 * strings: the root must equal `root` byte for byte, and WorkingDirectory must equal it too.
 */
function botErrorsInstallerForm(plist: StrictPlistDict, programArguments: string[], root: string, home: string): boolean {
  if (programArguments[0] !== ROOT_HELPER_PYTHON) return false;
  const suffix = parseHealthRunnerSuffix(programArguments, 0, home);
  const workingDirectory = plist.get('WorkingDirectory');
  return suffix !== null && suffix.root === root && workingDirectory?.kind === 'string' && workingDirectory.value === root;
}

export type PathRebasePlistCheck = { readonly ok: true; readonly programArguments: string[] } | { readonly ok: false; readonly error: string };

/**
 * One path-rebase plist against its closed contract, with `root` as the release it selects: the declared
 * expected-current root before staging, and the target release for the staged plist at planning and again at apply.
 * It proves the text launchd reads (strict-plist.ts), the root keys, the environment key names, and the exact argv of
 * one of four contracts: the BOT ERRORS installer form or legacy wrapper, harness maintenance, or reply guarantee.
 */
export function checkPathRebasePlist(label: string, text: string, root: string, home: string): PathRebasePlistCheck {
  if (!isLegacyPathRebaseLabel(label)) return { ok: false, error: 'undeclared legacy path-rebase label' };
  const read = readStrictPlist(text);
  if (!read.ok) return read;
  for (const key of read.root.keys()) {
    if (!PATH_REBASE_ROOT_KEYS.has(key)) return { ok: false, error: `plist root key ${key} is not admitted for a path-rebase job` };
  }
  const declared = read.root.get('Label');
  if (declared?.kind !== 'string' || declared.value !== label) return { ok: false, error: 'plist Label is not the declared host auxiliary label' };
  const programArguments = strictStringArray(read.root, 'ProgramArguments');
  if ('error' in programArguments) return { ok: false, error: programArguments.error };
  const environment = strictStringDict(read.root, 'EnvironmentVariables');
  if ('error' in environment) return { ok: false, error: environment.error };
  for (const key of environment.entries.keys()) {
    if (!PATH_REBASE_ENVIRONMENT_KEYS[label].has(key)) return { ok: false, error: `environment key ${key} is not admitted for ${label}` };
  }
  const argv = programArguments.values;
  const legacy = rebaseLegacyHostAuxiliaryForPathRebase(text, argv, label, root, root, home) !== null;
  if (label !== 'com.bot-errors.health') return legacy ? { ok: true, programArguments: argv } : { ok: false, error: LEGACY_TIMER_SHAPE };
  return legacy || botErrorsInstallerForm(read.root, argv, root, home)
    ? { ok: true, programArguments: argv }
    : { ok: false, error: BOT_ERRORS_HEALTH_SHAPE };
}

/**
 * Validates only observed legacy argv contracts and rewrites only the legacy wrapper's profile default. This
 * function never resolves, executes, or selects an executable; callers retain ordinary plist staging.
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
