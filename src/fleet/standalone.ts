/**
 * Standalone fleet server launcher — for development/testing.
 * Starts the fleet server without requiring a full WhatSoup instance.
 *
 * Usage: node --experimental-strip-types src/fleet/standalone.ts [port]
 */

import { DatabaseSync } from 'node:sqlite';
import { createFleetServer } from './index.ts';
import { DEFAULT_BIND_ADDRESS, DEFAULT_FLEET_PORT } from './constants.ts';
import { loadOrCreateFleetTokens } from './token-storage.ts';
import { printErr } from '../lib/cli-print.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('fleet-standalone');

const port = parseInt(process.argv[2] ?? String(DEFAULT_FLEET_PORT), 10);

// Open a throwaway in-memory DB — the standalone server doesn't have a "self" instance
const db = new DatabaseSync(':memory:');

const tokens = await loadOrCreateFleetTokens();
log.info({ tokenPrefix: tokens.active.slice(0, 8) }, 'fleet token generated');
// Wording is redaction-stable on purpose: a "token:"-style colon or a literal
// credential path would (correctly) be scrubbed by the print seam.
printErr('The console unlock token is the "active" field in the fleet-tokens config file.');

const server = createFleetServer({
  db,
  selfName: '__standalone__',
  fleetToken: tokens.active,
  acceptTokens: tokens.accept,
  getFleetTokens: loadOrCreateFleetTokens,
  getSelfHealth: () => ({
    status: 'healthy',
    generated_at: new Date().toISOString(),
    standalone: true,
  }),
});

server.start(port);
log.info(
  { bindAddress: process.env.FLEET_BIND_ADDRESS ?? DEFAULT_BIND_ADDRESS, port },
  'fleet server listening',
);
printErr('Press Ctrl+C to stop');
