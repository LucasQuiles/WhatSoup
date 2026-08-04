// Watchdog credential-state contract (deploy/templates/watchdog-script.sh).
//
// Root cause pinned on mini11 (Jul 15–27 outage): the watchdog's decision
// block treated `degraded` as ok and only inspected one stale usability
// field, so a bot whose provider credential was dead logged plain "ok" every
// two minutes for 12 days. These tests run the template's embedded python
// decision block against real-shaped health payloads and pin the contract
// (docs/superpowers/specs/2026-08-03-watchdog-auth-required-contract-design.md):
//   exit 3 — dead (any current normalized auth-required signal): the shell
//            logs CREDENTIAL-DEAD, creates/retains the marker, never restarts;
//   exit 0 — recovered (affirmative fresh primary proof): the ONLY exit that
//            may clear the marker;
//   exit 4 — unknown, no fallback window active (stderr-silent);
//   exit 5 — unknown while a fallback window is active;
//   exit 6 — untrusted diagnostic evidence (shell HEALTH-UNKNOWN / exit 2);
//   exit 1 — restart-worthy liveness failures (unchanged, higher priority).
// Shell wiring: exits 4/5 route to a branch that never restarts and never
// touches the marker, ahead of the generic nonzero restart elif; the final
// log escalates to CREDENTIAL-UNKNOWN only when a marker is present or the
// fallback window is active.
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
  return runRawDecision(JSON.stringify(payload), httpCode);
}

