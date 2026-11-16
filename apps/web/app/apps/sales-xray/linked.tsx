"use client";
// XRAY-LINK: Sales X-Ray inside Pulse's own records. Calls linked to a client, a person or a Pulse call show their
// analysis (what they want, objections, promises) where the work happens; "Analyse a recording" sends a file to Sales
// X-Ray; "Send to Sales X-Ray" makes a client a lead there; the Calls tab links a call to a client.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, ExternalLink, Link2, PhoneCall, Send, Unlink, Upload } from "lucide-react";
import { Combobox, Drawer, DrawerFooter, DrawerSection } from "../../kit";
import { Badge, Empty, Panel, Skeleton, styles } from "../../ui";
import css from "./sales-xray.module.css";

export type LinkedCall = { id: string; sxCallId: string; title: string | null; callAt: string | null; durationSeconds: number | null; status: "sent" | "waiting" | "analysing" | "ready" | "failed";
  summary: { summary?: string; items?: string[]; objections?: string[]; promises?: string[]; score?: number | string | null; url?: string }; openUrl: string | null;
  clientId: string | null; clientName: string | null; personId: string | null; personName: string | null; linkedBy: string | null; linkedAt: string };
export type LeadCopy = { sxLeadId: string; name: string; company: string | null; city: string | null; stage: string; stageLabel: string | null; ownerName: string | null; origin: string; goneAt: string | null };

