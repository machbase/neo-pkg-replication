import { useState, useEffect, useRef } from "react";
import Icon from "../common/Icon";
import * as jobsApi from "../../api/jobs";
import { useApp } from "../../context/AppContext";

const displayType = (t) => {
    if (!t) return null;
    const upper = String(t).toUpperCase();
    if (upper === "TIMESTAMP") return "DATETIME";
    if (upper === "NUMERIC") return "NUMBER";
    return upper;
};

const normalizeBase = (base) => {
    if (base === "TIMESTAMP") return "DATETIME";
    if (base === "NUMERIC") return "NUMBER";
    return base;
};

const parseType = (t) => {
    if (!t) return null;
    const s = String(t).toUpperCase();
    const m = s.match(/^([A-Z_]+)(?:\((\d+)\))?/);
    if (!m) return { base: s, size: null };
    return { base: normalizeBase(m[1]), size: m[2] ? Number(m[2]) : null };
};

const compareTypes = (src, tgt) => {
    if (!src || !tgt) return "none";
    const a = parseType(src);
    const b = parseType(tgt);
    if (!a || !b) return "none";
    if (a.base !== b.base) return "error";
    if (a.size != null && b.size != null && a.size !== b.size) return "warning";
    return "ok";
};

function ColumnFlags({ col }) {
    if (!col) return null;
    return (
        <>
            {col.isPrimary && <span className="col-flag-badge col-flag-badge--pk">pk</span>}
            {col.isBasetime && <span className="col-flag-badge col-flag-badge--basetime">basetime</span>}
            {col.isSummarized && <span className="col-flag-badge col-flag-badge--summarized">summarized</span>}
        </>
    );
}

/**
 * TargetCondition
 *   form.source.rep_target_cond = { column, op, value[] }
 *   op: ALL | IN | LIKE
 *   value: string[]  (ALL이면 빈 배열)
 */
