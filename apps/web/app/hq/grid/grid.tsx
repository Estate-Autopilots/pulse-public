"use client";
// PULSE-HQ (owner, 23 Oct 2026): fast, Notion-like editing for Pulse HQ's sheets (ideas, the feature catalogue) and
// Stack Intelligence. One component, five ways to look at the same rows:
//   Sheet    click a cell to edit, Enter saves, Tab saves and moves to the next cell, Esc cancels; arrows move;
//            typing on a cell starts editing it; Space selects a row, Shift+click selects a range, Ctrl/⌘+A all;
//            Alt+↑/↓ (or the handle, dragged) reorders; Shift+Enter opens the row; Delete removes the selection
//   Board    columns by a field (stage, status, verdict…); drag a card to another column, or Alt+←/→
//   Compact  one dense line per row with its chips; Gallery cards; Free  cards placed anywhere on a canvas
// "+ New" (or n) adds a row with one keystroke and stays ready for the next; pasting several lines adds a row per line
// (tab-separated cells fill the next fields). Filters, sort, group-by and fields are remembered per sheet, and saved as
// named views on the person's account. Long text takes slash commands (/heading, /bullet, /todo, /date …).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Bookmark, Check, ChevronDown, ChevronRight, Columns3, Expand, Filter, GalleryVerticalEnd, GripVertical, LayoutGrid, ListFilter, Plus, Rows3,
  Search, Shapes, SquareKanban, Table2, Trash2, X, type LucideIcon } from "lucide-react";
import { Floating, OptionList, type Choice } from "./pop";
import { SlashText } from "./slash";
import { BASE_SETTINGS, useGridSettings, useSavedViews, type GridSettings } from "./state";
import css from "./grid.module.css";

export type Opt = { key: string; label: string; tone?: string };
export type Kind = "title" | "text" | "long" | "select" | "person" | "number" | "money" | "score" | "view";
export type Col<R> = {
  key: string; label: string; kind: Kind; width?: number; options?: readonly Opt[]; nullable?: boolean; editable?: boolean; group?: boolean; hidden?: boolean;
  currency?: "INR" | "USD"; get?: (r: R) => unknown; render?: (r: R) => ReactNode; sortValue?: (r: R) => string | number; placeholder?: string;
};
export type Person = { id: string; name: string };
type Row = { id: string };
export type ExtraView<R> = { key: string; label: string; Icon: LucideIcon; render: (rows: R[]) => ReactNode };
export type BuiltIn = "sheet" | "board" | "compact" | "gallery" | "free";

export type GridProps<R extends Row> = {
  scope: string; rows: R[]; cols: Col<R>[]; people: Person[]; noun: string; nouns?: string;
  defaults?: Partial<GridSettings>; views?: BuiltIn[]; extraViews?: ExtraView<R>[];
  canEdit: (r: R) => boolean; canCreate?: boolean; canReorder?: boolean; canRemove?: boolean; bulk?: string[];
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  onCreate?: (fields: Record<string, unknown>) => Promise<unknown>;
  onBatch?: (items: Record<string, unknown>[]) => Promise<unknown>;
  onBulk?: (ids: string[], patch: Record<string, unknown> | null) => Promise<unknown>;
  onReorder?: (ids: string[]) => Promise<unknown>;
  onOpen?: (id: string) => void;
  bulkExtra?: (ids: string[], clear: () => void) => ReactNode;
  cardExtra?: (r: R) => ReactNode;
  links?: { key: string; label: string }[];
  toolbarExtra?: ReactNode;
};

const VIEW_META: Record<BuiltIn, { label: string; Icon: LucideIcon }> = {
  sheet: { label: "Sheet", Icon: Table2 }, board: { label: "Board", Icon: SquareKanban }, compact: { label: "Compact", Icon: Rows3 },
  gallery: { label: "Gallery", Icon: GalleryVerticalEnd }, free: { label: "Free", Icon: Shapes },
};
const valueOf = <R,>(r: R, c: Col<R>): unknown => c.get ? c.get(r) : (r as unknown as Record<string, unknown>)[c.key];
const text = (x: unknown) => x === null || x === undefined ? "" : String(x);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const hueOf = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const fmtMoney = (n: unknown, currency: "INR" | "USD" = "INR") => {
  if (n === null || n === undefined || n === "") return "";
  const v = Number(n); if (!Number.isFinite(v)) return "";
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency, maximumFractionDigits: v % 1 ? 2 : 0 }).format(v);
};
const EMPTY = "∅";

/** The choices a select, person or score field offers. */
function choicesOf<R>(c: Col<R>, people: Person[]): Choice[] {
  if (c.kind === "person") return [{ key: "", label: "No one" }, ...people.map((p) => ({ key: p.id, label: p.name }))];
  if (c.kind === "score") return [1, 2, 3, 4, 5].map((n) => ({ key: String(n), label: String(n) }));
  return [...(c.nullable ? [{ key: "", label: "None" }] : []), ...(c.options ?? []).map((o) => ({ key: o.key, label: o.label, swatch: o.tone }))];
}
const keyOf = <R,>(r: R, c: Col<R>) => { const v = valueOf(r, c); return v === null || v === undefined ? "" : String(v); };
const labelOf = <R,>(r: R, c: Col<R>, people: Person[]) => {
  const k = keyOf(r, c);
  if (c.kind === "person") return people.find((p) => p.id === k)?.name ?? "";
  if (c.kind === "select") return c.options?.find((o) => o.key === k)?.label ?? k;
  return k;
};

