// Watchdog credential-death escalation (deploy/templates/watchdog-script.sh).
//
// Root cause pinned on mini11 (Jul 15–27 outage): the watchdog's decision
// block treats `degraded` as ok and never inspects turn capability, so a bot
// whose claude credential is dead — model_usability_status
// 'credential-unavailable', a state a restart cannot fix — logged plain "ok"
// every two minutes for 12 days. These tests run the template's embedded
// python decision block against real-shaped health payloads and pin the new
// contract: exit 3 (distinct from restart-worthy exit 1) plus a
// CREDENTIAL-DEAD stderr line when the credential is dead, existing
// restart/ok behavior otherwise; the shell wiring routes exit 3 to a log
// line + marker file and NEVER to restart_label.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const templatePath = path.join(repoRoot, 'deploy', 'templates', 'watchdog-script.sh');
const template = fs.readFileSync(templatePath, 'utf8');

const BOT = 'tb-bot';

function decisionScript(): string {
  const m = template.match(/python3 - <<'PY'[^\n]*\n([\s\S]*?)\nPY\n/);
  if (!m) throw new Error('embedded python decision block not found in watchdog template');
  return m[1].replaceAll('BOT_NAME', BOT);
}

interface RunResult {
  status: number | null;
  stderr: string;
}

function runDecision(payload: Record<string, unknown>, httpCode = '200'): RunResult {
  const r = spawnSync('python3', ['-'], {
    input: decisionScript(),
    encoding: 'utf8',
    env: { ...process.env, BOT_JSON: JSON.stringify(payload), BOT_CODE: httpCode },
    timeout: 15_000,
  });
  return { status: r.status, stderr: r.stderr };
}

function healthyPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'healthy',
    whatsapp: {
      connected: true,
      connection: {
        state: 'connected',
        last_pong_at: new Date().toISOString(),
        auth_failure_class: 'none',
      },
    },
    turn_capability: { model_usability_status: 'usable' },
    ...over,
  };
}

describe('watchdog decision block — credential death', () => {
  it('exits 3 with a CREDENTIAL-DEAD line when the credential is dead on an otherwise-passing bot', () => {
    const r = runDecision(healthyPayload({
      turn_capability: { model_usability_status: 'credential-unavailable' },
    }));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('CREDENTIAL-DEAD');
  });

  it('exits 3 when the bot is degraded AND the credential is dead (degraded-is-ok must not mask it)', () => {
    const r = runDecision(healthyPayload({
      status: 'degraded',
      turn_capability: { model_usability_status: 'credential-unavailable' },
    }));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('CREDENTIAL-DEAD');
  });

  it('still exits 0 for a healthy, usable bot', () => {
    const r = runDecision(healthyPayload());
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('CREDENTIAL-DEAD');
  });

  it('still exits 0 for a degraded bot with a usable credential (existing degraded-is-ok rule)', () => {
    const r = runDecision(healthyPayload({ status: 'degraded' }));
    expect(r.status).toBe(0);
  });

  it('exits 0 when turn_capability is absent or null (no evidence is not credential death)', () => {
    expect(runDecision(healthyPayload({ turn_capability: null })).status).toBe(0);
    const { turn_capability: _drop, ...rest } = healthyPayload();
    expect(runDecision(rest).status).toBe(0);
  });

  it('keeps restart-worthy failures on exit 1 even when the credential is also dead (crash wins)', () => {
    const r = runDecision(healthyPayload({
      status: 'unhealthy',
      whatsapp: { connected: false, connection: { state: 'close', last_pong_at: null, auth_failure_class: 'none' } },
      turn_capability: { model_usability_status: 'credential-unavailable' },
    }));
    expect(r.status).toBe(1);
  });

  it('keeps the terminal-auth no-restart branch on exit 0 (unchanged)', () => {
    const r = runDecision(healthyPayload({
      status: 'unhealthy',
      whatsapp: {
        connected: false,
        connection: { state: 'close', last_pong_at: null, auth_failure_class: 'pairing_required' },
      },
    }));
    expect(r.status).toBe(0);
  });
});

describe('watchdog shell wiring — exit 3 routes to marker + log, never restart', () => {
  it('captures the decision exit code instead of `|| restart_label`', () => {
    expect(template).not.toMatch(/PY\s*\|\|\s*restart_label/);
    expect(template).toMatch(/py_rc=\$\?/);
  });

  it('routes exit 3 to a CREDENTIAL-DEAD log line and a marker file, with no restart in that branch', () => {
    const branch = template.match(/if \[ "\$py_rc" -eq 3 \]; then\n([\s\S]*?)\n\s*elif/)?.[1];
    expect(branch, 'exit-3 branch missing from shell wiring').toBeTruthy();
    expect(branch).toContain('CREDENTIAL-DEAD');
    expect(branch).toContain('credential-dead');
    expect(branch).not.toContain('restart_label');
  });

  it('clears the marker file on a passing check so the marker reflects current state', () => {
    expect(template).toMatch(/rm -f "\$CRED_MARKER"/);
  });

  it('keeps nonzero-but-not-3 exits on the restart path', () => {
    expect(template).toMatch(/elif \[ "\$py_rc" -ne 0 \]; then\n\s*restart_label/);
  });
});
