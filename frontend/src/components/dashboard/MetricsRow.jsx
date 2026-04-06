import Icon from '../common/Icon'

const metrics = [
  { label: 'Throughput', value: 'N/A', icon: 'speed' },
  { label: 'Latency', value: 'N/A', icon: 'timer' },
  { label: 'Rows Processed', value: 'N/A', icon: 'reorder' },
]

export default function MetricsRow() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-16">
      {metrics.map(m => (
        <div key={m.label} className="bg-surface-alt p-16 rounded-base border border-border flex items-center justify-between">
          <div>
            <p className="text-xs uppercase font-bold text-on-surface-tertiary mb-4">{m.label}</p>
            <h4 className="text-lg font-bold text-on-surface">{m.value}</h4>
          </div>
          <Icon name={m.icon} className="text-primary text-lg opacity-40" />
        </div>
      ))}
    </div>
  )
}
