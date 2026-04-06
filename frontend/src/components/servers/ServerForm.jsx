import { useState, useEffect } from 'react'
import Icon from '../common/Icon'
import { koToEn } from '../../utils/korean'

const inputClass = 'w-full'

export default function ServerForm({ server, onSave, onClose }) {
  const isEdit = Boolean(server)

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

  const handleSubmit = (e) => {
    e.preventDefault()
    const data = { ...form, port: Number(form.port) }
    onSave(data)
  }

  const labelClass = 'block text-on-surface-secondary mb-2'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-md font-semibold text-on-surface">{isEdit ? 'Edit Server' : 'Add Server'}</h3>
          <button onClick={onClose} className="p-4 hover:bg-surface-hover rounded-base tooltip" data-tooltip="Close">
            <Icon name="close" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
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
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className={labelClass}>Host</label>
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
              <label className={labelClass}>User</label>
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
                type="password"
                required
                value={form.password}
                onChange={e => setForm(p => ({ ...p, password: koToEn(e.target.value) }))}
                className={inputClass}
                placeholder="Password required"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="btn btn-content btn-ghost"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-content btn-primary"
            >
              {isEdit ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
