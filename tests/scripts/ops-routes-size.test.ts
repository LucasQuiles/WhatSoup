/**
 * Arch ratchet for #2239: src/fleet/routes/ops.ts stays a thin shim.
 *
 * The auth, config, lifecycle and message handlers live in ops-auth.ts,
 * ops-config.ts, ops-lifecycle.ts and ops-messages.ts. ops.ts keeps the
 * OpsDeps contract and re-exports those handlers so existing importers are
 * unchanged. Growing it back past 200 lines re-creates the god-module the
 * issue split up; put new handler code in the module that owns its concern.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OPS_PATH = 'src/fleet/routes/ops.ts';
const MAX_LINES_EXCLUSIVE = 200;

describe('ops routes size ratchet (#2239)', () => {
  it('src/fleet/routes/ops.ts is below 200 lines post-extraction', () => {
    const src = readFileSync(resolve(repoRoot, OPS_PATH), 'utf8');
    const lines = src.split('\n').length;
    expect(lines, `${OPS_PATH} has ${lines} lines`).toBeLessThan(MAX_LINES_EXCLUSIVE);
  });

  it('ops.ts defines no route handler bodies of its own', () => {
    const src = readFileSync(resolve(repoRoot, OPS_PATH), 'utf8');
    expect(src).not.toMatch(/^export async function handle/m);
    for (const handler of [
      'handleSend', 'handleAccessUpdate', 'handleMarkRead', 'handleSaveContact',
      'handleRestart', 'handleStop', 'handleDeleteLine', 'handleCreateLine',
      'handleConfigUpdate', 'handleAuth',
    ]) {
      expect(src, `${handler} must be re-exported from ${OPS_PATH}`).toMatch(
        new RegExp(`export \\{[^}]*\\b${handler}\\b[^}]*\\} from '\\./ops-[a-z]+\\.ts';`),
      );
    }
  });
});
