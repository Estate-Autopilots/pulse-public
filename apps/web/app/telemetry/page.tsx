// TELEMETRY (owner, 24 Oct 2026): where Pulse is slow, for whom and since which version. Leadership and admins only
// (the API refuses everyone else). Every movement comes from the collector (lib/telemetry.mjs) and the API's own timing.
import Link from "next/link";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { Columns } from "../charts";
import { Badge, Kpi, Message, Page, PageHeader, Panel, QueryTabs, Tiles, styles } from "../ui";

type Pct = { n: number; p50: number | null; p75: number | null; p95: number | null };
type Overview = {
  days: number; platform: string | null; zone: string;
  totals: { events: number; sessions: number; people: number; views: number; actions: number; apiCalls: number; errors: number; viewP75: number | null; actionP75: number | null; serverP75: number | null };
  pages: (Pct & { name: string; kind: string })[];
  actions: (Pct & { page: string | null; name: string | null; kind: string })[];
  server: (Pct & { name: string; dbP50: number | null; errors: number })[];
  client: (Pct & { name: string; errors: number; bytes: number | null })[];
  vitals: (Pct & { kind: string; valueP75: number | null })[];
  longTasks: { page: string | null; n: number; total: number; max: number }[];
  errors: { kind: string; name: string; page: string | null; n: number; last: string }[];
  people: { personId: string; name: string | null; role: string | null; events: number; sessions: number; views: number; actions: number; errors: number; actionP75: number | null; last: string }[];
  roles: { role: string; people: number; sessions: number; events: number; viewP75: number | null; actionP75: number | null; apiP75: number | null }[];
  sessions: { id: string; name: string | null; role: string | null; platform: string | null; version: string | null; start: string; end: string; events: number; errors: number }[];
  trend: { day: string; events: number | null; errors: number | null; people: number | null; routeP75: number | null; loadP75: number | null; clickP75: number | null; apiP75: number | null; serverP75: number | null }[];
  versions: { version: string; platform: string; events: number; errors: number; first: string; last: string; routeP75: number | null; clickP75: number | null; apiP75: number | null; serverP75: number | null }[];
};
/** PERF: the slowest things in the last 24 hours, beside the 24 before. */
type Before = { nBefore: number; p50Before: number | null; p95Before: number | null };
type Slowest = { platform: string | null; network: { n: number; p50: number | null; p95: number | null };
  connections: { n: number; cold: number; coldP50: number | null; warmP50: number | null };
  edges: { colo: string; n: number; p50: number | null; p95: number | null; people: number }[];
  pages: ({ name: string; kind: string; n: number; p50: number | null; p95: number | null } & Before)[];
  api: ({ name: string; n: number; p50: number | null; p95: number | null; dbP50: number | null; queries: number | null; errors: number; totalMs: number;
    browserP50: number | null; browserP95: number | null; netP50: number | null } & Before)[];
  moments: { at: string; kind: string; name: string | null; page: string | null; durationMs: number; sessionId: string | null; platform: string | null; pending: string | null; wait: string | null; cut: string | null; api: number | null }[];
  renders: { name: string; n: number; ttfbP50: number | null; ttfbP95: number | null; callsP50: number | null; apiP50: number | null; readyP50: number | null }[] };
type Timeline = { id: string; zone: string; who: { name: string | null; role: string | null; start: string; end: string } | null;
  events: { id: string; at: string; kind: string; name: string | null; page: string | null; durationMs: number | null; value: number | null; status: number | null; requestId: string | null;
    platform: string | null; version: string | null; detail: Record<string, unknown> | null; serverMs: number | null; dbMs: number | null; serverRoute: string | null }[] };

const VIEWS = [{ key: "overview", label: "Overview" }, { key: "slowest", label: "Slowest" }, { key: "pages", label: "Pages & actions" }, { key: "api", label: "API" }, { key: "errors", label: "Errors" },
  { key: "people", label: "People & roles" }, { key: "sessions", label: "Sessions" }, { key: "trends", label: "Trends & versions" }];
