"use client";

import { Crosshair, MapPinOff, Sparkles } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { belts, CLIENT_TYPES, monthLabel, monthShort, pinPriority, placeName, PRECISIONS, repeatClients, type Belt, type ClientSpread, type Filters, type MapData, type Market, type Row } from "./geo";
import css from "./map.module.css";
import { Layout, List, Note, PrecisionBadge, Stat } from "./parts";

export type AnalysisTab = "concentration" | "patterns" | "growth" | "market" | "money" | "shoots" | "coverage";
type Props = {
  tab: AnalysisTab; data: MapData; rows: Row[]; allTime: Row[]; markets: Market[]; months: string[]; filters: Filters; wide: boolean;
  onMarket: (m: Market) => void; onBelt: (b: Belt) => void; onClient: (c: ClientSpread) => void; onSelect: (id: string) => void; onFix: (row: Row) => void; onPrecision: (key: string) => void;
  review?: ReactNode;   // R55: the places to check (organisation admins), as a view of Pins
};
const n = (value: number) => value.toLocaleString("en-IN");
const pct = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "0%";
const plural = (value: number, one: string, many = `${one}s`) => `${n(value)} ${value === 1 ? one : many}`;

export function Analysis(props: Props) {
  if (props.tab === "concentration") return <Concentration {...props} />;
  if (props.tab === "patterns") return <Patterns {...props} />;
  if (props.tab === "growth") return <Growth {...props} />;
  return <Coverage {...props} />;
}

function Concentration({ rows, markets, data, onMarket, wide }: Props) {
  const [view, setView] = useState<"summary" | "markets" | "cities">("summary");
  const placed = rows.filter((r) => r.loc.city);
  const micro = markets.filter((m) => !m.isCity);
  const cities = useMemo(() => {
    const by = new Map<string, Market[]>(); for (const m of markets) by.set(m.city, [...(by.get(m.city) ?? []), m]);
    return [...by.entries()].map(([city, list]) => ({ city, projects: list.reduce((s, m) => s + m.projects, 0), markets: list.filter((m) => !m.isCity).length, top: list[0] })).sort((a, b) => b.projects - a.projects);
  }, [markets]);
  const top5 = micro.slice(0, 5).reduce((s, m) => s + m.projects, 0);
  // How many micro-markets it takes to cover half of the placed projects: a plain reading of concentration.
  let half = 0, run = 0; for (const m of markets) { if (run * 2 >= placed.length) break; run += m.projects; half += 1; }
  const shown = wide && view === "summary" ? "markets" : view;
  const most = Math.max(1, shown === "cities" ? cities[0]?.projects ?? 1 : markets[0]?.projects ?? 1);
  const summary = <>
    <div className={css.stats}>
      <Stat label="Projects" value={n(rows.length)} note={`${n(placed.length)} with a city`} title="Developments that pass the filters. A development shot more than once counts once." />
      <Stat label="Markets" value={n(micro.length)} note={plural(cities.length, "city", "cities")} title="Named localities with at least one visible project." />
      <Stat label="Top 5 share" value={pct(top5, placed.length)} note={`${n(top5)} of ${n(placed.length)}`} title="Projects in the five busiest micro-markets, as a share of all projects with a place." />
    </div>
    {placed.length ? <>
      <p className={css.lead}><b>{run >= placed.length ? "All" : "Half"} of the work sits in {plural(half, "market")}.</b> {markets[0] ? `${markets[0].name} leads with ${plural(markets[0].projects, "project")}.` : ""}</p>
      <div className={css.bars} role="list" aria-label="Busiest micro-markets">
        {markets.slice(0, 18).map((m) => <button key={m.key} type="button" role="listitem" onClick={() => onMarket(m)} title={`${m.name}: ${plural(m.projects, "project")}. Show on the map.`}>
          <span>{m.name}</span><i><em style={{ width: `${(m.projects / most) * 100}%` }} /></i><b>{n(m.projects)}</b></button>)}
      </div>
    </> : <Note icon={MapPinOff} title="No projects match">Clear a filter or widen the months.</Note>}
  </>;
  return (
    <Layout wide={wide} summary={summary} label="Places view" view={view} setView={setView} views={[{ key: "markets", label: "Markets", count: markets.length }, { key: "cities", label: "Cities", count: cities.length }]}
      how={<>A project is one development; repeat shoots count once. Pune includes PCMC and nearby towns. {data.joins?.unmatchedEngagements ? `${data.joins.linkedEngagements} of ${data.joins.sourceEngagements} source folders are linked; ${data.joins.unmatchedEngagements} await matching for engagement filters and repeat-client counts.` : "Projects with only a city are listed under the city."}</>}>
      {shown === "markets"
        ? <List resetKey="markets" items={markets} unit="markets" columns={wide} keyOf={(m) => m.key} empty={<Note icon={MapPinOff} title="No projects match">Clear a filter or widen the months.</Note>} render={(m, i) => (
            <button type="button" className={css.rank} onClick={() => onMarket(m)} title={`Show ${m.name} on the map`}>
              <span className={css.rankNo}>{i + 1}</span>
              <span className={css.rankText}><b>{m.name}</b><small>{m.isCity ? "City, locality not known" : m.city}{m.repeatClients ? ` · ${plural(m.repeatClients, "repeat client")}` : ""}</small></span>
              <span className={css.bar}><i style={{ width: `${(m.projects / most) * 100}%` }} /></span>
              <span className={css.rankValue}>{n(m.projects)}</span>
            </button>)} />
        : <List resetKey="cities" items={cities} unit="cities" columns={wide} keyOf={(c) => c.city} render={(c, i) => (
            <button type="button" className={css.rank} onClick={() => onMarket({ ...c.top, rows: markets.filter((m) => m.city === c.city).flatMap((m) => m.rows), key: `city:${c.city}`, name: c.city })} title={`Show ${c.city} on the map`}>
              <span className={css.rankNo}>{i + 1}</span>
              <span className={css.rankText}><b>{c.city}</b><small>{c.markets ? plural(c.markets, "micro-market") : "No locality known"}</small></span>
              <span className={css.bar}><i style={{ width: `${(c.projects / most) * 100}%` }} /></span>
              <span className={css.rankValue}>{n(c.projects)}</span>
            </button>)} />}
    </Layout>
  );
}

