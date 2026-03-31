import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useApp } from '../context/AppContext'
import * as jobsApi from '../api/jobs'
import Icon from '../components/common/Icon'
import SourceSection from '../components/jobs/SourceSection'
import TargetSection from '../components/jobs/TargetSection'
import ExecutionSection from '../components/jobs/ExecutionSection'
import AdvancedSection from '../components/jobs/AdvancedSection'

const DEFAULTS = {
  id: '',
  source: { host: '', port: 5656, user: 'SYS', password: '', table: '', columns: null, filter: null, transform: null },
  target: { host: '', port: 5656, user: 'SYS', password: '', table: '', autoCreate: false },
  startMode: 'full',
  ridAfter: '',
  queryLimit: 5000,
  ridRangeSize: 50000,
  pollIntervalMs: 1000,
  shutdownTimeoutMs: 30000,
  onSaveFailure: 'continue',
  integrity: null,
  retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 30000 },
  logging: { level: 'info', stdout: true, file: { enabled: false, directory: '/work/logs' } },
}

export default function JobFormPage({ onRefresh }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const { notify } = useApp()
  const isEdit = Boolean(id)

  const [form, setForm] = useState(DEFAULTS)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (isEdit) {
      jobsApi.getJob(id).then(data => {
        setForm({
          ...DEFAULTS,
          ...data,
          id: data.name || data.id || id,
          source: { ...DEFAULTS.source, ...data.source },
          target: { ...DEFAULTS.target, ...data.target },
          retry: data.retry || DEFAULTS.retry,
          logging: data.logging ? { ...DEFAULTS.logging, ...data.logging, file: { ...DEFAULTS.logging.file, ...data.logging?.file } } : DEFAULTS.logging,
        })
      }).catch(e => {
        notify(e.reason || e.message, 'error')
        navigate('/')
      })
    }
  }, [id, isEdit, navigate, notify])

  const update = (path, value) => {
    setForm(prev => {
      const next = { ...prev }
      const keys = path.split('.')
      let obj = next
      for (let i = 0; i < keys.length - 1; i++) {
        obj[keys[i]] = { ...obj[keys[i]] }
        obj = obj[keys[i]]
      }
      obj[keys[keys.length - 1]] = value
      return next
    })
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const name = form.id || null
      const config = {
        id: name,
        source: {
          ...form.source,
          port: Number(form.source.port),
          columns: form.source.columns?.length ? form.source.columns : null,
        },
        target: {
          ...form.target,
          port: Number(form.target.port),
        },
        startMode: form.startMode,
        queryLimit: Number(form.queryLimit),
        ridRangeSize: Number(form.ridRangeSize),
        pollIntervalMs: Number(form.pollIntervalMs),
        shutdownTimeoutMs: Number(form.shutdownTimeoutMs),
        onSaveFailure: form.onSaveFailure,
        integrity: form.integrity,
        retry: form.retry ? {
          ...form.retry,
          maxAttempts: Number(form.retry.maxAttempts),
          baseDelayMs: Number(form.retry.baseDelayMs),
          maxDelayMs: Number(form.retry.maxDelayMs),
        } : null,
        logging: form.logging,
      }
      if (form.startMode === 'ridAfter') {
        config.ridAfter = Number(form.ridAfter)
      }

      if (isEdit) {
        await jobsApi.updateJob(id, config)
        notify(`Job '${id}' updated`, 'success')
      } else {
        await jobsApi.createJob({ name, config })
        notify(`Job created`, 'success')
      }
      if (onRefresh) await onRefresh()
      navigate('/')
    } catch (e) {
      notify(e.reason || e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-24 pb-10">
      {/* Header */}
      <div className="flex justify-between items-start mb-6 gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <button onClick={() => navigate('/')} className="p-1 hover:bg-surface-hover rounded-base transition-colors shrink-0">
              <Icon name="arrow_back" />
            </button>
            <h2 className="page-title truncate">
              {isEdit ? 'Edit Job' : 'New Replication Job'}
            </h2>
          </div>
          <p className="text-sm text-on-surface-disabled ml-8">
            Configure source-to-target data replication parameters.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="btn btn-content btn-ghost"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="job-form"
            disabled={saving}
            className="btn btn-content btn-primary"
          >
            {saving ? 'Saving...' : (isEdit ? 'Update Job' : 'Create Job')}
          </button>
        </div>
      </div>

      <form id="job-form" onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Left column */}
          <div className="space-y-4">
            {/* Job Identity */}
            <div className="form-card">
              <div className="form-card-header">
                <Icon name="badge" className="text-primary" />
                Job Identity
              </div>
              <div>
                <label className="form-label">Job ID (optional)</label>
                <input
                  type="text"
                  disabled={isEdit}
                  value={form.id}
                  onChange={e => update('id', e.target.value)}
                  className="w-full disabled:opacity-50"
                  placeholder="Auto-generated from table names if empty"
                />
              </div>
            </div>

            <SourceSection form={form} update={update} />
          </div>

          {/* Right column */}
          <div className="space-y-4">
            <TargetSection form={form} update={update} />
            <ExecutionSection form={form} update={update} />
            <AdvancedSection form={form} update={update} />
          </div>
        </div>
      </form>
    </div>
  )
}
