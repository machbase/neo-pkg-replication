import { useNavigate } from 'react-router'
import StatusBadge from '../common/StatusBadge'
import Icon from '../common/Icon'

export default function JobDetailHeader({ job, onDelete }) {
  const navigate = useNavigate()

  return (
    <header className="flex justify-between items-start mb-12">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <StatusBadge status={job.status} />
          <span className="text-on-surface-variant text-sm font-medium">
            Replication ID: {job.id}
          </span>
        </div>
        <h2 className="text-4xl font-extrabold tracking-tight text-on-surface">{job.id}</h2>
      </div>
      <div className="flex gap-3">
        <button
          disabled={job.status === 'running'}
          onClick={() => navigate(`/jobs/${encodeURIComponent(job.id)}/edit`)}
          className="flex items-center gap-2 px-4 py-2 text-on-secondary-container font-semibold hover:bg-surface-container-highest transition-all rounded-lg disabled:opacity-40 disabled:pointer-events-none"
        >
          <Icon name="edit"  />
          <span>Edit</span>
        </button>
        <button
          disabled={job.status === 'running'}
          onClick={onDelete}
          className="flex items-center gap-2 px-4 py-2 text-error font-semibold hover:bg-error-container/20 transition-all rounded-lg disabled:opacity-40 disabled:pointer-events-none"
        >
          <Icon name="delete"  />
          <span>Delete</span>
        </button>
      </div>
    </header>
  )
}
