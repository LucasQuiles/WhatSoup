import { describe, it, expect } from 'vitest'
import { parseWsEvent } from '../../console/src/lib/realtime-events'

describe('realtime-events', () => {
  describe('parseWsEvent', () => {
    it('returns null for non-string data', () => {
      expect(parseWsEvent(null)).toBeNull()
      expect(parseWsEvent(undefined)).toBeNull()
      expect(parseWsEvent(123)).toBeNull()
      expect(parseWsEvent({ type: 'connected' })).toBeNull()
      expect(parseWsEvent(['connected'])).toBeNull()
    })

    it('returns null for invalid JSON strings', () => {
      expect(parseWsEvent('not valid json')).toBeNull()
      expect(parseWsEvent('{incomplete}')).toBeNull()
      expect(parseWsEvent('{"type": invalid}')).toBeNull()
    })

    it('returns null for JSON without type field', () => {
      expect(parseWsEvent('{"timestamp": 123}')).toBeNull()
      expect(parseWsEvent('{}')).toBeNull()
      expect(parseWsEvent('{"data": "value"}')).toBeNull()
    })

    it('parses connected events with valid timestamp', () => {
      const event = parseWsEvent('{"type": "connected", "timestamp": 1234567890}')
      expect(event).toEqual({
        type: 'connected',
        timestamp: 1234567890,
      })
    })

    it('returns null for connected event without timestamp', () => {
      expect(parseWsEvent('{"type": "connected"}')).toBeNull()
      expect(parseWsEvent('{"type": "connected", "timestamp": null}')).toBeNull()
    })

    it('returns null for connected event with non-finite timestamp', () => {
      expect(parseWsEvent('{"type": "connected", "timestamp": Infinity}')).toBeNull()
      expect(parseWsEvent('{"type": "connected", "timestamp": NaN}')).toBeNull()
    })

    it('parses typing_update events with valid fields', () => {
      const event = parseWsEvent('{"type": "typing_update", "instance": "q", "jid": "123@s.whatsapp.net", "composing": true, "since": 1234567890}')
      expect(event).toEqual({
        type: 'typing_update',
        instance: 'q',
        jid: '123@s.whatsapp.net',
        composing: true,
        since: 1234567890,
      })
    })

    it('returns null for typing_update with missing required fields', () => {
      expect(parseWsEvent('{"type": "typing_update"}')).toBeNull()
      expect(parseWsEvent('{"type": "typing_update", "instance": "q"}')).toBeNull()
      expect(parseWsEvent('{"type": "typing_update", "instance": "q", "jid": "123@s.whatsapp.net"}')).toBeNull()
    })

    it('returns null for typing_update with empty instance or jid', () => {
      expect(parseWsEvent('{"type": "typing_update", "instance": "", "jid": "123@s.whatsapp.net", "composing": true, "since": 123}')).toBeNull()
      expect(parseWsEvent('{"type": "typing_update", "instance": "q", "jid": "", "composing": true, "since": 123}')).toBeNull()
    })

    it('returns null for typing_update with non-boolean composing', () => {
      expect(parseWsEvent('{"type": "typing_update", "instance": "q", "jid": "123@s.whatsapp.net", "composing": "true", "since": 123}')).toBeNull()
      expect(parseWsEvent('{"type": "typing_update", "instance": "q", "jid": "123@s.whatsapp.net", "composing": 1, "since": 123}')).toBeNull()
    })

    it('returns null for typing_update with non-finite since', () => {
      expect(parseWsEvent('{"type": "typing_update", "instance": "q", "jid": "123@s.whatsapp.net", "composing": true, "since": Infinity}')).toBeNull()
    })

    it('parses invalidation events with required fields', () => {
      const event = parseWsEvent('{"type": "message_received", "instance": "q", "conversationKey": "conv-123"}')
      expect(event).toEqual({
        type: 'message_received',
        instance: 'q',
        conversationKey: 'conv-123',
      })
    })

    it('parses invalidation events with optional fields', () => {
      const event = parseWsEvent('{"type": "chat_updated", "instance": "q", "conversationKey": "conv-123", "lid": "lid-123", "messagePk": 42}')
      expect(event).toEqual({
        type: 'chat_updated',
        instance: 'q',
        conversationKey: 'conv-123',
        lid: 'lid-123',
        messagePk: 42,
      })
    })

    it('returns null for invalidation event without instance', () => {
      expect(parseWsEvent('{"type": "message_received"}')).toBeNull()
      expect(parseWsEvent('{"type": "message_received", "instance": ""}')).toBeNull()
    })

    it('parses all known invalidation types', () => {
      const types = [
        'instance_status',
        'message_received',
        'chat_updated',
        'log_entry',
        'feed_event',
        'access_changed',
        'lid_conflict',
      ]

      types.forEach((type) => {
        const event = parseWsEvent(`{"type": "${type}", "instance": "q"}`)
        expect(event).not.toBeNull()
        expect(event?.type).toBe(type)
      })
    })

    it('returns null for unknown event type', () => {
      expect(parseWsEvent('{"type": "unknown_type", "instance": "q"}')).toBeNull()
    })

    it('ignores extra fields in valid events', () => {
      const event = parseWsEvent('{"type": "connected", "timestamp": 123, "extra": "field", "more": true}')
      expect(event).toEqual({
        type: 'connected',
        timestamp: 123,
      })
    })

    it('handles complex JSON structures', () => {
      const event = parseWsEvent('{"type": "message_received", "instance": "q", "nested": {"key": "value"}, "array": [1, 2, 3]}')
      expect(event).toEqual({
        type: 'message_received',
        instance: 'q',
      })
    })
  })
})