export function TargetCondition({ form, update }) {
    const { notify } = useApp();
    const cond = form.source.rep_target_cond || { column: "", op: "ALL", value: [] };
    const column = cond.column || "";
    const operator = cond.op || "ALL";
    const values = Array.isArray(cond.value) ? cond.value : [];
    const [inputValue, setInputValue] = useState("");
    const [likeValue, setLikeValue] = useState(operator === "LIKE" && values.length ? values[0] : "");
    const [sourceCols, setSourceCols] = useState([]);

    const sourceServer = form.source?.server;
    const sourceTable = form.source?.table;

    // 소스 테이블의 실제 컬럼 조회 (테이블 변경 시 자동 refetch)
    useEffect(() => {
        if (!sourceServer || !sourceTable) {
            setSourceCols([]);
            return;
        }
        let cancelled = false;
        jobsApi
            .fetchTableColumns({ server: sourceServer, table: sourceTable })
            .then((data) => {
                if (!cancelled) setSourceCols(data?.columns ?? []);
            })
            .catch((e) => {
                if (!cancelled) notify(e.reason || e.message, "error");
            });
        return () => {
            cancelled = true;
        };
    }, [sourceServer, sourceTable, notify]);

    // primary 컬럼이 있으면 그걸로 고정, 없으면 VARCHAR 타입만 허용
    const primaryCol = sourceCols.find((c) => c.isPrimary);
    const isVarchar = (t) =>
        String(t || "")
            .toUpperCase()
            .startsWith("VARCHAR");
    const columnOptions = primaryCol ? [primaryCol.name] : sourceCols.filter((c) => isVarchar(c.type)).map((c) => c.name);
    const isLocked = !!primaryCol;

    const setCond = (next) => update("source.rep_target_cond", next);

    // 현재 선택값이 columnOptions에 없으면 0번째로 리셋 (테이블 변경 등)
    useEffect(() => {
        if (columnOptions.length === 0) return;
        if (!columnOptions.includes(column)) {
            setCond({ column: columnOptions[0], op: operator, value: isLocked ? values : [] });
        }
    }, [sourceCols]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleColumnChange = (e) => {
        setCond({ column: e.target.value, op: operator, value: values });
    };

    const handleOpChange = (e) => {
        const nextOp = e.target.value;
        setCond({ column, op: nextOp, value: [] });
        setInputValue("");
        setLikeValue("");
    };

    const addTag = () => {
        const raw = inputValue.trim();
        if (!raw) return;
        const newVals = raw.split(/[\s,]+/).filter((v) => v && !values.includes(v));
        if (newVals.length) setCond({ column, op: operator, value: [...values, ...newVals] });
        setInputValue("");
    };

    const removeTag = (tag) => {
        setCond({ column, op: operator, value: values.filter((v) => v !== tag) });
    };

    const handleKeyDown = (e) => {
        if (e.key === "Enter" || e.key === "," || e.key === " ") {
            e.preventDefault();
            addTag();
        }
        if (e.key === "Backspace" && !inputValue.length && values.length) {
            setCond({ column, op: operator, value: values.slice(0, -1) });
        }
    };

    const handleLikeBlur = () => {
        const v = likeValue.trim();
        setCond({ column, op: operator, value: v ? [v] : [] });
    };

    return (
        <div className="target-cond-row">
            <select
                className="target-cond-select"
                value={column}
                onChange={handleColumnChange}
                disabled={isLocked || columnOptions.length === 0}
                title={isLocked ? "Locked to primary column" : undefined}
            >
                {columnOptions.length === 0 && (
                    <option value="" disabled>
                        -
                    </option>
                )}
                {columnOptions.map((c) => (
                    <option key={c} value={c}>
                        {c}
                    </option>
                ))}
            </select>

            <select className="target-cond-select target-cond-select--op" value={operator} onChange={handleOpChange}>
                <option value="ALL">ALL</option>
                <option value="IN">IN</option>
                <option value="LIKE">LIKE</option>
            </select>

            {operator === "ALL" ? (
                <input className="target-cond-like-input" type="text" placeholder="All values matched" disabled />
            ) : operator === "IN" ? (
                <div className="target-cond-tags" onClick={(e) => e.currentTarget.querySelector("input")?.focus()}>
                    {values.map((tag) => (
                        <span key={tag} className="target-cond-badge">
                            <span>'{tag}'</span>
                            <button type="button" className="target-cond-badge-x" onClick={() => removeTag(tag)}>
                                ×
                            </button>
                        </span>
                    ))}
                    <input
                        className="target-cond-tag-input"
                        type="text"
                        placeholder={values.length ? "" : "Add values..."}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onBlur={addTag}
                    />
                </div>
            ) : (
                <input
                    className="target-cond-like-input"
                    type="text"
                    placeholder="%keyword%"
                    value={likeValue}
                    onChange={(e) => setLikeValue(e.target.value)}
                    onBlur={handleLikeBlur}
                />
            )}
        </div>
    );
}

/**
 * MappingTable — source 아이템과 target 아이템의 positional 매핑을 렌더
 *   sourceItems/targetItems: [{ name, type }, ...] (API에서 받은 그대로)
 *   mapping: string|null[] — 각 row의 "어떤 source 이름을 쓸지" (null = disabled)
 *   onMappingChange: (next) => void
 */
function MappingTable({ sourceItems, targetItems, mapping, onMappingChange }) {
    const [dragIdx, setDragIdx] = useState(null);
    const [dropIdx, setDropIdx] = useState(null);

    const rowCount = Math.max(sourceItems.length, targetItems.length);

    // mapping(저장된 source 배열) + schema → 내부 (order, enabled) 재구성
    //   1) mapping[i]이 실제 컬럼명이면 그 schema 인덱스를 사용하고 해당 인덱스를 "사용됨"으로 마킹
    //   2) mapping[i]이 null/undefined이면 그 자리에 "아직 사용되지 않은" schema 컬럼을 순서대로 채움
    //      (disabled 슬롯은 unused 컬럼을 들고 있어야 drag/reorder/checkbox 조작이 자연스러움)
    const buildInternalState = (m, items, count) => {
        const sNames = items.map((s) => s.name);
        const used = new Set();
        const order = new Array(count).fill(null);
        // 1단계: saved mapping 기준으로 order 배치 + used 마킹
        for (let i = 0; i < count; i++) {
            const name = m?.[i];
            if (!name) continue;
            const idx = sNames.indexOf(name);
            if (idx !== -1 && !used.has(idx)) {
                order[i] = idx;
                used.add(idx);
            }
        }
        // 2단계: null 슬롯에 unused schema 컬럼 순서대로 채움
        const pool = [];
        for (let i = 0; i < items.length; i++) {
            if (!used.has(i)) pool.push(i);
        }
        let pi = 0;
        for (let i = 0; i < count; i++) {
            if (order[i] === null && pi < pool.length) {
                order[i] = pool[pi++];
            }
        }
        // enabled: saved mapping[i]이 실제 string이면 true, null/undefined면 false
        const enabled = Array.from({ length: count }, (_, i) => typeof m?.[i] === "string");
        return { order, enabled };
    };

    const [order, setOrder] = useState(() => buildInternalState(mapping, sourceItems, rowCount).order);
    const [enabled, setEnabled] = useState(() => buildInternalState(mapping, sourceItems, rowCount).enabled);

    // 외부 변경(테이블 swap, sync effect 등) 감지용 ref
    // — 우리가 직접 emit한 변화인지 구분해서 무한 re-derive 방지
    const lastDerivedRef = useRef({ mapping, sourceItems, targetItems });

    useEffect(() => {
        const last = lastDerivedRef.current;
        if (last.mapping === mapping && last.sourceItems === sourceItems && last.targetItems === targetItems) return;
        lastDerivedRef.current = { mapping, sourceItems, targetItems };

        const newRowCount = Math.max(sourceItems.length, targetItems.length);
        const { order: nextOrder, enabled: nextEnabled } = buildInternalState(mapping, sourceItems, newRowCount);
        setOrder(nextOrder);
        setEnabled(nextEnabled);
    }, [mapping, sourceItems, targetItems]);

    // 내부 (order, enabled) → 저장 포맷 (string|null[]) 변환
    // target은 여기서 건드리지 않음 — 항상 schema 기준(ColumnMapping의 sync effect가 처리)
    const deriveMapping = (o, e) => Array.from({ length: rowCount }, (_, i) => (e[i] && o[i] != null ? sourceItems[o[i]]?.name ?? null : null));

    // 우리가 emit한 mapping은 위 effect가 무시하도록 ref에 미리 박아둠
    const emitMapping = (nextMapping) => {
        lastDerivedRef.current = { mapping: nextMapping, sourceItems, targetItems };
        onMappingChange(nextMapping);
    };

    const rows = Array.from({ length: rowCount }, (_, i) => {
        const tCol = targetItems[i];
        const oIdx = order[i];
        const sCol = oIdx != null ? sourceItems[oIdx] : null;
        return {
            id: i,
            source: sCol?.name || null,
            sourceType: sCol?.type || null,
            sourceCol: sCol || null,
            target: tCol?.name || null,
            targetType: tCol?.type || null,
            targetCol: tCol || null,
            enabled: enabled[i] === true,
            typeStatus: compareTypes(sCol?.type, tCol?.type),
        };
    });

    const toggleRow = (idx) => {
        // order가 null인 row(가리킬 컬럼 없음)는 enable 불가
        if (order[idx] == null) return;
        const nextEnabled = [...enabled];
        nextEnabled[idx] = !nextEnabled[idx];
        setEnabled(nextEnabled);
        emitMapping(deriveMapping(order, nextEnabled));
    };

    const handleDragStart = (e, idx) => {
        const row = rows[idx];
        setDragIdx(idx);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(idx));

        const ghost = document.createElement("div");
        ghost.className = "col-map-ghost font-mono";
        ghost.style.position = "absolute";
        ghost.style.top = "-1000px";
        ghost.style.left = "-1000px";

        const iconEl = document.createElement("span");
        iconEl.className = "material-symbols-outlined";
        iconEl.style.fontSize = "18px";
        iconEl.style.color = "var(--color-on-surface-tertiary)";
        iconEl.textContent = "drag_indicator";
        ghost.appendChild(iconEl);

        const checkEl = document.createElement("input");
        checkEl.type = "checkbox";
        checkEl.className = "form-checkbox";
        checkEl.checked = row?.enabled !== false;
        checkEl.disabled = true;
        checkEl.style.pointerEvents = "none";
        ghost.appendChild(checkEl);

        const nameEl = document.createElement("span");
        if (row?.source) {
            nameEl.textContent = row.source;
        } else {
            nameEl.textContent = "NULL";
            nameEl.style.fontStyle = "italic";
            nameEl.style.color = "var(--color-on-surface-disabled)";
        }
        ghost.appendChild(nameEl);

        if (row?.sourceType) {
            const typeEl = document.createElement("span");
            typeEl.className = "col-map-type";
            typeEl.textContent = displayType(row.sourceType);
            ghost.appendChild(typeEl);
        }

        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 12, 12);
        setTimeout(() => {
            if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
        }, 0);
    };
    const handleDragEnd = () => {
        setDragIdx(null);
        setDropIdx(null);
    };
    const handleDragOver = (e, idx) => {
        if (dragIdx === null || idx === dragIdx) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dropIdx !== idx) setDropIdx(idx);
    };
    const handleDragLeave = (e, idx) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        if (dropIdx === idx) setDropIdx(null);
    };
    const handleDrop = (e, idx) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("text/plain"));
        setDragIdx(null);
        setDropIdx(null);
        if (!Number.isFinite(from) || from === idx) return;
        // identity swap: order와 enabled 모두 함께 이동
        const nextOrder = [...order];
        const nextEnabled = [...enabled];
        [nextOrder[from], nextOrder[idx]] = [nextOrder[idx], nextOrder[from]];
        [nextEnabled[from], nextEnabled[idx]] = [nextEnabled[idx], nextEnabled[from]];
        setOrder(nextOrder);
        setEnabled(nextEnabled);
        emitMapping(deriveMapping(nextOrder, nextEnabled));
    };

    if (rowCount === 0) return null;

    return (
        <div className="col-map-wrap">
            <table className="col-map-table">
                <colgroup>
                    <col style={{ width: "32px" }} />
                    <col style={{ width: "36px" }} />
                    <col />
                    <col style={{ width: "40px" }} />
                    <col />
                </colgroup>
                <thead>
                    <tr>
                        <th></th>
                        <th></th>
                        <th>SOURCE COLUMN</th>
                        <th></th>
                        <th>TARGET COLUMN</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr
                            key={row.id}
                            className={`col-map-row${row.enabled === false ? " col-map-row--disabled" : ""}${dragIdx === row.id ? " col-map-row--dragging" : ""}${
                                dropIdx === row.id ? " col-map-row--drop-target" : ""
                            }`}
                            onDragOver={(e) => handleDragOver(e, row.id)}
                            onDragLeave={(e) => handleDragLeave(e, row.id)}
                            onDrop={(e) => handleDrop(e, row.id)}
                        >
                            <td className="col-map-drag" draggable onDragStart={(e) => handleDragStart(e, row.id)} onDragEnd={handleDragEnd} title="Drag to reorder">
                                <Icon
                                    name="drag_indicator"
                                    style={{
                                        fontSize: "18px",
                                        color: "var(--color-on-surface-tertiary)",
                                        verticalAlign: "middle",
                                    }}
                                />
                            </td>
                            <td className="col-map-check">
                                <input type="checkbox" checked={row.enabled !== false} onChange={() => toggleRow(row.id)} className="form-checkbox" />
                            </td>
                            <td
                                className={`col-map-source ${row.source ? "" : "schema-cell--empty"}`}
                                draggable
                                onDragStart={(e) => handleDragStart(e, row.id)}
                                onDragEnd={handleDragEnd}
                            >
                                {row.source ? (
                                    <span className="col-map-field font-mono">
                                        <span className="col-map-name-row">
                                            <span>{row.source}</span>
                                            <ColumnFlags col={row.sourceCol} />
                                        </span>
                                        {row.sourceType && <span className="col-map-type">{displayType(row.sourceType)}</span>}
                                    </span>
                                ) : (
                                    <span className="col-map-field col-map-field--empty font-mono">NULL</span>
                                )}
                            </td>
                            <td className="text-center">
                                {row.enabled && row.typeStatus === "error" ? (
                                    <span
                                        title={`Type mismatch: ${displayType(row.sourceType) || "—"} → ${displayType(row.targetType) || "—"}`}
                                        style={{ color: "var(--color-error)", display: "inline-flex" }}
                                    >
                                        <Icon name="error" />
                                    </span>
                                ) : row.enabled && row.typeStatus === "warning" ? (
                                    <span
                                        title={`Size mismatch: ${displayType(row.sourceType) || "—"} → ${displayType(row.targetType) || "—"}`}
                                        style={{ color: "var(--color-warning)", display: "inline-flex" }}
                                    >
                                        <Icon name="warning" />
                                    </span>
                                ) : (
                                    <span className="text-on-surface-disabled">→</span>
                                )}
                            </td>
                            <td className={row.target ? "" : "schema-cell--empty"}>
                                {row.target ? (
                                    <span className="col-map-field col-map-field--target font-mono">
                                        <span className="col-map-name-row">
                                            <span>{row.target}</span>
                                            <ColumnFlags col={row.targetCol} />
                                        </span>
                                        {row.targetType && <span className="col-map-type">{displayType(row.targetType)}</span>}
                                    </span>
                                ) : (
                                    <span className="col-map-field col-map-field--empty font-mono">NULL</span>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/**
 * ColumnMapping
 *   form.source.columns / target.columns — string|null array (data columns)
 *   form.source.meta    / target.meta    — string|null array (meta columns for TAG tables)
 */
export default function ColumnMapping({ form, update }) {
    const { notify } = useApp();
    const [sourceCols, setSourceCols] = useState([]);
    const [sourceMeta, setSourceMeta] = useState([]);
    const [targetCols, setTargetCols] = useState([]);
    const [targetMeta, setTargetMeta] = useState([]);
    const [loading, setLoading] = useState(false);

    const sourceServer = form.source?.server;
    const sourceTable = form.source?.table;
    const targetServer = form.target?.server;
    const targetTable = form.target?.table;

    useEffect(() => {
        if (!sourceServer || !sourceTable) {
            setSourceCols([]);
            setSourceMeta([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        jobsApi
            .fetchTableColumns({ server: sourceServer, table: sourceTable })
            .then((data) => {
                if (cancelled) return;
                setSourceCols(data?.columns ?? []);
                setSourceMeta(data?.meta ?? []);
            })
            .catch((e) => {
                if (!cancelled) notify(e.reason || e.message, "error");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [sourceServer, sourceTable, notify]);

    useEffect(() => {
        if (!targetServer || !targetTable) {
            setTargetCols([]);
            setTargetMeta([]);
            return;
        }
        let cancelled = false;
        jobsApi
            .fetchTableColumns({ server: targetServer, table: targetTable })
            .then((data) => {
                if (cancelled) return;
                setTargetCols(data?.columns ?? []);
                setTargetMeta(data?.meta ?? []);
            })
            .catch((e) => {
                if (!cancelled) notify(e.reason || e.message, "error");
            });
        return () => {
            cancelled = true;
        };
    }, [targetServer, targetTable, notify]);

    // source/target 테이블 변경 감지용 ref — sync effect에서 force reset에 사용
    const prevTablesColsRef = useRef(null);
    const prevTablesMetaRef = useRef(null);

    // target.columns / target.meta는 실제 target DB 스키마 + null padding
    //   rowCount = max(source, target). target이 짧으면 뒤쪽을 null로 채워 source와 길이를 맞춤
    //   checkbox 상태와 무관하게 schema 기준으로 유지됨 (padding만 null)
    //   targetCols가 아직 로딩 전이면 기존 saved 값을 건드리지 않음 (schema 도착 전 race로 날려먹는 것 방지)
    useEffect(() => {
        if (targetCols.length === 0) return;
        const rowCount = Math.max(sourceCols.length, targetCols.length);
        const names = Array.from({ length: rowCount }, (_, i) => targetCols[i]?.name ?? null);
        const current = form.target.columns || [];
        if (current.length === names.length && current.every((n, i) => n === names[i])) return;
        update("target.columns", names);
    }, [targetCols, sourceCols]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (targetMeta.length === 0) return;
        const rowCount = Math.max(sourceMeta.length, targetMeta.length);
        const names = Array.from({ length: rowCount }, (_, i) => targetMeta[i]?.name ?? null);
        const current = form.target.meta || [];
        if (current.length === names.length && current.every((n, i) => n === names[i])) return;
        update("target.meta", names);
    }, [targetMeta, sourceMeta]); // eslint-disable-line react-hooks/exhaustive-deps

    // source.columns / source.meta는 rowCount만큼 길이 맞춰 보관
    //   null         = disabled (체크박스 해제)
    //   "<col name>" = 해당 이름의 source 컬럼을 이 row의 매핑으로 사용
    // 테이블이 바뀌면 forceReset — 기존 매핑을 무시하고 새 positional로 덮어씀
    // sourceCols가 아직 로딩 전이면 실행하지 않음 — 빈 schema와 saved name을 비교해 hasInvalid=true로
    // 오판하고 saved mapping을 전부 날려버리는 race 방지
    useEffect(() => {
        if (sourceCols.length === 0) return;
        const currentKey = `${sourceServer}/${sourceTable}|${targetServer}/${targetTable}`;
        const tableChanged = prevTablesColsRef.current !== null && prevTablesColsRef.current !== currentKey;
        prevTablesColsRef.current = currentKey;

        const rowCount = Math.max(sourceCols.length, targetCols.length);
        const current = form.source.columns || [];
        const sourceNames = new Set(sourceCols.map((c) => c.name));
        const hasInvalid = current.some((v) => v && !sourceNames.has(v));
        const forceReset = tableChanged || hasInvalid;
        const next = Array.from({ length: rowCount }, (_, i) => {
            if (forceReset) return sourceCols[i]?.name ?? null;
            const cur = current[i];
            if (cur === null) return null;
            if (cur !== undefined) return cur;
            return sourceCols[i]?.name ?? null;
        });
        const same = current.length === next.length && current.every((v, i) => v === next[i]);
        if (!same) update("source.columns", next);
    }, [sourceCols, targetCols]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (sourceMeta.length === 0) return;
        const currentKey = `${sourceServer}/${sourceTable}|${targetServer}/${targetTable}`;
        const tableChanged = prevTablesMetaRef.current !== null && prevTablesMetaRef.current !== currentKey;
        prevTablesMetaRef.current = currentKey;

        const rowCount = Math.max(sourceMeta.length, targetMeta.length);
        const current = form.source.meta || [];
        const sourceNames = new Set(sourceMeta.map((c) => c.name));
        const hasInvalid = current.some((v) => v && !sourceNames.has(v));
        const forceReset = tableChanged || hasInvalid;
        const next = Array.from({ length: rowCount }, (_, i) => {
            if (forceReset) return sourceMeta[i]?.name ?? null;
            const cur = current[i];
            if (cur === null) return null;
            if (cur !== undefined) return cur;
            return sourceMeta[i]?.name ?? null;
        });
        const same = current.length === next.length && current.every((v, i) => v === next[i]);
        if (!same) update("source.meta", next);
    }, [sourceMeta, targetMeta]); // eslint-disable-line react-hooks/exhaustive-deps

    // 소스/타겟 중 하나라도 선택되어 있고, columns/meta가 있으면 테이블 렌더
    const hasAnySide = (sourceServer && sourceTable) || (targetServer && targetTable);
    const hasColumns = sourceCols.length > 0 || targetCols.length > 0;
    const hasMeta = sourceMeta.length > 0 || targetMeta.length > 0;

    return (
        <div className="form-card">
            <div className="form-card-header">
                <span className="flex items-center gap-8">
                    <Icon name="view_column" className="text-primary" />
                    Column Mapping
                </span>
            </div>

            {!hasAnySide ? (
                <div className="text-sm text-on-surface-tertiary py-8">Select source or target server/table to view column mapping.</div>
            ) : loading && !hasColumns && !hasMeta ? (
                <div className="text-sm text-on-surface-tertiary py-8">Loading columns...</div>
            ) : !hasColumns && !hasMeta ? (
                <div className="text-sm text-on-surface-tertiary py-8">No columns found.</div>
            ) : (
                <>
                    {hasColumns && (
                        <MappingTable
                            key={`cols|${sourceServer}/${sourceTable}|${targetServer}/${targetTable}|${sourceCols.length}|${targetCols.length}`}
                            sourceItems={sourceCols}
                            targetItems={targetCols}
                            mapping={form.source.columns}
                            onMappingChange={(next) => update("source.columns", next)}
                        />
                    )}

                    {hasMeta && (
                        <div className={hasColumns ? "mt-20" : ""}>
                            <div className="text-sm text-on-surface-secondary font-semibold uppercase tracking-wide mb-8">Meta Columns</div>
                            <MappingTable
                                key={`meta|${sourceServer}/${sourceTable}|${targetServer}/${targetTable}|${sourceMeta.length}|${targetMeta.length}`}
                                sourceItems={sourceMeta}
                                targetItems={targetMeta}
                                mapping={form.source.meta}
                                onMappingChange={(next) => update("source.meta", next)}
                            />
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
