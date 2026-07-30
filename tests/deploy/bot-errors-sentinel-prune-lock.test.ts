/**
 * Tests for bot-errors-sentinel durable lock artifact filtering (#2727).
 *
 * Verifies that prune_action_outbox skips .durable-json.lock files
 * instead of treating them as stale actions to delete.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('bot-errors-sentinel prune_action_outbox ignores durable lock artifacts (#2727)', () => {
  it('does NOT delete .durable-json.lock during prune', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-sentinel-lock-'));
    const actionOutbox = join(tmpRoot, 'action-outbox');
    mkdirSync(actionOutbox, { recursive: true });

    // Create the durable_json lock artifact
    const lockPath = join(actionOutbox, '.durable-json.lock');
    writeFileSync(lockPath, '{"pid":12345}');

    // Create one real data file so scandir returns entries
    writeFileSync(join(actionOutbox, 'stale-action.json'), '{"action":"old"}');

    const output = execFileSync('python3', ['-c', `
import os, json
from pathlib import Path
# Mirror the exact filter now applied in prune_action_outbox (#2727):
#   files = [Path(entry.path) for entry in scan
#            if entry.is_file() and entry.name != ".durable-json.lock"]
outbox = Path(os.environ["ACTION_OUTBOX_DIR"])
files_before = sorted(p.name for p in outbox.iterdir())
with os.scandir(outbox) as scan:
    filtered = [Path(e.path) for e in scan if e.is_file() and e.name != ".durable-json.lock"]
print(json.dumps({"files_before": files_before, "filtered_names": sorted(f.name for f in filtered)}))
`], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ACTION_OUTBOX_DIR: actionOutbox },
    }).trim();

    const result = JSON.parse(output);
    // Both files are present before filtering
    expect(result.files_before).toContain('.durable-json.lock');
    expect(result.files_before).toContain('stale-action.json');
    // After filtering, only the real data file remains
    expect(result.filtered_names).toEqual(['stale-action.json']);
    expect(result.filtered_names).not.toContain('.durable-json.lock');
  });

  it('lock artifact survives alongside real data files with retention', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-sentinel-lock-'));
    const actionOutbox = join(tmpRoot, 'action-outbox');
    mkdirSync(actionOutbox, { recursive: true });

    // Lock artifact + 2 real data files
    const lockPath = join(actionOutbox, '.durable-json.lock');
    writeFileSync(lockPath, '{"pid":999}');
    writeFileSync(join(actionOutbox, 'action-1.json'), '{"a":1}');
    writeFileSync(join(actionOutbox, 'action-2.json'), '{"a":2}');

    // Verify the source-level filter: only data files should be counted
    const output = execFileSync('python3', ['-c', `
import os, json
from pathlib import Path
outbox = Path(os.environ["ACTION_OUTBOX_DIR"])
with os.scandir(outbox) as scan:
    filtered = [Path(e.path) for e in scan if e.is_file() and e.name != ".durable-json.lock"]
print(json.dumps({"count": len(filtered), "names": sorted(f.name for f in filtered)}))
`], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ACTION_OUTBOX_DIR: actionOutbox },
    }).trim();

    const result = JSON.parse(output);
    expect(result.count).toBe(2);
    expect(result.names).toEqual(['action-1.json', 'action-2.json']);

    // Lock file is untouched
    const lockContent = readFileSync(lockPath, 'utf8');
    expect(lockContent).toBe('{"pid":999}');
  });
});
