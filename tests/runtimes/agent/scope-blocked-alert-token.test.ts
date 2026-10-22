// agentOptions.scopeBlockedAlertToken: the opt-in scope_blocked=finalization
// marker on agent_turn_admission_rejected evidence.
//
// Each case sets its own INSTANCE_CONFIG fixture, resets modules and imports the
// coordinator afresh, so the real src/config.ts resolves the setting from that
// fixture and from nothing the suite inherited. Nothing overrides the resolved
// flag: the cases read it only through the coordinator's emitted evidence.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  RuntimeTurnCoordinator,
  RuntimeTurnCoordinatorPort,
} from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';

const emitAlertChecked = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked,
  emitObservationChecked: vi.fn(() => true),
}));

const ENV_KEYS = [
  'INSTANCE_CONFIG',
  'WHATSOUP_CONFIG_DIR',
  'WHATSOUP_DATA_DIR',
  'WHATSOUP_STATE_DIR',
  // config.ts writes both at every load (:536, :544); restore them before tmpDir is removed.
  'TMPDIR',
  'LOG_DIR',
] as const;
let savedEnv: Record<string, string | undefined>;
let tmpDir: string;

const TODAYS_EVIDENCE = 'inbound_seq=41 reason=pre_dispatch_error automatic_replay=false scope=per_chat';

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-blocked-token-'));
  process.env.WHATSOUP_CONFIG_DIR = path.join(tmpDir, 'config');
  process.env.WHATSOUP_DATA_DIR = path.join(tmpDir, 'data');
  process.env.WHATSOUP_STATE_DIR = path.join(tmpDir, 'state');
  delete process.env.INSTANCE_CONFIG;
  emitAlertChecked.mockClear();
  vi.resetModules();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

/** The tests/config.test.ts:298-311 minimal agent instance, with the given agentOptions. */
function agentInstance(agentOptions: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'token-bot',
    type: 'agent',
    paths: {
      configRoot: path.join(tmpDir, 'g-config'),
      dataRoot: path.join(tmpDir, 'g-data'),
      stateRoot: path.join(tmpDir, 'g-state'),
      authDir: path.join(tmpDir, 'g-config', 'auth_info'),
      dbPath: path.join(tmpDir, 'g-data', 'bot.db'),
      logDir: path.join(tmpDir, 'g-data', 'logs'),
      lockPath: path.join(tmpDir, 'g-state', 'bot.lock'),
      mediaDir: path.join(tmpDir, 'g-data', 'media', 'tmp'),
    },
    agentOptions,
  };
}

/** Load the coordinator against the fixture, reject one journaled turn, return the alert evidence. */
async function admissionRejectionEvidence(degraded: boolean): Promise<string> {
  // Imported only after INSTANCE_CONFIG is set: the coordinator's config import evaluates the fixture.
  const { RuntimeTurnCoordinator } = await import('../../../src/runtimes/agent/runtime-turn-coordinator.ts');
  const { coordinatorPortDouble } = await import('./lib/runtime-turn-coordinator-port-double.ts');
  const { createRuntimeTurnContext } = await import('../../../src/runtimes/agent/runtime-turn-context.ts');
  const coordinator = new RuntimeTurnCoordinator(coordinatorPortDouble({
    instanceName: 'token-test',
    runtimeTurnSupervisor: {
      scopeKey: vi.fn(() => 'per_chat:15550190099'),
      isDegraded: vi.fn(() => degraded),
    } as unknown as RuntimeTurnCoordinatorPort['runtimeTurnSupervisor'],
  }));
  const context = createRuntimeTurnContext({
    identity: {
      scope: 'per_chat',
      conversationKey: '15550190099',
      deliveryJid: '15550190099@s.whatsapp.net',
      inboundSeq: 41,
      logicalTurnId: 'turn-token-41',
      managerId: 'manager-token',
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: 'turn-token-41-recovery',
      managerId: 'manager-token-recovery',
      generation: 1,
    },
    replay: {
      sourceMessageId: 'wamid-token-41',
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: true,
      senderJid: '15550190099@s.whatsapp.net',
      senderName: null,
      text: 'hello',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: '15550190099#session',
  });
  const session = {
    getDbRowId: vi.fn(() => 13),
    getStatus: vi.fn(() => ({ active: true, sessionId: 'sess-1', pid: 123 })),
  } as unknown as Parameters<RuntimeTurnCoordinator['turnFinalizationBookkeeping']>[1];
  coordinator.turnFinalizationBookkeeping(context, session, undefined, {
    kind: 'admission_rejected',
    class: 'pre_dispatch_error',
  });
  const [, , , evidence] = emitAlertChecked.mock.calls[0] as unknown as [string, string, string, string, ...unknown[]];
  return evidence;
}

describe('agentOptions.scopeBlockedAlertToken', () => {
  it('OFF (key absent): a degraded scope keeps today\'s exact evidence', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(agentInstance({ sessionScope: 'per_chat' }));
    // The fixture, not the environment, decides the setting: it must lack the key.
    expect(JSON.parse(process.env.INSTANCE_CONFIG ?? '{}')).not.toHaveProperty(['agentOptions', 'scopeBlockedAlertToken']);

    expect(await admissionRejectionEvidence(true)).toBe(TODAYS_EVIDENCE);
  });

  it('ON: a degraded scope appends scope_blocked=finalization', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      agentInstance({ sessionScope: 'per_chat', scopeBlockedAlertToken: true }),
    );

    expect(await admissionRejectionEvidence(true)).toContain('scope_blocked=finalization');
    const call = emitAlertChecked.mock.calls[0] as unknown as unknown[];
    expect(call.at(-1)).toEqual({ conversationKey: '15550190099' });
  });

  it('ON: a scope that is not degraded carries no marker', async () => {
    process.env.INSTANCE_CONFIG = JSON.stringify(
      agentInstance({ sessionScope: 'per_chat', scopeBlockedAlertToken: true }),
    );

    expect(await admissionRejectionEvidence(false)).not.toContain('scope_blocked');
  });
});
