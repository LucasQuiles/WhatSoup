import { slugAgentWorkspaceName } from './agent-cwd'
import { isTransportKind, TRANSPORT_MAP, type TransportKind } from './transport-meta'
import { asRecordOrEmpty } from './type-guards'
import { isE164WireInput, normalizePhoneIdentityInput } from './validation'

const TWILIO_ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/
const TWILIO_MESSAGING_SERVICE_SID_RE = /^MG[0-9a-f]{32}$/
const KEYRING_SERVICE_RE = /^\S{1,128}$/
const APPLEID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type ConfigRecord = Record<string, unknown>

export type CanonicalTransportFormData = Record<string, unknown> & {
  transport: TransportKind | null
  twilioConfig?: ConfigRecord
  signalConfig?: ConfigRecord
  imessageConfig?: ConfigRecord
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function wirePhone(value: unknown): string {
  const raw = text(value)
  if (!raw) return ''
  const normalized = normalizePhoneIdentityInput(raw)
  return normalized ? `+${normalized}` : ''
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  const parts = normalized.split('.')
  if (parts.length !== 4 || parts.some(part => part === '' || !Number.isInteger(Number(part)))) return false
  const octets = parts.map(Number)
  return octets.every(octet => octet >= 0 && octet <= 255) && octets[0] === 127
}

function isTrustedBluebubblesUrl(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname))
}

function accountName(data: Record<string, unknown>): string {
  return slugAgentWorkspaceName(text(data.name))
}

function bluebubblesPasswordServiceForAccount(account: string): string {
  return `whatsoup-bluebubbles-${account}`
}

function twilioAuthTokenServiceForAccount(account: string): string {
  return `whatsoup-twilio-${account}`
}

export function canonicalizeTransportFormData(
  data: Record<string, unknown>,
): CanonicalTransportFormData {
  const transport = data.transport === undefined
    ? 'baileys'
    : isTransportKind(data.transport) ? data.transport : null
  const result: CanonicalTransportFormData = { ...data, transport }
  delete result.twilioConfig
  delete result.signalConfig
  delete result.imessageConfig

  const account = accountName(data)
  if (data.type === 'passive') {
    result.accessMode = 'self_only'
  } else if (
    transport === 'twilio'
    && (result.accessMode === undefined || result.accessMode === 'self_only' || result.accessMode === 'groups_only')
  ) {
    result.accessMode = 'allowlist'
  }
  if (transport === 'twilio') {
    const source = asRecordOrEmpty(data.twilioConfig)
    const config: ConfigRecord = {
      account,
      accountSid: text(source.accountSid),
      authTokenService: twilioAuthTokenServiceForAccount(account),
      inboundMode: 'poll',
      pollIntervalMs: 15_000,
    }
    const hasMessagingServiceSid = source.messagingServiceSid !== undefined
    if (hasMessagingServiceSid) config.messagingServiceSid = text(source.messagingServiceSid)
    if (!hasMessagingServiceSid || text(source.phoneNumber)) config.phoneNumber = wirePhone(source.phoneNumber)
    result.twilioConfig = config
  } else if (transport === 'signal') {
    const source = asRecordOrEmpty(data.signalConfig)
    const config: ConfigRecord = {
      account,
      phoneNumber: wirePhone(source.phoneNumber),
      inboundMode: 'poll',
      pollIntervalMs: 15_000,
    }
    const hasSocketPath = source.socketPath !== undefined
    const hasTcpEndpoint = source.tcpPort !== undefined || source.tcpHost !== undefined
    const socketPath = text(source.socketPath)
    const tcpPort = typeof source.tcpPort === 'number' ? source.tcpPort : Number(source.tcpPort)
    if (hasSocketPath && (socketPath || !hasTcpEndpoint)) {
      config.socketPath = socketPath
    }
    if (hasTcpEndpoint) {
      config.tcpHost = text(source.tcpHost) || '127.0.0.1'
      config.tcpPort = Number.isInteger(tcpPort) && tcpPort > 0 ? tcpPort : text(source.tcpPort)
    }
    result.signalConfig = config
  } else if (transport === 'imessage') {
    const source = asRecordOrEmpty(data.imessageConfig)
    const backend = source.backend === undefined
      ? 'bluebubbles'
      : source.backend === 'imsg' || source.backend === 'bluebubbles'
        ? source.backend
        : null
    const rawSender = text(source.sender)
    const sender = rawSender.includes('@') ? rawSender.toLowerCase() : wirePhone(rawSender)
    const config: ConfigRecord = {
      account,
      backend,
      sender,
      inboundMode: 'poll',
      pollIntervalMs: 15_000,
    }
    if (backend === 'imsg') {
      config.imsgSocketPath = text(source.imsgSocketPath)
    } else if (backend === 'bluebubbles') {
      config.bluebubblesUrl = text(source.bluebubblesUrl)
      config.bluebubblesPasswordService = text(source.bluebubblesPasswordService)
    }
    result.imessageConfig = config
  }

  return result
}

