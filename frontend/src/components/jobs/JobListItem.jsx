export default function JobListItem({ job, selected, onSelect, onToggle }) {
    const isRunning = job.status === "running";

    return (
        <div
            onClick={onSelect}
            className={`side-item shrink-0 ${selected ? "active" : ""}`}
        >
            <span className="lg:flex-1 truncate min-w-0">{job.id}</span>
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    onToggle();
                }}
                className={`switch shrink-0 ml-2 ${isRunning ? "active" : ""}`}
            >
                <div className="switch-thumb" />
            </button>
        </div>
    );
}
