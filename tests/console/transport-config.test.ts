import { describe, expect, it } from 'vitest'
import {
  canonicalizeTransportFormData,
  validateTransportFormData,
} from '../../console/src/lib/transport-config'
import { isTransportKind, TRANSPORT_MAP } from '../../console/src/lib/transport-meta'

describe('console transport config', () => {
  it.each([null, 42, {}, [], 'future-provider'])(
    'fails closed on an explicit invalid transport value %#',
    (transport) => {
      const input = {
        name: 'invalid-transport',
        transport,
        adminPhones: ['+15551234567'],
      }

      expect(canonicalizeTransportFormData(input).transport).toBeNull()
      expect(validateTransportFormData(input).transport).toMatch(/valid transport/i)
    },
  )

  it('normalizes phone admins to each transport\'s canonical representation', () => {
    expect(TRANSPORT_MAP.baileys.normalizeAdminId('+1 (555) 123-4567')).toBe('15551234567')
    expect(TRANSPORT_MAP.twilio.normalizeAdminId('+1 (555) 123-4567')).toBe('15551234567')
    expect(TRANSPORT_MAP.signal.normalizeAdminId('+1 (555) 123-4567')).toBe('+15551234567')
    expect(TRANSPORT_MAP.imessage.normalizeAdminId('+1 (555) 123-4567')).toBe('+15551234567')
  })

  it('builds a Twilio poll config from the canonical nested block without serializing secrets', () => {
    const result = canonicalizeTransportFormData({
      name: 'support-line',
      transport: 'twilio',
      twilioConfig: {
        accountSid: `AC${'a'.repeat(32)}`,
        authTokenService: 'whatsoup-twilio-support',
        phoneNumber: '+15551234567',
        authToken: 'must-not-leave-the-browser',
      },
      signalConfig: { phoneNumber: '+15550000000' },
    })

    expect(result).toMatchObject({
      transport: 'twilio',
      twilioConfig: {
        account: 'support-line',
        accountSid: `AC${'a'.repeat(32)}`,
        authTokenService: 'whatsoup-twilio-support',
        phoneNumber: '+15551234567',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
    })
    expect(result).not.toHaveProperty('signalConfig')
    expect(result.twilioConfig).not.toHaveProperty('authToken')
  })

  it('builds Signal and iMessage configs from their canonical nested blocks', () => {
    const signal = canonicalizeTransportFormData({
      name: 'signal-line',
      transport: 'signal',
      signalConfig: {
        phoneNumber: '+15551234567',
        tcpHost: 'localhost',
        tcpPort: 7583,
      },
    })
    expect(signal.signalConfig).toEqual({
      account: 'signal-line',
      phoneNumber: '+15551234567',
      tcpHost: 'localhost',
      tcpPort: 7583,
      inboundMode: 'poll',
      pollIntervalMs: 15_000,
    })

    const imessage = canonicalizeTransportFormData({
      name: 'imessage-line',
      transport: 'imessage',
      imessageConfig: {
        backend: 'bluebubbles',
        sender: 'Owner@Example.com',
        bluebubblesUrl: 'https://messages.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles',
        bluebubblesPassword: 'must-not-be-serialized',
      },
    })
    expect(imessage.imessageConfig).toEqual({
      account: 'imessage-line',
      backend: 'bluebubbles',
      sender: 'owner@example.com',
      bluebubblesUrl: 'https://messages.example.test',
      bluebubblesPasswordService: 'whatsoup-bluebubbles',
      inboundMode: 'poll',
      pollIntervalMs: 15_000,
    })
  })

  it('rejects credentials embedded in the BlueBubbles URL', () => {
    const errors = validateTransportFormData({
      name: 'imessage-line',
      transport: 'imessage',
      adminPhones: ['owner@example.com'],
      imessageConfig: {
        backend: 'bluebubbles',
        sender: 'owner@example.com',
        bluebubblesUrl: 'https://user:secret@messages.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles',
      },
    })

    expect(errors['imessageConfig.bluebubblesUrl']).toContain('must not contain credentials')
  })

  it('fails closed on missing endpoints, sender choices, and malformed admin identities', () => {
    expect(validateTransportFormData({
      name: 'signal-line',
      transport: 'signal',
      adminPhones: ['not-signal'],
      signalConfig: { phoneNumber: '+15551234567' },
    })).toMatchObject({
      adminPhones: expect.any(String),
      'signalConfig.endpoint': expect.any(String),
    })

    expect(validateTransportFormData({
      name: 'twilio-line',
      transport: 'twilio',
      adminPhones: ['15551234567'],
      twilioConfig: {
        accountSid: `AC${'a'.repeat(32)}`,
        authTokenService: 'twilio-service',
      },
    })).toHaveProperty('twilioConfig.sender')
  })

  it('rejects embedded non-phone text before admin identity normalization', () => {
    expect(validateTransportFormData({
      name: 'signal-line',
      transport: 'signal',
      adminPhones: ['privileged-user+15551234567'],
      signalConfig: {
        phoneNumber: '+15551234567',
        socketPath: '/tmp/signal-cli.sock',
      },
    })).toHaveProperty('adminPhones')
  })

  it.each([
    {
      transport: 'twilio',
      configField: 'twilioConfig',
      identityField: 'phoneNumber',
      errorField: 'twilioConfig.sender',
      input: {
        name: 'twilio-line',
        transport: 'twilio',
        adminPhones: ['15551234567'],
        twilioConfig: {
          accountSid: `AC${'a'.repeat(32)}`,
          authTokenService: 'twilio-service',
          phoneNumber: 'privileged-user+15551234567',
        },
      },
    },
    {
      transport: 'signal',
      configField: 'signalConfig',
      identityField: 'phoneNumber',
      errorField: 'signalConfig.phoneNumber',
      input: {
        name: 'signal-line',
        transport: 'signal',
        adminPhones: ['15551234567'],
        signalConfig: {
          phoneNumber: 'privileged-user+15551234567',
          socketPath: '/tmp/signal-cli.sock',
        },
      },
    },
    {
      transport: 'imessage',
      configField: 'imessageConfig',
      identityField: 'sender',
      errorField: 'imessageConfig.sender',
      input: {
        name: 'imessage-line',
        transport: 'imessage',
        adminPhones: ['owner@example.com'],
        imessageConfig: {
          backend: 'imsg',
          sender: 'privileged-user+15551234567',
          imsgSocketPath: '/tmp/imsg.sock',
        },
      },
    },
  ] as const)(
    'rejects embedded non-phone text in $transport provider identity fields',
    ({ configField, identityField, errorField, input }) => {
      expect(validateTransportFormData(input)).toHaveProperty(errorField)
      expect(canonicalizeTransportFormData(input)[configField]?.[identityField]).toBe('')
    },
  )

  it('recognizes only own transport-map keys', () => {
    expect(isTransportKind('baileys')).toBe(true)
    expect(isTransportKind('toString')).toBe(false)
    expect(isTransportKind('constructor')).toBe(false)
    expect(isTransportKind('__proto__')).toBe(false)
  })
})
