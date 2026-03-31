import { useState } from 'react'
import Icon from '../common/Icon'

export default function SourceSection({ form, update }) {
  const [columnInput, setColumnInput] = useState('')
  const selectedColumns = form.source.columns || []
  const isAllSelected = !form.source.columns

  const addColumn = () => {
    const name = columnInput.trim().toUpperCase()
    if (!name) return
    if (!isAllSelected && selectedColumns.includes(name)) return
    if (isAllSelected) {
      update('source.columns', [name])
    } else {
      update('source.columns', [...selectedColumns, name])
    }
    setColumnInput('')
  }

  const removeColumn = (colName) => {
    const cols = selectedColumns.filter(c => c !== colName)
    update('source.columns', cols.length ? cols : null)
  }

  return (
    <div className="form-card">
      <div className="form-card-header">
        <Icon name="database" className="text-primary" />
        Source Database
      </div>

      <div className="space-y-6">
        {/* Connection */}
        <div>
          <label className="form-label">Host Address</label>
          <input type="text" required value={form.source.host} onChange={e => update('source.host', e.target.value)} className="w-full" placeholder="127.0.0.1" />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="form-label">Port</label>
            <input type="number" required value={form.source.port} onChange={e => update('source.port', e.target.value)} className="w-full" />
          </div>
          <div>
            <label className="form-label">Table</label>
            <input type="text" required value={form.source.table} onChange={e => update('source.table', e.target.value)} className="w-full" placeholder="TAG" />
          </div>
          <div>
            <label className="form-label">User</label>
            <input type="text" required value={form.source.user} onChange={e => update('source.user', e.target.value)} className="w-full" />
          </div>
        </div>

        <div>
          <label className="form-label">Password</label>
          <input type="password" required value={form.source.password} onChange={e => update('source.password', e.target.value)} className="w-full" />
        </div>

        {/* Columns */}
        <div>
          <label className="form-label">Columns (empty = all)</label>
          <div className="flex gap-2">
            <input
              type="text" value={columnInput} disabled={form.target.autoCreate}
              onChange={e => setColumnInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addColumn() } }}
              className="w-full disabled:opacity-50"
              placeholder="Type column name and press Enter"
            />
            <button type="button" disabled={form.target.autoCreate} onClick={addColumn}
              className="btn btn-content btn-ghost border border-border text-primary-light disabled:opacity-50">
              Add
            </button>
          </div>
          {!form.target.autoCreate && !isAllSelected && selectedColumns.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {selectedColumns.map(name => (
                <span key={name} className="badge gap-1">
                  {name}
                  <button type="button" onClick={() => removeColumn(name)} className="hover:text-error">
                    <Icon name="close" className="icon-sm" />
                  </button>
                </span>
              ))}
              <button type="button" onClick={() => update('source.columns', null)}
                className="btn btn-ghost btn-sm">
                Reset all
              </button>
            </div>
          )}
        </div>

        {/* Auto Create */}
        <label className="checkbox-label">
          <input type="checkbox" checked={form.target.autoCreate || false}
            onChange={e => { update('target.autoCreate', e.target.checked); if (e.target.checked) update('source.columns', null) }}
          />
          Auto Create Target Table
        </label>
      </div>
    </div>
  )
}
