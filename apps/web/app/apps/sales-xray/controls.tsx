"use client";
// EST-1363: the Sales X-Ray app's controls. Connect goes to Sales X-Ray's own sign-in and consent (the API answers the
// address; this page goes there itself). The tabs read Sales X-Ray through Pulse's API as the signed-in person, each
// when it opens; a refusal shows Sales X-Ray's own sentence. Ask is Pulse's assistant, reading through Sales X-Ray's MCP.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CloudOff, ExternalLink, FileText, MessageSquareText, PhoneCall, PlugZap, Send, Sparkles, Unplug, UserRound } from "lucide-react";
import { Drawer, DrawerFooter, DrawerSection, Segmented } from "../../kit";
import { Badge, Empty, Panel, Skeleton, styles } from "../../ui";
import { LinkCallToClient } from "./linked";
import css from "./sales-xray.module.css";
import { LEAD_STAGES, type Call, type CallDetail, type CallPage, type Fact, type LeadDetail, type LeadPage, type LeadRow } from "./types";

type Settled<T> = { key: string | null; data: T | null; error: string | null };
const UNAVAILABLE = "Pulse couldn’t reach Sales X-Ray just now. Try again in a minute.";

async function ask<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v0/sales-xray/${path}`, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(typeof body?.error === "string" && body.error !== "Not Found" ? body.error : UNAVAILABLE);
  return body as T;
}

/** One read: loading until the answer for this exact path (and attempt) arrives; state changes only when it settles. */
function useRead<T>(path: string | null) {
  const [attempt, setAttempt] = useState(0);
  const key = path ? `${path}#${attempt}` : null;
  const [state, setState] = useState<Settled<T>>({ key: null, data: null, error: null });
  useEffect(() => {
    if (!path || !key) return;
    let live = true;
    ask<T>(path).then((data) => { if (live) setState({ key, data, error: null }); },
      (e: Error) => { if (live) setState({ key, data: null, error: e.message }); });
    return () => { live = false; };
  }, [path, key]);
  const done = state.key === key;
  return { data: done ? state.data : null, error: done ? state.error : null, loading: !!key && !done, retry: useCallback(() => setAttempt((n) => n + 1), []) };
}

