export default function StatusBadge({ status }) {
  const isRunning = status === 'running'
  return (
    <span className={`px-2 py-0.5 text-[10px] font-bold rounded uppercase tracking-wider ${
      isRunning
        ? 'bg-green-100 text-green-700'
        : 'bg-slate-100 text-slate-500'
    }`}>
      {isRunning ? 'Live Sync' : 'Stopped'}
    </span>
  )
}
