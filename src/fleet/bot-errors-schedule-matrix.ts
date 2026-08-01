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
