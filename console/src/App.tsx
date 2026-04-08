import { lazy, Suspense, useState, useCallback } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import ErrorBoundary from './components/ErrorBoundary'
import { KeyboardShortcutsHelp } from './components/KeyboardShortcutsHelp'
import Nav from './components/Nav'
import { useLines } from './hooks/use-fleet'
import { useUpdateCheck, getStaticVersion } from './hooks/use-update-check'
import { useKeyboardShortcuts } from './hooks/use-keyboard-shortcuts'

// Route-level code splitting — each page loads its own chunk on navigation
const SoupKitchen = lazy(() => import('./pages/SoupKitchen'))
const LineDetail = lazy(() => import('./pages/LineDetail'))
const Inbox = lazy(() => import('./pages/Inbox'))
const Ops = lazy(() => import('./pages/Ops'))

// Modal code splitting — loaded only when opened
const UpdateModal = lazy(() => import('./components/UpdateModal'))

function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-t4 font-mono text-[var(--font-size-data)]">Loading...</div>
    </div>
  )
}

export default function App() {
  const { data: lines } = useLines()
  const alertCount = lines?.filter(l => l.status !== 'online').length ?? 0
  const unreadCount = lines?.reduce((sum, l) => sum + (l.unread ?? 0), 0) ?? 0

  const update = useUpdateCheck()
  const version = update.data?.sha ?? getStaticVersion()

  // Keyboard shortcuts help modal
  const [showShortcuts, setShowShortcuts] = useState(false)
  const toggleShortcuts = useCallback(() => setShowShortcuts(p => !p), [])

  // Global keyboard shortcuts (Cmd+K search, 1/2/3 page nav, ? help)
  useKeyboardShortcuts({ onHelp: toggleShortcuts })

  return (
    <div className="flex flex-col h-screen bg-d0 overflow-hidden">
      <Nav
        alertCount={alertCount}
        unreadCount={unreadCount}
        version={version}
        updateAvailable={update.data?.updateAvailable}
        remoteSha={update.data?.remoteSha}
        onUpdateClick={update.openUpdateModal}
      />
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/" element={<ErrorBoundary><SoupKitchen /></ErrorBoundary>} />
            <Route path="/lines/:name" element={<ErrorBoundary><LineDetail /></ErrorBoundary>} />
            <Route path="/inbox" element={<ErrorBoundary><Inbox /></ErrorBoundary>} />
            <Route path="/ops" element={<ErrorBoundary><Ops /></ErrorBoundary>} />
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
  )
}
