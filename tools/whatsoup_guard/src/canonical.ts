import { createHash } from 'node:crypto';
import type { ProbeDoc } from './types.ts';

export function canonicalize(value: unknown): string {
  const serialized = JSON.stringify(normalizeCanonical(value, [], new WeakSet()));
  if (serialized === undefined) {
    throw new Error('Unsupported canonical value at $: serialization failed');
  }
  return serialized;
}

function normalizeCanonical(value: unknown, path: PathSegment[], ancestors: WeakSet<object>): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (Number.isFinite(value)) return value;
      throw unsupported(path, 'non-finite number');
    case 'undefined':
      throw unsupported(path, 'undefined');
    case 'function':
      throw unsupported(path, 'function');
    case 'symbol':
      throw unsupported(path, 'symbol');
    case 'bigint':
      throw unsupported(path, 'bigint');
    case 'object':
      return normalizeObject(value, path, ancestors);
  }
}

type PathSegment = string | number;

function normalizeObject(value: object, path: PathSegment[], ancestors: WeakSet<object>): unknown {
  if (ancestors.has(value)) throw unsupported(path, 'circular reference');
  if (Array.isArray(value)) {
    ancestors.add(value);
    const out: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const childPath = [...path, index];
      if (!(index in value)) throw unsupported(childPath, 'sparse array item');
      out.push(normalizeCanonical(value[index], childPath, ancestors));
    }
    ancestors.delete(value);
    return out;
  }

  if (!isPlainObject(value)) throw unsupported(path, 'non-plain object');

  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) throw unsupported(path, 'symbol key');

  ancestors.add(value);
  try {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = normalizeCanonical((value as Record<string, unknown>)[k], [...path, k], ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unsupported(path: PathSegment[], reason: string): Error {
  return new Error(`Unsupported canonical value at ${formatPath(path)}: ${reason}`);
}

function formatPath(path: PathSegment[]): string {
  return path.reduce<string>((out, segment) => {
    if (typeof segment === 'number') return `${out}[${segment}]`;
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) return `${out}.${segment}`;
    return `${out}[${JSON.stringify(segment)}]`;
  }, '$');
}

export interface StructuralDiff {
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, { from: unknown; to: unknown }>;
}

export function structuralDiff(observed: ProbeDoc, baseline: ProbeDoc): StructuralDiff {
  const a = (observed.fields ?? {}) as Record<string, unknown>;
  const b = (baseline.fields ?? {}) as Record<string, unknown>;
  const added: Record<string, unknown> = {};
  const removed: Record<string, unknown> = {};
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(a)) {
    if (!(k in b)) added[k] = a[k];
    else if (canonicalize(a[k]) !== canonicalize(b[k])) changed[k] = { from: b[k], to: a[k] };
  }
  for (const k of Object.keys(b)) {
    if (!(k in a)) removed[k] = b[k];
  }
  return { added, removed, changed };
}

export function fingerprint(probeId: string, observed: ProbeDoc, baseline: ProbeDoc): string {
  const diff = structuralDiff(observed, baseline);
  return createHash('sha256').update(probeId + canonicalize(diff)).digest('hex');
}
