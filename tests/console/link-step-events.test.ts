import { describe, expect, it } from 'vitest'

import { parseAuthErrorMessage, parseQrPayload } from '../../console/src/components/wizard/link-step-events'

describe('link step event payload parsing', () => {
  it('accepts JSON-encoded and raw QR payloads', () => {
    expect(parseQrPayload(JSON.stringify('qr-payload'))).toBe('qr-payload')
    expect(parseQrPayload('raw-qr-payload')).toBe('raw-qr-payload')
  })

  it('rejects blank or non-string QR payloads without throwing', () => {
    expect(parseQrPayload('')).toBeNull()
    expect(parseQrPayload('   ')).toBeNull()
    expect(parseQrPayload(JSON.stringify({ qr: 'not-the-contract' }))).toBeNull()
    expect(parseQrPayload(JSON.stringify(null))).toBeNull()
  })

  it('extracts useful auth error messages without trusting malformed JSON', () => {
    expect(parseAuthErrorMessage(JSON.stringify({ message: 'Timed out' }))).toBe('Timed out')
    expect(parseAuthErrorMessage(JSON.stringify('Plain text failure'))).toBe('Plain text failure')
    expect(parseAuthErrorMessage('raw failure')).toBe('raw failure')
    expect(parseAuthErrorMessage(JSON.stringify({ message: '' }))).toBe('Connection lost')
    expect(parseAuthErrorMessage('')).toBe('Connection lost')
  })
})
