// The implementation lives in the domain ring (src/core/config-memory-migration.ts)
// so the shared config validator can check the migrated view config load reads.
export {
  migrateLegacyMemoryConfig,
  type MemoryMigrationOptions,
  type MemoryMigrationResult,
} from './core/config-memory-migration.ts';
