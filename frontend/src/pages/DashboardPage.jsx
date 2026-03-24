import { useState, useEffect } from 'react'
import { useApp } from '../context/AppContext'
import JobDetailHeader from '../components/dashboard/JobDetailHeader'
import SourceConfigCard from '../components/dashboard/SourceConfigCard'
import TargetConfigCard from '../components/dashboard/TargetConfigCard'
import ConfirmDialog from '../components/common/ConfirmDialog'
import Icon from '../components/common/Icon'

export default function DashboardPage({ jobs, servers, onDelete }) {
  const { selectedJobId, setSelectedJobId } = useApp()
  const [confirmDelete, setConfirmDelete] = useState(false)

  const job = jobs.find(j => j.id === selectedJobId)

  // Auto-select first job if none selected
  useEffect(() => {
    if (!selectedJobId && jobs.length > 0) {
      setSelectedJobId(jobs[0].id)
    }
  }, [jobs, selectedJobId, setSelectedJobId])

  if (!job) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-on-surface-variant">
        <Icon name="inbox" className="text-6xl mb-4 opacity-30" />
        <p className="text-lg font-medium">
          {jobs.length === 0 ? 'No jobs yet' : 'Select a job from the sidebar'}
        </p>
        {jobs.length === 0 && (
          <p className="text-sm mt-2 opacity-60">Click "New Job" to get started</p>
        )}
      </div>
    )
  }

  const handleDelete = async () => {
    await onDelete(job.id)
    setSelectedJobId(null)
    setConfirmDelete(false)
  }

  return (
    <div className="p-10">
      <JobDetailHeader job={job} onDelete={() => setConfirmDelete(true)} />
      <div className="space-y-6 mb-8">
        <SourceConfigCard job={job} servers={servers} />
        <TargetConfigCard job={job} servers={servers} />
      </div>
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
