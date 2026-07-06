import { planCredentialWrites, type CredentialWrite } from './credential-routing.ts';

/** Split the wizard's accumulated form state into the config PATCH payload
 *  (raw keys removed — they go to the keyring, never config.json) and the
 *  keyring writes to perform via PUT /api/credentials/:service. */
export function buildFinishPatch(
  formData: Record<string, unknown>,
): { patch: Record<string, unknown>; credentials: CredentialWrite[] } {
  const credentials = planCredentialWrites(formData);
  const patch = { ...formData };
  delete patch.apiKey;
  delete patch.openaiKey;
  return { patch, credentials };
}