const KIND: Record<string, string> = { "nav.load": "Page load", "nav.route": "Route change", "ui.click": "Click", "ui.submit": "Submit", "ui.key": "Shortcut",
  "vital.lcp": "LCP", "vital.inp": "INP", "vital.cls": "CLS", "vital.ttfb": "TTFB", "vital.fcp": "FCP", "error.js": "JS error", "error.promise": "Unhandled rejection",
  "error.boundary": "Screen error", "error.resource": "Missing file", api: "API call", "api.server": "API (server)" };

/** 320 ms, 1.4 s, 2 min; a dash for nothing measured. */
function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.round(ms / 60_000)} min`;
}
const tone = (ms: number | null | undefined, good: number, poor: number) => ms === null || ms === undefined ? undefined : ms <= good ? "success" as const : ms <= poor ? "warning" as const : "danger" as const;
const when = (iso: string, zone: string, seconds = false) => new Intl.DateTimeFormat("en-IN", { timeZone: zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false }).format(new Date(iso));

function Table({ head, rows, label, empty = "Nothing recorded in this period yet." }: { head: { label: string; right?: boolean }[]; rows: ReactNode[][]; label: string; empty?: string }) {
  if (!rows.length) return <p className={styles.chartEmpty}>{empty}</p>;
  return <div className={styles.tableWrap}><table className={`${styles.table} ${styles.tableDense}`} aria-label={label}>
    <thead><tr>{head.map((h) => <th key={h.label} className={h.right ? styles.right : undefined}>{h.label}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={head[j]?.right ? styles.right : undefined}>{c}</td>)}</tr>)}</tbody>
  </table></div>;
}
const pctCells = (r: Pct) => [r.n, dur(r.p50), <b key="p75">{dur(r.p75)}</b>, dur(r.p95)];
const PCT_HEAD = [{ label: "Count", right: true }, { label: "p50", right: true }, { label: "p75", right: true }, { label: "p95", right: true }];
const mono = (s: string | null | undefined) => <span className={styles.mono}>{s || "–"}</span>;

export default async function Telemetry({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  if (q.session) return <SessionTimeline id={q.session} days={q.days} />;
  const days = ["1", "7", "30"].includes(q.days ?? "") ? q.days! : "7";
  const platform = ["web", "android", "ios", "desktop"].includes(q.platform ?? "") ? q.platform! : "";
  const view = VIEWS.some((v) => v.key === q.view) ? q.view! : "overview";
  const [r, slow] = await Promise.all([api<Overview>(`telemetry?${new URLSearchParams({ days, ...(platform ? { platform } : {}) })}`),
    view === "slowest" ? api<Slowest>(`telemetry/slowest${platform ? `?platform=${platform}` : ""}`) : null]);
  if (r.error) return <Message text={r.error} />;
  const d = r.data;
  if (!d) return null;
  const keep = (without: string) => [without !== "view" && view !== "overview" ? `view=${view}` : "", without !== "days" && days !== "7" ? `days=${days}` : "", without !== "platform" && platform ? `platform=${platform}` : ""].filter(Boolean).join("&");
  const t = d.totals;
  const sessionHref = (id: string) => `/telemetry?session=${encodeURIComponent(id)}${days !== "7" ? `&days=${days}` : ""}`;

  const pages = <Panel title="Slowest pages" sub="From the click (or navigation start) until the screen settled">
    <Table label="Slowest pages" head={[{ label: "Page" }, { label: "How" }, ...PCT_HEAD]} rows={d.pages.map((p) => [mono(p.name), KIND[p.kind] ?? p.kind, ...pctCells(p)])} /></Panel>;
  const actions = <Panel title="Slowest interactions" sub="Click, tap or submit until the screen settled">
    <Table label="Slowest interactions" head={[{ label: "Element" }, { label: "Page" }, ...PCT_HEAD]} rows={d.actions.map((a) => [mono(a.name), mono(a.page), ...pctCells(a)])} /></Panel>;
  const server = <Panel title="Slowest API routes" sub="The API's own time, with its database time (AI co-workers' polling: 1 in 50 kept)">
    <Table label="Slowest API routes" head={[{ label: "Route" }, ...PCT_HEAD, { label: "DB p50", right: true }, { label: "5xx", right: true }]}
      rows={d.server.map((s) => [mono(s.name), ...pctCells(s), dur(s.dbP50), s.errors || "–"])} /></Panel>;
  const client = <Panel title="API calls as people waited" sub="In the browser or phone, through the web server">
    <Table label="API calls as people waited" head={[{ label: "Call" }, ...PCT_HEAD, { label: "Failed", right: true }, { label: "Size", right: true }]}
      rows={d.client.map((c) => [mono(c.name), ...pctCells(c), c.errors || "–", c.bytes ? `${Math.round(c.bytes / 102.4) / 10} KB` : "–"])} /></Panel>;
  const errors = <Panel title="Errors" sub="Script errors, screens that failed, failed and 5xx API calls">
    <Table label="Errors" empty="No errors in this period." head={[{ label: "What" }, { label: "Message or route" }, { label: "Page" }, { label: "Count", right: true }, { label: "Last" }]}
      rows={d.errors.map((e) => [KIND[e.kind] ?? e.kind, mono(e.name), mono(e.page), e.n, when(e.last, d.zone)])} /></Panel>;
  const vitals = <Panel title="Web vitals" sub="p75 across page views (good · needs work · poor)">
    <Table label="Web vitals" head={[{ label: "Measure" }, { label: "Count", right: true }, { label: "p75", right: true }, { label: "" }]}
      rows={d.vitals.map((v) => {
        const cls = v.kind === "vital.cls";
        const [good, poor] = { "vital.lcp": [2500, 4000], "vital.inp": [200, 500], "vital.ttfb": [800, 1800], "vital.fcp": [1800, 3000] }[v.kind] ?? [0, 0];
        const state = cls ? (v.valueP75 ?? 0) <= 0.1 ? "success" : (v.valueP75 ?? 0) <= 0.25 ? "warning" : "danger" : tone(v.p75, good, poor);
        return [KIND[v.kind] ?? v.kind, v.n, cls ? (v.valueP75 ?? 0).toFixed(3) : dur(v.p75), state ? <Badge tone={state}>{state === "success" ? "Good" : state === "warning" ? "Needs work" : "Poor"}</Badge> : null];
      })} /></Panel>;
  const trendChart = <Panel title="Route changes by day" sub={`p75, ${d.zone}; updated hourly`}>
    <Columns label="Route change p75 by day" suffix=" ms" items={d.trend.map((x) => ({ key: x.day, label: x.day.slice(5), value: x.routeP75 ?? 0, tip: dur(x.routeP75), tipSub: `${x.day} · ${x.events ?? 0} events · ${x.errors ?? 0} errors` }))} /></Panel>;

  return (
    <Page>
      <PageHeader title="Telemetry" context={["Every page, click and API call, timed", days === "1" ? "Last 24 hours" : `Last ${days} days`, platform || "All platforms"]} />
      <QueryTabs base="/telemetry" param="view" current={view} keep={keep("view")} items={VIEWS} />
      <QueryTabs base="/telemetry" param="days" current={days} keep={keep("days")} sub label="Period" items={[{ key: "7", label: "7 days" }, { key: "1", label: "24 hours" }, { key: "30", label: "30 days" }]} />
      <QueryTabs base="/telemetry" param="platform" current={platform || "all"} keep={keep("platform")} sub label="Platform" items={[{ key: "all", label: "All" }, { key: "web", label: "Web" }, { key: "android", label: "Android" }, { key: "ios", label: "iPhone" }, { key: "desktop", label: "Desktop" }]} />
      {view === "overview" ? <>
        <Tiles count={6} dense>
          <Kpi label="Sessions" value={t.sessions} note={`${t.people} people`} />
          <Kpi label="Page views" value={t.views} note={`p75 ${dur(t.viewP75)}`} tone={tone(t.viewP75, 1000, 3000)} />
          <Kpi label="Actions" value={t.actions} note={`p75 ${dur(t.actionP75)}`} tone={tone(t.actionP75, 300, 1000)} />
          <Kpi label="API calls" value={t.apiCalls} note={`server p75 ${dur(t.serverP75)}`} tone={tone(t.serverP75, 200, 800)} />
          <Kpi label="Errors" value={t.errors} note={t.actions ? `${Math.round((t.errors / Math.max(1, t.actions + t.views)) * 1000) / 10}% of views and actions` : "–"} tone={t.errors ? "warning" : "success"} />
          <Kpi label="Events" value={t.events} note="Everything recorded" />
        </Tiles>
        {trendChart}{pages}{actions}{server}{errors}{vitals}
      </> : null}
      {view === "pages" ? <>{pages}{actions}
        <Panel title="Long tasks" sub="Main-thread work over 50 ms that blocked taps and scrolling">
          <Table label="Long tasks" head={[{ label: "Page" }, { label: "Count", right: true }, { label: "Total", right: true }, { label: "Longest", right: true }]}
            rows={d.longTasks.map((l) => [mono(l.page), l.n, dur(l.total), dur(l.max)])} /></Panel>{vitals}</> : null}
      {view === "slowest" ? slow?.error ? <Message text={slow.error} /> : slow?.data ? <SlowestView s={slow.data} sessionHref={sessionHref} zone={d.zone} /> : null : null}
      {view === "api" ? <>{server}{client}</> : null}
      {view === "errors" ? errors : null}
      {view === "people" ? <>
        <Panel title="People" sub="Activity and how long their actions took">
          <Table label="People" head={[{ label: "Person" }, { label: "Role" }, { label: "Sessions", right: true }, { label: "Views", right: true }, { label: "Actions", right: true }, { label: "Action p75", right: true }, { label: "Errors", right: true }, { label: "Last seen" }]}
            rows={d.people.map((p) => [p.personId ? <Link key="p" className={styles.cellLink} href={`/people/${p.personId}`}>{p.name ?? "Person"}</Link> : "–", p.role ?? "–", p.sessions, p.views, p.actions, dur(p.actionP75), p.errors || "–", when(p.last, d.zone)])} /></Panel>
        <Panel title="Roles" sub="p75 by role">
          <Table label="Roles" head={[{ label: "Role" }, { label: "People", right: true }, { label: "Sessions", right: true }, { label: "Events", right: true }, { label: "Page p75", right: true }, { label: "Action p75", right: true }, { label: "API p75", right: true }]}
            rows={d.roles.map((r) => [r.role, r.people, r.sessions, r.events, dur(r.viewP75), dur(r.actionP75), dur(r.apiP75)])} /></Panel>
      </> : null}
      {view === "sessions" ? <Panel title="Recent sessions" sub="Open one for its timeline: every route, click and API call in order">
        <Table label="Recent sessions" head={[{ label: "Session" }, { label: "Person" }, { label: "Role" }, { label: "Platform" }, { label: "Version" }, { label: "Started" }, { label: "Length", right: true }, { label: "Events", right: true }, { label: "Errors", right: true }]}
          rows={d.sessions.map((s) => [<Link key="s" className={styles.cellLink} href={sessionHref(s.id)}>{s.id.slice(0, 8)}</Link>, s.name ?? "–", s.role ?? "–", s.platform ?? "–", mono(s.version), when(s.start, d.zone),
            dur(Date.parse(s.end) - Date.parse(s.start)), s.events, s.errors || "–"])} /></Panel> : null}
      {view === "trends" ? <>{trendChart}
        <Panel title="By day" sub="p75 per day (rollups, updated hourly)">
          <Table label="By day" head={[{ label: "Day" }, { label: "People", right: true }, { label: "Events", right: true }, { label: "Errors", right: true }, { label: "Load", right: true }, { label: "Route", right: true }, { label: "Click", right: true }, { label: "API (browser)", right: true }, { label: "API (server)", right: true }]}
            rows={[...d.trend].reverse().map((x) => [x.day, x.people ?? "–", x.events ?? "–", x.errors ?? "–", dur(x.loadP75), dur(x.routeP75), dur(x.clickP75), dur(x.apiP75), dur(x.serverP75)])} /></Panel>
        <Panel title="By app version" sub="Each release and platform, p75">
          <Table label="By app version" head={[{ label: "Version" }, { label: "Platform" }, { label: "Days" }, { label: "Events", right: true }, { label: "Errors", right: true }, { label: "Route", right: true }, { label: "Click", right: true }, { label: "API (browser)", right: true }, { label: "API (server)", right: true }]}
            rows={d.versions.map((v) => [mono(v.version), v.platform, v.first === v.last ? v.first : `${v.first} – ${v.last}`, v.events, v.errors || "–", dur(v.routeP75), dur(v.clickP75), dur(v.apiP75), dur(v.serverP75)])} /></Panel>
      </> : null}
    </Page>
  );
}

async function SessionTimeline({ id, days }: { id: string; days?: string }) {
  const r = await api<Timeline>(`telemetry/sessions/${encodeURIComponent(id)}`);
  if (r.error) return <Message text={r.error} />;
  const d = r.data;
  if (!d) return null;
  const first = d.events[0] ? Date.parse(d.events[0].at) : 0;
  return (
    <Page>
      <PageHeader title="Session timeline" back={{ href: `/telemetry?view=sessions${days && days !== "7" ? `&days=${days}` : ""}`, label: "Sessions" }}
        context={[d.who?.name ?? "Unknown person", d.who?.role ?? "", `${d.events.length} events`, d.events[0] ? `${d.events[0].platform ?? ""} ${d.events[0].version ?? ""}`.trim() : ""]} />
      <Panel title="Every movement, in order" sub="API calls show the API's own time and database time beside the browser's">
        <Table label="Session timeline" empty="Nothing recorded for this session."
          head={[{ label: "Time" }, { label: "+s", right: true }, { label: "What" }, { label: "Name" }, { label: "Page" }, { label: "Took", right: true }, { label: "Status", right: true }, { label: "Server", right: true }, { label: "DB", right: true }]}
          rows={d.events.map((e) => [when(e.at, d.zone, true), ((Date.parse(e.at) - first) / 1000).toFixed(1), KIND[e.kind] ?? e.kind, mono(e.name), mono(e.page),
            e.kind === "vital.cls" ? (e.value ?? 0).toFixed(3) : dur(e.durationMs), e.status ?? "–", dur(e.serverMs), dur(e.dbMs)])} />
      </Panel>
    </Page>
  );
}

/** PERF: a p95 beside the day before: faster in green, slower in red (changes under 10% or 20 ms stay plain). */
function Change({ now, before }: { now: number | null; before: number | null }) {
  if (now === null || before === null || before === 0) return <span>{before === null ? "new" : "–"}</span>;
  const diff = now - before, pct = Math.round((diff / before) * 100);
  if (Math.abs(diff) < 20 || Math.abs(pct) < 10) return <span>{dur(before)}</span>;
  return <Badge tone={diff < 0 ? "success" : "danger"}>{`${dur(before)} → ${pct > 0 ? "+" : ""}${pct}%`}</Badge>;
}

function SlowestView({ s, sessionHref, zone }: { s: Slowest; sessionHref: (id: string) => string; zone: string }) {
  const totalApi = s.api.reduce((sum, a) => sum + a.totalMs, 0) || 1;
  return <>
    <Tiles count={4} dense>
      <Kpi label="Network + web server" value={dur(s.network.p50)} note={`p50 per API call, p95 ${dur(s.network.p95)} (${s.network.n} joined)`} tone={tone(s.network.p50, 100, 300)} />
      <Kpi label="New database connections" value={`${s.connections.n ? Math.round((s.connections.cold / s.connections.n) * 1000) / 10 : 0}%`}
        note={`of API requests; p50 ${dur(s.connections.coldP50)} against ${dur(s.connections.warmP50)} warm`} tone={s.connections.n && s.connections.cold / s.connections.n > 0.05 ? "warning" : "success"} />
      <Kpi label="Slowest page p95" value={dur(s.pages[0]?.p95)} note={s.pages[0]?.name ?? "–"} tone={tone(s.pages[0]?.p95, 1000, 3000)} />
      <Kpi label="Slowest API p95" value={dur(s.api[0]?.p95)} note={s.api[0]?.name ?? "–"} tone={tone(s.api[0]?.p95, 200, 800)} />
    </Tiles>
    <Panel title="Pages by p95" sub="Last 24 hours, beside the 24 hours before (until the screen settled)">
      <Table label="Pages by p95" head={[{ label: "Page" }, { label: "How" }, { label: "Count", right: true }, { label: "p50", right: true }, { label: "p95", right: true }, { label: "Day before p95", right: true }]}
        rows={s.pages.map((p) => [mono(p.name), KIND[p.kind] ?? p.kind, p.n, dur(p.p50), <b key="p95">{dur(p.p95)}</b>, <Change key="c" now={p.p95} before={p.p95Before} />])} /></Panel>
    <Panel title="API routes by p95" sub="The API's own time; the browser's wait for the same calls (joined by request id); the share of all API time">
      <Table label="API routes by p95" head={[{ label: "Route" }, { label: "Count", right: true }, { label: "p50", right: true }, { label: "p95", right: true }, { label: "Day before p95", right: true },
        { label: "DB p50", right: true }, { label: "Queries", right: true }, { label: "Browser p50", right: true }, { label: "Share", right: true }]}
        rows={s.api.map((a) => [mono(a.name), a.n, dur(a.p50), <b key="p95">{dur(a.p95)}</b>, <Change key="c" now={a.p95} before={a.p95Before} />, dur(a.dbP50), a.queries ?? "–",
          dur(a.browserP50), `${Math.round((a.totalMs / totalApi) * 100)}%`])} /></Panel>
    <Panel title="Page first byte" sub="A page load's time to first byte beside the API calls its server render made">
      <Table label="Page first byte" empty="No page loads carried a request id yet."
        head={[{ label: "Page" }, { label: "Loads", right: true }, { label: "TTFB p50", right: true }, { label: "TTFB p95", right: true }, { label: "Render API calls", right: true }, { label: "Render API time", right: true }, { label: "Ready p50", right: true }]}
        rows={s.renders.map((x) => [mono(x.name), x.n, dur(x.ttfbP50), dur(x.ttfbP95), x.callsP50 ?? "–", dur(x.apiP50), dur(x.readyP50)])} /></Panel>
    <Panel title="Network to Cloudflare" sub="Last 7 days: the Cloudflare location each session reached and the round trip to it alone (never reaching Pulse)">
      <Table label="Network to Cloudflare" empty="No session measured its edge yet."
        head={[{ label: "Location" }, { label: "Sessions", right: true }, { label: "People", right: true }, { label: "Round trip p50", right: true }, { label: "p95", right: true }]}
        rows={s.edges.map((e) => [mono(e.colo), e.n, e.people, dur(e.p50), dur(e.p95)])} /></Panel>
    <Panel title="Slowest single movements" sub="Last 24 hours; what each one was still waiting for when it was cut short">
      <Table label="Slowest single movements" head={[{ label: "When" }, { label: "What" }, { label: "Name" }, { label: "Page" }, { label: "Took", right: true }, { label: "API calls", right: true }, { label: "Waiting on" }, { label: "Session" }]}
        rows={s.moments.map((m) => [when(m.at, zone, true), KIND[m.kind] ?? m.kind, mono(m.name), mono(m.page), <b key="d">{dur(m.durationMs)}</b>, m.api ?? "–",
          mono([m.cut, m.wait, m.pending].filter(Boolean).join(" · ") || null), m.sessionId ? <Link key="s" className={styles.cellLink} href={sessionHref(m.sessionId)}>{m.sessionId.slice(0, 8)}</Link> : "–"])} /></Panel>
  </>;
}
