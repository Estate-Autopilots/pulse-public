"use client";

// COMP-A: every pay action is one drawer: fill in, see what changes (before and after, the cost, the letter), then
// propose, approve or send. The database decides who may do each; these forms only offer what the viewer can do.
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Check, Copy, Link2, ShieldAlert } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import type { LetterData } from "@pulse/invoice-doc/browser";
import { Modal, post } from "../../records";
import { Badge, styles } from "../../ui";
import { LetterPreview } from "./letter-preview";
import { addDays, CHANGE_KIND, day, EXIT_KIND, ITEM_KIND, NOTICE_MODE, PAUSE_REASON, PAY_TYPE, rupees, typed, type Component, type Figures, type Offer, type PayType, type PersonPay, type Version } from "./model";
import css from "./pay.module.css";
import { DateField } from "../../kit/date-field";
import { SelectField } from "../../kit/select-field";

type Done = () => void;
/** A drawer's busy, error and submit: saves, tells the person what happened, refreshes the page. */
function useSubmit(onDone: Done, message: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function run(work: () => Promise<unknown>, said = message) {
    setBusy(true); setError("");
    try { await work(); notify({ id: "comp", tone: "success", title: said, timeout: 3500 }); onDone(); router.refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save"); }
    finally { setBusy(false); }
  }
  return { busy, error, run };
}
function Foot({ error, children }: { error: string; children: ReactNode }) {
  return <div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p>{children}</div>;
}
/** READY (Datup, 21 Oct): why the preview can't be worked out, once, at the top of the form; the footer keeps its
 *  buttons (a long server refusal there was cut off beside them). */
function PreviewProblem({ error }: { error: string }) {
  if (!error) return null;
  return <p className={`${styles.wide} ${styles.banner} ${css.problem}`} role="alert"><ShieldAlert size={14} aria-hidden="true" /><span>{error}</span></p>;
}
const Primary = ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button className={`${styles.btn} ${styles.btnPrimary}`} {...p}>{children}</button>;
const Ghost = ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" className={`${styles.btn} ${styles.btnGhost}`} {...p}>{children}</button>;
const Field = ({ label, wide, children, hint }: { label: string; wide?: boolean; children: ReactNode; hint?: string }) =>
  <label className={`${styles.field} ${wide ? styles.wide : ""}`}>{label}{children}{hint ? <small className={css.hint}>{hint}</small> : null}</label>;

/** Rupees as typed, kept as text so "40,000" stays as written; the API reads it. */
function Money({ label, value, onChange, wide, hint, required }: { label: string; value: string; onChange: (v: string) => void; wide?: boolean; hint?: string; required?: boolean }) {
  return <Field label={label} wide={wide} hint={hint}><span className={css.money}><span aria-hidden="true">₹</span><input inputMode="decimal" value={value} required={required} onChange={(e) => onChange(e.target.value)} autoComplete="off" /></span></Field>;
}

/** The figures part of a form: by pay type, the monthly pay (or hourly rate and usual hours) and the yearly CTC. */
function PayFields({ payType, setPayType, monthly, setMonthly, ctc, setCtc, rate, setRate, hours, setHours, auto }: {
  payType: PayType; setPayType: (p: PayType) => void; monthly: string; setMonthly: (v: string) => void; ctc: string; setCtc: (v: string) => void;
  rate: string; setRate: (v: string) => void; hours: string; setHours: (v: string) => void; auto: Figures | null;
}) {
  return <>
    <Field label="Pay type"><SelectField value={payType} onChange={(e) => setPayType(e.target.value as PayType)}>{Object.entries(PAY_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</SelectField></Field>
    {payType === "hourly" ? <>
      <Money label="Rate an hour" value={rate} onChange={setRate} required />
      <Field label="Usual hours a month"><input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Optional" /></Field>
    </> : <>
      <Money label={payType === "salary" ? "Gross pay a month" : payType === "stipend" ? "Stipend a month" : "Fee a month"} value={monthly} onChange={setMonthly} required />
      {payType === "salary" ? <Money label="Yearly CTC" value={ctc} onChange={setCtc} hint={auto?.ctc ? `Leave empty for ${rupees(auto.ctc)} (gross and employer contributions × 12)` : "Leave empty to work it out"} /> : null}
    </>}
  </>;
}

/** Before → after, the cost a month, the rest of the year, arrears and the budget line. */
function BeforeAfter({ p, components }: { p: Preview | null; components: Component[] }) {
  if (!p) return null;
  const v = p.preview, sign = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + rupees(Math.abs(n)).replace("−", "");
  return <section className={css.compare} aria-label="Before and after">
    <table>
      <thead><tr><th scope="col" /><th scope="col">Before</th><th scope="col">After</th></tr></thead>
      <tbody>
        <tr><th scope="row">A month</th><td>{rupees(v.before?.monthly)}</td><td><b>{rupees(v.after.monthly)}</b></td></tr>
        <tr><th scope="row">A year (CTC)</th><td>{rupees(v.before?.ctc)}</td><td>{rupees(v.after.ctc)}</td></tr>
        {components.filter((c) => c.kind === "earning").map((c) => <tr key={c.key} className={css.sub}><th scope="row">{c.label}</th><td /><td>{rupees(c.amount)}</td></tr>)}
      </tbody>
    </table>
    <ul className={css.effects}>
      <li><span>Cost to the company</span><b>{sign(v.diff.cost)} a month{v.diff.percent !== null ? ` (${v.diff.percent > 0 ? "+" : ""}${v.diff.percent}%)` : ""}</b></li>
      <li><span>To 31 March</span><b>{sign(v.restOfYear.cost)} over {v.restOfYear.months} {v.restOfYear.months === 1 ? "month" : "months"}</b></li>
      {v.arrears.amount ? <li><span>Arrears (already paid at the old pay)</span><b>{rupees(v.arrears.amount)} for {v.arrears.months} months, added on approval</b></li> : null}
      <li><span>Budget</span><BudgetLine b={v.budget} /></li>
    </ul>
  </section>;
}
/** COMP-B: the change against its pod's people budget (Finance → People cost), from its month to 31 March. */
export type Budget = { available: boolean; note: string; over?: boolean; by?: number; left?: number; from?: string; months?: number };
export function BudgetLine({ b }: { b: Budget }) {
  if (!b.available) return <span className={css.quiet}>{b.note}</span>;
  return b.over ? <b className={css.warnText} role="note">{b.note}, by up to {rupees(b.by)} a month</b>
    : <span className={css.quiet}>{b.note}: {rupees(b.left)} a month left at the tightest</span>;
}
type Preview = { figures: Figures; before: Figures | null; effectiveOn: string; components: Component[]; letter: { kind: string; data: LetterData };
  preview: { before: { monthly: number; ctc: number | null; cost: number } | null; after: { monthly: number; ctc: number | null; cost: number }; diff: { monthly: number; cost: number; percent: number | null };
    restOfYear: { months: number; cost: number }; arrears: { amount: number; months: number }; budget: Budget } };

/** Asks the API for the preview 400 ms after the last keystroke. */
function usePreview<T>(path: string, body: Record<string, unknown> | null) {
  const [state, setState] = useState<{ data: T | null; error: string; key: string }>({ data: null, error: "", key: "" });
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!body) return;
    const t = setTimeout(async () => {
      const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: key }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : { error: "The preview is not reachable" };
      setState(r?.ok ? { data: d as T, error: "", key } : { data: null, error: d.error ?? "Not ready", key });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, path]);
  return state.key === key ? state : { data: state.data, error: "", key };
}

// --------------------------------------------------------------------------------------------- change pay
const CHANGE_KINDS = ["raise", "cut", "correction", "promotion", "role_change"] as const;
export function ChangePay({ p, onClose, start }: { p: PersonPay; onClose: Done; start?: boolean }) {
  const formId = useId(), now = p.inForce, versions = (p.versions ?? []).filter((v) => v.status === "approved");
  const [kind, setKind] = useState<string>(start ? "start" : "raise"), [on, setOn] = useState(start ? p.today : `${addDays(`${p.today.slice(0, 7)}-28`, 7).slice(0, 7)}-01`);
  const [payType, setPayType] = useState<PayType>(now?.payType ?? "salary"), [monthly, setMonthly] = useState(""), [ctc, setCtc] = useState(""), [rate, setRate] = useState(typed(now?.figures?.rate)), [hours, setHours] = useState(now?.figures?.hours ? String(now.figures.hours) : "");
  const [role, setRole] = useState(p.person.role ?? ""), [reason, setReason] = useState(""), [corrects, setCorrects] = useState(versions[0]?.id ?? "");
  const body = (payType === "hourly" ? rate : monthly) ? { person: p.person.id, kind, effectiveOn: on, payType, role: ["promotion", "role_change"].includes(kind) ? role : "", reason,
    correctsId: kind === "correction" ? corrects : null, figures: { monthly, ctc, rate, hours } } : null;
  const pv = usePreview<Preview>("comp/preview", body);
  const { busy, error, run } = useSubmit(onClose, "Proposed: a founder is asked to approve it");
  const submit = (submitIt: boolean) => (e?: FormEvent) => { e?.preventDefault(); void run(() => post("comp/changes", { ...body, submit: submitIt }), submitIt ? "Proposed: a founder is asked to approve it" : "Saved as a draft"); };
  return <Modal scroll size="lg" title={start ? `Set up ${p.person.name}'s pay` : `Change ${p.person.name}'s pay`} sub={now?.figures ? `Now ${rupees(now.figures.monthly)} a month · ${PAY_TYPE[now.payType]} since ${day(now.effectiveOn)}` : "No pay in force yet"} onClose={onClose}
    foot={<Foot error={error}><Ghost onClick={onClose}>Cancel</Ghost><Ghost disabled={busy || !body} onClick={() => submit(false)()}>Save draft</Ghost><Primary form={formId} disabled={busy || !pv.data}>{busy ? "Saving…" : "Propose"}</Primary></Foot>}>
    <form id={formId} className={styles.modalBody} onSubmit={submit(true)} autoComplete="off">
      <PreviewProblem error={pv.error} />
      {!start ? <div className={`${styles.wide} ${css.kinds}`} role="radiogroup" aria-label="What changes">{CHANGE_KINDS.map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={css.kind} onClick={() => setKind(k)}>{CHANGE_KIND[k]}</button>)}</div> : null}
      {kind === "correction" ? <Field label="Corrects" wide><SelectField value={corrects} onChange={(e) => setCorrects(e.target.value)}>{versions.map((v) => <option key={v.id} value={v.id}>{CHANGE_KIND[v.kind]} from {day(v.effectiveOn)}{v.figures ? ` · ${rupees(v.figures.monthly)}` : ""}</option>)}</SelectField></Field>
        : <Field label="Takes effect on"><DateField value={on} onChange={(e) => setOn(e.target.value)} required /></Field>}
      {["promotion", "role_change"].includes(kind) ? <Field label="New role" wide><input value={role} onChange={(e) => setRole(e.target.value)} required maxLength={120} /></Field> : null}
      <PayFields payType={payType} setPayType={setPayType} monthly={monthly} setMonthly={setMonthly} ctc={ctc} setCtc={setCtc} rate={rate} setRate={setRate} hours={hours} setHours={setHours} auto={pv.data?.figures ?? null} />
      <Field label="Why" wide hint="Kept with the change and written in the letter."><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} required placeholder="e.g. Annual review: took over the Pod 2 edits" /></Field>
      {pv.data ? <><div className={styles.wide}><BeforeAfter p={pv.data} components={pv.data.components ?? []} /></div>
        <div className={styles.wide}><LetterPreview kind={pv.data.letter.kind ?? "revision"} data={pv.data.letter.data ?? null} name={p.person.name} role={["promotion", "role_change"].includes(kind) ? role : p.person.role} /></div></>
        : !pv.error ? <p className={`${styles.wide} ${css.quiet}`}>Fill in the pay to see what changes and the letter.</p> : null}
      <p className={`${styles.wide} ${css.quiet}`}>A founder approves it before anything changes. Then the letter is filed and {p.person.name.split(" ")[0]} sees it in My money.</p>
    </form>
  </Modal>;
}

