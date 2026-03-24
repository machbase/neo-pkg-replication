import { Routes, Route } from 'react-router'
import useJobs from './hooks/useJobs'
import useServers from './hooks/useServers'
import Sidebar from './components/layout/Sidebar'
import DashboardPage from './pages/DashboardPage'
import JobFormPage from './pages/JobFormPage'
import ServerSettingsPage from './pages/ServerSettingsPage'
import Toast from './components/common/Toast'

export default function App() {
  const { jobs, toggleJob, removeJob, refreshJobs } = useJobs()
  const { servers, loading: serversLoading, addServer, editServer, removeServer, healthCheck } = useServers()

  return (
    <>
      <div className="flex overflow-hidden bg-surface font-body text-on-surface antialiased">
        <Sidebar jobs={jobs} onToggleJob={toggleJob} />
        <main className="ml-64 flex-1 h-screen overflow-y-auto bg-surface-container-low">
          <Routes>
            <Route path="/" element={
              <DashboardPage jobs={jobs} servers={servers} onDelete={removeJob} />
            } />
            <Route path="/jobs/new" element={
              <JobFormPage servers={servers} onRefresh={refreshJobs} />
            } />
            <Route path="/jobs/:id/edit" element={
              <JobFormPage servers={servers} onRefresh={refreshJobs} />
            } />
            <Route path="/servers" element={
              <ServerSettingsPage
                servers={servers}
                loading={serversLoading}
                onAdd={addServer}
                onEdit={editServer}
                onDelete={removeServer}
                onHealthCheck={healthCheck}
              />
            } />
          </Routes>
        </main>
      </div>
      <Toast />
    </>
  )
}
