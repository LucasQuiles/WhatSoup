import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTestPython } from '../helpers/python-interpreter.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const durableWriterGuard = join(repoRoot, 'deploy/scripts/check-bot-errors-durable-writers.py');
const testPython = resolveTestPython();
const fixtureDirs: string[] = [];

const boundedJsonlBinding = {
  publisher: 'append_bounded_jsonl',
  consumer: 'require_bounded_jsonl_commit',
  module: 'lib.bounded_jsonl',
  path: 'deploy/scripts/lib/bounded_jsonl.py',
};

const boundedJsonlModule = [
  'def append_bounded_jsonl(path, record, *, component, max_bytes, lock_timeout_seconds=5.0):',
  '    return object()',
  '',
  'def require_bounded_jsonl_commit(result):',
  '    return None',
  '',
].join('\n');

function writeBoundedJsonlModule(root: string, source = boundedJsonlModule): void {
  mkdirSync(join(root, 'deploy/scripts/lib'), { recursive: true });
  writeFileSync(join(root, boundedJsonlBinding.path), source);
}

function writeInventory(root: string, inventory: Record<string, unknown>): void {
  writeFileSync(
    join(root, 'deploy/bot-errors-durable-writer-inventory.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
}

function pythonFixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'bot-errors-durable-writer-'));
  fixtureDirs.push(root);
  const script = 'deploy/scripts/fixture.py';
  mkdirSync(join(root, 'deploy/scripts'), { recursive: true });
  writeFileSync(join(root, script), `${source.trim()}\n`);
  writeBoundedJsonlModule(root);
  writeInventory(root, {
      schema_version: 2,
      helper_generation: 2,
      shared_publishers: [boundedJsonlBinding],
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
  });
  return root;
}

function embeddedFixture(source: string, resultPolicy = 'require_advance'): string {
  const root = mkdtempSync(join(tmpdir(), 'bot-errors-durable-writer-embedded-'));
  fixtureDirs.push(root);
  const script = 'deploy/scripts/fixture.py';
  mkdirSync(join(root, 'deploy/scripts'), { recursive: true });
  writeFileSync(join(root, script), `REMOTE_SCRIPT = ${JSON.stringify(`${source.trim()}\n`)}\n`);
  writeBoundedJsonlModule(root);
  writeInventory(root, {
      schema_version: 2,
      helper_generation: 2,
      shared_publishers: [boundedJsonlBinding],
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
  });
  return root;
}

function boundedJsonlFixture(
  source: string,
  options: { moduleSource?: string | null } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'bot-errors-bounded-jsonl-writer-'));
  fixtureDirs.push(root);
  const script = 'deploy/scripts/fixture.py';
  mkdirSync(join(root, 'deploy/scripts'), { recursive: true });
  writeFileSync(join(root, script), `${source.trim()}\n`);
  if (options.moduleSource !== null) {
    writeBoundedJsonlModule(root, options.moduleSource ?? boundedJsonlModule);
  }
  writeInventory(root, {
    schema_version: 2,
    helper_generation: 2,
    shared_publishers: [boundedJsonlBinding],
    principal_scripts: [script],
    cooperating_scripts: [],
    embedded_publishers: [],
    diagnostic_only_weaker_callers: [],
    callers: [{
      site_id: 'fixture-bounded-jsonl',
      script,
      function: 'publish',
      logical_publication: 'fixture.jsonl',
      kind: 'diagnostic_jsonl_append',
      operation_identity_source: 'bounded_jsonl.record_sha256.evidence_only.v1',
      result_policy: 'require_bounded_jsonl_commit',
      result_consumer: 'publish',
      fault_test_ids: [
        'jsonl.serialization',
        'jsonl.lock-concurrency',
        'jsonl.post-replace-unproven',
      ],
    }],
  });
  return root;
}

