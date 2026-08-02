import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/validate-visual-manifest.mjs');

const tmp = trackTmpDirs('visual-');

interface FixtureOptions {
  mutate?: (manifest: Record<string, unknown>, fixture: Fixture) => void;
}

interface Fixture {
  dir: string;
  manifestPath: string;
  screenshotFor: (route: string, theme: string, viewport: string) => string;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const dir = tmp.make('manifest');
  mkdirSync(join(dir, 'screenshots'), { recursive: true });

  const fixture: Fixture = {
    dir,
    manifestPath: join(dir, 'manifest.json'),
    screenshotFor(route, theme, viewport) {
      return join(dir, 'screenshots', `${route}__${theme}__${viewport}.png`);
    },
  };

  const routes = [
    { name: 'fleet', path: '/' },
    { name: 'inbox', path: '/inbox' },
  ];
  const themes = ['dark', 'light'];
  const viewports = [
    { name: 'mobile', width: 390, height: 844 },
    { name: 'desktop', width: 1440, height: 900 },
  ];

  const artifacts = [];
  for (const route of routes) {
    for (const theme of themes) {
      for (const viewport of viewports) {
        const screenshot = fixture.screenshotFor(route.name, theme, viewport.name);
        writeFileSync(screenshot, Buffer.alloc(2048, 1));
        artifacts.push({
          route: route.name,
          path: route.path,
          url: `http://127.0.0.1:5177${route.path}`,
          theme,
          viewport,
          screenshot,
          bytes: 2048,
          dom: {
            bodyTextLength: 100,
            horizontalOverflow: false,
            rootRect: { width: viewport.width, height: viewport.height },
            theme,
            title: 'WhatSoup Console',
            verticalScrollable: false,
          },
          signals: {
            console: [],
            httpErrors: [],
            pageErrors: [],
            requestFailures: [],
          },
          verdict: 'PASS',
        });
      }
    }
  }

  const manifest: Record<string, unknown> = {
    artifacts,
    base_url: 'http://127.0.0.1:5177/',
    fixed_time_utc: '2026-06-13T12:00:00.000Z',
    generated_at_utc: '2026-06-13T12:01:00.000Z',
    reduced_motion: 'reduce',
    routes,
    run_id: 'fixture',
    themes,
    verdict: 'PASS',
    viewports,
  };

  options.mutate?.(manifest, fixture);
  writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return fixture;
}

function runScript(manifestPath: string | null) {
  return spawnSync(
    'node',
    manifestPath ? [SCRIPT, manifestPath] : [SCRIPT],
    {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function parsedOutput(result: ReturnType<typeof runScript>) {
  return JSON.parse(result.stdout) as {
    artifacts: { actual: number; expected: number };
    failures: Array<{ code: string; tuple?: string }>;
    signals: { console: number; httpErrors: number; pageErrors: number; requestFailures: number };
    verdict: 'PASS' | 'FAIL';
    warnings: Array<{ code: string }>;
  };
}

function firstArtifact(manifest: Record<string, unknown>) {
  const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
  return artifacts[0];
}

describe('validate-visual-manifest.mjs', () => {
  it('passes a complete route/theme/viewport matrix', () => {
    const fixture = makeFixture();
    const result = runScript(fixture.manifestPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.artifacts).toEqual({ actual: 8, expected: 8 });
    expect(output.failures).toEqual([]);
  });

  it('records console and HTTP signals without failing the manifest', () => {
    const fixture = makeFixture({
      mutate(manifest) {
        const artifact = firstArtifact(manifest);
        artifact.signals = {
          console: [{ type: 'warning', text: 'chart width pending' }],
          httpErrors: [{ url: '/api/version', status: 502 }],
          pageErrors: [],
          requestFailures: [{ url: '/api/lines', failure: 'ECONNREFUSED' }],
        };
      },
    });
    const result = runScript(fixture.manifestPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.signals).toMatchObject({ console: 1, httpErrors: 1, requestFailures: 1 });
    expect(output.warnings.map((warning) => warning.code)).toContain('RECORDED_NON_BLOCKING_SIGNALS');
  });

  it('fails when the manifest file is absent', () => {
    const result = runScript(resolve(tmpdir(), 'missing-visual-manifest.json'));
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.failures.map((failure) => failure.code)).toContain('MISSING_MANIFEST');
  });

  it('fails when a declared matrix row is missing', () => {
    const fixture = makeFixture({
      mutate(manifest) {
        const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
        artifacts.pop();
      },
    });
    const result = runScript(fixture.manifestPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.failures.map((failure) => failure.code)).toContain('MISSING_ROW');
  });

  it('fails when a matrix row is duplicated', () => {
    const fixture = makeFixture({
      mutate(manifest) {
        const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
        artifacts.push({ ...artifacts[0] });
      },
    });
    const result = runScript(fixture.manifestPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.failures.map((failure) => failure.code)).toContain('DUPLICATE_ROW');
  });

  it('fails when a screenshot file is empty', () => {
    const fixture = makeFixture({
      mutate(manifest, fixtureRef) {
        const artifact = firstArtifact(manifest);
        const emptyPath = fixtureRef.screenshotFor('empty', 'dark', 'mobile');
        writeFileSync(emptyPath, Buffer.alloc(0));
        artifact.screenshot = emptyPath;
        artifact.bytes = 0;
      },
    });
    const result = runScript(fixture.manifestPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.failures.map((failure) => failure.code)).toContain('SCREENSHOT_EMPTY_FILE');
    expect(output.failures.map((failure) => failure.code)).toContain('SCREENSHOT_EMPTY_MANIFEST');
  });

  it('fails when a screenshot file is missing', () => {
    const fixture = makeFixture({
      mutate(manifest) {
        const artifact = firstArtifact(manifest);
        artifact.screenshot = resolve(tmpdir(), 'missing-shot.png');
      },
    });
    const result = runScript(fixture.manifestPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.failures.map((failure) => failure.code)).toContain('SCREENSHOT_MISSING');
  });

  it('fails when the DOM proof is empty', () => {
    const fixture = makeFixture({
      mutate(manifest) {
        const artifact = firstArtifact(manifest);
        artifact.dom = { bodyTextLength: 0 };
      },
    });
    const result = runScript(fixture.manifestPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.failures.map((failure) => failure.code)).toContain('EMPTY_DOM');
  });

  it('fails when a browser page error was captured', () => {
    const fixture = makeFixture({
      mutate(manifest) {
        const artifact = firstArtifact(manifest);
        artifact.signals = {
          console: [],
          httpErrors: [],
          pageErrors: ['Cannot read properties of null'],
          requestFailures: [],
        };
      },
    });
    const result = runScript(fixture.manifestPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.failures.map((failure) => failure.code)).toContain('PAGE_ERROR');
    expect(output.signals.pageErrors).toBe(1);
  });

  it('fails when an artifact verdict is not PASS', () => {
    const fixture = makeFixture({
      mutate(manifest) {
        const artifact = firstArtifact(manifest);
        artifact.verdict = 'FAIL';
      },
    });
    const result = runScript(fixture.manifestPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.failures.map((failure) => failure.code)).toContain('ARTIFACT_VERDICT');
  });

  it('fails when the top-level manifest verdict is not PASS', () => {
    const fixture = makeFixture({
      mutate(manifest) {
        manifest.verdict = 'FAIL';
      },
    });
    const result = runScript(fixture.manifestPath);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.failures.map((failure) => failure.code)).toContain('MANIFEST_VERDICT');
  });
});
