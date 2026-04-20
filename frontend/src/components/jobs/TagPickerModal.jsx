import { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../common/Icon";
import * as serversApi from "../../api/servers";

const PAGE_SIZE = 50;

export default function TagPickerModal({ server, table, candidates, existingValues = [], onClose, onConfirm }) {
    const useStaticCandidates = Array.isArray(candidates);

    const [page, setPage] = useState(1);
    const [tags, setTags] = useState([]);
    const [totalTags, setTotalTags] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [search, setSearch] = useState("");
    const [selected, setSelected] = useState(() => new Set(existingValues));

    useEffect(() => {
        const handleKey = (e) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", handleKey);
        return () => document.removeEventListener("keydown", handleKey);
    }, [onClose]);

    useEffect(() => {
        if (useStaticCandidates) {
            setLoading(false);
            setError(null);
            setTotalTags(candidates.length);
            const start = (page - 1) * PAGE_SIZE;
            setTags(candidates.slice(start, start + PAGE_SIZE));
            return;
        }
        if (!server || !table) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        serversApi
            .listTableTags({ server, table, page, size: PAGE_SIZE })
            .then((data) => {
                if (cancelled) return;
                setTags(Array.isArray(data?.tags) ? data.tags : []);
                setTotalTags(Number(data?.total_tags ?? 0));
            })
            .catch((e) => { if (!cancelled) setError(e.reason || e.message); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [server, table, page, useStaticCandidates, candidates]);

    const filtered = useMemo(() => {
        if (!search.trim()) return tags;
        const q = search.trim().toLowerCase();
        return tags.filter((t) => t.toLowerCase().includes(q));
    }, [tags, search]);

    const totalPages = totalTags > 0 ? Math.max(1, Math.ceil(totalTags / PAGE_SIZE)) : 1;
    const canPrev = page > 1;
    const canNext = page < totalPages;

    const toggle = (tag) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            return next;
        });
    };

    const visibleSelectedCount = useMemo(
        () => filtered.reduce((acc, t) => (selected.has(t) ? acc + 1 : acc), 0),
        [filtered, selected]
    );
    const allVisibleSelected = filtered.length > 0 && visibleSelectedCount === filtered.length;
    const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

    const headerCheckboxRef = useRef(null);
    useEffect(() => {
        if (headerCheckboxRef.current) {
            headerCheckboxRef.current.indeterminate = someVisibleSelected;
        }
    }, [someVisibleSelected]);

    const toggleAllVisible = () => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (allVisibleSelected) {
                for (const t of filtered) next.delete(t);
            } else {
                for (const t of filtered) next.add(t);
            }
            return next;
        });
    };

    const handleConfirm = () => {
        onConfirm(Array.from(selected));
    };

    return (
        <div className="modal-overlay" onMouseDown={onClose}>
            <div className="modal modal-md" onMouseDown={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <div className="modal-header-title">
                        <Icon name="sell" className="text-primary" />
                        Select Tags
                    </div>
                    <button onClick={onClose} className="p-4 hover:bg-surface-hover rounded-base tooltip" data-tooltip="Close">
                        <Icon name="close" />
                    </button>
                </div>

                <div className="modal-body">
                    <div className="tag-picker-toolbar">
                        <input
                            type="text"
                            className="tag-picker-search"
                            placeholder="Search tags on this page..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                        <span className="tag-picker-count">
                            {selected.size.toLocaleString()} / {totalTags.toLocaleString()}
                        </span>
                    </div>

                    <div className="tag-picker-list">
                        <table className="table-clean tag-picker-table">
                            <colgroup>
                                <col style={{ width: "44px" }} />
                                <col />
                            </colgroup>
                            <thead>
                                <tr>
                                    <th>
                                        <input
                                            ref={headerCheckboxRef}
                                            type="checkbox"
                                            checked={allVisibleSelected}
                                            onChange={toggleAllVisible}
                                            disabled={loading || filtered.length === 0}
                                            aria-label="Select all visible tags"
                                        />
                                    </th>
                                    <th>Tag</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    <tr><td colSpan={2} className="tag-picker-empty">Loading...</td></tr>
                                ) : error ? (
                                    <tr><td colSpan={2} className="tag-picker-empty text-error">{error}</td></tr>
                                ) : filtered.length === 0 ? (
                                    <tr><td colSpan={2} className="tag-picker-empty">No tags</td></tr>
                                ) : (
                                    filtered.map((tag) => {
                                        const isSel = selected.has(tag);
                                        return (
                                            <tr
                                                key={tag}
                                                className={isSel ? "tag-picker-row--selected" : ""}
                                                onClick={() => toggle(tag)}
                                            >
                                                <td onClick={(e) => e.stopPropagation()}>
                                                    <input
                                                        type="checkbox"
                                                        checked={isSel}
                                                        onChange={() => toggle(tag)}
                                                    />
                                                </td>
                                                <td className="mono">{tag}</td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>

                    <div className="tag-picker-footer">
                        <div />
                        <div className="flex items-center gap-8">
                            <button type="button" className="btn btn-sm btn-ghost" disabled={!canPrev || loading} onClick={() => setPage(page - 1)}>
                                <Icon name="chevron_left" className="icon-sm" />
                            </button>
                            <span className="text-xs text-on-surface-tertiary">
                                {page} / {totalPages}
                            </span>
                            <button type="button" className="btn btn-sm btn-ghost" disabled={!canNext || loading} onClick={() => setPage(page + 1)}>
                                <Icon name="chevron_right" className="icon-sm" />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="modal-footer">
                    <button type="button" onClick={onClose} className="btn btn-content btn-ghost">
                        Cancel
                    </button>
                    <button type="button" onClick={handleConfirm} className="btn btn-content btn-primary">
                        Apply ({selected.size})
                    </button>
                </div>
            </div>
        </div>
    );
}
