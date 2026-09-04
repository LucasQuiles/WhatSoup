import {
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createNativeSourceInventoryFileSystem,
  inventorySourceFiles,
} from '../../scripts/lib/guard-core.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('source-inventory-native-read-');

describe('source inventory native descriptor-bound reads', () => {
  it('opens candidates with the platform no-follow flag', () => {
    const repoRoot = tmp.make('flags-repo');
    const sourceRoot = path.join(repoRoot, 'src');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(path.join(sourceRoot, 'candidate.ts'), 'export const candidate = true;\n');

    const noFollowFlag = constants.O_NOFOLLOW;
    expect(typeof noFollowFlag).toBe('number');
    if (typeof noFollowFlag !== 'number') return;

    const openedFlags: number[] = [];
    let openedDescriptor: number | undefined;
    const result = inventorySourceFiles({
      repoRoot,
      roots: ['src'],
      includeFile: (relativePath) => relativePath.endsWith('.ts'),
      fileSystem: createNativeSourceInventoryFileSystem({
        noFollowFlag,
        openFile: (file, flags) => {
          openedFlags.push(flags);
          openedDescriptor = openSync(file, flags);
          return openedDescriptor;
        },
      }),
    });

    expect(result.issues).toEqual([]);
    expect(result.files.map(({ path: file }) => file)).toEqual(['src/candidate.ts']);
    expect(openedFlags).toEqual([constants.O_RDONLY | noFollowFlag]);
    expect(openedDescriptor).toBeTypeOf('number');
    if (openedDescriptor === undefined) return;
    let postReadDescriptorCode: string | undefined;
    try {
      fstatSync(openedDescriptor);
    } catch (error) {
      postReadDescriptorCode = (error as NodeJS.ErrnoException).code;
    }
    expect(postReadDescriptorCode).toBe('EBADF');
  });

  it('reports an inconclusive read without opening when no-follow is unavailable', () => {
    const repoRoot = tmp.make('unsupported-repo');
    const sourceRoot = path.join(repoRoot, 'src');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(path.join(sourceRoot, 'candidate.ts'), 'export const candidate = true;\n');

    const openedPaths: string[] = [];
    const result = inventorySourceFiles({
      repoRoot,
      roots: ['src'],
      includeFile: (relativePath) => relativePath.endsWith('.ts'),
      fileSystem: createNativeSourceInventoryFileSystem({
        noFollowFlag: null,
        openFile: (file, _flags) => {
          openedPaths.push(file);
          throw new Error('open must not be attempted without no-follow protection');
        },
      }),
    });

    expect(openedPaths).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.issues).toEqual([{
      code: 'guard.scan.entry-unreadable',
      operation: 'read',
      path: 'src/candidate.ts',
      systemCode: 'ENOSYS',
    }]);
  });

  it('classifies a post-lstat symlink replacement without returning outside content', () => {
    const repoRoot = tmp.make('repo');
    const sourceRoot = path.join(repoRoot, 'src');
    const candidate = path.join(sourceRoot, 'candidate.ts');
    const outsideDirectory = tmp.make('outside-directory');
    const outsideFile = path.join(outsideDirectory, 'private-canary.ts');
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(candidate, 'export const original = true;\n');
    writeFileSync(outsideFile, 'PRIVATE_OUTSIDE_CANARY\n');

    let swapped = false;
    const result = inventorySourceFiles({
      repoRoot,
      roots: ['src'],
      includeFile: (relativePath) => {
        if (relativePath === 'src/candidate.ts') {
          renameSync(candidate, path.join(sourceRoot, 'candidate-before-swap.ts'));
          symlinkSync(outsideFile, candidate, 'file');
          swapped = true;
        }
        return relativePath.endsWith('.ts');
      },
    });

    expect(swapped).toBe(true);
    expect(result.files).toEqual([]);
    expect(result.issues).toContainEqual({
      code: 'guard.scan.entry-replaced',
      operation: 'read',
      path: 'src/candidate.ts',
    });
    expect(result.issues).not.toContainEqual(expect.objectContaining({
      code: 'guard.scan.entry-unreadable',
      operation: 'read',
      path: 'src/candidate.ts',
    }));
    expect(JSON.stringify(result)).not.toContain(outsideDirectory);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_OUTSIDE_CANARY');
  });
});
