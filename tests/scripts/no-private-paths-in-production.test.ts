import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const productionSourceFiles = [
  'console/src/components/wizard/ConfigStep.tsx',
  'scripts/cutover.sh',
  'scripts/rollback.sh',
  'src/main.ts',
  'src/runtimes/agent/providers/__tests__/fixtures/codex-appserver-output.jsonl',
  'src/runtimes/agent/providers/__tests__/fixtures/codex-appserver-tools.jsonl',
  'src/runtimes/agent/providers/__tests__/fixtures/codex-output3.jsonl',
  'src/runtimes/agent/providers/__tests__/fixtures/opencode-tools-output.jsonl',
];

const privatePathPattern =
  /\/(?:Users|home)\/(?!whatsoup(?:\/|$)|testuser(?:\/|$)|runner(?:\/|$)|node(?:\/|$))[A-Za-z0-9._-]+(?:\/|$)/g;

describe('production source contains no operator-local paths', () => {
  for (const relPath of productionSourceFiles) {
    it(`${relPath} uses synthetic home paths only`, () => {
      const text = readFileSync(path.join(repoRoot, relPath), 'utf8');

      expect(text.match(privatePathPattern) ?? []).toEqual([]);
    });
  }
});
