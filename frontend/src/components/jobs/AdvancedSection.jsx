import Icon from '../common/Icon'

export default function AdvancedSection({ form, update }) {
  const showFileDir = form.logging?.file?.enabled

  return (
    <div className="form-card">
      <div className="form-card-header">
        <Icon name="settings" className="text-primary" />
        Advanced Settings
      </div>

      <div className="space-y-6">
        {/* Shutdown & Integrity */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="form-label">Shutdown Timeout (ms)</label>
            <input type="number" value={form.shutdownTimeoutMs} onChange={e => update('shutdownTimeoutMs', e.target.value)} className="w-full" />
          </div>
          <div className="flex items-end pb-1">
            <label className="checkbox-label">
              <input type="checkbox" checked={form.integrity !== false} onChange={e => update('integrity', e.target.checked ? null : false)} />
              <span>Integrity Check</span>
            </label>
          </div>
        </div>

        {/* Retry */}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="form-label">Retry Max Attempts</label>
            <input type="number" value={form.retry?.maxAttempts ?? 5} onChange={e => update('retry.maxAttempts', e.target.value)} className="w-full" />
          </div>
          <div>
            <label className="form-label">Retry Base Delay (ms)</label>
            <input type="number" value={form.retry?.baseDelayMs ?? 100} onChange={e => update('retry.baseDelayMs', e.target.value)} className="w-full" />
          </div>
          <div>
            <label className="form-label">Retry Max Delay (ms)</label>
            <input type="number" value={form.retry?.maxDelayMs ?? 30000} onChange={e => update('retry.maxDelayMs', e.target.value)} className="w-full" />
          </div>
        </div>

        {/* Logging */}
        <div className="space-y-4 pt-3 border-t border-border">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="form-label">Log Level</label>
              <select value={form.logging?.level ?? 'info'} onChange={e => update('logging.level', e.target.value)} className="w-full">
                <option value="trace">Trace</option>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div className="flex items-end pb-1">
              <label className="checkbox-label">
                <input type="checkbox" checked={form.logging?.stdout ?? true} onChange={e => update('logging.stdout', e.target.checked)} />
                <span>Stdout</span>
              </label>
            </div>
            <div className="flex items-end pb-1">
              <label className="checkbox-label">
                <input type="checkbox" checked={form.logging?.file?.enabled ?? false} onChange={e => update('logging.file.enabled', e.target.checked)} />
                <span>File Output</span>
              </label>
            </div>
          </div>
          {showFileDir && (
            <div>
              <label className="form-label">Log Directory</label>
              <input type="text" value={form.logging?.file?.directory ?? '/work/logs'} onChange={e => update('logging.file.directory', e.target.value)} className="w-full" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
