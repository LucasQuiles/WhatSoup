#!/usr/bin/env node
// Verify self-hosted font files, @font-face declarations, provenance hashes, and external-font drift.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '..');
const repoRoot = resolve(consoleRoot, '..');

const DEFAULT_FONTS_CSS = resolve(consoleRoot, 'src/styles/fonts.css');
const DEFAULT_FONTS_DIR = resolve(consoleRoot, 'public/fonts');
const DEFAULT_README = resolve(DEFAULT_FONTS_DIR, 'README.md');
const DEFAULT_EXTERNAL_SCAN_DIRS = ['console/index.html', 'console/src'];
const FONT_URL_RE = /fonts\.(?:googleapis|gstatic)\.com|use\.typekit\.net|@import\s+url\(["']?https?:\/\/[^"')]+font|url\(["']?https?:\/\/[^"')]+\.(?:woff2?|ttf|otf)/i;

function usage() {
  return `Usage: node console/scripts/check-font-assets.mjs [options]

Options:
  --fonts-css <path>       Font-face CSS. Default: console/src/styles/fonts.css
  --fonts-dir <path>       Self-hosted font directory. Default: console/public/fonts
  --readme <path>          Provenance README. Default: console/public/fonts/README.md
  --external-scan <path>   File or directory scanned for external font URLs. Repeatable.
                           Default: console/index.html and console/src
  --help                   Print this message.
`;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const opts = {
    externalScan: [],
    fontsCss: DEFAULT_FONTS_CSS,
    fontsDir: DEFAULT_FONTS_DIR,
    help: false,
    readme: DEFAULT_README,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--fonts-css') opts.fontsCss = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--fonts-dir') opts.fontsDir = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--readme') opts.readme = resolve(requireValue(argv, ++i, arg));
    else if (arg === '--external-scan') opts.externalScan.push(requireValue(argv, ++i, arg));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.externalScan.length === 0) opts.externalScan = DEFAULT_EXTERNAL_SCAN_DIRS;
  return opts;
}

function normalizeRepoPath(filePath) {
  return relative(repoRoot, filePath).replaceAll('\\', '/');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseDecl(block, property) {
  const match = new RegExp(`${property}\\s*:\\s*([^;]+);`, 'i').exec(block);
  return match?.[1]?.trim() ?? null;
}

function unquote(value) {
  return value.trim().replace(/^["']|["']$/g, '');
}

function parseFontFaces(css) {
  const faces = [];
  const uncommented = stripCssComments(css);
  for (const match of uncommented.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)) {
    const block = match[1];
    const src = parseDecl(block, 'src') ?? '';
    const url = /url\(["']?([^"')]+)["']?\)/.exec(src)?.[1] ?? null;
    faces.push({
      display: parseDecl(block, 'font-display'),
      family: parseDecl(block, 'font-family') ? unquote(parseDecl(block, 'font-family')) : null,
      format: /format\(["']?([^"')]+)["']?\)/.exec(src)?.[1] ?? null,
      line: css.slice(0, match.index).split(/\r?\n/).length,
      raw_src: src,
      url,
      weight: parseDecl(block, 'font-weight'),
    });
  }
  return faces;
}

function parseReadme(readme) {
  const entries = new Map();
  for (const line of readme.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const [file, weight, hash] = cells;
    if (!/\.woff2$/i.test(file)) continue;
    entries.set(file, { file, hash, weight });
  }
  return entries;
}

function walkTextFiles(path, files = []) {
  if (!existsSync(path)) return files;
  const stats = statSync(path);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkTextFiles(resolve(path, entry.name), files);
    }
  } else if (stats.isFile()) {
    files.push(path);
  }
  return files.sort();
}

function localFontFileFromUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return null;
  const match = /^\/fonts\/([^/]+\.woff2)$/i.exec(url);
  return match?.[1] ?? null;
}

function addFailure(failures, code, details) {
  failures.push({ code, ...details });
}

