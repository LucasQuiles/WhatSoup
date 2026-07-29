import { describe, expect, it } from 'vitest';
import { makeChannelId } from '../../src/core/transport-refs.ts';
import {
  OUTBOUND_FAILURE_CODES,
  TOOL_FAILURE_CODES,
  TOOL_FAILURE_DISPOSITIONS,
  classifyOutboundSendFailure,
  classifyThrownToolFailure,
  normalizeToolDurabilityGroup,
} from '../../src/core/durability-evidence-contract.ts';
import {
  PayloadTooLargeError,
  RateLimitedError,
  SendAmbiguousError,
} from '../../src/transport/contract/errors.ts';

const channelId = makeChannelId('whatsapp', 'durability-evidence-test');
const transportBase = {
  channelId,
  operation: 'sendText',
  correlationId: 'synthetic-correlation',
  scope: 'provider' as const,
};

describe('metadata-only durability evidence contract', () => {
  it('declares one disposition for every tool failure code', () => {
    expect(Object.keys(TOOL_FAILURE_DISPOSITIONS).sort())
      .toEqual([...TOOL_FAILURE_CODES].sort());
  });

  it('classifies typed rate limits without inspecting exception prose', () => {
    const failure = classifyThrownToolFailure(new RateLimitedError({
      ...transportBase,
      message: 'SENSITIVE-PROSE-MUST-NOT-BE-PARSED',
    }));

    expect(failure).toEqual({
      failureCode: 'rate_limited',
      failureStage: 'dependency',
      retryDisposition: 'retryable',
      operatorAction: 'none',
      evidenceCoverage: 'complete',
    });
  });

  it('classifies stable resource-exhaustion codes without inspecting prose', () => {
    const error = Object.assign(new Error('SENSITIVE-RESOURCE-PROSE'), { code: 'ENOSPC' });

    expect(classifyThrownToolFailure(error)).toEqual({
      failureCode: 'resource_exhausted',
      failureStage: 'dependency',
      retryDisposition: 'not_retryable',
      operatorAction: 'recover',
      evidenceCoverage: 'complete',
    });
  });

  it('keeps untyped thrown values honestly unknown', () => {
    expect(classifyThrownToolFailure('SENSITIVE-ARBITRARY-THROW')).toEqual({
      failureCode: 'unknown',
      failureStage: 'unknown',
      retryDisposition: 'unknown',
      operatorAction: 'inspect',
      evidenceCoverage: 'partial',
    });
  });

  it('normalizes undeclared tool groups to a bounded other bucket', () => {
    expect(normalizeToolDurabilityGroup('messaging')).toBe('messaging');
    expect(normalizeToolDurabilityGroup('extension-private-name')).toBe('other');
    expect(normalizeToolDurabilityGroup(undefined)).toBe('other');
  });

  it('preserves typed outbound ambiguity and retryability', () => {
    const error = new SendAmbiguousError({
      ...transportBase,
      message: 'SENSITIVE-AMBIGUITY-PROSE',
      phase: 'provider_call_started',
    });

    expect(classifyOutboundSendFailure(error)).toEqual({
      outcomeCode: 'ambiguous',
      failureCode: 'transport.send_ambiguous',
      failureStage: 'provider_call_started',
      mutationState: 'maybe_mutated',
      retryable: false,
      evidenceCoverage: 'typed',
    });
  });

  it('classifies typed local payload rejection as definitely not sent', () => {
    const error = new PayloadTooLargeError({
      ...transportBase,
      message: 'SENSITIVE-PAYLOAD-PROSE',
    });

    expect(classifyOutboundSendFailure(error)).toEqual({
      outcomeCode: 'failed_not_sent',
      failureCode: 'transport.payload_too_large',
      failureStage: 'not_started',
      mutationState: 'not_mutated',
      retryable: false,
      evidenceCoverage: 'typed',
    });
  });

  it('keeps an untyped post-entry outbound throw ambiguous', () => {
    expect(classifyOutboundSendFailure(new Error('SENSITIVE-UNTYPED-PROSE'))).toEqual({
      outcomeCode: 'ambiguous',
      failureCode: 'unknown',
      failureStage: 'unknown',
      mutationState: 'unknown',
      retryable: false,
      evidenceCoverage: 'untyped',
    });
  });

  it('contains the exact transport and legacy outbound failure closure', () => {
    expect(OUTBOUND_FAILURE_CODES).toContain('transport.send_ambiguous');
    expect(OUTBOUND_FAILURE_CODES).toContain('unknown');
    expect(OUTBOUND_FAILURE_CODES).toContain('legacy_unclassified');
  });
});
