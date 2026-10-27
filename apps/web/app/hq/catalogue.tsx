"use client";
// PULSE-HQ (owner, 23 Oct 2026): "What Pulse can do", for every organisation (/features) and, editable, for the Pulse
// organisation (/hq/features). Functional first: it opens on every feature in one table, with a summary strip that
// filters by status, grouping (area, status, audience, none) with sticky collapsible group headers, sortable columns,
// filter chips, a column chooser, density, CSV export and full keyboard use. The 13 product areas stay as a second
// view. A row opens a side sheet; every feature also has its own page (<base>/<key>). The view settings are remembered.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Archive, ArrowUpRight, BadgeCheck, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Columns3, Download, LayoutGrid, PenLine, Plus, Rows3, Search, Table2, X } from "lucide-react";
import { AUDIENCES, CATEGORIES, CATEGORY, FEATURE_STATUS, STATUS_ORDER, audiencesOf, type Category, type Feature, type FeatureStatus, type Idea, type Offer, type Person } from "./model";
import { Grid, type Col as GridCol } from "./grid/grid";
import { hqPost, useSoonRefresh } from "./client";
import { FeatureIcon, StatusBars, StatusPill, hue } from "./parts";
import { FeatureSheet } from "./feature-sheet";
import css from "./hq.module.css";

type GroupBy = "area" | "status" | "who" | "none";
type SortKey = "name" | "what" | "area" | "who" | "status" | "reviewed" | "where";
type Col = "what" | "area" | "who" | "status" | "reviewed" | "where";
type Settings = { view: "table" | "areas" | "edit"; groupBy: GroupBy; sort: { key: SortKey; up: boolean }; hidden: Col[]; density: "comfortable" | "compact" };
const DEFAULTS: Settings = { view: "table", groupBy: "area", sort: { key: "name", up: true }, hidden: [], density: "comfortable" };
/** Pulse's editors open on the editable sheet. */
const EDITOR_DEFAULTS: Settings = { ...DEFAULTS, view: "edit" };
const KEY = "pulse.catalogue.settings";
const COLS: { key: Col; label: string }[] = [{ key: "what", label: "What it does" }, { key: "area", label: "Area" }, { key: "who", label: "For whom" },
  { key: "status", label: "Status" }, { key: "reviewed", label: "Reviewed" }, { key: "where", label: "Where" }];

// The remembered view settings, read without a hydration mismatch (the server always draws the defaults).
let cacheRaw: string | null | undefined, cacheBase: Settings | null = null, cacheVal: Settings = DEFAULTS;
function readSettings(base: Settings): Settings {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(KEY); } catch { /* private window */ }
  if (raw !== cacheRaw || base !== cacheBase) { cacheRaw = raw; cacheBase = base; try { cacheVal = { ...base, ...(raw ? JSON.parse(raw) as Partial<Settings> : {}) }; } catch { cacheVal = base; } }
  return cacheVal;
}
function useSettings(base: Settings): [Settings, (patch: Partial<Settings>) => void] {
  const s = useSyncExternalStore((on) => { window.addEventListener("storage", on); window.addEventListener("pulse:catalogue-settings", on);
    return () => { window.removeEventListener("storage", on); window.removeEventListener("pulse:catalogue-settings", on); }; }, () => readSettings(base), () => base);
  const set = useCallback((patch: Partial<Settings>) => {
    try { window.localStorage.setItem(KEY, JSON.stringify({ ...readSettings(base), ...patch })); } catch { /* private window */ }
    window.dispatchEvent(new Event("pulse:catalogue-settings"));
  }, [base]);
  return [s, set];
}

const reviewed = (f: Feature) => !f.draft;
const primaryAudience = (f: Feature) => audiencesOf(f.who)[0] ?? "other";
const audienceLabel = (k: string) => AUDIENCES.find((a) => a.key === k)?.label ?? "Others";

export type CatalogueProps = { features: Feature[]; base: string; title: string; canEdit?: boolean; offers?: Offer[]; ideas?: Idea[]; people?: Person[] };