// ------------------------------------------------------------------------------------------------- offers
export function OfferForm({ p, offer, onClose }: { p: PersonPay; offer?: Offer | null; onClose: Done }) {
  const formId = useId(), pol = p.policy;
  const [role, setRole] = useState(offer?.role ?? (p.person.role ?? "").replace(/\s*\(proposed\)\s*$/i, "")), [startOn, setStart] = useState(offer?.startOn ?? addDays(p.today, 14));
  const [payType, setPayType] = useState<PayType>(offer?.payType ?? "salary"), [monthly, setMonthly] = useState(typed(offer?.figures?.monthly)), [ctc, setCtc] = useState("");
  const [rate, setRate] = useState(typed(offer?.figures?.rate)), [hours, setHours] = useState(offer?.figures?.hours ? String(offer.figures.hours) : "");
  const [probation, setProbation] = useState(String(offer?.probationDays ?? pol.probationDays)), [notice, setNotice] = useState(offer?.noticeDays === null || offer?.noticeDays === undefined ? String(pol.noticeProbation) : String(offer.noticeDays));
  const [validUntil, setValid] = useState(offer?.validUntil && offer.validUntil >= p.today ? offer.validUntil : addDays(p.today, pol.offerDays)), [terms, setTerms] = useState(offer?.terms ?? "");
  const body = (payType === "hourly" ? rate : monthly) && role ? { person: p.person.id, role, startOn, payType, figures: { monthly, ctc, rate, hours }, probationDays: probation, noticeDays: notice, validUntil, terms } : null;
  const pv = usePreview<{ figures: Figures; components: Component[]; budget?: Budget; letter: { kind: string; data: LetterData } }>("comp/offers/preview", body);
  const { busy, error, run } = useSubmit(onClose, "Offer saved");
  const save = (ask: boolean) => void run(() => post("comp/offers", { ...body, id: offer?.id, submit: ask }), ask ? "Offer sent to a founder for approval" : "Offer saved as a draft");
  return <Modal scroll size="lg" title={offer ? "Edit the offer" : `Offer for ${p.person.name}`} sub="A founder approves it, then a founder sends it. Pulse e-mails nobody." onClose={onClose}
    foot={<Foot error={error}><Ghost onClick={onClose}>Cancel</Ghost><Ghost disabled={busy || !body} onClick={() => save(false)}>Save draft</Ghost><Primary form={formId} disabled={busy || !pv.data}>{busy ? "Saving…" : "Ask a founder"}</Primary></Foot>}>
    <form id={formId} className={styles.modalBody} onSubmit={(e) => { e.preventDefault(); save(true); }} autoComplete="off">
      <PreviewProblem error={pv.error} />
      <Field label="Role" wide><input value={role} onChange={(e) => setRole(e.target.value)} required maxLength={120} /></Field>
      <Field label="Starts on"><DateField value={startOn} onChange={(e) => setStart(e.target.value)} required /></Field>
      <Field label="Open until"><DateField value={validUntil} min={p.today} onChange={(e) => setValid(e.target.value)} required /></Field>
      <PayFields payType={payType} setPayType={setPayType} monthly={monthly} setMonthly={setMonthly} ctc={ctc} setCtc={setCtc} rate={rate} setRate={setRate} hours={hours} setHours={setHours} auto={pv.data?.figures ?? null} />
      <Field label="Probation, days" hint="0 for none"><input inputMode="numeric" value={probation} onChange={(e) => setProbation(e.target.value)} /></Field>
      <Field label="Notice during probation, days"><input inputMode="numeric" value={notice} onChange={(e) => setNotice(e.target.value)} /></Field>
      <Field label="Other terms" wide hint="Goes into the letter as written."><textarea value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={4000} placeholder="e.g. Review after 3 months against the KPIs in the role terms." /></Field>
      {pv.data?.components.length ? <div className={styles.wide}><ComponentList items={pv.data.components} /></div> : null}
      {pv.data?.budget ? <p className={styles.wide}>Budget: <BudgetLine b={pv.data.budget} /></p> : null}
      {pv.data ? <div className={styles.wide}><LetterPreview kind="offer" data={pv.data.letter.data ?? null} name={p.person.name} role={role} /></div>
        : !pv.error ? <p className={`${styles.wide} ${css.quiet}`}>Fill in the role and pay to see the letter.</p> : null}
    </form>
  </Modal>;
}
export function ComponentList({ items }: { items: Component[] }) {
  return <table className={css.components}><caption>The pay, by component (a month)</caption><tbody>{items.map((c) => <tr key={c.key}><th scope="row">{c.label}{c.kind === "employer" ? <small> paid by the company</small> : null}</th><td>{rupees(c.amount)}</td></tr>)}</tbody></table>;
}

