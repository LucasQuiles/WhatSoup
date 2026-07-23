/**
 * Process exit-code vocabulary (sysexits.h subset) for service-manager restart control.
 *
 * When a fatal error occurs at startup, the process exit code tells the service
 * manager (systemd, launchd) whether to restart:
 *
 * - A **permanent** error (bad config, missing required field) recurs on every
 *   restart, so the manager must STOP restarting — otherwise the unit
 *   restart-flaps forever, burning CPU and masking the real fault.
 * - A **transient** error (disk full, port briefly in use, a node-install race)
 *   may clear, so the manager SHOULD restart.
 *
 * The linchpin constant here is {@link EX_CONFIG} (78). `deploy/whatsoup@.service`
 * declares `RestartPreventExitStatus=78`, so exiting **exactly 78** on a permanent
 * configuration error is what makes systemd stop restart-flapping. Any other
 * "permanent" sysexits code (e.g. EX_USAGE 64) is NOT in that prevent-list, so a
 * permanent startup error that should stop the flap must map to 78 specifically.
 *
 * Only a positively-identified permanent error should exit 78: misclassifying a
 * transient failure as permanent halts a recoverable service (an outage), which is
 * strictly worse than a flap. Unknown/ambiguous errors must keep the default
 * restart behavior (exit 1).
 *
 * Reference: sysexits.h (BSD), systemd.unit(5) `RestartPreventExitStatus`.
 *
 * Only `EX_CONFIG` is exported today because it is the only sysexits code with a
 * live consumer (the startup exit-code classifier). The broader sysexits table
 * (EX_USAGE, EX_TEMPFAIL, transient/permanent sets, `exitCodeName`) lands with the
 * bash-launcher-side flap fix, where those codes gain consumers.
 */

/**
 * Configuration error (sysexits `EX_CONFIG`). A fatal, non-recoverable startup
 * configuration fault — malformed instance config, an invalid config field, a
 * missing required setting. Mapped to systemd's `RestartPreventExitStatus=78` so
 * the service manager stops restarting into the same broken state.
 */
export const EX_CONFIG = 78;