function runRawDecision(payload: string, httpCode = '200'): RunResult {
  const r = spawnSync('python3', ['-'], {
    input: decisionScript(),
    encoding: 'utf8',
    env: { ...process.env, BOT_JSON: payload, BOT_CODE: httpCode },
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
    expect(r.stderr).toContain('fallbackReason');
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
    expect(r.stderr).toContain('last_turn_error_class=auth-required');
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

  it('exits 4 (stderr-silent) when turn_capability is absent or null — no evidence is unknown, not recovery', () => {
    // Permanent and correct for non-agent instances: watchdogs install for
    // every instance type, and non-agent health has turn_capability=null.
    const absent = runDecision(healthyPayload({ turn_capability: null }));
    expect(absent.status).toBe(4);
    expect(absent.stderr).not.toContain('CREDENTIAL');
    const { turn_capability: _drop, ...rest } = healthyPayload();
    expect(runDecision(rest).status).toBe(4);
  });

  it('exits 4 (stderr-silent) for stale usable evidence without a current auth failure', () => {
    // The healthy idle bot past its 30-minute probe TTL lands here every
    // cycle — a stderr line here would double idle log volume fleet-wide.
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
    expect(r.stderr).not.toContain('CREDENTIAL');
  });

  it('a bare usable status with no probe evidence is NOT recovered (regression to the one-field contract)', () => {
    const r = runDecision(healthyPayload({
      turn_capability: { model_usability_status: 'usable' },
    }));
    expect(r.status).toBe(4);
  });

  it('non-dead usability statuses classify unknown (exit 4) — the dead set is exactly credential-unavailable', () => {
    for (const status of ['model-unavailable', 'provider-unavailable', 'timeout', 'unknown', null]) {
      const r = runDecision(healthyPayload({
        turn_capability: { model_usability_status: status },
      }));
      expect(r.status, `model_usability_status=${String(status)}`).toBe(4);
      expect(r.stderr).not.toContain('CREDENTIAL-DEAD');
    }
  });

  it('exits 5 with a CREDENTIAL-UNKNOWN line while a non-auth fallback window is active', () => {
    const r = runDecision(healthyPayload({
      instance: { fallbackReason: 'usage-limit' },
      turn_capability: {
        model_usable: null,
        model_usable_stale: true,
        model_usability_status: 'usable',
        last_successful_turn_at: 200,
        last_turn_error_class: null,
        last_turn_error_at: null,
      },
    }));
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('CREDENTIAL-UNKNOWN');
  });

  it('classifies the unauthenticated public envelope as untrusted evidence (exit 6)', () => {
    // #2515: the 4-field public envelope has no whatsapp block, so the
    // diagnostic object shape, so it can never clear the marker or restart.
    const r = runDecision({
      schema_version: 'health.public.v1',
      status: 'healthy',
      generated_at: new Date().toISOString(),
      startupNotification: null,
    });
    expect(r.status).toBe(6);
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

  it('routes the terminal-auth branch to unknown-quiescent (exit 4): no restart, marker retained', () => {
    const r = runDecision(healthyPayload({
      status: 'unhealthy',
      whatsapp: {
        connected: false,
        connection: { state: 'close', last_pong_at: null, auth_failure_class: 'pairing_required' },
      },
    }));
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('terminal auth_failure_class');
  });
});

describe('watchdog decision block — malformed evidence is HEALTH-UNKNOWN', () => {
  it('exits 6 for a string instance field on an otherwise-recovered-looking bot', () => {
    const r = runDecision(healthyPayload({ instance: 'future-shape' }));
    expect(r.status).toBe(6);
    expect(r.stderr).toContain('untrusted instance');
  });

  it('exits 6 for an array instance field — a malformed shape must never reach recovery', () => {
    const r = runDecision(healthyPayload({ instance: [] }));
    expect(r.status).toBe(6);
    expect(r.stderr).toContain('untrusted instance');
  });

  it('does not trust a dead usability status paired with a malformed instance shape', () => {
    const r = runDecision(healthyPayload({
      instance: 'future-shape',
      turn_capability: { model_usability_status: 'credential-unavailable' },
    }));
    expect(r.status).toBe(6);
    expect(r.stderr).not.toContain('CREDENTIAL-DEAD');
  });

  it('rejects duplicate keys at any nesting level with exit 6', () => {
    const r = runRawDecision(
      '{"status":"healthy","whatsapp":{"connected":true,"connection":{"state":"connected"}},' +
      '"turn_capability":{"model_usability_status":"credential-unavailable"},' +
      '"turn_capability":{"model_usability_status":"usable"}}',
    );
    expect(r.status).toBe(6);
    expect(r.stderr).toContain('untrusted diagnostic health JSON');
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

  it('routes exits 4 and 5 to a no-restart, no-marker-mutation branch ahead of the generic restart elif', () => {
    const branch = template.match(
      /elif \[ "\$py_rc" -eq 4 \] \|\| \[ "\$py_rc" -eq 5 \]; then\n([\s\S]*?)\n\s*elif \[ "\$py_rc" -ne 0 \]/,
    )?.[1];
    expect(branch, 'unknown-state branch missing or ordered after the restart elif').toBeTruthy();
    expect(branch).toContain('CREDENTIAL-UNKNOWN');
    expect(branch).not.toContain('restart_label');
    expect(branch).not.toContain('touch "$CRED_MARKER"');
    expect(branch).not.toContain('rm -f "$CRED_MARKER"');
  });

  it('routes decision exit 6 to HEALTH-UNKNOWN without restart or marker mutation', () => {
    const branch = template.match(
      /elif \[ "\$py_rc" -eq 6 \]; then\n([\s\S]*?)\n\s*elif \[ "\$py_rc" -ne 0 \]/,
    )?.[1];
    expect(branch, 'exit-6 branch missing or ordered after generic restart').toBeTruthy();
    expect(branch).toContain('health_unknown');
    expect(branch).not.toContain('restart_label');
    expect(branch).not.toContain('CRED_MARKER');
    expect(template).toMatch(/health_unknown\(\)[\s\S]*WD_EXIT=2/);
    expect(template).toMatch(/65536/);
    expect(template).toContain('object_pairs_hook=reject_duplicate_keys');
  });

  it('clears the marker only on affirmative recovery and does not mask removal failure', () => {
    expect(template).toMatch(/if \[ -e "\$CRED_MARKER" \]; then/);
    expect(template).toMatch(/if ! rm -f "\$CRED_MARKER"/);
    expect(template).not.toMatch(/rm -f "\$CRED_MARKER"[^\n]*\|\| true/);
  });

  it('does not mask marker creation failure and returns the accumulated watchdog status', () => {
    expect(template).toMatch(/if ! touch "\$CRED_MARKER"/);
    expect(template).toMatch(/if \[ ! -e "\$CRED_MARKER" \]; then/);
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
  // instance bearer from a strictly validated tokens.env.
  it('reads the bearer through a private descriptor with canonical validation', () => {
    expect(template).toMatch(/BOT_TOKENS_ENV="\$HOME_DIR\/\.config\/whatsoup\/instances\/BOT_NAME\/tokens\.env"/);
    expect(template).toContain('os.lstat(path)');
    expect(template).toContain('getattr(os, "O_NOFOLLOW", 0)');
    expect(template).toContain('stat.S_IMODE(file_before.st_mode) != 0o600');
    expect(template).toContain('(file_before.st_dev, file_before.st_ino) != (opened.st_dev, opened.st_ino)');
    expect(template).toContain('TOKEN_RE.fullmatch(token)');
    expect(template).not.toMatch(/sed -n 's\/\^WHATSOUP_HEALTH_TOKEN=/);
  });

  it('sends the bearer through curl config stdin, never curl argv', () => {
    const botCurl = template.match(/bot_resp="\$\([^\n]*curl --config -[^\n]*/)?.[0];
    expect(botCurl, 'bot health curl line missing').toBeTruthy();
    expect(botCurl).toContain('header = \\"Authorization: Bearer $HEALTH_TOKEN\\"');
    expect(botCurl).not.toContain(' -H ');
    expect(template).not.toContain('AUTH_ARGS=');
  });

  it('never writes the token to the log', () => {
    expect(template).not.toMatch(/export[^\n]*HEALTH_TOKEN/);
    expect(template).not.toMatch(/log[^\n]*\$HEALTH_TOKEN/);
    expect(template).toMatch(/curl_rc=\$\?\n\s*HEALTH_TOKEN=""/);
  });
});
