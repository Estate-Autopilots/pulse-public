"use client";
// PULSE-ID: Settings → Connected apps (docs/architecture/PULSE_IDENTITY_AND_DATA_API.md §9). Everyone sees the apps they
// signed in to with Pulse and removes them; admins also see the apps linked to the organisation (who linked it, what it
// may do, a switch per scope within what the app asked for, its webhook endpoints and their health, Disconnect) and
// members' sign-ins. Admins of the install's own organisation register apps below (Developer apps).
import { useEffect, useState } from "react";
import { BadgeCheck, Building2, Copy, KeyRound, Link2Off, Plug, ShieldAlert, UserRound } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { scopeSentence, SCOPES, shownScopes } from "../oauth/scopes";
import { Badge, Empty, Panel, Skeleton, styles } from "../ui";
import { ago } from "../lib/format";
import css from "./connected-apps.module.css";

type App = { clientId: string; name: string; maker: string | null; verified: boolean; homeUrl: string | null; logo: number | null; status: string };
type Connection = { id: string; kind: "personal" | "org"; scopes: string[]; asked: string[]; createdAt: string; updatedAt: string; lastUsedAt: string | null; mine: boolean;
  person: { id: string; name: string } | null; grantedBy: { id: string; name: string; active: boolean } | null; app: App;
  webhooks: { id: string; url: string; events: string[]; status: string; lastOkAt: string | null; lastError: string | null; failingSince: string | null }[]; calls: number };
type Connections = { admin: boolean; connections: Connection[] };

async function send<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "Pulse couldn’t do that just now. Try again.");
  return data as T;
}

function Mark({ app }: { app: App }) {
  // eslint-disable-next-line @next/next/no-img-element -- the app's logo, served by Pulse (re-encoded at upload)
  return <span className={css.mark} aria-hidden="true">{app.logo ? <img src={`/oauth/app-logo/${app.clientId}?v=${app.logo}`} alt="" width={36} height={36} /> : app.name.slice(0, 1)}</span>;
}
function AppName({ app }: { app: App }) {
  return <span className={css.name}><b>{app.name}</b><small>{app.verified ? <><BadgeCheck size={12} aria-hidden="true" /> Verified by Pulse</> : <><ShieldAlert size={12} aria-hidden="true" /> Not verified</>}
    {app.maker ? ` · ${app.maker}` : ""}{app.status !== "active" ? " · switched off" : ""}</small></span>;
}

