import { isNonEmptyString } from './type-guards.ts';

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

/** Instance name of the operator's own bot. */
export const OPERATOR_INSTANCE_NAME = 'q';

/**
 * Pinecone project the operator instance must reach: the operator's Default
 * project. The operator instance is checked like every other instance; this
 * constant supplies its expected project when its config sets no guard, so a
 * host that runs `q` without `memory.pinecone` still fails closed on a key for
 * another principal's project. A configured `projectId`/`expectedHostSuffix`
 * takes precedence.
 */
export const OPERATOR_PINECONE_PROJECT_ID = 'o6fsxb8';

export type PineconeProjectGuardSource = 'config' | 'operator_default' | 'none';

export function hasPineconeProjectGuard(guard: PineconeProjectGuard): boolean {
  return Boolean(guard.projectId || guard.expectedHostSuffix);
}

export function isOperatorInstance(botName: unknown): boolean {
  return isNonEmptyString(botName) && botName.trim().toLowerCase() === OPERATOR_INSTANCE_NAME;
}

/**
 * The guard an instance is held to: its configured guard when it has one,
 * otherwise the operator project for the operator instance, otherwise none.
 */
export function resolvePineconeProjectGuard(
  botName: unknown,
  configured: PineconeProjectGuard,
): { guard: PineconeProjectGuard; source: PineconeProjectGuardSource } {
  if (hasPineconeProjectGuard(configured)) return { guard: configured, source: 'config' };
  if (isOperatorInstance(botName)) {
    return { guard: { projectId: OPERATOR_PINECONE_PROJECT_ID }, source: 'operator_default' };
  }
  return { guard: configured, source: 'none' };
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
