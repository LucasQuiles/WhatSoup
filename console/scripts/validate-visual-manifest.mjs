#!/usr/bin/env node
// Validate a SOUP visual-capture manifest without launching a browser.
//
// The validator proves capture completeness and hard browser failures. It records
// console/http/request signals for review, but those signals are not pass/fail
// criteria because the dev-server mock path can emit expected backend proxy noise.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function usage() {
  return `Usage: node console/scripts/validate-visual-manifest.mjs <manifest.json>

Options:
  --help    Print this message.

The manifest path may also be supplied as VISUAL_MANIFEST_PATH.
`;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readJson(path) {
  if (!path || !existsSync(path)) {
    throw Object.assign(new Error(`manifest missing: ${path || '(none)'}`), { code: 'MISSING_MANIFEST' });
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw Object.assign(new Error(`manifest is not valid JSON: ${err.message}`), { code: 'BAD_JSON' });
  }
}

function tupleOf(artifact) {
  return `${artifact.route}::${artifact.theme}::${artifact.viewport?.name}`;
}

function screenshotPath(manifestPath, artifact) {
  const raw = artifact.screenshot;
  if (typeof raw !== 'string' || !raw) return null;
  return raw.startsWith('/') ? raw : resolve(dirname(manifestPath), raw);
}

function validateManifest(manifest, manifestPath) {
  const failures = [];
  const warnings = [];

  if (!isObject(manifest)) {
    failures.push({ code: 'MANIFEST_SHAPE', message: 'manifest root must be an object' });
    return resultFor(manifest, failures, warnings, {});
  }

  const routes = Array.isArray(manifest.routes) ? manifest.routes : [];
  const themes = Array.isArray(manifest.themes) ? manifest.themes : [];
  const viewports = Array.isArray(manifest.viewports) ? manifest.viewports : [];
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];

  if (!routes.length) failures.push({ code: 'NO_ROUTES', message: 'manifest.routes must be non-empty' });
  if (!themes.length) failures.push({ code: 'NO_THEMES', message: 'manifest.themes must be non-empty' });
  if (!viewports.length) failures.push({ code: 'NO_VIEWPORTS', message: 'manifest.viewports must be non-empty' });
  if (!artifacts.length) failures.push({ code: 'NO_ARTIFACTS', message: 'manifest.artifacts must be non-empty' });

  const expectedTuples = new Set();
  for (const route of routes) {
    for (const theme of themes) {
      for (const viewport of viewports) {
        expectedTuples.add(`${route.name}::${theme}::${viewport.name}`);
      }
    }
  }

  const seen = new Map();
  const signalSummary = {
    console: 0,
    httpErrors: 0,
    pageErrors: 0,
    requestFailures: 0,
  };

  for (const artifact of artifacts) {
    if (!isObject(artifact)) {
      failures.push({ code: 'ARTIFACT_SHAPE', message: 'artifact entries must be objects' });
      continue;
    }

    const tuple = tupleOf(artifact);
    if (seen.has(tuple)) {
      failures.push({ code: 'DUPLICATE_ROW', tuple, message: `duplicate artifact row: ${tuple}` });
    }
    seen.set(tuple, artifact);

    if (!expectedTuples.has(tuple)) {
      failures.push({ code: 'UNEXPECTED_ROW', tuple, message: `artifact row is not in the declared matrix: ${tuple}` });
    }

    const shotPath = screenshotPath(manifestPath, artifact);
    if (!shotPath) {
      failures.push({ code: 'SCREENSHOT_PATH', tuple, message: `artifact ${tuple} has no screenshot path` });
    } else if (!existsSync(shotPath)) {
      failures.push({ code: 'SCREENSHOT_MISSING', tuple, message: `screenshot missing for ${tuple}: ${shotPath}` });
    } else {
      const stat = statSync(shotPath);
      if (stat.size <= 0) {
        failures.push({ code: 'SCREENSHOT_EMPTY_FILE', tuple, message: `screenshot file is empty for ${tuple}: ${shotPath}` });
      }
      if (typeof artifact.bytes !== 'number' || artifact.bytes <= 0) {
        failures.push({ code: 'SCREENSHOT_EMPTY_MANIFEST', tuple, message: `manifest byte count is empty for ${tuple}` });
      } else if (artifact.bytes !== stat.size) {
        failures.push({
          code: 'SCREENSHOT_SIZE_MISMATCH',
          tuple,
          message: `manifest byte count ${artifact.bytes} does not match file size ${stat.size} for ${tuple}`,
        });
      }
    }

    if (!isObject(artifact.dom) || typeof artifact.dom.bodyTextLength !== 'number' || artifact.dom.bodyTextLength <= 0) {
      failures.push({ code: 'EMPTY_DOM', tuple, message: `artifact ${tuple} has empty rendered DOM text` });
    }

    const signals = isObject(artifact.signals) ? artifact.signals : {};
    for (const key of Object.keys(signalSummary)) {
      const count = Array.isArray(signals[key]) ? signals[key].length : 0;
      signalSummary[key] += count;
    }
    if (Array.isArray(signals.pageErrors) && signals.pageErrors.length > 0) {
      failures.push({ code: 'PAGE_ERROR', tuple, message: `artifact ${tuple} has ${signals.pageErrors.length} browser page error(s)` });
    }

    if (artifact.verdict !== 'PASS') {
      failures.push({ code: 'ARTIFACT_VERDICT', tuple, message: `artifact ${tuple} verdict is ${artifact.verdict}` });
    }
  }

  for (const tuple of expectedTuples) {
    if (!seen.has(tuple)) {
      failures.push({ code: 'MISSING_ROW', tuple, message: `missing artifact row: ${tuple}` });
    }
  }

  if (manifest.verdict !== 'PASS') {
    failures.push({ code: 'MANIFEST_VERDICT', message: `manifest verdict is ${manifest.verdict}` });
  }

  if (signalSummary.console || signalSummary.httpErrors || signalSummary.requestFailures) {
    warnings.push({
      code: 'RECORDED_NON_BLOCKING_SIGNALS',
      message: 'console, HTTP, or request-failure signals were recorded for reviewer inspection',
      signals: {
        console: signalSummary.console,
        httpErrors: signalSummary.httpErrors,
        requestFailures: signalSummary.requestFailures,
      },
    });
  }

  return resultFor(manifest, failures, warnings, {
    expectedRows: expectedTuples.size,
    actualRows: artifacts.length,
    signalSummary,
  });
}

