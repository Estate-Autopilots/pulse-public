"use client";
// CONNECTORS-CONTRACTS (owner, 6 Nov 2026): Settings → Connectors. A company admin connects apps "like Claude's and
// ChatGPT's": a featured app (Sales X-Ray first) or any remote MCP server by its address, signed in with OAuth or a token
// (sealed on the server, never shown again). Then they choose which tools are on, which tools that change things may
// run without asking, and who may use them: people by role, AI employees by name. Every change is on the ledger below
// each connector, with every call made through it (services/api/src/mcp-connectors.ts).
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Cable, History, Plug, RefreshCw, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { post } from "../orgs/client";
import { useOrgZone, useWords } from "../org-code";
import css from "../contracts/contracts.module.css";
import { SelectField } from "../kit/select-field";

type Tool = { name: string; title: string; description: string; readOnly: boolean };
type Connector = { id: string; appKey: string | null; label: string; url: string; authKind: "oauth" | "bearer" | "none"; status: string; tools: Tool[]; toolsAt: string | null;
  enabledTools: string[]; autoTools: string[]; peopleAccess: string; aiAccess: string; aiAgents: string[]; lastError: string | null };
type Featured = { key: string; name: string; publisher: string; summary: string; url: string | null; why: string | null };
type Data = { connectors: Connector[]; featured: Featured[]; agents: { id: string; name: string }[]; callback: string };
type Ledger = { events: { id: string; action: string; detail: Record<string, unknown>; actorName: string | null; at: string }[];
  calls: { id: string; tool: string; actorKind: string; actor: string | null; via: string; writes: boolean; confirmed: boolean; outcome: string; ms: number | null; at: string }[] };

const STATUS: Record<string, string> = { connected: "Connected", needs_auth: "Needs sign-in", error: "Not answering", off: "Off" };
const ACTION: Record<string, string> = { added: "Added", changed: "Renamed", tools: "Tools changed", access: "Who may use it changed", signed_in: "Signed in",
  secret: "Token replaced", removed: "Removed", status: "Status changed" };
const stamp = (iso: string, timeZone: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone });
const say = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
async function readConnectors(): Promise<Data> {
  const r = await fetch("/api/v0/mcp-connectors", { cache: "no-store" });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "Connectors are unavailable");
  return d;
}

