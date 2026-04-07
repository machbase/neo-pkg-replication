import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useApp } from "../context/AppContext";
import StatusBadge from "../components/common/StatusBadge";
import ConfirmDialog from "../components/common/ConfirmDialog";
import Icon from "../components/common/Icon";

function Field({ label, value }) {
    return (
        <div>
            <p className="text-xs text-on-surface-tertiary mb-4">{label}</p>
            <p className="text-base text-on-surface font-mono break-all">{value || "N/A"}</p>
        </div>
    );
}

function RuleVList({ rows, renderBadges }) {
    const scrollRef = useRef(null);
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 36,
        overscan: 5,
    });
    return (
        <div className="vtable-body" ref={scrollRef}>
            {(() => {
                const items = virtualizer.getVirtualItems();
                const firstStart = items[0]?.start ?? 0;
                const lastEnd = items[items.length - 1]?.end ?? 0;
                return (
                    <div style={{ paddingTop: `${firstStart}px`, paddingBottom: `${virtualizer.getTotalSize() - lastEnd}px` }}>
                        {items.map((vRow) => {
                            const row = rows[vRow.index];
                            const badges = renderBadges(row);
                            return (
                                <div
                                    key={row.name}
                                    ref={virtualizer.measureElement}
                                    data-index={vRow.index}
                                    className="flex items-center gap-8 border-b border-border"
                                    style={{ padding: "6px 12px" }}
                                >
                                    <span className="px-8 py-2 bg-surface-elevated rounded-sm text-sm font-mono font-medium text-on-surface shrink-0">{row.name}</span>
                                    <div className="flex flex-wrap gap-4 min-w-0">{badges}</div>
                                </div>
                            );
                        })}
                    </div>
                );
            })()}
        </div>
    );
}

