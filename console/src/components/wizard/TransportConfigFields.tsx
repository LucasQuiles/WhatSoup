import { type FC } from 'react'
import { Field, SelectInput, TextInput } from '../primitives'
import type { TransportKind } from '../../lib/transport-meta'

interface TransportConfigFieldsProps {
  transport: TransportKind
  data: Record<string, unknown>
  errors: Record<string, string>
  onChange: (patch: Record<string, unknown>) => void
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function value(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

const TransportConfigFields: FC<TransportConfigFieldsProps> = ({
  transport,
  data,
  errors,
  onChange,
}) => {
  if (transport === 'baileys') return null

  const field = `${transport}Config`
  const config = record(data[field])
  const update = (patch: Record<string, unknown>) => onChange({
    [field]: { ...config, ...patch },
  })

  if (transport === 'twilio') {
    const senderKind = value(config.messagingServiceSid) ? 'messaging-service' : 'phone'
    return (
      <section aria-labelledby="twilio-transport-config" className="flex flex-col gap-[var(--sp-3)] rounded-md border border-border-subtle bg-surface-inset p-[var(--sp-4)]">
        <h4 id="twilio-transport-config" className="c-heading">Twilio transport setup</h4>
        <Field label="Twilio Account SID" error={errors['twilioConfig.accountSid']}>
          {(id) => <TextInput id={id} value={value(config.accountSid)} onChange={(event) => update({ accountSid: event.target.value })} placeholder={`AC${'0'.repeat(32)}`} error={Boolean(errors['twilioConfig.accountSid'])} />}
        </Field>
        <Field label="Twilio auth-token keyring service" helper="The token stays in the OS keyring; only its service name is saved." error={errors['twilioConfig.authTokenService']}>
          {(id) => <TextInput id={id} value={value(config.authTokenService)} onChange={(event) => update({ authTokenService: event.target.value })} placeholder="whatsoup-twilio" error={Boolean(errors['twilioConfig.authTokenService'])} />}
        </Field>
        <Field label="Twilio sender type">
          {(id) => (
            <SelectInput
              id={id}
              value={senderKind}
              onChange={(event) => update(event.target.value === 'phone'
                ? { phoneNumber: '', messagingServiceSid: undefined }
                : { phoneNumber: undefined, messagingServiceSid: '' })}
            >
              <option value="phone">Phone number</option>
              <option value="messaging-service">Messaging Service SID</option>
            </SelectInput>
          )}
        </Field>
        {senderKind === 'phone' ? (
          <Field label="Twilio phone number" error={errors['twilioConfig.sender']}>
            {(id) => <TextInput id={id} value={value(config.phoneNumber)} onChange={(event) => update({ phoneNumber: event.target.value })} placeholder="+15551234567" error={Boolean(errors['twilioConfig.sender'])} />}
          </Field>
        ) : (
          <Field label="Twilio Messaging Service SID" error={errors['twilioConfig.sender']}>
            {(id) => <TextInput id={id} value={value(config.messagingServiceSid)} onChange={(event) => update({ messagingServiceSid: event.target.value })} placeholder={`MG${'0'.repeat(32)}`} error={Boolean(errors['twilioConfig.sender'])} />}
          </Field>
        )}
      </section>
    )
  }

  if (transport === 'signal') {
    const endpointKind = value(config.tcpPort) ? 'tcp' : 'socket'
    return (
      <section aria-labelledby="signal-transport-config" className="flex flex-col gap-[var(--sp-3)] rounded-md border border-border-subtle bg-surface-inset p-[var(--sp-4)]">
        <h4 id="signal-transport-config" className="c-heading">Signal transport setup</h4>
        <Field label="Signal account number" error={errors['signalConfig.phoneNumber']}>
          {(id) => <TextInput id={id} value={value(config.phoneNumber)} onChange={(event) => update({ phoneNumber: event.target.value })} placeholder="+15551234567" error={Boolean(errors['signalConfig.phoneNumber'])} />}
        </Field>
        <Field label="Signal endpoint type">
          {(id) => (
            <SelectInput
              id={id}
              value={endpointKind}
              onChange={(event) => update(event.target.value === 'socket'
                ? { socketPath: '', tcpHost: undefined, tcpPort: undefined }
                : { socketPath: undefined, tcpHost: '127.0.0.1', tcpPort: '' })}
            >
              <option value="socket">UNIX socket</option>
              <option value="tcp">Loopback TCP</option>
            </SelectInput>
          )}
        </Field>
        {endpointKind === 'socket' ? (
          <Field label="Signal UNIX socket path" error={errors['signalConfig.endpoint']}>
            {(id) => <TextInput id={id} value={value(config.socketPath)} onChange={(event) => update({ socketPath: event.target.value })} placeholder="/run/signal-cli/socket" error={Boolean(errors['signalConfig.endpoint'])} />}
          </Field>
        ) : (
          <>
            <Field label="Signal TCP host" helper="Only loopback hosts are accepted because signal-cli TCP is plaintext.">
              {(id) => <TextInput id={id} value={value(config.tcpHost) || '127.0.0.1'} onChange={(event) => update({ tcpHost: event.target.value })} />}
            </Field>
            <Field label="Signal TCP port" error={errors['signalConfig.endpoint']}>
              {(id) => <TextInput id={id} type="number" inputMode="numeric" value={value(config.tcpPort)} onChange={(event) => update({ tcpPort: event.target.value })} placeholder="7583" error={Boolean(errors['signalConfig.endpoint'])} />}
            </Field>
          </>
        )}
      </section>
    )
  }

  const backend = config.backend === 'imsg' ? 'imsg' : 'bluebubbles'
  return (
    <section aria-labelledby="imessage-transport-config" className="flex flex-col gap-[var(--sp-3)] rounded-md border border-border-subtle bg-surface-inset p-[var(--sp-4)]">
      <h4 id="imessage-transport-config" className="c-heading">iMessage transport setup</h4>
      <Field label="iMessage sender" error={errors['imessageConfig.sender']}>
        {(id) => <TextInput id={id} value={value(config.sender)} onChange={(event) => update({ sender: event.target.value })} placeholder="owner@example.com or +15551234567" error={Boolean(errors['imessageConfig.sender'])} />}
      </Field>
      <Field label="iMessage backend">
        {(id) => (
          <SelectInput
            id={id}
            value={backend}
            onChange={(event) => update(event.target.value === 'imsg'
              ? { backend: 'imsg', imsgSocketPath: '/tmp/imsg.sock', bluebubblesUrl: undefined, bluebubblesPasswordService: undefined }
              : { backend: 'bluebubbles', imsgSocketPath: undefined, bluebubblesUrl: '', bluebubblesPasswordService: '' })}
          >
            <option value="bluebubbles">BlueBubbles</option>
            <option value="imsg">imsg</option>
          </SelectInput>
        )}
      </Field>
      {backend === 'imsg' ? (
        <Field label="imsg socket path" error={errors['imessageConfig.imsgSocketPath']}>
          {(id) => <TextInput id={id} value={value(config.imsgSocketPath)} onChange={(event) => update({ imsgSocketPath: event.target.value })} placeholder="/tmp/imsg.sock" error={Boolean(errors['imessageConfig.imsgSocketPath'])} />}
        </Field>
      ) : (
        <>
          <Field label="BlueBubbles URL" error={errors['imessageConfig.bluebubblesUrl']}>
            {(id) => <TextInput id={id} value={value(config.bluebubblesUrl)} onChange={(event) => update({ bluebubblesUrl: event.target.value })} placeholder="https://messages.example.com" error={Boolean(errors['imessageConfig.bluebubblesUrl'])} />}
          </Field>
          <Field label="BlueBubbles password keyring service" helper="The password stays in the OS keyring; only its service name is saved." error={errors['imessageConfig.bluebubblesPasswordService']}>
            {(id) => <TextInput id={id} value={value(config.bluebubblesPasswordService)} onChange={(event) => update({ bluebubblesPasswordService: event.target.value })} placeholder="whatsoup-bluebubbles" error={Boolean(errors['imessageConfig.bluebubblesPasswordService'])} />}
          </Field>
        </>
      )}
    </section>
  )
}

export default TransportConfigFields
