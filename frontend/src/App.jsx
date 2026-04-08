import { useEffect, useRef } from 'react'
import { Routes, Route, useNavigate } from 'react-router'
import useJobs from './hooks/useJobs'
import { useApp } from './context/AppContext'
import DashboardPage from './pages/DashboardPage'
import JobFormPage from './pages/JobFormPage'
import Toast from './components/common/Toast'

const CHANNEL_NAME = 'app:neo-replication'

export default function App() {
  const navigate = useNavigate()
  const { selectedJobId, setSelectedJobId } = useApp()
  const { jobs, toggleJob, installJob, removeJob, refreshJobs } = useJobs()
  const channelRef = useRef(null)
  const handlersRef = useRef({})

  handlersRef.current = {
    selectJob: (payload) => {
      setSelectedJobId(payload.jobId)
      navigate('/')
    },
    navigate: (payload) => {
      navigate(payload.path)
    },
    toggleJob: (payload) => {
      const job = jobs.find(j => j.id === payload.jobId)
      if (job) toggleJob(job)
    },
    installJob: (payload) => {
      const job = jobs.find(j => j.id === payload.jobId)
      if (job) installJob(job)
    },
    requestReady: () => {
      const ch = channelRef.current
      if (!ch) return
      ch.postMessage({ type: 'ready' })
      ch.postMessage({ type: 'jobsData', payload: { jobs } })
      ch.postMessage({ type: 'jobSelected', payload: { jobId: selectedJobId } })
    },
  }

  useEffect(() => {
    const ch = new BroadcastChannel(CHANNEL_NAME)
    channelRef.current = ch

    ch.onmessage = (e) => {
      const msg = e.data
      if (!msg || !msg.type) return
      const handler = handlersRef.current[msg.type]
      if (handler) handler(msg.payload)
    }

    ch.postMessage({ type: 'ready' })
    return () => ch.close()
  }, [])

  useEffect(() => {
    channelRef.current?.postMessage({ type: 'jobsData', payload: { jobs } })
  }, [jobs])

  useEffect(() => {
    channelRef.current?.postMessage({ type: 'jobSelected', payload: { jobId: selectedJobId } })
  }, [selectedJobId])

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
    </>
  )
}
