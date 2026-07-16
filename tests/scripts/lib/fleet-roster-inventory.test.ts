import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  rosterDigest,
  rosterEpoch,
  rosterIdentity,
  rosterInventory,
  RosterPortError,
} from '../../../scripts/lib/fleet-roster-inventory.ts';

// lib/ -> scripts/ -> tests/ -> repo root
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const realRosterPath = path.join(repoRoot, 'deploy/bot-errors-expected-fleet.json');
const rosterLibDir = path.join(repoRoot, 'deploy/scripts/lib');

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-fleet-roster-port-'));
  tempRoots.push(root);
  return root;
}

function writeRoster(
  root: string,
  hosts: unknown[],
  extra: Record<string, unknown> = {},
  fileName = 'roster.json',
): string {
  const rosterPath = path.join(root, fileName);
  writeFileSync(rosterPath, JSON.stringify({ schemaVersion: 1, hosts, ...extra }, null, 2), 'utf8');
  return rosterPath;
}

function makeHosts(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, index) => ({
    host: `fixture-host-${index}`,
    role: 'bot-host',
    collectorRemote: index % 2 === 0,
    instances: [
      { name: `fixture-bot-${index}`, service: `fixture-bot-${index}.service`, expected: 'always_on' },
    ],
  }));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fleet-roster-inventory (TS port of bot_errors_roster.py, #1867 D4)', () => {
  it('produces a digest and inventory identical to the Python roster module for the real committed roster (lockstep)', () => {
    const pythonOutput = execFileSync('python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(rosterLibDir)})
from bot_errors_roster import roster_inventory
with open(${JSON.stringify(realRosterPath)}, encoding="utf-8") as f:
    data = json.load(f)
print(json.dumps(roster_inventory(data)))
`], { encoding: 'utf8' });
    const pythonInventory = JSON.parse(pythonOutput) as Record<string, unknown>;

    const rosterData = JSON.parse(readFileSync(realRosterPath, 'utf8'));
    const tsInventory = rosterInventory(rosterData);

    expect(tsInventory).toEqual(pythonInventory);
  });

  it('produces a rosterEpoch identical to Python roster_epoch() for the same file (lockstep)', () => {
    const pythonOutput = execFileSync('python3', ['-c', `
import sys, json
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(rosterLibDir)})
from bot_errors_roster import roster_epoch
print(json.dumps(roster_epoch(Path(${JSON.stringify(realRosterPath)}))))
`], { encoding: 'utf8' });
    const pythonEpoch = JSON.parse(pythonOutput) as number;

    expect(rosterEpoch(realRosterPath)).toBe(pythonEpoch);
  });

  it('is stable across cosmetic edits that do not change membership/topology (mirrors roster_identity docstring)', () => {
    const root = makeRoot();
    const hosts = makeHosts(2);
    const plainPath = writeRoster(root, hosts);
    const withDescriptionPath = path.join(root, 'roster-with-description.json');
    writeFileSync(
      withDescriptionPath,
      JSON.stringify({ schemaVersion: 1, description: 'a totally different cosmetic description', hosts }, null, 2),
      'utf8',
    );

    const plainDigest = rosterDigest(JSON.parse(readFileSync(plainPath, 'utf8')));
    const describedDigest = rosterDigest(JSON.parse(readFileSync(withDescriptionPath, 'utf8')));

    expect(describedDigest).toBe(plainDigest);
  });

  it('is stable under host/instance reordering (order-independent projection)', () => {
    const root = makeRoot();
    const hosts = makeHosts(3);
    const forwardPath = writeRoster(root, hosts, {}, 'forward.json');
    const reversedPath = writeRoster(root, [...hosts].reverse(), {}, 'reversed.json');

    const forwardDigest = rosterDigest(JSON.parse(readFileSync(forwardPath, 'utf8')));
    const reversedDigest = rosterDigest(JSON.parse(readFileSync(reversedPath, 'utf8')));

    expect(reversedDigest).toBe(forwardDigest);
  });

  it('changes the digest and expectedInstanceCount when fleet membership changes', () => {
    const root = makeRoot();
    const threeHostPath = writeRoster(root, makeHosts(3), {}, 'three-hosts.json');
    const twoHostPath = writeRoster(root, makeHosts(2), {}, 'two-hosts.json');

    const threeHostInventory = rosterInventory(JSON.parse(readFileSync(threeHostPath, 'utf8')));
    const twoHostInventory = rosterInventory(JSON.parse(readFileSync(twoHostPath, 'utf8')));

    expect(threeHostInventory.digest).not.toBe(twoHostInventory.digest);
    expect(threeHostInventory.expectedInstanceCount).not.toBe(twoHostInventory.expectedInstanceCount);
  });

  it('excludes instances explicitly marked expected: none from expectedInstanceCount', () => {
    const root = makeRoot();
    const relayOnlyPath = writeRoster(root, [
      {
        host: 'relay-host',
        role: 'relay-only',
        collectorRemote: true,
        instances: [{ name: 'agent', expected: 'none' }],
      },
    ]);

    const inventory = rosterInventory(JSON.parse(readFileSync(relayOnlyPath, 'utf8')));

    expect(inventory.expectedInstanceCount).toBe(0);
    expect(inventory.runtimeInstancesByHost).toEqual({});
  });

  it('rosterEpoch returns the integer-seconds file mtime, matching Python int(mtime) semantics', () => {
    const root = makeRoot();
    const rosterPath = writeRoster(root, makeHosts(1));
    const mtime = new Date('2026-05-01T12:34:56.789Z');
    utimesSync(rosterPath, mtime, mtime);

    expect(rosterEpoch(rosterPath)).toBe(Math.floor(mtime.getTime() / 1000));
  });

  it('rosterEpoch returns null when the file cannot be stat-ed', () => {
    const root = makeRoot();
    expect(rosterEpoch(path.join(root, 'does-not-exist.json'))).toBeNull();
  });

  it('fails closed (throws RosterPortError) on a structurally invalid roster', () => {
    expect(() => rosterIdentity({ hosts: 'not-a-list' })).toThrow(RosterPortError);
    expect(() => rosterIdentity({ hosts: [{ role: 'bot-host' }] })).toThrow(RosterPortError);
    expect(() => rosterIdentity('not-an-object')).toThrow(RosterPortError);
  });
});
