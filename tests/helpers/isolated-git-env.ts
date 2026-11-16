import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import { privateTermsTestEnv } from './private-terms-env.ts';

/**
 * The environment for every git process a test starts.
 *
 * A developer's global git configuration can name a hooks folder (`core.hooksPath`) whose
 * commit hooks run the repository guard, and that guard loads the real private term file from
 * the real home folder. Global and system settings can also change what a fixture repository
 * records. So every git child of a test gets, from this one helper:
 *
 * - HOME and XDG_CONFIG_HOME in a temporary folder (no real ~/.gitconfig, no real term file);
 * - GIT_CONFIG_NOSYSTEM=1 and GIT_CONFIG_GLOBAL naming an empty file;
 * - core.hooksPath set (through GIT_CONFIG_COUNT, the highest-precedence source) to an empty
 *   folder, so no hook runs, whatever a repository, template or inherited setting names;
 * - the private-term test variables (an absent term file, the require switch cleared);
 * - nothing else from the parent environment beyond cleanGitEnv's allow-list.
 */
let isolatedRoot: string | null = null;

function isolatedGitRoot(): string {
  if (isolatedRoot !== null) return isolatedRoot;
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-test-git-home-'));
  mkdirSync(join(root, 'xdg'));
  mkdirSync(join(root, 'no-hooks'));
  writeFileSync(join(root, 'gitconfig'), '');
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  isolatedRoot = root;
  return root;
}

export function isolatedGitEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const root = isolatedGitRoot();
  return {
    ...cleanGitEnv(),
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: join(root, 'no-hooks'),
    ...privateTermsTestEnv(),
    ...extra,
  };
}