function resultFor(manifest, failures, warnings, extras) {
  return {
    artifacts: {
      actual: extras.actualRows ?? 0,
      expected: extras.expectedRows ?? 0,
    },
    failures,
    manifest_verdict: isObject(manifest) ? manifest.verdict ?? null : null,
    schema_version: 1,
    signals: extras.signalSummary ?? {
      console: 0,
      httpErrors: 0,
      pageErrors: 0,
      requestFailures: 0,
    },
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    warnings,
  };
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true, manifestPath: null };
  }
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 1) {
    throw Object.assign(new Error(`expected one manifest path, got ${positional.length}`), { code: 'BAD_ARGS' });
  }
  const manifestPath = positional[0] ?? process.env.VISUAL_MANIFEST_PATH ?? null;
  return { help: false, manifestPath: manifestPath ? resolveManifestPath(manifestPath) : null };
}

function resolveManifestPath(rawPath) {
  const cwdPath = resolve(rawPath);
  if (existsSync(cwdPath) || rawPath.startsWith('/')) return cwdPath;
  return resolve(repoRoot, rawPath);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ERROR(args): ${err.message}\n\n${usage()}`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  let result;
  try {
    const manifest = readJson(args.manifestPath);
    result = validateManifest(manifest, args.manifestPath);
  } catch (err) {
    result = {
      artifacts: { actual: 0, expected: 0 },
      failures: [{ code: err.code ?? 'READ_ERROR', message: err.message }],
      manifest_verdict: null,
      schema_version: 1,
      signals: { console: 0, httpErrors: 0, pageErrors: 0, requestFailures: 0 },
      verdict: 'FAIL',
      warnings: [],
    };
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.verdict !== 'PASS') process.exit(1);
}

main();
