import { useEffect, useState } from 'react'
import { Routes, Route, useNavigate } from 'react-router'
import useJobs from './hooks/useJobs'
import { useApp } from './context/AppContext'
import DashboardPage from './pages/DashboardPage'
import JobFormPage from './pages/JobFormPage'
import ServerSettingsModal from './components/servers/ServerSettingsModal'
import Toast from './components/common/Toast'

const CHANNEL_NAME = 'app:neo-replication'

export default function App() {
  const navigate = useNavigate()
  const { setSelectedJobId } = useApp()
  const { jobs, removeJob, refreshJobs } = useJobs()
  const [showServerSettings, setShowServerSettings] = useState(false)

  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL_NAME)

    ch.onmessage = (e) => {
      const msg = e.data
      if (!msg || !msg.type) return
      switch (msg.type) {
        case 'selectJob':
          setSelectedJobId(msg.payload.jobId)
          navigate('/')
          break
        case 'navigate':
          navigate(msg.payload.path)
          break
        case 'openServerSettings':
          setShowServerSettings(true)
          break
      }
    }

    return () => ch.close()
  }, [navigate, setSelectedJobId])

  return (
    <>
      <div className="bg-surface-alt text-on-surface antialiased">
        <main className="h-screen overflow-y-auto bg-surface-alt">
          <Routes>
            <Route path="/" element={
              <DashboardPage jobs={jobs} onDelete={removeJob} />
            } />
            <Route path="/jobs/new" element={
              <JobFormPage onRefresh={refreshJobs} />
            } />
            <Route path="/jobs/:id/edit" element={
              <JobFormPage onRefresh={refreshJobs} />
            } />
          </Routes>
        </main>
      </div>
      <Toast />
      {showServerSettings && (
        <ServerSettingsModal onClose={() => setShowServerSettings(false)} />
      )}
    </>
  )
}
