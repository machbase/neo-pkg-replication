import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router";
import { useApp } from "../context/AppContext";
import StatusBadge from "../components/common/StatusBadge";
import ConfirmDialog from "../components/common/ConfirmDialog";
import Icon from "../components/common/Icon";
import useServers from "../hooks/useServers";
import LiveLogs from "../components/jobs/LiveLogs";
import LogFilesModal from "../components/jobs/LogFilesModal";

const LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];

function Field({ label, value }) {
    return (
        <div>
            <p className="text-xs text-on-surface-tertiary mb-4">{label}</p>
            <p className="text-base text-on-surface font-mono break-all">{value || "N/A"}</p>
        </div>
    );
}

export default function DashboardPage({ jobs, onDelete }) {
    const navigate = useNavigate();
    const { selectedJobId, setSelectedJobId, jobDetail, detailLoading, fetchJobDetail } = useApp();
    const { servers, loading: serversLoading } = useServers();
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [execOpen, setExecOpen] = useState(false);
    const [advOpen, setAdvOpen] = useState(false);
    const [logFilesOpen, setLogFilesOpen] = useState(false);
    const [showLiveLogs, setShowLiveLogs] = useState(false);
    const DASHBOARD_POLL_MS = 5000;
    const prevTotalRowsRef = useRef(null);
    const [rowsPerSec, setRowsPerSec] = useState(null);

    const listJob = jobs.find((j) => j.id === selectedJobId);

    const sumTotalRows = useCallback((cp) => {
        if (!cp) return 0;
        return Object.values(cp).reduce((sum, v) => sum + Number(v.totalRowsWritten || 0), 0);
    }, []);

    const computePartitionGaps = useCallback((cp) => {
        if (!cp) return { total: 0n, perPartition: [] };
        const toBig = (v) => {
            if (v == null || v === "") return null;
            try { return BigInt(String(v)); } catch { return null; }
        };
        let total = 0n;
        const perPartition = [];
        for (const [name, v] of Object.entries(cp)) {
            const max = toBig(v?.max_rid);
            const last = toBig(v?.lastSuccessRid);
            if (max == null) continue;
            const gap = last == null ? max : max - last;
            const safe = gap < 0n ? 0n : gap;
            total += safe;
            perPartition.push({ name, gap: safe });
        }
        return { total, perPartition };
    }, []);

    const formatBig = (n) => {
        const s = n.toString();
        return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    };

    useEffect(() => {
        prevTotalRowsRef.current = null;
        setRowsPerSec(null);
        if (selectedJobId) {
            fetchJobDetail(selectedJobId).then((data) => {
                if (data) {
                    prevTotalRowsRef.current = sumTotalRows(data.checkpoints);
                }
            });
        }
    }, [selectedJobId, fetchJobDetail, sumTotalRows]);

    const refreshReplicationInfo = useCallback(() => {
        if (!selectedJobId) return;
        fetchJobDetail(selectedJobId, true).then((data) => {
            if (!data) return;
            const currentTotal = sumTotalRows(data.checkpoints);
            if (prevTotalRowsRef.current !== null) {
                const diff = currentTotal - prevTotalRowsRef.current;
                const rate = Math.max(0, diff / (DASHBOARD_POLL_MS / 1000));
                setRowsPerSec(rate);
            }
            prevTotalRowsRef.current = currentTotal;
        });
    }, [selectedJobId, fetchJobDetail, sumTotalRows]);

    const AUTO_REFRESH_DASHBOARD = true;
    useEffect(() => {
        if (!AUTO_REFRESH_DASHBOARD || !selectedJobId) return;
        const id = setInterval(refreshReplicationInfo, DASHBOARD_POLL_MS);
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
    const logging = jobDetail.logging || {};

    // target server가 삭제되어 서버 목록에 없을 수 있음 — 그런 경우 isMqttPublish=false로 정상 렌더에 폴백
    const targetServerMeta = servers.find((s) => s.name === tgt.server);
    const isMqttPublish = targetServerMeta?.type === "mqtt-publish";
    const targetServerMissing = !serversLoading && !!tgt.server && !targetServerMeta;

    const checkpoints = jobDetail.checkpoints && Object.keys(jobDetail.checkpoints).length > 0 ? jobDetail.checkpoints : {};
    const cpEntries = Object.entries(checkpoints);

    // checkpointStatus: { source_row_count, target_row_count, warnings: [{code, side, table, message}] }
    // row_count is a string: "" = unsupported/unavailable, "0" = empty table, otherwise count as string
    const checkpointStatus = jobDetail.checkpointStatus || null;
    const formatRowCount = (v) => {
        if (v == null || v === "") return null;
        try {
            return BigInt(String(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        } catch {
            return null;
        }
    };
    const sourceRowCountLabel = formatRowCount(checkpointStatus?.source_row_count);
    const targetRowCountLabel = formatRowCount(checkpointStatus?.target_row_count);
    const warnings = Array.isArray(checkpointStatus?.warnings) ? checkpointStatus.warnings : [];
    const hasSourceWarning = warnings.some((w) => w?.side === "source");
    const hasTargetWarning = warnings.some((w) => w?.side === "target");

    const srcColumns = Array.isArray(src.columns) ? src.columns : [];
    const tgtColumns = Array.isArray(tgt.columns) ? tgt.columns : [];
    const schemaRowCount = Math.max(srcColumns.length, tgtColumns.length);
    const schemaRows = Array.from({ length: schemaRowCount }, (_, i) => ({
        src: srcColumns[i] || null,
        tgt: tgtColumns[i] || null,
    })).filter((row) => row.src || row.tgt);

    const srcMeta = Array.isArray(src.meta) ? src.meta : [];
    const tgtMeta = Array.isArray(tgt.meta) ? tgt.meta : [];
    const metaRowCount = Math.max(srcMeta.length, tgtMeta.length);
    const metaRows = Array.from({ length: metaRowCount }, (_, i) => ({
        src: srcMeta[i] || null,
        tgt: tgtMeta[i] || null,
    })).filter((row) => row.src || row.tgt);

    const repCond = src.rep_target_cond || null;
    const hasRepCond = !!(repCond && repCond.column);

    const transforms = Array.isArray(src.transform) ? src.transform : [];
    const hasTransforms = transforms.length > 0 && transforms.some((t) => Array.isArray(t.expr) && t.expr.length > 0);

    const renderCriteriaLabel = (criteria) => {
        if (!criteria) return "ALL";
        const { column, op, value } = criteria;
        if (!op || op === "ALL") return `${column || "—"} ALL`;
        if (op === "IN") return `${column} IN [${(value || []).map((v) => `'${v}'`).join(", ")}]`;
        if (op === "LIKE") return `${column} LIKE '${value?.[0] || ""}'`;
        return `${column} ${op}`;
    };

    const renderExpr = (e) => {
        if (e.type === "prefix") return <span style={{ color: "#4da6ff" }}>prefix '{e.value}'</span>;
        if (e.type === "suffix") return <span style={{ color: "#4da6ff" }}>suffix '{e.value}'</span>;
        if (e.type === "calc") {
            const order = e.calcOrder === "mb" ? "mb" : "bm";
            const bPart = e.bias != null && e.bias !== "" ? ` + ${e.bias}` : "";
            const mPart = e.multiplier != null && e.multiplier !== "" ? ` * ${e.multiplier}` : "";
            const formula = order === "bm" ? `(val${bPart})${mPart}` : `(val${mPart})${bPart}`;
            return <span style={{ color: "#4da6ff" }}>{formula}</span>;
        }
        if (e.type === "filter") {
            const parts = [];
            if (e.min != null && e.min !== "") parts.push(`>= ${e.min}`);
            if (e.max != null && e.max !== "") parts.push(`<= ${e.max}`);
            return <span style={{ color: "#4da6ff" }}>{parts.join(" AND ") || "(no bounds)"}</span>;
        }
        return null;
    };

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
                            type="button"
                            onClick={() => setShowLiveLogs((v) => !v)}
                            className="btn btn-secondary"
                        >
                            <Icon name="terminal" className="icon-sm" />
                            <span>Live Logs</span>
                        </button>
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
                    {/* Replication Info — full width */}
                    <section className="repl-info-card">
                        {warnings.length > 0 && (
                            <div className="repl-info-warnings">
                                {warnings.map((w, i) => (
                                    <div key={i} className="repl-info-warning">
                                        <Icon name="warning" className="icon-sm" />
                                        <span className="repl-info-warning-text">
                                            {w.message || `${w.side || ""} table '${w.table || ""}' issue (${w.code || "unknown"})`}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                        {(() => {
                            const totalRows = sumTotalRows(checkpoints);
                            const hasAnyMore = cpEntries.length > 0 && cpEntries.some(([, v]) => v.hasMore);
                            const isFlowing = hasAnyMore && listJob.status !== "stopped";
                            const stateLabel = listJob.status === "running" ? (isFlowing ? "REPLICATING" : "IDLE STATE") : "STOPPED";
                            const stateDotClass = listJob.status === "running" ? (isFlowing ? "repl-dot--active" : "repl-dot--idle") : "repl-dot--stopped";
                            const { total: totalGap, perPartition } = computePartitionGaps(checkpoints);
                            const hasGapInfo = perPartition.length > 0;
                            const isBehind = totalGap > 0n;
                            return (
                                <div className="repl-info-grid">
                                    <div className="repl-info-endpoint">
                                        <span className="repl-info-label">
                                            SOURCE
                                            {hasSourceWarning && (
                                                <span
                                                    className="tooltip ml-4"
                                                    data-tooltip="Source table issue — see warnings above"
                                                    style={{ color: "var(--color-warning)", verticalAlign: "middle" }}
                                                >
                                                    <Icon name="warning" className="icon-sm" />
                                                </span>
                                            )}
                                        </span>
                                        <span className="repl-info-table">{src.table || "—"}</span>
                                        <span className="repl-info-db">{src.server || "—"}</span>
                                        {sourceRowCountLabel !== null && (
                                            <span className="repl-info-row-count">
                                                <span className="repl-info-row-count-value">{sourceRowCountLabel}</span>
                                                <span className="repl-info-row-count-label">ROWS</span>
                                            </span>
                                        )}
                                    </div>

                                    <div className="repl-info-center">
                                        <div className="repl-info-status">
                                            <span className={`repl-dot ${stateDotClass}`} />
                                            <span className="repl-info-status-text">{stateLabel}</span>
                                            {hasGapInfo && (
                                                <>
                                                    <span className="repl-info-status-sep">·</span>
                                                    <span className={`repl-info-lag ${isBehind ? "repl-info-lag--behind" : ""}`}>
                                                        GAP <span className="repl-info-lag-value">{formatBig(totalGap)}</span>
                                                        <span className="repl-info-lag-popover" role="tooltip">
                                                            {perPartition.map((p) => (
                                                                <span key={p.name} className="repl-info-lag-row">
                                                                    <span className="repl-info-lag-row-name">{p.name}</span>
                                                                    <span className="repl-info-lag-row-gap">{formatBig(p.gap)}</span>
                                                                </span>
                                                            ))}
                                                        </span>
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                        <span className="repl-info-rows">{totalRows.toLocaleString("en-US")}</span>
                                        <span className="repl-info-rows-label">ROWS PROCESSED</span>
                                        <span className={`repl-info-rate ${rowsPerSec !== null && rowsPerSec > 0 ? "repl-info-rate--active" : ""}`}>
                                            {rowsPerSec !== null ? `${rowsPerSec.toFixed(1)} rows/s` : "0.0 rows/s"}
                                        </span>
                                    </div>

                                    <div className="repl-info-endpoint">
                                        <span className="repl-info-label">
                                            TARGET
                                            {isMqttPublish && (
                                                <span className="tooltip ml-4" data-tooltip="MQTT Publish" style={{ color: "#4da6ff", verticalAlign: "middle" }}>
                                                    <Icon name="podcasts" className="icon-sm" />
                                                </span>
                                            )}
                                            {hasTargetWarning && (
                                                <span
                                                    className="tooltip ml-4"
                                                    data-tooltip="Target table issue — see warnings above"
                                                    style={{ color: "var(--color-warning)", verticalAlign: "middle" }}
                                                >
                                                    <Icon name="warning" className="icon-sm" />
                                                </span>
                                            )}
                                        </span>
                                        <span className="repl-info-table">{tgt.table || "—"}</span>
                                        <span className="repl-info-db">
                                            {tgt.server || "—"}
                                            {targetServerMissing && (
                                                <span
                                                    className="tooltip ml-4"
                                                    data-tooltip="Target server no longer exists"
                                                    style={{ color: "var(--color-warning)", verticalAlign: "middle" }}
                                                >
                                                    <Icon name="warning" className="icon-sm" />
                                                </span>
                                            )}
                                        </span>
                                        {targetRowCountLabel !== null && (
                                            <span className="repl-info-row-count">
                                                <span className="repl-info-row-count-value">{targetRowCountLabel}</span>
                                                <span className="repl-info-row-count-label">ROWS</span>
                                            </span>
                                        )}
                                    </div>
                                </div>
                            );
                        })()}
                    </section>

                    {/* Schema Mapping */}
                    {(schemaRows.length > 0 || metaRows.length > 0) && (
                        <section className="form-card">
                            <div className="form-card-header">
                                <Icon name="schema" className="text-primary" />
                                Schema Mapping
                            </div>
                            {schemaRows.length > 0 && (
                                <div className="schema-mapping-wrap">
                                    <table className="schema-mapping-table">
                                        <thead>
                                            <tr>
                                                <th>SOURCE ({(src.table || "—").toUpperCase()})</th>
                                                {isMqttPublish ? (
                                                    <th style={{ width: "60px", textAlign: "center" }}>MQTT</th>
                                                ) : (
                                                    <>
                                                        <th style={{ width: "60px", textAlign: "center" }}>LOGIC</th>
                                                        <th>TARGET ({(tgt.table || "—").toUpperCase()})</th>
                                                    </>
                                                )}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {(isMqttPublish ? schemaRows.filter((r) => r.src) : schemaRows).map((row, i) => (
                                                <tr key={i}>
                                                    <td className={!row.src || (!isMqttPublish && !row.tgt) ? "schema-cell--empty" : ""}>
                                                        {row.src ? (
                                                            <span className={`font-mono${!isMqttPublish && !row.tgt ? " schema-strike" : ""}`}>{row.src}</span>
                                                        ) : (
                                                            <span className="text-on-surface-disabled">-</span>
                                                        )}
                                                    </td>
                                                    {isMqttPublish ? (
                                                        <td style={{ textAlign: "center" }}>
                                                            <span
                                                                className={`col-map-outbound-icon${row.src ? " col-map-outbound-icon--active" : ""}`}
                                                                title="Published to MQTT"
                                                            >
                                                                <Icon name="podcasts" />
                                                            </span>
                                                        </td>
                                                    ) : (
                                                        <>
                                                            <td style={{ textAlign: "center" }}>
                                                                {!row.src || !row.tgt ? (
                                                                    <Icon name="sync_disabled" style={{ fontSize: "16px", color: "var(--color-on-surface-disabled)" }} />
                                                                ) : (
                                                                    <span className="text-on-surface-disabled">→</span>
                                                                )}
                                                            </td>
                                                            <td className={!row.src || !row.tgt ? "schema-cell--empty" : ""}>
                                                                {row.tgt ? (
                                                                    <span className={`font-mono${!row.src ? " schema-strike" : ""}`}>{row.tgt}</span>
                                                                ) : (
                                                                    <span className="font-mono" style={{ fontStyle: "italic", color: "#555" }}>
                                                                        NULL
                                                                    </span>
                                                                )}
                                                            </td>
                                                        </>
                                                    )}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                            {metaRows.length > 0 && (
                                <div className={schemaRows.length > 0 ? "mt-20" : ""}>
                                    <div className="text-sm text-on-surface-secondary font-semibold uppercase tracking-wide mb-8">Meta Columns</div>
                                    <div className="schema-mapping-wrap">
                                        <table className="schema-mapping-table">
                                            <thead>
                                                <tr>
                                                    <th>SOURCE ({(src.table || "—").toUpperCase()})</th>
                                                    {isMqttPublish ? (
                                                        <th style={{ width: "60px", textAlign: "center" }}>MQTT</th>
                                                    ) : (
                                                        <>
                                                            <th style={{ width: "60px", textAlign: "center" }}>LOGIC</th>
                                                            <th>TARGET ({(tgt.table || "—").toUpperCase()})</th>
                                                        </>
                                                    )}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {(isMqttPublish ? metaRows.filter((r) => r.src) : metaRows).map((row, i) => (
                                                    <tr key={i}>
                                                        <td className={!row.src || (!isMqttPublish && !row.tgt) ? "schema-cell--empty" : ""}>
                                                            {row.src ? (
                                                                <span className={`font-mono${!isMqttPublish && !row.tgt ? " schema-strike" : ""}`}>{row.src}</span>
                                                            ) : (
                                                                <span className="text-on-surface-disabled">-</span>
                                                            )}
                                                        </td>
                                                        {isMqttPublish ? (
                                                            <td style={{ textAlign: "center" }}>
                                                                <span
                                                                    className={`col-map-outbound-icon${row.src ? " col-map-outbound-icon--active" : ""}`}
                                                                    title="Published to MQTT"
                                                                >
                                                                    <Icon name="podcasts" />
                                                                </span>
                                                            </td>
                                                        ) : (
                                                            <>
                                                                <td style={{ textAlign: "center" }}>
                                                                    {!row.src || !row.tgt ? (
                                                                        <Icon name="sync_disabled" style={{ fontSize: "16px", color: "var(--color-on-surface-disabled)" }} />
                                                                    ) : (
                                                                        <span className="text-on-surface-disabled">→</span>
                                                                    )}
                                                                </td>
                                                                <td className={!row.src || !row.tgt ? "schema-cell--empty" : ""}>
                                                                    {row.tgt ? (
                                                                        <span className={`font-mono${!row.src ? " schema-strike" : ""}`}>{row.tgt}</span>
                                                                    ) : (
                                                                        <span className="font-mono" style={{ fontStyle: "italic", color: "#555" }}>
                                                                            NULL
                                                                        </span>
                                                                    )}
                                                                </td>
                                                            </>
                                                        )}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}
                        </section>
                    )}

                    {/* Replication Target Condition */}
                    {hasRepCond && (
                        <section className="form-card">
                            <div className="form-card-header">
                                <Icon name="rule" className="text-primary" />
                                Replication Target Condition
                            </div>
                            <div className="condition-block">
                                <div className="condition-line font-mono text-sm" style={{ letterSpacing: "0.5px", wordSpacing: "4px" }}>
                                    <span className="text-on-surface font-semibold">{repCond.column}</span>
                                    <span className="text-on-surface-tertiary"> {repCond.op || "ALL"} </span>
                                    {repCond.op === "IN" ? (
                                        <span style={{ color: "#4da6ff" }}>{"[" + (repCond.value || []).map((v) => "'" + v + "'").join(", ") + "]"}</span>
                                    ) : repCond.op === "LIKE" ? (
                                        <span style={{ color: "#4da6ff" }}>{"'" + (repCond.value?.[0] || "") + "'"}</span>
                                    ) : (
                                        <span className="text-on-surface-tertiary">(all values)</span>
                                    )}
                                </div>
                            </div>
                        </section>
                    )}

                    {/* Data Pipeline */}
                    {hasTransforms && (
                        <section className="form-card">
                            <div className="form-card-header">
                                <Icon name="account_tree" className="text-primary" />
                                Data Pipeline
                            </div>
                            <div className="pipeline-wrap">
                                {transforms.map((group, gi) => {
                                    if (!Array.isArray(group.expr) || group.expr.length === 0) return null;
                                    return (
                                        <div key={gi} className="pipeline-group">
                                            <div className="pipeline-header">
                                                <span className="font-mono text-sm font-semibold" style={{ color: "#4da6ff" }}>
                                                    {renderCriteriaLabel(group.criteria)}
                                                </span>
                                            </div>
                                            <div className="pipeline-body">
                                                {group.expr.map((e, ei) => (
                                                    <div key={ei} className="pipeline-rule font-mono text-sm">
                                                        <Icon
                                                            name={e.type === "filter" ? "filter_alt" : e.type === "calc" ? "calculate" : "arrow_right"}
                                                            className="text-on-surface-tertiary"
                                                            style={{ fontSize: "16px" }}
                                                        />
                                                        <span className="text-on-surface font-medium">{e.column}</span>
                                                        <span className="text-on-surface-tertiary">{e.type}</span>
                                                        {renderExpr(e)}
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </section>
                    )}

                    {/* Execution | Advanced — collapsible */}
                    <div className="flex flex-col lg:flex-row items-stretch gap-16">
                        <div className="flex-1 lg:min-w-0">
                            <section className="form-card collapse-card">
                                <button className="collapse-card-header" onClick={() => setExecOpen(!execOpen)}>
                                    <div className="flex items-center gap-8">
                                        <Icon name="bolt" className="text-primary" />
                                        <span className="collapse-card-summary">
                                            EXECUTION: {(jobDetail.startMode || "manual").toUpperCase()} / {jobDetail.queryLimit || 0} LIMIT
                                        </span>
                                    </div>
                                    <Icon name="keyboard_arrow_down" className={`collapse-card-toggle ${execOpen ? "collapse-card-toggle--open" : ""}`} />
                                </button>
                                {execOpen && (
                                    <div className="collapse-card-body">
                                        <div className="grid grid-cols-2 gap-16 mb-16">
                                            <Field label="Start Mode" value={jobDetail.startMode} />
                                            <Field label="On Save Failure" value={jobDetail.onSaveFailure} />
                                        </div>
                                        <div className="grid grid-cols-2 gap-16">
                                            <Field label="Query Limit" value={jobDetail.queryLimit} />
                                            <Field label="Poll Interval" value={`${jobDetail.pollIntervalMs}ms`} />
                                        </div>
                                    </div>
                                )}
                            </section>
                        </div>
                        <div className="flex-1 lg:min-w-0">
                            <section className="form-card collapse-card">
                                <button className="collapse-card-header" onClick={() => setAdvOpen(!advOpen)}>
                                    <div className="flex items-center gap-8">
                                        <Icon name="settings" className="text-on-surface-tertiary" />
                                        <span className="collapse-card-summary">
                                            ADVANCED: {jobDetail.integrity !== false ? "INTEGRITY ON" : "INTEGRITY OFF"} / RETRY {retry.maxAttempts || 0}
                                        </span>
                                    </div>
                                    <Icon name="keyboard_arrow_down" className={`collapse-card-toggle ${advOpen ? "collapse-card-toggle--open" : ""}`} />
                                </button>
                                {advOpen && (
                                    <div className="collapse-card-body">
                                        <div className="mb-16">
                                            <Field label="Integrity Check" value={jobDetail.integrity !== false ? "Enabled" : "Disabled"} />
                                        </div>
                                        <div className="grid grid-cols-3 gap-16">
                                            <Field label="Retry Max Attempts" value={retry.maxAttempts} />
                                            <Field label="Retry Base Delay" value={retry.baseDelayMs ? `${retry.baseDelayMs}ms` : null} />
                                            <Field label="Retry Max Delay" value={retry.maxDelayMs ? `${retry.maxDelayMs}ms` : null} />
                                        </div>
                                    </div>
                                )}
                            </section>
                        </div>
                    </div>

                    {/* Logging */}
                    {(() => {
                        const level = (logging.level || "info").toUpperCase();
                        const idx = LOG_LEVELS.indexOf(level);
                        const included = idx >= 0 ? LOG_LEVELS.slice(idx) : [];
                        return (
                            <div className="form-card log-compact">
                                <div className="form-card-header !mb-0">
                                    <Icon name="terminal" className="text-primary" />
                                    Logging Controls
                                </div>
                                <div className="flex flex-wrap items-center gap-32">
                                    <div className="flex flex-wrap items-center gap-12">
                                        <span className="form-label !mb-0">Log Level</span>
                                        <span
                                            className={`log-level-item level-${level.toLowerCase()} is-selected`}
                                            style={{ cursor: "default", pointerEvents: "none", borderRight: "none", borderRadius: "var(--radius-base)" }}
                                        >
                                            {level}
                                        </span>
                                        <span className="log-level-caption" style={{ fontSize: "var(--font-size-sm)", marginTop: 0 }}>
                                            {included.length > 0 ? (
                                                <>
                                                    Records{" "}
                                                    {included.map((lv, i) => (
                                                        <span key={lv} className={`log-level-tag level-${lv.toLowerCase()}`}>
                                                            {lv}
                                                            {i < included.length - 1 ? ", " : ""}
                                                        </span>
                                                    ))}{" "}
                                                    messages
                                                </>
                                            ) : (
                                                "—"
                                            )}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-12">
                                        <span className="form-label !mb-0">File Limit</span>
                                        <span className="text-sm text-on-surface font-mono font-semibold">{logging.maxFiles ?? "—"}</span>
                                        <button type="button" onClick={() => setLogFilesOpen(true)} className="btn btn-sm btn-primary tooltip" data-tooltip="View log files">
                                            <Icon name="folder_open" className="icon-sm" />
                                            <span>Log Files</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    <LiveLogs jobId={listJob.id} open={showLiveLogs} onClose={() => setShowLiveLogs(false)} />

                    {logFilesOpen && <LogFilesModal name={listJob.id} onClose={() => setLogFilesOpen(false)} />}

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