function mutateInventory(
  root: string,
  mutate: (inventory: Record<string, any>) => void,
): void {
  const inventoryPath = join(root, 'deploy/bot-errors-durable-writer-inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as Record<string, any>;
  mutate(inventory);
  writeInventory(root, inventory);
}

function runDurableWriterGuard(root: string): {
  status: number | null;
  code: string | null;
  codes: string[];
  stderr: string;
} {
  const result = spawnSync(
    testPython,
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
  let codes: string[] = [];
  try {
    const parsed = JSON.parse(result.stdout) as { findings?: Array<{ code?: string }> };
    code = parsed.findings?.[0]?.code ?? null;
    codes = parsed.findings?.flatMap((finding) => finding.code === undefined ? [] : [finding.code]) ?? [];
  } catch {
    code = null;
    codes = [];
  }
  return { status: result.status, code, codes, stderr: result.stderr };
}

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const durablePublisherScripts = [
  'deploy/scripts/bot-errors-collector.py',
  'deploy/scripts/bot-errors-dispatcher.py',
  'deploy/scripts/bot-errors-health-check.py',
  'deploy/scripts/bot-errors-heartbeat-watchdog.py',
  'deploy/scripts/bot-errors-sentinel.py',
];

const durableStateWriterScripts = [
  'deploy/scripts/bot-errors-q-loop.py',
  'deploy/scripts/bot-errors-selfcheck.py',
  'deploy/scripts/bot_errors_cutover.py',
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

const exactBoundedJsonlCaller = `
from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload):
    require_bounded_jsonl_commit(
        append_bounded_jsonl(
            target,
            payload,
            component="fixture.jsonl",
            max_bytes=512,
        )
    )
`;

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

  it('does not classify a JSON stderr diagnostic as a filesystem publisher', () => {
    const fixture = pythonFixture(`
import json
import sys
from lib.durable_json import publish_state_json, require_advance

def report(payload):
    sys.stderr.write(json.dumps(payload) + "\\n")

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
      inventory.helper_generation = 1;
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

  it('bounded JSONL rejects an inventory missing shared_publishers', () => {
    const fixture = boundedJsonlFixture(exactBoundedJsonlCaller);
    mutateInventory(fixture, (inventory) => {
      delete inventory.shared_publishers;
    });

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'inventory-invalid',
    });
  });

  it('bounded JSONL rejects a malformed shared publisher binding', () => {
    const fixture = boundedJsonlFixture(exactBoundedJsonlCaller);
    mutateInventory(fixture, (inventory) => {
      inventory.shared_publishers[0].module = 'lib.not_bounded_jsonl';
    });

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'inventory-invalid',
    });
  });

  it('bounded JSONL rejects a duplicate shared publisher binding', () => {
    const fixture = boundedJsonlFixture(exactBoundedJsonlCaller);
    mutateInventory(fixture, (inventory) => {
      inventory.shared_publishers.push({ ...inventory.shared_publishers[0] });
    });

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'inventory-invalid',
    });
  });

  it('bounded JSONL rejects a missing bound module', () => {
    const fixture = boundedJsonlFixture(exactBoundedJsonlCaller, { moduleSource: null });

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'shared-publisher-module-missing',
    });
  });

  it.each([
    [
      'publisher definition',
      'def require_bounded_jsonl_commit(result):\n    return None\n',
    ],
    [
      'consumer definition',
      'def append_bounded_jsonl(path, record, *, component, max_bytes):\n    return object()\n',
    ],
  ])('bounded JSONL rejects a module missing the %s', (_label, moduleSource) => {
    const fixture = boundedJsonlFixture(exactBoundedJsonlCaller, { moduleSource });

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'shared-publisher-definition-missing',
    });
  });

  it('bounded JSONL rejects imports from a wrong module', () => {
    const fixture = boundedJsonlFixture(`
from lib.not_bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload):
    require_bounded_jsonl_commit(append_bounded_jsonl(
        target,
        payload,
        component="fixture.jsonl",
        max_bytes=512,
    ))
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'shared-publisher-binding-invalid',
    });
  });

  it.each([
    [
      'publisher alias',
      `from lib.bounded_jsonl import append_bounded_jsonl as append_record, require_bounded_jsonl_commit

def publish(target, payload):
    require_bounded_jsonl_commit(append_record(target, payload, component="fixture.jsonl", max_bytes=512))`,
    ],
    [
      'consumer alias',
      `from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit as require_commit

def publish(target, payload):
    require_commit(append_bounded_jsonl(target, payload, component="fixture.jsonl", max_bytes=512))`,
    ],
  ])('bounded JSONL rejects an import %s', (_label, source) => {
    const fixture = boundedJsonlFixture(source);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'shared-publisher-binding-invalid',
    });
  });

  it('bounded JSONL rejects a qualified publisher call', () => {
    const fixture = boundedJsonlFixture(`
import lib.bounded_jsonl as bounded_jsonl

def publish(target, payload):
    bounded_jsonl.require_bounded_jsonl_commit(bounded_jsonl.append_bounded_jsonl(
        target,
        payload,
        component="fixture.jsonl",
        max_bytes=512,
    ))
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'shared-publisher-binding-invalid',
    });
  });

  it.each([
    [
      'direct reflective invocation',
      `def unregistered(target, payload):
    globals()["require_bounded_jsonl_commit"](
        globals()["append_bounded_jsonl"](
            target,
            payload,
            component="fixture.reflective",
            max_bytes=512,
        )
    )`,
    ],
    [
      'reflective rebinding',
      `def unregistered(target, payload):
    publisher = globals()["append_bounded_jsonl"]
    consumer = globals()["require_bounded_jsonl_commit"]
    consumer(publisher(
        target,
        payload,
        component="fixture.reflective",
        max_bytes=512,
    ))`,
    ],
    [
      'computed reflective rebinding',
      `def unregistered(target, payload):
    publisher = globals()["append_" + "bounded_jsonl"]
    consumer = globals()["require_" + "bounded_jsonl_commit"]
    consumer(publisher(
        target,
        payload,
        component="fixture.reflective",
        max_bytes=512,
    ))`,
    ],
  ])('bounded JSONL rejects %s of the canonical names', (_label, source) => {
    const fixture = boundedJsonlFixture(`${exactBoundedJsonlCaller}\n${source}`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'shared-publisher-binding-invalid',
    });
  });

  it.each([
    [
      'publisher local function',
      `from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload):
    def append_bounded_jsonl(path, record, *, component, max_bytes):
        return object()
    require_bounded_jsonl_commit(append_bounded_jsonl(target, payload, component="fixture.jsonl", max_bytes=512))`,
    ],
    [
      'consumer local function',
      `from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload):
    def require_bounded_jsonl_commit(result):
        return None
    require_bounded_jsonl_commit(append_bounded_jsonl(target, payload, component="fixture.jsonl", max_bytes=512))`,
    ],
    [
      'publisher parameter',
      `from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload, append_bounded_jsonl=append_bounded_jsonl):
    require_bounded_jsonl_commit(append_bounded_jsonl(target, payload, component="fixture.jsonl", max_bytes=512))`,
    ],
    [
      'consumer parameter',
      `from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload, require_bounded_jsonl_commit=require_bounded_jsonl_commit):
    require_bounded_jsonl_commit(append_bounded_jsonl(target, payload, component="fixture.jsonl", max_bytes=512))`,
    ],
    [
      'publisher assignment',
      `from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload):
    append_bounded_jsonl = lambda *args, **kwargs: object()
    require_bounded_jsonl_commit(append_bounded_jsonl(target, payload, component="fixture.jsonl", max_bytes=512))`,
    ],
    [
      'consumer assignment',
      `from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload):
    require_bounded_jsonl_commit = lambda result: None
    require_bounded_jsonl_commit(append_bounded_jsonl(target, payload, component="fixture.jsonl", max_bytes=512))`,
    ],
  ])('bounded JSONL rejects %s shadowing', (_label, source) => {
    const fixture = boundedJsonlFixture(source);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'shared-publisher-binding-invalid',
    });
  });

  it('bounded JSONL rejects a nonliteral component', () => {
    const fixture = boundedJsonlFixture(`
