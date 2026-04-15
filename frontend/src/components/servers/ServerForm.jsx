import { useState, useEffect } from 'react'
import Icon from '../common/Icon'
import { koToEn } from '../../utils/korean'

const inputClass = 'w-full'

export default function ServerForm({ server, onSave, onClose }) {
  const isEdit = Boolean(server)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const handleKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  const [form, setForm] = useState({
    name: server?.name || '',
    host: server?.host || '',
    port: server?.port || 5656,
    user: server?.user || 'SYS',
    password: '',
  })

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const data = { ...form, port: Number(form.port) }
      // Edit 모드에서 password 빈 값이면 payload에서 제외 (서버가 기존값 유지)
      if (isEdit && !data.password) delete data.password
      await onSave(data)
    } finally {
      setSaving(false)
    }
  }

  const labelClass = 'block text-on-surface-secondary mb-2'

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal-md" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-header-title">
            <Icon name={isEdit ? 'edit' : 'add_circle'} className="text-primary" />
            {isEdit ? 'Edit Server' : 'Add Server'}
          </div>
          <button onClick={onClose} className="p-4 hover:bg-surface-hover rounded-base tooltip" data-tooltip="Close">
            <Icon name="close" />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className={labelClass}>Name</label>
                <input
                  type="text"
                  required
                  disabled={isEdit}
                  value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className={`${inputClass} disabled:opacity-50`}
                  placeholder="e.g., src"
                />
              </div>
              <div>
                <label className={labelClass}>Type</label>
                <input
                  type="text"
                  disabled
                  value="native"
                  className={`${inputClass} disabled:opacity-50`}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className={labelClass}>IP</label>
                <input
                  type="text"
                  required
                  value={form.host}
                  onChange={e => setForm(p => ({ ...p, host: e.target.value }))}
                  className={inputClass}
                  placeholder="127.0.0.1"
                />
              </div>
              <div>
                <label className={labelClass}>Port</label>
                <input
                  type="number"
                  required
                  value={form.port}
                  onChange={e => setForm(p => ({ ...p, port: e.target.value }))}
                  className={inputClass}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>ID</label>
                <input
                  type="text"
                  required
                  value={form.user}
                  onChange={e => setForm(p => ({ ...p, user: e.target.value }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Password</label>
                <input
                  type="text"
                  required={!isEdit}
                  value={form.password}
                  onChange={e => setForm(p => ({ ...p, password: koToEn(e.target.value) }))}
                  className={`${inputClass} input-password`}
                  placeholder={isEdit ? 'Leave blank to keep current' : 'Password required'}
                />
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" onClick={onClose} className="btn btn-content btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn btn-content btn-primary">
              {isEdit ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
