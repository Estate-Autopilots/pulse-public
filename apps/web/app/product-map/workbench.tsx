"use client";
// PRODUCT-MAP (owner, 25 Oct 2026): the Product map. Connect an app (its code, a live visit with a test account, a
// manifest, Pulse telemetry, or a push from its build); see its screens, features, user types, journeys, issues and
// ideas; plan new journeys by picking screens; hand the plan to the build team and AI agents.
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Bot, Boxes, CircleAlert, Code2, Compass, Globe, LayoutGrid, Map as MapIcon, Play, Plus, Radio, RefreshCw, Route, Sparkles, Upload, Users } from "lucide-react";
import { Drawer, DrawerFooter, DrawerSection } from "../kit";
import { useSoonRefresh } from "../hq/client";
import hq from "../hq/hq.module.css";
import { ISSUE_KIND, ORIGIN, SOURCE_INFO, TABS, pmPost, when, type ListData, type MapData, type SourceKind, type Tab } from "./model";
import { BuildView, FeaturesView, IdeasView, IssuesView, ScreensView, UsersView } from "./views";
import { JourneysView } from "./journeys";
import css from "./pm.module.css";

export const tone = (t: string) => ({ "--tone": t }) as CSSProperties;
export function Err({ text }: { text: string | null }) {
  return text ? <p className={hq.draftNote} role="alert"><CircleAlert size={16} aria-hidden="true" /><span>{text}</span></p> : null;
}
export function Origin({ origin, confidence }: { origin: string; confidence?: number | null }) {
  return <span className={css.origin} data-origin={origin} title={confidence != null ? `${Math.round(confidence * 100)}% sure` : undefined}>
    {origin === "ai" ? <Sparkles size={11} aria-hidden="true" /> : null}{ORIGIN[origin] ?? origin}{confidence != null && origin !== "manual" ? ` · ${Math.round(confidence * 100)}%` : ""}</span>;
}

export function ProductMap({ list, data, tab: initialTab }: { list: ListData; data: MapData | null; tab: Tab }) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  const soon = useSoonRefresh(refresh);
  const [tab, setTabState] = useState<Tab>(initialTab);
  const [connect, setConnect] = useState<"new" | "add" | null>(null);
  const setTab = (t: Tab) => { setTabState(t); const u = new URL(window.location.href); u.searchParams.set("tab", t); window.history.replaceState(null, "", u.toString()); };
  const go = (id: string) => router.push(`/product-map?product=${id}`);
  const head = <header className={`${hq.pageHead} ${data ? css.headCompact : ""}`}>
    <div><h1>Product map</h1><p>Connect an app: Pulse lists its screens, tabs and buttons, finds who uses it and how, proposes their journeys, flags dead ends and missing links, and keeps the plan for the next version for your team and AI agents.</p></div>
    <div className={hq.headActions}>
      <button type="button" className={hq.primary} onClick={() => setConnect("new")}><Plus size={16} aria-hidden="true" />Connect an app</button>
    </div>
  </header>;
  if (!data) return <>
    {head}
    <section className={css.empty}>
      <MapIcon size={30} aria-hidden="true" /><h2>Map an app you are building</h2>
      <p>Pick how Pulse should read it. Several ways can work together: the code gives every screen and button, a live visit gives what people see, telemetry gives what they really do.</p>
      <div className={css.ways}>{(Object.keys(SOURCE_INFO) as SourceKind[]).map((k) => <div key={k} className={css.way}><SourceIcon kind={k} /><b>{SOURCE_INFO[k].label}</b><span>{SOURCE_INFO[k].what}</span></div>)}</div>
      <button type="button" className={hq.primary} onClick={() => setConnect("new")}><Plus size={16} aria-hidden="true" />Connect an app</button>
    </section>
    {connect ? <ConnectSheet list={list} product={null} onClose={() => setConnect(null)} onDone={(id) => { setConnect(null); go(id); }} /> : null}
  </>;
  const openIssues = data.issues.filter((i) => i.status === "open");
  const counts: Record<Tab, number | null> = { overview: null, screens: data.screens.filter((s) => s.status !== "removed").length, features: data.features.length, users: data.personas.length,
    journeys: data.journeys.length, issues: openIssues.length, ideas: data.ideas.filter((i) => i.status !== "shipped" && i.status !== "parked").length, build: null };
  return <>
    {head}
    {list.products.length > 1 ? <nav className={css.products} aria-label="Apps">{list.products.map((p) => <button key={p.id} type="button" aria-pressed={p.id === data.product.id} onClick={() => go(p.id)}>
      {p.name}{p.issues ? <small>{p.issues}</small> : null}</button>)}</nav> : null}
    <section className={css.productHead}>
      <div><h2>{data.product.name}</h2>{data.product.blurb ? <p>{data.product.blurb}</p> : null}</div>
      <span className={hq.headActions}><button type="button" className={hq.secondary} onClick={() => setConnect("add")}><Plus size={15} aria-hidden="true" />Add a source</button></span>
    </section>
    <div className={css.tabs} role="tablist" aria-label="Views">
      {TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>{t.label}{counts[t.key] != null ? <small>{counts[t.key]}</small> : null}</button>)}
    </div>
    <div role="tabpanel" aria-label={TABS.find((t) => t.key === tab)?.label} className={css.panel}>
      {tab === "overview" ? <Overview data={data} onTab={setTab} onSaved={soon} onAdd={() => setConnect("add")} /> : null}
      {tab === "screens" ? <ScreensView data={data} onSaved={soon} /> : null}
      {tab === "features" ? <FeaturesView data={data} onSaved={soon} /> : null}
      {tab === "users" ? <UsersView data={data} onSaved={soon} /> : null}
      {tab === "journeys" ? <JourneysView data={data} onSaved={soon} /> : null}
      {tab === "issues" ? <IssuesView data={data} onSaved={soon} /> : null}
      {tab === "ideas" ? <IdeasView data={data} onSaved={soon} /> : null}
      {tab === "build" ? <BuildView data={data} onSaved={soon} /> : null}
    </div>
    {connect ? <ConnectSheet list={list} product={connect === "add" ? data.product : null} onClose={() => setConnect(null)} onDone={(id) => { setConnect(null); if (id === data.product.id) refresh(); else go(id); }} /> : null}
  </>;
}

