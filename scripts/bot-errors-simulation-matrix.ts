#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type BotErrorsSimulationDomain =
  | 'provider-runtime'
  | 'whatsapp-auth-bond'
  | 'bot-errors-delivery'
  | 'supervision-orchestration'
  | 'fleet-recovery';

export type BotErrorsSimulationRisk = 'critical' | 'high';

export interface BotErrorsSimulationAnchor {
  file: string;
  anchors: string[];
}

export interface BotErrorsSimulationRequirement {
  id: string;
  domain: BotErrorsSimulationDomain;
  risk: BotErrorsSimulationRisk;
  signal: string;
  expectedOutcome: string;
  evidence: BotErrorsSimulationAnchor[];
}

export interface BotErrorsSimulationMatrixResult {
  ok: boolean;
  checked: number;
  findings: string[];
}

const REQUIRED_DOMAINS: BotErrorsSimulationDomain[] = [
  'provider-runtime',
  'whatsapp-auth-bond',
  'bot-errors-delivery',
  'supervision-orchestration',
  'fleet-recovery',
];

export const BOT_ERRORS_SIMULATION_MATRIX: BotErrorsSimulationRequirement[] = [
  {
    id: 'provider-fallback-state-machine',
    domain: 'provider-runtime',
    risk: 'critical',
    signal: 'usage-limit, auth-required, empty-output, and probe-unusable provider fallback transitions',
    expectedOutcome: 'Provider fallback activates only on terminal result paths, keeps independent-provider windows (auth-required, empty-output, probe-unusable) armed until recovery proof, and suppresses user-visible usage-limit noise from assistant text.',
    evidence: [
      {
        file: 'tests/runtimes/agent/provider-fallback.test.ts',
        anchors: [
          'AgentRuntime — provider fallback state machine',
          'keeps %s fallback armed until a primary recovery probe succeeds',
          'AgentRuntime — usage-limit assistant_text/result asymmetry',
          'does NOT activate fallback on a usage-limit assistant_text event',
          'DOES activate fallback on a usage-limit result event (the deferred site)',
        ],
      },
    ],
  },
  {
    id: 'provider-resume-and-session-failure',
    domain: 'provider-runtime',
    risk: 'critical',
    signal: 'resume failure, stale checkpoints, and context recovery paths',
    expectedOutcome: 'Resume failures spawn fresh sessions, notify the user through the controlled path, and preserve context recovery behavior without misclassifying normal exits as crashes.',
    evidence: [
      {
        file: 'tests/runtimes/agent/runtime.test.ts',
        anchors: [
          'resume failure — sends expiry message and spawns fresh session',
          'resume failure before WA connects — overrides pending startup message',
          'resume failure — sendTurn called with CONTEXT RECOVERY prefix when messages exist',
        ],
      },
      {
        file: 'tests/runtimes/agent/session.test.ts',
        anchors: [
          'clears stale thread ID from DB after resume failure',
          'spawn-per-turn non-zero exit invokes crash handling and notifies the user',
        ],
      },
    ],
  },
  {
    id: 'daily-health-auth-bond-canaries',
    domain: 'whatsapp-auth-bond',
    risk: 'critical',
    signal: 'auth-bond snapshot risk, stale backup, duplicate local auth, and physical-intervention indicators',
    expectedOutcome: 'Daily health emits actionable, redacted linked-device diagnostics and escalates risky auth-bond states without leaking credential material.',
    evidence: [
      {
        file: 'tests/scripts/bot-errors-health-check.test.ts',
        anchors: [
          'fails daily health when a connected instance reports auth bond snapshot risk',
          'auth_bond_backup_stale_for_live_creds',
          'auth_bond_restore_canary=failed reason=copied_tree_hash_mismatch',
          'physical_intervention_required',
          'FAIL auth_bond_duplicate',
        ],
      },
    ],
  },
  {
    id: 'primary-phone-linkage-protection',
    domain: 'whatsapp-auth-bond',
    risk: 'critical',
    signal: 'primary-phone verification age, symlinked state, unknown owner, and owner-confirmed checks',
    expectedOutcome: 'Primary-phone linkage verification is tracked as a first-class bond-risk signal and bad state files fail closed.',
    evidence: [
      {
        file: 'tests/scripts/bot-errors-health-check.test.ts',
        anchors: [
          'FAIL primary_phone primary-bot: owner=Lucas',
          'WARN primary_phone primary-bot: owner=Lucas',
          'OK primary_phone primary-bot: owner=Lucas',
          'FAIL primary_phone_state primary-bot: refusing to trust symlinked critical file',
        ],
      },
    ],
  },
  {
    id: 'fallback-provider-probes',
    domain: 'provider-runtime',
    risk: 'critical',
    signal: 'OpenCode fallback compatibility, model command mode, credential availability, and active fallback telemetry',
    expectedOutcome: 'Fallback provider readiness is observable before and during failover, with degraded/unsupported installs, missing credentials, and active fallback windows surfaced to BOT ERRORS.',
    evidence: [
      {
        file: 'tests/scripts/bot-errors-health-check.test.ts',
        anchors: [
          'alerts when an OpenCode fallback/provider install only supports the degraded legacy one-shot contract',
          'probes configured OpenCode fallback using fallbackProviderConfig, not primary providerConfig',
          'fails the OpenCode fallback provider probe when its model credential is missing',
          'passes the OpenCode fallback provider probe when its model credential is present',
          'warns when the health endpoint is serving through an active provider fallback',
        ],
      },
    ],
  },
  {
    id: 'source-and-runtime-drift-probes',
    domain: 'supervision-orchestration',
    risk: 'critical',
    signal: 'source update reachability, enforced source-update failures, and runtime-manifest drift',
    expectedOutcome: 'Health checks can distinguish source-update access failures from other daily-health issues and can fail closed on runtime-script drift.',
    evidence: [
      {
        file: 'tests/scripts/bot-errors-health-check.test.ts',
        anchors: [
          'runtime_manifest: files=1',
          'source_update: git_remote reachable mode=enforce remote=origin ref=HEAD rc=0',
          'FAIL source_update: source_update_blocked mode=enforce',
          'source_update: shadow source_update_blocked mode=shadow',
        ],
      },
      {
        file: 'tests/scripts/source-runtime-drift-check.test.ts',
        anchors: [
          'source runtime drift check',
          'exits nonzero and emits JSON for drift',
        ],
      },
    ],
  },
  {
    id: 'provisioning-env-and-service-parity',
    domain: 'supervision-orchestration',
    risk: 'critical',
    signal: 'BOT ERRORS systemd/launchd provisioning, routing env parity, and installer fail-closed behavior',
    expectedOutcome: 'Fresh provisioning installs the monitor services/timers, both platform paths carry the private routing env contract, setup backfill plus launchd installers parse host env without executing it as shell, and launchd installers fail before writing plists when required health-profile input is missing.',
    evidence: [
      {
        file: 'tests/deploy/setup-platform.test.ts',
        anchors: [
          'Linux setup installs BOT ERRORS service and timer units, not just the env template',
          'Linux setup replay copies BOT ERRORS units and writes private routing env',
          'Linux setup replay mirrors BOT_ERRORS_SOCKET when BOT_ERRORS_SOCKET_PATH is absent',
          'Linux setup replay backfills missing BOT ERRORS keys in an existing private env file',
          'Linux setup replay stops before routing env creation when daemon-reload fails',
          'setup provisions the full BOT ERRORS routing env contract',
        ],
      },
      {
        file: 'tests/scripts/bot-errors-service-templates.test.ts',
        anchors: [
          'load live routing from the private host env file',
          'launchd installers hydrate routing env from the private host env file into rendered plists',
          'renders launchd plists with routing env from file without executing env-file shell',
          'prefers explicit launchd installer env over stale private env-file values',
          'mirrors BOT_ERRORS_SOCKET into BOT_ERRORS_SOCKET_PATH when the path key is absent',
          'fails closed when launchctl bootstrap rejects a rendered plist',
          'fails closed before writing launchd plists when the health profile is missing',
          'must not source the host env as executable shell',
        ],
      },
    ],
  },
  {
    id: 'delivery-durability-and-writefail',
    domain: 'bot-errors-delivery',
    risk: 'critical',
    signal: 'outbox write failure, writefail breadcrumbs, remote writefail harvest, duplicate recovery, and terminal ack failure',
    expectedOutcome: 'Alerts are either durably queued or durably recoverable, and writefail recovery is idempotent without losing remote evidence.',
    evidence: [
      {
        file: 'tests/scripts/bot-errors-emit.test.ts',
        anchors: [
          'records a reconstructable breadcrumb when the outbox is unwritable (B4)',
          'prefers the collector-visible home writefail fallback before TMPDIR',
        ],
      },
      {
        file: 'tests/scripts/bot-errors-collector.test.ts',
        anchors: [
          'harvests remote writefail crumbs into the local writefail inbox with provenance',
          'lets dispatcher recover a harvested critical remote writefail end to end',
          'preserves a remote writefail claim when no terminal ack archive is writable',
        ],
      },
      {
        file: 'tests/scripts/bot-errors-dispatcher.test.ts',
        anchors: [
          'recovers writefail breadcrumbs into the normal dispatch path',
          'does not replay writefail breadcrumbs for events already known locally',
          'does not treat substring event-id matches as writefail duplicates',
        ],
      },
      {
        file: 'tests/scripts/bot-errors-health-check.test.ts',
        anchors: [
          'records a recoverable writefail breadcrumb when daily health outbox is unwritable',
        ],
      },
    ],
  },
  {
    id: 'dispatcher-noise-control',
    domain: 'bot-errors-delivery',
    risk: 'critical',
    signal: 'same-fingerprint alert storms, daily-health noise, duplicate clears, and test-provenance leakage',
    expectedOutcome: 'Q receives bounded, actionable alerts with auditable suppression rather than duplicate storms or test-route leakage.',
    evidence: [
      {
        file: 'tests/scripts/bot-errors-dispatcher.test.ts',
        anchors: [
          'collapses same-fingerprint storms into one manifest-backed digest',
          'limits storm collapse to one digest per time window',
          'suppresses daily-health info sends with a distinct auditable disposition',
          'suppresses duplicate clear recoveries while preserving the first visible recovery',
          'suppresses test-provenance events and sends one path-free debounced meta-alert',
        ],
      },
    ],
  },
  {
    id: 'q-loop-and-watchdog-supervision',
    domain: 'supervision-orchestration',
    risk: 'critical',
    signal: 'Q-loop idle backoff, stale heartbeats, daily health cadence, local service health, queue backlog, and writefail backlog',
    expectedOutcome: 'Supervision state survives restarts, stale services are surfaced, and watchdog checks alert without unbounded spam.',
    evidence: [
      {
        file: 'tests/scripts/bot-errors-q-loop.test.ts',
        anchors: [
          'keeps max idle backoff strictly below the watchdog stale threshold with margin',
        ],
      },
      {
        file: 'tests/scripts/bot-errors-heartbeat-watchdog.test.ts',
        anchors: [
          'emits a durable alert when the q-loop heartbeat is stale',
          'suppresses duplicate open heartbeat alerts and confirms recovery before sending one clear',
          'emits when daily health cadence is missing or stale',
          'BOT ERRORS heartbeat watchdog stale: local_service:whatsoup-agent-alpha.service',
          'emits a continuous watchdog alert when writefail breadcrumbs accumulate',
        ],
      },
    ],
  },
  {
    id: 'fleet-linked-device-logged-out-detection',
    domain: 'fleet-recovery',
    risk: 'critical',
    signal: 'fleet health poll logged-out body, stale reconnect hints, weak backoff persistence, and explicit logout evidence',
    expectedOutcome: 'Fleet polling ignores stale reconnect metadata when current connection evidence is healthy, keeps weak disconnected hints quiet until persistence, and emits logged-out state only on explicit or persistent corroborated evidence.',
    evidence: [
      {
        file: 'tests/fleet/health-poller.test.ts',
        anchors: [
          'ignores stale backoff-zero reconnect metadata when connection is healthy',
          'keeps disconnected backoff-zero ambiguous without explicit auth-loss proof',
          'emits logged-out immediately for explicit 401 logout evidence',
          'weak_signal_polls=3',
          'instance_logged_out',
          "toBe('logged_out')",
        ],
      },
    ],
  },
];