const UNAVAILABLE = "Pulse couldn’t reach Sales X-Ray just now. Try again in a minute.";
export async function sx<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v0/sales-xray/${path}`, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(typeof body?.error === "string" && body.error !== "Not Found" ? body.error : UNAVAILABLE);
  return body as T;
}
const day = (iso?: string | null) => iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";
const mins = (s?: number | null) => !s ? "" : s < 90 ? `${Math.round(s)} sec` : `${Math.round(s / 60)} min`;
const STATUS: Record<LinkedCall["status"], { label: string; tone: "success" | "neutral" | "warning" | "accent" }> = {
  ready: { label: "Report ready", tone: "success" }, analysing: { label: "Analysing", tone: "accent" }, waiting: { label: "Add it in Sales X-Ray", tone: "warning" },
  sent: { label: "Sent", tone: "neutral" }, failed: { label: "Didn’t finish", tone: "warning" } };

function Bullets({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return <div className={css.insight}><h4>{title}</h4><ul>{items.slice(0, 4).map((x, i) => <li key={i}>{x.replace(/^(Objection|What they want|Biggest problem|We promised|They promised): /, "")}</li>)}</ul></div>;
}
/** One linked call with its analysis, short. */
export function LinkedCallCard({ c, onUnlink }: { c: LinkedCall; onUnlink?: () => void }) {
  const href = c.summary?.url ?? c.openUrl;
  return <article className={css.callCard}>
    <header>
      <PhoneCall size={16} aria-hidden="true" />
      <span className={css.main}><b>{c.title?.trim() || `Call on ${day(c.callAt ?? c.linkedAt)}`}</b>
        <small>{[day(c.callAt), mins(c.durationSeconds), c.personName, c.clientName].filter(Boolean).join(" · ")}</small></span>
      <Badge tone={STATUS[c.status]?.tone ?? "neutral"}>{STATUS[c.status]?.label ?? c.status}</Badge>
    </header>
    {c.status === "ready" ? <div className={css.insights}>
      <Bullets title="What they want" items={c.summary?.items} />
      <Bullets title="Objections" items={c.summary?.objections} />
      <Bullets title="Promises" items={c.summary?.promises} />
      {!c.summary?.items?.length && !c.summary?.objections?.length && !c.summary?.promises?.length ? <p className={css.text}>Sales X-Ray found no needs, objections or promises in this call.</p> : null}
    </div> : <p className={css.small}>{c.status === "waiting" ? "Sales X-Ray keeps the recording for you for 7 days under Calls → From Pulse. Add it there and the report shows here when it’s ready." : "The report shows here when Sales X-Ray finishes."}</p>}
    <footer>
      {href ? <a className={`${styles.btn} ${styles.btnGhost}`} href={href} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} aria-hidden="true" />Full report</a> : null}
      {onUnlink ? <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onUnlink}><Unlink size={14} aria-hidden="true" />Remove link</button> : null}
    </footer>
  </article>;
}

/** Calls linked to a client, a person or a Pulse call. */
export function LinkedCalls({ query, title = "Sales X-Ray calls", empty, tools }: { query: string; title?: string; empty?: string; tools?: React.ReactNode }) {
  const [calls, setCalls] = useState<LinkedCall[] | null>(null), [error, setError] = useState<string | null>(null), [n, setN] = useState(0);
  useEffect(() => { let live = true; sx<{ calls: LinkedCall[] }>(`linked?${query}`).then((r) => live && setCalls(r.calls), (e: Error) => live && setError(e.message)); return () => { live = false; }; }, [query, n]);
  const unlink = (id: string) => sx(`linked/${id}/unlink`, { method: "POST", body: "{}" }).then(() => setN((x) => x + 1), (e: Error) => setError(e.message));
  return <Panel title={title} sub={calls?.length ? `${calls.length}` : undefined} tools={tools}>
    {error ? <p className={css.error} role="alert">{error}</p>
      : !calls ? <div className={css.loading}><Skeleton height={40} /><Skeleton height={40} /></div>
      : !calls.length ? <Empty icon={AudioLines} compact title="No Sales X-Ray calls here yet" text={empty ?? "Link a call from Sales X-Ray, or analyse a recording."} />
      : <div className={css.callCards}>{calls.map((c) => <LinkedCallCard key={c.id} c={c} onUnlink={() => unlink(c.id)} />)}</div>}
  </Panel>;
}

/** "Analyse a recording": the file goes to Pulse in parts, then once to Sales X-Ray as the signed-in person. */
export function RecordingButton({ clientId, personId, pulseCallId, sxLeadId, label = "Analyse a recording", onDone }: { clientId?: string; personId?: string; pulseCallId?: string; sxLeadId?: string; label?: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false), [file, setFile] = useState<File | null>(null), [title, setTitle] = useState(""), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null), [said, setSaid] = useState<{ ok: boolean; words: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = () => { setOpen(false); setFile(null); setSaid(null); setBusy(null); setConsent(false); setTitle(""); };
  const send = async () => {
    if (!file || !consent) return;
    setSaid(null);
    try {
      setBusy("Starting…");
      const start = await sx<{ uploadId: string; partSize: number; parts: number }>("recordings", { method: "POST", body: JSON.stringify({ name: file.name, mime: file.type || "audio/mpeg", size: file.size, consent, title: title.trim() || undefined, clientId, personId, pulseCallId, sxLeadId }) });
      for (let i = 0; i < start.parts; i++) {
        setBusy(`Uploading ${Math.round((i / start.parts) * 100)}%…`);
        const buf = new Uint8Array(await file.slice(i * start.partSize, (i + 1) * start.partSize).arrayBuffer());
        let bin = ""; for (let j = 0; j < buf.length; j += 0x8000) bin += String.fromCharCode(...buf.subarray(j, j + 0x8000));
        await sx(`recordings/${start.uploadId}/parts`, { method: "POST", body: JSON.stringify({ index: i, bytes: btoa(bin) }) });
      }
      setBusy("Sending to Sales X-Ray…");
      const r = await sx<{ sent: boolean; words: string }>(`recordings/${start.uploadId}/send`, { method: "POST", body: "{}" });
      setSaid({ ok: r.sent, words: r.words }); setBusy(null);
      if (r.sent) onDone?.();
    } catch (e) { setSaid({ ok: false, words: (e as Error).message }); setBusy(null); }
  };
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(true)}><Upload size={16} aria-hidden="true" />{label}</button>
    {open ? <Drawer title="Analyse a recording" context="Sales X-Ray" size="sm" onClose={close}
      footer={<DrawerFooter status={said?.words ?? busy} primary={said?.ok ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={close}>Done</button>
        : <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!file || !consent || !!busy} onClick={send}><Send size={16} aria-hidden="true" />{busy ? "Sending…" : "Send to Sales X-Ray"}</button>}>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={close}>Cancel</button></DrawerFooter>}>
      <DrawerSection title="Recording" help="An audio or video file of a sales call, up to 100 MB. It goes to Sales X-Ray as your call; Pulse deletes its copy once it is sent.">
        <input ref={input} type="file" accept="audio/*,video/mp4,video/webm,video/quicktime" className={css.file} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && file.size > 100 * 1024 * 1024 ? <p className={css.error}>This file is over 100 MB.</p> : null}
        <label className={css.field}><span>Title <small>(optional)</small></span><input className={styles.input} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Site visit call with the client" /></label>
        <label className={css.check}><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />The people on this call know it was recorded and agree to its analysis.</label>
      </DrawerSection>
    </Drawer> : null}
  </>;
}

/** "Send to Sales X-Ray": this client becomes a lead there (once; a second press changes nothing). */
export function SendClientButton({ clientId, onDone }: { clientId: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false), [said, setSaid] = useState<{ ok: boolean; words: string } | null>(null);
  const go = () => { setBusy(true); setSaid(null); sx<{ ok: boolean; words: string }>(`clients/${clientId}/send`, { method: "POST", body: "{}" }).then((r) => { setSaid(r); setBusy(false); if (r.ok) onDone?.(); }, (e: Error) => { setSaid({ ok: false, words: e.message }); setBusy(false); }); };
  return <span className={css.sendWorkflows}>
    <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={go} disabled={busy}><Send size={16} aria-hidden="true" />{busy ? "Sending…" : "Send to Sales X-Ray"}</button>
    {said ? <small className={said.ok ? css.sentOk : css.error} role="status">{said.words}</small> : null}
  </span>;
}

/** Choose a client and link a Sales X-Ray call to it (the Calls tab's call drawer). */
export function LinkCallToClient({ sxCallId }: { sxCallId: string }) {
  const [options, setOptions] = useState<{ value: string; label: string; keywords?: string }[] | null>(null), [client, setClient] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; words: string } | null>(null), [busy, setBusy] = useState(false);
  const load = useCallback(() => { if (!options) sx<{ clients: { id: string; name: string; city: string | null }[] }>("client-options").then((r) => setOptions(r.clients.map((c) => ({ value: c.id, label: c.name, keywords: c.city ?? undefined }))), () => setOptions([])); }, [options]);
  useEffect(load, [load]);
  const link = () => { if (!client) return; setBusy(true); sx<LinkedCall>(`calls/${sxCallId}/link`, { method: "POST", body: JSON.stringify({ clientId: client }) })
    .then((r) => { setBusy(false); setSaid({ ok: true, words: `Linked to ${r.clientName ?? "the client"}. Its analysis shows on the client and on your profile.` }); }, (e: Error) => { setBusy(false); setSaid({ ok: false, words: e.message }); }); };
  return <div className={css.linkRow}>
    <Combobox label="Client" placeholder={options ? "Choose a client" : "Loading clients…"} options={options ?? []} value={client} onChange={(v) => setClient(v)} searchable />
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={!client || busy} onClick={link}><Link2 size={16} aria-hidden="true" />{busy ? "Linking…" : "Link"}</button>
    {said ? <small className={said.ok ? css.sentOk : css.error} role="status">{said.words}</small> : null}
  </div>;
}

/** The client page's Sales X-Ray tab: the lead it is, its calls, and the two actions. */
export function ClientSalesXray({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [d, setD] = useState<{ configured: boolean; connected: boolean; missing?: string[]; sync: boolean; leads: LeadCopy[]; calls: LinkedCall[] } | null>(null), [error, setError] = useState<string | null>(null), [n, setN] = useState(0);
  useEffect(() => { let live = true; sx<typeof d>(`clients/${clientId}`).then((r) => live && setD(r), (e: Error) => live && setError(e.message)); return () => { live = false; }; }, [clientId, n]);
  if (error) return <Panel title="Sales X-Ray"><p className={css.error} role="alert">{error}</p></Panel>;
  if (!d) return <Panel title="Sales X-Ray"><Skeleton height={60} /></Panel>;
  const lead = d.leads[0];
  // A connection made before leads:update and calls:write: reading works; sending waits for a reconnect.
  const reconnect = d.connected && (d.missing ?? []).length > 0;
  const actions = d.connected ? <>{lead ? null : <SendClientButton clientId={clientId} onDone={() => setN((x) => x + 1)} />}{reconnect ? null : <RecordingButton clientId={clientId} sxLeadId={lead?.sxLeadId} onDone={() => setN((x) => x + 1)} />}</> : undefined;
  return <div className={css.clientTab} data-grow="" data-enter="">
    <Panel title="Lead in Sales X-Ray" tools={actions}><div className={css.syncBody}>
      {!d.connected ? <Empty icon={PhoneCall} compact title="Connect Sales X-Ray to send calls and leads" text="Your calls and leads stay yours in Sales X-Ray; Pulse links them to this client." action={{ href: "/apps/sales-xray", label: "Open Sales X-Ray" }} /> : null}
      {reconnect ? <p className={css.small} role="status"><b>Reconnect to allow updates.</b> Your Sales X-Ray connection predates sending recordings and client changes. <Link className={styles.fill} href="/apps/sales-xray">Reconnect in Sales X-Ray</Link>.</p> : null}
      {lead ? <dl className={css.facts}>
        <div><dt>Lead</dt><dd>{lead.name}{lead.company && lead.company !== lead.name ? ` · ${lead.company}` : ""}</dd></div>
        <div><dt>Stage</dt><dd><Badge tone={lead.stage === "won" ? "success" : lead.stage === "lost" ? "neutral" : "accent"}>{lead.stageLabel ?? lead.stage}</Badge>{lead.goneAt ? <span className={css.small}> · no longer in Sales X-Ray</span> : null}</dd></div>
        {lead.ownerName ? <div><dt>Salesperson</dt><dd>{lead.ownerName}</dd></div> : null}
        <div><dt>Came from</dt><dd>{lead.origin === "pulse" ? "Sent from Pulse" : "Sales X-Ray"}{d.sync ? " · kept in step by lead sync" : ""}</dd></div>
      </dl> : d.connected ? <p className={css.text}>{clientName} isn’t a Sales X-Ray lead yet. Send it, and its stage shows here.</p> : null}
    </div></Panel>
    <LinkedCalls query={`client=${clientId}`} empty="Open a call in Sales X-Ray → Calls and link it to this client, or analyse a recording." />
    <p className={css.small}>Lead sync settings and its log: <Link className={styles.fill} href="/apps/sales-xray?tab=sync">Sales X-Ray → Sync</Link>.</p>
  </div>;
}
