// CONSTRAINT: Only Node built-ins + fleet/paths.ts. No config.ts, no logger.ts.
// Exports: loadInstance(name: string): void

import * as fs from 'node:fs';
import * as path from 'node:path';
import { configRoot as fleetConfigRoot, instancePaths, type InstancePaths } from './fleet/paths.ts';
import {
  validateInstanceConfig,
  VALID_TYPES as _VALID_TYPES,
  VALID_ACCESS_MODES as _VALID_ACCESS_MODES,
  VALID_SESSION_SCOPES as _VALID_SESSION_SCOPES,
  VALID_GROUP_SENDER_POLICIES as _VALID_GROUP_SENDER_POLICIES,
  type AccessMode,
  type GroupSenderPolicy,
} from './core/agent-config-validator.ts';
import type { TransportId } from './transport/registry.ts';
import type { TwilioSmsConfig } from './transport/twilio/types.ts';
import type { SignalConfig } from './transport/signal/types.ts';
import { errorMessage } from './lib/error-message.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstanceType = 'chat' | 'agent' | 'passive';
export type SessionScope = 'single' | 'shared' | 'per_chat';
export type { AccessMode, GroupSenderPolicy };

// Canonical enum sets live in the shared validator; re-export for back-compat.
export const VALID_TYPES = _VALID_TYPES;
export const VALID_ACCESS_MODES = _VALID_ACCESS_MODES;
export const VALID_SESSION_SCOPES = _VALID_SESSION_SCOPES;
export const VALID_GROUP_SENDER_POLICIES = _VALID_GROUP_SENDER_POLICIES;

interface AgentOptionsSandbox {
  allowedPaths?: unknown;
  allowedTools?: unknown;
  allowedMcpTools?: unknown;
  bash?: unknown;
  /** Opt-in egress allowlist (#1607); passthrough only — see runtime.ts SandboxPolicy. */
  allowedEgress?: unknown;
}

interface AgentOptions {
  sessionScope: SessionScope;
  cwd: string;
  /**
   * Agent-scoped model override. Highest-precedence input to
   * resolveAgentModel (before top-level `model` and `models.conversation`);
   * passed to the provider CLI as `--model` at spawn.
   */
  model?: string;
  instructionsPath?: string;
  sandbox?: AgentOptionsSandbox;
  mcp?: unknown;
  perUserDirs?: unknown;
  sandboxPerChat?: boolean;
  perChatConversationBound?: boolean;
  enabledPlugins?: Record<string, boolean>;
  autoCompactInputTokens?: number;
  /** Provider identifier — maps to the registry. Defaults to 'claude-cli'. */
  provider?: string;
  /** Provider-specific configuration overrides. */
  providerConfig?: Record<string, unknown>;
  /**
   * Opt-in per-instance allowlist for the `ALLOW_M365_MUTATIONS` env var
   * (#411). Only consulted when the `WHATSOUP_CONNECTOR_FAILCLOSED=1`
   * env flag is set on the parent process; otherwise unconditional
   * propagation runs and this field has no effect. See
   * `docs/configuration.md` for the migration plan.
   */
  allowM365Mutations?: boolean;
}

interface InstanceConfig {
  name: string;
  type: InstanceType;
  systemPrompt?: string;
  adminPhones: string[];
  accessMode: AccessMode;
  /** R5: per-sender group response policy. Defaults to 'any_member' (current behavior). */
  groupSenderPolicy?: GroupSenderPolicy;
  /** Set to false to hide this instance from fleet discovery (no polling, no routing).
   * Defaults to true. Useful for keeping a config on disk while taking it out of rotation. */
  enabled?: boolean;
  // Optional fields
  model?: string;
  models?: Record<string, string>;
  memory?: Record<string, unknown>;
  chatAliases?: Record<string, string>;
  pineconeIndex?: string;
  pineconeAllowedIndexes?: string[];
  maxTokens?: number;
  tokenBudget?: number;
  /** Summarize-before-trim gate (#1445 QR-010). Default true. See docs/configuration.md. */
  workingMemorySummarization?: boolean;
  rateLimitPerHour?: number;
  healthPort?: number;
  gui?: boolean;
  guiPort?: number;
  agentOptions?: AgentOptions;
  // Transport selection — defaults to 'baileys' when absent
  transport?: TransportId;
  // Twilio SMS transport config — present only when transport === 'twilio'
  twilioConfig?: TwilioSmsConfig;
  // Signal transport config — present only when transport === 'signal'
  signalConfig?: SignalConfig;
  // Resolved paths (added by loader)
  paths: InstancePaths;
}

function pinProcessTmpDir(paths: InstancePaths): void {
  fs.mkdirSync(paths.tmpDir, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = paths.tmpDir;
}

// Agent-model resolution moved to core/agent-model.ts so the shared validator
// can use it without a circular import; re-exported here for existing callers.
export { resolveAgentModel } from './core/agent-model.ts';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateInstance(raw: Record<string, unknown>, name: string, authOnly = false): void {
  // Defense-in-depth: the same shared validator runs here, on PATCH, and on
  // CREATE. Drift between sites (#244, #249) is what bricks instances.
  const error = validateInstanceConfig(raw, {
    name,
    mode: 'load',
    authOnly,
  });
  if (error) {
    throw new Error(error.message);
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function loadInstance(name: string, opts?: { authOnly?: boolean }): void {
  if (!name) {
    throw new Error('Instance name is required');
  }

  const instanceFile = path.join(fleetConfigRoot(), name, 'config.json');

  // 2. Read file (throws ENOENT if missing)
  let raw: string;
  try {
    raw = fs.readFileSync(instanceFile, 'utf8');
  } catch (err: unknown) {
    const message = errorMessage(err);
    throw new Error(`Failed to read instance file at ${instanceFile}: ${message}`);
  }

  // 3. Parse JSON (throws SyntaxError if invalid)
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    const message = errorMessage(err);
    throw new Error(`Failed to parse config.json for "${name}": ${message}`);
  }

  // 4. Validate
  validateInstance(parsed, name, opts?.authOnly);

  // 5. Resolve paths
  const paths = instancePaths(name);
  pinProcessTmpDir(paths);

  // 6. Build config — cast through unknown since validateInstance already
  // verified the required fields; TS cannot narrow from Record<string,unknown>
  const config = { ...parsed, paths } as InstanceConfig;

  // 7. Set env var
  process.env.INSTANCE_CONFIG = JSON.stringify(config);
}
