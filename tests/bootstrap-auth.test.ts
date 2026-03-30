import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock instance-loader before importing bootstrap-auth
vi.mock('../src/instance-loader.ts', () => ({
  loadInstance: vi.fn(),
}));

// Mock transport/auth.ts to prevent side effects from config.ts / logger.ts
vi.mock('../src/transport/auth.ts', () => ({}));

import { loadInstance } from '../src/instance-loader.ts';
import { bootstrapAuth } from '../src/bootstrap-auth.ts';

const mockLoadInstance = vi.mocked(loadInstance);

describe('bootstrapAuth', () => {
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = process.argv.slice();
    mockLoadInstance.mockReset();
  });

  afterEach(() => {
    process.argv = savedArgv;
  });

  it('calls loadInstance with argv[2]', async () => {
    process.argv = ['node', 'bootstrap-auth.ts', 'personal'];
    await bootstrapAuth();
    expect(mockLoadInstance).toHaveBeenCalledOnce();
    expect(mockLoadInstance).toHaveBeenCalledWith('personal');
  });

  it('throws when no instance name (no argv[2])', async () => {
    process.argv = ['node', 'bootstrap-auth.ts'];
    await expect(bootstrapAuth()).rejects.toThrow(/Usage: whatsoup-auth/);
  });
});
