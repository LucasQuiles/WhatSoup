/**
 * Ceremony — the hatch moment (14-onboarding §5 + 13-ceremony-motion §2).
 *
 * Motion law: the glow is radial, accent-hued, ONE play, ≤800ms, fades to 0
 * (CSS animation, `both` fill so it ends at opacity 0); the avatar pop is
 * 500ms spring with a 250ms delay; prefers-reduced-motion removes both
 * (instant final state — the CSS owns the removal). The glow classes are
 * journey-scoped (`.journey-glow`) — banned everywhere else by 13-§2.
 *
 * The name is locked by ceremony time (the line exists), so the dice lives
 * at the Agent step only — the mockup's ceremony dice would be fiction here
 * (documented deviation).
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useToast } from '../../hooks/toast-context'
import { api } from '../../lib/api'
import { Button } from '../primitives/Button'
import { TextInput } from '../primitives/FormControl'

export function Ceremony({
  name,
  soul,
  channelLabel,
  adminPhone,
  lineName,
  agentInitial,
  onAdjust,
}: {
  name: string
  soul: string
  channelLabel: string
  adminPhone: string
  lineName: string
  agentInitial: string
  onAdjust: () => void
}) {
  const navigate = useNavigate()
  const toast = useToast()
  const [msg, setMsg] = useState('')
  const [sendState, setSendState] = useState<'idle' | 'pending' | 'unconfirmed'>('idle')
  const attempted = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const sending = sendState === 'pending'
  const unconfirmed = sendState === 'unconfirmed'

  const goLive = async () => {
    if (attempted.current) return
    const text = msg.trim()
    if (!text) {
      navigate('/')
      return
    }
    attempted.current = true
    setSendState('pending')
    try {
      await api.sendMessage(lineName, adminPhone, text)
      if (!mounted.current) return
      toast.success(`${name} is live — first message sent to your admin`)
      navigate('/')
    } catch {
      if (!mounted.current) return
      // A lost response cannot establish whether the transport already sent the message.
      setSendState('unconfirmed')
      toast.error('First message was not confirmed. Check Inbox before sending again.')
    }
  }

  return (
    <div className="journey-stage" data-testid="hatch-ceremony">
      <div className="journey-lockup">
        <span className="journey-glow" aria-hidden="true" />
        <span className="journey-eggshell" aria-hidden="true" />
        <span className="journey-av">{agentInitial}</span>
      </div>
      <div className="journey-beats">
        <span className="journey-beat">
          <span className="journey-beat__dot" />
          name
        </span>
        <span className="journey-beat">
          <span className="journey-beat__dot" />
          soul
        </span>
        <span className="journey-beat">
          <span className="journey-beat__dot" />
          channel
        </span>
      </div>
      <div className="journey-name-row">
        {/* the hatched agent's name IS the page heading at this beat (single-h1
            law — every earlier step's h1 unmounts with its card) */}
        <h1 className="journey-name">{name}</h1>
      </div>
      {soul ? <p className="journey-soul">&ldquo;{soul}&rdquo;</p> : null}
      <p className="journey-meta">
        {channelLabel} · admin {adminPhone} · line <b>{lineName}</b>
      </p>
      <div className="journey-firstmsg">
        <TextInput
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          placeholder="Say hello to your new agent…"
          aria-label="First message (optional)"
          disabled={sending}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void goLive()
            }
          }}
        />
        <Button variant="primary" disabled={sending || unconfirmed} onClick={() => void goLive()}>
          {sending ? 'Sending…' : 'Send & go live'}
        </Button>
      </div>
      {unconfirmed && <div>
        <p role="status">Delivery was not confirmed. Your message may have been sent. Check Inbox before sending it again.</p>
        <Button variant="neutral" onClick={() => navigate('/inbox')}>Check Inbox</Button>
      </div>}
      <div className="journey-actions">
        <Button variant="ghost" disabled={sending} onClick={() => navigate('/')}>
          Skip ceremony
        </Button>
        <Button variant="neutral" disabled={sending || unconfirmed} onClick={onAdjust}>
          Adjust persona
        </Button>
      </div>
    </div>
  )
}
