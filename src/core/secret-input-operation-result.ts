import { isRecord } from '../lib/type-guards.ts';

export type SecretInputOperationResult = Readonly<
  | { phase: 'password'; outcome: 'mfa_required' }
  | { phase: 'password' | 'token' | 'mfa'; outcome: 'completed' }
>;

/** A recorded consumer attestation, never evidence that a challenge is still open. */
export function parseSecretInputOperationResult(
  value: unknown,
  kind: 'password' | 'token' | 'mfa',
  state: string,
): SecretInputOperationResult | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'phase') || !Object.hasOwn(value, 'outcome')
    || state !== 'succeeded' || value.phase !== kind) {
    throw new Error('invalid secret input operation result');
  }
  if (value.outcome === 'completed') return { phase: kind, outcome: 'completed' };
  if (kind === 'password' && value.outcome === 'mfa_required') return { phase: 'password', outcome: 'mfa_required' };
  throw new Error('invalid secret input operation result');
}
