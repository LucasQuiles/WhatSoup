import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const DISPATCH_AGENT_SH = path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh');

describe('dispatch-agent.sh CODEX_BIN fallback', () => {
  let tmpHome: string;
  let sessionName: string;
  let stateDir: string;
  let gridDir: string;
  let fakeBin: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-dispatch-path-'));
    sessionName = 'test-session';
    stateDir = path.join(tmpHome, '.local/state/tmup', sessionName);
    gridDir = path.join(stateDir, 'grid');
    fakeBin = path.join(tmpHome, 'fakebin');

    fs.mkdirSync(gridDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      path.join(gridDir, 'grid-state.json'),
      JSON.stringify({
        panes: [{ index: 1, pane_id: '%1', status: 'available' }],
      }, null, 2)
    );

    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
case "\${1:-}" in
  display-message)
    printf 'bash\\n'
    ;;
  send-keys)
    ;;
  capture-pane)
    printf 'Working (fake)\\n'
    ;;
  *)
    printf 'unexpected tmux command: %s\\n' "\${1:-}" >&2
    exit 1
    ;;
esac
`);

    writeExecutable('sleep', `#!/bin/bash
exit 0
`);

    writeExecutable('yq', `#!/bin/bash
printf 'null\\n'
`);

    for (const commandName of [
      'awk',
      'cat',
      'chmod',
      'dirname',
      'flock',
      'grep',
      'jq',
      'mktemp',
      'mv',
      'rm',
      'sed',
      'seq',
      'touch',
    ]) {
      linkSystemBinary(commandName);
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('prefers codex resolved from PATH when CODEX_BIN is unset', () => {
    const pathCodex = path.join(fakeBin, 'codex');
    writeExecutable('codex', `#!/bin/bash
exit 0
`);

    runDispatch('agent-path');

    expect(readLauncher()).toContain(`export CODEX_BIN=${pathCodex}`);
  });

  it('falls back to $HOME/.local/bin/codex when PATH lookup fails and CODEX_BIN is unset', () => {
    runDispatch('agent-home-fallback');

    expect(readLauncher()).toContain(
      `export CODEX_BIN=${path.join(tmpHome, '.local/bin/codex')}`
    );
  });

  function runDispatch(agentId: string): void {
    const env = shellEnv();
    delete env.CODEX_BIN;

    execFileSync('/bin/bash', [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'PATH fallback verification',
      '--agent-id', agentId,
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', PLUGIN_DIR,
      '--pane-index', '1',
    ], {
      env,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function readLauncher(): string {
    return fs.readFileSync(path.join(stateDir, 'launcher-1.sh'), 'utf-8');
  }

  function shellEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: tmpHome,
      PATH: fakeBin,
    };
  }

  function writeExecutable(fileName: string, contents: string): void {
    const filePath = path.join(fakeBin, fileName);
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
  }

  function linkSystemBinary(fileName: string): void {
    const filePath = path.join(fakeBin, fileName);
    if (fs.existsSync(filePath)) {
      return;
    }

    const systemPath = execFileSync('/bin/bash', ['-lc', `command -v ${fileName}`], {
      encoding: 'utf-8',
      env: process.env,
    }).trim();
    fs.symlinkSync(systemPath, filePath);
  }
});
