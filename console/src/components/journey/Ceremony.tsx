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
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
  const [sending, setSending] = useState(false)

  const goLive = async () => {
    const text = msg.trim()
    if (!text) {
      navigate('/')
      return
    }
    setSending(true)
    try {
      // The line boots on link; a just-linked transport can still be settling,
      // so one retry after a beat is honest engineering, not a swallowed error.
      try {
        await api.sendMessage(lineName, adminPhone, text)
      } catch {
        await new Promise((r) => setTimeout(r, 3000))
        await api.sendMessage(lineName, adminPhone, text)
      }
      toast.success(`${name} is live — first message sent to your admin`)
      navigate('/')
    } catch (e) {
      toast.error(`First message failed: ${e instanceof Error ? e.message : e}. The line still sends its own intro on boot.`)
      navigate('/')
    } finally {
      setSending(false)
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
        <span className="journey-name">{name}</span>
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
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void goLive()
            }
          }}
        />
        <Button variant="primary" disabled={sending} onClick={() => void goLive()}>
          {sending ? 'Sending…' : 'Send & go live'}
        </Button>
      </div>
      <div className="journey-actions">
        <Button variant="ghost" onClick={() => navigate('/')}>
          Skip ceremony
        </Button>
        <Button variant="neutral" onClick={onAdjust}>
          Adjust persona
        </Button>
      </div>
    </div>
  )
}
