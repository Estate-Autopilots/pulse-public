"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "@pulse/ui-shell";
import type * as GeoJSON from "geojson";
import { Banknote, ChartNoAxesCombined, ChevronLeft, ChevronRight, ChevronUp, Clapperboard, Compass, Crosshair, Gem, Layers, LocateFixed, MapPin, MapPinOff, Maximize2, Minimize2, Minus, Plus, Ruler, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { PageHeader, styles as ui } from "../ui";
import { Analysis, type AnalysisTab } from "./analysis";
import { catchment, circle, CLIENT_TYPES, displayName, filterCount, marketAreas, markets as groupMarkets, monthAxis, NO_FILTERS, parseCoordinates, placeName, PRECISIONS, SEGMENTS, SEGMENT_HINT, select, STAGES, STAGE_HINT, areaValue, type AreaMetric, type Belt, type ClientSpread, type Filters, type MapData, type Market, type Row } from "./geo";
import type { Base, Extra, MapApi, Mode } from "./canvas";
import { inr, moneyByLocation, moneyByMarket, planRoute, pricesByMarket, reachKm, whiteSpace, type Stop } from "./intel";
import { MarketPanel, MoneyPanel, ReviewPanel, ShootsPanel } from "./intel-panels";
import { DATA_LAYERS, Legend, LayersMenu, MeasureBar, TimeControl } from "./controls";
import { List, Note, PrecisionBadge, Seg, SubHead } from "./parts";
import { ProjectPanel } from "./project";
import css from "./map.module.css";

const MapCanvas = dynamic(() => import("./canvas"), { ssr: false });
const TABS = [
  { key: "concentration" as const, label: "Places", icon: Layers, title: "Concentration" },
  { key: "patterns" as const, label: "Patterns", icon: Sparkles, title: "Clusters and patterns" },
  { key: "growth" as const, label: "Growth", icon: ChartNoAxesCombined, title: "Growth over time" },
  { key: "market" as const, label: "Market", icon: Gem, title: "Prices, white space and launches" },
  { key: "money" as const, label: "Money", icon: Banknote, title: "Money by place" },
  { key: "shoots" as const, label: "Shoots", icon: Clapperboard, title: "Shoots and a shoot-day route" },
  { key: "coverage" as const, label: "Pins", icon: Crosshair, title: "Coverage" },
];
type Focus = { name: string; note: string; rows: Row[]; client?: string };
const n = (v: number) => v.toLocaleString("en-IN");

export default function MapWorkspace({ initial, orgName }: { initial: MapData; orgName: string }) {
  const [data, setData] = useState(initial);
  const months = useMemo(() => monthAxis(data.locations), [data.locations]);
  const [filters, setFilters] = useState<Filters>(() => NO_FILTERS(months.length));
  const [mode, setMode] = useState<Mode>("points"), [tab, setTab] = useState<AnalysisTab>("concentration");
  const [panel, setPanel] = useState(true), [wide, setWide] = useState(false), [phone, setPhone] = useState(false), [filterOpen, setFilterOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null), [focus, setFocus] = useState<Focus | null>(null);
  const [repeatOverlay, setRepeatOverlay] = useState(false), [extrude, setExtrude] = useState(false), [ringsOn, setRingsOn] = useState(true);
  const [baseChoice, setBaseChoice] = useState<Base | null>(null), [metric, setMetric] = useState<AreaMetric>("projects");
  const [layersOpen, setLayersOpen] = useState(false), [timeOpen, setTimeOpen] = useState(false), [measure, setMeasure] = useState<[number, number][] | null>(null);
  const [ready, setReady] = useState(false), [mapError, setMapError] = useState(""), [resolution, setResolution] = useState(7);
  const [query, setQuery] = useState(""), [searchOpen, setSearchOpen] = useState(false), [playing, setPlaying] = useState(false);
  const [fix, setFix] = useState<{ id: string; lat: number; lng: number } | null>(null), [coordinateText, setCoordinateText] = useState("");
  const [pinNote, setPinNote] = useState(""), [saving, setSaving] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [detailVersion, setDetailVersion] = useState(0);
  // R55: overlays and the shoot-day plan.
  const [travelOn, setTravelOn] = useState(false), [gapsOn, setGapsOn] = useState(false);
  const [routeStops, setRouteStops] = useState<Stop[]>([]);
  const firstOffice = data.office?.[0];
  const [routeStart, setRouteStart] = useState<Stop | null>(firstOffice ? { id: "office0", name: firstOffice.name, lat: firstOffice.lat, lng: firstOffice.lng } : null);
  const [size, setSize] = useState({ w: 1200, h: 700, panel: 420 }), [settled, setSettled] = useState(false);
  const map = useRef<MapApi | null>(null), search = useRef<HTMLInputElement>(null), box = useRef<HTMLElement>(null), aside = useRef<HTMLElement>(null), layersButton = useRef<HTMLButtonElement>(null);
  const { resolved } = useTheme();
  const base: Base = baseChoice ?? (resolved === "dark" ? "dark" : "light");
  const rows = useMemo(() => select(data, filters, months), [data, filters, months]);
  const allTime = useMemo(() => select(data, { ...filters, from: 0, to: months.length - 1 }, months), [data, filters, months]);
  const markets = useMemo(() => groupMarkets(rows, data, months), [rows, data, months]);
  const growthMarkets = useMemo(() => groupMarkets(allTime, data, months), [allTime, data, months]);
  const areas = useMemo(() => mode === "areas" ? marketAreas(markets) : [], [mode, markets]);
  const perMonth = useMemo(() => { const count = new Map<string, number>(); for (const r of allTime) for (const e of r.engagements) if (e.month) count.set(e.month, (count.get(e.month) ?? 0) + 1); return months.map((m) => count.get(m) ?? 0); }, [allTime, months]);
  const located = rows.filter((r) => r.loc.lat !== null).length;
  const picked = data.locations.find((r) => r.id === selected);
  const pickedRow = useMemo(() => selected ? rows.find((r) => r.loc.id === selected) ?? select(data, NO_FILTERS(months.length), months).find((r) => r.loc.id === selected) : undefined, [selected, rows, data, months]);
  const rings = useMemo(() => {
    if (!ringsOn || !pickedRow || pickedRow.loc.lat === null || pickedRow.loc.lng === null) return null;
    const c = catchment({ lat: pickedRow.loc.lat, lng: pickedRow.loc.lng }, rows, pickedRow.loc.id);
    return { lat: pickedRow.loc.lat, lng: pickedRow.loc.lng, counts: c.rings.map((r) => r.projects) };
  }, [ringsOn, pickedRow, rows]);
  const fixRow = data.locations.find((r) => r.id === fix?.id);
  // R55: money, prices, white space and the shoot route, from what the API sent (see intel.ts for every method).
  const today = data.generatedAt.slice(0, 10);
  const finance = !!data.money && data.money.connected;
  const moneyLoc = useMemo(() => data.money && data.money.connected ? moneyByLocation(data.money.invoices, today) : new Map(), [data.money, today]);
  const moneyMkt = useMemo(() => moneyByMarket(markets, moneyLoc), [markets, moneyLoc]);
  const priceStats = useMemo(() => pricesByMarket(data.prices ?? [], markets), [data.prices, markets]);
  const gaps = useMemo(() => whiteSpace(markets, moneyMkt, priceStats), [markets, moneyMkt, priceStats]);
  const route = useMemo(() => routeStops.length ? planRoute(routeStops, routeStart) : null, [routeStops, routeStart]);
  const travelFrom = pickedRow && pickedRow.loc.lat !== null && pickedRow.loc.lng !== null ? { name: pickedRow.name, lat: pickedRow.loc.lat, lng: pickedRow.loc.lng } : firstOffice ?? null;
  const extra = useMemo<Extra>(() => {
    const fc = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });
    const pt = (x: number, y: number, properties: Record<string, unknown>): GeoJSON.Feature => ({ type: "Feature", geometry: { type: "Point", coordinates: [x, y] }, properties });
    const placedRows = rows.filter((r) => r.x !== null && r.y !== null);
    const most = Math.max(1, ...[...moneyLoc.values()].map((v) => v.invoiced12 || v.invoiced));
    const active = new Set(data.money && data.money.connected ? data.money.active.map((a) => a.locationId).filter(Boolean) as string[] : []);
    const pkg = new Map<string, number>(); if (data.money && data.money.connected) for (const p of data.money.packages ?? []) if (p.locationId) pkg.set(p.locationId, (pkg.get(p.locationId) ?? 0) + Number(p.amount));
    const money = finance ? placedRows.flatMap((r) => { const v = moneyLoc.get(r.loc.id);
      if (!v) return active.has(r.loc.id) || pkg.has(r.loc.id) ? [pt(r.x!, r.y!, { id: r.loc.id, name: r.name, state: "pipeline", r: pkg.has(r.loc.id) ? 6 + 22 * Math.sqrt(Math.min(1, pkg.get(r.loc.id)! / most)) : 7, v: 0, label: "", tipTitle: r.name,
        tip: `${active.has(r.loc.id) ? "Active on the pod trackers" : "Package recorded"}; nothing invoiced to this project yet${pkg.has(r.loc.id) ? ` · package ${inr(pkg.get(r.loc.id)!)}` : ""}.` })] : [];
      const amount = v.invoiced12 || v.invoiced, state = v.overdue > 0 ? "overdue" : v.unpaid + v.unconfirmed > 0 ? "open" : "paid";
      return [pt(r.x!, r.y!, { id: r.loc.id, name: r.name, state, v: amount, r: 6 + 22 * Math.sqrt(amount / most), label: inr(amount), tipTitle: r.name,
        tip: `${inr(v.invoiced12)} in 12 months (${inr(v.invoiced)} in all) · ${v.overdue ? `${inr(v.overdue)} overdue` : v.unconfirmed ? `${inr(v.unconfirmed)} not yet confirmed` : "paid"}` })]; }) : [];
    const typeOf = new Map(data.clients.map((c) => [c.id, c.type]));
    const clients = placedRows.filter((r) => r.clientIds.length).map((r) => { const names = [...new Set(r.engagements.map((e) => e.clientName).filter(Boolean))];
      return pt(r.x!, r.y!, { id: r.loc.id, name: names[0] ?? r.name, type: typeOf.get(r.clientIds[0]) ?? "other", r: 6 + 2.5 * Math.sqrt(r.engagements.length), tipTitle: names.join(", ") || r.name,
        tip: `${CLIENT_TYPES[typeOf.get(r.clientIds[0]) ?? "other"] ?? "Client"} · ${r.name} · ${r.engagements.length} ${r.engagements.length === 1 ? "engagement" : "engagements"}` }); });
    const shoots = (data.shoots ?? []).filter((x) => x.lat !== null && x.lng !== null).map((x) => pt(x.lng!, x.lat!, { id: x.locationId, name: x.model ?? "Shoot", tipTitle: `${x.model ?? "A model"} · ${x.day ?? x.month}`,
      tip: [x.clientLabel, x.place, x.deliverable].filter(Boolean).join(" · ") || "Place from the shoot sheet" }));
    const topPrice = Math.max(1, ...priceStats.map((p) => p.median));
    const seen = new Set<string>();
    const prices = priceStats.filter((p) => { const k = p.key; if (seen.has(k) || (p.kind !== "apartment" && priceStats.some((q) => q.key === k && q.kind === "apartment"))) return false; seen.add(k); return true; })
      .map((p) => { const m = markets.find((x) => x.key === p.key); return m && m.lat !== null && m.lng !== null ? pt(m.lng, m.lat, { key: p.key, name: p.name, label: `₹${Math.round(p.median).toLocaleString("en-IN")}${p.kind === "plot" ? " plot" : ""}`, t: Math.sqrt(p.median / topPrice), n: p.n,
        tipTitle: p.name, tip: `Median ₹${Math.round(p.median).toLocaleString("en-IN")}/sq ft (${p.kind}) from ${p.projects} ${p.projects === 1 ? "project's" : "projects'"} documents` }) : null; })
      .filter((f): f is GeoJSON.Feature => !!f);
    const routeFc = route && route.order.length ? fc([
      { type: "Feature", geometry: { type: "LineString", coordinates: [...(route.start ? [[route.start.lng, route.start.lat]] : []), ...route.order.map((s) => [s.lng, s.lat])] }, properties: {} },
      ...route.order.map((s, i) => pt(s.lng, s.lat, { id: s.id, no: String(i + 1), name: s.name, tipTitle: `${i + 1}. ${s.name}`, tip: route.legs[i] ? `${route.legs[i].km.toFixed(1)} km, ~${route.legs[i].minutes} min from the stop before (estimated)` : "" }))]) : fc([]);
    const travel = travelOn && travelFrom ? fc([90, 60, 30].map((minutes, i) => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [circle(travelFrom.lat, travelFrom.lng, reachKm(minutes), 72)] }, properties: { label: `~${minutes} min`, o: [0.03, 0.05, 0.08][i] } }))) : fc([]);
    const gapFc = gapsOn ? fc(gaps.map((g) => pt(g.lng, g.lat, { key: g.key, name: g.name, tipTitle: `${g.name}: white space`, tip: g.why }))) : fc([]);
    return { money: fc(money), clients: fc(clients), shoots: fc(shoots), prices: fc(prices), route: routeFc, travel, gaps: gapFc };
  }, [rows, moneyLoc, finance, data.money, data.clients, data.shoots, priceStats, markets, route, travelOn, travelFrom?.lat, travelFrom?.lng, gapsOn, gaps]); // eslint-disable-line react-hooks/exhaustive-deps
  const available: Mode[] = ["points", "heat", "hex", "areas", "markets", "clients", ...(finance ? ["money" as const] : []), ...((data.shoots ?? []).length ? ["shoots" as const] : []), ...((data.prices ?? []).length ? ["prices" as const] : [])];
  const visibleFocus = focus ? rows.filter((r) => focus.rows.some((x) => x.loc.id === r.loc.id)) : [];
  const results = useMemo(() => { const q = query.trim().toLowerCase(); return q ? rows.filter((r) => [r.name, r.loc.clientLabel, placeName(r.loc), ...r.engagements.map((e) => e.clientName)].some((v) => v?.toLowerCase().includes(q))).slice(0, 7) : []; }, [query, rows]);
  const placeResults = useMemo(() => query.trim() ? markets.filter((m) => `${m.name} ${m.city}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 3) : [], [query, markets]);
  const filtered = filterCount(filters) > 0 || filters.from > 0 || filters.to < months.length - 1;
  const update = (patch: Partial<Filters>) => { setFilters((f) => ({ ...f, ...patch })); setNotice(""); };
  const clearAll = () => { setFilters(NO_FILTERS(months.length)); setPlaying(false); };

  // Phone: a bottom sheet. Desktop: the panel floats over the right of the map; the map's centre leaves it room.
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const sizeUp = () => { setPhone(media.matches); if (media.matches) { setPanel(false); setWide(false); } };
    // The first render is the desktop layout (the server cannot know the width); a phone folds it into the sheet
    // without animating, then transitions come on (LAYOUT-SWEEP: the sheet used to slide shut on every phone load).
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setSettled(true)); });
    sizeUp(); media.addEventListener("change", sizeUp); return () => { cancelAnimationFrame(frame); media.removeEventListener("change", sizeUp); };
  }, []);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const watch = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight, panel: aside.current?.offsetWidth ?? 0 }));
    watch.observe(el); if (aside.current) watch.observe(aside.current); return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (layersOpen) setLayersOpen(false); else if (measure) setMeasure(null); else if (fix) { setFix(null); setError(""); } else if (searchOpen) setSearchOpen(false);
      else if (timeOpen) setTimeOpen(false); else if (filterOpen) setFilterOpen(false); else if (selected) setSelected(null); else if (focus) setFocus(null); else if (wide) setWide(false); else if (phone) setPanel(false);
    };
    window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys);
  }, [layersOpen, measure, fix, searchOpen, timeOpen, filterOpen, selected, focus, wide, phone]);
  useEffect(() => {
    if (!playing || months.length < 2) return;
    const timer = window.setInterval(() => setFilters((f) => { if (f.to >= months.length - 1) { setPlaying(false); return f; } return { ...f, to: f.to + 1 }; }), 900);
    return () => window.clearInterval(timer);
  }, [playing, months.length]);

  const open = () => { setPanel(true); };
  const choose = (id: string) => {
    setSelected(id); setFocus(null); setFilterOpen(false); open(); setSearchOpen(false);
    const row = rows.find((r) => r.loc.id === id); if (row?.x !== null && row?.x !== undefined) map.current?.fly(row.x, row.y!, ringsOn ? 13 : undefined);
  };
  const showFocus = (f: Focus) => { setFocus(f); setSelected(null); setFilterOpen(false); open(); setSearchOpen(false); map.current?.fit(f.rows); };
  const showMarket = (m: Market) => showFocus({ name: m.name, note: `${n(m.projects)} projects · ${n(m.repeatClients)} repeat clients · ${m.city}`, rows: m.rows });
  const showBelt = (b: Belt) => showFocus({ name: b.name, note: `${n(b.projects)} projects · ${b.markets.length} neighbouring markets`, rows: b.markets.flatMap((m) => m.rows) });
  const showClient = (c: ClientSpread) => { setRepeatOverlay(true); showFocus({ name: c.name, note: `${n(c.projects)} projects · ${n(c.engagements)} engagements`, rows: c.rows, client: c.id }); };
  const startFix = (r: Row) => {
    if (!data.canEdit) return;
    const locality = markets.find((m) => m.key === `${r.loc.city}|${r.loc.locality ?? ""}`);
    const at = { id: r.loc.id, lat: r.loc.lat ?? locality?.lat ?? map.current?.centre().lat ?? 18.5204, lng: r.loc.lng ?? locality?.lng ?? map.current?.centre().lng ?? 73.8567 };
    setFix(at); setCoordinateText(`${at.lat.toFixed(7)}, ${at.lng.toFixed(7)}`); setPinNote(""); setError(""); setSelected(r.loc.id); setFocus(null); setFilterOpen(false); setMeasure(null); setTimeOpen(false);
    if (phone) setPanel(false); else setPanel(true);
  };
  const move = (lat: number, lng: number) => { setFix((f) => f ? { ...f, lat, lng } : null); setCoordinateText(`${lat.toFixed(7)}, ${lng.toFixed(7)}`); };
  const refresh = async () => {
    const res = await fetch("/api/v0/map", { cache: "no-store" }); if (!res.ok) throw new Error("The pin was saved, but the map could not refresh. Reload to see it.");
    setData(await res.json()); setDetailVersion((v) => v + 1);
  };
  const save = async () => {
    if (!fix) return;
    const point = parseCoordinates(coordinateText); if (!point) { setError("Enter valid latitude, longitude or a Maps URL containing coordinates."); return; }
    setSaving(true); setError("");
    try { const res = await fetch(`/api/v0/map/locations/${fix.id}/pin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...point, note: pinNote }) });
      const body = await res.json(); if (!res.ok) throw new Error(body.error ?? "The pin could not be saved.");
      await refresh(); setFix(null); setPanel(true); setNotice("Pin saved. The previous position and your name are kept in history.");
    } catch (e) { setError(e instanceof Error ? e.message : "The pin could not be saved."); } finally { setSaving(false); }
  };

  const sheetH = phone ? (panel ? Math.round(size.h * 0.62) : 76) : 0;
  const pad = { top: phone ? 60 : 64, left: 0, right: !phone && panel ? size.panel + 12 : 0, bottom: phone ? sheetH : 40 };
  const narrow = !phone && size.w - (panel ? size.panel + 24 : 0) < (filtered ? 980 : 860);
  const title = filterOpen ? "Filters" : picked ? displayName(picked) : focus ? focus.name : TABS.find((t) => t.key === tab)?.title ?? "Analysis";
  const layer = DATA_LAYERS.find((l) => l.key === mode)!;
  const canWiden = !phone && !filterOpen && (!!selected || !focus);

  return <div className={`${ui.page} ${css.root}`} data-fit="">
    <PageHeader title="Map" context={[`${n(located)} on the map`, `${n(rows.length)} projects · ${n(rows.length - located)} without a point`]} recent={{ title: "Map" }} />
    <section ref={box} className={css.workspace} aria-label="Pulse Map workspace" data-grow="" data-panel={panel ? "open" : "closed"} data-wide={wide && panel ? "" : undefined} data-phone={phone ? "" : undefined} data-settling={settled ? undefined : ""}
      data-narrow={narrow ? "" : undefined} data-base={base === "dark" || base === "satellite" || (base === "relief" && resolved === "dark") ? "dark" : "light"} data-time={timeOpen ? "open" : undefined} data-fixing={fix ? "" : undefined}>
      <MapCanvas orgName={orgName} rows={rows} markets={markets} areas={areas} areaMetric={metric} mode={mode} base={base} dark={resolved === "dark"} selected={selected} repeatOverlay={repeatOverlay} extrude={extrude} rings={rings} extra={extra}
        links={focus?.client ? visibleFocus : null} fix={fix} measure={measure} pad={pad} api={map} onSelect={choose} onMarket={(key: string) => { const m = markets.find((v) => v.key === key); if (m) showMarket(m); }}
        onFixMove={move} onHexResolution={setResolution} onMeasure={(at: [number, number]) => setMeasure((p) => [...(p ?? []), at])} onReady={() => { setReady(true); setMapError(""); }} onError={setMapError} />
      {!ready && !mapError ? <div className={css.mapLoading} role="status">Opening the map…</div> : null}
      {mapError ? <div className={css.mapLoading} role="alert">{mapError}<button type="button" onClick={() => window.location.reload()}>Try again</button></div> : null}
      {ready && !located ? <div className={css.noPoints}><Note icon={MapPinOff} title="No points in this view">{rows.length ? "These projects need a pin. Open Pins to place them." : "Clear a filter or widen the months."}</Note></div> : null}

      <div className={css.toolbar} role="toolbar" aria-label="Map tools">
        <div className={css.searchBox}><Search size={18} aria-hidden="true" /><input ref={search} type="search" value={query} onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} placeholder="Find a project, client or place" aria-label="Search projects, clients or places" onKeyDown={(e) => { if (e.key === "Enter") { if (placeResults[0]) showMarket(placeResults[0]); else if (results[0]) choose(results[0].loc.id); } }} />{query ? <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); setSearchOpen(false); }}><X size={16} /></button> : <kbd>/</kbd>}
          {searchOpen && query.trim() ? <div className={css.searchResults} aria-label="Search results">
            {placeResults.map((m) => <button type="button" key={m.key} onClick={() => showMarket(m)}><Layers size={18} aria-hidden="true" /><span><b>{m.name}</b><small>{n(m.projects)} projects · {m.city}</small></span></button>)}
            {results.map((r) => <button type="button" key={r.loc.id} onClick={() => choose(r.loc.id)}><MapPin size={18} aria-hidden="true" /><span><b>{r.name}</b><small>{placeName(r.loc)}</small></span><PrecisionBadge precision={r.loc.precision} /></button>)}
            {!results.length && !placeResults.length ? <p>No matches in the current filters.</p> : null}
          </div> : null}
        </div>
        <button ref={layersButton} type="button" className={css.tool} aria-label="Layers" aria-expanded={layersOpen} title="Base map, data layer and overlays" onClick={() => setLayersOpen(!layersOpen)}><layer.icon size={18} aria-hidden="true" /><span>{layer.label}</span></button>
        <button type="button" className={css.tool} aria-label="Filters" aria-pressed={filterOpen} title="Filter by pod, segment, client, status and precision" onClick={() => { setFilterOpen(!filterOpen); setPanel(true); }}><SlidersHorizontal size={18} aria-hidden="true" /><span>Filters</span>{filterCount(filters) ? <b>{filterCount(filters)}</b> : null}</button>
        <button type="button" className={css.tool} aria-label="Measure distance" aria-pressed={!!measure} title="Measure a distance on the map" onClick={() => { setMeasure(measure ? null : []); setLayersOpen(false); }}><Ruler size={18} aria-hidden="true" /><span>Measure</span></button>
        {filtered ? <button type="button" className={css.clearChip} onClick={clearAll} title="Clear filters and months" aria-label="Clear filters & months">Clear<X size={16} aria-hidden="true" /></button> : null}
      </div>
      <LayersMenu open={layersOpen} anchor={layersButton} close={() => setLayersOpen(false)} base={base} setBase={setBaseChoice} mode={mode} setMode={(m) => { setMode(m); if (m === "areas" && mode !== "areas") map.current?.home(); }} metric={metric} setMetric={setMetric}
        extrude={extrude} setExtrude={(on) => { setExtrude(on); if (on) setMode("hex"); }} repeat={repeatOverlay} setRepeat={setRepeatOverlay} rings={ringsOn} setRings={setRingsOn} hasProject={!!selected}
        available={available} travel={travelOn} setTravel={setTravelOn} gaps={gapsOn} setGaps={setGapsOn} travelFrom={travelFrom?.name ?? null} />

      <div className={css.mapControls} role="group" aria-label="Map view">
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => map.current?.zoom(1)}><Plus size={18} /></button>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => map.current?.zoom(-1)}><Minus size={18} /></button>
        <button type="button" aria-label="Reset north" title="Reset north and tilt" onClick={() => map.current?.north()}><Compass size={18} /></button>
        <button type="button" aria-label="Fit all projects" title="Fit all projects" onClick={() => map.current?.fit()}><LocateFixed size={18} /></button>
      </div>

      <Legend mode={mode} repeat={repeatOverlay} rings={!!rings} ringName={pickedRow?.name} resolution={resolution} extrude={extrude} metric={metric} setMetric={setMetric} values={areas.map((a) => areaValue(a, metric))} hidden={!!fix} folded={phone}
        overlays={{ travel: travelOn && travelFrom ? `30, 60 and 90 min from ${travelFrom.name}, estimated` : null, gaps: gapsOn && gaps.length > 0, route: route?.order.length ? `Shoot day: ${route.order.length} stops, ${route.km.toFixed(0)} km, ~${route.minutes} min (estimated)` : null }} />
      <TimeControl months={months} filters={filters} perMonth={perMonth} open={timeOpen} setOpen={setTimeOpen} playing={playing} hidden={!!fix}
        play={() => { if (!playing && filters.to === months.length - 1) update({ from: 0, to: 0 }); setPlaying(!playing); }} setRange={(from, to) => { setPlaying(false); update({ from, to }); }} />
      {measure ? <MeasureBar points={measure} undo={() => setMeasure(measure.slice(0, -1))} clear={() => setMeasure([])} done={() => setMeasure(null)} /> : null}

      {fix ? <form className={css.pinBar} onSubmit={(e) => { e.preventDefault(); void save(); }}><div className={css.pinTitle}><Crosshair size={20} aria-hidden="true" /><span><b>Fix pin · {fixRow ? displayName(fixRow) : "Project"}</b><small>Drag the pin to the site, or paste coordinates. Save only after checking the entrance.</small></span><button type="button" className={css.iconButton} disabled={saving} aria-label="Cancel pin correction" onClick={() => { setFix(null); setError(""); }}><X size={18} /></button></div>
        <div className={css.pinFields}><input aria-label="Pin coordinates or Maps link" value={coordinateText} onChange={(e) => { setCoordinateText(e.target.value); const at = parseCoordinates(e.target.value); if (at) setFix({ ...fix, ...at }); }} required /><input aria-label="Pin evidence or correction note" placeholder="Evidence link or reason for the correction" value={pinNote} maxLength={300} onChange={(e) => setPinNote(e.target.value)} /><button className={css.primary} disabled={saving} type="submit">{saving ? "Saving…" : "Save pin"}</button></div>{error ? <p className={css.error} role="alert">{error}</p> : null}</form> : null}
      {notice ? <button type="button" className={css.toast} role="status" onClick={() => setNotice("")}>{notice}<X size={16} aria-hidden="true" /></button> : null}

      <aside ref={aside} className={css.panel} aria-label={filterOpen ? "Map filters" : selected ? "Project details" : "Map analysis"} data-open={panel ? "" : undefined}>
        {phone ? <button type="button" className={css.sheetHead} aria-label={panel ? "Hide analysis" : "Show analysis"} aria-expanded={panel} onClick={() => setPanel(!panel)}>
          <i aria-hidden="true" /><span><b>{`${n(located)} on the map`}</b><small>{`${n(rows.length)} projects · ${n(rows.length - located)} without a point`}</small></span><ChevronUp size={20} aria-hidden="true" data-flip={panel ? "" : undefined} />
        </button> : <div className={css.edge}>
          <button type="button" aria-label={panel ? "Hide analysis" : "Show analysis"} title={panel ? "Hide the panel" : "Show the panel"} onClick={() => { setPanel(!panel); if (panel) setWide(false); }}>{panel ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}{panel ? null : <span>Analysis</span>}</button>
          {panel && canWiden ? <button type="button" aria-label={wide ? "Exit focus mode" : "Focus mode"} aria-pressed={wide} title={wide ? "Back to the narrow panel" : "Widen the panel to half the window for analysis"} onClick={() => setWide(!wide)}>{wide ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button> : null}
        </div>}
        <div className={css.panelBody} inert={!panel && !phone ? true : undefined}>
          {filterOpen ? <FilterPanel filters={filters} data={data} update={update} clear={() => setFilters(NO_FILTERS(months.length))} done={() => { setFilterOpen(false); setSelected(null); setFocus(null); if (phone) setPanel(false); }} />
            : selected ? <ProjectPanel key={selected} id={selected} version={detailVersion} row={pickedRow} rows={rows} onRing={(km) => { if (pickedRow?.loc.lat != null && pickedRow.loc.lng != null) { setRingsOn(true); map.current?.ring(pickedRow.loc.lat, pickedRow.loc.lng, km); } }} wide={wide} onBack={() => setSelected(null)} onSelect={choose}
                money={moneyLoc.get(selected) ?? null} financeVisible={finance} prices={(data.prices ?? []).filter((p) => p.locationId === selected)} shoots={(data.shoots ?? []).filter((x) => x.locationId === selected)}
                onFix={() => { const r = select(data, NO_FILTERS(months.length), months).find((r) => r.loc.id === selected); if (r) startFix(r); }} onRefresh={refresh} />
            : focus ? <div className={css.focusView}>
                <div className={css.projectHead}><div className={css.projectTop}><button type="button" className={css.textButton} onClick={() => setFocus(null)}><ChevronLeft size={16} aria-hidden="true" />All analysis</button></div><h2 className={css.projectName} title={focus.name}>{focus.name}</h2><p className={css.lead}>{focus.note}</p></div>
                <SubHead how={focus.client ? "Lines follow the order projects started. They describe a client's footprint, not journeys." : "Counts follow the current filters. Approximate pins show the known market, not the development entrance."}><span className={css.subTitle}>{n(visibleFocus.length)} projects in view</span></SubHead>
                <List resetKey={focus.name} items={visibleFocus} unit="projects" keyOf={(r) => r.loc.id} empty={<Note icon={MapPinOff} title="No projects match">Widen the filters or return to all analysis.</Note>} render={(r) => (
                  <button type="button" className={css.projectRow} onClick={() => choose(r.loc.id)}><span><b>{r.name}</b><small>{placeName(r.loc)} · {r.engagements.length} {r.engagements.length === 1 ? "engagement" : "engagements"}</small></span><PrecisionBadge precision={r.loc.precision} /></button>)} />
              </div>
            : <>
                <h2 className={css.srOnly}>{title}</h2>
                <Seg variant="tabs" label="Analysis" value={tab} onChange={(t) => { setTab(t); if (t === "money" && finance && mode === "points") setMode("money"); if (t === "shoots" && (data.shoots ?? []).length && mode === "points") setMode("shoots"); }}
                  items={TABS.filter((t) => (t.key !== "money" || !!data.money) && (t.key !== "shoots" || (data.shoots ?? []).length > 0))} />
                {tab === "money" ? <MoneyPanel key="money" data={data} markets={markets} byLocation={moneyLoc} byMarket={moneyMkt} today={today} wide={wide && !phone} onMarket={showMarket} onSelect={choose} onRefresh={refresh} />
                  : tab === "market" ? <MarketPanel key="market" markets={markets} prices={priceStats} gaps={gaps} wide={wide && !phone} onMarket={showMarket} />
                  : tab === "shoots" ? <ShootsPanel key="shoots" data={data} rows={rows} wide={wide && !phone} picked={pickedRow} start={routeStart} setStart={setRouteStart} stops={routeStops} setStops={setRouteStops} route={route} onSelect={choose} />
                  : <Analysis key={tab} tab={tab} data={data} rows={rows} allTime={allTime} markets={tab === "growth" ? growthMarkets : markets} months={months} filters={filters} wide={wide && !phone}
                  onMarket={showMarket} onBelt={showBelt} onClient={showClient} onSelect={choose} onFix={startFix} onPrecision={(key) => update({ precisions: filters.precisions.includes(key) ? [] : [key] })}
                  review={data.review !== null && data.review !== undefined ? <ReviewPanel wide={wide && !phone} version={detailVersion} onFly={(lat, lng) => map.current?.fly(lng, lat, 12.5)} onDone={refresh} /> : undefined} />}
              </>}
        </div>
      </aside>
      {!ready ? null : <span className={css.srOnly} aria-live="polite">{`${n(located)} projects on the map`}</span>}
    </section>
  </div>;
}

