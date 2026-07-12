import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createChildLogger } from '../logger.ts';
import { isRecord } from '../lib/type-guards.ts';
import { readPrivateConfigFileSync } from './private-config-file.ts';

const log = createChildLogger('user-claude-settings');

export type UserClaudeSettingsInspection =
  | 'absent'
  | 'clean'
  | 'invalid-root'
  | 'managed-hook-present'
  | 'unreadable';

/**
 * Inspect user-owned Claude settings without writing or locking the file.
 * Runtime startup may warn about its exact managed hook, but repair requires an
 * explicit maintenance action with stronger ownership and concurrency proof.
 */
export function inspectUserClaudeSettings(
  claudeDir: string,
  managedHookPath: string,
): UserClaudeSettingsInspection {
  const settingsPath = join(claudeDir, 'settings.json');
  if (!existsSync(claudeDir) || !existsSync(settingsPath)) return 'absent';

  let parsed: unknown;
  try {
    parsed = JSON.parse(readPrivateConfigFileSync(settingsPath));
  } catch {
    log.warn({ settingsPath }, 'user settings.json unreadable or unsafe; leaving unchanged');
    return 'unreadable';
  }
  if (!isRecord(parsed)) {
    log.warn({ settingsPath }, 'user settings.json root is not an object; leaving unchanged');
    return 'invalid-root';
  }

  const hooks = isRecord(parsed.hooks) ? parsed.hooks : undefined;
  const preToolUse = hooks?.PreToolUse;
  if (!Array.isArray(preToolUse)) return 'clean';

  const managedHookPresent = preToolUse.some((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((hook) =>
      isRecord(hook)
      && hook.type === 'command'
      && hook.command === managedHookPath,
    );
  });
  if (!managedHookPresent) return 'clean';

  log.warn(
    { settingsPath },
    'managed sandbox hook present in user settings; startup will not modify user-owned configuration',
  );
  return 'managed-hook-present';
}
