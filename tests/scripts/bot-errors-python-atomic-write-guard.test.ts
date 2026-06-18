import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const atomicWriterScripts = [
  'deploy/scripts/bot-errors-emit.py',
  'deploy/scripts/bot-errors-runner.py',
  'deploy/scripts/bot-errors-collector.py',
  'deploy/scripts/bot-errors-dispatcher.py',
  'deploy/scripts/bot-errors-heartbeat-watchdog.py',
  'deploy/scripts/bot-errors-health-check.py',
  'deploy/scripts/bot-errors-q-loop.py',
];

const protectedAppendScripts = [
  'deploy/scripts/bot-errors-collector.py',
  'deploy/scripts/bot-errors-dispatcher.py',
  'deploy/scripts/bot-errors-health-check.py',
  'deploy/scripts/bot-errors-heartbeat-watchdog.py',
  'deploy/scripts/bot-errors-q-loop.py',
];

describe('BOT ERRORS Python atomic write guard', () => {
  it.each(atomicWriterScripts)('%s uses no-follow fsynced temp writes before rename', (script) => {
    const text = readFileSync(script, 'utf8');

    expect(text).toContain('def atomic_write_json');
    expect(text).toContain('O_EXCL');
    expect(text).toContain('O_NOFOLLOW');
    expect(text).toContain('os.fsync');
    expect(text).toContain('os.replace');
    expect(text).toContain('chmod(0o600)');
    expect(text).toContain('def ensure_private_dir');
    expect(text).toContain('path.lstat()');
    expect(text).toContain('path.is_symlink()');
    expect(text).toContain('not os.path.isdir(path)');
    expect(text).not.toContain('tmp.write_text(json.dumps');
  });

  it.each(protectedAppendScripts)('%s uses no-follow fsynced appends for JSONL diagnostics', (script) => {
    const text = readFileSync(script, 'utf8');

    expect(text).toContain('def append_private_jsonl');
    expect(text).toContain('def assert_regular_or_missing');
    expect(text).toContain('O_APPEND');
    expect(text).toContain('O_NOFOLLOW');
    expect(text).toContain('os.fsync');
    expect(text).toContain('chmod(0o600)');
    expect(text).not.toContain('.open("a"');
    expect(text).not.toContain(".open('a'");
  });

  it.each(['deploy/scripts/bot-errors-emit.py', 'deploy/scripts/bot-errors-runner.py'])('%s protects writefail breadcrumbs with no-follow temp writes', (script) => {
    const text = readFileSync(script, 'utf8');

    expect(text).toContain('kind": "outbox_write_failure"');
    expect(text).toContain('O_NOFOLLOW');
    expect(text).not.toContain('os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600');
  });
});
