"use client";
// TASKS-4A: views everywhere. One toolbar for any list of tasks: the view (List · Board · Table · Calendar · Timeline ·
// Gallery), how to group and sort, filters (status, due, project, person, tags, pool, words) and saved views. The
// choice sits in the URL (so a link opens the same view) and is remembered per place and person; when someone keeps
// coming back to one view, or spends most of their time in it, Pulse asks once whether it should open that way.
import Link from "next/link";
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bookmark, CalendarDays, Columns3, Filter, GanttChartSquare, LayoutGrid, Rows3, Search, Sparkles, Table2, Trash2, X } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { post } from "../../records";
import { Avatar } from "../../ui";
import { Popover, Segmented, Select, Tooltip } from "../../kit";
import type { Task } from "../types";
import { ListView, GalleryView } from "./cards";
import { TableView } from "./table";
import { CalendarView } from "./calendar";
import { TimelineView } from "./timeline";
import { BoardLayout } from "./boards";
import { activeFilters, applyFilters, groupRows, sortRows, writeConfig, DUE_LABEL, GROUP_LABEL, LAYOUT_LABEL, NO_FILTERS, SORT_LABEL, STATUS_LABEL,
  type Due, type Filters, type Group, type Layout, type Place, type SavedView, type Sort, type StatusFilter, type ViewConfig } from "./model";
export type { SavedView };
import css from "./views.module.css";

export type BuiltIn = { key: string; label: string; href: string; icon?: ReactNode; current?: boolean };
const ICON: Record<Layout, typeof Rows3> = { list: Rows3, board: Columns3, table: Table2, calendar: CalendarDays, timeline: GanttChartSquare, gallery: LayoutGrid };
const msg = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
const send = (path: string, body: unknown, keepalive = false) => fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive })
  .then(async (r) => r.ok ? r.json() : null).catch(() => null);

