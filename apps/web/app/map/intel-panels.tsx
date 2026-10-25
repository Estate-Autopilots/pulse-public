"use client";

// R55: the map's market intelligence. Money by place (leadership with finance access), the market (prices, white
// space, launches), shoots and a shoot-day route, and the places Pulse thinks are wrong (the review queue).
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Banknote, Check, Crosshair, ExternalLink, IndianRupee, Link2, Plus, Radar, Route as RouteIcon, X } from "lucide-react";
import { monthShort, parseCoordinates, type MapData, type Market, type ReviewItem, type Row } from "./geo";
import { CONFIDENCE_LABEL, inr, projectRevenue, type Confidence, type Gap, type MoneyParty, type PlaceMoney, type PriceStat, type Route, type Stop } from "./intel";
import { Layout, List, Note, Stat } from "./parts";
import css from "./map.module.css";
import { SelectField } from "../kit/select-field";

const n = (v: number) => v.toLocaleString("en-IN");
const pct = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "0%";
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const Chip = ({ c }: { c: Confidence }) => <span className={css.chip} data-confidence={c}>{CONFIDENCE_LABEL[c]}</span>;
async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Could not save");
  return data;
}

// ---------------------------------------------------------------------------------------------------------- Money
export function MoneyPanel({ data, markets, byLocation, byMarket, today, wide, onMarket, onSelect, onRefresh }: {
  data: MapData; markets: Market[]; byLocation: Map<string, PlaceMoney>; byMarket: Map<string, PlaceMoney>; today: string; wide: boolean;
  onMarket: (m: Market) => void; onSelect: (id: string) => void; onRefresh: () => Promise<void>;
}) {
  const [view, setView] = useState<"summary" | "markets" | "risk" | "pipeline" | "projection" | "link">("summary");
  const money = data.money;
  const ranked = useMemo(() => markets.filter((m) => byMarket.has(m.key)).map((m) => ({ m, v: byMarket.get(m.key)! })).sort((a, b) => b.v.invoiced12 - a.v.invoiced12 || b.v.invoiced - a.v.invoiced), [markets, byMarket]);
  const rowsById = useMemo(() => new Map(markets.flatMap((m) => m.rows.map((r) => [r.loc.id, r] as const))), [markets]);
  if (!money || !money.connected) return <div className={css.pane}><div className={css.main}><Note icon={Banknote} title="Money is for leadership with finance access">{money && !money.connected ? money.detail : "Invoices, collections and the pipeline by place are shown to leadership with finance access."}</Note></div></div>;
  const all = money.invoices, placed = all.filter((i) => i.locationId);
  const from12 = `${Number(today.slice(0, 4)) - 1}-${today.slice(5, 7)}`;
  const year = all.filter((i) => i.day.slice(0, 7) > from12), yearPlaced = year.filter((i) => i.locationId);
  const sum = (xs: typeof all) => xs.reduce((t, i) => t + (i.taxable || 0), 0);
  const overdue = placed.filter((i) => i.status === "unpaid" && i.overdueDays > 0);
  const unverified = placed.filter((i) => i.status !== "paid" && i.status !== "unpaid" && i.overdueDays > 0);
  const risk = [...byLocation.entries()].filter(([, v]) => v.overdue > 0 || v.unpaid > 0).map(([id, v]) => ({ id, v, row: rowsById.get(id) })).filter((x) => x.row).sort((a, b) => b.v.overdue - a.v.overdue);
  const toLink = money.parties.filter((p) => p.status === "review" || p.status === "none").sort((a, b) => b.taxable - a.taxable);
  const active = money.active, activePlaced = active.filter((a) => a.locationId && rowsById.has(a.locationId));
  // Package values leadership records on client projects (Work → the project → value), by project and place.
  const packages = (money.packages ?? []).filter((p) => p.currency === "INR");
  const packageOf = new Map(packages.map((p) => [p.projectId, Number(p.amount)]));
  const projections = ranked.filter((x) => x.v.invoiced12 > 0).map((x) => ({ ...x, p: projectRevenue(x.v.monthly, today, x.v.clients) })).sort((a, b) => b.p.next6 - a.p.next6);
  const top = Math.max(1, ...ranked.map((x) => x.v.invoiced12));
  const summary = <>
    <div className={css.stats}>
      <Stat label="On the map" value={pct(sum(yearPlaced), sum(year))} note={`${inr(sum(yearPlaced))} of ${inr(sum(year))} · 12 months`} title="Invoices of the last twelve months (before GST) whose client and project Pulse knows, and whose project has a place." />
      <Stat label="Overdue" value={inr(sum(overdue))} note={`${plural(overdue.length, "invoice")} · ${n(unverified.length)} past due, unverifiable`} title={`Past their due date with no bank credit found up to ${money.evidenceEnd ?? "the last statement"}. ${unverified.length} later invoices are past due too but no statement can confirm them yet.`} />
      <Stat label="To link" value={n(toLink.length)} note={`${inr(toLink.reduce((t, p) => t + p.taxable, 0))} invoiced`} title="Invoice parties Pulse could not tie to one client. Link them under Link." />
    </div>
    <p className={css.lead}><b>{ranked[0] ? `${ranked[0].m.name} brings the most: ${inr(ranked[0].v.invoiced12)} in 12 months.` : "No placed invoice yet."}</b> {activePlaced.length ? `${plural(activePlaced.length, "active client")} on the pod trackers ${activePlaced.length === 1 ? "is" : "are"} on the map.` : ""} {packages.length ? `Package values: ${inr(packages.reduce((t, p) => t + Number(p.amount), 0))} across ${plural(packages.length, "project")}.` : "No package value is recorded on a project yet (Work → the project → value)."} Bank evidence ends {money.evidenceEnd ?? "with the last statement"}: later invoices read as not yet confirmed.</p>
    <div className={css.bars} role="list" aria-label="Invoiced by micro-market, last 12 months">
      {ranked.slice(0, 12).map(({ m, v }) => <button key={m.key} type="button" role="listitem" onClick={() => onMarket(m)} title={`${m.name}: ${inr(v.invoiced12)} in 12 months, ${plural(v.clients, "client")}`}>
        <span>{m.name}</span><i><em style={{ width: `${(v.invoiced12 / top) * 100}%` }} /></i><b>{inr(v.invoiced12)}</b></button>)}
    </div>
  </>;
  const views = [{ key: "markets" as const, label: "Markets" }, { key: "risk" as const, label: "Risk" }, { key: "pipeline" as const, label: "Pipeline" },
    { key: "projection" as const, label: "Forecast" }, { key: "link" as const, label: "Link", count: toLink.length }];
  const how = view === "projection" ? "Per market: the average of the last six full months, moved by half the trend of the last three months against the three before (capped at ±30%). High confidence needs invoices in 8 of 12 months from 3+ clients; one client's market is low confidence: it is that client's plan."
    : view === "risk" ? `Overdue: past due with no matching bank credit up to ${money.evidenceEnd ?? "the last statement"} (FIN-LIVE's reconciliation). Not yet confirmed: invoices after the last statement, which no bank line can confirm yet.`
    : view === "pipeline" ? "Active clients are the projects marked Active on the pod trackers; each is placed where its Pulse project is. The figure on the right is the package value leadership recorded on that project, where there is one."
    : view === "link" ? "Zoho invoices name the developer's legal entity. A party links itself when its name is a client's, or when every distinctive word of it appears in one client's project folders, shoot sheet or documents. Link the rest here; decisions are kept."
    : "Invoices before GST, placed at the project of the client they were for: the engagement that had started by the invoice month. A market is the micro-market of those projects.";
  return (
    <Layout wide={wide} summary={summary} label="Money view" view={view} setView={setView} views={views} how={how}>
      {view === "markets" ? <List resetKey="money-markets" items={ranked} unit="markets" columns={wide} keyOf={(x) => x.m.key} empty={<Note icon={Banknote} title="No placed invoices">Link invoice parties under Link.</Note>} render={({ m, v }, i) => (
        <button type="button" className={css.rank} onClick={() => onMarket(m)} title={`${m.name}: ${inr(v.invoiced)} invoiced in all, ${inr(v.overdue)} overdue`}>
          <span className={css.rankNo}>{i + 1}</span><span className={css.rankText}><b>{m.name}</b><small>{plural(v.clients, "client")} · {plural(v.invoices, "invoice")}{v.overdue ? ` · ${inr(v.overdue)} overdue` : ""}</small></span>
          <span className={css.bar}><i style={{ width: `${(v.invoiced12 / top) * 100}%` }} /></span><span className={css.rankValue}>{inr(v.invoiced12)}</span></button>)} /> : null}
      {view === "risk" ? <List resetKey="money-risk" items={risk} unit="projects" columns={wide} keyOf={(x) => x.id} empty={<Note icon={Check} title="Nothing overdue on the map">No placed invoice is past due without a bank credit.</Note>} render={(x) => (
        <button type="button" className={css.rank} onClick={() => onSelect(x.id)}><span className={css.rankText}><b>{x.row!.name}</b><small>{x.row!.loc.locality ?? x.row!.loc.city} · {inr(x.v.unpaid)} unpaid · {inr(x.v.unconfirmed)} not yet confirmed</small></span>
          <span className={css.rankValue} data-tone="risk">{inr(x.v.overdue)}</span></button>)} /> : null}
      {view === "pipeline" ? <List resetKey="money-pipeline" items={active} unit="clients" columns={wide} keyOf={(a) => a.name} empty={<Note icon={Banknote} title="No active clients">The pod trackers list no active client.</Note>} render={(a) => {
        const r = a.locationId ? rowsById.get(a.locationId) : undefined; const v = a.locationId ? byLocation.get(a.locationId) : undefined;
        const pkg = a.projectId ? packageOf.get(a.projectId) : undefined;
        return <button type="button" className={css.rank} disabled={!r} onClick={() => r && onSelect(r.loc.id)}><span className={css.rankText}><b>{a.name}</b><small>{r ? `${r.loc.locality ?? r.loc.city}${v ? ` · ${inr(v.invoiced12)} in 12 months` : " · nothing invoiced yet"}` : a.projectId ? "Project not on the map yet" : "No Pulse project of this name"}</small></span>
          {pkg !== undefined ? <span className={css.rankValue} title="Package value recorded on the project">{inr(pkg)}</span> : null}</button>; }} /> : null}
      {view === "projection" ? <List resetKey="money-projection" items={projections} unit="markets" columns={wide} keyOf={(x) => x.m.key} render={(x) => (
        <button type="button" className={css.fact} onClick={() => onMarket(x.m)} title={x.p.method}><b>{x.m.name}: {inr(x.p.next6)} in the next six months</b>
          <small>{inr(x.p.perMonth)} a month · trend {x.p.trend >= 0 ? "+" : "−"}{Math.round(Math.abs(x.p.trend) * 100)}% · {plural(x.p.activeMonths, "month")} with invoices <Chip c={x.p.confidence} /></small></button>)} /> : null}
      {view === "link" ? <List resetKey="money-link" items={toLink} unit="parties" keyOf={(p) => p.key} empty={<Note icon={Link2} title="Every invoice party is linked">New parties appear after the next finance sync.</Note>} render={(p) => <PartyRow party={p} clients={data.clients} onDone={onRefresh} />} /> : null}
    </Layout>
  );
}

