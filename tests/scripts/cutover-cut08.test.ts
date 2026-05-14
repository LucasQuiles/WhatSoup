import { describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../..');
const CUTOVER_SCRIPT = join(REPO_ROOT, 'scripts/cutover.sh');
const PERSONAL_ALIAS = ['whatsoup', 'personal'].join('-');
const PERSONAL_SOCKET = ['instances', 'personal', 'whatsoup.sock'].join('/');

function runCutoverFunction(functionName: string, env: NodeJS.ProcessEnv = {}, cwd = REPO_ROOT) {
  return spawnSync('bash', ['-c', `source "${CUTOVER_SCRIPT}"; ${functionName}`], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function makeFakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-cutover-test-'));
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  mkdirSync(join(root, 'deploy/mcp'), { recursive: true });
  writeFileSync(join(root, 'node_modules/.bin/tsx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(root, 'deploy/mcp/whatsoup-proxy.ts'), 'export {};\n');
  return root;
}

describe('cutover CUT-08 manual MCP instructions', () => {
  test('prints the repo-local tsx launcher shape for the personal server alias', () => {
    const result = runCutoverFunction('run_cut08', { WHATSOUP_REPO: REPO_ROOT });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`"${PERSONAL_ALIAS}": {`);
    expect(result.stdout).toContain('"type": "stdio"');
    expect(result.stdout).toContain(`"command": "${REPO_ROOT}/node_modules/.bin/tsx"`);
    expect(result.stdout).toContain(`"${REPO_ROOT}/deploy/mcp/whatsoup-proxy.ts"`);
    expect(result.stdout).toContain(
      `"WHATSOUP_SOCKET": "${process.env.HOME}/.local/state/whatsoup/${PERSONAL_SOCKET}"`,
    );
    expect(result.stdout).toContain('tilde (~) does NOT');
    expect(result.stdout).not.toContain('"command": "node"');
    expect(result.stdout).not.toContain('--experimental-strip-types');
  });

  test('normalizes relative WHATSOUP_REPO before printing JSON paths', () => {
    const fakeRepo = makeFakeRepo();
    try {
      const parent = dirname(fakeRepo);
      const relativeRepo = relative(parent, fakeRepo) || basename(fakeRepo);
      const normalizedRepo = realpathSync(fakeRepo);
      const result = runCutoverFunction('run_cut08', { WHATSOUP_REPO: relativeRepo }, parent);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`"command": "${normalizedRepo}/node_modules/.bin/tsx"`);
      expect(result.stdout).toContain(`"${normalizedRepo}/deploy/mcp/whatsoup-proxy.ts"`);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  test('fails before printing JSON when the repo-local tsx runner is missing', () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'whatsoup-cutover-test-'));
    try {
      const result = runCutoverFunction('run_cut08', { WHATSOUP_REPO: fakeRepo });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Missing repo-local tsx runner');
      expect(result.stdout).toContain('npm ci');
      expect(result.stdout).not.toContain(`"${PERSONAL_ALIAS}": {`);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  test('fails before printing JSON when the proxy script is missing', () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), 'whatsoup-cutover-test-'));
    try {
      mkdirSync(join(fakeRepo, 'node_modules/.bin'), { recursive: true });
      writeFileSync(join(fakeRepo, 'node_modules/.bin/tsx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = runCutoverFunction('run_cut08', { WHATSOUP_REPO: fakeRepo });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Missing proxy script');
      expect(result.stdout).not.toContain(`"${PERSONAL_ALIAS}": {`);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  test('keeps CUT-09 permissions aligned with the personal server alias', () => {
    const result = runCutoverFunction('run_cut09');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`"mcp__${PERSONAL_ALIAS}__list_chats"`);
    expect(result.stdout).toContain(`"mcp__${PERSONAL_ALIAS}__get_message_context"`);
    expect(result.stdout).not.toContain('"mcp__whatsoup__list_chats"');
  });
});
