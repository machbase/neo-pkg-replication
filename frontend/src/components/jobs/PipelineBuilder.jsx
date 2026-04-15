import { useState, useEffect, useRef } from "react";
import Icon from "../common/Icon";
import * as jobsApi from "../../api/jobs";

const STRING_TYPES = new Set(["VARCHAR", "TEXT", "NAME", "CHAR"]);
const NUMERIC_TYPES = new Set(["SHORT", "INTEGER", "LONG", "FLOAT", "DOUBLE", "USHORT", "UINTEGER", "ULONG", "BIGINT", "NUMERIC"]);

const getCategory = (type) => {
    const base = String(type || "").toUpperCase().match(/^[A-Z_]+/)?.[0] || "";
    if (STRING_TYPES.has(base)) return "string";
    if (NUMERIC_TYPES.has(base)) return "numeric";
    return null;
};

const MODE_BY_CATEGORY = {
    string: ["prefix", "suffix"],
    numeric: ["calc", "filter"],
};

/**
 * source.transform: [{ criteria: {column, op, value[]}, expr: [{column, type, value/bias/multiplier/min/max}] }]
 *
 * expr.type:
 *   prefix | suffix — string
 *   calc   — numeric: { column, type: 'calc', bias, multiplier }
 *   filter — numeric: { column, type: 'filter', min, max }
 */