export function Grid<R extends Row>(props: GridProps<R>) {
  const { scope, rows, cols, people, noun, nouns = `${noun}s`, views = ["sheet", "board", "compact", "gallery", "free"], extraViews = [], canEdit, canCreate, canReorder, canRemove,
    bulk = [], onPatch, onCreate, onBatch, onBulk, onReorder, onOpen, bulkExtra, cardExtra, links, toolbarExtra } = props;
  const defaults = useMemo<GridSettings>(() => ({ ...BASE_SETTINGS, ...props.defaults }), [props.defaults]);
  const [s, set] = useGridSettings(scope, defaults);
  // On a phone a sheet opens compact the first time (one line per row); a choice made after that is kept.
  useEffect(() => { try { if (window.innerWidth < 760 && !window.localStorage.getItem(`pulse.grid.${scope}`)) set({ kind: "compact" }); } catch { /* private window */ } }, [scope, set]);
  const saved = useSavedViews(scope);

  // Optimistic changes over the server's rows until the next read brings them (the rows' identity changes then).
  const [seen, setSeen] = useState(rows);
  const [patches, setPatches] = useState<Record<string, Record<string, unknown>>>({});
  const [order, setOrder] = useState<string[] | null>(null);
  const [gone, setGone] = useState<string[]>([]);
  const [temp, setTemp] = useState<{ tid: string; title: string; fields: Record<string, unknown> }[]>([]);
  if (seen !== rows) { setSeen(rows); setPatches({}); setOrder(null); setGone([]); setTemp([]); }
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy((n) => n + 1);
    try { await work(); setError(null); return true; } catch (e) { setError(e instanceof Error ? e.message : "That did not save."); return false; } finally { setBusy((n) => n - 1); }
  }, []);

  const titleCol = cols.find((c) => c.kind === "title") ?? cols[0];
  const all = useMemo(() => {
    const base = rows.filter((r) => !gone.includes(r.id)).map((r) => patches[r.id] ? { ...r, ...patches[r.id] } as R : r);
    if (!order) return base;
    const at = new Map(order.map((id, i) => [id, i]));
    return [...base].sort((a, b) => (at.get(a.id) ?? 1e9) - (at.get(b.id) ?? 1e9));
  }, [rows, gone, patches, order]);

  const visibleCols = cols.filter((c) => !s.hidden.includes(c.key) && !(c.hidden && !s.hidden.includes(`+${c.key}`)));
  const groupCols = cols.filter((c) => c.group);
  const groupCol = cols.find((c) => c.key === s.groupBy && c.group) ?? null;
  const boardCol = cols.find((c) => c.key === (s.boardBy ?? defaults.boardBy) && c.group) ?? groupCols[0] ?? null;
  const q = s.query.trim().toLowerCase();
  const shown = useMemo(() => {
    const textCols = cols.filter((c) => ["title", "text", "long"].includes(c.kind));
    let out = all.filter((r) => Object.entries(s.filters).every(([k, vals]) => { const c = cols.find((x) => x.key === k); return !c || !vals.length || vals.includes(keyOf(r, c)); })
      && (!q || textCols.some((c) => text(valueOf(r, c)).toLowerCase().includes(q))));
    const sc = s.sort ? cols.find((c) => c.key === s.sort!.key) : null;
    if (sc) {
      const v = (r: R): string | number => sc.sortValue ? sc.sortValue(r) : sc.kind === "select" ? (sc.options ?? []).findIndex((o) => o.key === keyOf(r, sc))
        : sc.kind === "person" ? labelOf(r, sc, people).toLowerCase() || "￿" : ["number", "money", "score"].includes(sc.kind) ? Number(valueOf(r, sc) ?? -1) : text(valueOf(r, sc)).toLowerCase();
      out = [...out].sort((a, b) => { const x = v(a), y = v(b); const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y)); return s.sort!.up ? d : -d; });
    }
    return out;
  }, [all, s.filters, s.sort, q, cols, people]);

  const groups = useMemo(() => {
    if (!groupCol) return [{ key: "*", label: "", rows: shown }];
    const ch = choicesOf(groupCol, people);
    const out = ch.map((c) => ({ key: c.key, label: c.label, rows: shown.filter((r) => keyOf(r, groupCol) === c.key) }));
    if (!ch.some((c) => c.key === "")) { const rest = shown.filter((r) => !ch.some((c) => c.key === keyOf(r, groupCol))); if (rest.length) out.push({ key: "", label: "None", rows: rest }); }
    return out.filter((g) => g.rows.length || groupCol.kind !== "person");
  }, [shown, groupCol, people]);
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const manual = !s.sort && !!canReorder && !!onReorder;

  // Selection.
  const [sel, setSel] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const toggle = (id: string, range = false) => {
    if (range && anchor.current) {
      const a = flat.findIndex((r) => r.id === anchor.current), b = flat.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) { const span = flat.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id); setSel((x) => [...new Set([...x, ...span])]); return; }
    }
    anchor.current = id; setSel((x) => x.includes(id) ? x.filter((y) => y !== id) : [...x, id]);
  };
  const selected = sel.filter((id) => all.some((r) => r.id === id));

  // Changes.
  const patch = (r: R, field: string, value: unknown) => {
    if (text(valueOf(r, cols.find((c) => c.key === field) ?? titleCol)) === text(value)) return;
    setPatches((p) => ({ ...p, [r.id]: { ...p[r.id], [field]: value } }));
    void run(() => onPatch(r.id, { [field]: value }));
  };
  const reorder = (ids: string[], moved?: { id: string; field: string; value: unknown }) => {
    setOrder(ids);
    if (moved) setPatches((p) => ({ ...p, [moved.id]: { ...p[moved.id], [moved.field]: moved.value } }));
    void run(async () => { if (moved) await onPatch(moved.id, { [moved.field]: moved.value }); if (onReorder) await onReorder(ids); });
  };
  const moveBefore = (id: string, target: string | null, after = false, field?: { key: string; value: unknown }) => {
    const ids = all.map((r) => r.id).filter((x) => x !== id);
    let at = target ? ids.indexOf(target) : ids.length; if (at < 0) at = ids.length; if (after) at += 1;
    ids.splice(at, 0, id);
    reorder(ids, field ? { id, field: field.key, value: field.value } : undefined);
  };
  const create = (title: string, fields: Record<string, unknown>) => {
    if (!onCreate || title.trim().length < 2) return;
    const tid = `t${Date.now()}${Math.random()}`;
    setTemp((t) => [...t, { tid, title: title.trim(), fields }]);
    void run(() => onCreate({ ...fields, [titleCol.key]: title.trim() }));
  };
  const createMany = (lines: string[], fields: Record<string, unknown>) => {
    const editable = visibleCols.filter((c) => c.kind !== "title" && c.kind !== "view" && c.editable !== false);
    const items = lines.map((line) => {
      const cells = line.split("\t").map((x) => x.trim()); const item: Record<string, unknown> = { ...fields, [titleCol.key]: cells[0] };
      cells.slice(1).forEach((v, i) => { const c = editable[i]; if (!c || !v) return;
        if (c.kind === "select" || c.kind === "person") { const hit = choicesOf(c, people).find((o) => o.label.toLowerCase() === v.toLowerCase() || o.key === v); if (hit) item[c.key] = hit.key || null; }
        else if (c.kind === "score") item[c.key] = Math.max(1, Math.min(5, Math.round(Number(v)) || 3));
        else item[c.key] = v; });
      return item;
    }).filter((x) => String(x[titleCol.key] ?? "").length >= 2).slice(0, 200);
    if (!items.length) return;
    setTemp((t) => [...t, ...items.map((x, i) => ({ tid: `p${Date.now()}-${i}`, title: String(x[titleCol.key]), fields: x }))]);
    void run(() => onBatch ? onBatch(items) : Promise.all(items.map((x) => onCreate?.(x))));
  };
  const groupFields = (g: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, vals] of Object.entries(s.filters)) if (vals.length === 1) out[k] = vals[0] === "" ? null : vals[0];
    const c = s.kind === "board" ? boardCol : groupCol;
    if (c && g !== "*") out[c.key] = g === "" ? null : c.kind === "score" ? Number(g) : g;
    return out;
  };
  const removeSelected = () => {
    if (!onBulk || !selected.length) return;
    if (!window.confirm(`Delete ${selected.length === 1 ? `this ${noun}` : `${selected.length} ${nouns}`}? This cannot be undone.`)) return;
    const ids = selected; setGone((g) => [...g, ...ids]); setSel([]);
    void run(() => onBulk(ids, null));
  };
  const bulkSet = (field: string, value: unknown) => {
    if (!onBulk || !selected.length) return;
    const ids = selected;
    setPatches((p) => { const next = { ...p }; for (const id of ids) next[id] = { ...next[id], [field]: value }; return next; });
    void run(() => onBulk(ids, { [field]: value }));
  };

  const [adding, setAdding] = useState<string | null>(null);
  const startNew = () => { setAdding(s.kind === "board" ? (boardCol ? choicesOf(boardCol, people)[0]?.key ?? "" : "*") : groups[0]?.key ?? "*"); };

  const kinds = [...views.map((v) => ({ key: v as string, ...VIEW_META[v] })), ...extraViews.map((v) => ({ key: v.key, label: v.label, Icon: v.Icon }))];
  const kind = kinds.some((k) => k.key === s.kind) ? s.kind : kinds[0].key;
  const extra = extraViews.find((v) => v.key === kind);
  const filtersOn = Object.values(s.filters).reduce((n, v) => n + (v.length ? 1 : 0), 0) + (q ? 1 : 0);

  return <div className={css.grid}>
    <div className={css.bar}>
      <div className={css.kinds} role="tablist" aria-label="Views">
        {kinds.map((k) => <button key={k.key} type="button" role="tab" aria-selected={kind === k.key} data-on={kind === k.key ? "" : undefined} title={k.label}
          onClick={() => set({ kind: k.key })}><k.Icon size={15} aria-hidden="true" /><span className={css.kindLabel}>{k.label}</span></button>)}
      </div>
      <span className={css.grow} />
      {toolbarExtra}
      <SavedViews saved={saved} current={s} apply={(b) => set({ ...BASE_SETTINGS, ...defaults, ...b })} />
      {canCreate && onCreate ? <button type="button" className={css.newBtn} data-hq-new="" title={`New ${noun} (n)`} onClick={startNew}><Plus size={16} aria-hidden="true" /><span className={css.kindLabel}>New</span></button> : null}
    </div>
    <div className={css.bar}>
      <label className={css.find}><Search size={15} aria-hidden="true" /><input type="search" value={s.query} onChange={(e) => set({ query: e.target.value })} placeholder={`Search ${nouns}`} aria-label={`Search ${nouns}`} /></label>
      <div className={css.chipRow}>
      {cols.filter((c) => ["select", "person", "score"].includes(c.kind)).map((c) => <FilterChip key={c.key} c={c} people={people} values={s.filters[c.key] ?? []}
        onChange={(v) => set({ filters: { ...s.filters, [c.key]: v } })} />)}
      {filtersOn ? <button type="button" className={css.link} onClick={() => set({ filters: {}, query: "" })}>Clear filters</button> : null}
      <span className={css.grow} />
      {kind === "board" ? <Pick label="Columns by" icon={<SquareKanban size={14} aria-hidden="true" />} value={boardCol?.key ?? ""} choices={groupCols.map((c) => ({ key: c.key, label: c.label }))} onPick={(k) => set({ boardBy: k })} />
        : <Pick label="Group" icon={<LayoutGrid size={14} aria-hidden="true" />} value={s.groupBy ?? ""} choices={[{ key: "", label: "No grouping" }, ...groupCols.map((c) => ({ key: c.key, label: c.label }))]}
          onPick={(k) => set({ groupBy: k || null })} />}
      <Pick label="Sort" icon={s.sort?.up === false ? <ArrowDown size={14} aria-hidden="true" /> : <ArrowUp size={14} aria-hidden="true" />} value={s.sort?.key ?? ""}
        choices={[{ key: "", label: canReorder ? "Manual order (drag)" : "Default order" }, ...cols.filter((c) => c.kind !== "view" || c.sortValue).map((c) => ({ key: c.key, label: c.label }))]}
        onPick={(k) => set({ sort: k ? { key: k, up: s.sort?.key === k ? !s.sort.up : true } : null })} />
      {kind === "sheet" ? <Pick label="Fields" icon={<Columns3 size={14} aria-hidden="true" />} value="" multi values={visibleCols.map((c) => c.key)}
        choices={cols.filter((c) => c !== titleCol).map((c) => ({ key: c.key, label: c.label }))}
        onPick={(k) => { const c = cols.find((x) => x.key === k)!; const on = visibleCols.includes(c);
          set({ hidden: c.hidden ? (on ? s.hidden.filter((h) => h !== `+${k}`) : [...s.hidden, `+${k}`]) : on ? [...s.hidden, k] : s.hidden.filter((h) => h !== k) }); }} /> : null}
      <span className={css.save} data-state={error ? "error" : busy ? "saving" : "saved"} aria-live="polite"><i aria-hidden="true" />{error ? error : busy ? "Saving…" : "Saved"}</span>
      </div>
    </div>
    <p className={css.count}>{shown.length === all.length ? `${all.length} ${all.length === 1 ? noun : nouns}` : `${shown.length} of ${all.length} ${nouns}`}
      {kind === "sheet" ? <span className={css.hint}> · click a cell to edit · Enter saves · Tab moves on · Space selects · n adds</span> : null}</p>

    {extra ? extra.render(shown) : kind === "board" && boardCol ? <Board {...{ cols, people, boardCol, shown, canEdit, onOpen, cardExtra, temp, adding, setAdding, create, createMany, groupFields, moveBefore, manual, noun, patch }} canCreate={!!(canCreate && onCreate)} />
      : kind === "gallery" ? <Gallery {...{ cols, people, shown, onOpen, cardExtra, titleCol, sel, toggle }} />
      : kind === "free" ? <Free {...{ cols, people, shown, onOpen, titleCol, s, set }} />
      : <Sheet {...{ cols: kind === "compact" ? cols.filter((c) => c.kind === "title" || (visibleCols.includes(c) && ["select", "person", "score"].includes(c.kind))) : visibleCols, people, groups, groupCol,
        flat, canEdit, onOpen, sel, toggle, setSel, manual, moveBefore, patch, temp, adding, setAdding, create, createMany, groupFields, links, noun, titleCol, removeSelected }}
        compact={kind === "compact"} canCreate={!!(canCreate && onCreate)} canRemove={!!(canRemove && onBulk)} />}

    {selected.length ? <div className={css.bulk} role="toolbar" aria-label={`${selected.length} selected`}>
      <b>{selected.length} selected</b>
      {bulk.map((k) => { const c = cols.find((x) => x.key === k); return c && onBulk ? <Pick key={k} label={c.label} value="" choices={choicesOf(c, people)} onPick={(v) => bulkSet(k, v === "" ? null : c.kind === "score" ? Number(v) : v)} up /> : null; })}
      {bulkExtra?.(selected, () => setSel([]))}
      {canRemove && onBulk ? <button type="button" className={css.bulkDanger} onClick={removeSelected}><Trash2 size={15} aria-hidden="true" />Delete</button> : null}
      <button type="button" className={css.iconBtn} onClick={() => setSel([])} aria-label="Clear the selection"><X size={16} /></button>
    </div> : null}
  </div>;
}

