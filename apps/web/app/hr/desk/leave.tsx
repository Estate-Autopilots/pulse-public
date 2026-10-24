import Link from "next/link";
import { CalendarDays, CircleCheck, History as HistoryIcon, SlidersHorizontal } from "lucide-react";
import { dayTime, dayYear, longDay, plural, range } from "../../lib/format";
import { Avatar, Badge, Empty, Fit, Panel, QueryTabs, styles } from "../../ui";
import css from "../desk.module.css";
import { REQUEST_LABEL, REQUEST_TONE, dayCount, leaveName, type Balance, type TeamLeave } from "../types";
import { RecordForm } from "../../records";
import { AdjustBalance } from "./adjust";
import { LeaveAsk, MonthNav, halfLabel, monthName, num, shiftMonth, weekdayLetter } from "./parts";

/** Used, waiting and left of what was earned, as one thin bar (the numbers beside it say the same). */
function Meter({ b }: { b: Balance }) {
  const total = Math.max(b.used + b.pending + Math.max(0, b.available - b.pending), 0.0001); const pct = (n: number) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
  return <span className={css.meter} aria-hidden="true"><i style={{ width: pct(b.used) }} /><i data-pending="" style={{ width: pct(b.pending) }} /></span>;
}

/** Leave for the team: what is waiting, who is away this month, what everyone has left, and what was decided. */
export function Leave({ data, view }: { data: TeamLeave; view?: string }) {
  const types = data.types; const allowance = types.filter((t) => t.active && t.annualDays !== null);
  const pending = data.requests.filter((r) => r.status === "pending").sort((a, b) => a.fromDate.localeCompare(b.fromDate));
  const decided = data.requests.filter((r) => r.status !== "pending").sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  const balanceOf = (personId: string, kind: string) => data.people.find((p) => p.id === personId)?.balances.find((b) => b.key === kind) ?? null;
  const away = data.people.filter((p) => data.calendar.some((l) => l.personId === p.id));
  const adjustable = data.people.map(({ id, name, balances }) => ({ id, name, balances }));
  const currentView = ["waiting", "calendar", "balances", "history"].includes(view ?? "") ? view! : "waiting";
  return <>
    <div className={styles.toolbar}>
      <QueryTabs base="/hr" keep={`tab=leave&month=${data.month}`} param="view" sub current={currentView} items={[{key:"waiting",label:"Waiting"},{key:"calendar",label:"Calendar"},{key:"balances",label:"Balances"},{key:"history",label:"History"}]} /><MonthNav tab="leave" view={currentView} month={data.month} today={data.today} latest={shiftMonth(data.today.slice(0, 7), 12)} />
      <RecordForm path="leave" title="File leave for someone" label="File leave for someone" action="File leave" done="Leave filed" fields={[{key:'personId',label:'Person',type:'select',required:true,options:data.people.map(p=>({value:p.id,label:p.name}))},{key:'kind',label:'Leave type',type:'select',required:true,options:types.filter(t=>t.active).map(t=>({value:t.key,label:t.name}))},{key:'fromDate',label:'From',type:'date',required:true},{key:'toDate',label:'To',type:'date',required:true},{key:'reason',label:'Reason',type:'textarea',required:true}]} note="Filed under your name for the selected person; HR or an admin decides the request."/>
      <span className={styles.muted}>Leave year {data.year} · balances count from {dayYear(data.policy.trackingFrom)}</span>
    </div>
    <Fit className={currentView === "history" ? css.two : css.one}>
    {currentView === "waiting" ? <Panel fill className={css.cq} title="Waiting for you" sub={pending.length ? `${plural(pending.length, "leave request")} to decide` : "Leave requests"}>
      {pending.length ? <ul className={styles.list}>{pending.map((l) => <LeaveAsk key={l.id} request={l} balance={balanceOf(l.personId, l.kind)} types={types} me={data.me} />)}</ul>
        : <Empty icon={CircleCheck} compact title="No leave request is waiting" text="When someone applies for leave from My desk, it lands here with their balance next to it." />}
    </Panel> : null}
    {currentView === "calendar" ? <Panel fill title="Team calendar" sub={`${monthName(data.month)} · ${away.length ? plural(away.length, "person", "people") + " away" : "nobody away"}`}>
      {away.length ? <>
        <div className={css.matrixWrap}>
          <table className={css.matrix}>
            <thead><tr>
              <th className={css.name} scope="col">Person</th>
              {data.dates.map((d) => <th key={d.date} scope="col" className={css.dayCol} data-off={d.off || d.holiday ? "" : undefined} data-today={d.date === data.today ? "" : undefined} title={`${longDay(d.date)}${d.holiday ? `: ${d.holiday}` : d.off ? ": weekly off" : ""}`}>{weekdayLetter(d.date)}<b>{Number(d.date.slice(8))}</b></th>)}
            </tr></thead>
            <tbody>{away.map((p) => (
              <tr key={p.id}>
                <th className={css.name} scope="row"><Link href={`/people/${p.id}?tab=attendance`} className={css.nameLink}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={22} className={css.avatarHide} /><span title={p.name}>{p.name}</span></Link></th>
                {data.dates.map((d) => {
                  const l = data.calendar.find((x) => x.personId === p.id && x.fromDate <= d.date && x.toDate >= d.date); const skip = d.off || !!d.holiday;
                  const name = l ? leaveName(types, l.kind) : "";
                  return <td key={d.date} className={css.dayCol} data-off={skip ? "" : undefined}>
                    {l ? <span className={css.bar} data-start={l.fromDate === d.date || d.date === data.from ? "" : undefined} data-end={l.toDate === d.date || d.date === data.to ? "" : undefined} data-pending={l.status === "pending" ? "" : undefined} data-skip={skip ? "" : undefined}
                      title={`${p.name}: ${name}, ${range(l.fromDate, l.toDate)}, ${dayCount(l.days)}${l.halfDay ? ` (${halfLabel(l.halfDay)})` : ""}${l.status === "pending" ? ", waiting for a decision" : ""}${skip ? `. ${d.holiday ?? "Weekly off"}: not counted` : ""}`}>
                      {l.fromDate === d.date || d.date === data.from ? (l.halfDay ? "½" : name.charAt(0)) : ""}<span className={styles.srOnly}> {name}{l.status === "pending" ? ", waiting" : ""}</span></span> : null}
                  </td>;
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div className={css.keys} aria-label="What the bars mean">
          <span><i className={css.bar} data-start="" data-end="" />Approved</span><span><i className={css.bar} data-start="" data-end="" data-pending="" />Waiting for a decision</span>
          {types.filter((t) => t.active).map((t) => <span key={t.key}><b>{t.name.charAt(0)}</b>{t.name}</span>)}<span><b>½</b>Half day</span><span>Shaded days are weekly offs and holidays</span>
        </div>
      </> : <Empty icon={CalendarDays} compact title={`Nobody has leave in ${monthName(data.month)}`} text="Approved and waiting leave shows here as a bar per person, so overlaps are easy to spot." />}
    </Panel> : null}
    {currentView === "balances" ? <Panel fill title="Balances" sub={`Available now, leave year ${data.year}`} tools={allowance.length ? <AdjustBalance people={adjustable} types={types} year={data.year} trackingFrom={data.policy.trackingFrom} /> : undefined}>
      {allowance.length ? <div className={styles.tableWrap}><table className={`${styles.table} ${css.balTable}`}>
        <thead><tr><th>Person</th>{allowance.map((t) => <th key={t.key} className={styles.right} title={`${t.annualDays} days a year, ${t.accrual === "monthly" ? "earned month by month" : "given at the start of the year"}`}>{t.name}</th>)}<th /></tr></thead>
        <tbody>{data.people.map((p) => (
          <tr key={p.id} className={css.hoverRow}>
            <td><Link href={`/people/${p.id}?tab=attendance`} className={styles.person}><Avatar name={p.name} id={p.id} photoAt={p.photoAt} size={26} /><span><span className={styles.cellLink}>{p.name}</span><span className={styles.cellSub}>{p.role}{p.joinedOn ? ` · joined ${dayYear(p.joinedOn)}` : ""}</span></span></Link></td>
            {allowance.map((t) => { const b = p.balances.find((x) => x.key === t.key); return (
              <td key={t.key} className={styles.right} data-label={t.name}>{b ? <span className={css.bal} title={`Earned ${num(b.accrued)} · carried over ${num(b.carried)} · adjusted ${num(b.adjusted)} · used ${num(b.used)}`}>
                <b data-low={b.available - b.pending < 0 ? "" : undefined}>{num(b.available)}</b><Meter b={b} /><small>{num(b.used)} used{b.pending ? ` · ${num(b.pending)} waiting` : ""}{b.adjusted ? ` · ${b.adjusted > 0 ? "+" : ""}${num(b.adjusted)} adjusted` : ""}</small></span> : <span className={styles.muted}>–</span>}</td>
            ); })}
            <td className={styles.right}><span className={css.rowAction}><AdjustBalance people={adjustable} types={types} personId={p.id} year={data.year} trackingFrom={data.policy.trackingFrom} small /></span></td>
          </tr>
        ))}</tbody>
      </table></div> : <Empty icon={SlidersHorizontal} compact title="No leave type has an allowance" text="Give a leave type a number of days per year under Policies, and balances appear here." action={{ href: "/hr?tab=policies", label: "Open Policies" }} />}
      <p className={styles.panelFoot}><span>Earned since <b>{dayYear(data.policy.trackingFrom)}</b>, less what was used · add what someone had before with “Adjust balance”{data.policy.confirmedAt ? "" : <> · allowances are provisional until confirmed in <Link href="/hr?tab=policies">Policies</Link></>}</span></p>
    </Panel> : null}
    {currentView === "history" ? <>
      <Panel fill title="Recent decisions" sub="Approved, rejected and withdrawn">
        {decided.length ? <ul className={styles.list}>{decided.map((l) => (
          <li key={l.id} className={styles.row}>
            <Avatar name={l.name} id={l.personId} photoAt={l.photoAt ?? null} size={28} />
            <span className={styles.rowMain}><Link href={`/people/${l.personId}?tab=attendance`} className={styles.rowTitle}>{l.name}</Link>
              <span className={styles.rowMeta}><span>{leaveName(types, l.kind)}</span><span>{range(l.fromDate, l.toDate)}</span><span>{dayCount(l.days)}</span></span>
              {l.decisionNote ? <span className={styles.cellSub}>“{l.decisionNote}”</span> : null}</span>
            <span className={styles.rowEnd}><span className={styles.hideSmall}>{l.status === "cancelled" ? "" : l.decidedBy ? `${l.decidedBy.split(" ")[0]} · ` : ""}{l.decidedAt ? dayTime(l.decidedAt) : ""}</span><Badge tone={REQUEST_TONE[l.status]}>{l.status === "cancelled" ? "Withdrawn" : REQUEST_LABEL[l.status]}</Badge></span>
          </li>
        ))}</ul> : <Empty icon={HistoryIcon} compact title="No decisions yet" text="Every approval and rejection is kept here with who decided and when." />}
      </Panel>
      <Panel fill title="Balance adjustments" sub="Opening balances and corrections">
        {data.adjustments.length ? <ul className={styles.list}>{data.adjustments.map((a) => (
          <li key={a.id} className={styles.row}>
            <Avatar name={a.name} id={a.personId} size={28} />
            <span className={styles.rowMain}><Link href={`/people/${a.personId}?tab=attendance`} className={styles.rowTitle}>{a.name}</Link>
              <span className={styles.rowMeta}>{[leaveName(types, a.kind), a.year].filter(Boolean).join(" ") ? <span>{[leaveName(types, a.kind), a.year].filter(Boolean).join(" ")}</span> : null}</span>
              {a.reason ? <span className={styles.cellSub} title={a.reason}>“{a.reason}”</span> : null}</span>
            <span className={styles.rowEnd}><span className={styles.hideSmall}>{a.by ? `${a.by.split(" ")[0]} · ` : ""}{dayTime(a.createdAt)}</span><b className={styles.rowValue}>{a.days > 0 ? "+" : "−"}{num(Math.abs(a.days))}</b></span>
          </li>
        ))}</ul> : <Empty icon={SlidersHorizontal} compact title="No adjustments yet" text="Opening balances and corrections you enter are listed here with their reason." />}
      </Panel>
    </> : null}
    </Fit>
  </>;
}
