import Icon from "../common/Icon";

export default function JobListItem({ job, selected, onSelect, onToggle, onInstall }) {
    const isRunning = job.status === "running";

    return (
        <div
            onClick={onSelect}
            className={`side-item shrink-0 ${selected ? "active" : ""}`}
        >
            <span className="lg:flex-1 truncate min-w-0">{job.id}</span>
            {job.installed === false ? (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onInstall();
                    }}
                    className="btn-icon-sm shrink-0 ml-4 tooltip"
                    data-tooltip="Install"
                >
                    <Icon name="download" className="icon-sm" />
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
