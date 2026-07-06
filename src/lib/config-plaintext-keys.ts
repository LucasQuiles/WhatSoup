/**
 * Top-level instance-config fields that historically received raw provider
 * keys from the console wizard (ModelAuthStep). Nothing at runtime ever
 * reads them — every auth path resolves via resolveApiKey({service, envVar})
 * — so any on-disk value is an inert plaintext secret. CREATE's
 * PASSTHROUGH_FIELDS already excludes them; the PATCH deep-merge did not.
 */
export const PLAINTEXT_PROVIDER_KEY_FIELDS: readonly string[] = ['apiKey', 'openaiKey'];

export function stripPlaintextProviderKeys(
  input: Record<string, unknown>,
): { clean: Record<string, unknown>; removed: string[] } {
  const clean = { ...input };
  const removed: string[] = [];
  for (const field of PLAINTEXT_PROVIDER_KEY_FIELDS) {
    if (field in clean) {
      delete clean[field];
      removed.push(field);
    }
  }
  return { clean, removed };
}
