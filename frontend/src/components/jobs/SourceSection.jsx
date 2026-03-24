import Icon from '../common/Icon'

export default function SourceSection({ form, update, servers, srcTables, srcColumns, inputClass }) {
  // Column selection: null = all, array = specific columns
  const selectedColumns = form.source.columns || []
  const isAllSelected = !form.source.columns

  const addColumn = (colName) => {
    if (isAllSelected) {
      // all -> first pick: select only that column
      update('source.columns', [colName])
    } else {
      const cols = [...selectedColumns, colName]
      update('source.columns', cols)
    }
  }

  const removeColumn = (colName) => {
    const cols = selectedColumns.filter(c => c !== colName)
    update('source.columns', cols.length ? cols : null)
  }

  return (
    <section className="bg-surface-container-lowest p-6 rounded-xl border border-outline-variant/15">
      <h3 className="text-lg font-bold mb-6 flex items-center gap-2">
        <Icon name="database" className="text-primary" />
        Source
      </h3>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Server</label>
          <select
            required
            value={form.source.server}
            onChange={e => { update('source.server', e.target.value); update('source.table', ''); update('source.columns', null) }}
            className={inputClass}
          >
            <option value="">Select server...</option>
            {servers.map(s => <option key={s.name} value={s.name}>{s.name} ({s.host}:{s.port})</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Table</label>
          <select
            required
            value={form.source.table}
            onChange={e => { update('source.table', e.target.value); update('source.columns', null) }}
            className={inputClass}
          >
            <option value="">Select table...</option>
            {srcTables.map(t => <option key={t.name} value={t.name}>{t.name} ({t.type})</option>)}
          </select>
        </div>
      </div>

      {/* Columns -- select dropdown + tags */}
      <div className="mt-6">
        <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Columns</label>
        <select
          value=""
          disabled={form.target.autoCreate}
          onChange={e => { if (e.target.value) addColumn(e.target.value) }}
          className={`${inputClass} disabled:opacity-50`}
        >
          <option value="">Select column</option>
          {srcColumns
            .filter(col => !selectedColumns.includes(col.name))
            .map(col => (
              <option key={col.name} value={col.name}>{col.name} ({col.type})</option>
            ))}
        </select>
        {!form.target.autoCreate && !isAllSelected && selectedColumns.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {selectedColumns.map(name => (
              <span key={name} className="inline-flex items-center gap-1 px-3 py-1 bg-primary-fixed/10 border border-primary/30 rounded text-sm font-medium text-on-surface">
                {name}
                <button type="button" onClick={() => removeColumn(name)} className="hover:text-error">
                  <Icon name="close" className="text-xs" />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => update('source.columns', null)}
              className="px-3 py-1 text-sm text-on-surface-variant hover:text-primary transition-colors"
            >
              Reset all
            </button>
          </div>
        )}
      </div>

      {/* Auto Create — 체크 시 전체 컬럼 복제, 컬럼 선택 비활성화 */}
      <div className="mt-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={form.target.autoCreate || false}
            onChange={e => {
              update('target.autoCreate', e.target.checked)
              if (e.target.checked) update('source.columns', null)
            }}
            className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary/30"
          />
          <span className="text-sm font-medium text-on-surface">Auto Create</span>
        </label>
      </div>

      {/* Tag Identifier */}
      <div className="mt-6 grid grid-cols-2 gap-6">
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Tag Identifier Mode</label>
          <select
            value={form.source.tagIdentifier?.mode || 'none'}
            onChange={e => update('source.tagIdentifier', { ...form.source.tagIdentifier, mode: e.target.value })}
            className={inputClass}
          >
            <option value="none">None</option>
            <option value="prefix">Prefix</option>
            <option value="suffix">Suffix</option>
          </select>
        </div>
        {form.source.tagIdentifier?.mode !== 'none' && (
          <div>
            <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest">Tag Identifier Value</label>
            <input
              type="text"
              value={form.source.tagIdentifier?.value || ''}
              onChange={e => update('source.tagIdentifier', { ...form.source.tagIdentifier, value: e.target.value })}
              className={inputClass}
              placeholder="e.g., site1/"
            />
          </div>
        )}
      </div>
    </section>
  )
}
