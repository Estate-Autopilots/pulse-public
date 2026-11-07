"use client";
// AGENT-API (owner, 4 Nov 2026: "the strongest possible API, MCP and CLI"): Settings → API keys. Everyone makes personal
// tokens for their own scripts and the pulse CLI (they act as you); admins also make bot keys for an AI member (Wise
// Life's Bhrata acts as that member, never as a person). A token is shown once, with how to use it; rotate gives a new
// secret and stops the old one at once; revoke stops it. Cards follow Work → My day: a left colour stripe per kind.
import { useEffect, useState } from "react";
import { Bot, Copy, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Badge, Empty, Panel, Skeleton, styles } from "../ui";
import { ago } from "../lib/format";
import css from "./api-keys.module.css";
import { useWords } from "../org-code";
import { say } from "../lib/words.mjs";
import { Webhooks } from "./webhooks";

type Token = { id: string; kind: "personal" | "bot"; name: string; scopes: string[]; personId: string; person: string; mine: boolean; canRotate?: boolean; createdAt: string; createdBy: string | null;
  expiresAt: string; lastUsedAt: string | null; days: number; expired: boolean };
// API-PLATFORM (1564): the company's API tier is a ceiling on what a new key may hold; areas outside it are shown, greyed out.
type Plan = { tier: "free" | "pro" | "business" | "enterprise"; scopes: string[]; botKeys: number; botKeysLive: number; perMinute: number;
  /** API-PLATFORM-2 (1595): after a downgrade, calls run at the old tier until graceUntil. */ callTier?: "free" | "pro" | "business" | "enterprise"; graceUntil?: string | null };
type Data = { tokens: Token[]; scopes: { key: string; label: string }[]; admin: boolean; agents: { id: string; name: string; title: string | null }[]; plan?: Plan };
type Shown = { name: string; token: string };

async function send<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "Pulse couldn’t do that just now. Try again.");
  return data as T;
}
// DE-EA: written once for every company; the screen says them in the company's own words (say, useWords).
const AREA_WORDS: Record<string, string> = { tasks: "Tasks", projects: "{Projects}", people: "People & calendar", chats: "Chats", billing: "Billing", companies: "{Clients} & leads",
  search: "Search", events: "Events & bug reports", docs: "Documents", workflows: "Workflows", finance: "Finance ledger", hr: "Leave & attendance" };
