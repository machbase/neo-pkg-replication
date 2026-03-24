export default function AdvancedSection({ form, update, inputClass }) {
  const labelClass = 'block text-[10px] uppercase font-bold text-on-surface-variant mb-2 tracking-widest'

  return (
    <details className="group">
      <summary className="cursor-pointer text-sm font-semibold text-on-surface-variant hover:text-on-surface transition-colors select-none flex items-center gap-2">
        <span className="transition-transform group-open:rotate-90">&#9654;</span>
        Advanced Settings
      </summary>
      <section className="bg-surface-container-lowest p-6 rounded-xl border border-outline-variant/15 mt-4">
        <div className="grid grid-cols-3 gap-6">
          <div>
            <label className={labelClass}>Shutdown Timeout (ms)</label>
            <input
              type="number"
              value={form.shutdownTimeoutMs}
              onChange={e => update('shutdownTimeoutMs', e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="flex items-end pb-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.integrity?.enabled ?? true}
                onChange={e => update('integrity.enabled', e.target.checked)}
                className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary/30"
              />
              <span className="text-sm font-medium text-on-surface">Integrity Check</span>
            </label>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-6 mt-6">
          <div>
            <label className={labelClass}>Retry Max Attempts</label>
            <input
              type="number"
              value={form.retry?.maxAttempts ?? 5}
              onChange={e => update('retry.maxAttempts', e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Retry Base Delay (ms)</label>
            <input
              type="number"
              value={form.retry?.baseDelayMs ?? 100}
              onChange={e => update('retry.baseDelayMs', e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Retry Max Delay (ms)</label>
            <input
              type="number"
              value={form.retry?.maxDelayMs ?? 30000}
              onChange={e => update('retry.maxDelayMs', e.target.value)}
              className={inputClass}
            />
          </div>
        </div>
      </section>
    </details>
  )
}
