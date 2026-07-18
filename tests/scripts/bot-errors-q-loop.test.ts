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

  it('reports collaboration target coverage without exposing raw group ids', () => {
    const result = python(`${importModulePrelude()}
import json
bot_errors_target = ("1" * 8) + "@g.us"
intended_target = ("2" * 8) + "@g.us"
m.BOT_ERRORS_JID = bot_errors_target
print(json.dumps(m.q_loop_target_coverage(intended_target), sort_keys=True))
`);
    const diagnostic = JSON.parse(result) as {
      bot_errors_target_kind: string;
      bot_errors_target_present: boolean;
      coverage: string;
      intended_target_kind: string;
      intended_target_present: boolean;
      targets_equal: boolean;
    };

    expect(diagnostic).toEqual({
      bot_errors_target_kind: 'group',
      bot_errors_target_present: true,
      coverage: 'routing_mismatch',
      intended_target_kind: 'group',
      intended_target_present: true,
      route_bridge_present: false,
      targets_equal: false,
    });
    expect(result).not.toContain('@g.us');
    expect(result).not.toContain('11111111');
    expect(result).not.toContain('22222222');
  });

  it('reports intended target as bridged only when an explicit bridge covers it', () => {
    const result = python(`${importModulePrelude()}
import json
bot_errors_target = ("1" * 8) + "@g.us"
intended_target = ("2" * 8) + "@g.us"
unrelated_target = ("3" * 8) + "@g.us"
m.BOT_ERRORS_JID = bot_errors_target
print(json.dumps({
  "covered": m.q_loop_target_coverage(intended_target, bridged_targets=[intended_target]),
  "uncovered": m.q_loop_target_coverage(intended_target, bridged_targets=[unrelated_target]),
}, sort_keys=True))
`);
    const diagnostic = JSON.parse(result) as {
      covered: {
        coverage: string;
        route_bridge_present: boolean;
        targets_equal: boolean;
      };
      uncovered: {
        coverage: string;
        route_bridge_present: boolean;
        targets_equal: boolean;
      };
    };

    expect(diagnostic.covered).toMatchObject({
      coverage: 'bridged',
      route_bridge_present: true,
      targets_equal: false,
    });
    expect(diagnostic.uncovered).toMatchObject({
      coverage: 'routing_mismatch',
      route_bridge_present: false,
      targets_equal: false,
    });
    expect(result).not.toContain('@g.us');
    expect(result).not.toContain('11111111');
    expect(result).not.toContain('22222222');
    expect(result).not.toContain('33333333');
  });

  it('persists collaboration target coverage during a runtime loop iteration', () => {
    const root = tmpRoot();
    const result = python(`${importModulePrelude()}
import argparse
import contextlib
import io
import json
root = Path(${JSON.stringify(root)})
root.mkdir(parents=True, exist_ok=True)
m.STATE_DIR = root
m.STATE_FILE = root / "state.json"
m.EVENT_LOG = root / "events.jsonl"
m.ACTIVITY_LOG = root / "activity.jsonl"
m.LOCK_FILE = root / "loop.lock"
m.BOT_ERRORS_JID = ("1" * 8) + "@g.us"
m.BOT_ERRORS_EXPECTED_JID = m.BOT_ERRORS_JID
m.bootstrap_cursor_pk = lambda db: (0, 0)
m.read_messages = lambda db, after_pk: []
with contextlib.redirect_stdout(io.StringIO()):
    m.run_once(argparse.Namespace(db="unused.sqlite", socket="", no_send=True))
state = json.loads(m.STATE_FILE.read_text())
event_log = m.EVENT_LOG.read_text()
print(json.dumps({
  "state": state.get("target_coverage"),
  "event_log_has_suffix": "@g.us" in event_log,
  "state_has_suffix": "@g.us" in json.dumps(state),
}, sort_keys=True))
`);
    const diagnostic = JSON.parse(result) as {
      event_log_has_suffix: boolean;
      state: { coverage: string; targets_equal: boolean } | null;
      state_has_suffix: boolean;
    };

    expect(diagnostic.state).toMatchObject({
      coverage: 'covered',
      targets_equal: true,
    });
    expect(diagnostic.event_log_has_suffix).toBe(false);
    expect(diagnostic.state_has_suffix).toBe(false);
  });

  it('diagnoses stale awaiting-Q behavior even when heartbeat phase is monitoring', () => {
    const result = python(`${importModulePrelude()}
import json
state = m.default_state()
state["phase"] = "monitoring"
state["awaiting_q_since"] = 1000
state["last_q_message_at"] = 0
print(json.dumps(m.q_response_wait_diagnostic(state, current=1000 + (25 * 60)), sort_keys=True))
`);
    const diagnostic = JSON.parse(result) as {
      awaiting_q: boolean;
      awaiting_q_age_seconds: number;
      last_q_message_age_seconds: number | null;
      phase: string;
      status: string;
    };

    expect(diagnostic).toEqual({
      awaiting_q: true,
      awaiting_q_age_seconds: 1500,
      last_q_message_age_seconds: null,
      phase: 'monitoring',
      status: 'stale_awaiting_q',
    });
  });

  it('does not re-arm the awaiting-Q clock from the loop’s own reminder frames', () => {
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
state["awaiting_q_since"] = 1000
for body in (
    "Codex -> Q / gate nudge\\n\\nStill inside the approved SDLC gate. Please reply with APPROVED or BLOCKED.",
    "Codex -> Q / hourly SDLC checkpoint\\n\\nNo reply yet; the gate remains blocked until Q approves.",
):
    m.classify_activity(state, [{
      "pk": 2,
      "body": body,
      "timestamp": 5000,
      "is_from_me": 1,
      "sender_name": "personal",
    }])
print(state["awaiting_q_since"])
`);
    expect(result).toBe('1000');
  });

  it('arms the awaiting-Q clock for a legitimate ask that extends a reminder header', () => {
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
state["awaiting_q_since"] = 0
m.classify_activity(state, [{
  "pk": 4,
  "body": "Codex -> Q / gate nudge escalation: this is a new ask, please reply APPROVED or BLOCKED.",
  "timestamp": 7000,
  "is_from_me": 1,
  "sender_name": "personal",
}])
print(state["awaiting_q_since"])
`);
    expect(result).toBe('7000');
  });

  it('re-arms the awaiting-Q clock from the one-shot bootstrap frame on history replay', () => {
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
state["awaiting_q_since"] = 0
m.classify_activity(state, [{
  "pk": 5,
  "body": m.BOOTSTRAP_HEADER + "\\n\\nCompletion remains blocked until Q verifies each gate.",
  "timestamp": 8000,
  "is_from_me": 1,
  "sender_name": "personal",
}])
print(state["awaiting_q_since"])
`);
    expect(result).toBe('8000');
  });

  it('still arms the awaiting-Q clock for a fresh non-reminder Codex ask', () => {
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
state["awaiting_q_since"] = 0
m.classify_activity(state, [{
  "pk": 3,
  "body": "Codex -> Q / slice 2 review request\\n\\nSpec attached. Please reply with APPROVED or BLOCKED.",
  "timestamp": 6000,
  "is_from_me": 1,
  "sender_name": "personal",
}])
print(state["awaiting_q_since"])
`);
    expect(result).toBe('6000');
  });
});
