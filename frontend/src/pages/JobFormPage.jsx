import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useApp } from '../context/AppContext'
import * as jobsApi from '../api/jobs'
import useTableSchema from '../hooks/useTableSchema'
import Icon from '../components/common/Icon'
import SourceSection from '../components/jobs/SourceSection'
import TargetSection from '../components/jobs/TargetSection'
import ExecutionSection from '../components/jobs/ExecutionSection'
import AdvancedSection from '../components/jobs/AdvancedSection'

const DEFAULTS = {
  id: '',
  source: { server: '', table: '', columns: null, tagIdentifier: { mode: 'none', value: '' } },
  target: { server: '', table: '', autoCreate: false },
  startMode: 'full',
  ridAfter: '',
  queryLimit: 5000,
  ridRangeSize: 50000,
  pollIntervalMs: 1000,
  shutdownTimeoutMs: 30000,
  onSaveFailure: 'continue',
  integrity: { enabled: true },
  retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 30000 },
}

const inputClass = 'w-full px-4 py-3 bg-surface-container-lowest border border-outline-variant/30 rounded-lg text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30'

export default function JobFormPage({ servers, onRefresh }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const { notify } = useApp()
  const isEdit = Boolean(id)

  const [form, setForm] = useState(DEFAULTS)
  const [saving, setSaving] = useState(false)
  const { tables: srcTables, columns: srcColumns, fetchTables: fetchSrcTables, fetchColumns: fetchSrcColumns } = useTableSchema()
  useEffect(() => {
    if (isEdit) {
      jobsApi.getJob(id).then(data => {
        setForm({
          ...DEFAULTS,
          ...data,
          source: { ...DEFAULTS.source, ...data.source },
          target: { ...DEFAULTS.target, ...data.target },
          integrity: data.integrity || DEFAULTS.integrity,
          retry: data.retry || DEFAULTS.retry,
        })
      }).catch(e => {
        notify(e.reason || e.message, 'error')
        navigate('/')
      })
    }
  }, [id, isEdit, navigate, notify])

  useEffect(() => {
    if (form.source.server) fetchSrcTables(form.source.server)
  }, [form.source.server, fetchSrcTables])

  useEffect(() => {
    if (form.source.server && form.source.table) {
      fetchSrcColumns(form.source.server, form.source.table)
    }
  }, [form.source.server, form.source.table, fetchSrcColumns])

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
      const { status, ...formData } = form
      const payload = {
        ...formData,
        queryLimit: Number(form.queryLimit),
        ridRangeSize: Number(form.ridRangeSize),
        pollIntervalMs: Number(form.pollIntervalMs),
        shutdownTimeoutMs: Number(form.shutdownTimeoutMs),
        source: {
          ...form.source,
          columns: form.source.columns?.length ? form.source.columns : null,
        },
        retry: {
          ...form.retry,
          maxAttempts: Number(form.retry.maxAttempts),
          baseDelayMs: Number(form.retry.baseDelayMs),
          maxDelayMs: Number(form.retry.maxDelayMs),
        },
      }
      if (payload.startMode === 'ridAfter') {
        payload.ridAfter = String(form.ridAfter).trim()
      } else {
        delete payload.ridAfter
      }

      if (isEdit) {
        await jobsApi.updateJob(id, payload)
        notify(`Job '${id}' updated`, 'success')
      } else {
        await jobsApi.createJob(payload)
        notify(`Job '${payload.id}' created`, 'success')
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
    <div className="p-10">
      <div className="flex items-center gap-3 mb-8">
        <button onClick={() => navigate('/')} className="p-2 hover:bg-surface-container-high rounded-lg transition-colors">
          <Icon name="arrow_back" />
        </button>
        <h2 className="text-3xl font-extrabold tracking-tight text-on-surface">
          {isEdit ? 'Edit Job' : 'New Job'}
        </h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Job ID */}
        {!isEdit && (
          <div>
            <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Job ID</label>
            <input
              type="text"
              required
              value={form.id}
              onChange={e => update('id', e.target.value)}
              className={inputClass}
              placeholder="e.g., tag-replication-1"
            />
          </div>
        )}

        <SourceSection form={form} update={update} servers={servers} srcTables={srcTables} srcColumns={srcColumns} inputClass={inputClass} />
        <TargetSection form={form} update={update} servers={servers} inputClass={inputClass} />
        <ExecutionSection form={form} update={update} inputClass={inputClass} />
        <AdvancedSection form={form} update={update} inputClass={inputClass} />

        {/* Submit */}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="px-6 py-3 text-sm font-semibold text-on-surface-variant hover:bg-surface-container-high rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-3 text-sm font-semibold text-on-primary bg-gradient-to-br from-primary to-primary-container rounded-lg shadow-sm hover:shadow-md transition-all disabled:opacity-50"
          >
            {saving ? 'Saving...' : (isEdit ? 'Update Job' : 'Create Job')}
          </button>
        </div>
      </form>
    </div>
  )
}
