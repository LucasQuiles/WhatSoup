import type { Database } from '../../../core/database.ts';
import type { LLMProvider } from './types.ts';

export function withDatabaseCompatibility(
  db: Database,
  provider: LLMProvider,
): LLMProvider {
  return {
    name: provider.name,
    async generate(request) {
      db.assertWritableCompatibility();
      return provider.generate(request);
    },
  };
}
