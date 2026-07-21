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

function accountName(data: Record<string, unknown>): string {
  return slugAgentWorkspaceName(text(data.name))
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
  if (transport === 'twilio') {
    const source = asRecordOrEmpty(data.twilioConfig)
    const config: ConfigRecord = {
      account,
      accountSid: text(source.accountSid),
      authTokenService: text(source.authTokenService),
      inboundMode: 'poll',
      pollIntervalMs: 15_000,
    }
    const messagingServiceSid = text(source.messagingServiceSid)
    if (messagingServiceSid) config.messagingServiceSid = messagingServiceSid
    else config.phoneNumber = wirePhone(source.phoneNumber)
    result.twilioConfig = config
  } else if (transport === 'signal') {
    const source = asRecordOrEmpty(data.signalConfig)
    const config: ConfigRecord = {
      account,
      phoneNumber: wirePhone(source.phoneNumber),
      inboundMode: 'poll',
      pollIntervalMs: 15_000,
    }
    const socketPath = text(source.socketPath)
    const tcpPort = typeof source.tcpPort === 'number' ? source.tcpPort : Number(source.tcpPort)
    if (socketPath) {
      config.socketPath = socketPath
    } else if (Number.isInteger(tcpPort) && tcpPort > 0) {
      config.tcpHost = text(source.tcpHost) || '127.0.0.1'
      config.tcpPort = tcpPort
    }
    result.signalConfig = config
  } else if (transport === 'imessage') {
    const source = asRecordOrEmpty(data.imessageConfig)
    const backend = source.backend === 'imsg' ? 'imsg' : 'bluebubbles'
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
    } else {
      config.bluebubblesUrl = text(source.bluebubblesUrl)
      config.bluebubblesPasswordService = text(source.bluebubblesPasswordService)
    }
    result.imessageConfig = config
  }

  return result
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
    if (!KEYRING_SERVICE_RE.test(text(config.authTokenService))) {
      errors['twilioConfig.authTokenService'] = 'Enter the keyring service that stores the Twilio auth token'
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
    const tcpPort = config.tcpPort
    if ((!socketPath || !socketPath.startsWith('/')) && !(typeof tcpPort === 'number' && Number.isInteger(tcpPort) && tcpPort >= 1 && tcpPort <= 65535)) {
      errors['signalConfig.endpoint'] = 'Set an absolute UNIX socket path or a loopback TCP port'
    }
  } else if (canonical.transport === 'imessage') {
    const config = canonical.imessageConfig ?? {}
    const sender = text(config.sender)
    if (!(isE164WireInput(sender) || (APPLEID_EMAIL_RE.test(sender) && sender === sender.toLowerCase()))) {
      errors['imessageConfig.sender'] = 'Enter a lowercase AppleID email or E.164 sender'
    }
    if (config.backend === 'imsg') {
      if (!text(config.imsgSocketPath).startsWith('/')) {
        errors['imessageConfig.imsgSocketPath'] = 'Enter an absolute imsg socket path'
      }
    } else {
      try {
        const url = new URL(text(config.bluebubblesUrl))
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid protocol')
        if (url.username !== '' || url.password !== '') {
          errors['imessageConfig.bluebubblesUrl'] = 'BlueBubbles URL must not contain credentials'
        }
      } catch {
        errors['imessageConfig.bluebubblesUrl'] = 'Enter the BlueBubbles http(s) URL'
      }
      if (!KEYRING_SERVICE_RE.test(text(config.bluebubblesPasswordService))) {
        errors['imessageConfig.bluebubblesPasswordService'] = 'Enter the keyring service that stores the BlueBubbles password'
      }
    }
  }

  return errors
}
