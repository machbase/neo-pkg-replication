import Icon from '../common/Icon'

export default function ExecutionSection({ form, update }) {
  return (
    <div className="form-card">
      <div className="form-card-header">
        <Icon name="tune" className="text-primary" />
        Execution Settings
      </div>

      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="form-label">Start Mode</label>
            <select value={form.startMode} onChange={e => update('startMode', e.target.value)} className="w-full">
              <option value="full">Full (from RID 0)</option>
              <option value="now">Now (latest RID)</option>
              <option value="ridAfter">RID After</option>
            </select>
          </div>
          {form.startMode === 'ridAfter' && (
            <div>
              <label className="form-label">RID After</label>
              <input type="text" value={form.ridAfter || ''} onChange={e => update('ridAfter', e.target.value)} className="w-full" placeholder="RID value" />
            </div>
          )}
          <div>
            <label className="form-label">On Save Failure</label>
            <select value={form.onSaveFailure} onChange={e => update('onSaveFailure', e.target.value)} className="w-full">
              <option value="continue">Continue</option>
              <option value="abort">Abort</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="form-label">Query Limit</label>
            <input type="number" value={form.queryLimit} onChange={e => update('queryLimit', e.target.value)} className="w-full" />
          </div>
          <div>
            <label className="form-label">Poll Interval (ms)</label>
            <input type="number" value={form.pollIntervalMs} onChange={e => update('pollIntervalMs', e.target.value)} className="w-full" />
          </div>
          <div>
            <label className="form-label">RID Range Size</label>
            <input type="number" value={form.ridRangeSize} onChange={e => update('ridRangeSize', e.target.value)} className="w-full" />
          </div>
        </div>
      </div>
    </div>
  )
}