function Patterns({ rows, markets, data, onMarket, onBelt, onClient, wide }: Props) {
  const [view, setView] = useState<"summary" | "markets" | "belts" | "clients">("markets");
  const beltList = useMemo(() => belts(markets, data), [markets, data]);
  const clients = useMemo(() => repeatClients(rows, data), [rows, data]);
  const micro = markets.filter((m) => m.projects >= 2);
  return (
    <Layout wide={wide} label="Pattern" view={view} setView={setView} views={[{ key: "markets", label: "Markets", count: micro.length }, { key: "belts", label: "Belts", count: beltList.length }, { key: "clients", label: "Repeat clients", count: clients.length }]}
      how={view === "belts" ? "Micro-market centres within 3.5 km of each other are chained into a belt. Centres are representative points, so a belt is a guide, not a boundary."
        : view === "clients" ? "Counted from the visible projects only. Choose a client to draw their projects on the map in the order they started."
        : "Markets with at least two visible projects. Repeat clients are clients with more than one engagement anywhere in Pulse. Segment is read from the folder name."}>
      {view === "markets" || view === "summary" ? <List resetKey="markets" items={micro} unit="markets" columns={wide} keyOf={(m) => m.key} empty={<Note icon={Sparkles} title="No pattern yet">A market needs at least two visible projects.</Note>} render={(m) => (
        <button type="button" className={css.fact} onClick={() => onMarket(m)} title={[m.engagements > m.projects ? `${n(m.engagements)} engagements` : null, m.topSegment ? `mostly ${m.topSegment.toLowerCase()}` : null, m.recent ? `${m.recent} in the last 12 months` : "none in the last 12 months"].filter(Boolean).join(" · ")}>
          <b>{m.name}: {plural(m.projects, "project")}{m.repeatClients ? `, ${plural(m.repeatClients, "repeat client")}` : ""}</b>
          <small>{[m.engagements > m.projects ? `${n(m.engagements)} engagements` : null, m.topSegment ? `mostly ${m.topSegment.toLowerCase()}` : null,
            m.first ? (m.first === m.last ? monthLabel(m.first) : `${monthShort(m.first)} to ${monthShort(m.last!)}`) : null,
            m.recent ? `${m.recent} in the last 12 months` : "none in the last 12 months"].filter(Boolean).join(" · ")}</small>
        </button>)} /> : null}
      {view === "belts" ? <List resetKey="belts" items={beltList} unit="belts" columns={wide} keyOf={(b) => b.name} empty={<Note icon={Sparkles} title="No belts in view">A belt is two or more neighbouring micro-markets with five or more projects between them.</Note>} render={(b) => (
        <button type="button" className={css.fact} onClick={() => onBelt(b)} title={b.markets.map((m) => `${m.name} (${m.projects})`).join(", ")}>
          <b>{b.name}: {plural(b.projects, "project")}</b>
          <small>{plural(b.markets.length, "neighbouring market")} within {b.spanKm.toFixed(1)} km{b.repeatClients ? ` · ${plural(b.repeatClients, "repeat client")}` : ""} · led by {b.markets[0].name} ({b.markets[0].projects})</small>
        </button>)} /> : null}
      {view === "clients" ? <List resetKey="clients" items={clients} unit="clients" columns={wide} keyOf={(c) => c.id} empty={<Note icon={Sparkles} title="No repeat clients in view">A repeat client has more than one engagement among the visible projects.</Note>} render={(c) => (
        <button type="button" className={css.fact} onClick={() => onClient(c)} title={`Show this client's projects on the map: ${c.markets.join(", ") || "place not known"}`}>
          <b>{c.name}: {plural(c.engagements, "engagement")} on {plural(c.projects, "project")}</b>
          <small>{CLIENT_TYPES[c.type] ?? "Client"} · {c.markets.length ? `${c.markets.slice(0, 3).join(", ")}${c.markets.length > 3 ? ` +${c.markets.length - 3}` : ""}` : "place not known"}</small>
        </button>)} /> : null}
    </Layout>
  );
}