function PartyRow({ party, clients, onDone }: { party: MoneyParty; clients: MapData["clients"]; onDone: () => Promise<void> }) {
  const [pick, setPick] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const save = async (clientId: string | null) => {
    setBusy(true); setError("");
    try { await post("/api/v0/map/money/party", { key: party.key, clientId }); await onDone(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  };
  return <div className={css.party}>
    <span><b>{party.party}</b><small>{plural(party.invoices, "invoice")} · {inr(party.taxable)} before GST{party.status === "review" ? " · several clients fit" : ""}</small></span>
    <div className={css.partyActions}>
      {party.candidates.slice(0, 3).map((c) => <button key={c.clientId} type="button" className={css.fixBtn} disabled={busy} onClick={() => void save(c.clientId)} title={`${c.name}: ${plural(c.projects, "project")}`}><Link2 size={14} aria-hidden="true" />{c.name}</button>)}
      <SelectField aria-label={`Client for ${party.party}`} value={pick} disabled={busy} onChange={(e) => setPick(e.target.value)}><option value="">Choose a client…</option>{[...clients].sort((a, b) => a.name.localeCompare(b.name)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField>
      <button type="button" className={css.primary} disabled={busy || !pick} onClick={() => void save(pick)}>Link</button>
      <button type="button" className={css.textButton} disabled={busy} onClick={() => void save(null)} title="This party is not a client in Pulse">Not a client</button>
    </div>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </div>;
}

// --------------------------------------------------------------------------------------------------------- Market
export function MarketPanel({ markets, prices, gaps, wide, onMarket }: { markets: Market[]; prices: PriceStat[]; gaps: Gap[]; wide: boolean; onMarket: (m: Market) => void }) {
  const [view, setView] = useState<"summary" | "prices" | "gaps" | "launches">("summary");
  const byKey = useMemo(() => new Map(markets.map((m) => [m.key, m])), [markets]);
  const apt = prices.filter((p) => p.kind === "apartment"), plot = prices.filter((p) => p.kind === "plot");
  const launches = useMemo(() => markets.filter((m) => m.recent > 0).sort((a, b) => b.recent - a.recent || b.projects - a.projects), [markets]);
  const topPrice = Math.max(1, ...apt.map((p) => p.median));
  const summary = <>
    <div className={css.stats}>
      <Stat label="Priced markets" value={n(new Set(prices.map((p) => p.key)).size)} note={`${n(prices.reduce((t, p) => t + p.n, 0))} prices in documents`} title="Prices per sq ft written in the documents of a market's own projects." />
      <Stat label="White space" value={n(gaps.length)} note={`${n(gaps.filter((g) => g.confidence !== "low").length)} medium or high`} title="Markets with demand nearby or known projects, and nothing invoiced in the last twelve months." />
      <Stat label="Launches, 12 months" value={n(launches.reduce((t, m) => t + m.recent, 0))} note={plural(launches.length, "market")} title="Engagements EA started in the last twelve months, by market." />
    </div>
    <p className={css.lead}>{apt[0] ? <><b>Apartments: {apt.length > 1 ? `₹${n(Math.round(Math.min(...apt.map((p) => p.median))))}–${n(Math.round(Math.max(...apt.map((p) => p.median))))}` : `₹${n(Math.round(apt[0].median))}`}/sq ft</b> across {plural(apt.length, "market")}{plot.length ? `; plots ₹${n(Math.round(Math.min(...plot.map((p) => p.median))))}–${n(Math.round(Math.max(...plot.map((p) => p.median))))}/sq ft` : ""}.</> : "No prices found in project documents yet."} {gaps[0] ? `Strongest white space: ${gaps[0].name}.` : ""}</p>
    <div className={css.bars} role="list" aria-label="Apartment price per sq ft by market">
      {apt.slice(0, 12).map((p) => { const m = byKey.get(p.key); return <button key={p.key} type="button" role="listitem" disabled={!m} onClick={() => m && onMarket(m)} title={`${p.name}: median ₹${n(Math.round(p.median))}/sq ft from ${plural(p.projects, "project")}`}>
        <span>{p.name}</span><i><em style={{ width: `${(p.median / topPrice) * 100}%` }} /></i><b>₹{n(Math.round(p.median))}</b></button>; })}
    </div>
  </>;
  return (
    <Layout wide={wide} summary={summary} label="Market view" view={view} setView={setView}
      views={[{ key: "prices", label: "Prices" }, { key: "gaps", label: "White space" }, { key: "launches", label: "Launches" }]}
      how={view === "gaps" ? "Demand Pulse can see: projects EA worked on or holds documents for in a market, invoiced revenue in markets within 6 km (nearer counts more) and the price its projects quote. White space has none of the company's invoices in the last twelve months. A market seen once is a lead, not a trend."
        : view === "launches" ? "Engagements started in the last twelve months of the data, by market: the launches EA marketed. No outside launch register (such as MahaRERA's) is connected."
        : "Median price per sq ft written in the documents of the market's own projects (research notes, brochures, scripts), apartments and plots apart. High confidence needs three projects quoting; one project's figure is that project's."}>
      {view === "prices" || view === "summary" ? <List resetKey="prices" items={prices} unit="prices" columns={wide} keyOf={(p) => `${p.key}|${p.kind}`} empty={<Note icon={IndianRupee} title="No prices yet">Prices appear when project documents quote ₹ per sq ft.</Note>} render={(p) => { const m = byKey.get(p.key); return (
        <button type="button" className={css.fact} disabled={!m} onClick={() => m && onMarket(m)}><b>{p.name}: ₹{n(Math.round(p.median))}/sq ft{p.kind !== "apartment" ? ` · ${p.kind}` : ""}</b>
          <small>{p.low !== p.high ? `₹${n(p.low)}–${n(p.high)} · ` : ""}{plural(p.n, "price")} in the documents of {plural(p.projects, "project")} <Chip c={p.confidence} /></small></button>); }} /> : null}
      {view === "gaps" ? <List resetKey="gaps" items={gaps} unit="markets" columns={wide} keyOf={(g) => g.key} empty={<Note icon={Radar} title="No white space found">Every market with demand has a paying client this year.</Note>} render={(g) => { const m = byKey.get(g.key); return (
        <button type="button" className={css.fact} disabled={!m} onClick={() => m && onMarket(m)} title={g.why}><b>{g.name}{g.city !== "Pune" ? `, ${g.city}` : ""}</b><small>{g.why} <Chip c={g.confidence} /></small></button>); }} /> : null}
      {view === "launches" ? <List resetKey="launches" items={launches} unit="markets" columns={wide} keyOf={(m) => m.key} render={(m) => (
        <button type="button" className={css.rank} onClick={() => onMarket(m)}><span className={css.rankText}><b>{m.name}</b><small>{m.city} · {m.last ? `latest ${monthShort(m.last)}` : ""}</small></span><span className={css.rankValue}>{m.recent}</span></button>)} /> : null}
    </Layout>
  );
}

// --------------------------------------------------------------------------------------------------------- Shoots
export function ShootsPanel({ data, rows, wide, picked, start, setStart, stops, setStops, route, onSelect }: {
  data: MapData; rows: Row[]; wide: boolean; picked: Row | undefined; start: Stop | null; setStart: (s: Stop | null) => void;
  stops: Stop[]; setStops: (s: Stop[]) => void; route: Route | null; onSelect: (id: string) => void;
}) {
  const [view, setView] = useState<"summary" | "plan" | "places" | "models">("plan");
  const shoots = data.shoots ?? [];
  const since = shoots.map((s) => s.day ?? `${s.month}-01`).sort()[0];
  const from90 = new Date(Date.parse(data.generatedAt) - 90 * 864e5).toISOString().slice(0, 10);
  const recent = shoots.filter((s) => s.day && s.day >= from90);
  const placeCount = new Map<string, number>();
  for (const s of shoots) if (s.place) { const k = s.place.trim().toLowerCase(); placeCount.set(k, (placeCount.get(k) ?? 0) + 1); }
  const places = [...placeCount.entries()].sort((a, b) => b[1] - a[1]);
  const byModel = new Map<string, { name: string; id: string | null; n: number; last: string | null }>();
  for (const s of shoots) { const k = s.personId ?? s.model ?? "?"; const m = byModel.get(k) ?? { name: s.model ?? "Not linked to a model", id: s.personId, n: 0, last: null }; m.n += 1; if (s.day && (!m.last || s.day > m.last)) m.last = s.day; byModel.set(k, m); }
  const models = [...byModel.values()].sort((a, b) => b.n - a.n);
  const offices = (data.office ?? []).map((o, i) => ({ id: `office${i}`, name: o.name, lat: o.lat, lng: o.lng }));
  const add = (r: Row) => { if (r.loc.lat === null || r.loc.lng === null || stops.some((s) => s.id === r.loc.id)) return; setStops([...stops, { id: r.loc.id, name: r.name, lat: r.loc.lat, lng: r.loc.lng }]); };
  const summary = <div className={css.stats}>
    <Stat label="Shoot days" value={n(shoots.length)} note={since ? `since ${monthShort(since.slice(0, 7))}` : "none yet"} title="Shoot lines from the shoot coordinator's sheets (one model on one day)." />
    <Stat label="Last 90 days" value={n(recent.length)} note={plural(new Set(recent.map((s) => s.personId).filter(Boolean)).size, "model")} />
    <Stat label="On the map" value={pct(shoots.filter((s) => s.lat !== null).length, shoots.length)} note="placed at a locality or project" />
  </div>;
  return (
    <Layout wide={wide} summary={summary} label="Shoots view" view={view} setView={setView}
      views={[{ key: "plan", label: "Plan a day", count: stops.length || undefined }, { key: "places", label: "Places" }, { key: "models", label: "Models" }]}
      how={view === "plan" ? "Choose the projects to shoot: Pulse orders them nearest first from the start and untangles crossings. Times are estimates (straight line × 1.35 for roads, 22 km/h in the city, 40 km/h beyond); check the real route before you leave." : "Shoot places as the coordinator wrote them; a shoot is drawn at its locality when Pulse knows it, else at its project. Model ads for projects elsewhere are often shot around Pune, so a shoot's place is not the project's site."}>
      {view === "plan" || view === "summary" ? <div className={css.planner}>
        <div className={css.plannerHead}>
          <label>Start <SelectField value={start?.id ?? "first"} onChange={(e) => { const o = offices.find((x) => x.id === e.target.value); setStart(o ?? (e.target.value === "first" ? null : start)); }} aria-label="Where the day starts">
            {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}<option value="first">The first stop</option></SelectField></label>
          <button type="button" className={css.fixBtn} disabled={!picked || picked.loc.lat === null || stops.some((s) => s.id === picked?.loc.id)} onClick={() => picked && add(picked)} title={picked ? `Add ${picked.name}` : "Choose a project on the map first"}><Plus size={14} aria-hidden="true" />{picked ? `Add ${picked.name}` : "Choose a project to add"}</button>
        </div>
        {stops.length ? <ol className={css.routeList}>
          {(route?.order ?? stops).map((s, i) => <li key={s.id}><b>{i + 1}</b><button type="button" className={css.textButton} onClick={() => onSelect(s.id)}>{s.name}</button>
            <small>{route?.legs[i] ? `${route.legs[i].km.toFixed(1)} km · ~${route.legs[i].minutes} min` : ""}</small>
            <button type="button" className={css.iconButton} aria-label={`Remove ${s.name}`} onClick={() => setStops(stops.filter((x) => x.id !== s.id))}><X size={16} /></button></li>)}
        </ol> : <Note icon={RouteIcon} title="No stops yet">Choose a project on the map, then add it. Search finds projects by name or place.</Note>}
        {route && route.order.length ? <p className={css.lead}><b>{route.km.toFixed(1)} km, about {Math.floor(route.minutes / 60) ? `${Math.floor(route.minutes / 60)} h ` : ""}{route.minutes % 60} min of driving</b> {route.start ? `from ${route.start.name}` : "from the first stop"}, estimated. {stops.length > 1 ? <button type="button" className={css.textButton} onClick={() => setStops([])}>Clear</button> : null}</p> : null}
        {!offices.length ? <p className={css.hintText}>No office is set in check-in settings, so the day starts at the first stop. HR adds the office under HR → Check-in.</p> : null}
        <SuggestedStops rows={rows} stops={stops} add={add} />
      </div> : null}
      {view === "places" ? <List resetKey="shoot-places" items={places} unit="places" columns={wide} keyOf={([k]) => k} render={([k, v]) => <div className={css.rank} data-static=""><span className={css.rankText}><b>{k.replace(/\b\w/g, (c) => c.toUpperCase())}</b></span><span className={css.rankValue}>{v}</span></div>} /> : null}
      {view === "models" ? <List resetKey="shoot-models" items={models} unit="models" columns={wide} keyOf={(m) => m.id ?? m.name} render={(m) => (
        <div className={css.rank} data-static=""><span className={css.rankText}>{m.id ? <Link href={`/contacts/${m.id}`}><b>{m.name}</b></Link> : <b>{m.name}</b>}<small>{m.last ? `last shoot ${m.last}` : ""}</small></span><span className={css.rankValue}>{m.n}</span></div>)} /> : null}
    </Layout>
  );
}

/** Projects that are delivering or new have shoots coming; offered as stops, nearest to the current route first. */
function SuggestedStops({ rows, stops, add }: { rows: Row[]; stops: Stop[]; add: (r: Row) => void }) {
  const list = rows.filter((r) => r.loc.lat !== null && !stops.some((s) => s.id === r.loc.id) && r.engagements.some((e) => e.stage === "new" || e.stage === "delivering")).slice(0, 30);
  if (!list.length) return null;
  return <details className={css.suggest}><summary>Projects starting or delivering now ({list.length})</summary><ul>{list.map((r) => <li key={r.loc.id}><button type="button" className={css.textButton} onClick={() => add(r)}><Plus size={14} aria-hidden="true" />{r.name}<small>{r.loc.locality ?? r.loc.city}</small></button></li>)}</ul></details>;
}

// ------------------------------------------------------------------------------------------- Places to check (review)
export function ReviewPanel({ wide, version, onFly, onDone }: { wide: boolean; version: number; onFly: (lat: number, lng: number) => void; onDone: () => Promise<void> }) {
  const [state, setState] = useState<{ items: ReviewItem[]; canEdit: boolean } | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/v0/map/review", { cache: "no-store", signal: controller.signal }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setState(d); }).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [version]);
  const check = async () => { setBusy(true); try { await post("/api/v0/map/review/check", {}); await onDone(); } catch (e) { setError(e instanceof Error ? e.message : "Could not check"); } finally { setBusy(false); } };
  if (error) return <p className={css.error} role="alert">{error}</p>;
  if (!state) return <div className={css.skeleton} role="status" aria-label="Loading places to check"><i /><i /><i /></div>;
  return <div className={css.reviewPane}>
    <p className={css.lead}><b>{plural(state.items.length, "place")} to check.</b> Micro-market centres first: moving one moves every project placed at it. <button type="button" className={css.textButton} disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check again"}</button></p>
    <List resetKey={`review${version}`} items={state.items} unit="places" columns={wide} keyOf={(x) => x.id} empty={<Note icon={Check} title="Nothing to check">Every place agrees with its folders and documents.</Note>} render={(item) => <ReviewRow item={item} canEdit={state.canEdit} onFly={onFly} onDone={onDone} />} />
  </div>;
}

function ReviewRow({ item, canEdit, onFly, onDone }: { item: ReviewItem; canEdit: boolean; onFly: (lat: number, lng: number) => void; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const p = item.proposed, from = item.evidence.from;
  const decide = async (action: "accept" | "keep", at?: { lat: number; lng: number }) => {
    setBusy(true); setError("");
    try { await post(`/api/v0/map/review/${item.id}`, { action, ...(at ?? {}) }); await onDone(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  };
  const typed = parseCoordinates(text);
  const search = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.search)}`;
  // One line each until opened, so the list shows many places; opening one shows why and how to fix it.
  return <div className={css.reviewItem} data-open={open ? "" : undefined}>
    <div className={css.cover}>
      <button type="button" className={css.coverText} aria-expanded={open} onClick={() => { setOpen(!open); if (!open && from.lat !== null && from.lng !== null) onFly(from.lat, from.lng); }} title={item.evidence.why}>
        <b>{item.title}</b><small>{p.rule === "locality_centre" ? `${p.projects} ${p.projects === 1 ? "project" : "projects"} at this centre` : p.place ? `Proposed: ${p.place}` : "Needs a point"}</small></button>
      {canEdit && p.lat !== null && p.lng !== null ? <button type="button" className={css.fixBtn} disabled={busy} onClick={() => void decide("accept")} title={item.evidence.why}><Crosshair size={14} aria-hidden="true" />Move</button> : null}
    </div>
    {open ? <>
      <p className={css.hintText}>{item.evidence.why}</p>
      {canEdit ? <div className={css.partyActions}>
        <input aria-label={`Location for ${p.name ?? item.title}`} placeholder="Paste coordinates or a Maps link" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" className={css.fixBtn} disabled={busy || !typed} onClick={() => typed && void decide("accept", typed)}>Save point</button>
        <a className={css.textButton} href={search} target="_blank" rel="noreferrer">Find on Maps <ExternalLink size={13} aria-hidden="true" /></a>
        <button type="button" className={css.textButton} disabled={busy} onClick={() => void decide("keep")}>Keep</button>
      </div> : null}
    </> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </div>;
}
