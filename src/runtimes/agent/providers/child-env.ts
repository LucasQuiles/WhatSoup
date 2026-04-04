// src/runtimes/agent/providers/child-env.ts
// Shared base environment builder for provider child processes.

/**
 * Build the base environment for child processes — system essentials only.
 * Provider-specific vars (API keys, passwords, etc.) are added by callers.
 *
 * Undefined values are stripped so callers don't need to repeat that logic.
 */
export function buildBaseChildEnv(): NodeJS.ProcessEnv {
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
      // Sudo support
      SUDO_ASKPASS: process.env.SUDO_ASKPASS,
    }).filter(([, v]) => v !== undefined),
  ) as NodeJS.ProcessEnv;
}
