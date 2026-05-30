import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function desiredEntries(templateText: string): Map<string, string> {
  const desired = new Map<string, string>();
  for (const line of templateText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    desired.set(line.slice(0, index).trim(), line);
  }
  return desired;
}

export function mergeNpmrcText(templateText: string, currentText = ''): string {
  const desired = desiredEntries(templateText);
  const lines = currentText.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  const seen = new Set<string>();
  const merged = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) return line;
    const index = trimmed.indexOf('=');
    if (index === -1) return line;
    const key = trimmed.slice(0, index).trim();
    const replacement = desired.get(key);
    if (!replacement) return line;
    seen.add(key);
    return replacement;
  });

  for (const [key, line] of desired) {
    if (!seen.has(key)) merged.push(line);
  }
  return `${merged.join('\n')}\n`;
}

export function mergeNpmrcFile(templatePath: string, targetPath: string): void {
  const templateText = readFileSync(templatePath, 'utf8');
  let currentText = '';
  try {
    currentText = readFileSync(targetPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
  writeFileSync(targetPath, mergeNpmrcText(templateText, currentText));
}

function run(argv: string[] = process.argv.slice(2)): void {
  const [templatePath, targetPath] = argv;
  if (!templatePath || !targetPath || argv.length !== 2) {
    throw new Error('usage: npmrc-merge.ts <template> <target>');
  }
  mergeNpmrcFile(templatePath, targetPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
