import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/logger.ts', async () => (await import('../../helpers/logger-mock.ts')).loggerMock());
// No test here may write a real BOT ERRORS outbox event.
vi.mock('../../../src/lib/emit-alert.ts', () => ({ emitAlertChecked: vi.fn(), clearAlertSourceChecked: vi.fn() }));

import { clearAlertSourceChecked, emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import { reportCodexDeferredDefects } from '../../../src/runtimes/agent/codex-deferred-defect-check.ts';

// Startup check for the Codex resume risks that the thread/resume change left
// open: each reachable risk gives one ERROR line and one BOT ERRORS warning
// (nothing reads WhatSoup logs by level), and the check never refuses to start
// the bot.
const INSTANCE = 'bot-a';
// The outbox confines summary and evidence to a digest, so the fix reaches the
// card through the critical-asset fields: the dispatcher renders operatorAction
// as the requested action and clearRequirement as the clear_requirement line.
const SCOPE_FIX = 'Set agentOptions.sessionScope to per_chat, or remove codex-cli from the provider and the'
  + ' fallbacks, then restart.';
const ADMISSION_FIX = 'Remove codex-cli from the provider and the fallbacks, or run the host without host work'
  + ' admission, then restart. Changing sessionScope does not stop this warning.';
// The dispatcher's clearRequirement check looks for the clear's source in the
// text; a rule without it adds a mismatch note to the closing card.
function clearRule(source: string): string {
  return `cleared by ${source} at the next start whose configuration no longer carries this risk`;
}

function captureLogger() {
  return { error: vi.fn() };
}

beforeEach(() => {
  vi.mocked(emitAlertChecked).mockReset();
  vi.mocked(emitAlertChecked).mockReturnValue(true);
  vi.mocked(clearAlertSourceChecked).mockReset();
  vi.mocked(clearAlertSourceChecked).mockReturnValue(true);
});

describe('codex deferred-defect startup check', () => {
  it.each([
    { role: 'primary', provider: 'codex-cli', fallbacks: [], sessionScope: 'single' },
    { role: 'fallback', provider: 'claude-cli', fallbacks: [{ provider: 'codex-cli' }], sessionScope: 'shared' },
  ])('logs one ERROR and raises one BOT ERRORS warning for the session scope risk when codex-cli is the $role with sessionScope $sessionScope', ({ provider, fallbacks, sessionScope }) => {
    const logger = captureLogger();

    const defects = reportCodexDeferredDefects({
      instance: INSTANCE, provider, fallbacks, sessionScope, hostWorkAdmission: false,
    }, logger);

    expect(defects.map((defect) => defect.check)).toEqual(['codex_single_or_shared_scope']);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'codex_deferred_defect',
        check: 'codex_single_or_shared_scope',
        sessionScope,
      }),
      expect.stringMatching(/not proven for this scope/),
    );
    // One incident per instance and risk: the dispatcher keys on the source.
    expect(emitAlertChecked).toHaveBeenCalledExactlyOnceWith(
      INSTANCE,
      'codex_resume_needs_per_chat_scope',
      'bot-a: codex-cli resume needs sessionScope per_chat',
      expect.stringContaining('check=codex_single_or_shared_scope'),
      'warning',
      expect.objectContaining({
        asset: { kind: 'runtime_session', instance: INSTANCE },
        failure: expect.objectContaining({ code: 'CODEX_RESUME_NEEDS_PER_CHAT_SCOPE', operatorAction: SCOPE_FIX }),
      }),
    );
  });

  it('treats a missing sessionScope as the runtime default, single', () => {
    const logger = captureLogger();

    reportCodexDeferredDefects({
      instance: INSTANCE,
      provider: 'codex-cli',
      fallbacks: [],
      sessionScope: undefined,
      hostWorkAdmission: false,
    }, logger);

    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ check: 'codex_single_or_shared_scope', sessionScope: 'single' }),
      expect.stringMatching(/sessionScope single/),
    );
  });

  it('logs one ERROR and raises one BOT ERRORS warning for the host work admission risk when codex-cli runs under host work admission', () => {
    const logger = captureLogger();

    const defects = reportCodexDeferredDefects({
      instance: INSTANCE,
      provider: 'opencode-cli',
      fallbacks: [{ provider: 'codex-cli' }],
      sessionScope: 'per_chat',
      hostWorkAdmission: true,
    }, logger);

    expect(defects.map((defect) => defect.check)).toEqual(['codex_host_work_admission']);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: 'codex_deferred_defect',
        check: 'codex_host_work_admission',
        hostWorkAdmission: true,
      }),
      expect.stringMatching(/WHATSOUP_WORK_ADMISSION=systemd.*not proven under host work admission/),
    );
    expect(emitAlertChecked).toHaveBeenCalledExactlyOnceWith(
      INSTANCE,
      'codex_resume_unproven_under_host_admission',
      'bot-a: codex-cli resume is unproven under host work admission',
      expect.stringContaining('check=codex_host_work_admission'),
      'warning',
      expect.objectContaining({
        asset: { kind: 'runtime_session', instance: INSTANCE },
        failure: expect.objectContaining({ code: 'CODEX_RESUME_UNPROVEN_UNDER_HOST_ADMISSION', operatorAction: ADMISSION_FIX }),
      }),
    );
  });

  it('raises one BOT ERRORS warning per risk, each under its own source, when both are reachable', () => {
    const logger = captureLogger();

    reportCodexDeferredDefects({
      instance: INSTANCE,
      provider: 'codex-cli',
      fallbacks: [],
      sessionScope: 'shared',
      hostWorkAdmission: true,
    }, logger);

    expect(emitAlertChecked).toHaveBeenCalledTimes(2);
    expect(vi.mocked(emitAlertChecked).mock.calls.map((call) => [call[0], call[1], call[4]])).toEqual([
      [INSTANCE, 'codex_resume_needs_per_chat_scope', 'warning'],
      [INSTANCE, 'codex_resume_unproven_under_host_admission', 'warning'],
    ]);
  });

  // The card headline is the source with separators turned into spaces
  // (bot-errors-dispatcher.py source_headline), so the source must be a safe
  // label in plain words. A code of one letter and a number tells the reader
  // nothing, so no word of the source or title may have that shape.
  it('names each alert source and title in plain words: a dispatcher-safe label with no letter-and-number codes', () => {
    reportCodexDeferredDefects({
      instance: INSTANCE,
      provider: 'codex-cli',
      fallbacks: [],
      sessionScope: 'single',
      hostWorkAdmission: true,
    }, captureLogger());

    const calls = vi.mocked(emitAlertChecked).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [, source, title] of calls) {
      expect(source).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/);
      const words = `${source} ${title}`.toLowerCase().split(/[^a-z0-9]+/);
      expect(words.filter((word) => /^[a-z]\d+$/.test(word))).toEqual([]);
    }
  });

  it('logs nothing and raises no alert when codex-cli is only a per_chat fallback without host work admission', () => {
    const logger = captureLogger();

    const defects = reportCodexDeferredDefects({
      instance: INSTANCE,
      provider: 'opencode-cli',
      fallbacks: [
        { provider: 'opencode-cli' },
        { provider: 'opencode-cli' },
        { provider: 'codex-cli' },
        { provider: 'claude-cli' },
      ],
      sessionScope: 'per_chat',
      hostWorkAdmission: false,
    }, logger);

    expect(defects).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(emitAlertChecked).not.toHaveBeenCalled();
  });

  it('never throws when the logger does, and still raises every alert', () => {
    const logger = { error: vi.fn(() => { throw new Error('log sink closed'); }) };

    expect(() => reportCodexDeferredDefects({
      instance: INSTANCE,
      provider: 'codex-cli',
      fallbacks: [],
      sessionScope: 'shared',
      hostWorkAdmission: true,
    }, logger)).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
    // A failed log line must not hide the risk from the operator.
    expect(emitAlertChecked).toHaveBeenCalledTimes(2);
  });

  it('does not stop startup when emitAlertChecked throws: it logs the failure and still tries the next alert', () => {
    const logger = captureLogger();
    vi.mocked(emitAlertChecked)
      .mockImplementationOnce(() => { throw new Error('outbox directory missing'); })
      .mockReturnValueOnce(true);

    let defects: ReturnType<typeof reportCodexDeferredDefects> = [];
    expect(() => {
      defects = reportCodexDeferredDefects({
        instance: INSTANCE,
        provider: 'codex-cli',
        fallbacks: [],
        sessionScope: 'shared',
        hostWorkAdmission: true,
      }, logger);
    }).not.toThrow();

    expect(defects).toHaveLength(2);
    expect(emitAlertChecked).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ check: 'codex_single_or_shared_scope', err: expect.any(Error) }),
      'codex deferred-defect alert could not be emitted',
    );
    // Both risk lines are still logged.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ check: 'codex_single_or_shared_scope' }),
      expect.stringMatching(/not proven for this scope/),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ check: 'codex_host_work_admission' }),
      expect.stringMatching(/not proven under host work admission/),
    );
  });

  it('logs an alert that emitAlertChecked reports as not queued', () => {
    const logger = captureLogger();
    vi.mocked(emitAlertChecked).mockReturnValueOnce(false);

    reportCodexDeferredDefects({
      instance: INSTANCE,
      provider: 'codex-cli',
      fallbacks: [],
      sessionScope: 'single',
      hostWorkAdmission: false,
    }, logger);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ check: 'codex_single_or_shared_scope' }),
      'codex deferred-defect alert was not queued',
    );
  });

  it('puts the fix and the clear rule for each risk on the card through the critical-asset fields', () => {
    reportCodexDeferredDefects({
      instance: INSTANCE,
      provider: 'codex-cli',
      fallbacks: [],
      sessionScope: 'single',
      hostWorkAdmission: true,
    }, captureLogger());

    const cards = new Map(vi.mocked(emitAlertChecked).mock.calls.map((call) => [call[1], call[5]]));
    expect(cards.get('codex_resume_needs_per_chat_scope')).toEqual({
      asset: { kind: 'runtime_session', instance: INSTANCE },
      failure: {
        code: 'CODEX_RESUME_NEEDS_PER_CHAT_SCOPE',
        domain: 'runtime_configuration',
        recoverability: 'operator_recoverable',
        confidence: 'confirmed',
        operatorAction: SCOPE_FIX,
        clearRequirement: clearRule('codex_resume_needs_per_chat_scope'),
      },
    });
    expect(cards.get('codex_resume_unproven_under_host_admission')).toEqual({
      asset: { kind: 'runtime_session', instance: INSTANCE },
      failure: {
        code: 'CODEX_RESUME_UNPROVEN_UNDER_HOST_ADMISSION',
        domain: 'runtime_configuration',
        recoverability: 'operator_recoverable',
        confidence: 'confirmed',
        operatorAction: ADMISSION_FIX,
        clearRequirement: clearRule('codex_resume_unproven_under_host_admission'),
      },
    });
  });

  it('emits each warning and clears neither source when the configuration carries both risks', () => {
    reportCodexDeferredDefects({
      instance: INSTANCE,
      provider: 'codex-cli',
      fallbacks: [],
      sessionScope: 'shared',
      hostWorkAdmission: true,
    }, captureLogger());

    expect(emitAlertChecked).toHaveBeenCalledTimes(2);
    expect(clearAlertSourceChecked).not.toHaveBeenCalled();
  });

  it('clears only the source whose risk the configuration does not carry', () => {
    reportCodexDeferredDefects({
      instance: INSTANCE,
      provider: 'codex-cli',
      fallbacks: [],
      sessionScope: 'single',
      hostWorkAdmission: false,
    }, captureLogger());

    expect(vi.mocked(emitAlertChecked).mock.calls.map((call) => call[1])).toEqual(['codex_resume_needs_per_chat_scope']);
    expect(clearAlertSourceChecked).toHaveBeenCalledExactlyOnceWith(
      INSTANCE,
      'codex_resume_unproven_under_host_admission',
      expect.stringContaining('host_work_admission=false'),
    );
  });

  it.each([
    {
      config: 'codex-cli with per_chat scope and no host work admission',
      provider: 'codex-cli',
      fallbacks: [] as { provider: string }[],
      sessionScope: 'per_chat' as string | undefined,
      hostWorkAdmission: false,
    },
    {
      config: 'no codex-cli at all',
      provider: 'claude-cli',
      fallbacks: [{ provider: 'opencode-cli' }],
      sessionScope: undefined,
      hostWorkAdmission: true,
    },
  ])('clears both sources once and emits no warning when the configuration carries neither risk: $config', ({ provider, fallbacks, sessionScope, hostWorkAdmission }) => {
    const logger = captureLogger();

    const defects = reportCodexDeferredDefects({
      instance: INSTANCE, provider, fallbacks, sessionScope, hostWorkAdmission,
    }, logger);

    expect(defects).toEqual([]);
    expect(emitAlertChecked).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(vi.mocked(clearAlertSourceChecked).mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [INSTANCE, 'codex_resume_needs_per_chat_scope'],
      [INSTANCE, 'codex_resume_unproven_under_host_admission'],
    ]);
  });

  it('does not stop startup when a clear throws: it logs the failure and still tries the next clear', () => {
    const logger = captureLogger();
    vi.mocked(clearAlertSourceChecked)
      .mockImplementationOnce(() => { throw new Error('outbox directory missing'); })
      .mockReturnValueOnce(true);

    expect(() => reportCodexDeferredDefects({
      instance: INSTANCE,
      provider: 'claude-cli',
      fallbacks: [],
      sessionScope: 'per_chat',
      hostWorkAdmission: false,
    }, logger)).not.toThrow();

    expect(clearAlertSourceChecked).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ check: 'codex_single_or_shared_scope', err: expect.any(Error) }),
      'codex deferred-defect clear could not be emitted',
    );
  });

  // A source check pins the wiring without main.ts's large mocked harness.
  it('main.ts runs the check with the instance name and the effective inputs before it constructs the AgentRuntime', () => {
    const source = readFileSync('src/main.ts', 'utf8');
    const call = source.indexOf('reportCodexDeferredDefects({');
    const construct = source.indexOf('new AgentRuntime(');

    expect(call).toBeGreaterThan(-1);
    expect(construct).toBeGreaterThan(call);
    const callText = source.slice(call, source.indexOf('});', call));
    expect(callText).toContain('instance: config.botName');
    expect(callText).toContain('provider: config.agentProvider');
    expect(callText).toContain('fallbacks: config.agentFallbacks');
    expect(callText).toContain('sessionScope: agentOpts?.sessionScope');
    expect(callText).toContain('hostWorkAdmission: isHostWorkAdmissionEnabled()');
  });
});