export function transportAttestationFingerprint(data: Record<string, unknown>): string {
  const canonical = canonicalizeTransportFormData(data)
  const transport = canonical.transport
  const config = transport === 'twilio'
    ? canonical.twilioConfig
    : transport === 'signal'
      ? canonical.signalConfig
      : transport === 'imessage'
        ? canonical.imessageConfig
        : null
  return JSON.stringify([transport, config ?? null])
}

export function validateTransportFormData(data: Record<string, unknown>): Record<string, string> {
  const canonical = canonicalizeTransportFormData(data)
  const errors: Record<string, string> = {}
  if (canonical.transport === null) {
    errors.transport = 'Select a valid transport'
    return errors
  }
  const admins = Array.isArray(data.adminPhones) ? data.adminPhones : []
  const meta = TRANSPORT_MAP[canonical.transport]
  if (admins.length === 0 || admins.some((value) => typeof value !== 'string' || !meta.validateAdminId(value))) {
    errors.adminPhones = `Add at least one valid ${meta.adminIdLabel.toLowerCase().replace(/^admin /, '')}`
  }

  if (canonical.transport === 'twilio') {
    const config = canonical.twilioConfig ?? {}
    if (!TWILIO_ACCOUNT_SID_RE.test(text(config.accountSid))) {
      errors['twilioConfig.accountSid'] = 'Enter a Twilio Account SID (AC followed by 32 lowercase hex characters)'
    }
    const expectedAuthTokenService = twilioAuthTokenServiceForAccount(text(config.account))
    if (!KEYRING_SERVICE_RE.test(text(config.authTokenService)) || text(config.authTokenService) !== expectedAuthTokenService) {
      errors['twilioConfig.authTokenService'] = `Use ${expectedAuthTokenService} for this line's Twilio auth token`
    }
    const phone = text(config.phoneNumber)
    const service = text(config.messagingServiceSid)
    if ((phone ? 1 : 0) + (service ? 1 : 0) !== 1 || (phone && !isE164WireInput(phone)) || (service && !TWILIO_MESSAGING_SERVICE_SID_RE.test(service))) {
      errors['twilioConfig.sender'] = 'Set exactly one valid Twilio phone number or Messaging Service SID'
    }
  } else if (canonical.transport === 'signal') {
    const config = canonical.signalConfig ?? {}
    if (!isE164WireInput(text(config.phoneNumber))) {
      errors['signalConfig.phoneNumber'] = 'Enter the Signal account phone number in E.164 format'
    }
    const socketPath = text(config.socketPath)
    const tcpHost = text(config.tcpHost)
    const tcpPort = config.tcpPort
    const hasSocketEndpoint = socketPath !== ''
    const hasTcpEndpoint = config.tcpHost !== undefined || config.tcpPort !== undefined
    const validTcpPort = typeof tcpPort === 'number' && Number.isInteger(tcpPort) && tcpPort >= 1 && tcpPort <= 65535
    if (hasSocketEndpoint && hasTcpEndpoint) {
      errors['signalConfig.endpoint'] = 'Set either a UNIX socket or a loopback TCP endpoint, not both'
    } else if ((!hasSocketEndpoint || !socketPath.startsWith('/')) && !validTcpPort) {
      errors['signalConfig.endpoint'] = 'Set an absolute UNIX socket path or a loopback TCP port'
    }
    if (hasTcpEndpoint && !isLoopbackHostname(tcpHost || '127.0.0.1')) {
      errors['signalConfig.tcpHost'] = 'Signal TCP host must be loopback because signal-cli TCP is plaintext'
    }
  } else if (canonical.transport === 'imessage') {
    const config = canonical.imessageConfig ?? {}
    const sender = text(config.sender)
    if (!(isE164WireInput(sender) || (APPLEID_EMAIL_RE.test(sender) && sender === sender.toLowerCase()))) {
      errors['imessageConfig.sender'] = 'Enter a lowercase AppleID email or E.164 sender'
    }
    if (config.backend !== 'imsg' && config.backend !== 'bluebubbles') {
      errors['imessageConfig.backend'] = 'Select imsg or BlueBubbles as the iMessage backend'
    } else if (config.backend === 'imsg') {
      if (!text(config.imsgSocketPath).startsWith('/')) {
        errors['imessageConfig.imsgSocketPath'] = 'Enter an absolute imsg socket path'
      }
    } else {
      try {
        const url = new URL(text(config.bluebubblesUrl))
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid protocol')
        if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
          errors['imessageConfig.bluebubblesUrl'] = 'BlueBubbles URL must not contain credentials or a query or fragment'
        } else if (!isTrustedBluebubblesUrl(url)) {
          errors['imessageConfig.bluebubblesUrl'] = 'BlueBubbles URL must use HTTPS unless the server is on loopback'
        }
      } catch {
        errors['imessageConfig.bluebubblesUrl'] = 'Enter the BlueBubbles http(s) URL'
      }
      const expectedService = bluebubblesPasswordServiceForAccount(text(config.account))
      if (text(config.bluebubblesPasswordService) !== expectedService) {
        errors['imessageConfig.bluebubblesPasswordService'] = `Use ${expectedService} for this line's BlueBubbles password`
      }
    }
  }

  return errors
}
