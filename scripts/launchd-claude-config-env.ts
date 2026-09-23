// launchd-claude-config-env.ts — carry an instance's `service.claudeConfigDir`
// into the host-level launchd renders (harness-maintenance, reply-guarantee,
// release-drift-check).
//
// Bot instance plists already export CLAUDE_CONFIG_DIR from that config field
// (src/fleet/platform.ts). The host-level jobs did not, so a job that runs the
// provider CLI on a bot host read a DIFFERENT credential store than the bot. A
// refresh from such a job can move the shared login into the other store and
// leave the bot logged out. Every render path of these templates (setup.sh
// install, render-release-drift-launchd.sh, and the substitute-then-compare
// drift checker) pipes its sed render through this filter, so install and
// drift check agree byte for byte.
//
//   node --experimental-strip-types scripts/launchd-claude-config-env.ts \
//     --home <abs> [--instance <name>] [--preserve-from <installed.plist>] \
//     < rendered.plist > final.plist
//
// Resolution (validated by the same resolver the bot plist render uses):
//   --instance N : that instance's config value, else nothing.
//   no --instance: the one distinct value across the host's instances; none
//                  or several distinct values give nothing (several also
//                  warn on stderr — a host-level job cannot pick one).
//   --preserve-from P: when the steps above give nothing, carry forward the
//                  CLAUDE_CONFIG_DIR the installed plist P already has, so a
//                  re-render never strips a hand-added key. A configured value
//                  always wins over it. A missing P preserves nothing.
// No value ⇒ output is byte-identical to input. Exit 2 on an invalid config, a
// plist without an EnvironmentVariables dict, or a --preserve-from plist that
// mentions CLAUDE_CONFIG_DIR but that the reader refuses (fail closed: never
// install a render that silently dropped a configured or installed dir).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLaunchdPlistRenderOptions } from '../src/fleet/launchd-render-options.ts';
import { readLaunchdEnvironment } from '../src/fleet/launchd-env-drift.ts';
import { escapeXml } from '../src/fleet/platform.ts';
import { isValidInstanceName } from '../src/fleet/instance-name.ts';
import { parseClosedOptions } from './lib/cli-args.ts';

const KEY = 'CLAUDE_CONFIG_DIR';

/**
 * Insert CLAUDE_CONFIG_DIR as the first EnvironmentVariables entry. The dict is
 * located by the hardened drift reader (src/fleet/launchd-env-drift.ts), so
 * the injector and the drift check agree on which dict is the environment: a
 * decoy inside a comment or CDATA is ignored, and a duplicated or unparseable
 * declaration is refused rather than guessed at.
 */
export function injectClaudeConfigDir(plist: string, dir: string | null): string {
  if (dir === null) return plist;
  const environment = readLaunchdEnvironment(plist);
  if (environment === null || environment.bodyStart === null) {
    throw new Error('plist has no EnvironmentVariables dict to extend');
  }
  if (environment.env.has(KEY)) throw new Error(`plist already carries ${KEY}`);
  // Insert at the dict body's first byte, never after "the next newline": in a
  // compact dict that newline can lie past </dict> or inside a string value.
  // For the usual one-entry-per-line layout the bytes are the same either way.
  const lineStart = plist.lastIndexOf('\n', environment.bodyStart) + 1;
  const indent = `${/^[ \t]*/.exec(plist.slice(lineStart))?.[0] ?? ''}  `;
  const at = environment.bodyStart;
  const entry = `\n${indent}<key>${KEY}</key>\n${indent}<string>${escapeXml(dir)}</string>`;
  return plist.slice(0, at) + entry + plist.slice(at);
}

/**
 * The CLAUDE_CONFIG_DIR an installed plist already carries, read with the same
 * reader. A missing file, or one with no readable environment that never
 * mentions the key, has nothing to preserve (null). A file that mentions the
 * key but that the reader refuses throws: a hand-added value may exist and
 * cannot be carried forward safely, so the render must not proceed.
 */
