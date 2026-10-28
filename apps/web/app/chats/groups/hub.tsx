"use client";
// GROUPS-HUB (owner, 25 Oct 2026): every group of the agency in one place. A filter rail (saved views, quick filters,
// facets with counts), search over names, clients, projects, areas, people and message text, sort, bulk actions on
// many groups at once, a detail panel per group (detail.tsx), the review queue for imported groups (review.tsx) and AI
// employees in groups. Works on a phone: filters and the detail open as sheets, rows become cards.
import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bookmark, Bot, Check, ChevronDown, Clock3, Inbox, ListChecks, MessageSquareText, Plus, RefreshCw, Search, SlidersHorizontal, Sparkles, Tag, Trash2, UserPlus, Users, X } from "lucide-react";
import { Avatar } from "../../ui";
import { AiBadge, Combobox, Drawer, DrawerFooter, Menu, PeopleInput, PersonSelect, Popover, Segmented, Select, Tooltip, usePopoverState, type MenuItem } from "../../kit";
import { useMedia } from "../../kit/drawer";
import { get, send } from "../net";
import { GroupDetail } from "./detail";
import { Review } from "./review";
import css from "./hub.module.css";
import { ago, applyFilters, displayName, facetCounts, facetLabel, FACETS, fromQuery, haystack, KIND, monthLabel, NO_FILTERS, QUICK, ROLE, SEGMENT, SERVICE, SORTS, sortGroups, STATUS, toQuery,
  type FacetKey, type Filters, type Group, type HubData, type Quick, type Sort } from "./model";

type Tab = "groups" | "review" | "ai";
const PAGE = 80;

