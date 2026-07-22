import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  admitRiskClassificationReceipt,
  createRiskClassificationReceipt,
  MAX_CLASSIFICATION_RECEIPT_BYTES,
  matchesSameProcessRiskClassificationAdmission,
  RiskClassificationReceiptError,
  riskClassificationEvidenceDigest,
  serializeRiskClassification,
} from '../../scripts/lib/ci-control/classification-admission.ts';
import type {
  ExactRevisionInput,
  RiskClassificationV1,
} from '../../scripts/lib/ci-control/classifier.ts';
import { digestControlManifest, loadControlManifest } from '../../scripts/lib/ci-control/manifest.ts';
import {
  canonicalizeBoundaryRun,
  sha256Bytes,
} from '../../scripts/lib/verification/boundary-run/shared.ts';

const projectRoot = resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture Author',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function commit(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function fixture(path = 'docs/guide.md'): {
  root: string;
  trustedInput: ExactRevisionInput;
} {
  const root = mkdtempSync(join(tmpdir(), 'ci-control-classification-admission-'));
  temporaryRoots.push(root);
  git(root, ['init', '--quiet']);
  mkdirSync(join(root, 'controls'), { recursive: true });
  cpSync(join(projectRoot, 'controls/ci-control-manifest.json'), join(root, 'controls/ci-control-manifest.json'));
  write(root, 'docs/guide.md', 'base guide\n');
  write(root, 'src/example.ts', 'export const value = 1;\n');
  write(root, 'tests/example.test.ts', 'export {};\n');
  const baseOid = commit(root, 'base');
  const manifestDigest = digestControlManifest(loadControlManifest(root));
  write(root, path, 'candidate content\n');
  const candidateOid = commit(root, 'candidate');
  return {
    root,
    trustedInput: {
      eventName: 'local',
      baseOid,
      candidateOid,
      mergeOid: null,
      manifestDigest,
    },
  };
}

function errorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RiskClassificationReceiptError);
    const receiptError = error as RiskClassificationReceiptError;
    expect(receiptError.outcome).toBe('inconclusive');
    expect(receiptError.exitCode).toBe(2);
    return receiptError.code;
  }
  throw new Error('expected RiskClassificationReceiptError');
}

function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(canonicalizeBoundaryRun(value), 'utf8');
}

function parsed(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
}

function setNested(record: Record<string, unknown>, key: string, value: unknown): void {
  record[key] = value;
}

function assertDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) assertDeeplyFrozen(nested);
}

function changedHex(value: string): string {
  const index = value.startsWith('sha256:') ? 'sha256:'.length : 0;
  const replacement = value[index] === 'a' ? 'b' : 'a';
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

function invokeWithReplacedMethod<T>(
  target: object,
  key: PropertyKey,
  replacement: (...args: unknown[]) => unknown,
  operation: () => T,
): { ok: true; value: T } | { ok: false; error: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) throw new Error('expected method descriptor');
  Object.defineProperty(target, key, { ...descriptor, value: replacement });
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return { ok: false, error };
  } finally {
    Object.defineProperty(target, key, descriptor);
  }
}

