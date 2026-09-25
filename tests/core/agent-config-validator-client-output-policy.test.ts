import { describe, expect, it } from 'vitest';
import { validateInstanceConfig, type ValidatorContext } from '../../src/core/agent-config-validator.ts';

const SYNTHETIC_PHONE = ['1555', '000', '0000'].join('');
const SYNTHETIC_POLICY = {
  conversationKey: 'synthetic-conversation',
  maxCodePoints: 500,
  maxQuestionMarks: 1,
  blockedTerms: [],
  rejectInternalArtifacts: true,
  rejectWhatsAppJids: true,
};

function validate(
  overrides: Record<string, unknown>,
  mode: ValidatorContext['mode'] = 'create',
) {
  return validateInstanceConfig({
    name: 'synthetic-agent',
    type: 'agent',
    adminPhones: [SYNTHETIC_PHONE],
    accessMode: 'self_only',
    ...overrides,
  }, {
    name: 'synthetic-agent',
    mode,
    ...(mode === 'patch' ? { originalType: 'agent' } : {}),
  });
}

describe('validateInstanceConfig clientOutputPolicies admission', () => {
  it('rejects an explicit null instead of treating it as absent', () => {
    expect(validate({ clientOutputPolicies: null })).toMatchObject({
      field: 'clientOutputPolicies',
    });
  });

  it('rejects the field for a chat instance', () => {
    expect(validate({
      type: 'chat',
      clientOutputPolicies: [SYNTHETIC_POLICY],
    })).toMatchObject({
      field: 'clientOutputPolicies',
    });
  });

  it('rejects the field for an agent using a non-Baileys transport', () => {
    expect(validate({
      transport: 'signal',
      signalConfig: {
        account: 'synthetic-account',
        phoneNumber: `+${SYNTHETIC_PHONE}`,
        socketPath: '/tmp/synthetic-signal.sock',
      },
      clientOutputPolicies: [SYNTHETIC_POLICY],
    })).toMatchObject({
      field: 'clientOutputPolicies',
    });
  });

  it.each(['create', 'patch', 'load', 'discovery'] as const)(
    'uses the same validator in %s mode',
    (mode) => {
      expect(validate({ clientOutputPolicies: [SYNTHETIC_POLICY] }, mode)).toBeNull();
      expect(validate({
        clientOutputPolicies: [{ ...SYNTHETIC_POLICY, maxQuestionMarks: 21 }],
      }, mode)).toMatchObject({
        field: 'clientOutputPolicies[0].maxQuestionMarks',
      });
    },
  );

  it('keeps the historical top-level config open while closing nested policy objects', () => {
    expect(validate({
      futureTopLevelField: { retained: true },
      clientOutputPolicies: [SYNTHETIC_POLICY],
    })).toBeNull();
    expect(validate({
      clientOutputPolicies: [{ ...SYNTHETIC_POLICY, leakedExtension: true }],
    })).toMatchObject({
      field: 'clientOutputPolicies[0]',
    });
  });

  it('returns field/index/reason without echoing invalid private values', () => {
    const privateValue = 'private-term-that-must-not-echo';
    const result = validate({
      clientOutputPolicies: [{
        ...SYNTHETIC_POLICY,
        blockedTerms: [{ value: privateValue, match: 'invalid', caseSensitive: false }],
      }],
    });

    expect(result).toMatchObject({
      field: 'clientOutputPolicies[0].blockedTerms[0].match',
    });
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  it('rejects key IDs containing a colon under the approved ASCII-token grammar', () => {
    expect(validate({
      clientOutputPolicies: [{
        ...SYNTHETIC_POLICY,
        authorization: {
          keyId: 'synthetic:key',
          publicKey: Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'),
            Buffer.alloc(32, 9),
          ]).toString('base64url'),
          requiredActions: ['send_message'],
        },
      }],
    })).toMatchObject({
      field: 'clientOutputPolicies[0].authorization.keyId',
    });
  });
});
