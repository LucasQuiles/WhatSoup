import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const durableWriterGuard = join(repoRoot, 'deploy/scripts/check-bot-errors-durable-writers.py');
const fixtureDirs: string[] = [];

function pythonFixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'bot-errors-durable-writer-'));
  fixtureDirs.push(root);
  const script = 'deploy/scripts/fixture.py';
  mkdirSync(join(root, 'deploy/scripts'), { recursive: true });
  writeFileSync(join(root, script), `${source.trim()}\n`);
  writeFileSync(
    join(root, 'deploy/bot-errors-durable-writer-inventory.json'),
    `${JSON.stringify({
      schema_version: 1,
      helper_generation: 1,
      principal_scripts: [script],
      cooperating_scripts: [],
      embedded_publishers: [],
      diagnostic_only_weaker_callers: [],
      callers: [{
        site_id: 'fixture-state',
        script,
        function: 'publish',
        logical_publication: 'fixture.state',
        kind: 'state_replace_expected',
        operation_identity_source: 'durable_json.operation_id.v1',
        result_policy: 'require_advance',
        result_consumer: 'publish',
        fault_test_ids: ['state.no-advance-unproven'],
      }],
    }, null, 2)}\n`,
  );
  return root;
}

function embeddedFixture(source: string, resultPolicy = 'require_advance'): string {
  const root = mkdtempSync(join(tmpdir(), 'bot-errors-durable-writer-embedded-'));
  fixtureDirs.push(root);
  const script = 'deploy/scripts/fixture.py';
  mkdirSync(join(root, 'deploy/scripts'), { recursive: true });
  writeFileSync(join(root, script), `REMOTE_SCRIPT = ${JSON.stringify(`${source.trim()}\n`)}\n`);
  writeFileSync(
    join(root, 'deploy/bot-errors-durable-writer-inventory.json'),
    `${JSON.stringify({
      schema_version: 1,
      helper_generation: 1,
      principal_scripts: [script],
      cooperating_scripts: [],
      embedded_publishers: ['fixture.REMOTE_SCRIPT.publish'],
      diagnostic_only_weaker_callers: [],
      callers: [{
        site_id: 'fixture-embedded-event',
        script,
        function: 'REMOTE_SCRIPT.publish',
        logical_publication: 'fixture.embedded',
        kind: 'event_create_once',
        operation_identity_source: 'durable_json.operation_id.v1',
        result_policy: resultPolicy,
        result_consumer: 'REMOTE_SCRIPT.publish',
        fault_test_ids: ['event.no-advance-unproven'],
      }],
    }, null, 2)}\n`,
  );
  return root;
}

