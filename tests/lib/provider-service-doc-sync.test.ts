import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { SERVICE_ENV_MAP } from '../../src/lib/provider-key-service.ts';
import { verifyFallbackCredential } from '../../src/runtimes/agent/providers/credential-verify.ts';

// Enforcement for the hand-maintained service lists in docs/configuration.md,
// which SERVICE_ENV_MAP's exact-map lock (provider-key-service.test.ts) can
// only name in a comment. Invariant: the doc lists may be deliberately
// PARTIAL, but every entry they do carry must be TRUE against the code.
// The probe set is derived behaviorally through verifyFallbackCredential so
// no internals need exporting. Every parser asserts a match floor first — a
// doc rewording that breaks a parser fails loudly here instead of passing
// vacuously; update the regex alongside the prose.
// Tooling constraint: regex literals here use \x60 for doc code-span
// backticks and avoid unbalanced raw parens (e.g. no ')' inside character
// classes) — the test-integrity scanner matches test-block parens on raw
// source and misparses otherwise.

const configurationMd = readFileSync(
  fileURLToPath(new URL('../../docs/configuration.md', import.meta.url)),
  'utf8',
);

/**
 * Behaviorally classify a service against a probing 200-OK fake fetch:
 * 'probed' (probe fired, key accepted), 'unprobed' (fail-open unknown, no
 * fetch), or a description of any unexpected combination for the test to
 * reject.
 */
async function classifyProbe(service: string): Promise<string> {
  const fetchSpy = vi.fn(async () => ({ status: 200, ok: true }));
  const result = await verifyFallbackCredential(
    service,
    'sync-check-key',
    fetchSpy as unknown as typeof fetch,
  );
  const fetched = fetchSpy.mock.calls.length > 0;
  if (result === 'valid' && fetched) return 'probed';
  if (result === 'unknown' && !fetched) return 'unprobed';
  return 'unexpected: result=' + result + ' fetched=' + String(fetched);
}

describe('docs/configuration.md provider service lists stay true to the code', () => {
  it('env-var table rows all match SERVICE_ENV_MAP', () => {
    const lines = configurationMd.split('\n');
    const headerIdx = lines.findIndex((l) =>
      /\|\s*Provider service\s*\|\s*Environment variable\s*\|/.test(l),
    );
    expect(headerIdx, 'env-var table header must exist (parser anchor)').toBeGreaterThan(-1);

    const rows: Array<[string, string]> = [];
    for (let i = headerIdx + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
      const m = /^\s*\|\s*\x60([a-z0-9_-]+)\x60\s*\|\s*\x60([A-Z0-9_]+)\x60\s*\|\s*$/.exec(lines[i]);
      if (m) rows.push([m[1], m[2]]);
    }
    expect(rows.length, 'parser floor: table must yield rows').toBeGreaterThanOrEqual(8);

    for (const [service, envVar] of rows) {
      expect(
        SERVICE_ENV_MAP[service],
        'configuration.md table row ' + service + ' -> ' + envVar + ' disagrees with SERVICE_ENV_MAP',
      ).toBe(envVar);
    }
  });

  it('the documented probed-service list is exactly the set whose probe fires', async () => {
    const m = /verified probe endpoint: ((?:\x60[a-z0-9_-]+\x60(?:, (?:and )?|, | and )?)+)/.exec(
      configurationMd,
    );
    expect(m, 'probed-list sentence must exist (parser anchor)').not.toBeNull();
    const documented = [...m![1].matchAll(/\x60([a-z0-9_-]+)\x60/g)].map((x) => x[1]).sort();
    expect(documented.length, 'parser floor: probed list must yield entries').toBeGreaterThanOrEqual(3);

    const behavioral: string[] = [];
    for (const service of Object.keys(SERVICE_ENV_MAP)) {
      const classification = await classifyProbe(service);
      expect(
        classification,
        'service ' + service + ' must classify cleanly as probed/unprobed',
      ).toMatch(/^(probed|unprobed)$/);
      if (classification === 'probed') behavioral.push(service);
    }
    // "only for services with a verified probe endpoint" is a completeness
    // claim — compare both directions.
    expect(documented).toEqual(behavioral.sort());
  });

  it('every service named in the no-probe prose is mapped and genuinely unprobed', async () => {
    const m = /All other keyring services \((.*?)\) have no validity probe/.exec(configurationMd);
    expect(m, 'no-probe sentence must exist (parser anchor)').not.toBeNull();
    const documented = [...m![1].matchAll(/\x60([a-z0-9_-]+)\x60/g)].map((x) => x[1]);
    expect(documented.length, 'parser floor: no-probe list must yield entries').toBeGreaterThanOrEqual(5);

    for (const service of documented) {
      expect(
        SERVICE_ENV_MAP[service],
        'no-probe prose names ' + service + ', which is not in SERVICE_ENV_MAP',
      ).toBeDefined();
      const classification = await classifyProbe(service);
      expect(
        classification,
        service + ' is documented as unprobed but the probe behaves otherwise',
      ).toBe('unprobed');
    }
  });
});
