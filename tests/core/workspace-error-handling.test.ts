import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogError, mockMkdirSync, mockWriteFileSync, mockSymlinkSync, mockUnlinkSync, mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockSymlinkSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    debug: vi.fn(),
  }),
}));

vi.mock('node:fs', () => ({
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  symlinkSync: mockSymlinkSync,
  unlinkSync: mockUnlinkSync,
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
}));

import { provisionWorkspace } from '../../src/core/workspace.ts';

describe('provisionWorkspace error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('{}');
  });

  it('logs and rethrows symlink failures during provisioning', () => {
    const symlinkErr = new Error('EEXIST: file already exists');
    mockSymlinkSync.mockImplementation(() => {
      throw symlinkErr;
    });

    expect(() => provisionWorkspace({
      workspacePath: '/tmp/workspace',
      instanceCwd: '/tmp/instance',
      sandbox: {
        allowedPaths: ['/elsewhere'],
        allowedTools: ['Read'],
        bash: { enabled: false },
      },
      hookPath: '/tmp/agent-sandbox.sh',
      mcpServerPath: '/tmp/whatsoup-proxy.ts',
    })).toThrow(symlinkErr);

    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ err: symlinkErr, workspacePath: '/tmp/workspace' }),
      'workspace provisioning failed',
    );
  });
});
