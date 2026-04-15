import Icon from "../common/Icon";

export default function JobListItem({ job, selected, onSelect, onToggle, onInstall }) {
    const isRunning = job.status === "running";

    return (
        <div
            onClick={onSelect}
            className={`side-item ${selected ? "active" : ""}`}
        >
            <span className="flex-1 min-w-0 truncate">{job.id}</span>
            {job.installed === false ? (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onInstall();
                    }}
                    className="btn-icon-sm shrink-0 ml-4 tooltip"
                    data-tooltip="Register"
                >
                    <Icon name="app_registration" className="icon-sm" />
                </button>
            ) : (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggle();
                    }}
                    className={`switch shrink-0 ml-4 ${isRunning ? "active" : ""}`}
                >
                    <div className="switch-thumb" />
                </button>
            )}
        </div>
    );
}
