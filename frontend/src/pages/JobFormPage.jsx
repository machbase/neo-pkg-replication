import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import { useApp } from "../context/AppContext";
import * as jobsApi from "../api/jobs";
import useServers from "../hooks/useServers";
import Icon from "../components/common/Icon";
import { koToEn } from "../utils/korean";
import { validateMqttTopic } from "../utils/mqttTopic";
import DatabaseSection from "../components/jobs/DatabaseSection";
import ColumnMapping, { TargetCondition } from "../components/jobs/ColumnMapping";
import ExecutionSection from "../components/jobs/ExecutionSection";
import AdvancedSection from "../components/jobs/AdvancedSection";
import LogSection from "../components/jobs/LogSection";
import PipelineBuilder from "../components/jobs/PipelineBuilder";

// backend의 null 배열을 UI가 기대하는 빈 배열로 정규화
function normalizeDefaults(cfg) {
    if (!cfg) return cfg;
    const source = cfg.source || {};
    const target = cfg.target || {};
    return {
        ...cfg,
        id: cfg.id ?? "",
        ridAfter: cfg.ridAfter ?? "",
        integrity: cfg.integrity !== false,
        source: {
            ...source,
            columns: Array.isArray(source.columns) ? source.columns : [],
            meta: Array.isArray(source.meta) ? source.meta : [],
            rep_target_cond: source.rep_target_cond || { column: "", op: "ALL", value: [] },
            transform: Array.isArray(source.transform) ? source.transform : [],
        },
        target: {
            ...target,
            columns: Array.isArray(target.columns) ? target.columns : [],
            meta: Array.isArray(target.meta) ? target.meta : [],
        },
    };
}

