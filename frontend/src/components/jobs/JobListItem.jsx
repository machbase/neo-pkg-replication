export default function JobListItem({ job, selected, onSelect, onToggle }) {
    const isRunning = job.status === "running";

    return (
        <div
            onClick={onSelect}
            className={`side-item ${selected ? "active" : ""}`}
        >
            <span className="flex-1 truncate min-w-0">{job.id}</span>
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    onToggle();
                }}
                className={`switch shrink-0 ml-1 ${isRunning ? "active" : ""}`}
            >
                <div className="switch-thumb" />
            </button>
        </div>
    );
}
