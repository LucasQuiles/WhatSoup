/**
 * Typed render input for generated macOS launchd instance plists.
 *
 * The low-level renderer (`buildPlist` in src/fleet/platform.ts) must stay a
 * pure function of its arguments: it never reads instance config.json itself.
 * Callers obtain a validated `LaunchdPlistRenderOptions` from the
 * instance-specific resolver (src/fleet/launchd-render-options.ts) and pass it
 * down. This module is dependency-light (Node builtins only) so both the core
 * instance-config validator and the fleet render path can share one source of
 * truth for the shape rules.
 */

export interface LaunchdPlistRenderOptions {
  /**
   * Absolute path of a dedicated claude-cli config root. When set, the
   * generated plist exports it as `CLAUDE_CONFIG_DIR` in
   * `EnvironmentVariables`, so the service context resolves the same isolated
   * config surface as interactive use of that root.
   */
  claudeConfigDir?: string;
  /**
   * Absolute directories prepended, in order, ahead of the generating shell's
   * ambient PATH in the rendered service PATH. Owns what used to be hand-patched
   * plist PATH edits (e.g. prepending `~/.local/bin` so a fallback provider
   * binary resolves in the launchd context).
   */
  pathPrepend?: readonly string[];
}