export function TaskViews({ place, prefKey, rows, today, me, initial, ask: initialAsk, saved: initialSaved, builtIns = [], listSlot, pool, layouts, empty, domainOwner, showAssignee = true, extra, lead }: {
  /** Which defaults apply. */ place: Place; /** Where preferences are kept (a place, or a finer one). */ prefKey: string;
  rows: Task[]; today: string; me: string | null; initial: ViewConfig; ask?: Layout | null; saved: SavedView[]; builtIns?: BuiltIn[];
  /** A richer List for this place (My tasks keeps its own list). */ listSlot?: ReactNode; pool?: boolean; layouts?: Layout[]; empty?: ReactNode; domainOwner?: string; showAssignee?: boolean; extra?: ReactNode; /** WORK-UX: whose tasks, on the same row as the view (one row of controls, not two). */ lead?: ReactNode }) {
  const [config, setConfig] = useState<ViewConfig>(initial);
  const [ask, setAsk] = useState<Layout | null>(initialAsk ?? null);
  const [saved, setSaved] = useState(initialSaved);
  const [now] = useState(() => Date.now());
  const since = useRef(0);
  const lastLayout = useRef(config.layout);
  const allowed = layouts ?? ["list", "board", "table", "calendar", "timeline", "gallery"];

  // The URL follows the view without a server round trip; the person's choice is kept a moment later.
  const persist = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const apply = useCallback((next: ViewConfig) => {
    setConfig(next);
    const url = new URL(window.location.href); const q = writeConfig(next, place, url.searchParams);
    window.history.replaceState(window.history.state, "", `${url.pathname}${q.toString() ? `?${q}` : ""}${url.hash}`);
    clearTimeout(persist.current);
    persist.current = setTimeout(() => void send("work/views/pref", { place: prefKey, layout: next.layout, config: { group: next.group, sort: next.sort, filters: next.filters } }), 700);
  }, [place, prefKey]);
  // Time in each view, and switches to it, for "make it your default?".
  const flush = useCallback(async (keepalive = false) => {
    const ms = since.current ? Date.now() - since.current : 0; since.current = Date.now();
    if (ms < 1000) return;
    const r = await send("work/views/use", { place: prefKey, layout: lastLayout.current, ms, switched: false }, keepalive);
    if (r?.ask) setAsk(r.ask);
  }, [prefKey]);
  useEffect(() => {
    if (!me) return;
    since.current = Date.now();
    const hide = () => { if (document.visibilityState === "hidden") void flush(true); else since.current = Date.now(); };
    const tick = setInterval(() => { if (document.visibilityState === "visible") void flush(); }, 120000);
    document.addEventListener("visibilitychange", hide);
    return () => { clearInterval(tick); document.removeEventListener("visibilitychange", hide); void flush(true); };
  }, [me, flush]);
  const setLayout = (layout: Layout) => {
    if (layout === config.layout) return;
    if (me) { void flush(); lastLayout.current = layout; void send("work/views/use", { place: prefKey, layout, ms: 0, switched: true }).then((r) => { if (r?.ask) setAsk(r.ask); }); }
    apply({ ...config, layout });
  };
  const answer = async (yes: boolean) => {
    const l = ask; setAsk(null); if (!l) return;
    await send("work/views/pref", { place: prefKey, answer: { layout: l, yes } });
    if (yes) notify({ id: "view-default", tone: "success", title: `${LAYOUT_LABEL[l]} is your default here`, message: "Change it any time from the view switcher.", timeout: 3200 });
  };
  const setFilters = (f: Partial<Filters>) => apply({ ...config, filters: { ...config.filters, ...f } });

  const filtered = useMemo(() => applyFilters(rows, config.filters, today), [rows, config.filters, today]);
  const sorted = useMemo(() => sortRows(filtered, config.sort), [filtered, config.sort]);
  const buckets = useMemo(() => groupRows(sorted, config.layout === "timeline" && config.group === "none" ? "project" : config.group, today, me), [sorted, config.group, config.layout, today, me]);
  const slot = config.layout === "list" && !!listSlot;
  const n = activeFilters(config.filters);

  return <div className={css.views} data-grow="" data-layout={config.layout}>
    <div className={css.toolbar} role="toolbar" aria-label="View" data-phone-filter="" data-lead={lead ? "" : undefined} data-compact={slot ? "" : undefined}>
      {lead}
      {/* UX-SIMPLE (28 Oct 2026): the six layouts are one short "View" list everywhere (Kazuk: no six-way switcher in
          front of everyone); EST-1199 had it on phones only. */}
      <Select label="View" size="sm" variant="ghost" className={css.viewPick} value={config.layout} onChange={(v) => { if (v) setLayout(v as Layout); }} placement="bottom-start"
        options={allowed.map((l) => ({ value: l, label: LAYOUT_LABEL[l], icon: createElement(ICON[l], { size: 14, "aria-hidden": true }) }))} renderValue={(o) => <><span className={css.muted}>View</span>{o.icon}<span>{o.label}</span></>} />
      {!slot ? <>
        <Select label="Group by" size="sm" variant="ghost" value={config.group} onChange={(v) => apply({ ...config, group: (v ?? "none") as Group })} placement="bottom-start"
          options={(["none", "status", "when", "priority", "person", "project", "kind", "eisenhower"] as Group[]).map((g) => ({ value: g, label: GROUP_LABEL[g] }))} renderValue={(o) => <><span className={css.muted}>Group</span><span>{o.label}</span></>} />
        <Select label="Sort by" size="sm" variant="ghost" value={config.sort} onChange={(v) => apply({ ...config, sort: (v ?? "due") as Sort })}
          options={(["due", "priority", "updated", "created", "title"] as Sort[]).map((s) => ({ value: s, label: SORT_LABEL[s] }))} renderValue={(o) => <><span className={css.muted}>Sort</span><span>{o.label}</span></>} />
        <FilterButton rows={rows} filters={config.filters} onChange={setFilters} count={n} pool={pool} />
      </> : null}
      <span className={css.grow} />
      {extra}
      <SavedViews prefKey={prefKey} builtIns={builtIns} saved={saved} config={config} onSaved={setSaved} onApply={(c) => apply({ ...config, ...c, filters: { ...NO_FILTERS, ...(c.filters ?? {}) } })} />
    </div>
    {n && !slot ? <div className={css.chips} aria-label="Filters in use">
      {config.filters.status !== "open" ? <FilterChip label={`Status: ${STATUS_LABEL[config.filters.status]}`} onRemove={() => setFilters({ status: "open" })} /> : null}
      {config.filters.due !== "any" ? <FilterChip label={DUE_LABEL[config.filters.due]} onRemove={() => setFilters({ due: "any" })} /> : null}
      {config.filters.projects.map((p) => <FilterChip key={p} label={rows.find((t) => (t.projectId ?? "none") === p)?.projectName ?? "No project"} onRemove={() => setFilters({ projects: config.filters.projects.filter((x) => x !== p) })} />)}
      {config.filters.people.map((p) => <FilterChip key={p} label={p === "none" ? "Nobody yet" : rows.find((t) => t.assigneeId === p)?.assigneeName ?? "Someone"} onRemove={() => setFilters({ people: config.filters.people.filter((x) => x !== p) })} />)}
      {config.filters.tags.map((x) => <FilterChip key={x} label={`#${x}`} onRemove={() => setFilters({ tags: config.filters.tags.filter((y) => y !== x) })} />)}
      {config.filters.pool ? <FilterChip label="In the pool" onRemove={() => setFilters({ pool: false })} /> : null}
      {config.filters.q.trim() ? <FilterChip label={`“${config.filters.q.trim()}”`} onRemove={() => setFilters({ q: "" })} /> : null}
      <button type="button" className={css.clear} onClick={() => setFilters({ ...NO_FILTERS })}>Clear all</button>
      <span className={css.muted}>{filtered.length} of {rows.length}</span>
    </div> : null}
    {ask && ask === config.layout ? <p className={css.ask} role="note"><Sparkles size={15} aria-hidden="true" /><span>You keep using <b>{LAYOUT_LABEL[ask]}</b> here. Open it this way by default?</span>
      <button type="button" className={css.askYes} onClick={() => void answer(true)}>Make {LAYOUT_LABEL[ask]} my default</button><button type="button" className={css.askNo} onClick={() => void answer(false)}>No thanks</button></p> : null}
    <div className={css.body} data-grow="">
      {slot ? listSlot
        : !filtered.length ? (empty && !n ? empty : <p className={css.empty}><b>{n ? "Nothing matches these filters" : "Nothing here yet"}</b>{n ? <button type="button" className={css.clear} onClick={() => setFilters({ ...NO_FILTERS })}>Clear the filters</button> : null}</p>)
        : config.layout === "list" ? <ListView buckets={buckets} today={today} me={me} domainOwner={domainOwner} showAssignee={showAssignee} />
        : config.layout === "board" ? <BoardLayout rows={sorted} buckets={buckets} group={config.group} today={today} me={me} now={now} />
        : config.layout === "table" ? <TableView rows={filtered} today={today} me={me} sort={config.sort} onSort={(s) => apply({ ...config, sort: s })} now={now} />
        : config.layout === "calendar" ? <CalendarView rows={filtered} today={today} me={me} />
        : config.layout === "timeline" ? <TimelineView buckets={buckets} today={today} />
        : <GalleryView buckets={buckets} today={today} pool={pool} />}
    </div>
  </div>;
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <span className={css.fchip}>{label}<button type="button" aria-label={`Remove filter: ${label}`} onClick={onRemove}><X size={12} aria-hidden="true" /></button></span>;
}

