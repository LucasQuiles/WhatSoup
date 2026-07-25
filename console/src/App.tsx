import { lazy, Profiler, Suspense, useState, useCallback, useEffect, useRef } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import ErrorBoundary from './components/ErrorBoundary'
import { KeyboardShortcutsHelp } from './components/KeyboardShortcutsHelp'
import NavRail from './components/chrome/NavRail'
import ChromeHeader from './components/chrome/ChromeHeader'
import ConnectionBanner from './components/ConnectionBanner'
import { CommandPalette } from './components/CommandPalette'
import { useLines } from './hooks/use-fleet'
import { surfaceProfilerCallback } from './lib/perf'
import { useConsoleSession } from './hooks/use-console-session'
import UnlockScreen from './components/UnlockScreen'
import { useUpdateCheck, getStaticVersion } from './hooks/use-update-check'
import { useKeyboardShortcuts } from './hooks/use-keyboard-shortcuts'
import { useTransportStatus } from './hooks/use-transport-status'
import { useToast } from './hooks/toast-context'

// Route-level code splitting — each page loads its own chunk on navigation
const SoupKitchen = lazy(() => import('./pages/SoupKitchen'))
const LineDetail = lazy(() => import('./pages/LineDetail'))
const Inbox = lazy(() => import('./pages/Inbox'))
const Deployments = lazy(() => import('./pages/Deployments'))
const Settings = lazy(() => import('./pages/Settings'))
const Hatch = lazy(() => import('./pages/Hatch'))
const Operator = lazy(() => import('./pages/Operator'))
const Landing = lazy(() => import('./pages/Landing'))
const Agents = lazy(() => import('./pages/Agents'))
const SkillsHub = lazy(() => import('./pages/SkillsHub'))
const DreamLab = lazy(() => import('./pages/DreamLab'))

// Modal code splitting — loaded only when opened
const UpdateModal = lazy(() => import('./components/UpdateModal'))

function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-text-2 font-mono text-data">Loading...</div>
    </div>
  )
}

export default function App() {
  // B1 closure: in production the console is locked until the operator
  // starts a session — no data hooks fire before the gate opens.
  const session = useConsoleSession()
  if (session.state === 'locked') {
    return <UnlockScreen onUnlocked={session.onUnlocked} />
  }
  if (session.state === 'checking') {
    return <PageLoader />
  }
  return <UnlockedApp onLogout={session.onLock} showLogout={session.state === 'unlocked'} />
}

