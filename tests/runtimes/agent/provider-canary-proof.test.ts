import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CANARY_CONTRACT_VERSION,
  collectProviderCanaryEvidence,
  providerCanaryReceiptPath,
  validateProviderCanaryAdmission,
  validateProviderCanaryReceipt,
  type ProviderCanaryEvidence,
  type ProviderCanaryReceipt,
} from '../../../src/runtimes/agent/provider-canary-proof.ts';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function evidence(overrides: Partial<ProviderCanaryEvidence> = {}): ProviderCanaryEvidence {
  return {
    providerId: 'codex-cli',
    platform: 'darwin',
    architecture: 'arm64',
    binaryVersion: '1.2.3',
    entrypointDigest: 'a'.repeat(64),
    proxyDigest: 'b'.repeat(64),
    ...overrides,
  };
}

function receipt(overrides: Partial<ProviderCanaryReceipt> = {}): ProviderCanaryReceipt {
  return {
    schemaVersion: 1,
    contractVersion: CANARY_CONTRACT_VERSION,
    providerId: 'codex-cli',
    recordedAt: '2026-07-23T11:00:00.000Z',
    platform: 'darwin',
    architecture: 'arm64',
    binaryVersion: '1.2.3',
    entrypointDigest: 'a'.repeat(64),
    proxyDigest: 'b'.repeat(64),
    dynamicInitialize: true,
    dynamicToolsList: true,
    staticConnections: 0,
    proxyDescendant: true,
    processGroupReaped: true,
    ...overrides,
  };
}

describe('provider canary receipt', () => {
  it('accepts a fresh exact artifact-bound proof', () => {
    expect(validateProviderCanaryReceipt(receipt(), evidence(), NOW)).toEqual({
      proven: true,
      reason: 'proven',
    });
  });

  it.each([
    ['contractVersion', 'old'],
    ['providerId', 'claude-cli'],
    ['platform', 'linux'],
    ['architecture', 'x64'],
    ['binaryVersion', '2.0.0'],
    ['entrypointDigest', 'c'.repeat(64)],
    ['proxyDigest', 'd'.repeat(64)],
    ['dynamicInitialize', false],
    ['dynamicToolsList', false],
    ['staticConnections', 1],
    ['proxyDescendant', false],
    ['processGroupReaped', false],
  ] as const)('fails closed on mismatched %s', (key, value) => {
    expect(validateProviderCanaryReceipt(
      receipt({ [key]: value } as Partial<ProviderCanaryReceipt>),
      evidence(),
      NOW,
    )).toMatchObject({ proven: false });
  });

  it('keeps old artifact-matching receipts durable and rejects future, malformed, and secret-shaped receipts', () => {
    expect(validateProviderCanaryReceipt(
      receipt({ recordedAt: '2026-07-15T11:00:00.000Z' }),
      evidence(),
      NOW,
    )).toEqual({ proven: true, reason: 'proven' });
    expect(validateProviderCanaryReceipt(
      receipt({ recordedAt: '2026-07-23T12:10:00.000Z' }),
      evidence(),
      NOW,
    )).toEqual({ proven: false, reason: 'future' });
    expect(validateProviderCanaryReceipt({ bad: true }, evidence(), NOW))
      .toEqual({ proven: false, reason: 'malformed' });
    expect(validateProviderCanaryReceipt(
      { ...receipt(), output: 'forbidden-sensitive-material' },
      evidence(),
      NOW,
    )).toEqual({ proven: false, reason: 'malformed' });
  });

  it('uses a deterministic receipt path without embedding provider-controlled separators', () => {
    expect(providerCanaryReceiptPath('/state/root', 'codex-cli'))
      .toBe('/state/root/provider-canaries/codex-cli.json');
    expect(() => providerCanaryReceiptPath('/state/root', '../escape')).toThrow(/provider/);
  });

  it('reads the binary version without exposing the operator HOME or provider config', () => {
    const root = mkdtempSync(join(tmpdir(), 'provider-proof-version-'));
    roots.push(root);
    const hostHome = join(root, 'host-home');
    const binary = join(root, 'provider');
    const proxy = join(root, 'proxy.ts');
    mkdirSync(hostHome, { mode: 0o700 });
    writeFileSync(join(hostHome, 'forbidden-canary-config'), 'host-only');
    writeFileSync(binary, [
      '#!/bin/sh',
      'test ! -e "$HOME/forbidden-canary-config" || exit 9',
      'printf "provider 1.0\\n"',
    ].join('\n'));
    writeFileSync(proxy, 'proxy');
    chmodSync(binary, 0o700);
    const previousHome = process.env.HOME;
    process.env.HOME = hostHome;
    try {
      expect(collectProviderCanaryEvidence('codex-cli', binary, proxy))
        .toMatchObject({ binaryVersion: 'provider 1.0' });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

describe('provider canary admission scope', () => {
  it.each([
    [{ providerId: 'codex-cli', sessionScope: 'per_chat', sandboxPerChat: false }, true],
    [{ providerId: 'claude-cli', sessionScope: 'per_chat', sandboxPerChat: false }, true],
    [{ providerId: 'openai-api', sessionScope: 'per_chat', sandboxPerChat: false }, false],
    [{ providerId: 'codex-cli', sessionScope: 'shared', sandboxPerChat: false }, false],
    [{ providerId: 'codex-cli', sessionScope: 'single', sandboxPerChat: false }, false],
    [{ providerId: 'codex-cli', sessionScope: 'per_chat', sandboxPerChat: true }, false],
  ] as const)('scopes blocking to selected sensitive CLI mode: %j', (input, required) => {
    const result = validateProviderCanaryAdmission({
      ...input,
      receipt: null,
      evidence: evidence({ providerId: input.providerId }),
      nowMs: NOW,
    });
    expect(result.required).toBe(required);
    expect(result.allowed).toBe(!required);
  });

  it('allows only the selected provider when its receipt proves the current artifacts', () => {
    expect(validateProviderCanaryAdmission({
      providerId: 'codex-cli',
      sessionScope: 'per_chat',
      sandboxPerChat: false,
      receipt: receipt(),
      evidence: evidence(),
      nowMs: NOW,
    })).toEqual({ required: true, allowed: true, reason: 'proven' });
  });
});
