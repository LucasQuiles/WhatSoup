// src/mcp/tools/retention.ts
// MCP tool: cleanup_media — on-demand media file cleanup with optional dry-run (SP7).

import { z } from 'zod';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { config } from '../../config.ts';
import { runCleanup } from '../../core/media-retention.ts';
import type { Database } from '../../core/database.ts';
import type { ToolRegistry } from '../registry.ts';
import { createChildLogger } from '../../logger.ts';
import { MS_PER_HOUR } from '../../lib/time-units.ts';
import { type Clock, systemClock } from '../../lib/clock.ts';
import { EXTERNAL_EFFECT_CONTRACT_VERSION } from '../external-effect.ts';

const log = createChildLogger('mcp:retention');

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface RetentionDeps {
  db: Database;
}

// ---------------------------------------------------------------------------
// Dry-run scan — count files that would be deleted without touching them
// ---------------------------------------------------------------------------

function scanDir(
  dir: string,
  maxAgeMs: number,
  // Injectable so expiry can be driven to a known instant (#2200). Optional
  // and defaulted, so this slice changes no existing call site.
  clock: Clock = systemClock,
): { count: number; bytes: number } {
  const now = clock.now();
  let count = 0;
  let bytes = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { count, bytes };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const stat = statSync(join(dir, entry.name));
      if (now - stat.mtimeMs > maxAgeMs) {
        count++;
        bytes += stat.size;
      }
    } catch {
      // skip
    }
  }
  return { count, bytes };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerRetentionTools(
  registry: ToolRegistry,
  deps: RetentionDeps,
  // Injectable so the dry-run expiry scan can be driven to a known instant
  // (#2200). Optional and defaulted, so this slice changes no existing call
  // site.
  clock: Clock = systemClock,
): void {
  const { db } = deps;

  // Base media directory: config.mediaDir resolves to .../media/tmp; base is one level up
  const baseMediaDir = dirname(config.mediaDir);

  registry.register({
    name: 'cleanup_media',
    description:
      'Scan and delete expired media files (downloads, voice notes, cached thumbnails) from the instance media directories. ' +
      'Files in media/tmp/ are expired after tempMaxAgeHours (default 72h); files in media/cache/ after 7 days. ' +
      'Use dry_run: true to see what would be deleted without deleting anything.',
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    externalEffect: { version: EXTERNAL_EFFECT_CONTRACT_VERSION, kind: 'external' },
    schema: z.object({
      max_age_hours: z
        .number()
        .positive()
        .optional()
        .describe(
          'Override temp file max age in hours for this run. Default: uses instance retention config.',
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe('If true, report what would be deleted without deleting. Default: false.'),
    }),
    handler: async (params) => {
      const maxAgeHours = params['max_age_hours'] as number | undefined;
      const dryRun = (params['dry_run'] as boolean | undefined) ?? false;

      const tempMaxAgeMs = maxAgeHours != null
        ? maxAgeHours * MS_PER_HOUR
        : config.mediaRetention.tempHours * MS_PER_HOUR;
      const cacheMaxAgeMs = config.mediaRetention.cacheHours * MS_PER_HOUR;

      if (dryRun) {
        const tmpScan   = scanDir(join(baseMediaDir, 'tmp'),   tempMaxAgeMs, clock);
        const cacheScan = scanDir(join(baseMediaDir, 'cache'), cacheMaxAgeMs, clock);
        const total = { count: tmpScan.count + cacheScan.count, bytes: tmpScan.bytes + cacheScan.bytes };
        log.info({ dryRun: true, ...total }, 'cleanup_media: dry-run scan complete');
        return {
          dry_run: true,
          deleted: total.count,
          skipped: 0,
          bytes_freed: total.bytes,
        };
      }

      const result = await runCleanup(baseMediaDir, db, {
        intervalMs:    config.mediaRetention.intervalHours * MS_PER_HOUR,
        tempMaxAgeMs,
        cacheMaxAgeMs,
      });

      log.info(
        { deleted: result.deleted, skipped: result.skipped, bytesFreed: result.bytesFreed },
        'cleanup_media: complete',
      );

      return {
        dry_run: false,
        deleted: result.deleted,
        skipped: result.skipped,
        bytes_freed: result.bytesFreed,
      };
    },
  });
}
