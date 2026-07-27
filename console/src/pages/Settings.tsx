/**
 * Settings — v3.5 form-register surface (T5 b-09; mockup settings.html SSOT,
 * 17-settings-ia-spec.md). Five sections; the section nav resolves 1:1 to
 * rendered sections (the wave-4b no-phantom-nav law).
 */
import { useRef, useState } from 'react'
import {
  WorkspaceSection,
  ChannelsSection,
  NotificationsSection,
  TokensSection,
  DangerSection,
} from '../components/settings/SettingsSections'

const SECTIONS = [
  ['workspace', 'Workspace'],
  ['channels', 'Channels'],
  ['notifications', 'Notifications'],
  ['tokens', 'API tokens'],
  ['danger', 'Danger zone'],
] as const

export default function Settings() {
  const [active, setActive] = useState<string>('workspace')
  const refs = useRef<Record<string, HTMLElement | null>>({})

  return (
    <div className="settings-page">
      <h1 className="settings-sr-h1">Settings</h1>
      <div className="settings-wrap">
        <nav className="settings-snav" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className={active === id ? 'on' : ''}
              aria-current={active === id ? 'true' : undefined}
              onClick={(e) => {
                e.preventDefault()
                setActive(id)
                refs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              {label}
            </a>
          ))}
        </nav>
        <main className="settings-main">
          <section id="workspace" ref={(el) => { refs.current.workspace = el }}>
            <WorkspaceSection />
          </section>
          <section id="channels" ref={(el) => { refs.current.channels = el }}>
            <ChannelsSection />
          </section>
          <section id="notifications" ref={(el) => { refs.current.notifications = el }}>
            <NotificationsSection />
          </section>
          <section id="tokens" ref={(el) => { refs.current.tokens = el }}>
            <TokensSection />
          </section>
          <section id="danger" ref={(el) => { refs.current.danger = el }}>
            <DangerSection />
          </section>
        </main>
      </div>
    </div>
  )
}