export function GroupsHub({ initial }: { initial: HubData }) {
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState<Tab>("groups");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<Sort>("activity");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [textHits, setTextHits] = useState<Map<string, number> | null>(null);
  const [msgSearch, setMsgSearch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone?: "error" } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const phone = useMedia("(max-width: 899.98px)");
  const q = useDeferredValue(filters.q);

  // The URL keeps the filters (a link opens the same list); a saved view is the same state with a name.
  const urlRead = useRef(false);
  const [ready, setReady] = useState(false); // the address is written back only after it was read (a remount reads it again)
  useEffect(() => {
    if (urlRead.current) return; // React's development double run must not read the address after it was rewritten
    urlRead.current = true;
    const s = new URLSearchParams(location.search);
    const { filters: f, sort: so } = fromQuery(s);
    const t0 = s.get("tab") === "review" || s.get("tab") === "ai" ? s.get("tab") as Tab : null, g0 = s.get("group");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the address is read once, after hydration
    setFilters(f); setSort(so); if (t0) setTab(t0); if (g0) setOpenId(g0); setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const p = toQuery(filters, sort), extra = new URLSearchParams(p);
    if (tab !== "groups") extra.set("tab", tab);
    if (openId) extra.set("group", openId);
    const next = `${location.pathname}${extra.toString() ? `?${extra}` : ""}`;
    if (next !== `${location.pathname}${location.search}`) history.replaceState(history.state, "", next);
  }, [filters, sort, tab, openId, ready]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- a new filter starts the list at its first page
  useEffect(() => { setShown(PAGE); }, [filters, sort]);

  const reload = useCallback(async () => {
    try { setData(await get<HubData>("chats/hub")); } catch (e) { setToast({ text: (e as Error).message, tone: "error" }); }
  }, []);
  const say = useCallback((text: string, tone?: "error") => { setToast({ text, tone }); }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), toast.tone ? 6000 : 3200); return () => clearTimeout(t); }, [toast]);

  // Message text: the server counts matches in each group you are in (live and imported), 400 ms after typing stops.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- too short to search: no message matches
    if (!msgSearch || q.trim().length < 3) { setTextHits(null); return; }
    const ctl = new AbortController();
    const t = setTimeout(() => { get<{ hits: { channelId: string; hits: number }[] }>(`chats/hub/search?q=${encodeURIComponent(q.trim())}`, ctl.signal)
      .then((r) => setTextHits(new Map(r.hits.map((h) => [h.channelId, h.hits])))).catch(() => undefined); }, 400);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, msgSearch]);

  const names = useMemo(() => new Map([...data.people.map((p) => [p.id, p.name] as const), ...data.agents.map((a) => [a.id, a.name] as const)]), [data.people, data.agents]);
  const hay = useMemo(() => new Map(data.groups.map((g) => [g.id, haystack(g, names)])), [data.groups, names]);
  const live = useMemo(() => ({ ...filters, q }), [filters, q]);
  const list = useMemo(() => sortGroups(applyFilters(data.groups, live, data.viewer, hay, textHits), sort, textHits), [data.groups, live, data.viewer, hay, textHits, sort]);
  const stats = useMemo(() => {
    const active = data.groups.filter((g) => g.status !== "archived");
    return { all: active.length, waiting: active.filter((g) => g.waitingSince).length, unread: active.filter((g) => g.unread > 0).length,
      review: active.reduce((n, g) => n + g.suggestions + g.unmapped, 0), imported: active.filter((g) => g.imported > 0).length,
      unlinked: active.filter((g) => g.kind === "client" && (!g.clientId || !g.projectId)).length };
  }, [data.groups]);
  const open = data.groups.find((g) => g.id === openId) ?? null;

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const toggle = (key: FacetKey, v: string) => setFilters((f) => ({ ...f, [key]: f[key].includes(v) ? f[key].filter((x) => x !== v) : [...f[key], v] }));
  const toggleQuick = (k: Quick) => setFilters((f) => ({ ...f, quick: f.quick.includes(k) ? f.quick.filter((x) => x !== k) : [...f.quick, k] }));
  const active = filters.quick.length + FACETS.reduce((n, { key }) => n + filters[key].length, 0);

  const bulk = async (path: string, body: object, done: string) => {
    setBusy(true);
    try { await send(path, { ids: [...selected], ...body }); await reload(); say(done); }
    catch (e) { say((e as Error).message, "error"); } finally { setBusy(false); }
  };

  const filterRail = <FilterRail data={data} filters={filters} viewer={data.viewer} hay={hay} textHits={textHits} toggle={toggle} toggleQuick={toggleQuick}
    sort={sort} onView={(v) => { setFilters({ ...NO_FILTERS, ...v.query }); setSort(v.query.sort ?? "activity"); setFiltersOpen(false); }}
    onSave={async (name, shared) => { try { await send("chats/hub/views", { name, shared, query: { ...filters, sort } }); await reload(); say(`Saved “${name}”`); } catch (e) { say((e as Error).message, "error"); } }}
    onDelete={async (id) => { try { await send(`chats/hub/views/${id}/delete`); await reload(); } catch (e) { say((e as Error).message, "error"); } }}
    canShare={data.canLead} stats={stats} />;

  return <div className={css.hub}>
    <header className={css.top}>
      <div className={css.titleRow}>
        <Link href="/chats" className={css.back} aria-label="Back to Chats"><ArrowLeft size={18} aria-hidden="true" /></Link>
        <div className={css.titles}>
          <h1>Groups</h1>
          <p className={css.sub}>
            <span><b>{stats.all.toLocaleString("en-IN")}</b> groups</span>
            <button type="button" className={css.statBtn} data-tone={stats.waiting ? "warn" : undefined} onClick={() => { setTab("groups"); set({ quick: ["waiting"] }); setSort("waiting"); }}><b>{stats.waiting}</b> waiting on us</button>
            <button type="button" className={css.statBtn} onClick={() => { setTab("groups"); set({ quick: ["unread"] }); }}><b>{stats.unread}</b> unread</button>
            <button type="button" className={css.statBtn} onClick={() => setTab("review")}><b>{stats.review}</b> to review</button>
            {stats.imported ? <button type="button" className={css.statBtn} onClick={() => { setTab("groups"); set({ quick: ["imported"] }); }}><b>{stats.imported}</b> imported</button> : null}
          </p>
        </div>
        <div className={css.topActions}>
          {data.canLead ? <Tooltip content="Read every group's name again (what people set stays)"><button type="button" className={css.ghostBtn} disabled={busy} aria-label="Read names again"
            onClick={async () => { setBusy(true); try { const r = await send<{ classified: number }>("chats/hub/classify"); await reload(); say(`Read ${r.classified} names again`); } catch (e) { say((e as Error).message, "error"); } finally { setBusy(false); } }}>
            <RefreshCw size={16} aria-hidden="true" data-spin={busy || undefined} />{phone ? null : "Read names"}</button></Tooltip> : null}
        </div>
      </div>
      <Segmented<Tab> label="Groups hub" value={tab} onChange={setTab} size="md" className={css.tabs}
        options={[{ value: "groups", label: "All groups", icon: Users, count: list.length === stats.all ? stats.all : `${list.length}/${stats.all}` },
          { value: "review", label: "To review", icon: ListChecks, count: stats.review || undefined }, { value: "ai", label: "AI employees", icon: Bot, count: data.agents.length || undefined }]} />
    </header>

    {tab === "review" ? <Review data={data} onOpen={setOpenId} reload={reload} say={say} /> : null}
    {tab === "ai" ? <AiTab data={data} onPick={(name) => { setTab("groups"); setFilters({ ...NO_FILTERS, agents: [name] }); }} onNoAi={() => { setTab("groups"); setFilters({ ...NO_FILTERS, quick: ["noai"] }); }} /> : null}

    {tab === "groups" ? <div className={css.body}>
      {phone ? null : <aside className={css.rail} aria-label="Filters">{filterRail}</aside>}
      <section className={css.main} aria-label="Groups">
        <div className={css.toolbar}>
          <label className={css.search}>
            <Search size={17} aria-hidden="true" />
            <input type="search" value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder="Search groups, clients, projects, areas, people, messages"
              aria-label="Search groups" data-hub-search="" onKeyDown={(e) => { if (e.key === "Escape") set({ q: "" }); }} />
            {filters.q ? <button type="button" className={css.clear} onClick={() => set({ q: "" })} aria-label="Clear search"><X size={15} aria-hidden="true" /></button> : null}
          </label>
          {phone ? <button type="button" className={css.filterBtn} onClick={() => setFiltersOpen(true)} aria-label={`Filters${active ? `, ${active} on` : ""}`}>
            <SlidersHorizontal size={17} aria-hidden="true" />{active ? <span className={css.dot}>{active}</span> : null}</button> : null}
          <span className={css.toolEnd}>
            <Tooltip content="Also find groups whose messages (live and imported) contain the words"><label className={css.msgToggle}><input type="checkbox" checked={msgSearch} onChange={(e) => setMsgSearch(e.target.checked)} /><MessageSquareText size={14} aria-hidden="true" />In messages</label></Tooltip>
            <Select<Sort> label="Sort" value={sort} onChange={(v) => setSort(v ?? "activity")} options={SORTS} size="sm" variant="chip" placement="bottom-end" />
          </span>
        </div>
        <div className={css.chipsRow} role="group" aria-label="Quick filters">
          {QUICK.map((qk) => {
            const n = data.groups.filter((g) => g.status !== "archived").filter((g) => qk.key === "mine" ? g.member : qk.key === "waiting" ? !!g.waitingSince : qk.key === "unread" ? g.unread > 0 : qk.key === "imported" ? g.imported > 0
              : qk.key === "unlinked" ? g.kind === "client" && (!g.clientId || !g.projectId) : qk.key === "review" ? g.suggestions + g.unmapped > 0 : g.kind === "client" && !g.agents.length).length;
            if (!n && !filters.quick.includes(qk.key)) return null;
            return <Tooltip key={qk.key} content={qk.hint}><button type="button" className={css.quick} aria-pressed={filters.quick.includes(qk.key)} data-quick={qk.key} onClick={() => toggleQuick(qk.key)}>
              {filters.quick.includes(qk.key) ? <Check size={14} aria-hidden="true" /> : null}{qk.label}<span>{n}</span></button></Tooltip>;
          })}
        </div>
        {active ? <div className={css.activeRow} aria-label="Filters on">
          {FACETS.flatMap(({ key, label }) => filters[key].map((v) => <button key={`${key}:${v}`} type="button" className={css.activeChip} onClick={() => toggle(key, v)} aria-label={`Remove ${label}: ${facetLabel(key, v)}`}>
            <span>{label}</span>{facetLabel(key, v)}<X size={13} aria-hidden="true" /></button>))}
          <button type="button" className={css.linkBtn} onClick={() => setFilters({ ...NO_FILTERS, q: filters.q })}>Clear all</button>
        </div> : null}

        <div className={css.listHead} aria-hidden={phone || undefined}>
          <label className={css.check}><input type="checkbox" aria-label="Select all shown" checked={!!list.length && list.slice(0, shown).every((g) => selected.has(g.id))}
            onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...list.slice(0, shown).map((g) => g.id)]) : new Set())} /></label>
          {phone ? <span>{list.length} groups</span> : <><span>Group</span><span>Pod · area</span><span>Segment · service</span><span>People</span><span>Activity</span><span>State</span></>}
        </div>
        {list.length ? <ul className={css.list} data-hub-list="">
          {list.slice(0, shown).map((g) => <Row key={g.id} g={g} phone={phone} selected={selected.has(g.id)} hits={textHits?.get(g.id)}
            onSelect={(on) => setSelected((s) => { const n = new Set(s); if (on) n.add(g.id); else n.delete(g.id); return n; })} onOpen={() => setOpenId(g.id)} />)}
        </ul> : <div className={css.empty}><Inbox size={28} aria-hidden="true" /><h2>No groups match</h2><p>Try fewer filters or other words.</p>
          <button type="button" className={css.ghostBtn} onClick={() => setFilters(NO_FILTERS)}>Clear filters and search</button></div>}
        {list.length > shown ? <ShowMore onMore={() => setShown((n) => n + PAGE * 2)} left={list.length - shown} /> : null}
      </section>
    </div> : null}

    {selected.size && tab === "groups" ? <BulkBar data={data} count={selected.size} busy={busy} clear={() => setSelected(new Set())} run={bulk} /> : null}
    {phone && filtersOpen ? <Drawer className={css.vars} title="Filters" onClose={() => setFiltersOpen(false)} size="md" snap="full"
      footer={<DrawerFooter primary={<button type="button" className={css.primary} onClick={() => setFiltersOpen(false)}>Show {list.length} groups</button>}>
        <button type="button" className={css.ghostBtn} onClick={() => setFilters({ ...NO_FILTERS, q: filters.q })}>Clear</button></DrawerFooter>}>{filterRail}</Drawer> : null}
    {open ? <GroupDetail key={open.id} group={open} data={data} onClose={() => setOpenId(null)} reload={reload} say={say} /> : null}
    {toast ? <div className={css.toast} role="status" data-tone={toast.tone}>{toast.text}</div> : null}
  </div>;
}

