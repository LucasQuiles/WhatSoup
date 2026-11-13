import { useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { conversationId, type Conversation } from '../lib/inbox-unified'
import { useToast } from './toast-context'

type Draft = { text: string; status: 'editing' | 'pending' | 'unconfirmed' | 'rejected' }
const EMPTY_DRAFT: Draft = { text: '', status: 'editing' }

/** Drafts and send ownership survive thread navigation within the owning view. */
export function useInboxComposer(conversation: Pick<Conversation, 'line' | 'conversationKey'> | null) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(new Map())
  const attempts = useRef(new Map<string, symbol>())
  const mounted = useRef(false)
  const id = conversation ? conversationId(conversation.line, conversation.conversationKey) : null
  const selected = useRef(id)
  useLayoutEffect(() => {
    selected.current = id
  }, [id])
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const draft = id ? drafts.get(id) ?? EMPTY_DRAFT : EMPTY_DRAFT
  const update = (key: string, value?: Draft) => {
    setDrafts((previous) => {
      const next = new Map(previous)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }
  const setText = (text: string) => {
    if (id && !attempts.current.has(id)) update(id, text ? { text, status: 'editing' } : undefined)
  }
  const send = async () => {
    if (!id || !conversation || attempts.current.has(id) || !draft.text.trim()) return
    const attempt = Symbol('send')
    const submitted = draft.text
    const queryKey = ['messages', conversation.line, conversation.conversationKey]
    attempts.current.set(id, attempt)
    update(id, { text: submitted, status: 'pending' })
    const retain = (rejected = false) => {
      if (!mounted.current || attempts.current.get(id) !== attempt) return
      if (rejected) attempts.current.delete(id)
      update(id, { text: submitted, status: rejected ? 'rejected' : 'unconfirmed' })
      if (selected.current === id) toast.error(rejected
        ? 'Message was not sent. Review it before trying again.'
        : 'Send not confirmed. Check this conversation before sending again.')
    }
    try {
      const result = await api.sendMessage(conversation.line, conversation.conversationKey, submitted.trim())
      if (result?.sent !== true) {
        retain(result?.sent === false)
        return
      }
    } catch {
      retain()
      return
    }
    if (!mounted.current || attempts.current.get(id) !== attempt) return
    // History is an independent observation; its refresh cannot undo acceptance.
    void queryClient.invalidateQueries({ queryKey })
    attempts.current.delete(id)
    update(id)
  }
  const discard = () => {
    if (!id || draft.status !== 'unconfirmed') return
    attempts.current.delete(id)
    update(id)
  }
  const refresh = () => {
    if (conversation) void queryClient.invalidateQueries({ queryKey: ['messages', conversation.line, conversation.conversationKey] })
  }
  return { ...draft, setText, send, discard, refresh }
}

export type InboxComposer = ReturnType<typeof useInboxComposer>
