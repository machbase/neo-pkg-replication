import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useApp } from '../context/AppContext'
import StatusBadge from '../components/common/StatusBadge'
import ConfirmDialog from '../components/common/ConfirmDialog'
import Icon from '../components/common/Icon'

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs text-on-surface-tertiary mb-4">{label}</p>
      <p className="text-base text-on-surface font-mono break-all">{value || 'N/A'}</p>
    </div>
  )
}

export default function DashboardPage({ jobs, onDelete }) {
  const navigate = useNavigate()
  const { selectedJobId, setSelectedJobId, jobDetail, detailLoading, fetchJobDetail } = useApp()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)

  const listJob = jobs.find(j => j.id === selectedJobId)

  useEffect(() => {
    if (selectedJobId) {
      fetchJobDetail(selectedJobId).then(data => {
        if (data) setLastUpdated(new Date())
      })
    }
  }, [selectedJobId, fetchJobDetail])

  if (!listJob) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-on-surface-tertiary">
        <Icon name="inbox" className="text-lg mb-12 opacity-30" />
        <p className="text-md font-medium">
          {jobs.length === 0 ? 'No jobs yet' : 'Select a job from the sidebar'}
        </p>
        {jobs.length === 0 && (
          <p className="text-sm mt-4 text-on-surface-disabled">Click "New Job" to get started</p>
        )}
      </div>
    )
  }

  if (detailLoading || !jobDetail) {
    return (
      <div className="flex items-center justify-center h-full text-on-surface-tertiary">
        <p className="text-sm">Loading...</p>
      </div>
    )
  }

  const handleDelete = async () => {
    await onDelete(listJob.id)
    setSelectedJobId(null)
    setConfirmDelete(false)
  }

  const src = jobDetail.source || {}
  const tgt = jobDetail.target || {}
  const retry = jobDetail.retry || {}
  // TODO: remove dummy data when backend implements checkpoints
  const DUMMY_CHECKPOINTS = {
    'PARTITION_0': 154320,
    'PARTITION_1': 98210,
    'PARTITION_2': 231050,
    'PARTITION_3': 45600,
  }
  const checkpoints = jobDetail.checkpoints && Object.keys(jobDetail.checkpoints).length > 0
    ? jobDetail.checkpoints
    : DUMMY_CHECKPOINTS
  const cpEntries = Object.entries(checkpoints)

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header-inner">
          <div className="flex items-center gap-12">
            <h2 className="page-title">{listJob.id}</h2>
            <StatusBadge status={listJob.status} />
          </div>
          <div className="flex gap-8">
            <button
              disabled={listJob.status === 'running'}
              onClick={() => navigate(`/jobs/${encodeURIComponent(listJob.id)}/edit`)}
              className="btn btn-content btn-primary"
            >
              <Icon name="edit" className="icon-sm" />
              <span>Edit</span>
            </button>
            <button
              disabled={listJob.status === 'running'}
              onClick={() => setConfirmDelete(true)}
              className="btn btn-content btn-danger"
            >
              <Icon name="delete" className="icon-sm" />
              <span>Delete</span>
            </button>
          </div>
        </div>
      </header>
      <div className="page-body">
      <div className="page-body-inner">

        {/* Checkpoints — full width */}
        <section className="form-card mb-16">
          <div className="form-card-header">
            <Icon name="account_tree" className="text-primary" />
            Replication Info
            {lastUpdated && (
              <span className="ml-auto" style={{ fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-normal)', color: 'var(--color-on-surface-disabled)' }}>
                Last updated: {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={() => fetchJobDetail(selectedJobId, true).then(data => { if (data) setLastUpdated(new Date()) })}
              className={`${lastUpdated ? '' : 'ml-auto'} p-4 hover:bg-surface-hover rounded-base transition-colors tooltip`}
              data-tooltip="Refresh"
            >
              <Icon name="refresh" className="icon-sm" />
            </button>
          </div>
          {cpEntries.length > 0 ? (
            <div className="flex items-start gap-16">
              <Icon name="database" className="text-primary shrink-0" style={{ fontSize: '200px' }} />
              <div className="flex-1">
                <table className="w-full">
                  <thead>
                    <tr className="text-xs text-on-surface-tertiary">
                      <th className="text-left font-medium pb-8 pl-12">Partition</th>
                      <th className="text-right font-medium pb-8 pr-12">Last Row ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cpEntries.map(([partition, rid]) => (
                      <tr key={partition} className="border-t border-border">
                        <td className="py-8 pl-12">
                          <span className="text-sm text-on-surface">{partition}</span>
                        </td>
                        <td className="py-8 pr-12 text-right">
                          <span className="font-mono text-sm text-on-surface-secondary">{rid}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-right text-xs text-on-surface-disabled mt-8 pr-12">
                  Total Rows: {cpEntries.reduce((sum, [, rid]) => sum + Number(rid), 0).toLocaleString()}
                </p>
              </div>
            </div>
          ) : (
            <div className="dash-field-box">
              <Icon name="database" className="text-on-surface-disabled" />
              <span className="text-sm text-on-surface-disabled">Job has not been executed yet</span>
            </div>
          )}
        </section>

        {/* Two-column layout */}
        <div className="flex flex-col lg:flex-row items-start gap-16">
          {/* Left column: Execution / Advanced */}
          <div className="flex-1 lg:min-w-0 space-y-16">
            <section className="form-card">
              <div className="form-card-header">
                <Icon name="tune" className="text-primary" />
                Execution Settings
              </div>
              <div className="grid grid-cols-2 gap-16 mb-16">
                <Field label="Start Mode" value={jobDetail.startMode} />
                <Field label="On Save Failure" value={jobDetail.onSaveFailure} />
              </div>
              <div className="grid grid-cols-3 gap-16">
                <Field label="Query Limit" value={jobDetail.queryLimit} />
                <Field label="Poll Interval" value={`${jobDetail.pollIntervalMs}ms`} />
                <Field label="RID Range Size" value={jobDetail.ridRangeSize} />
              </div>
            </section>

            <section className="form-card">
              <div className="form-card-header">
                <Icon name="settings" className="text-primary" />
                Advanced Settings
              </div>
              <div className="grid grid-cols-2 gap-16 mb-16">
                <Field label="Shutdown Timeout" value={`${jobDetail.shutdownTimeoutMs}ms`} />
                <Field label="Integrity Check" value={jobDetail.integrity !== false ? 'Enabled' : 'Disabled'} />
              </div>
              <div className="grid grid-cols-3 gap-16">
                <Field label="Retry Max Attempts" value={retry.maxAttempts} />
                <Field label="Retry Base Delay" value={retry.baseDelayMs ? `${retry.baseDelayMs}ms` : null} />
                <Field label="Retry Max Delay" value={retry.maxDelayMs ? `${retry.maxDelayMs}ms` : null} />
              </div>
            </section>
          </div>

          {/* Right column: Source / Target */}
          <div className="flex-1 lg:min-w-0 space-y-16">
            <section className="form-card">
              <div className="form-card-header">
                <Icon name="database" className="text-primary" />
                Source Database
              </div>
              <div className="flex gap-16">
                <div className="flex-1"><Field label="Host" value={src.host ? `${src.host}:${src.port}` : null} /></div>
                <div className="w-80"><Field label="User" value={src.user} /></div>
                <div className="w-80"><Field label="Table" value={src.table} /></div>
              </div>
              <div className="mt-16">
                <button
                  type="button"
                  onClick={() => setColumnsOpen(prev => !prev)}
                  className="flex items-center gap-4 text-xs text-on-surface-tertiary hover:text-on-surface-secondary transition-colors"
                >
                  <Icon name={columnsOpen ? 'expand_more' : 'chevron_right'} className="icon-sm" />
                  Columns {src.columns ? `(${src.columns.length})` : '(All)'}
                </button>
                {columnsOpen && (
                  <div className="flex flex-wrap gap-4 mt-8 max-h-120 overflow-y-auto">
                    {src.columns && src.columns.length > 0 ? src.columns.map(c => (
                      <span key={c} className="px-8 py-2 bg-surface-elevated rounded-sm text-sm text-on-surface-secondary">{c}</span>
                    )) : (
                      <span className="text-sm text-on-surface-tertiary">All columns</span>
                    )}
                  </div>
                )}
              </div>
              {src.filter && src.filter.length > 0 && (
                <div className="mt-12">
                  <p className="text-xs text-on-surface-tertiary mb-4">Filter Rules</p>
                  <div className="flex flex-wrap gap-4">
                    {src.filter.map(r => (
                      <span key={r.column} className="px-8 py-2 bg-surface-elevated rounded-sm text-sm text-on-surface-secondary">
                        {r.column}: {r.like ? `LIKE '${r.like}'` : ''}{r.in ? `IN [${r.in.join(', ')}]` : ''}{r.min != null ? `≥${r.min}` : ''}{r.max != null ? ` ≤${r.max}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {src.transform && src.transform.length > 0 && (
                <div className="mt-12">
                  <p className="text-xs text-on-surface-tertiary mb-4">Transform Rules</p>
                  <div className="flex flex-wrap gap-4">
                    {src.transform.map(r => (
                      <span key={r.column} className="px-8 py-2 bg-surface-elevated rounded-sm text-sm text-on-surface-secondary">
                        {r.column}: {r.prefix ? `prefix='${r.prefix}'` : ''}{r.suffix ? ` suffix='${r.suffix}'` : ''}{r.add != null ? `+${r.add}` : ''}{r.multiply != null ? ` ×${r.multiply}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="form-card">
              <div className="form-card-header">
                <Icon name="output" className="text-primary" />
                Target Database
              </div>
              <div className="flex gap-16">
                <div className="flex-1"><Field label="Host" value={tgt.host ? `${tgt.host}:${tgt.port}` : null} /></div>
                <div className="w-80"><Field label="User" value={tgt.user} /></div>
                <div className="w-80"><Field label="Table" value={tgt.table} /></div>
              </div>
            </section>
          </div>
        </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete Job"
          message={`Are you sure you want to delete "${listJob.id}"? This action cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      </div>
      </div>
    </div>
  )
}