export function ToolConnectors() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [auth, setAuth] = useState<"oauth" | "bearer" | "none">("oauth");
  const load = useCallback(async () => {
    try { setData(await readConnectors()); } catch (e) { setError(say(e)); }
  }, []);
  useEffect(() => { readConnectors().then(setData, (e: unknown) => setError(say(e))); }, []);

  async function act<T>(key: string, path: string, body: unknown = {}): Promise<T | null> {
    setBusy(key); setError(null);
    try { const r = await post<T>(path, body); await load(); return r; } catch (e) { setError(say(e)); return null; } finally { setBusy(null); }
  }
  async function signIn(id: string) {
    const r = await act<{ url: string }>(`signin-${id}`, `mcp-connectors/${id}/sign-in`);
    if (r?.url) window.location.assign(r.url);
  }
  async function addFeatured(f: Featured) {
    const r = await act<{ connector: Connector }>(`add-${f.key}`, "mcp-connectors", { appKey: f.key });
    if (r?.connector) await signIn(r.connector.id);
  }
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await act<{ connector: Connector }>("add", "mcp-connectors", { url: String(f.get("url") ?? ""), label: String(f.get("label") ?? ""), authKind: auth,
      token: auth === "bearer" ? String(f.get("token") ?? "") : undefined });
    if (r?.connector) { (e.target as HTMLFormElement).reset(); if (r.connector.authKind === "oauth") await signIn(r.connector.id); }
  }

  if (!data) return <section className={css.panel}>{error ? <p className={css.error} role="alert">{error}</p> : <p className={css.hint}>Loading connectors…</p>}</section>;
  const connected = new Set(data.connectors.map((c) => c.appKey).filter(Boolean));
  return <div className={css.wrap} data-grow="">
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    <section className={css.section} aria-label="Featured apps">
      <div className={css.sectionHead}><h2><Sparkles size={16} aria-hidden="true" /> Featured apps</h2></div>
      <div className={css.grid}>{data.featured.map((f) => <div key={f.key} className={css.card}>
        <span className={css.cardTop}><h3 className={css.cardTitle}>{f.name}</h3><span className={css.badge}>{f.publisher}</span></span>
        <span className={css.meta}>{f.summary}</span>
        {connected.has(f.key) ? <span className={css.hint}>Connected below.</span> : f.url
          ? <div className={css.actions}><button type="button" className={`${css.btn} ${css.primary}`} disabled={!!busy} onClick={() => addFeatured(f)}>{busy === `add-${f.key}` ? "Connecting…" : "Connect"}</button></div>
          : <p className={css.hint}>{f.why}</p>}
      </div>)}</div>
    </section>

    <section className={css.section} aria-label="Your connectors">
      <div className={css.sectionHead}><h2><Cable size={16} aria-hidden="true" /> Connected apps</h2><span>{data.connectors.length || ""}</span></div>
      {data.connectors.length ? data.connectors.map((c) => <ConnectorCard key={c.id} c={c} agents={data.agents} busy={busy} act={act} signIn={signIn} />)
        : <p className={css.empty}>No apps connected yet. Connect a featured app, or add any app that offers a remote MCP server.</p>}
    </section>

    <form className={`${css.panel} ${css.form}`} onSubmit={add} aria-label="Add an app by its address">
      <h2><Plug size={16} aria-hidden="true" /> Add an app by its address</h2>
      <p className={css.hint}>Any app with a remote MCP server. Vitals OS only connects to public https addresses.</p>
      <div className={css.row}>
        <label className={css.field}>MCP address<input name="url" type="url" required placeholder="https://app.example.com/mcp" maxLength={500} /></label>
        <label className={css.field}>Name<input name="label" maxLength={80} placeholder="Its name in Vitals OS" /></label>
        <label className={css.field}>Sign in with
          <SelectField value={auth} onChange={(e) => setAuth(e.target.value as typeof auth)}>
            <option value="oauth">The app’s own sign-in (OAuth)</option><option value="bearer">A token from the app</option><option value="none">Nothing (a public server)</option>
          </SelectField>
        </label>
      </div>
      {auth === "bearer" ? <label className={css.field}>Token <span className={css.hint}>Kept sealed on the server. Nobody sees it again, not even admins.</span>
        <input name="token" type="password" required minLength={8} maxLength={4000} autoComplete="off" /></label> : null}
      <div className={css.actions}><button type="submit" className={`${css.btn} ${css.primary}`} disabled={busy === "add"}>{busy === "add" ? "Adding…" : "Add app"}</button></div>
    </form>
  </div>;
}

