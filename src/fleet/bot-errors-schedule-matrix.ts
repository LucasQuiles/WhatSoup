/**
 * Canonical BOT ERRORS schedule matrix (#2466).
 *
 * Declares which observer lanes each platform provisions, their cadence, and
 * role-appropriate watchdog check sets. Installer tests compare rendered
 * launchd jobs against this matrix to detect omissions or undeclared extras.
 *
 * The matrix is the single source of truth for platform/role schedule parity.
 * Documentation and installer assertions derive from it — not the other way
 * around. When a new lane or check is added, update this module first, then
 * the installers and tests.
 */

// ---------------------------------------------------------------------------
// Watchdog check registry
// ---------------------------------------------------------------------------

/**
 * All recognized heartbeat-watchdog check identifiers.
 * Mirrors `KNOWN_WATCHDOG_CHECKS` in `bot-errors-heartbeat-watchdog.py`.
 * The drift-guard test in the Python suite enforces alignment.
 */
export const WATCHDOG_CHECKS = [
  'q_loop',
  'dispatcher',
  'collector',
  'daily_health',
  'queue_backlog',
  'local_services',
  'local_instance_health',
  'fleet_sentinel',
  'collector_roster',
  'browser_debug',
] as const;
export type WatchdogCheck = (typeof WATCHDOG_CHECKS)[number];

/**
 * Checks that probe central/hub-only state files. These create false incidents
 * on a non-hub host where the corresponding service does not run, because the
 * state file is absent and the watchdog reports it as stale/missing.
 *
 * Specifically:
 *  - `q_loop`          checks q-loop state JSON (central queue supervisor)
 *  - `collector`       checks collector-state.json (central alert collector)
 *  - `fleet_sentinel`  checks fleet sentinel heartbeat (central sentinel)
 *  - `collector_roster` checks collector roster drift (central roster)
 */
export const HUB_ONLY_CHECKS: readonly WatchdogCheck[] = [
  'q_loop',
  'collector',
  'fleet_sentinel',
  'collector_roster',
];

/**
 * Checks safe for a local (non-hub) role. Excludes hub-only central services
 * so a non-hub macOS host cannot emit false missing-q-loop/collector incidents.
 *
 * The operator can still opt into hub-only checks by setting
 * `BOT_ERRORS_WATCHDOG_CHECKS` in the env file or launchd plist.
 */
export const LOCAL_SAFE_CHECKS: readonly WatchdogCheck[] = WATCHDOG_CHECKS.filter(
  (c): c is WatchdogCheck => !HUB_ONLY_CHECKS.includes(c),
);

// ---------------------------------------------------------------------------
// Schedule lanes
// ---------------------------------------------------------------------------

/** A BOT ERRORS observer lane provisioned by platform installers. */
export interface ScheduleLane {
  /** Canonical lane name (matches launchd label suffix and systemd unit stem). */
  readonly name: string;
  /** Run cadence in seconds. 0 = continuous (RunAtLoad, no timer). */
  readonly cadenceSeconds: number;
  /** Linux systemd unit that provisions this lane. */
  readonly linuxUnit: string;
  /** macOS launchd label suffix (appended to `BOT_ERRORS_LABEL_PREFIX`). */
  readonly macosLabel: string;
}

/**
 * BOT ERRORS observer lanes. Every supported platform installer must provision
 * every lane listed here. Installer parity tests iterate this array.
 */
export const SCHEDULE_LANES: readonly ScheduleLane[] = [
  {
    name: 'dispatcher',
    cadenceSeconds: 0,
    linuxUnit: 'bot-errors-dispatcher.service',
    macosLabel: 'dispatcher',
  },
  {
    name: 'deadman',
    cadenceSeconds: 300,
    linuxUnit: 'bot-errors-deadman.timer',
    macosLabel: 'deadman',
  },
  {
    name: 'health',
    cadenceSeconds: 86_400,
    linuxUnit: 'bot-errors-health-check.timer',
    macosLabel: 'health',
  },
  {
    name: 'heartbeat-watchdog',
    cadenceSeconds: 300,
    linuxUnit: 'bot-errors-heartbeat-watchdog.timer',
    macosLabel: 'heartbeat-watchdog',
  },
];

/** Lane names that every supported platform must provision. */
export const REQUIRED_LANE_NAMES: readonly string[] = SCHEDULE_LANES.map((l) => l.name);

// ---------------------------------------------------------------------------
// Role-appropriate defaults
// ---------------------------------------------------------------------------

/**
 * Default watchdog checks for a local macOS role.
 * Uses the local-safe subset so hub-only checks do not create false incidents.
 */
export const MACOS_LOCAL_DEFAULT_CHECKS: readonly string[] = LOCAL_SAFE_CHECKS;

/**
 * Comma-joined string form of {@link MACOS_LOCAL_DEFAULT_CHECKS}, suitable for
 * the `BOT_ERRORS_WATCHDOG_CHECKS` environment variable in rendered plists.
 */
