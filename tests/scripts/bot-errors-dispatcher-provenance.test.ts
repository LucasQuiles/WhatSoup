/**
 * End-to-end proof that the TypeScript producer's provenance stamp satisfies the
 * dispatcher's test-traffic screen (#2391).
 *
 * `bot-errors-dispatcher.test.ts` already covers the screen itself, but it
 * hand-types its provenance block as `producer: 'ts-lib'` — a shape TypeScript
 * never actually produced, because before #2391 it emitted no provenance at all.
 * A transcribed fixture proves the dispatcher works; it cannot prove the
 * producer satisfies it. Here the runtime block comes straight from
 * `buildBotErrorsEvent()`, so the two sides are checked against each other.
 *
 * This lives in its own file rather than alongside the other dispatcher tests
 * because `bot-errors-dispatcher.test.ts` is at 1916 lines against the
 * `arch.file-size` ceiling of 2000, and appending here would have pushed it onto
 * the grandfathered warning list. That list is a shrink-only ratchet; growing it
 * is precisely what `fitness-file-size-warning-budget.test.ts` exists to catch.
 *
 * test-integrity: source-string-ok
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildBotErrorsEvent } from '../../src/lib/bot-errors-outbox.ts';

let tmpRoot = '';
const tmpdir = () => '/tmp';

/** Runner variables the producer treats as strong test signals. */
const RUNNER_SIGNALS = ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'JEST_WORKER_ID', 'PYTEST_CURRENT_TEST'] as const;

function writeEvent(root: string, machine: string, id: string, overrides: Record<string, unknown>): void {
  const outbox = join(root, 'outbox');
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const event = {
    schemaVersion: 1,
    id,
    eventType: 'alert',
    severity: 'warning',
    createdAt: '2026-05-31T00:00:00Z',
    machine,
    platform: 'darwin',
    instance: 'synthetic-instance',
    process: { pid: 123, cwd: root, argv: ['synthetic'] },
    diagnostics: { logHints: [], queue: outbox },
    delivery: { attempts: 0, status: 'queued', nextAttemptAtEpoch: 0, lastError: null },
    ...overrides,
  };
  writeFileSync(
    join(outbox, `20260531T000000Z.${machine}.${id}.json`),
    `${JSON.stringify(event, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** Build an event with every runner signal removed, then restore the environment. */
function buildWithoutRunnerSignals(input: Parameters<typeof buildBotErrorsEvent>[0]) {
  const saved = new Map(RUNNER_SIGNALS.map((key) => [key, process.env[key]]));
  for (const key of RUNNER_SIGNALS) delete process.env[key];
  try {
    return buildBotErrorsEvent(input);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('bot-errors dispatcher — TypeScript producer provenance (#2391)', () => {
  it('refuses the stamped event and lets an unstamped one through', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'bot-errors-dispatcher-provenance-'));
    const capturePath = join(tmpRoot, 'sent-message.txt');
    const suppressed = join(tmpRoot, 'suppressed');

    // Built under vitest, so the strong-signal path stamps test:true.
    const stamped = buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'synthetic-instance',
      source: 'synthetic-provenance-canary',
      summary: 'synthetic canary must not page',
    });
    // And with every runner signal removed the same builder must stamp false,
    // or the backstop would swallow genuine production alerts.
    const live = buildWithoutRunnerSignals({
      eventType: 'alert',
      instance: 'synthetic-instance',
      source: 'synthetic-live-producer',
      summary: 'synthetic live alert must still page',
    });

    expect(stamped.runtime.provenance.test).toBe(true);
    expect(live.runtime.provenance.test).toBe(false);

    writeEvent(tmpRoot, 'synthetic-host-a', 'ts-builder-provenance-suppressed', {
      source: 'synthetic-provenance-canary',
      summary: 'synthetic canary must not page',
      runtime: stamped.runtime,
    });
    writeEvent(tmpRoot, 'synthetic-host-b', 'ts-builder-provenance-live', {
      source: 'synthetic-live-producer',
      summary: 'synthetic live alert must still page',
      runtime: live.runtime,
    });

    const result = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOT_ERRORS_STATE_DIR: tmpRoot,
        BOT_ERRORS_DRY_SEND_CAPTURE: capturePath,
        BOT_ERRORS_TEST_PROVENANCE_META_WINDOW_SECONDS: '900',
      },
      encoding: 'utf8',
    });

    // Exactly one of the two is refused. The other reaching ordinary processing
    // is what keeps this from being a denial-of-alerting change.
    expect(JSON.parse(result)).toMatchObject({ testProvenanceSuppressed: 1, failed: 0 });

    // Identify WHICH event was refused by reading the retained original rather
    // than inferring it from a count — the dry-send capture holds only the last
    // message written, so it cannot answer this.
    const retained = readdirSync(suppressed);
    expect(retained).toHaveLength(1);
    const audited = JSON.parse(readFileSync(join(suppressed, retained[0]), 'utf8')) as {
      id: string;
      runtime: { provenance: { producer: string; test: boolean } };
    };
    expect(audited.id).toBe('ts-builder-provenance-suppressed');
    expect(audited.runtime.provenance.producer).toBe('typescript-outbox');
    expect(audited.runtime.provenance.test).toBe(true);

    const rendered = readFileSync(capturePath, 'utf8');
    expect(rendered).toContain('dispatcher refused test-provenance events');
    // The meta-alert must not leak the producer's resolved queue path.
    expect(rendered).not.toContain(tmpRoot);
  });
});
