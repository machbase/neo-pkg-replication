import { useState } from 'react'
import Icon from '../common/Icon'

const inputClass = 'w-full px-4 py-2.5 bg-surface-container-lowest border border-outline-variant/30 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30'

export default function ServerForm({ server, onSave, onClose }) {
  const isEdit = Boolean(server)
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-lg font-bold text-on-surface">{isEdit ? 'Edit Server' : 'Add Server'}</h3>
          <button onClick={onClose} className="p-1 hover:bg-surface-container-high rounded-lg">
            <Icon name="close" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-1 tracking-widest">Name</label>
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
              <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-1 tracking-widest">Host</label>
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
              <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-1 tracking-widest">Port</label>
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
              <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-1 tracking-widest">User</label>
              <input
                type="text"
                required
                value={form.user}
                onChange={e => setForm(p => ({ ...p, user: e.target.value }))}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-1 tracking-widest">Password</label>
              <input
                type="password"
                required
                value={form.password}
                onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                className={inputClass}
                placeholder="Password required"
              />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold text-on-surface-variant hover:bg-surface-container-high rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-semibold text-on-primary bg-primary rounded-lg"
            >
              {isEdit ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