function FilterPanel({ filters, data, update, clear, done }: { filters: Filters; data: MapData; update: (patch: Partial<Filters>) => void; clear: () => void; done: () => void }) {
  const [group, setGroup] = useState<"pods" | "segments" | "clientTypes" | "stages" | "precisions">("pods");
  const groups = [{ key: "pods" as const, label: "Pod" }, { key: "segments" as const, label: "Segment" }, { key: "clientTypes" as const, label: "Client" }, { key: "stages" as const, label: "Status" }, { key: "precisions" as const, label: "Precision" }];
  const items = group === "pods" ? [...data.pods, "Unassigned"].map((key) => ({ key, label: key })) : group === "segments" ? SEGMENTS.map((key) => ({ key, label: key })) : group === "clientTypes" ? Object.entries(CLIENT_TYPES).map(([key, label]) => ({ key, label })) : group === "stages" ? Object.entries(STAGES).map(([key, label]) => ({ key, label })) : [...PRECISIONS, { key: "none", label: "No point" }];
  return <div className={css.filters}>
    <div className={css.projectHead}><div className={css.projectTop}><button type="button" className={css.textButton} onClick={done}><ChevronLeft size={16} aria-hidden="true" />Back</button></div><h2 className={css.panelTitle}>Filters</h2><p className={css.lead}>Within a category, choices are alternatives; categories apply together.</p></div>
    <SubHead how={group === "segments" ? SEGMENT_HINT : group === "stages" ? STAGE_HINT : group === "precisions" ? "Exact means evidence coordinates, not survey-grade accuracy. Review the source and flags before relying on a pin." : "Projects without a linked engagement appear in the full view. Pod, segment, client, status or month filters exclude them."}>
      <Seg variant="sub" label="Filter category" items={groups.map((g) => ({ ...g, count: filters[g.key].length || undefined }))} value={group} onChange={setGroup} />
    </SubHead>
    <div className={css.filterChoices}>{items.map(({ key, label }) => <label key={key}><input type="checkbox" checked={filters[group].includes(key)} onChange={() => update({ [group]: filters[group].includes(key) ? filters[group].filter((v) => v !== key) : [...filters[group], key] })} /><span>{label}</span></label>)}</div>
    <label className={css.switch}><input type="checkbox" checked={filters.repeatOnly} onChange={(e) => update({ repeatOnly: e.target.checked })} /><span>Only repeat clients</span></label>
    <div className={css.filterSummary}>{groups.filter((g) => filters[g.key].length).map((g) => <p key={g.key}><b>{g.label}</b><span>{filters[g.key].map((k) => CLIENT_TYPES[k] ?? STAGES[k] ?? PRECISIONS.find((p) => p.key === k)?.label ?? k).join(", ")}</span></p>)}</div>
    <div className={css.filterActions}><button type="button" className={css.textButton} onClick={clear}>Reset all</button><button type="button" className={css.primary} onClick={done}>Show results</button></div>
  </div>;
}
