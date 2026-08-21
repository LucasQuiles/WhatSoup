import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('whatsoup-rs-gate-');
const BEGIN = '# --- restart-safety ledger preflight (begin)';
const END = '# --- restart-safety ledger preflight (end)';

function gateBlock(): string | null {
  const source = fs.readFileSync('deploy/whatsoup', 'utf8');
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  return start >= 0 && end > start ? source.slice(start, end + END.length) : null;
}

function runGate(rc: number, skip = false, withScript = true): { status: number | null; argv: string[] } {
  const root = tmp.make('gate');
  const repo = path.join(root, 'repo');
  const script = path.join(repo, 'scripts', 'restart-safety-preflight.ts');
  const argvFile = path.join(root, 'argv');
  const node = path.join(root, 'node');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  if (withScript) fs.writeFileSync(script, '// fixture\n');
  fs.writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$@" > "$STUB_ARGV"\nexit "$STUB_RC"\n`, { mode: 0o755 });
  const result = spawnSync('bash', ['-c', gateBlock() ?? 'exit 99'], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), XDG_DATA_HOME: path.join(root, 'data'),
      NODE: node, REPO_ROOT: repo, INSTANCE: 'freshline', STUB_ARGV: argvFile, STUB_RC: String(rc),
      ...(skip ? { WHATSOUP_SKIP_PREFLIGHT: '1' } : {}),
    },
  });
  const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, 'utf8').trim().split('\n') : [];
  return { status: result.status, argv };
}

describe('deploy/whatsoup restart-safety ledger gate', () => {
  it('runs after the import preflight and before bootstrap', () => {
    const source = fs.readFileSync('deploy/whatsoup', 'utf8');
    expect(source.indexOf('restart-safety pre-flight gate BYPASSED')).toBeLessThan(source.indexOf(BEGIN));
    expect(source.indexOf(BEGIN)).toBeLessThan(source.indexOf('"$REPO_ROOT/src/bootstrap.ts"'));
  });

  it('passes canonical paths and maps a refusal to terminal exit 78', () => {
    const result = runGate(3);
    expect(result.status).toBe(78);
    expect(result.argv).toEqual(expect.arrayContaining(['--json', '--db', '--instance', 'freshline', '--initial-marker']));
    expect(result.argv[result.argv.indexOf('--db') + 1]).toContain('/whatsoup/instances/freshline/bot.db');
  });

  it('honors the existing emergency skip without invoking the ledger probe', () => {
    expect(runGate(3, true)).toEqual({ status: 0, argv: [] });
  });

  it('fails closed when the ledger probe is missing', () => {
    expect(runGate(0, false, false).status).toBe(78);
  });

  it('consumes the first-create marker only after database startup is ready', () => {
    const source = fs.readFileSync('src/main.ts', 'utf8');
    expect(source.indexOf('process.exit(shutdownExitCode(drainSignal))'))
      .toBeLessThan(source.indexOf('clearInitialDatabaseCreateMarker('));
    expect(source).toContain('clearInitialDatabaseCreateMarker(dataRoot(config.botName), config.botName)');
  });
});
