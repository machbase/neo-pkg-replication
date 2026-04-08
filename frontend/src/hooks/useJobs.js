import { useState, useEffect, useCallback, useRef } from "react";
import * as jobsApi from "../api/jobs";
import { useApp } from "../context/AppContext";

const AUTO_REFRESH = false;

export default function useJobs() {
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);
    const { notify, setSelectedJobId } = useApp();
    const intervalRef = useRef(null);
    const lastErrorRef = useRef(null);
    const initialSelectedRef = useRef(false);

    const fetchJobs = useCallback(async () => {
        try {
            const data = await jobsApi.listJobs();
            setJobs(data);
            lastErrorRef.current = null;
            if (!initialSelectedRef.current && data.length > 0) {
                initialSelectedRef.current = true;
                setSelectedJobId(data[0].id);
            }
        } catch (e) {
            const msg = e.reason || e.message;
            if (lastErrorRef.current !== msg) {
                lastErrorRef.current = msg;
                notify(msg, "error");
            }
        } finally {
            setLoading(false);
        }
    }, [notify, setSelectedJobId]);

    useEffect(() => {
        fetchJobs();
        if (AUTO_REFRESH) {
            intervalRef.current = setInterval(fetchJobs, 5000);
            return () => clearInterval(intervalRef.current);
        }
    }, [fetchJobs]);

    const toggleJob = useCallback(
        async (job) => {
            try {
                if (job.status === "running") {
                    await jobsApi.stopJob(job.id);
                    notify(`Job '${job.id}' stopped`, "success");
                } else {
                    await jobsApi.startJob(job.id);
                    notify(`Job '${job.id}' started`, "success");
                }
                await fetchJobs();
            } catch (e) {
                notify(e.reason || e.message, "error");
            }
        },
        [fetchJobs, notify]
    );

    const installJob = useCallback(
        async (job) => {
            try {
                await jobsApi.installJob(job.id);
                notify(`Job '${job.id}' installed`, "success");
                await fetchJobs();
            } catch (e) {
                notify(e.reason || e.message, "error");
            }
        },
        [fetchJobs, notify]
    );

    const removeJob = useCallback(
        async (id) => {
            try {
                await jobsApi.deleteJob(id);
                notify(`Job '${id}' deleted`, "success");
                await fetchJobs();
            } catch (e) {
                notify(e.reason || e.message, "error");
            }
        },
        [fetchJobs, notify]
    );

    return { jobs, loading, toggleJob, installJob, removeJob, refreshJobs: fetchJobs };
}
