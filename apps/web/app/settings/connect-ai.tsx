"use client";
// AI-CONNECT (owner, 8 Nov 2026: "There's no way to add connectors or add AI … you just copy the API link or MCP link and
// add it, and you can log in easily"). Settings → Connect your AI, built from Codex concept B ("Pick then follow"):
//  * six app tiles (Claude, ChatGPT, Gemini CLI, Cursor / VS Code, any MCP app, API key); the chosen one opens ONE panel
//    with ONE Copy button and three big steps, each with a small picture of what the person sees (drawn here, no images);
//  * Connected apps: every AI app signed in as this person (OAuth grants, /api/v0/oauth/connections) and every key they
//    made, with what it may do, when it was last used, and Disconnect / Remove (at once);
//  * For your company: where the AI employees run and which AI plan they use (admins and leadership; /api/v0/ai and
//    /api/v0/admin/runners), with Manage links; others read who sets it up.
// The server is the existing remote MCP at /mcp with OAuth 2.1 + dynamic registration (EST-2811); a key is an ordinary
// personal token (Settings → API keys). Everything an app does is checked against the person's own permissions.
// Started by DOCS-MCP (8 Nov 2026) as one column of steps for docs; AI-CONNECT makes it the one place for every AI app.
// FIX-AI-EMPLOYEES (owner walkthrough, 10 Nov 2026, D3: "use the real Claude, ChatGPT and Gemini logos, with proper
// brand-asset rules, and give it a clearer layout"), Codex concept 1 ("Big three first"): the three big apps as large
// cards with their real logos (MIT SVGs from lobe-icons, unchanged, on a white plate; THIRD_PARTY.md has the rules) and
// whether each is connected; Cursor / VS Code, any MCP app and an API key as a quieter "More ways" row; then the steps.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, CodeXml, Copy, ExternalLink, KeyRound, Plug, Server, Sparkles, Terminal, Trash2, Unplug } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Skeleton, styles } from "../ui";
import { ago } from "../lib/format";
import { aiApps, type AiShot } from "../lib/connect-ai-apps.mjs";
import { scopeSummary } from "../lib/oauth-scope-groups.mjs";
import css from "./connect-ai.module.css";
import { useConfirm } from "../kit/dialogs";
import { EmptyState } from "../kit/game";

type Token = { id: string; kind: "personal" | "bot"; name: string; scopes: string[]; mine: boolean; createdAt: string; lastUsedAt: string | null; expired: boolean; expiresAt: string };
type Grant = { id: string; app: string; scopes: string[]; createdAt: string; lastUsedAt: string | null };
type Fact = { name: string; detail: string; ok: boolean };
type Company = { runsOn: Fact[]; uses: Fact[]; canServers: boolean } | "not-yours" | null;
type AiData = { connections?: { name: string; providerName?: string; state: string; agents?: number }[]; server?: { name: string; state: string; agents?: number }[];
  workspaces?: { name: string; state: string; agents?: number }[]; cloud?: { name: string; state?: string } };
type Runner = { name: string; online: boolean; aiEmployees: boolean; lastSeenAt: string | null; claude?: { loggedIn: boolean }; codex?: { loggedIn: boolean } };

const READ = ["docs.read", "tasks.read", "projects.read", "search.read", "people.read", "contracts.read", "billing.read", "companies.read"];
const WRITE = ["docs.write", "tasks.write", "projects.write", "contracts.write", "billing.write"];
/** The three big apps, shown first with their own logos; the rest are "More ways". */
const BIG = ["claude", "chatgpt", "gemini"] as const;
const ICONS: Record<string, typeof Plug> = { editor: CodeXml, any: Plug, key: KeyRound };
/** Which app a sign-in (an OAuth connection's name) is, for its logo and the Connected chip. */
export function appOf(name: string): string | null {
  if (/claude/i.test(name)) return "claude";
  if (/chatgpt|openai/i.test(name)) return "chatgpt";
  if (/gemini/i.test(name)) return "gemini";
  if (/cursor|vs ?code|visual studio/i.test(name)) return "editor";
  return null;
}

/** The app's own logo, as published, on a white plate with clear space (brand rules: THIRD_PARTY.md). */
function Logo({ app, size = 28 }: { app: string; size?: number }) {
  if (!(BIG as readonly string[]).includes(app)) { const Icon = ICONS[app] ?? Sparkles; return <span className={css.glyph} aria-hidden="true"><Icon size={Math.round(size * 0.7)} /></span>; }
  // eslint-disable-next-line @next/next/no-img-element -- a 2 KB static SVG mark, fixed size (no layout shift)
  return <span className={css.plate} style={{ padding: Math.round(size * 0.3) }} aria-hidden="true"><img src={`/brand-ai/${app}.svg`} alt="" width={size} height={size} /></span>;
}

