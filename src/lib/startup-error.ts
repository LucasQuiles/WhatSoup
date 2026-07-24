/**
 * Startup config-validation error marker.
 *
 * A `ConfigValidationError` is a **permanent** startup fault: the instance config
 * is malformed or a config field is invalid, so restarting hits the identical
 * error immediately. The bootstrap entrypoint (`src/bootstrap.ts`) classifies it
 * to exit code {@link EX_CONFIG} (78) via `startupExitCode`, which trips systemd's
 * `RestartPreventExitStatus=78` and stops the restart-flap.
 *
 * This is a distinct, positively-identifiable type — NOT a bare `Error` — precisely
 * so the exit-code classifier can tell "the config is wrong" (permanent → stop
 * restarting) apart from a transient startup failure (disk full, a mkdir race →
 * keep restarting). Throw it ONLY at genuine config-validation sites; never relabel
 * a transient I/O failure as a `ConfigValidationError`, or a recoverable service
 * would be wrongly halted.
 *
 * The marker must survive un-wrapped from the throw site — through the dynamic
 * main-module import rejection — up to `bootstrap().catch`, or the `instanceof`
 * classification breaks and the process silently falls back to exit 1.
 * `bootstrap-common.ts` performs no try/catch, so the type propagates intact.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/** True when `err` is a permanent config-validation failure (→ exit EX_CONFIG). */
export function isConfigValidationError(err: unknown): err is ConfigValidationError {
  return err instanceof ConfigValidationError;
}
