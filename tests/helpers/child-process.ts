import { vi } from 'vitest';

export function childProcessMock() {
  return {
    spawn: vi.fn().mockReturnValue({
      unref: vi.fn(),
      on: vi.fn(),
    }),
    execFile: vi.fn(),
  };
}
