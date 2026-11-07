"use client";
// API-PLATFORM-2 (1594): Settings → API keys → Webhooks, for company admins. Register an https address, choose what
// Pulse tells it, see each delivery (sent, waiting to retry, failed) and send one again, send a test, pause or remove.
// The signing secret is shown once, when the webhook is made. Words through say/useWords (DE-EA).
import { useEffect, useState } from "react";
import { Copy, Pause, Play, RotateCcw, Send, Trash2, Webhook } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { Badge, Empty, Panel, Skeleton, styles } from "../ui";
import { ago } from "../lib/format";
import css from "./api-keys.module.css";
import { useWords } from "../org-code";
import { say } from "../lib/words.mjs";

type Hook = { id: string; url: string; events: string[]; description: string | null; active: boolean; disabledReason: string | null; secretHint: string;
  createdAt: string; createdBy: string | null; failingSince: string | null; lastSuccessAt: string | null; pending: number; failedToday: number };
type Delivery = { id: string; eventType: string; status: "pending" | "delivered" | "failed" | "cancelled"; attempts: number; lastStatus: number | null; lastError: string | null;
  lastMs: number | null; createdAt: string; nextAt: string | null };
type Data = { webhooks: Hook[]; eventTypes: string[]; limit: number; tier: string };

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(typeof data?.error === "string" ? data.error : "Pulse couldn’t do that just now. Try again.");
  return data as T;
}
const EVENT_WORDS: Record<string, string> = {
  "task.created": "A task is made", "task.updated": "A task changes", "task.completed": "A task is done",
  "project.created": "A {project} is made", "project.updated": "A {project} changes", "project.deleted": "A {project} is deleted",
  "expense.created": "An expense is recorded", "expense.approved": "An expense is approved", "expense.rejected": "An expense is turned down",
  "leave.requested": "Someone asks for leave", "leave.decided": "Leave is approved or turned down",
  "quotation.issued": "A quotation is issued", "invoice.issued": "An invoice is issued", "invoice.paid": "An invoice is paid",
  "chat.message.posted": "A chat message is sent", "webhook.ping": "Test",
};
const STATUS_WORDS: Record<Delivery["status"], string> = { pending: "Waiting to retry", delivered: "Delivered", failed: "Gave up after a day", cancelled: "Cancelled" };
const ERROR_WORDS: Record<string, string> = { timeout: "no answer in 3 seconds", dns: "address not found", destination: "address not allowed (private network)",
  redirect: "it redirected", response_size: "answer too large", network: "could not connect", http: "it answered with an error" };

