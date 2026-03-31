import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (full.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('strip-types compatibility', () => {
  const files = [...collectTsFiles('src'), ...collectTsFiles('deploy/mcp')];

  it('finds .ts files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s parses under strip-types', (filePath) => {
    const source = readFileSync(filePath, 'utf8');
    expect(() => {
      (stripTypeScriptTypes as any)(source, { mode: 'strip' });
    }).not.toThrow();
  });
});
