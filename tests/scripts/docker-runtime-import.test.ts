import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

it('loads the default transcription chain with the files packaged in the Docker runtime', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'whatsoup-runtime-import-'));
  try {
    const dockerfile = readFileSync(path.join(repoRoot, 'docker/Dockerfile'), 'utf8');
    const runtime = dockerfile.split(/^FROM .+ AS runtime$/m)[1];
    expect(runtime, 'runtime stage must be available to the packaging fixture').toBeDefined();
    for (const line of runtime!.split('\n')) {
      if (!line.startsWith('COPY ') || line.startsWith('COPY --from=')) continue;
      const parts = line.split(/\s+/);
      expect(parts, `unsupported runtime COPY: ${line}`).toHaveLength(3);
      const [, source, destination] = parts as [string, string, string];
      if (path.isAbsolute(destination)) continue;
      const target = path.join(fixture, destination);
      mkdirSync(destination.endsWith('/') ? target : path.dirname(target), { recursive: true });
      cpSync(path.join(repoRoot, source), destination.endsWith('/') && !source.endsWith('/')
        ? path.join(target, path.basename(source))
        : target, { recursive: true });
    }
    // Supply the dependency-stage artifacts without installing a second dependency tree.
    cpSync(path.join(repoRoot, 'package.json'), path.join(fixture, 'package.json'));
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      "const { transcribeAudio } = await import('./src/runtimes/chat/providers/transcription/chain.ts'); if (typeof transcribeAudio !== 'function') throw new Error('transcription entrypoint missing');",
    ], { cwd: fixture, encoding: 'utf8', timeout: 8_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
