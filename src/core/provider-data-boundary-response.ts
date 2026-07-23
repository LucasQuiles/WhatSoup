import {
  ProviderDataBoundaryError,
  type ProviderResponseFailureCode,
} from './provider-data-boundary-contract.ts';
import { MAX_BOUNDARY_TEXT_LENGTH } from './provider-data-boundary-detection.ts';

const MAX_RESTRICTED_RESPONSE_BYTES = MAX_BOUNDARY_TEXT_LENGTH * 2;
const MAX_RESTRICTED_TOOL_CALLS = 1024;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export interface RestrictedProviderResponseBudget {
  observeWireBytes(byteLength: number): void;
  observeText(text: string): void;
  observeToolCall(index: number): void;
  observeToolArguments(argumentsFragment: string): void;
  observeInvalid(): void;
  assertTerminal(seen: boolean): void;
}

export interface RestrictedProviderResponseBudgetOptions {
  readonly enforce: boolean;
  readonly onFailure: (code: ProviderResponseFailureCode) => void;
}

export function createRestrictedProviderResponseBudget(
  options: RestrictedProviderResponseBudgetOptions,
): RestrictedProviderResponseBudget {
  let responseBytes = 0;
  let textBytes = 0;
  let toolArgumentBytes = 0;
  const toolCallIndices = new Set<number>();
  const observedFailures = new Set<ProviderResponseFailureCode>();

  const fail = (code: ProviderResponseFailureCode): void => {
    if (!observedFailures.has(code)) {
      observedFailures.add(code);
      options.onFailure(code);
    }
    if (options.enforce) throw new ProviderDataBoundaryError(code);
  };

  const addWithinLimit = (current: number, value: string, limit: number): number => {
    const next = current + utf8Bytes(value);
    if (!Number.isSafeInteger(next) || next > limit) {
      fail('limit_exceeded');
    }
    return next;
  };

  return Object.freeze({
    observeWireBytes(byteLength: number) {
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        fail('invalid_provider_response');
        return;
      }
      const next = responseBytes + byteLength;
      if (!Number.isSafeInteger(next) || next > MAX_RESTRICTED_RESPONSE_BYTES) {
        fail('limit_exceeded');
      }
      responseBytes = next;
    },
    observeText(text: string) {
      textBytes = addWithinLimit(textBytes, text, MAX_BOUNDARY_TEXT_LENGTH);
    },
    observeToolCall(index: number) {
      if (!Number.isSafeInteger(index) || index < 0) {
        fail('invalid_provider_response');
      }
      if (index >= MAX_RESTRICTED_TOOL_CALLS) {
        fail('limit_exceeded');
      }
      toolCallIndices.add(index);
      if (toolCallIndices.size > MAX_RESTRICTED_TOOL_CALLS) {
        fail('limit_exceeded');
      }
    },
    observeToolArguments(argumentsFragment: string) {
      toolArgumentBytes = addWithinLimit(
        toolArgumentBytes,
        argumentsFragment,
        MAX_BOUNDARY_TEXT_LENGTH,
      );
    },
    observeInvalid() {
      fail('invalid_provider_response');
    },
    assertTerminal(seen: boolean) {
      if (!seen) fail('invalid_provider_response');
    },
  });
}
