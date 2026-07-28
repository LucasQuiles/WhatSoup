const SHA256 = /^sha256:[0-9a-f]{64}$/;

export type ExactRangeProvenanceValidation =
  | 'valid'
  | 'receipt-invalid'
  | 'tool-mismatch'
  | 'policy-mismatch';

export function validateExactRangeProvenance(
  expectedToolDigest: unknown,
  expectedPolicyDigest: unknown,
  currentToolDigest: string,
  currentPolicyDigest: string,
): ExactRangeProvenanceValidation {
  if (
    typeof expectedToolDigest !== 'string'
    || !SHA256.test(expectedToolDigest)
    || typeof expectedPolicyDigest !== 'string'
    || !SHA256.test(expectedPolicyDigest)
    || !SHA256.test(currentToolDigest)
    || !SHA256.test(currentPolicyDigest)
  ) return 'receipt-invalid';
  if (expectedToolDigest !== currentToolDigest) return 'tool-mismatch';
  if (expectedPolicyDigest !== currentPolicyDigest) return 'policy-mismatch';
  return 'valid';
}
