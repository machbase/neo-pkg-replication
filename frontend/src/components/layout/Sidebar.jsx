import { useNavigate, useLocation } from "react-router";
import { useApp } from "../../context/AppContext";
import Icon from "../common/Icon";
import JobListItem from "../jobs/JobListItem";

export default function Sidebar({ jobs, onToggleJob }) {
    const navigate = useNavigate();
    const location = useLocation();
    const { selectedJobId, setSelectedJobId } = useApp();

    return (
        <aside className="side fixed left-0 top-0 w-52 z-40 border-r border-border">
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
                <nav className="flex-1 overflow-y-auto px-3 py-1.5">
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
                    {jobs.length === 0 && <p className="px-2 py-3 text-on-surface-disabled text-sm">No jobs</p>}
                </nav>
            </div>
        </aside>
    );
}