type Paged<T> = { key: string; scope: string; items: T[]; next: string | null; error: string | null };
/** A list read page by page: "Show more" adds the next page; a new scope (another stage) starts again. */
function usePaged<T>(scope: string, cursor: string | null, attempt: number, url: string, pick: (body: unknown) => { items: T[]; next: string | null }, id: (item: T) => string) {
  const key = `${scope}|${cursor ?? ""}|${attempt}`;
  const [state, setState] = useState<Paged<T>>({ key: "", scope: "", items: [], next: null, error: null });
  useEffect(() => {
    let live = true;
    ask<unknown>(url).then((body) => {
      if (!live) return;
      const got = pick(body);
      setState((prev) => ({ key, scope, next: got.next, error: null,
        items: cursor && prev.scope === scope ? [...prev.items, ...got.items.filter((x) => !prev.items.some((p) => id(p) === id(x)))] : got.items }));
    }, (e: Error) => { if (live) setState((prev) => ({ ...prev, key, scope, error: e.message, items: prev.scope === scope ? prev.items : [] })); });
    return () => { live = false; };
    // url, pick and id follow from the key (scope, cursor, attempt); pick and id are module-level.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const mine = state.scope === scope;
  return { items: mine ? state.items : [], next: mine && state.key === key ? state.next : null, error: state.key === key ? state.error : null, loading: state.key !== key };
}
const pickCalls = (body: unknown) => { const p = (body ?? {}) as CallPage; return { items: p.calls ?? [], next: p.next_before ?? null }; };
const pickLeads = (body: unknown) => { const p = (body ?? {}) as LeadPage; return { items: p.leads ?? [], next: p.next_offset ? String(p.next_offset) : null }; };
const callId = (c: Call) => c.id, leadId = (l: LeadRow) => l.lead_id;

const when = (iso?: string | null) => iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";
const length = (s?: number | null) => !s ? "" : s < 90 ? `${Math.max(1, Math.round(s))} sec` : `${Math.round(s / 60)} min`;
const callTitle = (c: Call) => c.title?.trim() || (c.created_at ? `Call on ${new Date(c.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}` : "Call");

function Failure({ text, retry }: { text: string; retry?: () => void }) {
  return <Empty icon={CloudOff} compact title="This didn’t load" text={text}>
    {retry ? <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={retry}>Try again</button> : null}
  </Empty>;
}
function Rows() {
  return <div className={css.loading} aria-busy="true" aria-label="Loading">{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={40} />)}</div>;
}

export function ConnectButton() {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const go = () => {
    setBusy(true); setError(null);
    ask<{ url: string }>("connect", { method: "POST", body: "{}" }).then(({ url }) => window.location.assign(url), (e: Error) => { setBusy(false); setError(e.message); });
  };
  return <div className={css.connect}>
    <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={go} disabled={busy}><PlugZap size={16} aria-hidden="true" />{busy ? "Opening Sales X-Ray…" : "Connect Sales X-Ray"}</button>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </div>;
}

/** Leadership and admins: send the company's workflow step names to Sales X-Ray as lead-stage suggestions. */
export function SendWorkflowsButton() {
  const [busy, setBusy] = useState(false), [said, setSaid] = useState<{ ok: boolean; words: string } | null>(null);
  const send = () => {
    setBusy(true); setSaid(null);
    ask<{ sent: boolean; words: string }>("catalogue", { method: "POST", body: "{}" })
      .then((r) => { setBusy(false); setSaid({ ok: r.sent, words: r.words }); }, (e: Error) => { setBusy(false); setSaid({ ok: false, words: e.message }); });
  };
  return <span className={css.sendWorkflows}>
    <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={send} disabled={busy} title="Your workflow step names become lead-stage suggestions in Sales X-Ray">
      <Send size={16} aria-hidden="true" />{busy ? "Sending…" : "Send workflows"}</button>
    {said ? <small className={said.ok ? css.sentOk : css.error} role="status">{said.words}</small> : null}
  </span>;
}

export function DisconnectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const confirm = () => {
    setBusy(true); setError(null);
    ask<{ revoked?: boolean; words?: string }>("disconnect", { method: "POST", body: "{}" }).then((r) => { if (r.words) { setBusy(false); setError(r.words); } else setOpen(false); router.refresh(); }, (e: Error) => { setBusy(false); setError(e.message); });
  };
  return <>
    <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(true)}><Unplug size={16} aria-hidden="true" />Disconnect</button>
    {open ? <Drawer title="Disconnect Sales X-Ray?" size="sm" onClose={() => setOpen(false)}
      footer={<DrawerFooter status={error} primary={<button type="button" className={`${styles.btn} ${styles.btnDanger}`} onClick={confirm} disabled={busy}>{busy ? "Disconnecting…" : "Disconnect"}</button>}>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)}>Keep it</button></DrawerFooter>}>
      <DrawerSection><p className={css.text}>Pulse stops reading your Sales X-Ray calls and leads, and Sales X-Ray ends Pulse’s access at once. Your calls and leads stay in Sales X-Ray. You can connect again any time.</p></DrawerSection>
    </Drawer> : null}
  </>;
}

export function CallsView() {
  const [before, setBefore] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const page = usePaged<Call>("calls", before, attempt, before ? `calls?before=${before}` : "calls", pickCalls, callId);
  const pages = page.items;
  const [open, setOpen] = useState<Call | null>(null);
  return <Panel title="Your calls" sub="Newest first, as Sales X-Ray shows them to you">
    {page.error && !pages.length ? <Failure text={page.error} retry={() => setAttempt((n) => n + 1)} />
      : page.loading && !pages.length ? <Rows />
      : !pages.length ? <Empty icon={PhoneCall} compact title="No calls yet" text="Calls you record or upload in Sales X-Ray appear here." />
      : <ul className={css.rows}>{pages.map((c) => <li key={c.id}>
        <button type="button" className={css.row} onClick={() => setOpen(c)}>
          <PhoneCall size={16} aria-hidden="true" />
          <span className={css.main}><b>{callTitle(c)}</b><small>{[when(c.created_at), length(c.duration_seconds)].filter(Boolean).join(" · ")}</small></span>
          {c.has_report ? <Badge tone="success">Report ready</Badge> : <Badge>No report yet</Badge>}
        </button>
      </li>)}</ul>}
    {page.next ? <div className={css.more}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={page.loading} onClick={() => setBefore(page.next)}>{page.loading ? "Loading…" : "Show older calls"}</button></div> : null}
    {open ? <CallDrawer call={open} onClose={() => setOpen(null)} /> : null}
  </Panel>;
}

