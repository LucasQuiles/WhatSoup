import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { vi } from 'vitest';

export async function prepareRuntimeHome(): Promise<typeof import('node:fs')> {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const home = process.env.WHATSOUP_VITEST_HOME;
  if (!home || home !== process.env.HOME
    || !fs.lstatSync(join(home, '.whatsoup-vitest-home')).isFile()) {
    throw new Error('runtime filesystem fixtures require the marked Vitest HOME');
  }
  const fromHome = relative(home, fs.realpathSync.native(tmpdir()));
  if (!fromHome || fromHome === '..' || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
    throw new Error('runtime temporary fixtures must remain inside the marked Vitest HOME');
  }
  fs.mkdirSync(join(home, '.claude'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(tmpdir(), '.claude'), { recursive: true, mode: 0o700 });
  return fs;
}

export async function ownedRuntimeCwd(name: string): Promise<string> {
  if (!name || basename(name) !== name || name === '.' || name === '..') {
    throw new Error('runtime cwd fixture requires a child directory name');
  }
  const fs = await prepareRuntimeHome();
  const cwd = join(tmpdir(), name);
  fs.mkdirSync(join(cwd, '.claude'), { recursive: true, mode: 0o700 });
  return cwd;
}
