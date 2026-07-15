const EXECUTION_PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface OpenCodeExecutionProfileConfig {
  executionProfile?: unknown;
  baseUrl?: unknown;
  [key: string]: unknown;
}

export function isSafeOpenCodeExecutionProfile(value: unknown): value is string {
  return typeof value === 'string' && EXECUTION_PROFILE_RE.test(value);
}

export function resolveOpenCodeExecutionProfile(config: OpenCodeExecutionProfileConfig): string {
  if (!isSafeOpenCodeExecutionProfile(config.executionProfile)) {
    throw new Error(
      'providerConfig.executionProfile must be a non-empty OpenCode agent name containing only letters, digits, dot, underscore, or hyphen',
    );
  }
  return config.executionProfile;
}

/**
 * Return the explicit OpenCode agent selector when the source config has opted
 * into the hardened lane. An absent field remains report-only during the first
 * source rollout; malformed configured values fail closed.
 */
export function openCodeAgentArgs(config: OpenCodeExecutionProfileConfig | undefined): string[] {
  if (config?.executionProfile === undefined) return [];
  return ['--agent', resolveOpenCodeExecutionProfile(config)];
}

export function opencodeUsesConfigModel(config: OpenCodeExecutionProfileConfig | undefined): boolean {
  const baseUrl = config?.baseUrl;
  return typeof baseUrl === 'string' && baseUrl.trim() !== '';
}

export interface OpenCodeRunArgsOptions {
  providerConfig?: OpenCodeExecutionProfileConfig;
  sessionId?: string;
  model?: string;
  prompt?: string;
}

/** Pure argv seam shared by operational turns and model-usability probes. */
export function buildOpenCodeRunArgs(options: OpenCodeRunArgsOptions): string[] {
  return [
    'run',
    '--format', 'json',
    '--pure',
    ...openCodeAgentArgs(options.providerConfig),
    ...(options.sessionId ? ['--session', options.sessionId] : []),
    ...(options.model && !opencodeUsesConfigModel(options.providerConfig)
      ? ['-m', options.model]
      : []),
    ...(options.prompt === undefined ? [] : [options.prompt]),
  ];
}
