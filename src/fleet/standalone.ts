/**
 * Standalone fleet server launcher — for development/testing.
 * Starts the fleet server without requiring a full WhatSoup instance.
 *
 * Usage: node --experimental-strip-types src/fleet/standalone.ts [port]
 */

import { DatabaseSync } from 'node:sqlite';
import { createFleetServer, loadOrCreateFleetToken } from './index.ts';

const port = parseInt(process.argv[2] ?? '9099', 10);

// Open a throwaway in-memory DB — the standalone server doesn't have a "self" instance
const db = new DatabaseSync(':memory:');

const fleetToken = await loadOrCreateFleetToken();
console.log(`Fleet token: ${fleetToken.slice(0, 8)}...`);

const server = createFleetServer({
  db,
  selfName: '__standalone__',
  fleetToken,
  getSelfHealth: () => ({ status: 'healthy', standalone: true }),
});

server.start(port);
console.log(`Fleet server listening on http://127.0.0.1:${port}`);
console.log('Press Ctrl+C to stop');