function ConnectorCard({ c, agents, busy, act, signIn }: { c: Connector; agents: Data["agents"]; busy: string | null;
  act: <T>(key: string, path: string, body?: unknown) => Promise<T | null>; signIn: (id: string) => Promise<void> }) {
  const words = useWords();
  const zone = useOrgZone();
  const when = (iso: string) => stamp(iso, zone);
  const [enabled, setEnabled] = useState(new Set(c.enabledTools));
  const [auto, setAuto] = useState(new Set(c.autoTools));
  const [people, setPeople] = useState(c.peopleAccess);
  const [ai, setAi] = useState(c.aiAccess);
  const [chosen, setChosen] = useState(new Set(c.aiAgents));
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const flip = (s: Set<string>, k: string) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; };
  const save = () => act(`save-${c.id}`, `mcp-connectors/${c.id}`, { enabledTools: [...enabled], autoTools: [...auto].filter((t) => enabled.has(t)), peopleAccess: people,
    aiAccess: ai, aiAgents: [...chosen] });
  async function showLedger() {
    if (ledger) { setLedger(null); return; }
    const r = await fetch(`/api/v0/mcp-connectors/${c.id}/ledger`, { cache: "no-store" });
    if (r.ok) setLedger(await r.json());
  }
  return <article className={css.panel} aria-label={c.label}>
    <span className={css.cardTop}>
      <span className={css.itemText}><strong>{c.label}</strong><span>{c.url}</span></span>
      <span className={css.badge} data-tone={c.status === "connected" ? "active" : "proposed"}>{STATUS[c.status] ?? c.status}</span>
    </span>
    {c.lastError ? <p className={css.hint}>{c.lastError}</p> : null}
    <div className={css.actions}>
      {c.authKind === "oauth" ? <button type="button" className={`${css.btn} ${c.status === "needs_auth" ? css.primary : ""}`} disabled={!!busy} onClick={() => signIn(c.id)}>
        <ShieldCheck size={16} aria-hidden="true" />{c.status === "needs_auth" ? "Sign in" : "Sign in again"}</button> : null}
      <button type="button" className={css.btn} disabled={!!busy} onClick={() => act(`refresh-${c.id}`, `mcp-connectors/${c.id}/refresh`)}><RefreshCw size={16} aria-hidden="true" />{busy === `refresh-${c.id}` ? "Reading…" : "Read its tools again"}</button>
      <button type="button" className={css.btn} onClick={showLedger}><History size={16} aria-hidden="true" />{ledger ? "Hide the ledger" : "Ledger"}</button>
      <button type="button" className={`${css.btn} ${css.quiet}`} disabled={!!busy} onClick={() => { if (window.confirm(`Remove ${c.label}? Its sign-in is forgotten; the ledger stays.`)) void act(`rm-${c.id}`, `mcp-connectors/${c.id}/remove`); }}>
        <Trash2 size={16} aria-hidden="true" />Remove</button>
    </div>
    {c.tools.length ? <ul className={css.list} aria-label="Tools">{c.tools.map((t) => <li key={t.name}>
      <label className={css.itemText}>
        <strong><input type="checkbox" checked={enabled.has(t.name)} onChange={() => setEnabled(flip(enabled, t.name))} /> {t.title}</strong>
        <span>{[t.readOnly ? "Reads only" : "Changes things in the app", t.description.slice(0, 160)].filter(Boolean).join(" · ")}</span>
      </label>
      {!t.readOnly && enabled.has(t.name) ? <label className={css.hint}><input type="checkbox" checked={auto.has(t.name)} onChange={() => setAuto(flip(auto, t.name))} /> Runs without asking</label> : null}
    </li>)}</ul> : <p className={css.hint}>{c.status === "connected" ? "This app offers no tools." : "Its tools show once it is signed in."}</p>}
    <div className={css.row}>
      <label className={css.field}>People who may use it
        <SelectField value={people} onChange={(e) => setPeople(e.target.value)}>
          <option value="admins">Admins only</option><option value="leadership">Leadership and admins</option><option value="staff">Everyone on staff</option>
        </SelectField>
      </label>
      <label className={css.field}>AI employees who may use it
        <SelectField value={ai} onChange={(e) => setAi(e.target.value)}>
          <option value="none">None</option><option value="chosen">The ones chosen below</option><option value="all">Every AI employee</option>
        </SelectField>
      </label>
    </div>
    {ai === "chosen" ? agents.length ? <div className={css.actions} role="group" aria-label="AI employees">{agents.map((a) =>
      <label key={a.id} className={css.hint}><input type="checkbox" checked={chosen.has(a.id)} onChange={() => setChosen(flip(chosen, a.id))} /> {a.name}</label>)}</div>
      : <p className={css.hint}>{`No AI employees yet. Add one from People, then choose it here for its ${words.projects.toLowerCase()} and tasks.`}</p> : null}
    <p className={css.hint}>A tool that changes things asks the person (or, for an AI employee, the person it works for) first, unless you let it run without asking. Each AI employee still acts only within its own key’s areas.</p>
    <div className={css.actions}><button type="button" className={`${css.btn} ${css.primary}`} disabled={!!busy} onClick={save}>{busy === `save-${c.id}` ? "Saving…" : "Save"}</button></div>
    {ledger ? <div className={css.section} aria-label="Ledger">
      <ul className={css.list}>{ledger.events.map((e) => <li key={e.id}><span className={css.itemText}><strong>{ACTION[e.action] ?? e.action}</strong>
        <span>{`${when(e.at)}${e.actorName ? ` · ${e.actorName}` : ""}`}</span></span></li>)}</ul>
      {ledger.calls.length ? <ul className={css.list} aria-label="Calls">{ledger.calls.map((x) => <li key={x.id}><span className={css.itemText}><strong>{x.tool}</strong>
        <span>{[when(x.at), x.actor ?? (x.actorKind === "ai" ? "An AI employee" : "Someone"), x.via, x.writes ? (x.confirmed ? "changed things, confirmed" : "changes things") : "read", x.outcome].join(" · ")}</span></span></li>)}</ul>
        : <p className={css.hint}>No calls yet.</p>}
    </div> : null}
  </article>;
}
