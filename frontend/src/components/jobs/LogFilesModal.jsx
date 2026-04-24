import { useEffect, useState, useRef, useMemo } from "react";
import Icon from "../common/Icon";
import { listLogFiles, fetchLogContentAll } from "../../api/logs";

const PAGE_SIZE = 500;
const KNOWN_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
const LEVEL_RE = new RegExp(`\\[\\s*(${KNOWN_LEVELS.join("|")})\\s*\\]`);

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

function formatBytes(n) {
    if (n == null) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function LogFilesModal({ onClose, name }) {
    const [files, setFiles] = useState([]);
    const [listLoading, setListLoading] = useState(true);
    const [listError, setListError] = useState(null);

    const [selected, setSelected] = useState(null);
    const [allLines, setAllLines] = useState(null);
    const [contentLoading, setContentLoading] = useState(false);
    const [contentError, setContentError] = useState(null);
    const [page, setPage] = useState(0);
    const [wrap, setWrap] = useState(true);
    const [downloadingName, setDownloadingName] = useState(null);

    const bodyRef = useRef(null);

    useEffect(() => {
        const handleKey = (e) => {
            if (e.key !== "Escape") return;
            if (selected) setSelected(null);
            else onClose();
        };
        document.addEventListener("keydown", handleKey);
        return () => document.removeEventListener("keydown", handleKey);
    }, [onClose, selected]);

    const loadList = async () => {
        setListLoading(true);
        setListError(null);
        try {
            const f = await listLogFiles(name);
            setFiles(f);
        } catch (err) {
            setListError(err.message || "Failed to load log files");
        } finally {
            setListLoading(false);
        }
    };

    useEffect(() => {
        loadList();
    }, [name]);

    const loadFile = async (file) => {
        setContentLoading(true);
        setContentError(null);
        try {
            const data = await fetchLogContentAll({ name: file.name });
            const text = data?.content ?? "";
            const lines = text.split("\n");
            if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
            setAllLines(lines);
            setPage(0);
            requestAnimationFrame(() => {
                if (bodyRef.current) bodyRef.current.scrollTop = 0;
            });
        } catch (err) {
            setContentError(err.message || "Failed to load log content");
        } finally {
            setContentLoading(false);
        }
    };

    const openFile = (file) => {
        setSelected(file);
        setAllLines(null);
        loadFile(file);
    };

    const downloadFile = async (file) => {
        if (downloadingName) return;
        setDownloadingName(file.name);
        try {
            const data = await fetchLogContentAll({ name: file.name });
            const text = data?.content ?? "";
            const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            setListError(err.message || "Failed to download log file");
        } finally {
            setDownloadingName(null);
        }
    };

    const backToList = () => {
        setSelected(null);
        setAllLines(null);
        setContentError(null);
        setPage(0);
    };

    const totalLines = allLines?.length ?? 0;
    const totalPages = totalLines > 0 ? Math.ceil(totalLines / PAGE_SIZE) : 0;
    const canPrev = page > 0;
    const canNext = page + 1 < totalPages;

    const pageStart = totalLines > 0 ? page * PAGE_SIZE + 1 : 0;
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, totalLines);
    const pageLines = useMemo(
        () => (allLines ? allLines.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : []),
        [allLines, page]
    );

    const goToPage = (p) => {
        setPage(p);
        requestAnimationFrame(() => {
            if (bodyRef.current) bodyRef.current.scrollTop = 0;
        });
    };

    return (
        <div className="modal-overlay" onMouseDown={onClose}>
            <div
                className="modal modal-lg"
                style={
                    selected
                        ? {
                              maxWidth: "none",
                              width: "100vw",
                              height: "100vh",
                              maxHeight: "100vh",
                              borderRadius: 0,
                              display: "flex",
                              flexDirection: "column",
                          }
                        : { maxWidth: 860, width: "100%" }
                }
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="modal-header">
                    <div className="modal-header-title">
                        {selected && (
                            <button
                                onClick={backToList}
                                className="p-4 hover:bg-surface-hover rounded-base tooltip"
                                data-tooltip="Back"
                            >
                                <Icon name="arrow_back" />
                            </button>
                        )}
                        <Icon name="description" className="text-primary" />
                        {selected ? selected.name : "Log Files"}
                    </div>
                    <button
                        onClick={onClose}
                        className="p-4 hover:bg-surface-hover rounded-base tooltip"
                        data-tooltip="Close"
                    >
                        <Icon name="close" />
                    </button>
                </div>

                {!selected ? (
                    <div className="modal-body">
                        {listLoading ? (
                            <p className="text-on-surface-tertiary text-base py-8 text-center">
                                Loading...
                            </p>
                        ) : listError ? (
                            <p className="text-error text-sm py-8 text-center">{listError}</p>
                        ) : files.length === 0 ? (
                            <div className="text-center py-12 text-on-surface-tertiary">
                                <Icon name="description" className="text-4xl mb-2 opacity-20" />
                                <p className="text-sm font-medium">No log files</p>
                            </div>
                        ) : (
                            <div className="server-card-list">
                                {files.map((f) => {
                                    const isDownloading = downloadingName === f.name;
                                    return (
                                        <div
                                            key={f.name}
                                            style={{
                                                display: "flex",
                                                gap: "var(--spacing-8)",
                                                alignItems: "stretch",
                                            }}
                                        >
                                            <div
                                                role="button"
                                                tabIndex={0}
                                                className="server-card"
                                                onClick={() => openFile(f)}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter" || e.key === " ") {
                                                        e.preventDefault();
                                                        openFile(f);
                                                    }
                                                }}
                                                style={{
                                                    flex: 1,
                                                    minWidth: 0,
                                                    cursor: "pointer",
                                                    textAlign: "left",
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: "var(--spacing-16)",
                                                        minWidth: 0,
                                                    }}
                                                >
                                                    <span
                                                        className="server-card-name"
                                                        style={{
                                                            overflow: "hidden",
                                                            textOverflow: "ellipsis",
                                                        }}
                                                    >
                                                        {f.name}
                                                    </span>
                                                    <span
                                                        className="server-card-detail"
                                                        style={{ marginLeft: "auto", flexShrink: 0 }}
                                                    >
                                                        {formatBytes(f.size)}
                                                    </span>
                                                </div>
                                                <Icon
                                                    name="chevron_right"
                                                    className="text-on-surface-tertiary"
                                                />
                                            </div>
                                            <button
                                                type="button"
                                                className="server-card tooltip tooltip-above"
                                                data-tooltip="Download"
                                                disabled={isDownloading}
                                                onClick={() => downloadFile(f)}
                                                style={{
                                                    display: "flex",
                                                    alignItems: "center",
                                                    justifyContent: "center",
                                                    width: 56,
                                                    flexShrink: 0,
                                                    cursor: isDownloading ? "default" : "pointer",
                                                    color: "var(--color-on-surface-tertiary)",
                                                }}
                                            >
                                                <Icon
                                                    name={isDownloading ? "progress_activity" : "download"}
                                                    className={isDownloading ? "animate-spin" : ""}
                                                />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                ) : (
                    <>
                        <div className="live-logs-header" style={{ borderTop: "1px solid var(--color-border)" }}>
                            <div className="flex items-center gap-12">
                                <span className="live-logs-meta">
                                    {contentLoading
                                        ? "LOADING..."
                                        : allLines
                                          ? `LINES ${pageStart}-${pageEnd} / ${totalLines.toLocaleString()}`
                                          : ""}
                                </span>
                                {totalPages > 1 && (
                                    <span className="live-logs-meta">
                                        PAGE {page + 1}/{totalPages}
                                    </span>
                                )}
                            </div>
                            <div className="flex gap-8">
                                <button
                                    type="button"
                                    className="btn btn-sm btn-ghost"
                                    disabled={!canPrev || contentLoading}
                                    onClick={() => goToPage(page - 1)}
                                >
                                    <Icon name="chevron_left" className="icon-sm" />
                                    <span>Prev</span>
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-sm btn-ghost"
                                    disabled={!canNext || contentLoading}
                                    onClick={() => goToPage(page + 1)}
                                >
                                    <span>Next</span>
                                    <Icon name="chevron_right" className="icon-sm" />
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-sm btn-ghost tooltip"
                                    data-tooltip={wrap ? "Switch to horizontal scroll" : "Switch to wrap lines"}
                                    onClick={() => setWrap((w) => !w)}
                                >
                                    <Icon name={wrap ? "wrap_text" : "swap_horiz"} className="icon-sm" />
                                    <span>{wrap ? "Wrap" : "Scroll"}</span>
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-sm btn-ghost"
                                    disabled={contentLoading}
                                    onClick={() => loadFile(selected)}
                                >
                                    <Icon name="refresh" className="icon-sm" />
                                    <span>Reload</span>
                                </button>
                            </div>
                        </div>
                        <div
                            ref={bodyRef}
                            className="live-logs-body"
                            style={{
                                flex: 1,
                                minHeight: 0,
                                overflowX: wrap ? "hidden" : "auto",
                                paddingLeft: 0,
                            }}
                        >
                            {contentError ? (
                                <div className="live-logs-empty">{contentError}</div>
                            ) : contentLoading && !allLines ? (
                                <div className="live-logs-empty">Loading...</div>
                            ) : !allLines || pageLines.length === 0 ? (
                                <div className="live-logs-empty">Empty</div>
                            ) : (
                                pageLines.map((text, i) => (
                                    <div
                                        key={`${pageStart}-${i}`}
                                        style={{
                                            display: "flex",
                                            alignItems: "flex-start",
                                            width: wrap ? "100%" : "max-content",
                                            minWidth: wrap ? undefined : "100%",
                                        }}
                                    >
                                        <span
                                            style={{
                                                flex: "0 0 64px",
                                                color: "var(--color-on-surface-tertiary)",
                                                userSelect: "none",
                                                position: wrap ? "static" : "sticky",
                                                left: 0,
                                                backgroundColor: "#0b0d10",
                                                zIndex: 2,
                                                alignSelf: "stretch",
                                                textAlign: "right",
                                                paddingRight: "var(--spacing-12)",
                                                borderRight: wrap
                                                    ? "none"
                                                    : "1px solid var(--color-border)",
                                                boxSizing: "border-box",
                                                fontFamily:
                                                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                                fontSize: "inherit",
                                                lineHeight: "inherit",
                                                letterSpacing: "normal",
                                                fontVariantNumeric: "tabular-nums",
                                            }}
                                        >
                                            {pageStart + i}
                                        </span>
                                        <span
                                            style={{
                                                flex: wrap ? 1 : "0 0 auto",
                                                minWidth: 0,
                                                paddingLeft: "var(--spacing-12)",
                                                whiteSpace: wrap ? "pre-wrap" : "pre",
                                                wordBreak: wrap ? "break-word" : "normal",
                                            }}
                                        >
                                            {renderLine(text)}
                                        </span>
                                    </div>
                                ))
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
