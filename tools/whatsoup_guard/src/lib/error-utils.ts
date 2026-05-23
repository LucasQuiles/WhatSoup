export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'operation failed';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
