import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-brand-assets.mjs');

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

interface FixtureOptions {
  extraPublicFiles?: Record<string, string>;
  favicon?: string;
  index?: string;
  manifest?: string | null;
}

function makeFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brand-assets-'));
  tmpDirs.push(root);
  const favicon = join(root, 'console/public/favicon.svg');
  const index = join(root, 'console/index.html');
  const manifest = join(root, 'console/public/manifest.webmanifest');
  mkdirSync(dirname(favicon), { recursive: true });
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(
    favicon,
    options.favicon ?? '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><title>SOUP</title><path fill="currentColor" d="M12 12h24v24H12z"/></svg>\n',
  );
  writeFileSync(
    index,
    options.index ?? '<!doctype html><html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><link rel="manifest" href="/manifest.webmanifest" /></head><body></body></html>\n',
  );
  if (options.manifest !== null) {
    writeFileSync(
      manifest,
      options.manifest ?? JSON.stringify({ icons: [{ src: '/favicon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' }] }, null, 2),
    );
  }
  for (const [path, content] of Object.entries(options.extraPublicFiles ?? {})) {
    const target = join(root, 'console/public', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { favicon, index, manifest, root };
}

function runScript(fixture: ReturnType<typeof makeFixture>, extraArgs: string[] = []) {
  return spawnSync(
    'node',
    [
      SCRIPT,
      '--favicon',
      fixture.favicon,
      '--index',
      fixture.index,
      '--manifest',
      fixture.manifest,
      ...extraArgs,
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  );
}

function parsedOutput(result: ReturnType<typeof runScript>) {
  return JSON.parse(result.stdout) as {
    by_rule: Record<string, number>;
    failure_count: number;
    failures: Array<{ code: string; message: string; target: string }>;
    finding_count: number;
    mode: 'report-only' | 'fail-on-findings';
    verdict: 'PASS' | 'FAIL';
  };
}

describe('check-brand-assets.mjs', () => {
  it('passes a square local monogram favicon with manifest and maskable icon coverage', () => {
    const fixture = makeFixture();
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.finding_count).toBe(0);
    expect(output.failure_count).toBe(0);
  });

  it('reports the legacy purple/blue blurred bolt favicon without failing report-only mode', () => {
    const fixture = makeFixture({
      favicon: '<svg width="48" height="46" viewBox="0 0 48 46"><path fill="#863bff"/><mask id="m"/><filter id="f"><feGaussianBlur stdDeviation="4"/></filter><path fill="#47bfff" style="fill:color(display-p3 .2799 .748 1)"/></svg>\n',
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.mode).toBe('report-only');
    expect(output.by_rule).toMatchObject({
      'soup/brand-asset-no-gradient-glow': 1,
      'soup/brand-asset-simple-glyph': 1,
      'soup/brand-favicon-legacy-palette': 1,
      'soup/brand-favicon-square-canvas': 2,
    });
  });

  it('can fail once report-only findings are promoted to blocking mode', () => {
    const fixture = makeFixture({
      favicon: '<svg width="48" height="46" viewBox="0 0 48 46"><path fill="#7e14ff"/></svg>\n',
    });
    const result = runScript(fixture, ['--fail-on-findings']);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mode).toBe('fail-on-findings');
    expect(output.by_rule['soup/brand-favicon-legacy-palette']).toBe(1);
  });

  it('reports missing PWA manifest and manifest link coverage', () => {
    const fixture = makeFixture({
      index: '<!doctype html><html><head><link rel="icon" href="/favicon.svg" /></head><body></body></html>\n',
      manifest: null,
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.by_rule['soup/brand-pwa-maskable-assets-missing']).toBe(2);
  });

  it('fails on legacy product or channel copy in peripheral artifacts', () => {
    const fixture = makeFixture({
      index: '<!doctype html><html><head><link rel="icon" href="/favicon.svg" /><link rel="manifest" href="/manifest.webmanifest" /></head><body>Soup Kitchen from WhatsApp</body></html>\n',
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.failures.filter((failure) => failure.code === 'PERIPHERAL_BRAND_COPY')).toHaveLength(2);
    expect(output.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PERIPHERAL_BRAND_COPY', target: fixture.index }),
    ]));
  });

  it('fails on legacy product or channel copy in nested public peripheral artifacts', () => {
    const fixture = makeFixture({
      extraPublicFiles: {
        'pwa/install.html': '<!doctype html><html><body>Soup Kitchen via WhatsApp</body></html>\n',
      },
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.failures.filter((failure) => failure.code === 'PERIPHERAL_BRAND_COPY')).toHaveLength(2);
    expect(output.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'PERIPHERAL_BRAND_COPY',
        target: join(fixture.root, 'console/public/pwa/install.html'),
      }),
    ]));
  });

  it('fails when a public SVG asset is not referenced by the shell, manifest, or console source', () => {
    const fixture = makeFixture({
      extraPublicFiles: {
        'unused.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />\n',
      },
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ORPHAN_PUBLIC_SVG',
        target: join(fixture.root, 'console/public/unused.svg'),
      }),
    ]));
  });

  it('fails when a nested public SVG asset is not referenced by the shell, manifest, or console source', () => {
    const fixture = makeFixture({
      extraPublicFiles: {
        'icons/unused.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />\n',
      },
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ORPHAN_PUBLIC_SVG',
        target: join(fixture.root, 'console/public/icons/unused.svg'),
      }),
    ]));
  });
});
