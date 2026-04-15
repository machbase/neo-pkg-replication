import { useEffect, useRef, useState } from "react";
import Icon from "../common/Icon";

const MAX_LINES = 100;
// TODO: flip to false once backend SSE endpoint is ready
const USE_MOCK = true;
const API_BASE = import.meta.env.VITE_API_BASE ?? "/public/neo-pkg-replication/cgi-bin/api";

const KNOWN_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
const LEVEL_RE = new RegExp(`\\[(${KNOWN_LEVELS.join("|")})\\]`);

function renderLine(text) {
    const m = text.match(LEVEL_RE);
    if (!m) return text;
    const level = m[1];
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    return (
        <>
            {before}
            <span className={`log-level-tag level-${level.toLowerCase()}`}>[{level}]</span>
            {after}
        </>
    );
}

export default function LiveLogs({ jobId }) {
    const [lines, setLines] = useState([]);
    const [connected, setConnected] = useState(false);
    const [paused, setPaused] = useState(false);
    const bodyRef = useRef(null);
    const pausedRef = useRef(paused);
    const stickToBottomRef = useRef(true);

    pausedRef.current = paused;

    useEffect(() => {
        if (!jobId) return undefined;
        setLines([]);
        stickToBottomRef.current = true;

        const append = (text) => {
            if (pausedRef.current) return;
            setLines((prev) => {
                const base = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev;
                return [...base, { key: `${Date.now()}-${Math.random()}`, text }];
            });
        };

        if (USE_MOCK) {
            setConnected(true);
            let i = 0;
            const levels = ["INFO", "DEBUG", "WARN", "ERROR"];
            const id = setInterval(() => {
                i += 1;
                const ts = new Date().toISOString();
                const lv = levels[Math.floor(Math.random() * levels.length)];
                append(`[${lv}] ${ts} ${jobId} mock log line #${i}`);
            }, 300);
            return () => {
                clearInterval(id);
                setConnected(false);
            };
        }

        const url = `${API_BASE}/rc/logs.stream?name=${encodeURIComponent(jobId)}`;
        const es = new EventSource(url);
        es.onopen = () => setConnected(true);
        es.onmessage = (e) => append(e.data);
        es.onerror = () => setConnected(false);
        return () => {
            es.close();
            setConnected(false);
        };
    }, [jobId]);

    useEffect(() => {
        const el = bodyRef.current;
        if (!el || !stickToBottomRef.current) return;
        el.scrollTop = el.scrollHeight;
    }, [lines]);

    const handleScroll = () => {
        const el = bodyRef.current;
        if (!el) return;
        stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 5;
    };

    return (
        <section className="form-card live-logs-card">
            <div className="live-logs-header">
                <div className="flex items-center gap-12">
                    <div className="form-card-header !mb-0">
                        <Icon name="terminal" className="text-primary" />
                        Live Logs
                    </div>
                    <span
                        className={`repl-dot ${connected ? "repl-dot--active" : "repl-dot--stopped"}`}
                    />
                    <span className="live-logs-meta">
                        {connected ? "CONNECTED" : "DISCONNECTED"}
                    </span>
                    <span className="live-logs-meta">
                        {lines.length}/{MAX_LINES}
                    </span>
                </div>
                <div className="flex gap-8">
                    <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => setPaused((p) => !p)}
                    >
                        <Icon name={paused ? "play_arrow" : "pause"} className="icon-sm" />
                        <span>{paused ? "Resume" : "Pause"}</span>
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLines([])}>
                        <Icon name="delete_sweep" className="icon-sm" />
                        <span>Clear</span>
                    </button>
                </div>
            </div>
            <div ref={bodyRef} onScroll={handleScroll} className="live-logs-body">
                {lines.length === 0 ? (
                    <div className="live-logs-empty">Waiting for logs...</div>
                ) : (
                    lines.map((l) => <div key={l.key}>{renderLine(l.text)}</div>)
                )}
            </div>
        </section>
    );
}
