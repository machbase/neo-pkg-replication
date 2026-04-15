import Icon from "../common/Icon";
import JobListItem from "../jobs/JobListItem";

export default function Sidebar({ jobs, selectedJobId, onSelectJob, onNewJob, onToggleJob, onInstallJob, onRefresh, onServerSettings, className = "side h-screen" }) {
    return (
        <aside className={className}>
            <div className="side-header">
                <Icon name="rebase_edit" className="text-primary shrink-0" />
                <span className="truncate flex-1">Replication</span>
                <button
                    onClick={onNewJob}
                    className="side-header-action tooltip"
                    data-tooltip="New Job"
                >
                    <Icon name="add" />
                </button>
                <button
                    onClick={onServerSettings}
                    className="side-header-action tooltip"
                    data-tooltip="Server Settings"
                >
                    <Icon name="dns" />
                </button>
            </div>

            <div className="side-body">
                <div className="side-section-title">
                    <span className="flex-1">Jobs</span>
                    <button
                        onClick={onRefresh}
                        className="side-section-action tooltip"
                        data-tooltip="Refresh"
                    >
                        <Icon name="refresh" />
                    </button>
                </div>
                <nav className="side-list">
                    {jobs.map((job) => (
                        <JobListItem
                            key={job.id}
                            job={job}
                            selected={selectedJobId === job.id}
                            onSelect={() => onSelectJob(job.id)}
                            onToggle={() => onToggleJob(job)}
                            onInstall={() => onInstallJob(job)}
                        />
                    ))}
                    {jobs.length === 0 && <p className="side-empty">No jobs</p>}
                </nav>
            </div>
        </aside>
    );
}
