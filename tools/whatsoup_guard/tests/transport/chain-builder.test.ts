import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPolicy } from '../../src/policy/loader.ts';
import { buildAlertChain, buildMetaAlertSinks } from '../../src/transport/chain-builder.ts';

function profile(name: string): string {
  return new URL(`../../src/policy/profiles/${name}.yaml`, import.meta.url).pathname;
}

describe('transport chain builder', () => {
  it('builds WhatSoup sink, local-notify, and local-log from a personal-strict policy', () => {
    const policy = loadPolicy(profile('personal-strict'));
    const chain = buildAlertChain(policy);

    expect(chain.map((sink) => sink.name)).toEqual(['whatsoup', 'local-notify', 'local-log']);
  });

  it('builds ntfy meta-alert sink from production policy', () => {
    const policy = loadPolicy(profile('production'));
    const sinks = buildMetaAlertSinks(policy);

    expect(sinks).toHaveLength(1);
    expect(sinks[0]!.name).toBe('meta-ntfy');
  });

  it('returns empty meta-alert sinks when meta_alert.enabled is false', () => {
    const policy = loadPolicy(profile('development'));

    expect(buildMetaAlertSinks(policy)).toEqual([]);
  });

  it('keeps local fallback sinks when a configured WhatSoup token file is missing', async () => {
    const missingTokenPath = join(tmpdir(), `wg-missing-token-${Date.now()}`);
    const policy = loadPolicy(profile('personal-strict'));
    policy.transport.alert_sink = {
      ...policy.transport.alert_sink,
      base_url: 'https://whatsoup.invalid',
      conversation_key: 'conversation-alpha',
      token_file: missingTokenPath,
    };

    const chain = buildAlertChain(policy);

    expect(chain.map((sink) => sink.name)).toEqual(['whatsoup', 'local-notify', 'local-log']);
    const result = await chain[0]!.deliver({ body: 'hello operator' });
    expect(result).toMatchObject({
      ok: false,
      channel: 'whatsoup',
    });
    expect(result.error).toContain(missingTokenPath);
  });

  it('returns a failed meta-alert sink when a configured meta secret file is missing', async () => {
    const missingSecretPath = join(tmpdir(), `wg-missing-meta-secret-${Date.now()}`);
    const policy = loadPolicy(profile('production'));
    policy.transport.meta_alert = {
      enabled: true,
      provider: 'ntfy',
      topic_or_destination: 'operator-topic',
      secret_file: missingSecretPath,
    };

    const sinks = buildMetaAlertSinks(policy);

    expect(sinks.map((sink) => sink.name)).toEqual(['meta-ntfy']);
    const result = await sinks[0]!.deliver({ body: 'hello operator' });
    expect(result).toMatchObject({
      ok: false,
      channel: 'meta-ntfy',
    });
    expect(result.error).toContain(missingSecretPath);
    expect(result.error).not.toContain('hello operator');
  });
});
