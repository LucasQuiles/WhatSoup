import {
  isWhatSoupHeadlessExecutionProfile,
  WHATSOUP_HEADLESS_EXECUTION_PROFILE,
} from '../../../lib/opencode-execution-profile-contract.ts';
import { isNonEmptyString } from '../../../lib/type-guards.ts';

export { WHATSOUP_HEADLESS_EXECUTION_PROFILE };

export interface OpenCodeExecutionProfileConfig {
  executionProfile?: unknown;
  baseUrl?: unknown;
  [key: string]: unknown;
}

export function isSafeOpenCodeExecutionProfile(
  value: unknown,
): value is typeof WHATSOUP_HEADLESS_EXECUTION_PROFILE {
  return isWhatSoupHeadlessExecutionProfile(value);
}

export function resolveOpenCodeExecutionProfile(config: OpenCodeExecutionProfileConfig): string {
  if (!isSafeOpenCodeExecutionProfile(config.executionProfile)) {
    throw new Error(
      `providerConfig.executionProfile must be exactly "${WHATSOUP_HEADLESS_EXECUTION_PROFILE}" when configured`,
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
  return isNonEmptyString(config?.baseUrl);
}

export interface OpenCodeRunArgsOptions {
  providerConfig?: OpenCodeExecutionProfileConfig;
  sessionId?: string;
  model?: string;
  prompt?: string;
  progressLogs?: boolean;
}

/** Pure argv seam shared by operational turns and model-usability probes. */
export function buildOpenCodeRunArgs(options: OpenCodeRunArgsOptions): string[] {
  return [
    'run',
    '--format', 'json',
    '--pure',
    ...(options.progressLogs ? ['--print-logs', '--log-level', 'INFO'] : []),
    ...openCodeAgentArgs(options.providerConfig),
    ...(options.sessionId ? ['--session', options.sessionId] : []),
    ...(options.model && !opencodeUsesConfigModel(options.providerConfig)
      ? ['-m', options.model]
      : []),
    ...(options.prompt === undefined ? [] : [options.prompt]),
  ];
}