/* ------------------------------------------------------------------------------------------------ the sheet */

type SheetProps<R extends Row> = {
  cols: Col<R>[]; people: Person[]; groups: { key: string; label: string; rows: R[] }[]; groupCol: Col<R> | null; flat: R[]; canEdit: (r: R) => boolean; onOpen?: (id: string) => void;
  sel: string[]; toggle: (id: string, range?: boolean) => void; setSel: (ids: string[]) => void; manual: boolean; moveBefore: (id: string, target: string | null, after?: boolean, field?: { key: string; value: unknown }) => void;
  patch: (r: R, field: string, value: unknown) => void; temp: { tid: string; title: string; fields: Record<string, unknown> }[]; adding: string | null; setAdding: (g: string | null) => void;
  create: (title: string, fields: Record<string, unknown>) => void; createMany: (lines: string[], fields: Record<string, unknown>) => void; groupFields: (g: string) => Record<string, unknown>;
  links?: { key: string; label: string }[]; noun: string; titleCol: Col<R>; compact: boolean; canCreate: boolean; canRemove: boolean; removeSelected: () => void;
};

function Sheet<R extends Row>(p: SheetProps<R>) {
  const { cols, people, groups, groupCol, flat, canEdit, onOpen, sel, toggle, setSel, manual, moveBefore, patch, temp, adding, setAdding, create, createMany, groupFields, links, noun, titleCol, compact, canCreate, canRemove, removeSelected } = p;
  const wrap = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ r: string; c: number } | null>(null);
  const [edit, setEdit] = useState<{ r: string; c: number; seed?: string } | null>(null);
  const [closed, setClosed] = useState<string[]>([]);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const editable = (r: R, c: Col<R>) => c.kind !== "view" && c.editable !== false && canEdit(r);
  const focusCell = useCallback((r: string, c: number) => { setAt({ r, c }); requestAnimationFrame(() => wrap.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)?.focus()); }, []);
  const visibleRows = flat.filter((r) => !groupCol || !closed.includes(keyOf(r, groupCol)));
  const step = (r: string, c: number, dr: number, dc: number) => {
    const i = visibleRows.findIndex((x) => x.id === r);
    let ni = i, nc = c + dc;
    if (nc >= cols.length) { nc = 0; ni += 1; } else if (nc < 0) { nc = cols.length - 1; ni -= 1; }
    ni = Math.max(0, Math.min(visibleRows.length - 1, ni + dr));
    const row = visibleRows[ni]; if (row) focusCell(row.id, Math.max(0, Math.min(cols.length - 1, nc)));
    return row ? { r: row.id, c: nc } : null;
  };
  const commit = (r: R, c: Col<R>, value: unknown, move?: 1 | -1 | "down" | "stay") => {
    setEdit(null);
    if (c.kind === "number" || c.kind === "money") { const t = String(value ?? "").replace(/[,₹$\s]/g, ""); value = t === "" ? null : Number(t); if (value !== null && !Number.isFinite(value)) value = null; }
    if (c.kind === "score") value = Math.max(1, Math.min(5, Number(value) || 3));
    if ((c.kind === "select" || c.kind === "person") && value === "") value = null;
    if (c.kind === "title" && String(value ?? "").trim().length < 2) { focusCell(r.id, cols.indexOf(c)); return; }
    patch(r, c.key, value);
    const ci = cols.indexOf(c);
    if (move === "down") step(r.id, ci, 1, 0);
    else if (move === "stay") focusCell(r.id, ci);
    else if (move) { const next = step(r.id, ci, 0, move); if (next) { const row = visibleRows.find((x) => x.id === next.r); const col = cols[next.c]; if (row && col && editable(row, col)) setEdit({ r: next.r, c: next.c }); } }
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (edit || !at) return;
    const t = e.target as HTMLElement; if (!t.dataset.r) return;
    const r = visibleRows.find((x) => x.id === at.r); if (!r) return;
    const c = cols[at.c];
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && manual) {
      e.preventDefault(); const i = flat.findIndex((x) => x.id === r.id); const other = flat[i + (e.key === "ArrowUp" ? -1 : 1)];
      if (other) { moveBefore(r.id, other.id, e.key === "ArrowDown"); focusCell(r.id, at.c); } return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); step(r.id, at.c, 1, 0); }
    else if (e.key === "ArrowUp") { e.preventDefault(); step(r.id, at.c, -1, 0); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(r.id, at.c, 0, 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(r.id, at.c, 0, -1); }
    else if (e.key === "Tab") { const n = step(r.id, at.c, 0, e.shiftKey ? -1 : 1); if (n) e.preventDefault(); }
    else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); onOpen?.(r.id); }
    else if ((e.key === "Enter" || e.key === "F2") && c && editable(r, c)) { e.preventDefault(); setEdit({ r: r.id, c: at.c }); }
    else if (e.key === " ") { e.preventDefault(); toggle(r.id, e.shiftKey); }
    else if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setSel(flat.map((x) => x.id)); }
    else if (e.key === "Escape") { setSel([]); }
    else if ((e.key === "Delete" || e.key === "Backspace") && sel.length && canRemove) { e.preventDefault(); removeSelected(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && c && editable(r, c) && c.kind !== "title" && (c.kind !== "select" || c.nullable) && c.kind !== "score") { e.preventDefault(); patch(r, c.key, c.kind === "text" || c.kind === "long" ? "" : null); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && c && editable(r, c)) { e.preventDefault(); setEdit({ r: r.id, c: at.c, seed: e.key }); }
  };
  const dragOver = (e: DragEvent, id: string) => { if (!drag || !manual) return; e.preventDefault(); const b = (e.currentTarget as HTMLElement).getBoundingClientRect(); setOver({ id, after: e.clientY > b.top + b.height / 2 }); };
  const drop = (e: DragEvent, target: R) => {
    if (!drag || !manual) return; e.preventDefault();
    const after = over?.after ?? false; const field = groupCol && keyOf(target, groupCol) !== keyOf(flat.find((x) => x.id === drag) ?? target, groupCol)
      ? { key: groupCol.key, value: valueOf(target, groupCol) ?? null } : undefined;
    if (drag !== target.id) moveBefore(drag, target.id, after, field);
    setDrag(null); setOver(null);
  };
  const firstCell = visibleRows[0]?.id;
  const span = cols.length + 2;
  const tempFor = (g: string) => temp.filter((t) => g === "*" || !groupCol || String(t.fields[groupCol.key] ?? "") === g);

  return <div ref={wrap} className={compact ? css.compactWrap : css.sheetWrap} onKeyDown={keys}>
    <table className={css.table} data-compact={compact ? "" : undefined} aria-label={`${noun} sheet`} aria-multiselectable="true">
      <colgroup><col style={{ width: 52 }} />{cols.map((c) => <col key={c.key} className={c.kind === "title" ? css.titleCol : undefined} style={{ width: c.kind === "title" ? (compact ? Math.min(c.width ?? 300, 260) : c.width ?? 300) : c.width ?? (c.kind === "long" ? 280 : c.kind === "score" ? 96 : 150) }} />)}<col style={{ width: 40 }} /></colgroup>
      {compact ? null : <thead><tr>
        <th scope="col" className={css.selHead}><input type="checkbox" aria-label="Select all" checked={flat.length > 0 && sel.length === flat.length} onChange={(e) => setSel(e.target.checked ? flat.map((x) => x.id) : [])} /></th>
        {cols.map((c) => <th key={c.key} scope="col" className={c.kind === "number" || c.kind === "money" ? css.num : undefined}>{c.label}</th>)}<th aria-hidden="true" />
      </tr></thead>}
      {groups.map((g) => { const isClosed = !!groupCol && closed.includes(g.key);
        return <tbody key={g.key}>
          {groupCol ? <tr className={css.groupRow}><th colSpan={span} scope="colgroup">
            <button type="button" className={css.groupBtn} aria-expanded={!isClosed} onClick={() => setClosed((x) => isClosed ? x.filter((k) => k !== g.key) : [...x, g.key])}>
              {isClosed ? <ChevronRight size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}<b>{g.label || "None"}</b><small>{g.rows.length}</small></button></th></tr> : null}
          {isClosed ? null : g.rows.map((r) => { const on = sel.includes(r.id);
            return <tr key={r.id} className={css.row} data-on={on ? "" : undefined} aria-selected={on} data-over={over?.id === r.id ? (over.after ? "after" : "before") : undefined}
              onDragOver={(e) => dragOver(e, r.id)} onDrop={(e) => drop(e, r)}>
              <td className={css.selCell}>
                <span className={css.handle} draggable={manual} onDragStart={(e) => { setDrag(r.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); }}
                  onDragEnd={() => { setDrag(null); setOver(null); }} title={manual ? "Drag to reorder (Alt+↑/↓)" : "Clear the sort to reorder"} aria-hidden="true" data-off={manual ? undefined : ""}><GripVertical size={14} /></span>
                <input type="checkbox" checked={on} aria-label={`Select ${text(valueOf(r, titleCol))}`} onChange={() => undefined} onClick={(e) => toggle(r.id, e.shiftKey)} />
              </td>
              {cols.map((c, ci) => { const isEdit = edit?.r === r.id && edit.c === ci;
                return <td key={c.key} data-r={r.id} data-c={ci} tabIndex={(at ? at.r === r.id && at.c === ci : r.id === firstCell && ci === 0) ? 0 : -1}
                  className={`${css.cell} ${c.kind === "number" || c.kind === "money" ? css.num : ""}`} data-kind={c.kind} data-edit={isEdit ? "" : undefined} data-ro={editable(r, c) ? undefined : ""}
                  onFocus={() => setAt({ r: r.id, c: ci })}
                  onClick={() => { setAt({ r: r.id, c: ci }); if (!isEdit && editable(r, c)) setEdit({ r: r.id, c: ci }); }}>
                  {isEdit ? <CellEditor c={c} r={r} people={people} seed={edit.seed} links={links} onDone={(v, move) => commit(r, c, v, move)} onCancel={() => { setEdit(null); focusCell(r.id, ci); }} onDismiss={() => setEdit(null)} />
                    : <CellView c={c} r={r} people={people} />}
                </td>; })}
              <td className={css.openCell}>{onOpen ? <button type="button" className={css.open} onClick={() => onOpen(r.id)} aria-label={`Open ${text(valueOf(r, titleCol))}`} title="Open (Shift+Enter)"><Expand size={14} /></button> : null}</td>
            </tr>; })}
          {isClosed ? null : tempFor(g.key).map((t) => <tr key={t.tid} className={css.tempRow}><td /><td colSpan={cols.length + 1}>{t.title}<small>adding…</small></td></tr>)}
          {canCreate && !isClosed ? <tr className={css.newRow}><td colSpan={span}>
            {adding === g.key ? <NewInput noun={noun} onCreate={(title) => create(title, groupFields(g.key))} onMany={(lines) => createMany(lines, groupFields(g.key))} onClose={() => setAdding(null)} />
              : <button type="button" className={css.newLine} onClick={() => setAdding(g.key)}><Plus size={15} aria-hidden="true" />New {noun}</button>}
          </td></tr> : null}
        </tbody>; })}
    </table>
    {!flat.length && !temp.length ? <p className={css.empty}>No {noun} matches. {canCreate ? "Press n to add one." : ""}</p> : null}
  </div>;
}

