/**
 * Hatch — the v3.5 hatch journey (T5 b-10; mockup hatch.html + 14-onboarding).
 *
 * Flow: kind → channel → agent → link → hatch (ceremony). One step renders
 * at a time (the wave-4 law: completed-step content never competes).
 *
 * Honest backend reality (verified):
 * - Only baileys is API-creatable; every other channel tile is
 *   disabled with the reason (createLine has no transport field).
 * - The line is created when entering Link (the auth child needs its config
 *   dir) — name locks there; a mid-journey abandon leaves an unlinked line,
 *   same keep semantics as the wizard.
 * - Link mirrors the wizard's SSE flow: qr → QrDisplay, connected = linked.
 */
import { useEffect, useRef, useState } from 'react'
import { useTheme } from '../hooks/use-theme'
import { useToast } from '../hooks/toast-context'
import { useProviders } from '../hooks/use-fleet'
import { api, getApiTicket, isProductionConsole } from '../lib/api'
import { DEFAULT_PROVIDER_ID } from '../lib/providers'
import { CHANNEL_LABEL } from '../lib/transport-identity'
import {
  CHANNEL_TILES,
  KIND_PRESETS,
  NAME_WORDLIST,
  rerollName,
  slugifyName,
} from '../lib/journey'
import { StepRail, type JourneyStepId } from '../components/journey/StepRail'
import { journeyStepLabel } from '../lib/journey'
import { Ceremony } from '../components/journey/Ceremony'
import { Button } from '../components/primitives/Button'
import { TextArea, TextInput } from '../components/primitives/FormControl'
import QrDisplay from '../components/QrDisplay'
import ProviderModelInput from '../components/ProviderModelInput'
import ProviderSelect from '../components/ProviderSelect'

type LinkState =
  | { phase: 'creating' }
  | { phase: 'qr'; value: string }
  | { phase: 'watching' }
  | { phase: 'linked' }
  | { phase: 'error'; message: string }

