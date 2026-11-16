"use client";
// HR-PEOPLE (owner, 13 Nov 2026, T1.1.4: "People / pay … is cluttered … How do you use it?"; Codex concept people-pay 1,
// "Progress first"): one clear flow. The top says how far pay is set up, with the one button that does the rest (Set up
// pay, one person after another, without leaving the page), the month's payroll and the pay policy everyone accepts.
// Under it, one list with the groups that have someone in them. Pay figures stay hidden until asked for, every look
// logged (COMP-A), and hidden again when the tab is left.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Banknote, Eye, EyeOff, FileCheck2, ShieldCheck, UserRoundPlus } from "lucide-react";
import { FinTable, type FinRow } from "../../finance/table";
import { styles } from "../../ui";
import { Chip, ProgressRing } from "../../kit/game";
import { dayShort, PAY_TYPE, rupees, statusOf, type PayRow, type PeopleData } from "./model";
import { SetupWalk } from "./setup-walk";
import { ApproveSetups } from "./flows";
import { setupWalk, waitingSetups } from "../../lib/pay-setup.mjs";
import css from "./pay.module.css";

/** The pay policy document's state (HR policy documents, kind "pay"; migration 2041). */
export type PolicyDocState = { version: number | null; published: boolean; accepted: number; of: number; draft: boolean } | null;

/** Where a row's one action goes: the person's page opens the matching step (set up pay opens here instead). */
const actionHref = (r: PayRow) => r.action?.key === "claims" ? "/people/pay/claims" : `/people/pay/${r.id}?do=${encodeURIComponent(r.action!.key)}`;

