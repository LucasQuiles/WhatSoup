import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import Nav from './components/Nav'
import { useLines } from './hooks/use-fleet'
import { useUpdateCheck, getStaticVersion } from './hooks/use-update-check'

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
      <div className="text-t4 font-mono" style={{ fontSize: 'var(--font-size-data)' }}>Loading...</div>
    </div>
  )
}

export default function App() {
  const { data: lines } = useLines()
  const alertCount = lines?.filter(l => l.status !== 'online').length ?? 0
  const unreadCount = lines?.reduce((sum, l) => sum + (l.unread ?? 0), 0) ?? 0

  const update = useUpdateCheck()
  const version = update.data?.sha ?? getStaticVersion()

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
            <Route path="/" element={<SoupKitchen />} />
            <Route path="/lines/:name" element={<LineDetail />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/ops" element={<Ops />} />
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
    </div>
  )
}
