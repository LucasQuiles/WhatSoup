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
} from './core/agent-config-validator.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InstanceType = 'chat' | 'agent' | 'passive';
type AccessMode = 'self_only' | 'allowlist' | 'open_dm' | 'groups_only';
type SessionScope = 'single' | 'shared' | 'per_chat';

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
  /** Provider identifier — maps to the registry. Defaults to 'claude-cli'. */
  provider?: string;
  /** Provider-specific configuration overrides. */
  providerConfig?: Record<string, unknown>;
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
  // Resolved paths (added by loader)
  paths: InstancePaths;
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

  // 6. Build config — cast through unknown since validateInstance already
  // verified the required fields; TS cannot narrow from Record<string,unknown>
  const config = { ...parsed, paths } as InstanceConfig;

  // 7. Set env var
  process.env.INSTANCE_CONFIG = JSON.stringify(config);
}
