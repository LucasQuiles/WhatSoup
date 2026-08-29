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
  extractLaunchdPlistRenderOptions,
  type LaunchdPlistRenderOptions,
} from '../lib/launchd-service-config.ts';
import { isValidInstanceName } from './instance-name.ts';
import { configRoot } from './paths.ts';

export type { LaunchdPlistRenderOptions } from '../lib/launchd-service-config.ts';

/**
 * Read and validate `<instancesConfigRoot>/<name>/config.json`, returning the
 * typed render options for the generated plist.
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid config.json for instance ${name}: ${detail}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`invalid config.json for instance ${name}: config is not a JSON object`);
  }

  return extractLaunchdPlistRenderOptions(parsed as Record<string, unknown>);
}
