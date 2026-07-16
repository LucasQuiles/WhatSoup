import type { SystemTurnPurpose } from './pending-system-result-tracker.ts';
import type { AgentEvent } from './stream-parser.ts';

export type ProviderEventOwner =
  | { readonly kind: 'logical_turn' }
  | { readonly kind: 'system_request'; readonly purpose: SystemTurnPurpose }
  | { readonly kind: 'control' }
  | { readonly kind: 'session_accounting' }
  | { readonly kind: 'none' };

export interface ProviderEventAdmissionDecision {
  readonly admit: boolean;
  readonly reason:
    | 'owned'
    | 'inert'
    | 'no_owner'
    | 'accounting_only'
    | 'purpose_disallows_effect'
    | 'ambiguous_event';
}

const OUTPUT_SYSTEM_PURPOSES = new Set<SystemTurnPurpose>([
  'proactive_resume_continuation',
  'poll_answer_continuation',
  'respawn_continuation',
]);

const COMPACT_SYSTEM_PURPOSES = new Set<SystemTurnPurpose>([
  'auto_compact_silent',
  'manual_compact_silent',
  'manual_compact_notice',
]);

export function systemPurposeAllowsOutput(purpose: SystemTurnPurpose): boolean {
  return OUTPUT_SYSTEM_PURPOSES.has(purpose);
}

export function decideProviderEventAdmission(
  event: AgentEvent,
  owner: ProviderEventOwner,
): ProviderEventAdmissionDecision {
  switch (event.type) {
    case 'ignored':
      return { admit: true, reason: 'inert' };
    case 'unknown_block':
    case 'unknown':
    case 'parse_error':
      return { admit: false, reason: 'ambiguous_event' };
    case 'init':
      return owner.kind === 'none'
        ? { admit: false, reason: 'no_owner' }
        : { admit: true, reason: 'owned' };
    default:
      break;
  }

  if (owner.kind === 'logical_turn' || owner.kind === 'control') {
    return { admit: true, reason: 'owned' };
  }
  if (owner.kind === 'none') {
    return { admit: false, reason: 'no_owner' };
  }
  if (owner.kind === 'session_accounting') {
    return { admit: false, reason: 'accounting_only' };
  }

  if (event.type === 'token_usage' || event.type === 'result') {
    return { admit: true, reason: 'owned' };
  }
  if (event.type === 'compact_boundary' && COMPACT_SYSTEM_PURPOSES.has(owner.purpose)) {
    return { admit: true, reason: 'owned' };
  }
  if (OUTPUT_SYSTEM_PURPOSES.has(owner.purpose)) {
    return { admit: true, reason: 'owned' };
  }
  return { admit: false, reason: 'purpose_disallows_effect' };
}
