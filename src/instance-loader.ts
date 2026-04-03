// CONSTRAINT: Only Node built-ins + fleet/paths.ts. No config.ts, no logger.ts.
// Exports: loadInstance(name: string): void

import * as fs from 'node:fs';
import * as path from 'node:path';
import { configRoot as fleetConfigRoot, instancePaths, type InstancePaths } from './fleet/paths.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InstanceType = 'chat' | 'agent' | 'passive';
type AccessMode = 'self_only' | 'allowlist' | 'open_dm' | 'groups_only';
type SessionScope = 'single' | 'shared' | 'per_chat';

const VALID_TYPES: ReadonlySet<string> = new Set(['chat', 'agent', 'passive']);
const VALID_ACCESS_MODES: ReadonlySet<string> = new Set(['self_only', 'allowlist', 'open_dm', 'groups_only']);
const VALID_SESSION_SCOPES: ReadonlySet<string> = new Set(['single', 'shared', 'per_chat']);

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
}

interface InstanceConfig {
  name: string;
  type: InstanceType;
  systemPrompt?: string;
  adminPhones: string[];
  accessMode: AccessMode;
  // Optional fields
  model?: string;
  models?: Record<string, string>;
  pineconeIndex?: string;
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

function validateInstance(raw: Record<string, unknown>, name: string): void {
  // Name match
  if (raw['name'] !== name) {
    throw new Error(
      `Instance name mismatch: expected "${name}" but config.json has "${String(raw['name'])}"`,
    );
  }

  // Valid type
  if (!VALID_TYPES.has(String(raw['type']))) {
    throw new Error(
      `Invalid type "${String(raw['type'])}": must be one of ${[...VALID_TYPES].join(', ')}`,
    );
  }

  // Valid accessMode
  if (!VALID_ACCESS_MODES.has(String(raw['accessMode']))) {
    throw new Error(
      `Invalid accessMode "${String(raw['accessMode'])}": must be one of ${[...VALID_ACCESS_MODES].join(', ')}`,
    );
  }

  // adminPhones must be non-empty array
  if (
    !Array.isArray(raw['adminPhones']) ||
    (raw['adminPhones'] as unknown[]).length === 0
  ) {
    throw new Error('adminPhones must be a non-empty array of phone numbers');
  }

  // adminPhones elements must be non-empty strings
  const instancePath = name;
  const phones = raw['adminPhones'] as unknown[];
  if (phones.some((p: unknown) => typeof p !== 'string' || (p as string).trim() === '')) {
    throw new Error(`adminPhones must contain only non-empty strings in ${instancePath}`);
  }

  // Agent access mode gate — CON-007
  if (raw['type'] === 'agent') {
    const agentOpts = raw['agentOptions'];
    if (agentOpts !== undefined && agentOpts !== null) {
      // agentOptions present: validate its shape first
      if (typeof agentOpts !== 'object' || Array.isArray(agentOpts)) {
        throw new Error('agentOptions must be an object');
      }
      const opts = agentOpts as Record<string, unknown>;

      // @check CHK-061 // @traces CON-007.AC-02
      // sessionScope is required
      if (!VALID_SESSION_SCOPES.has(String(opts['sessionScope'] ?? ''))) {
        throw new Error(
          `agentOptions.sessionScope is required and must be one of ${[...VALID_SESSION_SCOPES].join(', ')}`,
        );
      }

      // cwd is optional — empty/missing means "use homedir() at runtime"
      if (opts['cwd'] !== undefined && typeof opts['cwd'] !== 'string') {
        throw new Error('agentOptions.cwd must be a string when provided');
      }

      // instructionsPath is optional but must be a string when present
      if (opts['instructionsPath'] !== undefined && typeof opts['instructionsPath'] !== 'string') {
        throw new Error('agentOptions.instructionsPath must be a string');
      }

      // sandboxPerChat requires sessionScope 'per_chat'
      if (opts['sandboxPerChat'] === true && opts['sessionScope'] !== 'per_chat') {
        throw new Error('agentOptions.sandboxPerChat requires sessionScope "per_chat"');
      }

      // @check CHK-060 // @traces CON-007.AC-01
      // sessionScope:"shared" and "per_chat" permit any valid access mode; "single" still requires self_only
      if (opts['sessionScope'] === 'shared' || opts['sessionScope'] === 'per_chat') {
        // Any valid access mode is acceptable — already validated above
      } else {
        // sessionScope is "single": requires self_only
        if (raw['accessMode'] !== 'self_only') {
          throw new Error(`Agent instances require accessMode "self_only", got "${raw['accessMode']}"`);
        }
      }
    } else {
      // No agentOptions: existing rule — requires self_only
      if (raw['accessMode'] !== 'self_only') {
        throw new Error(`Agent instances require accessMode "self_only", got "${raw['accessMode']}"`);
      }
    }
  }

  // Chat requires systemPrompt
  if (raw['type'] === 'chat' && !raw['systemPrompt']) {
    throw new Error('Chat instances must have a non-empty systemPrompt');
  }

  // Passive: no systemPrompt, self_only access only
  if (raw['type'] === 'passive') {
    if (raw['systemPrompt']) {
      throw new Error('Passive instances must not have a systemPrompt');
    }
    if (raw['accessMode'] !== 'self_only') {
      throw new Error(`Passive instances require accessMode "self_only", got "${raw['accessMode']}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function loadInstance(name: string): void {
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
  validateInstance(parsed, name);

  // 5. Resolve paths
  const paths = instancePaths(name);

  // 6. Build config — cast through unknown since validateInstance already
  // verified the required fields; TS cannot narrow from Record<string,unknown>
  const config = { ...parsed, paths } as InstanceConfig;

  // 7. Set env var
  process.env.INSTANCE_CONFIG = JSON.stringify(config);
}