const NO_PEOPLE: Person[] = [];
export function Catalogue({ features: all, base, title, canEdit = false, offers = [], ideas = [], people = NO_PEOPLE }: CatalogueProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [stored, set] = useSettings(canEdit ? EDITOR_DEFAULTS : DEFAULTS);
  const settings = stored.view === "edit" && !canEdit ? { ...stored, view: "table" as const } : stored;
  const refresh = useCallback(() => router.refresh(), [router]);
  const soon = useSoonRefresh(refresh);
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim().toLowerCase());
  const initialArea = CATEGORIES.find((c) => c.key === params.get("c"))?.key;
  const [statuses, setStatuses] = useState<FeatureStatus[]>([]);
  const [areas, setAreas] = useState<Category[]>(initialArea ? [initialArea] : []);
  const [audiences, setAudiences] = useState<string[]>([]);
  const [review, setReview] = useState<"all" | "reviewed" | "draft">("all");
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const { view, groupBy, sort, hidden, density } = settings;
  // Grouped by area, the rows already sit under their area: the Area column would only repeat it.
  const show = (c: Col) => !hidden.includes(c) && (c !== "reviewed" || canEdit) && !(c === "area" && groupBy === "area");

  const pool = useMemo(() => all.filter((f) => showArchived ? f.archived : !f.archived), [all, showArchived]);
  const shown = useMemo(() => pool.filter((f) => (!statuses.length || statuses.includes(f.status)) && (!areas.length || areas.includes(f.category))
    && (!audiences.length || audiencesOf(f.who).some((a) => audiences.includes(a)))
    && (review === "all" || (review === "reviewed") === reviewed(f))
    && (!q || `${f.name} ${f.promise} ${f.what}`.toLowerCase().includes(q))), [pool, statuses, areas, audiences, review, q]);
  const sorted = useMemo(() => {
    const value = (f: Feature): string | number => sort.key === "status" ? STATUS_ORDER[f.status] : sort.key === "area" ? CATEGORIES.findIndex((c) => c.key === f.category)
      : sort.key === "reviewed" ? (reviewed(f) ? 0 : 1) : sort.key === "where" ? (f.href ? 0 : 1) : sort.key === "what" ? f.promise : sort.key === "who" ? f.who : f.name;
    return [...shown].sort((a, b) => { const x = value(a), y = value(b);
      const by = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return (sort.up ? by : -by) || a.name.localeCompare(b.name); });
  }, [shown, sort]);
  const groups = useMemo(() => {
    if (groupBy === "none") return [{ key: "all", label: "All features", Icon: null as null | typeof Table2, hueOf: null as Category | null, items: sorted }];
    if (groupBy === "area") return CATEGORIES.map((c) => ({ key: c.key, label: c.label, Icon: c.Icon, hueOf: c.key, items: sorted.filter((f) => f.category === c.key) })).filter((g) => g.items.length);
    if (groupBy === "status") return FEATURE_STATUS.map((s) => ({ key: s.key, label: s.label, Icon: null, hueOf: null, items: sorted.filter((f) => f.status === s.key) })).filter((g) => g.items.length);
    return [...AUDIENCES.map((a) => a.key), "other"].map((k) => ({ key: k, label: audienceLabel(k), Icon: null, hueOf: null, items: sorted.filter((f) => primaryAudience(f) === k) })).filter((g) => g.items.length);
  }, [groupBy, sorted]);
  const counts = FEATURE_STATUS.map((s) => ({ ...s, n: pool.filter((f) => f.status === s.key).length }));
  const filtered = statuses.length + areas.length + audiences.length + (review !== "all" ? 1 : 0) + (q ? 1 : 0) > 0;
  const clearAll = () => { setStatuses([]); setAreas([]); setAudiences([]); setReview("all"); setQuery(""); };
  const toggle = <T,>(list: T[], v: T) => list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const drafts = all.filter((f) => f.draft && !f.archived).length;
  const open = openId === "new" ? "new" : all.find((f) => f.id === openId) ?? null;
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.includes(g.key));

  const exportCsv = () => {
    const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = [["Feature", "Promise", "What it does", "Area", "For whom", "Status", ...(canEdit ? ["Reviewed"] : []), "Where"],
      ...sorted.map((f) => [f.name, f.promise, f.what, CATEGORY[f.category].label, f.who, f.status, ...(canEdit ? [reviewed(f) ? "yes" : "no"] : []), f.href ?? ""])];
    const blob = new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `pulse-features-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  return <>
    <header className={css.pageHead}>
      <div><h1>{title}</h1><p>{pool.length} features in {new Set(pool.map((f) => f.category)).size} areas · {counts[0].n} live today</p></div>
      <div className={css.headActions}>
        <button type="button" className={css.secondary} onClick={exportCsv}><Download size={15} aria-hidden="true" />Export CSV</button>
        {canEdit && view !== "edit" ? <button type="button" className={css.primary} data-hq-new="" title="Add feature (n)" onClick={() => setOpenId("new")}><Plus size={16} aria-hidden="true" />Add feature</button> : null}
      </div>
    </header>

    <section className={css.summary} aria-label="Features by status">
      <div className={css.summaryRow} role="group" aria-label="Filter by status">
        <button type="button" className={css.sumBtn} data-on={!statuses.length ? "" : undefined} aria-pressed={!statuses.length} onClick={() => setStatuses([])}>
          <b>{pool.length}</b><span>features</span></button>
        {counts.map((s) => <button key={s.key} type="button" className={css.sumBtn} data-tone={s.key} data-on={statuses.includes(s.key) ? "" : undefined} aria-pressed={statuses.includes(s.key)}
          onClick={() => setStatuses(toggle(statuses, s.key))} title={s.hint}><b>{s.n}</b><span><i aria-hidden="true" />{s.label.toLowerCase()}</span></button>)}
      </div>
      <StatusBars features={pool} />
    </section>
    {canEdit && drafts ? <p className={css.draftNote}><CircleAlert size={17} aria-hidden="true" /><span>First draft from 23 Oct 2026: {drafts} features wait for a review. Filter by Reviewed, open one and mark it reviewed.</span></p> : null}

    <div className={css.toolbar}>
      {view === "edit" ? <span className={css.grow} /> : <label className={css.search}><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search names, promises and what they do" aria-label="Search features" /></label>}
      <div className={css.segment} role="group" aria-label="View">
        <button type="button" data-on={view === "table" ? "" : undefined} aria-pressed={view === "table"} onClick={() => set({ view: "table" })}><Table2 size={15} aria-hidden="true" /><span className={css.segLabel}>All features</span></button>
        <button type="button" data-on={view === "areas" ? "" : undefined} aria-pressed={view === "areas"} onClick={() => set({ view: "areas" })}><LayoutGrid size={15} aria-hidden="true" /><span className={css.segLabel}>Areas</span></button>
        {canEdit ? <button type="button" data-on={view === "edit" ? "" : undefined} aria-pressed={view === "edit"} onClick={() => set({ view: "edit" })}><PenLine size={15} aria-hidden="true" /><span className={css.segLabel}>Edit sheet</span></button> : null}
      </div>
    </div>

    {view === "edit" ? <FeatureGrid features={statuses.length ? pool.filter((f) => statuses.includes(f.status)) : pool} people={people} onOpen={setOpenId} soon={soon} /> : view === "areas" ? <ul className={css.areas} aria-label="Product areas">
      {CATEGORIES.map((c, i) => {
        const own = pool.filter((f) => f.category === c.key);
        if (!own.length) return null;
        return <li key={c.key} style={{ "--i": i } as CSSProperties}>
          <button type="button" className={css.area} style={hue(c.key)} onClick={() => { setAreas([c.key]); set({ view: "table", groupBy: "none" }); }}>
            <span className={css.areaIcon}><c.Icon size={20} aria-hidden="true" /></span>
            <span className={css.areaName}>{c.label}</span>
            <span className={css.areaBlurb}>{c.blurb}</span>
            <span className={css.areaCount}>{own.length} features · {own.filter((f) => f.status === "live").length} live</span>
          </button>
        </li>;
      })}
    </ul> : <>
      <div className={css.filterBar}>
        <Picker label="Area" values={areas} options={CATEGORIES.map((c) => ({ key: c.key, label: c.label }))} onChange={(v) => setAreas(v as Category[])} />
        <Picker label="For whom" values={audiences} options={AUDIENCES.map((a) => ({ key: a.key, label: a.label }))} onChange={setAudiences} />
        {canEdit ? <Picker label="Reviewed" single values={review === "all" ? [] : [review]} options={[{ key: "reviewed", label: "Reviewed" }, { key: "draft", label: "Waiting for review" }]}
          onChange={(v) => setReview((v[0] as "reviewed" | "draft") ?? "all")} /> : null}
        {canEdit ? <button type="button" className={css.chip} data-on={showArchived ? "" : undefined} aria-pressed={showArchived} onClick={() => setShowArchived((x) => !x)}>Archived</button> : null}
        <span className={css.grow} />
        <label className={css.inline}>Group by
          <select className={css.select} value={groupBy} onChange={(e) => set({ groupBy: e.target.value as GroupBy })}>
            <option value="area">Area</option><option value="status">Status</option><option value="who">For whom</option><option value="none">None</option></select></label>
        <Picker label="Columns" icon={<Columns3 size={14} aria-hidden="true" />} values={COLS.filter((c) => !hidden.includes(c.key) && (c.key !== "reviewed" || canEdit)).map((c) => c.key)}
          options={COLS.filter((c) => c.key !== "reviewed" || canEdit).map((c) => ({ key: c.key, label: c.label }))} quiet
          onChange={(v) => set({ hidden: COLS.map((c) => c.key).filter((k) => !v.includes(k)) })} />
        <button type="button" className={css.chip} aria-pressed={density === "compact"} data-on={density === "compact" ? "" : undefined} onClick={() => set({ density: density === "compact" ? "comfortable" : "compact" })} title="Row density">
          <Rows3 size={14} aria-hidden="true" />{density === "compact" ? "Compact" : "Comfortable"}</button>
      </div>
      <div className={css.activeBar} aria-live="polite">
        <span className={css.resultCount}>Showing {shown.length} of {pool.length}</span>
        {statuses.map((s) => <Chip key={s} label={`Status: ${s}`} onRemove={() => setStatuses(statuses.filter((x) => x !== s))} />)}
        {areas.map((a) => <Chip key={a} label={CATEGORY[a].label} onRemove={() => setAreas(areas.filter((x) => x !== a))} />)}
        {audiences.map((a) => <Chip key={a} label={audienceLabel(a)} onRemove={() => setAudiences(audiences.filter((x) => x !== a))} />)}
        {review !== "all" ? <Chip label={review === "reviewed" ? "Reviewed" : "Waiting for review"} onRemove={() => setReview("all")} /> : null}
        {q ? <Chip label={`“${query.trim()}”`} onRemove={() => setQuery("")} /> : null}
        {filtered ? <button type="button" className={css.linkBtn} onClick={clearAll}>Clear all</button> : null}
        <span className={css.grow} />
        {groupBy !== "none" && groups.length ? <button type="button" className={css.linkBtn} onClick={() => setCollapsed(allCollapsed ? [] : groups.map((g) => g.key))}>{allCollapsed ? "Expand all" : "Collapse all"}</button> : null}
      </div>

      {!shown.length ? <div className={css.empty}><Search size={22} aria-hidden="true" /><b>No feature matches</b><span>Change the search or the filters.</span>
        <button type="button" className={css.secondary} onClick={clearAll}>Clear all filters</button></div> : <>
        <FeatureTable groups={groups} groupBy={groupBy} collapsed={collapsed} setCollapsed={setCollapsed} show={show} sort={sort} onSort={(s) => set({ sort: s })}
          density={density} onOpen={setOpenId} />
        <FeatureList groups={groups} groupBy={groupBy} collapsed={collapsed} setCollapsed={setCollapsed} onOpen={setOpenId} />
      </>}
    </>}
    <FeatureSheet open={open} base={base} canEdit={canEdit} offers={offers} ideas={ideas} onClose={close} onSaved={() => router.refresh()} />
  </>;
}

type Group = { key: string; label: string; Icon: null | typeof Table2; hueOf: Category | null; items: Feature[] };

function GroupHead({ g, groupBy, collapsed, setCollapsed }: { g: Group; groupBy: GroupBy; collapsed: string[]; setCollapsed: (v: string[]) => void }) {
  const closed = collapsed.includes(g.key);
  const live = g.items.filter((f) => f.status === "live").length;
  return <button type="button" className={css.groupBtn} aria-expanded={!closed} style={g.hueOf ? hue(g.hueOf) : undefined}
    onClick={() => setCollapsed(closed ? collapsed.filter((k) => k !== g.key) : [...collapsed, g.key])}>
    {closed ? <ChevronRight size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
    {g.Icon ? <span className={css.featIcon}><g.Icon size={15} aria-hidden="true" /></span> : groupBy === "status" ? <StatusPill status={g.key} /> : null}
    {groupBy !== "status" ? <b>{g.label}</b> : null}
    <span className={css.groupMeta}>{g.items.length} · {live} live</span>
    <span className={css.groupBar}><StatusBars features={g.items} /></span>
  </button>;
}

function FeatureTable({ groups, groupBy, collapsed, setCollapsed, show, sort, onSort, density, onOpen }: { groups: Group[]; groupBy: GroupBy; collapsed: string[];
  setCollapsed: (v: string[]) => void; show: (c: Col) => boolean; sort: Settings["sort"]; onSort: (s: Settings["sort"]) => void; density: Settings["density"]; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLTableElement>(null);
  const span = 1 + COLS.filter((c) => show(c.key)).length;
  const keys = (e: KeyboardEvent<HTMLTableElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-row]");
    if (!row || !ref.current) return;
    const rows = [...ref.current.querySelectorAll<HTMLTableRowElement>("tr[data-row]")];
    const at = rows.indexOf(row);
    const go = (i: number) => { const next = rows[Math.max(0, Math.min(rows.length - 1, i))]; next?.focus(); e.preventDefault(); };
    if (e.key === "ArrowDown") go(at + 1); else if (e.key === "ArrowUp") go(at - 1); else if (e.key === "Home") go(0); else if (e.key === "End") go(rows.length - 1);
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(row.dataset.row!); }
  };
  const firstId = groups.find((g) => !collapsed.includes(g.key))?.items[0]?.id;
  return <div className={`${css.tableWrap} ${css.wideOnly}`}>
    <table ref={ref} className={css.table} data-density={density} onKeyDown={keys} aria-label="Pulse features" aria-rowcount={groups.reduce((n, g) => n + g.items.length, 0)}>
      <colgroup><col style={{ width: "24%" }} />{show("what") ? <col /> : null}{show("area") ? <col style={{ width: "13%" }} /> : null}{show("who") ? <col style={{ width: "15%" }} /> : null}
        {show("status") ? <col style={{ width: 104 }} /> : null}{show("reviewed") ? <col style={{ width: 104 }} /> : null}{show("where") ? <col style={{ width: 84 }} /> : null}</colgroup>
      <thead><tr>
        <SortHead label="Feature" k="name" sort={sort} on={onSort} />
        {show("what") ? <SortHead label="What it does" k="what" sort={sort} on={onSort} /> : null}
        {show("area") ? <SortHead label="Area" k="area" sort={sort} on={onSort} /> : null}
        {show("who") ? <SortHead label="For whom" k="who" sort={sort} on={onSort} /> : null}
        {show("status") ? <SortHead label="Status" k="status" sort={sort} on={onSort} /> : null}
        {show("reviewed") ? <SortHead label="Reviewed" k="reviewed" sort={sort} on={onSort} /> : null}
        {show("where") ? <SortHead label="Where" k="where" sort={sort} on={onSort} /> : null}
      </tr></thead>
      {groups.map((g) => <tbody key={g.key}>
        {groupBy !== "none" ? <tr className={css.groupRow}><th colSpan={span} scope="colgroup"><GroupHead g={g} groupBy={groupBy} collapsed={collapsed} setCollapsed={setCollapsed} /></th></tr> : null}
        {collapsed.includes(g.key) ? null : g.items.map((f) => { return <tr key={f.id} data-row={f.id} tabIndex={f.id === firstId ? 0 : -1} className={css.row}
          onClick={() => onOpen(f.id)} aria-label={`${f.name}: ${f.promise}`}>
          <th scope="row"><span className={css.nameCell}><span className={css.featIcon} style={hue(f.category)}><FeatureIcon name={f.icon} size={15} /></span>{f.name}</span></th>
          {show("what") ? <td className={css.oneLine} title={f.promise}>{f.promise}</td> : null}
          {show("area") ? <td className={css.oneLine}>{CATEGORY[f.category].label}</td> : null}
          {show("who") ? <td className={css.oneLine} title={f.who}>{f.who}</td> : null}
          {show("status") ? <td><StatusPill status={f.status} /></td> : null}
          {show("reviewed") ? <td>{f.draft ? <span className={css.faint}>Draft</span> : <span className={css.okText}>Reviewed</span>}</td> : null}
          {show("where") ? <td>{f.href ? <Link href={f.href} className={css.whereLink} tabIndex={-1} onClick={(e: MouseEvent) => e.stopPropagation()} aria-label={`Open ${f.name} in Pulse`}>Open<ArrowUpRight size={13} aria-hidden="true" /></Link> : <span className={css.faint}>—</span>}</td> : null}
        </tr>; })}
      </tbody>)}
    </table>
  </div>;
}

/** On a phone the table reads as a grouped list: the same groups, counts, filters and order. */
function FeatureList({ groups, groupBy, collapsed, setCollapsed, onOpen }: { groups: Group[]; groupBy: GroupBy; collapsed: string[]; setCollapsed: (v: string[]) => void; onOpen: (id: string) => void }) {
  return <div className={css.narrowOnly}>
    {groups.map((g) => <section key={g.key} className={css.listGroup} aria-label={g.label}>
      {groupBy !== "none" ? <div className={css.listHead}><GroupHead g={g} groupBy={groupBy} collapsed={collapsed} setCollapsed={setCollapsed} /></div> : null}
      {collapsed.includes(g.key) ? null : <ul className={css.list}>{g.items.map((f) => <li key={f.id}>
        <button type="button" className={css.itemRow} onClick={() => onOpen(f.id)}>
          <span className={css.featIcon} style={hue(f.category)}><FeatureIcon name={f.icon} size={15} /></span>
          <span className={css.listText}><b>{f.name}</b><span>{f.promise}</span></span>
          <StatusPill status={f.status} />
        </button>
      </li>)}</ul>}
    </section>)}
  </div>;
}

function SortHead({ label, k, sort, on }: { label: string; k: SortKey; sort: Settings["sort"]; on: (s: Settings["sort"]) => void }) {
  const active = sort.key === k;
  return <th scope="col" aria-sort={active ? (sort.up ? "ascending" : "descending") : "none"}>
    <button type="button" className={css.sortBtn} data-on={active ? "" : undefined} onClick={() => on({ key: k, up: active ? !sort.up : true })}>
      {label}{active ? (sort.up ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />) : <ChevronDown size={14} aria-hidden="true" style={{ opacity: 0.3 }} />}
    </button>
  </th>;
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <button type="button" className={css.tag} onClick={onRemove} aria-label={`Remove filter ${label}`}>{label}<X size={13} aria-hidden="true" /></button>;
}

/** A filter chip that opens a small checklist (several values, or one with `single`). */
function Picker({ label, values, options, onChange, single, icon, quiet }: { label: string; values: string[]; options: { key: string; label: string }[];
  onChange: (v: string[]) => void; single?: boolean; icon?: ReactNode; quiet?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const count = !quiet && values.length ? ` · ${values.length}` : "";
  return <div className={css.picker2} ref={box}>
    <button type="button" className={css.chip} data-on={!quiet && values.length ? "" : undefined} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((x) => !x)}>
      {icon}{label}{count}<ChevronDown size={13} aria-hidden="true" /></button>
    {open ? <div className={`${css.pop} ${css.glassThick}`} role="group" aria-label={label}>
      {options.map((o) => <label key={o.key} className={css.check}>
        <input type={single ? "radio" : "checkbox"} name={single ? label : undefined} checked={values.includes(o.key)}
          onChange={() => onChange(single ? (values.includes(o.key) ? [] : [o.key]) : values.includes(o.key) ? values.filter((v) => v !== o.key) : [...values, o.key])} />
        <span>{o.label}</span></label>)}
      {!quiet && values.length ? <button type="button" className={css.linkBtn} onClick={() => onChange([])}>Clear</button> : null}
    </div> : null}
  </div>;
}


const AREA_OPTS = CATEGORIES.map((c) => ({ key: c.key, label: c.label, tone: `hsl(${c.hue} 60% 45%)` }));
const GRID_DEFAULTS = { kind: "sheet", groupBy: "category", boardBy: "status" };
const FEATURE_COLS: GridCol<Feature>[] = [
  { key: "name", label: "Feature", kind: "title", width: 260 },
  { key: "category", label: "Area", kind: "select", options: AREA_OPTS, group: true, width: 170 },
  { key: "status", label: "Status", kind: "select", options: FEATURE_STATUS, group: true, width: 118 },
  { key: "ownerId", label: "Owner", kind: "person", group: true, width: 150 },
  { key: "promise", label: "One-line promise", kind: "text", width: 320 },
  { key: "who", label: "For whom", kind: "text", width: 170 },
  { key: "what", label: "What it does", kind: "long", width: 280, hidden: true },
  { key: "href", label: "Page in Pulse", kind: "text", width: 170, hidden: true },
  { key: "reviewed", label: "Reviewed", kind: "view", width: 104, sortValue: (f) => (f.draft ? 1 : 0), render: (f) => f.draft ? <span className={css.faint}>Draft</span> : <span className={css.okText}>Reviewed</span> },
];

/** Pulse's editors edit the catalogue in place: a sheet grouped by area, a board by status, compact, gallery and free. */
function FeatureGrid({ features, people, onOpen, soon }: { features: Feature[]; people: Person[]; onOpen: (id: string) => void; soon: () => void }) {
  return <Grid<Feature> scope="hq-features" rows={features} cols={FEATURE_COLS} people={people} noun="feature" defaults={GRID_DEFAULTS}
    canEdit={() => true} canCreate canReorder bulk={["status", "category", "ownerId"]}
    onPatch={async (id, patch) => { await hqPost(`features/${id}`, patch); soon(); }}
    onCreate={async (fields) => { await hqPost("features", { ...fields, draft: true }); soon(); }}
    onBatch={async (items) => { await hqPost("features/batch", { items }); soon(); }}
    onBulk={async (ids, patch) => { if (patch) await hqPost("features/bulk", { ids, patch }); soon(); }}
    onReorder={async (ids) => { await hqPost("features/reorder", { ids }); soon(); }}
    onOpen={onOpen}
    bulkExtra={(ids, clear) => <>
      <button type="button" className={css.chip} onClick={() => { void hqPost("features/bulk", { ids, patch: { draft: false } }).then(soon); clear(); }}><BadgeCheck size={14} aria-hidden="true" />Mark reviewed</button>
      <button type="button" className={css.chip} onClick={() => { if (window.confirm(`Archive ${ids.length} feature${ids.length === 1 ? "" : "s"}? They leave "What Pulse can do" and can be restored.`)) { void hqPost("features/bulk", { ids, patch: { archived: true } }).then(soon); clear(); } }}><Archive size={14} aria-hidden="true" />Archive</button>
    </>}
    cardExtra={(f) => f.promise ? <span className={css.cardWho}>{f.promise}</span> : null} />;
}
