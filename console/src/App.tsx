import { lazy, Suspense, useState, useCallback } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { MotionConfig } from 'framer-motion'
import ErrorBoundary from './components/ErrorBoundary'
import { KeyboardShortcutsHelp } from './components/KeyboardShortcutsHelp'
import Nav from './components/Nav'
import { useLines } from './hooks/use-fleet'
import { useConsoleSession } from './hooks/use-console-session'
import UnlockScreen from './components/UnlockScreen'
import { useUpdateCheck, getStaticVersion } from './hooks/use-update-check'
import { useKeyboardShortcuts } from './hooks/use-keyboard-shortcuts'

// Route-level code splitting — each page loads its own chunk on navigation
const SoupKitchen = lazy(() => import('./pages/SoupKitchen'))
const LineDetail = lazy(() => import('./pages/LineDetail'))
const Inbox = lazy(() => import('./pages/Inbox'))
const Metrics = lazy(() => import('./pages/Metrics'))
const Operator = lazy(() => import('./pages/Operator'))
const Landing = lazy(() => import('./pages/Landing'))

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

  // Keyboard shortcuts help modal
  const [showShortcuts, setShowShortcuts] = useState(false)
  const toggleShortcuts = useCallback(() => setShowShortcuts(p => !p), [])
  const focusSearch = useCallback(() => {
    const target = document.querySelector<HTMLInputElement>('[data-search-shortcut-target="true"]:not(:disabled)')
    target?.focus()
    target?.select()
  }, [])

  // Global keyboard shortcuts (Cmd+K search, 1/2/3 page nav, ? help)
  useKeyboardShortcuts({ onHelp: toggleShortcuts, onSearch: focusSearch })

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
        <Nav
          alertCount={alertCount}
          unreadCount={unreadCount}
          version={version}
          updateAvailable={update.data?.updateAvailable}
          remoteSha={update.data?.remoteSha}
          onUpdateClick={update.openUpdateModal}
          onLogout={showLogout ? onLogout : undefined}
        />
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<ErrorBoundary><SoupKitchen /></ErrorBoundary>} />
              <Route path="/welcome" element={<ErrorBoundary><Landing /></ErrorBoundary>} />
              <Route path="/lines/:name" element={<ErrorBoundary><LineDetail /></ErrorBoundary>} />
              <Route path="/inbox" element={<ErrorBoundary><Inbox /></ErrorBoundary>} />
              <Route path="/metrics" element={<ErrorBoundary><Metrics /></ErrorBoundary>} />
              <Route path="/operator" element={<ErrorBoundary><Operator /></ErrorBoundary>} />
              <Route path="/ops" element={<Navigate to="/operator" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </main>
        <Suspense fallback={null}>
          <UpdateModal
            open={update.showUpdateModal}
            onClose={update.closeUpdateModal}
            currentSha={version}
            lines={lines ?? []}
          />
        </Suspense>
        <KeyboardShortcutsHelp open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      </div>
    </MotionConfig>
  )
}