/** Sending: a founder's press. The link is shown once; Pulse sends nothing itself. */
export function SendOffer({ offer, name, onClose }: { offer: Offer; name: string; onClose: Done }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [link, setLink] = useState(true), [sent, setSent] = useState<{ url: string | null; validUntil: string } | null>(null), [copied, setCopied] = useState(false);
  async function send() {
    setBusy(true); setError("");
    try { setSent(await post<{ url: string | null; validUntil: string }>(`comp/offers/${offer.id}/send`, { link })); router.refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not send"); } finally { setBusy(false); }
  }
  return <Modal title={sent ? "The offer is sent" : `Send the offer to ${name}`} onClose={onClose}
    foot={<Foot error={error}>{sent ? <Primary type="button" onClick={onClose}>Done</Primary> : <><Ghost onClick={onClose}>Cancel</Ghost><Primary type="button" disabled={busy} onClick={send}>{busy ? "Sending…" : "Send"}</Primary></>}</Foot>}>
    <div className={styles.modalBody}>
      {sent ? <>
        <p className={styles.wide}>{name.split(" ")[0]} can read and answer it until {day(sent.validUntil)}{offer.taskId ? "; the linked task is marked done" : ""}.</p>
        {sent.url ? <div className={`${styles.wide} ${css.linkBox}`}><Link2 size={15} aria-hidden="true" /><input readOnly value={sent.url} aria-label="Acceptance link" onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className={styles.btn} onClick={async () => { await navigator.clipboard.writeText(sent.url!).catch(() => undefined); setCopied(true); }}>{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied ? "Copied" : "Copy"}</button></div> : null}
        {sent.url ? <p className={`${styles.wide} ${css.quiet}`}>This link is shown only now. Share it yourself (WhatsApp, e-mail). Anyone with it can read the offer, so send it to {name.split(" ")[0]} only.</p> : null}
      </> : <>
        <p className={styles.wide}>The approved letter becomes readable to {name.split(" ")[0]}: in My money if they sign in to Pulse, and through a link you share.</p>
        <label className={`${styles.wide} ${css.check}`}><input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />Make a link to share (valid until {day(offer.validUntil)})</label>
      </>}
    </div>
  </Modal>;
}

/** Link a task ("Issue … offer letter") so sending the offer finishes it. */
export function LinkTask({ offer, onClose }: { offer: Offer; onClose: Done }) {
  const formId = useId(), [task, setTask] = useState(""), { busy, error, run } = useSubmit(onClose, "Linked: sending the offer finishes that task");
  const taskId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(task)?.[1] ?? "";
  return <Modal title="Link a task" sub="When a founder sends this offer, Pulse marks the task done (with Undo)." onClose={onClose}
    foot={<Foot error={error}><Ghost onClick={onClose}>Cancel</Ghost><Primary form={formId} disabled={busy || !taskId}>Link</Primary></Foot>}>
    <form id={formId} className={styles.modalBody} onSubmit={(e) => { e.preventDefault(); void run(() => post(`comp/offers/${offer.id}/task`, { taskId })); }}>
      <Field label="The task's link" wide hint="Open the task and copy its address."><input value={task} onChange={(e) => setTask(e.target.value)} placeholder="https://…/tasks/…" /></Field>
    </form>
  </Modal>;
}

// ------------------------------------------------------------------------------------------- decisions
/** Approve, send back or reject, with a note (required to send back or reject). */
export function Decide({ title, sub, path, what, onClose, back = true, reject = true, children, approveLabel = "Approve", approveAction = "approve" }: { title: string; sub?: string; path: string; what: string; onClose: Done; back?: boolean; reject?: boolean; children?: ReactNode; approveLabel?: string; approveAction?: string }) {
  const [note, setNote] = useState(""), { busy, error, run } = useSubmit(onClose, "Done");
  const act = (action: string, said: string) => void run(() => post(path, { action, note }), said);
  return <Modal scroll size="lg" title={title} sub={sub} onClose={onClose}
    foot={<Foot error={error}>{reject ? <Ghost disabled={busy || !note.trim()} onClick={() => act("reject", `${what} rejected`)}>Reject</Ghost> : null}
      {back ? <Ghost disabled={busy || !note.trim()} onClick={() => act("return", `${what} sent back`)}>Send back</Ghost> : null}
      <Primary type="button" disabled={busy} onClick={() => act(approveAction, approveAction === "approve" ? `${what} approved` : `${what}: done`)}>{busy ? "Saving…" : approveLabel}</Primary></Foot>}>
    <div className={css.decide}>{children}
      <label className={styles.field}>Note{back || reject ? " (needed to send back or reject)" : ""}<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label>
    </div>
  </Modal>;
}
/** A version's before and after, for the approver. */
export function ChangeSummary({ v, name }: { v: Version; name: string }) {
  return <dl className={css.facts}>
    <div><dt>What</dt><dd>{CHANGE_KIND[v.kind]}{v.role ? `: ${v.role}` : ""} for {name}</dd></div>
    <div><dt>From</dt><dd>{day(v.effectiveOn)}</dd></div>
    <div><dt>Pay</dt><dd>{v.before ? <>{rupees(v.before.monthly)} → </> : null}<b>{rupees(v.figures?.monthly)}</b> a month{v.figures?.ctc ? ` · ${rupees(v.figures.ctc)} a year` : ""}</dd></div>
    <div><dt>Why</dt><dd>{v.reason ?? "—"}</dd></div>
    <div><dt>Proposed by</dt><dd>{v.proposedBy ?? "Pulse (from the records)"}</dd></div>
  </dl>;
}

// ------------------------------------------------------------------------------------------------ probation
export function Probation({ p, onClose }: { p: PersonPay; onClose: Done }) {
  const formId = useId(), e = p.employment;
  const [action, setAction] = useState<"confirm" | "extend" | "end">("confirm"), [until, setUntil] = useState(e.probationTo ? addDays(e.probationTo, 30) : p.today), [note, setNote] = useState("");
  const lastDay = addDays(p.today, p.policy.noticeProbation);
  const founder = action === "end" || p.policy.probationApproval === "founder";
  const { busy, error, run } = useSubmit(onClose, "Done");
  const data = { name: p.person.name, role: p.person.role, effective: p.today, probationEnd: action === "extend" ? until : null, lastDay: action === "end" ? until : null, reason: note, noticeConfirmed: p.policy.noticeConfirmed };
  return <Modal scroll size="lg" title={`Probation: ${p.person.name}`} sub={e.probationTo ? `Ends ${day(e.probationTo)}` : undefined} onClose={onClose}
    foot={<Foot error={error}><Ghost onClick={onClose}>Cancel</Ghost><Primary form={formId} disabled={busy}>{founder ? "Ask a founder" : action === "confirm" ? "Confirm" : "Extend"}</Primary></Foot>}>
    <form id={formId} className={styles.modalBody} onSubmit={(ev) => { ev.preventDefault(); void run(() => post(`comp/people/${p.person.id}/probation`, { action, until, note }), founder ? "A founder is asked to approve it" : action === "confirm" ? "Probation confirmed; the letter is filed" : "Probation extended; the letter is filed"); }}>
      <div className={`${styles.wide} ${css.kinds}`} role="radiogroup" aria-label="Outcome">{(["confirm", "extend", "end"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={action === k} className={css.kind} onClick={() => { setAction(k); setUntil(k === "end" ? lastDay : e.probationTo ? addDays(e.probationTo, 30) : p.today); }}>{{ confirm: "Confirm", extend: "Extend", end: "End" }[k]}</button>)}</div>
      {action !== "confirm" ? <Field label={action === "extend" ? "New end of probation" : "Last working day"} hint={action === "end" ? `${p.policy.noticeProbation} days' notice in probation` : undefined}><DateField value={until} onChange={(ev) => setUntil(ev.target.value)} required /></Field> : null}
      <Field label={action === "confirm" ? "Note (optional)" : "Why"} wide><textarea value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={1000} required={action !== "confirm"} /></Field>
      {action === "end" ? <p className={`${styles.wide} ${css.warn}`}>Ending employment needs care: a written reason, the notice (or pay in lieu) and a chance for {p.person.name.split(" ")[0]} to be heard. A founder approves it; the leaving checklist opens.</p> : null}
      <div className={styles.wide}><LetterPreview kind={`probation_${action}`} data={data} name={p.person.name} role={p.person.role} /></div>
    </form>
  </Modal>;
}

// --------------------------------------------------------------------------------------------------- pauses
export function PauseForm({ p, onClose }: { p: PersonPay; onClose: Done }) {
  const formId = useId(), [from, setFrom] = useState(addDays(p.today, 1)), [to, setTo] = useState(addDays(p.today, 30)), [paid, setPaid] = useState("0"), [reason, setReason] = useState("unpaid_leave"), [note, setNote] = useState("");
  const { busy, error, run } = useSubmit(onClose, "Pause proposed: a founder is asked to approve it");
  return <Modal scroll size="lg" title={`Pause ${p.person.name}'s pay`} sub="Between two dates, in full or in part. Payroll pays those days at the share you set." onClose={onClose}
    foot={<Foot error={error}><Ghost onClick={onClose}>Cancel</Ghost><Primary form={formId} disabled={busy}>Propose</Primary></Foot>}>
    <form id={formId} className={styles.modalBody} onSubmit={(e) => { e.preventDefault(); void run(() => post("comp/pauses", { person: p.person.id, from, to, paidPercent: Number(paid) || 0, reasonKind: reason, note })); }}>
      <Field label="First day"><DateField value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
      <Field label="Last day"><DateField value={to} min={from} onChange={(e) => setTo(e.target.value)} required /></Field>
      <Field label="Why"><SelectField value={reason} onChange={(e) => setReason(e.target.value)}>{Object.entries(PAUSE_REASON).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</SelectField></Field>
      <Field label="Paid during the pause, %" hint="0 = nothing paid; 50 = half pay"><input inputMode="numeric" value={paid} onChange={(e) => setPaid(e.target.value)} /></Field>
      <Field label="Note for the letter" wide><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} required /></Field>
      <div className={styles.wide}><LetterPreview kind="pause" data={{ name: p.person.name, payType: p.inForce?.payType ?? "salary", pauseFrom: from, pauseTo: to, resumeOn: addDays(to, 1), paidPercent: Number(paid) || 0, pauseReason: reason, reason: note }} name={p.person.name} role={p.person.role} /></div>
    </form>
  </Modal>;
}

// ----------------------------------------------------------------------------------------- one-time items
export function ItemForm({ p, onClose, kind: initial = "bonus" }: { p: PersonPay; onClose: Done; kind?: string }) {
  const formId = useId(), [kind, setKind] = useState(initial), [amount, setAmount] = useState(""), [month, setMonth] = useState(p.today.slice(0, 7)), [payout, setPayout] = useState("payroll");
  const [reason, setReason] = useState(""), [months, setMonths] = useState("3"), [dates, setDates] = useState("");
  const recover = ["advance", "loan"].includes(kind);
  const { busy, error, run } = useSubmit(onClose, `${ITEM_KIND[kind]} proposed: a founder is asked to approve it`);
  return <Modal scroll title={`Add a one-time item for ${p.person.name}`} onClose={onClose}
    foot={<Foot error={error}><Ghost onClick={onClose}>Cancel</Ghost><Primary form={formId} disabled={busy}>Propose</Primary></Foot>}>
    <form id={formId} className={styles.modalBody} onSubmit={(e) => { e.preventDefault(); void run(() => post("comp/items", { person: p.person.id, kind, amount, forMonth: `${month}-01`, payout, reason,
      recoverMonths: recover ? Number(months) : null, recoverFrom: recover ? `${addDays(`${month}-28`, 7).slice(0, 7)}-01` : null, dates: kind === "overtime" ? dates.split(/[\s,]+/).filter(Boolean) : [] })); }}>
      <Field label="What"><SelectField value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(ITEM_KIND).filter(([k]) => k !== "arrears").map(([k, l]) => <option key={k} value={k}>{l}</option>)}</SelectField></Field>
      <Money label="Amount" value={amount} onChange={setAmount} required />
      <Field label="Payroll month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} required /></Field>
      <Field label="Paid"><SelectField value={payout} onChange={(e) => setPayout(e.target.value)}><option value="payroll">With that month’s pay</option><option value="separate">Separately</option></SelectField></Field>
      {recover ? <Field label="Recover over, months" hint={`From the month after; at most ${p.policy.recoverMax}`}><input inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} /></Field> : null}
      {kind === "overtime" ? <Field label="Night or extra work on" wide hint="Dates, e.g. 2026-10-04 2026-10-05 (night-work rates are not set in Pulse yet)"><input value={dates} onChange={(e) => setDates(e.target.value)} /></Field> : null}
      <Field label="What it is for" wide><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} required /></Field>
    </form>
  </Modal>;
}

