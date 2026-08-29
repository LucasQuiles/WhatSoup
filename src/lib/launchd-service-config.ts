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

/**
 * Validation error shape compatible with agent-config-validator's
 * ValidationError (field + message; the caller supplies status).
 */
export interface ServiceConfigError {
  field: string;
  message: string;
}

/**
 * Marker class for render-config failures whose messages are safe to print
 * verbatim to an operator: validation-rule text and content-free resolver
 * failures (never config.json content, parser source windows, or paths).
 */
export class LaunchdRenderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchdRenderConfigError';
  }
}

const MAX_PATH_PREPEND_ENTRIES = 16;
/** PATH_MAX-class bound for one rendered path value. */
const MAX_PATH_VALUE_LENGTH = 4096;

/** Rendered plist values are single-line paths; reject C0 controls and DEL. */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isCleanAbsolutePath(value: string): boolean {
  return value !== ''
    && value.length <= MAX_PATH_VALUE_LENGTH
    && value === value.trim()
    && value.startsWith('/')
    && !hasControlChars(value);
}

/**
 * Validate the optional top-level `service` block of an instance config.
 * Returns the first error, or null when the block is absent or valid.
 * Unknown keys inside the block are ignored, matching the instance-config
 * validator's permissive convention for extraneous keys.
 */
export function validateLaunchdServiceConfig(
  raw: Record<string, unknown>,
): ServiceConfigError | null {
  const service = raw['service'];
  if (service === undefined || service === null) return null;
  if (typeof service !== 'object' || Array.isArray(service)) {
    return { field: 'service', message: 'service must be an object when provided' };
  }
  const block = service as Record<string, unknown>;

  const claudeConfigDir = block['claudeConfigDir'];
  if (claudeConfigDir !== undefined) {
    if (typeof claudeConfigDir !== 'string' || !isCleanAbsolutePath(claudeConfigDir)) {
      return {
        field: 'service.claudeConfigDir',
        message: `service.claudeConfigDir must be an absolute path of at most ${MAX_PATH_VALUE_LENGTH} characters with no surrounding whitespace or control characters`,
      };
    }
  }

  const pathPrepend = block['pathPrepend'];
  if (pathPrepend !== undefined) {
    if (!Array.isArray(pathPrepend)) {
      return {
        field: 'service.pathPrepend',
        message: 'service.pathPrepend must be an array of absolute directory paths',
      };
    }
    if (pathPrepend.length > MAX_PATH_PREPEND_ENTRIES) {
      return {
        field: 'service.pathPrepend',
        message: `service.pathPrepend may contain at most ${MAX_PATH_PREPEND_ENTRIES} entries`,
      };
    }
    for (let i = 0; i < pathPrepend.length; i++) {
      const entry = pathPrepend[i];
      if (typeof entry !== 'string' || !isCleanAbsolutePath(entry) || entry.includes(':')) {
        return {
          field: `service.pathPrepend[${i}]`,
          message: `service.pathPrepend[${i}] must be an absolute directory path of at most ${MAX_PATH_VALUE_LENGTH} characters without ':' or control characters`,
        };
      }
    }
  }

  return null;
}

/**
 * Assert caller-supplied render options obey the same shape rules as the
 * config `service` block, so every render admission path shares one source
 * of truth for absolute-path validation.
 */
export function assertValidLaunchdPlistRenderOptions(
  options: LaunchdPlistRenderOptions,
): void {
  const error = validateLaunchdServiceConfig({ service: { ...options } });
  if (error) throw new LaunchdRenderConfigError(error.message);
}

/**
 * Extract the typed launchd render options from a parsed instance config.
 * Throws on an invalid `service` block; returns {} when the block is absent.
 */
export function extractLaunchdPlistRenderOptions(
  raw: Record<string, unknown>,
): LaunchdPlistRenderOptions {
  const error = validateLaunchdServiceConfig(raw);
  if (error) throw new LaunchdRenderConfigError(error.message);
  const service = raw['service'];
  if (service === undefined || service === null) return {};
  const block = service as Record<string, unknown>;
  return {
    ...(typeof block['claudeConfigDir'] === 'string'
      ? { claudeConfigDir: block['claudeConfigDir'] }
      : {}),
    ...(Array.isArray(block['pathPrepend'])
      ? { pathPrepend: block['pathPrepend'] as string[] }
      : {}),
  };
}
