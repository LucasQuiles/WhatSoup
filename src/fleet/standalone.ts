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

const port = parseInt(process.argv[2] ?? String(DEFAULT_FLEET_PORT), 10);

// Open a throwaway in-memory DB — the standalone server doesn't have a "self" instance
const db = new DatabaseSync(':memory:');

const tokens = await loadOrCreateFleetTokens();
console.log(`Fleet token: ${tokens.active.slice(0, 8)}...`);
console.log('Console unlock token: full value in ~/.config/whatsoup/fleet-tokens.json (field "active")');

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
console.log(`Fleet server listening on http://${process.env.FLEET_BIND_ADDRESS ?? DEFAULT_BIND_ADDRESS}:${port}`);
console.log('Press Ctrl+C to stop');
