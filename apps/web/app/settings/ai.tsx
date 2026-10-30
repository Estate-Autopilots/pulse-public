"use client";
// CONNECT-AI (owner, 23 Oct 2026): Settings → AI, for admins and leadership. The AI the organisation's AI employees
// use, and where they run:
//  * Connected AI: subscriptions it already pays for (Claude through Claude Code's own sign-in, ChatGPT through Codex's
//    device code; Gemini CLI and Antigravity are listed honestly as not available for servers yet) and API keys of any
//    provider (sealed, shown only as ••••last4, checked with one call before they are kept, with an optional monthly cap);
//  * Agent workspaces: the Pulse cloud workspace (this server) and the organisation's own servers over SSH, with a key
//    Pulse makes (the public half to paste into authorized_keys) or its own deploy key; checked and shown with health.
// Each connect flow is a few numbered steps; every status says what Pulse knows and nothing more.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Bot, CircleAlert, CircleCheck, Clock3, Cloud, Copy, Cpu, ExternalLink, HardDrive, KeyRound, LoaderCircle, MemoryStick, Plug, RefreshCw, Server, ShieldCheck, Sparkles, Terminal, Trash2, type LucideIcon } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { ago } from "../lib/format";
import { post } from "../records";
import { Badge, Empty, Panel, Skeleton, styles } from "../ui";
import css from "./ai.module.css";
import { modelName } from "../people/ai/[id]/model";
import { SelectField } from "../kit/select-field";

type State = "connected" | "out_of_quota" | "expired" | "error";
type Conn = { id: string; kind: "subscription" | "api"; provider: string; providerName: string; name: string; account: string | null; masked?: string | null; baseUrl?: string | null;
  models?: string[]; model?: string | null; workspaceId?: string | null; cap?: number | null; used?: number; state: State; detail: string | null; until: string | null;
  checkedAt: string | null; createdAt?: string; createdBy?: string | null; agents: number; builtin?: boolean };
type Facts = { os?: string; host?: string; cpus?: number; memMb?: number; memFreeMb?: number; diskFreeMb?: number; diskMb?: number; load?: number; tools?: Record<string, string> };
type Workspace = { id: string; name: string; host: string; port?: number; username?: string; keySource?: "generated" | "pasted"; publicKey?: string; state: "new" | "ok" | "error";
  facts: Facts | null; error: string | null; checkedAt: string | null; pinned?: boolean; agents?: number; connections?: number; builtin?: boolean };
type Provider = { key: string; name: string; paid: boolean; keyHint: string; keysAt: string | null; needsUrl: boolean };
type Sub = { key: string; name: string; plan: string; how: string; available: boolean };
type SignIn = { id: string; provider: "claude" | "codex"; url: string | null; code: string | null; expiresAt: string };
type Data = { paidApiKeys: boolean; installOrg: boolean; connections: Conn[]; server: Conn[]; workspaces: Workspace[]; cloud: Workspace; providers: Provider[]; subscriptions: Sub[]; signin: SignIn[] };

