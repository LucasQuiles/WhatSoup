import { decideAuthLossModeEvent, type AuthLossModeDecision } from './auth-loss-mode-bucket-contract.ts';
import {
  deriveAuthLossModeProducerSignal,
  type AuthLossModeProducerInput,
  type AuthLossModeProducerSignal,
} from './auth-loss-mode-bucket-producer.ts';
import { isStrictIsoUtcTimestamp } from './time-utils.ts';

const sampleIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const unsafePatterns = [
  /\b\d{7,}@(s\.whatsapp\.net|g\.us)\b/i,
  /\b[A-Za-z0-9_-]{8,}@lid\b/i,
  /(?:^|[^\w-])(?:\+\d[\d .()-]{8,}\d|\d{10,16})(?:$|[^\w-])/,
  /\bauth\/(?:creds|session|keys)\.json\b/i,
  /\b(?:bearer|token|secret|password)\b\s*[:=]\s*["']?(?!redacted\b|<redacted>)[^\s"',}]{6,}/i,
];

export interface AuthLossModeProducerArtifactInput {
  generatedAt: string;
  samples: AuthLossModeProducerArtifactSample[];
}

export interface AuthLossModeProducerArtifactSample {
  id: string;
  evidence: AuthLossModeProducerInput;
}

export interface AuthLossModeProducerArtifact {
  artifact: 'auth-loss-mode-bucket-producer-dry-run';
  schemaVersion: 1;
  generatedAt: string;
  sampleCount: number;
  redaction: {
    rawIdentifiersAllowed: false;
    evidenceCopied: false;
  };
  decisions: AuthLossModeProducerArtifactDecision[];
}

export type AuthLossModeProducerArtifactDecision =
  | {
      id: string;
      emits: false;
      reason: Extract<AuthLossModeProducerSignal, { emits: false }>['reason'];
    }
  | {
      id: string;
      emits: true;
      reason: Extract<AuthLossModeProducerSignal, { emits: true }>['reason'];
      event: Extract<AuthLossModeProducerSignal, { emits: true }>['event'];
      decision: AuthLossModeDecision;
    };

export function buildAuthLossModeProducerArtifact(
  input: AuthLossModeProducerArtifactInput,
): AuthLossModeProducerArtifact {
  assertIsoTimestamp(input.generatedAt);
  const seenIds = new Set<string>();
  const decisions: AuthLossModeProducerArtifactDecision[] = input.samples.map((sample): AuthLossModeProducerArtifactDecision => {
    assertSafeSampleId(sample.id);
    if (seenIds.has(sample.id)) throw new Error(`duplicate sample id: ${sample.id}`);
    seenIds.add(sample.id);
    assertNoUnsafeStrings(sample.evidence);

    const signal = deriveAuthLossModeProducerSignal(sample.evidence);
    if (!signal.emits) {
      return {
        id: sample.id,
        emits: false,
        reason: signal.reason,
      };
    }

    return {
      id: sample.id,
      emits: true,
      reason: signal.reason,
      event: signal.event,
      decision: decideAuthLossModeEvent(signal.event),
    };
  });

  return {
    artifact: 'auth-loss-mode-bucket-producer-dry-run',
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    sampleCount: decisions.length,
    redaction: { rawIdentifiersAllowed: false, evidenceCopied: false },
    decisions,
  };
}

function assertIsoTimestamp(value: string): void {
  if (!isStrictIsoUtcTimestamp(value)) {
    throw new Error(`invalid generatedAt timestamp: ${value}`);
  }
}

function assertSafeSampleId(id: string): void {
  if (!sampleIdPattern.test(id)) {
    throw new Error(`unsafe sample id: ${id}`);
  }
}

function assertNoUnsafeStrings(value: unknown): void {
  if (typeof value === 'string') {
    if (unsafePatterns.some((pattern) => pattern.test(value))) {
      throw new Error('unsafe producer artifact input contains raw identifier-shaped data');
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) assertNoUnsafeStrings(item);
    return;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) assertNoUnsafeStrings(item);
  }
}
