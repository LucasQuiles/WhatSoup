// src/fleet/routes/instance-name.ts
// Shared instance-name request guard for the fleet HTTP route layer.
// Both ops.ts and checkpoints.ts validate instance names from URL params before
// the name reaches service-manager / path construction. This is the single
// source of truth for that route-layer guard so mutation routes cannot drift.
//
// NOTE: src/database-compatibility-config.ts owns a separate INSTANCE_NAME_RE
// that validates before the regular runtime graph is available. That bootstrap
// validator intentionally stays independent (no import of this module).

import type { ServerResponse } from 'node:http';
import { jsonResponse } from '../../lib/http.ts';

/** Valid instance name pattern: lowercase alphanumeric + hyphens, must start with a letter. */
export const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Maximum instance name length (route-layer guard). */
export const NAME_MAX_LENGTH = 30;

/**
 * Guard: validate instance name from URL params before using in shell commands
 * or path construction. Writes a 400 response and returns false on invalid input.
 */
export function validateInstanceName(name: string, res: ServerResponse): boolean {
  if (!NAME_RE.test(name) || name.length < 1 || name.length > NAME_MAX_LENGTH) {
    jsonResponse(res, 400, { error: 'invalid instance name' });
    return false;
  }
  return true;
}