function runDurableWriterGuard(root: string): { status: number | null; code: string | null; stderr: string } {
  const result = spawnSync(
    'python3.12',
    [
      durableWriterGuard,
      '--root',
      root,
      '--inventory',
      'deploy/bot-errors-durable-writer-inventory.json',
      '--json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  let code: string | null = null;
  try {
    const parsed = JSON.parse(result.stdout) as { findings?: Array<{ code?: string }> };
    code = parsed.findings?.[0]?.code ?? null;
  } catch {
    code = null;
  }
  return { status: result.status, code, stderr: result.stderr };
}

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const atomicWriterScripts = [
  'deploy/scripts/bot-errors-heartbeat-watchdog.py',
  'deploy/scripts/bot-errors-health-check.py',
  'deploy/scripts/bot-errors-q-loop.py',
];

const durableCollectorWriterScripts = [
  'deploy/scripts/bot-errors-collector.py',
  'deploy/scripts/bot-errors-dispatcher.py',
];

const durableEventWriterScripts = [
  'deploy/scripts/bot-errors-emit.py',
  'deploy/scripts/bot-errors-runner.py',
];

const protectedAppendScripts = [
  'deploy/scripts/bot-errors-collector.py',
  'deploy/scripts/bot-errors-dispatcher.py',
  'deploy/scripts/bot-errors-health-check.py',
  'deploy/scripts/bot-errors-heartbeat-watchdog.py',
  'deploy/scripts/bot-errors-q-loop.py',
];

describe('BOT ERRORS Python atomic write guard', () => {
  it('rejects a durable result that is discarded', () => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json

def publish(target, payload, op_id, expected):
    publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('rejects a durable result that is assigned but never read', () => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('rejects a durable result used only for string formatting', () => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    str(result)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('rejects a durable publisher call absent from the inventory', () => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json, require_advance

def publish(target, payload, op_id, expected):
    first = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    require_advance(first)
    second = publish_state_json(
        target,
        payload,
        component="fixture.other",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    require_advance(second)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'publisher-uninventoried',
    });
  });

  it('rejects a missing principal script without reporting a clean scan', () => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json, require_advance

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    require_advance(result)
`);
    rmSync(join(fixture, 'deploy/scripts/fixture.py'));

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'script-missing',
    });
  });

  it('rejects a renamed inline JSON write-and-replace publisher', () => {
    const fixture = pythonFixture(`
import json
import os

def publish(target, payload, op_id, expected):
    temporary = target.with_suffix(".private")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle)
    os.replace(temporary, target)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'inline-writer',
    });
  });

  it('rejects a direct JSON write even when it does not rename', () => {
    const fixture = pythonFixture(`
import json
from lib.durable_json import publish_state_json, require_advance

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    require_advance(result)

def hidden_direct_writer(target, payload):
    target.write_text(json.dumps(payload), encoding="utf-8")
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'inline-writer',
    });
  });

  it('does not classify a JSON-RPC socket write as a filesystem publisher', () => {
    const fixture = pythonFixture(`
import json
from lib.durable_json import publish_state_json, require_advance

def send_rpc(sock, payload):
    writer = sock.makefile("w", encoding="utf-8")
    writer.write(json.dumps(payload) + "\\n")

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    require_advance(result)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 0,
      code: null,
    });
  });

  it('rejects a direct JSON file-handle write without a rename', () => {
    const fixture = pythonFixture(`
import json
from lib.durable_json import publish_state_json, require_advance

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    require_advance(result)

def hidden_direct_writer(target, payload):
    with target.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload) + "\\n")
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'inline-writer',
    });
  });

  it('does not classify a lifecycle parent barrier as a JSON publisher', () => {
    const fixture = pythonFixture(`
import os
from lib.durable_json import publish_state_json, require_advance

def fsync_parent(path):
    descriptor = os.open(path.parent, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    require_advance(result)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 0,
      code: null,
    });
  });

  it('rejects duplicate inventory site identifiers', () => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json, require_advance

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    require_advance(result)
`);
    const inventoryPath = join(fixture, 'deploy/bot-errors-durable-writer-inventory.json');
    const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as {
      callers: Array<Record<string, unknown>>;
    };
    inventory.callers.push({ ...inventory.callers[0] });
    writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'duplicate-site-id',
    });
  });

  it.each([
    ['underscore assignment', '_ = result'],
    ['repr-only use', 'repr(result)'],
    ['logging-only use', 'print(result)'],
    ['serialization-only use', 'json.dumps({"result": str(result)})'],
  ])('rejects %s as a durability decision', (_label, use) => {
    const fixture = pythonFixture(`
import json
from lib.durable_json import publish_state_json

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    ${use}
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('accepts a result that reaches the declared require_advance gate', () => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json, require_advance

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    require_advance(result)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 0,
      code: null,
    });
  });

  it('accepts a consumed durable result inside an inventoried embedded script', () => {
    const fixture = embeddedFixture(`
def publish(target, payload, op_id):
    result = publish_event_json(
        target,
        payload,
        component="fixture.embedded",
        operation_id=op_id,
    )
    require_advance(result)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 0,
      code: null,
    });
  });

  it('rejects a discarded durable result inside an inventoried embedded script', () => {
    const fixture = embeddedFixture(`
def publish(target, payload, op_id):
    publish_event_json(
        target,
        payload,
        component="fixture.embedded",
        operation_id=op_id,
    )
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('rejects an inline JSON writer hidden inside an embedded script', () => {
    const fixture = embeddedFixture(`
import json

def hidden(target, payload):
    target.write_text(json.dumps(payload), encoding="utf-8")

def publish(target, payload, op_id):
    result = publish_event_json(
        target,
        payload,
        component="fixture.embedded",
        operation_id=op_id,
    )
    require_advance(result)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'inline-writer',
    });
  });

  it('rejects a result variable overwritten before require_advance', () => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json, require_advance

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    result = "overwritten"
    require_advance(result)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('rejects consumption that exists only in an uncalled nested function', () => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json, require_advance

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    def never_called():
        require_advance(result)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('rejects an unrelated method impersonating require_advance', () => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json

def publish(target, payload, op_id, expected, telemetry):
    telemetry.require_advance(publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    ))
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('rejects a non-literal component that cannot be matched exactly', () => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json, require_advance

COMPONENT = "fixture.state"

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component=COMPONENT,
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    require_advance(result)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'component-not-literal',
    });
  });

  it.each([
    ['wrong function', (inventory: { helper_generation: number; callers: Array<Record<string, unknown>> }) => {
      inventory.callers[0].function = 'elsewhere';
    }, 'inventory-call-missing'],
    ['mixed helper generation', (inventory: { helper_generation: number }) => {
      inventory.helper_generation = 2;
    }, 'inventory-invalid'],
    ['best-effort policy', (inventory: { callers: Array<Record<string, unknown>> }) => {
      inventory.callers[0].result_policy = 'best_effort';
    }, 'inventory-invalid'],
  ])('rejects an inventory with %s', (_label, mutate, expectedCode) => {
    const fixture = pythonFixture(`
from lib.durable_json import publish_state_json, require_advance

def publish(target, payload, op_id, expected):
    result = publish_state_json(
        target,
        payload,
        component="fixture.state",
        operation_id=op_id,
        expected=expected,
        generation=1,
    )
    require_advance(result)
`);
    const inventoryPath = join(fixture, 'deploy/bot-errors-durable-writer-inventory.json');
    const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as {
      helper_generation: number;
      callers: Array<Record<string, unknown>>;
    };
    mutate(inventory);
    writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: expectedCode,
    });
  });

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

  it.each(durableCollectorWriterScripts)('%s consumes shared durable publication outcomes', (script) => {
    const text = readFileSync(script, 'utf8');

    expect(text).toContain('from lib.durable_json import');
    expect(text).toContain('publish_event_json(');
    expect(text).toContain('publish_state_json(');
    expect(text).toContain('require_advance(publication)');
    expect(text).not.toContain('def atomic_write_json');
  });

  it.each(durableEventWriterScripts)('%s consumes the shared create-once publication outcome', (script) => {
    const text = readFileSync(script, 'utf8');

    expect(text).toContain('from lib.durable_json import');
    expect(text).toContain('publish_event_json(');
    expect(text).toContain('require_advance(publication)');
    expect(text).not.toContain('def atomic_write_json');
    expect(text).not.toContain('os.replace(');
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

  it.each(durableEventWriterScripts)('%s protects writefail breadcrumbs with the shared event fence', (script) => {
    const text = readFileSync(script, 'utf8');

    expect(text).toContain('kind": "outbox_write_failure"');
    expect(text).toMatch(/component="(?:emit|runner)\.writefail"/);
    expect(text).not.toContain('os.O_CREAT | os.O_EXCL | os.O_WRONLY');
  });
});
