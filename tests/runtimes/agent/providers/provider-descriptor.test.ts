import { describe, it, expect } from 'vitest';
import { configuredProviders, describeProvider } from '../../../../src/runtimes/agent/providers/provider-descriptor.ts';

const deps = {
  // stub the eligibility resolver: openai valid, deepseek absent, gemini native
  resolveState: (p: string) =>
    p === 'openai' ? 'present-valid' : p === 'gemini' ? 'native' : 'absent',
  providerIds: () => ['openai', 'deepseek', 'gemini'],
};

it('lists only routable providers as configured', () => {
  const ids = configuredProviders(deps).map((d) => d.id);
  expect(ids).toContain('openai');
  expect(ids).toContain('gemini');       // native fails open → routable
  expect(ids).not.toContain('deepseek'); // absent → not configured
});

it('describes an unconfigured provider without dropping it', () => {
  expect(describeProvider('deepseek', deps)).toMatchObject({ id: 'deepseek', configured: false, state: 'absent' });
});
