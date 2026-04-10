import { useNavigate, useLocation } from "react-router";
import { useApp } from "../../context/AppContext";
import Icon from "../common/Icon";
import JobListItem from "../jobs/JobListItem";

export default function Sidebar({ jobs, onToggleJob, onInstallJob, onRefresh }) {
    const navigate = useNavigate();
    const location = useLocation();
    const { selectedJobId, setSelectedJobId } = useApp();

    return (
        <aside className="side w-full shrink-0 lg:fixed lg:left-0 lg:top-0 lg:w-64 lg:h-screen z-dropdown border-b lg:border-b-0 lg:border-r border-border">
            <div className="side-header">
                <Icon name="rebase_edit" className="text-primary shrink-0" />
                <span className="truncate flex-1">Replication</span>
                <button
                    onClick={() => { navigate("/jobs/new"); setSelectedJobId(null); }}
                    className="side-header-action tooltip"
                    data-tooltip="New Job"
                >
                    <Icon name="add" />
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
                {/* Desktop: vertical list, Mobile: horizontal scroll */}
                <nav className="side-list lg:flex-col flex-row overflow-x-auto lg:overflow-x-hidden">
                    {jobs.map((job) => (
                        <JobListItem
                            key={job.id}
                            job={job}
                            selected={selectedJobId === job.id}
                            onSelect={() => {
                                setSelectedJobId(job.id);
                                if (location.pathname !== "/") navigate("/");
                            }}
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