function Growth({ allTime, markets, months, filters, wide }: Props) {
  const [view, setView] = useState<"summary" | "markets">("summary");
  const perMonth = useMemo(() => { const count = new Map<string, number>(); for (const r of allTime) for (const e of r.engagements) if (e.month) count.set(e.month, (count.get(e.month) ?? 0) + 1); return months.map((m) => ({ m, v: count.get(m) ?? 0 })); }, [allTime, months]);
  const most = Math.max(1, ...perMonth.map((p) => p.v));
  const recent = perMonth.slice(-12).reduce((s, p) => s + p.v, 0), before = perMonth.slice(-24, -12).reduce((s, p) => s + p.v, 0);
  const peak = perMonth.reduce((a, b) => (b.v > a.v ? b : a), { m: months[0] ?? "", v: 0 });
  const years = useMemo(() => { const by = new Map<string, { engagements: number; entered: number }>();
    for (const p of perMonth) { const y = p.m.slice(0, 4), e = by.get(y) ?? { engagements: 0, entered: 0 }; e.engagements += p.v; by.set(y, e); }
    // A market is "entered" in the year of its first engagement, read without the month filter.
    const first = new Map<string, string>(); for (const r of allTime) { const key = r.loc.city ? `${r.loc.city}|${r.loc.locality ?? ""}` : null; if (key && r.first && (!first.has(key) || r.first < first.get(key)!)) first.set(key, r.first); }
    for (const m of first.values()) { const e = by.get(m.slice(0, 4)); if (e) e.entered += 1; }
    return [...by.entries()].sort(); }, [perMonth, allTime]);
  const movers = useMemo(() => markets.filter((m) => m.recent + m.before > 0).map((m) => ({ ...m, change: m.recent - m.before })).sort((a, b) => b.change - a.change || b.recent - a.recent), [markets]);
  const summary = <>
    <div className={css.stats}>
      <Stat label="Last 12 months" value={n(recent)} note="engagements started" title={`Engagements whose start month falls in the last twelve months of the data (${months.length ? monthLabel(months[Math.max(0, months.length - 12)]) : ""} onwards).`} />
      <Stat label="12 months before" value={n(before)} note={before ? `${recent >= before ? "+" : "−"}${Math.abs(Math.round(((recent - before) / before) * 100))}% since` : "no earlier data"} title="The twelve months before those, for comparison." />
      <Stat label="Busiest month" value={peak.v ? monthShort(peak.m) : "—"} note={peak.v ? plural(peak.v, "engagement") : undefined} title="The month with the most engagements started." />
    </div>
    <div className={css.chart}>
      <div className={css.chartBars} role="img" aria-label={`Engagements started per month, ${months.length ? `${monthLabel(months[0])} to ${monthLabel(months[months.length - 1])}` : ""}`}>
        {perMonth.map((p, i) => <i key={p.m} data-on={i >= filters.from && i <= filters.to ? "" : undefined} style={{ height: `${Math.max(p.v ? 2 : 0, (p.v / most) * 100)}%` }} title={`${monthLabel(p.m)}: ${plural(p.v, "engagement")} started`} />)}
      </div>
      <div className={css.chartTicks} aria-hidden="true">{perMonth.map((p, i) => <span key={p.m}>{p.m.endsWith("-01") ? p.m.slice(0, 4) : i === 0 && Number(p.m.slice(5, 7)) <= 9 ? monthShort(p.m) : ""}</span>)}</div>
    </div>
    <div className={css.years}>{years.map(([year, v]) => <div key={year} title={`${year}: ${plural(v.engagements, "engagement")} started; first work in ${plural(v.entered, "market")}`}><span>{year}</span><b>{n(v.engagements)}</b><small>{v.entered} new {v.entered === 1 ? "market" : "markets"}</small></div>)}</div>
  </>;
  return (
    <Layout wide={wide} summary={summary} label="Growth view" view={view} setView={setView} views={[{ key: "markets", label: "Market movers", count: movers.length }]}
      how={view === "markets" || wide ? "Last 12 months against the 12 before, by engagements started. The last 12 months end with the newest month in the data."
        : "One bar per month: project folders (engagements) by start month. Darker bars are inside the months chosen on the timeline. Filters apply; the month range does not."}>
      <List resetKey="movers" items={movers} unit="markets" columns={wide} keyOf={(m) => m.key} render={(m) => (
        <div className={css.rank} data-static="">
          <span className={css.rankText}><b>{m.name}</b><small>{m.city}{m.first ? ` · since ${monthShort(m.first)}` : ""}</small></span>
          <span className={css.pair} title="Engagements started in the last 12 months, and in the 12 months before">{m.recent}<small> vs {m.before}</small></span>
          <span className={css.delta} data-tone={m.change > 0 ? "up" : m.change < 0 ? "down" : "flat"}>{m.change > 0 ? "+" : m.change < 0 ? "−" : ""}{Math.abs(m.change)}</span>
        </div>)} />
    </Layout>
  );
}

