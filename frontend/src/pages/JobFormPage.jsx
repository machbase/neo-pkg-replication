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

const inputClass = 'w-full'

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

      const payload = { name, config }

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
    <div className="p-5">
      <div className="flex items-center gap-2 mb-6">
        <button onClick={() => navigate('/')} className="p-1 hover:bg-surface-hover rounded-base transition-colors">
          <Icon name="arrow_back" />
        </button>
        <h2 className="page-title">
          {isEdit ? 'Edit Job' : 'New Job'}
        </h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Job ID */}
        <div>
          <label className="block text-on-surface-secondary mb-2">Job ID (optional)</label>
          <input
            type="text"
            disabled={isEdit}
            value={form.id}
            onChange={e => update('id', e.target.value)}
            className={`${inputClass} disabled:opacity-50`}
            placeholder="Auto-generated from table names if empty"
          />
        </div>

        <SourceSection form={form} update={update} inputClass={inputClass} />
        <TargetSection form={form} update={update} inputClass={inputClass} />
        <ExecutionSection form={form} update={update} inputClass={inputClass} />
        <AdvancedSection form={form} update={update} inputClass={inputClass} />

        {/* Submit */}
        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="btn btn-content btn-ghost"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="btn btn-content btn-primary"
          >
            {saving ? 'Saving...' : (isEdit ? 'Update Job' : 'Create Job')}
          </button>
        </div>
      </form>
    </div>
  )
}