const TIER_WORDS: Record<Plan["tier"], string> = { free: "Free", pro: "Pro", business: "Business", enterprise: "Enterprise" };
// What a bot like Bhrata needs to quote and follow up; the person ticks fewer if they want.
const STARTER = ["tasks.read", "tasks.write", "projects.read", "people.read", "search.read", "companies.read", "companies.write", "billing.read", "billing.write", "chats.read"];
const until = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export function ApiKeys({ origin }: { origin: string }) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState<string | null>(null);
  const words = useWords(), area = (a: string) => say(AREA_WORDS[a] ?? a, words);
  const [shown, setShown] = useState<Shown | null>(null), [form, setForm] = useState<{ kind: "personal" | "bot"; name: string; agentId: string; scopes: string[]; days: number } | null>(null);
  useEffect(() => { send<Data>("api-tokens").then(setData).catch((e: Error) => setError(e.message)); }, []);
  const run = async (key: string, what: () => Promise<{ tokens: Token[]; token?: string }>, title: string, name?: string) => {
    setBusy(key);
    try { const r = await what(); setData((d) => d && { ...d, tokens: r.tokens }); if (r.token && name) setShown({ name, token: r.token }); notify({ id: `api-key-${key}`, tone: "success", title, timeout: 3000 }); }
    catch (e) { notify({ id: `api-key-${key}`, tone: "error", title: "Not changed", message: (e as Error).message }); }
    finally { setBusy(null); }
  };
  if (error) return <Panel title="API keys"><p className={css.note}>{error}</p></Panel>;
  if (!data) return <Panel title="API keys"><div className={css.list}><Skeleton height={72} /><Skeleton height={72} /></div></Panel>;
  const personal = data.tokens.filter((t) => t.kind === "personal" && t.mine), bots = data.tokens.filter((t) => t.kind === "bot"), others = data.tokens.filter((t) => t.kind === "personal" && !t.mine);
  const areas = [...new Set(data.scopes.map((s) => s.key.split(".")[0]))];
  const inPlan = (s: string) => !data.plan || data.plan.scopes.includes(s);
  const start = (kind: "personal" | "bot") => setForm({ kind, name: kind === "bot" ? "" : "My scripts", agentId: data.agents[0]?.id ?? "", scopes: (kind === "bot" ? STARTER : ["tasks.read", "tasks.write", "projects.read", "people.read", "search.read"]).filter(inPlan), days: 90 });
  const create = () => form && run("new", () => send("api-tokens", { kind: form.kind, name: form.name, scopes: form.scopes, days: form.days, ...(form.kind === "bot" ? { agentId: form.agentId } : {}) }),
    form.kind === "bot" ? "Bot key made" : "Token made", form.name).then(() => setForm(null));
  const card = (t: Token) => <article key={t.id} className={`${css.card} ${t.kind === "bot" ? css.bot : css.personal}`} aria-label={t.name}>
    <header className={css.head}>{t.kind === "bot" ? <Bot size={16} aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}<b>{t.name}</b>
      {t.expired ? <Badge tone="danger">Expired</Badge> : <Badge tone="neutral">{t.kind === "bot" ? `Acts as ${t.person}` : t.mine ? "Acts as you" : `Acts as ${t.person}`}</Badge>}</header>
    <ul className={css.chips} aria-label="May use">{areas.filter((a) => t.scopes.some((s) => s.startsWith(a + "."))).map((a) =>
      <li key={a}>{area(a)} · {t.scopes.includes(`${a}.write`) ? "read & change" : "read"}</li>)}</ul>
    <p className={css.meta}>Made {ago(t.createdAt)}{t.createdBy && !t.mine ? ` by ${t.createdBy}` : ""} · {t.expired ? "expired" : `works until ${until(t.expiresAt)}`} · {t.lastUsedAt ? `last used ${ago(t.lastUsedAt)}` : "not used yet"}</p>
    <div className={css.actions}>
      {t.canRotate && <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy === t.id} onClick={() => { if (window.confirm(`Rotate “${t.name}”? A new secret is shown once and the old one stops working now.`)) void run(t.id, () => send(`api-tokens/${t.id}/rotate`, {}), "Rotated", t.name); }}><RefreshCw size={13} aria-hidden="true" /> Rotate</button>}
      <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy === t.id} onClick={() => { if (window.confirm(`Revoke “${t.name}”? Anything using it stops at once.`)) void run(t.id, () => send(`api-tokens/${t.id}/revoke`, {}), "Revoked"); }}><Trash2 size={13} aria-hidden="true" /> Revoke</button>
    </div>
  </article>;
  return <div className={css.stack} data-grow="">
    {data.admin && data.plan?.graceUntil && data.plan.callTier ? <p className={css.note} role="status">Your company’s plan changed to {TIER_WORDS[data.plan.tier]}. Keys keep the {TIER_WORDS[data.plan.callTier]} areas and request rate until {new Date(data.plan.graceUntil).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}; after that, areas outside {TIER_WORDS[data.plan.tier]} are refused.</p> : null}
    {shown ? <div className={css.secret} role="status">
      <p><b>{shown.name}</b>: copy it now. Pulse shows it once and keeps only a fingerprint. Keep it in a password manager or the bot’s secret settings, never in chat or a file in git.</p>
      <code className={css.token}>{shown.token}</code>
      <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} onClick={() => void navigator.clipboard.writeText(shown.token).then(() => notify({ id: "api-key-copy", tone: "success", title: "Copied", timeout: 2000 }))}><Copy size={13} aria-hidden="true" /> Copy</button>
        <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setShown(null)}>I’ve stored it</button></div>
      <details className={css.how}><summary>How to use it</summary>
        <p>API: send it as <code>Authorization: Bearer …</code> to <code>{origin}/api/v1/…</code> (reference at <a href="/developers">/developers</a>).</p>
        <p>CLI: <code>pulse login --token --host {origin}</code>, then paste it.</p>
        <p>MCP (Claude Code, Codex, a bot): server <code>{origin}/mcp</code> with the header <code>Authorization: Bearer …</code>.</p></details>
    </div> : null}
    {form ? <Panel title={form.kind === "bot" ? "New bot key" : "New personal token"} sub={form.kind === "bot" ? "The bot acts as the AI member you choose, with that member’s roles" : "It acts as you, with your roles; pick only the areas it needs"}>
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label className={css.field}><span>Name</span><input className={styles.input} required maxLength={60} value={form.name} placeholder={form.kind === "bot" ? "Bhrata on the wl server" : "My scripts"} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        {form.kind === "bot" ? <label className={css.field}><span>AI member</span>
          {data.agents.length ? <select className={styles.input} value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>{data.agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.title ? ` · ${a.title}` : ""}</option>)}</select>
            : <small className={css.note}>Add the AI member first in Settings → AI; the key acts as them.</small>}
          <small className={css.hint}>On the member’s profile, turn on Billing to draft quotations, and Operations access to make and change tasks.</small></label> : null}
        <fieldset className={css.areas}><legend>What it may use</legend>
          {areas.map((a) => { const r = `${a}.read`, w = `${a}.write`, has = (s: string) => form.scopes.includes(s);
            const set = (s: string, on: boolean) => setForm({ ...form, scopes: on ? [...new Set([...form.scopes, s, ...(s === w ? [r] : [])])] : form.scopes.filter((x) => x !== s && !(s === r && x === w)) });
            const label = data.scopes.find((s) => s.key === r)?.label;
            return <div key={a} className={css.area} title={label}><b>{area(a)}</b>
              {data.scopes.some((s) => s.key === r) ? <label><input type="checkbox" checked={has(r)} disabled={!inPlan(r)} onChange={(e) => set(r, e.target.checked)} /> Read</label> : null}
              {data.scopes.some((s) => s.key === w) ? <label><input type="checkbox" checked={has(w)} disabled={!inPlan(w) || !inPlan(r)} onChange={(e) => set(w, e.target.checked)} /> Change</label> : null}
              {!inPlan(r) || (data.scopes.some((s) => s.key === w) && !inPlan(w)) ? <small className={css.hint}>Not in your plan</small> : null}</div>; })}
        </fieldset>
        {data.plan ? <p className={css.note}>Your company’s API plan: {TIER_WORDS[data.plan.tier]}{form.kind === "bot" ? ` · bot keys ${data.plan.botKeysLive} of ${data.plan.botKeys}` : ""}. A key never does more than the person or AI member it acts as.</p> : null}
        <label className={css.field}><span>Works for</span><select className={styles.input} value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })}>
          {[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label>
        <div className={css.actions}><button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy === "new" || !form.name.trim() || !form.scopes.length || (form.kind === "bot" && !form.agentId)}>Make it</button>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setForm(null)}>Cancel</button></div>
      </form>
    </Panel> : null}
    <Panel title="Your personal tokens" sub="For your scripts and the pulse command line. A token acts as you, with your roles."
      tools={!form ? <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} onClick={() => start("personal")}>New token</button> : null}>
      {personal.length ? <div className={css.list}>{personal.map(card)}</div>
        : <Empty icon={KeyRound} compact title="No personal tokens" text="Claude and ChatGPT connect with “Sign in with Pulse” and need none. Make a token for a script, a cron job or the pulse CLI on a server." />}
    </Panel>
    {data.admin ? <Panel title="Bot keys" sub="For a bot such as Bhrata: it acts as one AI member of this organisation, with that member’s roles. Approving quotations stays a person’s click."
      tools={!form ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => start("bot")}>New bot key</button> : null}>
      {bots.length ? <div className={css.list}>{bots.map(card)}</div> : <Empty icon={Bot} compact title="No bot keys" text="Make one when a bot (Telegram, WhatsApp or a server agent) should draft quotations, add tasks or read the calendar in Pulse." />}
    </Panel> : null}
    {/* API-PLATFORM-2 (1594): company admins register webhooks here. */}
    {data.admin ? <Webhooks /> : null}
    {data.admin && others.length ? <Panel title="Members’ personal tokens" sub={`${others.length} live · revoke one when someone leaves`}><div className={css.list}>{others.map(card)}</div></Panel> : null}
  </div>;
}
