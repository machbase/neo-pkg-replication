import { useNavigate, useLocation } from "react-router";
import { useApp } from "../../context/AppContext";
import Icon from "../common/Icon";
import JobListItem from "../jobs/JobListItem";

export default function Sidebar({ jobs, onToggleJob }) {
    const navigate = useNavigate();
    const location = useLocation();
    const { selectedJobId, setSelectedJobId } = useApp();

    return (
        <aside className="side w-full shrink-0 lg:fixed lg:left-0 lg:top-0 lg:w-64 lg:h-screen z-40 border-b lg:border-b-0 lg:border-r border-border">
            <div className="side-header">
                <Icon name="rebase_edit" className="text-primary shrink-0" />
                <span className="truncate flex-1">Replication</span>
                <button
                    onClick={() => navigate("/jobs/new")}
                    className="btn btn-primary shrink-0 truncate"
                >
                    <Icon name="add" className="icon-sm" />
                    <span>New Job</span>
                </button>
            </div>

            <div className="side-body">
                <div className="side-section-title">Jobs</div>
                {/* Desktop: vertical list, Mobile: horizontal scroll */}
                <nav className="flex lg:flex-col flex-row overflow-x-auto lg:overflow-x-hidden lg:overflow-y-auto flex-1 px-3 py-1.5 gap-1">
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
                        />
                    ))}
                    {jobs.length === 0 && <p className="px-2 py-3 text-on-surface-disabled text-sm whitespace-nowrap">No jobs</p>}
                </nav>
            </div>
        </aside>
    );
}
