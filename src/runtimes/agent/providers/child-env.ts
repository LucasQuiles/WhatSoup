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
   * Suppress all provider credential resolution for non-inference probes.
   * Production sessions omit this option and retain existing credential
   * behavior.
   */
  providerCredentials?: 'include' | 'omit';
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
  // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
  return process.env[FAILCLOSED_FLAG] === '1';
}

function isConfigRootIsolationEnabled(): boolean {
  // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
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
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      ? process.env.ALLOW_M365_MUTATIONS
      : undefined
    // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
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
      // env-allowed: ambient OS PATH contract for executable resolution
      PATH: process.env.PATH,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      HOME: configRoots?.home ?? process.env.HOME,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      USER: process.env.USER,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      SHELL: process.env.SHELL,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      LANG: process.env.LANG,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      TERM: process.env.TERM,
      // Node.js
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      NODE_PATH: process.env.NODE_PATH,
      // XDG dirs (Linux)
      // env-allowed: ambient OS contract (XDG dirs); absence handling load-bearing
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      // env-allowed: ambient OS contract (XDG dirs); absence handling load-bearing
      XDG_CONFIG_HOME: configRoots?.xdgConfig ?? process.env.XDG_CONFIG_HOME,
      // env-allowed: ambient OS contract (XDG dirs); absence handling load-bearing
      XDG_DATA_HOME: configRoots?.xdgData ?? process.env.XDG_DATA_HOME,
      // env-allowed: TMPDIR publish-back pattern; config writes it at load, env is the lib-side channel
      TMPDIR: process.env.TMPDIR,
      // claude config dir. Forward-if-set only (undefined is stripped below), so
      // hosts that don't set it see zero change. Required on launchd-managed
      // macOS hosts where the agent OAuth credential item in the login keychain
      // is unreadable in the non-GUI context: pointing CLAUDE_CONFIG_DIR at the
      // dir holding `.credentials.json` (`$HOME/.claude`) lets the spawned cli
      // read the file-based OAuth creds instead of 401-ing. Without this
      // forward, a per-instance plist setting never reaches the child env (this
      // builder is an explicit allow-list, not a process.env passthrough).
      // env-allowed: external-tool interop; must track the env the spawned claude CLI sees
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      // Per-instance overrides can set ALLOW_M365_MUTATIONS=1 to bypass
      // external M365 read-only hooks; most instances do not set it and
      // remain read-only.
      //
      // When WHATSOUP_CONNECTOR_FAILCLOSED=1 (opt-in, #411) the value is
      // suppressed unless agentOptions.allowM365Mutations === true.
      ALLOW_M365_MUTATIONS: allowM365,
      // Sudo support
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      SUDO_ASKPASS: process.env.SUDO_ASKPASS,
      // Tokenomics pilot controls: forward only operator-provided values.
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      TOKENOMICS_BOT: process.env.TOKENOMICS_BOT,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      BASH_MAX_OUTPUT_LENGTH: process.env.BASH_MAX_OUTPUT_LENGTH,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      MAX_MCP_OUTPUT_TOKENS: process.env.MAX_MCP_OUTPUT_TOKENS,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: process.env.CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
      // Reply Guarantee Protocol hook context. These are explicit instance
      // fields, not inherited parent env, so child sessions only see the socket
      // they are meant to use.
      WHATSOUP_INSTANCE: opts?.whatsoupInstance,
      WHATSOUP_MCP_SOCKET: opts?.whatsoupMcpSocket,
      // Egress proxy (#1607): only present when a caller supplies a positive
      // egressProxyPort — instances that haven't opted into the allowlist
      // see zero change. Both UPPER and lower case variants are set (F4):
      // curl (post-httpoxy hardening) reads lowercase `http_proxy` for plain
      // HTTP and ignores the uppercase form, so `curl http://host` would
      // otherwise bypass the proxy entirely — no adjudication, no log.
      HTTP_PROXY: egressProxyUrl,
      HTTPS_PROXY: egressProxyUrl,
      NO_PROXY: egressProxyPort !== undefined ? 'localhost,127.0.0.1' : undefined,
      http_proxy: egressProxyUrl,
      https_proxy: egressProxyUrl,
      no_proxy: egressProxyPort !== undefined ? 'localhost,127.0.0.1' : undefined,
    }).filter(([, v]) => v !== undefined),
  ) as NodeJS.ProcessEnv;
}

/**
 * Minimal non-secret environment for an OpenCode headless child. This is a
 * separate positive allowlist: Claude-specific auth, privilege, connector,
 * mutation, and tuning variables never enter the object.
 */
export function buildOpenCodeBaseChildEnv(opts?: BuildBaseChildEnvOptions): NodeJS.ProcessEnv {
  const configRoots = childConfigRoots(opts);
  const egressProxyPort =
    typeof opts?.egressProxyPort === 'number' && opts.egressProxyPort > 0
      ? opts.egressProxyPort
      : undefined;
  const egressProxyUrl =
    egressProxyPort !== undefined ? `http://127.0.0.1:${egressProxyPort}` : undefined;

  return Object.fromEntries(
    Object.entries({
      // env-allowed: ambient OS PATH contract for executable resolution
      PATH: process.env.PATH,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      HOME: configRoots?.home ?? process.env.HOME,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      USER: process.env.USER,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      SHELL: process.env.SHELL,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      LANG: process.env.LANG,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      TERM: process.env.TERM,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      NODE_PATH: process.env.NODE_PATH,
      // env-allowed: ambient OS contract (XDG dirs); absence handling load-bearing
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      // env-allowed: ambient OS contract (XDG dirs); absence handling load-bearing
      XDG_CONFIG_HOME: configRoots?.xdgConfig ?? process.env.XDG_CONFIG_HOME,
      // env-allowed: ambient OS contract (XDG dirs); absence handling load-bearing
      XDG_DATA_HOME: configRoots?.xdgData ?? process.env.XDG_DATA_HOME,
      // env-allowed: TMPDIR publish-back pattern; config writes it at load, env is the lib-side channel
      TMPDIR: process.env.TMPDIR,
      WHATSOUP_INSTANCE: opts?.whatsoupInstance,
      WHATSOUP_MCP_SOCKET: opts?.whatsoupMcpSocket,
      // Egress proxy (#1607): threaded exactly as buildBaseChildEnv does so an
      // opted-in instance's OpenCode children route outbound HTTP(S) through the
      // allowlist proxy rather than escaping it. Both UPPER and lower case
      // variants are set (F4): curl reads lowercase `http_proxy` for plain HTTP
      // and ignores the uppercase form, so a `curl http://host` would otherwise
      // bypass the proxy entirely. Only present when a positive port is supplied
      // — undefined values are filtered out, preserving the unproxied default.
      HTTP_PROXY: egressProxyUrl,
      HTTPS_PROXY: egressProxyUrl,
      NO_PROXY: egressProxyPort !== undefined ? 'localhost,127.0.0.1' : undefined,
      http_proxy: egressProxyUrl,
      https_proxy: egressProxyUrl,
      no_proxy: egressProxyPort !== undefined ? 'localhost,127.0.0.1' : undefined,
    }).filter(([, value]) => value !== undefined),
  ) as NodeJS.ProcessEnv;
}
