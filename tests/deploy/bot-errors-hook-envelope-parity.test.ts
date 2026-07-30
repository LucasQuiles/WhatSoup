import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// deploy/hooks/post-tool-use-log.mjs cannot import the Python envelope SSOT, so
// it hardcodes its v2 envelope fields inline. This guard turns that silent drift
// risk into a red test: the hook's literals must match what
// lib/bot_errors_envelope.new_event_fields produces for the same inputs.
describe('post-tool-use-log envelope parity with the Python SSOT', () => {
  it("keeps the hook's hardcoded v2 envelope fields aligned with bot_errors_envelope", () => {
    const hook = readFileSync(path.join(repoRoot, 'deploy/hooks/post-tool-use-log.mjs'), 'utf8');
    // Anchor on the queue-event literal (the block carrying eventKind) — the
    // hook also writes an unrelated schemaVersion:1 writefail-breadcrumb wrapper.
    const block = hook.match(/schemaVersion:\s*(\d+),\s*\n\s*eventKind:\s*'([a-z_]+)',[\s\S]{0,400}?eventType:\s*'([a-z_]+)',\s*\n\s*severity:\s*'([a-z_]+)',/);
    expect(block).not.toBeNull();
    const schemaVersion = Number(block![1]);
    const eventKind = block![2];
    const eventType = block![3];
    const severity = block![4];

    expect(schemaVersion).not.toBeNaN();
    expect(eventKind).toBeDefined();
    expect(eventType).toBeDefined();
    expect(severity).toBeDefined();
    expect(eventType).toMatch(/^[a-z_]+$/);
    expect(severity).toMatch(/^[a-z_]+$/);

    const ssot = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          [
            'import json, sys',
            "sys.path.insert(0, 'deploy/scripts')",
            'from lib.bot_errors_envelope import SCHEMA_VERSION, new_event_fields',
            `fields = new_event_fields(${JSON.stringify(eventType)}, ${JSON.stringify(severity)})`,
            "print(json.dumps({'schemaVersion': SCHEMA_VERSION, **fields}))",
          ].join('\n'),
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      ),
    ) as { schemaVersion: number; eventKind: string; eventType: string; severity: string };

    expect(schemaVersion).toBe(ssot.schemaVersion);
    expect(eventKind).toBe(ssot.eventKind);
    expect(eventType).toBe(ssot.eventType);
    expect(severity).toBe(ssot.severity);
  });
});
