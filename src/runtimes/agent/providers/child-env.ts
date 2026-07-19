// src/runtimes/agent/providers/child-env.ts
// Shared base environment builder for provider child processes.

import { join } from 'node:path';

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

/**
 * Opt-in env flag for generated-workspace config-root isolation. When set to
 * `"1"` and a caller supplies `configRoot`, child HOME/XDG config roots are
 * rewritten under that root. Unset or any other value preserves current
 * parent HOME/XDG forwarding behavior.
 */
export const CONFIG_ROOT_ISOLATION_FLAG = 'WHATSOUP_AGENT_CONFIG_ROOT_ISOLATION';

/** Per-call options for `buildBaseChildEnv`. Optional for back-compat. */
export interface BuildBaseChildEnvOptions {
  /**
   * Per-instance opt-in for `ALLOW_M365_MUTATIONS` propagation. Only
   * consulted when the `WHATSOUP_CONNECTOR_FAILCLOSED=1` env flag is
   * set; otherwise the existing unconditional propagation path runs and
   * this field is ignored. See `docs/configuration.md` (#411).
   */
  allowM365Mutations?: boolean;
  whatsoupInstance?: string;
  whatsoupMcpSocket?: string;
  configRoot?: string;
  /**
   * Egress proxy port (#1607). When set to a positive port number,
   * `buildBaseChildEnv` injects `HTTP_PROXY`/`HTTPS_PROXY` pointed at
   * `http://127.0.0.1:<port>` plus `NO_PROXY=localhost,127.0.0.1` so the
   * child process's outbound HTTP(S) traffic routes through the local
   * egress-allowlist proxy (see `./egress-proxy.ts`). Unset, undefined, or
   * a non-positive value: none of the three vars are added — today's
   * unproxied behavior for instances that have not opted into the
   * allowlist.
   */
  egressProxyPort?: number;
}

function isFailClosedEnabled(): boolean {
  return process.env[FAILCLOSED_FLAG] === '1';
}

function isConfigRootIsolationEnabled(): boolean {
  return process.env[CONFIG_ROOT_ISOLATION_FLAG] === '1';
}

function childConfigRoots(opts?: BuildBaseChildEnvOptions): {
  home: string;
  xdgConfig: string;
  xdgData: string;
} | undefined {
  if (!opts?.configRoot || !isConfigRootIsolationEnabled()) return undefined;
  return {
    home: opts.configRoot,
    xdgConfig: join(opts.configRoot, '.config'),
    xdgData: join(opts.configRoot, '.local', 'share'),
  };
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
  const configRoots = childConfigRoots(opts);
  const egressProxyPort =
    typeof opts?.egressProxyPort === 'number' && opts.egressProxyPort > 0
      ? opts.egressProxyPort
      : undefined;
  const egressProxyUrl =
    egressProxyPort !== undefined ? `http://127.0.0.1:${egressProxyPort}` : undefined;

  return Object.fromEntries(
    Object.entries({
      // System essentials
      PATH: process.env.PATH,
      HOME: configRoots?.home ?? process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL,
      LANG: process.env.LANG,
      TERM: process.env.TERM,
      // Node.js
      NODE_PATH: process.env.NODE_PATH,
      // XDG dirs (Linux)
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      XDG_CONFIG_HOME: configRoots?.xdgConfig ?? process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: configRoots?.xdgData ?? process.env.XDG_DATA_HOME,
      TMPDIR: process.env.TMPDIR,
      // claude config dir. Forward-if-set only (undefined is stripped below), so
      // hosts that don't set it see zero change. Required on launchd-managed
      // macOS hosts where the agent OAuth credential item in the login keychain
      // is unreadable in the non-GUI context: pointing CLAUDE_CONFIG_DIR at the
      // dir holding `.credentials.json` (`$HOME/.claude`) lets the spawned cli
      // read the file-based OAuth creds instead of 401-ing. Without this
      // forward, a per-instance plist setting never reaches the child env (this
      // builder is an explicit allow-list, not a process.env passthrough).
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      // Per-instance overrides can set ALLOW_M365_MUTATIONS=1 to bypass
      // external M365 read-only hooks; most instances do not set it and
      // remain read-only.
      //
      // When WHATSOUP_CONNECTOR_FAILCLOSED=1 (opt-in, #411) the value is
      // suppressed unless agentOptions.allowM365Mutations === true.
      ALLOW_M365_MUTATIONS: allowM365,
      // Sudo support
      SUDO_ASKPASS: process.env.SUDO_ASKPASS,
      // Tokenomics pilot controls: forward only operator-provided values.
      ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH,
      TOKENOMICS_BOT: process.env.TOKENOMICS_BOT,
      BASH_MAX_OUTPUT_LENGTH: process.env.BASH_MAX_OUTPUT_LENGTH,
      MAX_MCP_OUTPUT_TOKENS: process.env.MAX_MCP_OUTPUT_TOKENS,
      CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS,
      CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: process.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT,
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
      // Reply Guarantee Protocol hook context. These are explicit instance
      // fields, not inherited parent env, so child sessions only see the socket
      // they are meant to use.
      WHATSOUP_INSTANCE: opts?.whatsoupInstance,
      WHATSOUP_MCP_SOCKET: opts?.whatsoupMcpSocket,
      // Egress proxy (#1607): only present when a caller supplies a positive
      // egressProxyPort — instances that haven't opted into the allowlist
      // see zero change.
      HTTP_PROXY: egressProxyUrl,
      HTTPS_PROXY: egressProxyUrl,
      NO_PROXY: egressProxyPort !== undefined ? 'localhost,127.0.0.1' : undefined,
    }).filter(([, v]) => v !== undefined),
  ) as NodeJS.ProcessEnv;
}
