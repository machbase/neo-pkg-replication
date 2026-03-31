import Icon from '../common/Icon'

export default function TargetConfigCard({ job }) {
  const tgt = job.target || {}
  const address = tgt.host ? `${tgt.host}:${tgt.port}` : 'N/A'
  const labelClass = 'block text-sm text-on-surface-tertiary mb-1'

  return (
    <section className="bg-surface-alt p-5 rounded-base border border-border relative overflow-hidden">
      <div className="absolute top-0 right-0 w-0.5 h-full bg-primary-light" />
      <div className="flex items-center gap-2 mb-3">
        <Icon name="output" className="text-primary-light " />
        <h3 className="card-title !mb-0">Target</h3>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={labelClass}>Server</label>
          <p className="text-base text-on-surface">{address}</p>
        </div>
        <div>
          <label className={labelClass}>Table</label>
          <p className="text-base text-on-surface">{tgt.table || 'N/A'}</p>
        </div>
        <div>
          <label className={labelClass}>User</label>
          <p className="text-base text-on-surface">{tgt.user || 'N/A'}</p>
        </div>
      </div>
    </section>
  )
}
