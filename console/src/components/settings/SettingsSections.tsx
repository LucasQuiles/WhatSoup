/**
 * Settings sections (T5 b-09; mockup settings.html + 17-settings-ia-spec.md).
 *
 * Honest register (data reality verified against the fleet route table):
 * - Workspace: appearance swatches are WIRED (useTheme); auto/reduced-motion/
 *   export are disabled-with-note (no auto theme value, no motion override
 *   seam, no export endpoint). Workspace name + admin identity rows are
 *   omitted — no backend field exists for either (never fiction).
 * - Channels: per-line link state, real (useLines); relink entry navigates.
 * - Notifications: per-channel prefs have no store; the real alert-mute
 *   backend (fleet silences) is wired end-to-end (list, mute, unsilence).
 * - API tokens: no named-token inventory exists; provider keys (write-only)
 *   get set/verify/revoke rows; session lock row is real.
 * - Danger zone: reset row disabled — no reset endpoint exists.
 */
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLines } from '../../hooks/use-fleet'
import { useTheme, type Theme } from '../../hooks/use-theme'
import { useToast } from '../../hooks/toast-context'
import { api, lockConsole } from '../../lib/api'
import { formatFullTime } from '../../lib/format-time'
import { channelOf, CHANNEL_LABEL } from '../../lib/transport-identity'
import { Button } from '../primitives/Button'
import { NumberInput, SelectInput, TextInput } from '../primitives/FormControl'
import { SettingsToggle } from './Toggle'

const PROVIDER_SERVICES = ['deepseek', 'minimax', 'openai', 'anthropic'] as const

function Row({ children, ctl }: { children: ReactNode; ctl?: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row__body">{children}</div>
      {ctl ? <div className="settings-ctl">{ctl}</div> : null}
    </div>
  )
}

function RowLabel({ label, sub }: { label: string; sub: string }) {
  return (
    <>
      <div className="settings-lbl">{label}</div>
      <div className="settings-sub">{sub}</div>
    </>
  )
}

/* ── Workspace ─────────────────────────────────────────────────────────── */

const SWATCHES: Array<{ t: Theme | 'auto'; label: string }> = [
  { t: 'dark', label: 'dark' },
  { t: 'light', label: 'light' },
  { t: 'auto', label: 'auto' },
]

export function WorkspaceSection() {
  const { theme, setTheme } = useTheme()
  return (
    <>
      <h2>Workspace</h2>
      <p className="settings-desc">Identity and defaults for this deployment.</p>
      <div className="settings-panel">
        <div className="settings-panel__b">
          <Row
            ctl={
              <div className="settings-swatches" role="group" aria-label="Appearance">
                {SWATCHES.map((s) => {
                  const isAuto = s.t === 'auto'
                  const on = !isAuto && theme === s.t
                  return (
                    <Button
                      key={s.t}
                      variant="ghost"
                      className={`settings-sw settings-sw--${s.t}${on ? ' settings-sw--on' : ''}`}
                      disabled={isAuto}
                      title={
                        isAuto
                          ? 'auto follows your OS — no auto theme value exists today'
                          : `Switch to the ${s.t} theme`
                      }
                      aria-description={
                        isAuto ? 'Disabled: the theme register has no auto value; dark and light are first-class.' : undefined
                      }
                      aria-pressed={on}
                      onClick={() => {
                        if (!isAuto) setTheme(s.t as Theme)
                      }}
                    >
                      {isAuto ? (
                        <>
                          <span className="settings-sw__a">
                            <i data-theme="dark" />
                            <i data-theme="light" />
                          </span>
                          <span className="settings-sw__b">
                            <i data-theme="light" />
                            <i data-theme="dark" />
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="settings-sw__a" data-theme={s.t} />
                          <span className="settings-sw__b" data-theme={s.t} />
                        </>
                      )}
                      <span className="settings-sw__t">{s.label}</span>
                    </Button>
                  )
                })}
              </div>
            }
          >
            <RowLabel label="Appearance" sub="both themes are first-class — syncs live" />
          </Row>
          <Row
            ctl={
              <SettingsToggle
                on={false}
                disabled
                label="Reduced motion"
                reason="follows your OS setting (prefers-reduced-motion); the manual override lands with the motion bead (b-11)"
              />
            }
          >
            <RowLabel label="Reduced motion" sub="follows system; ceremony becomes instant" />
          </Row>
          <Row
            ctl={
              <Button
                variant="neutral"
                size="sm"
                disabled
                title="No export endpoint exists today; metrics CSV export lives on the metrics surface"
                aria-description="Disabled: there is no fleet export endpoint."
              >
                export…
              </Button>
            }
          >
            <RowLabel label="Export all data" sub="messages, configs, memory indexes" />
          </Row>
        </div>
      </div>
    </>
  )
}

