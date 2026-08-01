import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-font-assets.mjs');

const tmp = trackTmpDirs('');

function hash(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

interface FixtureOptions {
  css?: string;
  fontContent?: string;
  readme?: string;
  extra?: (root: string) => void;
}

function makeFixture(options: FixtureOptions = {}) {
  const root = tmp.make('font-assets');
  const fontsCss = join(root, 'console/src/styles/fonts.css');
  const fontsDir = join(root, 'console/public/fonts');
  const readme = join(fontsDir, 'README.md');
  const fontContent = options.fontContent ?? 'font-bytes';

  mkdirSync(dirname(fontsCss), { recursive: true });
  mkdirSync(fontsDir, { recursive: true });
  writeFileSync(join(fontsDir, 'FixtureSans-Regular.woff2'), fontContent);
  writeFileSync(
    fontsCss,
    options.css ?? `
@font-face {
  font-family: "Fixture Sans";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/fonts/FixtureSans-Regular.woff2") format("woff2");
}
`,
  );
  writeFileSync(
    readme,
    options.readme ?? `
# Fixture fonts

| File | Weight | sha256 |
|---|---|---|
| FixtureSans-Regular.woff2 | 400 | ${hash(fontContent)} |
`,
  );
  options.extra?.(root);
  return { fontsCss, fontsDir, readme, root };
}

function runScript(fixture: ReturnType<typeof makeFixture>) {
  return spawnSync(
    'node',
    [
      SCRIPT,
      '--fonts-css',
      fixture.fontsCss,
      '--fonts-dir',
      fixture.fontsDir,
      '--readme',
      fixture.readme,
      '--external-scan',
      join(fixture.root, 'console/src'),
    ],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function parsedOutput(result: ReturnType<typeof runScript>) {
  return JSON.parse(result.stdout) as {
    external_font_url_count: number;
    face_count: number;
    failures: Array<{ code: string; file?: string }>;
    font_file_count: number;
    readme_entry_count: number;
    verdict: 'PASS' | 'FAIL';
  };
}

function failureCodes(result: ReturnType<typeof runScript>) {
  return parsedOutput(result).failures.map((failure) => failure.code);
}

describe('check-font-assets.mjs', () => {
  it('passes when font faces are self-hosted, documented, hashed, and swap-loaded', () => {
    const fixture = makeFixture();
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.face_count).toBe(1);
    expect(output.font_file_count).toBe(1);
    expect(output.readme_entry_count).toBe(1);
    expect(output.external_font_url_count).toBe(0);
  });

  it('fails when a README hash no longer matches the font file', () => {
    const fixture = makeFixture({
      readme: `
| File | Weight | sha256 |
|---|---|---|
| FixtureSans-Regular.woff2 | 400 | ${'0'.repeat(64)} |
`,
    });
    const result = runScript(fixture);

    expect(result.status).toBe(1);
    expect(failureCodes(result)).toContain('README_HASH_MISMATCH');
  });

  it('fails when @font-face points at an external font URL', () => {
    const fixture = makeFixture({
      css: `
@font-face {
  font-family: "Fixture Sans";
  font-weight: 400;
  font-display: swap;
  src: url("https://fonts.gstatic.com/s/fixture.woff2") format("woff2");
}
`,
    });
    const result = runScript(fixture);

    expect(result.status).toBe(1);
    expect(failureCodes(result)).toContain('FONT_FACE_NOT_SELF_HOSTED');
    expect(failureCodes(result)).toContain('UNUSED_FONT_FILE');
  });

  it('fails when font-display is not swap', () => {
    const fixture = makeFixture({
      css: `
@font-face {
  font-family: "Fixture Sans";
  font-weight: 400;
  font-display: block;
  src: url("/fonts/FixtureSans-Regular.woff2") format("woff2");
}
`,
    });
    const result = runScript(fixture);

    expect(result.status).toBe(1);
    expect(failureCodes(result)).toContain('FONT_FACE_DISPLAY_NOT_SWAP');
  });

  it('fails when a font file is present without README provenance and @font-face use', () => {
    const fixture = makeFixture({
      extra(root) {
        writeFileSync(join(root, 'console/public/fonts/Unused.woff2'), 'unused');
      },
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNTRACKED_FONT_FILE', file: 'Unused.woff2' }),
        expect.objectContaining({ code: 'UNUSED_FONT_FILE', file: 'Unused.woff2' }),
      ]),
    );
  });

  it('fails when external font URLs re-enter scanned source files', () => {
    const fixture = makeFixture({
      extra(root) {
        writeFileSync(join(root, 'console/src/remote-font.css'), '@import url("https://fonts.googleapis.com/css2?family=Fixture");\n');
      },
    });
    const result = runScript(fixture);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.external_font_url_count).toBe(1);
    expect(failureCodes(result)).toContain('EXTERNAL_FONT_URL');
  });
});
