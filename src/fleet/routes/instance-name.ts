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
import { isValidInstanceName } from '../instance-name.ts';

export { NAME_MAX_LENGTH, NAME_RE } from '../instance-name.ts';

/**
 * Guard: validate instance name from URL params before using in shell commands
 * or path construction. Writes a 400 response and returns false on invalid input.
 */
export function validateInstanceName(name: string, res: ServerResponse): boolean {
  if (!isValidInstanceName(name)) {
    jsonResponse(res, 400, { error: 'invalid instance name' });
    return false;
  }
  return true;
}