function checkDuplicateIds(findings: string[]): void {
  const seen = new Set<string>();
  for (const row of BOT_ERRORS_SIMULATION_MATRIX) {
    if (seen.has(row.id)) findings.push(`${row.id}: duplicate simulation requirement id`);
    seen.add(row.id);
  }
}

function checkRequiredDomains(findings: string[]): void {
  const present = new Set(BOT_ERRORS_SIMULATION_MATRIX.map(row => row.domain));
  for (const domain of REQUIRED_DOMAINS) {
    if (!present.has(domain)) findings.push(`${domain}: missing simulation domain`);
  }
}

function checkRowShape(findings: string[]): void {
  for (const row of BOT_ERRORS_SIMULATION_MATRIX) {
    if (!row.id.trim()) findings.push('matrix row has empty id');
    if (!row.signal.trim()) findings.push(`${row.id}: signal must be non-empty`);
    if (!row.expectedOutcome.trim()) findings.push(`${row.id}: expectedOutcome must be non-empty`);
    if (row.evidence.length === 0) findings.push(`${row.id}: at least one evidence anchor is required`);
    for (const anchor of row.evidence) {
      if (!anchor.file.trim()) findings.push(`${row.id}: evidence file must be non-empty`);
      if (anchor.anchors.length === 0) findings.push(`${row.id}: ${anchor.file} must list at least one anchor`);
      for (const marker of anchor.anchors) {
        if (!marker.trim()) findings.push(`${row.id}: ${anchor.file} includes an empty anchor`);
      }
    }
  }
}

