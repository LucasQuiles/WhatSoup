import type { MemoryWriteLifecycle } from '../../src/mcp/tools/memory-write.ts';

/**
 * Permissive lifecycle double for tests whose subject is outside persistence.
 * Lifecycle behavior tests use the real database-backed implementation.
 */
export function memoryWriteLifecycleStub(): MemoryWriteLifecycle {
  return {
    registerWrite: (input) => ({ remoteRecordId: input.remoteRecordId, admitted: true }),
    assertWriteAdmission: () => {},
    markWriteFinalized: () => true,
    markWriteAmbiguous: () => {},
    requestErase: () => ({ matched: 0, queued: 0, states: {} }),
  };
}
