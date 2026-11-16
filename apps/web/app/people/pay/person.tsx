"use client";

// COMP-A: one person's pay, from offer to exit, on one page: what they are paid now, what happens next and the one thing
// to do, then the story (versions with before and after, the offer, probation, pauses, one-time items, claims, the exit
// and every letter) and the timeline. Founders and HR see everything; the person sees their own on My money.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { CalendarClock, FileDown, FileText, Gift, LogOut, PauseCircle, PenLine, Send, ShieldCheck, Undo2, UserCheck } from "lucide-react";
import { notify } from "@pulse/ui-shell";
import type { LetterData } from "@pulse/invoice-doc/browser";
import { Modal, post } from "../../records";
import { Avatar, Badge, styles } from "../../ui";
import { ChangePay, ChangeSummary, ComponentList, Decide, ItemForm, LinkTask, OfferForm, PauseForm, Probation, SendOffer, Settlement, StatementTable } from "./flows";
import { LetterPreview } from "./letter-preview";
import { CHANGE_KIND, day, EXIT_KIND, ITEM_KIND, LETTER_KIND, monthName, NOTICE_MODE, PAUSE_REASON, PAY_TYPE, plural, rupees, STATUS, statusOf, type Event, type Item, type Offer, type Pause, type PersonPay, type Version } from "./model";
import css from "./pay.module.css";

type Open = { kind: string; id?: string } | null;
const OFFER_STATUS: Record<string, [string, "neutral" | "warning" | "success" | "danger" | "accent"]> = { draft: ["Draft", "neutral"], proposed: ["Waiting for a founder", "warning"],
  approved: ["Approved: to send", "accent"], sent: ["Sent", "accent"], accepted: ["Accepted", "success"], declined: ["Declined", "danger"], expired: ["Expired", "neutral"], withdrawn: ["Withdrawn", "neutral"] };
const STATE: Record<string, [string, "neutral" | "warning" | "success" | "danger" | "accent"]> = { draft: ["Draft", "neutral"], proposed: ["Waiting for approval", "warning"], approved: ["Approved", "success"],
  rejected: ["Rejected", "danger"], withdrawn: ["Withdrawn", "neutral"], submitted: ["Waiting for the head", "warning"], head_approved: ["Waiting for HR or a founder", "warning"],
  checked: ["Checked by HR", "accent"], issued: ["Letter issued", "success"] };
const Chip = ({ s, map = STATE }: { s: string; map?: Record<string, [string, "neutral" | "warning" | "success" | "danger" | "accent"]> }) => <Badge tone={map[s]?.[1] ?? "neutral"}>{map[s]?.[0] ?? s}</Badge>;
/** A preview from the API without telling the rest of the app that data changed (post() does). */
async function peek<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/v0/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "Not available");
  return d as T;
}
const Btn = ({ children, onClick, primary, icon }: { children: ReactNode; onClick: () => void; primary?: boolean; icon?: ReactNode }) =>
  <button type="button" className={`${styles.btn} ${primary ? styles.btnPrimary : ""}`} onClick={onClick}>{icon}{children}</button>;

/** What a timeline event says, in a few words. */
export function eventText(e: Event): string {
  const d = e.detail as Record<string, string>;
  const kind = CHANGE_KIND[d.kind] ?? ITEM_KIND[d.kind] ?? d.kind;
  const [what, how] = e.kind.split(".");
  const verb: Record<string, string> = { proposed: "proposed", drafted: "drafted", approved: "approved", rejected: "rejected", returned: "sent back", withdrawn: "withdrawn",
    sent: "sent", accepted: "accepted", declined: "declined", expired: "expired", opened: "opened through the link", started: "started", imported: "set up from the records",
    task_linked: "linked to a task", submitted: "submitted", head_approved: "approved by the head", issued: "issued", checked: "checked by HR", prepared: "prepared",
    reviewed: "review written", confirm: "confirmed", extend: "extended", end: "ended", ended: "ended early", set_up: "set up from the salary records" };
  if (e.kind === "status.changed") return `Status: ${STATUS[d.to as keyof typeof STATUS]?.label ?? d.to}`;
  if (e.kind === "letter.issued") return `${LETTER_KIND[d.kind] ?? "Letter"} issued`;
  const noun: Record<string, string> = { change: kind ?? "Pay change", offer: "Offer", probation: "Probation", pause: "Pause", item: kind ?? "One-time item", claim: "Reimbursement claim",
    settlement: "Full and final", record: "Pay record" };
  return `${noun[what] ?? what} ${verb[how] ?? how.replace(/_/g, " ")}${d.effectiveOn ? ` from ${day(d.effectiveOn)}` : d.startOn ? `, starting ${day(d.startOn)}` : d.from ? ` ${day(d.from)} to ${day(d.to)}` : ""}`;
}