function NewInput({ noun, onCreate, onMany, onClose }: { noun: string; onCreate: (title: string) => void; onMany: (lines: string[]) => void; onClose: () => void }) {
  const [v, setV] = useState("");
  return <span className={css.newInput}><Plus size={15} aria-hidden="true" />
    <input autoFocus value={v} placeholder={`Name the ${noun}, Enter to add; paste a list to add many`} aria-label={`New ${noun}`} onChange={(e) => setV(e.target.value)}
      onPaste={(e) => { const t = e.clipboardData.getData("text"); const lines = t.split(/\r?\n/).map((x) => x.replace(/^[-*•\d.)\s]+(?=\S)/, "").trimEnd()).filter((x) => x.trim()); if (lines.length > 1) { e.preventDefault(); onMany(lines); setV(""); } }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (v.trim().length >= 2) { onCreate(v); setV(""); } } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}
      onBlur={() => { if (!v.trim()) onClose(); }} />
    <kbd>Enter</kbd></span>;
}

export function CellView<R>({ c, r, people }: { c: Col<R>; r: R; people: Person[] }) {
  if (c.render) return <>{c.render(r)}</>;
  const v = valueOf(r, c);
  if (c.kind === "select") { const o = c.options?.find((x) => x.key === v); return o ? <span className={css.chip} style={{ "--tone": o.tone ?? "var(--muted)" } as CSSProperties}><i />{o.label}</span> : <span className={css.faint}>{EMPTY}</span>; }
  if (c.kind === "person") { const name = people.find((x) => x.id === v)?.name; return name ? <span className={css.person}><i style={{ "--h": hueOf(name) } as CSSProperties}>{initials(name)}</i>{name}</span> : <span className={css.faint}>{EMPTY}</span>; }
  if (c.kind === "score") { const n = Number(v) || 0; return <span className={css.score} aria-label={`${n} of 5`}>{[1, 2, 3, 4, 5].map((i) => <i key={i} data-on={i <= n ? "" : undefined} />)}<b>{n}</b></span>; }
  if (c.kind === "money") return v === null || v === undefined ? <span className={css.faint}>{EMPTY}</span> : <>{fmtMoney(v, c.currency)}</>;
  if (c.kind === "long") { const t = text(v); return t ? <span className={css.clip} title={t.slice(0, 400)}>{t.split("\n")[0]}</span> : <span className={css.faint}>{c.placeholder ?? ""}</span>; }
  if (c.kind === "title") return <span className={css.titleText}>{text(v) || <span className={css.faint}>Untitled</span>}</span>;
  return text(v) ? <span className={css.clip} title={text(v)}>{text(v)}</span> : <span className={css.faint}>{c.placeholder ?? ""}</span>;
}

