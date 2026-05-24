export interface PineconeProjectGuard {
  projectId?: string;
  expectedHostSuffix?: string;
}

export interface PineconeIndexDescriptor {
  name?: string;
  host?: string;
}

export interface PineconeIndexLister {
  listIndexes(): Promise<unknown>;
}

export interface PineconeProjectGuardMessages {
  missingIndex(indexName: string): string;
  projectMismatch(indexName: string): string;
}

export function hasPineconeProjectGuard(guard: PineconeProjectGuard): boolean {
  return Boolean(guard.projectId || guard.expectedHostSuffix);
}

export function matchesPineconeProjectGuard(
  host: string | undefined,
  guard: PineconeProjectGuard,
): boolean {
  if (!hasPineconeProjectGuard(guard)) return true;
  if (!host) return false;
  if (guard.expectedHostSuffix && !host.endsWith(guard.expectedHostSuffix)) return false;
  if (guard.projectId && !host.includes(`-${guard.projectId}.`)) return false;
  return true;
}

export function pineconeIndexesFromListResult(result: unknown): PineconeIndexDescriptor[] {
  const indexes = typeof result === 'object' && result !== null && 'indexes' in result
    ? (result as { indexes?: PineconeIndexDescriptor[] }).indexes
    : undefined;
  return Array.isArray(indexes) ? indexes : [];
}

export function findPineconeIndex(
  result: unknown,
  targetIndex: string,
): PineconeIndexDescriptor | undefined {
  return pineconeIndexesFromListResult(result).find((index) => index.name === targetIndex);
}

export async function pineconeProjectGuardError(
  client: PineconeIndexLister,
  targetIndex: string,
  guard: PineconeProjectGuard,
  messages: PineconeProjectGuardMessages,
): Promise<string | null> {
  if (!hasPineconeProjectGuard(guard)) return null;
  const found = findPineconeIndex(await client.listIndexes(), targetIndex);
  if (!found) return messages.missingIndex(targetIndex);
  if (!matchesPineconeProjectGuard(found.host, guard)) {
    return messages.projectMismatch(targetIndex);
  }
  return null;
}
