export default function ExecutionSection({ form, update }) {
    return (
        <div className="form-card">
            <div className="form-card-header">Execution Settings</div>

            <div className="space-y-16">
                {/* Row 1: Start Mode, On Save Failure */}
                <div className="grid grid-cols-2 gap-16">
                    <div>
                        <label className="form-label">Start Mode</label>
                        <select value={form.startMode} onChange={(e) => update("startMode", e.target.value)} className="w-full">
                            <option value="full">Full (from RID 0)</option>
                            <option value="now">Now (latest)</option>
                            {/* <option value="ridAfter">RID After</option> */}
                        </select>
                    </div>
                    <div>
                        <label className="form-label">On Save Failure</label>
                        <select value={form.onSaveFailure} onChange={(e) => update("onSaveFailure", e.target.value)} className="w-full">
                            <option value="continue">Continue</option>
                            <option value="abort">Abort</option>
                        </select>
                    </div>
                </div>

                {/* Row 2: Query Limit, Poll Interval */}
                <div className="grid grid-cols-2 gap-16">
                    <div>
                        <label className="form-label">Query Limit</label>
                        <input type="number" value={form.queryLimit} onChange={(e) => update("queryLimit", e.target.value)} className="w-full" />
                    </div>
                    <div>
                        <label className="form-label">Poll Interval (ms)</label>
                        <input type="number" value={form.pollIntervalMs} onChange={(e) => update("pollIntervalMs", e.target.value)} className="w-full" />
                    </div>
                </div>
            </div>
        </div>
    );
}
