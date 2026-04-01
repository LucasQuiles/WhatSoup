import { Routes, Route } from 'react-router-dom'
import Nav from './components/Nav'
import SoupKitchen from './pages/SoupKitchen'
import LineDetail from './pages/LineDetail'
import Inbox from './pages/Inbox'
import Ops from './pages/Ops'
import { useLines } from './hooks/use-fleet'

export default function App() {
  const { data: lines } = useLines()
  const alertCount = lines?.filter(l => l.status !== 'online').length ?? 0
  const unreadCount = lines?.reduce((sum, l) => sum + (l.unread ?? 0), 0) ?? 0

  return (
    <div className="flex flex-col h-screen bg-d0 overflow-hidden">
      <Nav alertCount={alertCount} unreadCount={unreadCount} />
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <Routes>
          <Route path="/" element={<SoupKitchen />} />
          <Route path="/lines/:name" element={<LineDetail />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/ops" element={<Ops />} />
        </Routes>
      </main>
    </div>
  )
}
