import Icon from '../common/Icon'

export default function TargetSection({ form, update, inputClass }) {
  const labelClass = 'block text-on-surface-secondary mb-2'

  return (
    <section className="bg-surface-alt p-5 rounded-base border border-border">
      <h3 className="card-title">
        <Icon name="output" className="text-primary-light " />
        Target
      </h3>
      <div className="grid grid-cols-4 gap-3 mb-3">
        <div className="col-span-2">
          <label className={labelClass}>Host</label>
          <input type="text" required value={form.target.host} onChange={e => update('target.host', e.target.value)} className={inputClass} placeholder="127.0.0.1" />
        </div>
        <div>
          <label className={labelClass}>Port</label>
          <input type="number" required value={form.target.port} onChange={e => update('target.port', e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Table</label>
          <input type="text" value={form.target.table} onChange={e => update('target.table', e.target.value)} className={inputClass} placeholder="Target table name" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>User</label>
          <input type="text" required value={form.target.user} onChange={e => update('target.user', e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Password</label>
          <input type="password" required value={form.target.password} onChange={e => update('target.password', e.target.value)} className={inputClass} />
        </div>
      </div>
    </section>
  )
}
