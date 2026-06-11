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
  type AccessMode,
} from './core/agent-config-validator.ts';
import type { TransportId } from './transport/registry.ts';
import type { TwilioSmsConfig } from './transport/twilio/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstanceType = 'chat' | 'agent' | 'passive';
export type SessionScope = 'single' | 'shared' | 'per_chat';
export type { AccessMode };

// Canonical enum sets live in the shared validator; re-export for back-compat.
export const VALID_TYPES = _VALID_TYPES;
export const VALID_ACCESS_MODES = _VALID_ACCESS_MODES;
export const VALID_SESSION_SCOPES = _VALID_SESSION_SCOPES;

interface AgentOptionsSandbox {
  allowedPaths?: unknown;
  allowedTools?: unknown;
  allowedMcpTools?: unknown;
  bash?: unknown;
}

interface AgentOptions {
  sessionScope: SessionScope;
  cwd: string;
  instructionsPath?: string;
  sandbox?: AgentOptionsSandbox;
  mcp?: unknown;
  perUserDirs?: unknown;
  sandboxPerChat?: boolean;
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
  rateLimitPerHour?: number;
  healthPort?: number;
  gui?: boolean;
  guiPort?: number;
  agentOptions?: AgentOptions;
  // Transport selection — defaults to 'baileys' when absent
  transport?: TransportId;
  // Twilio SMS transport config — present only when transport === 'twilio'
  twilioConfig?: TwilioSmsConfig;
  // Resolved paths (added by loader)
  paths: InstancePaths;
}

function pinProcessTmpDir(paths: InstancePaths): void {
  fs.mkdirSync(paths.tmpDir, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = paths.tmpDir;
}

/**
 * Resolve the agent subprocess model from an instance config. Prefers the
 * top-level `model`; falls back to `models.conversation` so per-role models
 * declared in the canonical models map propagate to the agent runtime even
 * when the top-level field is unset. Returns undefined when neither is set
 * or both are empty/non-string.
 */
export function resolveAgentModel(
  cfg: { model?: unknown; models?: unknown } | null | undefined,
): string | undefined {
  const top = cfg?.model;
  if (typeof top === 'string' && top.trim() !== '') return top;
  const models = cfg?.models;
  if (models && typeof models === 'object') {
    const conv = (models as Record<string, unknown>)['conversation'];
    if (typeof conv === 'string' && conv.trim() !== '') return conv;
  }
  return undefined;
}

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
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read instance file at ${instanceFile}: ${message}`);
  }

  // 3. Parse JSON (throws SyntaxError if invalid)
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
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