function UnlockedApp({ onLogout, showLogout }: { onLogout: () => void; showLogout: boolean }) {
  const { data: lines } = useLines()
  const alertCount = lines?.filter(l => l.status !== 'online').length ?? 0
  const unreadCount = lines?.reduce((sum, l) => sum + (l.unread ?? 0), 0) ?? 0

  const update = useUpdateCheck()
  const version = update.data?.sha ?? getStaticVersion()
  const location = useLocation()
  const navigate = useNavigate()

  // First-run (T5 b-10): when the lines query FIRST resolves with zero lines
  // and the operator landed on the fleet root, offer the journey splash. Once
  // per mount — deleting your last line mid-session never force-redirects.
  const firstRunChecked = useRef(false)
  useEffect(() => {
    if (firstRunChecked.current || lines === undefined) return
    firstRunChecked.current = true
    if (lines.length === 0 && location.pathname === '/') {
      navigate('/welcome', { replace: true })
    }
  }, [lines, location.pathname, navigate])

  // Keyboard shortcuts help modal
  const [showShortcuts, setShowShortcuts] = useState(false)
  const toggleShortcuts = useCallback(() => setShowShortcuts(p => !p), [])

  // ⌘K command palette (showcase §17, v1: nav + jump-to-line, read-only).
  // Repurposes the existing Cmd/Ctrl+K binding (use-keyboard-shortcuts is
  // untouched — only what we pass as onSearch changes).
  const [paletteOpen, setPaletteOpen] = useState(false)
  const openPalette = useCallback(() => setPaletteOpen(true), [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])

  // Global keyboard shortcuts (Cmd+K palette, 1/2/3 page nav, ? help)
  useKeyboardShortcuts({ onHelp: toggleShortcuts, onSearch: openPalette })

  // Connection-status surface (DD-29). The hook fires onReconnect exactly once
  // per disconnected→connected transition; we raise a success toast there.
  const toast = useToast()
  const onReconnect = useCallback(() => {
    toast.success('Connection restored')
  }, [toast])
  const transport = useTransportStatus({ onReconnect })

  // Dedicated splash/landing route — rendered full-screen, outside the Nav shell, so
  // it carries its own <main> landmark (no nested-main). Additive and non-breaking:
  // the console chrome (Nav + Fleet at "/") and every other route are untouched.
  if (location.pathname === '/welcome') {
    return (
      <MotionConfig reducedMotion="user">
        <Suspense fallback={<PageLoader />}>
          <ErrorBoundary><Landing /></ErrorBoundary>
        </Suspense>
      </MotionConfig>
    )
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-row h-dvh bg-surface-base overflow-hidden">
        <NavRail
          unreadCount={unreadCount}
          version={version}
          updateAvailable={update.data?.updateAvailable}
          remoteSha={update.data?.remoteSha}
          onUpdateClick={update.openUpdateModal}
          onLogout={showLogout ? onLogout : undefined}
        />
        {/* Content column — the ConnectionBanner sits above the chrome header so
            the rail stays full-height beside the whole column (DD-29); the header
            is v3.5 chrome (T5 b-02) and <main> owns the page surface. */}
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <ConnectionBanner status={transport.status} isDisconnected={transport.isDisconnected} />
          <ChromeHeader alertCount={alertCount} />
          <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <Suspense fallback={<PageLoader />}>
            {/* Profiler around the route tree (19-§2 render profiler, dev-mode logging) */}
            <Profiler id="app-routes" onRender={surfaceProfilerCallback}>
              <Routes>
                <Route path="/" element={<ErrorBoundary><SoupKitchen /></ErrorBoundary>} />
                <Route path="/welcome" element={<ErrorBoundary><Landing /></ErrorBoundary>} />
                <Route path="/hatch" element={<ErrorBoundary><Hatch /></ErrorBoundary>} />
                <Route path="/lines/:name" element={<ErrorBoundary><LineDetail /></ErrorBoundary>} />
                <Route path="/inbox" element={<ErrorBoundary><Inbox /></ErrorBoundary>} />
                {/* Ops consolidation (02-mapping §2, E4): /ops is canonical and
                    renders the Operator surface; /operator redirects to it.
                    T5 b-09a: /metrics is absorbed into Ops as the Metrics tab —
                    the route redirects for deep links. */}
                <Route path="/ops" element={<ErrorBoundary><Operator /></ErrorBoundary>} />
                <Route path="/operator" element={<Navigate to="/ops" replace />} />
                <Route path="/metrics" element={<Navigate to="/ops?tab=metrics" replace />} />
                {/* v3.5 route shells — stubs until their surface beads land
                    (b-04 Agents, b-05 Skills, b-06 Dream Lab, b-08 Deployments,
                    b-09 Settings). */}
                <Route path="/agents" element={<ErrorBoundary><Agents /></ErrorBoundary>} />
                <Route path="/skills" element={<ErrorBoundary><SkillsHub /></ErrorBoundary>} />
                <Route path="/dream-lab" element={<ErrorBoundary><DreamLab /></ErrorBoundary>} />
                <Route path="/deployments" element={<ErrorBoundary><Deployments /></ErrorBoundary>} />
                <Route path="/settings" element={<ErrorBoundary><Settings /></ErrorBoundary>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Profiler>
            </Suspense>
          </main>
        </div>
        <Suspense fallback={null}>
          <UpdateModal
            open={update.showUpdateModal}
            onClose={update.closeUpdateModal}
            currentSha={version}
            lines={lines ?? []}
          />
        </Suspense>
        <KeyboardShortcutsHelp open={showShortcuts} onClose={() => setShowShortcuts(false)} />
        <CommandPalette open={paletteOpen} onClose={closePalette} />
      </div>
    </MotionConfig>
  )
}
