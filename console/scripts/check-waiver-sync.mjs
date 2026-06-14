#!/usr/bin/env node
// Checks that eslint suppression waiver tags in console/src stay synchronized
// with console/eslint-waivers.yaml. This is deliberately narrow: CSS policy
// waivers may live only in the registry, but source eslint disables must use a
// registered WVR id, and TS/TSX registry scopes must point at a file carrying
// the same source tag.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  const next = i !== -1 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : null;
}

const consoleRoot = resolve(
  argValue('--console-root') ??
    process.env.WAIVER_SYNC_CONSOLE_ROOT ??
    resolve(here, '..'),
);
const srcRoot = resolve(consoleRoot, 'src');
const waiversPath = resolve(
  argValue('--waivers') ??
    process.env.WAIVER_SYNC_WAIVERS_PATH ??
    join(consoleRoot, 'eslint-waivers.yaml'),
);

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walk(abs));
    } else if (/\.(?:ts|tsx)$/.test(ent.name)) {
      out.push(abs);
    }
  }
  return out;
}

function parseWaivers(raw) {
  const waivers = [];
  let current = null;
  let inScope = false;

  function flush() {
    if (current) waivers.push(current);
  }

  for (const line of raw.split('\n')) {
    const idMatch = /^\s+-\s+id:\s*(WVR-[0-9]+)\s*$/.exec(line);
    if (idMatch) {
      flush();
      current = { id: idMatch[1], scopes: [] };
      inScope = false;
      continue;
    }

    if (!current) continue;

    const inlineScope = /^\s+scope:\s*(.*?)\s*$/.exec(line);
    if (inlineScope) {
      inScope = true;
      const scope = inlineScope[1].trim();
      if (scope && scope !== '>' && scope !== '|') current.scopes.push(scope);
      continue;
    }

    if (!inScope) continue;

    const listScope = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (listScope) {
      current.scopes.push(listScope[1].trim());
      continue;
    }

    if (/^\s+[a-zA-Z_][\w-]*:\s*/.test(line)) {
      inScope = false;
    }
  }

  flush();
  return waivers;
}

function sourceFileFromScope(scope) {
  const match = /(console\/src\/[^\s),]+?\.(?:ts|tsx))(?:[:\s),]|$)/.exec(scope);
  return match?.[1] ?? null;
}

let waiversRaw;
try {
  waiversRaw = readFileSync(waiversPath, 'utf8');
} catch (e) {
  process.stderr.write(`ERROR(read:eslint-waivers.yaml): ${e.message}\n`);
  process.exit(2);
}

const waivers = parseWaivers(waiversRaw);
const registeredIds = new Set(waivers.map(w => w.id));
const sourceTags = [];
const untaggedSuppressions = [];
const lintDisablePattern = 'eslint-' + 'disable';

for (const abs of walk(srcRoot)) {
  const relFromConsole = relative(consoleRoot, abs);
  const rel = `console/${relFromConsole}`;
  const lines = readFileSync(abs, 'utf8').split('\n');
  for (const [idx, line] of lines.entries()) {
    if (!line.includes(lintDisablePattern)) continue;

    const ids = [...line.matchAll(/waiver:(WVR-[0-9]+)/g)].map(match => match[1]);
    if (ids.length === 0) {
      untaggedSuppressions.push({
        file: rel,
        line: idx + 1,
        evidence: line.trim(),
      });
      continue;
    }

    for (const id of ids) {
      sourceTags.push({
        id,
        file: rel,
        line: idx + 1,
      });
    }
  }
}

const sourceIds = new Set(sourceTags.map(tag => tag.id));
const sourceTagKeys = new Set(sourceTags.map(tag => `${tag.id} ${tag.file}`));

const unknownSourceIds = [...sourceIds]
  .filter(id => !registeredIds.has(id))
  .sort();

const staleRegistryScopes = [];
for (const waiver of waivers) {
  for (const scope of waiver.scopes) {
    const scopeFile = sourceFileFromScope(scope);
    if (!scopeFile) continue;
    if (!sourceTagKeys.has(`${waiver.id} ${scopeFile}`)) {
      staleRegistryScopes.push({
        id: waiver.id,
        scope_file: scopeFile,
      });
    }
  }
}

const issueCount =
  untaggedSuppressions.length + unknownSourceIds.length + staleRegistryScopes.length;

const output = {
  schema_version: 1,
  verdict: issueCount === 0 ? 'PASS' : 'FAIL',
  issue_count: issueCount,
  registered_count: registeredIds.size,
  source_tag_count: sourceTags.length,
  untagged_count: untaggedSuppressions.length,
  untagged_suppressions: untaggedSuppressions,
  unknown_source_ids: unknownSourceIds,
  stale_registry_scope_count: staleRegistryScopes.length,
  stale_registry_scopes: staleRegistryScopes,
  paths: {
    console_root: consoleRoot,
    src_root: srcRoot,
    waivers: waiversPath,
  },
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exit(issueCount === 0 ? 0 : 1);
