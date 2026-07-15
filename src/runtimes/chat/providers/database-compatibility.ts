import type { Database } from '../../../core/database.ts';
import { DatabaseCompatibilityError } from '../../../core/database-compatibility.ts';
import type { LLMProvider } from './types.ts';

export function withDatabaseCompatibility(
  db: Database,
  provider: LLMProvider,
  onCompatibilityRejection?: (rejection: DatabaseCompatibilityError) => void,
): LLMProvider {
  return {
    name: provider.name,
    async generate(request) {
      try {
        db.assertWritableCompatibility();
      } catch (err) {
        if (err instanceof DatabaseCompatibilityError) onCompatibilityRejection?.(err);
        throw err;
      }
      return provider.generate(request);
    },
  };
}
