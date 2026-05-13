// src/runtimes/agent/providers/child-env.ts
// Shared base environment builder for provider child processes.

/**
 * Opt-in env flag (#411). When set to `"1"`, `buildBaseChildEnv` drops
 * `ALLOW_M365_MUTATIONS` from the child env unless the per-instance
 * agentOptions explicitly opts in via `allowM365Mutations: true`.
 *
 * Unset or any other value: existing behavior — `ALLOW_M365_MUTATIONS` is
 * propagated unconditionally whenever it appears in the parent env. This
 * is the shipping default; current fleets see zero observable change.
 */
export const FAILCLOSED_FLAG = 'WHATSOUP_CONNECTOR_FAILCLOSED';

/** Per-call options for `buildBaseChildEnv`. Optional for back-compat. */
export interface BuildBaseChildEnvOptions {
  /**
   * Per-instance opt-in for `ALLOW_M365_MUTATIONS` propagation. Only
   * consulted when the `WHATSOUP_CONNECTOR_FAILCLOSED=1` env flag is
   * set; otherwise the existing unconditional propagation path runs and
   * this field is ignored. See `docs/configuration.md` (#411).
   */
  allowM365Mutations?: boolean;
}

function isFailClosedEnabled(): boolean {
  return process.env[FAILCLOSED_FLAG] === '1';
}

/**
 * Build the base environment for child processes — system essentials only.
 * Provider-specific vars (API keys, passwords, etc.) are added by callers.
 *
 * Undefined values are stripped so callers don't need to repeat that logic.
 *
 * When `WHATSOUP_CONNECTOR_FAILCLOSED=1` is set in the parent env, the
 * `ALLOW_M365_MUTATIONS` variable is only propagated when the per-instance
 * `opts.allowM365Mutations === true`. The flag defaults to unset and the
 * propagation behavior is unchanged for current fleets.
 */
export function buildBaseChildEnv(opts?: BuildBaseChildEnvOptions): NodeJS.ProcessEnv {
  const failClosed = isFailClosedEnabled();
  const allowM365 = failClosed
    ? opts?.allowM365Mutations === true
      ? process.env.ALLOW_M365_MUTATIONS
      : undefined
    : process.env.ALLOW_M365_MUTATIONS;

  return Object.fromEntries(
    Object.entries({
      // System essentials
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL,
      LANG: process.env.LANG,
      TERM: process.env.TERM,
      // Node.js
      NODE_PATH: process.env.NODE_PATH,
      // XDG dirs (Linux)
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      // Per-instance overrides (mw-bot has ALLOW_M365_MUTATIONS=1 in its
      // launchd plist to bypass the global claude-guards M365 read-only
      // hook; other instances do not set it and remain read-only).
      //
      // When WHATSOUP_CONNECTOR_FAILCLOSED=1 (opt-in, #411) the value is
      // suppressed unless agentOptions.allowM365Mutations === true.
      ALLOW_M365_MUTATIONS: allowM365,
      // Sudo support
      SUDO_ASKPASS: process.env.SUDO_ASKPASS,
    }).filter(([, v]) => v !== undefined),
  ) as NodeJS.ProcessEnv;
}