const STATE: Record<State, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  connected: { label: "Connected", tone: "success" }, out_of_quota: { label: "Out of quota", tone: "warning" }, expired: { label: "Signed out", tone: "danger" }, error: { label: "Needs attention", tone: "danger" },
};
const WS_STATE = { ok: { label: "Healthy", tone: "success" }, new: { label: "Waiting for the key", tone: "warning" }, error: { label: "Can't reach it", tone: "danger" } } as const;
const at = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const n = (x: number) => x.toLocaleString("en-IN");
const gb = (mb?: number) => mb === undefined ? "—" : mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb} MB`;
const why = (e: unknown) => e instanceof Error ? e.message : "That did not work. Try again.";
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { cache: "no-store" }); const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? "Pulse could not load this. Try again."); return d as T;
}
function copy(text: string, what: string) { void navigator.clipboard.writeText(text).then(() => notify({ id: "ai-copy", tone: "success", title: `${what} copied`, timeout: 2000 })); }

/** Connection status in words: what Pulse knows, with the time it resets when the provider said so. */
function StateLine({ c }: { c: Pick<Conn, "state" | "detail" | "until" | "checkedAt"> }) {
  const s = STATE[c.state] ?? STATE.error;
  const Icon = c.state === "connected" ? CircleCheck : c.state === "out_of_quota" ? Clock3 : CircleAlert;
  const text = c.state === "out_of_quota" ? `Out of quota${c.until ? ` until ${at(c.until)}` : ""}. Work waits and starts again then.`
    : c.state === "expired" ? "The sign-in or key was refused. Sign in again or replace the key."
    : c.state === "error" ? c.detail ?? "The last check failed." : c.checkedAt ? `${c.detail ?? "Checked"} · ${ago(c.checkedAt)}` : "Not tested yet";
  return <p className={css.state} data-tone={s.tone}><Icon size={14} aria-hidden="true" /><span>{text}</span></p>;
}

export function AiSettings() {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState("");
  const [adding, setAdding] = useState<null | "connect" | "server">(null);
  const load = useCallback(() => get<Data>("ai").then((d) => { setData(d); setError(""); }).catch((e) => setError(why(e))), []);
  useEffect(() => { void load(); }, [load]);
  if (error && !data) return <Panel title="AI"><Empty icon={CircleAlert} title="Settings → AI did not load" text={error}><button className={styles.btn} onClick={() => void load()}>Try again</button></Empty></Panel>;
  if (!data) return <div className={css.stack}><Skeleton height={120} /><Skeleton height={220} /><Skeleton height={160} /></div>;
  const all = [...data.server, ...data.connections];
  const workspaces = [data.cloud, ...data.workspaces];
  const wsName = (id?: string | null) => id ? data.workspaces.find((w) => w.id === id)?.name ?? "A removed workspace" : "Pulse cloud workspace";
  return <div className={css.stack} data-grow="">
    <section className={css.hero} aria-label="AI for your AI employees">
      <span className={css.heroIcon}><Sparkles size={18} aria-hidden="true" /></span>
      <div><h2>AI for your AI employees</h2>
        <p>Connect the AI they think with: a subscription you already pay for, or an API key from any provider. Then choose it on each AI employee&apos;s AI tab. Secrets are encrypted at rest and never shown again.</p></div>
      <div className={css.heroActions}>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setAdding(adding === "connect" ? null : "connect")}><Plug size={14} aria-hidden="true" />Connect an AI</button>
        <button className={styles.btn} onClick={() => setAdding(adding === "server" ? null : "server")}><Server size={14} aria-hidden="true" />Add a server</button>
      </div>
    </section>
    <Policy data={data} onSaved={() => void load()} />
    {adding === "connect" ? <ConnectFlow data={data} onDone={() => { setAdding(null); void load(); }} onCancel={() => setAdding(null)} /> : null}
    <Panel title="Connected AI" sub={all.length ? `${all.filter((c) => c.state === "connected").length} of ${all.length} ready` : "Nothing connected yet"}>
      {all.length ? <div className={css.grid}>{all.map((c) => <ConnectionCard key={c.id} c={c} workspace={c.builtin ? "Pulse cloud workspace" : wsName(c.workspaceId)} workspaces={workspaces} onChanged={() => void load()} />)}</div>
        : <Empty icon={Bot} first title="No AI connected yet" text="Your AI employees need an AI to think with. Sign in with a Claude or ChatGPT subscription you already pay for, or add an API key.">
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => setAdding("connect")}>Connect an AI</button></Empty>}
    </Panel>
    {adding === "server" ? <AddServer onDone={() => { setAdding(null); void load(); }} onCancel={() => setAdding(null)} /> : null}
    <Panel title="Agent workspaces" sub="Where your AI employees run. Subscriptions run their CLI on the workspace; API keys are called from Pulse.">
      <div className={css.grid}>{workspaces.map((w) => <WorkspaceCard key={w.id} w={w} onChanged={() => void load()} />)}</div>
      {!data.workspaces.length ? <p className={css.hint}><Server size={14} aria-hidden="true" />Have your own VPS? <button className={css.linkish} onClick={() => setAdding("server")}>Add a server</button> and your AI employees can run there instead.</p> : null}
    </Panel>
  </div>;
}

/** Paid API keys on or off (Estate Autopilots: subscriptions only). A custom OpenAI-compatible address stays allowed. */
function Policy({ data, onSaved }: { data: Data; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  async function set(on: boolean) {
    setBusy(true);
    try { await post("ai/policy", { paidApiKeys: on }); onSaved(); notify({ id: "ai-policy", tone: "success", title: on ? "Paid API keys are allowed" : "Subscriptions only", timeout: 2500 }); }
    catch (e) { notify({ id: "ai-policy", tone: "error", title: "Not changed", message: why(e) }); } finally { setBusy(false); }
  }
  return <label className={css.policy} data-on={data.paidApiKeys ? "" : undefined}>
    <ShieldCheck size={16} aria-hidden="true" />
    <span><b>{data.paidApiKeys ? "Subscriptions and paid API keys" : "Subscriptions only"}</b>
      <small>{data.paidApiKeys ? "Admins may add API keys that bill per token. Each key can have a monthly limit." : "Your AI employees run on the subscriptions you already pay for. Paid API keys are off; a self-hosted model (custom OpenAI-compatible address) is still allowed."}</small></span>
    <input type="checkbox" role="switch" aria-label="Allow paid API keys" checked={data.paidApiKeys} disabled={busy} onChange={(e) => void set(e.target.checked)} />
  </label>;
}

function ConnectionCard({ c, workspace, workspaces, onChanged }: { c: Conn; workspace: string; workspaces: Workspace[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<"" | "test" | "remove" | "save">(""), [edit, setEdit] = useState(false), [confirm, setConfirm] = useState(false);
  const s = STATE[c.state] ?? STATE.error;
  async function test() {
    setBusy("test");
    try { const r = await post<{ ok: boolean; state: State; detail: string }>(`ai/connections/${c.id}/test`, {});
      notify({ id: `ai-test-${c.id}`, tone: r.ok ? "success" : r.state === "out_of_quota" ? "info" : "error", title: r.ok ? `${c.name} answered` : `${c.name}: ${STATE[r.state]?.label ?? "failed"}`, message: r.ok ? undefined : r.detail }); onChanged(); }
    catch (e) { notify({ id: `ai-test-${c.id}`, tone: "error", title: "Test failed", message: why(e) }); } finally { setBusy(""); }
  }
  async function remove() {
    setBusy("remove");
    try { await post(`ai/connections/${c.id}/disconnect`, {}); notify({ id: "ai-remove", tone: "success", title: `${c.name} disconnected`, message: "Its secret was destroyed.", timeout: 3000 }); onChanged(); }
    catch (e) { notify({ id: "ai-remove", tone: "error", title: "Not disconnected", message: why(e) }); } finally { setBusy(""); setConfirm(false); }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy("save");
    try { await post(`ai/connections/${c.id}`, { name: f.get("name"), model: f.get("model") ?? undefined, monthlyTokenCap: f.get("cap") ? Number(f.get("cap")) : null, workspaceId: f.get("workspaceId") ?? undefined });
      setEdit(false); onChanged(); notify({ id: "ai-save", tone: "success", title: "Saved", timeout: 2000 }); }
    catch (err) { notify({ id: "ai-save", tone: "error", title: "Not saved", message: why(err) }); } finally { setBusy(""); }
  }
  const Icon: LucideIcon = c.kind === "api" ? KeyRound : c.provider === "claude" ? Sparkles : Bot;
  return <article className={css.card} data-state={c.state} aria-label={c.name}>
    <div className={css.top}><span className={css.icon} data-provider={c.provider}><Icon size={17} strokeWidth={1.75} aria-hidden="true" /></span>
      <span className={css.name}><small className={css.kind}>{c.kind === "api" ? "API key" : "Subscription"}{c.builtin ? " · this server's sign-in" : ""}</small><b>{c.name}</b>
        <small>{c.account ?? (c.masked ? `${c.providerName} · key ${c.masked}` : c.providerName)}</small></span>
      <Badge tone={s.tone}>{s.label}</Badge></div>
    <StateLine c={c} />
    <dl className={css.facts}>
      <div><dt>Runs on</dt><dd>{c.kind === "api" ? "Called from Pulse" : workspace}</dd></div>
      <div><dt>Used by</dt><dd>{c.agents ? `${c.agents} AI employee${c.agents === 1 ? "" : "s"}` : "No one yet"}</dd></div>
      {c.kind === "api" ? <div><dt>This month</dt><dd>{n(c.used ?? 0)} tokens{c.cap ? ` of ${n(c.cap)}` : ""}</dd></div> : <div><dt>Billing</dt><dd>Your plan · no per-token cost</dd></div>}
      {c.kind === "api" ? <div><dt>Model</dt><dd title={c.model ?? undefined}>{c.model ? modelName(c.model) : "—"}{c.models?.length ? <small> · {c.models.length} available</small> : null}</dd></div> : null}
    </dl>
    {c.kind === "api" && c.cap ? <div className={css.meter} role="meter" aria-label="Monthly tokens used" aria-valuemin={0} aria-valuemax={c.cap} aria-valuenow={c.used ?? 0}><span style={{ width: `${Math.min(100, ((c.used ?? 0) / c.cap) * 100)}%` }} /></div> : null}
    {edit ? <form className={css.form} onSubmit={save}>
      <label className={styles.field}>Name<input name="name" defaultValue={c.name} maxLength={80} required /></label>
      {c.kind === "api" ? <><label className={styles.field}>Model<SelectField name="model" defaultValue={c.model ?? ""}>{(c.models ?? []).map((m) => <option key={m} value={m}>{modelName(m)}</option>)}</SelectField></label>
        <label className={styles.field}>Monthly limit (tokens, optional)<input name="cap" type="number" min={1000} step={1000} defaultValue={c.cap ?? ""} placeholder="No limit" /></label></>
        : <label className={styles.field}>Runs on<SelectField name="workspaceId" defaultValue={c.workspaceId ?? "cloud"}>{workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</SelectField></label>}
      <div className={css.row}><button className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={!!busy}>{busy === "save" ? "Saving…" : "Save"}</button><button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setEdit(false)}>Cancel</button></div>
    </form> : null}
    {confirm ? <div className={css.confirm} role="alertdialog" aria-label={`Disconnect ${c.name}?`}><p><b>Disconnect {c.name}?</b> Its secret is destroyed at once.{c.agents ? ` ${c.agents} AI employee${c.agents === 1 ? " uses" : "s use"} it and will stop until you choose another AI for ${c.agents === 1 ? "it" : "them"}.` : ""}</p>
      <div className={css.row}><button className={`${styles.btn} ${styles.btnDanger} ${styles.btnSmall}`} disabled={!!busy} onClick={() => void remove()}>{busy === "remove" ? "Disconnecting…" : "Disconnect"}</button><button className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setConfirm(false)}>Keep it</button></div></div> : null}
    <div className={css.foot}>
      <button className={`${styles.btn} ${styles.btnSmall}`} disabled={!!busy} onClick={() => void test()}>{busy === "test" ? <LoaderCircle size={13} className={css.spin} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}{busy === "test" ? "Testing…" : "Test"}</button>
      {!c.builtin && !edit ? <button className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setEdit(true)}>Edit</button> : null}
      {!c.builtin && !confirm ? <button className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setConfirm(true)}><Trash2 size={13} aria-hidden="true" />Disconnect</button> : null}
      {c.builtin ? <small className={css.muted}>Signed in on this server by the operator</small> : c.createdBy ? <small className={css.muted}>Added by {c.createdBy}{c.createdAt ? ` · ${ago(c.createdAt)}` : ""}</small> : null}
    </div>
  </article>;
}

function Steps({ items }: { items: { title: string; body?: ReactNode; done?: boolean; active?: boolean }[] }) {
  return <ol className={css.steps}>{items.map((s, i) => <li key={s.title} data-done={s.done ? "" : undefined} data-active={s.active ? "" : undefined}>
    <span className={css.stepNo} aria-hidden="true">{s.done ? <CircleCheck size={14} /> : i + 1}</span><div><b>{s.title}</b>{s.body ? <div className={css.stepBody}>{s.body}</div> : null}</div></li>)}</ol>;
}

/** Connect an AI: choose a subscription or an API key, then a few numbered steps. */
function ConnectFlow({ data, onDone, onCancel }: { data: Data; onDone: () => void; onCancel: () => void }) {
  const [choice, setChoice] = useState<string>(data.signin[0]?.provider ?? "");
  const sub = data.subscriptions.find((s) => s.key === choice), prov = data.providers.find((p) => p.key === choice);
  return <Panel title="Connect an AI" sub="Choose what you already have" tools={<button className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={onCancel}>Close</button>}>
    <div className={css.connect}>
      <div className={css.choose}>
        <h3>Use a subscription <small>No API billing: runs on the plan you already pay for</small></h3>
        <div className={css.options}>{data.subscriptions.map((s) => <button key={s.key} type="button" className={css.option} aria-pressed={choice === s.key} disabled={!s.available} onClick={() => setChoice(s.key)}>
          <b>{s.name}</b><small>{s.plan}</small>{s.available ? null : <em>{s.key === "antigravity" ? "Not available for servers" : "Coming soon"}</em>}</button>)}</div>
        {data.subscriptions.filter((s) => !s.available).map((s) => <p key={s.key} className={css.hint}><CircleAlert size={13} aria-hidden="true" /><span><b>{s.name}:</b> {s.how}</span></p>)}
        <h3>Or add an API key <small>{data.paidApiKeys ? "Billed by the provider per token" : "Paid keys are off for this organisation (subscriptions only)"}</small></h3>
        <div className={css.options}>{data.providers.map((p) => <button key={p.key} type="button" className={css.option} aria-pressed={choice === p.key} disabled={p.paid && !data.paidApiKeys} onClick={() => setChoice(p.key)}>
          <b>{p.name}</b><small>{p.needsUrl ? "Any OpenAI-compatible server" : p.paid ? "API key" : ""}</small>{p.paid && !data.paidApiKeys ? <em>Off: subscriptions only</em> : null}</button>)}</div>
      </div>
      <div className={css.flow} aria-live="polite">
        {sub?.key === "claude" ? <ClaudeFlow data={data} onDone={onDone} /> : sub?.key === "codex" ? <CodexFlow data={data} onDone={onDone} /> : prov ? <KeyFlow p={prov} onDone={onDone} />
          : <div className={css.placeholder}><Plug size={18} aria-hidden="true" /><p>Choose a subscription or a provider on the left. Pulse checks it before it is kept.</p></div>}
      </div>
    </div>
  </Panel>;
}

function WorkspacePick({ data, name = "workspaceId" }: { data: Data; name?: string }) {
  return <label className={styles.field}>Runs on<SelectField name={name} defaultValue="cloud"><option value="cloud">Pulse cloud workspace</option>{data.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}{w.state !== "ok" ? " (not checked yet)" : ""}</option>)}</SelectField></label>;
}

function ClaudeFlow({ data, onDone }: { data: Data; onDone: () => void }) {
  const [session, setSession] = useState<SignIn | null>(data.signin.find((s) => s.provider === "claude") ?? null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState(""), [paste, setPaste] = useState(false), [opened, setOpened] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  async function start() {
    setBusy(true); setErr("");
    const f = new FormData(form.current ?? undefined);
    try { setSession(await post<SignIn>("ai/signin", { provider: "claude", name: f.get("name") || "Claude", workspaceId: f.get("workspaceId") })); }
    catch (e) { setErr(why(e)); } finally { setBusy(false); }
  }
  async function finish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setErr("");
    try {
      const r = paste ? await post<{ connection: Conn }>("ai/subscriptions", { provider: "claude", token: f.get("token"), name: f.get("name") || "Claude", workspaceId: f.get("workspaceId") })
        : await post<{ connection: Conn }>(`ai/signin/${session!.id}/code`, { code: f.get("code") });
      notify({ id: "ai-connect", tone: "success", title: `${r.connection.name} connected`, message: r.connection.account ?? undefined, timeout: 4000 }); onDone();
    } catch (e2) { setErr(why(e2)); if (!paste) setSession(null); } finally { setBusy(false); }
  }
  return <form ref={form} className={css.form} onSubmit={finish} aria-label="Connect Claude">
    <h3><Sparkles size={16} aria-hidden="true" />Claude · Pro, Max or Team</h3>
    {!session || paste ? <><label className={styles.field}>Name<input name="name" defaultValue="Claude" maxLength={80} /></label><WorkspacePick data={data} /></> : null}
    {paste ? <Steps items={[
      { title: "On a computer with Claude Code, run", body: <code className={css.cmd}>claude setup-token</code>, done: false },
      { title: "Sign in with your Claude account when it asks", body: "It prints a long-lived token (valid one year) that starts with sk-ant-oat01-." },
      { title: "Paste the token here", active: true, body: <input name="token" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-oat01-…" aria-label="Claude token" required /> }]} />
      : <Steps items={[
        { title: "Start the sign-in", done: !!session, active: !session, body: session ? "Pulse started Claude Code's sign-in on the server." : <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Start sign-in"}</button> },
        { title: "Sign in with your Claude account", done: opened, active: !!session && !opened, body: session?.url ? <a className={`${styles.btn} ${styles.btnSmall}`} href={session.url} target="_blank" rel="noreferrer noopener" onClick={() => setOpened(true)}><ExternalLink size={13} aria-hidden="true" />Open Claude sign-in</a> : "A link appears here." },
        { title: "Copy the code Claude shows, and paste it here", active: opened, body: session ? <input name="code" autoComplete="off" spellCheck={false} placeholder="Paste the code" aria-label="Code from Claude" required /> : "After you sign in, Claude shows a code to copy." }]} />}
    {err ? <p role="alert" className={css.error}>{err}</p> : null}
    <div className={css.row}>
      {paste || session ? <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Connecting…" : "Connect Claude"}</button> : null}
      <button type="button" className={css.linkish} onClick={() => { setPaste(!paste); setErr(""); }}>{paste ? "Sign in from Pulse instead" : "I already have a token from claude setup-token"}</button>
    </div>
    <p className={css.note}>Pulse keeps the token encrypted and uses it only for your AI employees&apos; runs. It is never shown again. Usage counts against your Claude plan&apos;s limits.</p>
  </form>;
}

function CodexFlow({ data, onDone }: { data: Data; onDone: () => void }) {
  const [session, setSession] = useState<SignIn | null>(data.signin.find((s) => s.provider === "codex") ?? null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const form = useRef<HTMLFormElement>(null);
  async function start() {
    setBusy(true); setErr(""); const f = new FormData(form.current ?? undefined);
    try { setSession(await post<SignIn>("ai/signin", { provider: "codex", name: f.get("name") || "ChatGPT · Codex", workspaceId: f.get("workspaceId") })); }
    catch (e) { setErr(why(e)); } finally { setBusy(false); }
  }
  useEffect(() => {
    if (!session) return; let live = true;
    const tick = async () => {
      if (!live) return;
      try { const r = await get<{ state: string; error?: string; connection?: Conn }>(`ai/signin/${session.id}`);
        if (r.state === "connected" && r.connection) { notify({ id: "ai-connect", tone: "success", title: `${r.connection.name} connected`, message: r.connection.account ?? undefined, timeout: 4000 }); onDone(); return; }
        if (r.state === "failed") { setErr(r.error ?? "The sign-in did not finish."); setSession(null); return; } }
      catch (e) { setErr(why(e)); setSession(null); return; }
      setTimeout(() => void tick(), 3000);
    };
    const t = setTimeout(() => void tick(), 3000);
    return () => { live = false; clearTimeout(t); };
  }, [session, onDone]);
  return <form ref={form} className={css.form} onSubmit={(e) => { e.preventDefault(); void start(); }} aria-label="Connect ChatGPT Codex">
    <h3><Bot size={16} aria-hidden="true" />ChatGPT · Codex</h3>
    {!session ? <><label className={styles.field}>Name<input name="name" defaultValue="ChatGPT · Codex" maxLength={80} /></label><WorkspacePick data={data} /></> : null}
    <Steps items={[
      { title: "Get a one-time code", done: !!session, active: !session, body: session ? "Pulse started Codex's device sign-in on the server." : <button className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={busy}>{busy ? "Starting…" : "Get a code"}</button> },
      { title: "Open the ChatGPT sign-in page", active: !!session, body: session?.url ? <a className={`${styles.btn} ${styles.btnSmall}`} href={session.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={13} aria-hidden="true" />{session.url.replace("https://", "")}</a> : "A link appears here." },
      { title: "Enter this code and sign in", active: !!session, body: session?.code ? <span className={css.code}><b>{session.code}</b><button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => copy(session.code!, "Code")}><Copy size={13} aria-hidden="true" />Copy</button></span> : "The code appears here; it works for 15 minutes." },
      { title: "Pulse connects it by itself", body: session ? <span className={css.waiting}><LoaderCircle size={14} className={css.spin} aria-hidden="true" />Waiting for you to finish signing in…</span> : "No need to come back and press anything." }]} />
    {err ? <p role="alert" className={css.error}>{err}</p> : null}
    {session ? <button type="button" className={css.linkish} onClick={() => { void post(`ai/signin/${session.id}/cancel`, {}); setSession(null); }}>Cancel and start again</button> : null}
    <p className={css.note}>Never enter a code someone else sent you. Pulse keeps the sign-in encrypted; usage counts against your ChatGPT plan.</p>
  </form>;
}

function KeyFlow({ p, onDone }: { p: Provider; onDone: () => void }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setErr("");
    try { const r = await post<{ connection: Conn }>("ai/keys", { provider: p.key, name: f.get("name"), key: f.get("key"), baseUrl: f.get("baseUrl") ?? undefined, model: f.get("model"), monthlyTokenCap: f.get("cap") ? Number(f.get("cap")) : null });
      notify({ id: "ai-connect", tone: "success", title: `${r.connection.name} connected`, message: `Key ${r.connection.masked ?? ""} · ${r.connection.models?.length ?? 0} models`, timeout: 4000 }); onDone(); }
    catch (e2) { setErr(why(e2)); } finally { setBusy(false); }
  }
  return <form className={css.form} onSubmit={save} aria-label={`Add a ${p.name} key`} key={p.key}>
    <h3><KeyRound size={16} aria-hidden="true" />{p.name}</h3>
    <Steps items={[
      { title: p.keysAt ? "Create a key with the provider" : "Have your server's address and key ready", body: p.keysAt ? <a href={p.keysAt} target="_blank" rel="noreferrer noopener" className={css.linkish}>{p.keysAt.replace("https://", "")} <ExternalLink size={12} aria-hidden="true" /></a> : "Any server that speaks the OpenAI chat API: vLLM, Ollama, LM Studio, LiteLLM and others." },
      { title: "Paste it here", active: true, body: <div className={css.fields}>
        <label className={styles.field}>Name<input name="name" defaultValue={p.name} maxLength={80} /></label>
        {p.needsUrl ? <label className={styles.field}>Address<input name="baseUrl" required placeholder="https://llm.example.com/v1" inputMode="url" /></label> : null}
        <label className={styles.field}>API key<input name="key" type="password" autoComplete="off" spellCheck={false} required placeholder={p.keyHint} /></label>
        <label className={styles.field}>Model <small className={css.muted}>(optional: the first listed is used)</small><input name="model" spellCheck={false} placeholder="Pulse lists the models after the check" /></label>
        <label className={styles.field}>Monthly limit in tokens <small className={css.muted}>(optional)</small><input name="cap" type="number" min={1000} step={1000} placeholder="No limit" /></label></div> },
      { title: "Pulse checks it", body: "It lists the models your key can use and sends one tiny test message. Nothing is kept if the check fails." }]} />
    {err ? <p role="alert" className={css.error}>{err}</p> : null}
    <div className={css.row}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? <><LoaderCircle size={14} className={css.spin} aria-hidden="true" />Checking…</> : "Check and connect"}</button></div>
    <p className={css.note}>The key is encrypted before it is stored and is never shown again (only its last four characters).</p>
  </form>;
}

function WorkspaceCard({ w, onChanged }: { w: Workspace; onChanged: () => void }) {
  const [busy, setBusy] = useState<"" | "check" | "remove">(""), [confirm, setConfirm] = useState(false);
  const s = WS_STATE[w.state];
  async function check() {
    setBusy("check");
    try { const r = await post<{ workspace: Workspace }>(`ai/workspaces/${w.id}/verify`, {}); const ok = r.workspace.state === "ok";
      notify({ id: `ws-${w.id}`, tone: ok ? "success" : "error", title: ok ? `${w.name} is reachable` : `${w.name}: can't reach it`, message: ok ? undefined : r.workspace.error ?? undefined }); onChanged(); }
    catch (e) { notify({ id: `ws-${w.id}`, tone: "error", title: "Check failed", message: why(e) }); } finally { setBusy(""); }
  }
  async function remove() {
    setBusy("remove");
    try { await post(`ai/workspaces/${w.id}/remove`, {}); notify({ id: "ws-remove", tone: "success", title: `${w.name} removed`, message: "Its key was destroyed. Remove Pulse's public key from the server too.", timeout: 4000 }); onChanged(); }
    catch (e) { notify({ id: "ws-remove", tone: "error", title: "Not removed", message: why(e) }); } finally { setBusy(""); setConfirm(false); }
  }
  const f = w.facts, tools = Object.entries(f?.tools ?? {});
  return <article className={css.card} data-state={w.state === "ok" ? "connected" : w.state === "new" ? "out_of_quota" : "error"} aria-label={w.name}>
    <div className={css.top}><span className={css.icon}>{w.builtin ? <Cloud size={17} strokeWidth={1.75} aria-hidden="true" /> : <Server size={17} strokeWidth={1.75} aria-hidden="true" />}</span>
      <span className={css.name}><small className={css.kind}>{w.builtin ? "Built in · default" : "Your server"}</small><b>{w.name}</b>
        <small className={styles.mono}>{w.builtin ? `This Pulse server (${w.host})` : `${w.username}@${w.host}${w.port && w.port !== 22 ? `:${w.port}` : ""}`}</small></span>
      <Badge tone={s.tone}>{s.label}</Badge></div>
    {w.state === "ok" && f ? <div className={css.health}>
      <span title="Processors"><Cpu size={13} aria-hidden="true" />{f.cpus ?? "—"} CPU{f.load !== undefined ? ` · load ${f.load}` : ""}</span>
      <span title="Memory free of total"><MemoryStick size={13} aria-hidden="true" />{gb(f.memFreeMb)} free of {gb(f.memMb)}</span>
      <span title="Disk free"><HardDrive size={13} aria-hidden="true" />{gb(f.diskFreeMb)} free</span>
    </div> : null}
    {w.state === "ok" && tools.length ? <div className={css.tools} aria-label="Installed">{tools.map(([t, v]) => <span key={t} title={v || t}><Terminal size={11} aria-hidden="true" />{t}</span>)}</div> : null}
    {w.state === "ok" && f && !f.tools?.claude && !f.tools?.codex ? <p className={css.hint}><CircleAlert size={13} aria-hidden="true" /><span>Neither Claude Code nor Codex is installed here: subscriptions cannot run on it yet (npm i -g @anthropic-ai/claude-code @openai/codex).</span></p> : null}
    {w.error ? <p className={css.state} data-tone={w.state === "ok" ? "warning" : "danger"}><CircleAlert size={14} aria-hidden="true" /><span>{w.error}</span></p> : null}
    {!w.builtin && w.state !== "ok" && w.publicKey ? <div className={css.pubkey}>
      <p><b>Add Pulse&apos;s key to the server.</b> As <span className={styles.mono}>{w.username}</span> on {w.host}, run:</p>
      <code className={css.cmd}>{`mkdir -p ~/.ssh && echo '${w.publicKey}' >> ~/.ssh/authorized_keys`}</code>
      <div className={css.row}><button className={`${styles.btn} ${styles.btnSmall}`} onClick={() => copy(`mkdir -p ~/.ssh && echo '${w.publicKey}' >> ~/.ssh/authorized_keys`, "Command")}><Copy size={13} aria-hidden="true" />Copy command</button>
        <button className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => copy(w.publicKey!, "Public key")}>Copy key only</button></div></div> : null}
    {confirm ? <div className={css.confirm} role="alertdialog" aria-label={`Remove ${w.name}?`}><p><b>Remove {w.name}?</b> Pulse destroys its key.{w.agents ? ` ${w.agents} AI employee${w.agents === 1 ? " runs" : "s run"} here and will move to the Pulse cloud workspace when you choose.` : ""}</p>
      <div className={css.row}><button className={`${styles.btn} ${styles.btnDanger} ${styles.btnSmall}`} disabled={!!busy} onClick={() => void remove()}>Remove</button><button className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setConfirm(false)}>Keep it</button></div></div> : null}
    <div className={css.foot}>
      <button className={`${styles.btn} ${styles.btnSmall} ${w.state === "new" ? styles.btnPrimary : ""}`} disabled={!!busy} onClick={() => void check()}>{busy === "check" ? <LoaderCircle size={13} className={css.spin} aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}{busy === "check" ? "Checking…" : w.state === "new" ? "Check connection" : "Check now"}</button>
      {!w.builtin && !confirm ? <button className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setConfirm(true)}><Trash2 size={13} aria-hidden="true" />Remove</button> : null}
      <small className={css.muted}>{w.checkedAt ? `Checked ${ago(w.checkedAt)}` : "Not checked yet"}{w.pinned ? " · host key pinned" : ""}</small>
    </div>
  </article>;
}