export function readInstalledClaudeConfigDir(file: string): string | null {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const environment = readLaunchdEnvironment(source);
  if (environment === null) {
    if (!source.includes(KEY)) return null;
    throw new Error(`--preserve-from ${file}: mentions ${KEY} but its EnvironmentVariables dict is duplicated or unparseable`);
  }
  // The reader decodes only the five named XML entities. A numeric character
  // reference (&#45;) would be carried forward as literal text, changing the
  // path, or would hide the key itself (CLAUDE_CONFIG_DI&#82;), so refuse it.
  for (const [name, value] of environment.env) {
    if (name.includes('&#') || value.includes('&#')) {
      throw new Error(`--preserve-from ${file}: EnvironmentVariables uses a numeric character reference, which is not supported`);
    }
  }
  return environment.env.get(KEY) ?? null;
}

export interface HostClaudeConfigDir {
  dir: string | null;
  warning: string | null;
}

/** Resolve the dir for a host-level render. Throws on an invalid instance config. */
export function resolveHostClaudeConfigDir(opts: {
  home: string;
  env: NodeJS.ProcessEnv;
  instance?: string;
}): HostClaudeConfigDir {
  const xdg = opts.env['XDG_CONFIG_HOME'];
  const root = path.join(xdg ? xdg : path.join(opts.home, '.config'), 'whatsoup', 'instances');
  if (opts.instance !== undefined) {
    // A name outside the fleet naming policy can own no instance config.
    if (!isValidInstanceName(opts.instance)) return { dir: null, warning: null };
    return { dir: resolveLaunchdPlistRenderOptions(opts.instance, root).claudeConfigDir ?? null, warning: null };
  }
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidInstanceName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { dir: null, warning: null };
    throw error;
  }
  const dirs = new Set<string>();
  for (const name of names) {
    const dir = resolveLaunchdPlistRenderOptions(name, root).claudeConfigDir;
    if (dir !== undefined) dirs.add(dir);
  }
  if (dirs.size === 1) return { dir: [...dirs][0], warning: null };
  if (dirs.size > 1) {
    return {
      dir: null,
      warning: `${dirs.size} different service.claudeConfigDir values on this host; host-level jobs get none`,
    };
  }
  return { dir: null, warning: null };
}

interface Options {
  home: string;
  instance?: string;
  preserveFrom?: string;
}

function readOptions(argv: readonly string[]): Options {
  const parsed = parseClosedOptions(argv, {
    booleanOptions: [],
    valueOptions: ['--home', '--instance', '--preserve-from'],
  });
  if (parsed.error) throw new Error(`invalid arguments (${parsed.error})`);
  const home = parsed.values.get('--home');
  const instance = parsed.values.get('--instance');
  const preserveFrom = parsed.values.get('--preserve-from');
  if (!home || !path.isAbsolute(home)) throw new Error('--home must be an absolute path');
  if (preserveFrom !== undefined && !path.isAbsolute(preserveFrom)) {
    throw new Error('--preserve-from must be an absolute path');
  }
  return {
    home,
    ...(instance !== undefined ? { instance } : {}),
    ...(preserveFrom !== undefined ? { preserveFrom } : {}),
  };
}

export function run(argv: readonly string[], input: string, env: NodeJS.ProcessEnv): { output: string; warning: string | null } {
  const { preserveFrom, ...args } = readOptions(argv);
  const resolved = resolveHostClaudeConfigDir({ ...args, env });
  // A configured value always wins. Only when config yields none (unset, or
  // several different values) does the installed plist's own value carry
  // forward, so a re-render never strips a hand-added key.
  const dir = resolved.dir ?? (preserveFrom !== undefined ? readInstalledClaudeConfigDir(preserveFrom) : null);
  return { output: injectClaudeConfigDir(input, dir), warning: resolved.warning };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // env-allowed: XDG_CONFIG_HOME selects the instance config root, as in src/fleet/paths.ts
    const result = run(process.argv.slice(2), readFileSync(0, 'utf8'), process.env);
    if (result.warning) process.stderr.write(`launchd-claude-config-env: WARN ${result.warning}\n`);
    process.stdout.write(result.output);
  } catch (error) {
    process.stderr.write(`launchd-claude-config-env: ${(error as Error).message}\n`);
    process.exitCode = 2;
  }
}
