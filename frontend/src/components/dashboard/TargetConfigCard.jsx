import Icon from '../common/Icon'

export default function TargetConfigCard({ job, servers }) {
  const server = servers.find(s => s.name === job.target?.server)
  const address = server ? `${server.host}:${server.port}` : job.target?.server || 'N/A'

  return (
    <section className="bg-surface-container-lowest p-8 rounded-xl shadow-sm border border-outline-variant/15 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-1 h-full bg-secondary" />
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-secondary-container/10 flex items-center justify-center text-secondary">
          <Icon name="output" />
        </div>
        <h3 className="text-xl font-bold tracking-tight">Target</h3>
      </div>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-1 tracking-widest">Server</label>
          <p className="text-base font-medium text-on-surface">{address}</p>
        </div>
        <div>
          <label className="block text-[10px] uppercase font-bold text-on-surface-variant mb-1 tracking-widest">Table</label>
          <p className="text-base font-medium text-on-surface">{job.target?.table || 'N/A'}</p>
        </div>
      </div>
    </section>
  )
}
