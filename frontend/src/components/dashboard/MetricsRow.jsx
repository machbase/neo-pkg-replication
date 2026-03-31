import Icon from '../common/Icon'

const metrics = [
  { label: 'Throughput', value: 'N/A', icon: 'speed' },
  { label: 'Latency', value: 'N/A', icon: 'timer' },
  { label: 'Rows Processed', value: 'N/A', icon: 'reorder' },
]

export default function MetricsRow() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {metrics.map(m => (
        <div key={m.label} className="bg-white/60 backdrop-blur-md p-6 rounded-xl border border-white flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase font-bold text-on-surface-variant mb-1">{m.label}</p>
            <h4 className="text-2xl font-bold">{m.value}</h4>
          </div>
          <Icon name={m.icon} className="text-primary/40 text-4xl" />
        </div>
      ))}
    </div>
  )
}
