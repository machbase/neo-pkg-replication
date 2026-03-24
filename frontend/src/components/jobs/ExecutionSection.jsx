import Icon from '../common/Icon'

export default function ExecutionSection({ form, update, inputClass }) {
  return (
    <section className="bg-surface-container-lowest p-6 rounded-xl border border-outline-variant/15">
      <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
        <Icon name="tune" className="text-on-surface-variant" />
        Execution Settings
      </h3>
      <div className="grid grid-cols-3 gap-6">
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Start Mode</label>
          <select
            value={form.startMode}
            onChange={e => update('startMode', e.target.value)}
            className={inputClass}
          >
            <option value="full">Full (from RID 0)</option>
            <option value="now">Now (latest RID)</option>
            <option value="ridAfter">RID After</option>
          </select>
        </div>
        {form.startMode === 'ridAfter' && (
          <div>
            <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">RID After</label>
            <input
              type="text"
              value={form.ridAfter || ''}
              onChange={e => update('ridAfter', e.target.value)}
              className={inputClass}
              placeholder="RID value"
            />
          </div>
        )}
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Query Limit</label>
          <input
            type="number"
            value={form.queryLimit}
            onChange={e => update('queryLimit', e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Poll Interval (ms)</label>
          <input
            type="number"
            value={form.pollIntervalMs}
            onChange={e => update('pollIntervalMs', e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">RID Range Size</label>
          <input
            type="number"
            value={form.ridRangeSize}
            onChange={e => update('ridRangeSize', e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">On Save Failure</label>
          <select
            value={form.onSaveFailure}
            onChange={e => update('onSaveFailure', e.target.value)}
            className={inputClass}
          >
            <option value="continue">Continue</option>
            <option value="abort">Abort</option>
          </select>
        </div>
      </div>
    </section>
  )
}