function CellEditor<R>({ c, r, people, seed, links, onDone, onCancel, onDismiss }: { c: Col<R>; r: R; people: Person[]; seed?: string; links?: { key: string; label: string }[];
  onDone: (v: unknown, move?: 1 | -1 | "down" | "stay") => void; onCancel: () => void; onDismiss: () => void }) {
  const cell = useRef<HTMLSpanElement>(null);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [v, setV] = useState(() => seed !== undefined && !["select", "person", "score"].includes(c.kind) ? seed : text(valueOf(r, c)));
  useEffect(() => { const el = cell.current?.closest("td") ?? null; const raf = requestAnimationFrame(() => setAnchorEl(el)); return () => cancelAnimationFrame(raf); }, []);
  if (c.kind === "select" || c.kind === "person" || c.kind === "score") {
    return <span ref={cell}><CellView c={c} r={r} people={people} />
      {anchorEl ? <Floating anchor={anchorEl} onClose={onDismiss} label={c.label}>
        <OptionList choices={choicesOf(c, people)} value={[keyOf(r, c)]} onPick={(k, move) => onDone(k, move ?? "stay")} onCancel={onCancel} placeholder={`${c.label}…`} />
      </Floating> : null}</span>;
  }
  if (c.kind === "long") {
    return <span ref={cell}><span className={css.clip}>{v.split("\n")[0]}</span>
      {anchorEl ? <Floating anchor={anchorEl} onClose={() => onDone(v)} width={460} label={c.label}>
        <div className={css.longEdit}>
          <SlashText className={css.longArea} value={v} onValue={setV} links={links} autoFocus enterSubmits onSubmit={() => onDone(v, "stay")} onCancel={onCancel}
            onKeyDown={(e) => { if (e.key === "Tab") { e.preventDefault(); onDone(v, e.shiftKey ? -1 : 1); } }} aria-label={c.label} rows={6} />
          <small>Enter saves · Shift+Enter new line · / for blocks · Esc cancels</small>
        </div>
      </Floating> : null}</span>;
  }
  return <input className={css.cellInput} autoFocus value={v} inputMode={c.kind === "number" || c.kind === "money" ? "decimal" : undefined} aria-label={c.label}
    onFocus={(e) => { if (seed === undefined) e.target.select(); }}
    onChange={(e) => setV(e.target.value)} onBlur={() => onDone(v)}
    onKeyDown={(e) => { e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); onDone(v, "stay"); }
      else if (e.key === "Tab") { e.preventDefault(); onDone(v, e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); } }} />;
}