export default function PipelineBuilder({ form, update }) {
    const blocks = Array.isArray(form.source?.transform) ? form.source.transform : [];
    const [columnsMeta, setColumnsMeta] = useState([]);

    // source 컬럼 타입 정보 조회 — PipelineBuilder는 column 타입으로 mode 분기
    const sourceServer = form.source?.server;
    const sourceTable = form.source?.table;
    useEffect(() => {
        if (!sourceServer || !sourceTable) {
            setColumnsMeta([]);
            return;
        }
        let cancelled = false;
        jobsApi.fetchTableColumns({ server: sourceServer, table: sourceTable })
            .then((data) => {
                if (cancelled) return;
                setColumnsMeta(data?.columns ?? []);
            })
            .catch(() => { if (!cancelled) setColumnsMeta([]); });
        return () => { cancelled = true; };
    }, [sourceServer, sourceTable]);

    // 소스 테이블 변경 감지: Data Pipeline 전체 비우기
    // Pipeline은 source columnsMeta에만 의존하므로 source만 추적
    // 소스 테이블이 실제로 세팅된 이후부터 추적 시작 (edit flow 초기 빈 값 → 실 데이터 전환을
    // "변경"으로 오인해 pipeline을 지우는 것 방지)
    const prevTableRef = useRef(null);
    useEffect(() => {
        if (!sourceServer || !sourceTable) return;
        const key = `${sourceServer}/${sourceTable}`;
        if (prevTableRef.current === null) {
            prevTableRef.current = key;
            return;
        }
        if (prevTableRef.current === key) return;
        prevTableRef.current = key;

        if (blocks.length === 0) return;
        update("source.transform", []);
    }, [sourceServer, sourceTable]); // eslint-disable-line react-hooks/exhaustive-deps

    // criteria 컬럼은 Replication Target Condition의 값을 그대로 따라간다
    const condColumn = form.source?.rep_target_cond?.column || "";

    // rep_target_cond.column 이 바뀌면 모든 block의 criteria.column을 동기화
    useEffect(() => {
        if (blocks.length === 0) return;
        let changed = false;
        const next = blocks.map((b) => {
            if (b.criteria?.column !== condColumn) {
                changed = true;
                return { ...b, criteria: { ...b.criteria, column: condColumn } };
            }
            return b;
        });
        if (changed) update("source.transform", next);
    }, [condColumn]); // eslint-disable-line react-hooks/exhaustive-deps

    const setBlocks = (next) => update("source.transform", next);

    const addBlock = () => setBlocks([
        ...blocks,
        {
            criteria: { column: condColumn, op: "ALL", value: [] },
            expr: [],
        },
    ]);

    const removeBlock = (idx) => setBlocks(blocks.filter((_, i) => i !== idx));

    const updateBlock = (idx, updater) => {
        setBlocks(blocks.map((b, i) => (i === idx ? updater(b) : b)));
    };

    // --- Criteria helpers ---
    const updateCriteria = (idx, field, value) =>
        updateBlock(idx, (b) => ({ ...b, criteria: { ...b.criteria, [field]: value } }));

    const addCriteriaTag = (idx, raw) => {
        const newVals = raw.split(/[\s,]+/).filter(Boolean);
        if (!newVals.length) return;
        updateBlock(idx, (b) => {
            const existing = Array.isArray(b.criteria.value) ? b.criteria.value : [];
            return { ...b, criteria: { ...b.criteria, value: [...existing, ...newVals.filter((v) => !existing.includes(v))] } };
        });
    };

    const removeCriteriaTag = (idx, tag) =>
        updateBlock(idx, (b) => ({ ...b, criteria: { ...b.criteria, value: (b.criteria.value || []).filter((v) => v !== tag) } }));

    // --- Expression helpers ---
    const addExpression = (idx) =>
        updateBlock(idx, (b) => ({ ...b, expr: [...(b.expr || []), { column: "", type: "", value: "", bias: "", multiplier: "", min: "", max: "" }] }));

    const removeExpression = (idx, exprIdx) =>
        updateBlock(idx, (b) => ({ ...b, expr: (b.expr || []).filter((_, i) => i !== exprIdx) }));

    const updateExpression = (idx, exprIdx, field, value) =>
        updateBlock(idx, (b) => ({
            ...b,
            expr: (b.expr || []).map((e, i) => {
                if (i !== exprIdx) return e;
                const next = { ...e, [field]: value };
                if (field === "column") {
                    const col = columnsMeta.find((c) => c.name === value);
                    const cat = col ? getCategory(col.type) : null;
                    const modes = cat ? MODE_BY_CATEGORY[cat] : [];
                    next.type = modes.length ? modes[0] : "";
                    next.value = ""; next.bias = ""; next.multiplier = ""; next.min = ""; next.max = "";
                }
                if (field === "type") {
                    next.value = ""; next.bias = ""; next.multiplier = ""; next.min = ""; next.max = "";
                }
                return next;
            }),
        }));

    const getColumnCategory = (colName) => {
        const col = columnsMeta.find((c) => c.name === colName);
        return col ? getCategory(col.type) : null;
    };

    const [inputValues, setInputValues] = useState({}); // idx → string

    return (
        <div className="form-card">
            <div className="form-card-header">
                <span className="flex items-center gap-8">
                    <Icon name="account_tree" className="text-primary" />
                    Data Pipeline Builder
                </span>
                <button type="button" className="btn btn-sm btn-primary ml-auto" onClick={addBlock}>
                    + Add Criteria Block
                </button>
            </div>

            {columnsMeta.length === 0 && (
                <div className="text-xs text-on-surface-tertiary mb-8">
                    TAG name 기준 조건은 prefix/suffix 적용 전 원본 name 기준으로 매칭됩니다.
                </div>
            )}

            <div className="pb-blocks">
                {blocks.length === 0 && (
                    <div className="text-sm text-on-surface-tertiary py-8">No transform rules. Click "Add Criteria Block" to add one.</div>
                )}
                {blocks.map((block, idx) => {
                    const criteria = block.criteria || { column: condColumn, op: "ALL", value: [] };
                    const op = criteria.op || "ALL";
                    const values = Array.isArray(criteria.value) ? criteria.value : [];
                    const inputValue = inputValues[idx] || "";

                    return (
                        <div key={idx} className="pb-block">
                            <div className="pb-timeline">
                                <div className="pb-dot" />
                                {(block.expr || []).length > 0 && <div className="pb-line" />}
                            </div>

                            <div className="pb-block-body">
                                {/* Criteria row */}
                                <div className="pb-expr">
                                    <select
                                        className="pb-select"
                                        value={condColumn}
                                        disabled
                                        title="Follows Replication Target Condition column"
                                    >
                                        {condColumn
                                            ? <option value={condColumn}>{condColumn}</option>
                                            : <option value="">—</option>}
                                    </select>

                                    <select
                                        className="pb-select pb-select--op"
                                        value={op}
                                        onChange={(e) => { updateCriteria(idx, "op", e.target.value); updateCriteria(idx, "value", []); }}
                                    >
                                        <option value="ALL">ALL</option>
                                        <option value="IN">IN</option>
                                        <option value="LIKE">LIKE</option>
                                    </select>

                                    {op === "ALL" ? (
                                        <input className="pb-text-input" type="text" placeholder="All values matched" disabled />
                                    ) : op === "IN" ? (
                                        <div className="pb-tags" onClick={(e) => e.currentTarget.querySelector("input")?.focus()}>
                                            {values.map((tag) => (
                                                <span key={tag} className="pb-tag">
                                                    <span>{tag}</span>
                                                    <button type="button" className="pb-tag-x" onClick={() => removeCriteriaTag(idx, tag)}>×</button>
                                                </span>
                                            ))}
                                            <input
                                                className="pb-tag-input"
                                                type="text"
                                                placeholder={values.length ? "" : "Add values..."}
                                                value={inputValue}
                                                onChange={(e) => setInputValues((prev) => ({ ...prev, [idx]: e.target.value }))}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter" || e.key === "," || e.key === " ") {
                                                        e.preventDefault();
                                                        addCriteriaTag(idx, inputValue);
                                                        setInputValues((prev) => ({ ...prev, [idx]: "" }));
                                                    }
                                                    if (e.key === "Backspace" && !inputValue && values.length) {
                                                        removeCriteriaTag(idx, values[values.length - 1]);
                                                    }
                                                }}
                                                onBlur={() => {
                                                    addCriteriaTag(idx, inputValue);
                                                    setInputValues((prev) => ({ ...prev, [idx]: "" }));
                                                }}
                                            />
                                        </div>
                                    ) : (
                                        <input
                                            className="pb-text-input"
                                            type="text"
                                            placeholder="%keyword%"
                                            value={values[0] || ""}
                                            onChange={(e) => updateCriteria(idx, "value", [e.target.value])}
                                        />
                                    )}

                                    <button type="button" className="pb-remove" onClick={() => removeBlock(idx)}>
                                        <Icon name="delete" style={{ fontSize: "16px" }} />
                                    </button>
                                </div>

                                {/* Expressions */}
                                {(block.expr || []).map((expr, exprIdx) => {
                                    const cat = getColumnCategory(expr.column);
                                    const modes = cat ? MODE_BY_CATEGORY[cat] : [];

                                    return (
                                        <div key={exprIdx} className="pb-expr pb-expr--sub">
                                            <select
                                                className={`pb-select${expr.column ? "" : " pb-select--empty"}`}
                                                value={expr.column || ""}
                                                onChange={(e) => updateExpression(idx, exprIdx, "column", e.target.value)}
                                            >
                                                <option value="" disabled>Select column...</option>
                                                {columnsMeta.filter((c) => getCategory(c.type)).map((c) => (
                                                    <option key={c.name} value={c.name}>{c.name}</option>
                                                ))}
                                            </select>

                                            <select
                                                className="pb-select pb-select--op"
                                                value={expr.type || ""}
                                                onChange={(e) => updateExpression(idx, exprIdx, "type", e.target.value)}
                                                disabled={!modes.length}
                                            >
                                                {!modes.length && <option value="">--</option>}
                                                {modes.map((m) => (
                                                    <option key={m} value={m}>{m}</option>
                                                ))}
                                            </select>

                                            {expr.type === "filter" && (
                                                <div className="pb-dual-input">
                                                    <div className="pb-input-addon">
                                                        <span className="pb-addon-label">Min ≥</span>
                                                        <input type="number" placeholder="min" value={expr.min} onChange={(e) => updateExpression(idx, exprIdx, "min", e.target.value)} />
                                                    </div>
                                                    <div className="pb-input-addon">
                                                        <span className="pb-addon-label">Max ≤</span>
                                                        <input type="number" placeholder="max" value={expr.max} onChange={(e) => updateExpression(idx, exprIdx, "max", e.target.value)} />
                                                    </div>
                                                </div>
                                            )}
                                            {expr.type === "calc" && (
                                                <div className="pb-dual-input">
                                                    <div className="pb-input-addon">
                                                        <span className="pb-addon-label">Bias</span>
                                                        <input type="number" placeholder="bias" value={expr.bias} onChange={(e) => updateExpression(idx, exprIdx, "bias", e.target.value)} />
                                                    </div>
                                                    <div className="pb-input-addon">
                                                        <span className="pb-addon-label">Multiplier</span>
                                                        <input type="number" placeholder="multiplier" value={expr.multiplier} onChange={(e) => updateExpression(idx, exprIdx, "multiplier", e.target.value)} />
                                                    </div>
                                                </div>
                                            )}
                                            {expr.type === "prefix" && (
                                                <div className="pb-input-addon" style={{ flex: 1 }}>
                                                    <span className="pb-addon-label">Prefix</span>
                                                    <input type="text" placeholder="prefix..." value={expr.value} onChange={(e) => updateExpression(idx, exprIdx, "value", e.target.value)} />
                                                </div>
                                            )}
                                            {expr.type === "suffix" && (
                                                <div className="pb-input-addon" style={{ flex: 1 }}>
                                                    <span className="pb-addon-label">Suffix</span>
                                                    <input type="text" placeholder="suffix..." value={expr.value} onChange={(e) => updateExpression(idx, exprIdx, "value", e.target.value)} />
                                                </div>
                                            )}
                                            {!expr.type && (
                                                <input className="pb-text-input" type="text" placeholder="Select column first..." disabled />
                                            )}

                                            <button type="button" className="pb-remove" onClick={() => removeExpression(idx, exprIdx)}>
                                                <span>×</span>
                                            </button>
                                        </div>
                                    );
                                })}

                                <button type="button" className="pb-add-expr" style={{ marginLeft: "var(--spacing-32)" }} onClick={() => addExpression(idx)}>
                                    + Add Expression
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