export function ConnectedApps({ orgName }: { orgName: string }) {
  const [data, setData] = useState<Connections | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState<string | null>(null);
  const load = () => send<Connections>("oidc/connections").then(setData).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const act = async (id: string, run: () => Promise<Connections>, done: string) => {
    setBusy(id);
    try { setData(await run()); notify({ id: `oidc-${id}`, tone: "success", title: done, timeout: 3000 }); }
    catch (e) { notify({ id: `oidc-${id}`, tone: "error", title: "Not changed", message: (e as Error).message }); }
    finally { setBusy(null); }
  };
  const end = (c: Connection) => {
    const words = c.kind === "org" ? `Disconnect ${c.app.name} from ${orgName}? It stops at once and its webhook endpoints are told.` : `Remove ${c.app.name}? It stops at once; signing in there again asks you again.`;
    if (window.confirm(words)) void act(c.id, () => send<Connections>(`oidc/connections/${c.id}/end`, {}), c.kind === "org" ? "Disconnected" : "Removed");
  };
  if (error) return <Panel title="Connected apps"><p className={css.note}>{error}</p></Panel>;
  if (!data) return <Panel title="Connected apps"><div className={css.list}><Skeleton height={88} /><Skeleton height={88} /></div></Panel>;
  const links = data.connections.filter((c) => c.kind === "org"), mine = data.connections.filter((c) => c.mine), others = data.connections.filter((c) => c.kind === "personal" && !c.mine);
  return <div className={css.stack} data-grow="">
    {data.admin ? <Panel title={`Apps linked to ${orgName}`} sub={links.length ? `${links.length} linked · any admin can change or end a link` : "Apps an admin links to the organisation read and write only what is switched on here"}>
      {links.length ? <div className={css.list}>{links.map((c) => <article key={c.id} className={css.card} aria-label={c.app.name}>
        <header className={css.head}><Mark app={c.app} /><AppName app={c.app} /><Badge tone="success">Linked</Badge></header>
        <p className={css.meta}><Building2 size={13} aria-hidden="true" /> Linked by {c.grantedBy?.name ?? "an admin"}{c.grantedBy && !c.grantedBy.active ? " (no longer here: the link stays the organisation’s)" : ""} · {ago(c.createdAt)}
          {c.lastUsedAt ? ` · last used ${ago(c.lastUsedAt)}` : " · not used yet"} · {c.calls} calls this week</p>
        <fieldset className={css.scopes} disabled={busy === c.id}><legend>What {c.app.name} may do</legend>
          {shownScopes(c.asked).filter((s) => SCOPES[s]?.data).map((s) => { const on = c.scopes.includes(s);
            return <label key={s} className={css.scope}><input type="checkbox" checked={on} onChange={() => void act(c.id,
              () => send<Connections>(`oidc/connections/${c.id}/scopes`, { scopes: on ? c.scopes.filter((x) => x !== s) : [...c.scopes, s] }), on ? "Switched off" : "Switched on")} />
              <span>{scopeSentence(s, "org", orgName)}</span></label>; })}
        </fieldset>
        {c.webhooks.length ? <ul className={css.hooks} aria-label="Webhook endpoints">{c.webhooks.map((h) => <li key={h.id}><span className={styles.mono}>{h.url}</span>
          <Badge tone={h.status === "active" && !h.failingSince ? "success" : h.status === "off" ? "danger" : "warning"}>{h.status === "off" ? "Switched off after failing" : h.failingSince ? "Failing" : h.status === "ending" ? "Ending" : "Delivering"}</Badge>
          <small>{h.lastOkAt ? `last delivered ${ago(h.lastOkAt)}` : "nothing delivered yet"}{h.lastError ? ` · ${h.lastError}` : ""}</small></li>)}</ul> : null}
        <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy === c.id} onClick={() => end(c)}><Link2Off size={13} aria-hidden="true" /> Disconnect</button></div>
      </article>)}</div> : <Empty icon={Plug} compact title="No app is linked to the organisation" text="An admin links one from the app itself (for Sales X-Ray: its organisation settings → Connect your Pulse org)." />}
    </Panel> : null}
    <Panel title="Your connected apps" sub="Apps you signed in to with Pulse, and what each can see">
      {mine.length ? <div className={css.list}>{mine.map((c) => <article key={c.id} className={css.card} aria-label={c.app.name}>
        <header className={css.head}><Mark app={c.app} /><AppName app={c.app} /></header>
        <ul className={css.sees}>{shownScopes(c.scopes).map((s) => <li key={s}>{scopeSentence(s, "personal", orgName)}</li>)}</ul>
        <p className={css.meta}>Since {ago(c.createdAt)}{c.lastUsedAt ? ` · last used ${ago(c.lastUsedAt)}` : ""}</p>
        <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy === c.id} onClick={() => end(c)}><Link2Off size={13} aria-hidden="true" /> Remove</button></div>
      </article>)}</div> : <Empty icon={KeyRound} compact title="You haven’t signed in to an app with Pulse" text="When an app offers “Sign in with Pulse”, it shows here with what it can see, and you can remove it any time." />}
    </Panel>
    {data.admin && others.length ? <Panel title="Members’ sign-ins" sub={`${others.length} in ${orgName}`}>
      <ul className={css.rows}>{others.map((c) => <li key={c.id}><UserRound size={14} aria-hidden="true" /><b>{c.person?.name}</b><span>{c.app.name}</span>
        <small>{c.lastUsedAt ? `last used ${ago(c.lastUsedAt)}` : `since ${ago(c.createdAt)}`}</small>
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy === c.id} onClick={() => end(c)}>Remove</button></li>)}</ul>
    </Panel> : null}
  </div>;
}

