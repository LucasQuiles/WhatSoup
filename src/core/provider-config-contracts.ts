/**
 * Canonical, ordered list of supported agent provider IDs.
 *
 * This lives in core because loaders, validators, fleet routes, and runtime
 * switches all need the same protocol enum. Runtime-specific provider behavior
 * still lives under src/runtimes/agent/providers.
 */
export const PROVIDER_IDS = Object.freeze([
  'claude-cli',
  'codex-cli',
  'gemini-cli',
  'opencode-cli',
  'openai-api',
  'anthropic-api',
] as const);

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const DEFAULT_PROVIDER_ID: ProviderId = 'claude-cli';

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function assertNeverProvider(value: never, context: string): never {
  throw new Error(
    `[${context}] unknown provider id: ${JSON.stringify(value)}. ` +
      `Valid: ${PROVIDER_IDS.join(', ')}.`,
  );
}

export const OPENCODE_COMMAND_MODES = [
  'auto',
  'modern-run',
  'legacy-prompt-json',
] as const;

export type OpenCodeCommandMode = (typeof OPENCODE_COMMAND_MODES)[number];

export function isOpenCodeCommandMode(value: unknown): value is OpenCodeCommandMode {
  return typeof value === 'string' && (OPENCODE_COMMAND_MODES as readonly string[]).includes(value);
}

export function normalizeOpenCodeCommandMode(value: unknown): OpenCodeCommandMode {
  return isOpenCodeCommandMode(value) ? value : 'auto';
}

export function openCodeCommandModeValidationError(value: unknown): string | null {
  if (value === undefined) return null;
  if (isOpenCodeCommandMode(value)) return null;
  return `agentOptions.providerConfig.opencodeCommandMode must be one of: ${OPENCODE_COMMAND_MODES.join(', ')}`;
}
