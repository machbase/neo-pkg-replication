import { useState, useEffect, useRef } from "react";
import Icon from "./components/common/Icon";

const CHANNEL_NAME = "app:neo-replication";

export default function SideApp() {
    const [ready, setReady] = useState(false);
    const [jobs, setJobs] = useState([]);
    const [selectedJobId, setSelectedJobId] = useState(null);
    const channelRef = useRef(null);

    useEffect(() => {
        const ch = new BroadcastChannel(CHANNEL_NAME);
        channelRef.current = ch;

        ch.onmessage = (e) => {
            const msg = e.data;
            if (!msg || !msg.type) return;
            switch (msg.type) {
                case "ready":
                    setReady(true);
                    break;
                case "jobsData":
                    setJobs(msg.payload.jobs);
                    break;
                case "jobSelected":
                    setSelectedJobId(msg.payload.jobId);
                    break;
            }
        };

        ch.postMessage({ type: "requestReady" });
        return () => ch.close();
    }, []);

    const send = (type, payload) => {
        channelRef.current?.postMessage({ type, payload });
    };

    if (!ready) {
        return (
            <div className="side h-screen opacity-50">
                <div className="side-header">
                    <Icon name="rebase_edit" className="text-primary shrink-0" />
                    <span>Replication</span>
                </div>
                <p className="px-4 py-3 text-sm text-on-surface-disabled">Loading...</p>
            </div>
        );
    }

    return (
        <div className="side h-screen">
            <div className="side-header">
                <Icon name="rebase_edit" className="text-primary shrink-0" />
                <span className="truncate flex-1">Replication</span>
                <button
                    onClick={() => send("navigate", { path: "/jobs/new" })}
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
                        <div
                            key={job.id}
                            onClick={() => send("selectJob", { jobId: job.id })}
                            className={`side-item ${selectedJobId === job.id ? "active" : ""}`}
                        >
                            <span className="flex-1 truncate min-w-0">{job.id}</span>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    send("toggleJob", { jobId: job.id });
                                }}
                                className={`switch shrink-0 ml-1 ${job.status === "running" ? "active" : ""}`}
                            >
                                <div className="switch-thumb" />
                            </button>
                        </div>
                    ))}
                    {jobs.length === 0 && <p className="px-2 py-3 text-sm text-on-surface-disabled">No jobs</p>}
                </nav>
            </div>
        </div>
    );
}
