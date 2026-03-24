export default function JobListItem({ job, selected, onSelect, onToggle }) {
  const isRunning = job.status === 'running'

  return (
    <div
      onClick={onSelect}
      className={`flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer ${
        selected
          ? 'bg-white text-blue-700 shadow-sm font-semibold'
          : 'text-slate-500 hover:bg-slate-200/50 transition-colors'
      }`}
    >
      <div className="flex-1 overflow-hidden">
        <div className="truncate">{job.id}</div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        className={`w-8 h-4 rounded-full relative transition-colors ${
          isRunning ? 'bg-primary' : 'bg-slate-300'
        }`}
      >
        <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${
          isRunning ? 'right-0.5' : 'left-0.5'
        }`} />
      </button>
    </div>
  )
}
