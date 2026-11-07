"use client";
import { lower } from "../../lib/words.mjs";

// COMP-A: People & pay, one table for leadership and HR. Each person's status, what happens next and the one thing to
// do; pay figures only when someone asks for them (every look is logged) and hidden again when the tab is left.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Banknote, Eye, EyeOff, Settings2, ShieldCheck } from "lucide-react";
import { FinTable, type FinRow } from "../../finance/table";
import { styles } from "../../ui";
import { dayShort, PAY_TYPE, rupees, statusOf, type PayRow, type PeopleData } from "./model";
import css from "./pay.module.css";
import { SelectField } from "../../kit/select-field";
import { W } from "../../kit/word";
import { useWords } from "../../org-code";

const FILTERS = [{ key: "all", label: "Everyone" }, { key: "act", label: "Needs you" }, { key: "offer", label: "Offers" }, { key: "probation", label: "On probation" },
  { key: "paused", label: "Paused" }, { key: "notice", label: "Leaving" }, { key: "none", label: "No pay record" }];

/** Where a row's one action goes: the person's page opens the matching step. */
const actionHref = (r: PayRow) => r.action?.key === "claims" ? "/people/pay/claims" : `/people/pay/${r.id}?do=${encodeURIComponent(r.action!.key)}`;

export function PayTable({ data, payroll }: { data: PeopleData; /** COMP-B: the month's payroll and its next step. */ payroll?: { text: string; href: string; act: boolean } | null }) {
  const words = useWords();
  const [pay, setPay] = useState<Map<string, NonNullable<PayRow["pay"]>> | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pod, setPod] = useState(""), [month, setMonth] = useState(false);
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
  const pods = useMemo(() => [...new Set(data.people.map((p) => p.pod).filter(Boolean) as string[])].sort(), [data.people]);
  const thisMonth = data.today.slice(0, 7);
  const rows: FinRow[] = data.people.filter((p) => (!pod || p.pod === pod) && (!month || (p.next?.on ?? "").startsWith(thisMonth))).map((p) => {
    const st = p.status ? statusOf(p.status, p.payType) : null, figure = pay?.get(p.id);
    const tags = [p.next?.tone === "act" ? "act" : "", p.offer ? "offer" : "", p.status === "probation" ? "probation" : "", p.status === "paused" ? "paused" : "",
      p.status === "notice" || p.leavingCase ? "notice" : "", p.hasRecord ? "" : "none"].filter(Boolean);
    return {
      id: p.id, tags,
      cells: {
        person: { v: p.name, t: p.name, href: `/people/pay/${p.id}`, sub: [p.role, p.pod].filter(Boolean).join(" · ") },
        status: st ? { v: p.status!, t: st.label, chip: true, tone: st.tone } : { v: "", t: p.current ? "No record" : "Not current", chip: true, tone: "neutral" },
        next: p.next ? { v: p.next.on ?? "", t: p.next.label, sub: p.next.tone === "act" ? "Needs you" : p.next.tone === "wait" ? "Waiting" : undefined } : null,
        pay: pay ? (figure ? { v: figure.monthly, t: figure.payType === "hourly" && figure.rate ? `${rupees(figure.rate)} / h` : rupees(figure.monthly), sub: `${PAY_TYPE[figure.payType]}${figure.ctc && figure.payType === "salary" ? ` · ${rupees(figure.ctc)} a year` : ""}` } : null)
          : p.hasRecord ? { v: null, t: "Hidden", sub: p.payType ? PAY_TYPE[p.payType] : undefined } : null,
        since: p.since ? { v: p.since, t: dayShort(p.since), sub: p.until ? `until ${dayShort(p.until)}` : undefined } : null,
      },
      action: p.action ? <Link className={`${styles.btn} ${p.next?.tone === "act" ? styles.btnPrimary : ""}`} href={actionHref(p)} aria-label={`${p.action.label}: ${p.name}`}>{p.action.label}</Link> : null,
    };
  });
  const toolbar = <div className={css.toolbar}>
    <label className={css.select}><span className={css.srOnly}><W k="team" /></span><SelectField value={pod} onChange={(e) => setPod(e.target.value)} aria-label={`${words.team}`}><option value="">{`All ${lower(words.teams)}`}</option>{pods.map((x) => <option key={x}>{x}</option>)}</SelectField></label>
    <label className={css.check}><input type="checkbox" checked={month} onChange={(e) => setMonth(e.target.checked)} />Events this month</label>
    {data.can.read ? pay ? <button type="button" className={styles.btn} onClick={() => setPay(null)}><EyeOff size={14} aria-hidden="true" />Hide pay</button>
      : <button type="button" className={styles.btn} onClick={show} disabled={busy}><Eye size={14} aria-hidden="true" />{busy ? "Opening…" : "Show pay"}</button> : null}
  </div>;
  const acting = data.people.filter((p) => p.next?.tone === "act").length;
  return <>
    <div className={css.summary} role="status">
      <p><b>{acting ? `${acting} ${acting === 1 ? "thing needs" : "things need"} you` : "Nothing needs you now"}</b>{" · "}{data.people.filter((p) => p.status === "probation").length} on probation{" · "}
        {data.people.filter((p) => p.offer).length} {data.people.filter((p) => p.offer).length === 1 ? "offer" : "offers"} in progress{" · "}{data.people.filter((p) => !p.hasRecord && p.current).length} without a pay record</p>
      <span className={css.quiet}><ShieldCheck size={13} aria-hidden="true" /> {data.can.read ? "Pay figures stay hidden until you show them; every look is logged." : "You see status and dates only: pay is for founders and HR."}</span>
      {data.can.write ? <Link href="/people/pay/settings" className={css.settings}><Settings2 size={14} aria-hidden="true" />Pay policy</Link> : null}
    </div>
    {payroll ? <p className={css.payrollLine}><Banknote size={14} aria-hidden="true" />{payroll.text}<Link href={payroll.href} className={payroll.act ? `${styles.btn} ${styles.btnPrimary}` : undefined}>{payroll.act ? "Open payroll" : "Payroll"}</Link></p> : null}
    {error ? <p role="alert" className={css.warn}>{error}</p> : null}
    <FinTable fill label="People and pay" filters={FILTERS} search toolbar={toolbar} sort={{ key: "person", dir: "asc" }}
      columns={[{ key: "person", label: "Person", phone: "title" }, { key: "status", label: "Status", phone: "line" }, { key: "next", label: "Next", phone: "line" },
        ...(data.can.read ? [{ key: "pay", label: "Pay a month", align: "right" as const, phone: "value" as const }] : []), { key: "since", label: "Since", phone: "hide" }]}
      rows={rows} empty="Nobody to show." />
    <p className={css.foot}>Approvals: {data.policy.approvers === "founders" ? "a founder approves pay" : data.policy.approvers === "leadership" ? "leadership approves pay" : "a second person in HR approves pay"}; HR proposes. Managers see {data.policy.managers === "status" ? "their people's status and dates" : "nothing about pay"}.</p>
  </>;
}