async function send<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "That did not work just now. Try again.");
  return data as T;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.copyBig}`} disabled={!text}
    onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 2000); },
      () => notify({ id: "connect-ai-copy", tone: "error", title: "Could not copy", message: "Select the text and copy it by hand." }))}>
    {done ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}{done ? "Copied" : label}</button>;
}

/** A small drawing of what the person sees at a step (menu path, fields, a terminal line, the Allow screen). */
function Shot({ shot, brand }: { shot: AiShot; brand: string }) {
  if (shot.kind === "terminal") return <div className={`${css.shot} ${css.term}`} aria-hidden="true"><span>$</span> {shot.line}</div>;
  if (shot.kind === "fields") return <div className={css.shot} aria-hidden="true">{shot.rows.map(([k, v]) => <div key={k} className={css.field}><small>{k}</small><span>{v}</span></div>)}</div>;
  if (shot.kind === "menu") return <div className={css.shot} aria-hidden="true"><div className={css.crumbs}>{shot.path.join(" → ")}</div><span className={css.press}>{shot.button}</span></div>;
  return <div className={css.shot} aria-hidden="true"><b className={css.allowTitle}>Connect to {brand}?</b><small>It sees only what you can see.</small>
    <div className={css.allowRow}><span>Cancel</span><span className={css.press}>Allow</span></div></div>;
}

function Facts({ title, facts, Icon }: { title: string; facts: Fact[]; Icon: typeof Server }) {
  return <div className={css.fact}>
    <h4><Icon size={16} aria-hidden="true" />{title}</h4>
    <ul>{facts.map((f, i) => <li key={`${f.name}-${i}`}><i className={f.ok ? css.dotOk : css.dotOff} aria-hidden="true" /><span><b>{f.name}</b><small>{f.detail}</small></span></li>)}</ul>
  </div>;
}

export function ConnectAi({ origin, appName }: { origin: string; appName: string }) {
  const confirm = useConfirm();
  const url = `${origin}/mcp`;
  const [pick, setPick] = useState("claude"), [way, setWay] = useState<Record<string, string>>({});
  const [tokens, setTokens] = useState<Token[] | null>(null), [plan, setPlan] = useState<string[] | null>(null);
  const [grants, setGrants] = useState<Grant[] | null>(null), [company, setCompany] = useState<Company>(null);
  const [made, setMade] = useState<string | null>(null), [busy, setBusy] = useState(false), [canWrite, setCanWrite] = useState(true), [error, setError] = useState<string | null>(null);

  const loadMine = useCallback(() => Promise.all([
    send<{ tokens: Token[]; plan?: { scopes: string[] } }>("api-tokens").then((d) => { setTokens(d.tokens); setPlan(d.plan?.scopes ?? null); }),
    send<{ connections: Grant[] }>("oauth/connections").then((d) => setGrants(d.connections)),
  ]).catch((e: Error) => setError(e.message)), []);
  useEffect(() => { void loadMine(); }, [loadMine]);
  useEffect(() => {
    // Admins and leadership see the company's AI; anyone else gets 403 here and reads who sets it up.
    send<AiData>("ai").then(async (ai) => {
      const runners = await send<{ runners: Runner[] }>("admin/runners").then((r) => r.runners, () => null);
      const runsOn: Fact[] = [
        ...(runners ?? []).filter((r) => r.aiEmployees).map((r) => ({ name: r.name, ok: r.online,
          detail: `${r.online ? "online" : r.lastSeenAt ? `offline, last seen ${ago(r.lastSeenAt)}` : "not seen yet"}${r.claude?.loggedIn ? " · Claude signed in" : ""}${r.codex?.loggedIn ? " · Codex signed in" : ""}` })),
        ...(ai.workspaces ?? []).map((w) => ({ name: w.name, ok: w.state === "ok", detail: `workspace · ${w.state === "ok" ? "working" : w.state}${w.agents ? ` · ${w.agents} AI employees` : ""}` })),
      ];
      if (!runsOn.length) runsOn.push({ name: `${appName}'s own servers`, ok: ai.cloud?.state !== "error", detail: "nothing to set up" });
      const uses: Fact[] = [
        ...(ai.server ?? []).filter((s) => s.state === "connected" || (s.agents ?? 0) > 0).map((s) => ({ name: s.name.replace(/\s*·\s*this server$/i, ""), ok: s.state === "connected",
          detail: s.state === "connected" ? `the company's plan${s.agents ? `, used by ${s.agents} AI employees` : ""}` : s.state.replaceAll("_", " ") })),
        ...(ai.connections ?? []).map((c) => ({ name: c.name, ok: c.state === "connected" || c.state === "ok", detail: `${c.providerName ?? "AI"}${c.agents ? ` · ${c.agents} AI employees` : ""}` })),
      ];
      setCompany({ runsOn, uses, canServers: runners !== null });
    }).catch(() => setCompany("not-yours"));
  }, [appName]);

  const apps = useMemo(() => aiApps({ url, brand: appName, key: made }), [url, appName, made]);
  const app = apps.find((a) => a.key === pick) ?? apps[0];
  const current = app.ways.find((w) => w.key === way[app.key]) ?? app.ways[0];
  const isKey = app.key === "key";

  const makeKey = async () => {
    setBusy(true);
    try {
      const scopes = [...READ, ...(canWrite ? WRITE : [])].filter((s) => !plan || plan.includes(s));
      const r = await send<{ tokens: Token[]; token: string }>("api-tokens", { kind: "personal", name: canWrite ? "My AI key (read and write)" : "My AI key (read only)", scopes, days: 90 });
      setTokens(r.tokens); setMade(r.token);
    } catch (e) { notify({ id: "connect-ai", tone: "error", title: "No key made", message: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const endGrant = async (g: Grant) => {
    if (!(await confirm({ title: `Disconnect ${g.app}?`, body: `It can't reach ${appName} any more, starting now. You can connect it again later.`, confirmLabel: "Disconnect", danger: true }))) return;
    try { await send(`oauth/connections/${g.id}/end`, {}); await loadMine(); notify({ id: "connect-ai", tone: "success", title: `${g.app} disconnected`, timeout: 2500 }); }
    catch (e) { notify({ id: "connect-ai", tone: "error", title: "Not disconnected", message: (e as Error).message }); }
  };
  const removeKey = async (t: Token) => {
    if (!(await confirm({ title: `Remove “${t.name}”?`, body: `Anything that uses it can't reach ${appName} any more, starting now.`, confirmLabel: "Remove", danger: true }))) return;
    try { const r = await send<{ tokens: Token[] }>(`api-tokens/${t.id}/revoke`, {}); setTokens(r.tokens); notify({ id: "connect-ai", tone: "success", title: "Key removed", timeout: 2500 }); }
    catch (e) { notify({ id: "connect-ai", tone: "error", title: "Not removed", message: (e as Error).message }); }
  };
  const keys = (tokens ?? []).filter((t) => t.kind === "personal" && t.mine && !t.expired);
  const linked = new Set((grants ?? []).map((g) => appOf(g.app)).filter(Boolean) as string[]);

  return <div className={css.page} data-grow="">
    {/* The Settings header already names the section; this line says what it means for the person. */}
    <p className={css.head}>Let your own Claude, ChatGPT or Gemini work in {appName} as you. It sees only what you can see, and you can switch it off any time.</p>

    <div className={css.big} role="group" aria-label="Pick your AI app">
      {apps.filter((a) => (BIG as readonly string[]).includes(a.key)).map((a) => <button key={a.key} type="button" aria-pressed={a.key === app.key}
        className={`${css.bigCard} ${a.key === app.key ? css.on : ""}`} onClick={() => setPick(a.key)}>
        <Logo app={a.key} size={36} />
        <span className={css.bigText}><b>{a.name}</b><small>{a.sub}</small>
          {linked.has(a.key) ? <span className={css.state} data-on="">Connected</span> : null}</span>
        {a.key === app.key ? <Check className={css.tick} size={16} aria-hidden="true" /> : null}</button>)}
    </div>
    <details className={css.moreWays} open={!(BIG as readonly string[]).includes(app.key)}>
      <summary>More ways to connect <small>Cursor or VS Code, any MCP app, an API key</small></summary>
      <div className={css.moreRow} role="group" aria-label="More ways to connect">
        {apps.filter((a) => !(BIG as readonly string[]).includes(a.key)).map((a) => <button key={a.key} type="button" aria-pressed={a.key === app.key}
          className={`${css.way} ${a.key === app.key ? css.on : ""}`} onClick={() => setPick(a.key)}>
          <Logo app={a.key} size={20} /><span><b>{a.name}</b><small>{a.sub}</small></span><ChevronRight size={16} aria-hidden="true" /></button>)}
      </div>
    </details>

    <div className={css.main}>
      <section className={css.panel} role="tabpanel" aria-label={app.name}>
        <div className={css.panelHead}>
          <div className={css.setUp}><Logo app={app.key} size={24} /><span><h3>Set up {app.name}</h3><p>{app.signIn ? `No key needed: you sign in to ${appName} once.` : "A key acts as you, with your access, for 90 days."}</p></span></div>
          {app.ways.length > 1 ? <div className={css.ways} role="group" aria-label="Which one">
            {app.ways.map((w) => <button key={w.key} type="button" aria-pressed={w.key === current.key} className={w.key === current.key ? css.wayOn : ""}
              onClick={() => setWay((x) => ({ ...x, [app.key]: w.key }))}>{w.label}</button>)}</div> : null}
        </div>

        {isKey && !made ? <div className={css.make}>
          <fieldset className={css.choice}><legend>The key may</legend>
            <label><input type="radio" name="ai-write" checked={canWrite} onChange={() => setCanWrite(true)} /> Read and write (docs, tasks, projects, contracts, quotes)</label>
            <label><input type="radio" name="ai-write" checked={!canWrite} onChange={() => setCanWrite(false)} /> Only read</label></fieldset>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.copyBig}`} disabled={busy || !tokens} onClick={() => void makeKey()}>
            <KeyRound size={16} aria-hidden="true" />{busy ? "Making…" : "Make a key"}</button>
        </div> : <div className={css.copyRow}>
          <code aria-label={current.copy.label}>{current.copy.text}</code>
          <CopyButton text={current.copy.text} label={current.copy.label} />
          {current.link ? <a className={`${styles.btn} ${css.copyBig}`} href={current.link.href}><ExternalLink size={16} aria-hidden="true" />{current.link.label}</a> : null}
        </div>}
        {isKey && made ? <p className={css.secret} role="status"><b>Copy your key now.</b> {appName} shows it only once. Keep it secret, like a password.</p> : null}

        <ol className={css.steps}>
          {current.steps.map((s, i) => <li key={i}><span className={css.num} aria-hidden="true">{i + 1}</span><p>{s}</p>
            {current.shots[i] ? <Shot shot={current.shots[i]} brand={appName} /> : null}</li>)}
        </ol>
        {current.note ? <p className={css.note}>{current.note}</p> : null}
        <p className={css.note}>Then ask things like: “List my {appName} tasks due this week”, “Read the latest docs tagged offer”, “Draft a quote for …”, or “Write a doc called Offer stage 3”.</p>
      </section>

      <aside className={css.side}>
        <section className={css.card} aria-labelledby="connected-apps">
          <h3 id="connected-apps">Connected apps</h3>
          {error ? <p className={css.note}>{error}</p> : null}
          {!grants || !tokens ? (error ? null : <Skeleton height={90} />) : !grants.length && !keys.length ? <EmptyState art="connect" title="Nothing connected yet" text="Pick your app above and follow its three steps." /> :
            <ul className={css.list}>
              {grants.map((g) => <li key={g.id}><Logo app={appOf(g.app) ?? "any"} size={20} /><span><b>{g.app}</b>
                <small>{scopeSummary(g.scopes)} · {g.lastUsedAt ? `last used ${ago(g.lastUsedAt)}` : `connected ${ago(g.createdAt)}, not used yet`}</small></span>
                <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void endGrant(g)}><Unplug size={13} aria-hidden="true" /> Disconnect</button></li>)}
              {keys.map((t) => <li key={t.id}><span className={css.glyph} aria-hidden="true"><Terminal size={14} /></span><span><b>{t.name}</b>
                <small>key · {scopeSummary(t.scopes)} · {t.lastUsedAt ? `last used ${ago(t.lastUsedAt)}` : "not used yet"}</small></span>
                <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void removeKey(t)}><Trash2 size={13} aria-hidden="true" /> Remove</button></li>)}
            </ul>}
          <p className={css.note}>All your keys: <Link href="/settings?tab=api-keys">Settings → API keys</Link>.</p>
        </section>

        <details className={`${css.card} ${css.company}`}>
          <summary><h3>For your company</h3><small>Where your AI employees work, and the AI they use</small></summary>
          {company === null ? <Skeleton height={70} /> : company === "not-yours"
            ? <p className={css.note}>Your admins choose which AI your company’s AI employees use and where they run (Settings → AI).</p>
            : <>
              <Facts title="Where your AI employees work" facts={company.runsOn} Icon={Server} />
              <Facts title="The AI they use" facts={company.uses.length ? company.uses : [{ name: "No AI connected yet", detail: "an admin connects one in Settings → AI", ok: false }]} Icon={Sparkles} />
              <p className={css.manage}><Link href="/settings?tab=ai">Manage AI</Link>{company.canServers ? <Link href="/settings?tab=servers">Manage servers</Link> : null}</p>
            </>}
        </details>
      </aside>
    </div>
    <p className={css.marks}>Claude is a trademark of Anthropic, ChatGPT of OpenAI, and Gemini of Google. Their logos are here only to help you find your app.</p>
  </div>;
}
