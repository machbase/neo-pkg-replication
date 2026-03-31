import Icon from '../common/Icon'

export default function SourceConfigCard({ job }) {
  const src = job.source || {}
  const address = src.host ? `${src.host}:${src.port}` : 'N/A'
  const columns = src.columns || []
  const labelClass = 'block text-sm text-on-surface-tertiary mb-1'

  return (
    <section className="bg-surface-alt p-5 rounded-base border border-border relative overflow-hidden">
      <div className="absolute top-0 left-0 w-0.5 h-full bg-primary" />
      <div className="flex items-center gap-2 mb-3">
        <Icon name="database" className="text-primary " />
        <h3 className="card-title !mb-0">Source</h3>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className={labelClass}>Server</label>
          <p className="text-base text-on-surface">{address}</p>
        </div>
        <div>
          <label className={labelClass}>Table</label>
          <p className="text-base text-on-surface">{src.table || 'N/A'}</p>
        </div>
        <div>
          <label className={labelClass}>User</label>
          <p className="text-base text-on-surface">{src.user || 'N/A'}</p>
        </div>
      </div>
      <div>
        <label className={labelClass}>Columns</label>
        <div className="flex flex-wrap gap-1">
          {columns.length > 0 ? columns.map(name => (
            <span key={name} className="px-2 py-0.5 bg-surface-elevated rounded-sm text-sm text-on-surface-secondary">
              {name}
            </span>
          )) : (
            <span className="text-sm text-on-surface-tertiary">All columns</span>
          )}
        </div>
      </div>
    </section>
  )
}