export default function JobFormPage({ onRefresh }) {
    const { id } = useParams();
    const navigate = useNavigate();
    const { notify, fetchJobDetail, clearJobDetail } = useApp();
    const isEdit = Boolean(id);
    const { servers, addServer, refreshServers } = useServers();

    const [defaults, setDefaults] = useState(null);
    const [guide, setGuide] = useState(null);
    const [form, setForm] = useState(null);
    const [saving, setSaving] = useState(false);
    const [dryRunWarnings, setDryRunWarnings] = useState(null);
    const [pendingConfig, setPendingConfig] = useState(null);

    const applyData = (data, base) => {
        const d = base || defaults;
        if (!d) return;
        setForm({
            ...d,
            ...data,
            id: data.name || data.id || id,
            source: { ...d.source, ...data.source },
            target: { ...d.target, ...data.target },
            retry: data.retry || d.retry,
            logging: { ...d.logging, ...(data.logging || {}) },
        });
    };

    // 최초 마운트 시 기본 템플릿 로드 + edit 모드면 기존 데이터 병합
    useEffect(() => {
        let cancelled = false;
        jobsApi
            .getRcDefault()
            .then((res) => {
                if (cancelled) return;
                const d = normalizeDefaults(res?.config);
                setDefaults(d);
                setGuide(res?.guide || null);
                if (isEdit) {
                    fetchJobDetail(id).then((data) => {
                        if (cancelled) return;
                        if (data) applyData(data, d);
                        else navigate("/");
                    });
                } else {
                    setForm(d);
                }
            })
            .catch((e) => {
                if (!cancelled) notify(e.reason || e.message, "error");
            });
        return () => {
            cancelled = true;
        };
    }, [id, isEdit]);

    const goBack = () => {
        navigate("/");
    };

    const update = (path, value) => {
        setForm((prev) => {
            const next = { ...prev };
            const keys = path.split(".");
            let obj = next;
            for (let i = 0; i < keys.length - 1; i++) {
                obj[keys[i]] = { ...obj[keys[i]] };
                obj = obj[keys[i]];
            }
            obj[keys[keys.length - 1]] = value;
            return next;
        });
    };

    const buildConfig = () => {
        const name = form.id || null;
        // source/target mapping 길이를 max 기준으로 맞추고 trailing null 로 padding
        // — backend validator 가 양쪽 length 일치 + trailing null 만 허용
        const alignPair = (a, b) => {
            const src = Array.isArray(a) ? a : [];
            const tgt = Array.isArray(b) ? b : [];
            const len = Math.max(src.length, tgt.length);
            const pad = (arr) => Array.from({ length: len }, (_, i) => arr[i] ?? null);
            return [pad(src), pad(tgt)];
        };
        const [srcColumns, tgtColumns] = alignPair(form.source.columns, form.target.columns);
        const [srcMeta, tgtMeta] = alignPair(form.source.meta, form.target.meta);
        const config = {
            id: name,
            source: {
                server: form.source.server,
                table: form.source.table,
                columns: srcColumns,
                meta: srcMeta,
                rep_target_cond: form.source.rep_target_cond || { column: "", op: "ALL", value: [] },
                transform: Array.isArray(form.source.transform) ? form.source.transform : [],
            },
            target: {
                server: form.target.server,
                table: form.target.table,
                columns: tgtColumns,
                meta: tgtMeta,
            },
            startMode: form.startMode,
            queryLimit: Number(form.queryLimit),
            pollIntervalMs: Number(form.pollIntervalMs),
            onSaveFailure: form.onSaveFailure,
            integrity: form.integrity !== false,
            retry: form.retry
                ? {
                      maxAttempts: Number(form.retry.maxAttempts),
                      baseDelayMs: Number(form.retry.baseDelayMs),
                      maxDelayMs: Number(form.retry.maxDelayMs),
                  }
                : null,
            logging: {
                level: form.logging?.level || "info",
                maxFiles: Number(form.logging?.maxFiles ?? 10),
            },
        };
        if (form.startMode === "ridAfter") {
            config.ridAfter = Number(form.ridAfter);
        }
        return { name, config };
    };

    const persistConfig = async ({ name, config }) => {
        if (isEdit) {
            await jobsApi.updateJob(id, config);
            notify(`Job '${id}' updated`, "success");
        } else {
            await jobsApi.createJob({ name, config });
            notify(`Job created`, "success");
        }
        if (onRefresh) await onRefresh();
        clearJobDetail();
        goBack();
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        const targetServerMeta = servers.find((s) => s.name === form?.target?.server);
        if (targetServerMeta?.type === "mqtt-publish") {
            const { valid, error } = validateMqttTopic(form?.target?.table ?? "");
            if (!valid) {
                notify(error, "error");
                return;
            }
        }
        setSaving(true);
        try {
            const built = buildConfig();
            // dry-run 사전 검증
            const result = await jobsApi.dryRunJob(built.config);
            if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
                // 경고가 있으면 사용자 확인 후 진행
                setDryRunWarnings(result.warnings);
                setPendingConfig(built);
                setSaving(false);
                return;
            }
            await persistConfig(built);
        } catch (e) {
            notify(e.reason || e.message, "error");
        } finally {
            setSaving(false);
        }
    };

    const confirmWarningsAndSave = async () => {
        const built = pendingConfig;
        setDryRunWarnings(null);
        setPendingConfig(null);
        setSaving(true);
        try {
            await persistConfig(built);
        } catch (e) {
            notify(e.reason || e.message, "error");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="page">
            <header className="page-header">
                <div className="page-header-inner">
                    <div className="flex items-center gap-8">
                        <button onClick={goBack} className="p-4 hover:bg-surface-hover rounded-base transition-colors shrink-0 tooltip" data-tooltip="Back">
                            <Icon name="arrow_back" />
                        </button>
                        <h2 className="page-title truncate">{isEdit ? "Edit Job" : "New Replication Job"}</h2>
                    </div>
                    <div className="flex gap-8 shrink-0">
                        <button type="button" onClick={goBack} className="btn btn-content btn-ghost">
                            Cancel
                        </button>
                        <button type="submit" form="job-form" disabled={saving || !form} className="btn btn-content btn-primary">
                            {saving ? "Saving..." : isEdit ? "Update Job" : "Create Job"}
                        </button>
                    </div>
                </div>
            </header>

            <div className="page-body">
                <div className="page-body-inner">
                    {!form ? (
                        <p className="text-on-surface-tertiary text-base py-8">Loading...</p>
                    ) : (
                        <form
                            id="job-form"
                            onSubmit={handleSubmit}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") e.preventDefault();
                            }}
                            className="space-y-16"
                        >
                            {/* Job name */}
                            <div className="form-card">
                                <div className="form-card-header">Job</div>
                                <div>
                                    <label className="form-label">name</label>
                                    <input
                                        type="text"
                                        disabled={isEdit}
                                        value={form.id}
                                        onChange={(e) => {
                                            const v = koToEn(e.target.value).replace(/[^a-zA-Z0-9_-]/g, "");
                                            update("id", v);
                                        }}
                                        pattern="^[a-zA-Z0-9_-]*$"
                                        className="w-full disabled:opacity-50"
                                        placeholder="Auto-generated from table names if empty"
                                    />
                                </div>
                            </div>

                            {/* Source / Target Database — side by side */}
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-16">
                                <DatabaseSection
                                    title="Source Database"
                                    prefix="source"
                                    form={form}
                                    update={update}
                                    servers={servers}
                                    onAddServer={addServer}
                                    onRefreshServers={refreshServers}
                                    isEdit={isEdit}
                                />
                                <DatabaseSection
                                    title="Target Database"
                                    prefix="target"
                                    form={form}
                                    update={update}
                                    servers={servers}
                                    onAddServer={addServer}
                                    onRefreshServers={refreshServers}
                                    isEdit={isEdit}
                                />
                            </div>

                            {/* Column Mapping */}
                            <ColumnMapping form={form} update={update} servers={servers} />

                            {/* Replication Target Condition */}
                            <div className="form-card">
                                <div className="form-card-header">
                                    <span className="flex items-center gap-8">
                                        <Icon name="filter_alt" className="text-primary" />
                                        Replication Target Condition
                                    </span>
                                </div>
                                <TargetCondition form={form} update={update} />
                            </div>

                            {/* Data Pipeline Builder */}
                            <PipelineBuilder form={form} update={update} />

                            {/* Execution / Advanced */}
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-16">
                                <ExecutionSection form={form} update={update} />
                                <AdvancedSection form={form} update={update} />
                            </div>

                            {/* Logging */}
                            <LogSection form={form} update={update} />
                        </form>
                    )}
                </div>
            </div>

            {dryRunWarnings && (
                <div
                    className="modal-overlay"
                    onMouseDown={() => {
                        setDryRunWarnings(null);
                        setPendingConfig(null);
                    }}
                >
                    <div className="modal modal-md" onMouseDown={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <div className="modal-header-title">
                                <Icon name="warning" className="text-warning" />
                                Validation Warnings
                            </div>
                            <button
                                onClick={() => {
                                    setDryRunWarnings(null);
                                    setPendingConfig(null);
                                }}
                                className="p-4 hover:bg-surface-hover rounded-base tooltip"
                                data-tooltip="Close"
                            >
                                <Icon name="close" />
                            </button>
                        </div>
                        <div className="modal-body">
                            <p className="mb-8 text-on-surface-secondary">다음 경고가 확인되었습니다. 그래도 저장하시겠습니까?</p>
                            <ul className="space-y-2">
                                {dryRunWarnings.map((w, i) => (
                                    <li key={i} className="flex items-start gap-8">
                                        <Icon name="warning" className="text-warning icon-sm shrink-0 mt-2" />
                                        <span className="text-sm">{w}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <div className="modal-footer">
                            <button
                                onClick={() => {
                                    setDryRunWarnings(null);
                                    setPendingConfig(null);
                                }}
                                className="btn btn-content btn-ghost"
                            >
                                Cancel
                            </button>
                            <button onClick={confirmWarningsAndSave} disabled={saving} className="btn btn-content btn-primary">
                                Save Anyway
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