describe('strict exact-classification admission', () => {
  it('privately recognizes only genuine same-process report-only admission wrappers', () => {
    const { root, trustedInput } = fixture();
    const created = createRiskClassificationReceipt(root, trustedInput);
    const admitted = admitRiskClassificationReceipt(root, trustedInput, created.receiptBytes);

    expect(matchesSameProcessRiskClassificationAdmission(created)).toBe(true);
    expect(matchesSameProcessRiskClassificationAdmission(admitted)).toBe(true);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isExtensible(created)).toBe(false);
    expect(Object.getOwnPropertyDescriptors(created)).toMatchObject({
      authorization: { enumerable: true, configurable: false, writable: false },
      classification: { enumerable: true, configurable: false, writable: false },
      receiptBytes: { enumerable: true, configurable: false, writable: false },
      evidenceDigest: { enumerable: true, configurable: false, writable: false },
    });
    expect(created.authorization).toBe('report-only');
    expect(admitted.authorization).toBe('report-only');
    expect(Reflect.ownKeys(created)).toEqual([
      'authorization',
      'classification',
      'receiptBytes',
      'evidenceDigest',
    ]);
    expect('decision' in created).toBe(false);
    expect('exitCode' in created).toBe(false);
  });

  it('rejects cloned and coherently reconstructed wrappers despite identical public values', () => {
    const { root, trustedInput } = fixture();
    const created = createRiskClassificationReceipt(root, trustedInput);
    const cloned = structuredClone(created);
    const reconstructed = {
      authorization: created.authorization,
      classification: created.classification,
      receiptBytes: created.receiptBytes,
      evidenceDigest: created.evidenceDigest,
    };
    const detachedReconstruction = {
      authorization: created.authorization,
      classification: structuredClone(created.classification),
      receiptBytes: Uint8Array.from(created.receiptBytes),
      evidenceDigest: created.evidenceDigest,
    };

    expect(cloned).toEqual(created);
    expect(reconstructed).toEqual(created);
    expect(detachedReconstruction).toEqual(created);
    expect(matchesSameProcessRiskClassificationAdmission(cloned)).toBe(false);
    expect(matchesSameProcessRiskClassificationAdmission(reconstructed)).toBe(false);
    expect(matchesSameProcessRiskClassificationAdmission(detachedReconstruction)).toBe(false);
  });

  it('rejects hostile unbranded values without invoking their properties', () => {
    let getterCalls = 0;
    let proxyTrapCalls = 0;
    const hostile = Object.create({ inherited: true }) as Record<PropertyKey, unknown>;
    for (const key of ['authorization', 'classification', 'receiptBytes', 'evidenceDigest']) {
      Object.defineProperty(hostile, key, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          throw new Error('unbranded admission fields must not be read');
        },
      });
    }
    Object.defineProperty(hostile, Symbol('foreign'), {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('unbranded admission symbols must not be read');
      },
    });
    const hostileProxy = new Proxy({}, {
      get: () => {
        proxyTrapCalls += 1;
        throw new Error('unbranded proxy fields must not be read');
      },
      getOwnPropertyDescriptor: () => {
        proxyTrapCalls += 1;
        throw new Error('unbranded proxy descriptors must not be read');
      },
      getPrototypeOf: () => {
        proxyTrapCalls += 1;
        throw new Error('unbranded proxy prototype must not be read');
      },
      ownKeys: () => {
        proxyTrapCalls += 1;
        throw new Error('unbranded proxy keys must not be read');
      },
    });

    expect(matchesSameProcessRiskClassificationAdmission(hostile)).toBe(false);
    expect(matchesSameProcessRiskClassificationAdmission(hostileProxy)).toBe(false);
    expect(matchesSameProcessRiskClassificationAdmission(null)).toBe(false);
    expect(matchesSameProcessRiskClassificationAdmission('report-only')).toBe(false);
    expect(getterCalls).toBe(0);
    expect(proxyTrapCalls).toBe(0);
  });

  it('invalidates a genuine admission after receipt-byte mutation and keeps root fields immutable', () => {
    const { root, trustedInput } = fixture();
    const created = createRiskClassificationReceipt(root, trustedInput);

    expect(matchesSameProcessRiskClassificationAdmission(created)).toBe(true);
    expect(() => Object.defineProperty(created, 'authorization', { value: 'pass' })).toThrowError(TypeError);
    expect(() => Object.defineProperty(created, 'receiptBytes', { value: Uint8Array.from(created.receiptBytes) }))
      .toThrowError(TypeError);
    created.receiptBytes[0] = created.receiptBytes[0] === 0x7b ? 0x5b : 0x7b;
    expect(matchesSameProcessRiskClassificationAdmission(created)).toBe(false);
    expect(created.authorization).toBe('report-only');
  });

  it('returns false without throwing after a genuine receipt buffer is detached', () => {
    const { root, trustedInput } = fixture();
    const created = createRiskClassificationReceipt(root, trustedInput);

    expect(matchesSameProcessRiskClassificationAdmission(created)).toBe(true);
    structuredClone(created.receiptBytes, { transfer: [created.receiptBytes.buffer] });
    expect(created.receiptBytes.byteLength).toBe(0);
    expect(() => matchesSameProcessRiskClassificationAdmission(created)).not.toThrow();
    expect(matchesSameProcessRiskClassificationAdmission(created)).toBe(false);
  });

  it('uses captured WeakMap and Uint8Array primordials for the private binding boundary', () => {
    const { root, trustedInput } = fixture();
    const created = createRiskClassificationReceipt(root, trustedInput);

    const getResult = invokeWithReplacedMethod(
      WeakMap.prototype,
      'get',
      () => { throw new Error('dynamic WeakMap#get must not run'); },
      () => matchesSameProcessRiskClassificationAdmission(created),
    );
    expect(getResult).toEqual({ ok: true, value: true });

    const setResult = invokeWithReplacedMethod(
      WeakMap.prototype,
      'set',
      () => { throw new Error('dynamic WeakMap#set must not run'); },
      () => createRiskClassificationReceipt(root, trustedInput),
    );
    expect(setResult.ok).toBe(true);
    if (setResult.ok) {
      expect(matchesSameProcessRiskClassificationAdmission(setResult.value)).toBe(true);
    }

    const typedArraySetResult = invokeWithReplacedMethod(
      Object.getPrototypeOf(Uint8Array.prototype) as object,
      'set',
      () => { throw new Error('dynamic Uint8Array#set must not run'); },
      () => admitRiskClassificationReceipt(root, trustedInput, created.receiptBytes),
    );
    expect(typedArraySetResult.ok).toBe(true);
    if (typedArraySetResult.ok) {
      expect(matchesSameProcessRiskClassificationAdmission(typedArraySetResult.value)).toBe(true);
    }
  });

  it('uses captured Reflect.apply for every same-process admission intrinsic call', () => {
    const { root, trustedInput } = fixture();
    const created = createRiskClassificationReceipt(root, trustedInput);
    const originalReflectApply = Reflect.apply;
    const originalWeakMapGet = WeakMap.prototype.get;
    const reconstructed = Object.freeze({
      authorization: created.authorization,
      classification: created.classification,
      receiptBytes: created.receiptBytes,
      evidenceDigest: created.evidenceDigest,
    });
    const forgedBinding = Object.freeze({
      classification: reconstructed.classification,
      receiptBytes: reconstructed.receiptBytes,
      evidenceDigest: reconstructed.evidenceDigest,
      receiptBytesDigest: sha256Bytes(reconstructed.receiptBytes),
    });

    const forgeryResult = invokeWithReplacedMethod(
      Reflect,
      'apply',
      (...call) => {
        const [target, thisArgument, argumentsList] = call;
        if (target === originalWeakMapGet) return forgedBinding;
        return originalReflectApply(
          target as (...parameters: unknown[]) => unknown,
          thisArgument,
          argumentsList as ArrayLike<unknown>,
        );
      },
      () => matchesSameProcessRiskClassificationAdmission(reconstructed),
    );
    expect(forgeryResult).toEqual({ ok: true, value: false });

    const genuineResult = invokeWithReplacedMethod(
      Reflect,
      'apply',
      () => { throw new Error('dynamic Reflect.apply must not run'); },
      () => {
        const createdUnderPatch = createRiskClassificationReceipt(root, trustedInput);
        const admittedUnderPatch = admitRiskClassificationReceipt(
          root,
          trustedInput,
          createdUnderPatch.receiptBytes,
        );
        return {
          created: matchesSameProcessRiskClassificationAdmission(createdUnderPatch),
          admitted: matchesSameProcessRiskClassificationAdmission(admittedUnderPatch),
        };
      },
    );
    expect(genuineResult).toEqual({
      ok: true,
      value: { created: true, admitted: true },
    });
  });

  it('uses captured Uint8Array factory and constructor for exact admission bytes', () => {
    const { root, trustedInput } = fixture();
    const baseline = createRiskClassificationReceipt(root, trustedInput);
    const expectedBytes = Buffer.from(baseline.receiptBytes);

    const factoryResult = invokeWithReplacedMethod(
      Object.getPrototypeOf(Uint8Array) as object,
      'from',
      () => { throw new Error('dynamic Uint8Array.from must not run'); },
      () => {
        const created = createRiskClassificationReceipt(root, trustedInput);
        const admitted = admitRiskClassificationReceipt(root, trustedInput, baseline.receiptBytes);
        return { created, admitted };
      },
    );
    expect(factoryResult.ok).toBe(true);
    if (factoryResult.ok) {
      expect(Buffer.from(factoryResult.value.created.receiptBytes)).toEqual(expectedBytes);
      expect(Buffer.from(factoryResult.value.admitted.receiptBytes)).toEqual(expectedBytes);
      expect(matchesSameProcessRiskClassificationAdmission(factoryResult.value.created)).toBe(true);
      expect(matchesSameProcessRiskClassificationAdmission(factoryResult.value.admitted)).toBe(true);
    }

    const constructorResult = invokeWithReplacedMethod(
      globalThis,
      'Uint8Array',
      () => { throw new Error('dynamic Uint8Array constructor must not run'); },
      () => admitRiskClassificationReceipt(root, trustedInput, baseline.receiptBytes),
    );
    expect(constructorResult.ok).toBe(true);
    if (constructorResult.ok) {
      expect(Buffer.from(constructorResult.value.receiptBytes)).toEqual(expectedBytes);
      expect(matchesSameProcessRiskClassificationAdmission(constructorResult.value)).toBe(true);
    }
  });

  it('creates and admits stable canonical low-risk evidence as detached report-only snapshots', () => {
    const { root, trustedInput } = fixture();
    const created = createRiskClassificationReceipt(root, trustedInput);
    const admitted = admitRiskClassificationReceipt(root, trustedInput, created.receiptBytes);

    expect(created.authorization).toBe('report-only');
    expect(created.classification).toMatchObject({ outcome: 'pass', exitCode: 0, riskTier: 'low' });
    expect(created.receiptBytes).toEqual(serializeRiskClassification(created.classification));
    expect(admitted).toEqual(created);
    expect(admitted.evidenceDigest).toBe(riskClassificationEvidenceDigest(trustedInput, admitted.classification));
    expect(createRiskClassificationReceipt(root, trustedInput)).toEqual(created);
    expect(admitted.classification).not.toBe(created.classification);
    expect(admitted.receiptBytes).not.toBe(created.receiptBytes);
    assertDeeplyFrozen(created.classification);
    assertDeeplyFrozen(admitted.classification);
    expect(Object.isFrozen(created.classification.changed[0])).toBe(true);
    expect(Object.isFrozen(admitted.classification.changed[0])).toBe(true);

    const supplied = Uint8Array.from(created.receiptBytes);
    const detached = admitRiskClassificationReceipt(root, trustedInput, supplied);
    supplied.fill(0);
    expect(detached.receiptBytes).toEqual(created.receiptBytes);
    expect(() => (detached.classification.reasons as string[]).push('forged')).toThrowError(TypeError);
  });

  it('preserves a genuine unknown-path system-wide inconclusive result without narrowing selection', () => {
    const { root, trustedInput } = fixture('mystery/run.bin');
    const created = createRiskClassificationReceipt(root, trustedInput);
    const admitted = admitRiskClassificationReceipt(root, trustedInput, created.receiptBytes);

    expect(admitted.authorization).toBe('report-only');
    expect(admitted.classification).toMatchObject({
      outcome: 'inconclusive',
      exitCode: 2,
      riskTier: 'system-wide',
      reasons: ['ci.classification.unknown-path'],
    });
    const expectedControls = loadControlManifest(root).controls.map(({ id }) => id).sort();
    expect(admitted.classification.requiredControls).toEqual(expectedControls);
    expect(admitted.classification.requiredSuites).toEqual(['tests/example.test.ts']);

    const genuine = parsed(created.receiptBytes);
    const downgradeAttacks: Array<(value: Record<string, unknown>) => void> = [
      (value) => setNested(value, 'riskTier', 'low'),
      (value) => {
        setNested(value, 'outcome', 'pass');
        setNested(value, 'exitCode', 0);
      },
      (value) => setNested(value, 'requiredControls', expectedControls.slice(0, -1)),
      (value) => setNested(value, 'requiredSuites', []),
    ];
    for (const mutate of downgradeAttacks) {
      const attack = structuredClone(genuine);
      mutate(attack);
      expect(errorCode(() => admitRiskClassificationReceipt(root, trustedInput, canonicalBytes(attack))))
        .toBe('ci.classification.receipt.binding-mismatch');
    }
  });

  it('rejects every canonical mutation of classification decisions, facts, selections, and bindings', () => {
    const { root, trustedInput } = fixture();
    const receipt = createRiskClassificationReceipt(root, trustedInput);
    const source = parsed(receipt.receiptBytes);
    const changed = source.changed as Array<Record<string, unknown>>;
    expect(changed).toHaveLength(1);

    const mutations: Array<[string, (value: Record<string, unknown>) => void]> = [
      ['risk tier', (value) => setNested(value, 'riskTier', 'system-wide')],
      ['outcome', (value) => setNested(value, 'outcome', 'inconclusive')],
      ['exit', (value) => setNested(value, 'exitCode', 2)],
      ['reasons', (value) => setNested(value, 'reasons', ['ci.classification.unknown-path'])],
      ['changed facts', (value) => ((value.changed as Array<Record<string, unknown>>)[0]!.path = 'docs/forged.md')],
      ['controls', (value) => setNested(value, 'requiredControls', [])],
      ['suites', (value) => setNested(value, 'requiredSuites', ['tests/forged.test.ts'])],
      ['base OID', (value) => setNested(value, 'baseOid', changedHex(value.baseOid as string))],
      ['candidate OID', (value) => setNested(value, 'candidateOid', changedHex(value.candidateOid as string))],
      ['merge OID', (value) => setNested(value, 'mergeOid', 'c'.repeat(40))],
      ['merge-base OID', (value) => setNested(value, 'mergeBaseOid', changedHex(value.mergeBaseOid as string))],
      ['manifest digest', (value) => setNested(value, 'manifestDigest', changedHex(value.manifestDigest as string))],
      ['classifier digest', (value) => setNested(value, 'classifierDigest', changedHex(value.classifierDigest as string))],
      ['graph digest', (value) => setNested(value, 'graphDigest', changedHex(value.graphDigest as string))],
      ['change-set digest', (value) => setNested(value, 'changeSetDigest', changedHex(value.changeSetDigest as string))],
    ];

    for (const [label, mutate] of mutations) {
      const value = structuredClone(source);
      mutate(value);
      expect(errorCode(() => admitRiskClassificationReceipt(root, trustedInput, canonicalBytes(value))), label)
        .toBe('ci.classification.receipt.binding-mismatch');
    }
  });

  it('rejects strict JSON transport violations and canonical shape or array mutations', () => {
    const { root, trustedInput } = fixture();
    const receipt = createRiskClassificationReceipt(root, trustedInput);
    const raw = Buffer.from(receipt.receiptBytes).toString('utf8');
    const value = parsed(receipt.receiptBytes);

    const malformed = [
      Buffer.from(raw.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
      Uint8Array.from([0xff]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw)]),
      Buffer.from(raw.replace('\n', '\r\n')),
      Buffer.from(`${raw}x`),
    ];
    for (const bytes of malformed) {
      expect(errorCode(() => admitRiskClassificationReceipt(root, trustedInput, bytes)))
        .toBe('ci.classification.receipt.malformed');
    }

    const noncanonical = [
      Buffer.from(JSON.stringify(value), 'utf8'),
      Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
      Buffer.from(`${JSON.stringify(Object.fromEntries(Object.entries(value).reverse()))}\n`, 'utf8'),
      Buffer.from(` ${raw}`, 'utf8'),
    ];
    for (const bytes of noncanonical) {
      expect(errorCode(() => admitRiskClassificationReceipt(root, trustedInput, bytes)))
        .toBe('ci.classification.receipt.noncanonical');
    }

    const missing = structuredClone(value);
    delete missing.graphDigest;
    const extra = structuredClone(value);
    extra.untrusted = true;
    const reordered = structuredClone(value);
    reordered.requiredControls = [...(reordered.requiredControls as string[])].reverse();
    const duplicated = structuredClone(value);
    duplicated.reasons = [...(duplicated.reasons as string[]), ...(duplicated.reasons as string[])];
    for (const altered of [missing, extra, reordered, duplicated]) {
      expect(errorCode(() => admitRiskClassificationReceipt(root, trustedInput, canonicalBytes(altered))))
        .toBe('ci.classification.receipt.binding-mismatch');
    }
  });

  it('validates and snapshots a plain exact trusted input before classifier execution', () => {
    const { root, trustedInput } = fixture();
    let getterCalls = 0;
    const accessor = { ...trustedInput } as Record<string, unknown>;
    Object.defineProperty(accessor, 'candidateOid', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return trustedInput.candidateOid;
      },
    });
    const symbolic = { ...trustedInput, [Symbol('foreign')]: true };
    const extra = { ...trustedInput, foreign: true };
    const missing = { ...trustedInput } as Partial<ExactRevisionInput>;
    delete missing.baseOid;
    const noncanonical = { ...trustedInput, manifestDigest: 1n };
    class TrustedInputClass {}
    const classInstance = Object.assign(new TrustedInputClass(), trustedInput);

    for (const invalid of [accessor, symbolic, extra, missing, noncanonical, classInstance]) {
      expect(errorCode(() => createRiskClassificationReceipt(root, invalid as ExactRevisionInput)))
        .toBe('ci.classification.receipt.trusted-input-invalid');
    }
    expect(getterCalls).toBe(0);

    const mutable = { ...trustedInput };
    const created = createRiskClassificationReceipt(root, mutable);
    mutable.candidateOid = 'f'.repeat(40);
    mutable.eventName = 'push';
    expect(created.classification.candidateOid).toBe(trustedInput.candidateOid);
    expect(created.evidenceDigest).toBe(riskClassificationEvidenceDigest(trustedInput, created.classification));
  });

  it('binds eventName into evidence identity even when classification bytes are unchanged', () => {
    const { root, trustedInput } = fixture();
    const local = createRiskClassificationReceipt(root, trustedInput);
    const tagInput: ExactRevisionInput = { ...trustedInput, eventName: 'tag' };
    const tag = createRiskClassificationReceipt(root, tagInput);

    expect(tag.receiptBytes).toEqual(local.receiptBytes);
    expect(tag.evidenceDigest).not.toBe(local.evidenceDigest);
    expect(tag.evidenceDigest).toBe(riskClassificationEvidenceDigest(tagInput, tag.classification));
  });

  it('checks the exact byte boundary before parsing', () => {
    const { root, trustedInput } = fixture();
    expect(errorCode(() => admitRiskClassificationReceipt(
      root,
      trustedInput,
      Buffer.alloc(MAX_CLASSIFICATION_RECEIPT_BYTES, 0x7b),
    ))).toBe('ci.classification.receipt.malformed');
    expect(errorCode(() => admitRiskClassificationReceipt(
      root,
      trustedInput,
      Buffer.alloc(MAX_CLASSIFICATION_RECEIPT_BYTES + 1, 0x7b),
    ))).toBe('ci.classification.receipt.byte-budget');
  });

  it('uses the intrinsic typed-array length when a subclass understates oversized receipt bytes', () => {
    const { root, trustedInput } = fixture();
    class UnderstatedReceipt extends Uint8Array {
      override get byteLength(): number {
        return 0;
      }
    }
    const oversized = new UnderstatedReceipt(MAX_CLASSIFICATION_RECEIPT_BYTES + 1);
    Uint8Array.prototype.fill.call(oversized, 0x7b);

    expect(errorCode(() => admitRiskClassificationReceipt(root, trustedInput, oversized)))
      .toBe('ci.classification.receipt.byte-budget');
  });

  it('snapshots valid typed-array subclasses without invoking hostile getters, iterators, or species', () => {
    const { root, trustedInput } = fixture();
    const created = createRiskClassificationReceipt(root, trustedInput);
    class HostileReceipt extends Uint8Array {
      static get [Symbol.species](): Uint8ArrayConstructor {
        throw new Error('species must not run');
      }

      override get byteLength(): number {
        throw new Error('byteLength must not run');
      }

      override [Symbol.iterator](): ArrayIterator<number> {
        throw new Error('iterator must not run');
      }
    }
    const hostile = new HostileReceipt(created.receiptBytes);

    const admitted = admitRiskClassificationReceipt(root, trustedInput, hostile);
    expect(admitted).toEqual(created);
    expect(admitted.receiptBytes).not.toBe(hostile);
  });

  it('maps typed-array impostors to the exact malformed receipt error', () => {
    const { root, trustedInput } = fixture();
    const impostor = {
      byteLength: 0,
      [Symbol.iterator]: () => {
        throw new Error('iterator must not run');
      },
    };

    expect(errorCode(() => admitRiskClassificationReceipt(
      root,
      trustedInput,
      impostor as unknown as Uint8Array,
    ))).toBe('ci.classification.receipt.malformed');
  });

  it.each([
    ['Int8Array', (bytes: Uint8Array) => new Int8Array(bytes)],
    ['Uint8ClampedArray', (bytes: Uint8Array) => new Uint8ClampedArray(bytes)],
  ] as const)('rejects canonical receipt bytes carried by the wrong %s brand', (_brand, wrap) => {
    const { root, trustedInput } = fixture();
    const created = createRiskClassificationReceipt(root, trustedInput);
    const wrongBrand = wrap(created.receiptBytes);

    expect(errorCode(() => admitRiskClassificationReceipt(
      root,
      trustedInput,
      wrongBrand as unknown as Uint8Array,
    ))).toBe('ci.classification.receipt.malformed');
  });

  it('rejects a genuine candidate-A receipt against trusted candidate B without replacement', () => {
    const first = fixture();
    const receiptA = createRiskClassificationReceipt(first.root, first.trustedInput);
    write(first.root, 'docs/second.md', 'second candidate\n');
    const candidateOid = commit(first.root, 'candidate B');
    const trustedB: ExactRevisionInput = { ...first.trustedInput, candidateOid };
    const freshB = createRiskClassificationReceipt(first.root, trustedB);

    expect(freshB.receiptBytes).not.toEqual(receiptA.receiptBytes);
    expect(errorCode(() => admitRiskClassificationReceipt(first.root, trustedB, receiptA.receiptBytes)))
      .toBe('ci.classification.receipt.binding-mismatch');
  });

  it('rejects a one-byte canonical binding mutation and changes evidence identity', () => {
    const { root, trustedInput } = fixture();
    const receipt = createRiskClassificationReceipt(root, trustedInput);
    const mutatedBytes = Uint8Array.from(receipt.receiptBytes);
    const needle = Buffer.from(trustedInput.candidateOid, 'ascii');
    const index = Buffer.from(mutatedBytes).indexOf(needle);
    expect(index).toBeGreaterThanOrEqual(0);
    mutatedBytes[index] = mutatedBytes[index] === 0x61 ? 0x62 : 0x61;

    expect(errorCode(() => admitRiskClassificationReceipt(root, trustedInput, mutatedBytes)))
      .toBe('ci.classification.receipt.binding-mismatch');
    const mutated = parsed(mutatedBytes) as unknown as RiskClassificationV1;
    expect(riskClassificationEvidenceDigest(trustedInput, mutated)).not.toBe(receipt.evidenceDigest);
  });
});
