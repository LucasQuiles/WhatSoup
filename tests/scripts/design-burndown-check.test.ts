import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

// Path to the script under test (resolved from repo root = process.cwd())
const SCRIPT = resolve(process.cwd(), 'console/scripts/check-design-burndown.mjs');

const tmp = trackTmpDirs('design-');

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface QueueFile {
  path: string;
  count: number;
  lines: number[] | null;
}

interface QueueItem {
  id: string;
  category: string;
  severity: 'blocking' | 'polish';
  count: number;
  files: QueueFile[];
  owner: string;
  source: string;
}

interface QueueDoc {
  schema_version: number;
  summary: { total: number; blocking: number; byCategory: Record<string, number> };
  items: QueueItem[];
}

const DEFAULT_SHADOW_BASELINE = {
  generated: 'shadow lint per-rule warning ceiling',
  total: 10,
  rules: {
    'soup/no-raw-button :: src/components/Foo.tsx': 3,
    'soup/no-legacy-tokens :: src/components/Bar.tsx': 7,
  },
};

// Semantic-token fixture: the "Legacy aliases" marker block is the derivation
// source for the legacy-name list (adoption-audit.md §6 methodology).
const DEFAULT_SEMANTIC_CSS = `/* tokens.semantic.css fixture — value-owning tier (raw colors sanctioned here) */
:root {
  --surface-base: #101012;
  --text-1: #e8e8ea;
  --border-subtle: #2a2a2e;
  --status-ok-solid: #22aa55;
}

/* --------------------------------------------------------------------------
   Legacy aliases — §7 migration map (fixture)
   -------------------------------------------------------------------------- */
:root {
  --color-d0: var(--surface-base);
  --color-t1: var(--text-1);
  --b2: var(--border-subtle);
  --color-s-ok: var(--status-ok-solid);
}
`;

const DEFAULT_PRIMITIVE_CSS = `/* tokens.primitive.css fixture — half-step DEFINITIONS (excluded from the scan) */
:root {
  --sp-0h: 3px;
  --sp-1h: 6px;
  --sp-2h: 10px;
  --sp-1: 4px;
}
`;

// Planted violations, one per CSS-side category, on known lines:
//   line 2: legacy var refs x2          (legacy-var-css)
//   line 3: status-bound primary button (accent-law + legacy-var-css overlap)
//   line 4: accent-color status token   (accent-law + legacy-var-css overlap)
//   line 5: raw hex literal             (raw-color-css)
//   line 6: half-step alias usage       (half-step)
const DEFAULT_COMPOSITES_CSS = `/* composites.css fixture */
.c-card { background: var(--color-d0); border-color: var(--b2); }
.c-btn-primary { background: var(--color-s-ok); }
input[type="checkbox"] { accent-color: var(--color-s-ok); }
.c-raw { color: #ff0000; }
.c-pad { padding: var(--sp-1h); }
`;

const DEFAULT_PRIMITIVES_CSS = '';

const DEFAULT_TSX = `export function Widget() {
  return <div style={{ paddingLeft: 'var(--sp-0h)' }}>x</div>;
}
`;

interface Fixture {
  root: string;
  consoleDir: string;
  stylesDir: string;
}

function makeFixture(opts: {
  shadowBaseline?: object | string;
  semanticCss?: string;
  primitiveCss?: string;
  primitivesCss?: string | null;
  compositesCss?: string;
  tsx?: string | null;
} = {}): Fixture {
  const root = tmp.make('burndown');

  const consoleDir = join(root, 'console');
  const stylesDir = join(consoleDir, 'src', 'styles');
  const componentsDir = join(consoleDir, 'src', 'components');
  mkdirSync(stylesDir, { recursive: true });
  mkdirSync(componentsDir, { recursive: true });

  const shadowBaseline = opts.shadowBaseline ?? DEFAULT_SHADOW_BASELINE;
  writeFileSync(
    join(consoleDir, 'lint-shadow-baseline.json'),
    typeof shadowBaseline === 'string' ? shadowBaseline : JSON.stringify(shadowBaseline, null, 2)
  );

  writeFileSync(join(stylesDir, 'tokens.semantic.css'), opts.semanticCss ?? DEFAULT_SEMANTIC_CSS);
  writeFileSync(join(stylesDir, 'tokens.primitive.css'), opts.primitiveCss ?? DEFAULT_PRIMITIVE_CSS);
  writeFileSync(join(stylesDir, 'composites.css'), opts.compositesCss ?? DEFAULT_COMPOSITES_CSS);
  if (opts.primitivesCss !== null) {
    writeFileSync(join(stylesDir, 'primitives.css'), opts.primitivesCss ?? DEFAULT_PRIMITIVES_CSS);
  }

  const tsx = opts.tsx === undefined ? DEFAULT_TSX : opts.tsx;
  if (tsx !== null) {
    writeFileSync(join(componentsDir, 'Widget.tsx'), tsx);
  }

  return { root, consoleDir, stylesDir };
}

