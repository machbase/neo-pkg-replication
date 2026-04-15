import { useState } from 'react'
import { Routes, Route, useNavigate } from 'react-router'
import useJobs from './hooks/useJobs'
import { useApp } from './context/AppContext'
import Sidebar from './components/layout/Sidebar'
import DashboardPage from './pages/DashboardPage'
import JobFormPage from './pages/JobFormPage'
import ServerSettingsModal from './components/servers/ServerSettingsModal'
import Toast from './components/common/Toast'

export default function IndexApp() {
  const navigate = useNavigate()
  const { selectedJobId, setSelectedJobId } = useApp()
  const { jobs, toggleJob, installJob, removeJob, refreshJobs } = useJobs()
  const [showServerSettings, setShowServerSettings] = useState(false)

  return (
    <>
      <div className="flex flex-col lg:flex-row overflow-hidden bg-surface-alt text-on-surface antialiased">
        <Sidebar
          jobs={jobs}
          selectedJobId={selectedJobId}
          onSelectJob={(jobId) => {
            setSelectedJobId(jobId)
            navigate('/')
          }}
          onNewJob={() => {
            setSelectedJobId(null)
            navigate('/jobs/new')
          }}
          onToggleJob={toggleJob}
          onInstallJob={installJob}
          onRefresh={refreshJobs}
          onServerSettings={() => setShowServerSettings(true)}
          className="side w-full shrink-0 lg:fixed lg:left-0 lg:top-0 lg:w-64 lg:h-screen z-dropdown border-b lg:border-b-0 lg:border-r border-border"
        />
        <main className="flex-1 h-screen overflow-y-auto bg-surface-alt lg:ml-64">
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
