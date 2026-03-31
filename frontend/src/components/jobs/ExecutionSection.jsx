import Icon from '../common/Icon'

export default function ExecutionSection({ form, update, inputClass }) {
  const labelClass = 'block text-on-surface-secondary mb-2'

  return (
    <section className="bg-surface-alt p-5 rounded-base border border-border">
      <h3 className="card-title">
        <Icon name="tune" className="text-on-surface-tertiary " />
        Execution Settings
      </h3>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={labelClass}>Start Mode</label>
          <select value={form.startMode} onChange={e => update('startMode', e.target.value)} className={inputClass}>
            <option value="full">Full (from RID 0)</option>
            <option value="now">Now (latest RID)</option>
            <option value="ridAfter">RID After</option>
          </select>
        </div>
        {form.startMode === 'ridAfter' && (
          <div>
            <label className={labelClass}>RID After</label>
            <input type="text" value={form.ridAfter || ''} onChange={e => update('ridAfter', e.target.value)} className={inputClass} placeholder="RID value" />
          </div>
        )}
        <div>
          <label className={labelClass}>Query Limit</label>
          <input type="number" value={form.queryLimit} onChange={e => update('queryLimit', e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Poll Interval (ms)</label>
          <input type="number" value={form.pollIntervalMs} onChange={e => update('pollIntervalMs', e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>RID Range Size</label>
          <input type="number" value={form.ridRangeSize} onChange={e => update('ridRangeSize', e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>On Save Failure</label>
          <select value={form.onSaveFailure} onChange={e => update('onSaveFailure', e.target.value)} className={inputClass}>
            <option value="continue">Continue</option>
            <option value="abort">Abort</option>
          </select>
        </div>
      </div>
    </section>
  )
}