/* ------------------------------------------------------------------------------------------------ board */

function Board<R extends Row>({ cols, people, boardCol, shown, canEdit, onOpen, cardExtra, temp, adding, setAdding, create, createMany, groupFields, moveBefore, manual, noun, patch, canCreate }: {
  cols: Col<R>[]; people: Person[]; boardCol: Col<R>; shown: R[]; canEdit: (r: R) => boolean; onOpen?: (id: string) => void; cardExtra?: (r: R) => ReactNode;
  temp: { tid: string; title: string; fields: Record<string, unknown> }[]; adding: string | null; setAdding: (g: string | null) => void; create: (t: string, f: Record<string, unknown>) => void;
  createMany: (l: string[], f: Record<string, unknown>) => void; groupFields: (g: string) => Record<string, unknown>; manual: boolean; noun: string; canCreate: boolean;
  moveBefore: (id: string, target: string | null, after?: boolean, field?: { key: string; value: unknown }) => void; patch: (r: R, field: string, value: unknown) => void }) {
  const lanes = choicesOf(boardCol, people);
  const titleCol = cols.find((c) => c.kind === "title") ?? cols[0];
  const chips = cols.filter((c) => c !== boardCol && (c.kind === "select" || c.kind === "person" || c.kind === "score") && !c.hidden).slice(0, 3);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; el: HTMLElement } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const toLane = (id: string, laneKey: string, before: string | null = null) => {
    const value = laneKey === "" ? null : boardCol.kind === "score" ? Number(laneKey) : laneKey;
    if (manual) moveBefore(id, before, false, { key: boardCol.key, value });
    else { const r = shown.find((x) => x.id === id); if (r) patch(r, boardCol.key, value); }
  };
  const cardKeys = (e: KeyboardEvent<HTMLElement>, r: R, li: number) => {
    if (e.target !== e.currentTarget) return;
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && canEdit(r)) {
      e.preventDefault(); const next = lanes[li + (e.key === "ArrowLeft" ? -1 : 1)]; if (next) { toLane(r.id, next.key); requestAnimationFrame(() => wrap.current?.querySelector<HTMLElement>(`[data-card="${r.id}"]`)?.focus()); } return;
    }
    if (e.key === "Enter") { e.preventDefault(); onOpen?.(r.id); return; }
    const moveFocus = (lane: number, idx: number) => { const el = wrap.current?.querySelectorAll<HTMLElement>(`[data-lane="${lane}"] [data-card]`)[idx]; el?.focus(); };
    const idx = [...(wrap.current?.querySelectorAll(`[data-lane="${li}"] [data-card]`) ?? [])].indexOf(e.currentTarget);
    if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(li, idx + 1); } else if (e.key === "ArrowUp") { e.preventDefault(); moveFocus(li, Math.max(0, idx - 1)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); moveFocus(li + 1, 0); } else if (e.key === "ArrowLeft") { e.preventDefault(); moveFocus(li - 1, 0); }
  };
  return <div ref={wrap} className={css.board} style={{ "--lanes": lanes.length } as CSSProperties}>
    {lanes.map((lane, li) => { const own = shown.filter((r) => keyOf(r, boardCol) === lane.key);
      return <section key={lane.key || "none"} className={css.lane} data-lane={li} data-over={over === lane.key ? "" : undefined} aria-label={lane.label}
        onDragOver={(e) => { if (drag) { e.preventDefault(); setOver(lane.key); } }} onDragLeave={() => setOver(null)}
        onDrop={(e) => { e.preventDefault(); if (drag) toLane(drag, lane.key); setDrag(null); setOver(null); }}>
        <header className={css.laneHead}>{lane.swatch ? <i className={css.swatch} style={{ background: lane.swatch }} aria-hidden="true" /> : null}<b>{lane.label}</b><small>{own.length}</small>
          {canCreate ? <button type="button" className={css.iconBtn} onClick={() => setAdding(lane.key)} aria-label={`New ${noun} in ${lane.label}`}><Plus size={15} /></button> : null}</header>
        {own.map((r) => <article key={r.id} data-card={r.id} className={css.card} tabIndex={0} draggable={canEdit(r)} data-drag={drag === r.id ? "" : undefined}
          onDragStart={(e) => { setDrag(r.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); }} onDragEnd={() => { setDrag(null); setOver(null); }}
          onDragOver={(e) => { if (drag && drag !== r.id) { e.preventDefault(); e.stopPropagation(); setOver(lane.key); } }}
          onDrop={(e) => { if (!drag) return; e.preventDefault(); e.stopPropagation(); if (drag !== r.id) toLane(drag, lane.key, r.id); setDrag(null); setOver(null); }}
          onKeyDown={(e) => cardKeys(e, r, li)} onClick={() => onOpen?.(r.id)} aria-label={text(valueOf(r, titleCol))}>
          <p className={css.cardTitle}>{text(valueOf(r, titleCol))}</p>
          {cardExtra?.(r)}
          <span className={css.cardChips}>
            {chips.filter((c) => keyOf(r, c) !== "").map((c) => <CellView key={c.key} c={c} r={r} people={people} />)}
            {canEdit(r) ? <button type="button" className={css.moveBtn} aria-label={`Move to another ${boardCol.label.toLowerCase()}`} title={`${boardCol.label} (Alt+←/→)`}
              onClick={(e) => { e.stopPropagation(); setMenu({ id: r.id, el: e.currentTarget }); }}><ChevronDown size={14} /></button> : null}
          </span>
        </article>)}
        {temp.filter((t) => String(t.fields[boardCol.key] ?? "") === lane.key).map((t) => <article key={t.tid} className={css.card} data-temp=""><p className={css.cardTitle}>{t.title}</p></article>)}
        {adding === lane.key ? <NewInput noun={noun} onCreate={(title) => create(title, groupFields(lane.key))} onMany={(lines) => createMany(lines, groupFields(lane.key))} onClose={() => setAdding(null)} />
          : !own.length ? <p className={css.laneEmpty}>Drop here{canCreate ? " or press +" : ""}</p> : null}
      </section>; })}
    {menu ? <Floating anchor={menu.el} onClose={() => setMenu(null)} label={boardCol.label}>
      <OptionList choices={lanes} value={[keyOf(shown.find((x) => x.id === menu.id) ?? ({} as R), boardCol)]} onPick={(k) => { toLane(menu.id, k); setMenu(null); }} onCancel={() => setMenu(null)} />
    </Floating> : null}
  </div>;
}