export function Webhooks() {
  const words = useWords(), event = (t: string) => say(EVENT_WORDS[t] ?? t, words);
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<{ url: string; events: string[]; description: string } | null>(null), [secret, setSecret] = useState<string | null>(null);
  const [log, setLog] = useState<{ id: string; items: Delivery[] } | null>(null);
  useEffect(() => { call<Data>("webhooks").then(setData).catch((e: Error) => setError(e.message)); }, []);
  const run = async (key: string, what: () => Promise<unknown>, title: string) => {
    setBusy(key);
    try { const r = await what() as Partial<Data> & { secret?: string }; if (r.webhooks) setData((d) => d && { ...d, webhooks: r.webhooks! }); if (r.secret) setSecret(r.secret); notify({ id: `webhook-${key}`, tone: "success", title, timeout: 3000 }); return true; }
    catch (e) { notify({ id: `webhook-${key}`, tone: "error", title: "Not changed", message: (e as Error).message }); return false; }
    finally { setBusy(null); }
  };
  const openLog = async (id: string) => { try { setLog({ id, items: (await call<{ deliveries: Delivery[] }>(`webhooks/${id}/deliveries`)).deliveries }); } catch (e) { notify({ id: "webhook-log", tone: "error", title: "Couldn’t load the log", message: (e as Error).message }); } };
  if (error) return <Panel title="Webhooks"><p className={css.note}>{error}</p></Panel>;
  if (!data) return <Panel title="Webhooks"><Skeleton height={72} /></Panel>;
  const full = data.webhooks.length >= data.limit;
  return <Panel title="Webhooks" sub={`Pulse tells your own system when something happens, within seconds. ${data.webhooks.length} of ${data.limit} in your plan.`}
    tools={!form && !full ? <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setForm({ url: "https://", events: ["task.created", "task.completed"], description: "" })}>New webhook</button> : null}>
    <div className={css.stack}>
      {secret ? <div className={css.secret} role="status">
        <p><b>Signing secret</b>: copy it now; Pulse shows it once. Your system checks each delivery with it: the <code>X-Pulse-Signature</code> header is <code>t=…,v1=…</code>, where v1 is the HMAC-SHA256 of “t.body” with this secret.</p>
        <code className={css.token}>{secret}</code>
        <div className={css.actions}><button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} onClick={() => void navigator.clipboard.writeText(secret).then(() => notify({ id: "webhook-copy", tone: "success", title: "Copied", timeout: 2000 }))}><Copy size={13} aria-hidden="true" /> Copy</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => setSecret(null)}>I’ve stored it</button></div>
      </div> : null}
      {form ? <form className={css.form} onSubmit={(e) => { e.preventDefault(); void run("new", () => call("webhooks", "POST", { url: form.url.trim(), events: form.events, ...(form.description.trim() ? { description: form.description.trim() } : {}) }), "Webhook made").then((ok) => { if (ok) setForm(null); }); }}>
        <label className={css.field}><span>Address</span><input className={styles.input} type="url" required maxLength={2048} value={form.url} placeholder="https://your-system.example/pulse" onChange={(e) => setForm({ ...form, url: e.target.value })} />
          <small className={css.hint}>An https address on the internet. Addresses inside a private network are refused.</small></label>
        <label className={css.field}><span>Note (optional)</span><input className={styles.input} maxLength={120} value={form.description} placeholder="Our accounts system" onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <fieldset className={css.areas}><legend>Tell it when</legend>
          {data.eventTypes.map((t) => <label key={t} className={css.area}><input type="checkbox" checked={form.events.includes(t)} onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, t] : form.events.filter((x) => x !== t) })} /> {event(t)}</label>)}
        </fieldset>
        <p className={css.note}>Each delivery carries ids only, never names, amounts or messages; your system reads the details with its own key. Pulse retries for a day when your system does not answer.</p>
        <div className={css.actions}><button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy === "new" || !form.events.length || !form.url.startsWith("https://")}>Make it</button>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setForm(null)}>Cancel</button></div>
      </form> : null}
      {data.webhooks.length ? <div className={css.list}>{data.webhooks.map((h) => <article key={h.id} className={`${css.card} ${css.bot}`} aria-label={h.url}>
        <header className={css.head}><Webhook size={16} aria-hidden="true" /><b>{h.description ?? h.url}</b>
          {h.active ? <Badge tone={h.failingSince ? "danger" : "neutral"}>{h.failingSince ? `Failing since ${ago(h.failingSince)}` : "On"}</Badge> : <Badge tone="danger">{h.disabledReason === "failing" ? "Off: failed for 3 days" : "Paused"}</Badge>}</header>
        {h.description ? <p className={css.meta}>{h.url}</p> : null}
        <ul className={css.chips} aria-label="Tells it when">{h.events.map((t) => <li key={t}>{event(t)}</li>)}</ul>
        <p className={css.meta}>Made {ago(h.createdAt)}{h.createdBy ? ` by ${h.createdBy}` : ""} · secret {h.secretHint} · {h.lastSuccessAt ? `last delivered ${ago(h.lastSuccessAt)}` : "nothing delivered yet"}{h.pending ? ` · ${h.pending} waiting` : ""}{h.failedToday ? ` · ${h.failedToday} failed today` : ""}</p>
        <div className={css.actions}>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} disabled={busy === h.id} onClick={() => void run(h.id, () => call(`webhooks/${h.id}/test`, "POST", {}), "Test sent")}><Send size={13} aria-hidden="true" /> Send a test</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void (log?.id === h.id ? setLog(null) : openLog(h.id))}>{log?.id === h.id ? "Hide deliveries" : "Deliveries"}</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy === h.id} onClick={() => void run(h.id, () => call(`webhooks/${h.id}`, "PATCH", { active: !h.active }), h.active ? "Paused" : "Switched on")}>{h.active ? <><Pause size={13} aria-hidden="true" /> Pause</> : <><Play size={13} aria-hidden="true" /> Switch on</>}</button>
          <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} disabled={busy === h.id} onClick={() => { if (window.confirm("Remove this webhook? Deliveries still waiting are cancelled.")) void run(h.id, () => call(`webhooks/${h.id}`, "DELETE"), "Removed"); }}><Trash2 size={13} aria-hidden="true" /> Remove</button>
        </div>
        {log?.id === h.id ? (log.items.length ? <ul className={css.list} aria-label="Deliveries">{log.items.map((d) => <li key={d.id} className={css.meta}>
          {event(d.eventType)} · {STATUS_WORDS[d.status]}{d.lastStatus ? ` · answered ${d.lastStatus}` : ""}{d.lastError && d.status !== "delivered" ? ` · ${ERROR_WORDS[d.lastError] ?? d.lastError}` : ""} · {d.attempts} {d.attempts === 1 ? "try" : "tries"} · {ago(d.createdAt)}
          {d.status !== "pending" ? <button type="button" className={`${styles.btn} ${styles.btnSmall} ${styles.btnGhost}`} onClick={() => void run(d.id, () => call(`webhooks/${h.id}/deliveries/${d.id}/redeliver`, "POST", {}), "Sent again").then(() => openLog(h.id))}><RotateCcw size={13} aria-hidden="true" /> Send again</button> : null}
        </li>)}</ul> : <p className={css.note}>No deliveries yet.</p>) : null}
      </article>)}</div>
        : !form ? <Empty icon={Webhook} compact title="No webhooks" text={data.limit ? "Make one when another system (accounts, a CRM, a bot) should hear about new tasks, expenses, leave or invoices as they happen." : "Your company’s plan has no webhooks. Ask Pulse to change the plan."} /> : null}
    </div>
  </Panel>;
}
