import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Icon from "../common/Icon";
import ServerForm from "../servers/ServerForm";
import * as serversApi from "../../api/servers";
import { useApp } from "../../context/AppContext";
import { validateMqttTopic } from "../../utils/mqttTopic";

function useDropdown() {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        if (!open) return;
        const handleClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        const handleKey = (e) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", handleClick);
        document.addEventListener("keydown", handleKey);
        return () => { document.removeEventListener("mousedown", handleClick); document.removeEventListener("keydown", handleKey); };
    }, [open]);

    return { open, setOpen, ref };
}

export default function DatabaseSection({ title, prefix, form, update, servers = [], onAddServer, onRefreshServers, isEdit = false }) {
    const data = prefix === "source" ? form.source : form.target;
    const visibleServers = prefix === "source" ? servers.filter((s) => !s.targetOnly) : servers;
    const server = useDropdown();
    const table = useDropdown();
    const [showServerForm, setShowServerForm] = useState(false);
    const [tables, setTables] = useState([]);
    const [tablesLoading, setTablesLoading] = useState(false);
    const [topicTouched, setTopicTouched] = useState(false);
    const { notify } = useApp();

    const selectedServer = data.server || "";
    const selectedTable = data.table || "";
    const selectedServerMeta = visibleServers.find((s) => s.name === selectedServer);
    const isMqttPublishTarget = prefix === "target" && (selectedServerMeta?.type === "mqtt-publish");

    // 응답: { tables: [{ name, tableType: "TAG" | "LOG", owner }] }
    // owner가 SYS가 아니면 `{owner}.{name}` 형태로 표시/저장
    useEffect(() => {
        if (!selectedServer || isMqttPublishTarget) {
            setTables([]);
            return;
        }
        let cancelled = false;
        setTablesLoading(true);
        serversApi.listTables(selectedServer)
            .then((data) => {
                if (cancelled) return;
                const normalized = (data?.tables ?? []).map((t) => ({
                    name: t.name,
                    type: (t.tableType || "LOG").toUpperCase(),
                    owner: (t.owner || "").toString(),
                }));
                setTables(normalized);
            })
            .catch((e) => { if (!cancelled) notify(e.reason || e.message, "error"); })
            .finally(() => { if (!cancelled) setTablesLoading(false); });
        return () => { cancelled = true; };
    }, [selectedServer, isMqttPublishTarget, notify]);

    // create 모드 + target mqtt-publish + table 미입력 시 기본 topic 주입
    useEffect(() => {
        if (isEdit) return;
        if (!isMqttPublishTarget) return;
        if (selectedTable) return;
        update(`${prefix}.table`, "db/write/example");
    }, [isMqttPublishTarget, isEdit]); // eslint-disable-line react-hooks/exhaustive-deps

    const tableId = (t) => (t.owner && t.owner.toUpperCase() !== "SYS" ? `${t.owner}.${t.name}` : t.name);

    // owner별 그룹화 → 각 그룹 내부는 TAG 먼저, 그 다음 LOG, 같은 타입은 이름순
    const groupedTables = (() => {
        const typeOrder = { TAG: 0, LOG: 1 };
        const groups = new Map();
        for (const t of tables) {
            const owner = (t.owner || "SYS").toUpperCase();
            if (!groups.has(owner)) groups.set(owner, []);
            groups.get(owner).push(t);
        }
        return Array.from(groups.keys())
            .sort((a, b) => {
                if (a === "SYS") return -1;
                if (b === "SYS") return 1;
                return a.localeCompare(b);
            })
            .map((owner) => ({
                label: owner,
                items: groups.get(owner).sort((a, b) => {
                    const diff = (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
                    return diff !== 0 ? diff : a.name.localeCompare(b.name);
                }),
            }));
    })();

    const selectedTableMeta = tables.find((t) => tableId(t) === selectedTable);

    const handleSelectServer = (s) => {
        update(`${prefix}.server`, s.name);
        // 서버 변경 시 테이블/매핑 초기화 — 이전 서버의 컬럼/메타가 쓰레기값으로 남는 것 방지
        update(`${prefix}.table`, "");
        update(`${prefix}.columns`, []);
        update(`${prefix}.meta`, []);
        server.setOpen(false);
    };

    const handleSelectTable = (t) => {
        update(`${prefix}.table`, t);
        // 테이블 변경 시 매핑 초기화 — 새 schema 로드 전까지 이전 컬럼/메타가 남지 않도록
        update(`${prefix}.columns`, []);
        update(`${prefix}.meta`, []);
        table.setOpen(false);
    };

    const handleAddServer = async (data) => {
        if (onAddServer) {
            await onAddServer(data);
        }
        setShowServerForm(false);
    };

    return (
        <div className="form-card">
            <div className="form-card-header">{title}</div>
            <div className="space-y-16">
                <div>
                    <label className="form-label">Select Server</label>
                    <div className="flex gap-8">
                        <div className="relative flex-1" ref={server.ref}>
                            <button
                                type="button"
                                className="db-select-btn"
                                onClick={() => {
                                    const next = !server.open;
                                    if (next && onRefreshServers) onRefreshServers();
                                    server.setOpen(next);
                                }}
                            >
                                <span className={`font-mono truncate flex items-center gap-8 ${selectedServer ? "text-on-surface" : "text-on-surface-disabled"}`}>
                                    {selectedServerMeta && (
                                        <span className={`server-type-badge server-type-badge--${selectedServerMeta.type || "native"}`}>
                                            {selectedServerMeta.type || "native"}
                                        </span>
                                    )}
                                    {selectedServer || "Select a server..."}
                                </span>
                                <Icon name="keyboard_arrow_down" className={`db-select-chevron ${server.open ? "db-select-chevron--open" : ""}`} />
                            </button>
                            {server.open && (
                                <div className="db-select-dropdown">
                                    {visibleServers.length > 0 ? (
                                        visibleServers.map((s) => (
                                            <button
                                                key={s.name}
                                                type="button"
                                                className={`db-select-option ${s.name === selectedServer ? "db-select-option--active" : ""}`}
                                                onClick={() => handleSelectServer(s)}
                                            >
                                                <span className="flex items-center gap-8">
                                                    <span className={`server-type-badge server-type-badge--${s.type || "native"}`}>
                                                        {s.type || "native"}
                                                    </span>
                                                    <span className="font-mono">{s.name}</span>
                                                </span>
                                                <span className="text-xs text-on-surface-disabled">
                                                    {s.host}:{s.port}
                                                </span>
                                            </button>
                                        ))
                                    ) : (
                                        <div className="db-select-empty">No servers registered</div>
                                    )}
                                </div>
                            )}
                        </div>
                        <button
                            type="button"
                            className="btn btn-icon btn-primary tooltip"
                            data-tooltip="Add Server"
                            onClick={() => setShowServerForm(true)}
                        >
                            <Icon name="add" />
                        </button>
                    </div>
                </div>

                {isMqttPublishTarget ? (
                    (() => {
                        const topicValidation = validateMqttTopic(selectedTable);
                        const showTopicError = topicTouched && !topicValidation.valid;
                        return (
                            <div>
                                <label className="form-label">Topic</label>
                                <input
                                    type="text"
                                    className={`w-full font-mono ${showTopicError ? "input-error" : ""}`}
                                    value={selectedTable}
                                    onChange={(e) => {
                                        if (!topicTouched) setTopicTouched(true);
                                        update(`${prefix}.table`, e.target.value);
                                    }}
                                    onBlur={() => setTopicTouched(true)}
                                    placeholder="Defaults to source table"
                                    aria-invalid={showTopicError || undefined}
                                />
                                {showTopicError && (
                                    <p className="form-error-text">{topicValidation.error}</p>
                                )}
                            </div>
                        );
                    })()
                ) : (
                    <div>
                        <label className="form-label">Table Selection</label>
                        <div className="relative" ref={table.ref}>
                            <button type="button" className="db-select-btn" onClick={() => table.setOpen(!table.open)} disabled={!selectedServer || tablesLoading}>
                                <span className={`font-mono truncate flex items-center gap-8 ${selectedTable ? "text-on-surface" : "text-on-surface-disabled"}`}>
                                    {selectedTableMeta && (
                                        <span className={`table-type-badge table-type-badge--${selectedTableMeta.type.toLowerCase()}`}>
                                            {selectedTableMeta.type}
                                        </span>
                                    )}
                                    {tablesLoading ? "Loading tables..." : selectedTable || "Select a table..."}
                                </span>
                                <Icon name="keyboard_arrow_down" className={`db-select-chevron ${table.open ? "db-select-chevron--open" : ""}`} />
                            </button>
                            {table.open && (
                                <div className="db-select-dropdown">
                                    {groupedTables.length > 0 ? (
                                        groupedTables.map((group) => (
                                            <div key={group.label}>
                                                <div className="db-select-group-label">{group.label}</div>
                                                {group.items.map((t) => {
                                                    const id = tableId(t);
                                                    return (
                                                        <button
                                                            key={id}
                                                            type="button"
                                                            className={`db-select-option ${id === selectedTable ? "db-select-option--active" : ""}`}
                                                            onClick={() => handleSelectTable(id)}
                                                        >
                                                            <span className="flex items-center gap-8">
                                                                <span className={`table-type-badge table-type-badge--${t.type.toLowerCase()}`}>{t.type}</span>
                                                                <span className="font-mono">{id}</span>
                                                            </span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        ))
                                    ) : (
                                        <div className="db-select-empty">No tables found</div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {showServerForm && createPortal(
                <ServerForm
                    server={null}
                    onSave={handleAddServer}
                    onClose={() => setShowServerForm(false)}
                />,
                document.body
            )}
        </div>
    );
}