// ------------------------------------------------------------------------------------------ full and final
type Statement = { lastDay: string; exitKind: string; noticeMode: string; noticeRequired: number; noticeServed: number; settleBy: string; net: number;
  lines: { label: string; kind: string; amount: number; basis?: string }[]; letter: { kind: string; data: LetterData } };
const LEGAL = [["reason", "The reason is written down and shared with them"], ["notice", "Notice is given, or paid in lieu"], ["heard", "They had a chance to be heard (show cause), as the policy says"],
  ["dues", "Statutory dues are in the statement: final wages within two working days of the last day (Code on Wages, 2019); gratuity after five years"]] as const;
export function Settlement({ p, onClose }: { p: PersonPay; onClose: Done }) {
  const formId = useId(), step = (p.leavingCase?.settlement ?? {}) as Record<string, unknown>;
  const [lastDay, setLastDay] = useState(p.employment.lastWorkingDay ?? p.leavingCase?.effectiveOn ?? p.today);
  const [exitKind, setExit] = useState(p.settlement?.exitKind ?? (p.leavingCase?.leftType === "terminated" ? "terminated" : p.leavingCase?.leftType === "contract_ended" ? "contract_ended" : "resigned"));
  const [encash, setEncash] = useState(String(step.leaveDays ?? 0)), [required, setRequired] = useState(String(step.noticeRequiredDays ?? p.policy.noticeConfirmed)), [served, setServed] = useState(String(step.noticeServedDays ?? 0));
  const [mode, setMode] = useState(p.settlement?.noticeMode ?? ""), [lastPaid, setLastPaid] = useState(false), [legal, setLegal] = useState<Record<string, boolean>>(p.settlement?.legal ?? {}), [note, setNote] = useState(p.settlement?.note ?? "");
  const body = { person: p.person.id, lastDay, exitKind, encashDays: Number(encash) || 0, noticeRequired: Number(required) || 0, noticeServed: Number(served) || 0, noticeMode: mode || undefined, lastMonthPaid: lastPaid };
  const pv = usePreview<Statement>(`comp/people/${p.person.id}/settlement/preview`, body);
  const termination = ["terminated", "probation_end"].includes(exitKind);
  const { busy, error, run } = useSubmit(onClose, "Full and final prepared: HR checks it next");
  return <Modal scroll size="lg" title={`Full and final: ${p.person.name}`} sub="Pulse works it out." help="HR checks it, a founder approves it, then the settlement and relieving letter goes out." onClose={onClose}
    foot={<Foot error={error}><Ghost onClick={onClose}>Cancel</Ghost><Primary form={formId} disabled={busy || !pv.data}>{busy ? "Saving…" : "Prepare"}</Primary></Foot>}>
    <form id={formId} className={styles.modalBody} onSubmit={(e) => { e.preventDefault(); void run(() => post("comp/settlements", { ...body, legal, note })); }}>
      <PreviewProblem error={pv.error} />
      <Field label="How they leave"><SelectField value={exitKind} onChange={(e) => setExit(e.target.value)}>{Object.entries(EXIT_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</SelectField></Field>
      <Field label="Last working day"><DateField value={lastDay} onChange={(e) => setLastDay(e.target.value)} required /></Field>
      <Field label="Notice required, days"><input inputMode="numeric" value={required} onChange={(e) => setRequired(e.target.value)} /></Field>
      <Field label="Notice served, days"><input inputMode="numeric" value={served} onChange={(e) => setServed(e.target.value)} /></Field>
      <Field label="Notice" wide><SelectField value={mode} onChange={(e) => setMode(e.target.value)}><option value="">As the days say</option>{Object.entries(NOTICE_MODE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</SelectField></Field>
      <Field label="Leave days to encash" hint={`Policy: ${p.policy.encashBasis === "none" ? "no encashment" : `${p.policy.encashBasis} ÷ ${p.policy.encashDivisor} a day`}`}><input inputMode="decimal" value={encash} onChange={(e) => setEncash(e.target.value)} /></Field>
      <label className={css.check}><input type="checkbox" checked={lastPaid} onChange={(e) => setLastPaid(e.target.checked)} />The last month’s pay is paid with payroll</label>
      {termination ? <fieldset className={`${styles.wide} ${css.legal}`}><legend>Legal care for a termination</legend>{LEGAL.map(([k, l]) => <label key={k} className={css.check}><input type="checkbox" checked={!!legal[k]} onChange={(e) => setLegal({ ...legal, [k]: e.target.checked })} />{l}</label>)}
        <small className={css.hint}>HR cannot pass the statement on until each is ticked. Check the policy with the company’s counsel.</small></fieldset> : null}
      <div className={styles.wide}>{pv.data ? <StatementTable s={pv.data} /> : pv.error ? null : <p className={css.quiet}>Working it out…</p>}</div>
      <Field label="Note" wide><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
      {pv.data ? <div className={styles.wide}><LetterPreview kind="settlement" data={pv.data.letter.data} name={p.person.name} role={p.person.role} /></div> : null}
    </form>
  </Modal>;
}
export function StatementTable({ s }: { s: { lines: { label: string; kind: string; amount: number; basis?: string }[]; net: number; settleBy?: string } }) {
  return <table className={css.statement}><caption>The statement{s.settleBy ? `, to pay by ${day(s.settleBy)}` : ""}</caption>
    <tbody>{s.lines.map((l, i) => <tr key={i}><th scope="row">{l.label}{l.basis && !/\.\./.test(l.basis) ? <small>{l.basis}</small> : null}</th><td data-neg={l.amount < 0 ? "" : undefined}>{rupees(l.amount)}</td></tr>)}</tbody>
    <tfoot><tr><th scope="row">Net payable</th><td><b>{rupees(s.net)}</b></td></tr></tfoot></table>;
}

// ------------------------------------------------------------------------------------------------- claims
/** Snap a bill: a photo (the phone's camera) or a PDF, with the amount, date, category and a note. */
export function ClaimForm({ categories, threshold, onClose }: { categories: { key: string; label: string; cap?: number }[]; threshold: number | null; onClose: Done }) {
  const formId = useId(), [category, setCategory] = useState(categories[0]?.key ?? "other"), [spentOn, setSpent] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(""), [vendor, setVendor] = useState(""), [note, setNote] = useState(""), [receipt, setReceipt] = useState<{ url: string; name: string; image: boolean } | null>(null);
  const { busy, error, run } = useSubmit(onClose, "Claim sent: your head approves it");
  const read = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { notify({ id: "comp", tone: "error", title: "The bill is larger than 8 MB", message: "Take the photo again at a lower size.", timeout: 5000 }); return; }
    const r = new FileReader(); r.onload = () => setReceipt({ url: String(r.result), name: file.name, image: file.type.startsWith("image/") }); r.readAsDataURL(file);
  };
  return <Modal scroll title="Claim a reimbursement" sub="Your head approves it." help={threshold !== null ? `Above ${rupees(threshold * 100)}, HR or a founder approves it too. Approved claims are paid with the next payroll.` : "Approved claims are paid with the next payroll."} onClose={onClose}
    foot={<Foot error={error}><Ghost onClick={onClose}>Cancel</Ghost><Primary form={formId} disabled={busy || !receipt}>{busy ? "Sending…" : "Send claim"}</Primary></Foot>}>
    <form id={formId} className={styles.modalBody} onSubmit={(e) => { e.preventDefault(); void run(() => post("comp/claims", { category, spentOn, amount, vendor, note, receipt: receipt?.url })); }}>
      <label className={`${styles.wide} ${css.snap}`} data-has={receipt ? "" : undefined}>
        <input type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => read(e.target.files?.[0])} aria-label="Photo or PDF of the bill" />
        {receipt?.image
          // eslint-disable-next-line @next/next/no-img-element -- the photo just taken, a data URL
          ? <img src={receipt.url} alt="The bill" /> : <span>{receipt ? receipt.name : "Take a photo of the bill, or choose a PDF"}</span>}
      </label>
      <Money label="Amount" value={amount} onChange={setAmount} required />
      <Field label="Date on the bill"><DateField value={spentOn} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setSpent(e.target.value)} required /></Field>
      <Field label="Category"><SelectField value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</SelectField></Field>
      <Field label="Shop or vendor"><input value={vendor} onChange={(e) => setVendor(e.target.value)} maxLength={120} /></Field>
      <Field label="What it was for" wide><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Cab to the Baner shoot" /></Field>
    </form>
  </Modal>;
}

export const Chip = ({ tone, children }: { tone?: "neutral" | "warning" | "success" | "danger" | "accent"; children: ReactNode }) => <Badge tone={tone}>{children}</Badge>;
