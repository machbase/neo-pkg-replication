import { useEffect, useRef } from "react";
import useJobs from "./hooks/useJobs";
import { useApp } from "./context/AppContext";
import Sidebar from "./components/layout/Sidebar";

const CHANNEL_NAME = "app:neo-replication";

export default function SideApp() {
    const { jobs, toggleJob, installJob, refreshJobs } = useJobs();
    const { selectedJobId, setSelectedJobId } = useApp();
    const channelRef = useRef(null);

    useEffect(() => {
        const ch = new BroadcastChannel(CHANNEL_NAME);
        channelRef.current = ch;
        return () => ch.close();
    }, []);

    const send = (type, payload) => {
        channelRef.current?.postMessage({ type, payload });
    };

    return (
        <Sidebar
            jobs={jobs}
            selectedJobId={selectedJobId}
            onSelectJob={(jobId) => {
                setSelectedJobId(jobId);
                send("selectJob", { jobId });
            }}
            onNewJob={() => {
                setSelectedJobId(null);
                send("navigate", { path: "/jobs/new" });
            }}
            onToggleJob={toggleJob}
            onInstallJob={installJob}
            onRefresh={refreshJobs}
            onServerSettings={() => send("openServerSettings", {})}
        />
    );
}