export function PayHome({ data, payroll, doc, me }: { data: PeopleData; payroll?: { text: string; href: string; act: boolean; /** no run yet */ none?: boolean } | null; doc: PolicyDocState;
  /** The person looking (WORKFLOW-QA): nobody proposes their own pay, so their row stays out of the set-up walk. */ me?: string | null }) {
  const [pay, setPay] = useState<Map<string, NonNullable<PayRow["pay"]>> | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [walk, setWalk] = useState<{ ids: string[]; at: number } | null>(null), [approving, setApproving] = useState(false);
  useEffect(() => {
    if (!pay) return;
    const hide = () => { if (document.hidden) setPay(null); };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [pay]);
  async function show() {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/v0/comp/people?figures=1"), d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Pay figures are not available");
      setPay(new Map((d.people as PayRow[]).filter((p) => p.pay).map((p) => [p.id, p.pay!])));
    } catch (e) { setError(e instanceof Error ? e.message : "Pay figures are not available"); } finally { setBusy(false); }
  }
  const current = data.people.filter((p) => p.current);
  const needs = useMemo(() => data.people.filter((p) => p.current && !p.hasRecord).sort((a, b) => a.name.localeCompare(b.name)), [data.people]);
  const paid = current.length - needs.length;
  // WORKFLOW-QA (14 Nov 2026): HR's own row was in the walk, and saving it was refused at the end ("Someone else proposes
  // changes to your own pay"). The walk is everyone else; the list says who sets up your own pay.
  const own = me ? needs.find((p) => p.id === me) : undefined;
  const startIds = useMemo(() => setupWalk(data.people, me).map((p) => p.id), [data.people, me]);
  // WORKFLOW-QA: the set-ups waiting for this founder, approved together instead of one person page at a time.
  const setups = useMemo(() => waitingSetups(data.people), [data.people]);
  const bulk = setups.length >= 2;
  const tagsOf = (p: PayRow) => [p.next?.tone === "act" ? "act" : "", p.current && !p.hasRecord ? "none" : "", p.hasRecord ? "paid" : "", p.offer ? "offer" : "",
    p.status === "probation" ? "probation" : "", p.status === "paused" ? "paused" : "", p.status === "notice" || p.leavingCase ? "notice" : ""].filter(Boolean);
  const rows: FinRow[] = data.people.map((p) => {
    const st = p.status ? statusOf(p.status, p.payType) : null, figure = pay?.get(p.id);
    const setUp = data.can.write && p.current && !p.hasRecord && p.id !== me;
    return {
      id: p.id, tags: tagsOf(p),
      cells: {
        person: { v: p.name, t: p.name, href: `/people/pay/${p.id}`, sub: [p.role, p.pod].filter(Boolean).join(" · ") },
        status: st ? { v: p.status!, t: st.label, chip: true, tone: st.tone } : { v: "", t: p.current ? "Needs pay" : "Not current", chip: true, tone: p.current ? "warning" : "neutral" },
        next: p.current && !p.hasRecord ? (p.id === me && data.can.write ? { v: "", t: "A founder sets up your pay" } : { v: "", t: "" }) : p.next ? { v: p.next.on ?? "", t: p.next.label, sub: p.next.tone === "act" ? "Needs you" : p.next.tone === "wait" ? "Waiting" : undefined } : null,
        pay: pay ? (figure ? { v: figure.monthly, t: figure.payType === "hourly" && figure.rate ? `${rupees(figure.rate)} / h` : rupees(figure.monthly), sub: `${PAY_TYPE[figure.payType]}${figure.ctc && figure.payType === "salary" ? ` · ${rupees(figure.ctc)} a year` : ""}` } : { v: null, t: "" })
          : p.hasRecord ? { v: null, t: "₹ •••••", sub: p.payType ? PAY_TYPE[p.payType] : undefined } : { v: null, t: "" },
        since: p.since ? { v: p.since, t: dayShort(p.since), sub: p.until ? `until ${dayShort(p.until)}` : undefined } : null,
      },
      // One quiet action per row: Set up opens the form here; anything else opens the person's page at that step.
      action: setUp ? <button type="button" className={`${styles.btn} ${styles.btnGhost} ${css.rowAct}`} onClick={() => setWalk({ ids: startIds, at: Math.max(0, startIds.indexOf(p.id)) })} aria-label={`Set up pay: ${p.name}`}>Set up</button>
        : p.action ? <Link className={`${styles.btn} ${p.next?.tone === "act" ? styles.btnPrimary : styles.btnGhost} ${css.rowAct}`} href={actionHref(p)} aria-label={`${p.action.label}: ${p.name}`}>{p.action.label}</Link> : null,
    };
  });
  // Only the groups that hold someone (Everyone first: FinTable's "everything").
  const groups = [{ key: "all", label: "Everyone" }, { key: "act", label: "Needs you" }, { key: "none", label: "Needs pay" }, { key: "paid", label: "Paid" }, { key: "offer", label: "Offers" },
    { key: "probation", label: "On probation" }, { key: "paused", label: "Paused" }, { key: "notice", label: "Leaving" }].filter((f, i) => i === 0 || rows.some((r) => r.tags?.includes(f.key)));
  const toolbar = data.can.read ? pay ? <button type="button" className={styles.btn} onClick={() => setPay(null)}><EyeOff size={14} aria-hidden="true" />Hide pay</button>
    : <button type="button" className={styles.btn} onClick={show} disabled={busy} title="Every look is logged"><Eye size={14} aria-hidden="true" />{busy ? "Opening…" : "Show pay"}</button> : null;
  const share = current.length ? paid / current.length : 0;
  const acting = data.people.filter((p) => p.next?.tone === "act").length;
  return <>
    <section className={css.homeTop} aria-label="Pay at a glance">
      <div className={`${css.homeCard} ${css.homeLead}`}>
        <ProgressRing value={share} size={92} stroke={9} label={`Pay set up for ${paid} of ${current.length}`} tone={needs.length ? undefined : "good"}><b className={css.ringNum}>{paid}/{current.length}</b></ProgressRing>
        <div className={css.homeLeadText}>
          <h2>{needs.length ? `Pay set up for ${paid} of ${current.length}` : "Everyone's pay is set up"}</h2>
          <p>{needs.length ? `${needs.length} ${needs.length === 1 ? "person needs" : "people need"} a pay record before payroll can pay them.` : "Payroll can pay everyone on the team."}
            {own && data.can.write ? ` You set up ${startIds.length}; a founder sets up yours.` : null}
            {bulk ? <> <b>{setups.length} pay set-ups</b> wait for your approval{acting > setups.length ? `, and ${acting - setups.length} more ${acting - setups.length === 1 ? "thing needs" : "things need"} you below` : ""}.</>
              : acting ? <> <b>{acting} {acting === 1 ? "thing needs" : "things need"} you</b> in the list below.</> : null}</p>
        </div>
        {bulk ? <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${css.homeBtn}`} onClick={() => setApproving(true)}>
          <ShieldCheck size={16} aria-hidden="true" />Approve {setups.length} pay set-ups</button> : null}
        {startIds.length && data.can.write ? <button type="button" className={`${styles.btn} ${bulk ? styles.btnGhost : styles.btnPrimary} ${css.homeBtn}`} onClick={() => setWalk({ ids: startIds, at: 0 })}>
          <UserRoundPlus size={16} aria-hidden="true" />Set up pay for {startIds.length} {startIds.length === 1 ? "person" : "people"}</button> : null}
      </div>
      <Link href={payroll?.href ?? "/people/pay/payroll"} className={css.homeCard}>
        <span className={css.homeLabel}><Banknote size={15} aria-hidden="true" />Payroll</span>
        <b className={css.homeBig}>{payroll?.text ?? "No payroll yet"}</b>
        {!payroll || payroll.none ? <span className={css.homeSub}>{needs.length ? "Set up pay first, then start a month" : "Start this month's payroll"}</span> : null}
        <span className={css.homeGo}>{payroll?.act ? "Open payroll" : "See payroll"} →</span>
      </Link>
      <Link href="/people/pay/settings" className={css.homeCard}>
        <span className={css.homeLabel}><FileCheck2 size={15} aria-hidden="true" />Pay policy</span>
        <b className={css.homeBig}>{doc?.published ? `Version ${doc.version}` : doc?.draft ? "Draft, not published" : "Not written yet"}</b>
        {doc?.published ? <Chip tone={doc.accepted >= doc.of ? "good" : "warn"}>{doc.accepted} of {doc.of} accepted</Chip> : <span className={css.homeSub}>Answer five questions and Pulse writes it</span>}
        <span className={css.homeGo}>{data.can.write ? "Open" : "Read"} →</span>
      </Link>
    </section>
    {error ? <p role="alert" className={css.warn}>{error}</p> : null}
    <FinTable fill inlineAction label="People and pay" filters={groups} search toolbar={toolbar} sort={{ key: "person", dir: "asc" }}
      columns={[{ key: "person", label: "Person", phone: "title" }, { key: "status", label: "Status", phone: "value" }, { key: "next", label: "Next", phone: "line" },
        // Only columns that say something: pay once anyone has a pay record, Since once anyone has a date.
        ...(data.can.read && data.people.some((p) => p.hasRecord) ? [{ key: "pay", label: "Pay a month", align: "right" as const, phone: "line" as const }] : []),
        ...(data.people.some((p) => p.since) ? [{ key: "since", label: "Since", phone: "hide" as const }] : [])]}
      rows={rows} empty="Nobody to show." />
    <p className={css.foot}><ShieldCheck size={13} aria-hidden="true" /> {data.can.read ? "Pay stays hidden until you show it; every look is logged." : "You see status and dates only: pay is for founders and HR."}
      {" "}{data.policy.approvers === "founders" ? "A founder approves pay" : data.policy.approvers === "leadership" ? "Leadership approves pay" : "A second person in HR approves pay"}; HR proposes it.</p>
    {walk ? <SetupWalk ids={walk.ids} at={walk.at} onClose={() => setWalk(null)} /> : null}
    {approving ? <ApproveSetups rows={setups} names={new Map(data.people.map((p) => [p.id, p.name]))} onClose={() => setApproving(false)} /> : null}
  </>;
}
