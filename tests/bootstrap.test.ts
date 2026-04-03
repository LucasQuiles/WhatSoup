import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock instance-loader before importing bootstrap
vi.mock('../src/instance-loader.ts', () => ({
  loadInstance: vi.fn(),
}));

// Mock main.ts to prevent side effects from config.ts / logger.ts
vi.mock('../src/main.ts', () => ({}));

import { loadInstance } from '../src/instance-loader.ts';
import { bootstrap } from '../src/bootstrap.ts';

const mockLoadInstance = vi.mocked(loadInstance);

describe('bootstrap', () => {
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = process.argv.slice();
    mockLoadInstance.mockReset();
  });

  afterEach(() => {
    process.argv = savedArgv;
  });

  it('calls loadInstance with argv[2]', async () => {
    process.argv = ['node', 'bootstrap.ts', 'loops'];
    await bootstrap();
    expect(mockLoadInstance).toHaveBeenCalledOnce();
    expect(mockLoadInstance).toHaveBeenCalledWith('loops', undefined);
  });

  it('throws when no instance name (no argv[2])', async () => {
    process.argv = ['node', 'bootstrap.ts'];
    await expect(bootstrap()).rejects.toThrow(/Usage: whatsoup/);
  });
});
