import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bot-errors-q-loop-'));
  tmpRoots.push(dir);
  return dir;
}

function python(code: string): string {
  return execFileSync('python3', ['-c', code], { cwd: process.cwd(), encoding: 'utf8' }).trim();
}

function importModulePrelude(script = 'deploy/scripts/bot-errors-q-loop.py'): string {
  return [
    'import importlib.util',
    'from pathlib import Path',
    `spec = importlib.util.spec_from_file_location("m", "${script}")`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
  ].join('\n');
}

function pyConst(script: string, name: string): number {
  return Number(python(`${importModulePrelude(script)}\nprint(getattr(m, "${name}"))`));
}

function watchdogMaxQLoopAge(): number {
  return Number(python('import os\nprint(int(os.environ.get("BOT_ERRORS_MAX_Q_LOOP_AGE", "600")))'));
}

describe('bot-errors-q-loop cadence invariant', () => {
  const qLoop = 'deploy/scripts/bot-errors-q-loop.py';

  it('keeps deploy-specific addresses and paths out of the tracked daemon', () => {
    const text = readFileSync(qLoop, 'utf8');
    expect(text).not.toContain('120363');
    expect(text).not.toContain(['', 'home', 'q', '.local', 'share', 'whatsoup'].join('/'));
    expect(text).not.toContain(['', 'home', 'q', '.local', 'state', 'whatsoup'].join('/'));
  });

  it('keeps max idle backoff strictly below the watchdog stale threshold with margin', () => {
    const maxIdle = pyConst(qLoop, 'MAX_IDLE_WAIT_SECONDS');
    const watchdog = watchdogMaxQLoopAge();
    expect(maxIdle).toBeLessThan(watchdog);
    expect(watchdog - maxIdle).toBeGreaterThanOrEqual(60);
  });

  it('idle backoff schedule never reaches the watchdog threshold', () => {
    const idle = pyConst(qLoop, 'IDLE_WAIT_SECONDS');
    const maxIdle = pyConst(qLoop, 'MAX_IDLE_WAIT_SECONDS');
    const watchdog = watchdogMaxQLoopAge();
    for (let cycles = 1; cycles <= 1000; cycles += 1) {
      const wait = Math.min(maxIdle, idle + cycles * 60);
      expect(wait).toBeLessThan(watchdog);
    }
  });

  it('refreshes persisted SLA constants from current code defaults', () => {
    const root = tmpRoot();
    const result = python(`${importModulePrelude()}
import json
root = Path(${JSON.stringify(root)})
root.mkdir(parents=True, exist_ok=True)
m.STATE_DIR = root
m.STATE_FILE = root / "state.json"
m.EVENT_LOG = root / "events.jsonl"
m.ACTIVITY_LOG = root / "activity.jsonl"
m.LOCK_FILE = root / "loop.lock"
m.STATE_FILE.write_text(json.dumps({"sent": {}, "sla": {"max_idle_wait_seconds": 900}}))
state = m.load_state()
print(state["sla"]["max_idle_wait_seconds"])
`);
    expect(Number(result)).toBe(480);
  });

  it('does not treat incidental blocked wording as a Q block directive', () => {
    const root = tmpRoot();
    const result = python(`${importModulePrelude()}
root = Path(${JSON.stringify(root)})
root.mkdir(parents=True, exist_ok=True)
m.STATE_DIR = root
m.STATE_FILE = root / "state.json"
m.EVENT_LOG = root / "events.jsonl"
m.ACTIVITY_LOG = root / "activity.jsonl"
m.LOCK_FILE = root / "loop.lock"
state = m.default_state()
state["phase"] = "monitoring"
m.classify_activity(state, [{
  "pk": 1,
  "body": "Pre-commit hygiene guard blocked on pre-existing lines; not my diff.",
  "timestamp": m.now(),
  "is_from_me": 0,
  "sender_name": "Q",
}])
print(state["phase"])
`);
    expect(result).toBe('monitoring');
  });

  it('recognizes Q continuing monitor/poll as monitoring disposition', () => {
    const root = tmpRoot();
    const result = python(`${importModulePrelude()}
root = Path(${JSON.stringify(root)})
root.mkdir(parents=True, exist_ok=True)
m.STATE_DIR = root
m.STATE_FILE = root / "state.json"
m.EVENT_LOG = root / "events.jsonl"
m.ACTIVITY_LOG = root / "activity.jsonl"
m.LOCK_FILE = root / "loop.lock"
state = m.default_state()
state["phase"] = "blocked_by_q"
m.classify_activity(state, [{
  "pk": 1,
  "body": "Residuals unchanged. Continuing monitor/poll.",
  "timestamp": m.now(),
  "is_from_me": 0,
  "sender_name": "Q",
}])
print(state["phase"])
`);
    expect(result).toBe('monitoring');
  });
});