function compareFonts(paths, files) {
  const failures = [];
  const faces = parseFontFaces(files.fontsCss);
  const readmeEntries = parseReadme(files.readme);
  const referencedFiles = new Set();

  if (faces.length === 0) addFailure(failures, 'NO_FONT_FACES', { file: paths.fonts_css });

  for (const face of faces) {
    const file = localFontFileFromUrl(face.url);
    if (!face.family) addFailure(failures, 'FONT_FACE_MISSING_FAMILY', { line: face.line });
    if (!face.weight) addFailure(failures, 'FONT_FACE_MISSING_WEIGHT', { family: face.family, line: face.line });
    if (face.display !== 'swap') addFailure(failures, 'FONT_FACE_DISPLAY_NOT_SWAP', { display: face.display, family: face.family, line: face.line });
    if (face.format !== 'woff2') addFailure(failures, 'FONT_FACE_NOT_WOFF2', { family: face.family, format: face.format, line: face.line });
    if (!file) {
      addFailure(failures, 'FONT_FACE_NOT_SELF_HOSTED', { family: face.family, line: face.line, url: face.url });
      continue;
    }

    referencedFiles.add(file);
    const fontPath = resolve(paths.fonts_dir, file);
    const entry = readmeEntries.get(file);
    if (!existsSync(fontPath)) addFailure(failures, 'MISSING_FONT_FILE', { file });
    if (!entry) addFailure(failures, 'MISSING_README_ENTRY', { file });
    if (entry && face.weight && entry.weight !== face.weight) {
      addFailure(failures, 'README_WEIGHT_MISMATCH', { css_weight: face.weight, file, readme_weight: entry.weight });
    }
    if (existsSync(fontPath) && entry && sha256(fontPath) !== entry.hash) {
      addFailure(failures, 'README_HASH_MISMATCH', { file, expected: entry.hash, actual: sha256(fontPath) });
    }
  }

  const fontFiles = existsSync(paths.fonts_dir)
    ? readdirSync(paths.fonts_dir).filter((file) => /\.woff2$/i.test(file)).sort()
    : [];
  for (const file of fontFiles) {
    if (!readmeEntries.has(file)) addFailure(failures, 'UNTRACKED_FONT_FILE', { file });
    if (!referencedFiles.has(file)) addFailure(failures, 'UNUSED_FONT_FILE', { file });
  }
  for (const file of readmeEntries.keys()) {
    if (!fontFiles.includes(file)) addFailure(failures, 'README_ENTRY_WITHOUT_FILE', { file });
  }

  return {
    face_count: faces.length,
    failures,
    font_file_count: fontFiles.length,
    readme_entry_count: readmeEntries.size,
  };
}

function findExternalFontUrls(root, scanPaths) {
  const hits = [];
  for (const scanPath of scanPaths) {
    const absolute = resolve(root, scanPath);
    for (const file of walkTextFiles(absolute)) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!FONT_URL_RE.test(lines[i])) continue;
        hits.push({
          file: normalizeRepoPath(file),
          line: i + 1,
          text: lines[i].trim(),
        });
      }
    }
  }
  return hits;
}

function buildReport(opts) {
  const paths = {
    external_scan: opts.externalScan,
    fonts_css: opts.fontsCss,
    fonts_dir: opts.fontsDir,
    readme: opts.readme,
  };
  const failures = [];

  for (const [key, path] of Object.entries({ fonts_css: opts.fontsCss, fonts_dir: opts.fontsDir, readme: opts.readme })) {
    if (!existsSync(path)) addFailure(failures, 'MISSING_INPUT', { input: key, path });
  }

  let fontComparison = { face_count: 0, failures: [], font_file_count: 0, readme_entry_count: 0 };
  if (failures.length === 0) {
    fontComparison = compareFonts(paths, {
      fontsCss: readFileSync(opts.fontsCss, 'utf8'),
      readme: readFileSync(opts.readme, 'utf8'),
    });
  }
  failures.push(...fontComparison.failures);

  const externalFontUrls = findExternalFontUrls(repoRoot, opts.externalScan);
  for (const hit of externalFontUrls) addFailure(failures, 'EXTERNAL_FONT_URL', hit);

  return {
    external_font_url_count: externalFontUrls.length,
    face_count: fontComparison.face_count,
    failures,
    font_file_count: fontComparison.font_file_count,
    generated_at_utc: new Date().toISOString(),
    paths,
    readme_entry_count: fontComparison.readme_entry_count,
    schema_version: 1,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ERROR(args): ${err.message}\n\n${usage()}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  const report = buildReport(opts);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== 'PASS') process.exit(1);
}

main();
