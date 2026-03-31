import { Routes, Route } from 'react-router'
import useJobs from './hooks/useJobs'
import Sidebar from './components/layout/Sidebar'
import DashboardPage from './pages/DashboardPage'
import JobFormPage from './pages/JobFormPage'
import Toast from './components/common/Toast'

export default function IndexApp() {
  const { jobs, toggleJob, removeJob, refreshJobs } = useJobs()

  return (
    <>
      <div className="flex flex-col lg:flex-row overflow-hidden bg-surface-alt text-on-surface antialiased">
        <Sidebar jobs={jobs} onToggleJob={toggleJob} />
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
    </>
  )
}
