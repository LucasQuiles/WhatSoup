import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const DISPATCH_AGENT_SH = path.join(PLUGIN_DIR, 'scripts/dispatch-agent.sh');

describe('dispatch-agent.sh Codex submit verification', () => {
  let tmpHome: string;
  let sessionName: string;
  let stateDir: string;
  let gridDir: string;
  let fakeBin: string;
  let tmuxStateDir: string;
  let captureSequencePath: string;
  let sendLogPath: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-dispatch-submit-'));
    sessionName = 'test-session';
    stateDir = path.join(tmpHome, '.local/state/tmup', sessionName);
    gridDir = path.join(stateDir, 'grid');
    fakeBin = path.join(tmpHome, 'fakebin');
    tmuxStateDir = path.join(tmpHome, 'tmux-state');
    captureSequencePath = path.join(tmuxStateDir, 'capture-sequence.txt');
    sendLogPath = path.join(tmuxStateDir, 'send-keys.log');

    fs.mkdirSync(gridDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });

    fs.writeFileSync(
      path.join(gridDir, 'grid-state.json'),
      JSON.stringify({
        panes: [{ index: 1, pane_id: '%1', status: 'available' }],
      }, null, 2)
    );

    writeTmuxStub();
    writeExecutable('sleep', '#!/bin/bash\nexit 0\n');
    writeExecutable('yq', '#!/bin/bash\nprintf \'null\\n\'\n');

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
      'seq',
      'tail',
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

  it('toggles plan mode and retries Enter when Codex does not confirm the first submit', () => {
    writeCaptureSequence([
      'Working (boot)\\n',
      '❯\\n',
      '❯ still idle\\n',
      'Working (tool call)\\n',
    ]);

    execFileSync('/bin/bash', dispatchArgs('agent-shift-tab'), {
      env: shellEnv(),
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const sendLog = readSendLog();
    expect(sendLog.filter((line) => line.includes(' S-Tab'))).toHaveLength(1);
    expect(sendLog.filter((line) => line.includes(' Enter'))).toHaveLength(3);
    expect(sendLog.filter((line) => line.startsWith('-l ') || line.includes(' -l '))).toHaveLength(1);
  });

  it('interrupts and re-sends the full prompt, then fails after three exhausted retries', () => {
    writeCaptureSequence([
      'Working (boot)\\n',
      '❯\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
    ]);

    let failure: { status?: number; stderr?: Buffer | string } | undefined;
    try {
      execFileSync('/bin/bash', dispatchArgs('agent-full-retry-failure'), {
        env: shellEnv(),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain('failed to confirm Codex accepted the initial prompt');

    const sendLog = readSendLog();
    expect(sendLog.filter((line) => line.startsWith('-l ') || line.includes(' -l '))).toHaveLength(3);
    expect(sendLog.filter((line) => line.includes(' C-c'))).toHaveLength(3);
  });

  function dispatchArgs(agentId: string): string[] {
    return [
      DISPATCH_AGENT_SH,
      '--session', sessionName,
      '--role', 'tester',
      '--prompt', 'Dispatch retry verification',
      '--agent-id', agentId,
      '--db-path', path.join(stateDir, 'tmup.db'),
      '--working-dir', PLUGIN_DIR,
      '--pane-index', '1',
    ];
  }

  function shellEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: tmpHome,
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      TMUX_FAKE_CAPTURE_FILE: captureSequencePath,
      TMUX_FAKE_SEND_LOG: sendLogPath,
    };
  }

  function readSendLog(): string[] {
    return fs.readFileSync(sendLogPath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function writeCaptureSequence(lines: string[]): void {
    fs.writeFileSync(captureSequencePath, `${lines.join('\n')}\n`);
  }

  function writeExecutable(fileName: string, contents: string): void {
    const filePath = path.join(fakeBin, fileName);
    fs.writeFileSync(filePath, contents);
    fs.chmodSync(filePath, 0o755);
  }

  function writeTmuxStub(): void {
    const captureSequence = shellQuote(captureSequencePath);
    const captureCountFile = shellQuote(path.join(tmuxStateDir, 'capture-count'));
    const sendLogFile = shellQuote(sendLogPath);

    writeExecutable('tmux', `#!/bin/bash
set -euo pipefail
cmd="\${1:-}"
shift || true

case "$cmd" in
  display-message)
    printf 'bash\\n'
    ;;
  send-keys)
    printf '%s\\n' "$*" >> ${sendLogFile}
    ;;
  capture-pane)
    count=0
    if [[ -f ${captureCountFile} ]]; then
      count=$(cat ${captureCountFile})
    fi
    count=$((count + 1))
    printf '%s' "$count" > ${captureCountFile}
    line=$(sed -n "\${count}p" ${captureSequence} 2>/dev/null || true)
    printf '%b' "$line"
    ;;
  *)
    printf 'unexpected tmux command: %s\\n' "$cmd" >&2
    exit 1
    ;;
esac
`);
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

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }
});
