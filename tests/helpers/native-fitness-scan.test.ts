import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runEslintFitness } from '../../scripts/eslint-fitness-check.ts';
import { scanFitnessInNativeProcess } from './native-fitness-scan.ts';
import { trackTmpDirs } from './tmp-dir.ts';

const tmp = trackTmpDirs('native-fitness-scan-');

function fixture(config: string): string {
  const cwd = tmp.make('repository');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'sample.ts'), 'const first = 1;\nconst second = 2;\n');
  writeFileSync(join(cwd, 'eslint.config.fitness.mjs'), config);
  return cwd;
}

describe('native fitness scan', () => {
  it('returns every finding and count from the ordinary scanner', async () => {
    const cwd = fixture('export default [{ files: ["**/*.ts"], rules: { "max-lines": ["warn", 1] } }];');
    const direct = await runEslintFitness(cwd);
    expect(direct.warningCount).toBeGreaterThan(0);
    expect(direct.filesLinted).toBe(1);
    expect(scanFitnessInNativeProcess(cwd)).toEqual(direct);
  });

  it('preserves parser failures as blocking findings', () => {
    const cwd = fixture('export default [{ files: ["**/*.ts"] }];');
    writeFileSync(join(cwd, 'src', 'sample.ts'), 'const = ;\n');
    expect(scanFitnessInNativeProcess(cwd)).toMatchObject({ fatal: true, errorCount: 1, filesLinted: 1 });
  });

  it('rejects a native config-load failure', () => {
    const cwd = fixture('throw new Error("synthetic-config-failure");');
    expect(() => scanFitnessInNativeProcess(cwd)).toThrow('synthetic-config-failure');
  });

  it('rejects a clean child exit without its complete report', () => {
    const cwd = fixture('process.exit(0);');
    expect(() => scanFitnessInNativeProcess(cwd)).toThrow();
  });

  it('rejects a nonzero child exit', () => {
    const cwd = fixture('process.exit(17);');
    expect(() => scanFitnessInNativeProcess(cwd)).toThrow();
  });

  it('rejects valid JSON that omits findings and counts', () => {
    const cwd = fixture('process.stdout.write("{}"); process.exit(0);');
    expect(() => scanFitnessInNativeProcess(cwd)).toThrow('Command failed');
  });

  it('rejects a config that emits a plausible report and exits before scanning', () => {
    const report = { fatal: false, warningCount: 0, errorCount: 0, filesLinted: 1, issues: [] };
    const cwd = fixture(`process.stdout.write(${JSON.stringify(JSON.stringify(report))}); process.exit(0);`);
    expect(() => scanFitnessInNativeProcess(cwd)).toThrow();
  });
});
