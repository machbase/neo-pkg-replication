export default function AdvancedSection({ form, update }) {
  return (
    <div className="form-card">
      <div className="form-card-header">Advanced Settings</div>

      <div className="space-y-16">
        {/* Integrity Check */}
        <div className="flex items-end pb-8">
          <label className="flex items-center gap-8 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.integrity !== false}
              onChange={(e) => update('integrity', e.target.checked)}
              className="form-checkbox"
            />
            <span className="form-label !mb-0">Integrity Check</span>
          </label>
        </div>

        {/* Retry settings */}
        <div className="grid grid-cols-3 gap-16">
          <div>
            <label className="form-label">Retry Max Attempts</label>
            <input
              type="number"
              value={form.retry?.maxAttempts ?? 5}
              onChange={(e) => update('retry.maxAttempts', e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <label className="form-label">Retry Base Delay (ms)</label>
            <input
              type="number"
              value={form.retry?.baseDelayMs ?? 100}
              onChange={(e) => update('retry.baseDelayMs', e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <label className="form-label">Retry Max Delay (ms)</label>
            <input
              type="number"
              value={form.retry?.maxDelayMs ?? 30000}
              onChange={(e) => update('retry.maxDelayMs', e.target.value)}
              className="w-full"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
