import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-brand-assets.mjs');

const tmp = trackTmpDirs('brand-');

interface FixtureOptions {
  extraConsoleFiles?: Record<string, string>;
  extraPublicFiles?: Record<string, string>;
  favicon?: string;
  index?: string;
  manifest?: string | null;
}

function makeFixture(options: FixtureOptions = {}) {
  const root = tmp.make('assets');
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
  for (const [path, content] of Object.entries(options.extraConsoleFiles ?? {})) {
    const target = join(root, 'console', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
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
    enforced_rules: string[];
    failure_count: number;
    failures: Array<{ code: string; message: string; target: string }>;
    failed_rules: string[];
    finding_count: number;
    mode: 'report-only' | 'fail-on-findings' | 'fail-on-rule';
    verdict: 'PASS' | 'FAIL';
  };
}

describe('check-brand-assets.mjs', () => {
  it('promotes the canonical favicon link rule in the console package script', () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'console/package.json'), 'utf8')) as { scripts?: Record<string, string> };

    expect(pkg.scripts?.['design:brand-assets']).toContain('--fail-on-rule soup/brand-favicon-link-required');
  });

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

  it('treats manifest icon purpose as tokens, not substrings', () => {
    const fixture = makeFixture({
      manifest: JSON.stringify({ icons: [{ src: '/favicon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any unmaskable' }] }, null, 2),
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.by_rule['soup/brand-pwa-maskable-assets-missing']).toBe(1);
  });

  it('reports maskable manifest icon sources that are not checked in under public', () => {
    const fixture = makeFixture({
      manifest: JSON.stringify({ icons: [{ src: '/icons/missing.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' }] }, null, 2),
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.by_rule['soup/brand-pwa-maskable-assets-missing']).toBe(1);
  });

  it('fails on a missing canonical favicon link when that zeroed rule is promoted', () => {
    const fixture = makeFixture({
      index: '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest" /></head><body></body></html>\n',
    });
    const result = runScript(fixture, ['--fail-on-rule', 'soup/brand-favicon-link-required']);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mode).toBe('fail-on-rule');
    expect(output.enforced_rules).toEqual(['soup/brand-favicon-link-required']);
    expect(output.failed_rules).toEqual(['soup/brand-favicon-link-required']);
    expect(output.by_rule['soup/brand-favicon-link-required']).toBe(1);
  });

  it('keeps unresolved PWA coverage report-only when only the favicon link rule is promoted', () => {
    const fixture = makeFixture({
      index: '<!doctype html><html><head><link rel="icon" href="/favicon.svg" /></head><body></body></html>\n',
      manifest: null,
    });
    const result = runScript(fixture, ['--fail-on-rule', 'soup/brand-favicon-link-required']);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.mode).toBe('fail-on-rule');
    expect(output.by_rule['soup/brand-pwa-maskable-assets-missing']).toBe(2);
    expect(output.failed_rules).toEqual([]);
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

  it('fails on legacy product or channel copy in referenced public SVG assets', () => {
    const fixture = makeFixture({
      extraConsoleFiles: {
        'src/IconPreview.tsx': 'export const iconPath = "/icons/used.svg";\n',
      },
      extraPublicFiles: {
        'icons/used.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>Soup Kitchen via WhatsApp</title></svg>\n',
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
        target: join(fixture.root, 'console/public/icons/used.svg'),
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

  it('does not treat prose basename mentions as public SVG references', () => {
    const fixture = makeFixture({
      extraPublicFiles: {
        'icons/unused.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />\n',
      },
      index: '<!doctype html><html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><link rel="manifest" href="/manifest.webmanifest" /><!-- icons/unused.svg was retired --></head><body></body></html>\n',
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

  it('accepts public SVG assets referenced by a console source path', () => {
    const fixture = makeFixture({
      extraConsoleFiles: {
        'src/IconPreview.tsx': 'export const iconPath = "/icons/used.svg";\n',
      },
      extraPublicFiles: {
        'icons/used.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />\n',
      },
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.failure_count).toBe(0);
  });

  it('does not count a matchable SVG reference that appears inside a comment', () => {
    // A real, regex-matchable reference (quoted path) commented out in source must
    // not keep the asset reachable — characterizes comment exclusion across the
    // span-based scan (line, block, and HTML comment forms).
    const fixture = makeFixture({
      extraConsoleFiles: {
        'src/CommentedRefs.tsx': [
          '// const retired = "/icons/commented.svg";',
          '/* export const old = "/icons/commented.svg" */',
          'export const x = 1;',
          '',
        ].join('\n'),
        'index.partial.html': '<!-- <img src="/icons/commented.svg" /> -->\n',
      },
      extraPublicFiles: {
        'icons/commented.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />\n',
      },
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ORPHAN_PUBLIC_SVG',
        target: join(fixture.root, 'console/public/icons/commented.svg'),
      }),
    ]));
  });
});
