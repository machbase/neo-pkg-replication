import { useState, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as jobsApi from "../../api/jobs";
import Icon from "../common/Icon";
import { koToEn } from "../../utils/korean";

const TYPE_KEY_MAP = {
    4: "SHORT", 5: "VARCHAR", 8: "INTEGER", 12: "LONG",
    16: "FLOAT", 20: "DOUBLE", 49: "TEXT", 104: "USHORT",
    108: "UINTEGER", 112: "ULONG",
};
const STRING_TYPES = new Set(["VARCHAR", "TEXT", "NAME"]);
const NUMERIC_TYPES = new Set(["SHORT", "INTEGER", "LONG", "FLOAT", "DOUBLE", "USHORT", "UINTEGER", "ULONG"]);

const getColumnCategory = (type) => {
    const t = (typeof type === "number" ? TYPE_KEY_MAP[type] : String(type).toUpperCase().replace(/\(.*\)/, "")) || "";
    if (STRING_TYPES.has(t)) return "string";
    if (NUMERIC_TYPES.has(t)) return "numeric";
    return null;
};

export default function SourceSection({ form, update, isEdit }) {
    const [fetchedColumns, setFetchedColumns] = useState(null);
    const [fetching, setFetching] = useState(false);
    const [tableType, setTableType] = useState(null);
    const [search, setSearch] = useState("");
    const [fetchError, setFetchError] = useState(null);


    const selectedColumns = form.source.columns || [];
    const isAllSelected = !form.source.columns;

    const canFetch = form.source.host.trim() && form.source.port && form.source.user.trim() && form.source.password.trim() && form.source.table.trim();

    const handleFetch = async (silent) => {
        if (!canFetch) return;
        setFetching(true);
        try {
            const data = await jobsApi.fetchTableColumns({
                host: form.source.host,
                port: form.source.port,
                user: form.source.user,
                password: form.source.password,
                table: form.source.table,
            });
            setFetchedColumns(data.columns);
            setTableType(data.tableType);
            setFetchError(null);
            if (!silent) update("source.columns", null);
        } catch (e) {
            setFetchError(e.reason || e.message);
        } finally {
            setFetching(false);
        }
    };

    const handleTableChange = (e) => {
        update("source.table", e.target.value);
        // table name changed → clear fetched columns
        setFetchedColumns(null);
        setTableType(null);
        update("source.columns", null);
        update("source.filter", null);
        update("source.transform", null);
    };

    const toggleColumn = (name) => {
        if (!fetchedColumns) return;
        const allNames = fetchedColumns.map((c) => c.name);

        if (isAllSelected) {
            // deselect this one → select all except this
            const next = allNames.filter((n) => n !== name);
            update("source.columns", next.length > 0 ? next : null);
        } else {
            const has = selectedColumns.includes(name);
            if (has) {
                const next = selectedColumns.filter((n) => n !== name);
                update("source.columns", next);
            } else {
                const next = [...selectedColumns, name];
                // if all selected → set null
                update("source.columns", next.length === allNames.length ? null : next);
            }
        }
    };

    const selectAll = () => update("source.columns", null);
    const clearAll = () => {
        if (!fetchedColumns) return;
        update("source.columns", []);
    };

    const isColumnSelected = (name) => isAllSelected || selectedColumns.includes(name);

    const getFilterRule = (colName) => (form.source.filter || []).find((r) => r.column === colName);
    const getTransformRule = (colName) => (form.source.transform || []).find((r) => r.column === colName);

    const updateRule = (key, colName, field, value) => {
        const rules = [...(form.source[key] || [])];
        let idx = rules.findIndex((r) => r.column === colName);
        if (idx === -1) {
            rules.push({ column: colName, [field]: value });
        } else {
            rules[idx] = { ...rules[idx], [field]: value };
            if (value === "" || value === undefined || value === null) delete rules[idx][field];
            if (Object.keys(rules[idx]).every((k) => k === "column")) rules.splice(idx, 1);
        }
        update(`source.${key}`, rules.length > 0 ? rules : null);
    };

    const updateFilter = (colName, field, value) => updateRule("filter", colName, field, value);
    const updateTransform = (colName, field, value) => updateRule("transform", colName, field, value);

    const [inDrafts, setInDrafts] = useState({});

    const getInDisplay = (colName, rule) => {
        if (colName in inDrafts) return inDrafts[colName];
        return Array.isArray(rule?.in) ? rule.in.join(", ") : "";
    };

    const handleInChange = (colName, value) => {
        setInDrafts((prev) => ({ ...prev, [colName]: value }));
    };

    const handleInBlur = (colName) => {
        const raw = inDrafts[colName];
        if (raw === undefined) return;
        const arr = raw.split(",").map((s) => s.trim()).filter(Boolean);
        updateFilter(colName, "in", arr.length > 0 ? arr : undefined);
        setInDrafts((prev) => {
            const next = { ...prev };
            delete next[colName];
            return next;
        });
    };

    const selectedCount = isAllSelected ? fetchedColumns?.length || 0 : selectedColumns.length;

    const filteredColumns = (fetchedColumns || []).filter((col) => {
        if (!search) return true;
        const q = search.toLowerCase();
        if (col.name.toLowerCase().includes(q)) return true;
        if (String(col.type).toLowerCase().includes(q)) return true;
        const fr = getFilterRule(col.name);
        if (fr) {
            if (fr.like?.toLowerCase().includes(q)) return true;
            if (fr.in?.some((v) => v.toLowerCase().includes(q))) return true;
            if (fr.min != null && String(fr.min).includes(q)) return true;
            if (fr.max != null && String(fr.max).includes(q)) return true;
        }
        const tr = getTransformRule(col.name);
        if (tr) {
            if (tr.prefix?.toLowerCase().includes(q)) return true;
            if (tr.suffix?.toLowerCase().includes(q)) return true;
            if (tr.add != null && String(tr.add).includes(q)) return true;
            if (tr.multiply != null && String(tr.multiply).includes(q)) return true;
        }
        return false;
    });

    const scrollRef = useRef(null);
    const virtualizer = useVirtualizer({
        count: filteredColumns.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 44,
        overscan: 5,
    });

    const renderFilterCell = (col) => {
        const cat = getColumnCategory(col.type);
        const rule = getFilterRule(col.name);
        if (cat === "string") return (
            <div className="flex flex-col gap-4">
                <input type="text" value={rule?.like || ""} onChange={(e) => updateFilter(col.name, "like", e.target.value || undefined)} className="w-full" placeholder="LIKE %" />
                <input type="text" value={getInDisplay(col.name, rule)} onChange={(e) => handleInChange(col.name, e.target.value)} onBlur={() => handleInBlur(col.name)} className="w-full" placeholder="IN val1, val2" />
            </div>
        );
        if (cat === "numeric") return (
            <div className="flex gap-4">
                <input type="number" value={rule?.min ?? ""} onChange={(e) => updateFilter(col.name, "min", e.target.value ? Number(e.target.value) : undefined)} className="w-full" placeholder="Min (≥)" />
                <input type="number" value={rule?.max ?? ""} onChange={(e) => updateFilter(col.name, "max", e.target.value ? Number(e.target.value) : undefined)} className="w-full" placeholder="Max (≤)" />
            </div>
        );
        return <span className="text-tertiary">—</span>;
    };

    const renderTransformCell = (col) => {
        const cat = getColumnCategory(col.type);
        const rule = getTransformRule(col.name);
        if (cat === "string") return (
            <div className="flex gap-4">
                <input type="text" value={rule?.prefix || ""} onChange={(e) => updateTransform(col.name, "prefix", e.target.value || undefined)} className="w-full" placeholder="Prefix" />
                <input type="text" value={rule?.suffix || ""} onChange={(e) => updateTransform(col.name, "suffix", e.target.value || undefined)} className="w-full" placeholder="Suffix" />
            </div>
        );
        if (cat === "numeric") return (
            <div className="flex gap-4">
                <input type="number" value={rule?.add ?? ""} onChange={(e) => updateTransform(col.name, "add", e.target.value ? Number(e.target.value) : undefined)} className="w-full" placeholder="Add" />
                <input type="number" value={rule?.multiply ?? ""} onChange={(e) => updateTransform(col.name, "multiply", e.target.value ? Number(e.target.value) : undefined)} className="w-full" placeholder="Multiply" />
            </div>
        );
        return <span className="text-tertiary">—</span>;
    };

    return (
        <div className="form-card">
            <div className="form-card-header">
                <Icon name="database" className="text-primary" />
                Source Database
            </div>

            <div className="space-y-16">
                <div>
                    <label className="form-label">Host Address</label>
                    <input type="text" required value={form.source.host} onChange={(e) => update("source.host", e.target.value)} className="w-full" placeholder="127.0.0.1" />
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-3 gap-16">
                    <div>
                        <label className="form-label">Port</label>
                        <input type="number" required value={form.source.port} onChange={(e) => update("source.port", e.target.value)} className="w-full" />
                    </div>
                    <div>
                        <label className="form-label">Table</label>
                        <input type="text" required value={form.source.table} onChange={handleTableChange} className="w-full" placeholder="Source table name" />
                    </div>
                    <div>
                        <label className="form-label">User</label>
                        <input type="text" required value={form.source.user} onChange={(e) => update("source.user", e.target.value)} className="w-full" />
                    </div>
                </div>

                <div>
                    <label className="form-label">Password</label>
                    <input
                        type="text"
                        autoComplete="off"
                        required={!isEdit}
                        value={form.source.password}
                        onChange={(e) => update("source.password", koToEn(e.target.value))}
                        className="w-full input-masked"
                        placeholder={isEdit ? "Leave blank to keep current password" : ""}
                    />
                </div>

                {/* Columns */}
                <div>
                    <div className="flex items-center justify-between">
                        <label className="form-label !mb-0">Columns</label>
                        <label className="checkbox-label">
                            <input type="checkbox" checked={form.target.autoCreate} onChange={(e) => update("target.autoCreate", e.target.checked)} />
                            <span>Auto Create Target Table</span>
                        </label>
                    </div>
                    <button type="button" onClick={() => handleFetch(isEdit)} disabled={!canFetch || fetching || form.target.autoCreate} className="btn btn-content btn-ghost mt-8">
                        <Icon name="refresh" className="icon-sm" />
                        {fetching ? "Fetching..." : "Fetch Columns"}
                    </button>

                    {fetchedColumns && fetchedColumns.length > 0 && !form.target.autoCreate && (
                        <div className="columns-table-wrap mt-12">
                            <div className="columns-table-info">
                                {tableType && (
                                    <span className="flex items-center gap-8 shrink-0">Table Type: <span className={`badge ${tableType.toUpperCase() === "TAG" ? "badge-primary" : tableType.toUpperCase() === "LOG" ? "badge-error" : "badge-warning"}`}>{tableType}</span></span>
                                )}
                                <input
                                    type="text"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    className="vtable-search"
                                    placeholder="Search columns..."
                                />
                            </div>
                            {/* Virtual table header */}
                            <div className="vtable-header">
                                <div className="vtable-cell vtable-cell-check">
                                    <input type="checkbox" checked={isAllSelected} onChange={() => (isAllSelected ? clearAll() : selectAll())} />
                                </div>
                                <div className="vtable-cell vtable-cell-name">Name</div>
                                <div className="vtable-cell vtable-cell-type">Type</div>
                                <div className="vtable-cell vtable-cell-filter">Filter</div>
                                <div className="vtable-cell vtable-cell-transform">Transform</div>
                            </div>
                            {/* Virtual table body */}
                            <div className="vtable-body" ref={scrollRef}>
                                {(() => {
                                    const items = virtualizer.getVirtualItems();
                                    const firstStart = items[0]?.start ?? 0;
                                    const lastEnd = items[items.length - 1]?.end ?? 0;
                                    return (
                                        <div style={{ paddingTop: `${firstStart}px`, paddingBottom: `${virtualizer.getTotalSize() - lastEnd}px` }}>
                                            {items.map((vRow) => {
                                                const col = filteredColumns[vRow.index];
                                                return (
                                                    <div
                                                        key={col.name}
                                                        ref={virtualizer.measureElement}
                                                        data-index={vRow.index}
                                                        className="vtable-row"
                                                        onClick={() => toggleColumn(col.name)}
                                                    >
                                                        <div className="vtable-cell vtable-cell-check">
                                                            <input type="checkbox" checked={isColumnSelected(col.name)} onChange={() => toggleColumn(col.name)} />
                                                        </div>
                                                        <div className="vtable-cell vtable-cell-name mono" title={col.name}>{col.name}</div>
                                                        <div className={`vtable-cell vtable-cell-type mono${typeof col.type === "number" ? " text-right" : ""}`} title={String(col.type)}>{col.type}</div>
                                                        <div className="vtable-cell vtable-cell-filter" onClick={(e) => e.stopPropagation()}>
                                                            {renderFilterCell(col)}
                                                        </div>
                                                        <div className="vtable-cell vtable-cell-transform" onClick={(e) => e.stopPropagation()}>
                                                            {renderTransformCell(col)}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    );
                                })()}
                            </div>
                            <div className="columns-table-footer">
                                <span className="text-secondary text-sm">
                                    Selected {selectedCount} / {fetchedColumns.length}
                                </span>
                                <div className="flex gap-8">
                                    <button type="button" onClick={selectAll} className="btn btn-ghost">
                                        Select All
                                    </button>
                                    <button type="button" onClick={clearAll} className="btn btn-ghost">
                                        Clear
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {fetchedColumns && fetchedColumns.length === 0 && <p className="text-secondary text-sm mt-8">No columns found for this table.</p>}
                    {fetchError && <p className="text-error text-sm mt-8">{fetchError}</p>}
                </div>
            </div>
        </div>
    );
}
