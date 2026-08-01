import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const SCRIPT = resolve(process.cwd(), 'console/scripts/check-raw-form-control-inventory.mjs');
const RAW_FORM_MESSAGE = '[soup/no-raw-form-control SHADOW] Raw form control element.';

const tmp = trackTmpDirs('');

interface EslintHit {
  file: string;
  line: number;
  column?: number;
  message?: string;
}

function makeFixture(files: Record<string, string>, hits: EslintHit[]) {
  const root = tmp.make('raw-form-inventory');

  for (const [filePath, source] of Object.entries(files)) {
    const absolute = join(root, filePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }

  const resultsByFile = new Map<string, Array<{ column: number; line: number; message: string; ruleId: string }>>();
  for (const hit of hits) {
    const messages = resultsByFile.get(hit.file) ?? [];
    messages.push({
      column: hit.column ?? 1,
      line: hit.line,
      message: hit.message ?? RAW_FORM_MESSAGE,
      ruleId: 'no-restricted-syntax',
    });
    resultsByFile.set(hit.file, messages);
  }

  const eslintResults = [...resultsByFile.entries()].map(([filePath, messages]) => ({
    filePath: join(root, filePath),
    messages,
  }));
  const eslintJson = join(root, 'eslint.json');
  writeFileSync(eslintJson, JSON.stringify(eslintResults, null, 2));

  return { eslintJson, root };
}

function runInventory(root: string, eslintJson: string, extraArgs: string[] = []) {
  return spawnSync(
    'node',
    [SCRIPT, '--root', root, '--eslint-json', eslintJson, '--no-baseline', ...extraArgs],
    {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function parsedOutput(result: ReturnType<typeof runInventory>) {
  return JSON.parse(result.stdout) as {
    by_file: Array<{
      file: string;
      lines: number[];
      total: number;
    }>;
    errors: Array<{ code: string; file: string }>;
    hits: Array<{
      classification: string;
      consumer_group: string;
      element: string;
      file: string;
      line: number;
    }>;
    mismatches: Array<{ expected: number; observed: number; path: string }>;
    baseline?: {
      errors: Array<{ code: string; file: string }>;
      mismatches: Array<{ path: string; message: string }>;
      path: string;
      update: boolean;
    };
    totals: {
      by_classification: Record<string, number>;
      by_consumer_group: Record<string, number>;
      by_element: Record<string, number>;
      files: number;
      total: number;
    };
    verdict: 'PASS' | 'FAIL';
  };
}

describe('check-raw-form-control-inventory.mjs', () => {
  it('classifies raw form-control hits by migration type, consumer group, and element', () => {
    const { eslintJson, root } = makeFixture(
      {
        'console/src/components/primitives/FormControl.tsx': `
export function TextInput() {
  return <input className="c-input" />;
}
export function TextArea() {
  return <textarea className="c-input" />;
}
`,
        'console/src/components/SaveContactDialog.tsx': 'export function SaveContactDialog() { return <input aria-label="Name" />; }\n',
        'console/src/components/line-detail/GroupDetailModal.tsx': 'export function GroupDetailModal() { return <select aria-label="Delay" />; }\n',
        'console/src/pages/Inbox.tsx': 'export function Inbox() { return <textarea aria-label="Message" />; }\n',
      },
      [
        { file: 'console/src/pages/Inbox.tsx', line: 1 },
        { file: 'console/src/components/line-detail/GroupDetailModal.tsx', line: 1 },
        { file: 'console/src/components/primitives/FormControl.tsx', line: 3 },
        { file: 'console/src/components/SaveContactDialog.tsx', line: 1 },
        { file: 'console/src/components/primitives/FormControl.tsx', line: 6 },
      ],
    );

    const result = runInventory(root, eslintJson, [
      '--expected-total',
      '5',
      '--expected-consumer',
      '3',
      '--expected-exemption',
      '2',
      '--expected-input',
      '2',
      '--expected-select',
      '1',
      '--expected-textarea',
      '2',
      '--fail-on-mismatch',
    ]);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.errors).toEqual([]);
    expect(output.mismatches).toEqual([]);
    expect(output.totals.total).toBe(5);
    expect(output.totals.by_classification).toEqual({
      consumer_migration: 3,
      exemption_movement: 2,
    });
    expect(output.totals.by_consumer_group).toMatchObject({
      form_kit_self_hits: 2,
      line_detail_and_modals: 1,
      pages: 1,
      standalone_components: 1,
    });
    expect(output.totals.by_element).toEqual({
      input: 2,
      select: 1,
      textarea: 2,
    });
  });

  it('fails when expected inventory counts do not match the mechanical scan', () => {
    const { eslintJson, root } = makeFixture(
      {
        'console/src/components/SaveContactDialog.tsx': 'export function SaveContactDialog() { return <input aria-label="Name" />; }\n',
      },
      [{ file: 'console/src/components/SaveContactDialog.tsx', line: 1 }],
    );

    const result = runInventory(root, eslintJson, [
      '--expected-total',
      '2',
      '--expected-consumer',
      '1',
      '--fail-on-mismatch',
    ]);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.mismatches).toEqual([
      { expected: 2, observed: 1, path: 'total' },
    ]);
  });

  it('ignores unrelated ESLint messages and emits stable sorted file order', () => {
    const { eslintJson, root } = makeFixture(
      {
        'console/src/components/Beta.tsx': 'export function Beta() { return <input aria-label="B" />; }\n',
        'console/src/components/Alpha.tsx': 'export function Alpha() { return <select aria-label="A" />; }\n',
      },
      [
        { file: 'console/src/components/Beta.tsx', line: 1 },
        { file: 'console/src/components/Alpha.tsx', line: 1 },
        {
          file: 'console/src/components/Alpha.tsx',
          line: 1,
          message: '[soup/no-raw-button SHADOW] Raw button.',
        },
      ],
    );

    const result = runInventory(root, eslintJson);
    const output = parsedOutput(result);

    expect(result.status).toBe(0);
    expect(output.verdict).toBe('PASS');
    expect(output.by_file.map((entry) => entry.file)).toEqual([
      'console/src/components/Alpha.tsx',
      'console/src/components/Beta.tsx',
    ]);
    expect(output.totals.total).toBe(2);
    expect(output.totals.by_element).toMatchObject({ input: 1, select: 1, textarea: 0 });
  });

  it('fails closed when ESLint output references a missing source file', () => {
    const { eslintJson, root } = makeFixture({}, [
      { file: 'console/src/components/Missing.tsx', line: 1 },
    ]);

    const result = runInventory(root, eslintJson);
    const output = parsedOutput(result);

    expect(result.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.errors).toMatchObject([
      {
        code: 'source-missing',
        file: 'console/src/components/Missing.tsx',
      },
    ]);
  });

  it('writes and compares a generated baseline instead of hand-entered package counts', () => {
    const { eslintJson, root } = makeFixture(
      {
        'console/src/components/SaveContactDialog.tsx': 'export function SaveContactDialog() { return <input aria-label="Name" />; }\n',
      },
      [{ file: 'console/src/components/SaveContactDialog.tsx', line: 1 }],
    );
    const baseline = join(root, 'console', 'design-raw-form-control-inventory.json');

    const update = spawnSync(
      'node',
      [SCRIPT, '--root', root, '--eslint-json', eslintJson, '--baseline', baseline, '--update'],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const updateOutput = parsedOutput(update as ReturnType<typeof runInventory>);

    expect(update.status).toBe(0);
    expect(updateOutput.verdict).toBe('PASS');

    const compare = spawnSync(
      'node',
      [SCRIPT, '--root', root, '--eslint-json', eslintJson, '--baseline', baseline],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const compareOutput = parsedOutput(compare as ReturnType<typeof runInventory>);

    expect(compare.status).toBe(0);
    expect(compareOutput.verdict).toBe('PASS');
    expect(compareOutput.baseline?.mismatches).toEqual([]);
  });

  it('fails when the live mechanical inventory drifts from the generated baseline', () => {
    const { eslintJson, root } = makeFixture(
      {
        'console/src/components/SaveContactDialog.tsx': 'export function SaveContactDialog() { return <input aria-label="Name" />; }\n',
      },
      [{ file: 'console/src/components/SaveContactDialog.tsx', line: 1 }],
    );
    const baseline = join(root, 'console', 'design-raw-form-control-inventory.json');

    const update = spawnSync(
      'node',
      [SCRIPT, '--root', root, '--eslint-json', eslintJson, '--baseline', baseline, '--update'],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    expect(update.status).toBe(0);

    const drifted = makeFixture(
      {
        'console/src/components/SaveContactDialog.tsx': 'export function SaveContactDialog() { return <input aria-label="Name" />; }\n',
        'console/src/pages/Inbox.tsx': 'export function Inbox() { return <textarea aria-label="Message" />; }\n',
      },
      [
        { file: 'console/src/components/SaveContactDialog.tsx', line: 1 },
        { file: 'console/src/pages/Inbox.tsx', line: 1 },
      ],
    );

    const compare = spawnSync(
      'node',
      [SCRIPT, '--root', drifted.root, '--eslint-json', drifted.eslintJson, '--baseline', baseline],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const output = parsedOutput(compare as ReturnType<typeof runInventory>);

    expect(compare.status).toBe(1);
    expect(output.verdict).toBe('FAIL');
    expect(output.baseline?.mismatches).toEqual([
      expect.objectContaining({ path: 'generated_inventory' }),
    ]);
  });
});
