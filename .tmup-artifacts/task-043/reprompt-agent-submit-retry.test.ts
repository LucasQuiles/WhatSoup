import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../');
const REPROMPT_AGENT_SH = path.join(PLUGIN_DIR, 'scripts/reprompt-agent.sh');

describe('reprompt-agent.sh Codex submit verification', () => {
  let tmpHome: string;
  let fakeBin: string;
  let tmuxStateDir: string;
  let captureSequencePath: string;
  let sendLogPath: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmup-reprompt-submit-'));
    fakeBin = path.join(tmpHome, 'fakebin');
    tmuxStateDir = path.join(tmpHome, 'tmux-state');
    captureSequencePath = path.join(tmuxStateDir, 'capture-sequence.txt');
    sendLogPath = path.join(tmuxStateDir, 'send-keys.log');

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(tmuxStateDir, { recursive: true });

    writeTmuxStub();
    writeExecutable('sleep', '#!/bin/bash\nexit 0\n');
    writeExecutable('yq', '#!/bin/bash\nprintf \'null\\n\'\n');

    for (const commandName of [
      'cat',
      'chmod',
      'dirname',
      'grep',
      'mktemp',
      'rm',
      'sed',
      'timeout',
    ]) {
      linkSystemBinary(commandName);
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  });

  it('submits once when Codex starts working after the first Enter', () => {
    writeCaptureSequence([
      '❯\\n',
      'Working (accepted)\\n',
    ]);

    execFileSync('/bin/bash', [
      REPROMPT_AGENT_SH,
      '--session', 'test-session',
      '--pane', '2',
      '--prompt', 'Follow-up verification',
    ], {
      env: shellEnv(),
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const sendLog = readSendLog();
    expect(sendLog.filter((line) => line.includes(' Enter'))).toHaveLength(1);
    expect(sendLog.filter((line) => line.startsWith('-l ') || line.includes(' -l '))).toHaveLength(1);
  });

  it('fails after three submit attempts when Codex never starts working', () => {
    writeCaptureSequence([
      '❯\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
      '❯ still idle\\n',
    ]);

    let failure: { status?: number; stderr?: Buffer | string } | undefined;
    try {
      execFileSync('/bin/bash', [
        REPROMPT_AGENT_SH,
        '--session', 'test-session',
        '--pane', '0',
        '--prompt', 'Retry me',
      ], {
        env: shellEnv(),
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      failure = error;
    }

    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr ?? '')).toContain('failed to confirm Codex accepted the reprompt');

    const sendLog = readSendLog();
    expect(sendLog.filter((line) => line.includes(' Enter'))).toHaveLength(3);
    expect(sendLog.filter((line) => line.startsWith('-l ') || line.includes(' -l '))).toHaveLength(1);
  });

  function shellEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: tmpHome,
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      TMUX_FAKE_CAPTURE_FILE: captureSequencePath,
      TMUX_FAKE_SEND_LOG: sendLogPath,
      TMUX_FAKE_PANE_COMMAND: 'codex',
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
  has-session)
    exit 0
    ;;
  display-message)
    printf '%s\\n' "\${TMUX_FAKE_PANE_COMMAND:-codex}"
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
