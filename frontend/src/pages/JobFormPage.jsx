import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import { useApp } from "../context/AppContext";
import * as jobsApi from "../api/jobs";
import Icon from "../components/common/Icon";
import SourceSection from "../components/jobs/SourceSection";
import TargetSection from "../components/jobs/TargetSection";
import ExecutionSection from "../components/jobs/ExecutionSection";
import AdvancedSection from "../components/jobs/AdvancedSection";

const DEFAULTS = {
    id: "",
    source: { host: "127.0.0.1", port: 5656, user: "SYS", password: "", table: "", columns: null, filter: null, transform: null },
    target: { host: "", port: 5656, user: "SYS", password: "", table: "", autoCreate: false },
    startMode: "full",
    ridAfter: "",
    queryLimit: 5000,
    ridRangeSize: 50000,
    pollIntervalMs: 1000,
    shutdownTimeoutMs: 30000,
    onSaveFailure: "continue",
    integrity: null,
    retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 30000 },
    logging: { level: "info", stdout: true, file: { enabled: false, directory: "${CWD}/logs" } },
};

export default function JobFormPage({ onRefresh }) {
    const { id } = useParams();
    const navigate = useNavigate();
    const { notify, fetchJobDetail, clearJobDetail } = useApp();
    const isEdit = Boolean(id);

    const [form, setForm] = useState(DEFAULTS);
    const [saving, setSaving] = useState(false);
    const [conflictJob, setConflictJob] = useState(null);

    const applyData = (data) => {
        setForm({
            ...DEFAULTS,
            ...data,
            id: data.name || data.id || id,
            source: { ...DEFAULTS.source, ...data.source },
            target: { ...DEFAULTS.target, ...data.target },
            retry: data.retry || DEFAULTS.retry,
            logging: data.logging ? { ...DEFAULTS.logging, ...data.logging, file: { ...DEFAULTS.logging.file, ...data.logging?.file } } : DEFAULTS.logging,
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
        setForm((prev) => ({
            ...prev,
            source: { ...prev.source, password: "" },
            target: { ...prev.target, password: "" },
        }));
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

    const handleSubmit = async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
            const name = form.id || null;
            const config = {
                id: name,
                source: {
                    host: form.source.host,
                    port: Number(form.source.port),
                    user: form.source.user,
                    password: form.source.password,
                    table: form.source.table,
                    columns: form.target.autoCreate ? null : form.source.columns?.length ? form.source.columns : null,
                    filter: form.target.autoCreate ? null : form.source.filter?.length ? form.source.filter : null,
                    transform: form.target.autoCreate ? null : form.source.transform?.length ? form.source.transform : null,
                },
                target: {
                    ...form.target,
                    port: Number(form.target.port),
                },
                startMode: form.startMode,
                queryLimit: Number(form.queryLimit),
                ridRangeSize: Number(form.ridRangeSize),
                pollIntervalMs: Number(form.pollIntervalMs),
                shutdownTimeoutMs: Number(form.shutdownTimeoutMs),
                onSaveFailure: form.onSaveFailure,
                integrity: form.integrity,
                retry: form.retry
                    ? {
                          ...form.retry,
                          maxAttempts: Number(form.retry.maxAttempts),
                          baseDelayMs: Number(form.retry.baseDelayMs),
                          maxDelayMs: Number(form.retry.maxDelayMs),
                      }
                    : null,
                logging: form.logging,
            };
            if (form.startMode === "ridAfter") {
                config.ridAfter = Number(form.ridAfter);
            }

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
                    <form id="job-form" onSubmit={handleSubmit}>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            {/* Left column: Identity / Execution / Advanced */}
                            <div className="space-y-4">
                                <div className="form-card">
                                    <div className="form-card-header">
                                        <Icon name="badge" className="text-primary" />
                                        Job Identity
                                    </div>
                                    <div>
                                        <label className="form-label">Job ID</label>
                                        <input
                                            type="text"
                                            disabled={isEdit}
                                            value={form.id}
                                            onChange={(e) => update("id", e.target.value)}
                                            className="w-full disabled:opacity-50"
                                            placeholder="Auto-generated from table names if empty"
                                        />
                                    </div>
                                </div>

                                <ExecutionSection form={form} update={update} />
                                <AdvancedSection form={form} update={update} />
                            </div>

                            {/* Right column: Source / Target Database */}
                            <div className="space-y-4">
                                <SourceSection form={form} update={update} isEdit={isEdit} />
                                <TargetSection form={form} update={update} />
                            </div>
                        </div>
                    </form>
                </div>
            </div>

            {conflictJob && (
                <div className="modal-overlay" onClick={() => setConflictJob(null)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-title">Job Conflict</div>
                        <div className="modal-body">
                            <p>기존 설정 파일이 존재하지만 서비스가 등록되어 있지 않습니다.</p>
                            <p className="mt-8 text-secondary">아래 옵션 중 하나를 선택하세요.</p>
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
        </div>
    );
}