function runScript(fixture: Fixture, extraArgs: string[] = []) {
  return spawnSync('node', [SCRIPT, ...extraArgs], {
    env: {
      ...process.env,
      DESIGN_BURNDOWN_CONSOLE_ROOT: fixture.consoleDir,
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function readQueue(fixture: Fixture): QueueDoc {
  return JSON.parse(
    readFileSync(join(fixture.consoleDir, 'design-burndown-queue.json'), 'utf8')
  ) as QueueDoc;
}

function itemOf(queue: QueueDoc, category: string): QueueItem {
  const item = queue.items.find((i) => i.category === category);
  if (!item) throw new Error(`queue has no item for category ${category}`);
  return item;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('check-design-burndown.mjs', () => {
  describe('scanners fire on planted violations (negative fixtures)', () => {
    it('legacy-var-css fires with exact file:line for planted legacy var() refs', () => {
      const fixture = makeFixture();
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const item = itemOf(readQueue(fixture), 'legacy-var-css');
      expect(item.severity).toBe('blocking');
      const comp = item.files.find((f) => f.path === 'src/styles/composites.css');
      expect(comp).toBeDefined();
      // line 2: --color-d0 + --b2; line 3: --color-s-ok; line 4: --color-s-ok
      expect(comp!.lines).toEqual([2, 3, 4]);
      expect(comp!.count).toBe(4);
      // The alias DEFINITION lines in tokens.semantic.css must NOT be counted
      expect(item.files.some((f) => f.path === 'src/styles/tokens.semantic.css')).toBe(false);
    });

    it('accent-law fires on a status-bound primary button AND an accent-color declaration', () => {
      const fixture = makeFixture();
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const item = itemOf(readQueue(fixture), 'accent-law');
      expect(item.severity).toBe('blocking');
      expect(item.count).toBe(2);
      const comp = item.files.find((f) => f.path === 'src/styles/composites.css');
      expect(comp).toBeDefined();
      // line 3: .c-btn-primary -> var(--color-s-ok); line 4: accent-color: var(--color-s-ok)
      expect(comp!.lines).toEqual([3, 4]);
    });

    it('accent-law does NOT fire on status-semantic button variants (.c-btn-danger)', () => {
      const fixture = makeFixture({
        compositesCss: `.c-btn-danger { border-color: var(--color-s-ok); }\n`,
      });
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);
      const item = itemOf(readQueue(fixture), 'accent-law');
      expect(item.count).toBe(0);
      expect(item.files).toEqual([]);
    });

    it('raw-color-css fires on a raw hex literal outside the token-definition tiers', () => {
      const fixture = makeFixture();
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const item = itemOf(readQueue(fixture), 'raw-color-css');
      expect(item.count).toBe(1);
      expect(item.files).toEqual([
        { path: 'src/styles/composites.css', count: 1, lines: [5] },
      ]);
      // Hex literals in tokens.semantic.css (value-owning tier) are allowlisted
      expect(item.files.some((f) => f.path === 'src/styles/tokens.semantic.css')).toBe(false);
    });

    it('raw-color-css fires on rgba() inside CSS box-shadow declarations', () => {
      const fixture = makeFixture({
        compositesCss: `.c-kpi-hover:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.3); }\n`,
        tsx: null,
      });
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const item = itemOf(readQueue(fixture), 'raw-color-css');
      expect(item.count).toBe(1);
      expect(item.files).toEqual([
        { path: 'src/styles/composites.css', count: 1, lines: [1] },
      ]);
    });

    it('raw-font-size-css fires on raw font-size declarations and shorthands but ignores tokenized type-scale values', () => {
      const fixture = makeFixture({
        compositesCss: [
          '.c-body { font-size: 14px; }',
          '.c-short { font: 500 14px/20px var(--font-sans); }',
          '.c-token { font-size: var(--text-body); }',
          '',
        ].join('\n'),
        primitivesCss: '.soup-pill { font: 500 10px/14px var(--font-sans); }\n',
        tsx: null,
      });
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const item = itemOf(readQueue(fixture), 'raw-font-size-css');
      expect(item.severity).toBe('polish');
      expect(item.count).toBe(2);
      expect(item.files).toEqual([
        { path: 'src/styles/composites.css', count: 2, lines: [1, 2] },
      ]);
    });

    it('raw-dimension-css fires on direct CSS layout lengths but ignores var() fallbacks', () => {
      const fixture = makeFixture({
        compositesCss: [
          '.c-size { width: 40px; }',
          '.c-fallback { height: var(--panel-h, 20px); }',
          '.c-calc { padding: calc(var(--sp-2) + 1px) var(--sp-3); }',
          '.c-radius { border-radius: 8px; }',
          '.c-token { width: var(--panel-w); padding: var(--sp-2); }',
          '.c-type { font-size: 12px; }',
          '',
        ].join('\n'),
        tsx: null,
      });
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const item = itemOf(readQueue(fixture), 'raw-dimension-css');
      expect(item.severity).toBe('blocking');
      expect(item.count).toBe(3);
      expect(item.files).toEqual([
        { path: 'src/styles/composites.css', count: 3, lines: [1, 3, 4] },
      ]);
    });

    it('raw-dimension-css stays silent for tokenized CSS dimensions and token-tier raw lengths', () => {
      const fixture = makeFixture({
        primitiveCss: `${DEFAULT_PRIMITIVE_CSS}:root { --shape-size: 12px; }\n`,
        compositesCss: [
          '.c-token { width: var(--panel-w); padding: var(--sp-2); }',
          '.c-fallback { height: var(--panel-h, 20px); }',
          '',
        ].join('\n'),
        tsx: null,
      });
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const item = itemOf(readQueue(fixture), 'raw-dimension-css');
      expect(item.count).toBe(0);
      expect(item.files).toEqual([]);
    });

    it('transition-all-css fires on CSS transition-all shorthand and longhand declarations', () => {
      const fixture = makeFixture({
        compositesCss: [
          '.c-hover { transition: all 120ms var(--ease); }',
          '.c-panel { transition-property: opacity, all; }',
          '.c-safe { transition: opacity var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease); }',
          '',
        ].join('\n'),
        tsx: null,
      });
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const item = itemOf(readQueue(fixture), 'transition-all-css');
      expect(item.severity).toBe('blocking');
      expect(item.count).toBe(2);
      expect(item.files).toEqual([
        { path: 'src/styles/composites.css', count: 2, lines: [1, 2] },
      ]);
    });

    it('transition-all-css ignores comments, transition:none, and explicit property lists', () => {
      const fixture = makeFixture({
        compositesCss: [
          '/* no transition: all here */',
          '.c-none { transition: none; }',
          '.c-safe { transition: opacity var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease); }',
          '.c-prop { transition-property: opacity, transform; }',
          '',
        ].join('\n'),
        tsx: null,
      });
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const item = itemOf(readQueue(fixture), 'transition-all-css');
      expect(item.count).toBe(0);
      expect(item.files).toEqual([]);
    });

    it('half-step fires on CSS and TSX usage but not on the definitions', () => {
      const fixture = makeFixture();
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const item = itemOf(readQueue(fixture), 'half-step');
      expect(item.severity).toBe('polish');
      expect(item.count).toBe(2);
      expect(item.files).toEqual([
        { path: 'src/components/Widget.tsx', count: 1, lines: [2] },
        { path: 'src/styles/composites.css', count: 1, lines: [6] },
      ]);
      // tokens.primitive.css definition lines excluded
      expect(item.files.some((f) => f.path === 'src/styles/tokens.primitive.css')).toBe(false);
    });

    it('rolls up lint-shadow-baseline.json rule×file buckets into category items', () => {
      const fixture = makeFixture();
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const queue = readQueue(fixture);
      const rawButton = itemOf(queue, 'raw-button');
      expect(rawButton.severity).toBe('blocking');
      expect(rawButton.count).toBe(3);
      expect(rawButton.files).toEqual([
        { path: 'src/components/Foo.tsx', count: 3, lines: null },
      ]);
      const legacyTsx = itemOf(queue, 'legacy-token-tsx');
      expect(legacyTsx.count).toBe(7);
    });

    it('summary reconciles: total = sum of all categories, blocking = blocking subset', () => {
      const fixture = makeFixture();
      const result = runScript(fixture, ['--update']);
      expect(result.status).toBe(0);

      const queue = readQueue(fixture);
      const sum = queue.items.reduce((a, i) => a + i.count, 0);
      const blockingSum = queue.items
        .filter((i) => i.severity === 'blocking')
        .reduce((a, i) => a + i.count, 0);
      expect(queue.summary.total).toBe(sum);
      expect(queue.summary.blocking).toBe(blockingSum);
      for (const item of queue.items) {
        expect(queue.summary.byCategory[item.category]).toBe(item.count);
      }
    });
  });

  describe('ratchet semantics', () => {
    it('--check exits 0 when counts match the baseline and the queue is in sync', () => {
      const fixture = makeFixture();
      expect(runScript(fixture, ['--update']).status).toBe(0);

      const result = runScript(fixture);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('design burndown OK');
    });

    it('blocks on a rise, naming the category, the delta, and the new file:line', () => {
      const fixture = makeFixture();
      expect(runScript(fixture, ['--update']).status).toBe(0);

      // Plant a NEW legacy var ref on a new line (line 7)
      writeFileSync(
        join(fixture.stylesDir, 'composites.css'),
        DEFAULT_COMPOSITES_CSS + `.c-new { color: var(--color-t1); }\n`
      );

      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('FAIL: legacy-var-css -> 5 violations (ceiling 4, +1)');
      expect(result.stderr).toContain('src/styles/composites.css:7');
    });

    it('blocks on a brand-new category appearing (count above implicit ceiling 0)', () => {
      const fixture = makeFixture({
        compositesCss: `.c-card { color: var(--color-t1); }\n`,
      });
      expect(runScript(fixture, ['--update']).status).toBe(0);

      // Introduce the first raw hex — raw-color-css rises 0 -> 1
      writeFileSync(
        join(fixture.stylesDir, 'composites.css'),
        `.c-card { color: var(--color-t1); }\n.c-bad { color: #ff0000; }\n`
      );
      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('FAIL: raw-color-css -> 1 violations (ceiling 0, +1)');
      expect(result.stderr).toContain('src/styles/composites.css:2');
    });

    it('demands --update on a fall (fixing a violation shrinks the queue via baseline rewrite)', () => {
      const fixture = makeFixture();
      expect(runScript(fixture, ['--update']).status).toBe(0);

      // Fix the raw hex violation (line 5 -> tokenized)
      writeFileSync(
        join(fixture.stylesDir, 'composites.css'),
        DEFAULT_COMPOSITES_CSS.replace('color: #ff0000;', 'color: var(--text-1);')
      );

      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('FALL: raw-color-css -> 0 violations (ceiling 1, -1)');
      expect(result.stderr).toContain('ratchet fall — run with --update to lower the baseline');

      // --update then shrinks both baseline and queue together
      expect(runScript(fixture, ['--update']).status).toBe(0);
      const queue = readQueue(fixture);
      expect(itemOf(queue, 'raw-color-css').count).toBe(0);
      const baseline = JSON.parse(
        readFileSync(join(fixture.consoleDir, 'design-burndown-baseline.json'), 'utf8')
      ) as { categories: Record<string, number> };
      expect(baseline.categories['raw-color-css']).toBe(0);
      expect(runScript(fixture).status).toBe(0);
    });

    it('blocks on queue drift when a violation moves without changing any count', () => {
      const fixture = makeFixture();
      expect(runScript(fixture, ['--update']).status).toBe(0);

      // Same counts, different line numbers: insert a blank line at the top
      writeFileSync(join(fixture.stylesDir, 'composites.css'), '\n' + DEFAULT_COMPOSITES_CSS);

      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('queue drift');
      expect(result.stderr).toContain('--update');
    });

    it('--check never writes: baseline and queue bytes are untouched on failure', () => {
      const fixture = makeFixture();
      expect(runScript(fixture, ['--update']).status).toBe(0);
      const baselinePath = join(fixture.consoleDir, 'design-burndown-baseline.json');
      const queuePath = join(fixture.consoleDir, 'design-burndown-queue.json');
      const baselineBefore = readFileSync(baselinePath, 'utf8');
      const queueBefore = readFileSync(queuePath, 'utf8');

      writeFileSync(
        join(fixture.stylesDir, 'composites.css'),
        DEFAULT_COMPOSITES_CSS + `.c-new { color: var(--color-t1); }\n`
      );
      expect(runScript(fixture).status).toBe(1);

      expect(readFileSync(baselinePath, 'utf8')).toBe(baselineBefore);
      expect(readFileSync(queuePath, 'utf8')).toBe(queueBefore);
    });

    it('fails with the --update instruction when no burndown baseline exists', () => {
      const fixture = makeFixture();
      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no baseline');
      expect(result.stderr).toContain('--update');
      // Fail-closed --check creates nothing
      expect(existsSync(join(fixture.consoleDir, 'design-burndown-queue.json'))).toBe(false);
    });
  });

  describe('fail-closed parsing', () => {
    it('RAISES on malformed design-burndown-baseline.json (never silently passes)', () => {
      const fixture = makeFixture();
      expect(runScript(fixture, ['--update']).status).toBe(0);
      writeFileSync(
        join(fixture.consoleDir, 'design-burndown-baseline.json'),
        '{ "categories": { NOT JSON }'
      );

      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(parse:design-burndown-baseline.json)');
    });

    it('RAISES on missing lint-shadow-baseline.json input', () => {
      const fixture = makeFixture();
      rmSync(join(fixture.consoleDir, 'lint-shadow-baseline.json'));

      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(read:lint-shadow-baseline.json)');
    });

    it('RAISES on malformed lint-shadow-baseline.json', () => {
      const fixture = makeFixture({ shadowBaseline: '{ "total": 10, "rules": { BROKEN' });
      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(parse:lint-shadow-baseline.json)');
    });

    it('RAISES when the shadow baseline rules sum disagrees with its declared total', () => {
      const fixture = makeFixture({
        shadowBaseline: {
          generated: 'test',
          total: 999,
          rules: { 'soup/no-raw-button :: src/Foo.tsx': 3 },
        },
      });
      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(schema:lint-shadow-baseline.json)');
      expect(result.stderr).toContain('999');
    });

    it('RAISES when the Legacy aliases derivation block is missing from tokens.semantic.css', () => {
      const fixture = makeFixture({
        semanticCss: ':root { --surface-base: #101012; }\n',
      });
      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(derive:legacy-alias-block)');
    });

    it('RAISES on an unknown argument', () => {
      const fixture = makeFixture();
      const result = runScript(fixture, ['--bogus']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ERROR(args)');
    });
  });

  describe('determinism', () => {
    it('two --update runs on the same tree produce byte-identical queue and baseline', () => {
      const fixture = makeFixture();
      expect(runScript(fixture, ['--update']).status).toBe(0);
      const q1 = readFileSync(join(fixture.consoleDir, 'design-burndown-queue.json'), 'utf8');
      const b1 = readFileSync(join(fixture.consoleDir, 'design-burndown-baseline.json'), 'utf8');
      expect(runScript(fixture, ['--update']).status).toBe(0);
      const q2 = readFileSync(join(fixture.consoleDir, 'design-burndown-queue.json'), 'utf8');
      const b2 = readFileSync(join(fixture.consoleDir, 'design-burndown-baseline.json'), 'utf8');
      expect(q2).toBe(q1);
      expect(b2).toBe(b1);
      // No timestamps / randomness in artifact content
      expect(q1).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    });

    it('queue items are ordered blocking-first then by category name', () => {
      const fixture = makeFixture();
      expect(runScript(fixture, ['--update']).status).toBe(0);
      const queue = readQueue(fixture);
      const severities = queue.items.map((i) => i.severity);
      const firstPolish = severities.indexOf('polish');
      if (firstPolish !== -1) {
        expect(severities.slice(firstPolish).every((s) => s === 'polish')).toBe(true);
      }
      const blockingCats = queue.items.filter((i) => i.severity === 'blocking').map((i) => i.category);
      expect(blockingCats).toEqual([...blockingCats].sort((a, b) => a.localeCompare(b)));
    });
  });
});
