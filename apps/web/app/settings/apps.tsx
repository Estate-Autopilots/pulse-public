"use client";
// FLOW-E (owner, 21 Oct 2026: "All apps like Sales X-Ray should be able to connect"): Settings → Apps. Every app a
// process can use as an App action (or a Start), grouped: what each action needs and gives back, whether it is
// connected for this company or for you (Sales X-Ray and Gmail are each person's own), and Connect. Statuses are read
// live and say what Pulse does and does not do. Webhooks: the company's address and its signing secret.
import Link from "next/link";
import { useEffect, useState } from "react";
import { CalendarCheck, ClipboardList, Copy, ExternalLink, HardDrive, Mail, Megaphone, MessageCircle, Receipt, ScanSearch, Webhook, type LucideIcon } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import { flow, why } from "../processes/flow-client";
import type { AppView } from "../processes/builder/app-line";
import { STATE_WORD } from "../processes/builder/app-line";
import { Badge, Panel, Skeleton, styles } from "../ui";
import css from "./apps.module.css";

const ICONS: Record<string, LucideIcon> = { "scan-search": ScanSearch, "hard-drive": HardDrive, "calendar-check": CalendarCheck, mail: Mail, "message-circle": MessageCircle, megaphone: Megaphone,
  "clipboard-list": ClipboardList, receipt: Receipt, webhook: Webhook };
const TONE = { connected: "success", built_in: "success", partial: "warning", not_connected: "neutral", off: "neutral" } as const;
type Data = { apps: (AppView & { group: string; icon: string })[]; webhook: { url: string | null } | null; canEdit: boolean; mail?: { server: boolean; company: boolean } };
const BLOCK_WORD: Record<string, string> = { app: "App action", start: "Start" };

export function AppsSettings() {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState("");
  const load = () => flow<Data>("apps").then(setData).catch((e) => setError(why(e)));
  useEffect(() => { void load(); }, []);
  if (error) return <Panel title="Apps"><p className={css.note}>{error}</p></Panel>;
  if (!data) return <Panel title="Apps"><div className={css.grid}><Skeleton height={140} /><Skeleton height={140} /><Skeleton height={140} /></div></Panel>;
  const groups = [...new Set(data.apps.map((a) => a.group))];
  const on = data.apps.filter((a) => a.status.state === "connected" || a.status.state === "built_in").length;
  return <div className={css.stack} data-grow="">
    <Panel title="Apps" sub={`${on} of ${data.apps.length} ready · each is an App action or a Start in your processes`}>
      <div className={`${css.grid} ${css.group}`}>
        {groups.flatMap((g) => data.apps.filter((a) => a.group === g)).map((a) => { const Icon = ICONS[a.icon] ?? Webhook; const s = a.status;
          return <article key={a.key} className={css.app} data-state={s.state} aria-label={a.name}>
            <div className={css.top}><span className={css.icon}><Icon size={17} strokeWidth={1.75} aria-hidden="true" /></span>
              <span className={css.name}><small className={css.kind}>{a.group}</small><b>{a.name}</b><small>{a.maker}</small></span><Badge tone={TONE[s.state]}>{STATE_WORD[s.state]}</Badge></div>
            <p>{s.text}</p>
            <ul className={css.actions}>{a.actions.map((x) => <li key={x.key}><b>{x.name}</b><span className={css.where}>{BLOCK_WORD[x.block] ?? x.block}</span>
              <small><em>Needs</em> {x.needs}</small><small><em>Gives back</em> {x.gives}</small></li>)}</ul>
            {s.connect?.href ? <div className={css.foot}><Link href={s.connect.href} className={`${styles.btn} ${s.state === "not_connected" ? styles.btnPrimary : ""} ${styles.btnSmall}`}>
              {s.state === "not_connected" ? null : <ExternalLink size={13} aria-hidden="true" />}{s.connect.label}</Link></div> : null}
            {s.connect?.action === "webhook" ? <WebhookConnect data={data} onSaved={() => void load()} /> : null}
            {a.key === "gmail" && data.canEdit && data.mail ? <GmailSend mail={data.mail} onSaved={() => void load()} /> : null}
          </article>; })}
      </div>
    </Panel>
  </div>;
}

function WebhookConnect({ data, onSaved }: { data: Data; onSaved: () => void }) {
  const [url, setUrl] = useState(data.webhook?.url ?? ""), [secret, setSecret] = useState<string | null>(null), [busy, setBusy] = useState(false);
  if (!data.canEdit) return <p className={css.note}>Leadership and admins connect webhooks.</p>;
  async function save() {
    setBusy(true);
    try { const r = await flow<{ url: string | null; secret: string | null }>("apps/webhook", "POST", { url }); setSecret(r.secret); onSaved();
      notify({ id: "webhook", tone: "success", title: r.url ? "Webhooks connected" : "Webhooks disconnected", timeout: 3000 }); }
    catch (e) { notify({ id: "webhook", tone: "error", title: "Not saved", message: why(e) }); } finally { setBusy(false); }
  }
  return <form className={css.hook} onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <label className={styles.field}>The other app&apos;s address<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/pulse" /></label>
    <button className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`} disabled={busy}>{busy ? "Saving…" : url ? "Connect" : "Disconnect"}</button>
    {secret ? <p className={css.secret}><span>Signing secret (set it in the other app; each post carries <code>x-pulse-signature: sha256=…</code>):</span><code>{secret}</code>
      <button type="button" className={`${styles.btn} ${styles.btnSmall}`} onClick={() => void navigator.clipboard.writeText(secret)}><Copy size={12} aria-hidden="true" />Copy</button></p> : null}
  </form>;
}

/** Gmail: whether people may send a step's e-mail from their own Gmail (this Pulse must allow sending too). */
function GmailSend({ mail, onSaved }: { mail: { server: boolean; company: boolean }; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  async function set(send: boolean) {
    setBusy(true);
    try { await flow("apps/gmail", "POST", { send }); onSaved(); notify({ id: "gmail", tone: "success", title: send ? "Sending from Pulse is on" : "Sending from Pulse is off", timeout: 2500 }); }
    catch (e) { notify({ id: "gmail", tone: "error", title: "Not changed", message: why(e) }); } finally { setBusy(false); }
  }
  return <label className={css.switch}><input type="checkbox" role="switch" checked={mail.company} disabled={busy || (!mail.server && !mail.company)} onChange={(e) => void set(e.target.checked)} />
    <span><b>Send from Pulse</b><small>{mail.server ? "A step's e-mail goes from the person's own Gmail when they press Send." : "This Pulse does not send e-mail yet; the step opens it in the mail app."}</small></span></label>;
}
