import Icon from '../common/Icon'

export default function TargetSection({ form, update }) {
  return (
    <div className="form-card">
      <div className="form-card-header">
        <Icon name="output" className="text-primary" />
        Target Database
      </div>

      <div className="space-y-6">
        <div>
          <label className="form-label">Host Address</label>
          <input type="text" required value={form.target.host} onChange={e => update('target.host', e.target.value)} className="w-full" placeholder="127.0.0.1" />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="form-label">Port</label>
            <input type="number" required value={form.target.port} onChange={e => update('target.port', e.target.value)} className="w-full" />
          </div>
          <div>
            <label className="form-label">Table</label>
            <input type="text" value={form.target.table} onChange={e => update('target.table', e.target.value)} className="w-full" placeholder="Target table name" />
          </div>
          <div>
            <label className="form-label">User</label>
            <input type="text" required value={form.target.user} onChange={e => update('target.user', e.target.value)} className="w-full" />
          </div>
        </div>

        <div>
          <label className="form-label">Password</label>
          <input type="password" required value={form.target.password} onChange={e => update('target.password', e.target.value)} className="w-full" />
        </div>
      </div>
    </div>
  )
}
