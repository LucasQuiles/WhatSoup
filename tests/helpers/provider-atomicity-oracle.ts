import { isDeepStrictEqual } from 'node:util';

import type { ProviderBoundaryEvent } from '../../src/core/provider-data-boundary.ts';
import { PROVIDER_DATA_POLICY_VERSION } from '../../src/core/provider-data-policy.ts';
import type { ProviderSession } from '../../src/runtimes/agent/providers/types.ts';

export interface ProviderBoundaryObservation {
  split: number;
  rejectionCode: string | undefined;
  fetchCalls: number;
  executeCalls: number;
  nonInitEventCount: number;
  historyCaptured: boolean;
  historyExpectedShape: boolean;
  historyUnchanged: boolean;
  checkpointUnchanged: boolean;
  parsedInputCaptured: boolean;
  parsedInputSupported: boolean;
  parsedInputUnchanged: boolean;
  boundaryEvents: ProviderBoundaryEvent[];
}

export type ExactState =
  | {
    kind: 'primitive';
    value: null | undefined | string | number | boolean;
  }
  | {
    kind: 'object';
    prototype: object | null;
    properties: Array<{
      key: PropertyKey;
      configurable: boolean;
      enumerable: boolean;
      writable: boolean;
      value: ExactState;
    }>;
  };

export function captureExactState(
  value: unknown,
  seen = new WeakSet<object>(),
): ExactState {
  if (
    value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return { kind: 'primitive', value };
  }
  if (typeof value !== 'object') {
    throw new Error(`unsupported exact-state value type: ${typeof value}`);
  }
  if (seen.has(value)) throw new Error('unsupported cyclic or shared exact-state object');
  seen.add(value);
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (
    prototype !== null
    && prototype !== Object.prototype
    && prototype !== Array.prototype
  ) {
    throw new Error('unsupported exact-state object prototype');
  }
  const properties = Reflect.ownKeys(value).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new Error('unsupported accessor property in exact-state object');
    }
    return {
      key,
      configurable: descriptor.configurable ?? false,
      enumerable: descriptor.enumerable ?? false,
      writable: descriptor.writable ?? false,
      value: captureExactState(descriptor.value, seen),
    };
  });
  return {
    kind: 'object',
    prototype,
    properties,
  };
}

export function tryCaptureExactState(value: unknown): ExactState | undefined {
  try {
    return captureExactState(value);
  } catch {
    return undefined;
  }
}

export function exactStateUnchanged(
  value: unknown,
  before: ExactState | undefined,
): boolean {
  if (!before) return false;
  const after = tryCaptureExactState(value);
  return after !== undefined && isDeepStrictEqual(after, before);
}

export interface ProviderHistoryCapture {
  captured: boolean;
  expectedShape: boolean;
  state: ExactState | undefined;
}

export function captureProviderHistory(
  providerName: 'openai-api' | 'anthropic-api',
  provider: ProviderSession,
): ProviderHistoryCapture {
  const reachable = provider as unknown as {
    messages?: unknown[];
    systemPrompt?: string;
  };
  const messages = reachable.messages;
  const systemPrompt = reachable.systemPrompt;
  const messagesCaptured = Object.hasOwn(reachable, 'messages') && Array.isArray(messages);
  const systemPromptCaptured = providerName === 'openai-api'
    ? !Object.hasOwn(reachable, 'systemPrompt')
    : Object.hasOwn(reachable, 'systemPrompt') && typeof systemPrompt === 'string';
  const roles = Array.isArray(messages)
    ? messages.map((message) => (
      typeof message === 'object' && message !== null && 'role' in message
        ? String(message.role)
        : null
    ))
    : [];
  const expectedShape = providerName === 'openai-api'
    ? isDeepStrictEqual(roles, ['system', 'user'])
    : isDeepStrictEqual(roles, ['user']) && typeof systemPrompt === 'string';
  const captured = messagesCaptured && systemPromptCaptured;
  return {
    captured,
    expectedShape,
    state: captured
      ? tryCaptureExactState({
        messages,
        systemPrompt: providerName === 'anthropic-api' ? systemPrompt : null,
      })
      : undefined,
  };
}

function expectedBoundaryEvent(
  secretCount: number,
): Omit<ProviderBoundaryEvent, 'latencyMs'> {
  return {
    policyVersion: PROVIDER_DATA_POLICY_VERSION,
    mode: 'enforce',
    providerClass: 'managed_api',
    routeSource: 'fallback',
    eventType: 'secret_block',
    success: 1,
    transformCount: 1,
    aliasCount: 0,
    secretCount,
  };
}

function hasExactBoundaryEvent(
  events: readonly ProviderBoundaryEvent[],
  secretCount: number,
): boolean {
  if (events.length !== 1) return false;
  const event = events[0]!;
  const {
    latencyMs,
    ...deterministicFields
  } = event;
  const eventKeys = Reflect.ownKeys(event);
  if (eventKeys.some((key) => typeof key !== 'string')) return false;
  return isDeepStrictEqual(
    [...eventKeys].sort(),
    [
      'policyVersion',
      'mode',
      'providerClass',
      'routeSource',
      'eventType',
      'success',
      'transformCount',
      'aliasCount',
      'secretCount',
      'latencyMs',
    ].sort(),
  )
    && isDeepStrictEqual(deterministicFields, expectedBoundaryEvent(secretCount))
    && Number.isInteger(latencyMs)
    && latencyMs === 0;
}

export const NO_PROVIDER_ANOMALIES = {
  rejection: [],
  fetch: [],
  execution: [],
  events: [],
  historyCaptured: [],
  historyShape: [],
  history: [],
  checkpoint: [],
  parsedInput: [],
  boundaryEvents: [],
};

export function providerAnomalySummary(
  observations: readonly ProviderBoundaryObservation[],
  expectedSecretCount: number,
) {
  return {
    rejection: observations
      .filter(({ rejectionCode }) => rejectionCode !== 'secret_detected')
      .map(({ split }) => split),
    fetch: observations.filter(({ fetchCalls }) => fetchCalls !== 1).map(({ split }) => split),
    execution: observations.filter(({ executeCalls }) => executeCalls !== 0).map(({ split }) => split),
    events: observations
      .filter(({ nonInitEventCount }) => nonInitEventCount !== 0)
      .map(({ split }) => split),
    historyCaptured: observations
      .filter(({ historyCaptured }) => !historyCaptured)
      .map(({ split }) => split),
    historyShape: observations
      .filter(({ historyExpectedShape }) => !historyExpectedShape)
      .map(({ split }) => split),
    history: observations
      .filter(({ historyUnchanged }) => !historyUnchanged)
      .map(({ split }) => split),
    checkpoint: observations
      .filter(({ checkpointUnchanged }) => !checkpointUnchanged)
      .map(({ split }) => split),
    parsedInput: observations
      .filter(({ parsedInputCaptured, parsedInputSupported, parsedInputUnchanged }) => (
        !parsedInputCaptured || !parsedInputSupported || !parsedInputUnchanged
      ))
      .map(({ split }) => split),
    boundaryEvents: observations
      .filter(({ boundaryEvents }) => !hasExactBoundaryEvent(boundaryEvents, expectedSecretCount))
      .map(({ split }) => split),
  };
}