export const MACOS_LOCAL_DEFAULT_CHECKS_STRING: string = MACOS_LOCAL_DEFAULT_CHECKS.join(',');

// ---------------------------------------------------------------------------
// Independent observer relationships (criterion 6)
// ---------------------------------------------------------------------------

/**
 * Declares which lane independently observes another lane's receipts. An
 * independent observer detects a stopped/failed/stale job WITHOUT relying on
 * the job itself to self-report — the observer checks the job's receipt file
 * freshness from a separate process.
 *
 * Key invariant: a lane MUST NOT observe itself. The observer must be a
 * different lane with its own schedule.
 */
export interface ObserverRelationship {
  /** The lane being observed (must exist in SCHEDULE_LANES). */
  readonly observed: string;
  /** The independent lane that checks the observed lane's receipts. */
  readonly observer: string;
}

/**
 * Canonical observer relationships. The deadman lane independently checks the
 * heartbeat-watchdog's receipts because the deadman runs on a different schedule
 * and from a separate process — a watchdog that fails silently is caught by the
 * deadman's stale-receipt detection, not by the watchdog itself (#2466 criterion 6).
 */
export const OBSERVER_RELATIONSHIPS: readonly ObserverRelationship[] = [
  { observed: 'heartbeat-watchdog', observer: 'deadman' },
];

// ---------------------------------------------------------------------------
// Runtime readback validation (criterion 5)
// ---------------------------------------------------------------------------

/**
 * Result of validating a watchdog runtime receipt. File presence alone is
 * insufficient — the receipt must prove the job loaded, executed the expected
 * check set recently, and produced valid structured output.
 */
export interface WatchdogReceiptVerdict {
  /** True only when every check below passes. */
  readonly valid: boolean;
  /** Human-readable reasons for any failure (empty when valid). */
  readonly reasons: readonly string[];
}

/** Maximum age (ms) of a receipt before it's considered stale. Matches the 5-min cadence × 2 grace. */
export const WATCHDOG_RECEIPT_MAX_AGE_MS = 600_000; // 10 minutes

/**
 * Validate a heartbeat-watchdog runtime receipt (criterion 5).
 *
 * The receipt is the `heartbeat-watchdog-state.json` file written by the Python
 * watchdog on each execution. This function checks:
 * 1. The receipt has a `schemaVersion` field (proves structured output).
 * 2. The receipt has a `lastRunAt` timestamp within the freshness window.
 * 3. The receipt records which checks were executed and they match the
 *    expected set (or a declared subset for non-hub roles).
 *
 * @param receipt - Parsed JSON contents of the state file.
 * @param expectedChecks - The check set the job should have run (role-dependent).
 * @param now - Current time (epoch ms); defaults to Date.now() for production,
 *   injectable for deterministic tests.
 */
export function verifyWatchdogReceipt(
  receipt: unknown,
  expectedChecks: readonly string[],
  now: number = Date.now(),
): WatchdogReceiptVerdict {
  const reasons: string[] = [];

  if (typeof receipt !== 'object' || receipt === null) {
    return { valid: false, reasons: ['receipt is not an object'] };
  }

  const r = receipt as Record<string, unknown>;

  // 1. Schema version must be present and numeric.
  if (typeof r.schemaVersion !== 'number') {
    reasons.push('receipt missing numeric schemaVersion');
  }

  // 2. lastRunAt must be a valid timestamp within the freshness window.
  if (typeof r.lastRunAt !== 'number' || !Number.isFinite(r.lastRunAt)) {
    reasons.push('receipt missing numeric lastRunAt');
  } else {
    const age = now - r.lastRunAt;
    if (age < 0) {
      reasons.push('receipt lastRunAt is in the future');
    } else if (age > WATCHDOG_RECEIPT_MAX_AGE_MS) {
      reasons.push(`receipt is stale (age=${Math.round(age / 1000)}s, max=${WATCHDOG_RECEIPT_MAX_AGE_MS / 1000}s)`);
    }
  }

  // 3. The executed checks must match the expected set.
  const executedChecks = r.executedChecks;
  if (!Array.isArray(executedChecks)) {
    reasons.push('receipt missing executedChecks array');
  } else {
    const executed = new Set(executedChecks.filter((c): c is string => typeof c === 'string'));
    const expected = new Set(expectedChecks);
    // Every expected check must appear in the executed set.
    for (const check of expectedChecks) {
      if (!executed.has(check)) {
        reasons.push(`receipt missing expected check: ${check}`);
      }
    }
    // Warn on unexpected checks not in the known registry (but don't fail —
    // a newer watchdog version may have added checks not yet in the TS matrix).
    const known = new Set<string>(WATCHDOG_CHECKS);
    for (const check of executed) {
      if (!expected.has(check) && !known.has(check)) {
        reasons.push(`receipt has unknown check: ${check}`);
      }
    }
  }

  return { valid: reasons.length === 0, reasons };
}