function Coverage({ rows, data, onSelect, onFix, onPrecision, filters, wide, review }: Props) {
  const [view, setView] = useState<"summary" | "needs" | "none" | "pinned" | "check">("summary");
  const counts = useMemo(() => { const c: Record<string, number> = { none: 0 }; for (const r of rows) { const k = r.loc.precision ?? "none"; c[k] = (c[k] ?? 0) + 1; } return c; }, [rows]);
  const needs = useMemo(() => rows.filter((r) => !r.loc.precision || !["exact", "building"].includes(r.loc.precision)).sort((a, b) => pinPriority(b) - pinPriority(a) || a.name.localeCompare(b.name)), [rows]);
  const none = needs.filter((r) => !r.loc.precision), pinned = rows.filter((r) => r.loc.pinned);
  const shown = wide && view === "summary" ? "needs" : view;
  const list = shown === "none" ? none : shown === "pinned" ? pinned : needs;
  const precise = rows.length - needs.length;
  const all = [...PRECISIONS, { key: "none", label: "No point", meaning: "Not enough evidence to place it.", confirmed: false }];
  const summary = <>
    <div className={css.stats}>
      <Stat label="Precise pins" value={n(precise)} note={`${pct(precise, rows.length)} of ${n(rows.length)}`} title="Projects whose point is exact or matched to a named building." />
      <Stat label="Need a pin" value={n(needs.length)} note={`${n(none.length)} with no point`} title="Projects known only to a street, locality or city, or not located at all." />
      <Stat label="Pinned in Pulse" value={n(data.pins.moved ? pinned.length : 0)} note={data.pins.moved ? plural(data.pins.moved, "move") : "none yet"} title="Pins placed or corrected by a person in Pulse. Every move is kept in the pin's history." />
    </div>
    <div className={css.stack} role="group" aria-label="Projects by precision. Choose one to filter the map.">
      {all.map((p) => counts[p.key] ? (
        <button key={p.key} type="button" data-precision={p.key} aria-pressed={filters.precisions.includes(p.key)} style={{ flexGrow: counts[p.key] }} title={`${p.label}: ${n(counts[p.key])}. ${p.meaning} Click to filter.`} onClick={() => onPrecision(p.key)}><b>{n(counts[p.key])}</b></button>) : null)}
    </div>
    <ul className={css.meanings}>{all.map((p) => <li key={p.key}><PrecisionBadge precision={p.key === "none" ? null : p.key as Row["loc"]["precision"]} /><b>{n(counts[p.key] ?? 0)}</b><span>{p.meaning}</span></li>)}</ul>
  </>;
  return (
    <Layout wide={wide} summary={summary} label="Coverage list" view={view} setView={setView} views={[...(review ? [{ key: "check" as const, label: "Check", count: data.review ?? undefined }] : []), { key: "needs", label: "To pin", count: needs.length }, { key: "none", label: "No point", count: none.length }, { key: "pinned", label: "Pinned", count: pinned.length }]}
      how={view === "check" ? "Places their own evidence contradicts: a micro-market centre more than 25 km from its city (the 5 Oct import matched some names to a village or boundary of the same name elsewhere), a pin far from the locality its folder names, or sources that disagree. Accepting moves the place with the move in each project's pin history; Keep leaves it. Pulse never geocodes outside itself." : <>Listed in the order worth fixing: no point first, then projects with a Maps link or RERA number to pin from, then repeat clients. {data.canEdit ? "Fix pin saves an exact point with your name and keeps the old one in history." : "Organisation admins can fix pins."} Exact means evidence coordinates, not survey-grade accuracy.</>}>
      {shown === "check" ? review : <List resetKey={shown} items={list} unit="projects" columns={wide} keyOf={(r) => r.loc.id} empty={<Note icon={Crosshair} title={shown === "pinned" ? "No pins placed in Pulse yet" : "Nothing left to pin here"}>{shown === "pinned" ? "Choose a project and use Fix pin to place it exactly." : "Every visible project has a precise pin."}</Note>} render={(r) => (
        <div className={css.cover}>
          <button type="button" className={css.coverText} onClick={() => onSelect(r.loc.id)} title={`Open ${r.name}: ${placeName(r.loc)}`}><b>{r.name}</b>
            <small><PrecisionBadge precision={r.loc.precision} pinned={r.loc.pinned} /><span>{[placeName(r.loc), r.loc.mapsLinks ? "Maps link" : "", r.loc.rera ? `${r.loc.rera} RERA` : "", r.repeat ? "repeat client" : ""].filter(Boolean).join(" · ")}</span></small></button>
          {data.canEdit ? <button type="button" className={css.fixBtn} onClick={() => onFix(r)} title="Drag a pin to the site and save it"><Crosshair size={15} aria-hidden="true" />Fix pin</button> : null}
        </div>)} />}
    </Layout>
  );
}
