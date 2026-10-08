/**
 * End-to-end proof that a degraded-health alert built by the TypeScript
 * producer reaches the dispatcher's per-cause hold (#2409).
 *
 * The dispatcher holds a `health_body_degraded` event only when it can read
 * the bot's WhatsApp-connected state and a cause vector whose every cause has
 * a registered hold tier. Its own tests hand-type those values into plain
 * evidence text, but the producer confines evidence to a digest (#2386), so
 * before the structured diagnostics existed no real event was ever held:
 * every degraded event paged at once. Here each event comes straight from
 * `buildBotErrorsEvent()` and goes through one real dispatcher pass.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildBotErrorsEvent, type BotErrorsDegradationDiagnostics } from '../../src/lib/bot-errors-outbox.ts';

const tmpRoots: string[] = [];

/**
 * Producer environment for a live-shaped build: no runner signals (the
 * dispatcher's test-provenance screen would refuse the event) and a state root
 * outside the vitest sandbox (its path would trip the test-leak screen).
 */
const RUNNER_SIGNALS = ['VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID', 'JEST_WORKER_ID', 'PYTEST_CURRENT_TEST'] as const;
const OVERRIDDEN = [...RUNNER_SIGNALS, 'BOT_ERRORS_STATE_DIR', 'BOT_ERRORS_OUTBOX_DIR'] as const;

function buildDegradedAlert(root: string, id: string, degradationDiagnostics?: BotErrorsDegradationDiagnostics) {
  const saved = new Map(OVERRIDDEN.map((key) => [key, process.env[key]]));
  for (const key of OVERRIDDEN) delete process.env[key];
  process.env['BOT_ERRORS_STATE_DIR'] = root;
  try {
    return buildBotErrorsEvent({
      eventType: 'alert',
      instance: 'synthetic-instance',
      source: 'health_body_degraded',
      summary: 'whatsoup@synthetic-instance health is degraded',
      evidence: 'whatsapp_connected=true degradation_causes=degradation_silence_unproven',
      ...(degradationDiagnostics ? { degradationDiagnostics } : {}),
    }, id, new Date().toISOString());
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Build one event in a fresh state root and run one dispatcher pass over it. */
function dispatchOnce(id: string, degradationDiagnostics?: BotErrorsDegradationDiagnostics) {
  const root = mkdtempSync(join('/tmp', 'bot-errors-degraded-hold-'));
  tmpRoots.push(root);
  const event = buildDegradedAlert(root, id, degradationDiagnostics);
  const outbox = join(root, 'outbox');
  mkdirSync(outbox, { recursive: true, mode: 0o700 });
  // The relay adds the machine on harvest; the dispatcher keys incidents on it.
  writeFileSync(
    join(outbox, `20261008T000000Z.synthetic-host.${id}.json`),
    `${JSON.stringify({ ...event, machine: 'synthetic-host' }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const result = execFileSync('python3', ['deploy/scripts/bot-errors-dispatcher.py', '--once'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BOT_ERRORS_STATE_DIR: root,
      BOT_ERRORS_DRY_SEND_CAPTURE: join(root, 'sent-message.txt'),
    },
    encoding: 'utf8',
  });
  const suppressedDir = join(root, 'suppressed');
  const suppressed = (existsSync(suppressedDir) ? readdirSync(suppressedDir) : []).map(
    (entry) => JSON.parse(readFileSync(join(suppressedDir, entry), 'utf8')) as {
      id: string;
      severity: string;
      diagnostics: Record<string, unknown>;
    },
  );
  return { event, counts: JSON.parse(result) as Record<string, unknown>, suppressed };
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bot-errors dispatcher — degraded-health hold from the real producer (#2409)', () => {
  it('holds a connected instance whose only cause is hold-tier', () => {
    const { event, counts, suppressed } = dispatchOnce('degraded-hold-tier', {
      degradationCauses: ['degradation_silence_unproven'],
      whatsappConnected: true,
    });

    // The evidence text is a digest, so the structured fields are the only
    // place the dispatcher can read the causes from.
    expect(event.evidence).toHaveProperty('correlationDigest');
    expect(counts).toMatchObject({
      processed: 1, sent: 0, suppressed: 1, failed: 0, testLeakDropped: 0, testProvenanceSuppressed: 0,
    });
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({
      id: 'degraded-hold-tier',
      severity: 'warning',
      diagnostics: { failureClass: 'transient', transientHeld: true },
    });
  });

  it.each([
    ['a page-tier cause joins the vector', { degradationCauses: ['degradation_silence_unproven', 'transport_disconnected'], whatsappConnected: true }],
    ['the instance reports WhatsApp disconnected', { degradationCauses: ['degradation_silence_unproven'], whatsappConnected: false }],
    ['the producer sends an unrecognized cause', { degradationCauses: ['unrecognized'], whatsappConnected: true }],
    ['the producer sends no diagnostics (the shape before this fix)', undefined],
  ])('pages when %s', (_label, diagnostics) => {
    const { counts, suppressed } = dispatchOnce('degraded-page', diagnostics);

    expect(counts).toMatchObject({
      processed: 1, sent: 1, suppressed: 0, failed: 0, testLeakDropped: 0, testProvenanceSuppressed: 0,
    });
    expect(suppressed).toHaveLength(0);
  });
});