/** Everything the rows offer to filter by, in one panel. */
function FilterButton({ rows, filters, onChange, count, pool }: { rows: Task[]; filters: Filters; onChange: (f: Partial<Filters>) => void; count: number; pool?: boolean }) {
  const [open, setOpen] = useState(false); const anchor = useRef<HTMLButtonElement>(null);
  const people = useMemo(() => { const m = new Map<string, { id: string; name: string; photoAt: string | null; n: number }>(); for (const t of rows) { const k = t.assigneeId ?? "none"; const p = m.get(k) ?? { id: k, name: t.assigneeName ?? "Nobody yet", photoAt: t.assigneePhotoAt, n: 0 }; p.n++; m.set(k, p); } return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 30); }, [rows]);
  const projects = useMemo(() => { const m = new Map<string, { id: string; name: string; n: number }>(); for (const t of rows) { const k = t.projectId ?? "none"; const p = m.get(k) ?? { id: k, name: t.projectName ?? "No project", n: 0 }; p.n++; m.set(k, p); } return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 24); }, [rows]);
  const tags = useMemo(() => { const m = new Map<string, number>(); for (const t of rows) for (const x of t.tags ?? []) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([x]) => x); }, [rows]);
  const toggle = (list: string[], v: string) => list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  return <>
    <button ref={anchor} type="button" className={css.toolBtn} aria-expanded={open} aria-haspopup="dialog" data-on={count ? "" : undefined} onClick={() => setOpen((o) => !o)}>
      <Filter size={14} aria-hidden="true" />Filter{count ? <span className={css.badge}>{count}</span> : null}</button>
    <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label="Filter tasks" placement="bottom-start" sheet>
      <div className={css.filters}>
        <label className={css.search}><Search size={14} aria-hidden="true" /><input value={filters.q} onChange={(e) => onChange({ q: e.target.value })} placeholder="Words in the title, project, person or tag" aria-label="Search these tasks" data-autofocus="" /></label>
        <fieldset><legend>Status</legend><Segmented label="Status" size="sm" value={filters.status} onChange={(v) => onChange({ status: v as StatusFilter })}
          options={(["open", "doing", "blocked", "done", "all"] as StatusFilter[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))} /></fieldset>
        <fieldset><legend>Due</legend><div className={css.optChips}>{(["any", "overdue", "today", "week", "next", "none"] as Due[]).map((d) => <button key={d} type="button" aria-pressed={filters.due === d} onClick={() => onChange({ due: d })}>{DUE_LABEL[d]}</button>)}</div></fieldset>
        {people.length > 1 ? <fieldset><legend>Person</legend><div className={css.optChips}>{people.map((p) => <button key={p.id} type="button" aria-pressed={filters.people.includes(p.id)} onClick={() => onChange({ people: toggle(filters.people, p.id) })}>
          {p.id !== "none" ? <Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={18} /> : null}{p.name.split(" ")[0]}<small>{p.n}</small></button>)}</div></fieldset> : null}
        {projects.length > 1 ? <fieldset><legend>Project</legend><div className={css.optChips}>{projects.map((p) => <button key={p.id} type="button" aria-pressed={filters.projects.includes(p.id)} onClick={() => onChange({ projects: toggle(filters.projects, p.id) })}>{p.name}<small>{p.n}</small></button>)}</div></fieldset> : null}
        {tags.length ? <fieldset><legend>Tags</legend><div className={css.optChips}>{tags.map((x) => <button key={x} type="button" aria-pressed={filters.tags.includes(x)} onClick={() => onChange({ tags: toggle(filters.tags, x) })}>#{x}</button>)}</div></fieldset> : null}
        {!pool ? <label className={css.toggle}><input type="checkbox" checked={filters.pool} onChange={(e) => onChange({ pool: e.target.checked })} />Only tasks in the pool (nobody has them yet)</label> : null}
        <div className={css.filterFoot}><button type="button" className={css.clear} onClick={() => onChange({ ...NO_FILTERS })} disabled={!count}>Clear all</button><button type="button" className={css.done} onClick={() => { setOpen(false); anchor.current?.focus(); }}>Done</button></div>
      </div>
    </Popover>
  </>;
}

/** Built-in views (links), the person's own saved views, and "save this view". */
function SavedViews({ prefKey, builtIns, saved, config, onSaved, onApply }: { prefKey: string; builtIns: BuiltIn[]; saved: SavedView[]; config: ViewConfig; onSaved: (s: SavedView[]) => void; onApply: (c: Partial<ViewConfig>) => void }) {
  const [open, setOpen] = useState(false), [name, setName] = useState(""), [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  async function save() {
    if (!name.trim() || busy) return; setBusy(true);
    try { const r = await post<SavedView>("work/views/saved", { place: prefKey, name: name.trim(), config: { layout: config.layout, group: config.group, sort: config.sort, filters: config.filters } }); onSaved([...saved, r]); setName("");
      notify({ id: "view-saved", tone: "success", title: `Saved “${r.name}”`, message: "It is under Views here, only for you.", timeout: 2600 }); }
    catch (e) { notify({ id: "view-saved", tone: "error", title: "Not saved", message: msg(e) }); } finally { setBusy(false); }
  }
  async function remove(v: SavedView) {
    onSaved(saved.filter((x) => x.id !== v.id));
    try { await post(`work/views/saved/${v.id}/remove`, {}); } catch (e) { onSaved(saved); notify({ id: "view-saved", tone: "error", title: "Not removed", message: msg(e) }); }
  }
  const current = builtIns.find((b) => b.current);
  return <>
    <button ref={anchor} type="button" className={css.toolBtn} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} data-on={current ? "" : undefined}>
      <Bookmark size={14} aria-hidden="true" />{current ? current.label : "Views"}{saved.length ? <span className={css.badge}>{saved.length}</span> : null}</button>
    <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label="Saved views" placement="bottom-end">
      <div className={css.saved}>
        {builtIns.length ? <><p className={css.savedHead}>Ready-made</p><ul>{builtIns.map((b) => <li key={b.key}><Link href={b.href} className={css.savedItem} aria-current={b.current ? "page" : undefined} onClick={() => setOpen(false)}>{b.icon}{b.label}</Link></li>)}</ul></> : null}
        <p className={css.savedHead}>Yours</p>
        {saved.length ? <ul>{saved.map((v) => <li key={v.id} className={css.savedRow}>
          <button type="button" className={css.savedItem} onClick={() => { onApply(v.config); setOpen(false); }}>{v.config.layout ? createElement(ICON[v.config.layout], { size: 14, "aria-hidden": true }) : null}{v.name}</button>
          <Tooltip content={`Remove “${v.name}”`}><button type="button" className={css.savedX} aria-label={`Remove saved view ${v.name}`} onClick={() => void remove(v)}><Trash2 size={13} aria-hidden="true" /></button></Tooltip></li>)}</ul>
          : <p className={css.muted} style={{ padding: "0 10px 6px" }}>Set up a view you like, then save it here.</p>}
        <form className={css.saveForm} onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this view" aria-label="Name this view" maxLength={60} />
          <button type="submit" disabled={!name.trim() || busy}>Save</button>
        </form>
      </div>
    </Popover>
  </>;
}
