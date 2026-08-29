/**
 * Validated instance-specific resolver for launchd plist render options.
 *
 * Every macOS plist render path (first install after pairing, reconcile)
 * resolves the instance's `service` block through this module, so a configured
 * CLAUDE_CONFIG_DIR or PATH prepend can never be silently dropped by one
 * render call site. Fail-closed: an unreadable or invalid config.json aborts
 * the render instead of regenerating a plist without its governed environment.
 * A missing config.json resolves to the empty options (byte-compatible render).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  LaunchdRenderConfigError,
  extractLaunchdPlistRenderOptions,
  type LaunchdPlistRenderOptions,
} from '../lib/launchd-service-config.ts';
import { isValidInstanceName } from './instance-name.ts';
import { configRoot } from './paths.ts';

export type { LaunchdPlistRenderOptions } from '../lib/launchd-service-config.ts';

/** True only when nothing exists at the path — a dangling symlink still exists. */
function isTrulyAbsent(configPath: string): boolean {
  try {
    fs.lstatSync(configPath);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Read and validate `<instancesConfigRoot>/<name>/config.json`, returning the
 * typed render options for the generated plist.
 *
 * Error messages are content-free by construction: they name the instance and
 * a failure class, never config.json bytes (a JSON parser message embeds a
 * source window that can carry values), and never the on-disk path.
 */
export function resolveLaunchdPlistRenderOptions(
  name: string,
  instancesConfigRoot: string = configRoot(),
): LaunchdPlistRenderOptions {
  if (!isValidInstanceName(name)) throw new Error('invalid instance name');
  const configPath = path.join(instancesConfigRoot, name, 'config.json');

  let contents: string;
  try {
    contents = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    if (code === 'ENOENT') {
      if (isTrulyAbsent(configPath)) return {};
      throw new LaunchdRenderConfigError(`config.json for instance ${name} is a dangling symlink`);
    }
    throw new LaunchdRenderConfigError(`config.json for instance ${name} is unreadable (${code})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new LaunchdRenderConfigError(`malformed JSON in config.json for instance ${name}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LaunchdRenderConfigError(`config.json for instance ${name} is not a JSON object`);
  }

  return extractLaunchdPlistRenderOptions(parsed as Record<string, unknown>);
}
