/**
 * TS port of `deploy/scripts/lib/bot_errors_roster.py`'s roster identity,
 * digest, and inventory projection (#1867 criterion 3, decision D4).
 *
 * `check-fleet-bot-hardening-parity.ts` is kept pure-Node (no Python
 * subprocess in the guard's hot path, for CI robustness). This module
 * reproduces `roster_identity`/`roster_digest`/`roster_inventory` from the
 * Python source of truth byte-for-byte, so the guard can independently
 * recompute the fleet roster digest/inventory from
 * `deploy/bot-errors-expected-fleet.json` the same way
 * `deploy/scripts/bot-errors-heartbeat-watchdog.py` already does against the
 * sentinel's declared digest (`declared_digest != independent_digest`).
 *
 * This is a deliberate second implementation, not a shared library, because
 * the guard must stay pure-Node. It is kept honest by a lockstep test
 * (`tests/scripts/lib/fleet-roster-inventory.test.ts`) that shells out to the
 * real `bot_errors_roster.py` (via python3, present in the test environment)
 * and asserts byte-identical digest/inventory output against the same fixture
 * roster — so this port can never silently drift from the Python source.
 *
 * Do not hand-roll a third scheme elsewhere; import from here.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

import { isRecord } from '../../src/lib/type-guards.ts';

/** Raised when the roster cannot be read or is structurally invalid. Callers
 * treat this as fail-closed: a roster that cannot be independently loaded or
 * parsed must not be silently trusted (mirrors Python's `RosterError`). */
export class RosterPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterPortError';
  }
}

export interface RosterInstanceIdentity {
  name: string;
  service: string;
  expected: string;
}

export interface RosterHostIdentity {
  host: string;
  role: string;
  collectorRemote: boolean;
  instances: RosterInstanceIdentity[];
}

export interface RosterIdentity {
  schemaVersion: unknown;
  hosts: RosterHostIdentity[];
}

export interface RosterInventory {
  digest: string;
  expectedHosts: string[];
  expectedHostCount: number;
  expectedInstanceCount: number;
  runtimeInstancesByHost: Record<string, number>;
  collectorRemoteHosts: string[];
  collectorRemoteHostCount: number;
}

// Mirrors Python truthiness (`if value:` / `bool(value)`): None, "", 0, False,
// NaN, and empty collections are falsy; everything else is truthy. JS's own
// `Boolean()` disagrees on empty arrays/objects (truthy in JS, falsy in
// Python), so this is spelled out explicitly rather than reused.
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

// Mirrors `bool(value)` exactly (same truthiness table as `pyTruthy`).
function pyBool(value: unknown): boolean {
  return pyTruthy(value);
}

// Mirrors `str(a or b or ... or "").strip()`: the first truthy candidate,
// stringified and trimmed; "" if none are truthy.
function pyOrEmptyTrimmed(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (pyTruthy(candidate)) return String(candidate).trim();
  }
  return '';
}

