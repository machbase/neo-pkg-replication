import Icon from '../common/Icon'

export default function TargetSection({ form, update, servers, inputClass }) {
  return (
    <section className="bg-surface-container-lowest p-6 rounded-xl border border-outline-variant/15">
      <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
        <Icon name="output" className="text-secondary" />
        Target
      </h3>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Server</label>
          <select
            required
            value={form.target.server}
            onChange={e => update('target.server', e.target.value)}
            className={inputClass}
          >
            <option value="">Select server...</option>
            {servers.map(s => <option key={s.name} value={s.name}>{s.name} ({s.host}:{s.port})</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Table</label>
          <input
            type="text"
            value={form.target.table}
            onChange={e => update('target.table', e.target.value)}
            className={inputClass}
            placeholder="Target table name"
          />
        </div>
      </div>
    </section>
  )
}