function Section({ title, icon, children, tools, id }: { title: string; icon?: ReactNode; children: ReactNode; tools?: ReactNode; id?: string }) {
  return <section className={css.section} id={id} aria-label={title}><header>{icon}<h2>{title}</h2>{tools ? <div className={css.tools}>{tools}</div> : null}</header>{children}</section>;
}
function LetterLinks({ id }: { id: string | null }) {
  if (!id) return null;
  return <span className={css.letterLinks}><a href={`/api/v0/comp/letters/${id}/pdf?inline=1`} target="_blank" rel="noreferrer"><FileText size={13} aria-hidden="true" />Letter</a><a href={`/api/v0/comp/letters/${id}/docx`}><FileDown size={13} aria-hidden="true" />Word</a></span>;
}

export function PersonPayView({ p, start }: { p: PersonPay; start?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(start ? { kind: start } : null);
  const close = () => setOpen(null);
  const can = p.can, me = can.propose, approve = can.approve;
  const offer = (p.offers ?? []).find((o) => ["draft", "proposed", "approved", "sent"].includes(o.status)) ?? (p.offers ?? [])[0] ?? null;
  const pending = (p.versions ?? []).filter((v) => ["draft", "proposed"].includes(v.status));
  const st = p.record ? statusOf(p.record.status, p.inForce?.payType) : null, now = p.inForce;
  const probation = p.employment.probationTo && !p.record?.confirmedOn && p.record?.status === "probation";
  const act = async (path: string, body: Record<string, unknown>, said: string) => {
    try { await post(path, body); notify({ id: "comp", tone: "success", title: said, timeout: 3000 }); router.refresh(); }
    catch (e) { notify({ id: "comp", tone: "error", title: e instanceof Error ? e.message : "Could not save", timeout: 5000 }); }
  };
  // The one step a row's action asked for opens straight away (People & pay → "Review offer" etc.).
  useEffect(() => { if (start) router.replace(`/people/pay/${p.person.id}`, { scroll: false }); }, [start, p.person.id, router]);

  const next: { label: string; when?: string | null; button?: ReactNode }[] = [];
  if (offer && ["draft", "proposed", "approved"].includes(offer.status)) next.push({ label: `Offer ${OFFER_STATUS[offer.status][0].toLowerCase()}`, when: offer.startOn,
    button: offer.status === "draft" && me ? <Btn primary onClick={() => act(`comp/offers/${offer.id}/propose`, {}, "Sent to a founder")}>Ask a founder</Btn>
      : offer.status === "proposed" && approve && offer.proposedById !== p.me ? <Btn primary onClick={() => setOpen({ kind: "offer.approve" })}>Review offer</Btn>
      : offer.status === "approved" && approve ? <Btn primary icon={<Send size={14} aria-hidden="true" />} onClick={() => setOpen({ kind: "offer.send" })}>Send offer</Btn> : null });
  for (const v of pending) next.push({ label: `${CHANGE_KIND[v.kind]} ${v.status === "draft" ? "draft" : "waiting for approval"}`, when: v.effectiveOn,
    button: v.status === "proposed" && approve && v.proposedById !== p.me ? <Btn primary onClick={() => setOpen({ kind: "change.approve", id: v.id })}>Review change</Btn> : null });
  if (probation) next.push({ label: `Probation ends ${day(p.employment.probationTo)}`, when: p.employment.probationTo, button: me ? <Btn primary onClick={() => setOpen({ kind: "probation" })}>Confirm probation</Btn> : null });
  const outcome = p.probation.outcomes.find((b) => b.status === "proposed");
  if (outcome) next.push({ label: `Probation ${outcome.action} waiting for a founder`, button: approve && outcome.proposedById !== p.me ? <Btn primary onClick={() => setOpen({ kind: "probation.approve", id: outcome.id })}>Review</Btn> : null });
  for (const z of p.pauses.filter((x) => x.status === "proposed")) next.push({ label: "Pause waiting for approval", when: z.from, button: approve && z.proposedById !== p.me ? <Btn primary onClick={() => setOpen({ kind: "pause.approve", id: z.id })}>Review pause</Btn> : null });
  for (const i of (p.items ?? []).filter((x) => x.status === "proposed")) next.push({ label: `${ITEM_KIND[i.kind]} waiting for approval`, button: approve && i.proposedById !== p.me ? <Btn primary onClick={() => setOpen({ kind: "item.approve", id: i.id })}>Review</Btn> : null });
  const s = p.settlement;
  if (s && s.status === "draft") next.push({ label: "Full and final to check", when: s.lastDay, button: me ? <Btn primary onClick={() => setOpen({ kind: "settlement.check" })}>Check it</Btn> : null });
  if (s && s.status === "checked") next.push({ label: "Full and final waiting for a founder", when: s.lastDay, button: approve && s.checkedById !== p.me ? <Btn primary onClick={() => setOpen({ kind: "settlement.approve" })}>Review</Btn> : null });
  if (!s && p.leavingCase) next.push({ label: `Leaving on ${day(p.employment.lastWorkingDay ?? p.leavingCase.effectiveOn)}: prepare the full and final`, button: me ? <Btn primary onClick={() => setOpen({ kind: "settlement" })}>Full and final</Btn> : null });

  return <div className={css.page}>
    <header className={css.hero}>
      <Avatar name={p.person.name} id={p.person.id} photoAt={p.person.photoAt} size={52} />
      <div className={css.heroText}>
        <h1>{p.person.name}</h1>
        <p>{[p.person.role, p.person.pod, p.person.head ? `Head: ${p.person.head}` : null].filter(Boolean).join(" · ")}</p>
        <div className={css.chips}>{st ? <Badge tone={st.tone}>{st.label}</Badge> : <Badge>No pay record</Badge>}
          {p.record?.since ? <span className={css.quiet}>since {day(p.record.since)}{p.record.until ? `, until ${day(p.record.until)}` : ""}</span> : null}</div>
      </div>
      <div className={css.figure} aria-label="Pay now">
        {now?.figures ? <><b>{now.payType === "hourly" && now.figures.rate ? `${rupees(now.figures.rate)} an hour` : `${rupees(now.figures.monthly)}`}</b>
          <span>{now.payType === "hourly" ? "" : "a month"}{now.figures.ctc && now.payType === "salary" ? ` · ${rupees(now.figures.ctc)} a year (CTC)` : ""}</span>
          <small>{PAY_TYPE[now.payType]} since {day(now.effectiveOn)}</small></>
          : now ? <><b>Sealed</b><small>{p.keyring ? "Not shown to this account" : "The document key is not installed: pay cannot be shown"}</small></> : <><b>—</b><small>No pay in force</small></>}
      </div>
    </header>

    {me ? <nav className={css.actions} aria-label="Pay actions">
      {["candidate", "offer"].includes(p.person.stage) ? null : !p.record || !(p.versions ?? []).some((v) => v.status === "approved") ? <>
        <Btn primary icon={<PenLine size={14} aria-hidden="true" />} onClick={() => act(`comp/people/${p.person.id}/setup`, {}, "Proposed from the salary records: the pay approver approves it")}>Set up from salary records</Btn>
        <Btn onClick={() => setOpen({ kind: "start" })}>Enter pay</Btn></> : <Btn primary icon={<PenLine size={14} aria-hidden="true" />} onClick={() => setOpen({ kind: "change" })}>Change pay</Btn>}
      {!offer || !["draft", "proposed", "approved", "sent"].includes(offer.status) ? <Btn icon={<Send size={14} aria-hidden="true" />} onClick={() => setOpen({ kind: "offer" })}>Offer</Btn> : null}
      {probation ? <Btn icon={<UserCheck size={14} aria-hidden="true" />} onClick={() => setOpen({ kind: "probation" })}>Probation</Btn> : null}
      {now ? <><Btn icon={<PauseCircle size={14} aria-hidden="true" />} onClick={() => setOpen({ kind: "pause" })}>Pause pay</Btn>
        <Btn icon={<Gift size={14} aria-hidden="true" />} onClick={() => setOpen({ kind: "item" })}>Bonus or advance</Btn>
        <Btn icon={<LogOut size={14} aria-hidden="true" />} onClick={() => setOpen({ kind: "settlement" })}>Full and final</Btn></> : null}
    </nav> : null}

    <Section title="Next" icon={<CalendarClock size={16} aria-hidden="true" />}>
      {next.length ? <ul className={css.next}>{next.map((n, i) => <li key={i}><span>{n.label}{n.when ? <small> · {day(n.when)}</small> : null}</span>{n.button}</li>)}</ul>
        : <p className={css.quiet}>Nothing waits. {p.record?.status === "confirmed" ? "Pay is confirmed and in force." : ""}</p>}
    </Section>

    {now?.components?.length ? <Section title="The pay now, by component"><ComponentList items={now.components} /></Section> : null}

    {offer ? <Section title="Offer" icon={<Send size={16} aria-hidden="true" />} tools={<Chip s={offer.status} map={OFFER_STATUS} />}>
      <dl className={css.facts}>
        <div><dt>Role</dt><dd>{offer.role}</dd></div><div><dt>Starts</dt><dd>{day(offer.startOn)}</dd></div>
        <div><dt>Pay</dt><dd>{offer.figures ? `${rupees(offer.figures.monthly)} a month${offer.figures.ctc ? ` · ${rupees(offer.figures.ctc)} a year` : ""} · ${PAY_TYPE[offer.payType]}` : "Sealed"}</dd></div>
        <div><dt>Probation</dt><dd>{offer.probationDays ? `${offer.probationDays} days` : "None"}{offer.noticeDays !== null ? ` · notice ${offer.noticeDays} days` : ""}</dd></div>
        <div><dt>Open until</dt><dd>{day(offer.validUntil)}{offer.link?.openedAt ? " · opened" : ""}</dd></div>
        {offer.terms ? <div><dt>Terms</dt><dd>{offer.terms}</dd></div> : null}
        <div><dt>Drafted by</dt><dd>{offer.proposedBy ?? "Pulse, from the role terms"}{offer.approvedBy ? ` · approved by ${offer.approvedBy}` : ""}{offer.sentBy ? ` · sent by ${offer.sentBy}` : ""}</dd></div>
        {offer.answeredAt ? <div><dt>Answer</dt><dd>{offer.status === "accepted" ? "Accepted" : "Declined"} by {offer.answerName} on {day(offer.answeredAt.slice(0, 10))} ({offer.answerVia === "link" ? "through the link" : "in Pulse"})</dd></div> : null}
        {offer.task ? <div><dt>Task</dt><dd><Link href={`/tasks/${offer.taskId}`}>{offer.task}</Link>: done when the offer is sent</dd></div> : null}
      </dl>
      <div className={css.rowTools}><LetterLinks id={offer.letterId} />
        {me && ["draft", "proposed", "approved"].includes(offer.status) ? <><Btn onClick={() => setOpen({ kind: "offer.edit" })}>Edit</Btn>{!offer.taskId ? <Btn onClick={() => setOpen({ kind: "offer.task" })}>Link a task</Btn> : null}</> : null}
        {(me || approve) && ["draft", "proposed", "approved", "sent"].includes(offer.status) ? <Btn icon={<Undo2 size={14} aria-hidden="true" />} onClick={() => setOpen({ kind: "offer.withdraw" })}>Withdraw</Btn> : null}
      </div>
    </Section> : null}

    <Section title="Pay history" icon={<FileText size={16} aria-hidden="true" />} tools={<span className={css.quiet}>{plural((p.versions ?? []).length, "version")}</span>}>
      {(p.versions ?? []).length ? <ol className={css.history}>{(p.versions ?? []).map((v) => <VersionRow key={v.id} v={v} p={p} onApprove={() => setOpen({ kind: "change.approve", id: v.id })}
        onWithdraw={() => act(`comp/changes/${v.id}/withdraw`, {}, "Withdrawn")} />)}</ol> : <p className={css.quiet}>No pay recorded yet. {me ? "Set it up from the salary records, or enter it." : ""}</p>}
    </Section>

    {p.employment.probationFrom || p.probation.reviews.length ? <Section title="Probation" icon={<UserCheck size={16} aria-hidden="true" />}
      tools={p.record?.confirmedOn ? <Badge tone="success">Confirmed {day(p.record.confirmedOn)}</Badge> : p.employment.probationTo ? <span className={css.quiet}>{day(p.employment.probationFrom)} to {day(p.employment.probationTo)}</span> : null}>
      <ul className={css.list}>{p.probation.reviews.map((r) => <li key={r.id}><span><b>{r.kind === "final" ? "Final review" : "Midpoint review"}</b> due {day(r.dueOn)}{r.doneBy ? ` · written by ${r.doneBy}` : ""}{r.note ? <small>{r.note}</small> : null}</span>
        {r.status === "due" && (me || can.manager) ? <Btn onClick={() => setOpen({ kind: "review", id: r.id })}>Write review</Btn> : <Chip s={r.status === "done" ? "approved" : r.status} map={{ approved: ["Done", "success"], due: ["Due", "warning"], skipped: ["Closed", "neutral"] }} />}</li>)}
        {p.probation.outcomes.map((b) => <li key={b.id}><span><b>{{ confirm: "Confirm", extend: "Extend", end: "End" }[b.action]}</b>{b.until ? ` · ${day(b.until)}` : ""}{b.note ? <small>{b.note}</small> : null}<small>Proposed by {b.proposedBy}{b.decidedBy ? ` · decided by ${b.decidedBy}` : ""}</small></span>
          <span className={css.rowTools}><LetterLinks id={b.letterId} /><Chip s={b.status} /></span></li>)}</ul>
    </Section> : null}

    {p.pauses.length ? <Section title="Pauses" icon={<PauseCircle size={16} aria-hidden="true" />}><ul className={css.list}>{p.pauses.map((z) => <PauseRow key={z.id} z={z} me={me} approve={approve} viewer={p.me}
      onApprove={() => setOpen({ kind: "pause.approve", id: z.id })} act={act} today={p.today} />)}</ul></Section> : null}

    {(p.items ?? []).length || (p.claims ?? []).length ? <Section title="One-time items and claims" icon={<Gift size={16} aria-hidden="true" />}>
      <ul className={css.list}>{(p.items ?? []).map((i) => <ItemRow key={i.id} i={i} me={me} approve={approve} viewer={p.me} onApprove={() => setOpen({ kind: "item.approve", id: i.id })} act={act} />)}
        {(p.claims ?? []).map((k) => <li key={k.id}><span><b>Reimbursement · {rupees(k.amount)}</b> {k.vendor ? `· ${k.vendor}` : ""} · {day(k.spentOn)}<small>{k.category}{k.note ? ` · ${k.note}` : ""}{k.decidedBy ? ` · decided by ${k.decidedBy}` : k.headBy ? ` · approved by ${k.headBy}` : ""}</small></span>
          <span className={css.rowTools}><a href={`/api/v0/comp/claims/${k.id}/receipt`} target="_blank" rel="noreferrer">Bill</a><Chip s={k.status} /></span></li>)}</ul>
    </Section> : null}

    {s ? <Section title="Exit: full and final" icon={<LogOut size={16} aria-hidden="true" />} tools={<Chip s={s.status} />}>
      <dl className={css.facts}><div><dt>How</dt><dd>{EXIT_KIND[s.exitKind]}</dd></div><div><dt>Last day</dt><dd>{day(s.lastDay)}</dd></div><div><dt>Notice</dt><dd>{NOTICE_MODE[s.noticeMode]}</dd></div>
        <div><dt>Prepared</dt><dd>{s.preparedBy}{s.checkedBy ? ` · checked by ${s.checkedBy}` : ""}{s.approvedBy ? ` · approved by ${s.approvedBy}` : ""}</dd></div></dl>
      <SettlementLines id={s.id} />
      <div className={css.rowTools}><LetterLinks id={s.letterId} />{me && ["draft", "checked"].includes(s.status) ? <Btn onClick={() => setOpen({ kind: "settlement" })}>Work it out again</Btn> : null}</div>
    </Section> : null}

    {(p.letters ?? []).length ? <Section title="Letters" icon={<FileText size={16} aria-hidden="true" />}><ul className={css.list}>{(p.letters ?? []).map((l) => <li key={l.id}>
      <span><b>{l.title}</b><small>{LETTER_KIND[l.kind]} · {day(l.issuedAt.slice(0, 10))}{l.issuedBy ? ` · filed by ${l.issuedBy}` : ""}{l.seenAt ? " · read by them" : ""}</small></span><LetterLinks id={l.id} /></li>)}</ul></Section> : null}

    <Section title="Timeline"><ol className={css.timeline}>{p.timeline.map((e, i) => <li key={i}><time dateTime={e.at}>{day(e.at.slice(0, 10))}</time><span>{eventText(e)}</span>{e.by ? <small>{e.by}</small> : null}</li>)}</ol>
      <p className={css.quiet}><ShieldCheck size={13} aria-hidden="true" /> Every look at this pay and every change is logged.</p></Section>

    {open?.kind === "change" || open?.kind === "start" ? <ChangePay p={p} onClose={close} start={open.kind === "start"} /> : null}
    {open?.kind === "offer" || open?.kind === "offer.edit" ? <OfferForm p={p} offer={open.kind === "offer.edit" ? offer : null} onClose={close} /> : null}
    {open?.kind === "offer.send" && offer ? <SendOffer offer={offer} name={p.person.name} onClose={close} /> : null}
    {open?.kind === "offer.task" && offer ? <LinkTask offer={offer} onClose={close} /> : null}
    {open?.kind === "offer.propose" && offer ? <Decide title="Ask a founder to approve the offer" path={`comp/offers/${offer.id}/propose`} what="Offer" onClose={close} back={false} reject={false} approveLabel="Ask a founder"><OfferFacts o={offer} /></Decide> : null}
    {open?.kind === "offer.approve" && offer ? <Decide title={`Offer for ${p.person.name}`} sub="Approve it to file the letter; then a founder sends it." path={`comp/offers/${offer.id}/decide`} what="Offer" onClose={close}><OfferFacts o={offer} /><OfferLetter o={offer} p={p} /></Decide> : null}
    {open?.kind === "offer.withdraw" && offer ? <Withdraw path={`comp/offers/${offer.id}/withdraw`} onClose={close} /> : null}
    {open?.kind === "change.approve" ? (() => { const v = (p.versions ?? []).find((x) => x.id === open.id) ?? pending.find((x) => x.status === "proposed"); return v ? <Decide title={`${CHANGE_KIND[v.kind]} for ${p.person.name}`} sub="Approving files the letter and tells them." path={`comp/changes/${v.id}/decide`} what={CHANGE_KIND[v.kind]} onClose={close}><ChangeSummary v={v} name={p.person.name} /><ChangeLetter v={v} p={p} /></Decide> : null; })() : null}
    {open?.kind === "probation" ? <Probation p={p} onClose={close} /> : null}
    {open?.kind === "probation.approve" && outcome ? <Decide title={`Probation: ${p.person.name}`} path={`comp/probation/${outcome.id}/decide`} what="Probation" onClose={close} back={false}>
      <dl className={css.facts}><div><dt>Outcome</dt><dd>{outcome.action}{outcome.until ? ` · ${day(outcome.until)}` : ""}</dd></div><div><dt>Why</dt><dd>{outcome.note}</dd></div><div><dt>Proposed by</dt><dd>{outcome.proposedBy}</dd></div></dl></Decide> : null}
    {open?.kind === "review" ? <Review id={open.id!} onClose={close} /> : null}
    {open?.kind === "pause" ? <PauseForm p={p} onClose={close} /> : null}
    {open?.kind === "pause.approve" ? (() => { const z = p.pauses.find((x) => x.id === open.id); return z ? <Decide title={`Pause for ${p.person.name}`} path={`comp/pauses/${z.id}/decide`} what="Pause" onClose={close} back={false}>
      <dl className={css.facts}><div><dt>Days</dt><dd>{day(z.from)} to {day(z.to)}</dd></div><div><dt>Paid</dt><dd>{z.paidPercent ? `${z.paidPercent}%` : "Nothing"}</dd></div><div><dt>Why</dt><dd>{PAUSE_REASON[z.reasonKind]}: {z.note}</dd></div></dl></Decide> : null; })() : null}
    {open?.kind === "item" ? <ItemForm p={p} onClose={close} /> : null}
    {open?.kind === "item.approve" ? (() => { const i = (p.items ?? []).find((x) => x.id === open.id); return i ? <Decide title={`${ITEM_KIND[i.kind]} for ${p.person.name}`} path={`comp/items/${i.id}/decide`} what={ITEM_KIND[i.kind]} onClose={close} back={false}>
      <dl className={css.facts}><div><dt>Amount</dt><dd>{rupees(i.amount)}</dd></div><div><dt>Month</dt><dd>{monthName(i.forMonth)} · {i.payout === "payroll" ? "with pay" : "separately"}</dd></div>
        {i.recoverMonths ? <div><dt>Recovered</dt><dd>over {i.recoverMonths} months from {monthName(i.recoverFrom)}</dd></div> : null}<div><dt>For</dt><dd>{i.reason}</dd></div></dl></Decide> : null; })() : null}
    {open?.kind === "settlement" ? <Settlement p={p} onClose={close} /> : null}
    {open?.kind === "settlement.check" && s ? <Decide title={`Check the full and final for ${p.person.name}`} sub="When it is right, a founder approves it." path={`comp/settlements/${s.id}/step`} what="Full and final" onClose={close} back={false} reject={false} approveLabel="It is right: pass it on" approveAction="check"><SettlementLines id={s.id} check /></Decide> : null}
    {open?.kind === "settlement.approve" && s ? <Decide title={`Full and final for ${p.person.name}`} sub="Approving issues the letter." path={`comp/settlements/${s.id}/step`} what="Full and final" onClose={close} reject={false}><SettlementLines id={s.id} /></Decide> : null}
  </div>;
}

function VersionRow({ v, p, onApprove, onWithdraw }: { v: Version; p: PersonPay; onApprove: () => void; onWithdraw: () => void }) {
  return <li data-in-force={v.inForce ? "" : undefined}>
    <div className={css.vHead}><b>{CHANGE_KIND[v.kind]}{v.role && v.kind !== "start" ? `: ${v.role}` : ""}</b><span>from {day(v.effectiveOn)}</span>{v.inForce ? <Badge tone="success">In force</Badge> : <Chip s={v.status} />}</div>
    <p className={css.vPay}>{v.before && v.kind !== "start" ? <><span>{rupees(v.before.monthly)}</span> → </> : null}<b>{v.figures ? rupees(v.figures.monthly) : "Sealed"}</b> a month{v.figures?.ctc ? ` · ${rupees(v.figures.ctc)} a year` : ""} · {PAY_TYPE[v.payType]}</p>
    <small>{v.reason}{v.proposedBy ? ` · proposed by ${v.proposedBy}` : v.source === "import" ? " · from the salary records" : ""}{v.decidedBy ? ` · approved by ${v.decidedBy}` : ""}{v.decisionNote ? ` · “${v.decisionNote}”` : ""}</small>
    <div className={css.rowTools}><LetterLinks id={v.letterId} />{v.status === "proposed" && p.can.approve && v.proposedById !== p.me ? <Btn primary onClick={onApprove}>Review</Btn> : null}
      {["draft", "proposed"].includes(v.status) && p.can.propose ? <Btn onClick={onWithdraw}>Withdraw</Btn> : null}</div>
  </li>;
}
function PauseRow({ z, me, approve, viewer, onApprove, act, today }: { z: Pause; me: boolean; approve: boolean; viewer?: string | null; onApprove: () => void; act: (path: string, body: Record<string, unknown>, said: string) => void; today: string }) {
  return <li><span><b>{day(z.from)} to {day(z.endedOn ?? z.to)}</b> · {z.paidPercent ? `${z.paidPercent}% paid` : "unpaid"} · {PAUSE_REASON[z.reasonKind]}<small>{z.note}{z.decidedBy ? ` · approved by ${z.decidedBy}` : ""}</small></span>
    <span className={css.rowTools}><LetterLinks id={z.letterId} />{z.status === "proposed" && approve && z.proposedById !== viewer ? <Btn primary onClick={onApprove}>Review</Btn> : null}
      {z.status === "proposed" && me ? <Btn onClick={() => act(`comp/pauses/${z.id}/close`, { action: "withdraw" }, "Pause withdrawn")}>Withdraw</Btn> : null}
      {z.status === "approved" && me && (z.endedOn ?? z.to) > today ? <Btn onClick={() => act(`comp/pauses/${z.id}/close`, { action: "end", on: today }, "Pause ended today")}>End today</Btn> : null}<Chip s={z.status} /></span></li>;
}
function ItemRow({ i, me, approve, viewer, onApprove, act }: { i: Item; me: boolean; approve: boolean; viewer?: string | null; onApprove: () => void; act: (path: string, body: Record<string, unknown>, said: string) => void }) {
  return <li><span><b>{ITEM_KIND[i.kind]} · {rupees(i.amount)}</b> · {monthName(i.forMonth)}{i.payout === "separate" ? " · paid separately" : ""}
    <small>{i.reason}{i.schedule ? ` · recovered ${i.schedule.map((x) => `${monthName(x.month)} ${rupees(x.amount)}`).join(", ")}` : ""}{i.decidedBy ? ` · approved by ${i.decidedBy}` : ""}</small></span>
    <span className={css.rowTools}>{i.status === "proposed" && approve && i.proposedById !== viewer ? <Btn primary onClick={onApprove}>Review</Btn> : null}
      {i.status === "proposed" && me ? <Btn onClick={() => act(`comp/items/${i.id}/decide`, { action: "withdraw" }, "Withdrawn")}>Withdraw</Btn> : null}<Chip s={i.status} /></span></li>;
}
function OfferFacts({ o }: { o: Offer }) {
  return <dl className={css.facts}><div><dt>Role</dt><dd>{o.role}</dd></div><div><dt>Starts</dt><dd>{day(o.startOn)}</dd></div>
    <div><dt>Pay</dt><dd>{o.figures ? `${rupees(o.figures.monthly)} a month${o.figures.ctc ? ` · ${rupees(o.figures.ctc)} a year` : ""}` : "Sealed"} · {PAY_TYPE[o.payType]}</dd></div>
    <div><dt>Probation</dt><dd>{o.probationDays ? `${o.probationDays} days` : "None"}</dd></div>{o.terms ? <div><dt>Terms</dt><dd>{o.terms}</dd></div> : null}
    <div><dt>Drafted by</dt><dd>{o.proposedBy ?? "Pulse, from the role terms"}</dd></div></dl>;
}
/** The approver reads the letter they are about to file. */
function OfferLetter({ o, p }: { o: Offer; p: PersonPay }) {
  const [data, setData] = useState<LetterData | null>(null);
  useEffect(() => {
    if (!o.figures) return;
    const t = setTimeout(() => peek<{ letter: { data: LetterData } }>("comp/offers/preview", { person: p.person.id, role: o.role, startOn: o.startOn, payType: o.payType, figures: { monthly: o.figures!.monthly / 100, ctc: o.figures!.ctc ? o.figures!.ctc / 100 : "", rate: o.figures!.rate ? o.figures!.rate / 100 : "", hours: o.figures!.hours ?? "" },
      probationDays: o.probationDays, noticeDays: o.noticeDays ?? "", validUntil: o.validUntil, terms: o.terms ?? "" }).then((r) => setData(r.letter.data)).catch(() => undefined), 0);
    return () => clearTimeout(t);
  }, [o, p.person.id]);
  return <LetterPreview kind="offer" data={data} name={p.person.name} role={o.role} />;
}
function ChangeLetter({ v, p }: { v: Version; p: PersonPay }) {
  const [data, setData] = useState<{ kind: string; data: LetterData } | null>(null);
  useEffect(() => {
    if (!v.figures) return;
    const t = setTimeout(() => peek<{ letter: { kind: string; data: LetterData } }>("comp/preview", { person: p.person.id, kind: v.kind, effectiveOn: v.effectiveOn, payType: v.payType, role: v.role ?? "", reason: v.reason ?? "", correctsId: v.correctsId,
      figures: { monthly: v.figures!.monthly / 100, ctc: v.figures!.ctc ? v.figures!.ctc / 100 : "", rate: v.figures!.rate ? v.figures!.rate / 100 : "", hours: v.figures!.hours ?? "", components: Object.fromEntries(Object.entries(v.figures!.components).map(([k, x]) => [k, x / 100])) } })
      .then((r) => setData(r.letter)).catch(() => undefined), 0);
    return () => clearTimeout(t);
  }, [v, p.person.id]);
  return <LetterPreview kind={data?.kind ?? "revision"} data={data?.data ?? null} name={p.person.name} role={v.role ?? p.person.role} />;
}
function SettlementLines({ id, check }: { id: string; check?: boolean }) {
  const [s, setS] = useState<{ lines: { label: string; kind: string; amount: number; basis?: string }[]; net: number; settleBy?: string } | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let gone = false;
    fetch(`/api/v0/comp/settlements/${id}`).then(async (r) => { const d = await r.json(); if (gone) return; if (r.ok) setS(d); else setError(d.error ?? "Not available"); }).catch(() => undefined);
    return () => { gone = true; };
  }, [id]);
  return error ? <p className={css.quiet}>{error}</p> : s ? <><StatementTable s={s} />{check ? <p className={css.quiet}>Check each line against the leaving checklist, the leave balance and the pay record. To change something, work it out again.</p> : null}</> : <p className={css.quiet}>Opening…</p>;
}
function Review({ id, onClose }: { id: string; onClose: () => void }) {
  const router = useRouter(), [note, setNote] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  return <Modal title="Probation review" sub="How the probation is going: what went well, what to work on. HR and the manager read it." onClose={onClose}
    foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Cancel</button>
      <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || note.trim().length < 3} onClick={async () => { setBusy(true); try { await post(`comp/reviews/${id}`, { note }); onClose(); router.refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); } }}>Save review</button></div>}>
    <div className={styles.modalBody}><label className={`${styles.field} ${styles.wide}`}>Review<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></label></div>
  </Modal>;
}
function Withdraw({ path, onClose }: { path: string; onClose: () => void }) {
  const router = useRouter(), [note, setNote] = useState(""), [error, setError] = useState("");
  return <Modal title="Withdraw the offer" sub="A sent offer's link stops working at once." onClose={onClose}
    foot={<div className={styles.modalFoot}><p role="alert" className={styles.status}>{error}</p><button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={onClose}>Keep it</button>
      <button type="button" className={`${styles.btn} ${styles.btnDanger ?? styles.btnPrimary}`} onClick={async () => { try { await post(path, { note }); onClose(); router.refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Could not withdraw"); } }}>Withdraw</button></div>}>
    <div className={styles.modalBody}><label className={`${styles.field} ${styles.wide}`}>Why<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label></div>
  </Modal>;
}