/* ------------------------------------------------------------------------------------------------ gallery, free */

function Gallery<R extends Row>({ cols, people, shown, onOpen, cardExtra, titleCol, sel, toggle }: { cols: Col<R>[]; people: Person[]; shown: R[]; onOpen?: (id: string) => void;
  cardExtra?: (r: R) => ReactNode; titleCol: Col<R>; sel: string[]; toggle: (id: string, range?: boolean) => void }) {
  const long = cols.find((c) => c.kind === "long" && !c.hidden);
  const chips = cols.filter((c) => (c.kind === "select" || c.kind === "person") && !c.hidden).slice(0, 3);
  return <ul className={css.gallery}>{shown.map((r) => <li key={r.id}>
    <article className={css.gCard} tabIndex={0} data-on={sel.includes(r.id) ? "" : undefined} onClick={() => onOpen?.(r.id)}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen?.(r.id); else if (e.key === " ") { e.preventDefault(); toggle(r.id, e.shiftKey); } }}>
      <p className={css.cardTitle}>{text(valueOf(r, titleCol))}</p>
      {long ? <p className={css.gText}>{text(valueOf(r, long)) || <span className={css.faint}>No {long.label.toLowerCase()} yet</span>}</p> : null}
      {cardExtra?.(r)}
      <span className={css.cardChips}>{chips.filter((c) => keyOf(r, c) !== "").map((c) => <CellView key={c.key} c={c} r={r} people={people} />)}</span>
    </article></li>)}</ul>;
}

