import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useApp } from '../context/AppContext'
import StatusBadge from '../components/common/StatusBadge'
import ConfirmDialog from '../components/common/ConfirmDialog'
import Icon from '../components/common/Icon'

export default function DashboardPage({ jobs, onDelete }) {
  const navigate = useNavigate()
  const { selectedJobId, setSelectedJobId } = useApp()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const job = jobs.find(j => j.id === selectedJobId)

  useEffect(() => {
    if (!selectedJobId && jobs.length > 0) {
      setSelectedJobId(jobs[0].id)
    }
  }, [jobs, selectedJobId, setSelectedJobId])

  if (!job) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-on-surface-tertiary">
        <Icon name="inbox" className="text-4xl mb-3 opacity-30" />
        <p className="text-md font-medium">
          {jobs.length === 0 ? 'No jobs yet' : 'Select a job from the sidebar'}
        </p>
        {jobs.length === 0 && (
          <p className="text-sm mt-1 text-on-surface-disabled">Click "New Job" to get started</p>
        )}
      </div>
    )
  }

  const handleDelete = async () => {
    await onDelete(job.id)
    setSelectedJobId(null)
    setConfirmDelete(false)
  }

  const checkpoints = job.checkpoints || {}
  const cpEntries = Object.entries(checkpoints)

  return (
    <div className="p-5">
      {/* Header */}
      <header className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-3">
          <h2 className="page-title">{job.id}</h2>
          <StatusBadge status={job.status} />
        </div>
        <div className="flex gap-2">
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
            onClick={() => setConfirmDelete(true)}
            className="btn btn-content btn-danger"
          >
            <Icon name="delete" className="icon-sm" />
            <span>Delete</span>
          </button>
        </div>
      </header>

      {/* Checkpoints */}
      <section className="bg-surface-alt p-5 rounded-base border border-border">
        <div className="flex items-center gap-2 mb-3">
          <Icon name="flag" className="text-primary " />
          <h3 className="card-title !mb-0">Checkpoints</h3>
          <span className="ml-auto text-sm text-on-surface-tertiary">
            {cpEntries.length} partition{cpEntries.length !== 1 ? 's' : ''}
          </span>
        </div>
        {cpEntries.length > 0 ? (
          <div className="space-y-1">
            {cpEntries.map(([partition, rid]) => (
              <div key={partition} className="flex items-center justify-between px-3 py-1.5 bg-surface-elevated rounded-sm">
                <span className="text-base text-on-surface">{partition}</span>
                <span className="font-mono text-sm text-on-surface-tertiary">RID {rid}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-on-surface-tertiary">No checkpoints yet</p>
        )}
      </section>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete Job"
          message={`Are you sure you want to delete "${job.id}"? This action cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}
