import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import {
  decideProviderEventAdmission,
  resolveProviderEventOwner,
  type ProviderEventOwner,
} from '../../../src/runtimes/agent/runtime-event-admission.ts';
import type { SystemTurnPurpose } from '../../../src/runtimes/agent/pending-system-result-tracker.ts';

const effectEvents: AgentEvent[] = [
  { type: 'assistant_text', text: 'private output' },
  { type: 'tool_use', toolName: 'send_message', toolId: 'tool-1', toolInput: { secret: true } },
  { type: 'tool_result', toolId: 'tool-1', isError: true, content: 'private error' },
  { type: 'compact_boundary' },
  { type: 'result', text: 'private terminal text' },
  { type: 'token_usage', inputTokens: 42 },
];

const owner = (kind: ProviderEventOwner['kind']): ProviderEventOwner => {
  switch (kind) {
    case 'logical_turn': return { kind };
    case 'control': return { kind };
    case 'session_accounting': return { kind };
    case 'none': return { kind };
    case 'system_request': return { kind, purpose: 'fresh_session_context' };
  }
};

describe('decideProviderEventAdmission', () => {
  it.each(['poll_answer_continuation', 'proactive_resume_continuation', 'respawn_continuation'] as const)(
    'preserves matching logical output and system-result precedence for %s',
    (purpose) => {
      const systemTurn = {
        lease: { id: 1, scopeKey: 'chat' }, purpose,
        owner: { managerId: 'manager', generation: 2, toolScopeKey: 'chat#2' }, blocking: true,
      };
      const text: AgentEvent = { type: 'assistant_text', text: 'answer' };
      expect(resolveProviderEventOwner(text, true, systemTurn))
        .toEqual({ owner: { kind: 'logical_turn' }, systemTurn: null });
      expect(resolveProviderEventOwner(text, false, systemTurn))
        .toEqual({ owner: { kind: 'system_request', purpose }, systemTurn });
      expect(resolveProviderEventOwner({ type: 'result', text: 'answer' }, true, systemTurn))
        .toEqual({ owner: { kind: 'system_request', purpose }, systemTurn });
    },
  );

  it('rejects every effect-bearing event without an owner', () => {
    for (const event of effectEvents) {
      expect(decideProviderEventAdmission(event, owner('none'))).toMatchObject({ admit: false });
    }
  });

  it('admits all well-formed event effects for logical and control owners', () => {
    for (const ownerKind of ['logical_turn', 'control'] as const) {
      for (const event of effectEvents) {
        expect(decideProviderEventAdmission(event, owner(ownerKind))).toMatchObject({ admit: true });
      }
    }
  });

  it('limits session accounting to init and inert ignored events', () => {
    expect(decideProviderEventAdmission({ type: 'init', sessionId: 'opaque' }, owner('session_accounting')))
      .toMatchObject({ admit: true });
    expect(decideProviderEventAdmission({ type: 'ignored' }, owner('session_accounting')))
      .toMatchObject({ admit: true });
    for (const event of effectEvents) {
      expect(decideProviderEventAdmission(event, owner('session_accounting')))
        .toMatchObject({ admit: false });
    }
  });

  it('rejects ambiguous parser events for every owner without reading raw content', () => {
    const raw = Object.defineProperty({}, 'private', {
      enumerable: true,
      get: () => { throw new Error('raw content inspected'); },
    });
    const ambiguous: AgentEvent[] = [
      { type: 'unknown_block', blockType: 'future', raw },
      { type: 'unknown', raw },
      { type: 'parse_error', line: 'private malformed record' },
    ];
    for (const currentOwner of [owner('none'), owner('logical_turn'), owner('control')]) {
      for (const event of ambiguous) {
        expect(decideProviderEventAdmission(event, currentOwner)).toMatchObject({ admit: false });
      }
    }
  });

  it.each<{
    purpose: SystemTurnPurpose;
    allowed: AgentEvent['type'][];
  }>([
    { purpose: 'fresh_session_context', allowed: ['init', 'token_usage', 'result', 'ignored'] },
    { purpose: 'auto_compact_silent', allowed: ['init', 'token_usage', 'compact_boundary', 'result', 'ignored'] },
    { purpose: 'manual_compact_notice', allowed: ['init', 'token_usage', 'compact_boundary', 'result', 'ignored'] },
    {
      purpose: 'poll_answer_continuation',
      allowed: ['init', 'assistant_text', 'tool_use', 'tool_result', 'compact_boundary', 'result', 'token_usage', 'ignored'],
    },
    {
      purpose: 'respawn_continuation',
      allowed: ['init', 'assistant_text', 'tool_use', 'tool_result', 'compact_boundary', 'result', 'token_usage', 'ignored'],
    },
  ])('applies the $purpose system-purpose event policy', ({ purpose, allowed }) => {
    const currentOwner: ProviderEventOwner = { kind: 'system_request', purpose };
    const events: AgentEvent[] = [
      { type: 'init', sessionId: 'opaque' },
      ...effectEvents,
      { type: 'ignored' },
    ];

    for (const event of events) {
      expect(decideProviderEventAdmission(event, currentOwner).admit)
        .toBe(allowed.includes(event.type));
    }
  });
});
