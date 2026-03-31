export default function AdvancedSection({ form, update, inputClass }) {
  const labelClass = 'block text-on-surface-secondary mb-2'
  const checkboxClass = ''

  return (
    <details className="group">
      <summary className="cursor-pointer text-base font-semibold text-on-surface-tertiary hover:text-on-surface transition-colors select-none flex items-center gap-2">
        <svg className="w-3.5 h-3.5 transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 16 16" fill="currentColor"><path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06L9.44 8 6.22 4.78a.75.75 0 0 1 0-1.06z"/></svg>
        Advanced Settings
      </summary>
      <section className="bg-surface-alt p-5 rounded-base border border-border mt-2 space-y-3">
        {/* Shutdown & Integrity */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Shutdown Timeout (ms)</label>
            <input type="number" value={form.shutdownTimeoutMs} onChange={e => update('shutdownTimeoutMs', e.target.value)} className={inputClass} />
          </div>
          <div className="flex items-end pb-1">
            <label className="checkbox-label">
              <input type="checkbox" checked={form.integrity !== false} onChange={e => update('integrity', e.target.checked ? null : false)} />
              <span>Integrity Check</span>
            </label>
          </div>
        </div>

        {/* Retry */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Retry Max Attempts</label>
            <input type="number" value={form.retry?.maxAttempts ?? 5} onChange={e => update('retry.maxAttempts', e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Retry Base Delay (ms)</label>
            <input type="number" value={form.retry?.baseDelayMs ?? 100} onChange={e => update('retry.baseDelayMs', e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Retry Max Delay (ms)</label>
            <input type="number" value={form.retry?.maxDelayMs ?? 30000} onChange={e => update('retry.maxDelayMs', e.target.value)} className={inputClass} />
          </div>
        </div>

        {/* Logging */}
        <div>
          <h4 className="section-title mb-2">Logging</h4>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelClass}>Level</label>
              <select value={form.logging?.level ?? 'info'} onChange={e => update('logging.level', e.target.value)} className={inputClass}>
                <option value="trace">Trace</option>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.logging?.stdout ?? true} onChange={e => update('logging.stdout', e.target.checked)} className={checkboxClass} />
                <span className="text-on-surface">Stdout</span>
              </label>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.logging?.file?.enabled ?? false} onChange={e => update('logging.file.enabled', e.target.checked)} className={checkboxClass} />
                <span className="text-on-surface">File Output</span>
              </label>
            </div>
          </div>
          {form.logging?.file?.enabled && (
            <div className="mt-2">
              <label className={labelClass}>Log Directory</label>
              <input type="text" value={form.logging?.file?.directory ?? '/work/logs'} onChange={e => update('logging.file.directory', e.target.value)} className={inputClass} />
            </div>
          )}
        </div>
      </section>
    </details>
  )
}