/** A button with its own panel (a sheet on a phone). */
function PopButton({ label, className, children, placement = "top-start", disabled, panel }: { label: string; className: string; children: ReactNode; placement?: "top-start" | "bottom-end"; disabled?: boolean; panel: (close: () => void) => ReactNode }) {
  const { open, setOpen, anchor, close } = usePopoverState();
  return <>
    <button ref={anchor} type="button" className={className} aria-expanded={open} aria-label={label} disabled={disabled} onClick={() => setOpen(!open)}>{children}</button>
    <Popover open={open} onClose={close} anchor={anchor} label={label} placement={placement} sheet>{panel(close)}</Popover>
  </>;
}

function ShowMore({ onMore, left }: { onMore: () => void; left: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = ref.current; if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) onMore(); }, { rootMargin: "600px" });
    io.observe(el); return () => io.disconnect();
  }, [onMore]);
  return <button ref={ref} type="button" className={css.more} onClick={onMore}>Show more ({left} left)</button>;
}

const KIND_HUE: Record<string, number> = { client: 210, pod: 150, team: 280, internal: 30, vendor: 340, other: 0 };
export function GroupMark({ g, size = 40 }: { g: Pick<Group, "name" | "kind" | "imported">; size?: number }) {
  const letters = g.name.replace(/^pod\s*\d+\s*/i, "").split(/\s+/).filter((w) => /^[a-z0-9]/i.test(w) && !/^(mr|mrs|miss|ms|dr)$/i.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "#";
  return <span className={css.mark} style={{ "--h": KIND_HUE[g.kind ?? "other"], width: size, height: size } as React.CSSProperties} data-kind={g.kind ?? "other"} aria-hidden="true">
    {letters}{g.imported ? <i className={css.waDot} /> : null}</span>;
}

function Row({ g, phone, selected, hits, onSelect, onOpen }: { g: Group; phone: boolean; selected: boolean; hits?: number; onSelect: (on: boolean) => void; onOpen: () => void }) {
  const line = [g.client, g.project && g.project !== g.client ? g.project : null].filter(Boolean).join(" · ");
  const place = [g.pod, g.area ?? g.city].filter(Boolean).join(" · ");
  const tags = [...g.segments.map((s) => SEGMENT[s] ?? s), ...g.services.filter((s) => s !== "marketing").map((s) => SERVICE[s] ?? s)];
  const ai = g.agents;
  const state = <span className={css.state}>
    <span className={css.pill} data-status={g.status}>{STATUS[g.status]}</span>
    {g.waitingSince ? <Tooltip content={`${g.waitingWho ?? "A client"} wrote ${ago(g.waitingSince)} and nobody from the team answered yet`}><span className={css.waiting}><Clock3 size={12} aria-hidden="true" />{ago(g.waitingSince).replace(" ago", "")}</span></Tooltip> : null}
    {g.unread ? <span className={css.unread} aria-label={`${g.unread} unread`}>{g.unread > 99 ? "99+" : g.unread}</span> : null}
    {g.suggestions + g.unmapped ? <Tooltip content={`${g.suggestions + g.unmapped} to review`}><span className={css.review}>{g.suggestions + g.unmapped}</span></Tooltip> : null}
    {g.health ? <span className={css.health} data-health={g.health} aria-label={`Health: ${g.health}`} /> : null}
  </span>;
  return <li className={css.row} data-selected={selected || undefined} data-group-row={g.id}>
    <label className={css.check}><input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${g.name}`} /></label>
    <button type="button" className={css.rowMain} onClick={onOpen} aria-label={`${g.name}${line ? `, ${line}` : ""}`}>
      <GroupMark g={g} />
      <span className={css.nameCol}>
        <span className={css.name} title={g.name}>{displayName(g.name)}</span>
        <span className={css.line2}>
          {g.kind ? <span className={css.kind} data-kind={g.kind}>{KIND[g.kind]}</span> : null}
          {line ? <span className={css.ellipsis}>{line}</span> : g.kind === "client" ? <span className={css.missing}>Not linked yet</span> : null}
          {g.period ? <span className={css.muted}>{monthLabel(g.period)}</span> : null}
          {hits ? <span className={css.hits}><MessageSquareText size={12} aria-hidden="true" />{hits} match{hits === 1 ? "" : "es"}</span> : null}
        </span>
        {phone ? <span className={css.line3}>{place ? <span>{place}</span> : null}{tags.slice(0, 3).map((t) => <span key={t} className={css.tag}>{t}</span>)}</span> : null}
      </span>
      {phone ? null : <>
        <span className={css.cell}>{place || <span className={css.muted}>—</span>}</span>
        <span className={css.cellTags}>{tags.length ? tags.slice(0, 3).map((t) => <span key={t} className={css.tag}>{t}</span>) : <span className={css.muted}>—</span>}{tags.length > 3 ? <span className={css.muted}>+{tags.length - 3}</span> : null}</span>
        <span className={css.people}><Users size={13} aria-hidden="true" />{g.members}{g.clientSide ? <span className={css.muted}> · {g.clientSide} client</span> : null}
          {ai.length ? <span className={css.aiChips}>{ai.slice(0, 2).map((a) => <Tooltip key={a.id} content={`${a.name}: ${ROLE[a.role]?.label ?? a.role}`}><span className={css.aiChip}><Sparkles size={11} aria-hidden="true" />{a.name.replace(/\s*\(AI\)$/, "").split(" ")[0]}</span></Tooltip>)}{ai.length > 2 ? <span className={css.muted}>+{ai.length - 2}</span> : null}</span> : null}</span>
        <span className={css.activity}><span>{ago(g.lastAt)}</span><span className={css.muted}>{g.messages7 ? `${g.messages7} this week` : g.messages ? `${g.messages.toLocaleString("en-IN")} messages` : ""}</span></span>
      </>}
      {state}
    </button>
  </li>;
}

function FilterRail({ data, filters, viewer, hay, textHits, toggle, toggleQuick, sort, onView, onSave, onDelete, canShare, stats }: {
  data: HubData; filters: Filters; viewer: string; hay: Map<string, string>; textHits: Map<string, number> | null; toggle: (k: FacetKey, v: string) => void; toggleQuick: (k: Quick) => void; sort: Sort;
  onView: (v: HubData["views"][number]) => void; onSave: (name: string, shared: boolean) => void; onDelete: (id: string) => void; canShare: boolean; stats: { waiting: number } }) {
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [name, setName] = useState(""), [shared, setShared] = useState(false);
  const anyFilter = !!(filters.q || filters.quick.length || FACETS.some(({ key }) => filters[key].length) || sort !== "activity");
  const builtIn: HubData["views"] = [
    { id: "b:waiting", name: "Waiting on us", query: { quick: ["waiting"], sort: "waiting" }, shared: true, mine: false },
    { id: "b:client", name: "Active client groups", query: { kinds: ["client"], statuses: ["active"] }, shared: true, mine: false },
    { id: "b:review", name: "Imported, to review", query: { quick: ["imported", "review"], sort: "review" }, shared: true, mine: false },
    { id: "b:quiet", name: "Gone quiet", query: { kinds: ["client"], statuses: ["quiet"], sort: "activity" }, shared: true, mine: false },
  ];
  return <div className={css.railInner}>
    <div className={css.railSection}>
      <div className={css.railHead}><h2><Bookmark size={14} aria-hidden="true" />Views</h2>
        <PopButton label="Save this view" className={css.iconBtn} placement="bottom-end" disabled={!anyFilter} panel={(close) =>
          <form className={css.saveForm} onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onSave(name.trim(), shared); setName(""); close(); } }}>
            <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pod 2 · luxury · active" maxLength={60} autoFocus /></label>
            {canShare ? <label className={css.inline}><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />Share with the company</label> : null}
            <button type="submit" className={css.primary} disabled={!name.trim()}>Save view</button>
          </form>}><Plus size={16} aria-hidden="true" /></PopButton></div>
      <ul className={css.views}>
        {[...builtIn, ...data.views].map((v) => <li key={v.id}>
          <button type="button" onClick={() => onView(v)}>{v.name}{v.id === "b:waiting" && stats.waiting ? <span className={css.count}>{stats.waiting}</span> : null}{v.shared && !v.id.startsWith("b:") ? <span className={css.muted}> · shared</span> : null}</button>
          {v.mine || (v.shared && canShare && !v.id.startsWith("b:")) ? <button type="button" className={css.iconBtn} onClick={() => onDelete(v.id)} aria-label={`Delete view ${v.name}`}><Trash2 size={13} aria-hidden="true" /></button> : null}
        </li>)}
      </ul>
    </div>
    {FACETS.map(({ key, label }) => {
      const counts = facetCounts(data.groups, filters, viewer, hay, textHits, key);
      if (!counts.length || (counts.length === 1 && counts[0][0] === "—" && !filters[key].length)) return null;
      const limit = more[key] ? 60 : 6;
      return <div key={key} className={css.railSection} data-facet={key}>
        <div className={css.railHead}><h2>{label}</h2></div>
        <ul className={css.facet}>
          {counts.slice(0, limit).map(([v, n]) => <li key={v}><label>
            <input type="checkbox" checked={filters[key].includes(v)} onChange={() => toggle(key, v)} />
            <span className={css.facetLabel}>{facetLabel(key, v)}</span><span className={css.count}>{n}</span></label></li>)}
        </ul>
        {counts.length > 6 ? <button type="button" className={css.linkBtn} onClick={() => setMore((m) => ({ ...m, [key]: !m[key] }))}>{more[key] ? "Fewer" : `All ${counts.length}`}</button> : null}
      </div>;
    })}
    <p className={css.railNote}>Types, segments and services are read from each group&apos;s name; a change you make by hand stays.</p>
    {filters.quick.length ? <button type="button" className={css.linkBtn} onClick={() => filters.quick.forEach(toggleQuick)}>Clear quick filters</button> : null}
  </div>;
}

function BulkBar({ data, count, busy, clear, run }: { data: HubData; count: number; busy: boolean; clear: () => void; run: (path: string, body: object, done: string) => Promise<void> }) {
  const pods = useMemo(() => [...new Set(["Pod 1", "Pod 2", ...data.groups.map((g) => g.pod).filter(Boolean) as string[]])].sort(), [data.groups]);
  const [tag, setTag] = useState(""), [agent, setAgent] = useState<string | null>(null), [role, setRole] = useState<"observer" | "assistant" | "coordinator">("assistant"), [people, setPeople] = useState<string[]>([]);
  const n = `${count} group${count === 1 ? "" : "s"}`;
  const items = (field: string, opts: { key: string; label: string }[], what: string): MenuItem[] =>
    [...opts.map((o) => ({ key: o.key, label: o.label, onSelect: () => void run("chats/hub/set", { fields: { [field]: o.key } }, `${what}: ${o.label} on ${n}`) })),
      { key: "sep", label: "", separator: true }, { key: "auto", label: "Back to what the name says", onSelect: () => void run("chats/hub/set", { fields: { [field]: null } }, `${what} read from the names again`) }];
  const all = useMemo(() => [...new Set(data.groups.flatMap((g) => g.tags))].sort(), [data.groups]);
  return <div className={css.bulk} role="toolbar" aria-label={`${count} selected`} data-bulk="">
    <span className={css.bulkCount}><b>{count}</b> selected</span>
    <Menu label="Set type" items={items("kind", Object.entries(KIND).map(([key, label]) => ({ key, label })), "Type")} placement="top-start" className={css.bulkBtn}>Type<ChevronDown size={14} aria-hidden="true" /></Menu>
    <Menu label="Set status" items={items("status", Object.entries(STATUS).map(([key, label]) => ({ key, label })), "Status")} placement="top-start" className={css.bulkBtn}>Status<ChevronDown size={14} aria-hidden="true" /></Menu>
    <Menu label="Set pod" items={items("pod", pods.map((p) => ({ key: p, label: p })), "Pod")} placement="top-start" className={css.bulkBtn}>Pod<ChevronDown size={14} aria-hidden="true" /></Menu>
    <PopButton label="Set the owner" className={css.bulkBtn} panel={(close) => <div className={css.popForm}>
      <PersonSelect label="Owner" people={data.people} value={null} autoOpen onChange={(p) => { close(); if (p) void run("chats/hub/set", { fields: { ownerId: p.id } }, `${p.name} owns ${n}`); }} /></div>}>Owner<ChevronDown size={14} aria-hidden="true" /></PopButton>
    <PopButton label="Add a tag" className={css.bulkBtn} panel={(close) =>
      <form className={css.popForm} onSubmit={(e) => { e.preventDefault(); const t = tag.trim().toLowerCase(); if (!t) return; close(); setTag(""); void run("chats/hub/set", { fields: { addTags: [t] } }, `Tagged ${n} “${t}”`); }}>
        <label>Tag<input value={tag} onChange={(e) => setTag(e.target.value)} list="hub-tags" placeholder="renewal, vip, escalated…" maxLength={40} autoFocus /></label>
        <datalist id="hub-tags">{all.map((t) => <option key={t} value={t} />)}</datalist>
        <button type="submit" className={css.primary} disabled={!tag.trim()}>Add tag</button>
      </form>}><Tag size={14} aria-hidden="true" />Tag</PopButton>
    <PopButton label="Put an AI employee in these groups" className={css.bulkBtn} panel={(close) => <div className={css.popForm}>
      <Combobox label="AI employee" value={agent} onChange={(v) => setAgent(v)} options={data.agents.map((a) => ({ value: a.id, label: a.name, detail: a.title || a.employeeId || undefined, icon: <Avatar name={a.name} id={a.id} size={20} ai /> }))} placeholder="Choose an AI employee" />
      <fieldset className={css.roles}><legend>Its role in these groups</legend>
        {(["observer", "assistant", "coordinator"] as const).map((r) => <label key={r} data-on={role === r || undefined}><input type="radio" name="hub-role" checked={role === r} onChange={() => setRole(r)} /><b>{ROLE[r].label}</b><span>{ROLE[r].hint}</span></label>)}
      </fieldset>
      <p className={css.small}>It reads only the groups it is in. Messages to clients always go to a person to approve first.</p>
      <div className={css.popActions}>
        <button type="button" className={css.ghostBtn} disabled={!agent} onClick={() => { close(); void run("chats/hub/agents", { agentId: agent, role: null }, `Took the AI employee out of ${n}`); }}>Take out</button>
        <button type="button" className={css.primary} disabled={!agent} onClick={() => { close(); void run("chats/hub/agents", { agentId: agent, role }, `${data.agents.find((a) => a.id === agent)?.name} is ${ROLE[role].label.toLowerCase()} in ${n}`); }}>Put in {n}</button>
      </div>
    </div>}><Sparkles size={14} aria-hidden="true" />AI employee</PopButton>
    <PopButton label="Add colleagues" className={css.bulkBtn} panel={(close) => <div className={css.popForm}>
      <PeopleInput label="Colleagues" people={data.people} value={people} onChange={setPeople} addLabel="Add a colleague" />
      <p className={css.small}>Pods and teams follow the roster, so only groups people made take new members.</p>
      <button type="button" className={css.primary} disabled={!people.length} onClick={() => { close(); const k = people.length; setPeople([]); void run("chats/hub/people", { personIds: people }, `Added ${k} colleague${k === 1 ? "" : "s"}`); }}>Add to {n}</button>
    </div>}><UserPlus size={14} aria-hidden="true" />People</PopButton>
    <button type="button" className={css.bulkBtn} disabled={busy} onClick={() => void run("chats/hub/set", { fields: { status: "archived" } }, `Archived ${n} (they stay readable)`)}>Archive</button>
    <button type="button" className={css.iconBtn} onClick={clear} aria-label="Clear selection"><X size={16} aria-hidden="true" /></button>
  </div>;
}

function AiTab({ data, onPick, onNoAi }: { data: HubData; onPick: (name: string) => void; onNoAi: () => void }) {
  const rows = data.agents.map((a) => {
    const gs = data.groups.filter((g) => g.agents.some((x) => x.id === a.id));
    const by = (r: string) => gs.filter((g) => g.agents.find((x) => x.id === a.id)?.role === r).length;
    return { a, total: gs.length, observer: by("observer"), assistant: by("assistant"), coordinator: by("coordinator"), member: by("profile"), waiting: gs.filter((g) => g.waitingSince).length };
  }).sort((x, y) => y.total - x.total || x.a.name.localeCompare(y.a.name));
  const noAi = data.groups.filter((g) => g.kind === "client" && g.status !== "archived" && !g.agents.length).length;
  return <section className={css.aiTab} aria-label="AI employees in groups">
    <div className={css.aiIntro}>
      <div><h2>AI employees in groups</h2><p>Each AI employee reads only the groups it is in, with a role per group. Choose groups on the list and use <b>AI employee</b> to put one in many groups at once.</p></div>
      {noAi ? <button type="button" className={css.ghostBtn} onClick={onNoAi}><Bot size={16} aria-hidden="true" />{noAi} client groups without one</button> : null}
    </div>
    <div className={css.roleKey}>{(["observer", "assistant", "coordinator"] as const).map((r) => <div key={r}><b>{ROLE[r].label}</b><span>{ROLE[r].hint}</span></div>)}</div>
    <ul className={css.aiGrid}>
      {rows.map(({ a, total, observer, assistant, coordinator, member, waiting }) => <li key={a.id}>
        <button type="button" onClick={() => onPick(a.name)} className={css.aiCard} aria-label={`${a.name}: ${total} groups`}>
          <span className={css.aiTop}><Avatar name={a.name} id={a.id} size={40} ai /><span><b>{a.name}</b><span className={css.muted}>{a.title || "AI employee"}</span></span><AiBadge employeeId={a.employeeId} /></span>
          <span className={css.aiStats}><span><b>{total}</b> groups</span>{coordinator ? <span>{coordinator} coordinating</span> : null}{assistant ? <span>{assistant} assisting</span> : null}{observer ? <span>{observer} observing</span> : null}{member ? <span>{member} by profile</span> : null}</span>
          {waiting ? <span className={css.waiting}><Clock3 size={12} aria-hidden="true" />{waiting} of its groups waiting on us</span> : null}
          <span className={css.runtime} data-state={a.runtimeState}>{a.runtimeState === "ready" ? "Ready" : a.runtimeState === "out_of_quota" ? "Out of quota" : a.runtimeState === "error" ? "Failing" : "Not seen yet"}</span>
        </button>
      </li>)}
    </ul>
  </section>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className={css.field}><span className={css.fieldLabel}>{label}</span>{children}</div>;
}
