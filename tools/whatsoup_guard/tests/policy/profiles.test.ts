import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/loader.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = resolve(HERE, '../../src/policy/profiles');

const PROFILE_NAMES = ['development', 'personal-strict', 'production', 'customer-managed'] as const;
type ProfileName = (typeof PROFILE_NAMES)[number];

const ACTION_KEYS = [
  'alerting.self_secret_widened',
  'alerting.transport_failed',
  'capability.role_violation',
  'change.new_application_route',
  'change.new_persistence_unit',
  'credential.file_mode_widened',
  'credential.token_aging',
  'exposure.firewall_disabled',
  'exposure.public_funnel_internal',
  'exposure.unauthenticated_mutation',
] as const;

const EXPECTED_EXTENDS: Record<ProfileName, ProfileName> = {
  development: 'development',
  'personal-strict': 'development',
  production: 'personal-strict',
  'customer-managed': 'production',
};

function profilePath(name: ProfileName): string {
  return resolve(PROFILE_DIR, `${name}.yaml`);
}

function profileText(name: ProfileName): string {
  return readFileSync(profilePath(name), 'utf8');
}

function loadedProfile(name: ProfileName) {
  return loadPolicy(profilePath(name));
}

describe('shipped profiles', () => {
  for (const name of PROFILE_NAMES) {
    it(`loads ${name}.yaml with no local inventory or transport identifiers`, () => {
      const p = loadedProfile(name);

      expect(p.extends).toBe(EXPECTED_EXTENDS[name]);
      expect(p.inventory.hosts).toEqual([]);
      expect(p.inventory.instances).toEqual([]);
      expect(p.deployment_roles).toEqual({});
      expect(Object.keys(p.actions).sort()).toEqual([...ACTION_KEYS].sort());
      expect(p.transport.alert_sink.kind).toBe('whatsoup');
      expect(p.transport.alert_sink).not.toHaveProperty('base_url');
      expect(p.transport.alert_sink).not.toHaveProperty('conversation_key');
      expect(p.transport.alert_sink).not.toHaveProperty('delivery_jid');
      expect(p.transport.alert_sink).not.toHaveProperty('target_label');
      expect(p.transport.alert_sink).not.toHaveProperty('token_file');
      expect(p.transport.meta_alert).not.toHaveProperty('provider');
      expect(p.transport.meta_alert).not.toHaveProperty('secret_file');
      expect(p.transport.meta_alert).not.toHaveProperty('topic_or_destination');
      expect(p.mute_constraints.forbidden_domains).toEqual(['alerting']);
      expect(p.mute_constraints.wildcard_blocks_remediation).toBe(true);
    });
  }

  it('matches the shipped profile action and duration contract', () => {
    const summary = Object.fromEntries(
      PROFILE_NAMES.map((name) => {
        const p = loadedProfile(name);
        return [
          name,
          {
            actions: p.actions,
            defaultMaxDuration: p.mute_constraints.default_max_duration,
            metaAlertEnabled: p.transport.meta_alert?.enabled,
          },
        ];
      }),
    );

    expect(summary).toMatchInlineSnapshot(`
      {
        "customer-managed": {
          "actions": {
            "alerting.self_secret_widened": "alert",
            "alerting.transport_failed": "meta_alert",
            "capability.role_violation": "alert",
            "change.new_application_route": "alert",
            "change.new_persistence_unit": "alert",
            "credential.file_mode_widened": "alert",
            "credential.token_aging": "alert",
            "exposure.firewall_disabled": "alert",
            "exposure.public_funnel_internal": "alert",
            "exposure.unauthenticated_mutation": "alert",
          },
          "defaultMaxDuration": "24h",
          "metaAlertEnabled": false,
        },
        "development": {
          "actions": {
            "alerting.self_secret_widened": "alert",
            "alerting.transport_failed": "meta_alert",
            "capability.role_violation": "observe",
            "change.new_application_route": "observe",
            "change.new_persistence_unit": "observe",
            "credential.file_mode_widened": "alert",
            "credential.token_aging": "observe",
            "exposure.firewall_disabled": "alert",
            "exposure.public_funnel_internal": "alert",
            "exposure.unauthenticated_mutation": "alert",
          },
          "defaultMaxDuration": "72h",
          "metaAlertEnabled": false,
        },
        "personal-strict": {
          "actions": {
            "alerting.self_secret_widened": "alert",
            "alerting.transport_failed": "meta_alert",
            "capability.role_violation": "alert",
            "change.new_application_route": "alert",
            "change.new_persistence_unit": "alert",
            "credential.file_mode_widened": "alert",
            "credential.token_aging": "propose_fix",
            "exposure.firewall_disabled": "propose_fix",
            "exposure.public_funnel_internal": "propose_fix",
            "exposure.unauthenticated_mutation": "propose_fix",
          },
          "defaultMaxDuration": "24h",
          "metaAlertEnabled": false,
        },
        "production": {
          "actions": {
            "alerting.self_secret_widened": "alert",
            "alerting.transport_failed": "meta_alert",
            "capability.role_violation": "alert",
            "change.new_application_route": "alert",
            "change.new_persistence_unit": "alert",
            "credential.file_mode_widened": "alert",
            "credential.token_aging": "alert",
            "exposure.firewall_disabled": "propose_fix",
            "exposure.public_funnel_internal": "propose_fix",
            "exposure.unauthenticated_mutation": "propose_fix",
          },
          "defaultMaxDuration": "8h",
          "metaAlertEnabled": true,
        },
      }
    `);
  });

  it('enables meta-alert for production', () => {
    expect(loadedProfile('production').transport.meta_alert?.enabled).toBe(true);
  });

  it('ships the documented profile inheritance chain', () => {
    expect(loadedProfile('personal-strict').extends).toBe('development');
    expect(loadedProfile('production').extends).toBe('personal-strict');
    expect(loadedProfile('customer-managed').extends).toBe('production');
  });

  it('ships no unsupported runtime actions', () => {
    for (const name of PROFILE_NAMES) {
      expect(Object.entries(loadedProfile(name).actions)).not.toContainEqual(
        expect.arrayContaining([expect.any(String), 'remediate']),
      );
      expect(Object.entries(loadedProfile(name).actions)).not.toContainEqual(
        expect.arrayContaining([expect.any(String), 'block']),
      );
    }
  });

  it('keeps profile YAML free of concrete deployment labels and URL-like tokens', () => {
    for (const name of PROFILE_NAMES) {
      const text = profileText(name);
      const textWithoutGenericKeys = text
        .replaceAll('deployment_roles', '')
        .replaceAll('exposure.public_funnel_internal', '');

      expect(text).not.toMatch(/\b(?:base_url|conversation_key|delivery_jid|target_label|token_file):/u);
      expect(text).not.toMatch(/\b(?:provider|secret_file|topic_or_destination):/u);
      expect(text).not.toMatch(/\b(?:https?:\/\/|[a-z][a-z0-9+.-]*:\/\/)/iu);
      expect(text).not.toMatch(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/u);
      expect(text).not.toMatch(/\b[a-z0-9-]+\.(?:com|dev|io|net|org|local|test)\b/iu);
      expect(textWithoutGenericKeys).not.toMatch(/\b(?:internal|deployment)\b/iu);
    }
  });
});