function Free<R extends Row>({ cols, people, shown, onOpen, titleCol, s, set }: { cols: Col<R>[]; people: Person[]; shown: R[]; onOpen?: (id: string) => void; titleCol: Col<R>;
  s: GridSettings; set: (p: Partial<GridSettings>) => void }) {
  const chip = cols.find((c) => c.kind === "select" && c.group);
  const [live, setLive] = useState<Record<string, [number, number]>>({});
  const dragging = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const place = (r: R, i: number): [number, number] => live[r.id] ?? s.positions[r.id] ?? [16 + (i % 4) * 236, 16 + Math.floor(i / 4) * 128];
  const spots = shown.map((r, i) => place(r, i));
  const h = Math.max(520, ...spots.map((p) => p[1] + 160)), w = Math.max(980, ...spots.map((p) => p[0] + 240));
  return <div className={css.freeWrap}>
    <p className={css.hint}>Drag cards anywhere; the layout is kept in this view. Double-click or Enter opens one.</p>
    <div className={css.free} style={{ height: h, width: w }}>
      {shown.map((r, i) => { const [x, y] = spots[i];
        return <article key={r.id} className={css.freeCard} style={{ transform: `translate(${x}px, ${y}px)` }} tabIndex={0}
          onPointerDown={(e) => { const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect(); dragging.current = { id: r.id, dx: e.clientX - box.left - x, dy: e.clientY - box.top - y, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => { const d = dragging.current; if (!d || d.id !== r.id) return; const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
            d.moved = true; setLive((p) => ({ ...p, [r.id]: [Math.max(0, Math.round(e.clientX - box.left - d.dx)), Math.max(0, Math.round(e.clientY - box.top - d.dy))] })); }}
          onPointerUp={() => { const d = dragging.current; dragging.current = null; if (d?.moved && live[r.id]) set({ positions: { ...s.positions, [r.id]: live[r.id] } }); }}
          onDoubleClick={() => onOpen?.(r.id)} onKeyDown={(e) => { if (e.key === "Enter") onOpen?.(r.id); }}>
          <p className={css.cardTitle}>{text(valueOf(r, titleCol))}</p>
          {chip ? <CellView c={chip} r={r} people={people} /> : null}
        </article>; })}
    </div>
  </div>;
}

/* ------------------------------------------------------------------------------------------------ toolbar pieces */

function Pick({ label, icon, value, values, choices, onPick, multi, up }: { label: string; icon?: ReactNode; value: string; values?: string[]; choices: Choice[]; onPick: (k: string) => void; multi?: boolean; up?: boolean }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const current = choices.find((c) => c.key === value && value !== "");
  return <>
    <button type="button" className={up ? css.bulkBtn : css.tool} aria-haspopup="listbox" aria-expanded={!!el} onClick={(e) => setEl(el ? null : e.currentTarget)}>
      {icon}{label}{current && !multi ? <b>: {current.label}</b> : null}<ChevronDown size={13} aria-hidden="true" /></button>
    {el ? <Floating anchor={el} onClose={() => setEl(null)} label={label}>
      <OptionList choices={choices} value={multi ? values ?? [] : [value]} multi={multi} onPick={(k) => { onPick(k); if (!multi) setEl(null); }} onCancel={() => setEl(null)} placeholder={`${label}…`} />
    </Floating> : null}
  </>;
}

function FilterChip<R>({ c, people, values, onChange }: { c: Col<R>; people: Person[]; values: string[]; onChange: (v: string[]) => void }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const ch = choicesOf(c, people);
  const choices = ch.some((x) => x.key === "") ? ch : [...ch, { key: "", label: "None" }];
  return <>
    <button type="button" className={css.tool} data-on={values.length ? "" : undefined} aria-expanded={!!el} onClick={(e) => setEl(el ? null : e.currentTarget)}>
      {values.length ? <Filter size={13} aria-hidden="true" /> : <ListFilter size={13} aria-hidden="true" />}{c.label}{values.length ? <b>: {values.length === 1 ? choices.find((x) => x.key === values[0])?.label : values.length}</b> : null}</button>
    {el ? <Floating anchor={el} onClose={() => setEl(null)} label={`Filter by ${c.label}`}>
      <OptionList choices={choices} value={values} multi onPick={(k) => onChange(values.includes(k) ? values.filter((x) => x !== k) : [...values, k])} onCancel={() => setEl(null)} placeholder={`${c.label}…`} />
      {values.length ? <button type="button" className={css.link} onClick={() => { onChange([]); setEl(null); }}>Clear</button> : null}
    </Floating> : null}
  </>;
}

function SavedViews({ saved, current, apply }: { saved: ReturnType<typeof useSavedViews>; current: GridSettings; apply: (b: Partial<GridSettings>) => void }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [name, setName] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const body: Partial<GridSettings> = { kind: current.kind, filters: current.filters, sort: current.sort, groupBy: current.groupBy, boardBy: current.boardBy, hidden: current.hidden, query: current.query, positions: current.positions };
  const act = saved.views.find((v) => v.id === active);
  return <>
    <button type="button" className={css.tool} aria-expanded={!!el} onClick={(e) => setEl(el ? null : e.currentTarget)}><Bookmark size={14} aria-hidden="true" /><span className={css.kindLabel}>{act ? act.name : "Views"}</span><ChevronDown size={13} aria-hidden="true" /></button>
    {el ? <Floating anchor={el} onClose={() => setEl(null)} label="Saved views" width={300}>
      <div className={css.views}>
        <p className={css.viewsHead}>Your saved views</p>
        {saved.views.length ? saved.views.map((v) => <span key={v.id} className={css.viewRow}>
          <button type="button" className={css.optRow} data-on={v.id === active ? "" : undefined} onClick={() => { apply(v.body); setActive(v.id); setEl(null); }}><span>{v.name}</span>{v.id === active ? <Check size={14} aria-hidden="true" /> : null}</button>
          <button type="button" className={css.iconBtn} aria-label={`Delete the view ${v.name}`} onClick={() => { void saved.remove(v.id).catch(() => undefined); if (active === v.id) setActive(null); }}><Trash2 size={14} /></button>
        </span>) : <p className={css.optEmpty}>None yet: set filters, sort and grouping, then save them here.</p>}
        {act ? <button type="button" className={css.link} onClick={() => { void saved.update(act.id, body).catch(() => undefined); setEl(null); }}>Update “{act.name}” with what you see</button> : null}
        <form className={css.viewSave} onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; void saved.save(name.trim(), body).then((r) => { if (r?.id) setActive(r.id); }).catch(() => undefined); setName(""); setEl(null); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this view" aria-label="Name this view" maxLength={60} />
          <button type="submit" className={css.newBtn} disabled={!name.trim()}>Save</button>
        </form>
        {saved.error ? <p className={css.optEmpty} role="alert">{saved.error}</p> : null}
      </div>
    </Floating> : null}
  </>;
}
