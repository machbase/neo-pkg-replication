import { useNavigate } from 'react-router'
import StatusBadge from '../common/StatusBadge'
import Icon from '../common/Icon'

export default function JobDetailHeader({ job, onDelete }) {
  const navigate = useNavigate()

  return (
    <header className="flex justify-between items-start mb-24">
      <div>
        <div className="flex items-center gap-12 mb-8">
          <StatusBadge status={job.status} />
          <span className="text-on-surface-tertiary text-sm font-medium">
            Replication ID: {job.id}
          </span>
        </div>
        <h2 className="text-lg font-bold text-on-surface">{job.id}</h2>
      </div>
      <div className="flex gap-8">
        <button
          disabled={job.status === 'running'}
          onClick={() => navigate(`/jobs/${encodeURIComponent(job.id)}/edit`)}
          className="btn btn-content btn-ghost"
        >
          <Icon name="edit" className="icon-sm" />
          <span>Edit</span>
        </button>
        <button
          disabled={job.status === 'running'}
          onClick={onDelete}
          className="btn btn-content btn-danger"
        >
          <Icon name="delete" className="icon-sm" />
          <span>Delete</span>
        </button>
      </div>
    </header>
  )
}
