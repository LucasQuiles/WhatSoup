import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

let savedXdg: string | undefined;

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
  vi.restoreAllMocks();
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

function useTempConfigRoot(): string {
  savedXdg = process.env.XDG_CONFIG_HOME;
  const root = path.join(os.tmpdir(), `fleet-token-storage-fs-failures-${process.pid}-${Date.now()}`);
  process.env.XDG_CONFIG_HOME = root;
  return root;
}

describe('token-storage filesystem failure guards', () => {
  it('rejects a non-directory token directory after recursive mkdir reports success', async () => {
    const root = useTempConfigRoot();
    const dirPath = path.join(root, 'whatsoup');
    const currentPath = path.join(dirPath, 'fleet-tokens.json');
    const legacyPath = path.join(dirPath, 'fleet-token');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });

    vi.doMock('node:fs', () => ({
      ...actual,
      mkdirSync: vi.fn(),
      lstatSync: vi.fn((target: string) => {
	        if (target === currentPath || target === legacyPath) throw enoent;
	        if (target === dirPath) {
	          return {
	            isSymbolicLink: (): boolean => false,
	            isDirectory: (): boolean => false,
	            isFile: (): boolean => false,
	          };
	        }
        return actual.lstatSync(target);
      }),
    }));
    const { loadOrCreateFleetTokens } = await import('../../src/fleet/token-storage.ts');

    expect(() => loadOrCreateFleetTokens()).toThrow(/non-directory path/);
  });

  it('cleans up a temp file when writing fails and close also fails', async () => {
    const root = useTempConfigRoot();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('node:fs', () => ({
      ...actual,
      writeFileSync: vi.fn((target: string | number, data: unknown, options?: unknown) => {
        if (typeof target === 'number') throw new Error('simulated token write failure');
        return actual.writeFileSync(target, data as string | NodeJS.ArrayBufferView, options as Parameters<typeof actual.writeFileSync>[2]);
      }),
      closeSync: vi.fn((fd: number) => {
        actual.closeSync(fd);
        throw new Error('simulated close failure');
      }),
    }));
    const { getFleetTokensPath, loadOrCreateFleetTokens } = await import('../../src/fleet/token-storage.ts');
    const tokenPath = getFleetTokensPath();

    expect(() => loadOrCreateFleetTokens()).toThrow(/simulated token write failure/);

    const leftovers = actual.existsSync(path.dirname(tokenPath))
      ? actual.readdirSync(path.dirname(tokenPath)).filter((name) => name.includes('fleet-tokens.json.tmp-'))
      : [];
    expect(leftovers).toEqual([]);
    actual.rmSync(root, { recursive: true, force: true });
  });
});
