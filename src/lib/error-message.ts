/** Normalize an unknown thrown value into a human-readable error string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
