import { expect, it } from 'vitest';

import type { ProviderProcessIsolationConfig } from '../../../src/runtimes/agent/provider-process-isolation.ts';
import { providerProcessIsolationFixture } from './provider-process-isolation.fixture.ts';

interface StartedRuntime {
  start(): Promise<void>;
}

export function registerRuntimeProviderProcessIsolationTest<RuntimeType extends StartedRuntime>(deps: {
  createRuntime: (isolation: ProviderProcessIsolationConfig) => RuntimeType;
  sendAndDrain: (runtime: RuntimeType) => Promise<void>;
  capturedSessionManagerOptions: () => unknown;
}): void {
  it('forwards one required process-isolation contract to every created session', async () => {
    const isolation = providerProcessIsolationFixture();
    const runtime = deps.createRuntime(isolation);
    await runtime.start();
    await deps.sendAndDrain(runtime);
    expect(deps.capturedSessionManagerOptions()).toMatchObject({ providerProcessIsolation: isolation });
  });
}