function compareStringTuples(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

/**
 * Normalized, membership/topology-only projection used for the digest, ported
 * line-for-line from `bot_errors_roster.py:roster_identity` (:57-100). Only
 * the fields that define *what* the fleet is (hosts, role, collector-remote
 * flag, runtime instances) are included, so cosmetic edits (e.g. a
 * `description` field) do not manufacture false drift. Hosts and instances
 * are sorted to make the projection order-independent.
 */
export function rosterIdentity(data: unknown): RosterIdentity {
  if (!isRecord(data)) {
    throw new RosterPortError('roster must be a JSON object');
  }
  const rawHosts = data['hosts'];
  if (!Array.isArray(rawHosts)) {
    throw new RosterPortError('roster hosts must be a list');
  }

  const projected: RosterHostIdentity[] = [];
  for (const item of rawHosts) {
    if (!isRecord(item)) {
      throw new RosterPortError('roster host entries must be objects');
    }
    const host = pyOrEmptyTrimmed(item['host']);
    if (!host) {
      throw new RosterPortError('roster host entry missing host');
    }

    const instances: RosterInstanceIdentity[] = [];
    const rawInstances = item['instances'];
    if (Array.isArray(rawInstances)) {
      for (const inst of rawInstances) {
        if (!isRecord(inst)) continue;
        instances.push({
          name: pyOrEmptyTrimmed(inst['name'], inst['service']),
          service: pyOrEmptyTrimmed(inst['service']),
          expected: pyOrEmptyTrimmed(inst['expected']),
        });
      }
    }
    instances.sort((a, b) =>
      compareStringTuples([a.name, a.service, a.expected], [b.name, b.service, b.expected]),
    );

    projected.push({
      host,
      role: pyOrEmptyTrimmed(item['role']),
      collectorRemote: pyBool(item['collectorRemote']),
      instances,
    });
  }
  projected.sort((a, b) => compareStringTuples([a.host], [b.host]));

  return { schemaVersion: data['schemaVersion'], hosts: projected };
}

// Canonical JSON encoder matching Python's
// `json.dumps(value, sort_keys=True, separators=(",", ":"))` byte-for-byte,
// including its default `ensure_ascii=True` (non-ASCII code points escaped as
// lowercase `\uXXXX`, astral characters as UTF-16 surrogate pairs) so the
// UTF-8 bytes hashed on both sides are identical even for non-ASCII input.
function pyJsonEncodeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case '\\':
        out += '\\\\';
        continue;
      case '\n':
        out += '\\n';
        continue;
      case '\r':
        out += '\\r';
        continue;
      case '\t':
        out += '\\t';
        continue;
      case '\b':
        out += '\\b';
        continue;
      case '\f':
        out += '\\f';
        continue;
      default:
        break;
    }
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code > 0x7e) {
      if (code > 0xffff) {
        const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
        const low = ((code - 0x10000) % 0x400) + 0xdc00;
        out += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
      } else {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
      }
    } else {
      out += ch;
    }
  }
  out += '"';
  return out;
}

function pyJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RosterPortError('cannot encode non-finite number in roster identity projection');
    }
    return String(value);
  }
  if (typeof value === 'string') return pyJsonEncodeString(value);
  if (Array.isArray(value)) return `[${value.map((item) => pyJsonStringify(item)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => `${pyJsonEncodeString(key)}:${pyJsonStringify(value[key])}`);
    return `{${parts.join(',')}}`;
  }
  throw new RosterPortError(`cannot encode value of type ${typeof value} in roster identity projection`);
}

/** `sha256(json.dumps(roster_identity(data), sort_keys=True, separators=(",",":")))`,
 * identical call shape to `bot_errors_roster.py:roster_digest` (:103-106). */
export function rosterDigest(data: unknown): string {
  return digestFromIdentity(rosterIdentity(data));
}

function digestFromIdentity(identity: RosterIdentity): string {
  const material = pyJsonStringify(identity);
  return createHash('sha256').update(Buffer.from(material, 'utf8')).digest('hex');
}

function isRuntimeRelevant(expected: string): boolean {
  return expected.trim() !== 'none';
}

/** Ported from `bot_errors_roster.py:roster_inventory` (:109-136). */
export function rosterInventory(data: unknown): RosterInventory {
  const identity = rosterIdentity(data);
  const hosts = identity.hosts;
  const expectedHosts = hosts.map((host) => host.host);
  const runtimeInstancesByHost: Record<string, number> = {};
  let expectedInstanceCount = 0;
  for (const host of hosts) {
    const count = host.instances.filter((inst) => isRuntimeRelevant(inst.expected)).length;
    if (count) {
      runtimeInstancesByHost[host.host] = count;
      expectedInstanceCount += count;
    }
  }
  const collectorRemoteHosts = hosts
    .filter((host) => host.collectorRemote)
    .map((host) => host.host)
    .sort();

  return {
    digest: digestFromIdentity(identity),
    expectedHosts,
    expectedHostCount: expectedHosts.length,
    expectedInstanceCount,
    runtimeInstancesByHost,
    collectorRemoteHosts,
    collectorRemoteHostCount: collectorRemoteHosts.length,
  };
}

/** Inventory epoch bound to the roster: the roster file mtime (int seconds),
 * ported from `bot_errors_roster.py:roster_epoch` (:159-169). Returns `null`
 * when the file cannot be stat'd, so a missing epoch is explicit rather than
 * silently zero. */
export function rosterEpoch(filePath: string): number | null {
  try {
    const stats = statSync(filePath);
    return Math.floor(stats.mtimeMs / 1000);
  } catch {
    return null;
  }
}
