import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const {
  mockLogError,
  mockSymlinkSync,
} = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockSymlinkSync: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    debug: vi.fn(),
  }),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  symlinkSync: mockSymlinkSync,
}));

import { provisionWorkspace } from '../../src/core/workspace.ts';

const tmp = trackTmpDirs('workspace-error-');

describe('provisionWorkspace error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs and rethrows symlink failures during provisioning', () => {
    const workspacePath = tmp.make('workspace');
    const instanceCwd = tmp.make('instance');
    const symlinkErr = new Error('EEXIST: file already exists');
    mockSymlinkSync.mockImplementation(() => {
      throw symlinkErr;
    });

    expect(() => provisionWorkspace({
      workspacePath,
      instanceCwd,
      sandbox: {
        allowedPaths: ['/elsewhere'],
        allowedTools: ['Read'],
        bash: { enabled: false },
      },
      hookPath: join(instanceCwd, 'agent-sandbox.sh'),
      mcpServerPath: join(instanceCwd, 'whatsoup-proxy.ts'),
    })).toThrow(symlinkErr);

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      join(instanceCwd, 'CLAUDE.md'), join(workspacePath, 'CLAUDE.md'),
    );
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ err: symlinkErr, workspacePath }),
      'workspace provisioning failed',
    );
  });
});
