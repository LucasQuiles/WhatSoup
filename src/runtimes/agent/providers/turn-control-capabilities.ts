import {
  type ProviderId,
  PROVIDER_IDS,
} from './index.ts';

export type BusyTurnInputCapability =
  | 'steer_active_turn'
  | 'queue_only';

export type ActiveTurnInterruptCapability =
  | 'interrupt_active_turn'
  | 'terminate_provider_session';

export interface ProviderTurnControlCapabilities {
  readonly startTurn: true;
  readonly busyInput: BusyTurnInputCapability;
  readonly interrupt: ActiveTurnInterruptCapability;
  readonly nativeTurnIdentity: 'required' | 'none';
}

const queueOnly = Object.freeze({
  startTurn: true,
  busyInput: 'queue_only',
  interrupt: 'terminate_provider_session',
  nativeTurnIdentity: 'none',
} as const satisfies ProviderTurnControlCapabilities);

export const providerTurnControlCapabilities: Readonly<
  Record<ProviderId, ProviderTurnControlCapabilities>
> = Object.freeze({
  'claude-cli': queueOnly,
  'codex-cli': Object.freeze({
    startTurn: true,
    busyInput: 'steer_active_turn',
    interrupt: 'interrupt_active_turn',
    nativeTurnIdentity: 'required',
  }),
  'gemini-cli': queueOnly,
  'opencode-cli': queueOnly,
  'openai-api': queueOnly,
  'anthropic-api': queueOnly,
});

if (Object.keys(providerTurnControlCapabilities).length !== PROVIDER_IDS.length) {
  throw new Error('Provider turn-control capability registry is incomplete');
}
