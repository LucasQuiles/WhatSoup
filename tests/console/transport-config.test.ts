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

  it.each([
    'owner\u0007@example.com',
    'owner\u202E@example.com',
    'owner\u200B@example.com',
    'owner\u2028@example.com',
  ])('rejects unsafe iMessage AppleID admin and sender text %#', (identity) => {
    expect(TRANSPORT_MAP.imessage.validateAdminId(identity)).toBe(false)
    expect(TRANSPORT_MAP.imessage.normalizeAdminId(identity)).toBe('')
    expect(validateTransportFormData({
      name: 'imessage-line',
      transport: 'imessage',
      adminPhones: ['owner@example.com'],
      imessageConfig: {
        backend: 'imsg',
        sender: identity,
        imsgSocketPath: '/tmp/imsg.sock',
      },
    })).toHaveProperty('imessageConfig.sender')
  })

  it('builds a Twilio poll config from the canonical nested block without serializing secrets', () => {
    const result = canonicalizeTransportFormData({
      name: 'support-line',
      transport: 'twilio',
      twilioConfig: {
        accountSid: `AC${'a'.repeat(32)}`,
        authTokenService: 'whatsoup-twilio-other-line',
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
        authTokenService: 'whatsoup-twilio-support-line',
        phoneNumber: '+15551234567',
        inboundMode: 'poll',
        pollIntervalMs: 15_000,
      },
    })
    expect(result).not.toHaveProperty('signalConfig')
    expect(result.twilioConfig).not.toHaveProperty('authToken')
  })

  it('derives the Twilio keyring selector instead of preserving a hostile override', () => {
    const input = {
      name: 'support-line',
      transport: 'twilio',
      adminPhones: ['+15551234567'],
      twilioConfig: {
        accountSid: `AC${'a'.repeat(32)}`,
        authTokenService: 'openai',
        phoneNumber: '+15551234567',
      },
    }
    expect(canonicalizeTransportFormData(input).twilioConfig?.authTokenService)
      .toBe('whatsoup-twilio-support-line')
    expect(validateTransportFormData(input)).not.toHaveProperty('twilioConfig.authTokenService')
  })

  it('defaults interactive Twilio SMS to allowlist while preserving intentional functional modes', () => {
    expect(canonicalizeTransportFormData({
      transport: 'twilio',
      type: 'chat',
      accessMode: 'self_only',
    }).accessMode).toBe('allowlist')
    expect(canonicalizeTransportFormData({
      transport: 'twilio',
      type: 'agent',
      accessMode: 'open_dm',
    }).accessMode).toBe('open_dm')
    expect(canonicalizeTransportFormData({
      transport: 'twilio',
      type: 'chat',
      accessMode: 'groups_only',
    }).accessMode).toBe('allowlist')
  })

  it('keeps passive Twilio SMS on the server-required self_only mode', () => {
    expect(canonicalizeTransportFormData({
      transport: 'twilio',
      type: 'passive',
      accessMode: 'allowlist',
    }).accessMode).toBe('self_only')
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
        bluebubblesPasswordService: 'whatsoup-bluebubbles-imessage-line',
        bluebubblesPassword: 'must-not-be-serialized',
      },
    })
    expect(imessage.imessageConfig).toEqual({
      account: 'imessage-line',
      backend: 'bluebubbles',
      sender: 'owner@example.com',
      bluebubblesUrl: 'https://messages.example.test',
      bluebubblesPasswordService: 'whatsoup-bluebubbles-imessage-line',
      inboundMode: 'poll',
      pollIntervalMs: 15_000,
    })
  })

  it('rejects a non-loopback Signal TCP host before Review submits it', () => {
    const errors = validateTransportFormData({
      name: 'signal-line',
      transport: 'signal',
      adminPhones: ['+15551234567'],
      signalConfig: {
        phoneNumber: '+15551234567',
        tcpHost: '192.0.2.10',
        tcpPort: 7583,
      },
    })

    expect(errors['signalConfig.tcpHost']).toMatch(/loopback/i)
  })

  it.each(['127.0.0.2', '127.255.255.255', '[::1]', 'LOCALHOST'])(
    'matches the server allowlist by rejecting unsupported Signal TCP host %s',
    (tcpHost) => {
      const errors = validateTransportFormData({
        name: 'signal-line',
        transport: 'signal',
        adminPhones: ['+15551234567'],
        signalConfig: {
          phoneNumber: '+15551234567',
          tcpHost,
          tcpPort: 7583,
        },
      })

      expect(errors['signalConfig.tcpHost']).toMatch(/127\.0\.0\.1.*::1.*localhost/i)
    },
  )

  it('rejects conflicting Signal UNIX and TCP endpoints before Review submits them', () => {
    const errors = validateTransportFormData({
      name: 'signal-line',
      transport: 'signal',
      adminPhones: ['+15551234567'],
      signalConfig: {
        phoneNumber: '+15551234567',
        socketPath: '/tmp/signal-cli.sock',
        tcpHost: '127.0.0.1',
        tcpPort: 7583,
      },
    })

    expect(errors['signalConfig.endpoint']).toMatch(/either.*not both/i)
  })

  it('fails closed on an explicit invalid iMessage backend', () => {
    const input = {
      name: 'imessage-line',
      transport: 'imessage',
      adminPhones: ['owner@example.com'],
      imessageConfig: {
        backend: 'not-a-backend',
        sender: 'owner@example.com',
      },
    }

    expect(validateTransportFormData(input)['imessageConfig.backend']).toMatch(/imsg or BlueBubbles/i)
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
        bluebubblesPasswordService: 'whatsoup-bluebubbles-imessage-line',
      },
    })

    expect(errors['imessageConfig.bluebubblesUrl']).toContain('must not contain credentials')
  })

  it.each([
    'https://messages.example.test/api?password=url-query-marker',
    'https://messages.example.test/api#url-fragment-marker',
  ])('rejects query or fragment components in the BlueBubbles URL: %s', (bluebubblesUrl) => {
    const errors = validateTransportFormData({
      name: 'imessage-line',
      transport: 'imessage',
      adminPhones: ['owner@example.com'],
      imessageConfig: {
        backend: 'bluebubbles',
        sender: 'owner@example.com',
        bluebubblesUrl,
        bluebubblesPasswordService: 'whatsoup-bluebubbles-imessage-line',
      },
    })

    expect(errors['imessageConfig.bluebubblesUrl']).toContain('query or fragment')
  })

  it('rejects a BlueBubbles password service owned by another line', () => {
    const errors = validateTransportFormData({
      name: 'imessage-line',
      transport: 'imessage',
      adminPhones: ['owner@example.com'],
      imessageConfig: {
        backend: 'bluebubbles',
        sender: 'owner@example.com',
        bluebubblesUrl: 'https://messages.example.test',
        bluebubblesPasswordService: 'whatsoup-bluebubbles-other-line',
      },
    })

    expect(errors['imessageConfig.bluebubblesPasswordService']).toContain('imessage-line')
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