function checkAnchorFiles(cwd: string, findings: string[]): void {
  const cache = new Map<string, string | null>();
  for (const row of BOT_ERRORS_SIMULATION_MATRIX) {
    for (const anchor of row.evidence) {
      const absolute = path.join(cwd, anchor.file);
      if (!cache.has(absolute)) {
        cache.set(absolute, existsSync(absolute) ? readFileSync(absolute, 'utf8') : null);
      }
      const text = cache.get(absolute);
      if (text === null || text === undefined) {
        findings.push(`${row.id}: missing evidence file ${anchor.file}`);
        continue;
      }
      for (const marker of anchor.anchors) {
        if (!text.includes(marker)) {
          findings.push(`${row.id}: ${anchor.file} missing anchor ${JSON.stringify(marker)}`);
        }
      }
    }
  }
}

function checkCriticalDepth(findings: string[]): void {
  const criticalRows = BOT_ERRORS_SIMULATION_MATRIX.filter(row => row.risk === 'critical');
  if (criticalRows.length < 9) {
    findings.push(`critical-depth: expected at least 9 critical simulation rows, found ${criticalRows.length}`);
  }
  for (const row of criticalRows) {
    const anchorCount = row.evidence.reduce((sum, item) => sum + item.anchors.length, 0);
    if (anchorCount < 3) {
      findings.push(`${row.id}: critical rows require at least 3 evidence anchors`);
    }
  }
}

export function checkBotErrorsSimulationMatrix(cwd = process.cwd()): BotErrorsSimulationMatrixResult {
  const findings: string[] = [];
  checkDuplicateIds(findings);
  checkRequiredDomains(findings);
  checkRowShape(findings);
  checkCriticalDepth(findings);
  checkAnchorFiles(cwd, findings);
  return {
    ok: findings.length === 0,
    checked: BOT_ERRORS_SIMULATION_MATRIX.length,
    findings,
  };
}

function printHelp(): void {
  console.log(`Usage: npm run guard:bot-errors-simulation-matrix

Verifies that the BOT ERRORS/Q-loop reliability matrix is backed by executable
simulation fixtures for provider fallback, linked-device bonds, alert routing,
delivery durability, supervision, and fleet recovery clears.`);
}

export function run(argv: string[] = process.argv.slice(2), cwd = process.cwd()): BotErrorsSimulationMatrixResult {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return { ok: true, checked: 0, findings: [] };
  }

  const result = checkBotErrorsSimulationMatrix(cwd);
  if (!result.ok) {
    console.error('BOT ERRORS simulation matrix guard failed');
    for (const finding of result.findings) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else {
    console.log(`BOT ERRORS simulation matrix guard passed (${result.checked} requirements)`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
