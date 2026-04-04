import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROVIDERS_DIR = resolve(import.meta.dirname, '../../../../src/runtimes/agent/providers');

describe('Anti-duplication enforcement', () => {
  const parserFiles = [
    'codex-parser.ts',
    'gemini-parser.ts',
    'gemini-acp-parser.ts',
    'opencode-parser.ts',
  ];

  for (const file of parserFiles) {
    describe(file, () => {
      const content = readFileSync(resolve(PROVIDERS_DIR, file), 'utf8');

      it('must not define its own isRecord — use parser-utils.ts', () => {
        expect(content).not.toMatch(/function isRecord\(/);
      });

      it('must not define its own stringifyValue — use parser-utils.ts', () => {
        expect(content).not.toMatch(/function stringifyValue\(/);
      });

      it('must import from parser-utils.ts', () => {
        expect(content).toMatch(/from ['"]\.\/parser-utils/);
      });
    });
  }

  it('parser-utils.ts exports isRecord', () => {
    const content = readFileSync(resolve(PROVIDERS_DIR, 'parser-utils.ts'), 'utf8');
    expect(content).toMatch(/export function isRecord/);
  });

  it('parser-utils.ts exports stringifyValue', () => {
    const content = readFileSync(resolve(PROVIDERS_DIR, 'parser-utils.ts'), 'utf8');
    expect(content).toMatch(/export function stringifyValue/);
  });
});