const factText = (f: Fact) => f.display?.trim() || (typeof f.value === "string" ? f.value : f.value === undefined || f.value === null ? "" : JSON.stringify(f.value));

function CallDrawer({ call, onClose }: { call: Call; onClose: () => void }) {
  const detail = useRead<CallDetail>(`calls/${call.id}`);
  const facts = detail.data?.facts ?? [];
  const href = detail.data?.open_url ?? call.open_url;
  return <Drawer title={callTitle(call)} context={[when(call.created_at), length(call.duration_seconds)].filter(Boolean).join(" · ")} size="md" onClose={onClose}
    footer={<DrawerFooter primary={href ? <a className={`${styles.btn} ${styles.btnPrimary}`} href={href} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" />Open the report in Sales X-Ray</a> : undefined} />}>
    <DrawerSection title="What Sales X-Ray found" help="The facts found in this call, in Sales X-Ray’s words. Parts of a call marked sensitive are never shown.">
      {detail.error ? <Failure text={detail.error} retry={detail.retry} />
        : detail.loading ? <Rows />
        : !facts.length ? <Empty icon={FileText} compact title={call.has_report ? "No facts found yet" : "No report yet"} text={call.has_report ? "Sales X-Ray hasn’t found facts in this call yet." : "When Sales X-Ray finishes this call’s report, its facts appear here."} />
        : <dl className={css.facts}>{facts.map((f, i) => <div key={f.object_id ?? i}><dt>{f.label ?? f.category ?? "Fact"}</dt><dd>{factText(f)}</dd></div>)}</dl>}
    </DrawerSection>
    <DrawerSection title="Link to a client" help="The call and its analysis then show on the client and on your profile in Pulse.">
      <LinkCallToClient sxCallId={call.id} />
    </DrawerSection>
  </Drawer>;
}

export function LeadsView() {
  const [stage, setStage] = useState<string>("open"), [offset, setOffset] = useState<string | null>(null), [attempt, setAttempt] = useState(0);
  const page = usePaged<LeadRow>(`leads:${stage}`, offset, attempt, `leads?stage=${stage}${offset ? `&offset=${offset}` : ""}`, pickLeads, leadId);
  const rows = page.items;
  const [open, setOpen] = useState<LeadRow | null>(null);
  const choose = (value: string) => { setStage(value); setOffset(null); };
  return <Panel title="Your leads"
    tools={<Segmented label="Stage" size="sm" value={stage} onChange={choose} options={LEAD_STAGES.map((s) => ({ value: s.value, label: s.label }))} />}>
    {page.error && !rows.length ? <Failure text={page.error} retry={() => setAttempt((n) => n + 1)} />
      : page.loading && !rows.length ? <Rows />
      : !rows.length ? <Empty icon={UserRound} compact title="No leads here" text="Leads given to you in Sales X-Ray appear here." />
      : <ul className={css.rows}>{rows.map((l) => <li key={l.lead_id}>
        <button type="button" className={css.row} onClick={() => setOpen(l)} data-overdue={l.overdue ? "" : undefined}>
          <UserRound size={16} aria-hidden="true" />
          <span className={css.main}><b>{l.name || "Unnamed lead"}</b><small>{[l.company, l.city, l.source_label, l.why].filter(Boolean).join(" · ")}</small></span>
          <Badge tone={l.overdue ? "danger" : l.stage === "won" ? "success" : "neutral"}>{l.stage_label ?? l.stage ?? ""}</Badge>
        </button>
      </li>)}</ul>}
    {page.next ? <div className={css.more}><button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={page.loading} onClick={() => setOffset(page.next)}>{page.loading ? "Loading…" : "Show more leads"}</button></div> : null}
    {open ? <LeadDrawer lead={open} onClose={() => setOpen(null)} /> : null}
  </Panel>;
}

function LeadDrawer({ lead, onClose }: { lead: LeadRow; onClose: () => void }) {
  const detail = useRead<LeadDetail>(`leads/${lead.lead_id}`);
  const d = detail.data;
  return <Drawer title={lead.name || "Lead"} context={[lead.stage_label, lead.owner_name].filter(Boolean).join(" · ")} size="md" onClose={onClose}>
    {detail.error ? <Failure text={detail.error} retry={detail.retry} /> : detail.loading || !d ? <Rows /> : <>
      <DrawerSection title="Contact">
        <dl className={css.facts}>
          {d.phone ? <div><dt>Phone</dt><dd>{d.phone}</dd></div> : null}
          {d.email ? <div><dt>Email</dt><dd>{d.email}</dd></div> : null}
          {lead.company ? <div><dt>Company</dt><dd>{lead.company}</dd></div> : null}
          {lead.interest ? <div><dt>Interested in</dt><dd>{lead.interest}</dd></div> : null}
          {lead.next_action_at ? <div><dt>Next step</dt><dd>{[when(lead.next_action_at), d.next_action_note].filter(Boolean).join(" · ")}</dd></div> : null}
          {(d.fields ?? []).map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
        </dl>
      </DrawerSection>
      {d.events?.length ? <DrawerSection title="History">
        <ul className={css.events}>{d.events.slice(0, 12).map((e, i) => <li key={i}><b>{e.stage_label ?? e.reason_label ?? e.kind ?? ""}</b><small>{[when(e.at), e.actor_name, e.note].filter(Boolean).join(" · ")}</small></li>)}</ul>
      </DrawerSection> : null}
    </>}
  </Drawer>;
}

const STARTERS = ["What happened on my last call?", "Which of my leads should I call today?", "What budget or timeline did my prospects mention this week?"];

export function AskView() {
  const [question, setQuestion] = useState(""), [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ q: string; text: string } | null>(null), [error, setError] = useState<string | null>(null);
  const send = (q: string) => {
    const text = q.trim();
    if (text.length < 3 || busy) return;
    setBusy(true); setError(null);
    ask<{ answer: string }>("ask", { method: "POST", body: JSON.stringify({ question: text }) })
      .then((r) => { setAnswer({ q: text, text: r.answer }); setBusy(false); }, (e: Error) => { setError(e.message); setBusy(false); });
  };
  return <Panel title="Ask about your calls and leads" sub="Pulse’s assistant reads your Sales X-Ray through its MCP server, as you. It only reads.">
    <form className={css.ask} onSubmit={(e) => { e.preventDefault(); send(question); }}>
      <label className={css.srOnly} htmlFor="sx-question">Your question</label>
      <textarea id="sx-question" className={css.question} rows={2} maxLength={500} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about your calls and leads"
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(question); } }} />
      <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || question.trim().length < 3}><Sparkles size={16} aria-hidden="true" />{busy ? "Reading Sales X-Ray…" : "Ask"}</button>
    </form>
    {!answer && !busy ? <div className={css.starters}>{STARTERS.map((s) => <button key={s} type="button" className={css.starter} onClick={() => { setQuestion(s); send(s); }}><MessageSquareText size={14} aria-hidden="true" />{s}</button>)}</div> : null}
    {busy ? <div className={css.answer} aria-busy="true"><Skeleton height={14} /><Skeleton height={14} width="80%" /><Skeleton height={14} width="60%" /></div> : null}
    {error ? <p className={css.error} role="alert">{error}</p> : null}
    {answer && !busy ? <article className={css.answer} aria-live="polite">
      <header><Badge><Sparkles size={12} aria-hidden="true" /> AI</Badge><b>{answer.q}</b></header>
      <p>{answer.text}</p>
    </article> : null}
  </Panel>;
}