/* ── Channels ──────────────────────────────────────────────────────────── */

export function ChannelsSection() {
  const { data: lines } = useLines()
  const navigate = useNavigate()
  return (
    <>
      <h2>Channels</h2>
      <p className="settings-desc">Per-channel link state. Relink and grants live on each line&apos;s detail surface.</p>
      <div className="settings-panel">
        <div className="settings-panel__b">
          {(lines ?? []).length === 0 ? (
            <div className="settings-empty">No lines configured</div>
          ) : (
            (lines ?? []).map((l) => {
              const kind = channelOf(l)
              const linked = l.linkedStatus ?? 'unknown'
              return (
                <Row
                  key={l.name}
                  ctl={
                    <>
                      <span className={`settings-pill${l.status === 'online' ? ' settings-pill--live' : ''}`}>
                        {l.status}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => navigate(`/lines/${encodeURIComponent(l.name)}`)}>
                        manage
                      </Button>
                    </>
                  }
                >
                  <RowLabel
                    label={`${l.name} · ${CHANNEL_LABEL[kind]}`}
                    sub={`link: ${linked}`}
                  />
                </Row>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}

/* ── Notifications ─────────────────────────────────────────────────────── */

export function NotificationsSection() {
  const { data: lines } = useLines()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [muteLine, setMuteLine] = useState('')
  const [muteMinutes, setMuteMinutes] = useState('60')

  const silenceQuery = useQuery({
    queryKey: ['fleet-silences'],
    queryFn: () => api.getSilences(),
    refetchInterval: 30_000,
  })
  const silences = silenceQuery.data
  const silenceRegistryCurrent = !silenceQuery.isPending
    && !silenceQuery.isError
    && silences?.readBasis === 'current'
  const silenceRegistryStale = !silenceQuery.isPending
    && !silenceQuery.isError
    && silences?.readBasis === 'last_known_good'
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['fleet-silences'] })
  const mute = useMutation({
    mutationFn: () => api.silenceLine(muteLine, Number(muteMinutes) || 60, 'muted from Settings'),
    onSuccess: () => {
      toast.success(`Alerts muted for ${muteLine}`)
      setMuteLine('')
      invalidate()
    },
    onError: (e) => toast.error(`Mute failed: ${e instanceof Error ? e.message : e}`),
  })
  const unsilence = useMutation({
    mutationFn: (instance: string) => api.unsilenceLine(instance),
    onSuccess: (_d, instance) => {
      toast.success(`Alerts unmuted for ${instance}`)
      invalidate()
    },
    onError: (e) => toast.error(`Unmute failed: ${e instanceof Error ? e.message : e}`),
  })

  return (
    <>
      <h2>Notifications</h2>
      <p className="settings-desc">
        Alert delivery is the on-call channel configured on the host (env). Per-channel prefs —
        browser push, webhook, email digest — land with the notifications backend; no prefs
        store exists today.
      </p>
      <div className="settings-panel">
        <div className="settings-panel__b">
          <div className="settings-colhead">Alert mutes (real — persisted host-side)</div>
          {silenceQuery.isPending ? (
            <div className="settings-empty">Loading alert mutes…</div>
          ) : silenceQuery.isError ? (
            <div className="settings-empty" role="alert">
              Alert mutes unavailable — the silence registry could not be read.
              <Button variant="ghost" size="sm" onClick={() => { void silenceQuery.refetch() }}>
                retry
              </Button>
            </div>
          ) : (
            <>
              {silenceRegistryStale && (
                <div className="settings-empty" role="alert">
                  Alert mutes may be stale — the silence registry could not be read.
                  <Button variant="ghost" size="sm" onClick={() => { void silenceQuery.refetch() }}>
                    retry
                  </Button>
                </div>
              )}
              {silences?.availability === 'uninitialized' ? (
                <div className="settings-empty">No mute registry initialized</div>
              ) : (silences?.silences ?? []).length === 0 ? (
                <div className="settings-empty">No active mutes</div>
              ) : (
                (silences?.silences ?? []).map((s) => (
                  <Row
                    key={s.instance}
                    ctl={
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={unsilence.isPending || !silenceRegistryCurrent}
                        title={silenceRegistryCurrent ? undefined : 'Silence registry unavailable'}
                        onClick={() => unsilence.mutate(s.instance)}
                      >
                        unmute
                      </Button>
                    }
                  >
                    <RowLabel
                      label={s.instance}
                      sub={`until ${formatFullTime(s.until)}${s.reason ? ` · ${s.reason}` : ''}`}
                    />
                  </Row>
                ))
              )}
            </>
          )}
          <Row
            ctl={
              <>
                <SelectInput
                  aria-label="Line to mute"
                  value={muteLine}
                  onChange={(e) => setMuteLine(e.target.value)}
                  className="settings-input"
                  disabled={!silenceRegistryCurrent}
                >
                  <option value="">line…</option>
                  {(lines ?? []).map((l) => (
                    <option key={l.name} value={l.name}>
                      {l.name}
                    </option>
                  ))}
                </SelectInput>
                <NumberInput
                  aria-label="Mute duration in minutes"
                  value={muteMinutes}
                  onChange={(e) => setMuteMinutes(e.target.value)}
                  className="settings-input settings-input--minutes"
                  min={1}
                  disabled={!silenceRegistryCurrent}
                />
                <Button
                  variant="neutral"
                  size="sm"
                  disabled={!muteLine || mute.isPending || !silenceRegistryCurrent}
                  title={silenceRegistryCurrent ? undefined : 'Silence registry unavailable'}
                  onClick={() => mute.mutate()}
                >
                  mute
                </Button>
              </>
            }
          >
            <RowLabel label="Mute a line" sub="timed mute of health alerts for that line (minutes)" />
          </Row>
        </div>
      </div>
    </>
  )
}

/* ── API tokens ────────────────────────────────────────────────────────── */

function ProviderKeyRow({ service }: { service: string }) {
  const toast = useToast()
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const set_ = useMutation({
    mutationFn: () => api.setCredential(service, value),
    onSuccess: () => {
      toast.success(`${service} key stored in the OS keyring`)
      setValue('')
      // The stored key replaced whatever was there — a prior verify verdict
      // belongs to the old key and must not linger as a false attestation.
      setStatus(null)
    },
    onError: (e) => toast.error(`Store failed: ${e instanceof Error ? e.message : e}`),
  })
  const verify = useMutation({
    mutationFn: () => api.verifyCredential(service),
    onSuccess: (d) => setStatus(d.status),
    onError: (e) => toast.error(`Verify failed: ${e instanceof Error ? e.message : e}`),
  })
  const revoke = useMutation({
    mutationFn: () => api.deleteCredential(service),
    onSuccess: () => {
      toast.info(`${service} key removed`)
      setStatus(null)
    },
    onError: (e) => toast.error(`Revoke failed: ${e instanceof Error ? e.message : e}`),
  })

  return (
    <Row
      ctl={
        <>
          {status ? <span className="settings-sub settings-sub--status">{status}</span> : null}
          <TextInput
            aria-label={`New ${service} key`}
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="new key…"
            className="settings-input"
          />
          <Button variant="ghost" size="sm" disabled={!value.trim() || set_.isPending} onClick={() => set_.mutate()}>
            set
          </Button>
          <Button variant="ghost" size="sm" disabled={verify.isPending} onClick={() => verify.mutate()}>
            verify
          </Button>
          <Button variant="danger" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            revoke
          </Button>
        </>
      }
    >
      <RowLabel label={service} sub="write-only · stored in the OS keyring" />
    </Row>
  )
}

export function TokensSection() {
  const toast = useToast()
  return (
    <>
      <h2>API tokens</h2>
      <p className="settings-desc">
        No named console-token inventory exists (root-token rotation is CLI-only; tickets are
        60-second ephemerals). Provider keys are write-only — presence can never be listed.
      </p>
      <div className="settings-panel">
        <div className="settings-panel__b">
          <div className="settings-colhead">Provider keys</div>
          {PROVIDER_SERVICES.map((s) => (
            <ProviderKeyRow key={s} service={s} />
          ))}
          <Row
            ctl={
              <Button
                variant="neutral"
                size="sm"
                onClick={() => {
                  void lockConsole()
                    .catch((e) => toast.error(`Lock failed: ${e instanceof Error ? e.message : e}`))
                    .finally(() => window.location.reload())
                }}
              >
                lock now
              </Button>
            }
          >
            <RowLabel label="Console session" sub="locks this browser session immediately" />
          </Row>
        </div>
      </div>
    </>
  )
}

/* ── Danger zone ───────────────────────────────────────────────────────── */

export function DangerSection() {
  return (
    <>
      <h2 className="settings-h2--danger">Danger zone</h2>
      <p className="settings-desc">Irreversible actions only.</p>
      <div className="settings-panel settings-panel--danger">
        <div className="settings-panel__b">
          <Row
            ctl={
              <Button
                variant="danger"
                size="sm"
                disabled
                title="No reset endpoint exists — workspace reset is not API-exposed; lines are deletable from their detail surfaces"
                aria-description="Disabled: there is no workspace reset endpoint."
              >
                reset…
              </Button>
            }
          >
            <RowLabel label="Reset workspace" sub="wipes all lines, agents, and configuration" />
          </Row>
        </div>
      </div>
    </>
  )
}
