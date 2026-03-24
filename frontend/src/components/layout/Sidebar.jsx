import { Link, useNavigate, useLocation } from 'react-router'
import { useApp } from '../../context/AppContext'
import Icon from '../common/Icon'
import JobListItem from '../jobs/JobListItem'

export default function Sidebar({ jobs, onToggleJob }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { selectedJobId, setSelectedJobId } = useApp()

  return (
    <aside className="fixed left-0 top-0 h-full flex flex-col p-4 z-40 bg-slate-50 w-64 border-r-0 font-['Inter'] antialiased tracking-tight text-sm font-medium">
      {/* Brand */}
      <div className="flex items-center gap-3 mb-8 px-2">
        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary to-primary-container flex items-center justify-center text-white shadow-md">
          <Icon name="rebase_edit" />
        </div>
        <div>
          <h1 className="text-lg font-bold tracking-tighter text-slate-900 leading-tight">Replication Manager</h1>
          <p className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold opacity-60">Database Curator</p>
        </div>
      </div>

      {/* New Replication Button */}
      <button
        onClick={() => navigate('/jobs/new')}
        className="mb-6 w-full flex items-center justify-center gap-2 py-3 bg-gradient-to-br from-primary to-primary-container text-white rounded-lg shadow-sm font-semibold active:scale-[0.98] transition-transform"
      >
        <Icon name="add" />
        <span>New Job</span>
      </button>

      {/* Job List */}
      <nav className="flex-1 space-y-1 overflow-y-auto">
        {jobs.map(job => (
          <JobListItem
            key={job.id}
            job={job}
            selected={selectedJobId === job.id}
            onSelect={() => {
              setSelectedJobId(job.id)
              if (location.pathname !== '/') navigate('/')
            }}
            onToggle={() => onToggleJob(job)}
          />
        ))}
        {jobs.length === 0 && (
          <p className="px-4 py-8 text-center text-slate-400 text-xs">No replication jobs</p>
        )}
      </nav>

      {/* Footer */}
      <div className="mt-auto pt-4 border-t border-slate-200/50">
        <Link
          to="/servers"
          className="flex items-center gap-3 px-4 py-3 text-slate-500 hover:bg-slate-200/50 transition-colors rounded-lg cursor-pointer"
        >
          <Icon name="settings" />
          <span className="flex-1">Server Settings</span>
        </Link>
      </div>
    </aside>
  )
}