export default function Hatch() {
  const { theme, toggleTheme } = useTheme()
  const toast = useToast()

  const [step, setStep] = useState<JourneyStepId>(0)
  const [kind, setKind] = useState(KIND_PRESETS.find((k) => k.hint)!)
  const [name, setName] = useState<string>(NAME_WORDLIST[0]!)
  const [soul, setSoul] = useState(kind.soulSeed)
  const [providerId, setProviderId] = useState<string>(DEFAULT_PROVIDER_ID)
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [adminPhone, setAdminPhone] = useState('')
  const [lineName, setLineName] = useState<string | null>(null)
  const [link, setLink] = useState<LinkState>({ phase: 'watching' })
  const esRef = useRef<EventSource | null>(null)

  const { data: providers } = useProviders()
  const selectedProvider = providers?.find((provider) => provider.id === providerId)
  const credentialService = selectedProvider?.credentialService ?? null

  useEffect(() => () => esRef.current?.close(), [])

  const pickKind = (k: (typeof KIND_PRESETS)[number]) => {
    setKind(k)
    setSoul(k.soulSeed)
  }

  const startLink = async () => {
    // Adjust-persona path: the line already exists (name locked) — persist the
    // persona edit via the config deep-merge and return to the ceremony. A
    // second createLine would 409 on the name and strand the flow.
    if (lineName) {
      try {
        await api.updateConfig(lineName, {
          ...(kind.type === 'agent' && soul.trim() ? { claudeMd: soul.trim() } : {}),
          ...(kind.type === 'chat' && soul.trim() ? { systemPrompt: soul.trim() } : {}),
          ...(model ? { models: { conversation: model } } : {}),
          agentOptions: { provider: providerId },
        })
        toast.success('Persona updated')
      } catch (e) {
        toast.error(`Persona update failed: ${e instanceof Error ? e.message : e}`)
      }
      setStep(4)
      return
    }
    const slug = slugifyName(name)
    if (!slug) {
      toast.error('Name must contain at least one letter')
      return
    }
    setStep(3)
    setLink({ phase: 'creating' })
    try {
      const created = await api.createLine({
        name: slug,
        type: kind.type,
        adminPhones: [adminPhone.trim()],
        models: model ? { conversation: model } : undefined,
        agentOptions: { provider: providerId },
        ...(kind.type === 'agent' && soul.trim() ? { claudeMd: soul.trim() } : {}),
        ...(kind.type === 'chat' && soul.trim() ? { systemPrompt: soul.trim() } : {}),
      })
      setLineName(created.name)
      if (apiKey.trim() && credentialService) {
        try {
          await api.setCredential(credentialService, apiKey.trim())
        } catch (e) {
          toast.error(`Key store failed: ${e instanceof Error ? e.message : e} — set it later in Settings → API tokens`)
        }
      }
      openQrStream(created.name)
    } catch (e) {
      setLink({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const openQrStream = async (line: string) => {
    setLink({ phase: 'watching' })
    try {
      const qs = isProductionConsole() ? `?ticket=${encodeURIComponent(await getApiTicket('sse'))}` : ''
      const es = new EventSource(`/api/lines/${encodeURIComponent(line)}/auth${qs}`)
      esRef.current = es
      es.addEventListener('qr', (ev) => {
        const raw = (ev as MessageEvent).data as string
        let value = raw
        try {
          const parsed = JSON.parse(raw) as string | { qr?: string }
          value = typeof parsed === 'string' ? parsed : (parsed.qr ?? raw)
        } catch {
          /* raw text payload */
        }
        setLink({ phase: 'qr', value })
      })
      es.addEventListener('connected', () => {
        es.close()
        esRef.current = null
        setLink({ phase: 'linked' })
        setStep(4)
      })
      es.addEventListener('error', () => {
        es.close()
        esRef.current = null
        setLink({ phase: 'error', message: 'The link stream ended before a connection was reported. Retry to get a fresh code.' })
      })
    } catch (e) {
      setLink({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const agentStepValid = name.trim().length >= 2 && /^\+?[0-9][0-9 -]{6,}$/.test(adminPhone.trim())

  return (
    <div className="journey-body">
      <Button variant="ghost" className="journey-theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
        theme
      </Button>
      <div className="journey-shell">
        <div className="journey-crumb">
          <span className="journey-tick" />
          <span className="journey-wm">
            SO<b>U</b>P
          </span>
          <span className="journey-ctx">{journeyStepLabel(step)}</span>
        </div>
        <StepRail current={step} />

        {step === 0 && (
          <div className="journey-card">
            <h1>Pick a kind</h1>
            <p className="journey-sub">The archetype sets the line type and seeds the soul — you can rewrite it at the next step.</p>
            <div className="journey-grid">
              {KIND_PRESETS.map((k) => (
                <div
                  key={k.id}
                  role="option"
                  aria-selected={kind.id === k.id}
                  tabIndex={0}
                  className={`journey-ch${kind.id === k.id ? ' journey-ch--sel' : ''}`}
                  onClick={() => pickKind(k)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      pickKind(k)
                    }
                  }}
                >
                  <span className="journey-ch__label">{k.label}</span>
                  <span className="journey-ch__desc">{k.desc}</span>
                </div>
              ))}
            </div>
            <div className="journey-actions">
              <Button variant="primary" onClick={() => setStep(1)}>
                Continue →
              </Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="journey-card">
            <h1>Pick a channel</h1>
            <p className="journey-sub">{`One account per line. ${CHANNEL_LABEL.wa} links by QR in this console today.`}</p>
            <div className="journey-grid">
              {CHANNEL_TILES.map((c) => (
                <div
                  key={c.id}
                  role="option"
                  aria-selected={c.id === 'baileys'}
                  aria-disabled={!c.enabled || undefined}
                  title={c.note}
                  className={`journey-ch${c.id === 'baileys' ? ' journey-ch--sel' : ''}${!c.enabled ? ' journey-ch--off' : ''}`}
                >
                  <span className="journey-ch__label">{c.label}</span>
                </div>
              ))}
            </div>
            <div className="journey-actions">
              <Button variant="ghost" onClick={() => setStep(0)}>
                ← Back
              </Button>
              <Button variant="primary" onClick={() => setStep(2)}>
                {`Continue with ${CHANNEL_LABEL.wa} →`}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="journey-card">
            <h1>Name your agent</h1>
            <p className="journey-sub">Name, soul, and brain. The dice proposes another name.</p>
            <div className="journey-field">
              <label className="journey-label" htmlFor="hatch-name">Name</label>
              <div className="journey-name-edit">
                <TextInput
                  id="hatch-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!!lineName}
                  title={lineName ? 'The name is locked — the line exists' : undefined}
                />
                <Button variant="neutral" aria-label="Another name" title="Another name" disabled={!!lineName} onClick={() => setName((n) => rerollName(n))}>
                  ⚄
                </Button>
              </div>
            </div>
            <div className="journey-field">
              <label className="journey-label" htmlFor="hatch-soul">Soul</label>
              <TextArea id="hatch-soul" value={soul} onChange={(e) => setSoul(e.target.value)} rows={3} textFace="sans" />
            </div>
            <div className="journey-field">
              <label className="journey-label" htmlFor="hatch-provider">Brain</label>
              <ProviderSelect
                id="hatch-provider"
                value={providerId}
                onChange={(value) => {
                  setProviderId(value)
                  setModel('')
                }}
              />
            </div>
            <div className="journey-field">
              <label className="journey-label" htmlFor="hatch-model">Model</label>
              <ProviderModelInput
                id="hatch-model"
                provider={providerId}
                value={model}
                onChange={setModel}
              />
            </div>
            {credentialService ? (
              <div className="journey-field">
                <label className="journey-label" htmlFor="hatch-key">
                  {credentialService} API key
                </label>
                <TextInput
                  id="hatch-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="stored in the OS keyring, never echoed"
                />
              </div>
            ) : null}
            {selectedProvider?.needsApiKey && !credentialService ? (
              <p className="journey-note">This provider does not advertise a fixed credential service — set its key in Settings → API tokens.</p>
            ) : null}
            <div className="journey-field">
              <label className="journey-label" htmlFor="hatch-admin">{`Your ${CHANNEL_LABEL.wa} number (admin)`}</label>
              <TextInput
                id="hatch-admin"
                value={adminPhone}
                onChange={(e) => setAdminPhone(e.target.value)}
                placeholder="+1 …"
              />
            </div>
            <div className="journey-actions">
              <Button variant="ghost" onClick={() => setStep(1)}>
                ← Back
              </Button>
              <Button variant="primary" disabled={!agentStepValid} onClick={() => void startLink()}>
                {lineName ? 'Save persona →' : 'Continue to link →'}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="journey-card">
            <h1>{`Link ${CHANNEL_LABEL.wa}`}</h1>
            <p className="journey-sub">{`Scan the code from ${CHANNEL_LABEL.wa} → Linked devices → Link a device. The line is created as the flow opens; its name locks here.`}</p>
            <div className="journey-linkstage" data-testid="link-stage">
              {link.phase === 'creating' ? <p className="journey-note">Creating the line…</p> : null}
              {link.phase === 'watching' ? <p className="journey-note">Waiting for the first code…</p> : null}
              {link.phase === 'qr' ? <QrDisplay value={link.value} /> : null}
              {link.phase === 'error' ? (
                <>
                  <p className="journey-note journey-note--crit">{link.message}</p>
                  <div className="journey-actions">
                    <Button variant="neutral" onClick={() => lineName && void openQrStream(lineName)}>
                      New code
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
            <div className="journey-actions">
              <Button variant="ghost" onClick={() => setStep(2)}>
                ← Back
              </Button>
            </div>
          </div>
        )}

        {step === 4 && lineName && (
          <div className="journey-card">
            <Ceremony
              name={name}
              soul={soul.trim()}
              channelLabel={CHANNEL_LABEL.wa}
              adminPhone={adminPhone.trim()}
              lineName={lineName}
              agentInitial={name.trim().charAt(0).toUpperCase() || '·'}
              onAdjust={() => setStep(2)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