export function SourceIcon({ kind, size = 18 }: { kind: string; size?: number }) {
  const I = kind === "repo" ? Code2 : kind === "crawl" ? Globe : kind === "manifest" ? Boxes : kind === "telemetry" ? Radio : Upload;
  return <I size={size} aria-hidden="true" />;
}

function Overview({ data, onTab, onSaved, onAdd }: { data: MapData; onTab: (t: Tab) => void; onSaved: () => void; onAdd: () => void }) {
  const live = data.screens.filter((s) => s.status !== "removed");
  const open = data.issues.filter((i) => i.status === "open");
  const byKind = Object.entries(open.reduce<Record<string, number>>((m, i) => { m[i.kind] = (m[i.kind] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const high = open.filter((i) => i.severity === "high").length;
  const kpi = (label: string, value: ReactNode, sub: string, t: Tab, Icon: typeof Users) => <button type="button" className={`${hq.kpi} ${css.kpiBtn}`} onClick={() => onTab(t)}>
    <span className={hq.kpiLabel}><Icon size={14} aria-hidden="true" /> {label}</span><span className={hq.kpiValue}>{value}</span><span className={hq.kpiSub}>{sub}</span></button>;
  return <div className={css.stack}>
    <section className={css.kpis} aria-label="At a glance">
      {kpi("Screens", live.filter((s) => !s.proposed).length, `${data.elements.length} buttons, tabs, links and fields${live.some((s) => s.proposed) ? ` · ${live.filter((s) => s.proposed).length} proposed` : ""}`, "screens", LayoutGrid)}
      {kpi("User types", data.personas.length, data.personas.slice(0, 3).map((p) => p.name).join(", ") || "none yet", "users", Users)}
      {kpi("Journeys", data.journeys.length, `${data.journeys.filter((j) => j.status === "planned").length} planned · ${data.journeys.filter((j) => j.status === "discovered").length} seen in use`, "journeys", Route)}
      {kpi("Open issues", open.length, high ? `${high} high` : open.length ? "none high" : "nothing found", "issues", CircleAlert)}
    </section>
    <div className={css.two}>
      <section className={css.card} aria-label="Health">
        <div className={css.cardHead}><h3>Health</h3><button type="button" className={css.link} onClick={() => onTab("issues")}>All issues</button></div>
        {byKind.length ? <ul className={css.bars}>{byKind.map(([k, n]) => <li key={k}><span>{ISSUE_KIND[k] ?? k}</span><i style={{ width: `${Math.max(6, (n / Math.max(...byKind.map((x) => x[1]))) * 100)}%` }} /><b>{n}</b></li>)}</ul>
          : <p className={hq.faint}>No open issues. Connect a source or run the analysis again after changes.</p>}
      </section>
      <AiCard data={data} onSaved={onSaved} />
    </div>
    <section className={css.card} aria-label="Sources">
      <div className={css.cardHead}><h3>Sources</h3><button type="button" className={css.link} onClick={onAdd}>Add a source</button></div>
      <Sources data={data} onSaved={onSaved} />
    </section>
    {data.personas.length ? <section className={css.card} aria-label="User types">
      <div className={css.cardHead}><h3>Who uses it</h3><button type="button" className={css.link} onClick={() => onTab("users")}>All user types</button></div>
      <div className={css.miniPeople}>{data.personas.slice(0, 8).map((p) => <button key={p.id} type="button" onClick={() => onTab("users")}><b>{p.name}</b>
        <span>{[p.frequency, p.device, p.skillLevel && `${p.skillLevel} skill`, p.ageGroup && `age ${p.ageGroup}`].filter(Boolean).join(" · ") || "details to fill"}</span></button>)}</div>
    </section> : null}
  </div>;
}

export function Sources({ data, onSaved }: { data: MapData; onSaved: () => void }) {
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  const run = async (id: string) => { setBusy(id); setError(null); setNote(null);
    try { const r = await pmPost<{ status: string; error?: string; analysis?: { issues: number; journeys: number; personas: number } }>(`sources/${id}/run`);
      if (r.status === "failed") setError(r.error ?? "It failed"); else if (r.status === "queued") setNote("Started: the live visit takes a few minutes. This page shows the result when it is done.");
      else setNote(r.analysis ? `Done: ${r.analysis.personas} user types, ${r.analysis.journeys} proposed journeys, ${r.analysis.issues} issues found.` : "Done."); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "It failed"); } finally { setBusy(null); } };
  const remove = async (id: string) => { if (!window.confirm("Remove this source? What it found stays until another run.")) return; try { await pmPost(`sources/${id}/remove`); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "Not removed"); } };
  if (!data.sources.length) return <p className={hq.faint}>No sources yet.</p>;
  return <>
    <ul className={css.sources}>{data.sources.map((s) => { const r = s.lastResult ?? {};
      const said = typeof r.error === "string" ? r.error : s.kind === "repo" ? `${r.screens ?? 0} screens, ${r.elements ?? 0} elements, ${r.edges ?? 0} links${Array.isArray(r.framework) ? ` (${(r.framework as string[]).join(", ")})` : ""}`
        : s.kind === "telemetry" ? `${r.sessions ?? 0} sessions in ${r.days ?? 30} days, ${r.paths ?? 0} common paths` : s.kind === "crawl" ? `${r.pages ?? 0} pages visited${r.signedIn ? ", signed in" : ""}` : `${r.screens ?? 0} screens`;
      return <li key={s.id} data-status={s.status}>
        <span className={css.srcIcon}><SourceIcon kind={s.kind} /></span>
        <div><b>{s.label || SOURCE_INFO[s.kind]?.label}</b><span>{SOURCE_INFO[s.kind]?.label} · {s.status === "queued" || s.status === "running" ? "running…" : s.lastRunAt ? `last ${when(s.lastRunAt)}` : "not run yet"}{s.lastRunAt || r.error ? ` · ${said}` : ""}</span></div>
        <span className={css.rowActions}>{s.kind !== "push" ? <button type="button" className={hq.secondary} disabled={busy !== null} onClick={() => void run(s.id)}>{busy === s.id ? <RefreshCw size={15} className={css.spin} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}{busy === s.id ? "Running" : "Run"}</button> : null}
          {data.canRemove ? <button type="button" className={hq.ghost} onClick={() => void remove(s.id)}>Remove</button> : null}</span>
      </li>; })}</ul>
    {note ? <p className={css.ok} role="status">{note}</p> : null}<Err text={error} />
  </>;
}

function AiCard({ data, onSaved }: { data: MapData; onSaved: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  const last = data.aiJobs[0];
  const run = async () => { setBusy(true); setError(null);
    try { const r = await pmPost<{ status: string; cached?: boolean; note?: string; estimate?: number }>(`products/${data.product.id}/ai`);
      setNote(r.cached ? r.note ?? "Already done" : r.status === "queued" ? `Queued for an AI employee (about ${Math.round((r.estimate ?? 0) / 1000)}k tokens in, at most 12k out). Results appear here in a few minutes.` : `Already ${r.status}.`); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not started"); } finally { setBusy(false); } };
  const analyse = async () => { setBusy(true); setError(null);
    try { const r = await pmPost<{ personas: number; journeys: number; issues: number; fixed: number }>(`products/${data.product.id}/analyse`); setNote(`Analysed: ${r.personas} user types, ${r.journeys} proposed journeys, ${r.issues} issues (${r.fixed} fixed since last time).`); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "Not analysed"); } finally { setBusy(false); } };
  return <section className={css.card} aria-label="AI pass">
    <div className={css.cardHead}><h3><Bot size={16} aria-hidden="true" /> AI pass</h3></div>
    <p className={css.small}>An AI employee reads a short summary of the map (never your code) and proposes user types with age group and skill level, key journeys, issues and ideas. Each claim shows its evidence and how sure it is. Bounded: about 12k tokens in and 5–12k out, from your AI employees’ daily budget.</p>
    {last ? <p className={css.small}>Last: <b>{last.status}</b> {when(last.finishedAt ?? last.createdAt)}{last.engine ? ` on ${last.engine}` : ""}{last.tokensIn != null ? ` · ${last.tokensIn + (last.tokensOut ?? 0)} tokens` : ""}
      {last.counts ? ` · ${last.counts.personas ?? 0} user types, ${last.counts.journeys ?? 0} journeys, ${last.counts.issues ?? 0} issues, ${last.counts.ideas ?? 0} ideas` : ""}{last.error ? ` · ${last.error}` : ""}</p> : null}
    <div className={css.actions}>
      <button type="button" className={hq.primary} disabled={busy} onClick={() => void run()}><Sparkles size={15} aria-hidden="true" />Run the AI pass</button>
      <button type="button" className={hq.secondary} disabled={busy} onClick={() => void analyse()}><Compass size={15} aria-hidden="true" />Analyse again</button>
    </div>
    {note ? <p className={css.ok} role="status">{note}</p> : null}<Err text={error} />
  </section>;
}

// ------------------------------------------------------------------------------------------------ connect an app
function ConnectSheet({ list, product, onClose, onDone }: { list: ListData; product: { id: string; name: string } | null; onClose: () => void; onDone: (id: string) => void }) {
  const [name, setName] = useState(""), [existing, setExisting] = useState<string>(product?.id ?? "");
  const [kind, setKind] = useState<SourceKind>(list.repos.length ? "repo" : "crawl");
  const [repo, setRepo] = useState(list.repos[0] ?? ""), [path, setPath] = useState(list.repos.includes("pulse") ? "apps/web" : "");
  const [url, setUrl] = useState(""), [startPaths, setStartPaths] = useState("/"), [budget, setBudget] = useState("30"), [signInUrl, setSignInUrl] = useState(""), [user, setUser] = useState(""), [pass, setPass] = useState("");
  const [paste, setPaste] = useState(""), [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const kinds = useMemo(() => (Object.keys(SOURCE_INFO) as SourceKind[]).filter((k) => (k !== "repo" || list.repos.length) && (k !== "crawl" || list.crawl)), [list]);
  const go = async () => {
    setError(null);
    try {
      let pid = existing;
      if (!pid) { if (name.trim().length < 2) throw new Error("Name the app"); setBusy("Adding the app…"); pid = (await pmPost<{ id: string }>("products", { name })).id; }
      if (kind === "manifest" && paste.trim()) {
        setBusy("Reading the manifest…"); let m: unknown; try { m = JSON.parse(paste); } catch { throw new Error("The pasted manifest is not JSON"); }
        await pmPost(`products/${pid}/import`, { manifest: m }); onDone(pid); return;
      }
      const body: Record<string, unknown> = { kind, label: label || undefined };
      if (kind === "repo") Object.assign(body, { repo, path });
      if (kind === "manifest") Object.assign(body, { url });
      if (kind === "crawl") Object.assign(body, { baseUrl: url, startPaths: startPaths.split(/[\s,]+/).filter(Boolean), pageBudget: Number(budget) || 30, signInUrl: signInUrl || undefined, username: user || undefined, password: pass || undefined });
      setBusy("Connecting…"); const s = await pmPost<{ id: string }>(`products/${pid}/sources`, body);
      if (kind !== "push") { setBusy(kind === "repo" ? "Reading the code…" : kind === "telemetry" ? "Reading real use…" : kind === "crawl" ? "Starting the visit…" : "Reading…");
        const r = await pmPost<{ status: string; error?: string }>(`sources/${s.id}/run`); if (r.status === "failed") throw new Error(r.error ?? "It failed"); }
      onDone(pid);
    } catch (e) { setError(e instanceof Error ? e.message : "Not connected"); setBusy(null); }
  };
  return <Drawer className={css.vars} title={product ? `Add a source to ${product.name}` : "Connect an app"} icon={<MapIcon size={16} />} size="lg" onClose={onClose}
    footer={<DrawerFooter status={error ?? busy ?? undefined} tone={error ? "error" : "info"} primary={<button type="button" className={hq.primary} disabled={!!busy} onClick={() => void go()}>{busy ? "Working…" : kind === "push" ? "Add" : "Connect and read"}</button>}>
      <button type="button" className={hq.secondary} onClick={onClose}>Close</button></DrawerFooter>}>
    {!product ? <DrawerSection title="The app">
      {list.products.length ? <label className={hq.fieldLabel}>App<select className={hq.input} value={existing} onChange={(e) => setExisting(e.target.value)}>
        <option value="">A new app…</option>{list.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : null}
      {!existing ? <label className={hq.fieldLabel}>Name<input className={hq.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales X-Ray, our customer app…" maxLength={80} autoFocus /></label> : null}
      <p className={css.small}>It joins Product Story, so its versions and its map stay together.</p>
    </DrawerSection> : null}
    <DrawerSection title="How should Pulse read it?">
      <div className={css.kindPick} role="radiogroup" aria-label="Source">{kinds.map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>
        <SourceIcon kind={k} /><b>{SOURCE_INFO[k].label}</b><span>{SOURCE_INFO[k].what}</span></button>)}</div>
    </DrawerSection>
    <DrawerSection title="Details">
      {kind === "repo" ? <>
        <label className={hq.fieldLabel}>Checkout on this server<select className={hq.input} value={repo} onChange={(e) => setRepo(e.target.value)}>{list.repos.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
        <label className={hq.fieldLabel}>Folder of the app (optional)<input className={hq.input} value={path} onChange={(e) => setPath(e.target.value)} placeholder="apps/web" /></label>
        <p className={css.small}>Next.js (app and pages), Expo Router and React Router are read. Code elsewhere: run <code>node services/api/dist/product-map-scan.js &lt;checkout&gt; [folder]</code> there and paste or push its output as a manifest.</p>
      </> : null}
      {kind === "crawl" ? <>
        <label className={hq.fieldLabel}>App address<input className={hq.input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.example.com" inputMode="url" /></label>
        <div className={css.row2}><label className={hq.fieldLabel}>Start pages<input className={hq.input} value={startPaths} onChange={(e) => setStartPaths(e.target.value)} placeholder="/ /dashboard" /></label>
          <label className={hq.fieldLabel}>Page budget<input className={hq.input} value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, ""))} inputMode="numeric" /></label></div>
        <label className={hq.fieldLabel}>Sign-in page (optional)<input className={hq.input} value={signInUrl} onChange={(e) => setSignInUrl(e.target.value)} placeholder="/login" /></label>
        <div className={css.row2}><label className={hq.fieldLabel}>Test account<input className={hq.input} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" placeholder="a test user, never a real one" /></label>
          <label className={hq.fieldLabel}>Its password<input className={hq.input} type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></label></div>
        <p className={css.small}>The test account is sealed with this server’s key and used only by the visit. Pulse opens pages by address and never clicks, so nothing is deleted, paid, sent or submitted.</p>
      </> : null}
      {kind === "manifest" ? <>
        <label className={hq.fieldLabel}>Manifest address<input className={hq.input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.example.com/.well-known/pulse-product-map.json" inputMode="url" /></label>
        <label className={hq.fieldLabel}>Or paste it<textarea className={`${hq.input} ${hq.textarea}`} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"schema":"pulse-product-map/1","screens":[…]}' rows={4} /></label>
        <p className={css.small}>The schema is in Build &amp; agents.</p>
      </> : null}
      {kind === "telemetry" ? <p className={css.small}>Uses the last 30 days of this organisation’s Pulse telemetry: screens people open, the paths they walk, load times and errors. Names and typed text are never read.</p> : null}
      {kind === "push" ? <p className={css.small}>After adding it, make a token that may push (Build &amp; agents) and send the manifest from the app’s build: <code>POST /api/v0/product-map/feed/manifest</code>.</p> : null}
      <label className={hq.fieldLabel}>Label (optional)<input className={hq.input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={SOURCE_INFO[kind].label} maxLength={120} /></label>
    </DrawerSection>
    {error ? <Err text={error} /> : null}
  </Drawer>;
}

export const Tag = ({ children, t }: { children: ReactNode; t?: string }) => <span className={css.tag} style={t ? tone(t) : undefined}>{children}</span>;