function BadgeList({ items }) {
    const scrollRef = useRef(null);
    const virtualizer = useVirtualizer({
        count: Math.ceil(items.length / 6),
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 32,
        overscan: 3,
    });
    return (
        <div className="vtable-body" ref={scrollRef} style={{ maxHeight: "160px" }}>
            {(() => {
                const vItems = virtualizer.getVirtualItems();
                const firstStart = vItems[0]?.start ?? 0;
                const lastEnd = vItems[vItems.length - 1]?.end ?? 0;
                return (
                    <div style={{ paddingTop: `${firstStart}px`, paddingBottom: `${virtualizer.getTotalSize() - lastEnd}px` }}>
                        {vItems.map((vRow) => {
                            const startIdx = vRow.index * 6;
                            const chunk = items.slice(startIdx, startIdx + 6);
                            return (
                                <div key={vRow.index} ref={virtualizer.measureElement} data-index={vRow.index} className="flex flex-wrap gap-4" style={{ padding: "4px 12px" }}>
                                    {chunk.map((name) => (
                                        <span key={name} className="px-8 py-2 bg-surface-elevated rounded-sm text-sm text-on-surface-secondary font-mono">
                                            {name}
                                        </span>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                );
            })()}
        </div>
    );
}

function RuleBadge({ label, value }) {
    return (
        <span className="badge badge-primary font-mono">
            {label}: {value}
        </span>
    );
}

function SourceDetailCard({ src }) {
    const columns = src.columns || [];
    const filter = src.filter || [];
    const transform = src.transform || [];

    const hasStringRule = (name) => {
        const f = filter.find((r) => r.column === name);
        const t = transform.find((r) => r.column === name);
        return f?.like != null || f?.in != null || t?.prefix != null || t?.suffix != null;
    };
    const hasNumericRule = (name) => {
        const f = filter.find((r) => r.column === name);
        const t = transform.find((r) => r.column === name);
        return f?.min != null || f?.max != null || t?.add != null || t?.multiply != null;
    };

    const stringRows = columns.filter(hasStringRule).map((name) => ({
        name,
        filter: filter.find((r) => r.column === name),
        transform: transform.find((r) => r.column === name),
    }));
    const numericRows = columns.filter(hasNumericRule).map((name) => ({
        name,
        filter: filter.find((r) => r.column === name),
        transform: transform.find((r) => r.column === name),
    }));
    const plainCols = columns.filter((name) => !hasStringRule(name) && !hasNumericRule(name));

    return (
        <section className="form-card">
            <div className="form-card-header">
                <Icon name="database" className="text-primary" />
                Source Database
            </div>
            <div className="flex gap-16">
                <div className="flex-1">
                    <Field label="Host" value={src.host ? `${src.host}:${src.port}` : null} />
                </div>
                <div className="w-80">
                    <Field label="User" value={src.user} />
                </div>
                <div className="w-80">
                    <Field label="Table" value={src.table} />
                </div>
            </div>

            {columns.length > 0 ? (
                <div className="space-y-16 mt-16">
                    <span className="text-xs text-on-surface-tertiary">Total Columns ({columns.length})</span>
                    {stringRows.length > 0 && (
                        <div className="columns-table-wrap">
                            <div className="columns-table-info">
                                <span className="text-xs text-on-surface-tertiary">Non Numeric Columns ({stringRows.length})</span>
                            </div>
                            <RuleVList
                                rows={stringRows}
                                renderBadges={(row) => {
                                    const f = row.filter,
                                        t = row.transform;
                                    return (
                                        <>
                                            {f?.like && <RuleBadge label="like" value={f.like} />}
                                            {f?.in && <RuleBadge label="in" value={f.in.join(", ")} />}
                                            {t?.prefix && <RuleBadge label="prefix" value={t.prefix} />}
                                            {t?.suffix && <RuleBadge label="suffix" value={t.suffix} />}
                                        </>
                                    );
                                }}
                            />
                        </div>
                    )}
                    {numericRows.length > 0 && (
                        <div className="columns-table-wrap">
                            <div className="columns-table-info">
                                <span className="text-xs text-on-surface-tertiary">Numeric Columns ({numericRows.length})</span>
                            </div>
                            <RuleVList
                                rows={numericRows}
                                renderBadges={(row) => {
                                    const f = row.filter,
                                        t = row.transform;
                                    return (
                                        <>
                                            {f?.min != null && <RuleBadge label="min" value={`≥${f.min}`} />}
                                            {f?.max != null && <RuleBadge label="max" value={`≤${f.max}`} />}
                                            {t?.add != null && <RuleBadge label="add" value={`+${t.add}`} />}
                                            {t?.multiply != null && <RuleBadge label="multiply" value={`×${t.multiply}`} />}
                                        </>
                                    );
                                }}
                            />
                        </div>
                    )}
                    {plainCols.length > 0 && (
                        <div className="columns-table-wrap">
                            <div className="columns-table-info">
                                <span className="text-xs text-on-surface-tertiary">Columns ({plainCols.length})</span>
                            </div>
                            <BadgeList items={plainCols} />
                        </div>
                    )}
                </div>
            ) : (
                <p className="text-sm text-on-surface-tertiary mt-16">{src.columns === null || src.columns === undefined ? "All columns" : "No columns configured"}</p>
            )}
        </section>
    );
}

export default function DashboardPage({ jobs, onDelete }) {
    const navigate = useNavigate();
    const { selectedJobId, setSelectedJobId, jobDetail, detailLoading, fetchJobDetail } = useApp();
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [lastUpdated, setLastUpdated] = useState(null);
    const prevTotalRowsRef = useRef(null);
    const [rowsPerSec, setRowsPerSec] = useState(null);
    const [consecutiveZero, setConsecutiveZero] = useState(0);

    const listJob = jobs.find((j) => j.id === selectedJobId);

    useEffect(() => {
        prevTotalRowsRef.current = null;
        setRowsPerSec(null);
        setConsecutiveZero(0);
        if (selectedJobId) {
            fetchJobDetail(selectedJobId).then((data) => {
                if (data) {
                    setLastUpdated(new Date());
                    const cp = data.checkpoints || {};
                    prevTotalRowsRef.current = Object.values(cp).reduce((sum, v) => sum + Number(v.lastSuccessRid || 0), 0);
                }
            });
        }
    }, [selectedJobId, fetchJobDetail]);

    const refreshReplicationInfo = useCallback(() => {
        if (!selectedJobId) return;
        fetchJobDetail(selectedJobId, true).then((data) => {
            if (!data) return;
            setLastUpdated(new Date());
            const cp = data.checkpoints || {};
            const currentTotal = Object.values(cp).reduce((sum, v) => sum + Number(v.lastSuccessRid || 0), 0);
            if (prevTotalRowsRef.current !== null) {
                const diff = currentTotal - prevTotalRowsRef.current;
                const rate = Math.max(0, diff / 5);
                setRowsPerSec(rate);
                setConsecutiveZero((prev) => (rate === 0 ? prev + 1 : 0));
            }
            prevTotalRowsRef.current = currentTotal;
        });
    }, [selectedJobId, fetchJobDetail]);

    useEffect(() => {
        if (!selectedJobId) return;
        const id = setInterval(refreshReplicationInfo, 5000);
        return () => clearInterval(id);
    }, [selectedJobId, refreshReplicationInfo]);

    if (!listJob) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-on-surface-tertiary">
                <Icon name="inbox" className="text-lg mb-12 opacity-30" />
                <p className="text-md font-medium">{jobs.length === 0 ? "No jobs yet" : "Select a job from the sidebar"}</p>
                {jobs.length === 0 && <p className="text-sm mt-4 text-on-surface-disabled">Click "New Job" to get started</p>}
            </div>
        );
    }

    if (detailLoading || !jobDetail) {
        return (
            <div className="flex items-center justify-center h-full text-on-surface-tertiary">
                <p className="text-sm">Loading...</p>
            </div>
        );
    }

    const handleDelete = async () => {
        await onDelete(listJob.id);
        setSelectedJobId(null);
        setConfirmDelete(false);
    };

    const src = jobDetail.source || {};
    const tgt = jobDetail.target || {};
    const retry = jobDetail.retry || {};

    const checkpoints = jobDetail.checkpoints && Object.keys(jobDetail.checkpoints).length > 0 ? jobDetail.checkpoints : {};
    const cpEntries = Object.entries(checkpoints);
    const allDone = cpEntries.length > 0 && cpEntries.every(([, v]) => !v.hasMore);

    return (
        <div className="page">
            <header className="page-header">
                <div className="page-header-inner">
                    <div className="flex items-center gap-12">
                        <h2 className="page-title">{listJob.id}</h2>
                        <StatusBadge status={listJob.status} />
                    </div>
                    <div className="flex gap-8">
                        <button
                            disabled={listJob.status === "running"}
                            onClick={() => navigate(`/jobs/${encodeURIComponent(listJob.id)}/edit`)}
                            className="btn btn-content btn-primary"
                        >
                            <Icon name="edit" className="icon-sm" />
                            <span>Edit</span>
                        </button>
                        <button disabled={listJob.status === "running"} onClick={() => setConfirmDelete(true)} className="btn btn-content btn-danger">
                            <Icon name="delete" className="icon-sm" />
                            <span>Delete</span>
                        </button>
                    </div>
                </div>
            </header>
            <div className="page-body">
                <div className="page-body-inner">
                    {/* Checkpoints — full width */}
                    <section className="form-card mb-16">
                        <div className="form-card-header">
                            <Icon name="account_tree" className="text-primary" />
                            Replication Info
                            {lastUpdated && (
                                <span
                                    className="ml-auto"
                                    style={{ fontSize: "var(--font-size-xs)", fontWeight: "var(--font-weight-normal)", color: "var(--color-on-surface-disabled)" }}
                                >
                                    Last updated: {lastUpdated.toLocaleTimeString()}
                                </span>
                            )}
                            <button
                                onClick={() => {
                                    if (!selectedJobId) return;
                                    fetchJobDetail(selectedJobId, true).then((data) => {
                                        if (!data) return;
                                        setLastUpdated(new Date());
                                        const cp = data.checkpoints || {};
                                        prevTotalRowsRef.current = Object.values(cp).reduce((sum, v) => sum + Number(v.lastSuccessRid || 0), 0);
                                        setRowsPerSec(null);
                                        setConsecutiveZero(0);
                                    });
                                }}
                                className={`${lastUpdated ? "" : "ml-auto"} p-4 hover:bg-surface-hover rounded-base transition-colors tooltip`}
                                data-tooltip="Refresh (auto every 5s)"
                            >
                                <Icon name="refresh" className="icon-sm" />
                            </button>
                        </div>
                        {(() => {
                            const totalRows = cpEntries.reduce((sum, [, v]) => sum + Number(v.lastSuccessRid || 0), 0);
                            const leftIconColor = listJob.status === "running" ? "var(--color-success)" : "var(--color-error)";
                            const rightIconColor =
                                cpEntries?.length === 0 || rowsPerSec === null
                                    ? "var(--color-on-surface-disabled)"
                                    : allDone
                                    ? "var(--color-on-surface-disabled)"
                                    : rowsPerSec > 0
                                    ? "var(--color-success)"
                                    : "var(--color-error)";
                            const isFlowing = rowsPerSec !== null && rowsPerSec > 0;
                            return (
                                <div className="flex items-center justify-center gap-24">
                                    {/* Left DB icon — status color */}
                                    <div className="flex flex-col items-center shrink-0">
                                        <Icon name="database" className="shrink-0" style={{ fontSize: "120px", color: leftIconColor }} />
                                        <span className="font-mono text-xs text-on-surface-disabled mt-2">
                                            {src.host}:{src.port}
                                        </span>
                                    </div>

                                    {/* Table */}
                                    <div className="flex-1 min-w-0" style={{ maxWidth: "360px" }}>
                                        <table className="w-full">
                                            <thead>
                                                <tr className="text-xs text-on-surface-tertiary">
                                                    <th className="text-left font-medium pb-6 pl-12">Partition</th>
                                                    <th className="text-right font-medium pb-6 pr-12">Last Row ID</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {cpEntries?.length > 0 ? (
                                                    cpEntries.map(([partition, v]) => (
                                                        <tr key={partition} className="border-t border-border">
                                                            <td className="py-6 pl-12">
                                                                <span className="text-sm text-on-surface">{partition}</span>
                                                            </td>
                                                            <td className="py-6 pr-12 text-right">
                                                                <span className="font-mono text-sm text-on-surface-secondary">{v.lastSuccessRid ? Number(v.lastSuccessRid).toLocaleString() : "—"}</span>
                                                            </td>
                                                        </tr>
                                                    ))
                                                ) : (
                                                    <tr>
                                                        <td colSpan="2" className="py-6 pl-12">
                                                            <span className="text-sm text-on-surface-disabled">Job has not been executed yet</span>
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                        <p className="text-right text-xs text-on-surface-disabled mt-8 pr-12">Total: {totalRows.toLocaleString()}</p>
                                    </div>

                                    {/* Flow arrow + rate */}
                                    <div className="flex flex-col items-center gap-6 shrink-0" style={{ width: "100px" }}>
                                        <div
                                            className={`repl-flow-arrow ${isFlowing ? `flowing text-primary` : ""} ${consecutiveZero >= 2 ? "text-error" : ""}`}
                                            style={{ fontSize: "56px", fontWeight: 700, letterSpacing: "-6px" }}
                                        >
                                            <span>&gt;</span>
                                            <span>&gt;</span>
                                            <span>&gt;</span>
                                        </div>
                                        <span
                                            className={`text-sm font-mono font-medium ${
                                                rowsPerSec === null ? "text-on-surface-disabled" : consecutiveZero >= 2 ? "text-error" : "text-success"
                                            }`}
                                        >
                                            {rowsPerSec !== null ? `${rowsPerSec.toFixed(1)} r/s` : "—"}
                                        </span>
                                    </div>

                                    {/* Right DB icon — rate color */}
                                    <div className="flex flex-col items-center shrink-0">
                                        <Icon name="database" className="shrink-0" style={{ fontSize: "120px", color: rightIconColor }} />
                                        <span className="font-mono text-xs text-on-surface-disabled mt-2">
                                            {tgt.host}:{tgt.port}
                                        </span>
                                    </div>
                                </div>
                            );
                        })()}
                    </section>

                    {/* Two-column layout */}
                    <div className="flex flex-col lg:flex-row items-start gap-16">
                        {/* Left column: Execution / Advanced */}
                        <div className="flex-1 lg:min-w-0 space-y-16">
                            <section className="form-card">
                                <div className="form-card-header">
                                    <Icon name="tune" className="text-primary" />
                                    Execution Settings
                                </div>
                                <div className="grid grid-cols-2 gap-16 mb-16">
                                    <Field label="Start Mode" value={jobDetail.startMode} />
                                    <Field label="On Save Failure" value={jobDetail.onSaveFailure} />
                                </div>
                                <div className="grid grid-cols-3 gap-16">
                                    <Field label="Query Limit" value={jobDetail.queryLimit} />
                                    <Field label="Poll Interval" value={`${jobDetail.pollIntervalMs}ms`} />
                                    <Field label="RID Range Size" value={jobDetail.ridRangeSize} />
                                </div>
                            </section>

                            <section className="form-card">
                                <div className="form-card-header">
                                    <Icon name="settings" className="text-primary" />
                                    Advanced Settings
                                </div>
                                <div className="grid grid-cols-2 gap-16 mb-16">
                                    <Field label="Shutdown Timeout" value={`${jobDetail.shutdownTimeoutMs}ms`} />
                                    <Field label="Integrity Check" value={jobDetail.integrity !== false ? "Enabled" : "Disabled"} />
                                </div>
                                <div className="grid grid-cols-3 gap-16">
                                    <Field label="Retry Max Attempts" value={retry.maxAttempts} />
                                    <Field label="Retry Base Delay" value={retry.baseDelayMs ? `${retry.baseDelayMs}ms` : null} />
                                    <Field label="Retry Max Delay" value={retry.maxDelayMs ? `${retry.maxDelayMs}ms` : null} />
                                </div>
                            </section>
                        </div>

                        {/* Right column: Source / Target */}
                        <div className="flex-1 lg:min-w-0 space-y-16">
                            <SourceDetailCard src={src} />

                            <section className="form-card">
                                <div className="form-card-header">
                                    <Icon name="output" className="text-primary" />
                                    Target Database
                                </div>
                                <div className="flex gap-16">
                                    <div className="flex-1">
                                        <Field label="Host" value={tgt.host ? `${tgt.host}:${tgt.port}` : null} />
                                    </div>
                                    <div className="w-80">
                                        <Field label="User" value={tgt.user} />
                                    </div>
                                    <div className="w-80">
                                        <Field label="Table" value={tgt.table} />
                                    </div>
                                </div>
                            </section>
                        </div>
                    </div>

                    {confirmDelete && (
                        <ConfirmDialog
                            title="Delete Job"
                            message={`Are you sure you want to delete "${listJob.id}"? This action cannot be undone.`}
                            onConfirm={handleDelete}
                            onCancel={() => setConfirmDelete(false)}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
