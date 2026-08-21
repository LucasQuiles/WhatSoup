import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

import {
  importLidMappings,
  readLidMappings,
  type FleetMappingInput,
} from '../../core/lid-resolver.ts';
import { jsonResponse } from '../../lib/http.ts';
import { createChildLogger } from '../../logger.ts';
import type { FleetDbReader } from '../db-reader.ts';
import type { FleetDiscovery } from '../discovery.ts';
import {
  buildConflictExplicitLidMappings,
  type LidMappingObservation,
} from '../lid-conflict-resolution.ts';
import { publishLidConflict, type FleetRealtimePublisher } from '../realtime-publisher.ts';

const log = createChildLogger('fleet');

export interface LidSyncDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
  realtime: FleetRealtimePublisher;
}

/** GET /api/lid-mappings — export all LID mappings from all instances. */
export function handleGetLidMappings(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: LidSyncDeps,
): void {
  try {
    const instances = [...deps.discovery.getInstances().values()];
    const allMappings: Array<{ lid: string; phone_jid: string; instance: string }> = [];
    const observations: LidMappingObservation[] = [];
    const seen = new Set<string>();
    const readErrors: string[] = [];

    for (const inst of instances) {
      const result = deps.dbReader.query(inst.name, inst.dbPath, (db: DatabaseSync) => {
        return readLidMappings(db);
      });
      if (!result.ok) {
        // PDR-3: a read failure must surface as failure, never as fake-normal data.
        readErrors.push(inst.name);
        continue;
      }
      for (const mapping of result.data) {
        observations.push({ ...mapping, instance: inst.name });
        if (!seen.has(mapping.lid)) {
          seen.add(mapping.lid);
          allMappings.push({ lid: mapping.lid, phone_jid: mapping.phone_jid, instance: inst.name });
        }
      }
    }

    const { unified, conflicts } = buildConflictExplicitLidMappings(observations);

    jsonResponse(res, 200, {
      mappings: allMappings,
      count: allMappings.length,
      unified,
      conflicts,
      conflict_count: conflicts.length,
      read_errors: readErrors,
      read_error_count: readErrors.length,
    });
  } catch (err) {
    log.error({ err }, 'L5: failed to export LID mappings');
    jsonResponse(res, 500, { error: 'internal error' });
  }
}

/** POST /api/lid-mappings/sync — broadcast LID mappings to all instances. */
export async function handleSyncLidMappings(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: LidSyncDeps,
): Promise<void> {
  try {
    const instances = [...deps.discovery.getInstances().values()];

    // Collect every instance's observation so the write seam can compare
    // cross-instance freshness without discarding timestamps.
    const readErrors: string[] = [];
    const observations: FleetMappingInput[] = [];
    for (const inst of instances) {
      const result = deps.dbReader.query(inst.name, inst.dbPath, (db: DatabaseSync) => {
        return readLidMappings(db);
      });
      if (!result.ok) {
        // PDR-3: surface the read failure per-instance (pinned sync semantics skip
        // unreadable peers with visible markers rather than aborting the broadcast).
        log.error({ instance: inst.name }, 'L5: LID sync — instance read failed; excluded from observations');
        readErrors.push(inst.name);
        continue;
      }
      for (const mapping of result.data) {
        observations.push({
          lid: mapping.lid,
          phone_jid: mapping.phone_jid,
          updated_at: mapping.updated_at,
          source_instance: inst.name,
        });
      }
    }

    const results: Record<string, number> = {};
    const details: Record<
      string,
      {
        imported: number;
        flipped: number;
        noop: number;
        conflicts: number;
        skipped?: boolean;
        reason?: string;
        schemaVersion?: number;
        error?: string;
      }
    > = {};
    const skippedInstances: Array<{
      instance: string;
      schemaVersion: number;
      required: number;
      reason: string;
    }> = [];

    for (const inst of instances) {
      const writeResult = deps.dbReader.queryWrite(inst.name, inst.dbPath, (rawDb: DatabaseSync) => {
        const schemaVersion = readSchemaMigrationVersion(rawDb);
        if (schemaVersion < 25) {
          return {
            imported: 0,
            flipped: 0,
            noop: 0,
            conflicts: [],
            skipped: true,
            reason: 'schema_migration_below_25',
            schemaVersion,
          } as const;
        }

        return { ...importLidMappings({ raw: rawDb }, observations), schemaVersion };
      });
      if (writeResult.ok) {
        const result = writeResult.data;
        results[inst.name] = result.imported;
        details[inst.name] = {
          imported: result.imported,
          flipped: result.flipped,
          noop: result.noop,
          conflicts: result.conflicts.length,
          schemaVersion: result.schemaVersion,
          ...(result.skipped ? { skipped: true, reason: result.reason } : {}),
        };
        if (!result.skipped) {
          for (const conflict of result.conflicts) {
            publishLidConflict(deps.realtime, inst.name, conflict.lid);
          }
        }
        if (result.skipped) {
          skippedInstances.push({
            instance: inst.name,
            schemaVersion: result.schemaVersion,
            required: 25,
            reason: result.reason,
          });
        }
      } else {
        results[inst.name] = -1;
        details[inst.name] = {
          imported: 0,
          flipped: 0,
          noop: 0,
          conflicts: 0,
          error: writeResult.error,
        };
      }
    }

    const totalMappings = observations.length;
    log.info({ totalMappings, results, details, skippedInstances }, 'L5: cross-instance LID sync completed');
    jsonResponse(res, 200, { totalMappings, results, details, skippedInstances, readErrors });
  } catch (err) {
    log.error({ err }, 'L5: failed to sync LID mappings');
    jsonResponse(res, 500, { error: 'internal error' });
  }
}

export function readSchemaMigrationVersion(rawDb: DatabaseSync): number {
  try {
    const row = rawDb
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null } | undefined;
    return typeof row?.version === 'number' ? row.version : 0;
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('no such table: schema_migrations')) {
      return 0;
    }
    throw err;
  }
}
