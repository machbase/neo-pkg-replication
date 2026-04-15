import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import { useApp } from "../context/AppContext";
import * as jobsApi from "../api/jobs";
import useServers from "../hooks/useServers";
import Icon from "../components/common/Icon";
import { koToEn } from "../utils/korean";
import DatabaseSection from "../components/jobs/DatabaseSection";
import ColumnMapping, { TargetCondition } from "../components/jobs/ColumnMapping";
import ExecutionSection from "../components/jobs/ExecutionSection";
import AdvancedSection from "../components/jobs/AdvancedSection";
import LogSection from "../components/jobs/LogSection";
import PipelineBuilder from "../components/jobs/PipelineBuilder";

const DEFAULTS = {
    id: "",
    source: {
        server: "",
        table: "",
        columns: [],
        meta: [],
        rep_target_cond: { column: "", op: "ALL", value: [] },
        transform: [],
    },
    target: {
        server: "",
        table: "",
        columns: [],
        meta: [],
    },
    startMode: "full",
    ridAfter: "",
    queryLimit: 5000,
    pollIntervalMs: 1000,
    onSaveFailure: "continue",
    integrity: true,
    retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 30000 },
    logging: { level: "info", maxFiles: 10 },
};

export default function JobFormPage({ onRefresh }) {
    const { id } = useParams();
    const navigate = useNavigate();
    const { notify, fetchJobDetail, clearJobDetail } = useApp();
    const isEdit = Boolean(id);
    const { servers, addServer, refreshServers } = useServers();

    const [form, setForm] = useState(DEFAULTS);
    const [saving, setSaving] = useState(false);
    const [conflictJob, setConflictJob] = useState(null);
    const [dryRunWarnings, setDryRunWarnings] = useState(null);
    const [pendingConfig, setPendingConfig] = useState(null);

    const applyData = (data) => {
        setForm({
            ...DEFAULTS,
            ...data,
            id: data.name || data.id || id,
            source: { ...DEFAULTS.source, ...data.source },
            target: { ...DEFAULTS.target, ...data.target },
            retry: data.retry || DEFAULTS.retry,
            logging: { ...DEFAULTS.logging, ...(data.logging || {}) },
        });
    };

    useEffect(() => {
        if (isEdit) {
            fetchJobDetail(id).then((data) => {
                if (data) applyData(data);
                else navigate("/");
            });
        }
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

    const handleConflictAction = async (action) => {
        const name = conflictJob;
        setConflictJob(null);
        setSaving(true);
        try {
            if (action === "recover") {
                await jobsApi.recoverJob(name);
                notify("서비스 재등록 완료", "success");
            } else {
                await jobsApi.overwriteJob(name);
                notify("Config 재생성 완료", "success");
            }
            if (onRefresh) await onRefresh();
            clearJobDetail();
            goBack();
        } catch (e) {
            notify(e.reason || e.message, "error");
        } finally {
            setSaving(false);
        }
    };

    const buildConfig = () => {
        const name = form.id || null;
        const config = {
            id: name,
            source: {
                server: form.source.server,
                table: form.source.table,
                columns: Array.isArray(form.source.columns) ? form.source.columns : [],
                meta: Array.isArray(form.source.meta) ? form.source.meta : [],
                rep_target_cond: form.source.rep_target_cond || { column: "", op: "ALL", value: [] },
                transform: Array.isArray(form.source.transform) ? form.source.transform : [],
            },
            target: {
                server: form.target.server,
                table: form.target.table,
                columns: Array.isArray(form.target.columns) ? form.target.columns : [],
                meta: Array.isArray(form.target.meta) ? form.target.meta : [],
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
            if (!isEdit && e.data?.hasConfig === true && e.data?.installed === false) {
                notify(e.reason || e.message, "error");
                setConflictJob(form.id);
                return;
            }
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
                        <button type="submit" form="job-form" disabled={saving} className="btn btn-content btn-primary">
                            {saving ? "Saving..." : isEdit ? "Update Job" : "Create Job"}
                        </button>
                    </div>
                </div>
            </header>

            <div className="page-body">
                <div className="page-body-inner">
                    <form id="job-form" onSubmit={handleSubmit} onKeyDown={(e) => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") e.preventDefault(); }} className="space-y-16">
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
                            <DatabaseSection title="Source Database" prefix="source" form={form} update={update} servers={servers} onAddServer={addServer} onRefreshServers={refreshServers} />
                            <DatabaseSection title="Target Database" prefix="target" form={form} update={update} servers={servers} onAddServer={addServer} onRefreshServers={refreshServers} />
                        </div>

                        {/* Column Mapping */}
                        <ColumnMapping form={form} update={update} />

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
                </div>
            </div>

            {conflictJob && (
                <div className="modal-overlay" onMouseDown={() => setConflictJob(null)}>
                    <div className="modal modal-md" onMouseDown={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <div className="modal-header-title">
                                <Icon name="error" className="text-warning" />
                                Job Conflict
                            </div>
                            <button onClick={() => setConflictJob(null)} className="p-4 hover:bg-surface-hover rounded-base tooltip" data-tooltip="Close">
                                <Icon name="close" />
                            </button>
                        </div>
                        <div className="modal-body">
                            <p>기존 설정 파일이 존재하지만 서비스가 등록되어 있지 않습니다.</p>
                            <p className="mt-8 text-on-surface-tertiary">아래 옵션 중 하나를 선택하세요.</p>
                        </div>
                        <div className="modal-footer">
                            <button onClick={() => setConflictJob(null)} className="btn btn-content btn-ghost">
                                Cancel
                            </button>
                            <button onClick={() => handleConflictAction("recover")} disabled={saving} className="btn btn-content btn-primary">
                                서비스 재등록
                            </button>
                            <button onClick={() => handleConflictAction("overwrite")} disabled={saving} className="btn btn-content btn-danger">
                                Config 재생성
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {dryRunWarnings && (
                <div className="modal-overlay" onMouseDown={() => { setDryRunWarnings(null); setPendingConfig(null); }}>
                    <div className="modal modal-md" onMouseDown={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <div className="modal-header-title">
                                <Icon name="warning" className="text-warning" />
                                Validation Warnings
                            </div>
                            <button onClick={() => { setDryRunWarnings(null); setPendingConfig(null); }} className="p-4 hover:bg-surface-hover rounded-base tooltip" data-tooltip="Close">
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
                            <button onClick={() => { setDryRunWarnings(null); setPendingConfig(null); }} className="btn btn-content btn-ghost">
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
