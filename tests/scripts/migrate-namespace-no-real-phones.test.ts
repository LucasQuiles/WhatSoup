import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'migrate-namespace.sh');
const productionFiles = [
  'scripts/migrate-namespace.sh',
  'src/core/access-list.ts',
  'src/core/lid-resolver.ts',
  'src/core/mentions.ts',
];

const syntheticPhones = new Set([
  '15555550100',
  '15555550101',
  '15555550102',
  '15555550103',
  '15555550104',
  '15550100001',
  '15555551234',
  '15551234567',
]);

describe('migrate-namespace.sh leak guard', () => {
  it('contains no real-looking US phone literals', () => {
    const text = readFileSync(scriptPath, 'utf8');
    const realLookingPhones = Array.from(text.matchAll(/\b(1[2-9][0-9]{9})\b/g))
      .map((match) => match[1])
      .filter((phone) => !syntheticPhones.has(phone));

    expect(realLookingPhones).toEqual([]);
  });

  it('uses the synthetic placeholder for passive admin phones', () => {
    const text = readFileSync(scriptPath, 'utf8');

    expect(text).toMatch(/"adminPhones":\s*\["15555550100"\]/);
  });
});

describe('production phone and group fixture leak guard', () => {
  for (const relPath of productionFiles) {
    it(`${relPath} contains only synthetic phone and group literals`, () => {
      const text = readFileSync(path.join(repoRoot, relPath), 'utf8');
      const realLookingPhones = Array.from(text.matchAll(/\b(1[2-9][0-9]{9})\b/g))
        .map((match) => match[1])
        .filter((phone) => !syntheticPhones.has(phone));
      const realLookingGroups = Array.from(text.matchAll(/\b(120363\d{6,})@g\.us\b/g))
        .map((match) => match[1])
        .filter((jid) => jid !== '120363555555555000');

      expect(realLookingPhones).toEqual([]);
      expect(realLookingGroups).toEqual([]);
    });
  }
});
