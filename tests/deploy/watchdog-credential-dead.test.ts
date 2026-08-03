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
    instance: { fallbackReason: null },
    turn_capability: {
      model_usable: true,
      model_usable_stale: false,
      model_usability_status: 'usable',
      last_successful_turn_at: 200,
      last_turn_error_class: null,
      last_turn_error_at: null,
    },
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

  it('exits 3 for the observed stale-usable payload while an auth-required fallback is active', () => {
    const r = runDecision(healthyPayload({
      status: 'degraded',
      instance: { effectiveProvider: 'opencode-cli', fallbackReason: 'auth-required' },
      turn_capability: {
        model_usable: null,
        model_usable_stale: true,
        model_usability_status: 'usable',
        last_successful_turn_at: 100,
        last_turn_error_class: 'auth-required',
        last_turn_error_at: 200,
      },
    }));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('CREDENTIAL-DEAD');
  });

  it('exits 3 for a current auth-required turn error without an active fallback', () => {
    const r = runDecision(healthyPayload({
      turn_capability: {
        model_usable: null,
        model_usable_stale: true,
        model_usability_status: 'usable',
        last_successful_turn_at: 100,
        last_turn_error_class: 'auth-required',
        last_turn_error_at: 200,
      },
    }));
    expect(r.status).toBe(3);
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

  it('exits 4 when turn_capability is absent or null (no evidence is unknown, not recovery)', () => {
    expect(runDecision(healthyPayload({ turn_capability: null })).status).toBe(4);
    const { turn_capability: _drop, ...rest } = healthyPayload();
    expect(runDecision(rest).status).toBe(4);
  });

  it('exits 4 for stale usable evidence without a current auth failure', () => {
    const r = runDecision(healthyPayload({
      turn_capability: {
        model_usable: null,
        model_usable_stale: true,
        model_usability_status: 'usable',
        last_successful_turn_at: 200,
        last_turn_error_class: null,
        last_turn_error_at: null,
      },
    }));
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('CREDENTIAL-UNKNOWN');
  });

  it('accepts a later successful turn as superseding an older auth-required turn error', () => {
    const r = runDecision(healthyPayload({
      turn_capability: {
        model_usable: true,
        model_usable_stale: false,
        model_usability_status: 'usable',
        last_successful_turn_at: 300,
        last_turn_error_class: 'auth-required',
        last_turn_error_at: 200,
      },
    }));
    expect(r.status).toBe(0);
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

  it('routes exit 4 to an unknown log state without marker mutation or restart', () => {
    const branch = template.match(/elif \[ "\$py_rc" -eq 4 \]; then\n([\s\S]*?)\n\s*elif/)?.[1];
    expect(branch, 'exit-4 branch missing from shell wiring').toBeTruthy();
    expect(branch).toContain('CREDENTIAL-UNKNOWN');
    expect(branch).not.toContain('restart_label');
    expect(branch).not.toContain('CRED_MARKER');
  });

  it('clears the marker only on affirmative recovery and does not mask removal failure', () => {
    expect(template).toMatch(/if \[ -e "\$CRED_MARKER" \]; then/);
    expect(template).toMatch(/if ! rm -f "\$CRED_MARKER"/);
    expect(template).not.toMatch(/rm -f "\$CRED_MARKER"[^\n]*\|\| true/);
  });

  it('does not mask marker creation failure and returns the accumulated watchdog status', () => {
    expect(template).toMatch(/if ! touch "\$CRED_MARKER"/);
    expect(template).toMatch(/WD_EXIT=1/);
    expect(template).toMatch(/exit "\$WD_EXIT"/);
  });

  it('keeps nonzero-but-not-3 exits on the restart path', () => {
    expect(template).toMatch(/elif \[ "\$py_rc" -ne 0 \]; then\n\s*restart_label/);
  });
});

describe('watchdog shell wiring — authenticated health read (#2515 public envelope)', () => {
  // The diagnostic health body is auth-gated: unauthenticated callers get the
  // minimal public liveness envelope, whose MISSING whatsapp/turn_capability
  // fields read as connected=false/state=None — the decision block then
  // restarts a perfectly healthy bot every cooldown window, and the
  // CREDENTIAL-DEAD branch can never see turn_capability at all. Surfaced
  // live on mini11 (2026-07-29): the watchdog kicked a healthy bot two
  // minutes after a green gate. The bot health curl must therefore send the
  // instance bearer from tokens.env when one resolves.
  it('resolves the bearer from the instance tokens.env', () => {
    expect(template).toMatch(/BOT_TOKENS_ENV="\$HOME_DIR\/\.config\/whatsoup\/instances\/BOT_NAME\/tokens\.env"/);
    expect(template).toMatch(/WHATSOUP_HEALTH_TOKEN=.*sed -n 's\/\^WHATSOUP_HEALTH_TOKEN=\/\/p'/);
  });

  it('sends the bearer on the bot health curl when available', () => {
    expect(template).toMatch(/AUTH_ARGS=\(\)/);
    expect(template).toMatch(/AUTH_ARGS=\(-H "Authorization: Bearer \$WHATSOUP_HEALTH_TOKEN"\)/);
    const botCurl = template.match(/bot_resp="\$\(curl[^\n]*/)?.[0];
    expect(botCurl, 'bot health curl line missing').toBeTruthy();
    expect(botCurl).toContain('"${AUTH_ARGS[@]}"');
  });

  it('never writes the token to the log', () => {
    // The token flows only into curl argv; no log/echo/print line references it.
    const tokenUses = template.split('\n').filter((l) => l.includes('WHATSOUP_HEALTH_TOKEN') && /\b(log|echo|print)\b/.test(l));
    expect(tokenUses).toEqual([]);
  });
});
