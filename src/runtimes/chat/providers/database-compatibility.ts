import type { Database } from '../../../core/database.ts';
import { DatabaseCompatibilityError } from '../../../core/database-compatibility.ts';
import type { LLMProvider } from './types.ts';

function assertProviderDatabaseCompatibility(
  db: Database,
  onCompatibilityRejection?: (rejection: DatabaseCompatibilityError) => void,
): void {
  try {
    db.assertWritableCompatibility();
  } catch (err) {
    if (err instanceof DatabaseCompatibilityError) onCompatibilityRejection?.(err);
    throw err;
  }
}

export function withDatabaseCompatibility(
  db: Database,
  provider: LLMProvider,
  onCompatibilityRejection?: (rejection: DatabaseCompatibilityError) => void,
): LLMProvider {
  return {
    name: provider.name,
    async generate(request) {
      assertProviderDatabaseCompatibility(db, onCompatibilityRejection);
      try {
        return await provider.generate(request);
      } finally {
        assertProviderDatabaseCompatibility(db, onCompatibilityRejection);
      }
    },
  };
}