// ----- Developer apps: the apps registered on this Pulse (admins of the install's own organisation) ------------------
type Registered = { id: string; clientId: string; name: string; maker: string | null; homeUrl: string | null; redirectUris: string[]; scopes: string[]; development: boolean;
  verified: boolean; status: string; hasLogo: boolean; createdAt: string; updatedAt: string; lastUsedAt: string | null; secretRotating: boolean };
type Registry = { apps: Registered[]; issuer: string | null; on: boolean };
const ALL = Object.keys(SCOPES);

export function DeveloperApps() {
  const [data, setData] = useState<Registry | null>(null), [denied, setDenied] = useState(false), [secret, setSecret] = useState<{ name: string; clientId: string; secret: string } | null>(null);
  const [form, setForm] = useState<{ id?: string; name: string; maker: string; homeUrl: string; uris: string; scopes: string[]; development: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => send<Registry>("oidc/apps").then(setData).catch(() => setDenied(true));
  useEffect(() => { void load(); }, []);
  if (denied) return null;   // only the install's own admins register apps
  if (!data) return <Panel title="Developer apps"><Skeleton height={88} /></Panel>;
  const run = async (what: () => Promise<unknown>, title: string) => {
    setBusy(true);
    try { await what(); await load(); notify({ id: "oidc-app", tone: "success", title, timeout: 3000 }); }
    catch (e) { notify({ id: "oidc-app", tone: "error", title: "Not saved", message: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const save = () => form && run(async () => {
    const body = { name: form.name, maker: form.maker, homeUrl: form.homeUrl, redirectUris: form.uris.split(/\s+/).filter(Boolean), scopes: form.scopes, development: form.development };
    if (form.id) await send(`oidc/apps/${form.id}`, body);
    else { const r = await send<{ clientId: string; clientSecret: string }>("oidc/apps", body); setSecret({ name: form.name, clientId: r.clientId, secret: r.clientSecret }); }
    setForm(null);
  }, form.id ? "App saved" : "App registered");
  const logo = (a: Registered, file: File) => { const reader = new FileReader(); reader.onload = () => void run(() => send(`oidc/apps/${a.id}/logo`, { image: String(reader.result) }), "Logo saved"); reader.readAsDataURL(file); };
  return <Panel title="Developer apps" sub={data.on ? `Apps that may offer “Sign in with Pulse” · issuer ${data.issuer}` : "Sign in with Pulse is switched off on this server (PULSE_OIDC and its signing key)"}
    tools={<button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} onClick={() => setForm({ name: "", maker: "", homeUrl: "", uris: "", scopes: ["openid", "profile", "email"], development: false })}>Register an app</button>}>
    {secret ? <div className={css.secret} role="status"><p><b>{secret.name}</b>: copy the client secret now. Pulse shows it once and keeps only a fingerprint; put it in the app’s own secret store, never in chat or git.</p>
      <dl><dt>Client ID</dt><dd className={styles.mono}>{secret.clientId}</dd><dt>Client secret</dt><dd className={styles.mono}>{secret.secret}</dd></dl>
      <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void navigator.clipboard.writeText(secret.secret)}><Copy size={13} aria-hidden="true" /> Copy secret</button>
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setSecret(null)}>I’ve stored it</button></div></div> : null}
    {form ? <form className={css.form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className={styles.field}>Name<input required minLength={2} maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Sales X-Ray (dev)" /></label>
      <label className={styles.field}>Made by<input maxLength={80} value={form.maker} onChange={(e) => setForm({ ...form, maker: e.target.value })} /></label>
      <label className={styles.field}>Home page<input type="url" maxLength={300} value={form.homeUrl} onChange={(e) => setForm({ ...form, homeUrl: e.target.value })} placeholder="https://" /></label>
      <label className={styles.field}>Return addresses (one per line, exact)<textarea required rows={3} value={form.uris} onChange={(e) => setForm({ ...form, uris: e.target.value })} /></label>
      <fieldset className={css.scopes}><legend>Scopes it may ask for</legend>{ALL.map((s) => <label key={s} className={css.scope}>
        <input type="checkbox" checked={form.scopes.includes(s)} disabled={s === "openid"} onChange={() => setForm({ ...form, scopes: form.scopes.includes(s) ? form.scopes.filter((x) => x !== s) : [...form.scopes, s] })} />
        <span><span className={styles.mono}>{s}</span> · {SCOPES[s].label}</span></label>)}</fieldset>
      <label className={css.scope}><input type="checkbox" checked={form.development} onChange={(e) => setForm({ ...form, development: e.target.checked })} /><span>Development app (may return to http://localhost)</span></label>
      <div className={css.actions}><button className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={busy}>{form.id ? "Save" : "Register"}</button>
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setForm(null)}>Cancel</button></div>
    </form> : null}
    {data.apps.length ? <div className={css.list}>{data.apps.map((a) => <article key={a.id} className={css.card} aria-label={a.name}>
      <header className={css.head}><Mark app={{ clientId: a.clientId, name: a.name, maker: a.maker, verified: a.verified, homeUrl: a.homeUrl, logo: a.hasLogo ? Date.parse(a.updatedAt) : null, status: a.status }} />
        <AppName app={{ clientId: a.clientId, name: a.name, maker: a.maker, verified: a.verified, homeUrl: a.homeUrl, logo: null, status: a.status }} />
        <Badge tone={a.status === "active" ? "success" : "neutral"}>{a.status === "active" ? "On" : "Off"}</Badge></header>
      <dl className={css.facts}><dt>Client ID</dt><dd className={styles.mono}>{a.clientId}</dd><dt>Return to</dt><dd>{a.redirectUris.map((u) => <span key={u} className={styles.mono}>{u}</span>)}</dd>
        <dt>Scopes</dt><dd>{a.scopes.join(" ")}</dd><dt>Used</dt><dd>{a.lastUsedAt ? ago(a.lastUsedAt) : "not yet"}{a.secretRotating ? " · previous secret still works for a day" : ""}</dd></dl>
      <div className={css.actions}>
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => setForm({ id: a.id, name: a.name, maker: a.maker ?? "", homeUrl: a.homeUrl ?? "", uris: a.redirectUris.join("\n"), scopes: a.scopes, development: a.development })}>Edit</button>
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => void run(() => send(`oidc/apps/${a.id}/verify`, { verified: !a.verified }), a.verified ? "No longer verified" : "Marked verified")}>{a.verified ? "Unverify" : "Mark verified"}</button>
        <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy} onClick={() => window.confirm(`Make a new client secret for ${a.name}? The current one keeps working for 24 hours.`)
          && void run(async () => { const r = await send<{ clientSecret: string }>(`oidc/apps/${a.id}/secret`, {}); setSecret({ name: a.name, clientId: a.clientId, secret: r.clientSecret }); }, "New secret made")}>New secret</button>
        <label className={`${styles.btn} ${styles.btnSmall} ${css.file}`}>Logo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) logo(a, f); }} /></label>
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy} onClick={() => (a.status !== "active" || window.confirm(`Switch ${a.name} off? Every token it holds stops working at once.`))
          && void run(() => send(`oidc/apps/${a.id}/status`, { on: a.status !== "active" }), a.status === "active" ? "Switched off" : "Switched on")}>{a.status === "active" ? "Switch off" : "Switch on"}</button>
      </div>
    </article>)}</div> : !form ? <Empty icon={Plug} compact title="No app is registered" text="Register an app to let it offer “Sign in with Pulse” and connect organisations." /> : null}
  </Panel>;
}