from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

COMPONENT = "fixture.jsonl"

def publish(target, payload):
    require_bounded_jsonl_commit(append_bounded_jsonl(
        target,
        payload,
        component=COMPONENT,
        max_bytes=512,
    ))
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'component-not-literal',
    });
  });

  it('bounded JSONL rejects a correct caller absent from inventory', () => {
    const fixture = boundedJsonlFixture(`
from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload):
    require_bounded_jsonl_commit(append_bounded_jsonl(
        target, payload, component="fixture.jsonl", max_bytes=512,
    ))

def unregistered(target, payload):
    require_bounded_jsonl_commit(append_bounded_jsonl(
        target, payload, component="fixture.other", max_bytes=512,
    ))
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'publisher-uninventoried',
    });
  });

  it('bounded JSONL rejects an inventory naming a different function', () => {
    const fixture = boundedJsonlFixture(exactBoundedJsonlCaller);
    mutateInventory(fixture, (inventory) => {
      inventory.callers[0].function = 'elsewhere';
    });

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'inventory-call-missing',
    });
  });

  it('bounded JSONL rejects a discarded publisher result', () => {
    const fixture = boundedJsonlFixture(`
from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload):
    append_bounded_jsonl(target, payload, component="fixture.jsonl", max_bytes=512)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('bounded JSONL rejects an unread publisher result', () => {
    const fixture = boundedJsonlFixture(`
from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload):
    result = append_bounded_jsonl(target, payload, component="fixture.jsonl", max_bytes=512)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('bounded JSONL rejects a result overwritten before consumption', () => {
    const fixture = boundedJsonlFixture(`
from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload):
    result = append_bounded_jsonl(target, payload, component="fixture.jsonl", max_bytes=512)
    result = "overwritten"
    require_bounded_jsonl_commit(result)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('bounded JSONL rejects consumption only inside an uncalled nested function', () => {
    const fixture = boundedJsonlFixture(`
from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload):
    result = append_bounded_jsonl(target, payload, component="fixture.jsonl", max_bytes=512)
    def never_called():
        require_bounded_jsonl_commit(result)
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('bounded JSONL rejects an unrelated object method named like the consumer', () => {
    const fixture = boundedJsonlFixture(`
from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def publish(target, payload, telemetry):
    telemetry.require_bounded_jsonl_commit(append_bounded_jsonl(
        target, payload, component="fixture.jsonl", max_bytes=512,
    ))
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'result-unconsumed',
    });
  });

  it('bounded JSONL rejects an inline writer beside a valid shared call', () => {
    const fixture = boundedJsonlFixture(`
import json
from lib.bounded_jsonl import append_bounded_jsonl, require_bounded_jsonl_commit

def hidden_inline_writer(target, payload):
    target.write_text(json.dumps(payload), encoding="utf-8")

def publish(target, payload):
    require_bounded_jsonl_commit(append_bounded_jsonl(
        target, payload, component="fixture.jsonl", max_bytes=512,
    ))
`);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'inline-writer',
    });
  });

  it.each([
    ['kind', 'kind', 'state_replace_expected'],
    ['identity', 'operation_identity_source', 'durable_json.operation_id.v1'],
    ['consumer policy', 'result_policy', 'require_advance'],
  ])('bounded JSONL rejects a mismatched closed %s', (_label, field, value) => {
    const fixture = boundedJsonlFixture(exactBoundedJsonlCaller);
    mutateInventory(fixture, (inventory) => {
      inventory.callers[0][field] = value;
    });

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 1,
      code: 'inventory-invalid',
    });
  });

  it('bounded JSONL accepts the exact bound import and direct consumer', () => {
    const fixture = boundedJsonlFixture(exactBoundedJsonlCaller);

    expect(runDurableWriterGuard(fixture)).toMatchObject({
      status: 0,
      code: null,
    });
  });

  it('checked-in durable writer estate has zero findings', () => {
    const result = spawnSync(
      testPython,
      [
        durableWriterGuard,
        '--root',
        repoRoot,
        '--inventory',
        'deploy/bot-errors-durable-writer-inventory.json',
        '--json',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      findings: Array<Record<string, unknown>>;
    };

    expect(result.status).toBe(0);
    expect(parsed.status).toBe('pass');
    expect(parsed.findings).toEqual([]);
    // The guard scans the checked-in Python estate (about 2 s on an idle host); under the hosted
    // full-suite battery it exceeded vitest's default 10 s once (run 33709157404, 2026-09-03), so
    // this spawn gets a bound that covers a loaded runner without hiding a real hang.
  }, 60_000);

  it.each(durablePublisherScripts)('%s consumes shared durable publication outcomes', (script) => {
    const text = readFileSync(script, 'utf8');

    expect(text).toContain('from lib.durable_json import');
    expect(text).toContain('publish_event_json(');
    expect(text).toContain('publish_state_json(');
    expect(text).toContain('require_advance(publication)');
    expect(text).not.toContain('def atomic_write_json');
  });

  it.each(durableStateWriterScripts)('%s consumes shared durable state outcomes', (script) => {
    const text = readFileSync(script, 'utf8');

    expect(text).toContain('durable_json import');
    expect(text).toContain('publish_state_json(');
    expect(text).toContain('require_advance(');
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
