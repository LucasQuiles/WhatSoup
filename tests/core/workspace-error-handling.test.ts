import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockLogError,
  mockMkdirSync,
  mockWriteFileSync,
  mockSymlinkSync,
  mockUnlinkSync,
  mockReadFileSync,
  mockExistsSync,
  mockLstatSync,
  mockOpenSync,
  mockFstatSync,
  mockFchmodSync,
  mockFtruncateSync,
  mockCloseSync,
  mockChmodSync,
} = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockSymlinkSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockLstatSync: vi.fn(),
  mockOpenSync: vi.fn(),
  mockFstatSync: vi.fn(),
  mockFchmodSync: vi.fn(),
  mockFtruncateSync: vi.fn(),
  mockCloseSync: vi.fn(),
  mockChmodSync: vi.fn(),
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
  chmodSync: mockChmodSync,
  closeSync: mockCloseSync,
  constants: {
    O_WRONLY: 1,
    O_CREAT: 64,
    O_NOFOLLOW: 131072,
    O_NONBLOCK: 2048,
  },
  fchmodSync: mockFchmodSync,
  fstatSync: mockFstatSync,
  ftruncateSync: mockFtruncateSync,
  lstatSync: mockLstatSync,
  mkdirSync: mockMkdirSync,
  openSync: mockOpenSync,
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
    mockLstatSync.mockImplementation((target) => {
      const path = String(target);
      if (path.endsWith('.json')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return {
        isSymbolicLink: () => false,
        isDirectory: () => true,
        isFile: () => false,
      };
    });
    mockOpenSync.mockReturnValue(10);
    mockFstatSync.mockReturnValue({ isFile: () => true });
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
