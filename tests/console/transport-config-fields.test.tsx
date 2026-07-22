// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import TransportConfigFields from '../../console/src/components/wizard/TransportConfigFields'
import {
  canonicalizeTransportFormData,
  type CanonicalTransportFormData,
} from '../../console/src/lib/transport-config'
import type { TransportKind } from '../../console/src/lib/transport-meta'

afterEach(cleanup)

function StatefulFields({
  transport,
  initialConfig,
  errors = {},
}: {
  transport: TransportKind
  initialConfig: Record<string, unknown>
  errors?: Record<string, string>
}) {
  const field = `${transport}Config`
  const [data, setData] = useState<Record<string, unknown>>({
    name: `${transport}-line`,
    type: 'chat',
    transport,
    adminPhones: ['+15551234567'],
    [field]: initialConfig,
  })

  return (
    <>
      <TransportConfigFields
        transport={transport}
        data={data}
        errors={errors}
        onChange={(patch) => setData(current => ({ ...current, ...patch }))}
      />
      <button type="button" onClick={() => setData(canonicalizeTransportFormData(data))}>
        Canonicalize
      </button>
      <output data-testid="form-data">{JSON.stringify(data)}</output>
    </>
  )
}

function canonicalState(): CanonicalTransportFormData {
  const raw = JSON.parse(screen.getByTestId('form-data').textContent ?? '{}') as Record<string, unknown>
  return canonicalizeTransportFormData(raw)
}

describe('TransportConfigFields alternative selectors', () => {
  it('shows the line-bound Twilio keyring service as read-only', () => {
    render(
      <StatefulFields
        transport="twilio"
        initialConfig={{ authTokenService: 'whatsoup-twilio-other-line' }}
      />,
    )

    const service = screen.getByLabelText('Twilio auth-token keyring service') as HTMLInputElement
    expect(service.value).toBe('whatsoup-twilio-twilio-line')
    expect(service.readOnly).toBe(true)
  })

  it('keeps Twilio Messaging Service selected while its SID is being entered', () => {
    render(
      <StatefulFields
        transport="twilio"
        initialConfig={{
          accountSid: `AC${'0'.repeat(32)}`,
          authTokenService: 'whatsoup-twilio-twilio-line',
          phoneNumber: '',
        }}
      />,
    )

    const senderType = screen.getByLabelText('Twilio sender type') as HTMLSelectElement
    fireEvent.change(senderType, { target: { value: 'messaging-service' } })
    fireEvent.click(screen.getByRole('button', { name: 'Canonicalize' }))

    expect(senderType.value).toBe('messaging-service')
    const sid = screen.getByLabelText('Twilio Messaging Service SID')
    fireEvent.change(sid, { target: { value: `MG${'a'.repeat(32)}` } })

    expect(canonicalState().twilioConfig).toMatchObject({
      messagingServiceSid: `MG${'a'.repeat(32)}`,
    })
    expect(canonicalState().twilioConfig).not.toHaveProperty('phoneNumber')

    fireEvent.change(screen.getByLabelText('Twilio sender type'), { target: { value: 'phone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Canonicalize' }))
    expect((screen.getByLabelText('Twilio sender type') as HTMLSelectElement).value).toBe('phone')
    fireEvent.change(screen.getByLabelText('Twilio phone number'), { target: { value: '+15551234567' } })
    expect(canonicalState().twilioConfig).toMatchObject({ phoneNumber: '+15551234567' })
    expect(canonicalState().twilioConfig).not.toHaveProperty('messagingServiceSid')
  })

  it('keeps Signal TCP selected while its endpoint is being entered', () => {
    render(
      <StatefulFields
        transport="signal"
        initialConfig={{
          phoneNumber: '+15551234567',
          socketPath: '',
        }}
      />,
    )

    const endpointType = screen.getByLabelText('Signal endpoint type') as HTMLSelectElement
    fireEvent.change(endpointType, { target: { value: 'tcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Canonicalize' }))

    expect(endpointType.value).toBe('tcp')
    expect(screen.getByLabelText('Signal TCP host')).toBeDefined()
    const port = screen.getByLabelText('Signal TCP port')
    fireEvent.change(port, { target: { value: '7583' } })

    expect(canonicalState().signalConfig).toMatchObject({
      tcpHost: '127.0.0.1',
      tcpPort: 7583,
    })
    expect(canonicalState().signalConfig).not.toHaveProperty('socketPath')

    fireEvent.change(screen.getByLabelText('Signal endpoint type'), { target: { value: 'socket' } })
    fireEvent.click(screen.getByRole('button', { name: 'Canonicalize' }))
    expect((screen.getByLabelText('Signal endpoint type') as HTMLSelectElement).value).toBe('socket')
    fireEvent.change(screen.getByLabelText('Signal UNIX socket path'), { target: { value: '/tmp/signal.sock' } })
    expect(canonicalState().signalConfig).toMatchObject({ socketPath: '/tmp/signal.sock' })
    expect(canonicalState().signalConfig).not.toHaveProperty('tcpPort')
  })

  it('renders an invalid iMessage backend as unselected with its validation error', () => {
    render(
      <StatefulFields
        transport="imessage"
        initialConfig={{ backend: 'not-a-backend', sender: 'owner@example.com' }}
        errors={{ 'imessageConfig.backend': 'Select imsg or BlueBubbles as the iMessage backend' }}
      />,
    )

    expect((screen.getByLabelText('iMessage backend') as HTMLSelectElement).value).toBe('')
    expect(screen.getByText('Select imsg or BlueBubbles as the iMessage backend')).toBeDefined()
  })
})