function AddServer({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [mode, setMode] = useState<"generate" | "paste">("generate"), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setErr("");
    try { const r = await post<{ workspace: Workspace }>("ai/workspaces", { name: f.get("name"), host: f.get("host"), port: Number(f.get("port") || 22), username: f.get("username"), keyMode: mode, privateKey: mode === "paste" ? f.get("privateKey") : undefined });
      notify({ id: "ws-add", tone: "success", title: `${r.workspace.name} added`, message: mode === "generate" ? "Add Pulse's public key to the server, then check the connection." : "Now check the connection.", timeout: 5000 }); onDone(); }
    catch (e2) { setErr(why(e2)); } finally { setBusy(false); }
  }
  return <Panel title="Add a server" sub="A VPS or machine your AI employees can run on, reached over SSH" tools={<button className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={onCancel}>Close</button>}>
    <form className={`${css.form} ${css.wide}`} onSubmit={save} aria-label="Add a server">
      <Steps items={[
        { title: "Where it is", active: true, body: <div className={css.fields} data-cols="">
          <label className={styles.field}>Name<input name="name" placeholder="e.g. Agents VPS" maxLength={80} /></label>
          <label className={styles.field}>Address<input name="host" required placeholder="vps.example.com or 203.0.113.7" spellCheck={false} autoCapitalize="off" /></label>
          <label className={styles.field}>SSH port<input name="port" type="number" min={1} max={65535} defaultValue={22} /></label>
          <label className={styles.field}>User<input name="username" required placeholder="pulse" spellCheck={false} autoCapitalize="off" /></label></div> },
        { title: "How Pulse signs in", body: <div className={css.fields}>
          <div className={css.segment} role="radiogroup" aria-label="Key">
            <label><input type="radio" name="mode" checked={mode === "generate"} onChange={() => setMode("generate")} /><span><b>Pulse makes a key</b><small>Recommended. You paste its public half on the server.</small></span></label>
            <label><input type="radio" name="mode" checked={mode === "paste"} onChange={() => setMode("paste")} /><span><b>Use my deploy key</b><small>A private key without a passphrase, made for Pulse.</small></span></label></div>
          {mode === "paste" ? <label className={styles.field}>Private key<textarea name="privateKey" rows={5} required spellCheck={false} placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"} className={styles.mono} /></label> : null}</div> },
        { title: "Pulse checks it", body: "SSH, the system, CPUs, memory, disk, and whether Docker, Node, Python, Claude Code and Codex are installed. Its host key is pinned on first contact." }]} />
      {err ? <p role="alert" className={css.error}>{err}</p> : null}
      <div className={css.row}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "Adding…" : "Add server"}</button>
        <small className={css.muted}>The private key is encrypted before it is stored and never shown. Give Pulse its own user on the server, without sudo.</small></div>
    </form>
  </Panel>;
}

